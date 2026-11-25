'use strict';

// Unit-Tests fuer bin/dptCodec.js - ohne Bus, ohne Abhaengigkeiten.
// Ausfuehren (Node >= 18):  node --test test/

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../bin/dptCodec');

const hex = (buf) => (buf === null ? null : buf.toString('hex'));
const B = (h) => Buffer.from(h, 'hex');

// Silence the codec's console.warn for unknown DPTs during tests.
test.beforeEach(() => { test.mock.method(console, 'warn', () => {}); });
test.afterEach(() => { test.mock.restoreAll(); });

test('DPT-Schreibweisen', () => {
  assert.equal(c.canonicalDpt('9.1'), '9.001');
  assert.equal(c.canonicalDpt(' 9.001 '), '9.001');
  assert.equal(c.canonicalDpt('DPST-9-1'), '9.001');
  assert.equal(c.canonicalDpt('5'), '5');
  assert.equal(hex(c.encode('DPST-5-1', 100)), 'ff');
});

test('DPT 1 (1 Bit)', () => {
  assert.equal(hex(c.encode('1.001', 1)), '01');
  assert.equal(hex(c.encode('1.001', 0)), '00');
  assert.equal(hex(c.encode('1.001', '0')), '00', 'String "0" muss 0 sein');
  assert.equal(hex(c.encode('1.001', '1')), '01');
  assert.equal(hex(c.encode('1.001', 'on')), '01');
  assert.equal(hex(c.encode('1.001', 'aus')), '00');
  assert.equal(hex(c.encode('1.001', true)), '01');
  assert.equal(hex(c.encode('1.001', 0.5)), '01');
  assert.equal(c.encode('1.001', ''), null);
  assert.equal(c.encode('1.001', 'abc'), null);
  assert.equal(c.encode('1.001', NaN), null);
  assert.equal(c.encode('1.001', undefined), null);
  assert.equal(c.decode('1.001', B('01')), 1);
  assert.equal(c.decode('1.001', B('00')), 0);
  assert.equal(c.decode('1.001', B('81')), 1);
});

test('leerer/fehlender Payload -> null', () => {
  for (const dpt of ['1.001', '5.001', '9.001', '10.001', '14.000', '16.000', '232.600', 'xyz']) {
    assert.equal(c.decode(dpt, Buffer.alloc(0)), null, dpt);
    assert.equal(c.decode(dpt, null), null, dpt);
  }
});

test('DPT 3 (4 Bit)', () => {
  assert.equal(hex(c.encode('3.007', 9)), '09');
  assert.equal(hex(c.encode('3.007', 99)), '0f');
  assert.equal(hex(c.encode('3.007', -1)), '00');
  assert.equal(c.decode('3.007', B('f9')), 9);
});

test('DPT 5 (8 Bit, 5.001 Prozent, 5.003 Winkel)', () => {
  assert.equal(hex(c.encode('5.001', 0)), '00');
  assert.equal(hex(c.encode('5.001', 100)), 'ff');
  assert.equal(hex(c.encode('5.001', 50)), '80');
  assert.equal(hex(c.encode('5.001', 150)), 'ff');
  assert.equal(hex(c.encode('5.001', -5)), '00');
  assert.equal(c.decode('5.001', B('ff')), 100);
  assert.equal(c.decode('5.001', B('80')), 50);
  assert.equal(hex(c.encode('5.003', 360)), 'ff');
  assert.equal(c.decode('5.003', B('ff')), 360);
  assert.equal(hex(c.encode('5.010', 255)), 'ff');
  assert.equal(hex(c.encode('5.010', 300)), 'ff');
  assert.equal(c.decode('5.010', B('2a')), 42);
  assert.equal(c.encode('5.001', 'x'), null);
});

test('DPT 6 (8 Bit signed)', () => {
  assert.equal(hex(c.encode('6.010', -1)), 'ff');
  assert.equal(hex(c.encode('6.010', -200)), '80');
  assert.equal(hex(c.encode('6.010', 200)), '7f');
  assert.equal(c.decode('6.010', B('80')), -128);
});

