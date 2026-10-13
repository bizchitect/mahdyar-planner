'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { nowRailEventPosition, nowRailState, __mainPath } = require('./harness.cjs');

const minute = 60000;
const mainSource = fs.readFileSync(__mainPath, 'utf8');

test('the now-rail interval is singular per view and cleared on close', () => {
  assert.match(mainSource, /if \(this\.nowRailInterval != null\) window\.clearInterval\(this\.nowRailInterval\);\s*this\.nowRailInterval = window\.setInterval\(\(\) => this\.updateNowRail\(\), 1000\);\s*this\.plugin\.registerInterval\(this\.nowRailInterval\);/);
  assert.match(mainSource, /async onClose\(\) \{\s*if \(this\.nowRailInterval != null\) \{\s*window\.clearInterval\(this\.nowRailInterval\);\s*this\.nowRailInterval = null;\s*\}\s*this\.contentEl\.empty\(\);\s*\}/);
});

test('the now rail aligns with event start, midpoint, and end', () => {
  const meeting = { startMs: 8 * 60 * minute, endMs: 9 * 60 * minute, top: 100, bottom: 220 };

  assert.equal(nowRailEventPosition(meeting.startMs, [meeting]), 100);
  assert.equal(nowRailEventPosition(8.5 * 60 * minute, [meeting]), 160);
  assert.equal(nowRailEventPosition(meeting.endMs, [meeting]), 220);
});

test('the now rail traverses the blank interval between event boundaries', () => {
  const events = [
    { startMs: 8 * 60 * minute, endMs: 9 * 60 * minute, top: 100, bottom: 160 },
    { startMs: 11 * 60 * minute, endMs: 12 * 60 * minute, top: 260, bottom: 320 },
  ];

  assert.equal(nowRailEventPosition(10 * 60 * minute, events), 210);
});

test('a lone event connects the workday anchors before and after its boundaries', () => {
  const meeting = { startMs: 9 * 60 * minute, endMs: 10 * 60 * minute, top: 100, bottom: 160 };
  const workday = {
    startMs: 8 * 60 * minute, endMs: 18 * 60 * minute,
    startPosition: 40, endPosition: 640,
  };

  assert.equal(nowRailEventPosition(8 * 60 * minute, [meeting], workday), 40);
  assert.equal(nowRailEventPosition(8.5 * 60 * minute, [meeting], workday), 70);
  assert.equal(nowRailEventPosition(meeting.startMs, [meeting], workday), meeting.top);
  assert.equal(nowRailEventPosition(meeting.endMs, [meeting], workday), meeting.bottom);
  assert.equal(nowRailEventPosition(14 * 60 * minute, [meeting], workday), 400);
  assert.equal(nowRailEventPosition(workday.endMs, [meeting], workday), workday.endPosition);
});

test('the now rail remains visible during timed events outside workday bounds', () => {
  const early = { startMs: 7 * 60 * minute, endMs: 8 * 60 * minute, top: 20, bottom: 80 };
  const late = { startMs: 18 * 60 * minute, endMs: 19 * 60 * minute, top: 500, bottom: 560 };

  assert.equal(nowRailState(7.5 * 60, 8 * 60, 18 * 60, 7.5 * 60 * minute, [early]), 'on');
  assert.equal(nowRailState(6.5 * 60, 8 * 60, 18 * 60, 6.5 * 60 * minute, [early]), 'before');
  assert.equal(nowRailState(18.5 * 60, 8 * 60, 18 * 60, 18.5 * 60 * minute, [late]), 'on');
  assert.equal(nowRailState(19.5 * 60, 8 * 60, 18 * 60, 19.5 * 60 * minute, [late]), 'after');
});