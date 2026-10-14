/* Routines: a recurring block of steps at a time of day.
 *
 * The contract has three parts and each is gated here: the note (frontmatter
 * plus "## Steps" plus the routine-log table), the day's materialisation
 * (which routines occur, in which lane half, with which steps done), and the
 * placement in the lane sequence and the agenda beside events and tasks. The
 * write path is pure (a body in, a body out) so the day's row can be checked
 * to the byte. Nothing in sync may ever see a routine; that is asserted too.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const T = require('./harness.cjs');

const FM = {
  type: 'planner-routine', name: 'Morning launch', routine_type: 'morning',
  start: '06:30', end: '07:30', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  active: true, created_at: '2026-09-04T09:00:00Z',
};

const BODY = [
  '---',
  'type: planner-routine',
  'name: Morning launch',
  '---',
  '',
  '# Morning launch',
  '',
  '## Steps',
  '- [ ] Water, 500 ml',
  '- [x] One journal page',
  '- [ ] Plan the day on the board',
  '',
  '## Log',
  '<!-- routine-log: schema=steps -->',
  '| Date | Done | Steps |',
  '|---|---|---|',
  '| 2026-09-04 | 3/3 | 1,2,3 |',
  '| 2026-09-03 | 1/3 | 2 |',
  '| 2026-09-02 | S |  |',
  '',
].join('\n');

const routine = (fm, body, p) => T.parseRoutineNote(Object.assign({}, FM, fm || {}), body == null ? BODY : body, p || '02 Planner/Routines/Morning launch.md');

function dailyPlanPlugin(routines = [routine()]) {
  const plugin = Object.create(T.IcorPlannerPlugin.prototype);
  plugin.settings = { ...T.DEFAULT_SETTINGS, _dailyPlanOverrides: {} };
  plugin.secrets = new T.SecretVault(null);
  plugin.routines = routines;
  plugin.planFiles = new Map(routines.map((current) => [current.path,
    Object.assign(new T.__obsidian.TFile(), { path: current.path })]));
  plugin.app = { vault: { getAbstractFileByPath: (routinePath) => plugin.planFiles.get(routinePath) } };
  plugin.emitModelChanged = () => {};
  plugin.saveData = async () => {};
  return plugin;
}

test('daily plan overrides isolate dates, inherit defaults and clip lunch to moved workday bounds', () => {
  const morning = routine();
  const settings = { ...T.DEFAULT_SETTINGS, lunchEnabled: true, lunchStart: '12:30', lunchEnd: '13:30',
    _dailyPlanOverrides: { '2026-09-07': { workday: { start: 540, end: 1020 },
      routines: { [morning.path]: { start: 435, end: 495 } } } } };
  const occurrences = T.routineOccurrences([morning], '2026-09-07', '13:00', T.routineDefaultsOf(settings), settings._dailyPlanOverrides);
  assert.deepEqual([occurrences[0].startMin, occurrences[0].endMin], [435, 495]);
  assert.equal(T.dailyPlannedTime('2026-09-07', settings, [], [], occurrences).dayMin, 420);
  assert.deepEqual(T.workdayFor('2026-09-08', settings), { start: 480, end: 1080 });
  const tuesday = T.routineOccurrences([morning], '2026-09-08', '13:00', T.routineDefaultsOf(settings), settings._dailyPlanOverrides)[0];
  assert.deepEqual([tuesday.startMin, tuesday.endMin], [390, 450]);
  const partial = { ...settings, dayEnd: '19:00', _dailyPlanOverrides: { '2026-09-07': { workday: { start: 540 } } } };
  assert.deepEqual(T.workdayFor('2026-09-07', partial), { start: 540, end: 1140 });
  const inherited = routine({ start: null, end: null });
  const defaults = T.routineDefaultsOf({ routineDefaults: { morning: { start: '08:00', end: '08:45' } } });
  assert.equal(T.routineOccurrence(inherited, '2026-09-08', '13:00', defaults, settings._dailyPlanOverrides).startMin, 480);
  assert.equal(T.routineOccurrence(morning, '2026-09-08', '13:00', defaults, {}).startMin, 390);
  assert.equal(morning.start, '06:30');
  assert.equal(morning.log.rows.length, 3);
});

test('daily plan normalization survives JSON reload and rejects invalid dates and intervals', () => {
  const path = routine().path;
  const valid = { '2026-09-07': { workday: { end: '24:00' }, routines: { [path]: { start: '23:15', end: 1440 } } } };
  const normalized = T.normalizeDailyPlanOverrides(valid);
  assert.deepEqual(T.normalizeDailyPlanOverrides(JSON.parse(JSON.stringify(normalized))), normalized);
  const adopted = T.adoptSettings(JSON.parse(JSON.stringify({ _dailyPlanOverrides: normalized })), new T.SecretVault(null));
  assert.deepEqual(adopted.settings._dailyPlanOverrides, normalized);
  assert.deepEqual(T.normalizeDailyPlanOverrides({ '2026-02-30': valid['2026-09-07'],
    '2026-09-08': { workday: { start: 600, end: 600 }, routines: { [path]: { start: 600, end: 599 } } } }), {});
  for (const invalid of [1.5, -1, 1441, null, true, '25:00', '12:60', '24:01']) assert.equal(T.planMinute(invalid), null);
});

test('daily planned time uses free time as the buffer percentage denominator', () => {
  const day = '2026-09-07';
  const events = [{ start: `${day}T09:00:00`, end: `${day}T11:00:00` }];
  const items = [{ source: 'todoist', recurring: false, plannedDay: day,
    plannedStart: '11:00', plannedDuration: 120 }];
  const occurrences = T.routineOccurrences([routine()], day, '13:00');
  assert.deepEqual(T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, events, items, occurrences), {
    dayMin: 600, lunchMin: 0, meetingsMin: 120, plannedMin: 180, freeMin: 480,
    bufferMin: 300, bufferPercent: 62.5, unknownTasks: 0,
  });
});

test('SOURCE: daily plan is shared by display and capacity without connector or completion writes', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const display = main.slice(main.indexOf('  routinesFor(day)'), main.indexOf('  async processRoutine('));
  assert.match(display, /routinesEnabled === false/);
  assert.match(display, /this\.settings\._dailyPlanOverrides/);
  const board = main.slice(main.indexOf('class PlannerBoardView extends ItemView'), main.indexOf('const TRAY_TABS'));
  assert.match(board, /routineDefaultsOf\(this\.plugin\.settings\), this\.plugin\.settings\._dailyPlanOverrides/);
  assert.match(board, /workdayFor\(day, this\.plugin\.settings\)/);
  assert.match(board, /workdayFor\(todayStr\(\), this\.plugin\.settings\)/);
  assert.match(board, /segmentInfo\(this\.plugin\.settings, mins, todayStr\(\)\)/);
  const writes = main.slice(main.indexOf('  updateDailyPlan(change)'), main.indexOf('  /* ---- the secrets backend'));
  assert.match(writes, /return this\.persistSettings\(async \(save\) =>/);
  assert.match(writes, /await save\(\{ _dailyPlanOverrides: normalized \}\);\s*this\.settings\._dailyPlanOverrides = normalized/);
  assert.match(writes, /await save\(\{ _dailyPlanOverrides: before \}\)/);
  assert.match(writes, /could not be saved or restored on disk/);
  assert.doesNotMatch(writes, /_dailyPlanQueue|await this\.persistSettings/);
  assert.match(writes, /this\.routinesFor\(day\)\.find/);
  assert.match(writes, /file instanceof TFile/);
  assert.match(writes, /file\.path !== path/);
  assert.doesNotMatch(writes, /saveSettings|scheduleSync|syncNow|processFrontMatter|processRoutine|vault\.process|requestUrl|routineLog|occurrences/);
  const rename = main.slice(main.indexOf("this.app.vault.on('rename'"), main.indexOf('  // Every path, derived'));
  assert.match(rename, /path !== oldPath && !path\.startsWith\(`\$\{oldPath\}\/`\)/);
  assert.match(rename, /entry\.routines\[next\] = entry\.routines\[path\]/);
  assert.match(rename, /delete entry\.routines\[path\]/);
  const modal = main.slice(main.indexOf('class RoutineDetailModal'), main.indexOf('function showRoutineMenu('));
  assert.match(modal, /change\(\{ start \}\)/);
  assert.doesNotMatch(modal, /const duration = occurrence\.endMin - occurrence\.startMin/);
  assert.match(board, /this\.renderTimedWorkdayMarkers\(day, axis, slots, bounds, scroll, labelGutter\)/);
  const markers = board.slice(board.indexOf('  renderTimedWorkdayMarkers('), board.indexOf('  placeTimedWorkdayMarkers('));
  assert.match(markers, /renderTimedWorkdayMarkers\(day, axis, slots, bounds, scroll, labelGutter\)/);
  assert.match(markers, /wireDailyPlanMove\(label, label, this, \{[\s\S]*?maximum:[^\n]+, scroll,/);
  const css = fs.readFileSync(path.join(path.dirname(T.__mainPath), 'styles.css'), 'utf8');
  assert.match(css, /button\.iplan-workday-label\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.iplan-workday-line\s*\{[^}]*pointer-events:\s*none/);
  const handle = css.match(/button\.iplan-plan-move\s*\{([^}]+)\}/)[1];
  assert.match(handle, /height:\s*min\(100%, var\(--size-4-6\)\)/);
  assert.doesNotMatch(handle, /min-height/);
});

test('daily plan writes queue rapid changes, recover from failure and reset without note or sync writes', async () => {
  const plugin = dailyPlanPlugin();
  const path = routine().path;
  const day = '2026-09-07';
  let notifications = 0;
  let fail = false;
  const saved = [];
  plugin.emitModelChanged = () => { notifications += 1; };
  plugin.saveData = async (snapshot) => {
    if (fail) { fail = false; throw new Error('Save rejected'); }
    saved.push(snapshot._dailyPlanOverrides);
  };
  const first = plugin.setDailyPlannedTime(day, path, { start: 435, end: 482 });
  const second = plugin.setDailyPlannedTime(day, path, { start: 450, end: 497 });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(saved[0][day].routines[path].start, 435);
  assert.equal(saved[1][day].routines[path].start, 450);
  fail = true;
  const rejected = plugin.setDailyPlannedTime(day, path, { start: 465, end: 512 });
  const newer = plugin.setDailyPlannedTime(day, null, { start: 540 });
  assert.deepEqual(await Promise.all([rejected, newer]), [false, true]);
  assert.equal(plugin.settings._dailyPlanOverrides[day].routines[path].start, 450);
  assert.equal(plugin.settings._dailyPlanOverrides[day].workday.start, 540);
  assert.equal(await plugin.setDailyPlannedTime(day, null, { end: 540 }), false);
  assert.equal(await plugin.setDailyPlannedTime(day, null, { end: '25:00' }), false);
  assert.equal(await plugin.setDailyPlannedTime('2026-02-30', path, { start: 450, end: 497 }), false);
  assert.equal(await plugin.setDailyPlannedTime(day, 'outside.md', { start: 450, end: 497 }), false);
  await plugin.setDailyPlannedTime(day, path, null);
  assert.equal(plugin.settings._dailyPlanOverrides[day].routines, undefined);
  await plugin.setDailyPlannedTime(day, null, null);
  assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
  assert.ok(notifications > 0);
});

test('real settings queue isolates a rejected plan between ordinary saves and restores partial writes', async () => {
  for (const partialWrite of [false, true]) {
    const plugin = dailyPlanPlugin();
    const day = '2026-09-07';
    let releaseEarlier;
    let beganEarlier;
    let releasePlan;
    let beganPlan;
    const earlierStarted = new Promise((resolve) => { beganEarlier = resolve; });
    const earlierGate = new Promise((resolve) => { releaseEarlier = resolve; });
    const planStarted = new Promise((resolve) => { beganPlan = resolve; });
    const planGate = new Promise((resolve) => { releasePlan = resolve; });
    const settle = plugin.secrets.settle.bind(plugin.secrets);
    let firstSettle = true;
    plugin.secrets.settle = async () => {
      if (firstSettle) { firstSettle = false; beganEarlier(); await earlierGate; }
      await settle();
    };
    let disk;
    const snapshots = [];
    plugin.saveData = async (snapshot) => {
      snapshots.push(snapshot);
      if (snapshots.length === 2) {
        beganPlan();
        await planGate;
        if (partialWrite) disk = snapshot;
        throw new Error('Plan save rejected');
      }
      disk = snapshot;
    };
    const earlier = plugin.persistSettings();
    await earlierStarted;
    const rejected = plugin.setDailyPlannedTime(day, null, { start: 540 });
    await Promise.resolve();
    assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
    assert.equal(snapshots.length, 0);
    releaseEarlier();
    await earlier;
    await planStarted;
    assert.deepEqual(snapshots[0]._dailyPlanOverrides, {});
    assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
    plugin.settings.dayEnd = '19:00';
    const later = plugin.persistSettings();
    releasePlan();
    assert.equal(await rejected, false);
    await later;
    assert.equal(snapshots.length, 4);
    assert.deepEqual(snapshots[2]._dailyPlanOverrides, {});
    assert.deepEqual(disk._dailyPlanOverrides, plugin.settings._dailyPlanOverrides);
    assert.deepEqual(T.adoptSettings(JSON.parse(JSON.stringify(disk)), new T.SecretVault(null)).settings._dailyPlanOverrides, {});
    assert.equal(disk.dayEnd, '19:00');
    assert.equal(plugin.settings.dayEnd, '19:00');
  }
});

test('real settings queue continues after an earlier failure and after a failed disk restoration', async () => {
  for (const failure of ['earlier', 'restore']) {
    const plugin = dailyPlanPlugin();
    const day = '2026-09-07';
    let attempts = 0;
    let disk;
    plugin.saveData = async (snapshot) => {
      attempts += 1;
      if (attempts === 1 || (failure === 'restore' && attempts === 2)) {
        disk = snapshot;
        throw new Error('Save rejected');
      }
      disk = snapshot;
    };
    const first = failure === 'earlier' ? plugin.persistSettings().catch(() => false)
      : plugin.setDailyPlannedTime(day, null, { start: 540 });
    assert.equal(await first, false);
    assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
    if (failure === 'restore') assert.equal(disk._dailyPlanOverrides[day].workday.start, 540);
    const newer = plugin.setDailyPlannedTime(day, null, { start: 555 });
    const latest = plugin.setDailyPlannedTime(day, null, { start: 570 });
    assert.deepEqual(await Promise.all([newer, latest]), [true, true]);
    assert.equal(plugin.settings._dailyPlanOverrides[day].workday.start, 570);
    assert.deepEqual(disk._dailyPlanOverrides, plugin.settings._dailyPlanOverrides);
  }
});

test('queued routine moves reject stale or unknown paths and use current source and override durations', async () => {
  const day = '2026-09-07';
  for (const stale of ['deleted', 'renamed', 'folder-renamed', 'not-live', 'not-file']) {
    const current = routine();
    const plugin = dailyPlanPlugin([current]);
    const oldPath = current.path;
    let release;
    let began;
    const started = new Promise((resolve) => { began = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let saves = 0;
    plugin.saveData = async () => { saves += 1; if (saves === 1) { began(); await gate; } };
    const earlier = plugin.persistSettings();
    await started;
    const move = plugin.setDailyPlannedTime(day, oldPath, { start: 435 });
    if (stale === 'deleted') plugin.planFiles.delete(oldPath);
    if (stale === 'not-live') plugin.routines = [];
    if (stale === 'not-file') plugin.planFiles.set(oldPath, new T.__obsidian.TFolder());
    if (stale === 'renamed' || stale === 'folder-renamed') {
      const nextPath = stale === 'renamed' ? '02 Planner/Routines/Renamed.md'
        : '02 Planner/Routines/Renamed folder/Morning launch.md';
      const file = plugin.planFiles.get(oldPath);
      file.path = nextPath;
      plugin.planFiles.delete(oldPath);
      plugin.planFiles.set(nextPath, file);
      plugin.routines = [routine({}, BODY, nextPath)];
    }
    release();
    await earlier;
    assert.equal(await move, false, stale);
    assert.equal(saves, 1, stale);
    assert.deepEqual(plugin.settings._dailyPlanOverrides, {}, stale);
    assert.equal(await plugin.setDailyPlannedTime(day, oldPath, null), false, stale);
  }
  const plugin = dailyPlanPlugin();
  const currentPath = routine().path;
  assert.equal(await plugin.setDailyPlannedTime(day, '02 Planner/Routines/Unknown.md', { start: 435 }), false);
  plugin.routines = [routine({ start: '06:30', end: '07:17' })];
  assert.equal(await plugin.setDailyPlannedTime(day, currentPath, { start: 435 }), true);
  assert.deepEqual(plugin.settings._dailyPlanOverrides[day].routines[currentPath], { start: 435, end: 482 });
  await plugin.setDailyPlannedTime(day, currentPath, { start: 450, end: 467 });
  assert.equal(await plugin.setDailyPlannedTime(day, currentPath, { start: 480 }), true);
  assert.deepEqual(plugin.settings._dailyPlanOverrides[day].routines[currentPath], { start: 480, end: 497 });
  assert.equal(await plugin.setDailyPlannedTime(day, currentPath, { start: 1435 }), false);
  assert.equal(await plugin.setDailyPlannedTime(day, currentPath, null), true);
  assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
  assert.equal(plugin.routines[0].end, '07:17');
});

test('settings persistence serializes immutable snapshots and continues after a rejected save', async () => {
  const plugin = Object.create(T.IcorPlannerPlugin.prototype);
  plugin.settings = { ...T.DEFAULT_SETTINGS, _dailyPlanOverrides: {} };
  plugin.secrets = new T.SecretVault(null);
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const snapshots = [];
  plugin.saveData = async (snapshot) => {
    snapshots.push(snapshot);
    if (snapshots.length === 1) { began(); await gate; throw new Error('Save rejected'); }
  };
  const first = plugin.persistSettings().catch(() => false);
  await started;
  plugin.settings._dailyPlanOverrides = { '2026-09-07': { workday: { start: 540 } } };
  const second = plugin.persistSettings();
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0]._dailyPlanOverrides, {});
  release();
  assert.equal(await first, false);
  await second;
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1]._dailyPlanOverrides['2026-09-07'].workday.start, 540);
});

test('daily plan snapping preserves odd routine durations and never crosses midnight or reversed workdays', () => {
  const duration = 47;
  const start = T.snapDailyPlanMinute(435, 0, 1440 - duration, 390);
  assert.equal(start, 435);
  assert.equal(start + duration, 482);
  assert.equal(T.snapDailyPlanMinute(-100, 0, 1440 - duration, 390), 0);
  assert.equal(T.snapDailyPlanMinute(1500, 0, 1440 - duration, 390), 1380);
  assert.equal(T.snapDailyPlanMinute(540, 0, 539, 480), 525);
  assert.equal(T.snapDailyPlanMinute(525, 541, 1440, 1080), 555);
  assert.equal(T.snapDailyPlanMinute(0, 1, 1, 1), 1);
  assert.equal(T.snapPlannerMinute(435), 450);
});

test('daily capacity subtracts enabled lunch once without excluding lunch from meetings or planned time', () => {
  const day = '2026-09-07';
  const settings = { ...T.DEFAULT_SETTINGS, lunchEnabled: true };
  const events = [{ start: `${day}T12:00:00`, end: `${day}T14:00:00` }];
  const items = [{ source: 'todoist', plannedDay: day, plannedDuration: 120 }];
  const occurrences = T.routineOccurrences([routine()], day, '13:00');
  assert.deepEqual(T.dailyPlannedTime(day, settings, events, items, occurrences), {
    dayMin: 540, lunchMin: 60, meetingsMin: 120, plannedMin: 180, freeMin: 420,
    bufferMin: 240, bufferPercent: 240 / 420 * 100, unknownTasks: 0,
  });
  assert.equal(T.dailyPlannedTime(day, { ...settings, lunchEnabled: false }, [], [], []).dayMin, 600);
  assert.equal(T.dailyPlannedTime(day, {}, [], [], []).lunchMin, 0);
});

test('daily lunch capacity clips to the workday and ignores missing, malformed or reversed bounds', () => {
  const day = '2026-09-07';
  const settings = { ...T.DEFAULT_SETTINGS, lunchEnabled: true };
  const cases = [
    ['07:00', '08:30', 30], ['17:30', '19:00', 30], ['07:00', '19:00', 600],
    ['06:00', '07:00', 0], ['19:00', '20:00', 0], ['13:30', '12:30', 0],
    ['12:30', '12:30', 0], ['', '13:30', 0], ['12:30', undefined, 0],
    ['invalid', '13:30', 0], ['12:30', '25:00', 0], ['12:60', '13:30', 0],
    ['-1:00', '13:30', 0], ['12:30', '13:30extra', 0], ['8:00', '9:00', 60],
  ];
  for (const [lunchStart, lunchEnd, lunchMin] of cases) {
    const totals = T.dailyPlannedTime(day, { ...settings, lunchStart, lunchEnd }, [], [], []);
    assert.equal(totals.lunchMin, lunchMin, `${lunchStart} to ${lunchEnd}`);
    assert.equal(totals.dayMin, 600 - lunchMin);
    assert.equal(totals.freeMin, totals.dayMin);
    assert.equal(totals.bufferMin, totals.dayMin);
    assert.equal(totals.bufferPercent, totals.dayMin === 0 ? null : 100);
  }
  for (const dayEnd of ['08:00', '07:00']) {
    const totals = T.dailyPlannedTime(day, { ...settings, dayEnd, lunchStart: '06:00', lunchEnd: '19:00' }, [], [], []);
    assert.equal(totals.lunchMin, 0);
    assert.equal(totals.dayMin, 0);
  }
});

test('daily meeting durations add overlaps rather than merging occupied intervals', () => {
  const day = '2026-09-07';
  const events = [
    { day, start: `${day}T09:00:00`, end: `${day}T11:00:00` },
    { day, start: `${day}T10:00:00`, end: `${day}T11:00:00` },
  ];
  const totals = T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, events, [], []);
  assert.equal(totals.meetingsMin, 180);
  assert.equal(totals.freeMin, 420);
  assert.equal(totals.bufferPercent, 100);
});

test('daily meetings clip to the configured window, ignore true all-day rows and count timed continuations once', () => {
  const day = '2026-09-07';
  const events = [
    { day, start: `${day}T07:00:00`, end: `${day}T09:00:00` },
    { day, start: `${day}T17:00:00`, end: `${day}T19:00:00` },
    { day, start: `${day}T19:00:00`, end: `${day}T20:00:00` },
    { day, allDay: true, start: null, end: null },
    { day, allDay: true, start: `${day}T00:00:00`, end: '2026-09-08T00:00:00' },
    { day, continues: true, allDay: true, start: '2026-09-06T23:00:00', end: `${day}T09:00:00` },
    { day: '2026-09-06', start: '2026-09-06T23:00:00', end: `${day}T09:00:00` },
    { day, start: 'invalid', end: `${day}T09:00:00` },
    { day, start: `${day}T11:00:00`, end: `${day}T10:00:00` },
  ];
  assert.equal(T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, events, [], []).meetingsMin, 180);
});

test('daily planned time counts only date-assigned Todoist durations and routine blocks, not their steps', () => {
  const day = '2026-09-07';
  const task = { source: 'todoist', recurring: false, plannedDay: day, plannedHalf: 'am', plannedDuration: 60 };
  const items = [task, { ...task, status: 'done' }, { ...task, plannedDuration: null },
    { ...task, source: 'clickup' }, { ...task, source: 'email' }, { ...task, source: 'manual' },
    { ...task, plannedDay: '2026-09-08' }, { ...task, plannedDay: null, due: day },
    { ...task, recurring: true, due: day, plannedStart: '09:00', plannedOccurrenceDue: '2026-09-06' },
  ];
  const occurrences = T.routineOccurrences([routine()], day, '13:00');
  occurrences[0].done = occurrences[0].total;
  const totals = T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, [], items, occurrences);
  assert.equal(totals.plannedMin, 240);
  assert.equal(totals.unknownTasks, 1);
  assert.equal(T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, [], [],
    [{ ...occurrences[0], skipped: true }]).plannedMin, 0);
});

test('daily planned time counts unscheduled assignments without requiring a half and rejects stale recurrence', () => {
  const day = '2026-09-07';
  const task = { source: 'todoist', recurring: false, plannedDay: day, plannedDuration: 60 };
  const items = [task, { ...task, status: 'done' }, { ...task, plannedDuration: null },
    { ...task, recurring: true, due: day, plannedOccurrenceDue: day },
    { ...task, recurring: true, due: day, plannedOccurrenceDue: '2026-09-06' },
    { ...task, recurring: true, due: day, plannedStart: '09:00' },
    { ...task, plannedDay: '2026-02-30' }];
  const totals = T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, [], items, []);
  assert.equal(totals.plannedMin, 180);
  assert.equal(totals.unknownTasks, 1);
});

test('daily planned time retains recorded recurrence durations once without borrowing current estimates', () => {
  const day = '2026-09-07';
  const prior = { source: 'todoist', recurring: true, due: day, plannedDay: day,
    plannedStart: '09:00', plannedDuration: 60, plannedOccurrenceDue: day };
  const plan = T.syncCompletionPlan({ prior, sourceItem: { due: '2026-09-08' },
    shadow: { due: day }, recurringAdvance: 'drop' });
  assert.equal(plan.occurrence.plannedDuration, 60);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.match(main, /planned_duration: ops\.occurrence\.plannedDuration/);
  const occurrences = T.normalizeOccurrences([
    { due: day, planned_day: day, planned_duration: 60 },
    { due: day, planned_day: day, planned_duration: 60 },
    { due: '2026-09-06', planned_day: day, planned_half: 'am' },
  ]);
  const advanced = { ...prior, due: '2026-09-08', plannedDay: '2026-09-08',
    plannedDuration: 180, plannedOccurrenceDue: '2026-09-08', occurrences };
  const totals = T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, [], [advanced], []);
  assert.equal(totals.plannedMin, 60);
  assert.equal(totals.unknownTasks, 1);
  assert.equal(T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, [], [{ ...prior, occurrences }], []).plannedMin, 60);
  const stale = T.syncCompletionPlan({ prior: { ...prior, plannedOccurrenceDue: '2026-09-05' },
    sourceItem: { due: '2026-09-08' }, shadow: { due: day }, recurringAdvance: 'drop' });
  assert.equal(stale.occurrence.plannedDuration, undefined);
});

test('daily due-only estimates belong to the due date unless an explicit planned day owns them', () => {
  const day = '2026-09-07';
  const task = { source: 'todoist', recurring: false, due: day, plannedDuration: 60 };
  const items = [task, { ...task, plannedDay: '2026-09-08' },
    { ...task, recurring: true, plannedOccurrenceDue: '2026-09-06' },
    { ...task, due: '2026-02-30' }];
  assert.equal(T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, [], items, []).plannedMin, 60);
  const plan = T.syncCompletionPlan({ prior: { ...task, recurring: true },
    sourceItem: { due: '2026-09-08' }, shadow: { due: day } });
  assert.equal(plan.occurrence.plannedDay, day);
  assert.equal(plan.occurrence.plannedDuration, 60);
});

test('SIMULATED: occurrence writer saves the completed duration before clearing the live timed plan', async () => {
  const day = '2026-09-07';
  const fm = { type: 'planner-item', source: 'todoist', external_id: 'recurring',
    title: 'Recurring', recurring: true, due: day, priority: 3, tags: [],
    planned_day: day, planned_start: '09:00', planned_duration: 60, planned_occurrence_due: day };
  const prior = T.itemFromFrontmatter(fm, '02 Planner/Todoist/Recurring.md', 'Recurring');
  prior.file = {};
  const sourceItem = { title: 'Recurring', recurring: true, due: '2026-09-08', priority: 3, tags: [] };
  const plan = T.syncCompletionPlan({ prior, sourceItem, shadow: { due: day }, recurringAdvance: 'drop' });
  const plugin = {
    app: { fileManager: { processFrontMatter: async (_file, change) => change(fm) } },
    markSyncWrite: () => {},
  };
  await T.IcorPlannerPlugin.prototype.updateItemFile.call(plugin, prior, sourceItem,
    { title: sourceItem.title, due: sourceItem.due, priority: 3 }, '', plan);
  assert.equal(fm.planned_duration, undefined);
  assert.equal(fm.occurrences[0].planned_duration, 60);
  const advanced = T.itemFromFrontmatter(fm, prior.path, 'Recurring');
  assert.equal(T.dailyPlannedTime(day, T.DEFAULT_SETTINGS, [], [advanced], []).plannedMin, 60);
});

test('daily planned time divides by negative free time and reports N/A only for zero', () => {
  const day = '2026-09-07';
  const settings = { ...T.DEFAULT_SETTINGS, dayStart: '09:00', dayEnd: '11:00' };
  const items = [{ source: 'todoist', recurring: false, plannedDay: day, plannedStart: '09:00', plannedDuration: 120 }];
  const meeting = { start: `${day}T09:00:00`, end: `${day}T10:00:00` };
  const overplanned = T.dailyPlannedTime(day, settings, [meeting], items, []);
  assert.equal(overplanned.bufferMin, -60);
  assert.equal(overplanned.bufferPercent, -100);
  const full = { start: `${day}T09:00:00`, end: `${day}T11:00:00` };
  assert.equal(T.dailyPlannedTime(day, settings, [full], items, []).bufferPercent, null);
  const negative = T.dailyPlannedTime(day, settings, [full, meeting], items, []);
  assert.equal(negative.freeMin, -60);
  assert.equal(negative.bufferMin, -180);
  assert.equal(negative.bufferPercent, 300);
  const empty = T.dailyPlannedTime(day, { ...settings, dayEnd: '09:00' }, [], [], []);
  assert.equal(empty.dayMin, 0);
  assert.equal(empty.bufferPercent, null);
  assert.equal(T.dailyPlannedTime(day, { ...settings, dayEnd: '08:00' }, [], [], []).dayMin, 0);
  assert.equal(T.dailyPlannedTime(day, {}, [], [], []).dayMin, 600);
});

function dailyCalendarDef(uid, start, end) {
  return T.parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', `UID:${uid}`,
    `DTSTART:${start}`, `DTEND:${end}`, 'END:VEVENT', 'END:VCALENDAR'].join('\n'));
}

test('daily calendars use only settings-enabled feeds and deduplicate enabled mirrored events', () => {
  const visible = dailyCalendarDef('visible', '20260907T090000', '20260907T100000');
  const hidden = dailyCalendarDef('hidden', '20260907T100000', '20260907T110000');
  const plugin = {
    settings: { calendars: [{ id: 'visible', name: 'Visible' }, { id: 'hidden', name: 'Hidden', enabled: false }] },
    calendarStatus: { perFeed: { visible: { ok: true }, hidden: { ok: false, warning: 'Disabled warning.' } } },
    calendarDefs: visible,
    calendarDefsByFeed: { visible },
    capacityCalendarDefsByFeed: { hidden: [...hidden, ...visible] },
  };
  const model = T.dailyCapacityCalendars(plugin, '2026-09-07', 13);
  assert.equal(model.events.length, 1);
  assert.deepEqual(model.missing, []);
  assert.deepEqual(model.cached, []);
  assert.deepEqual(model.warnings, []);
  assert.equal(T.dailyPlannedTime('2026-09-07', T.DEFAULT_SETTINGS, model.events, [], []).meetingsMin, 60);
  plugin.settings.calendars[1].enabled = true;
  const enabled = T.dailyCapacityCalendars(plugin, '2026-09-07', 13);
  assert.equal(enabled.events.length, 2);
  assert.deepEqual(enabled.cached, ['Hidden']);
  assert.deepEqual(enabled.warnings, ['Hidden: Disabled warning.']);
  assert.equal(T.dailyPlannedTime('2026-09-07', T.DEFAULT_SETTINGS, enabled.events, [], []).meetingsMin, 120);
  plugin.settings.calendars.pop();
  assert.equal(T.dailyCapacityCalendars(plugin, '2026-09-07', 13).events.length, 1);
});

test('daily calendars expose missing feeds but distinguish a fetched empty calendar', () => {
  const plugin = {
    settings: { calendars: [{ id: 'empty', name: 'Empty' }, { id: 'missing', name: 'Missing' },
      { id: 'disabled', name: 'Disabled', enabled: false }] },
    calendarDefsByFeed: { empty: [] },
  };
  const model = T.dailyCapacityCalendars(plugin, '2026-09-07', 13);
  assert.deepEqual(model.events, []);
  assert.deepEqual(model.missing, ['Missing']);
  assert.deepEqual(model.cached, ['Empty', 'Missing']);
});

test('daily calendars recognize successful empty and mirrored-only feeds omitted from definitions', () => {
  const visible = dailyCalendarDef('mirror', '20260907T090000', '20260907T100000');
  const plugin = {
    settings: { calendars: [{ id: 'visible', name: 'Visible' }, { id: 'mirror', name: 'Mirror' },
      { id: 'empty', name: 'Empty' }] },
    calendarStatus: { perFeed: { visible: { ok: true, count: 1 }, mirror: { ok: true, count: 1 },
      empty: { ok: true, count: 0 } } },
    calendarDefsByFeed: { visible },
  };
  const model = T.dailyCapacityCalendars(plugin, '2026-09-07', 13);
  assert.equal(model.events.length, 1);
  assert.deepEqual(model.missing, []);
  assert.deepEqual(model.cached, []);
  assert.equal(T.dailyPlannedTime('2026-09-07', T.DEFAULT_SETTINGS, model.events, [], []).meetingsMin, 60);
});

test('daily calendars with only disabled feeds produce no totals or data warnings even with stale caches', () => {
  const plugin = {
    settings: { calendars: [{ id: 'disabled', name: 'Disabled', enabled: false }] },
    calendarStale: true,
    capacityCalendarDefsByFeed: { disabled: dailyCalendarDef('disabled', '20260907T090000', '20260907T100000') },
    calendarStatus: { perFeed: { disabled: { ok: false, warning: 'Disabled warning.' } } },
  };
  assert.deepEqual(T.dailyCapacityCalendars(plugin, '2026-09-07', 13),
    { events: [], missing: [], cached: [], warnings: [] });
});

test('daily feed warnings survive another successful feed clearing the global stale flag', () => {
  const plugin = {
    settings: { calendars: [{ id: 'healthy', name: 'Healthy' }, { id: 'failed', name: 'Failed' },
      { id: 'partial', name: 'Partial' }, { id: 'unconfirmed', name: 'Unconfirmed' }] },
    calendarStale: false,
    calendarStatus: { perFeed: { healthy: { ok: true }, failed: { ok: false },
      partial: { ok: true, warning: 'Calendar window incomplete.' } } },
    calendarDefsByFeed: { healthy: [], failed: [], partial: [], unconfirmed: [] },
  };
  const model = T.dailyCapacityCalendars(plugin, '2026-09-07', 13);
  assert.deepEqual(model.cached, ['Failed', 'Unconfirmed']);
  assert.deepEqual(model.warnings, ['Partial: Calendar window incomplete.']);
  plugin.calendarStale = true;
  assert.deepEqual(T.dailyCapacityCalendars(plugin, '2026-09-07', 13).cached,
    ['Healthy', 'Failed', 'Partial', 'Unconfirmed']);
});

test('daily calendars recover Monday carry-in from the previous week without repeating multi-day rows', () => {
  const defs = dailyCalendarDef('overnight', '20260906T230000', '20260907T090000');
  const plugin = { settings: { calendars: [{ id: 'calendar' }] }, calendarDefsByFeed: { calendar: defs } };
  const model = T.dailyCapacityCalendars(plugin, '2026-09-07', 13);
  assert.equal(model.events.length, 1);
  assert.equal(T.dailyPlannedTime('2026-09-07', T.DEFAULT_SETTINGS, model.events, [], []).meetingsMin, 60);
  const long = dailyCalendarDef('long', '20260830T230000', '20260907T090000');
  plugin.calendarDefsByFeed.calendar = long;
  assert.equal(T.dailyPlannedTime('2026-09-07', T.DEFAULT_SETTINGS,
    T.dailyCapacityCalendars(plugin, '2026-09-07', 13).events, [], []).meetingsMin, 60);
});

test('SIMULATED: daily summary has labels, signed buffer, accessible tooltips and explicit data warnings', () => {
  const element = (options = {}) => {
    const node = { className: options.cls || '', text: options.text || '', attributes: options.attr || {}, children: [] };
    node.createDiv = node.createSpan = (childOptions) => {
      const child = element(childOptions);
      node.children.push(child);
      return child;
    };
    node.setAttribute = (name, value) => { node.attributes[name] = value; };
    node.addClass = (name) => { node.className += ` ${name}`; };
    return node;
  };
  const totals = { dayMin: 540, lunchMin: 60, meetingsMin: 120, plannedMin: 480, freeMin: 420,
    bufferMin: -60, bufferPercent: -60 / 420 * 100, unknownTasks: 1 };
  const summary = T.renderDailyPlannedTime(element(), '2026-09-07', totals,
    { missing: ['Missing'], cached: ['Hidden'] }, true);
  assert.equal(summary.attributes['aria-label'], 'Daily planned time for 2026-09-07');
  assert.deepEqual(summary.children.slice(0, 3).map((child) => child.children[0].text), ['Meetings', 'Planned', 'Buffer']);
  assert.ok(summary.children.slice(0, 3).every((child) => child.attributes.role === 'group'));
  assert.equal(summary.children[2].children[1].text, '-1h (-14.3%)');
  assert.equal(summary.children[2].children[2].text, 'Overplanned');
  assert.match(summary.children[2].title, /Net workday capacity: 9h/);
  assert.match(summary.children[2].attributes['aria-label'], /minus 1h of enabled, valid configured lunch within the workday/);
  assert.match(summary.children[2].title, /Meeting durations include any lunch overlap/);
  assert.match(summary.children[0].title, /Missing calendar data: Missing/);
  assert.match(summary.children[0].attributes['aria-label'], /Calendars use last-known or unconfirmed data: Hidden/);
  assert.match(summary.children[3].text, /1 task\/occurrence without duration; Calendar data incomplete/);
  const zero = T.renderDailyPlannedTime(element(), '2026-09-07',
    { ...totals, meetingsMin: 540, plannedMin: 60, freeMin: 0, bufferPercent: null },
    { missing: [], cached: [] }, false);
  assert.equal(zero.children[2].children[1].text, '-1h (N/A)');
  assert.match(zero.children[2].title, /free time is zero/);
  const negative = T.renderDailyPlannedTime(element(), '2026-09-07',
    { ...totals, meetingsMin: 600, plannedMin: 120, freeMin: -60, bufferMin: -180, bufferPercent: 300 },
    { missing: [], cached: [], warnings: ['Partial: Calendar window incomplete.'] }, false);
  assert.equal(negative.children[2].children[1].text, '-3h (300%)');
  assert.equal(negative.children[2].children[2].text, 'Overplanned');
  assert.match(negative.children[2].title, /positive ratio does not indicate available time/);
  assert.match(negative.children[0].title, /Calendar window incomplete/);
  assert.match(negative.children[3].text, /Calendar feed warnings/);
  assert.equal(T.dailyDurationText(-90), '-1h 30m');
  assert.equal(T.dailyDurationText(0), '0m');
});

test('SOURCE: daily metrics top-align unequal heights and wrap without fixed heights or lost identities', () => {
  const css = fs.readFileSync(path.join(path.dirname(T.__mainPath), 'styles.css'), 'utf8');
  const summary = css.match(/\.iplan-daily-summary\.iplan-card-meta\s*\{([^}]+)\}/)[1];
  assert.match(summary, /display:\s*grid/);
  assert.match(summary, /align-items:\s*start/);
  assert.match(summary, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(summary, /(?:^|;)\s*(?:min-|max-)?height\s*:/);
  for (const kind of ['label', 'value', 'warning']) {
    const rule = css.match(new RegExp(`\\.iplan-daily-${kind}\\s*\\{([^}]+)\\}`))[1];
    assert.match(rule, /overflow-wrap:\s*anywhere/);
    assert.doesNotMatch(rule, /(?:^|;)\s*(?:min-|max-)?height\s*:/);
  }
  for (const [kind, color] of [['meetings', 'red'], ['planned', 'yellow'], ['buffer', 'green']]) {
    assert.ok(css.includes(`.iplan-daily-metric.is-${kind} { border-top: 2px solid var(--color-${color}); }`));
  }
  assert.match(css, /\.iplan-daily-metric\.is-overplanned \.iplan-daily-warning\s*\{\s*color:\s*var\(--text-error/);
});

test('SOURCE: WEEK and DAY share daily totals while the countdown and visibility-controlled display remain separate', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const board = main.slice(main.indexOf('class PlannerBoardView extends ItemView'), main.indexOf('const TRAY_TABS'));
  assert.ok(board.includes('const capacityCalendars = dailyCapacityCalendars(this.plugin, eventsWeekStart, splitHour);'));
  assert.ok(board.includes('const capacityRoutines = routineOccurrences(this.plugin.routines || [], day,'));
  assert.ok(board.includes('capacityCalendars.events, items, capacityRoutines)'));
  assert.ok(board.includes('capacityCalendars, capacityCalendars.cached.length > 0)'));
  assert.ok(board.includes('const routines = this.plugin.routinesFor(day);'));
  assert.ok(board.includes('const seg = segmentInfo(this.plugin.settings, mins, todayStr());'));
  assert.ok(board.includes("colHead.insertAdjacentElement('afterend', cd);"));
  assert.ok(main.includes('const capacityDefs = adoptCacheDefs(parsed.defs, calendarFeeds(this.settings));'));
  assert.ok(main.includes('buildCalendarCacheContent(capacityDefs, new Date()'));
});

test('a routine note parses to steps and a per-day log', () => {
  const r = routine();
  assert.equal(r.name, 'Morning launch');
  assert.equal(r.routineType, 'morning');
  assert.equal(r.start, '06:30');
  assert.equal(r.end, '07:30');
  assert.deepEqual(r.weekdays, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(r.active, true);
  assert.equal(r.createdAt, '2026-09-04T09:00:00Z');
  assert.deepEqual(r.steps, [
    { index: 1, label: 'Water, 500 ml' },
    { index: 2, label: 'One journal page' },
    { index: 3, label: 'Plan the day on the board' },
  ]);
  assert.equal(r.log.found, true);
  assert.equal(r.log.schema, 'steps');
  assert.equal(r.log.rows.length, 3);
  assert.equal(r.log.direction, 'desc');
});

test('any other note is null, and nothing in sync can see a routine', () => {
  assert.equal(T.parseRoutineNote({ type: 'planner-item', source: 'todoist', external_id: '1' }, BODY), null);
  assert.equal(T.parseRoutineNote(null, BODY), null);
  // The item reader refuses the type, which is what keeps collectItems,
  // reconcile and the push path blind to routine notes.
  assert.equal(T.itemFromFrontmatter(Object.assign({}, FM), '02 Planner/Routines/x.md', 'x'), null);
});

test('a step box in the definition is never treated as state', () => {
  // Step 2 is "- [x]" in the Steps list; a day with no row still has it unchecked.
  const r = routine();
  const occ = T.routineOccurrence(r, '2026-09-01', '13:00');
  assert.deepEqual(occ.steps.map((s) => s.done), [false, false, false]);
  assert.equal(occ.done, 0);
  assert.equal(occ.total, 3);
  assert.equal(occ.skipped, false);
});

test('the day\'s row supplies the checked steps, the count is derived from the indices', () => {
  const r = routine();
  const three = T.routineOccurrence(r, '2026-09-03', '13:00');
  assert.deepEqual(three.steps.map((s) => s.done), [false, true, false]);
  assert.equal(three.done, 1);
  const full = T.routineOccurrence(r, '2026-09-04', '13:00');
  assert.equal(full.done, 3);
  // A habit-style Y with no indices means every step; a fraction at total does too.
  assert.deepEqual(T.routineRowState({ marker: 'Y', rest: [''] }, 3).done, [1, 2, 3]);
  assert.deepEqual(T.routineRowState({ marker: '3/3', rest: [] }, 3).done, [1, 2, 3]);
  assert.deepEqual(T.routineRowState({ marker: '1/3', rest: [] }, 3).done, [], 'a partial count with no indices cannot be mapped');
  assert.deepEqual(T.routineRowState({ marker: '2/3', rest: ['9,2,1'] }, 3).done, [1, 2], 'out-of-range indices drop');
});

test('THE ASK: a Mon-Fri morning routine occurs on Monday and not on Sunday', () => {
  assert.equal(T.dayCode('2026-09-07'), 'mon');
  assert.equal(T.dayCode('2026-09-06'), 'sun');
  const r = routine();
  assert.equal(T.routineOccurrences([r], '2026-09-07', '13:00').length, 1);
  assert.equal(T.routineOccurrences([r], '2026-09-06', '13:00').length, 0);
  // an inactive routine never occurs; a routine with no weekdays never occurs
  assert.equal(T.routineOccurrences([routine({ active: false })], '2026-09-07', '13:00').length, 0);
  assert.equal(T.routineOccurrences([routine({ weekdays: [] })], '2026-09-07', '13:00').length, 0);
});

test('start before the split lands in AM, at or after it in PM', () => {
  assert.equal(T.routineHalf('06:30', '13:00'), 'am');
  assert.equal(T.routineHalf('13:00', '13:00'), 'pm');
  assert.equal(T.routineHalf('12:59', '13:00'), 'am');
  assert.equal(T.routineHalf('21:00', '13:00'), 'pm');
  const am = T.routineOccurrence(routine(), '2026-09-07', '13:00');
  assert.equal(am.half, 'am');
  assert.equal(am.startMin, 390);
  assert.equal(am.endMin, 450);
  const pm = T.routineOccurrence(routine({ routine_type: 'afternoon', start: '13:00', end: '13:30' }), '2026-09-07', '13:00');
  assert.equal(pm.half, 'pm');
  // the lunch start moves the split: 12:30 lunch puts a 12:45 routine in PM
  assert.equal(T.routineHalf('12:45', '12:30'), 'pm');
});

test('a missing or malformed time falls back to the type default, never to a crash', () => {
  const r = routine({ start: 'soon', end: null });
  assert.equal(r.start, null);
  const occ = T.routineOccurrence(r, '2026-09-07', '13:00', T.DEFAULT_SETTINGS.routineDefaults);
  assert.equal(occ.startMin, 390, 'the morning default');
  assert.equal(occ.endMin, 450);
  // an unquoted 06:30 read as sexagesimal minutes by a YAML dialect
  assert.equal(T.normalizeHM(390), '06:30');
  assert.equal(T.normalizeHM('6:05'), '06:05');
  assert.equal(T.normalizeHM('24:00'), null);
  assert.equal(T.normalizeHM('07:60'), null);
});

test('laneSequence orders event, routine, task on a tie', () => {
  const ev = { start: '2026-09-07T09:00:00', title: 'Standup' };
  const task = { path: 't.md', plannedOrder: 540 };
  const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:30' }), '2026-09-07', '13:00');
  assert.equal(occ.startMin, 540);
  const seq = T.laneSequence([ev], [task], [occ]);
  assert.deepEqual(seq.map((e) => e.kind), ['event', 'routine', 'task']);
  assert.equal(seq[1].occ, occ, 'the occurrence passes through by reference');
  assert.equal(seq[1].path, occ.routine.path);
  assert.equal(seq[1].plannedOrder, 540);
  assert.deepEqual(T.LANE_KIND_RANK, { event: 0, routine: 1, task: 2 });
  // the two-argument form still works for every existing caller
  assert.deepEqual(T.laneSequence([ev], [task]).map((e) => e.kind), ['event', 'task']);
  // earlier start wins over kind
  const late = T.routineOccurrence(routine({ start: '10:00', end: '10:30' }), '2026-09-07', '13:00');
  assert.deepEqual(T.laneSequence([ev], [task], [late]).map((e) => e.kind), ['event', 'task', 'routine']);
});

test('agendaSections carries routines into the right half', () => {
  const today = '2026-09-07';
  const am = T.routineOccurrence(routine(), today, '13:00');
  const pm = T.routineOccurrence(routine({ routine_type: 'evening', start: '21:00', end: '21:45' }), today, '13:00');
  const other = T.routineOccurrence(routine(), '2026-09-08', '13:00');
  const model = T.agendaSections([], [], today, [am, pm, other]);
  assert.deepEqual(model.am.map((e) => e.kind), ['routine']);
  assert.equal(model.am[0].occ, am);
  assert.deepEqual(model.pm.map((e) => e.kind), ['routine']);
  assert.equal(model.pm[0].occ, pm);
  // the three-argument form still works
  assert.deepEqual(T.agendaSections([], [], today).am, []);
});

test('a skipped day is a ghost, a full day is done, an empty routine is neither', () => {
  const r = routine();
  assert.deepEqual(T.routineCardState(T.routineOccurrence(r, '2026-09-02', '13:00')), { ghost: true, done: false });
  assert.deepEqual(T.routineCardState(T.routineOccurrence(r, '2026-09-04', '13:00')), { ghost: false, done: true });
  assert.deepEqual(T.routineCardState(T.routineOccurrence(r, '2026-09-03', '13:00')), { ghost: false, done: false });
  const none = routine({}, BODY.replace(/- \[[ x]\] .*\n/g, ''));
  assert.equal(none.steps.length, 0);
  assert.deepEqual(T.routineCardState(T.routineOccurrence(none, '2026-09-07', '13:00')), { ghost: false, done: false });
});

test('the kicker names the type and the time, never a colour', () => {
  const occ = T.routineOccurrence(routine(), '2026-09-07', '13:00');
  assert.equal(T.routineKicker(occ), 'MORNING ROUTINE');
  assert.equal(T.routineTimeLabel(occ), '06:30 - 07:30');
});

test('checking a step writes the day\'s row with the indices and the recomputed count', () => {
  // no row for the day: a new one lands on top (newest-on-top table)
  const one = T.routineLogAfterStep(BODY, '2026-09-05', 2, true, 3);
  const rows = T.parseLogTable(one, 'routine-log').rows;
  assert.deepEqual([rows[0].date, rows[0].marker, rows[0].rest], ['2026-09-05', '1/3', ['2']]);
  assert.equal(rows.length, 4);
  // a second step on the same day extends the same row, in index order
  const two = T.routineLogAfterStep(one, '2026-09-05', 1, true, 3);
  const row2 = T.logRowFor(T.parseLogTable(two, 'routine-log'), '2026-09-05');
  assert.deepEqual([row2.marker, row2.rest], ['2/3', ['1,2']]);
  // unchecking removes the index, the row stays as the record of the day
  const back = T.routineLogAfterStep(two, '2026-09-05', 1, false, 3);
  const row3 = T.logRowFor(T.parseLogTable(back, 'routine-log'), '2026-09-05');
  assert.deepEqual([row3.marker, row3.rest], ['1/3', ['2']]);
  // untouched lines keep their bytes
  const before = BODY.split('\n');
  const after = back.split('\n');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, 16), before.slice(0, 16));
  assert.deepEqual(after.slice(17), before.slice(16));
});

test('skip writes S, reset and unskip delete the row', () => {
  const skipped = T.routineLogSkipped(BODY, '2026-09-05');
  const row = T.logRowFor(T.parseLogTable(skipped, 'routine-log'), '2026-09-05');
  assert.equal(row.marker, 'S');
  assert.equal(T.routineRowState(row, 3).skipped, true);
  const reset = T.routineLogReset(skipped, '2026-09-05');
  assert.equal(reset, BODY, 'reset returns the body to its prior bytes');
  assert.equal(T.routineLogReset(BODY, '2026-09-02').includes('| 2026-09-02 |'), false);
});

test('a note without a log section gets one on the first check, in the contract shape', () => {
  const bare = BODY.split('\n## Log')[0] + '\n';
  const out = T.routineLogAfterStep(bare, '2026-09-05', 3, true, 3);
  assert.ok(out.includes('\n## Log\n<!-- routine-log: schema=steps -->\n| Date | Done | Steps |\n| --- | --- | --- |\n| 2026-09-05 | 1/3 | 3 |\n'));
  assert.deepEqual(T.ROUTINE_LOG_SECTION, { heading: '## Log', schema: 'steps', header: ['Date', 'Done', 'Steps'] });
  assert.equal(T.ROUTINE_LOG_SENTINEL, 'routine-log');
});

test('the template writes every contract field', () => {
  const text = T.routineTemplate('Morning launch', 'morning', ['mon', 'tue', 'wed', 'thu', 'fri'],
    T.DEFAULT_SETTINGS.routineDefaults, { steps: ['Water, 500 ml', 'One journal page', 'Plan the day on the board'], nowIso: '2026-09-04T09:00:00Z' });
  const fmBlock = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fmBlock, 'a frontmatter block');
  const fmLines = fmBlock[1].split('\n');
  assert.deepEqual(fmLines, [
    'type: planner-routine',
    'name: "Morning launch"',
    'routine_type: morning',
    'start: "06:30"',
    'end: "07:30"',
    'weekdays: [mon, tue, wed, thu, fri]',
    'active: true',
    'created_at: 2026-09-04T09:00:00Z',
  ]);
  assert.ok(text.includes('\n# Morning launch\n'));
  assert.ok(text.includes('\n## Steps\n- [ ] Water, 500 ml\n- [ ] One journal page\n- [ ] Plan the day on the board\n'));
  assert.ok(text.includes('\n## Log\n<!-- routine-log: schema=steps -->\n| Date | Done | Steps |\n| --- | --- | --- |\n'));
  // and the template parses back through the reader it is written for
  const fm = {};
  for (const l of fmLines) { const m = /^([a-z_]+): (.*)$/.exec(l); fm[m[1]] = m[2]; }
  fm.weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
  fm.active = true;
  const r = T.parseRoutineNote(fm, text, '02 Planner/Routines/Morning launch.md');
  assert.equal(r.steps.length, 3);
  assert.equal(r.log.found, true);
  assert.equal(r.log.rows.length, 0);
  // the pair form for the times, an evening type, a placeholder step
  const ev = T.routineTemplate('Wind down', 'evening', 'sat, sun', { start: '21:00', end: '21:45' }, { nowIso: 'x' });
  assert.ok(ev.includes('routine_type: evening\nstart: "21:00"\nend: "21:45"\nweekdays: [sat, sun]\n'));
  assert.ok(ev.includes('- [ ] First step\n'));
});

test('the New routine checks speak in sentences', () => {
  assert.deepEqual(T.validateRoutineInput({ name: ' ', start: '06:30', end: '07:30', weekdays: ['mon'] }), { ok: false, error: 'Give the routine a name.' });
  assert.equal(T.validateRoutineInput({ name: 'x', start: '6', end: '07:30', weekdays: ['mon'] }).error, 'Times are HH:MM, for example 06:30.');
  assert.equal(T.validateRoutineInput({ name: 'x', start: '07:30', end: '07:30', weekdays: ['mon'] }).error, 'The end must be after the start.');
  assert.equal(T.validateRoutineInput({ name: 'x', start: '06:30', end: '07:30', weekdays: [] }).error, 'Pick at least one weekday.');
  assert.deepEqual(T.validateRoutineInput({ name: 'x', start: '06:30', end: '07:30', weekdays: ['mon'] }), { ok: true, error: null });
});

test('weekday codes normalise to the canonical seven, in order, once', () => {
  assert.deepEqual(T.WEEKDAY_CODES, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.deepEqual(T.normalizeWeekdays(['Sunday', 'MON', 'mon', 'x']), ['mon', 'sun']);
  assert.deepEqual(T.normalizeWeekdays('fri, wed'), ['wed', 'fri']);
  assert.deepEqual(T.normalizeWeekdays(null), []);
});

test('the settings: defaults, a partial routineDefaults merges, an empty weekday list is honoured', () => {
  const s = T.DEFAULT_SETTINGS;
  assert.equal(s.routinesEnabled, true);
  assert.deepEqual(s.routineDefaults, {
    morning: { start: '06:30', end: '07:30' },
    afternoon: { start: '13:00', end: '13:30' },
    evening: { start: '21:00', end: '21:45' },
  });
  assert.deepEqual(s.routineWeekdaysDefault, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(T.routineDefaultsOf({ routineDefaults: { evening: { start: '22:00' }, morning: { end: 'nope' } } }), {
    morning: { start: '06:30', end: '07:30' },
    afternoon: { start: '13:00', end: '13:30' },
    evening: { start: '22:00', end: '21:45' },
  });
  assert.deepEqual(T.routineWeekdaysDefaultOf({}), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(T.routineWeekdaysDefaultOf({ routineWeekdaysDefault: [] }), [], 'cleared stays cleared');
  assert.deepEqual(T.routineWeekdaysDefaultOf({ routineWeekdaysDefault: ['sat'] }), ['sat']);
  assert.deepEqual(T.ROUTINE_TYPES, ['morning', 'afternoon', 'evening']);
});

test('the routines folder derives from the planner folder and is created with the rest', () => {
  const p = T.plannerPaths({ plannerFolder: 'Planner' });
  assert.equal(p.routines, 'Planner/Routines');
  assert.equal(p.isRoutine('Planner/Routines/x.md'), true);
  assert.equal(p.isRoutine('Planner/Routines2/x.md'), false);
  assert.equal(p.isRoutine('Planner/Todoist/x.md'), false);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.ok(/await mk\(p\.routines\);/.test(main), 'ensureFolders creates Routines/');
});

function routineCardFixture(markdownRender, dimensions = {}) {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const renderer = main.slice(main.indexOf('function renderRoutineCard('), main.indexOf('function showRoutineMenu('));
  const checklist = markdownRender ? main.slice(main.indexOf('async function renderRoutineStepLabel('),
    main.indexOf('/* ---- the sentinel log table')) : '';
  const board = main.slice(main.indexOf('class PlannerBoardView extends ItemView'), main.indexOf('const TRAY_TABS'));
  const scale = main.match(/const PLANNER_PIXELS_PER_MINUTE\s*=[^;]+;/)[0];
  const movement = main.slice(main.indexOf('function snapDailyPlanMinute('), main.indexOf('function wireTimedTaskResize('));
  const documentListeners = {};
  const openedModals = [];
  const openedLinks = [];
  const components = [];
  const computedStyle = (node) => ({ paddingLeft: '8px', paddingRight: '8px', fontSize: '12px',
    display: node.style.display || 'block', visibility: node.style.visibility || 'visible',
    ...node.computedStyle });
  const element = (tagName) => {
    const node = { tagName, nodeType: 1, children: [], attributes: {}, listeners: {}, className: '', hidden: false, dataset: {}, style: {}, isConnected: true };
    Object.defineProperty(node, 'childNodes', { get: () => node.children });
    Object.defineProperty(node, 'textContent', {
      get: () => (node.ownText || '') + node.children.map((child) => child.textContent).join(''),
      set: (value) => { node.empty(); node.ownText = String(value); },
    });
    node.classList = {
      add: (...names) => { for (const name of names) if (!node.className.split(' ').includes(name)) node.className += ` ${name}`; },
      contains: (name) => node.className.split(' ').includes(name),
      toggle: (name, enabled) => {
        node.className = node.className.split(' ').filter((value) => value !== name).join(' ');
        if (enabled) node.classList.add(name);
      },
    };
    node.setAttribute = (name, value) => { node.attributes[name] = value; };
    node.getAttribute = (name) => node.attributes[name];
    node.appendChild = (child) => {
      if (child.nodeType === 11) {
        for (const entry of [...child.children]) node.appendChild(entry);
        child.children = [];
      } else { child.parentElement = node; node.children.push(child); }
      return child;
    };
    node.insertBefore = (child, before) => { child.parentElement = node; node.children.splice(node.children.indexOf(before), 0, child); };
    node.matches = (selector) => selector === ':disabled' && !!node.disabled;
    node.contains = (target) => target === node || node.children.some((child) => child.contains(target));
    node.closest = (selector) => {
      const tags = selector.split(',').map((part) => part.trim());
      for (let current = node; current; current = current.parentElement) {
        if (tags.includes(current.tagName)) return current;
      }
      return null;
    };
    node.getClientRects = () => {
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (!ancestor.isConnected || ancestor.hidden || computedStyle(ancestor).display === 'none') return [];
      }
      return [{}];
    };
    let scrollTop = 0;
    Object.defineProperty(node, 'scrollTop', {
      get: () => scrollTop,
      set: (value) => {
        if (dimensions.ignoreHiddenScrollAssignments && !node.getClientRects().length) return;
        scrollTop = value;
      },
    });
    node.addClass = (...names) => node.classList.add(...names);
    node.style.setProperty = (name, value) => { node.style[name] = value; };
    node.focus = () => { node.focused = true; };
    node.disconnect = () => { node.isConnected = false; for (const child of node.children) child.disconnect(); };
    node.empty = () => { for (const child of node.children) child.disconnect(); node.children = []; node.ownText = ''; };
    node.replaceChildren = (...children) => { node.empty(); for (const child of children) node.appendChild(child); };
    node.createEl = (tag, options = {}) => {
      const child = element(tag);
      child.className = options.cls || '';
      child.textContent = options.text || '';
      child.attributes = { ...(options.attr || {}) };
      if (options.attr && options.attr.title) child.title = options.attr.title;
      return node.appendChild(child);
    };
    node.createDiv = (options) => node.createEl('div', options);
    node.createSpan = (options) => node.createEl('span', options);
    node.querySelector = (selector) => {
      const classMatch = /^\.([\w-]+)/.exec(selector);
      const tagMatch = /^[a-z][\w-]*/i.exec(selector);
      const attributeMatch = /\[([\w-]+)="(.*)"\]/.exec(selector);
      for (const child of node.children) {
        if (child.nodeType !== 1) continue;
        if ((!tagMatch || child.tagName.toLowerCase() === tagMatch[0].toLowerCase())
          && (!classMatch || child.className.split(' ').includes(classMatch[1]))
          && (!attributeMatch || child.attributes[attributeMatch[1]] === attributeMatch[2])) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    };
    node.getBoundingClientRect = () => ({
      top: parseFloat(node.style.top) || 0,
      left: node.className.includes('iplan-routine-label-gutter') ? 300 : 0,
      right: 100, width: 240,
      height: node.getClientRects().length ? node.measuredHeight
        ?? (node.classList.contains('iplan-workday-label') ? dimensions.workdayLabelHeight ?? 24
          : node.classList.contains('iplan-workday-line') ? 2 : parseFloat(node.style.height) || 24) : 0,
      ...node.measuredRect,
    });
    const registrations = {};
    node.addEventListener = (name, listener, capture = false) => {
      (registrations[name] || (registrations[name] = [])).push({ listener, capture: capture === true });
      node.listeners[name] = (event) => {
        for (const entry of [...registrations[name]].sort((first, second) => Number(second.capture) - Number(first.capture))) entry.listener(event);
      };
    };
    node.removeEventListener = (name, listener) => {
      registrations[name] = (registrations[name] || []).filter((entry) => entry.listener !== listener);
    };
    node.fire = (name, values = {}) => {
      const event = {
        defaultPrevented: false, stopped: false, target: node, ...values,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
      };
      node.listeners[name](event);
      return event;
    };
    node.dispatch = (name, values = {}) => {
      const event = { target: node, defaultPrevented: false, stopped: false, ...values,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; } };
      for (let current = node; current && !event.stopped; current = current.parentElement) {
        if (current.listeners[name]) current.listeners[name](event);
      }
      return event;
    };
    return node;
  };
  return vm.runInNewContext(`${scale}\n${movement}\n${checklist}\n${renderer}\n${board}\n({ renderRoutineCard, PlannerBoardView, RoutineDetailModal, wireDailyPlanMove, documentListeners, element, openedModals, openedLinks, components, PLANNER_PIXELS_PER_MINUTE${markdownRender ? ', renderChecklist, renderRoutineStepLabel' : ''} })`, {
    Set, Map, documentListeners, ItemView: class {
      constructor(leaf) { this.leaf = leaf || {}; this.leaf.view = this; }
    }, element, openedModals, openedLinks, components, URL,
    document: {
      addEventListener: (name, listener) => { documentListeners[name] = listener; },
      removeEventListener: (name, listener) => { if (documentListeners[name] === listener) delete documentListeners[name]; },
      createElement: element,
      createTextNode: (text) => { const node = element('#text'); node.nodeType = 3; node.textContent = text; return node; },
      createDocumentFragment: () => { const node = element('#fragment'); node.nodeType = 11; return node; },
    },
    Component: class {
      constructor() { components.push(this); }
      load() { this.loaded = true; }
      unload() { this.unloaded = true; }
    },
    MarkdownRenderer: { render: markdownRender },
    window: { open: (...args) => openedLinks.push(args) },
    Notice: class {}, checklistProgressText: T.checklistProgressText,
    getComputedStyle: computedStyle,
    Modal: class {
      constructor() { this.contentEl = element('div'); }
      open() { openedModals.push(this); this.onOpen(); }
      close() { this.onClose(); }
    },
    CSS: { escape: (value) => value },
    markInkPlugin: (node, id) => node.setAttribute('data-ink-plugin', id),
    todayStr: () => '2026-09-07', mondayOf: () => '2026-09-07',
    timedGridBounds: T.timedGridBounds, timedGridColumns: T.timedGridColumns,
    activeTimedPlacement: T.activeTimedPlacement, plannedDuration: T.plannedDuration,
    localDayStr: T.localDayStr, fmtTimeHM: T.fmtTimeHM, hmToMin: T.hmToMin,
    workdayFor: T.workdayFor, planMinute: T.planMinute,
    fmtMin: (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
    plannedStartText: (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
    wireTimedDrop: () => {},
    routineCardState: T.routineCardState, routineKicker: T.routineKicker,
    routineTimeLabel: T.routineTimeLabel, checklistModel: T.checklistModel,
    setIcon: (node, icon) => { node.icon = icon; },
    renderChecklist: (parent, model, options) => { parent.checklist = { model, options }; },
    wireLongPress: () => {},
  });
}

test('SIMULATED: plan dragging preserves grab offset, cancels without saving and offers keyboard movement', async () => {
  const fixture = routineCardFixture();
  const { wireDailyPlanMove, element, documentListeners, PLANNER_PIXELS_PER_MINUTE } = fixture;
  const card = element('div');
  const handle = card.createEl('button', { attr: { 'data-plan-focus': 'routine:Monday' } });
  const view = {};
  const previews = [];
  const saves = [];
  const scroll = { scrollTop: 321 };
  wireDailyPlanMove(card, handle, view, { value: 390, minimum: 0, maximum: 1393, scroll,
    label: 'Planned routine', preview: (value) => previews.push(value), save: async (value) => { saves.push(value); return true; } });
  const pointer = { pointerId: 1, button: 0, clientY: 100 };
  handle.fire('pointerdown', pointer);
  card.fire('pointermove', { ...pointer, clientY: 104 });
  card.fire('pointerup', { ...pointer, clientY: 104 });
  assert.deepEqual(saves, []);
  assert.equal(card.fire('click').defaultPrevented, false);
  handle.fire('pointerdown', pointer);
  card.fire('pointermove', { ...pointer, clientY: 100 + 45 * PLANNER_PIXELS_PER_MINUTE });
  assert.equal(previews.at(-1), 435);
  const cancel = { key: 'Escape', preventDefault() {}, stopPropagation() {} };
  documentListeners.keydown(cancel);
  assert.equal(previews.at(-1), 390);
  assert.equal(documentListeners.keydown, undefined);
  assert.deepEqual(saves, []);
  handle.fire('pointerdown', pointer);
  card.fire('pointermove', { ...pointer, clientY: 100 + 45 * PLANNER_PIXELS_PER_MINUTE });
  card.fire('pointercancel', pointer);
  assert.deepEqual(saves, []);
  assert.equal(previews.at(-1), 390);
  handle.fire('pointerdown', pointer);
  card.fire('pointermove', { ...pointer, clientY: 100 + 45 * PLANNER_PIXELS_PER_MINUTE });
  card.fire('pointerup', { ...pointer, clientY: 100 + 45 * PLANNER_PIXELS_PER_MINUTE });
  assert.deepEqual(saves, [435]);
  assert.equal(card.fire('click').defaultPrevented, true);
  assert.equal(scroll.scrollTop, 321);
  handle.fire('keydown', { key: 'ArrowDown' });
  assert.deepEqual(saves, [435, 450]);
  assert.equal(handle.attributes['aria-valuenow'], '450');
  const title = card.createEl('button');
  card.fire('pointerdown', { ...pointer, target: title });
  assert.equal(view.cancelDailyMove, null);
  await Promise.resolve();
});

test('SIMULATED: moved routine geometry and leaders retain duration and scroll, and marker handles stay independent', async () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  const occurrence = T.routineOccurrence(routine({ start: '06:30', end: '06:47' }), day, '13:00');
  const plugin = dailyPlanPlugin([occurrence.routine]);
  const view = new PlannerBoardView(null, plugin);
  view.timeScrollPositions.set(day, 321);
  view.renderTimedGrid(day, element('div'), [], [], [occurrence]);
  const grid = view.timedGrids.get(day);
  const entry = grid.entries[0];
  const height = entry.element.style.height;
  const handle = entry.element.querySelector('.iplan-plan-move');
  handle.fire('keydown', { key: 'ArrowDown' });
  await plugin._settingsSaveQueue;
  assert.equal(entry.start, 405);
  assert.equal(entry.end, 422);
  assert.equal(entry.element.style.height, height);
  assert.equal(entry.element.style.top, `${405 * PLANNER_PIXELS_PER_MINUTE}px`);
  assert.equal(entry.labelLeader.style.top, `${(405 + 8.5) * PLANNER_PIXELS_PER_MINUTE}px`);
  assert.equal(grid.scroll.scrollTop, 321);
  assert.equal(occurrence.startMin, 390);
  assert.equal(occurrence.routine.start, '06:30');
  assert.equal(plugin.settings._dailyPlanOverrides[day].routines[occurrence.routine.path].end, 422);
  const [startMarker, endMarker] = grid.workdayLabels;
  startMarker.element.fire('keydown', { key: 'ArrowDown' });
  await plugin._settingsSaveQueue;
  assert.deepEqual(plugin.settings._dailyPlanOverrides[day].workday, { start: 495 });
  assert.equal(T.workdayFor(day, plugin.settings).end, 1080);
  endMarker.element.fire('keydown', { key: 'ArrowUp' });
  await plugin._settingsSaveQueue;
  assert.deepEqual(plugin.settings._dailyPlanOverrides[day].workday, { start: 495, end: 1065 });
  assert.deepEqual(T.workdayFor('2026-09-08', plugin.settings), { start: 480, end: 1080 });
  assert.equal(grid.scroll.scrollTop, 321);
});

