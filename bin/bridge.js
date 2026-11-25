'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const mqtt = require('mqtt');
const dptCodec = require('./dptCodec');
const {
  toBool, toInterval, LoxChangeFilter, EchoGuard, ReadQueue, assessHealth, isGroupAddress, valueTopicAddr,
} = require('./bridgeLogic');
const { execFile } = require('child_process');
const loxberrylog = require('./loxberrylog');

// ── Pfade: LoxBerry vs. lokale Entwicklung ─────────────────
// Gleiches Muster wie MiraiPanel/bin/bridge.js: auf LoxBerry liegen bin/ und
// config/ in getrennten Systemverzeichnissen, im Entwicklungs-Checkout sind
// sie Geschwister-Ordner neben bin/.
const LBHOMEDIR = process.env.LBHOMEDIR || '';
const PLUGIN_FOLDER = path.basename(__dirname); // 'knxmqtt' auf LoxBerry, 'bin' lokal (dort ungenutzt)

// Macht LoxBerrys "Log-Level"-Schalter (Plugin-Verwaltung) fuer die
// hochfrequenten Zeilen ([knx]/[cmd]/[latenz], je Telegramm/Befehl EINE
// Zeile) nutzbar - real bestaetigt als Hauptursache fuer unkontrolliertes
// Wachstum von bridge.log (2026-09-18). Siehe bin/loxberrylog.js.
const logLevel = loxberrylog.create(PLUGIN_FOLDER, LBHOMEDIR);
const CFG_DIR = LBHOMEDIR
  ? path.join(LBHOMEDIR, 'config', 'plugins', PLUGIN_FOLDER)
  : path.join(__dirname, '..', 'config');
const DATA_DIR = LBHOMEDIR
  ? path.join(LBHOMEDIR, 'data', 'plugins', PLUGIN_FOLDER)
  : path.join(__dirname, '..', 'data');

const PATHS = {
  bridgeCfg: path.join(CFG_DIR, 'bridge.json'),
  knxCfg:    path.join(CFG_DIR, 'config.yaml'),
  gaFile:    path.join(CFG_DIR, 'groupaddresses.yaml'),
  // /dev/shm statt data/-Verzeichnis: /dev/shm ist unter Linux ein
  // RAM-Dateisystem (tmpfs), auf praktisch jedem System vorhanden -
  // Schreibvorgaenge landen nie auf der SD-Karte/eMMC, unabhaengig davon,
  // welches Speichermedium hinter LoxBerrys eigenen config/data/log-
  // Verzeichnissen steckt (das ist plattform-/installationsabhaengig und
  // nicht garantiert). Damit kein Ereignis-Puffer/Drossel mehr noetig -
  // RAM-Schreibvorgaenge sind praktisch kostenlos, jedes Ereignis schreibt
  // direkt.
  activity: '/dev/shm/knxmqtt-activity.json',
  // Letzte Loxone-Ausgangswerte (Punkt 1, siehe bridgeLogic.LoxChangeFilter).
  // Bewusst ebenfalls /dev/shm: ueberlebt einen Neustart der Bridge (dann
  // werden echte Aenderungen waehrend der Auszeit erkannt), aber KEINEN
  // Reboot - nach einem Reboot gibt es keine veralteten Werte.
  loxValues: '/dev/shm/knxmqtt-loxvalues.json',
  // Gesamtzustand fuer die Status-Seite (Punkt 8), von api.cgi gelesen.
  health: '/dev/shm/knxmqtt-health.json',
};

// Live-Aktivitaet fuer die Status-Seite: Ringpuffer der letzten Ereignisse
// (beide Richtungen), als Datei geschrieben, da api.cgi (Perl-Prozess) nicht
// direkt auf den In-Memory-Zustand dieses Node-Prozesses zugreifen kann.
const ACTIVITY_MAX = 50;
let activity = [];
// addr -> label, befuellt in main() aus groupaddresses.yaml - erlaubt
// recordActivity() den Anzeigenamen mitzuloggen, ohne dass jeder Aufrufer
// selbst durch gaRows suchen muss.
let addrLabels = new Map();

