'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');
const mainSource = fs.readFileSync(T.__mainPath, 'utf8');

test('startup sync and debounced refresh cannot run after unload', () => {
  assert.match(mainSource, /async onload\(\) \{\s*this\._unloaded = false;\s*this\._startupSyncTimer = null;\s*this\._emitTimer = null;/);
  assert.match(mainSource, /onLayoutReady\(\(\) => \{\s*if \(this\._unloaded\) return;/);
  assert.match(mainSource, /this\._startupSyncTimer = window\.setTimeout\(\(\) => \{\s*this\._startupSyncTimer = null;\s*if \(!this\._unloaded\) this\.syncNow\(false\);\s*\}, 4000\);/);

  const unload = /onunload\(\) \{([\s\S]*?)\n  \}/.exec(mainSource);
  assert.ok(unload, 'the plugin unload handler exists');
  assert.match(unload[1], /this\._unloaded = true;/);
  assert.match(unload[1], /clearTimeout\(this\._startupSyncTimer\)[^\n]*this\._startupSyncTimer = null/);
  assert.match(unload[1], /clearTimeout\(this\._emitTimer\)[^\n]*this\._emitTimer = null/);

  const refresh = /emitModelChanged\(\) \{([\s\S]*?)\n  \}/.exec(mainSource);
  assert.ok(refresh, 'the debounced refresh method exists');
  assert.match(refresh[1], /if \(this\._unloaded\) return;/);
  assert.match(refresh[1], /this\._emitTimer = null;[\s\S]*if \(this\._unloaded\) return;/);

  const sync = /async syncNow\(manual\) \{([\s\S]*?)\n  \}/.exec(mainSource);
  assert.ok(sync, 'the sync method exists');
  assert.match(sync[1], /^\s*if \(this\._unloaded\) return;/);
});

test('the planner-item reader carries the declared optional scheduling fields', () => {
  const item = T.itemFromFrontmatter({
    type: 'planner-item', source: 'todoist', external_id: '1', due: '2026-10-13', recurring: true,
    planned_day: '2026-10-13', planned_start: '08:30', planned_duration: 60,
    planned_occurrence_due: '2026-10-13',
  }, '02 Planner/Todoist/task.md', 'task');
  assert.equal(item.plannedStart, '08:30');
  assert.equal(item.plannedDuration, 60);
  assert.equal(item.plannedOccurrenceDue, '2026-10-13');
  assert.equal(T.activeTimedPlacement(item).start, 510);
});

test('timed task placements validate the complete local schema and occurrence identity', () => {
  const base = {
    source: 'todoist', recurring: true, due: '2026-10-13', plannedDay: '2026-10-13',
    plannedStart: '08:30', plannedDuration: 60, plannedOccurrenceDue: '2026-10-13',
  };
  assert.deepEqual(T.activeTimedPlacement(base), { day: '2026-10-13', start: 510, duration: 60, end: 570 });
  assert.equal(T.activeTimedPlacement({ ...base, plannedOccurrenceDue: '2026-10-06' }), null);
  assert.equal(T.activeTimedPlacement({ ...base, plannedStart: '08:37' }), null);
  assert.equal(T.activeTimedPlacement({ ...base, plannedDuration: 45 }), null);
  assert.equal(T.activeTimedPlacement({ ...base, plannedDuration: 90, plannedStart: '23:30' }), null);
  assert.equal(T.activeTimedPlacement({ ...base, plannedDuration: 30, plannedStart: '23:30' }).end, 1440);
  assert.equal(T.activeTimedPlacement({ ...base, source: 'manual', recurring: null, plannedOccurrenceDue: null }).start, 510);
  assert.equal(T.activeTimedPlacement({ ...base, recurring: false, plannedOccurrenceDue: null }).start, 510);
  assert.equal(T.activeTimedPlacement({ ...base, recurring: null, plannedOccurrenceDue: null }), null);
});

test('drops floor to the prior half-hour and durations stop at local midnight', () => {
  assert.equal(T.snapPlannerMinute(8 * 60 + 37), 8 * 60 + 30);
  assert.equal(T.snapPlannerMinute(8 * 60 + 30), 8 * 60 + 30);
  assert.equal(T.clampPlannedDuration(8 * 60 + 30, 60), 60);
  assert.equal(T.clampPlannedDuration(23 * 60 + 30, 60), 30);
  assert.equal(T.clampPlannedDuration(23 * 60, 30), 30);
  assert.equal(T.clampPlannedDuration(23 * 60, 15), 60, 'an invalid duration falls back to the default');
});

test('the time range expands to include events and tasks beyond configured hours', () => {
  assert.deepEqual(T.timedGridBounds(8 * 60, 18 * 60, [
    { start: 7 * 60 + 17, end: 8 * 60 + 8 },
    { start: 19 * 60, end: 20 * 60 + 3 },
  ]), { start: 420, end: 1230 });
});

test('timed drops commit the snapped minute shown by the dragover preview', () => {
  const dropWire = /function wireTimedDrop\(slots, grid, onDrop\) \{([\s\S]*?)\n\}/.exec(mainSource);
  assert.ok(dropWire, 'the timed drop handler exists');
  assert.match(dropWire[1], /previewMinute = minuteAt\(event\.clientY\);/);
  assert.match(dropWire[1], /marker\.style\.top = `\$\{\(previewMinute - grid\.start\)/);
  assert.match(dropWire[1], /previewMinute == null \? minuteAt\(event\.clientY\) : previewMinute/);
});

test('all overlapping timed entries receive distinct side-by-side columns', () => {
  const layout = T.timedGridColumns([
    { key: 'task-a', start: 510, end: 570 },
    { key: 'event', start: 540, end: 600 },
    { key: 'routine', start: 540, end: 570 },
    { key: 'task-b', start: 600, end: 630 },
  ]);
  const byKey = Object.fromEntries(layout.map((entry) => [entry.key, entry]));
  assert.equal(byKey['task-a'].columns, 3);
  assert.equal(byKey.event.columns, 3);
  assert.equal(byKey.routine.columns, 3);
  assert.notEqual(byKey['task-a'].column, byKey.event.column);
  assert.notEqual(byKey.event.column, byKey.routine.column);
  assert.equal(byKey['task-b'].columns, 1, 'a touching, non-overlapping block starts a fresh group');
});

test('local scheduling fields are planner-owned and never added to outbound fields', () => {
  assert.deepEqual(T.TWO_WAY_FIELDS, ['title', 'due', 'priority', 'description']);
  for (const field of ['planned_start', 'planned_duration', 'planned_occurrence_due']) {
    assert.ok(T.PLAN_OWNED_ITEM_FIELDS.includes(field), `${field} must survive source refresh`);
    assert.ok(!T.TWO_WAY_FIELDS.includes(field), `${field} must never be pushed to a source`);
  }
});

test('timed placement writes go through Obsidian frontmatter and never the task body', async () => {
  const PluginClass = require(T.__mainPath);
  const { TFile } = T.__obsidian;
  const file = new TFile();
  const writes = [];
  const plugin = Object.create(PluginClass.prototype);
  plugin.emitModelChanged = () => {};
  plugin.app = {
    vault: { getAbstractFileByPath: () => file },
    fileManager: {
      processFrontMatter: async (target, update) => {
        const frontmatter = {};
        update(frontmatter);
        writes.push({ target, frontmatter });
      },
    },
  };
  await plugin.assignTimedItem('task.md', '2026-10-13', '08:30', 60, {
    source: 'todoist', recurring: true, due: '2026-10-13',
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, file);
  assert.deepEqual(writes[0].frontmatter, {
    planned_day: '2026-10-13', planned_start: '08:30', planned_duration: 60,
    planned_occurrence_due: '2026-10-13',
  });
});

test('recurrence advancement clears an old timed placement instead of carrying its time', () => {
  const plan = T.syncCompletionPlan({
    prior: {
      source: 'todoist', id: '1', recurring: true, due: '2026-10-06',
      plannedDay: '2026-10-06', plannedStart: '08:30', plannedDuration: 60,
      plannedOccurrenceDue: '2026-10-06', doneLocal: false, status: 'open', reopenPending: false,
    },
    sourceItem: { due: '2026-10-13' },
    shadow: { due: '2026-10-06', done: false },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(plan.clearPlan, true);
  assert.equal(plan.movePlan, null);
});

test('the existing agenda uses active timed task placements and configured split time', () => {
  const item = {
    path: 'task.md', source: 'manual', recurring: false, plannedDay: '2026-10-13',
    plannedStart: '14:30', plannedDuration: 60, plannedOrder: 0,
  };
  const agenda = T.agendaSections([item], [], '2026-10-13', [], '13:00');
  assert.equal(agenda.pm[0].kind, 'task');
  assert.equal(agenda.pm[0].plannedOrder, 870);
});

test('a stale timed occurrence does not fall back to its legacy half in the agenda', () => {
  const stale = {
    path: 'task.md', source: 'todoist', recurring: true, due: '2026-10-13',
    plannedDay: '2026-10-13', plannedHalf: 'am', plannedStart: '08:30',
    plannedDuration: 60, plannedOccurrenceDue: '2026-10-06',
  };
  const agenda = T.agendaSections([stale], [], '2026-10-13', [], '13:00');
  assert.deepEqual(agenda.am, []);
  assert.deepEqual(agenda.pm, []);
});

test('legacy half-day tasks remain untimed and are excluded when occurrence identity is stale', () => {
  const legacy = {
    path: 'legacy.md', plannedDay: '2026-10-13', plannedHalf: 'am',
    plannedStart: null, plannedDuration: null, plannedOccurrenceDue: null,
  };
  assert.equal(T.isUntimedHalfDayItem(legacy, '2026-10-13'), true);
  assert.equal(T.isUntimedHalfDayItem({ ...legacy, plannedStart: '08:30' }, '2026-10-13'), true);
  assert.equal(T.isUntimedHalfDayItem(legacy, '2026-10-14'), false);
  const agenda = T.agendaSections([legacy], [], '2026-10-13', [], '13:00');
  assert.equal(agenda.am[0].it.path, 'legacy.md');
  assert.equal(T.isUntimedHalfDayItem({ ...legacy, plannedOccurrenceDue: '2026-10-06' }, '2026-10-13'), false);
});

test('the unscheduled source tray excludes all planned tasks', () => {
  assert.match(mainSource, /\.filter\(\(i\) => i\.source === key && !activeTimedPlacement\(i\) && !i\.plannedDay && !isDone\(i\) && !i\.weeklyGoal\)/);
});

test('Overview and Calendar are independent persisted layout choices', () => {
  assert.match(mainSource, /this\.layout = 'overview'/);
  assert.match(mainSource, /layout: this\.layout/);
  assert.match(mainSource, /state\.layout === 'overview' \|\| state\.layout === 'calendar'/);
  assert.match(mainSource, /mkSeg\(seg, 'WEEK', 'week', this\.mode/);
  assert.match(mainSource, /mkSeg\(layoutSeg, 'OVERVIEW', 'overview', this\.layout/);
  assert.match(mainSource, /mkSeg\(layoutSeg, 'CALENDAR', 'calendar', this\.layout/);
});

test('WEEK and DAY retain the detailed renderer in CALENDAR while Overview restores the AM/PM board', () => {
  assert.match(mainSource, /this\.renderTimedGrid\(day, col, items, events, routines\)/);
  assert.match(mainSource, /this\.renderOverviewDay\(day, col, items, events, routines\)/);
  assert.match(mainSource, /text: 'UNTIMED TASKS'/);
  assert.match(mainSource, /renderCard\(this\.plugin, item, 'board', this\)/);
  assert.match(mainSource, /if \(!timeScaled\) card\.appendChild\(meta\);/);
  assert.match(mainSource, /card\.classList\.add\('iplan-time-entry', 'iplan-time-routine'\)/);
  assert.match(mainSource, /const steps = !timeScaled && expanded/);
  assert.doesNotMatch(mainSource, /pushed \+= Math\.max\(0, routine\.element/);
});

test('timed task duration slider keyboard supports arrow and endpoint keys', () => {
  assert.match(mainSource, /event\.key !== 'ArrowUp' && event\.key !== 'ArrowDown' && event\.key !== 'Home' && event\.key !== 'End'/);
  assert.match(mainSource, /event\.key === 'Home'\)\s*\{\s*nextDuration = Number\(handle\.getAttribute\('aria-valuemin'\)\);/);
  assert.match(mainSource, /event\.key === 'End'\)\s*\{\s*nextDuration = Number\(handle\.getAttribute\('aria-valuemax'\)\);/);
});