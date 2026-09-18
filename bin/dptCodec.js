'use strict';

// KNX-Datenpunkttyp (DPT) <-> JS-Wert Konvertierung, rein funktional, keine
// Abhängigkeiten.
//
// WICHTIG: dispatcht nach der KNX-HAUPTGRUPPE (die Zahl vor dem Punkt, z.B.
// "9" bei "9.001"), NICHT nach dem exakten Sub-Typ-String. Grund: reale
// ETS-Projekte enthalten weit mehr unterschiedliche DPT-Subtypen als eine
// von uns gepflegte Liste je abdecken könnte (z.B. 9.007 Feuchte, 9.008
// Luftqualität, 5.004 Prozent 0-255 roh, 13.010 aktive Energie, ...) - die
// Hauptgruppe bestimmt aber bei den allermeisten KNX-DPTs bereits das
// physische Byte-Format (Länge + Interpretation), der Sub-Typ nur die
// Einheit/Semantik. Deshalb deckt eine Dispatch-nach-Hauptgruppe praktisch
// jeden real vorkommenden Sub-Typ korrekt ab, ohne ihn einzeln zu kennen.
// Unbekannte/nicht abgedeckte Hauptgruppen fallen auf den Rohwert zurück
// statt zu werfen, damit ein einzelner exotischer DPT nicht die ganze
// Bridge stoppt.

function normalizeDpt(dpt) {
  return (dpt || '').trim().toLowerCase();
}

// "9.007" -> "9", "9" -> "9", "raw"/"" -> null
function mainGroup(dpt) {
  const m = /^(\d+)/.exec(dpt);
  return m ? m[1] : null;
}

// KNX 2-Byte-Float (DPT 9.xxx): Wert = 0.01 * Mantisse * 2^Exponent.
// Bit-Layout MSB..LSB: S EEEE MMM | MMMMMMMM (S=Vorzeichen, E=4-Bit-Exponent,
// M=11-Bit-Mantisse, S ist Teil der Zweierkomplement-Darstellung von M).
function decodeFloat16(buf) {
  const hi = buf[0], lo = buf[1];
  const sign = (hi & 0x80) >> 7;
  const exponent = (hi & 0x78) >> 3;
  let mantissa = ((hi & 0x07) << 8) | lo;
  if (sign) mantissa -= 2048;
  return Math.round(0.01 * mantissa * Math.pow(2, exponent) * 100) / 100;
}

function encodeFloat16(value) {
  const sign = value < 0 ? 1 : 0;
  let mantissa = Math.round(value * 100);
  let exponent = 0;
  while (mantissa > 2047 || mantissa < -2048) {
    mantissa = Math.round(mantissa / 2);
    exponent++;
  }
  if (mantissa < 0) mantissa += 2048;
  const hi = (sign << 7) | (exponent << 3) | ((mantissa >> 8) & 0x07);
  const lo = mantissa & 0xff;
  return Buffer.from([hi, lo]);
}

// buf: Buffer mit den rohen KNX-Bytes -> JS-Wert (Zahl)
function decode(dpt, buf) {
  const d = normalizeDpt(dpt);
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
    // 4 Bit (1 Bit Richtung + 3 Bit Schrittweite, z.B. Dimmen/Jalousie-
    // Steuerung) - Richtung/Schrittweite werden hier NICHT einzeln
    // aufgeschluesselt (dafuer bräuchte Loxone ohnehin zwei getrennte
    // Werte), sondern als roher 4-Bit-Wert (0-15) durchgereicht.
    return buf[0] & 0x0f;
  }
  if (d === '5.001') {
    return Math.round((buf[0] * 100) / 255);
  }
  if (g === '5') {
    // Alle anderen 5.xxx (5.010 Zaehler, 5.004 Prozent 0-255 roh, ...) als
    // rohes Byte 0-255 - nur 5.001 hat die spezielle 0-100%-Skalierung.
    return buf[0];
  }
  if (g === '6') {
    // 8-Bit VORZEICHENBEHAFTET (-128..127), z.B. 6.010 Zaehler.
    return buf.readInt8(0);
  }
  if (g === '9') {
    if (buf.length < 2) return null;
    return decodeFloat16(buf);
  }
  if (g === '7') {
    if (buf.length < 2) return null;
    return buf.readUInt16BE(0);
  }
  if (g === '8') {
    if (buf.length < 2) return null;
    return buf.readInt16BE(0);
  }
  if (g === '12') {
    if (buf.length < 4) return null;
    return buf.readUInt32BE(0);
  }
  if (g === '13') {
    if (buf.length < 4) return null;
    return buf.readInt32BE(0);
  }
  if (g === '14') {
    if (buf.length < 4) return null;
    return buf.readFloatBE(0);
  }
  if (g === '17' || g === '18' || g === '20') {
    // Szenennummer/-steuerung, HVAC-Modus u.ae. - 1 Byte, roh als Zahl.
    return buf[0];
  }

  // Fallback: unbekannte/nicht abgedeckte Hauptgruppe -> Rohwert durchreichen.
  console.warn(`[dptCodec] Unbekannter DPT "${dpt}", reiche Rohbytes durch:`, buf.toString('hex'));
  return buf.length === 1 ? buf[0] : buf.toString('hex');
}