// "YYYY-MM-DD HH:MM:SS" in LOKALER Zeit (nicht toISOString() - das ist immer
// UTC). Frueher wurde toISOString() verwendet, wodurch die "Zeit"-Spalte der
// Live-Aktivitaet 2h hinter der tatsaechlichen (Sommerzeit-)Ortszeit lag -
// besonders sichtbar bei den Zeitgeber-Eintraegen, deren WERT-Spalte schon
// korrekt lokale Zeit zeigt (toLocaleTimeString() in publishSystemTime()) -
// beide Spalten zeigten dieselbe Sekunde, aber mit 2h Differenz.
function pad2(n) { return String(n).padStart(2, '0'); }
function localTimestamp() {
  return localTimestampOf(new Date());
}
function localTimestampOf(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function recordActivity(direction, addr, dpt, value, labelOverride) {
  const label = labelOverride || addrLabels.get(addr) || '';
  activity.unshift({ ts: localTimestamp(), direction, addr, label, dpt, value: String(value) });
  if (activity.length > ACTIVITY_MAX) activity.length = ACTIVITY_MAX;
  try {
    fs.writeFileSync(PATHS.activity, JSON.stringify(activity));
  } catch (e) {
    console.warn('[activity] Konnte activity.json nicht schreiben:', e.message);
  }
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8')) || {};
}

// groupaddresses.yaml existiert auf einer frischen Installation noch NICHT -
// sie wird erst beim ersten Speichern der Tabelle über die Web-UI angelegt
// (siehe api.cgi save_ga_rows()). Das ist der Normalfall direkt nach der
// Installation, kein Fehler - "keine Gruppenadresse konfiguriert" statt
// process.exit(1), sonst startet die Bridge nach jeder frischen Installation
// nie (bis der Nutzer einmal die - dann noch leere - Tabelle speichert).
function loadYamlOptional(file) {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

let cfg, knxCfg, gaRows;
try {
  cfg    = loadJson(PATHS.bridgeCfg);
  knxCfg = loadYamlOptional(PATHS.knxCfg);
  gaRows = (loadYamlOptional(PATHS.gaFile).groupaddresses) || [];
} catch (e) {
  console.error('[config] Fehler beim Laden der Konfiguration:', e.message);
  process.exit(1);
}

// ── Miniserver- und MQTT-Zugangsdaten aus der LoxBerry-Systemkonfiguration ──
// Identisches Prinzip wie MiraiPanel: das Plugin speichert nur die
// Miniserver-Nummer (bridge.json → loxone.msno); Host/User/Pass für
// Miniserver UND MQTT-Broker stammen aus general.json, damit sie nicht
// doppelt gepflegt werden müssen. Die Go-Engine (knx-mqtt) bekommt ihre
// eigene Sicht auf denselben Broker separat über config.yaml (dort von
// api.cgi bei jedem Speichern aus general.json synchronisiert) — der
// Node-Bridge hier liest die Broker-Zugangsdaten NICHT aus config.yaml,
// nur topicPrefix/qos (siehe main()).
function readGeneralJson() {
  const home = process.env.LBHOMEDIR || '/opt/loxberry';
  const generalPath = path.join(home, 'config', 'system', 'general.json');
  return JSON.parse(fs.readFileSync(generalPath, 'utf8'));
}

function loadMiniserverConn(msno) {
  if (!msno) throw new Error('Keine Miniserver-Nummer (loxone.msno) in bridge.json konfiguriert');
  const general = readGeneralJson();
  const msSection = general.Miniserver || general.Miniservers;
  const ms = msSection && (msSection[msno] || msSection[String(msno)]);
  if (!ms) throw new Error(`Miniserver #${msno} nicht in LoxBerry general.json gefunden`);
  const host = ms.Ipaddress || ms.IPAddress;
  if (!host) throw new Error(`Miniserver #${msno}: IP-Adresse nicht gefunden`);
  return {
    host,
    port: ms.Port || 80,
    user: ms.Admin_raw || ms.Admin || '',
    pass: ms.Pass_raw || ms.Pass || '',
  };
}

function loadMqttConn() {
  const general = readGeneralJson();
  const m = general.Mqtt;
  if (!m || !m.Brokerhost) throw new Error('MQTT Gateway ist in LoxBerry nicht konfiguriert (general.json → Mqtt.Brokerhost)');
  return {
    host: m.Brokerhost,
    port: parseInt(m.Brokerport, 10) || 1883,
    user: m.Brokeruser || undefined,
    pass: m.Brokerpass || undefined,
  };
}

// ── Gruppenadressen-Tabelle → zwei Allowlist-Maps ──────────
// Entspricht MiraiPanels buildStateFilter()-Prinzip: nur was hier explizit
// konfiguriert ist, wird überhaupt verarbeitet/weitergeleitet.
//   inputMap:  KNX-Gruppenadresse -> {uuid, dpt}   (KNX-Zustand -> Loxone schreiben)
//   outputMap: Loxone-State-UUID  -> {addr, dpt, sendOnConnect}   (Loxone-Zustand -> KNX-Bus schreiben)
function buildMaps(rows) {
  const inputMap = new Map();
  const outputMap = new Map();
  for (const row of rows) {
    if (!row || !row.addr) continue;
    if (row.lox_input_uuid) {
      inputMap.set(row.addr, {
        uuid: row.lox_input_uuid.toLowerCase(),
        dpt: row.dpt,
        readInterval: toInterval(row.read_interval, 10),
      });
    }
    if (row.lox_output_uuid) {
      outputMap.set(row.lox_output_uuid.toLowerCase(), {
        addr: row.addr,
        dpt: row.dpt,
        sendOnConnect: toBool(row.send_on_connect),
      });
    }
  }
  return { inputMap, outputMap };
}

function joinTopic(prefix, addr) {
  const p = prefix.endsWith('/') ? prefix : prefix + '/';
  return p + addr;
}

async function main() {
  console.log('[bridge] KNXtoLOX Node-Bridge (MQTT<->Loxone) startet');
  console.log('[bridge] CFG_DIR:', CFG_DIR);

  const loxConn  = loadMiniserverConn(cfg.loxone && cfg.loxone.msno);
  const mqttConn = loadMqttConn();
  console.log(`[bridge] Miniserver: ${loxConn.host}:${loxConn.port}`);
  console.log(`[bridge] MQTT-Broker: ${mqttConn.host}:${mqttConn.port}`);

  const topicPrefix = (knxCfg.mqtt && knxCfg.mqtt.topicPrefix) || 'knx/';
  const { inputMap, outputMap } = buildMaps(gaRows);
  for (const row of gaRows) {
    if (row && row.addr && row.label) addrLabels.set(row.addr, row.label);
  }
  console.log(`[bridge] ${inputMap.size} Gruppenadresse(n) -> Loxone (Eingang), ${outputMap.size} Loxone-Zustand(e) -> KNX (Ausgang)`);
  if (inputMap.size === 0 && outputMap.size === 0) {
    console.warn('[bridge] Keine Gruppenadresse ist einem Loxone-Ziel zugeordnet — bitte in der Gruppenadressen-Tabelle konfigurieren');
  }

  // Punkt 7: Wert, der gerade vom Bus kam, nicht sofort zurueckschreiben.
  // bridge.json echo_window_ms (Standard 1000, 0 = aus).
  const echoGuard = new EchoGuard(Number.isFinite(Number(cfg.echo_window_ms)) ? Number(cfg.echo_window_ms) : 1000);

  // Punkt 3: letzter bekannter Ausgangswert je GA (aus Loxone-Zustand oder
  // MQTT-Schreibbefehl) - Quelle fuer das zyklische Senden. Wird auch fuer
  // Werte gesetzt, die wegen Punkt 1 NICHT gesendet wurden (Initial-Dump):
  // der Wert ist bekannt, er soll nur nicht beim Connect ausgeloest werden.
  const lastOut = new Map(); // addr -> value

  // Punkt 8: Zeitpunkt des letzten Telegramms vom Bus (beliebige GA)
  let lastKnxRx = 0;
  // Punkt 8: Pruefadresse - eine GA, deren Geraet auf Leseanfragen antwortet
  // (R-Flag, z.B. ein Aktor-Status). Die Bridge liest sie in jedem
  // Heartbeat-Intervall; die Antwort beweist den ganzen Weg LoxBerry ->
  // knx-mqtt -> Gateway -> Bus -> Geraet -> zurueck, unabhaengig davon, ob
  // gerade jemand im Haus etwas bedient. Muss NICHT in der GA-Tabelle stehen.
  const probeAddr = (() => {
    const a = String(cfg.heartbeat_probe_addr || '').trim();
    if (!a) return '';
    if (!isGroupAddress(a)) { console.warn(`[heartbeat] Pruefadresse "${a}" ist keine Gruppenadresse (x/y/z), ignoriert`); return ''; }
    return a;
  })();

  // ── MQTT Client ────────────────────────────────────────────
  const mqttClient = mqtt.connect({
    host: mqttConn.host,
    port: mqttConn.port,
    username: mqttConn.user,
    password: mqttConn.pass,
    clientId: 'knxlox-bridge',
    clean: true,
    reconnectPeriod: 5000,
  });

  // Abo ALLER Bus-Telegramme (<prefix>+/+/+), lokal gefiltert: weitergeleitet
  // an Loxone wird weiterhin nur, was in inputMap steht (Allowlist). Jedes
  // Telegramm zaehlt aber als Lebenszeichen des Busses fuer den Heartbeat
  // (Punkt 8) - frueher wurden nur die Tabellen-GAs abonniert, dann hing die
  // Ausfallerkennung davon ab, ob gerade jemand im Haus eine davon benutzt.
  // Eigene Befehle (".../read", ".../write-bytes") haben eine Ebene mehr und
  // fallen nicht darunter. KNX-Buslast ist gering (wenige Telegramme/s).
  const busTopic = joinTopic(topicPrefix, '+/+/+');

  // Punkt 6: zweiter Rueckweg Loxone -> KNX ohne beobachtete State-UUID.
  // Loxone (virtueller Ausgang ueber das LoxBerry-MQTT-Gateway) publiziert
  // den Klartextwert auf <writePrefix><ga>, z.B. "knxlox/write/1/2/3" = "21.5".
  // Nur GAs aus der Tabelle (mit DPT) werden angenommen; der DPT kommt aus
  // der Tabelle. Gleiche Werte nacheinander werden NICHT unterdrueckt
  // (Taster/Impulse), nur Echos (Punkt 7).
  const writePrefix = (() => {
    const p = (cfg.mqtt_write_prefix || 'knxlox/write/').trim();
    return p.endsWith('/') ? p : p + '/';
  })();
  const gaDpt = new Map();
  for (const row of gaRows) {
    if (row && row.addr && row.dpt && !gaDpt.has(row.addr)) gaDpt.set(row.addr, row.dpt);
  }
  if (writePrefix.startsWith(topicPrefix.endsWith('/') ? topicPrefix : topicPrefix + '/')) {
    console.warn(`[mqtt] mqtt_write_prefix "${writePrefix}" liegt unter dem knx-mqtt-Prefix "${topicPrefix}" - bitte einen eigenen Prefix waehlen`);
  }

  mqttClient.on('connect', () => {
    console.log('[mqtt] Verbunden mit Broker');
    const qos = (knxCfg.mqtt && knxCfg.mqtt.qos) || 0;
    mqttClient.subscribe(writePrefix + '#', { qos }, (err) => {
      if (err) console.error('[mqtt] Abo fuer Schreibbefehle fehlgeschlagen:', err.message);
      else console.log(`[mqtt] Schreibbefehle auf ${writePrefix}<ga> aktiv (${gaDpt.size} GA(s) mit DPT)`);
    });
    mqttClient.subscribe(busTopic, { qos }, (err) => {
      if (err) console.error('[mqtt] Abo fehlgeschlagen:', err.message);
      else console.log(`[mqtt] Bus-Telegramme abonniert (${busTopic}), ${inputMap.size} davon -> Loxone`);
    });
    // Pruefadresse sofort lesen, damit der erste Heartbeat schon eine Antwort hat
    if (probeAddr) readQueue.enqueue(probeAddr);
  });

  // Punkt 2: Leseanfragen (GroupValueRead) ueber knx-mqtt "<prefix><ga>/read".
  // Die Antwort kommt als normaler Wert auf dem abonnierten GA-Topic an und
  // geht wie jeder andere Bus-Wert an Loxone.
  //   - nach jeder Loxone-Authentifizierung (also auch beim Bridge-Start) fuer
  //     alle Eingangs-GAs, abschaltbar mit bridge.json read_on_connect: false
  //   - zyklisch fuer Zeilen mit read_interval (Sekunden, min. 10)
  //   - gedrosselt auf read_rate Telegramme/s (Standard 10)
  const readQueue = new ReadQueue(
    Number(cfg.read_rate) || 10,
    (addr) => {
      mqttClient.publish(joinTopic(topicPrefix, addr) + '/read', '', { qos: (knxCfg.mqtt && knxCfg.mqtt.qos) || 0, retain: false });
      if (logLevel.enabled(logLevel.DEBUG)) console.log(`[knx] Leseanfrage ${addr}`);
    },
    () => mqttClient.connected,
  );
  const readOnConnect = cfg.read_on_connect === undefined ? true : toBool(cfg.read_on_connect);
  function readAllInputs(reason) {
    if (!readOnConnect || inputMap.size === 0) return;
    readQueue.enqueue([...inputMap.keys()]);
    console.log(`[knx] ${inputMap.size} Leseanfrage(n) eingereiht (${reason})`);
  }
  for (const [addr, t] of inputMap) {
    if (!t.readInterval) continue;
    setInterval(() => readQueue.enqueue(addr), t.readInterval * 1000);
    console.log(`[knx] ${addr}: zyklische Leseanfrage alle ${t.readInterval} s`);
  }

  function handleMqttWrite(topic, message, packet) {
    const addr = topic.slice(writePrefix.length);
    // Retained-Nachrichten wuerden nach jedem Bridge-Neustart erneut auf den
    // Bus geschrieben (gleiches Problem wie Punkt 1) - deshalb verworfen.
    if (packet && packet.retain) {
      console.warn(`[mqtt] ${topic}: retained Schreibbefehl ignoriert (bitte ohne Retain publizieren)`);
      return;
    }
    const dpt = gaDpt.get(addr);
    if (!dpt) {
      console.warn(`[mqtt] ${topic}: GA "${addr}" nicht in der Gruppenadressen-Tabelle (oder ohne DPT), ignoriert`);
      return;
    }
    const value = message.toString('utf8').trim();
    lastOut.set(addr, value);
    publishToKnx(addr, dpt, value, 'mqtt->knx');
  }

  // KNX-Zustand -> Loxone. Payload-Format: config.yaml erzwingt
  // outgoingMqttMessage.type=bytes (das Binary verweigert den Start mit
  // type=json/value/..., solange kein ETS-Adressbuch importiert ist — siehe
  // Kommentar in config.yaml.default). Bei type=bytes ist der Payload DIREKT
  // der rohe KNX-Bytestring (kein JSON, kein base64), die Gruppenadresse
  // steckt stattdessen im Topic-Pfad, deshalb hier ueber valueTopicAddr()
  // statt ueber ein JSON-Feld aufgeloest.
  mqttClient.on('message', (topic, message, packet) => {
    if (topic.startsWith(writePrefix)) { handleMqttWrite(topic, message, packet); return; }
    const addr = valueTopicAddr(topicPrefix, topic);
    if (!addr) return;
    lastKnxRx = Date.now(); // jedes Bus-Telegramm = Lebenszeichen (Punkt 8)
    const target = inputMap.get(addr);
    if (!target) return; // nicht in der Tabelle -> nur Lebenszeichen

    // Leerer Payload = GroupValueRead vom Bus (knx-mqtt veroeffentlicht Reads
    // entgegen README auf dem normalen Werte-Topic, nicht auf ".../read") -
    // normalerweise schon per ignoreReadCommands: true unterdrueckt, hier als
    // zweite Absicherung (z.B. alte config.yaml). Ebenso nichts senden, wenn
    // der Codec keinen gueltigen Wert liefert (zu kurzer Payload o.ae.) -
    // sonst kommt "jdev/sps/io/<uuid>/null" bei Loxone an.
    if (!message || message.length === 0) {
      if (logLevel.enabled(logLevel.DEBUG)) console.log(`[knx] ${addr}: leerer Payload (Leseanfrage), ignoriert`);
      return;
    }
    echoGuard.noteBusValue(addr, message);
    const value = dptCodec.decode(target.dpt, message);
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
      console.warn(`[knx] ${addr}: Payload ${message.toString('hex')} nicht als DPT ${target.dpt} dekodierbar, ignoriert`);
      return;
    }
    recordActivity('knx->lox', addr, target.dpt, value);
    sendToLoxone(target.uuid, value);
  });

  // ── Loxone via node-lox-ws-api (identisch zu MiraiPanel) ───
  const LoxoneAPI = require('node-lox-ws-api');
  const loxApi = new LoxoneAPI(
    `${loxConn.host}:${loxConn.port || 80}`,
    loxConn.user,
    loxConn.pass,
    true,        // auto-reconnect
    'Token-Enc', // RSA+AES-verschlüsselte Token-Auth (Firmware 9.x+)
    30000
  );

  // Punkt 1: Initial-Dump nach jeder Authentifizierung nicht blind auf den
  // Bus schreiben. Gemerkte Werte vom letzten Bridge-Lauf laden.
  const loxFilter = new LoxChangeFilter();
  try {
    loxFilter.load(JSON.parse(fs.readFileSync(PATHS.loxValues, 'utf8')));
    console.log('[lox] Letzte Ausgangswerte vom vorherigen Bridge-Lauf geladen');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[lox] Konnte gemerkte Ausgangswerte nicht laden:', e.message);
  }
  let loxValuesSaveTimer = null;
  function scheduleLoxValuesSave() {
    if (loxValuesSaveTimer) return;
    loxValuesSaveTimer = setTimeout(() => {
      loxValuesSaveTimer = null;
      try { fs.writeFileSync(PATHS.loxValues, JSON.stringify(loxFilter.snapshot())); }
      catch (e) { console.warn('[lox] Konnte Ausgangswerte nicht speichern:', e.message); }
    }, 1000);
  }

  let loxAuthorized = false;
  loxApi.on('authorized',       () => {
    loxAuthorized = true;
    loxFilter.newConnection();
    readAllInputs('Loxone verbunden');
    console.log('[lox] Authentifiziert ✓ (Initial-Dump wird nur bei Aenderung bzw. send_on_connect weitergegeben)');
  });
  loxApi.on('auth_failed',      () => { loxAuthorized = false; console.error('[lox] Authentifizierung fehlgeschlagen'); });
  loxApi.on('connect_failed',   () => { loxAuthorized = false; console.error('[lox] Verbindung fehlgeschlagen'); });
  loxApi.on('connection_error', (e) => console.error('[lox] Fehler:', e && e.message || e));
  loxApi.on('close',            () => { loxAuthorized = false; console.warn('[lox] Verbindung getrennt'); });
  loxApi.on('reconnect',        () => console.log('[lox] Reconnect…'));

  const pendingCommands = new Map();
  const LOX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/i;

  function sendToLoxone(uuid, value) {
    const key = uuid.toLowerCase();
    if (!LOX_UUID_RE.test(key)) {
      console.warn(`[cmd] Ziel sieht nicht wie eine echte Loxone-UUID aus, übersprungen: "${key}" = ${value}`);
      return;
    }
    if (!loxAuthorized) {
      console.warn(`[cmd] Noch nicht bei Loxone authentifiziert — Befehl trotzdem versucht: ${key} = ${value}`);
    }
    if (typeof loxApi.is_connected === 'function' && !loxApi.is_connected()) {
      console.error(`[cmd] Keine Loxone-Verbindung — Befehl verworfen: ${key} = ${value}`);
      return;
    }
    // URL-kodiert: Texte (DPT 16) koennen Leerzeichen, "/" oder Umlaute
    // enthalten, die den Befehlspfad sonst zerbrechen. Zahlen bleiben gleich.
    const cmd = `jdev/sps/io/${key}/${encodeURIComponent(String(value))}`;
    if (logLevel.enabled(logLevel.DEBUG)) console.log(`[cmd] ${cmd}`);
    try {
      pendingCommands.set(key, Date.now());
      loxApi.send_command(cmd);
    } catch (e) {
      pendingCommands.delete(key);
      console.error(`[cmd] send_command fehlgeschlagen für ${key}:`, e && e.message || e);
    }
  }

  // Loxone-Zustand -> KNX-Bus. NICHT retained (Schreibbefehl, kein
  // persistenter Zustand — anders als MiraiPanels publishState()).
  // "/write-bytes" (nicht "/write", das laut knx-mqtt-Doku einen
  // string-formatierten Wert statt Rohbytes erwartet) mit dem rohen
  // KNX-Byte-Buffer direkt als Payload — konsistent mit
  // outgoingMqttMessage.type=bytes auf der Lese-Seite (siehe config.yaml.default).
  function publishToKnx(addr, dpt, value, source = 'lox->knx') {
    if (!mqttClient.connected) { console.error(`[knx] Keine MQTT-Verbindung — Schreibbefehl für ${addr} verworfen`); return; }
    const buf = dptCodec.encode(dpt, value);
    if (buf === null) {
      console.warn(`[knx] ${addr}: Wert "${value}" ist kein gueltiger DPT-${dpt}-Wert, nicht gesendet`);
      return;
    }
    if (echoGuard.isEcho(addr, buf)) {
      if (logLevel.enabled(logLevel.DEBUG)) console.log(`[knx] ${addr} <- ${value}: Echo des gerade empfangenen Bus-Werts, nicht gesendet`);
      return;
    }
    const topic = joinTopic(topicPrefix, addr) + '/write-bytes';
    mqttClient.publish(topic, buf, { qos: (knxCfg.mqtt && knxCfg.mqtt.qos) || 0, retain: false });
    if (logLevel.enabled(logLevel.DEBUG)) console.log(`[knx] ${topic} <- ${value} (dpt ${dpt})`);
    recordActivity(source, addr, dpt, value);
  }

  function handleLoxUpdate(uuid, value) {
    const key = uuid.toLowerCase();
    const sentAt = pendingCommands.get(key);
    if (sentAt !== undefined) {
      pendingCommands.delete(key);
      if (logLevel.enabled(logLevel.DEBUG)) console.log(`[latenz] ${key}: ${Date.now() - sentAt}ms (MQTT-Befehl -> Loxone-Rückmeldung)`);
    }
    const target = outputMap.get(key);
    if (!target) return;
    lastOut.set(target.addr, value);
    const send = loxFilter.shouldSend(key, value, target.sendOnConnect);
    scheduleLoxValuesSave();
    if (!send) {
      if (logLevel.enabled(logLevel.DEBUG)) console.log(`[knx] ${target.addr} <- ${value}: unveraendert/Initialwert, nicht gesendet`);
      return;
    }
    publishToKnx(target.addr, target.dpt, value);
  }

  loxApi.on('update_event_value', (uuid, value) => handleLoxUpdate(uuid, value));
  loxApi.on('update_event_text',  (uuid, text)  => handleLoxUpdate(uuid, text));

  // ── Punkt 3: zyklisches Senden Loxone -> KNX ─────────────────────────────
  // Zeilenfeld cyclic (Sekunden, min. 10): letzten bekannten Wert periodisch
  // erneut senden (Ersatz fuer Loxones Cyclic=60, z.B. Aussentemperatur fuer
  // KNX-Raumregler). Solange noch kein Wert bekannt ist, wird nichts gesendet.
  const cyclicByAddr = new Map();
  for (const row of gaRows) {
    if (!row || !row.addr) continue;
    const sec = toInterval(row.cyclic, 10);
    if (sec && sec > (cyclicByAddr.get(row.addr) || 0)) cyclicByAddr.set(row.addr, sec);
  }
  for (const [addr, sec] of cyclicByAddr) {
    const dpt = gaDpt.get(addr);
    if (!dpt) { console.warn(`[knx] ${addr}: cyclic gesetzt, aber kein DPT - zyklisches Senden aus`); continue; }
    setInterval(() => {
      if (!lastOut.has(addr)) return;
      publishToKnx(addr, dpt, lastOut.get(addr), 'zyklisch');
    }, sec * 1000);
    console.log(`[knx] ${addr}: zyklisches Senden alle ${sec} s`);
  }

  // ── KNX-Zeitgeber: periodischer Systemzeit-Push (DPT 10.001/11.001) ──────
  // Oeffentlicher KNX-Standard (nicht projektspezifisch geraten), siehe
  // dptCodec.encodeTimeOfDay()/encodeDate(). Leere Adresse(n) = deaktiviert,
  // kein Timer gestartet. Ziel: KNX-Uhren/Displays am Bus zeigen die
  // LoxBerry-Systemzeit an.
  const timeAddr = (cfg.time_addr || '').trim();
  const dateAddr = (cfg.date_addr || '').trim();
  if (timeAddr || dateAddr) {
    function publishSystemTime() {
      if (!mqttClient.connected) return;
      const now = new Date();
      if (timeAddr) {
        mqttClient.publish(joinTopic(topicPrefix, timeAddr) + '/write-bytes', dptCodec.encodeTimeOfDay(now), { qos: 0, retain: false });
        recordActivity('zeitgeber', timeAddr, '10.001', now.toLocaleTimeString('de-DE'), 'Systemzeit');
      }
      if (dateAddr) {
        mqttClient.publish(joinTopic(topicPrefix, dateAddr) + '/write-bytes', dptCodec.encodeDate(now), { qos: 0, retain: false });
        recordActivity('zeitgeber', dateAddr, '11.001', now.toLocaleDateString('de-DE'), 'Systemdatum');
      }
    }
    // Einmal sofort, danach synchron zur vollen Minute (Sekunde 0), damit
    // KNX-Geraete am Bus sich an LoxBerrys tatsaechlicher Sekunde orientieren.
    publishSystemTime();
    setTimeout(() => {
      publishSystemTime();
      setInterval(publishSystemTime, 60000);
    }, (60 - new Date().getSeconds()) * 1000);
    console.log(`[zeitgeber] aktiv (Uhrzeit=${timeAddr || '-'}, Datum=${dateAddr || '-'})`);
  }

  // ── Punkt 8: Heartbeat / Ausfallerkennung ────────────────────────────────
  // Alle heartbeat_interval Sekunden (Standard 30) wird der Gesamtzustand
  // geprueft und nach /dev/shm geschrieben (Status-Seite). Ist zusaetzlich
  // heartbeat_uuid gesetzt (virtueller Eingang), zaehlt die Bridge dort einen
  // Wert hoch - aber NUR solange alles ok ist. Bleibt der Zaehler stehen,
  // loest Loxones Watchdog-Logik aus. knx_timeout (Standard 300 s, 0 = aus):
  // so lange darf kein Telegramm vom Bus kommen, bevor KNX als ausgefallen
  // gilt - zuverlaessig nur mit Pruefadresse (heartbeat_probe_addr), weil
  // normaler Busverkehr von der Nutzung abhaengt.
  const hbUuid = String(cfg.heartbeat_uuid || '').trim().toLowerCase();
  const hbInterval = toInterval(cfg.heartbeat_interval === undefined ? 30 : cfg.heartbeat_interval, 5) || 30;
  const knxTimeoutSec = cfg.knx_timeout === undefined ? 300 : Math.max(0, Number(cfg.knx_timeout) || 0);
  let hbCounter = 0;
  let knxServiceState; // undefined = noch nicht abgefragt / nicht abfragbar
  function pollKnxService() {
    execFile('systemctl', ['is-active', 'knxmqtt.service'], { timeout: 5000 }, (err, stdout) => {
      const out = String(stdout || '').trim();
      // Ohne systemd (lokale Entwicklung) nicht werten
      knxServiceState = out || (err && err.code === 'ENOENT' ? undefined : 'unbekannt');
    });
  }
  function heartbeatTick() {
    pollKnxService();
    const health = assessHealth({
      mqtt: mqttClient.connected,
      lox: loxAuthorized,
      knxService: knxServiceState,
      lastKnxRx,
      now: Date.now(),
      knxTimeoutSec,
    });
    if (health.ok && hbUuid) {
      hbCounter = hbCounter >= 99999 ? 1 : hbCounter + 1;
      sendToLoxone(hbUuid, hbCounter);
    } else if (!health.ok) {
      console.warn(`[heartbeat] gestoert: ${health.reasons.join(', ')}`);
    }
    // Erst bewerten, dann die naechste Pruef-Leseanfrage stellen: jeder Tick
    // beurteilt die Antwort auf die Anfrage des vorherigen Ticks.
    if (probeAddr) readQueue.enqueue(probeAddr);
    try {
      fs.writeFileSync(PATHS.health, JSON.stringify({
        ts: localTimestamp(),
        ok: health.ok,
        reasons: health.reasons,
        mqtt: mqttClient.connected,
        lox: loxAuthorized,
        knx_service: knxServiceState || null,
        last_knx_rx: lastKnxRx ? localTimestampOf(new Date(lastKnxRx)) : null,
        knx_timeout: knxTimeoutSec,
        probe_addr: probeAddr || null,
        heartbeat_uuid: hbUuid || null,
        heartbeat_counter: hbCounter,
      }));
    } catch (e) {
      console.warn('[heartbeat] Konnte health.json nicht schreiben:', e.message);
    }
  }
  pollKnxService();
  setInterval(heartbeatTick, hbInterval * 1000);
  console.log(`[heartbeat] Pruefung alle ${hbInterval} s, KNX-Timeout ${knxTimeoutSec || 'aus'}, ` +
    `Pruefadresse ${probeAddr || '-'}` +
    (hbUuid ? `, Zaehler -> ${hbUuid}` : ' (kein heartbeat_uuid)'));

  console.log(`[lox] Verbinde mit ${loxConn.host}:${loxConn.port || 80}…`);
  loxApi.connect();
}

main().catch(e => {
  console.error('[bridge] Fataler Fehler:', e);
  process.exit(1);
});
