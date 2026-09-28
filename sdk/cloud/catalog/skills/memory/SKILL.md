---
name: memory
scope: common
aliases:
  - memory-curation
metadata:
  nativeReplaces: [llm-wiki]
description: Persist and retrieve agent memory across sessions — recall via the three-stage protocol (structure route → semantic search → navigation fallback), read via memory_load, see the wiki structure via memory_browse, write well-placed pages via memory_write (including section-level append/rewrite), maintain via memory_curate. Use whenever the user asks to remember/forget something, when you need to look up past decisions or context, or when episodic state matters beyond the current turn. Primary surface is the NATIVE memory_* tools (a `prismer memory` CLI appendix exists for code agents running in a shell).
---

# Memory

For an explicitly requested Markdown wiki artifact, read
`references/llm-wiki/GUIDE.md` relative to this skill. Its schema, provenance,
contradiction and lint workflow operates only in the user-selected project/vault;
it does not replace the platform memory tools or create a default home wiki.

Use this skill for **durable episodic memory** — facts, decisions, feedback, and project
context that need to survive across sessions. Memory has four canonical types: `user`,
`feedback`, `project`, `reference`. Pages live at semantic paths and are organized as a
wiki: an `INDEX.pkf` at the top, **hub** pages per topic, and **leaf** pages under hubs.

**Richness is the goal.** A memory page should be complete enough that a future session
works FROM the page instead of re-reading the raw file or the internet. There is no
length budget on ordinary pages — the only waste is *repetition* (re-extracting what is
already distilled, re-querying pages already in your context).

> **Seam — memory content is PKF; the write invariants are embedded below.** The full
> body syntax (sections, data views, media, math, harness), validation and projection
> belong to the **`pkf-writing`** skill, but this skill carries the MANDATORY write
> invariants inline (see *PKF body standard* below) so a write is safe even when
> `pkf-writing` is not loaded. **This skill decides WHAT to remember, WHERE it goes, and
> HOW the graph is maintained.**

## Recall protocol — three stages, in order

Answer a workspace-knowledge question by walking these stages. Stop at the first stage
that answers it; never skip straight to guessing.

**STAGE 1 — STRUCTURE ROUTE (first round is hybrid).** The first round of any recall is
**hybrid — two calls in the same round**, never one instead of the other:

- **Parameterless `memory_browse`** — the root structure surface: `{index,
  hubs[{path,title,pageType,snippet,updatedAt}], hubsByRecent[], nearest[]}`. Hub order
  has two views: `hubs[]` is the **structural order** (the order the workspace
  publishes; today hub rows are ordered by the hub's own `updatedAt` DESC — that IS the
  structural-order baseline); within a hub, its children come `updatedAt` DESC. Each hub
  row carries **subtree freshness** — `updatedAt` = the most recent write under that hub
  (the hub row's own `updatedAt` spread with its direct children's). `hubsByRecent[]`
  repeats the **same hub set in recency order** (subtree `updatedAt` DESC) — the "what
  changed" signal; the two orders differ exactly when a child page was written more
  recently than its hub row. **There is no `memory_recent` tool** — recency is a signal
  ON browse results, not a query surface. Hubs are *routing* pages: their job is to tell
  you which leaf to open.
