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

module.exports = { toBool, toInterval, sameValue, LoxChangeFilter };
