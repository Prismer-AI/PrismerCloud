---
name: prismer-imessage
scope: common
description: Send and receive iMessages/SMS via the imsg CLI on macOS.
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [ macos ]
metadata:
  nativeReplaces: [ imessage ]
  hermes:
    tags: [ iMessage, SMS, messaging, macOS, Apple ]
  requiresExplicitGrant: true
prerequisites:
  commands: [ imsg ]
---

## Prismer execution contract

This is the uniquely named `prismer-imessage` skill, adapted from Hermes.
Use the actual tools exposed by the executing host; examples using terminal,
process, delegate_task, vision_analyze or browser_* are not tool registrations.
Missing dependencies do not hide this skill. Report command startup, version,
account/permissions and task-specific live verification separately. Use task-owned
artifact paths and existing user authorization; do not change shared accounts,
Runtime/provider configuration, global security settings or unrelated work.
See NOTICE.md and LICENSE for resource provenance. Runtime availability and
upstream-entry suppression are owned by the integration layer.


# iMessage

Use `imsg` to read and send iMessage/SMS via macOS Messages.app.

## Prerequisites

Run `python3 "$SKILL_ROOT/scripts/readiness.py" imessage` from this installed
skill's resolved directory. Help checks flags only; account, Full Disk Access,
Automation, SMS forwarding and delivery require separate authorized live checks.

- **macOS** with Messages.app signed in
- Install: `brew install steipete/tap/imsg`
- Grant Full Disk Access for terminal (System Settings → Privacy → Full Disk Access)
- Grant Automation permission for Messages.app when prompted

## When to Use

- User asks to send an iMessage or text message
- Reading iMessage conversation history
- Checking recent Messages.app chats
- Sending to phone numbers or Apple IDs

## When NOT to Use

- Telegram/Discord/Slack/WhatsApp messages → use the appropriate gateway channel
- Group chat management (adding/removing members) → not supported
- Bulk/mass messaging → always confirm with user first

## Quick Reference

### List Chats

```bash
imsg chats --limit 10 --json
```

### View History

```bash
# By chat ID
imsg history --chat-id 1 --limit 20 --json

# With attachments info
imsg history --chat-id 1 --limit 20 --attachments --json
```

### Send Messages

```bash
# Text only
imsg send --to "+14155551212" --text "Hello!"

# With attachment
imsg send --to "+14155551212" --text "Check this out" --file /path/to/image.jpg

# Force iMessage or SMS
imsg send --to "+14155551212" --text "Hi" --service imessage
imsg send --to "+14155551212" --text "Hi" --service sms
```

### Watch for New Messages

```bash
imsg watch --chat-id 1 --attachments
```

Watch only for the user-authorized chat and duration; terminate the process at
that deadline. Do not capture a continuous stream as an incidental diagnostic.

## Service Options

- `--service imessage` — Force iMessage (requires recipient has iMessage)
- `--service sms` — Force SMS (green bubble)
- `--service auto` — Let Messages.app decide (default)

## Rules

1. Use an explicitly authorized exact recipient/content; clarify ambiguous identities only
2. **Never send to unknown numbers** without explicit user approval
3. Verify both file existence and authorization to send that specific content
4. **Don't spam** — rate-limit yourself

## Example Workflow

User: "Text mom that I'll be late"

```bash
# 1. Read candidates, then resolve the exact chat handle or phone number.
imsg chats --limit 20 --json

# 2. A display name is not unique. Clarify only if the authorized recipient is ambiguous.

# 3. Send after confirmation
imsg send --to "+1555123456" --text "I'll be late"
```

After an uncertain send, read back the target chat before retrying; do not create
duplicate messages. A local command exit is not proof of remote delivery.