test('SIMULATED: an open routine modal resolves source changes at queue execution and rejects rename or deletion', async () => {
  for (const change of ['duration', 'renamed', 'deleted']) {
    const { RoutineDetailModal, element } = routineCardFixture();
    const plugin = dailyPlanPlugin();
    plugin.manifest = { id: 'mahdyar-planner' };
    const day = '2026-09-07';
    const occurrence = plugin.routinesFor(day)[0];
    const modal = new RoutineDetailModal(plugin, occurrence, null, element('button'));
    modal.open();
    const controls = modal.contentEl.querySelector('.iplan-planned-time-controls');
    const input = controls.querySelector('input');
    const save = controls.querySelector('button[aria-label="Set planned start"]');
    const reset = controls.querySelector('button[aria-label="Reset planned time"]');
    let began;
    let release;
    const started = new Promise((resolve) => { began = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let saves = 0;
    plugin.saveData = async () => { saves += 1; if (saves === 1) { began(); await gate; } };
    const earlier = plugin.persistSettings();
    await started;
    input.value = '07:15';
    save.fire('click');
    assert.equal(save.disabled, true);
    assert.equal(reset.disabled, true);
    if (change === 'duration') plugin.routines = [routine({ start: '06:30', end: '07:17' })];
    else {
      plugin.planFiles.delete(occurrence.routine.path);
      plugin.routines = change === 'renamed' ? [routine({}, BODY, '02 Planner/Routines/Renamed.md')] : [];
    }
    release();
    await earlier;
    await plugin._settingsSaveQueue;
    await Promise.resolve();
    if (change === 'duration') {
      assert.deepEqual(plugin.settings._dailyPlanOverrides[day].routines[occurrence.routine.path], { start: 435, end: 482 });
      assert.equal(modal.contentEl.children.length, 0);
    } else {
      assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
      assert.equal(saves, 1);
      assert.equal(save.disabled, false);
      assert.equal(reset.disabled, false);
      assert.ok(modal.contentEl.children.length > 0);
      reset.fire('click');
      await plugin._settingsSaveQueue;
      await Promise.resolve();
      assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
      assert.equal(saves, 1);
      modal.close();
    }
    assert.equal(occurrence.endMin - occurrence.startMin, 60);
  }
});

test('SIMULATED: scrolled workday marker drags track pointer plus scroll with grab offset and cancel cleanly', async () => {
  for (const mode of ['week', 'day']) {
    const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE, documentListeners } = routineCardFixture();
    const plugin = dailyPlanPlugin();
    const day = '2026-09-07';
    const view = new PlannerBoardView(null, plugin);
    view.mode = mode;
    view.timeScrollPositions.set(day, 321);
    view.renderTimedGrid(day, element('div'), [], [], []);
    const grid = view.timedGrids.get(day);
    const [startMarker, endMarker] = grid.workdayLabels;
    const initialTotals = T.dailyPlannedTime(day, plugin.settings, [], [], []);
    const pointer = { pointerId: 3, button: 0, clientY: 137 };
    startMarker.element.fire('pointerdown', pointer);
    grid.scroll.scrollTop += 30 * PLANNER_PIXELS_PER_MINUTE;
    startMarker.element.fire('pointermove', { ...pointer, clientY: 137 + 15 * PLANNER_PIXELS_PER_MINUTE });
    assert.equal(startMarker.anchor, 525 * PLANNER_PIXELS_PER_MINUTE);
    assert.equal(startMarker.element.attributes['aria-valuenow'], '525');
    assert.deepEqual(T.dailyPlannedTime(day, plugin.settings, [], [], []), initialTotals);
    documentListeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(startMarker.anchor, 480 * PLANNER_PIXELS_PER_MINUTE);
    assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
    assert.equal(plugin._settingsSaveQueue, undefined);
    startMarker.element.fire('pointerdown', pointer);
    grid.scroll.scrollTop += 30 * PLANNER_PIXELS_PER_MINUTE;
    const moved = { ...pointer, clientY: 137 + 15 * PLANNER_PIXELS_PER_MINUTE };
    startMarker.element.fire('pointerup', moved);
    await plugin._settingsSaveQueue;
    assert.deepEqual(T.workdayFor(day, plugin.settings), { start: 525, end: 1080 });
    assert.equal(T.dailyPlannedTime(day, plugin.settings, [], [], []).dayMin, 555);
    assert.equal(endMarker.anchor, 1080 * PLANNER_PIXELS_PER_MINUTE);
    const committed = JSON.parse(JSON.stringify(plugin.settings._dailyPlanOverrides));
    endMarker.element.fire('pointerdown', pointer);
    grid.scroll.scrollTop -= 15 * PLANNER_PIXELS_PER_MINUTE;
    endMarker.element.fire('pointermove', pointer);
    assert.equal(endMarker.anchor, 1065 * PLANNER_PIXELS_PER_MINUTE);
    endMarker.element.fire('pointercancel', pointer);
    assert.equal(endMarker.anchor, 1080 * PLANNER_PIXELS_PER_MINUTE);
    assert.deepEqual(plugin.settings._dailyPlanOverrides, committed);
  }
});

test('SIMULATED: routine Markdown output is inline and safe, with separate link and checkbox activation', async () => {
  const source = 'Check [Action Items](https://example.com/actions) of today';
  const renderCalls = [];
  const fixture = routineCardFixture(async (app, markdown, rendered, sourcePath, component) => {
    renderCalls.push({ app, markdown, sourcePath, component });
    const paragraph = rendered.createEl('p');
    paragraph.appendChild(fixture.element('span')).textContent = 'Check ';
    paragraph.createEl('a', { cls: 'external-link', text: 'Action Items', attr: { href: 'https://example.com/actions' } });
    paragraph.createEl('span', { text: ' of today' });
  });
  const { element, renderChecklist, openedLinks, components } = fixture;
  const container = element('div');
  let cardClicks = 0;
  container.addEventListener('click', () => { cardClicks += 1; });
  const calls = [];
  const plugin = { app: {} };
  const block = renderChecklist(container, T.checklistModel({ rows: [{ id: 1, label: source }] }), {
    routineLabels: { plugin, sourcePath: '02 Planner/Routines/Morning.md' },
    onToggle: (...args) => calls.push(args),
  });
  await Promise.resolve();
  await Promise.resolve();
  const row = block.children[0];
  const check = row.querySelector('input');
  const label = row.querySelector('.iplan-checklist-label');
  const link = label.querySelector('a');
  assert.equal(row.tagName, 'div');
  assert.equal(row.attributes.role, undefined);
  assert.equal(check.type, 'checkbox');
  assert.equal(check.attributes['aria-label'], 'Check Action Items of today');
  assert.equal(label.textContent, 'Check Action Items of today');
  assert.equal(label.querySelector('p'), null);
  assert.equal(link.textContent, 'Action Items');
  assert.equal(link.attributes.href, 'https://example.com/actions');
  assert.equal(row.children[0].tagName, 'label');
  assert.equal(row.children[0].children.length, 1);
  assert.equal(check.checked, false);
  assert.deepEqual(openedLinks, []);
  assert.deepEqual(calls, []);
  assert.equal(label.dispatch('click').defaultPrevented, false);
  assert.equal(check.dispatch('keydown', { key: ' ' }).defaultPrevented, false);
  assert.equal(link.dispatch('keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.deepEqual(calls, []);
  const activation = link.dispatch('click');
  assert.equal(activation.defaultPrevented, true);
  assert.equal(activation.stopped, true);
  assert.deepEqual(openedLinks, [['https://example.com/actions', '_external']]);
  assert.deepEqual(calls, []);
  assert.equal(cardClicks, 0);
  check.checked = true;
  check.dispatch('change');
  assert.deepEqual(calls, [['1', true]]);
  assert.equal(check.checked, true);
  assert.equal(row.classList.contains('is-checked'), true);
  assert.equal(block.children.at(-1).textContent, '1 of 1');
  assert.equal(renderCalls[0].markdown, source);
  assert.equal(renderCalls[0].sourcePath, '02 Planner/Routines/Morning.md');
  assert.equal(components[0].loaded, true);
  assert.equal(components[0].unloaded, true);
});

test('SIMULATED: internal links navigate relative to the routine, and bare URLs keep renderer labels', async () => {
  for (const internal of [true, false]) {
    const fixture = routineCardFixture(async (_app, _markdown, rendered) => {
      rendered.createEl('p').createEl('a', { cls: internal ? 'internal-link' : 'external-link',
        text: internal ? 'Daily note' : 'https://example.com',
        attr: internal ? { href: 'Daily#Today', 'data-href': 'Daily#Today' } : { href: 'https://example.com' } });
    });
    const navigation = [];
    const plugin = { app: { workspace: { openLinkText: (...args) => navigation.push(args) } } };
    const label = fixture.element('span');
    await fixture.renderRoutineStepLabel(label, internal ? '[[Daily#Today|Daily note]]' : 'https://example.com',
      plugin, '02 Planner/Routines/Morning.md');
    const link = label.querySelector('a');
    link.dispatch('click', { ctrlKey: true });
    if (internal) {
      assert.deepEqual(navigation, [['Daily#Today', '02 Planner/Routines/Morning.md', true]]);
      assert.deepEqual(fixture.openedLinks, []);
    } else {
      assert.equal(link.textContent, 'https://example.com');
      assert.deepEqual(fixture.openedLinks, [['https://example.com', '_external']]);
      assert.deepEqual(navigation, []);
    }
  }
});

test('SIMULATED: malformed/plain step text stays text and unsafe rendered destinations never become links', async () => {
  for (const source of ['Water & rest', 'Check [unfinished](today', '<img src=x onerror=alert(1)>', 'First\nSecond']) {
    const markdownInputs = [];
    const fixture = routineCardFixture(async (_app, markdown, rendered) => {
      markdownInputs.push(markdown);
      rendered.createEl('p', { text: source });
    });
    const label = fixture.element('span');
    await fixture.renderRoutineStepLabel(label, source, { app: {} }, 'Routine.md');
    assert.equal(label.textContent, source);
    assert.equal(label.querySelector('a'), null);
    assert.equal(label.querySelector('img'), null);
    if (source.includes('\n')) assert.equal(markdownInputs.length, 0);
    if (source.startsWith('<')) assert.equal(markdownInputs[0], '&lt;img src=x onerror=alert(1)&gt;');
  }
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/example', 'vbscript:msgbox(1)']) {
    const fixture = routineCardFixture(async (_app, _markdown, rendered) => {
      rendered.createEl('p').createEl('a', { text: 'Unsafe', attr: { href } });
    });
    const label = fixture.element('span');
    await fixture.renderRoutineStepLabel(label, `[Unsafe](${href})`, { app: {} }, 'Routine.md');
    assert.equal(label.textContent, 'Unsafe');
    assert.equal(label.querySelector('a'), null);
    assert.deepEqual(fixture.openedLinks, []);
  }
});

test('SIMULATED: closed labels reject late rendering, unload components and preserve text on failure or block markup', async () => {
  let finish;
  const fixture = routineCardFixture((_app, _markdown, rendered) => new Promise((resolve) => {
    finish = () => { rendered.createEl('p', { text: 'Late' }); resolve(); };
  }));
  const label = fixture.element('span');
  const pending = fixture.renderRoutineStepLabel(label, 'Original', { app: {} }, 'Routine.md');
  label.disconnect();
  finish();
  await pending;
  assert.equal(label.textContent, 'Original');
  assert.equal(fixture.components[0].unloaded, true);
  for (const renderer of [async () => { throw new Error('render failed'); },
    async (_app, _markdown, rendered) => { rendered.createEl('h1', { text: 'Heading' }); }]) {
    const failed = routineCardFixture(renderer);
    const text = failed.element('span');
    await failed.renderRoutineStepLabel(text, '# Original', { app: {} }, 'Routine.md');
    assert.equal(text.textContent, '# Original');
    assert.equal(failed.components[0].unloaded, true);
  }
});

test('SIMULATED: routine checkbox writes revert on refusal, disabled boxes stay inert, other checklists keep button rows', async () => {
  const fixture = routineCardFixture(async (_app, markdown, rendered) => { rendered.createEl('p', { text: markdown }); });
  const container = fixture.element('div');
  let writes = 0;
  const block = fixture.renderChecklist(container, T.checklistModel({ rows: [
    { id: 1, label: 'Water' }, { id: 2, label: 'Skipped', disabled: true },
  ] }), { routineLabels: { plugin: { app: {} }, sourcePath: 'Routine.md' },
    onToggle: async () => { writes += 1; return false; } });
  const check = block.children[0].querySelector('input');
  check.checked = true;
  check.dispatch('change');
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.equal(check.checked, false);
  assert.equal(block.children[0].classList.contains('is-checked'), false);
  const disabled = block.children[1].querySelector('input');
  assert.equal(disabled.disabled, true);
  disabled.dispatch('change');
  assert.equal(writes, 1);
  const ordinary = fixture.renderChecklist(container, T.checklistModel({ rows: [{ id: 3, label: '[Raw](text)' }] }),
    { onToggle: () => { writes += 1; } });
  assert.equal(ordinary.children[0].tagName, 'button');
  assert.equal(ordinary.children[0].attributes.role, 'checkbox');
  assert.equal(ordinary.children[0].querySelector('.iplan-checklist-label').textContent, '[Raw](text)');
  ordinary.children[0].dispatch('click');
  assert.equal(writes, 2);
  assert.equal(ordinary.children[0].attributes['aria-checked'], 'true');
});

test('SIMULATED: overview and expanded calendar details share routine labels without rewriting step definitions', async () => {
  const source = 'Check [Action Items](https://example.com/actions) of today';
  const fixture = routineCardFixture(async (_app, _markdown, rendered) => {
    rendered.createEl('p').createEl('a', { text: 'Action Items', attr: { href: 'https://example.com/actions' } });
  });
  const body = BODY.replace('Water, 500 ml', source);
  const occ = T.routineOccurrence(routine({}, body), '2026-09-07', '13:00');
  const writes = [];
  const plugin = { app: {}, manifest: { id: 'mahdyar-planner' }, toggleRoutineStep: (...args) => writes.push(args) };
  const view = new fixture.PlannerBoardView(null, plugin);
  view.contentEl = fixture.element('div');
  view.render = () => {};
  view.routineExpanded.add(JSON.stringify([occ.routine.path, occ.day]));
  const overview = view.contentEl.appendChild(fixture.renderRoutineCard(plugin, occ, view));
  const modal = new fixture.RoutineDetailModal(plugin, occ, view, null);
  modal.open();
  await Promise.resolve();
  await Promise.resolve();
  for (const surface of [overview, modal.contentEl]) {
    const label = surface.querySelector('.iplan-checklist-label');
    assert.equal(label.querySelector('a').textContent, 'Action Items');
    assert.equal(surface.querySelector('.iplan-routine-steps').children[0].tagName, 'div');
    label.querySelector('a').dispatch('click');
  }
  assert.equal(modal.contentEl.querySelector('.iplan-card-sub-toggle').attributes['aria-expanded'], 'true');
  assert.equal(modal.contentEl.querySelector('.iplan-nav-btn'), null);
  assert.deepEqual(writes, []);
  assert.equal(occ.steps[0].label, source);
  assert.equal(occ.routine.steps[0].label, source);
  assert.equal(body.includes(`- [ ] ${source}`), true);
  modal.close();
});

test('SIMULATED: plain, linked and multiline routine labels share separate first-line checkbox structure', async () => {
  const sources = ['Water', '[A long link that can wrap onto another line](https://example.com)', 'First\nSecond'];
  const fixture = routineCardFixture(async (_app, markdown, rendered) => {
    const paragraph = rendered.createEl('p');
    if (markdown === sources[1]) {
      paragraph.createEl('a', { text: 'A long link that can wrap onto another line',
        attr: { href: 'https://example.com' } }).createEl('br');
    } else paragraph.textContent = markdown;
  });
  const block = fixture.renderChecklist(fixture.element('div'), T.checklistModel({
    rows: sources.map((label, index) => ({ id: index, label })),
  }), { routineLabels: { plugin: { app: {} }, sourcePath: 'Routine.md' }, progress: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(block.classList.contains('iplan-routine-steps'), true);
  for (const row of block.children) {
    assert.equal(row.tagName, 'div');
    assert.equal(row.children.length, 2);
    assert.equal(row.children[0].className, 'iplan-routine-step-check');
    assert.equal(row.children[0].children.length, 1);
    assert.equal(row.children[0].children[0].type, 'checkbox');
    assert.equal(row.children[1].className, 'iplan-checklist-label');
    assert.equal(row.children[1].querySelector('input'), null);
    assert.equal(row.children[1].querySelector('p'), null);
  }
  assert.equal(block.children[0].children[1].textContent, sources[0]);
  assert.ok(block.children[1].children[1].querySelector('a').querySelector('br'));
  assert.equal(block.children[2].children[1].textContent, sources[2]);
});

test('SOURCE: routines opt into one Markdown renderer with scoped text, checkbox and link cursor rules', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const renderer = main.slice(main.indexOf('function renderRoutineCard('), main.indexOf('function showRoutineMenu('));
  assert.ok(renderer.includes('routineLabels: { plugin, sourcePath: routine.path }'));
  const helper = main.slice(main.indexOf('async function renderRoutineStepLabel('), main.indexOf('function renderChecklist('));
  assert.match(helper, /await MarkdownRenderer\.render\(plugin\.app,/);
  assert.match(helper, /component\.load\(\)/);
  assert.match(helper, /finally\s*\{\s*component\.unload\(\)/);
  assert.doesNotMatch(helper, /innerHTML|insertAdjacentHTML|requestUrl|fetch\(/);
  const css = fs.readFileSync(path.join(path.dirname(T.__mainPath), 'styles.css'), 'utf8');
  for (const selector of ['.iplan-routine-steps .iplan-checklist-row', '.iplan-routine-steps .iplan-checklist-label']) {
    const rule = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
    assert.match(rule, /cursor:\s*default/);
    assert.doesNotMatch(rule, /cursor:\s*pointer/);
  }
  const checkRule = css.slice(css.indexOf('.iplan-routine-steps .iplan-routine-step-check {')).split('}')[0];
  assert.match(checkRule, /cursor:\s*pointer/);
  assert.match(checkRule, /font:\s*inherit/);
  assert.match(checkRule, /height:\s*1lh;/);
  assert.match(checkRule, /align-items:\s*center/);
  assert.match(checkRule, /margin:\s*0;/);
  assert.match(checkRule, /padding:\s*0 var\(--size-2-1\);/);
  const rowRule = css.slice(css.indexOf('.iplan-routine-steps .iplan-checklist-row {')).split('}')[0];
  assert.match(rowRule, /align-items:\s*flex-start/);
  const labelRule = css.slice(css.indexOf('.iplan-routine-steps .iplan-checklist-label {')).split('}')[0];
  assert.match(labelRule, /margin:\s*0;/);
  assert.match(labelRule, /padding:\s*0;/);
  assert.match(labelRule, /line-height:\s*inherit/);
  assert.match(labelRule, /white-space:\s*pre-line/);
  const inlineRule = css.slice(css.indexOf('.iplan-routine-steps .iplan-checklist-label :is(')).split('}')[0];
  assert.match(inlineRule, /:is\(p, a, strong, em, b, i, code, s, del, span\)/);
  assert.match(inlineRule, /display:\s*inline/);
  assert.match(inlineRule, /margin-block:\s*0;/);
  assert.match(inlineRule, /padding-block:\s*0;/);
  assert.match(inlineRule, /line-height:\s*inherit/);
  const coarseRule = css.slice(css.indexOf('@media (any-pointer: coarse) {', css.indexOf(checkRule))).split('}')[0];
  assert.match(coarseRule, /min-width:\s*44px/);
  assert.doesNotMatch(coarseRule, /min-height|padding|align-items/);
  assert.match(css, /\.iplan-routine-steps input\.iplan-check:checked\s*\{[^}]*background:\s*var\(--iplan-success\)/);
  assert.match(css, /\.iplan-routine-step-check:hover input\.iplan-check:not\(:disabled\)/);
  assert.match(css, /\.iplan-routine-steps :is\(input\.iplan-check, a\[href\]\):focus-visible/);
  const linkRule = css.slice(css.indexOf('.iplan-routine-steps .iplan-checklist-label a[href] {')).split('}')[0];
  assert.match(linkRule, /cursor:\s*pointer/);
  assert.match(linkRule, /color:\s*var\(--link-color\)/);
  assert.match(linkRule, /text-decoration:\s*underline/);
});

test('SIMULATED: board routines start collapsed and the button paints both toggle states', () => {
  const { renderRoutineCard, PlannerBoardView } = routineCardFixture();
  const view = new PlannerBoardView(null, {});
  const occ = T.routineOccurrence(routine(), '2026-09-07', '13:00');
  const card = renderRoutineCard({}, occ, view);
  const toggle = card.children[0].children[0];
  const steps = card.children[2];
  const key = JSON.stringify([occ.routine.path, occ.day]);
  assert.equal(toggle.tagName, 'button');
  assert.equal(toggle.type, 'button');
  assert.equal(steps.checklist.model.rows.length, 3);
  for (const open of [false, true, false]) {
    if (open || view.routineExpanded.has(key)) {
      const event = toggle.fire('click');
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.stopped, true);
    }
    assert.equal(steps.hidden, !open);
    assert.equal(toggle.attributes['aria-expanded'], String(open));
    assert.equal(toggle.children[0].icon, open ? 'chevron-down' : 'chevron-right');
    assert.equal(toggle.children[0].attributes['aria-hidden'], 'true');
    const label = `${open ? 'Hide' : 'Show'} steps of Morning launch on 2026-09-07`;
    assert.equal(toggle.attributes['aria-label'], label);
    assert.equal(toggle.title, label);
    assert.equal(view.routineExpanded.has(key), open);
  }
  assert.equal(toggle.fire('pointerdown').stopped, true);
});

test('SIMULATED: expansion belongs to one routine occurrence, not another date or routine', () => {
  const { renderRoutineCard, PlannerBoardView } = routineCardFixture();
  const view = new PlannerBoardView(null, {});
  const first = T.routineOccurrence(routine(), '2026-09-07', '13:00');
  renderRoutineCard({}, first, view).children[0].children[0].fire('click');
  const otherDay = T.routineOccurrence(routine(), '2026-09-08', '13:00');
  const otherRoutine = T.routineOccurrence(routine({ name: 'Other routine' }, null, '02 Planner/Routines/Other.md'), first.day, '13:00');
  for (const occ of [first, otherDay, otherRoutine]) {
    assert.equal(renderRoutineCard({}, occ, view).children[2].hidden, occ !== first);
  }
  const freshView = new PlannerBoardView(null, {});
  assert.equal(renderRoutineCard({}, first, freshView).children[2].hidden, true);
  assert.equal(view.routineExpanded.size, 1);
});

test('SIMULATED: mode changes and step callbacks retain expansion; a card without a view has no collapse control', async () => {
  const { renderRoutineCard, PlannerBoardView } = routineCardFixture();
  let body = BODY;
  let card;
  const calls = [];
  const day = '2026-09-07';
  const plugin = {
    toggleRoutineStep(routinePath, occurrenceDay, index, next, total) {
      calls.push([routinePath, occurrenceDay, index, next, total]);
      body = T.routineLogAfterStep(body, occurrenceDay, index, next, total);
      view.render();
    },
  };
  const view = new PlannerBoardView(null, plugin);
  view.render = () => { card = renderRoutineCard(plugin, T.routineOccurrence(routine({}, body), day, '13:00'), view); };
  view.render();
  card.children[0].children[0].fire('click');
  const expanded = view.routineExpanded;
  for (const mode of ['day', 'week']) {
    view.setMode(mode);
    assert.equal(view.mode, mode);
    assert.equal(view.routineExpanded, expanded);
    assert.equal(card.children[2].hidden, false);
    assert.equal(card.children[0].children[0].attributes['aria-expanded'], 'true');
    await card.children[2].checklist.options.onToggle('1', mode === 'day');
    assert.equal(card.children[2].checklist.model.rows[0].checked, mode === 'day');
    assert.equal(card.children[2].hidden, false);
    assert.equal(card.children[0].children[0].children[0].icon, 'chevron-down');
  }
  assert.deepEqual(calls, [
    ['02 Planner/Routines/Morning launch.md', day, 1, true, 3],
    ['02 Planner/Routines/Morning launch.md', day, 1, false, 3],
  ]);
  card.children[0].children[0].fire('click');
  const agenda = renderRoutineCard(plugin, T.routineOccurrence(routine({}, body), day, '13:00'), null);
  assert.equal(agenda.hidden, false);
  assert.equal(agenda.children.length, 2);
  assert.equal(agenda.querySelector('.iplan-card-title').textContent, 'Morning launch');
  assert.equal(agenda.children[0].children[0].tagName, 'span');
  assert.equal(agenda.querySelector('.iplan-card-sub-toggle'), null);
  assert.equal(view.routineExpanded.size, 0);
});

test('SIMULATED: every calendar bar and title opens details without calendar chevrons or steps', () => {
  const { renderRoutineCard, PlannerBoardView, openedModals, element } = routineCardFixture();
  const plugin = { app: {}, manifest: { id: 'mahdyar-planner' } };
  const view = new PlannerBoardView(null, plugin);
  view.contentEl = element('div');
  view.render = () => {};
  for (const end of ['09:15', '10:00']) {
    const occ = T.routineOccurrence(routine({ start: '09:00', end }), '2026-09-07', '13:00');
    const key = JSON.stringify([occ.routine.path, occ.day]);
    view.routineExpanded.add(key);
    const card = renderRoutineCard(plugin, occ, view, true);
    const title = card.querySelector('.iplan-routine-detail-button');
    assert.equal(title.textContent, occ.routine.name);
    assert.equal(card.querySelector('.iplan-card-sub-toggle'), null);
    assert.equal(card.querySelector('.iplan-card-sub-chevron'), null);
    assert.equal(card.children.length, end === '09:15' ? 1 : 2);
    assert.equal(card.attributes.role, 'button');
    assert.equal(card.attributes.tabindex, '0');
    assert.equal(card.attributes['aria-haspopup'], 'dialog');
    for (const [opener, eventName, values] of [
      [title, 'click', {}], [card, 'click', {}],
      [card, 'keydown', { key: 'Enter' }], [card, 'keydown', { key: ' ' }],
    ]) {
      const count = openedModals.length;
      const event = opener.fire(eventName, values);
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.stopped, true);
      assert.equal(openedModals.length, count + 1);
      assert.equal(openedModals.at(-1).occ, occ);
      assert.equal(openedModals.at(-1).opener, opener);
      openedModals.at(-1).close();
    }
    const count = openedModals.length;
    assert.equal(card.fire('keydown', { key: 'Escape' }).defaultPrevented, false);
    assert.equal(card.fire('keydown', { key: 'Enter', target: title }).defaultPrevented, false);
    assert.equal(card.fire('click', { defaultPrevented: true }).stopped, false);
    assert.equal(openedModals.length, count);
    assert.equal(view.routineExpanded.has(key), true);
  }
});

test('SIMULATED: only short timed routines are compact and their full name and time remain accessible', () => {
  const { renderRoutineCard, PlannerBoardView } = routineCardFixture();
  const view = new PlannerBoardView(null, {});
  for (const [end, compact] of [['09:15', true], ['09:30', true], ['10:00', false]]) {
    const occ = T.routineOccurrence(routine({ start: '09:00', end }), '2026-09-07', '13:00');
    const card = renderRoutineCard({}, occ, view, true);
    const title = card.querySelector('.iplan-routine-detail-button');
    assert.equal(card.className.split(' ').includes('is-compact'), compact);
    if (!compact) {
      assert.equal(card.children[0].children[0].textContent, T.routineKicker(occ));
      assert.equal(card.children[0].children[1].textContent, T.routineTimeLabel(occ));
      assert.equal(card.children[1].tagName, 'button');
      assert.equal(card.children[1].textContent, occ.routine.name);
    }
    assert.equal(title.tagName, 'button');
    assert.equal(title.type, 'button');
    assert.equal(title.attributes['aria-haspopup'], 'dialog');
    assert.equal(title.attributes['aria-label'], `Morning launch, 2026-09-07, 09:00 - ${end}`);
    assert.equal(title.title, card.title);
    assert.equal(title.fire('pointerdown').stopped, true);
    assert.equal(renderRoutineCard({}, occ, view).className.split(' ').includes('is-compact'), false);
  }
});

test('SIMULATED: details reopen expanded independently, keep step callbacks and restore title or bar focus', async () => {
  const { renderRoutineCard, PlannerBoardView, openedModals, element } = routineCardFixture();
  const calls = [];
  const plugin = { app: {}, manifest: { id: 'mahdyar-planner' },
    toggleRoutineStep: (...args) => calls.push(args) };
  const view = new PlannerBoardView(null, plugin);
  const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:15' }), '2026-09-07', '13:00');
  view.contentEl = element('div');
  view.render = () => {
    view.contentEl.empty();
    view.contentEl.appendChild(renderRoutineCard(plugin, occ, view, true));
  };
  const key = JSON.stringify([occ.routine.path, occ.day]);
  for (const listOpen of [false, true]) {
    if (listOpen) view.routineExpanded.add(key);
    else view.routineExpanded.delete(key);
    for (const selector of ['.iplan-routine-detail-button', '.iplan-time-routine']) {
      view.render();
      for (let opening = 0; opening < 2; opening += 1) {
        view.contentEl.querySelector(selector).fire('click');
        const modal = openedModals.at(-1);
        assert.equal(modal.contentEl.attributes['data-ink-plugin'], 'mahdyar-planner');
        assert.equal(modal.contentEl.children.length, 4);
        const controls = modal.contentEl.querySelector('.iplan-planned-time-controls');
        assert.ok(controls.querySelector(`input[aria-label="Planned start for ${occ.routine.name} on ${occ.day}"]`));
        assert.ok(controls.querySelector('button[aria-label="Set planned start"]'));
        assert.ok(controls.querySelector('button[aria-label="Reset planned time"]'));
        assert.equal(modal.contentEl.querySelector('button[aria-label="Close routine details"]'), null);
        assert.equal(modal.contentEl.children[1].textContent, '2026-09-07, 09:00 - 09:15');
        assert.equal(modal.contentEl.querySelector('.iplan-event-modal-title').textContent, occ.routine.name);
        assert.equal(modal.contentEl.querySelector('.iplan-card-title'), null);
        const card = modal.contentEl.querySelector(`.iplan-routine[data-routine="${occ.routine.path}"]`);
        const toggle = card.children[0].children[0];
        const steps = card.children[1];
        assert.equal(card.children[0].children[1].textContent, T.routineKicker(occ));
        assert.equal(card.children[0].children[2].textContent, T.routineTimeLabel(occ));
        assert.equal(steps.hidden, false);
        assert.equal(toggle.attributes['aria-expanded'], 'true');
        assert.equal(toggle.focused, true);
        await steps.checklist.options.onToggle('1', true);
        assert.deepEqual(calls.at(-1), [occ.routine.path, occ.day, 1, true, occ.total]);
        steps.checklist.options.onProgress(3, 3);
        assert.ok(card.className.split(' ').includes('is-done'));
        toggle.fire('click');
        assert.equal(steps.hidden, true);
        assert.equal(toggle.attributes['aria-expanded'], 'false');
        assert.equal(view.routineExpanded.has(key), listOpen);
        assert.equal(renderRoutineCard(plugin, occ, view).children[2].hidden, !listOpen);
        modal.close();
        assert.equal(view.contentEl.querySelector(selector).focused, true);
        assert.equal(view.contentEl.querySelector('.iplan-card-sub-toggle'), null);
      }
    }
  }
});

test('SIMULATED: overflow dialogs retain each routine name even with only one remaining occurrence', () => {
  const { RoutineDetailModal, element } = routineCardFixture();
  const plugin = { app: {}, manifest: { id: 'mahdyar-planner' } };
  const day = '2026-09-07';
  const occurrences = ['Daily planning', 'Other routine'].map((name, index) =>
    T.routineOccurrence(routine({ name }, null, `Routine ${index}.md`), day, '13:00'));
  for (const count of [1, 2]) {
    const opener = element('button');
    opener.className = 'iplan-routine-label-overflow';
    const modal = new RoutineDetailModal(plugin, occurrences.slice(0, count), null, opener);
    modal.open();
    assert.equal(modal.contentEl.querySelector('.iplan-event-modal-title').textContent, `More routines on ${day}`);
    for (const occurrence of occurrences.slice(0, count)) {
      const card = modal.contentEl.querySelector(`.iplan-routine[data-routine="${occurrence.routine.path}"]`);
      assert.equal(card.querySelector('.iplan-card-title').textContent, occurrence.routine.name);
      assert.equal(card.querySelector('.iplan-card-sub-toggle').attributes['aria-expanded'], 'true');
      assert.equal(card.children.find((child) => child.checklist).hidden, false);
    }
  }
});

test('SIMULATED: Outside is permanent with no prototype state or selector', () => {
  const { PlannerBoardView } = routineCardFixture();
  const settings = { ...T.DEFAULT_SETTINGS };
  const view = new PlannerBoardView(null, { settings });
  assert.equal(Object.hasOwn(view, 'routineLabelMode'), false);
  assert.equal(view.setRoutineLabelMode, undefined);
  assert.equal(view.renderRoutineLabelControl, undefined);
  assert.equal(Object.hasOwn(view.getState(), 'routineLabelMode'), false);
  assert.deepEqual(settings, T.DEFAULT_SETTINGS);
});

test('SIMULATED: configured workday markers share WEEK and DAY geometry, axis labels and rerendered settings', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  const settings = { ...T.DEFAULT_SETTINGS, lunchEnabled: true };
  const view = new PlannerBoardView(null, { settings });
  view.wireEvent = () => {};
  const events = [{ uid: 'busy', day, half: 'am', start: `${day}T08:00:00`, end: `${day}T18:00:00`, title: 'Busy' }];
  const occ = T.routineOccurrence(routine({ start: '08:15', end: '08:30' }), day, '13:00');
  let geometry;
  for (const mode of ['week', 'day']) {
    view.mode = mode;
    for (const [dayStart, dayEnd, startMin, endMin] of [
      ['08:00', '18:00', 480, 1080], ['08:15', '17:45', 495, 1065],
      ['00:00', '23:59', 0, 1439],
    ]) {
      Object.assign(settings, { dayStart, dayEnd });
      const col = element('div');
      view.renderTimedGrid(day, col, [], events, [occ]);
      const grid = view.timedGrids.get(day);
      const axis = grid.canvas.querySelector('.iplan-time-axis');
      const labels = axis.children.filter((child) => child.classList.contains('iplan-workday-label'));
      const lines = grid.slots.children.filter((child) => child.classList.contains('iplan-workday-line'));
      assert.equal(axis.attributes['aria-hidden'], undefined);
      assert.equal(labels.length, 2);
      assert.equal(lines.length, 2);
      for (const [index, minute] of [startMin, endMin].entries()) {
        const kind = index === 0 ? 'start' : 'end';
        const time = index === 0 ? dayStart : dayEnd;
        assert.deepEqual(Array.from(labels[index].children, (child) => child.textContent), [time]);
        const title = grid.workdayLabels[index].titleElement;
        assert.equal(title.parentElement, grid.labelGutter);
        assert.equal(title.textContent, `Workday ${kind}`);
        assert.equal(title.attributes.role, 'slider');
        assert.equal(title.attributes['aria-valuenow'], String(minute));
        assert.equal(grid.slots.querySelector('.iplan-workday-title'), null);
        assert.equal(labels[index].attributes['aria-label'], `Planned workday ${kind} on ${day}`);
        assert.equal(labels[index].attributes.role, 'slider');
        assert.equal(labels[index].attributes['aria-valuenow'], String(minute));
        assert.equal(lines[index].style.top, `${minute * PLANNER_PIXELS_PER_MINUTE}px`);
        assert.equal(parseFloat(labels[index].style.top) + parseFloat(labels[index].style['--iplan-workday-anchor']),
          minute * PLANNER_PIXELS_PER_MINUTE);
      }
      for (const hour of axis.children.filter((child) => !child.classList.contains('iplan-workday-label'))) {
        const top = parseFloat(hour.style.top);
        const overlaps = labels.some((label) => top + 12 >= parseFloat(label.style.top)
          && top - 12 <= parseFloat(label.style.top) + 24);
        assert.equal(hour.hidden, overlaps);
      }
      const current = grid.entries.map((entry) => [entry.element.style.top, entry.element.style.height,
        entry.element.style.left, entry.element.style.width]);
      if (!geometry) geometry = current;
      assert.deepEqual(current, geometry);
      assert.equal(grid.start, 0);
      assert.equal(grid.end, 1440);
      assert.equal(grid.canvas.style.height, `${1440 * PLANNER_PIXELS_PER_MINUTE}px`);
      for (const width of [150, 190, 220]) {
        grid.canvas.measuredRect = { left: 0, width };
        grid.labelGutter.measuredRect = { left: width * 0.58, width: width * 0.42 };
        view.relayoutTimedGrid(day);
        assert.deepEqual(grid.entries.map((entry) => [entry.element.style.top, entry.element.style.height,
          entry.element.style.left, entry.element.style.width]), geometry);
        assert.equal(lines[0].style.top, `${startMin * PLANNER_PIXELS_PER_MINUTE}px`);
        assert.equal(lines[1].style.top, `${endMin * PLANNER_PIXELS_PER_MINUTE}px`);
        assert.equal(grid.labelGutter.querySelector('.iplan-workday-label'), null);
      }
      assert.equal(col.querySelector('.iplan-lunch'), null);
    }
  }
});

test('SIMULATED: measured clock and title centers match the painted line after resize without moving time anchors', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  for (const mode of ['week', 'day']) {
    const view = new PlannerBoardView(null, { settings: T.DEFAULT_SETTINGS });
    view.mode = mode;
    view.timeScrollPositions.set(day, 321);
    view.renderTimedGrid(day, element('div'), [], [], []);
    const grid = view.timedGrids.get(day);
    grid.slots.clientTop = 1;
    for (const [clockHeight, titleHeight, width] of [[10.8, 24, 150], [18, 32, 220], [36, 48, 190]]) {
      grid.canvas.measuredRect = { left: 0, width };
      grid.labelGutter.measuredRect = { left: width * 0.58, width: width * 0.42 };
      for (const marker of grid.workdayLabels) {
        marker.element.measuredHeight = clockHeight;
        marker.titleElement.measuredHeight = titleHeight;
      }
      for (const relayout of [() => view.relayoutTimedGrid(day), () => view.onResize()]) {
        relayout();
        for (const [index, marker] of grid.workdayLabels.entries()) {
          const line = marker.lineElement.getBoundingClientRect();
          const paintedCenter = line.top + grid.slots.clientTop + line.height / 2;
          assert.equal(marker.anchor, (index === 0 ? 480 : 1080) * PLANNER_PIXELS_PER_MINUTE);
          assert.equal(line.top, marker.anchor);
          assert.equal(paintedCenter, marker.anchor + 2);
          for (const label of [marker.element, marker.titleElement]) {
            const rect = label.getBoundingClientRect();
            assert.ok(Math.abs(rect.top + rect.height / 2 - paintedCenter) < 0.000001);
            assert.ok(parseFloat(label.style['--iplan-workday-leader-height']) < 0.000001);
            assert.equal(rect.top + parseFloat(label.style['--iplan-workday-anchor']) + line.height / 2, paintedCenter);
          }
        }
        assert.equal(grid.scroll.scrollTop, 321);
      }
    }
  }
});

test('SIMULATED: edge clamping keeps both boxes visible and connectors point to the unchanged blue line', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  const view = new PlannerBoardView(null, { settings: { ...T.DEFAULT_SETTINGS,
    _dailyPlanOverrides: { [day]: { workday: { start: 0, end: 1440 } } } } });
  view.renderTimedGrid(day, element('div'), [], [], []);
  const grid = view.timedGrids.get(day);
  grid.slots.clientTop = 1;
  for (const measuredHeight of [24, 48]) {
    for (const marker of grid.workdayLabels) {
      marker.element.measuredHeight = measuredHeight;
      marker.titleElement.measuredHeight = measuredHeight;
    }
    view.onResize();
    for (const marker of grid.workdayLabels) {
      for (const label of [marker.element, marker.titleElement]) {
        const rect = label.getBoundingClientRect();
        const center = marker.anchor + 2 - rect.top;
        assert.ok(rect.top >= 0 && rect.top + rect.height <= 1440 * PLANNER_PIXELS_PER_MINUTE);
        assert.equal(parseFloat(label.style['--iplan-workday-leader-top']), Math.min(center, rect.height / 2));
        assert.equal(parseFloat(label.style['--iplan-workday-leader-height']), Math.abs(center - rect.height / 2));
        assert.equal(rect.top + parseFloat(label.style['--iplan-workday-anchor']) + 1, marker.anchor + 2);
      }
      assert.equal(parseFloat(marker.lineElement.style.top), marker.anchor);
    }
  }
});

test('SIMULATED: workday clocks stay HH:mm regardless of generic display format without changing geometry', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const settings = { ...T.DEFAULT_SETTINGS, dayStart: '08:15', dayEnd: '17:45', timeFormat: 'h:mm A' };
  const view = new PlannerBoardView(null, { settings });
  T.setDisplayFormatSource(() => T.resolveDisplayFormats(settings, {}));
  try {
    for (const format of ['h:mm A', 'HH:mm']) {
      settings.timeFormat = format;
      const axis = element('div');
      const slots = element('div');
      view.renderTimedWorkdayMarkers('2026-09-07', axis, slots, { start: 0, end: 1440 });
      assert.deepEqual(axis.children.map((label) => label.textContent), ['08:15', '17:45']);
      assert.deepEqual(slots.children.map((line) => line.style.top),
        [`${495 * PLANNER_PIXELS_PER_MINUTE}px`, `${1065 * PLANNER_PIXELS_PER_MINUTE}px`]);
    }
  } finally {
    T.setDisplayFormatSource(null);
  }
});