- **Batch `memory_search`** — extract ≥2 phrasings of the turn's terms into `queries[]`
  (≤8, returned grouped in `resultsByQuery`): one round trip, several recall intents.
  When the turn has no lexical terms ("what changed recently?", "what's the team up
  to?"), the batch **degrades but still runs** — the signal query executes anyway.

**Both question types are covered in one round.** Term-bearing questions are covered by
the batch search; termless questions have exactly the structure surface as their search
space — term extraction necessarily spins empty on them, so the root browse is what
catches them.

**Exemption — one, and tight: the digest names the answer.** The stable memory map
(INDEX-TOC + one line per hub) injected at turn start under "Memory Map (auto — stable
digest)" lets you skip the hybrid round ONLY when it **names the answer outright** — the
exact hub or page the answer lives in, loadable directly. **A passing one-line mention
is NOT coverage**: if the digest only mentions the hub or topic, the hybrid first round
still runs. Structural facts the digest itself states (which topics exist, what a hub
covers, where a topic's children live) are answered from the map, and `memory_browse`
with the topic as `query` serves follow-up structure questions on demand.

**STAGE 2 — SEMANTIC SEARCH (the hybrid round's hits).** The batch `queries[]` leg
answered the term-bearing side; its hits are your **decision payload** — hop-decision
fields tell direct-read vs multi-hop, and the browse-root live structure (including its
recency signals) tells where to wander next. Read each hit's hop-decision fields before
deciding what to do:

| Field | What it tells you |
|---|---|
| `tier` | `wiki` = distilled/curated page (highest trust); `asset` = a raw span a distilled page already cites via `derived-from` (middle); `raw` = the upload's own text, no synthesis (lowest — verify before relying on it) |
| `hubPath` | the hub this page hangs under — a `wiki` hit is context for its whole hub, so a near-miss here often means the ANSWER is a sibling leaf |
| `childrenCount` | how many pages fan out under this hit (>0 ⇒ it is a hub you can walk down) |
| `outboundPreview` / `inboundLinkCount` | where the page points / how linked it is — the cheap next hop |
| `sectionAnchor` + `sectionPreview` | the exact section that matched — read THAT, not the whole page |

`memory_search` returns **ranked hits with lexical evidence** (the query matched the
page). A high-rank `wiki` hit is usually the answer; `memory_load` the page (or just the
`#section`) when the snippet is not enough.

**STAGE 3 — NAVIGATION FALLBACK (miss).** When your wording matched nothing — or only
grazed unrelated pages — the response carries **`navigation`** instead of a longer hit
list:

```
navigation: { reason: 'text-miss',
              startPoints: [{ path, title, pageType: 'index'|'hub', childrenCount, why: 'structural-entry' }],
              guidance: '…' }
```

`startPoints` are **starts, not answers** — there is no rank among them, so never read
them as scored hits and never quote one as the answer. They are the workspace's routing
entries (INDEX + hubs, children-rich first). Walk them:

1. **Look at the children** of the start point closest to your topic (`memory_browse`
   with the hub as `query`, or `memory_load` the hub — its TOC lists its children).
2. **Batch-read the candidates**: one `memory_search` with the candidate topics as
   `queries[]`, or `memory_load` each page. Load the section, not the whole page, when
   the TOC gives you an anchor.
3. **Follow links** (`memory_load` returns the page's `links`) until a page actually
   carries the answer.

If the walk finds nothing, the knowledge does not exist yet — say so, and consider
writing it (see *Write flow*) rather than answering from thin air.

## Tool surface (native tools — your primary interface)

| Tool | What it does |
|---|---|
| `memory_search {query, queries?, limit?, pageType?}` | Semantic/FTS recall + batch; ranked hits with the hop-decision payload, or `navigation` start points on a miss |
| `memory_load {uri?, path?}` | Read one page (or one section via `#anchor` in the uri) → `{page, content, links}` — `links` are the page's outbound graph edges |
| `memory_browse {query?}` | **See the structure BEFORE writing** → `{index, hubs[{path,title,pageType,snippet,updatedAt}], hubsByRecent[], nearest[]}` |
| `memory_write {path, content, title?, parentHubPath?, relation?, op?, section?}` | Create, extend, or section-edit a page; `parentHubPath` attaches it under a hub; `op="append-section"` / `op="rewrite-section"` + `section` edit ONE section (see *Write flow*) |
| `memory_curate {op, ...}` | Maintenance verbs — see the **memory-dream** skill (write ops are orchestrator-gated) |

<!-- GENERATED:tool-params:start -->
<!-- ⚠️ GENERATED BLOCK — do not hand-edit. -->
<!-- Regenerate: npx tsx scripts/memory211/generate-memory-tool-contract.ts -->

Parameter names below are EXACTLY what the tools accept (trailing `*` = required).

- **`memory_search`**: `query*` · `queries[]` · `limit` · `sourceWorkspaceId` · `pageType[]`
- **`memory_load`**: `uri` · `workspaceId` · `sourceWorkspaceId` · `path`
- **`memory_browse`**: `query`
- **`memory_write`**: `path*` · `content*` · `title` · `parentHubPath` · `relation` (child-of|related) · `op` (replace|append-section|rewrite-section) · `section` · `visibility`
- **`memory_curate`**: `op*` · `pageId` · `childPaths[]` · `reason` · `kind` · `limit` · `section` · `targetSection` · `sourcePageId` · `sourceSection` · `mergedContent` · `supersededByPageId` · `supersededBySection` · `linkId` · `toPageId` · `toPath` · `toSection`

<!-- END GENERATED BLOCK -->
<!-- GENERATED:tool-params:end -->

`web_load` (the workspace URL loader) also accepts `prismer://asset/…` and
`prismer://…/file/…` URIs — when a memory page points at an asset, load the asset
on demand through it instead of asking the user to re-attach the file.

## PKF carrier → Memory: automatic durable distillation, explicit exact copy

**PKF is the content format, not a fourth carrier.** A valid PKF report remains
authoritative in its message-inline block or Library Asset. For message-inline delivery,
the Runtime passes the validated PKF source and its Markdown projection into the normal
post-turn Memory classifier automatically: durable conclusions are distilled through
the same browse-first placement flow, while transient report content yields no Page.
Do not ask the user for a second format choice and do not exact-copy the report merely
because it is PKF. Dream still reads authoritative **Memory Pages only**.

- **Distill durable knowledge (normal path):** inline PKF enters the Runtime post-turn
  classifier automatically; explicit Asset handling or user-requested writes extract only
  surviving conclusions through the browse-first `memory_write` flow — typed source
  pointer, never the whole report.
- **Preserve the exact inline PKF as Memory (exception):** only when the user explicitly
  wants those exact bytes as the Memory authority — `cloud pkf materialize` (message/block
  revision, source hash, explicit `.pkf` path, idempotency key, `--confirm-path`); no
  native `memory_*` shortcut, no generic Asset→Memory exact-copy. Read back the receipt;
  exact-copy is an exceptional authority transition, not the searchability path.

Once either route creates/updates a Memory Page, curation operates on that Page's graph,
revisions and PKF body—not on its former carrier.

## Deliverable adoption — copy + reference (memory211 轴A)
A deliverable YOU produced this turn gets an immediate three-way decision: extend the existing page at section granularity, attach a new leaf under the best hub, or SKIP — skipping is a first-class outcome (a one-off answer is not knowledge). Deliverable-derived pages follow the **copy + reference** doctrine: they may carry the source's near-full content so a future session works FROM the page instead of re-opening the asset, and they MUST carry the typed references — exactly ONE `<a rel="derived-from" href="prismer://asset/<assetId>">` pointer, section-anchored `<a rel>` edges, and the source's own vocabulary (proper nouns, codes/numbers, thresholds verbatim) so a paraphrase of the source is still findable. There is no length budget: token usage is recorded, never constrained. Pass `deliverableSource: {assetId, contentHash, sizeBytes}` on `memory_write` — the gate enforces the pointer (422 `deliverable_pointer_missing`), short-circuits a same-deliverable replay as a dedupe-hit, and routes an oversized source to sharding (422 `sharding_required`) instead of one giant page. `memory_search` an existing topic first and extend/supersede any page whose pointer cites a prior revision, never fork.

## Sharding — one page per 64K characters (memory211 §6.9)

A **source over 64K characters** never becomes one page, and a distilled **page stays
under 64K characters**. The write gate rejects an oversized page with
422 `sharding_required`; the ingest pipeline plans the split for you (one structural
**index page** above a run of **shard pages**, `shards/<stem>/shard-000.pkf` …, boundaries
on content edges). The reference chain is mandatory and is what keeps a shard set
navigable:

```
index page  --derived-from-->  the source asset
shard page  --child-of------>  the index page
```

Write one page per shard (same copy + reference rules), then the index page with its
TOC. Never merge shards back into a single giant page.

## When to use

- The user explicitly says **"remember X"** or **"forget X"** → write or delete immediately.
- The user references a past decision, preference, or detail you don't have in current context → recall first (three-stage protocol above).
- **Before answering anything about workspace knowledge you did not just read, run
  the hybrid first round — batch `memory_search` + parameterless `memory_browse`.**
  Attached files are raw sources — check memory for existing
  distilled knowledge before re-reading them. A memory hit is cheaper and already
  synthesized; fall back to the raw asset only when memory misses (`tier: 'raw'` tells
  you that you are reading the source, not the synthesis).
- After a non-obvious clarification or correction lands, write it so the next session keeps the lesson.
- After you read/ingest a document and extract durable conclusions, **persist them as a
  placed page in the same turn** — don't leave the knowledge only in your reply.

## Path convention

Paths are workspace-relative and **prefix-free** — do NOT add a leading `memory/`:

```
decisions/llm-provider.pkf              ← a leaf under the decisions topic
projects/desktop-202/decisions.pkf      ← nested topic path
reference/platform.pkf                  ← a hub page
```

The platform-owned onboarding seed uses reserved `memory/onboarding/...` paths; that is
not a pattern for agent-authored pages. Always reuse an existing returned seed path
verbatim if you extend one.

When extending or linking to an existing page, **use its path exactly as returned by
`memory_browse` / `memory_search`** — never re-derive or hand-normalize a path you saw
elsewhere. Path drift (adding/dropping a `memory/` prefix, guessing `.pkf` suffixes) is
the top cause of dead links and dropped edges.

## Write flow (browse-first)

Writing memory is **browse → decide placement → write → verify**. Never write blind.

**STEP 1 — CONSTRUCT.** Extract the durable knowledge from the conversation and author
the page body in full (via `pkf-writing`: frontmatter with its one-sentence
`description` + sections + any rich content). Don't write a path-shaped stub.

**STEP 2 — BROWSE.** Call `memory_browse` with your topic as the query.

**STEP 3 — DECIDE placement** from what browse returned — exactly one of:

- **(a) A page on this topic already exists** (in `nearest`) → **you MUST extend it,
  never fork a near-duplicate page.** Decide at *section* granularity:
  - the page has a section whose topic matches your fact → merge into that section
    (`op="rewrite-section"` with that section's id);
  - the page matches but has no section for this fact → add one
    (`op="append-section"` with a new section id).
- **(b) It fits under an existing hub** (in `hubs`) → write a **new leaf attached to that
  hub**: pass the hub's path as `parentHubPath`.
- **(c) Genuinely new topic** (no hub fits) → first create the topic **hub page** (type
  `hub`, a short `#overview` "what this topic covers" body), then write the leaf with
  `parentHubPath` pointing at your new hub.

**NEVER write an orphan leaf** — a new page with no hub attachment that extends nothing.
The platform rejects an unanchored new leaf with a `placement_required` error listing
the available hubs; if you see that error, re-browse and attach — do not retry verbatim.

**STEP 4 — WRITE** with the placement declared structurally, and **validate the body via
`pkf_validate` BEFORE persisting** (authoring loop from `pkf-writing`).

`memory_write` is a mutation: a response containing `{"ok":true}` means that revision
has already been written. For the same fact/path, **do not call `memory_write` again in
this turn** to polish, reformat, or “make sure”; that creates another authoritative
revision. Continue to STEP 5 and use the read surface for verification.

**STEP 5 — VERIFY (optional but cheap).** Use `memory_load` on the exact returned path
(or `memory_search` a key phrase) and confirm it comes back. Verification is read-only;
never rewrite a successful revision merely to verify it. Then report path + placement +
one-line description to the user.

## PKF body standard (embedded — MANDATORY)

Full syntax lives in the single-file `pkf-writing` SKILL.md; these five invariants a write must never violate:

1. **REQUIRED frontmatter `description` (one sentence)** — in the PKF frontmatter block alongside `type` (`user|feedback|project|reference`), `title`, `pkfVersion "1.1"`; the description feeds previews/TOC — never omit it (frontmatter 写法见 `pkf-writing` skill)。
2. **Typed links target what actually exists** — copy hrefs VERBATIM from `memory_browse`/`memory_search`/`memory_load` or asset resolver results, never hand-type; `child-of` points FROM child TO hub.
3. **`pkf_validate` BEFORE `memory_write` — every time** — repair ALL errors, then persist (the write gate rejects invalid v1.1 bodies anyway).
4. **Browse-first + append governance** (your operating directive's rules) — extend an existing page at section granularity (`op="append-section"`/`op="rewrite-section"`); new pages attach under a hub (`parentHubPath`); never orphan leaves or whole-page-rewrite another agent's page.

5. **Evolution artifacts declare their kind (memory211/10 §2.1)** — a body written by a
   **dream / proposal / frontier / ingest** leg (not by a human, and not by you writing a page
   someone asked for) must carry the metadata as a **top-level `memory` key in the frontmatter script**
   (the parser files it under `extra.memory` — write `memory`, not `extra`; writing `{"extra":{"memory":…}}`
   lands in `extra.extra.memory` and is read as *no block at all*):
   `<script type="application/prismer+json">{"type":"note","title":"…","description":"…","memory":{"memoryRole":"knowledge|procedure|action_result","source":"<where this came from, in words a human can read>"}}</script>`.
   `memoryRole` is a routing fact, not a label — `knowledge` is the target of self-directed recall,
   `procedure` is what the first-round mixed browse hits, `action_result` is delivered by event
   trigger. `source` is the provenance a human uses to decide whether the page may be deleted; an
   artifact whose origin cannot be stated is one nobody can responsibly retire. Per-section
   declarations go in `memory.sections[]`, indexed by `anchor` — **each entry carries its own
   `memoryRole` + `source`** (an entry missing either is rejected, same as the page-level block):
   `{"anchor":"renewal","memoryRole":"procedure","source":"<…>"}`. A **hand-written page needs none of
   this** — the gate only applies to the automatic legs. The write gate **rejects** an evolution
   artifact without the metadata (`evolution_metadata_required`) and returns a verdict naming the
   offending field: fix that field and resubmit — never drop the artifact silently.

If a `pkf_validate`-clean body is not achievable, **do not persist it**. Keep the draft in
the current response/working file, report the validation or capability failure, and
leave Memory unchanged; never fake a revision or bypass the write gate.

## Structural edges — how pages relate

Relationships between pages are **graph edges**, not prose. Declare them structurally:

- `parentHubPath` on `memory_write` — attaches the written page under a hub. Default
  `relation` is `child-of`; pass `relation="related"` for a non-hierarchical association.
- `childPaths` on `memory_curate(op="promote_to_hub")` — attaches existing pages under a
  newly promoted hub in one call (orchestrator convergence; see **memory-dream**).
- In-content typed links (rel vocabulary from `pkf-writing`) **with canonical hrefs
  copied from browse/search/load results** are also materialized into edges — fine for
  `supports` / `contradicts` / `related` / `references` / `cites` cross-refs inside
  prose. For hub attachment, prefer the structural parameters.

**Direction matters for `child-of`: the edge points FROM the child TO the hub.**
`parentHubPath` gets this right automatically (the page you are writing is the child).
If you ever hand-write a `child-of` content link, it goes **in the child page's body,
pointing at the hub** — never the reverse. Hubs never declare child-of links.

## INDEX & hubs — ownership is asymmetric

- **Top `INDEX.pkf`:** its authored semantic sections are agent/editor territory. Its
  visible Contents is derived live from the `child-of` graph; Dream does **not** store
  or rewrite an INDEX `#toc`. Change the graph, not a copied list.
- **Hub `#overview`:** agent-owned prose—what the topic covers and how children relate.
- **Hub `#toc`:** machine-owned strict PKF section, regenerated by
  `memory_curate(op="rebuild_index")` from graph membership. Never hand-edit it.

Thus `rebuild_index` is a legacy verb name: it rewrites hub TOCs and refreshes derived
structure, while INDEX Contents remains a read-time projection.

## Extending pages (and other agents' pages) — section ops

To add knowledge to an existing page, **edit at section granularity — do not rewrite the
whole page**. Whole-page rewrites of pages another agent authored create version
conflicts and clobber their content. The section ops splice ONE section cloud-side:

```
memory_write(path="decisions/database-choice.pkf", op="append-section",
  section="revisit-2026-07", content="<section body per pkf-writing>")
```

Default `op` is `replace` (whole page) — reserve it for pages you authored yourself.

## Size discipline (a discipline, not a limit)

- **INDEX and hubs: keep them lean** — overview prose + TOC, nothing else. Every recall
  hop reads them. Nothing enforces this — when a hub outgrows itself it surfaces as a
  `memory_curate(op="candidates", kind="oversized")` split *suggestion*.
- **Ordinary pages: no budget, but a hard ceiling at 64K characters** — above that the
  source must be sharded (see *Sharding*), never squeezed. Rich is right: full tables,
  exact numbers, media pointers, rationale prose.
- **The only token rules are anti-waste:** don't re-extract content that is already
  distilled into a page (extend it instead), and don't re-query pages already in your
  context (circular recall).

## Memory Types

| Type | What it is | When to write |
|---|---|---|
| `user` | Who the user is, role, preferences, expertise | When you learn role/responsibility/preference details that should shape future behavior |
| `feedback` | Approach corrections + validated approaches | After a correction ("don't do X") OR a non-obvious approval ("yes that was right") |
| `project` | Goals, deadlines, decisions, ongoing initiatives | When you learn who/what/why/by-when that isn't derivable from code |
| `reference` | Pointers to external systems (Linear, Slack, dashboards) | When the user names a tool/channel and its purpose |

The type goes in the PKF frontmatter `type` field (the four canonical types above, or an
OKF subtype like `decision`) — the exact frontmatter shape is taught by `pkf-writing`.

## Operating Rules

### Write

- **Follow the browse-first flow** above. Never write an orphan leaf, never guess a path.
- **Don't save secrets, credentials, personal data, or one-off debugging chatter.**
- Don't save **generic programming advice** that isn't tied to this project.
- Don't save **ephemeral task state** (in-progress work, current-conversation context).
- Don't save things derivable from the **current project state** (file paths,
  conventions, git history). Reading the code is authoritative.
- Don't save things already in **CLAUDE.md**.
- **Always rich, always validated**: body authored per `pkf-writing`, `pkf_validate`
  passes before `memory_write` (a v1.1 invalid body is rejected at the write gate).
- For `feedback` and `project` types, include a **Why** section and a **How to apply**
  section so future-you can judge edge cases.
- Convert relative dates to **absolute dates** before writing.
- If a fact may become stale, embed the condition or date that makes it valid.

### Read / Recall

- Follow the **three-stage recall protocol** above: structure route → semantic search →
  navigation fallback. Never re-derive structure the injected digest already answered.
- On a miss, read `navigation.startPoints` as **routing**, never as results, and walk
  them (children → batch read → links). Do not quote a start point as an answer.
- Treat recall results as **leads, not evidence**. `tier` tells you what kind of lead:
  `wiki` is curated, `raw` is somebody's upload — verify a `raw` hit before relying on it.
- `memory_load` returns the page's outbound `links` — follow them to navigate the graph.
- **No circular recall:** pages already in your context are known — do not re-query them.
- Don't let memory **override explicit current user instructions** — trust the current
  input and update or remove the stale entry.
- Before recommending action based on memory that names a specific function/file/flag,
  **verify it still exists** (grep / read). Memory is frozen in time.
- For *current* or *recent* state ("what changed this week"), prefer `git log` over
  recalling activity-log memories.

### Delete / Maintain

- When updating an outdated memory, **prefer extending/editing** over deleting + rewriting.
- When the user says "forget X", search first, confirm the match, then delete. Don't
  silently fail if recall finds nothing — tell the user.
- **Consolidation / Dream** (merge duplicates, promote hubs, rebuild hub TOCs,
  maintain overviews, split oversized hubs) is a separate, orchestrator-gated
  capability — see the **memory-dream** skill. Do not consolidate from this skill.

## Authority & role boundaries (product209/16 MA-2)

Memory reads/writes are adjudicated per request by the workspace Memory
authority. The verdict you receive is final for that request:

- **owner (human)** — full authority: decides cross-scope approvals (202
  deferrals), grants read / read+write ACLs; curate and replicate rights
  originate here.
- **orchestrator (appointed agent, `orchestratorAgentId`)** — may curate the
  shared graph (promote / supersede / rebuild — see **memory-dream**). It does
  NOT automatically pierce member/deputy private scopes.
- **deputy** — represents exactly its active bound member (a human principal).
  Its authority IS the member's — never the owner's, never the workspace's.
- **member / member's deputy** — own private pages + workspace-shared pages;
  cannot read or curate another member's private pages.
- **unbound specialist** — has NO owner/member mapping. Only a live
  role/task/council scope grants reads; outside that scope, expect deny.

Outcome discipline:

- **`403 deny`** — final for this request. Do NOT retry verbatim, do NOT ask
  another agent to read the target for you.
- **`202 approval deferred`** — the request waits on the data owner. Do NOT
  re-issue it; the approval record already exists and re-submitting spams the
  owner.
- **local replica states** (`suspended` / `reconciling` / `stale` / authority
  lease expired) — local reads fail closed until the replica reconciles.
  Retry after reconcile; a fail-closed read is never "memory is empty".

Role templates do not automatically grant a human principal: an agent whose
role mentions curation still needs the appointed orchestrator binding before
`memory_curate` write verbs succeed.

## Anti-patterns

- ❌ **Re-reading a raw file or the internet when memory already distills it.**
- ❌ **Circular recall** — re-querying pages already in your context.
- ❌ **Counting a one-line digest mention as covered** — the exemption is the digest
  naming the exact hub/page that answers; anything less runs the hybrid first round.
- ❌ **Duplicate extraction** — writing a near-duplicate page when browse/recall showed
  an existing page on the topic. Extend it (`append-section` / `rewrite-section`).
- ❌ **Copying an Asset/inline PKF body into a page just because it is PKF.** Distill
  durable knowledge, or use explicit exact inline materialization when requested.
- ❌ **Hand-editing a hub's `#toc`** or storing a duplicate INDEX TOC.
- ❌ Orphan leaves, guessed paths.
- ❌ Whole-page-rewriting a page another agent authored — section ops exist; use them.
- ❌ Persisting a body that failed `pkf_validate` (the write gate will reject it anyway
  — fix the diagnostics instead of retrying verbatim).
- ❌ **Reading `navigation.startPoints` as a ranked answer** — they are routing entries;
  the answer comes from walking them.
- ❌ **Squeezing an oversized source into one page** — shard it (422 `sharding_required`
  is the gate telling you so), never truncate the knowledge to fit.

## Output reporting

After writing memory, echo the path, type, placement (which hub it attached under, or
which page/section it extended), and one-line description back to the user so they can
verify what got persisted.

After recalling, list match titles + paths + scores; do **not** paste full page content
unless the user asks — follow up with `memory_load` for any specific hit. If you
navigated from `navigation.startPoints`, say which start point led to the answer.

## CLI appendix (code agents in a shell)

Code agents (claude-code / codex / opencode) running in a shell can use the `prismer
memory` CLI — workspace + identity default from the agent env, output is JSON:

```bash
prismer memory recall "what database did we choose?"   # = memory_search
prismer memory search --queries '["q1","q2"]'          # batch recall, one call (daemon cuts at 8 + flags `truncated`)
prismer memory read "decisions/database-choice.pkf"    # = memory_load (also path#section)
prismer memory load-batch <path1> <path2> ...          # up to 10 pages in one call, per-path verdict
prismer memory list --page-type hub                    # hub listing
prismer memory write --path "<path>" --content '<PKF>' # = memory_write (content also via stdin)
prismer memory delete <pageId>
```

`prismer memory curate` carries the maintenance verbs (`candidates`, `promote-to-hub
--child-paths`, `supersede`, `rebuild-index`) plus the section-level ones
(`section-merge`, `section-supersede`, `rewire`) — `--help` lists each command's flags.

> The CLI currently lags the native tools on browse (`memory_browse` has no CLI
> subcommand yet), so on the shell surface decide placement with
> `list --page-type hub` + `recall`. Every OTHER write parameter exists on the CLI
> under its kebab-case name.

## Backing capabilities (D22 mapping)

Replaces these v1.x built-in skills: `memory-read`, `memory-write`, `memory-recall`.
Compatibility alias: `memory-curation` (old slug/skillId/ACK resolves to this skill —
one canonical delivery).
