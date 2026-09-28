---
name: persona-generator
scope: common
description: >
  Given a Council Brief, produce persona-ROLE instance definitions: real,
  publicly-verifiable people who occupy distinct stakeholder positions on the
  issue — each a persona-flavored role template (lens / voice / SOUL + the
  persona-skill capability boundary + icon + an ASCII usernameSlug), handed to
  convene (council-creator) to be instantiated as a REAL agent. (Search
  grounding of each person is done by the cloud /councils/plan handler, not by
  this skill.) Use when the workspace orchestrator needs to convene an expert
  roundtable ("帮我找几个人聊聊这个 idea"). Personas are LENSES distilled from
  public records, not the real people — never assert private facts, never
  impersonate. This skill produces the persona-role DEFINITIONS (who speaks); it
  does NOT create the group and does NOT drive the discussion — that is
  council-creator.
license: MIT
compatibility:
  - prismer-sdk
  - hermes
metadata:
  category: council
  personaPolicy: public_distillation
  disclaimerRequired: true
  allowedUse: [analysis, debate, ideation]
  forbiddenUse:
    - impersonation
    - private_claim
    - legal_advice_without_disclaimer
    - medical_advice_without_disclaimer
    - financial_advice_without_disclaimer
  eval:
    level: generator # eval the GENERATOR against a Brief — never a single persona
    assertions:
      - positions-distinct # N personas occupy N distinct stakeholder positions (no two share one)
      - insider-view-present # ≥1 persona sits where outsiders cannot see
      - no-fabricated-people # every displayName is a real, publicly verifiable person
      - risk-coverage-3plus # cast covers ≥3 risk dimensions (capital/tech/market/org/compliance)
      - grounding-substring # every quote is a substring of a real search snippet (code-checked)
      - brief-boundary # no persona asserts company facts beyond the Brief
      - honest-degradation # ungroundable candidates are dropped; never fabricate quotes
---

# Persona Generator

