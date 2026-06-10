---
name: team
description: Invite humans into a workspace, propose collaborators for a project, and inspect the current human team. Use when the user says things like "let's bring X into this", "who else is on this", "add Bob to Q2 launch", or asks for a team roster. NEVER mints invites silently — the human must press a button.
---

# Team

Use this skill when work needs another human in the loop. The workspace + project surfaces collectively decide *who can see and act on* tasks, conversations, and assets in a workspace; this skill is how the agent exposes those surfaces to the user.

## ⛔ Hard rules — human-in-loop

1. **Never auto-send an invite.** Agents may *propose* who should be invited and explain *why*, but the final action (`POST /api/im/workspaces/:id/invites`) must originate from a human click in workspace settings or from an explicit user instruction like "send the invite". If you ever find yourself about to call invite-create without that explicit go-ahead, stop and surface the proposal as text instead.
2. **Never expose member emails.** The `/api/im/workspaces/:id/members` response carries imUserIds, not addresses. If the user asks "what's Bob's email", say you can see Bob's username + display name but not their email.
3. **Distinguish workspace member from project member.** Workspace member = ACL boundary across the whole workspace (chat, tasks, assets). Project member = a sub-scope inside that workspace with its own role enum (owner/contributor/observer). Adding someone to a project requires them to be a workspace member first — surface that constraint when proposing.
4. **Never silently re-add a removed member.** If a user was removed from the workspace, their project memberships were cascade-deleted on purpose (release201/16 §3.2.3). Treat re-adding as a new collaboration event that needs explicit user consent, not a "fix it" automation.

## When to use

- The user names someone who isn't already on the workspace: *"Have Maya look at this"*, *"Loop Bob in on Q2 launch"*.
- The user asks who's on the team or what the roster looks like: *"who has access to this workspace"*, *"who's working on Q2 launch"*.
- The user asks to remove someone, change someone's role, or move someone between projects.
- An agent (e.g. CEO role) is reasoning about staffing in onboarding and needs to *propose* additions without taking action.

## What the platform exposes

This skill is a thin wrapper over the cloud workspace + invite endpoints (release201/16):

| Intent | Surface |
|---|---|
| List workspace members | `GET /api/im/workspaces/:id/members` (owner / admin / member) |
| List project members | `GET /api/im/projects/:id/members` (project visibility rules) |
| List outstanding invites | `GET /api/im/workspaces/:id/invites` (owner/admin) |
| Propose an invite | Stop here. Tell the user what to click. |

Concrete invite minting and acceptance go through the workspace settings → Members UI and the `/invite/:token` landing page. Those are the *human-pressed* paths the platform intentionally requires.

## Suggested phrasing when proposing

When the user mentions a name and you're not sure if they're in:

> "Maya isn't in this workspace yet. To invite her, open **Workspace settings → People → Invite** and send her an email link or a direct in-app request. She'll see the link, accept, and then I can add her to the Q2 launch project."

When the user is owner/admin and asks you to do it:

> "I can't send the invite myself — the platform requires you to press the button so there's an audit receipt. Want me to walk you to **Workspace settings → People** now?"

When proposing a project add for someone already in the workspace:

> "Maya is a workspace member but not on the Q2 launch project. From the project drawer's *Agents* tab, click **+ Add** under *User members* and pick Maya — that adds her as contributor."

## What this skill does NOT do

- It does **not** push invite links to email, Slack, or any side channel. The cloud's notification queue handles email; this skill does not.
- It does **not** enumerate non-members. Showing a list of "people you could invite" requires either an email address or an existing imUserId — never a directory dump.
- It does **not** promote / demote roles. Surface the suggestion and let the human do it through settings. Role changes are owner-only on the server.

## Edge cases

- **Block relationships**: invites between blocked users 422 with `PRINCIPAL_BLOCKED`. If you see that, say so plainly: "There's a block between the inviter and invitee — neither side can invite the other until the block is cleared from contacts."
- **Already-pending invite**: the server returns 409 `DUPLICATE_PENDING_INVITE` if the same workspace already has a pending invite to that addressee. Surface the existing invite (it shows up in the Invites tab of workspace settings) rather than asking the user to mint a fresh one.
- **Expired invite**: 410 `INVITE_EXPIRED`. The link is dead. Ask the human to mint a new one; do not autocreate one in their place.

## Forbidden patterns

| Anti-pattern | Why it's forbidden |
|---|---|
| Calling invite-create silently during a task | release201/16 §0.2.4 — agents must not mint workspace ACL changes |
| Listing email addresses of workspace members | release201/16 §0.2.4 — members endpoint never returns emails |
| Treating contact-add as "auto-invite to workspace" | release201/16 §5.4 anti-pattern — contact ≠ ACL |
| Re-adding a removed user "because they used to be on the team" | release201/16 §3.2.3 — cascade is intentional |

## Related skills

- `tasks` — once people are in, this is how work flows to them.
- `human-approval` — if you need a human's sign-off on an action (different from inviting them as a workspace member).
- `agent-coordination` — for the agent side of who-does-what; this skill is the human side.
