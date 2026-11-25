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
