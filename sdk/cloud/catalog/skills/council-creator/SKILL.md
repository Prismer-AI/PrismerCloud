---
name: council-creator
scope: common
description: >
  Expert-council meeting protocol. Given a Brief + a persona cast (from
  persona-generator), propose the council to the Team Manager, and once convened
  FACILITATE it: each round post a NEW group message that @-mentions the
  persona-agents by their ASCII usernameSlug, collect their independent replies,
  stage-summarize, exchange memory, and settle into a disagreement map + report
  + memory writeback + task drafts. Personas are REAL agents (role instances),
  each speaking from its own session — you are the facilitator, NOT a puppeteer
  playing five roles. The group stays resident for @persona follow-ups. This is
  a PLAYBOOK the workspace orchestrator executes.
license: MIT
compatibility:
  - prismer-sdk
  - hermes
metadata:
  category: council
  disclaimerRequired: true
---

# Council Creator

**How they speak together.** A **facilitation playbook** layered onto the
workspace orchestrator. There is **no "Council Agent"** — but you are **not** the
only execution unit either: each persona is a **real agent** (a role instance
provisioned at convene), with its own identity, dispatch, and LLM session. Your
job is to **facilitate** — set the agenda, @-mention personas, collect their
replies, summarize, exchange memory — **never** to speak for them. Load this
skill after `persona-generator` has produced a cast.

| Do | Do NOT |
| --- | --- |
| propose the council to the Team Manager (`--plan <planId>` + one sentence), then **stop and wait** | **Convene it yourself** — that is the Team Manager's one click, and no command exists for it |
| facilitate: each round post a NEW group message that **@-mentions personas by ASCII `usernameSlug`** | Speak a persona's words yourself — personas are real agents, they reply on their own |
| collect the personas' replies, stage-summarize, exchange memory | @-mention a persona by its Chinese `displayName` (silently drops → 0 dispatch) |
| settle: disagreement map + report + memory + task drafts | Generate persona definitions (persona-generator) |
| Keep the group resident; answer @persona follow-ups | Narrate status chatter into the group between rounds |
| Say plainly when the Brief does not stand | Chain persona↔persona relays (burns the hop budget — see hop rule) |

## You execute this through the `prismer council` CLI + normal group messages

**The lifecycle commands are real: `plan`, `propose`, `finalize`.** A council
exists only when `plan`/`propose` have run and the Team Manager has convened; the
discussion itself is **normal group messages that @-mention the persona-agents**
(not a CLI command). Writing a document that *describes* a roundtable creates
nothing, and reporting it as done is a false claim of delivery. If you cannot get
past a phase, say what failed and why. Never substitute prose for the protocol.

**When to start:** the Team Manager does not ask for "a council" — he drops a deck, or says
"帮我找几个人聊聊这个 idea", or asks a question that plainly needs positions other
than his own. That is your cue to read the material, assemble the Brief, run
`persona-generator`, and **propose**. You start the flow; he only decides whether
to hold it.

```
Phase A  plan      prismer council plan     --file plan.json      →  planId
         propose   prismer council propose  <ceoConvId> --plan <planId> --text "一句人话"
                   ↓  ⛔ YOU STOP HERE. The Team Manager clicks [好，开吧].
Phase B  convene   — no command exists. The Team Manager's click instantiates the persona-agents + group.
Phase C  facilitate (you receive a "facilitate round N" task) → post ONE new group message
                   that @-mentions the personas by ASCII usernameSlug → each persona-agent
                   replies on its own session → you collect + summarize, then STOP.
Phase D  settle    (you receive a settle task) → prismer council finalize <convId> --file report.json
readback           prismer council report   <convId>
```

`--workspace-id` defaults to `$PRISMER_WORKSPACE_ID`. Nested bodies come in as a
JSON file you write first (shapes below). Each command prints the endpoint's JSON
response; a nonzero exit means the phase did **not** happen.

### The Team Manager gets exactly one decision — and it is not yours to take

Read this before anything else. **You cannot convene.** There is no
`council convene` command, on purpose. The whole flow gives the Team Manager one single
decision — *"好，开吧"* or *"先不用"* — and that click is what creates the group.
Your job in Phase A ends with `council propose`: the `planId` and one human
sentence, and then **you stop and wait**.

