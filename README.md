# ICOR for Life - Planner

**Plan your week once, in one place.**

Your tasks are in Todoist, in ClickUp, in starred emails and in four
calendars. Planning a week means re-reading all of them and holding the
answer in your head. This brings them into one board: drag a card onto a
morning or an afternoon, and that part of the week is decided.

Part of the [ICOR for Life](https://myicor.com) suite.

## What it is for

Planning fails at the gathering step, not the deciding step. By the time you
have checked four apps you have spent the energy you needed for the actual
choice, and you are choosing from whatever you still remember.

Put everything on one surface and the choice becomes easy, because you can
finally see all of it at once.

Everything lands in your vault as plain markdown notes, so your plan is yours
and readable without this plugin.

## Getting started

You do not need an account to start. Open the Planner from the button under
the sidebar logo, add a task by hand in the tray, and drag it onto a day.

Connect sources when you want them, one at a time, from the settings page.

## What you can connect

**Tasks.** Todoist and ClickUp.

**Email.** Starred or flagged mail becomes a task. Gmail, iCloud and Fastmail
have one-click presets and ask for an app password, never your account
password. Any other IMAP host works by typing it in. Outlook and Microsoft
365 connect through their own sign-in.

**Calendars.** As many as you like, one iCal address each: Google, iCloud,
Proton, Outlook or anything else that publishes a feed. Each gets a name and
a colour, an event in two calendars shows once, and one feed failing leaves
the others working and tells you which one broke.

Every source is optional. Connect none and the board still works.

## The one rule: your notes are a mirror

Tasks from a connected source are a mirror of that source.

- **Complete here and it completes there.** That is the "Complete on source"
  switch, and it is off until you turn it on.
- **Edit here and it syncs there.** Title, due date, priority and the note
  body go back to Todoist and ClickUp, behind the "Push edits to source"
  switch.
- **Changed there, changed here.** Every sync pulls what changed at the
  source. If the same thing changed on both sides, the source wins.
- **Deleted there, it disappears here.** The note moves to Obsidian's trash,
  where you can get it back.

Your own planning is never part of this. The day a card sits on, its half of
the day, its order, the star for the week and the note you linked it to live
only in your vault, and no sync touches them.

## The board and the tray

The **board** is your week in morning and afternoon lanes. Drag a card onto
one and it is scheduled.

The **tray** sits in the right sidebar with four tabs: unscheduled tasks,
your calendar, your routines and your habits.

In the daily **Calendar** view, **Today Backlog** sits to the left of the calendar.
Its left edge uses the same buffer thresholds and colors as Weekly Planning.
It lists unfinished tasks planned for the selected day that do not yet have
a calendar time, initially in the weekly-planning sequence (morning before afternoon).
Drag cards within Today Backlog to change that suggestion. An insertion line
shows where the card will land, including above the first or below the last card.
The new sequence is saved in the task notes, not just held in the open view.
It uses the existing weekly lane and order: an insertion before a card adopts
that card's morning or afternoon lane; an insertion at the end adopts the last
card's lane and follows its lane's tasks, events and routines. Moving across
the morning/afternoon boundary therefore also updates Weekly Planning.
Drag a task onto the calendar to choose its time, or use **Schedule now**
to place it at the exact current local time with its planned duration
(one hour when no duration is set). Schedule now is available only for today.
The existing 30-minute grid still applies to drag-and-drop. Scheduling stays
in the planner; it does not create an event in a connected calendar.
At narrow widths the backlog appears above the calendar, with the same keyboard order.
For a timed task, **Send to Today Backlog** removes its calendar time while
keeping its planned date, duration and weekly-planning order, even when viewing
another date. Its morning or afternoon lane is kept, or inferred from its
start time if none was set. Scheduling on the calendar keeps this saved order;
calendar tasks themselves remain chronological, not manually ordered.
Dragging a calendar task into Today Backlog removes its time and inserts it
at the indicated position instead. Only unfinished tasks planned for the
displayed date can be returned this way.
You can also drag an unfinished, unplanned task from **Weekly Backlog** into
Today Backlog, onto a card or the empty area. This plans it for the displayed
date without giving it a calendar time or changing its source due date.
Its duration and other task metadata are kept. It uses the same insertion
position and lane rules as reordering. Empty space below the cards appends;
an empty backlog keeps the task's valid lane, infers it from a former start
time when available, or uses morning, then appends within that weekly lane.
Tasks planned for another date, completed tasks and completed-occurrence
ghosts are not accepted. A changed target list or a task changed during the
save is refused with a notice rather than overwriting the newer plan.
Dropping a card back at its existing visible position keeps its lane and rank
and does not write a task note, including first, last and single-card drops.
Equal ranks (including the usual zero defaults) and exhausted fractional ranks
are handled by spreading the movable task block around the insertion into fresh
order ranks in the target date and lane. Other tasks keep their relative order.
Events, routines and timed tasks remain fixed anchors; their times and ranks
are not rewritten. Completed untimed tasks inside the same block may also have
their local ranks spread, keeping their relative order and completion unchanged.
Other blocks, lanes and dates are untouched.
A target without a valid weekly lane must first be placed in morning or afternoon.
If fixed anchors themselves leave no representable numeric space, the move is
refused before saving, with a notice to choose another position.
Membership and placement are checked before each write and each changed note is
checked again inside its save. Normalization can save several notes; these are
not an atomic multi-file transaction. If a later save fails, a notice explicitly
reports partial normalization and asks you to refresh and retry. It does not
roll back over newer edits or trigger a success refresh.
Weekly Goals keep their gold borders and remain visible in the goal lists.
This adds no menu action.
**Send to Weekly Backlog** returns a planned task
to the tray using the existing unscheduled-task rules and filters. These
actions do not change the task's source due date or completion.

Task cards show their source icon on the right of the title. The checkbox,
title and icon share a vertically centered row, including on longer tasks.
Todoist icons use a red tile with white lines throughout the planner.
Tasks of 30 minutes or less use a compact
single row with checkbox, an ellipsis title and icon; hover shows the full title
and metadata. Secondary chips, parent labels and subtask lists are hidden only
in these compact cards. Their resize grip sits on the right edge to keep the
single row clear, and resizing still changes duration vertically. Larger cards
keep their bottom resize grip. Calendar block heights still match exact minutes.

**Routines and habits** live here too, so the things you do every week are on
the same surface as the things you only do once.

**Weekly Goals** replaces manual pinning. A Todoist task is a Weekly Goal
only when it carries the exact `weekly-goal` label. The tray keeps its existing
Todoist backlog filter: the task must also carry the exact `this-week` label
or have a due date in the current local Monday-to-Sunday week. This uses the
current week, not the week selected on the board. The goals appear at the top
of TASKS and in the WEEKLY GOALS tab, whether scheduled or unscheduled.
Completed matching tasks that are still available as local planner notes stay
visible there with their completion state and the existing completion controls.
The ordinary source lists still show only unfinished, unscheduled non-goal tasks.

Weekly-goal cards have a gold border and a WEEKLY GOAL chip wherever shared task
cards render them, including Today Backlog; compact calendar cards keep their
existing hidden-chip layout. Today Backlog still shows only unfinished tasks
for the displayed day. Label highlighting does not change scheduling, due dates,
drag-and-drop or source completion behavior.

Set or remove the label in Todoist and sync; there are no pin/unpin controls
or new label write-backs. Legacy `weekly_goal` frontmatter is left intact but
has no effect. This is a live filtered list, not saved week membership or
completed-task history: open-task sync does not fetch full completed history,
and goals can leave the list when labels or due dates stop qualifying.
Recurring completion history and its existing placement requirements are unchanged;
completed occurrences are not added to the goals list.

## The week note

Beside the board there is one note per week, in `02 Planner/Weeks/`, and a tab
that reads and writes it. It holds two things.

**Weekly priorities.** What you are trying to achieve this week, one line
each, with a box you tick when it is done. Not tasks: outcomes. A task can
serve one.

**Daily highlights.** One sentence per day: the one thing that, if it happens,
makes the day a win. You set it in the morning and confirm it in the evening,
done or not done. Only today's row takes input; the rest of the week is what
it already says.

The note is plain markdown with two headings, so you can write in it by hand
and the tab reads exactly what you wrote. It is created the first time you put
something in it, and never before.

## Linking a task to a note

A card's menu can point it at the note the work is really for, usually a
project or a key element. The link lives on the planner side only, nothing is
written into the note you point at, and no sync run ever changes it.

## Where your keys live

One setting decides whether your keys stay on this device or follow the vault
to every device you sync. The setting explains both options in plain words
before you choose.

Keys are held in Obsidian's own keychain, outside your notes.

## What it touches

**Your vault.** Every task, event, routine and habit becomes a plain markdown
note in `02 Planner/`. You can read and edit them without this plugin.

**The services you connect, and only those.** With a key configured it talks
to Todoist, ClickUp, your own IMAP host, the iCal addresses you paste, and
Microsoft's sign-in if you use Outlook. Nothing passes through myICOR: your
Microsoft registration is yours, and so are the tokens.

**It reads by default.** It writes back only what you switched on:
completing a task or clearing an email flag ("Complete on source"), and
title, due date, priority and body edits ("Push edits to source"). Both are
off until you turn them on. It never deletes anything at a source.

Without a key for a source, that source is simply off.

## Good to know

- **Desktop and mobile.**
- **Proton Mail** connects through Proton Bridge, which must be running.
- **Outlook** needs about ten minutes of one-time setup in your own Microsoft
  account; there is a step-by-step guide in `docs/`.
- **Beta.** In daily use in a real vault, and you will find rough edges.
  Questions and ideas go in the
  [planner channel](https://app.myicor.com/icor-for-life?channel=planner);
  defects go in
  [bug reports](https://app.myicor.com/icor-for-life?channel=bug-reports).

## Support

What myICOR supports: the plugin as published in a tagged release, on the
current version, installed from that release. Bugs go to this repo's issues,
security reports to the process in `SECURITY.md`.

What the community maintains: anything marked community-maintained, including
community source adapters. We review it before it is merged. We do not support
it, we cannot promise it keeps working, and it can be disabled or removed in
any release.

What is yours: your own changes, your fork, your local patch. Please reproduce
the problem on a clean install of the current release before reporting it.

## Licence

MIT, see `LICENSE`. Install it, run it, read it, change it, sell it, ship it in
your own product; keep the copyright and licence notice.
Releases before 0.16.0 stay under the ICOR for Life
Source-Available License (Code) v1.0 they were published with.

The licence covers the code only. "ICOR", "ICOR for Life", "myICOR" and
"Paperless Movement" are trademarks of Paperless Movement, S.L.; a fork needs
its own plugin id and name. See `TRADEMARK.md`.

Contributions are welcome as pull requests under the same MIT terms, with a
DCO sign-off on every commit. See `CONTRIBUTING.md`.

Bundled third-party components keep their own licences; see
`THIRD-PARTY-NOTICES.md`.
