'use strict';

// Entscheidungslogik der Bridge, getrennt von MQTT/Loxone-I/O, damit sie
// ohne Bus und ohne Miniserver testbar ist (test/bridgeLogic.test.js).

// ── Hilfsfunktionen fuer Felder aus groupaddresses.yaml ─────────────────────
// YAML::Tiny (api.cgi) schreibt Werte als Klartext, js-yaml liest "true" als
// Boolean, "1" als Zahl, "ja" als String - alles hier tolerant normalisiert.
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return false;
  return ['1', 'true', 'yes', 'ja', 'on', 'ein', 'x'].includes(v.trim().toLowerCase());
}

// Sekunden-Intervall: 0 = aus. Werte unter minSec werden auf minSec
// angehoben (Schutz gegen versehentliches Bus-Fluten, z.B. "1").
function toInterval(v, minSec) {
  const n = Number(typeof v === 'string' ? v.trim().replace(',', '.') : v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(minSec, Math.round(n));
}

function sameValue(a, b) {
  return String(a) === String(b);
}

// ── Punkt 1: kein Schreiben auf den Bus beim (Re-)Connect ─────────────────
// Loxone schickt nach JEDER Authentifizierung alle Zustaende (Initial-Dump).
// Regel:
//   - UUID noch nie gesehen (Bridge frisch gestartet, kein Snapshot):
//     Wert nur merken, NICHT senden (ausser send_on_connect).
//   - Erster Wert nach einem (Re-)Connect: nur senden, wenn er sich vom
//     gemerkten Wert unterscheidet (Aenderung waehrend der Trennung) oder
//     send_on_connect gesetzt ist.
//   - Danach: nur bei echter Aenderung senden.
class LoxChangeFilter {
  constructor() {
    this.last = new Map(); // uuid -> { value, epoch }
    this.epoch = 0;        // wird bei jedem 'authorized' erhoeht
  }

  newConnection() {
    this.epoch++;
  }

  // true = an KNX senden
  shouldSend(uuid, value, sendOnConnect) {
    const prev = this.last.get(uuid);
    this.last.set(uuid, { value, epoch: this.epoch });
    if (!prev) return !!sendOnConnect;
    const firstThisConnection = prev.epoch !== this.epoch;
    if (firstThisConnection && sendOnConnect) return true;
    return !sameValue(prev.value, value);
  }

  // Persistenz ueber Bridge-Neustarts (nicht ueber Reboots, siehe bridge.js)
  snapshot() {
    const out = {};
    for (const [uuid, e] of this.last) out[uuid] = e.value;
    return out;
  }

  load(obj) {
    if (!obj || typeof obj !== 'object') return;
    // epoch -1: gilt beim ersten Wert jeder Verbindung als "vorher bekannt"
    for (const [uuid, value] of Object.entries(obj)) this.last.set(uuid, { value, epoch: -1 });
  }
}

// ── Punkt 7: Echo-Unterdrueckung ────────────────────────────────────────────
// Ist eine GA in beiden Richtungen konfiguriert, aendert ein Wert vom Bus
// den Loxone-Zustand, Loxone meldet die Aenderung zurueck, und die Bridge
// wuerde denselben Wert sofort wieder auf den Bus schreiben. Verglichen wird
// auf Byte-Ebene (nicht der dekodierte Wert), damit Rundungen wie bei 5.001
// (Bus 0x80 -> 50 % -> 0x80) das Echo nicht verdecken.
class EchoGuard {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.bus = new Map(); // addr -> { hex, ts }
  }

  noteBusValue(addr, buf, now = Date.now()) {
    this.bus.set(addr, { hex: buf.toString('hex'), ts: now });
  }

  isEcho(addr, buf, now = Date.now()) {
    if (!(this.windowMs > 0)) return false;
    const e = this.bus.get(addr);
    return !!e && e.hex === buf.toString('hex') && now - e.ts < this.windowMs;
  }
}

// ── Punkt 2: gedrosselte Leseanfragen ──────────────────────────────────────
// Sammelt GAs (jede hoechstens einmal in der Warteschlange) und gibt sie mit
// max. ratePerSec Telegrammen/s an send() weiter, damit der Bus beim Start
// (alle Eingangs-GAs auf einmal) nicht geflutet wird. canSend() = false
// (z.B. MQTT getrennt) haelt die Warteschlange an, ohne etwas zu verwerfen.
class ReadQueue {
  constructor(ratePerSec, send, canSend = () => true) {
    this.intervalMs = Math.round(1000 / Math.max(1, Math.min(50, ratePerSec || 10)));
    this.send = send;
    this.canSend = canSend;
    this.queue = [];
    this.pending = new Set();
    this.timer = null;
  }

  enqueue(addrs) {
    for (const a of Array.isArray(addrs) ? addrs : [addrs]) {
      if (this.pending.has(a)) continue;
      this.pending.add(a);
      this.queue.push(a);
    }
    if (this.queue.length && !this.timer) {
      this.timer = setInterval(() => this._tick(), this.intervalMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  get size() { return this.queue.length; }

  _tick() {
    if (!this.queue.length) { clearInterval(this.timer); this.timer = null; return; }
    if (!this.canSend()) return;
    const a = this.queue.shift();
    this.pending.delete(a);
    this.send(a);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ── Punkt 8: Gesamtzustand fuer Heartbeat/Ausfallerkennung ─────────────────
// knx-mqtt meldet seinen KNX-Verbindungszustand nirgends (kein Status-Topic,
// bei KNX-Abbruch laeuft der Dienst weiter und loggt nur). "Dienst aktiv"
// allein beweist also nichts - deshalb zusaetzlich: in den letzten
// knxTimeoutSec Sekunden muss mindestens ein Telegramm vom Bus angekommen
// sein (z.B. Antworten auf zyklische Leseanfragen). knxTimeoutSec 0 = diese
// Pruefung aus.
function assessHealth({ mqtt, lox, knxService, lastKnxRx, now, knxTimeoutSec }) {
  const reasons = [];
  if (!mqtt) reasons.push('MQTT getrennt');
  if (!lox) reasons.push('Loxone nicht verbunden');
  if (knxService !== undefined && knxService !== 'active') reasons.push(`knx-mqtt ${knxService || 'unbekannt'}`);
  if (knxTimeoutSec > 0) {
    if (!lastKnxRx) reasons.push('noch kein KNX-Telegramm empfangen');
    else if (now - lastKnxRx > knxTimeoutSec * 1000) {
      reasons.push(`seit ${Math.round((now - lastKnxRx) / 1000)} s kein KNX-Telegramm`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = { toBool, toInterval, sameValue, LoxChangeFilter, EchoGuard, ReadQueue, assessHealth };
