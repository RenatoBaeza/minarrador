'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// tray.js reaches for Electron at import time, but only to destructure — nothing
// runs until a Tray is constructed, so its pure formatters are importable here.
const { clock } = require('../src/main/tray');

test('clock counts a meeting up in minutes and seconds', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(9), '0:09');
  assert.equal(clock(60), '1:00');
  assert.equal(clock(95), '1:35');
  assert.equal(clock(599), '9:59');
});

test('clock grows an hours field only once there is one', () => {
  // The tooltip is read at a glance mid-meeting, so a short recording should not
  // carry a leading "0:" that has to be parsed past.
  assert.equal(clock(3599), '59:59');
  assert.equal(clock(3600), '1:00:00');
  assert.equal(clock(3661), '1:01:01');
  assert.equal(clock(7325), '2:02:05');
});

test('clock truncates rather than rounding past the elapsed time', () => {
  // Elapsed comes from the WAV writer as a fraction; showing 1:00 while the file
  // holds 59.9s would let the clock run ahead of the recording.
  assert.equal(clock(59.9), '0:59');
  assert.equal(clock(0.4), '0:00');
});