test('DPT 7/8 (16 Bit)', () => {
  assert.equal(hex(c.encode('7.001', 65535)), 'ffff');
  assert.equal(hex(c.encode('7.001', 70000)), 'ffff');
  assert.equal(hex(c.encode('7.001', -1)), '0000');
  assert.equal(c.decode('7.001', B('1234')), 0x1234);
  assert.equal(c.decode('7.001', B('12')), null);
  assert.equal(hex(c.encode('8.001', -32768)), '8000');
  assert.equal(hex(c.encode('8.001', 40000)), '7fff');
  assert.equal(c.decode('8.001', B('ffff')), -1);
});

test('DPT 9 (2-Byte-Float)', () => {
  assert.equal(hex(c.encode('9.001', 21.5)), '0c33');
  assert.equal(hex(c.encode('9.001', -5)), '860c');
  assert.equal(hex(c.encode('9.001', 0)), '0000');
  assert.equal(hex(c.encode('9.001', '21,5')), '0c33', 'Dezimalkomma');
  assert.equal(hex(c.encode('9.001', 670433.28)), '7ffe');
  assert.equal(hex(c.encode('9.001', 670760.96)), '7ffe', 'nie 0x7FFF (= ungueltig)');
  assert.equal(hex(c.encode('9.001', 1e9)), '7ffe', 'Obergrenze');
  assert.equal(hex(c.encode('9.001', -671088.64)), 'f800');
  assert.equal(hex(c.encode('9.001', -1e9)), 'f800', 'Untergrenze');
  assert.equal(c.encode('9.001', NaN), null, 'NaN darf nicht 0 °C werden');
  assert.equal(c.encode('9.001', 'abc'), null);
  assert.equal(c.encode('9.001', ''), null);
  assert.equal(c.decode('9.001', B('0c33')), 21.5);
  assert.equal(c.decode('9.001', B('860c')), -5);
  assert.equal(c.decode('9.001', B('7ffe')), 670433.28);
  assert.equal(c.decode('9.001', B('f800')), -671088.64);
  assert.equal(c.decode('9.001', B('7fff')), null, '0x7FFF = ungueltig');
  assert.equal(c.decode('9.001', B('0c')), null);
  // Rundlauf ueber typische Messbereiche
  for (const v of [-30, -0.5, 0.01, 5.5, 19.9, 22.37, 45, 99.9, 1013.25]) {
    const back = c.decode('9.001', c.encode('9.001', v));
    assert.ok(Math.abs(back - v) <= Math.max(0.01, Math.abs(v) * 0.001), `${v} -> ${back}`);
  }
});

test('DPT 10.001 Uhrzeit', () => {
  assert.equal(hex(c.encode('10.001', '13:45:30')), '0d2d1e');
  assert.equal(hex(c.encode('10.001', '7:05')), '070500');
  assert.equal(hex(c.encode('10.001', 13 * 3600 + 45 * 60 + 30)), '0d2d1e');
  assert.equal(c.encode('10.001', '25:00'), null);
  assert.equal(c.encode('10.001', 86400), null);
  assert.equal(c.encode('10.001', 'x'), null);
  // Mittwoch 25.11.2026 13:45:30 -> Tag 3 im oberen Bit-Teil
  assert.equal(hex(c.encode('10.001', new Date(2026, 10, 25, 13, 45, 30))), '6d2d1e');
  // Dekodieren ignoriert den Wochentag
  assert.equal(c.decode('10.001', B('6d2d1e')), 13 * 3600 + 45 * 60 + 30);
  assert.equal(c.decode('10.001', B('000000')), 0);
  assert.equal(c.decode('10.001', B('0d2d')), null);
  assert.equal(c.decode('10.001', B('183c00')), null, 'Stunde 24 ungueltig');
});

test('DPT 11.001 Datum', () => {
  assert.equal(hex(c.encode('11.001', 20261125)), '190b1a');
  assert.equal(hex(c.encode('11.001', '25.11.2026')), '190b1a');
  assert.equal(hex(c.encode('11.001', '2026-11-25')), '190b1a');
  assert.equal(hex(c.encode('11.001', new Date(2026, 10, 25))), '190b1a');
  assert.equal(hex(c.encode('11.001', 19991231)), '1f0c63');
  assert.equal(c.encode('11.001', 20261325), null, 'Monat 13');
  assert.equal(c.encode('11.001', 21000101), null, 'ausserhalb 1990-2089');
  assert.equal(c.decode('11.001', B('190b1a')), 20261125);
  assert.equal(c.decode('11.001', B('1f0c63')), 19991231);
  assert.equal(c.decode('11.001', B('010159')), 20890101);
  assert.equal(c.decode('11.001', B('010000')), null, 'Monat 0');
});

