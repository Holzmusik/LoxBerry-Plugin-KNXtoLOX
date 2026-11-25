'use strict';

// KNX-Datenpunkttyp (DPT) <-> JS-Wert Konvertierung, rein funktional, keine
// Abhängigkeiten. Unit-Tests: test/dptCodec.test.js (node --test test/).
//
// WICHTIG: dispatcht nach der KNX-HAUPTGRUPPE (die Zahl vor dem Punkt, z.B.
// "9" bei "9.001"), NICHT nach dem exakten Sub-Typ-String. Grund: reale
// ETS-Projekte enthalten weit mehr unterschiedliche DPT-Subtypen als eine
// von uns gepflegte Liste je abdecken könnte (z.B. 9.007 Feuchte, 9.008
// Luftqualität, 5.004 Prozent 0-255 roh, 13.010 aktive Energie, ...) - die
// Hauptgruppe bestimmt aber bei den allermeisten KNX-DPTs bereits das
// physische Byte-Format (Länge + Interpretation), der Sub-Typ nur die
// Einheit/Semantik. Ausnahmen mit eigener Skalierung (5.001, 5.003) und
// eigener Zeichenkodierung (16.000/16.001) werden explizit behandelt.
// Unbekannte Hauptgruppen fallen beim Dekodieren auf den Rohwert zurück
// statt zu werfen, damit ein einzelner exotischer DPT nicht die ganze
// Bridge stoppt.
//
// Ungültige Eingaben (NaN, leerer String, unbekanntes Wort, zu kurzer
// Payload) liefern IMMER null - in BEIDE Richtungen. Aufrufer senden bei
// null nichts. Früher wurde z.B. aus NaN bei DPT 9 der Wert 0 (= 0 °C) und
// aus dem String "0" bei DPT 1 eine 1 gesendet.

function normalizeDpt(dpt) {
  return String(dpt == null ? '' : dpt).trim().toLowerCase();
}

// "9.007" -> "9", "9" -> "9", "dpst-9-1" -> "9", "raw"/"" -> null
function mainGroup(dpt) {
  const m = /^(?:dpst-|dpt-?)?(\d+)/.exec(dpt);
  return m ? m[1] : null;
}

// "9.001" -> "9.001", "dpst-9-1" -> "9.001", "9" -> "9"
function canonicalDpt(dpt) {
  const d = normalizeDpt(dpt);
  const m = /^(?:dpst-|dpt-?)?(\d+)(?:[.-](\d+))?/.exec(d);
  if (!m) return d;
  return m[2] !== undefined ? `${m[1]}.${m[2].padStart(3, '0')}` : m[1];
}

// ── Eingabe-Normalisierung (Loxone liefert Zahlen ODER Text) ───────────────
// Liefert eine endliche Zahl oder null. Akzeptiert Dezimalkomma ("21,5"),
// weil Loxone-Texte und Benutzer-Eingaben das in DE gerne enthalten.
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const TRUE_WORDS  = new Set(['true', 'on', 'ein', 'an', 'yes', 'ja']);
const FALSE_WORDS = new Set(['false', 'off', 'aus', 'no', 'nein']);