**You do NOT pass the cast.** The cloud fills the head-avatars preview on the
proposal bubble by reading the cast straight out of your plan draft
(`councilPlan.cast` — the same `PersonaDef[]` you gave `council plan`) and
projecting only the display-safe subset (never the per-turn `voice`). So all you
give `propose` is `--plan <planId>` + `--text "一句人话"` — say, in plain words,
*why these positions*. The cloud guarantees the component data; you cannot leave
the roster preview empty by forgetting a flag (that was the real e2e failure —
28 §L1). The only variant is `--gap` (Brief did not stand — there is no cast to
show).

Do not "helpfully" push past this. Do not describe the roundtable you would have
held. Do not write the report early. A council the Team Manager never agreed to is not a
council, and a document describing an unheld discussion is a fabricated
deliverable — the exact thing this skill exists to make impossible.

What the Team Manager sees is a bubble in your conversation:

> 读完了。这件事牵涉几个很不一样的位置 —— 量产过来人、早期投资人、发动机工程师、
> 政府采购方，各自能看到你看不到的一块。要不要我请他们来聊聊？
> 　　[👤👤👤👤👤 5 位 ⌄]　　**[好，开吧]**　**[先不用]**

That sentence is yours to write (`--text`). It should say *why these positions*,
in plain language, from what you actually read. Never name internal machinery
(`lens`, `cast`, `Brief`, `persona`) to the Team Manager.

### The Brief hard gate — and what to do when it fails

`plan` exits nonzero with `BRIEF_INSUFFICIENT` + `gaps[]` when the Brief has no
readable material or no grounded facts.

**A failed Brief means you never propose a meeting at all.** You do not open a
room, you do not write a report, and you certainly do not show the Team Manager a plan and
then tell him it failed. You say what is missing and ask for it:

```
prismer council propose <ceoConvId> --gap \
  --text "读了你给的材料，但里面没有任何关于单位成本的数据 —— 缺这个的话，请谁来都只能猜。" \
  --gap-item "近 12 个月的单位成本曲线"
```

The gate is in Phase A, before the proposal — never inside a card the Team Manager has to
read to discover the failure.

`plan.json` (Phase A):

```json
{
  "question": "2026 年商业航天的关键变量是什么？",
  "brief": {
    "summary": "…",
    "facts": [{ "text": "Starlink 2025 年收入 114 亿美元", "sourceUrl": "https://…" }],
    "gaps": ["中国民营发射成本无公开数据"]
  },
  "cast": [ /* PersonaDef[] — produced by persona-generator, passed through verbatim */ ],
  "agenda": ["可复用火箭", "卫星星座", "政策监管", "资本市场"],
  "assetIds": ["<im_assets id of the material you ingested>"]
}
```

Both hard-gate legs are load-bearing: `assetIds` must point at **real ingested
assets** (use your ingest/asset skills first — a path on disk is not an asset),
and `brief.facts[].text` must carry grounded facts. Neither can be faked past
the gate.

## Convene receipt (Team Manager UI only)

This is not an agent command. After the Team Manager clicks the proposal UI,
the server uses the confirmed roster and performs these steps. Wait for its
receipt; never call an internal endpoint to bypass the UI confirmation:

1. Creates the group shell (real members: Team Manager + you + optional extras);
   `conversation.metadata.council = { sessionId, planId, question, agenda,
   materialRefs, personaUserIds, reportRefs }` is the council marker — the
   conversation `type` stays `'group'`.
2. Instantiates each persona as a **real agent** (role instance) in **one
   transaction**: `createAgentForWorkspace` (unbound agent) + `applyToAgent`
   (persona role template + persona skill + profile snapshot). Its username is
   `<usernameSlug>-<conv8>` (ASCII, deduped; non-ascii or `prismer-` reserved
   slugs are rejected — a persona MUST be reachable by an ASCII @-handle). Your
   generated `voice` / lens is baked into the role instance so it speaks
   in-character from its **own** session. There is **no** `backingAgentId` and
   **no** dispatch redirect — the persona is a standalone agent.
3. Seats everyone; on any failure the transaction rolls back and the group
   shell is removed — no orphan personas (负控 N9).
4. Posts the Brief as the opening message (sender = you,
   `metadata.kind='council_brief'`).

The response carries `conversationId` + `personas[]` + a
`prismer://conversation/<id>` link. A plan can be convened **once** — a second
attempt gets `404 PLAN_NOT_FOUND`.

## facilitate — you post rounds, the persona-agents reply themselves