test('SIMULATED: workday titles reserve the shared gutter without routines and follow live defaults, overrides and reset', async () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  const plugin = dailyPlanPlugin([]);
  const view = new PlannerBoardView(null, plugin);
  for (const mode of ['week', 'day']) {
    view.mode = mode;
    for (const [start, end] of [[480, 1080], [495, 1065], [0, 1440]]) {
      await plugin.setDailyPlannedTime(day, null, { start, end });
      view.renderTimedGrid(day, element('div'), [], [], []);
      const grid = view.timedGrids.get(day);
      assert.ok(grid.labelGutter);
      assert.equal(grid.canvas.classList.contains('has-outside-routine-labels'), true);
      assert.equal(grid.labelOverflow, null);
      assert.equal(grid.labelGutter.children.length, 2);
      for (const [index, minute] of [start, end].entries()) {
        const marker = grid.workdayLabels[index];
        const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        assert.equal(marker.element.textContent, clock);
        assert.equal(marker.titleElement.textContent, index === 0 ? 'Workday start' : 'Workday end');
        assert.equal(marker.anchor, minute * PLANNER_PIXELS_PER_MINUTE);
        assert.equal(grid.slots.children[index].style.top, `${marker.anchor}px`);
      }
      assert.deepEqual(T.workdayFor('2026-09-08', plugin.settings), { start: 480, end: 1080 });
    }
    await plugin.setDailyPlannedTime(day, null, null);
    Object.assign(plugin.settings, { dayStart: '09:00', dayEnd: '19:00' });
    view.renderTimedGrid(day, element('div'), [], [], []);
    assert.deepEqual(Array.from(view.timedGrids.get(day).workdayLabels, (marker) => marker.element.textContent), ['09:00', '19:00']);
    Object.assign(plugin.settings, { dayStart: '08:00', dayEnd: '18:00' });
  }
});

