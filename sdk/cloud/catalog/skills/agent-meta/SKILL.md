---
name: agent-meta
scope: common
description: Inspect, snapshot, publish, and fork Prismer long-running agents through the cloud agent lifecycle API.
allowed-tools: cloud.agent.spec cloud.agent.snapshot cloud.agent.snapshots cloud.agent.restore cloud.agent.publish cloud.agent.packs cloud.agent.fork prismer.agent.snapshot prismer.agent.publish prismer.agent.fork
metadata:
  prismer:
    category: workflow-core
    version: "1.0.0"
---

# Agent Meta

## Skill self-check

Start from the current Runtime's effective skill list (Hermes skills_list or
the registered skill surface), not a recursive disk count. Distinguish installed
files, registered capabilities, and actual smoke-tested operations. Platform or
session filtering is expected, not a damaged skill or a question for the user.
For a full disk audit, classify excluded entries as informational and missing
commands/credentials as not ready. Check prerequisites without printing secrets;
command presence does not prove authentication. Report only actionable defects,
and never claim all functions passed from frontmatter parsing alone.

Use this skill when the user asks you to inspect, save, restore, publish, or fork a Prismer long-running agent.

## Commands

- Inspect your 4-tuple spec:
  `cloud agent spec <agent-id>`

- Save a private owner snapshot:
  `cloud agent snapshot <agent-id> --label "<label>"`

- Save a snapshot with memory reference:
  `cloud agent snapshot <agent-id> --include-memory --label "<label>"`

- List snapshots:
  `cloud agent snapshots <agent-id>`

- Restore from a snapshot:
  `cloud agent restore <agent-id> <snapshot-id>`

- Publish an agent pack without memory:
  `cloud agent publish <agent-id> --slug <pack-slug> --version 1.0.0 --license proprietary`

- List public agent packs:
  `cloud agent packs`

- Fork a pack into a workspace:
  `cloud agent fork <pack-id-or-slug> --workspace-id <workspace-id> --display-name "<name>"`

The runtime CLI has the same operational verbs for daemon environments:

- `prismer agent snapshot <agent-id>`
- `prismer agent publish <agent-id> --slug <pack-slug>`
- `prismer agent fork <pack-id-or-slug> --workspace-id <workspace-id>`

## Rules

- Do not publish memory. The publish path strips memory by default; keep it that way unless a platform policy explicitly changes.
- Use snapshots for owner backup and restore. Use publish only when the user asks to share or reuse the agent as an Agent Pack.
- Fork creates a new identity and a clean memory partition in the target workspace.
- If the user asks to "save your config", create a snapshot rather than publishing.