**Personas are real agents now — you do NOT produce their words.** Each round you
post **one** new group message that @-mentions the personas; the platform
dispatches each one, and each persona-agent replies **from its own session**
(mention fan-out + per-agent dispatch + the workspace admission queue serialize
them). The 158% single-session blowup is structurally gone — five sessions, not
one. This replaces the old `council turns` serial-drive: there is no `turns.json`,
you never speak as a persona.

### 🚨 @-mention personas by their ASCII `usernameSlug` — NEVER by `displayName`

**This is the single highest-risk rule in this skill.** Break it and you silently
reproduce the "0/5 personas spoke" failure this redesign exists to kill. The
mention router (`agent-dispatcher.ts` `MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/`)
is **strict ASCII**. A bare `@伊隆·马斯克` (the Chinese `displayName`) matches
**nothing** → the mention is silently dropped → that persona is never dispatched
→ it never speaks.

- ✅ Always `@<usernameSlug>` — e.g. `@elon-musk-cmrm3cey`. The convene response
  gives you each persona's ASCII `usernameSlug`; use it **verbatim**.
- ❌ Never `@<displayName>` (Chinese or any non-ASCII). `displayName` is for the
  UI card only; it does **not** route.
- If you only have a persona's displayName, look up its `usernameSlug` from the
  convene response / roster **before** composing the message — do not guess.

### Semantic-clarification gate — run this FIRST, before opening a round

You are the council's facilitator, the **语义把关人**. Before you open a round,
check whether the Team Manager's input introduces a concept / term / acronym that the
**Council Brief and the transcript so far do not define**. If such a term exists
**and is genuinely ambiguous** (no shared definition, could mean more than one
thing), do **not** @-mention the personas and do **not** let them invent a
definition and argue on top of the guess. Instead:

1. Post **exactly ONE clarification message into the group AS YOURSELF** — a
   normal group message, **without** any persona @-mention. Name the undefined
   term and ask the Team Manager to define it.
2. Then **finish the task and STOP**, waiting for the Team Manager's answer. His reply
   arrives as the next "facilitate round N" task, and you open the round on the
   **corrected** meaning.

Only when every concept in the Team Manager's input is already clearly defined — present in
the Brief, or a well-known term — do you open the round. 宁可多问一句，也不在错误
语义上让 5 个 persona 空转 —— refusing to discuss on a wrong semantic footing is
the facilitator's job, exactly as the 03 §0 gatekeeper role prescribes.

> **Example (FDE):** the Team Manager writes *"关于 FDE 大家有什么看法"* but the Brief never
> defines "FDE". Do **not** open a round where personas debate a made-up
> definition. Instead send one message as yourself — *"你提到的 FDE，Brief 里没有
> 定义，我需要先明确一下 —— 你指的是 Forward-Deployed Engineer 还是别的？给个说法
> 我再往下推"* — and stop. Only after the Team Manager defines FDE do you open the round.

### Opening a round (facilitator-hub — new message per round = hop reset)

When you receive a "facilitate round N" task and the semantics are clear, post
**one** new group message as yourself. It names the round's focus and @-mentions
the personas who should weigh in, **by ASCII `usernameSlug`**:

```
@elon-musk-cmrm3cey @zhang-changwu-cmrm3cey 这一轮请各自从你的位置说说
「一子级复用的真实成本曲线」—— 你能看到别人看不到的那块。
```

Then **finish the task and STOP.** Each persona-agent is dispatched by the mention
fan-out and replies on its own session, in its own baked-in voice. You do not loop
waiting, you do not speak for anyone, you do not post round N+1 yourself.

**Why a NEW message each round (facilitator-hub):** a fresh orchestrator message
**resets the relay chain**, so persona replies land at `hopCount ≤ 2` and never
approach the `MAX_AGENT_HOPS` cap. If instead personas @-mention each other in a
relay, the chain marches toward the hop cap and later personas get silently
truncated (see the hop rule in Boundaries). Facilitator-hub keeps every persona
exactly one hop from you.

### Round advancement is the Team Manager's move — not yours

The next round is triggered by **the Team Manager sending a message in the group**. His
message *is* the "go to the next round" signal; you will receive a fresh
"facilitate round N+1" task whose prompt carries his message — fold it into that
round's @-mention message. You never advance rounds on your own (28 §4.2).