test('SIMULATED: close boundary titles and routine labels never overlap in the shared gutter at narrow widths or day edges', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  for (const mode of ['week', 'day']) {
    for (const start of [0, 495, 1439]) {
      const settings = { ...T.DEFAULT_SETTINGS, _dailyPlanOverrides: { [day]: { workday: { start, end: start + 1 } } } };
      const view = new PlannerBoardView(null, { settings });
      view.mode = mode;
      const occurrence = { ...T.routineOccurrence(routine(), day, '13:00'), startMin: start, endMin: start + 1 };
      view.renderTimedGrid(day, element('div'), [], [], [occurrence]);
      const grid = view.timedGrids.get(day);
      const entry = grid.entries[0];
      for (const width of [150, 190, 220]) {
        grid.canvas.measuredRect = { left: 0, width };
        grid.labelGutter.measuredRect = { left: width * 0.58, width: width * 0.42 };
        view.relayoutTimedGrid(day);
        const [first, second] = grid.workdayLabels;
        assert.ok(first.titleTop >= 0);
        assert.ok(first.titleBottom <= second.titleTop);
        assert.ok(second.titleBottom <= 1440 * PLANNER_PIXELS_PER_MINUTE);
        assert.equal(entry.labelElement.hidden, false);
        const top = parseFloat(entry.labelElement.style.top);
        const bottom = top + entry.labelElement.getBoundingClientRect().height;
        assert.ok(top >= 0 && bottom <= 1440 * PLANNER_PIXELS_PER_MINUTE);
        for (const marker of grid.workdayLabels) {
          assert.equal(marker.titleElement.parentElement, entry.labelElement.parentElement);
          assert.ok(bottom <= marker.titleTop || top >= marker.titleBottom);
          assert.equal(marker.titleTop + parseFloat(marker.titleElement.style['--iplan-workday-anchor']), marker.anchor);
        }
        assert.equal(grid.slots.children[0].style.top, `${start * PLANNER_PIXELS_PER_MINUTE}px`);
        assert.equal(grid.slots.children[1].style.top, `${(start + 1) * PLANNER_PIXELS_PER_MINUTE}px`);
        assert.equal(entry.element.style.top, `${start * PLANNER_PIXELS_PER_MINUTE}px`);
        assert.equal(entry.element.style.height, `${PLANNER_PIXELS_PER_MINUTE}px`);
        assert.equal(entry.labelLeader.style.top, `${(start + 0.5) * PLANNER_PIXELS_PER_MINUTE}px`);
      }
    }
  }
});

