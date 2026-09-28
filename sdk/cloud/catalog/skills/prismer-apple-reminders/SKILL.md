---
name: prismer-apple-reminders
scope: common
description: "Apple Reminders via remindctl: add, list, complete."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [ macos ]
metadata:
  nativeReplaces: [ apple-reminders ]
  hermes:
    tags: [ Reminders, tasks, todo, macOS, Apple ]
  requiresExplicitGrant: true
prerequisites:
  commands: [ remindctl ]
---

## Prismer execution contract

This is the uniquely named `prismer-apple-reminders` skill, adapted from Hermes.
Use the actual tools exposed by the executing host; examples using terminal,
process, delegate_task, vision_analyze or browser_* are not tool registrations.
Missing dependencies do not hide this skill. Report command startup, version,
account/permissions and task-specific live verification separately. Use task-owned
artifact paths and existing user authorization; do not change shared accounts,
Runtime/provider configuration, global security settings or unrelated work.
See NOTICE.md and LICENSE for resource provenance. Runtime availability and
upstream-entry suppression are owned by the integration layer.


# Apple Reminders

Use `remindctl` to manage Apple Reminders directly from the terminal. Tasks sync across all Apple devices via iCloud.

## Prerequisites

Resolve SKILL_ROOT to this installed directory and run
`python3 "$SKILL_ROOT/scripts/readiness.py" reminders`, then `remindctl --version`.
The startup probe does not authorize EventKit or verify iCloud/notifications.
The audited 0.1.1 lacks --alarm: enable the alarm examples below only when the
installed add/edit help explicitly supports that flag. Otherwise report the
early-notification requirement blocked; do not silently substitute a due date.

- **macOS** with Reminders.app
- Install: `brew install steipete/tap/remindctl`
- Grant Reminders permission when prompted
- Check: `remindctl status` / Request: `remindctl authorize`

## When to Use

- User mentions "reminder" or "Reminders app"
- Creating personal to-dos with due dates that sync to iOS
- Managing Apple Reminders lists
- User wants tasks to appear on their iPhone/iPad

## When NOT to Use

- Scheduling agent alerts → use the actual Prismer task scheduler, not an invented cronjob tool
- Calendar events → use Apple Calendar or Google Calendar
- Project task management → use GitHub Issues, Notion, etc.
- If user says "remind me" but means an agent alert → clarify first

## Quick Reference

### View Reminders

```bash
remindctl                    # Today's reminders
remindctl today              # Today
remindctl tomorrow           # Tomorrow
remindctl week               # This week
remindctl overdue            # Past due
remindctl all                # Everything
remindctl 2026-01-04         # Specific date
```

### Manage Lists

```bash
remindctl list               # List all lists
remindctl list Work          # Show specific list
remindctl list Projects --create    # Create list
remindctl list Work --delete        # Delete list
```

### Create Reminders

```bash
remindctl add "Buy milk"
remindctl add --title "Call mom" --list Personal --due tomorrow
remindctl add --title "Meeting prep" --due "2026-02-15 09:00"
```

### Due Time vs Alarm / Early Nudge

When the installed version supports both, `--due` and `--alarm` are different fields:

- `--due` sets the reminder's due date/time.
- `--alarm` sets the EventKit alarm/notification trigger. Timed due reminders may default to an alarm at the due time, but pass `--alarm` explicitly when the user asks for an earlier nudge.

For a reminder due at 2:00 PM with a notification 30 minutes earlier:

```bash
remindctl add --title "Hairdresser" --due "2026-05-15 14:00" --alarm "2026-05-15 13:30"
```

To edit an existing reminder:

```bash
remindctl edit 87354 --due "2026-05-15 14:00" --alarm "2026-05-15 13:30"
```

The Reminders UI may show or group the item by the alarm time because that is when the notification fires. Verify with JSON instead of assuming the due time moved:

```bash
remindctl today --json
```

Read the actual version's JSON schema; the following fields are version-dependent:

- `dueDate`: actual due time
- `alarmDate`: notification / early nudge time

Apple's public `EKReminder` docs list only reminder-specific properties. Alarm support comes from inherited `EKCalendarItem` behavior exposed by remindctl's `--alarm` flag.

### Complete / Delete

```bash
remindctl complete 1 2 3          # Complete by ID
remindctl delete 4A83 --force     # Delete by ID
```

### Output Formats

```bash
remindctl today --json       # JSON for scripting
remindctl today --plain      # TSV format
remindctl today --quiet      # Counts only
```

## Date Formats

Accepted by `--due` and date filters:
- `today`, `tomorrow`, `yesterday`
- `YYYY-MM-DD`
- `YYYY-MM-DD HH:mm`
- ISO 8601 (`2026-01-04T12:34:56Z`)

## Rules

1. Clarify Apple Reminders versus an agent scheduled task only when intent is ambiguous.
2. Use the user's stated content/time authorization; clarify only missing fields.
3. Use `--json` for programmatic parsing
4. Record host timezone and resolved timestamp. Read back the exact created ID;
   help/JSON success alone does not prove the notification was delivered.
