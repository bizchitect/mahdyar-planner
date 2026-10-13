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
  assert.ok(board.includes('const seg = segmentInfo(this.plugin.settings, mins);'));
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

function routineCardFixture() {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const renderer = main.slice(main.indexOf('function renderRoutineCard('), main.indexOf('function showRoutineMenu('));
  const board = main.slice(main.indexOf('class PlannerBoardView extends ItemView'), main.indexOf('const TRAY_TABS'));
  const scale = main.match(/const PLANNER_PIXELS_PER_MINUTE\s*=[^;]+;/)[0];
  const openedModals = [];
  const computedStyle = (node) => ({ paddingLeft: '8px', paddingRight: '8px', fontSize: '12px',
    display: node.style.display || 'block', visibility: node.style.visibility || 'visible',
    ...node.computedStyle });
  const element = (tagName) => {
    const node = { tagName, children: [], attributes: {}, listeners: {}, className: '', hidden: false, dataset: {}, style: {}, isConnected: true };
    node.classList = {
      add: (...names) => { for (const name of names) if (!node.className.split(' ').includes(name)) node.className += ` ${name}`; },
      toggle: (name, enabled) => {
        node.className = node.className.split(' ').filter((value) => value !== name).join(' ');
        if (enabled) node.classList.add(name);
      },
    };
    node.setAttribute = (name, value) => { node.attributes[name] = value; };
    node.getAttribute = (name) => node.attributes[name];
    node.appendChild = (child) => { child.parentElement = node; node.children.push(child); return child; };
    node.insertBefore = (child, before) => { child.parentElement = node; node.children.splice(node.children.indexOf(before), 0, child); };
    node.matches = (selector) => selector === ':disabled' && !!node.disabled;
    node.getClientRects = () => {
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (!ancestor.isConnected || ancestor.hidden || computedStyle(ancestor).display === 'none') return [];
      }
      return [{}];
    };
    node.addClass = (...names) => node.classList.add(...names);
    node.style.setProperty = (name, value) => { node.style[name] = value; };
    node.focus = () => { node.focused = true; };
    node.empty = () => { node.children = []; };
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
      const attributeMatch = /\[([\w-]+)="(.*)"\]/.exec(selector);
      for (const child of node.children) {
        if ((!classMatch || child.className.split(' ').includes(classMatch[1]))
          && (!attributeMatch || child.attributes[attributeMatch[1]] === attributeMatch[2])) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    };
    node.getBoundingClientRect = () => ({
      left: node.className.includes('iplan-routine-label-gutter') ? 300 : 0,
      right: 100, width: 240,
      height: node.measuredHeight || parseFloat(node.style.height) || 24,
      ...node.measuredRect,
    });
    node.addEventListener = (name, listener) => { node.listeners[name] = listener; };
    node.fire = (name, values = {}) => {
      const event = {
        defaultPrevented: false, stopped: false, target: node, ...values,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
      };
      node.listeners[name](event);
      return event;
    };
    return node;
  };
  return vm.runInNewContext(`${scale}\n${renderer}\n${board}\n({ renderRoutineCard, PlannerBoardView, RoutineDetailModal, element, openedModals, PLANNER_PIXELS_PER_MINUTE })`, {
    Set, Map, ItemView: class {
      constructor(leaf) { this.leaf = leaf || {}; this.leaf.view = this; }
    }, element, openedModals, document: { createElement: element },
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
    plannedStartText: (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
    wireTimedDrop: () => {},
    routineCardState: T.routineCardState, routineKicker: T.routineKicker,
    routineTimeLabel: T.routineTimeLabel, checklistModel: T.checklistModel,
    setIcon: (node, icon) => { node.icon = icon; },
    renderChecklist: (parent, model, options) => { parent.checklist = { model, options }; },
    wireLongPress: () => {},
  });
}

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
        assert.equal(modal.contentEl.children.length, 3);
        assert.equal(modal.contentEl.querySelector('.iplan-nav-btn'), null);
        assert.equal(modal.contentEl.children[1].textContent, '2026-09-07, 09:00 - 09:15');
        const card = modal.contentEl.children[2];
        const toggle = card.children[0].children[0];
        const steps = card.children[2];
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
  for (const [index, occurrence] of modal.occurrences.entries()) {
    const card = modal.contentEl.children[2 + index * 2];
    assert.equal(card.children[1].textContent, occurrence.routine.name);
    assert.equal(card.children[2].checklist.model.rows.length, 3);
    assert.equal(card.children[2].hidden, false);
    assert.equal(card.children[0].children[0].attributes['aria-expanded'], 'true');
    card.children[0].children[0].fire('click');
    assert.equal(card.children[2].hidden, true);
  }
  assert.equal(view.routineExpanded.size, 0);
  assert.equal(modal.contentEl.children.length, 1 + 2 * modal.occurrences.length);
  assert.equal(modal.contentEl.querySelector('.iplan-nav-btn'), null);
  modal.close();
  assert.equal(view.contentEl.querySelector('.iplan-routine-label-overflow').focused, true);
  view.contentEl.querySelector('.iplan-routine-label-overflow').fire('click');
  const reopened = openedModals.at(-1);
  for (const index of reopened.occurrences.keys()) {
    assert.equal(reopened.contentEl.children[2 + index * 2].children[2].hidden, false);
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