test('SIMULATED: gutter titles share clock drag, cancellation, keyboard values and focus without changing capacity during preview', async () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE, documentListeners } = routineCardFixture();
  const day = '2026-09-07';
  const plugin = dailyPlanPlugin([]);
  const view = new PlannerBoardView(null, plugin);
  view.timeScrollPositions.set(day, 321);
  view.renderTimedGrid(day, element('div'), [], [], []);
  const grid = view.timedGrids.get(day);
  const [start, end] = grid.workdayLabels;
  const pointer = { pointerId: 8, button: 0, clientY: 123 };
  start.titleElement.fire('pointerdown', pointer);
  grid.scroll.scrollTop += 15 * PLANNER_PIXELS_PER_MINUTE;
  start.element.fire('pointermove', { ...pointer, clientY: 123 + 15 * PLANNER_PIXELS_PER_MINUTE });
  assert.equal(start.element.textContent, '08:30');
  assert.equal(start.titleElement.attributes['aria-valuenow'], '510');
  assert.equal(start.element.attributes['aria-valuenow'], '510');
  assert.equal(T.dailyPlannedTime(day, plugin.settings, [], [], []).dayMin, 600);
  documentListeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(start.element.textContent, '08:00');
  assert.equal(start.titleElement.attributes['aria-valuenow'], '480');
  assert.deepEqual(plugin.settings._dailyPlanOverrides, {});
  start.titleElement.fire('pointerdown', pointer);
  start.element.fire('pointerup', { ...pointer, clientY: 123 + 15 * PLANNER_PIXELS_PER_MINUTE });
  await plugin._settingsSaveQueue;
  assert.deepEqual(T.workdayFor(day, plugin.settings), { start: 495, end: 1080 });
  assert.equal(view.pendingPlanFocus, `workday-title:${day}:start`);
  end.titleElement.fire('keydown', { key: 'ArrowUp' });
  await plugin._settingsSaveQueue;
  assert.equal(end.element.textContent, '17:45');
  assert.equal(end.titleElement.attributes['aria-valuenow'], '1065');
  assert.equal(view.pendingPlanFocus, `workday-title:${day}:end`);
  end.titleElement.fire('keydown', { key: 'End' });
  await plugin._settingsSaveQueue;
  assert.equal(end.element.textContent, '24:00');
  assert.equal(end.titleElement.attributes['aria-valuenow'], '1440');
  for (const [key, expected] of [['Home', 0], ['End', 1065]]) {
    start.titleElement.fire('keydown', { key });
    await plugin._settingsSaveQueue;
    assert.equal(start.titleElement.attributes['aria-valuenow'], String(expected));
    assert.equal(start.element.attributes['aria-valuenow'], String(expected));
  }
  assert.equal(grid.scroll.scrollTop, 321 + 15 * PLANNER_PIXELS_PER_MINUTE);
});