// 1/0 oder null. Zahl != 0 -> 1 (Loxone-Digitalzustand ist 0/1, Analog
// z.B. 0.5 gilt ebenfalls als "an", wie bei Loxones eigenen Digital-Eingängen).
function toBit(value) {
  if (typeof value === 'string') {
    const w = value.trim().toLowerCase();
    if (TRUE_WORDS.has(w)) return 1;
    if (FALSE_WORDS.has(w)) return 0;
  }
  const n = toNumber(value);
  if (n === null) return null;
  return n !== 0 ? 1 : 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampByte = (v) => clamp(Math.round(v), 0, 255);

// ── DPT 9: KNX 2-Byte-Float ────────────────────────────────────────────────
// Wert = 0.01 * Mantisse * 2^Exponent. Bit-Layout MSB..LSB:
// S EEEE MMM | MMMMMMMM (S=Vorzeichen, E=4-Bit-Exponent, M=11-Bit-Mantisse,
// S ist Teil der Zweierkomplement-Darstellung von M).
// Obergrenze 2046 statt 2047: 2047 * 2^15 ergaebe das Bitmuster 0x7FFF, und
// das bedeutet laut KNX-Spezifikation "ungueltige Daten".
const FLOAT16_MIN = -671088.64; // -2048 * 0.01 * 2^15
const FLOAT16_MAX = 670433.28;  //  2046 * 0.01 * 2^15

function decodeFloat16(buf) {
  const hi = buf[0], lo = buf[1];
  // 0x7FFF ist laut KNX-Spezifikation "ungültige Daten"
  if (hi === 0x7f && lo === 0xff) return null;
  const sign = (hi & 0x80) >> 7;
  const exponent = (hi & 0x78) >> 3;
  let mantissa = ((hi & 0x07) << 8) | lo;
  if (sign) mantissa -= 2048;
  return Math.round(0.01 * mantissa * Math.pow(2, exponent) * 100) / 100;
}

function encodeFloat16(value) {
  const v = clamp(value, FLOAT16_MIN, FLOAT16_MAX);
  let mantissa = Math.round(v * 100);
  let exponent = 0;
  while ((mantissa > 2047 || mantissa < -2048) && exponent < 15) {
    mantissa = Math.round(mantissa / 2);
    exponent++;
  }
  mantissa = clamp(mantissa, -2048, exponent === 15 ? 2046 : 2047);
  const sign = mantissa < 0 ? 1 : 0;
  if (mantissa < 0) mantissa += 2048;
  const hi = (sign << 7) | (exponent << 3) | ((mantissa >> 8) & 0x07);
  const lo = mantissa & 0xff;
  return Buffer.from([hi, lo]);
}

// ── DPT 10.001 Uhrzeit / 11.001 Datum ──────────────────────────────────────
// DPT 10.001, 3 Byte: Byte0 = Wochentag(3 Bit, 1=Mo..7=So, 0=keiner)
// + Stunde(5 Bit) | Byte1 = Minute(6 Bit) | Byte2 = Sekunde(6 Bit)
// DPT 11.001, 3 Byte: Byte0 = Tag(5 Bit) | Byte1 = Monat(4 Bit) |
// Byte2 = Jahr zweistellig (0-99, per Konvention 0-89=2000-2089, 90-99=1990-1999)
//
// Richtung Loxone (Analogwert eines virtuellen Eingangs):
//   Uhrzeit -> Sekunden seit Mitternacht (0..86399)
//   Datum   -> JJJJMMTT als Zahl (z.B. 20261125)

function encodeTimeOfDay(date) {
  const jsDay = date.getDay(); // JS: 0=So,1=Mo,...,6=Sa
  const knxDay = jsDay === 0 ? 7 : jsDay; // KNX: 1=Mo..7=So
  const b0 = ((knxDay & 0x07) << 5) | (date.getHours() & 0x1f);
  const b1 = date.getMinutes() & 0x3f;
  const b2 = date.getSeconds() & 0x3f;
  return Buffer.from([b0, b1, b2]);
}

function encodeDate(date) {
  const b0 = date.getDate() & 0x1f;
  const b1 = (date.getMonth() + 1) & 0x0f;
  const b2 = (date.getFullYear() % 100) & 0x7f;
  return Buffer.from([b0, b1, b2]);
}

// Eingabe: Date, Sekunden seit Mitternacht (Zahl) oder "HH:MM[:SS]".
// Wochentag wird nur bei Date gesetzt, sonst 0 (= "kein Tag").
function encodeTimeValue(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : encodeTimeOfDay(value);
  let h, m, s;
  const str = typeof value === 'string' ? value.trim() : '';
  const tm = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(str);
  if (tm) {
    h = +tm[1]; m = +tm[2]; s = tm[3] !== undefined ? +tm[3] : 0;
  } else {
    const n = toNumber(value);
    if (n === null || n < 0 || n >= 86400) return null;
    const t = Math.floor(n);
    h = Math.floor(t / 3600); m = Math.floor((t % 3600) / 60); s = t % 60;
  }
  if (h > 23 || m > 59 || s > 59) return null;
  return Buffer.from([h & 0x1f, m & 0x3f, s & 0x3f]);
}

function decodeTimeValue(buf) {
  if (buf.length < 3) return null;
  const h = buf[0] & 0x1f, m = buf[1] & 0x3f, s = buf[2] & 0x3f;
  if (h > 23 || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

// Eingabe: Date, JJJJMMTT (Zahl/String), "TT.MM.JJJJ" oder "JJJJ-MM-TT".
function encodeDateValue(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : encodeDate(value);
  let y, mo, d;
  const str = typeof value === 'string' ? value.trim() : '';
  let mm;
  if ((mm = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(str))) {
    d = +mm[1]; mo = +mm[2]; y = +mm[3];
  } else if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str))) {
    y = +mm[1]; mo = +mm[2]; d = +mm[3];
  } else {
    const n = toNumber(value);
    if (n === null || !Number.isInteger(n)) return null;
    y = Math.floor(n / 10000); mo = Math.floor((n % 10000) / 100); d = n % 100;
  }
  if (y < 1990 || y > 2089 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Buffer.from([d & 0x1f, mo & 0x0f, (y % 100) & 0x7f]);
}

function decodeDateValue(buf) {
  if (buf.length < 3) return null;
  const d = buf[0] & 0x1f, mo = buf[1] & 0x0f, yy = buf[2] & 0x7f;
  if (d < 1 || mo < 1 || mo > 12 || yy > 99) return null;
  const y = yy < 90 ? 2000 + yy : 1900 + yy;
  return y * 10000 + mo * 100 + d;
}

// ── DPT 16: 14-Byte-Text ───────────────────────────────────────────────────
// 16.000 = ASCII (Zeichen > 0x7F werden zu "?"), 16.001 = ISO-8859-1.
// Immer genau 14 Byte, kürzere Texte mit 0x00 aufgefüllt, längere gekürzt.
const TEXT_LEN = 14;

function encodeText(dpt, value) {
  if (value === null || value === undefined) return null;
  const latin1 = canonicalDpt(dpt) === '16.001';
  const str = String(value);
  const buf = Buffer.alloc(TEXT_LEN, 0);
  let i = 0;
  for (const ch of str) {
    if (i >= TEXT_LEN) break;
    const code = ch.codePointAt(0);
    buf[i++] = (latin1 ? code <= 0xff : code <= 0x7f) ? code : 0x3f; // '?'
  }
  return buf;
}

function decodeText(dpt, buf) {
  const latin1 = canonicalDpt(dpt) === '16.001';
  let end = buf.indexOf(0x00);
  if (end < 0) end = buf.length;
  const part = buf.subarray(0, Math.min(end, TEXT_LEN));
  if (latin1) return part.toString('latin1');
  return Array.from(part, (b) => (b <= 0x7f ? String.fromCharCode(b) : '?')).join('');
}

// ── DPT 232.600: RGB, 3 Byte (R, G, B je 0-255) ────────────────────────────
// Richtung Loxone wird das Loxone-RGB-Format verwendet, das Loxone selbst an
// Analog-Ausgängen/-Eingängen für Farben benutzt: BBBGGGRRR als Zahl, jede
// Komponente in Prozent 0-100 (z.B. 100000000 = Blau 100 %, 100 = Rot 100 %).
// Akzeptierte Eingaben beim Kodieren:
//   - Loxone-Zahl BBBGGGRRR (Zahl oder Ziffern-String)
//   - "hsv(h,s,v)"  h 0-360, s/v 0-100 (Lichtsteuerungs-Zustände)
//   - "rgb(r,g,b)"  je 0-255
//   - "#RRGGBB"
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; v = clamp(v, 0, 100) / 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}