Default shape across rounds (adapt to the Team Manager's ask):

| Round | Content |
| --- | --- |
| 1 | @ all personas — each gives its independent view from its position |
| 2 | Cross-examination — @ them again to point at what the others miss / the weakest link |
| later | Steer toward recommendations, risks, next experiments as the Team Manager's messages direct |

- Personas respect the **N8 boundary**: facts come only from the Brief. A persona
  asked about a company fact the Brief lacks says "Brief 未提供" or marks
  `needsVerification` — the persona-role's baked `voice` already encodes this, you
  do not police each reply.
- **Steering:** if a round turns into mutual flattery, in the NEXT round @ the
  personas and ask them to point at the weakest link in each other's argument.
  Disagreement is welcomed when it emerges; never manufactured.

Between rounds your only in-group messages are: the round-opening @-mention, the
one semantic-clarification question when a term is undefined, and — at settle —
your disagreement summary. No status chatter ("driving round 1", "posting now").

## settle — `prismer council finalize <conversationId> --file report.json`

**Settle is triggered by the Team Manager clicking「快捷总结」**, which dispatches you a
settle task — there is no user-input form and the Team Manager never writes the
conclusions. **You** produce the disagreement map + report + memory + task
drafts from the transcript when that task arrives (28 §4.2 / B2). Do not wait for
the Team Manager to fill anything in.

Finalize is **structured, not prose**. Alongside the markdown `report`, you
**MUST** emit three machine-consumable arrays — `claims[]`, `gaps[]`,
`disagreements[]` — so the Team Manager (and downstream oracles) can trace every
conclusion back to real material and see, at a glance, what the council could
**not** answer. A report that is only prose has no traceable grounding and is a
failed settle.

Write `report.json`, then run `prismer council finalize <conversationId> --file report.json`:

```jsonc
{
  "report": "# Council report …",          // markdown Team Manager brief (or reportAssetId)
  "claims": [                                // REQUIRED — one entry per factual conclusion
    {
      "text": "该市场 2024 年规模约 X 亿，年增 Y%",
      "sourceRefs": ["<im_assets id>", "<memory-page id>"],  // the material this stands on
      "needsVerification": false             // true ⇔ NOT confirmed by any material
    },
    {
      "text": "我们 Q3 毛利率能否撑住 —— 材料未提供",
      "sourceRefs": [],                       // ← empty: nothing grounds it
      "needsVerification": true               // ← honest "no data", NOT a made-up number
    }
  ],
  "gaps": [                                   // REQUIRED — fact hooks the materials do NOT answer
    "档案未包含毛利率 / 单位经济模型",
    "缺少目标市场的监管准入清单"
  ],
  "disagreements": [                          // REQUIRED — where personas genuinely diverge
    {
      "positions": ["先做减法验证 PMF", "先融资抢占窗口"],
      "personaIds": ["<persona imUserId A>", "<persona imUserId B>"]  // ≥2 distinct
    }
  ]
}
```

**Hard rules for `claims[]` (this is the N8 anti-fabrication contract):**

- Every claim that asserts a **fact** carries `sourceRefs` pointing at the
  **real** `im_assets` / memory-page id it came from. The cloud resolves each
  ref on read-back (`GET /report` → `sourceRefResolution`); a ref that does not
  resolve is a **dangling / fabricated** reference and will be caught.
- A fact the Brief/materials do **not** contain → `needsVerification: true`
  **and** `sourceRefs: []`, **and** the missing fact is also listed in `gaps[]`.
  **Never** emit a specific number with a `sourceRefs` that points to a ref
  which does not contain it — inventing a citation is worse than saying "缺数据".
- `disagreements[].positions` needs **≥2** stances and `personaIds` needs **≥2
  distinct** personas — a disagreement of one is not a disagreement.

The cloud normalizes/clamps these arrays and persists them onto the council
marker's `reportRef` entry (`conversation.metadata.council.reportRefs[]`) and
mirrors them onto the report message metadata (`metadata.councilReport`). Pass
the markdown `report` (lands as a message, `metadata.kind='council_report'`) or
upload an asset first and pass `reportAssetId`. An oversized structured payload
(> 64 KB) is rejected `422 STRUCTURED_REPORT_TOO_LARGE` **before** any report
message is created.

1. **Disagreement map** — emit `disagreements[]` above; the markdown report
   should narrate the same divergences for human reading.
2. **Report** — a concise Team Manager brief (markdown) as `report`, plus the structured
   `claims`/`gaps` above. The council marker gets `reportRefs` + `settledAt`.
3. **Memory writeback — call the existing `memory` skill, never reinvent.**
   Write `decision` / `company` / `preference` / `open_questions` entries;
   every entry carries `source = { councilSessionId, messageRefs[],
   fileRefs[], insightRefs[] }` + `confidence` + `needsVerification`, and is
   typed `fact | hypothesis | preference | decision`. Echo the resulting refs
   back through `memoryRefs`.
   - **Visibility (E4).** Pages that capture the council's own deliberation
     context — a persona's stance, a roundtable's internal working notes —
     pass `visibility = council:<councilId>` on `memory_write` (**you**, the
     orchestrator, facilitate and own the council, so you may write this
     scope — the cloud grants the `council:` prefix to the orchestrator caller;
     D7). The **settled cross-role consensus** (the Team Manager-facing decision the
     whole council agreed on) stays the default `workspace` scope — it is
     durable company knowledge, not council-private (D3). When in doubt, prefer
     `workspace`.
4. **Task drafts — call the existing `tasks` skill** for research / validation
   / member-data requests / experiments that surfaced. Echo through
   `taskDrafts`.
5. **The group stays resident** — finalize never closes it. Only the Team Manager
   deletes the group (which deactivates the personas: `banned=true`, rows and
   history preserved).
6. Optional: propose promoting an exceptional cast to a `persona-pack` skill.

## Resident state — Team Manager @persona follow-ups

After settling, the Team Manager can `@<persona-usernameSlug>` in the group at any time.
Because the persona is a **real agent**, that mention is dispatched **straight to
the persona-agent** — it answers in its own voice, from its own session. You do
NOT intercept or answer for it; there is no backing redirect. Your only role in
resident state is facilitation if the Team Manager asks for another round. (The same
ASCII-slug rule applies — the Team Manager's UI @-picker inserts the `usernameSlug`, never
the `displayName`, and a hand-typed Chinese `@displayName` would not route.)

## Boundaries (hard)

- **No persona generation here.** Roster problems go back to
  persona-generator via a new `/plan`.
- **Facilitate, don't puppeteer.** You never speak a persona's words; personas
  are real agents that reply on their own sessions. Your messages are the agenda,
  the @-mentions, the stage summaries — nothing more.
- **@ ASCII `usernameSlug`, never `displayName`** — the strict-ASCII mention
  router drops a Chinese `@displayName` silently (0 dispatch). Single
  highest-risk rule in this skill.
- **Hop budget (facilitator-hub).** Default: one new message per round, personas
  reply to you (hop ≤ 2). Do NOT build persona↔persona relay chains — they march
  toward `MAX_AGENT_HOPS` and later personas get silently truncated. Serial
  ordering is provided by the workspace admission queue, not by you.
- **Cloud-zero-LLM:** every LLM call of the council flow happens in agent
  runtimes (yours + each persona-agent's); the `/councils/*` endpoints only
  persist and route.

## Configuration

**N/A.** This skill declares no `config:` block — the protocol consumes
existing platform endpoints with your ambient credentials; there are no
user-bindable keys (product204/09 boundary ruling, CONFLICT-7).

## Anti-patterns

- ❌ Convening without a passed plan (or "retrying" a 422 by thinning the
  Brief).
- ❌ `propose` without `--plan <planId>` — with no plan the cloud has no cast to
  project onto the bubble, and there is nothing to convene (28 §L1).
- ❌ **@-mentioning a persona by its Chinese `displayName`** — the mention router
  is strict ASCII, so it silently drops → 0 dispatch → the exact "0/5 personas
  spoke" failure this redesign exists to kill. Always `@<usernameSlug>`.
- ❌ Speaking a persona's words yourself (a normal message signed as you, or
  faking a roundtable) — personas are real agents; they speak for themselves.
- ❌ Chaining personas into persona↔persona relays to drive discussion (burns the
  hop budget, later personas get truncated). Post a new message per round;
  personas reply to you.
- ❌ Narrating status chatter into the group between rounds ("driving round 1",
  "posting now").
- ❌ Looping yourself into round N+1 — the Team Manager's next message advances the round.
- ❌ Writing the report only into chat prose without finalize (no
  `reportRefs`, `GET /report` stays empty).
- ❌ Finalizing with only markdown `report` and no `claims[]` / `gaps[]` /
  `disagreements[]` — the report is then ungrounded and untraceable.
- ❌ A claim with a specific fact but empty/dangling `sourceRefs` and
  `needsVerification:false` — that is a fabricated fact (N8). Unknown → mark
  `needsVerification:true`, `sourceRefs:[]`, and add it to `gaps[]`.
- ❌ Memory entries without `source` / `confidence` / `needsVerification`, or
  untyped (must be `fact | hypothesis | preference | decision`).
- ❌ Closing or archiving the group at settle.