test('SIMULATED: first visible scroll waits for title measurement and saved scroll still wins', () => {
  const { PlannerBoardView, element } = routineCardFixture(undefined, { ignoreHiddenScrollAssignments: true });
  const day = '2026-09-07';
  const view = new PlannerBoardView(null, { settings: { ...T.DEFAULT_SETTINGS, dayStart: '23:58', dayEnd: '23:59' } });
  const col = element('div');
  col.hidden = true;
  view.renderTimedGrid(day, col, [], [], []);
  const grid = view.timedGrids.get(day);
  col.hidden = false;
  for (const marker of grid.workdayLabels) marker.titleElement.measuredHeight = 0;
  view.onResize();
  assert.equal(grid.initialScrollPending, true);
  for (const marker of grid.workdayLabels) marker.titleElement.measuredHeight = 48;
  view.onResize();
  assert.equal(grid.initialScrollPending, false);
  const first = grid.workdayLabels[0];
  assert.equal(grid.scroll.scrollTop, Math.min(first.top, first.titleTop));
  for (const marker of grid.workdayLabels) {
    assert.ok(marker.titleTop >= grid.scroll.scrollTop);
    assert.ok(marker.titleBottom <= grid.scroll.scrollTop + 96);
  }
  grid.scroll.scrollTop = 0;
  grid.scroll.fire('scroll');
  view.renderTimedGrid(day, element('div'), [], [], []);
  view.onResize();
  assert.equal(view.timedGrids.get(day).scroll.scrollTop, 0);
});

test('SIMULATED: close workday labels stay separated inside day edges while time anchors stay exact', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const height = 1440 * PLANNER_PIXELS_PER_MINUTE;
  for (const [dayStart, dayEnd] of [['00:00', '00:01'], ['08:15', '08:16'], ['23:58', '23:59']]) {
    for (const labelHeight of [36, 72]) {
      const view = new PlannerBoardView(null, { settings: { dayStart, dayEnd } });
      const axis = element('div');
      const createEl = axis.createEl;
      axis.createEl = (tag, options) => {
        const label = createEl(tag, options);
        label.measuredHeight = labelHeight;
        return label;
      };
      const slots = element('div');
      const labels = view.renderTimedWorkdayMarkers('2026-09-07', axis, slots, { start: 0, end: 1440 });
      assert.equal(labels.length, 2);
      assert.ok(labels[0].top >= 0);
      assert.ok(labels[0].bottom <= labels[1].top);
      assert.ok(labels[1].bottom <= height);
      for (const [index, time] of [dayStart, dayEnd].entries()) {
        const anchor = T.hmToMin(time) * PLANNER_PIXELS_PER_MINUTE;
        assert.equal(parseFloat(slots.children[index].style.top), anchor);
        assert.equal(labels[index].top + parseFloat(labels[index].element.style['--iplan-workday-anchor']), anchor);
      }
      const fixture = routineCardFixture(undefined, { workdayLabelHeight: labelHeight });
      const viewportView = new fixture.PlannerBoardView(null, { settings: { dayStart, dayEnd } });
      const day = '2026-09-07';
      viewportView.renderTimedGrid(day, fixture.element('div'), [], [], []);
      const grid = viewportView.timedGrids.get(day);
      grid.scroll.clientHeight = labelHeight * 2;
      assert.ok(grid.scroll.scrollTop <= grid.workdayLabels[0].top);
      for (const label of grid.workdayLabels) {
        assert.ok(label.top >= grid.scroll.scrollTop);
        assert.ok(label.bottom <= grid.scroll.scrollTop + grid.scroll.clientHeight);
      }
      assert.equal(grid.initialScrollPending, false);
      for (const saved of [0, 321]) {
        grid.scroll.scrollTop = saved;
        grid.scroll.fire('scroll');
        viewportView.renderTimedGrid(day, fixture.element('div'), [], [], []);
        const rerendered = viewportView.timedGrids.get(day);
        assert.equal(rerendered.scroll.scrollTop, saved);
        viewportView.onResize();
        assert.equal(rerendered.scroll.scrollTop, saved);
        assert.equal(viewportView.timeScrollPositions.get(day), saved);
      }
    }
  }
  for (const dayEnd of ['08:00', '07:00']) {
    const view = new PlannerBoardView(null, { settings: { dayStart: '08:00', dayEnd } });
    assert.equal(view.renderTimedWorkdayMarkers('2026-09-07', element('div'), element('div'),
      { start: 0, end: 1440 }).length, 0);
  }
});