test('encodeTimeOfDay/encodeDate (Zeitgeber)', () => {
  const sunday = new Date(2026, 10, 29, 23, 59, 58);
  assert.equal(hex(c.encodeTimeOfDay(sunday)), 'f73b3a');
  assert.equal(hex(c.encodeDate(sunday)), '1d0b1a');
});

test('DPT 12/13 (32 Bit)', () => {
  assert.equal(hex(c.encode('12.001', 4294967295)), 'ffffffff');
  assert.equal(hex(c.encode('12.001', -1)), '00000000');
  assert.equal(c.decode('12.001', B('00010000')), 65536);
  assert.equal(hex(c.encode('13.010', -1)), 'ffffffff');
  assert.equal(c.decode('13.010', B('ffffffff')), -1);
  assert.equal(c.decode('13.010', B('ffff')), null);
});

test('DPT 14 (4-Byte-Float)', () => {
  assert.equal(hex(c.encode('14.056', 1.5)), '3fc00000');
  assert.equal(c.decode('14.056', B('3fc00000')), 1.5);
  assert.equal(c.encode('14.056', NaN), null);
  assert.equal(c.decode('14.056', B('7fc00000')), null, 'NaN vom Bus');
  assert.equal(c.decode('14.056', B('7f800000')), null, 'Infinity vom Bus');
});

test('DPT 16 (14-Byte-Text)', () => {
  const buf = c.encode('16.000', 'Hallo');
  assert.equal(buf.length, 14);
  assert.equal(hex(buf), '48616c6c6f' + '00'.repeat(9));
  assert.equal(c.decode('16.000', buf), 'Hallo');
  // Kuerzen auf 14 Zeichen
  assert.equal(c.decode('16.000', c.encode('16.000', 'ABCDEFGHIJKLMNOPQ')), 'ABCDEFGHIJKLMN');
  // Umlaute: 16.000 ASCII -> '?', 16.001 Latin-1 -> erhalten
  assert.equal(c.decode('16.000', c.encode('16.000', 'Küche')), 'K?che');
  assert.equal(hex(c.encode('16.001', 'Küche').subarray(0, 5)), '4bfc636865');
  assert.equal(c.decode('16.001', c.encode('16.001', 'Küche')), 'Küche');
  assert.equal(c.decode('16.001', c.encode('16.001', '20 °C')), '20 °C');
  assert.equal(hex(c.encode('16.000', '')), '00'.repeat(14));
  assert.equal(c.encode('16.000', null), null);
  assert.equal(c.decode('16.000', c.encode('16.000', 42)), '42');
});

test('DPT 232.600 (RGB)', () => {
  // Loxone-Format BBBGGGRRR (Prozent)
  assert.equal(hex(c.encode('232.600', 100)), 'ff0000', 'Rot 100 %');
  assert.equal(hex(c.encode('232.600', 100000)), '00ff00', 'Gruen 100 %');
  assert.equal(hex(c.encode('232.600', 100000000)), '0000ff', 'Blau 100 %');
  assert.equal(hex(c.encode('232.600', 100100100)), 'ffffff');
  assert.equal(hex(c.encode('232.600', 0)), '000000');
  assert.equal(hex(c.encode('232.600', '50000')), '008000', 'Gruen 50 % als String');
  assert.equal(c.encode('232.600', 101), null, 'Komponente > 100 %');
  assert.equal(c.encode('232.600', 200000000), null);
  assert.equal(c.encode('232.600', -1), null);
  // Weitere Schreibweisen
  assert.equal(hex(c.encode('232.600', '#FF8000')), 'ff8000');
  assert.equal(hex(c.encode('232.600', 'rgb(10, 20, 30)')), '0a141e');
  assert.equal(hex(c.encode('232.600', 'hsv(0,100,100)')), 'ff0000');
  assert.equal(hex(c.encode('232.600', 'hsv(120,100,100)')), '00ff00');
  assert.equal(hex(c.encode('232.600', 'hsv(240,100,50)')), '000080');
  assert.equal(hex(c.encode('232.600', 'hsv(0,0,100)')), 'ffffff');
  assert.equal(c.encode('232.600', 'blau'), null);
  // Dekodieren -> Loxone-Format
  assert.equal(c.decode('232.600', B('ff0000')), 100);
  assert.equal(c.decode('232.600', B('0000ff')), 100000000);
  assert.equal(c.decode('232.600', B('ff8000')), 50100);
  assert.equal(c.decode('232.600', B('ff00')), null);
});

