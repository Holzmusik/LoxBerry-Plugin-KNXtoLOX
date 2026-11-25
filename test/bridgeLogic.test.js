'use strict';

// Unit-Tests fuer bin/bridgeLogic.js - ohne Bus, ohne Miniserver.
// Ausfuehren (Node >= 18):  node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../bin/bridgeLogic');

test('toBool / toInterval', () => {
  for (const v of [true, 1, '1', 'true', 'ja', 'X', ' on ']) assert.equal(L.toBool(v), true, String(v));
  for (const v of [false, 0, '0', 'false', 'nein', '', null, undefined]) assert.equal(L.toBool(v), false, String(v));
  assert.equal(L.toInterval(60, 5), 60);
  assert.equal(L.toInterval('61', 5), 61);
  assert.equal(L.toInterval(1, 5), 5, 'Untergrenze');
  assert.equal(L.toInterval(0, 5), 0);
  assert.equal(L.toInterval('', 5), 0);
  assert.equal(L.toInterval('abc', 5), 0);
  assert.equal(L.toInterval(-3, 5), 0);
});

test('Punkt 1: Initial-Dump nach Bridge-Start wird nicht gesendet', () => {
  const f = new L.LoxChangeFilter();
  f.newConnection();
  assert.equal(f.shouldSend('a', 1, false), false, 'erster Wert: nur merken');
  assert.equal(f.shouldSend('a', 0, false), true, 'echte Aenderung');
  assert.equal(f.shouldSend('a', 0, false), false, 'gleicher Wert');
  assert.equal(f.shouldSend('a', 1, false), true);
});

test('Punkt 1: Reconnect-Dump mit unveraenderten Werten wird nicht gesendet', () => {
  const f = new L.LoxChangeFilter();
  f.newConnection();
  f.shouldSend('a', 1, false);
  f.shouldSend('b', 22.5, false);
  f.newConnection(); // Miniserver-Neustart
  assert.equal(f.shouldSend('a', 1, false), false);
  assert.equal(f.shouldSend('b', 23, false), true, 'waehrend der Trennung geaendert');
});

test('Punkt 1: send_on_connect sendet den Dump jeder Verbindung', () => {
  const f = new L.LoxChangeFilter();
  f.newConnection();
  assert.equal(f.shouldSend('a', 1, true), true, 'erster Wert');
  assert.equal(f.shouldSend('a', 1, true), false, 'danach nur Aenderungen');
  f.newConnection();
  assert.equal(f.shouldSend('a', 1, true), true, 'nach Reconnect erneut');
});

test('Punkt 1: Snapshot ueberlebt Bridge-Neustart', () => {
  const f1 = new L.LoxChangeFilter();
  f1.newConnection();
  f1.shouldSend('a', 1, false);
  f1.shouldSend('b', 5, false);
  const snap = JSON.parse(JSON.stringify(f1.snapshot()));

  const f2 = new L.LoxChangeFilter();
  f2.load(snap);
  f2.newConnection();
  assert.equal(f2.shouldSend('a', 1, false), false, 'unveraendert');
  assert.equal(f2.shouldSend('b', 6, false), true, 'geaendert waehrend Bridge aus war');
  assert.equal(f2.shouldSend('c', 1, false), false, 'unbekannt: nur merken');
});

test('Punkt 7: Echo-Unterdrueckung', () => {
  const g = new L.EchoGuard(1000);
  const b = (h) => Buffer.from(h, 'hex');
  g.noteBusValue('1/2/3', b('80'), 10000);
  assert.equal(g.isEcho('1/2/3', b('80'), 10500), true, 'gleiche Bytes innerhalb 1 s');
  assert.equal(g.isEcho('1/2/3', b('81'), 10500), false, 'anderer Wert');
  assert.equal(g.isEcho('1/2/4', b('80'), 10500), false, 'andere GA');
  assert.equal(g.isEcho('1/2/3', b('80'), 11000), false, 'Fenster abgelaufen');
  assert.equal(new L.EchoGuard(0).isEcho('1/2/3', b('80'), 10000), false, '0 = aus');
});

test('Punkt 2: Leseanfragen gedrosselt und ohne Doppelte', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = [];
  let online = true;
  const q = new L.ReadQueue(10, (a) => sent.push(a), () => online);
  q.enqueue(['1/2/1', '1/2/2', '1/2/1']);
  q.enqueue('1/2/2');
  assert.equal(q.size, 2, 'Doppelte entfernt');
  t.mock.timers.tick(99);
  assert.deepEqual(sent, [], 'noch nichts vor 100 ms');
  t.mock.timers.tick(1);
  assert.deepEqual(sent, ['1/2/1']);
  online = false;
  t.mock.timers.tick(500);
  assert.deepEqual(sent, ['1/2/1'], 'angehalten solange offline');
  online = true;
  t.mock.timers.tick(100);
  assert.deepEqual(sent, ['1/2/1', '1/2/2']);
  q.enqueue('1/2/1');
  t.mock.timers.tick(100);
  assert.deepEqual(sent, ['1/2/1', '1/2/2', '1/2/1'], 'nach dem Senden erneut einreihbar');
  q.stop();
});

test('Punkt 2: Rate wird begrenzt', () => {
  assert.equal(new L.ReadQueue(10, () => {}).intervalMs, 100);
  assert.equal(new L.ReadQueue(1000, () => {}).intervalMs, 20, 'max 50/s');
  assert.equal(new L.ReadQueue(0, () => {}).intervalMs, 100, 'Standard 10/s');
});

test('Punkt 8: Gesamtzustand', () => {
  const base = { mqtt: true, lox: true, knxService: 'active', lastKnxRx: 1000, now: 60000, knxTimeoutSec: 300 };
  assert.deepEqual(L.assessHealth(base), { ok: true, reasons: [] });
  assert.equal(L.assessHealth({ ...base, mqtt: false }).ok, false);
  assert.equal(L.assessHealth({ ...base, lox: false }).ok, false);
  assert.equal(L.assessHealth({ ...base, knxService: 'failed' }).ok, false);
  assert.equal(L.assessHealth({ ...base, knxService: undefined }).ok, true, 'Dienststatus unbekannt -> nicht gewertet');
  assert.equal(L.assessHealth({ ...base, lastKnxRx: 0 }).ok, false, 'noch nie etwas empfangen');
  assert.equal(L.assessHealth({ ...base, now: 1000 + 301000 }).ok, false, 'Timeout');
  assert.equal(L.assessHealth({ ...base, lastKnxRx: 0, knxTimeoutSec: 0 }).ok, true, 'Timeout-Pruefung aus');
});