test('SIMULATED: visible relayout remeasures workday and hourly labels without duplicating nodes or moving geometry and user scroll', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  for (const mode of ['week', 'day']) {
    const view = new PlannerBoardView(null, { settings: { ...T.DEFAULT_SETTINGS, dayStart: '08:15', dayEnd: '08:16' } });
    view.mode = mode;
    view.wireEvent = () => {};
    const col = element('div');
    col.hidden = true;
    const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:15' }), day, '13:00');
    const events = [{ uid: 'busy', day, half: 'am', start: `${day}T09:00:00`, end: `${day}T10:00:00`, title: 'Busy' }];
    view.renderTimedGrid(day, col, [], events, [occ]);
    const grid = view.timedGrids.get(day);
    const axis = grid.canvas.querySelector('.iplan-time-axis');
    const axisNodes = [...axis.children];
    const slotNodes = [...grid.slots.children];
    const geometry = grid.entries.map((entry) => ({ ...entry.element.style }));
    const canvasHeight = grid.canvas.style.height;
    const slotsHeight = grid.slots.style.height;
    assert.equal(grid.initialScrollPending, true);
    assert.ok(grid.workdayLabels.every((label) => label.height === 0));
    for (const label of grid.workdayLabels) label.element.measuredHeight = 72;
    view.onResize();
    assert.equal(grid.initialScrollPending, true);
    col.hidden = false;
    view.onResize();
    assert.equal(grid.initialScrollPending, false);
    assert.equal(grid.scroll.scrollTop, grid.workdayLabels[0].top);
    assert.ok(grid.workdayLabels[1].bottom <= grid.scroll.scrollTop + 144);
    const hourEight = grid.hourLabels.find((hour) => hour.top === 480 * PLANNER_PIXELS_PER_MINUTE);
    const suppression = [];
    for (const [labelHeight, hourHeight, width, saved] of [
      [120 * PLANNER_PIXELS_PER_MINUTE, 30 * PLANNER_PIXELS_PER_MINUTE, 150, 0],
      [2 * PLANNER_PIXELS_PER_MINUTE, 2 * PLANNER_PIXELS_PER_MINUTE, 220, 321],
      [60 * PLANNER_PIXELS_PER_MINUTE, 12 * PLANNER_PIXELS_PER_MINUTE, 190, 0],
    ]) {
      grid.scroll.scrollTop = saved;
      grid.scroll.fire('scroll');
      for (const label of grid.workdayLabels) label.element.measuredHeight = labelHeight;
      for (const hour of grid.hourLabels) hour.element.measuredHeight = hourHeight;
      grid.canvas.measuredRect = { left: 0, width };
      grid.labelGutter.measuredRect = { left: width * 0.58, width: width * 0.42 };
      for (const relayout of [() => view.relayoutTimedGrid(day), () => view.onResize()]) {
        relayout();
        const [start, end] = grid.workdayLabels;
        assert.equal(start.height, labelHeight);
        assert.equal(end.height, labelHeight);
        assert.ok(start.bottom <= end.top);
        for (const [index, label] of grid.workdayLabels.entries()) {
          const anchor = (index === 0 ? 495 : 496) * PLANNER_PIXELS_PER_MINUTE;
          assert.equal(label.top + parseFloat(label.element.style['--iplan-workday-anchor']), anchor);
          assert.equal(slotNodes[index].style.top, `${anchor}px`);
        }
        for (const hour of grid.hourLabels) {
          const overlaps = grid.workdayLabels.some((label) => hour.top + hourHeight / 2 >= label.top
            && hour.top - hourHeight / 2 <= label.bottom);
          assert.equal(hour.element.hidden, overlaps);
        }
        assert.deepEqual(axis.children, axisNodes);
        assert.deepEqual(grid.slots.children, slotNodes);
        assert.deepEqual(grid.entries.map((entry) => ({ ...entry.element.style })), geometry);
        assert.equal(grid.canvas.style.height, canvasHeight);
        assert.equal(grid.slots.style.height, slotsHeight);
        assert.equal(grid.scroll.scrollTop, saved);
        assert.equal(view.timeScrollPositions.get(day), saved);
      }
      suppression.push(hourEight.element.hidden);
    }
    assert.deepEqual(suppression, [true, false, true]);
  }
});

test('SIMULATED: hidden panes defer saved scroll restoration, including zero, until visible relayout', () => {
  const { PlannerBoardView, element } = routineCardFixture(undefined, { ignoreHiddenScrollAssignments: true });
  const day = '2026-09-07';
  for (const mode of ['week', 'day']) {
    for (const saved of [321, 0]) {
      const view = new PlannerBoardView(null, { settings: T.DEFAULT_SETTINGS });
      view.mode = mode;
      view.timeScrollPositions.set(day, saved);
      const col = element('div');
      col.hidden = true;
      view.renderTimedGrid(day, col, [], [], []);
      const grid = view.timedGrids.get(day);
      grid.scroll.scrollTop = 999;
      assert.equal(grid.scroll.scrollTop, 0);
      assert.equal(grid.initialScrollPending, false);
      assert.equal(grid.pendingSavedScrollTop, saved);
      grid.scroll.fire('scroll');
      view.onResize();
      assert.equal(grid.pendingSavedScrollTop, saved);
      assert.equal(view.timeScrollPositions.get(day), saved);
      col.hidden = false;
      grid.scroll.fire('scroll');
      assert.equal(grid.pendingSavedScrollTop, saved);
      grid.scroll.measuredHeight = 0;
      view.onResize();
      assert.equal(grid.pendingSavedScrollTop, saved);
      grid.scroll.measuredHeight = 144;
      view.onResize();
      assert.equal(grid.scroll.scrollTop, saved);
      assert.equal(grid.pendingSavedScrollTop, null);
      grid.scroll.fire('scroll');
      view.onResize();
      assert.equal(grid.scroll.scrollTop, saved);
      assert.equal(view.timeScrollPositions.get(day), saved);
    }
  }
});

test('SIMULATED: meaningful user scroll supersedes pending saved or fresh initial scroll', () => {
  const { PlannerBoardView, element } = routineCardFixture(undefined, { ignoreHiddenScrollAssignments: true });
  const day = '2026-09-07';
  for (const saved of [undefined, 0, 321]) {
    const view = new PlannerBoardView(null, { settings: T.DEFAULT_SETTINGS });
    if (saved !== undefined) view.timeScrollPositions.set(day, saved);
    const col = element('div');
    col.hidden = true;
    view.renderTimedGrid(day, col, [], [], []);
    const grid = view.timedGrids.get(day);
    grid.scroll.fire('scroll');
    assert.equal(grid.initialScrollPending, saved === undefined);
    col.hidden = false;
    grid.scroll.fire('scroll');
    assert.equal(grid.initialScrollPending, saved === undefined);
    grid.scroll.scrollTop = 123;
    grid.scroll.fire('scroll');
    assert.equal(grid.pendingSavedScrollTop, null);
    assert.equal(grid.initialScrollPending, false);
    view.onResize();
    assert.equal(grid.scroll.scrollTop, 123);
    assert.equal(view.timeScrollPositions.get(day), 123);
    grid.scroll.scrollTop = 0;
    grid.scroll.fire('scroll');
    view.onResize();
    assert.equal(grid.scroll.scrollTop, 0);
    assert.equal(view.timeScrollPositions.get(day), 0);
    view.renderTimedGrid(day, element('div'), [], [], []);
    assert.equal(view.timedGrids.get(day).scroll.scrollTop, 0);
  }
});