**Who speaks.** Given a Council Brief (assembled by the orchestrator from the
Team Manager's materials + memory), produce `cast: PersonaDef[]` — 3–5 people occupying
**distinct stakeholder positions**, each contributing the one thing only their
position lets them see. This is a **capability skill**: the orchestrator calls
it to produce data — a set of **persona-role instance definitions**. Each cast
member is a persona-flavored **role template def** (lens / voice / SOUL + the
persona-skill capability boundary + icon + an ASCII `usernameSlug`) that convene
will instantiate as a **real agent** (`createAgentForWorkspace` + `applyToAgent`,
M2). It is **not** a virtual `im_users` mask — persona = role instance.

| Do | Do NOT |
| --- | --- |
| Enumerate stakeholder positions for the issue | Create the council group (council-creator) |
| Pick one **real person** per position | Drive or moderate the discussion (council-creator) |
| Produce `seesWhatOthersDont` per person | Write memory (settle phase, via `memory` skill) |
| Emit voice (per-turn instructions) per person | Parse / extract materials (orchestrator tool-skills) |
| Hand the cast to cloud `/councils/plan` for grounding | Run search verification / supply quotes yourself (cloud does it) |
| Read `droppedCast[]` and substitute for dropped people | Invent people, quotes, or citations — ever |

## Meta-goal (iron rule — supersedes any "debate" framing)

**A discussion is a plurality of viewpoints, not a positive-vs-negative game.**
Convene people of different identities, professions and stakes; each speaks
from their own position. If disagreement emerges it is the *natural result* of
plural perspectives — it is never something you construct. Do **not** hunt for
"an opposing side"; a target function of "construct opposition" structurally
excludes the two most valuable classes of people: **insiders** (dismissed as
same-camp) and **people who reject the axis entirely** (nowhere to stand on
it). The UI language is "讨论组" (discussion group), never "吵一架".

## Core procedure

### Step 0 — List stakeholder positions first (not "axes of disagreement")

Before picking anyone, enumerate the positions whose duty / expertise / stake
touches this issue:

```
运营执行者 / 出资人 / 监管者 / 同行实践者 / 下游客户 / 一线员工 / 被影响的第三方 …
```

### Step 1 — One REAL person per position

- Pick the person whose **real public track record** naturally puts them in
  that position. If no fitting famous person exists for a position (e.g. "this
  company's own CTO"), pick a real person who once held the *equivalent*
  position elsewhere (e.g. another rocket company's former CTO).
- **Never invent a name.** Prefer swapping to a position where a real person
  exists.
- Do **not** require them to disagree with each other. They may all agree and
  still each fill in a piece the Team Manager cannot see.
- **Forbidden:** inserting an artificial "opposing side" to manufacture
  conflict.

For every person you MUST state `seesWhatOthersDont` — not "which side they
are on", but "standing here, they can see X that nobody else at the table
can". This field is the core output of the skill.

### Step 2 — Attach the persona (who arrives at the table)

- Enough verifiable public record and a good fit → **real name**
  (`displayName: "Elon Musk"`, `subtitle: "SpaceX CEO"`). Compliance is
  carried by the **disclaimer**, never by renaming — "Elon-style Strategy
  Lens" style abstractions are forbidden (nobody wants to chat with a
  concept). Internal terms (`persona`, `lens`) never surface in UI copy.
- Otherwise → a role label ("一位持保守立场的航天投资人") — still a person,
  not a concept.
- `usernameSlug` (**load-bearing — this is the persona-agent's @-handle**):
  ascii `[a-zA-Z0-9_-]`, 3–20 chars, lowercase slug of the person (e.g.
  `elon-musk`). It must NOT start with the reserved `prismer-` segment. Final
  uniqueness (`<slug>-<conv8>` + dedupe suffix) is enforced by the cloud at
  convene time — you only produce the candidate slug. **Why it MUST be ASCII:**
  once instantiated (M2), the persona-agent is addressed in the group **only**
  by `@<usernameSlug>`. The mention router (`agent-dispatcher.ts` `MENTION_RE`)
  is strict ASCII — a bare `@中文displayName` matches nothing and is silently
  dropped, so a non-ASCII slug would leave the persona **unreachable** (0
  dispatches, the exact 0/5 failure). The Chinese `displayName` is display-only;
  it never routes.

### Step 2.5 — Search grounding is done by the CLOUD, not by you

You **only produce candidates** — position + real person + `seesWhatOthersDont`
+ candidate `usernameSlug`. **Do NOT run search verification yourself and do NOT
supply any `realCredential` / `whySelected` quotes.** Grounding is performed by
the cloud `/api/im/councils/plan` handler after you hand over the cast.

- **Why cloud, not you (architectural, 04 §2.5):** the anti-fabrication defense
  requires a **verbatim substring of a real search snippet**, checked in code
  against full-text search (`/api/search`). The daemon `web_search` tool you can
  reach routes through `/api/context/load`→`/api/compress`, so it returns
  **LLM-rewritten prose, not the original text** — you physically cannot obtain
  the verbatim snippet the substring check needs. Any quote you write from
  memory would be a fabrication that the cloud check exists to reject.
- **What the cloud does with your cast:** for each candidate it searches
  `"<displayName> <topic terms>"` and requires the person's name + a topic term
  to co-occur **inside the same sentence** ("some results exist" / "snippet
  contains the keyword" passes off-topic celebrities — 04 §2.5 实测:
  李开复+商业航天 returned 5 named-but-off-topic hits). Grounded → the persona is
  kept with `groundingSource='searched'` and verbatim quote evidence. **0
  co-occurrence → the person is dropped from the cast** and returned in the plan
  response's `droppedCast[]` — read it and substitute someone else for that
  position (do NOT patch up the quote).
- **You still MUST NOT invent people.** Pick a real, publicly verifiable person
  for each position (swap positions rather than inventing a name) — but leave the
  evidence to the cloud. Your job ends at "who plausibly sits here"; the cloud
  decides "is this person actually on-topic".
- **`groundingTerms` (optional but recommended for mixed-language topics):** you
  MAY attach a short `groundingTerms: string[]` per candidate — the topic keywords
  in **the language this person's public record is in** (English for "Elon Musk",
  中文 for a 中文人物). The cloud grounds against these instead of naively
  tokenizing the question. Without them, a Chinese question ("2026年商业航天进展")
  tokenizes to CJK bigrams that won't match an English-record person → that person
  is wrongly dropped. So for an English-record person on a Chinese topic, supply
  e.g. `["commercial spaceflight", "launch cost"]`.
- 🚫 **Never use self-critique as fact-checking.** Asked to "verify the
  citations are real", an LLM does not admit it cannot find them — it invents
  a *more specific* fake source ("引自2021年新浪财经专访"). Self-critique is
  allowed only for *structural* checks (two people on one position? invented
  names? missing insider view?), never for factual ones.

### Step 3 — Handle grounding failures (current searched-only contract)

> ⚠️ This tiering is applied by the cloud grounding step, not by you — it is
> shown here so you understand what happens to your candidates. You never set
> `groundingSource` yourself. In the current implementation a candidate that is
> not `searched` is returned in `droppedCast[]` for you to substitute.

The criterion is "**can it be found by search?**" — programmatically checkable
— never "does the model know enough?" (unverifiable; models claim they do).

| Condition | Strategy | `groundingSource` |
| --- | --- | --- |
| Name + topic co-occur in one sentence of a snippet | Use its verbatim substring as the quote | `searched` |
| Not searchable, including user-material-only candidates | Returned in `droppedCast[]`; propose a different verifiable candidate or ask for a changed roster | not accepted |
| No candidate can be verified | Stop the proposal and explain the missing evidence; do not fabricate personas | not accepted |

`user_materials` and `role_label` are not current accepted fallback tiers.
Do not set either yourself or claim the cloud accepted them. A conceptual
role-label discussion can be separately requested, but is not this real-agent
council workflow. Never fabricate quotes to keep a famous name.

### Step 4 — Icon acquisition (cloud-executed; you only reference the result)

Icon fetching and cropping run as **pure code on the cloud** (Serper image
search → Content-Type + magic-bytes double gate → aspect-ratio cull only
(0.6 ≤ ar ≤ 1.7, never re-rank by squareness — Google's own ranking encodes
"this is the standard portrait") → **top-edge square crop**, no face-detect).
Your responsibility is only to carry the resulting `iconAssetRef` (an
`im_assets` id) into the PersonaDef, or `null` when nothing usable was found —
the frontend degrades to a monogram. Never inline image bytes or hotlink URLs.

### Step 5 — Voice

`voice` = the persona-role's speaking instructions (markdown): the position,
speaking style, and disclaimer discipline. Because persona is now a **role
instance** (not a mask), `voice` — together with lens and a SOUL 特例档 — is what
convene bakes into the persona-agent's role template at instantiation, so the
agent speaks in-character from its **own** session (no one plays five roles).
Write voice as durable, self-contained instructions the standalone agent can
carry across turns, not one-off remarks. At convene time the cloud persists it
onto the persona-agent so later `@<usernameSlug>` follow-ups reuse it.

## Output shape (wire contract — aligns with `POST /api/im/councils/plan` cast)

```jsonc
{
  "cast": [
    {
      "id": "elon-musk",                  // slug — also the personaId in council metadata
      "displayName": "Elon Musk",         // REAL name; compliance rides the disclaimer
      "subtitle": "SpaceX 创始人兼 CEO",   // who this person IS — from primary sources only
      "usernameSlug": "elon-musk",        // ascii @-handle 3-20, no 'prismer-'; cloud dedupes — the ONLY way to reach this persona
      "iconAssetRef": null,               // im_assets id from the cloud icon service, or null
      "position": "同行实践者（已量产的商业航天创始人）",
      "seesWhatOthersDont": "复用一子级的真实成本曲线与产线爬坡节奏",
      // ⚠️ Do NOT supply realCredential / groundingSource — the cloud fills these
      //    from live search after grounding (step 2.5). Omit them from your output.
      "voice": "Speak as a first-principles propulsion founder. Terse. Numbers first. 你是公开资料蒸馏的视角，非本人；Brief 未提供的公司事实一律说「Brief 未提供」。",
      "disclaimer": "公开资料蒸馏视角，非本人"
    }
  ]
}
```

No `stance` field (the meta-goal is plural viewpoints, not sides). No `lens`
field (a stance is the runtime product of `facts × issue`, not a stored
attribute). Input: `{ brief, requestedPersonas?, n? }` (default n = 3–5).

## Iron principle: persona = lens, Brief = facts (负控 N8)

A persona **never carries company facts of its own**. Everything about the
company comes from the Council Brief the orchestrator assembled. If a persona
is asked to assert a company fact the Brief does not provide, it must say
"Brief 未提供" or mark `needsVerification` — never improvise. This is the
architectural cure for "stylized bubbles making things up", not a disclaimer.
Bake this discipline into every `voice` you emit.

At settle, `council-creator` turns this discipline into a **wire contract**: the
report's `claims[]` each carry `sourceRefs[]` (the real material a fact stands
on) + `needsVerification`, and unanswerable facts land in `gaps[]`. So your
`voice` must instruct the persona to speak in **grounded, attributable claims**
— tie each factual statement to the Brief fact it uses, and say "缺数据" (→
`needsVerification=true`, `sourceRefs=[]`) rather than inventing a number, so
council-creator can emit an honest structured report downstream.

## Generator-level eval

Eval judges the **generator** (input: a Brief; assertions over the cast as a
set), never a single persona. Code-enforceable oracles are the two grounding
checks (substring + same-sentence co-occurrence); the set-level assertions
below are eval judgements (semantic classification):

| Assertion | Criterion |
| --- | --- |
| Positions distinct | N personas occupy N different stakeholder positions; no two share one |
| Insider view present | ≥1 person sits where outsiders cannot see (operator / front-line / former insider) |
| No fabricated people | every `displayName` is real and publicly verifiable (`realCredential` non-empty) |
| Risk coverage | cast covers ≥3 of: capital / tech / market / org / compliance |
| Grounding real | every quote is a snippet substring + same-sentence co-occurrence (code check) |
| Brief boundary | no persona asserts company facts beyond the Brief |
| Honest degradation | unsearchable → `droppedCast[]`, substitute or stop; never fabricate a quote |

## Promote escape hatch

An exceptionally good cast can be saved as a **`persona-pack` skill** (static
snapshot, `metadata.category: council`, `personaPolicy: public_distillation`,
`disclaimerRequired: true`) and published to the marketplace for fork / rate /
compose. This is a third, non-default path — the default is always fresh
generation against the current Brief.

## Configuration

**N/A.** This skill declares no `config:` block. Grounding credentials
(search API keys) live cloud-side as Nacos global config consumed by the
`/api/im/councils/plan` handler and `/api/search` — they are never
agent-bound, so there is nothing for the skill-config binding system to carry
(product204/09 boundary ruling, CONFLICT-7).

## Anti-patterns

- ❌ Inventing a person because a position "needs" someone famous (the
  documented failure: `Will Smith` as Relativity's CEO — the real CEO is Tim
  Ellis). Swap positions instead.
- ❌ Filling the cast with five competitor CEOs (letting competitors judge
  your valuation) — that is the retired adversarial framing.
- ❌ Writing quotes from memory, or "verifying" them by self-critique.
- ❌ Renaming a real person into a concept ("工程激进视角") to dodge
  compliance — the disclaimer carries compliance.
- ❌ Emitting `stance` / picking a side for anyone.
- ❌ Creating the group, posting messages, or driving rounds — hand the cast
  to council-creator.