test('DPT 17/18/20 (1 Byte)', () => {
  assert.equal(hex(c.encode('17.001', 5)), '05');
  assert.equal(hex(c.encode('18.001', 0x81)), '81');
  assert.equal(c.decode('20.102', B('03')), 3);
});

test('unbekannter DPT', () => {
  assert.equal(c.decode('99.001', B('2a')), 42);
  assert.equal(c.decode('99.001', B('0102')), '0102');
  assert.equal(hex(c.encode('99.001', 7)), '07');
  assert.equal(c.encode('99.001', 'x'), null);
  assert.equal(hex(c.encode('', 7)), '07');
});

test('Leitungsformat knx-mqtt/knx-go: Empfang', () => {
  // Befund 2026-11-25: 1/2/2 (9.007) Bus-Wert 0x1546 = 54 %, knx-mqtt liefert 00 15 46
  assert.equal(c.decodeWire('9.007', B('001546')), 54);
  assert.equal(c.decodeWire('9.001', B('000c33')), 21.5);
  assert.equal(c.decodeWire('9.001', B('0c33')), 21.5, 'ohne fuehrendes Byte weiterhin korrekt');
  assert.equal(c.decodeWire('11.001', B('00190b1a')), 20261125);
  assert.equal(c.decodeWire('10.001', B('006d2d1e')), 13 * 3600 + 45 * 60 + 30);
  assert.equal(c.decodeWire('5.001', B('00ff')), 100);
  assert.equal(c.decodeWire('5.001', B('ff')), 100);
  assert.equal(c.decodeWire('7.001', B('001234')), 0x1234);
  assert.equal(c.decodeWire('12.001', B('0000010000')), 65536);
  assert.equal(c.decodeWire('14.056', B('003fc00000')), 1.5);
  assert.equal(c.decodeWire('232.600', B('00ff0000')), 100);
  assert.equal(c.decodeWire('16.000', Buffer.concat([B('00'), c.encode('16.000', 'Hallo')])), 'Hallo');
  // <= 6 Bit: Wert steckt im ersten (einzigen) Byte, nichts entfernen
  assert.equal(c.decodeWire('1.001', B('01')), 1);
  assert.equal(c.decodeWire('1.001', B('00')), 0);
  assert.equal(c.decodeWire('3.007', B('09')), 9);
  // unbekannter DPT
  assert.equal(c.decodeWire('99.001', B('002a')), 42);
  assert.equal(c.decodeWire('99.001', B('2a')), 42);
  assert.equal(c.decodeWire('9.001', Buffer.alloc(0)), null);
});

test('Leitungsformat knx-mqtt/knx-go: Senden', () => {
  assert.equal(hex(c.encodeWire('9.001', 21.5)), '000c33');
  assert.equal(hex(c.encodeWire('9.007', 54)), '001546');
  assert.equal(hex(c.encodeWire('1.001', 1)), '01', 'DPT 1 ohne Praefix');
  assert.equal(hex(c.encodeWire('3.007', 9)), '09', 'DPT 3 ohne Praefix');
  assert.equal(hex(c.encodeWire('5.001', 100)), '00ff');
  assert.equal(hex(c.encodeWire('11.001', 20261125)), '00190b1a');
  assert.equal(hex(c.encodeWire('232.600', 100)), '00ff0000');
  assert.equal(c.encodeWire('16.000', 'Hallo').length, 15);
  assert.equal(c.encodeWire('9.001', 'abc'), null);
  assert.equal(hex(c.toWire('10.001', c.encodeTimeOfDay(new Date(2026, 10, 25, 13, 45, 30)))), '006d2d1e');
  // Rundlauf
  for (const [dpt, v] of [['9.001', -5], ['5.001', 50], ['13.010', -1], ['1.001', 1], ['11.001', 20261125]]) {
    assert.equal(c.decodeWire(dpt, c.encodeWire(dpt, v)), v, dpt);
  }
});