test('SOURCE: workday clocks and gutter titles use theme blue and solid pointer-transparent lines', () => {
  const css = fs.readFileSync(path.join(path.dirname(T.__mainPath), 'styles.css'), 'utf8');
  const labelRule = css.match(/\.iplan-workday-label\s*\{([^}]+)\}/)[1];
  assert.match(labelRule, /width:\s*38px/);
  assert.match(labelRule, /transform:\s*none/);
  assert.match(labelRule, /color:\s*var\(--color-blue\)/);
  assert.match(labelRule, /background:\s*var\(--iplan-surface\)/);
  assert.match(labelRule, /overflow-wrap:\s*normal/);
  assert.match(css, /button\.iplan-workday-label\s*\{[^}]*white-space:\s*nowrap/);
  const clockRule = css.match(/button\.iplan-workday-label\s*\{([^}]+)\}/)[1];
  assert.match(clockRule, /appearance:\s*none/);
  assert.match(clockRule, /padding:\s*0/);
  assert.match(clockRule, /border:\s*0/);
  assert.match(clockRule, /min-height:\s*0/);
  for (const rule of [clockRule, css.match(/button\.iplan-workday-title\s*\{([^}]+)\}/)[1]]) {
    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /align-items:\s*center/);
    assert.doesNotMatch(rule, /transform:\s*translateY/);
  }
  assert.match(css, /button\.iplan-workday-title::after\s*\{[^}]*height:\s*var\(--iplan-workday-leader-height\)/);
  const lineRule = css.match(/\.iplan-workday-line\s*\{([^}]+)\}/)[1];
  assert.match(lineRule, /border-top:\s*2px solid var\(--color-blue\)/);
  assert.match(lineRule, /z-index:\s*4/);
  assert.match(lineRule, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /\.iplan-workday[^{}]*\{[^}]*dashed/);
  assert.match(css, /button\.iplan-workday-title\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /button\.iplan-workday-title\s*\{[^}]*color:\s*var\(--color-blue\)/);
  assert.match(css, /button\.iplan-workday-title\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.iplan-time-canvas\.has-outside-routine-labels\s*\{[^}]*min-width:\s*calc\(/);
  assert.match(css, /\.iplan-time-label\[hidden\]\s*\{\s*display:\s*none !important/);
  assert.match(css, /\.iplan-time-slots\s*\{[^}]*inset:\s*0 0 0 42px/);
  assert.match(css, /\.has-outside-routine-labels \.iplan-time-slots\s*\{\s*right:\s*var\(--iplan-routine-gutter\)/);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const board = main.slice(main.indexOf('class PlannerBoardView extends ItemView'), main.indexOf('const TRAY_TABS'));
  assert.ok(board.includes('this.renderTimedWorkdayMarkers(day, axis, slots, bounds, scroll, labelGutter)'));
  assert.ok(board.includes('const hasGutter = outside || workday.end > workday.start;'));
  assert.ok(board.includes('const bounds = timedGridBounds(0, 1440, entries)'));
  assert.match(board, /if \(isCalendar\)\s*\{[^}]*this\.renderTimedGrid\(day, col, items, events, routines\)/);
  const markers = board.slice(board.indexOf('  renderTimedWorkdayMarkers('), board.indexOf('  relayoutTimedGrid('));
  assert.match(markers, /workdayFor\(day, this\.plugin\.settings\)/);
  assert.match(markers, /plannedStartText\(/);
  assert.doesNotMatch(markers, /fmtTimeHM\(/);
  assert.doesNotMatch(markers, /lunch|splitTime|countdown|saveSettings|assignTimedItem/);
});

test('SOURCE: timed routines alone have a solid vivid green left border inside their unchanged border box', () => {
  const css = fs.readFileSync(path.join(path.dirname(T.__mainPath), 'styles.css'), 'utf8');
  const rule = css.match(/\.iplan-root \.iplan-card\.iplan-time-routine\s*\{([^}]*border-left[^}]+)\}/)[1];
  assert.match(rule, /border-left:\s*2px solid var\(--color-green, var\(--iplan-success\)\)/);
  assert.match(rule, /box-sizing:\s*border-box/);
  assert.doesNotMatch(rule, /(?:^|;)\s*(?:background|height|width|margin|padding|box-shadow)\s*:/);
  const accentRules = css.match(/[^{}]+\{[^{}]*border-left:\s*2px solid var\(--color-green, var\(--iplan-success\)\)[^{}]*\}/g);
  assert.equal(accentRules.length, 1);
  assert.match(accentRules[0], /^\s*\.iplan-root \.iplan-card\.iplan-time-routine\s*\{/);
  assert.match(css, /\.iplan-card\.iplan-routine\s*\{[^}]*border-left:\s*2px solid var\(--iplan-hairline\)/);
  assert.match(css, /\.iplan-root \.iplan-time-routine:focus-visible,[\s\S]*?outline:\s*1px solid var\(--iplan-marker\)/);
});

test('SIMULATED: permanent Outside keeps exact routine geometry, event slots and daily totals in WEEK and DAY', () => {
  const fixture = routineCardFixture();
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = fixture;
  const day = '2026-09-07';
  const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:15' }), day, '13:00');
  const events = [{ uid: 'meeting', day, half: 'am', start: `${day}T09:00:00`, end: `${day}T09:30:00`, title: 'Meeting' }];
  const plugin = { settings: T.DEFAULT_SETTINGS, app: {}, manifest: { id: 'mahdyar-planner' } };
  const totals = T.dailyPlannedTime(day, plugin.settings, events, [], [occ]);
  let baseline;
  for (const range of ['week', 'day']) {
    const view = new PlannerBoardView(null, plugin);
    view.mode = range;
    view.wireEvent = () => {};
    view.renderTimedGrid(day, element('div'), [], events, [occ]);
    const grid = view.timedGrids.get(day);
    const geometry = grid.entries.map((entry) => [entry.start, entry.end, entry.duration,
      entry.element.style.top, entry.element.style.height, entry.element.style.left, entry.element.style.width]);
    if (!baseline) baseline = geometry;
    assert.deepEqual(geometry, baseline);
    const entry = grid.entries.find((candidate) => candidate.kind === 'routine');
    assert.equal(entry.element.style.height, `${15 * PLANNER_PIXELS_PER_MINUTE}px`);
    assert.equal(entry.element.style.top, `${(540 - grid.start) * PLANNER_PIXELS_PER_MINUTE}px`);
    assert.ok(entry.labelElement);
    assert.equal(entry.labelElement.tagName, 'button');
    assert.equal(entry.labelElement.attributes.type, 'button');
    assert.equal(entry.labelElement.attributes['aria-label'], entry.element.title);
    assert.equal(entry.labelElement.attributes['aria-haspopup'], 'dialog');
    entry.labelElement.fire('click');
    assert.equal(fixture.openedModals.at(-1).occ, occ);
    assert.deepEqual(T.dailyPlannedTime(day, plugin.settings, events, [], [occ]), totals);
  }
});

test('SIMULATED: outside labels bound lanes on resize and connect real block edges to clamped labels', () => {
  const { PlannerBoardView, element, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  const view = new PlannerBoardView(null, { settings: T.DEFAULT_SETTINGS });
  const entries = [0, 0, 0, 1439].map((start, index) => ({
    key: `routine:${index}`, kind: 'routine', start, end: start + 1, duration: 1,
    element: element('div'), labelElement: element('button'), labelLeader: element('div'),
  }));
  for (const [index, entry] of entries.entries()) {
    entry.element.style.height = `${PLANNER_PIXELS_PER_MINUTE}px`;
    entry.element.measuredRect = { right: 80 + index * 20 };
    entry.labelElement.measuredHeight = 44;
    for (const name of ['line', 'bend', 'line']) entry.labelLeader.createDiv({ cls: `iplan-routine-label-${name}` });
  }
  const grid = { start: 0, end: 1440, entries, slots: element('div'), canvas: element('div'),
    labelGutter: element('div'), labelOverflow: element('button') };
  grid.labelGutter.measuredRect = { left: 300, width: 240 };
  view.timedGrids.set(day, grid);
  for (const [width, hiddenCount] of [[240, 1], [112, 2], [80, 2], [360, 0]]) {
    grid.labelGutter.measuredRect.width = width;
    view.onResize();
    assert.equal(grid.hiddenRoutineEntries.length, hiddenCount);
    assert.equal(entries[0].labelElement.hidden, false, `${width}px gutter keeps its first name`);
    assert.equal(entries[3].labelElement.hidden, false, `${width}px gutter keeps a noncolliding name`);
    assert.equal(grid.labelOverflow.hidden, hiddenCount === 0);
    assert.match(grid.labelOverflow.attributes['aria-label'], /show full list and details/);
    for (const entry of entries) {
      assert.equal(entry.element.style.top, `${entry.start * PLANNER_PIXELS_PER_MINUTE}px`);
      assert.equal(entry.element.style.height, `${PLANNER_PIXELS_PER_MINUTE}px`);
      assert.equal(entry.labelLeader.hidden, entry.labelElement.hidden);
      if (entry.labelElement.hidden) continue;
      const labelTop = parseFloat(entry.labelElement.style.top);
      assert.ok(labelTop >= 0);
      assert.ok(labelTop + 44 <= 1440 * PLANNER_PIXELS_PER_MINUTE);
      assert.ok(parseFloat(entry.labelElement.style.width) >= Math.min(width, 112));
      assert.ok(parseFloat(entry.labelElement.style.left) + parseFloat(entry.labelElement.style.width) <= width);
      const anchor = (entry.start + 0.5) * PLANNER_PIXELS_PER_MINUTE;
      assert.equal(entry.labelLeader.style.top, `${anchor}px`);
      assert.equal(parseFloat(entry.labelLeader.style.left), entry.element.measuredRect.right);
      const [line, vertical, tail] = entry.labelLeader.children;
      const offset = labelTop + 22 - anchor;
      assert.equal(parseFloat(vertical.style.height), Math.abs(offset));
      assert.equal(parseFloat(vertical.style.top), Math.min(0, offset));
      assert.equal(parseFloat(tail.style.top) + anchor, labelTop + 22);
      assert.equal(parseFloat(entry.labelLeader.style.left) + parseFloat(tail.style.left) + parseFloat(tail.style.width),
        300 + parseFloat(entry.labelElement.style.left));
      assert.equal(line.style.width, vertical.style.left);
    }
    const visible = entries.filter((entry) => !entry.labelElement.hidden);
    for (const [index, first] of visible.entries()) {
      for (const second of visible.slice(index + 1)) {
        assert.ok(first.labelElement.style.left !== second.labelElement.style.left
          || Math.abs(parseFloat(first.labelElement.style.top) - parseFloat(second.labelElement.style.top)) >= 44);
      }
    }
  }
});

test('SIMULATED: normal WEEK widths keep a first external name lane and overflow only collisions', () => {
  const { PlannerBoardView, element, openedModals, PLANNER_PIXELS_PER_MINUTE } = routineCardFixture();
  const day = '2026-09-07';
  const plugin = { settings: T.DEFAULT_SETTINGS, app: {}, manifest: { id: 'mahdyar-planner' } };
  const view = new PlannerBoardView(null, plugin);
  view.mode = 'week';
  const occurrences = [540, 540, 660].map((start, index) => T.routineOccurrence(
    routine({ name: `Ordinary routine with a long name ${index}`,
      start: `${String(Math.floor(start / 60)).padStart(2, '0')}:00`,
      end: `${String(Math.floor(start / 60)).padStart(2, '0')}:15` }, null, `Routine ${index}.md`), day, '13:00'));
  view.renderTimedGrid(day, element('div'), [], [], occurrences);
  const grid = view.timedGrids.get(day);
  const geometry = grid.entries.map((entry) => ({ ...entry.element.style }));
  for (const canvasWidth of [150, 190, 220]) {
    const gutterWidth = canvasWidth * 0.42;
    grid.canvas.measuredRect = { left: 0, width: canvasWidth };
    grid.labelGutter.measuredRect = { left: canvasWidth - gutterWidth, width: gutterWidth };
    for (const entry of grid.entries) entry.element.measuredRect = { right: canvasWidth - gutterWidth - 4 };
    view.relayoutTimedGrid(day);
    assert.equal(grid.hiddenRoutineEntries.length, 1, `${canvasWidth}px WEEK canvas`);
    assert.equal(grid.labelOverflow.textContent, '1 more routine');
    assert.equal(grid.labelOverflow.hidden, false);
    for (const index of [0, 2]) {
      const entry = grid.entries[index];
      assert.equal(entry.labelElement.hidden, false);
      assert.equal(entry.labelLeader.hidden, false);
      assert.equal(entry.labelElement.textContent, occurrences[index].routine.name);
      assert.equal(entry.labelElement.attributes['aria-label'], entry.element.title);
      assert.equal(parseFloat(entry.labelElement.style.width), gutterWidth);
      const [, , tail] = entry.labelLeader.children;
      assert.equal(parseFloat(entry.labelLeader.style.left) + parseFloat(tail.style.left) + parseFloat(tail.style.width),
        grid.labelGutter.measuredRect.left);
      assert.equal(entry.element.style.top, `${entry.start * PLANNER_PIXELS_PER_MINUTE}px`);
    }
    assert.equal(grid.entries[1].labelElement.hidden, true);
    assert.deepEqual(grid.entries.map((entry) => ({ ...entry.element.style })), geometry);
  }
  grid.entries[0].labelElement.fire('click');
  assert.equal(openedModals.at(-1).occ, occurrences[0]);
  grid.entries = [grid.entries[0]];
  view.relayoutTimedGrid(day);
  assert.equal(grid.entries[0].labelElement.hidden, false);
  assert.equal(grid.labelOverflow.hidden, true);
  assert.equal(grid.hiddenRoutineEntries.length, 0);
});

test('SIMULATED: unusably narrow gutters fall back inline without overflow or geometry changes and recover on resize', () => {
  const { PlannerBoardView, element, openedModals } = routineCardFixture();
  const day = '2026-09-07';
  const plugin = { settings: T.DEFAULT_SETTINGS, app: {}, manifest: { id: 'mahdyar-planner' } };
  const view = new PlannerBoardView(null, plugin);
  const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:15' }), day, '13:00');
  view.renderTimedGrid(day, element('div'), [], [], [occ]);
  const grid = view.timedGrids.get(day);
  const entry = grid.entries[0];
  const geometry = { ...entry.element.style };
  for (const width of [16, 0, 80]) {
    grid.labelGutter.measuredRect = { left: 100, width };
    view.relayoutTimedGrid(day);
    const fallback = width < 40;
    assert.equal(entry.element.className.split(' ').includes('is-inline-label-fallback'), fallback);
    assert.equal(entry.element.className.split(' ').includes('has-outside-label'), !fallback);
    assert.equal(entry.labelElement.hidden, fallback);
    assert.equal(entry.labelLeader.hidden, fallback);
    assert.equal(grid.hiddenRoutineEntries.length, 0);
    assert.equal(grid.labelOverflow.hidden, true);
    assert.deepEqual({ ...entry.element.style }, geometry);
    if (fallback) {
      const detail = entry.element.querySelector('.iplan-routine-detail-button');
      assert.equal(detail.attributes['aria-label'], entry.element.title);
      detail.fire('click');
      assert.equal(openedModals.at(-1).occ, occ);
    }
  }
});

test('SIMULATED: detail focus follows Outside-to-inline fallback and restoration in WEEK and DAY', () => {
  for (const mode of ['week', 'day']) {
    const { PlannerBoardView, renderRoutineCard, element, openedModals } = routineCardFixture();
    const day = '2026-09-07';
    const plugin = { settings: T.DEFAULT_SETTINGS, app: {}, manifest: { id: 'mahdyar-planner' } };
    const view = new PlannerBoardView(null, plugin);
    view.mode = mode;
    view.contentEl = element('div');
    const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:15' }), day, '13:00');
    const otherDay = T.routineOccurrence(routine({ start: '09:00', end: '09:15' }), '2026-09-08', '13:00');
    let width = 80;
    let entry;
    let inline;
    let decoy;
    let renders = 0;
    view.render = () => {
      renders += 1;
      view.contentEl.empty();
      decoy = renderRoutineCard(plugin, otherDay, view, true);
      view.contentEl.appendChild(decoy);
      view.renderTimedGrid(day, view.contentEl, [], [], [occ]);
      const grid = view.timedGrids.get(day);
      grid.labelGutter.measuredRect = { left: 100, width };
      view.relayoutTimedGrid(day);
      entry = grid.entries[0];
      inline = entry.element.querySelector('.iplan-routine-detail-button');
      inline.computedStyle = { display: width < 40 ? 'block' : 'none' };
    };
    view.render();
    entry.labelElement.fire('click');
    const outsideModal = openedModals.at(-1);
    width = 16;
    view.timedGrids.get(day).labelGutter.measuredRect.width = width;
    view.onResize();
    assert.equal(entry.labelElement.hidden, true);
    outsideModal.close();
    assert.equal(renders, 2);
    assert.equal(inline.focused, true);
    assert.equal(entry.labelElement.focused, undefined);
    assert.equal(decoy.focused, undefined);
    assert.equal(decoy.querySelector('.iplan-routine-detail-button').focused, undefined);
    inline.fire('click');
    const inlineModal = openedModals.at(-1);
    width = 80;
    view.timedGrids.get(day).labelGutter.measuredRect.width = width;
    view.onResize();
    inlineModal.close();
    assert.equal(renders, 3);
    assert.equal(inline.hidden, false);
    assert.equal(inline.getClientRects().length, 0);
    assert.equal(inline.focused, undefined);
    assert.equal(entry.labelElement.hidden, false);
    assert.equal(entry.labelElement.focused, true);
    assert.equal(entry.element.focused, undefined);
  }
});

test('SIMULATED: detail focus rejects CSS-hidden, inaccessible and disabled openers and ancestors', () => {
  for (const state of ['css-display', 'css-visibility', 'css-ancestor', 'hidden-ancestor',
    'inert-ancestor', 'aria-hidden-ancestor', 'aria-disabled', 'disabled', 'bar-only', 'none']) {
    const { PlannerBoardView, renderRoutineCard, RoutineDetailModal, element } = routineCardFixture();
    const plugin = { app: {}, manifest: { id: 'mahdyar-planner' } };
    const view = new PlannerBoardView(null, plugin);
    view.contentEl = element('div');
    const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:15' }), '2026-09-07', '13:00');
    const opener = element('button');
    opener.className = 'iplan-routine-outside-label';
    let outside;
    let inline;
    let bar;
    view.render = () => {
      view.contentEl.empty();
      const gutter = view.contentEl.createDiv();
      outside = gutter.createEl('button', { cls: 'iplan-routine-outside-label',
        attr: { 'data-routine-detail': JSON.stringify([occ.routine.path, occ.day]) } });
      bar = view.contentEl.appendChild(renderRoutineCard(plugin, occ, view, true));
      inline = bar.querySelector('.iplan-routine-detail-button');
      if (state === 'css-visibility') outside.computedStyle = { visibility: 'hidden' };
      else if (state === 'css-ancestor') gutter.computedStyle = { display: 'none' };
      else if (state === 'hidden-ancestor') gutter.hidden = true;
      else if (state === 'inert-ancestor') gutter.inert = true;
      else if (state === 'aria-hidden-ancestor') gutter.setAttribute('aria-hidden', 'true');
      else if (state === 'aria-disabled') outside.setAttribute('aria-disabled', 'true');
      else if (state === 'disabled') outside.disabled = true;
      else outside.computedStyle = { display: 'none' };
      if (state === 'bar-only') inline.disabled = true;
      if (state === 'none') bar.setAttribute('aria-hidden', 'true');
    };
    const modal = new RoutineDetailModal(plugin, occ, view, opener);
    modal.open();
    modal.close();
    assert.equal(outside.hidden, false, state);
    assert.equal(outside.focused, undefined, state);
    assert.equal(inline.focused, state === 'bar-only' || state === 'none' ? undefined : true, state);
    assert.equal(bar.focused, state === 'bar-only' ? true : undefined, state);
  }
});

test('SIMULATED: overflow opens every hidden routine with details and restores overflow focus', () => {
  const { PlannerBoardView, element, openedModals } = routineCardFixture();
  const day = '2026-09-07';
  const plugin = { settings: T.DEFAULT_SETTINGS, app: {}, manifest: { id: 'mahdyar-planner' } };
  const view = new PlannerBoardView(null, plugin);
  const occurrences = Array.from({ length: 5 }, (_, index) => T.routineOccurrence(
    routine({ name: `Routine ${index}`, start: '09:00', end: '09:15' }, null, `Routine ${index}.md`), day, '13:00'));
  view.contentEl = element('div');
  view.render = () => {
    view.contentEl.empty();
    view.renderTimedGrid(day, view.contentEl, [], [], occurrences);
  };
  view.render();
  const grid = view.timedGrids.get(day);
  assert.equal(grid.hiddenRoutineEntries.length, 3);
  assert.equal(grid.labelOverflow.textContent, '3 more routines');
  grid.labelOverflow.fire('click');
  const modal = openedModals.at(-1);
  assert.deepEqual(Array.from(modal.occurrences), Array.from(grid.hiddenRoutineEntries, (entry) => entry.occ));
  assert.match(modal.contentEl.children[0].textContent, /More routines on 2026-09-07/);
  for (const occurrence of modal.occurrences) {
    const card = modal.contentEl.querySelector(`.iplan-routine[data-routine="${occurrence.routine.path}"]`);
    assert.equal(card.querySelector('.iplan-card-title').textContent, occurrence.routine.name);
    const steps = card.children.find((child) => child.checklist);
    const toggle = card.querySelector('.iplan-card-sub-toggle');
    assert.equal(steps.checklist.model.rows.length, 3);
    assert.equal(steps.hidden, false);
    assert.equal(toggle.attributes['aria-expanded'], 'true');
    assert.equal(toggle.focused, occurrence === modal.occurrences[0] ? true : undefined);
    const input = modal.contentEl.querySelector(`input[aria-label="Planned start for ${occurrence.routine.name} on ${occurrence.day}"]`);
    assert.ok(input);
    assert.ok(input.parentElement.querySelector('button[aria-label="Set planned start"]'));
    assert.ok(input.parentElement.querySelector('button[aria-label="Reset planned time"]'));
    toggle.fire('click');
    assert.equal(steps.hidden, true);
    assert.equal(toggle.attributes['aria-expanded'], 'false');
  }
  assert.equal(view.routineExpanded.size, 0);
  assert.equal(modal.contentEl.querySelector('button[aria-label="Close routine details"]'), null);
  modal.close();
  assert.equal(view.contentEl.querySelector('.iplan-routine-label-overflow').focused, true);
  view.contentEl.querySelector('.iplan-routine-label-overflow').fire('click');
  const reopened = openedModals.at(-1);
  for (const occurrence of reopened.occurrences) {
    const card = reopened.contentEl.querySelector(`.iplan-routine[data-routine="${occurrence.routine.path}"]`);
    assert.equal(card.children.find((child) => child.checklist).hidden, false);
    assert.equal(card.querySelector('.iplan-card-sub-toggle').attributes['aria-expanded'], 'true');
  }
  reopened.close();
});

test('SIMULATED: detail close never renders or focuses a closed, detached or replaced originating view', async () => {
  for (const state of ['closed', 'detached', 'replaced']) {
    const { PlannerBoardView, RoutineDetailModal, element } = routineCardFixture();
    const plugin = { app: {}, manifest: { id: 'mahdyar-planner' } };
    const view = new PlannerBoardView(null, plugin);
    const occ = T.routineOccurrence(routine(), '2026-09-07', '13:00');
    const opener = element('button');
    view.contentEl = element('div');
    let renders = 0;
    view.render = () => { renders += 1; };
    const modal = new RoutineDetailModal(plugin, occ, view, opener);
    modal.open();
    assert.equal(view.routineDetailModal, modal);
    if (state === 'closed') {
      await view.onClose();
      assert.equal(view.routineDetailModal, null);
      assert.equal(modal.contentEl.children.length, 0);
    }
    if (state === 'detached') view.contentEl.isConnected = false;
    if (state === 'replaced') view.leaf.view = {};
    modal.close();
    assert.equal(renders, 0, state);
    assert.equal(opener.focused, undefined, state);
    assert.equal(view.routineDetailModal, null, state);
    assert.equal(modal.contentEl.children.length, 0, state);
    if (state === 'closed') {
      const grid = { entries: [] };
      view.timedGrids.set('closed', grid);
      view.onResize();
      assert.equal(grid.hiddenRoutineEntries, undefined);
    }
  }
});

test('SIMULATED: long routine headers, time and skipped status stay inline with permanent Outside short labels', () => {
  const { PlannerBoardView, element } = routineCardFixture();
  const day = '2026-09-07';
  const plugin = { settings: T.DEFAULT_SETTINGS };
  const long = { ...T.routineOccurrence(routine({ start: '09:00', end: '10:00' }), day, '13:00'), skipped: true };
  const short = T.routineOccurrence(routine({ start: '11:00', end: '11:30' }), day, '13:00');
  for (const range of ['week', 'day']) {
    const view = new PlannerBoardView(null, plugin);
    view.mode = range;
    view.renderTimedGrid(day, element('div'), [], [], [long, short]);
    const entry = view.timedGrids.get(day).entries[0];
    assert.equal(entry.labelElement, undefined);
    assert.equal(entry.element.children[0].children[0].textContent, T.routineKicker(long));
    assert.equal(entry.element.children[0].children[1].textContent, '09:00 - 10:00');
    assert.equal(entry.element.children[0].children[2].textContent, 'SKIPPED');
    assert.equal(entry.element.children[1].textContent, long.routine.name);
    assert.equal(entry.element.children[1].tagName, 'button');
    assert.equal(entry.element.querySelector('.iplan-card-sub-toggle'), null);
    assert.ok(view.timedGrids.get(day).entries[1].labelElement);
  }
});

test('SOURCE: compact and outside styling preserve duration and keep labels out of event space', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const css = fs.readFileSync(path.join(path.dirname(T.__mainPath), 'styles.css'), 'utf8');
  assert.doesNotMatch(main, /routineLabelMode|renderRoutineLabelControl|setRoutineLabelMode|Routine label prototype/);
  assert.doesNotMatch(css, /iplan-routine-label-control/);
  assert.doesNotMatch(main.slice(main.indexOf('class RoutineDetailModal'), main.indexOf('function showRoutineMenu(')), /Close routine details|setIcon\(close, 'x'\)/);
  assert.match(css, /\.iplan-root \.iplan-time-routine\.is-compact\s*\{\s*padding: 0 2px;\s*gap: 0;/);
  assert.match(css, /\.iplan-root \.iplan-time-routine:focus-visible,/);
  assert.match(css, /\.has-outside-routine-labels \.iplan-time-slots\s*\{ right: var\(--iplan-routine-gutter\); \}/);
  assert.match(css, /\.iplan-routine-label-gutter\s*\{[^}]*overflow: hidden/);
  assert.match(css, /\.iplan-root button\.iplan-routine-outside-label\s*\{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.iplan-root button\.iplan-routine-outside-label\s*\{[^}]*box-sizing: border-box;[^}]*min-width: 0/);
  assert.match(css, /\.iplan-routine-label-leader\s*\{[^}]*pointer-events: none/);
  assert.match(css, /\.iplan-routine-label-line,[\s\S]*?\.iplan-routine-label-bend\s*\{[^}]*pointer-events: none/);
  assert.match(css, /\.iplan-routine-label-overflow\[hidden\]\s*\{ display: none !important/);
  const blockRules = [...css.matchAll(/[^{}]*\.iplan-time-routine[^{}]*\{([^}]+)\}/g)];
  for (const rule of blockRules) assert.doesNotMatch(rule[1], /min-height:\s*(?!0)[\d.]+(?:px|em|rem)/);
});
test('SOURCE: the AGENDA tray view owns routineExpanded and passes itself to the routine card', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const start = main.indexOf('class PlannerTrayView extends ItemView');
  const ctor = main.slice(start, main.indexOf('getViewType()', start));
  assert.ok(/this\.routineExpanded = new Set\(\);/.test(ctor), 'tray constructor initialises routineExpanded');
  const agenda = main.slice(main.indexOf('  renderAgenda(el, items, today) {'), main.indexOf('  renderGoals(el, items) {'));
  assert.ok(/renderRoutineCard\(this\.plugin, entry\.occ, this\)/.test(agenda), 'agenda passes the tray view');
});
test('SOURCE: the card is not draggable, the drop line counts it as a position, sync never pushes for it', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const card = main.slice(main.indexOf('function renderRoutineCard('), main.indexOf('function showRoutineMenu('));
  assert.ok(/card\.draggable = false;/.test(card), 'card must match /card\.draggable = false;/');
  assert.ok(!/dragstart/.test(card), 'no drag handler on a routine card');
  assert.ok(/renderChecklist\(steps, model/.test(card), 'the steps container receives the shared checklist');
  const board = main.slice(main.indexOf('class PlannerBoardView extends ItemView'), main.indexOf('const TRAY_TABS'));
  assert.ok(/const isDay = this\.mode === 'day';/.test(board), 'week and day share the board render method');
  assert.ok(/const visibleDays = isDay\s*\? \[this\.day\]\s*: weekDays\(this\.weekStart\)/.test(board), 'mode selects the days, not a different routine renderer');
  assert.ok(/renderRoutineCard\(this\.plugin, entry\.occ, this\)/.test(board), 'both modes pass the same board expansion state');
  // the drop-line selector treats a routine block as a position, ghost or not
  assert.ok(/querySelectorAll\('\.iplan-event, \.iplan-card\.iplan-routine, \.iplan-card:not\(\.is-dragging\):not\(\.is-ghost\)'\)/.test(main), 'main must match /querySelectorAll\(\'\.iplan-event, \.iplan-card\.iplan-routine, \.iplan-card:not\(\.is-dragging\):not\(\.is-ghost\)\'\)/');
  // the push check is never scheduled for a routine note. The guard gained a
  // second clause in 0.14.0 (a week note is not a planner item either), so the
  // assertion reads the routine half of it rather than the whole line.
  assert.ok(/inside\(file\) && !this\.paths\(\)\.isRoutine\(file\.path\)/.test(main),
    'the push check must still be guarded by isRoutine');
  assert.ok(/this\.schedulePushCheck\(file\.path\);/.test(main), 'the push check is still scheduled');
  // every log write runs inside vault.process
  assert.ok(/await this\.app\.vault\.process\(file, fn\);/.test(main), 'main must match /await this\.app\.vault\.process\(file, fn\);/');
  for (const name of ['toggleRoutineStep', 'skipRoutine', 'unskipRoutine', 'resetRoutineDay']) {
    assert.ok(new RegExp(`${name}\\([^)]*\\) \\{\\s*return this\\.processRoutine\\(`).test(main), `${name} goes through processRoutine`);
  }
  // the menu offers exactly the four actions
  const menu = main.slice(main.indexOf('function showRoutineMenu('), main.indexOf('function wireDropLane('));
  for (const title of ['Skip today', 'Unskip today', 'Reset today', 'Open routine note']) {
    assert.ok(menu.includes(`setTitle('${title}')`), `menu carries ${title}`);
  }
  // the command exists
  assert.ok(/addCommand\(\{ id: 'new-routine', name: 'New routine'/.test(main), 'main must match /addCommand\(\{ id: \'new-routine\', name: \'New routine\'/');
});

test('SOURCE: rows are buttons with role=checkbox, disabled rows keep their tab stop', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const block = main.slice(main.indexOf('function renderChecklist('), main.indexOf('const LOG_DATE_RE'));
  assert.ok(/document\.createElement\('button'\)/.test(block), 'block must match /document\.createElement\(\'button\'\)/');
  assert.ok(/row\.setAttribute\('role', 'checkbox'\)/.test(block), 'block must match /row\.setAttribute\(\'role\', \'checkbox\'\)/');
  assert.ok(/'aria-checked'/.test(block), 'block must match /\'aria-checked\'/');
  assert.ok(/row\.setAttribute\('aria-disabled', 'true'\)/.test(block), 'block must match /row\.setAttribute\(\'aria-disabled\', \'true\'\)/');
  assert.ok(!/row\.disabled = true/.test(block), 'aria-disabled, not the disabled attribute: the row stays reachable');
  assert.ok(/check\.className = 'iplan-check'/.test(block), 'the check control is the task card\'s');
  assert.ok(/new Notice\(`Planner: could not save the check/.test(block), 'a failed write says so once');
});