// value: JS-Wert (Zahl) -> Buffer mit rohen KNX-Bytes
function encode(dpt, value) {
  const d = normalizeDpt(dpt);
  const g = mainGroup(d);
  const n = Number(value);
  const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));

  if (g === '1') {
    return Buffer.from([value ? 1 : 0]);
  }
  if (g === '3') {
    return Buffer.from([clampByte(n) & 0x0f]);
  }
  if (d === '5.001') {
    return Buffer.from([clampByte((n * 255) / 100)]);
  }
  if (g === '5') {
    return Buffer.from([clampByte(n)]);
  }
  if (g === '6') {
    const buf = Buffer.alloc(1);
    buf.writeInt8(Math.max(-128, Math.min(127, Math.round(n))), 0);
    return buf;
  }
  if (g === '9') {
    return encodeFloat16(n);
  }
  if (g === '7') {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(n))), 0);
    return buf;
  }
  if (g === '8') {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(n))), 0);
    return buf;
  }
  if (g === '12') {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(Math.max(0, Math.min(4294967295, Math.round(n))), 0);
    return buf;
  }
  if (g === '13') {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(Math.max(-2147483648, Math.min(2147483647, Math.round(n))), 0);
    return buf;
  }
  if (g === '14') {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(n, 0);
    return buf;
  }
  if (g === '17' || g === '18' || g === '20') {
    return Buffer.from([clampByte(n)]);
  }

  console.warn(`[dptCodec] Unbekannter DPT "${dpt}" beim Kodieren, sende Rohwert als 1 Byte:`, value);
  return Buffer.from([Number(value) & 0xff]);
}

// ── KNX-Zeitgeber (DPT 10.001 Uhrzeit, DPT 11.001 Datum) ───────────────────
// Oeffentlich dokumentierter KNX-Standard (nicht projektspezifisch geraten
// wie vieles andere in diesem Plugin) - fuer den periodischen Systemzeit-
// Push von bin/bridge.js auf konfigurierbare Gruppenadressen, damit
// KNX-Geraete am Bus (Uhren/Displays) die richtige Zeit anzeigen koennen.

// DPT 10.001, 3 Byte: Byte0 = Wochentag(3 Bit, 1=Mo..7=So, 0=nicht verwendet)
// + Stunde(5 Bit) | Byte1 = Minute(6 Bit) | Byte2 = Sekunde(6 Bit)
function encodeTimeOfDay(date) {
  const jsDay = date.getDay(); // JS: 0=So,1=Mo,...,6=Sa
  const knxDay = jsDay === 0 ? 7 : jsDay; // KNX: 1=Mo..7=So
  const b0 = ((knxDay & 0x07) << 5) | (date.getHours() & 0x1f);
  const b1 = date.getMinutes() & 0x3f;
  const b2 = date.getSeconds() & 0x3f;
  return Buffer.from([b0, b1, b2]);
}

// DPT 11.001, 3 Byte: Byte0 = Tag(5 Bit) | Byte1 = Monat(4 Bit) |
// Byte2 = Jahr zweistellig (0-99, per Konvention 0-89=2000-2089, 90-99=1990-1999)
function encodeDate(date) {
  const b0 = date.getDate() & 0x1f;
  const b1 = (date.getMonth() + 1) & 0x0f;
  const b2 = (date.getFullYear() % 100) & 0x7f;
  return Buffer.from([b0, b1, b2]);
}

module.exports = { decode, encode, normalizeDpt, encodeTimeOfDay, encodeDate };
