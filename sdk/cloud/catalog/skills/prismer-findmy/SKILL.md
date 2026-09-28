---
name: prismer-findmy
scope: common
description: "Track Apple devices/AirTags via FindMy.app on macOS."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [ macos ]
metadata:
  nativeReplaces: [ findmy ]
  hermes:
    tags: [ FindMy, AirTag, location, tracking, macOS, Apple ]
  requiresExplicitGrant: true
---

## Prismer execution contract

This is the uniquely named `prismer-findmy` skill, adapted from Hermes.
Use the actual tools exposed by the executing host; examples using terminal,
process, delegate_task, vision_analyze or browser_* are not tool registrations.
Missing dependencies do not hide this skill. Report command startup, version,
account/permissions and task-specific live verification separately. Use task-owned
artifact paths and existing user authorization; do not change shared accounts,
Runtime/provider configuration, global security settings or unrelated work.
See NOTICE.md and LICENSE for resource provenance. Runtime availability and
upstream-entry suppression are owned by the integration layer.


# Find My (Apple)

Track Apple devices and AirTags via the FindMy.app on macOS. Since Apple doesn't
provide a CLI for FindMy, this skill uses AppleScript to open the app and
screen capture to read device locations.

## Prerequisites

Run `python3 "$SKILL_ROOT/scripts/readiness.py" findmy`. This does not open the
app or prove Screen Recording, Accessibility, Automation or iCloud readiness.
Inspect live UI labels/elements in the user's locale; English labels below are
illustrations, not stable selectors. Use only the user-authorized device.

- **macOS** with Find My app and iCloud signed in
- Devices/AirTags already registered in Find My
- Screen Recording permission for terminal (System Settings → Privacy → Screen Recording)
- **Optional but recommended**: Install `peekaboo` for better UI automation:
  `brew install steipete/tap/peekaboo`

## When to Use

- User asks "where is my [device/cat/keys/bag]?"
- Tracking AirTag locations
- Checking device locations (iPhone, iPad, Mac, AirPods)
- Monitoring pet or item movement over time (AirTag patrol routes)

## Method 1: AppleScript + Screenshot (Basic)

### Open FindMy and Navigate

```bash
# Open Find My app
osascript -e 'tell application "FindMy" to activate'

# Wait for it to load
sleep 3

# Take a screenshot of the Find My window
# WINDOW_ID must be the verified numeric Find My window, not a guessed value.
TASK_CAPTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/prismer-findmy.XXXXXX")
screencapture -x -l "$WINDOW_ID" "$TASK_CAPTURE_DIR/findmy.png"
```

Then use `vision_analyze` to read the screenshot:
```
vision_analyze(image_url="$TASK_CAPTURE_DIR/findmy.png", question="What devices/items are shown and what are their locations?")
```

### Switch Between Tabs

```bash
# Switch to Devices tab
osascript -e '
tell application "System Events"
    tell process "FindMy"
        click button "Devices" of toolbar 1 of window 1
    end tell
end tell'

# Switch to Items tab (AirTags)
osascript -e '
tell application "System Events"
    tell process "FindMy"
        click button "Items" of toolbar 1 of window 1
    end tell
end tell'
```

## Method 2: Peekaboo UI Automation (Recommended)

If `peekaboo` is installed, use it for more reliable UI interaction:

```bash
# Open Find My
osascript -e 'tell application "FindMy" to activate'
sleep 3

# Capture and annotate the UI
peekaboo see --app "FindMy" --annotate --path $TASK_CAPTURE_DIR/findmy-ui.png

# Click on a specific device/item by element ID
peekaboo click --on "$VERIFIED_ELEMENT_ID" --app "FindMy"

# Capture the detail view
peekaboo image --app "FindMy" --path $TASK_CAPTURE_DIR/findmy-detail.png
```

Then analyze with vision:
```
vision_analyze(image_url="$TASK_CAPTURE_DIR/findmy-detail.png", question="What is the location shown for this device/item? Include address and coordinates if visible.")
```

## Workflow: Track AirTag Location Over Time

For monitoring an AirTag (e.g., tracking a cat's patrol route):

```bash
# 1. Open FindMy to Items tab
osascript -e 'tell application "FindMy" to activate'
sleep 3

# 2. Select the exact item and read its displayed update time.
# 3. One sample per authorized, time-bounded Prismer scheduler invocation.
screencapture -x -l "$WINDOW_ID" "$TASK_CAPTURE_DIR/findmy-$(date +%Y%m%dT%H%M%S)-$$.png"
```

Read only coordinates actually visible; never infer precise GPS from an address or map pin. Record timestamp/accuracy and retain only the user-authorized interval. Do not compile a route unless requested.

## Limitations

- FindMy has **no CLI or API** — must use UI automation
- Background refresh depends on OS/device state; report the displayed update time
- Location accuracy depends on nearby Apple devices in the FindMy network
- Screen Recording permission required for screenshots
- AppleScript UI automation may break across macOS versions

## Rules

1. Observe actual refresh behavior; do not promise foreground/background timing
2. Use `vision_analyze` to read screenshot content — don't try to parse pixels
3. For requested ongoing tracking, use the actual Prismer scheduler with an explicit duration and retention limit
4. Respect privacy — only track devices/items the user owns