function encodeRgb(value) {
  const str = typeof value === 'string' ? value.trim().toLowerCase() : '';
  let mm;
  if ((mm = /^#([0-9a-f]{6})$/.exec(str))) {
    const n = parseInt(mm[1], 16);
    return Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  }
  if ((mm = /^hsv\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(str))) {
    return Buffer.from(hsvToRgb(+mm[1], +mm[2], +mm[3]));
  }
  if ((mm = /^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(str))) {
    return Buffer.from([clampByte(+mm[1]), clampByte(+mm[2]), clampByte(+mm[3])]);
  }
  const n = toNumber(value);
  if (n === null || n < 0 || !Number.isInteger(n) || n > 100100100) return null;
  const pr = n % 1000, pg = Math.floor(n / 1000) % 1000, pb = Math.floor(n / 1000000);
  if (pr > 100 || pg > 100 || pb > 100) return null;
  const toByte = (p) => clampByte((p * 255) / 100);
  return Buffer.from([toByte(pr), toByte(pg), toByte(pb)]);
}

function decodeRgb(buf) {
  if (buf.length < 3) return null;
  const toPct = (b) => Math.round((b * 100) / 255);
  return toPct(buf[2]) * 1000000 + toPct(buf[1]) * 1000 + toPct(buf[0]);
}

// ── Dekodieren: Buffer mit rohen KNX-Bytes -> JS-Wert (Zahl oder Text) ─────
function decode(dpt, buf) {
  const d = canonicalDpt(dpt);
  const g = mainGroup(d);
  if (!buf || buf.length === 0) return null;

  if (g === '1') {
    // Bewusst 1/0 (Zahl), nicht true/false (Boolean): sendToLoxone() baut den
    // Loxone-Befehl per String-Interpolation ("jdev/sps/io/<uuid>/${value}")
    // - ein JS-Boolean wuerde dabei zum WORT "true"/"false" statt "1"/"0",
    // was Loxones Virtueller Eingang nicht als digitalen Zustand versteht.
    return (buf[0] & 0x01) === 1 ? 1 : 0;
  }
  if (g === '3') {
    // 4 Bit (1 Bit Richtung + 3 Bit Schrittweite, Dimmen/Jalousie) - roh 0-15.
    return buf[0] & 0x0f;
  }
  if (d === '5.001') return Math.round((buf[0] * 100) / 255);
  if (d === '5.003') return Math.round((buf[0] * 360) / 255);
  if (g === '5')  return buf[0];
  if (g === '6')  return buf.readInt8(0);
  if (g === '7')  return buf.length < 2 ? null : buf.readUInt16BE(0);
  if (g === '8')  return buf.length < 2 ? null : buf.readInt16BE(0);
  if (g === '9')  return buf.length < 2 ? null : decodeFloat16(buf);
  if (g === '10') return decodeTimeValue(buf);
  if (g === '11') return decodeDateValue(buf);
  if (g === '12') return buf.length < 4 ? null : buf.readUInt32BE(0);
  if (g === '13') return buf.length < 4 ? null : buf.readInt32BE(0);
  if (g === '14') {
    if (buf.length < 4) return null;
    const f = buf.readFloatBE(0);
    return Number.isFinite(f) ? f : null;
  }
  if (g === '16') return decodeText(d, buf);
  if (g === '17' || g === '18' || g === '20') return buf[0];
  if (g === '232') return decodeRgb(buf);

  // Fallback: unbekannte/nicht abgedeckte Hauptgruppe -> Rohwert durchreichen.
  console.warn(`[dptCodec] Unbekannter DPT "${dpt}", reiche Rohbytes durch:`, buf.toString('hex'));
  return buf.length === 1 ? buf[0] : buf.toString('hex');
}

// ── Kodieren: JS-Wert -> Buffer mit rohen KNX-Bytes, oder null ─────────────
function encode(dpt, value) {
  const d = canonicalDpt(dpt);
  const g = mainGroup(d);

  if (g === '1') {
    const b = toBit(value);
    return b === null ? null : Buffer.from([b]);
  }
  if (g === '10') return encodeTimeValue(value);
  if (g === '11') return encodeDateValue(value);
  if (g === '16') return encodeText(d, value);
  if (g === '232') return encodeRgb(value);

  const n = toNumber(value);
  if (n === null) return null;

  if (g === '3')     return Buffer.from([clamp(Math.round(n), 0, 15)]);
  if (d === '5.001') return Buffer.from([clampByte((n * 255) / 100)]);
  if (d === '5.003') return Buffer.from([clampByte((n * 255) / 360)]);
  if (g === '5' || g === '17' || g === '18' || g === '20') return Buffer.from([clampByte(n)]);
  if (g === '6') {
    const buf = Buffer.alloc(1);
    buf.writeInt8(clamp(Math.round(n), -128, 127), 0);
    return buf;
  }
  if (g === '7') {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(clamp(Math.round(n), 0, 65535), 0);
    return buf;
  }
  if (g === '8') {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(clamp(Math.round(n), -32768, 32767), 0);
    return buf;
  }
  if (g === '9') return encodeFloat16(n);
  if (g === '12') {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(clamp(Math.round(n), 0, 4294967295), 0);
    return buf;
  }
  if (g === '13') {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(clamp(Math.round(n), -2147483648, 2147483647), 0);
    return buf;
  }
  if (g === '14') {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(n, 0);
    return buf;
  }

  console.warn(`[dptCodec] Unbekannter DPT "${dpt}" beim Kodieren, sende Rohwert als 1 Byte:`, value);
  return Buffer.from([clampByte(n)]);
}

module.exports = {
  decode, encode, normalizeDpt, canonicalDpt,
  encodeTimeOfDay, encodeDate,
  // fuer Tests
  encodeFloat16, decodeFloat16,
};
