---
name: memory-dream
scope: common
role_scope: orchestrator-only
description: |
  Curate the workspace memory wiki as its appointed orchestrator. Trigger on a
  Cloud-scheduled Dream task or a user's direct curation request. Inspect candidates
  for orphan leaves, near-duplicates, stale pages, remote conflicts and oversized
  hubs; browse the graph, cluster leaves into INDEX/hub/leaf structure, maintain
  authored overview prose, split hubs, merge duplicates and verify/report changes.
  Use memory_curate and memory_browse; preserve machine-generated hub TOCs and
  graph-derived INDEX Contents. Orchestrator-only: write verbs reject other actors
  with 403. Follow the body for safe mutation and verification procedures.
applies_to: [hermes, claude-code, codex]
version: 4
---

# Memory Dream — orchestrator-driven consolidation

> **Memory pages are PKF (`.pkf`).** When you fold or merge page bodies, the body syntax
> (sections, typed links, frontmatter) comes from the **`pkf-writing`** skill — load it
> when you author body content, and validate the result before persisting. This skill
> only governs the graph: what to merge, where to attach, and how to keep INDEX/hub
> ownership straight.

> **Candidate boundary.** Dream sees authoritative **Memory Pages**, not “all PKF.” A
> message-inline PKF or Library `.pkf` Asset remains outside this loop. Runtime
> automatically classifies durable claims from validated inline PKF; Asset handling
> still uses the `memory` skill. Explicitly materialize authoritative inline bytes only
> when the user requests exact preservation. Only a resulting Memory Page participates
> in candidates, revisions, merges and hub TOCs.

You are (when appointed) the **workspace memory orchestrator**. Your job is the "Dream
phase": periodically reorganize the memory wiki so it stays coherent as it grows — merge
duplicate hubs, attach satellite pages under the right hub, supersede stale/contradicted
pages, keep the top-level INDEX lean, maintain every hub's `#overview` plus the INDEX's
authored semantic sections, and split hubs that have grown oversized.

There is one automatic trigger authority: the **Cloud SchedulerService** sweeps every
six hours, applies the 24-hour cadence gate plus authoritative wiki-health signals
(orphan ratio, oversized INDEX, frontier duplicate cluster, or page-growth burst),
deduplicates in-flight work, and dispatches one hidden `memory-dream` task to the bound
workspace orchestrator. The Cloud performs no Memory LLM reasoning. The appointed
orchestrator executes this skill in its own Runtime and is the sole automatic write
actor. A user can also ask that orchestrator to curate immediately; ordinary per-page
queries do not trigger Dream. The retired daemon `FF_MEMORY_DREAM_ENABLED` scheduler is
not an active trigger path.

> **Authority gate.** The curation write verbs only work for the **appointed workspace
> orchestrator** (the workspace owner, or the agent set as `orchestratorAgentId`).
> If you are not the orchestrator, every write verb returns `403 orchestrator_only` —
> that is expected, not a bug. Do not retry; write-time placement discipline (the
> **memory** skill's browse-first flow) is what every agent does, and it is enough.

**Owner vs orchestrator vs deputy (product209/16 MA-2):**

- The **owner** (human) and the **appointed orchestrator**
  (`orchestratorAgentId`) are the only Dream write actors. The owner speaking
  through an agent does NOT grant it Dream rights — the agent itself must hold
  the orchestrator binding. Dream never back-derives authority from "the owner
  is talking to me".
- A **deputy** does NOT inherit Dream from its bound member — not even when
  the bound member is the owner. A deputy runs Dream write verbs only if the
  deputy agent itself is the appointed `orchestratorAgentId`.
- `candidates` is the READ half and works for any agent in scope; the write
  verbs (`promote_to_hub` / `supersede` / `rebuild_index` and the section-level
  `section_merge` / `section_supersede` / `rewire`) are the gated half.
- `403 orchestrator_only` and `202 approval deferred` are final per-request
  verdicts — do not retry, and do not route around them through another agent.

## The verbs

```
memory_curate(op="candidates")                        # READ what needs work (any agent)
memory_curate(op="candidates", kind="orphans")        # one surface; limit caps per kind
memory_browse(query="<topic>")                        # READ the structure: {index, hubs[+snippet], nearest}
memory_curate(op="promote_to_hub", pageId="<id>",
              childPaths=["<path>", …])               # leaf → hub AND attach children (orchestrator only)
memory_curate(op="supersede", pageId="<id>",
              reason="merged into <path>")            # archive + mark stale (orchestrator only)
memory_curate(op="rebuild_index")                     # regenerate hub TOCs; INDEX Contents stays graph-derived (orchestrator only)
memory_curate(op="section_merge", pageId="<winnerPageId>",
              targetSection="<winnerSlug>", sourcePageId="<loserPageId>",
              sourceSection="<loserSlug>",
              mergedContent="<merged body>")          # fold ONE near-duplicate section (memory211 W5)
memory_curate(op="section_supersede", pageId="<pageId>",
              section="<slug>")                       # retire ONE section in place (memory211 W5)
memory_curate(op="rewire", linkId="<linkId>",
              toPageId="<id>")                        # re-point a broken/wrong link (memory211 W5)
```

- `candidates` is the READ half: `{candidates:{orphans,duplicates,stale,conflicts,oversized}}`
  — unplaced leaves (no outgoing `child-of`/`parent` edge to a live hub; an INDEX
  `index-anchor` only guarantees reachability and therefore still counts as flat), near-duplicate clusters
  (`duplicate_cluster:<peerIds>`), stale pages, remote-conflict pages, and oversized
  hub/INDEX advisories (`kind="oversized"` — size is recorded, never machine-enforced;
  splitting is YOUR call). It does NOT cluster or decide; that is YOUR LLM's job.
- **`promote_to_hub` takes `childPaths[]`** — pass the member pages' paths (exactly as
  candidates/browse returned them) and the cloud attaches them under the new hub as
  `child-of` children **in the same call**. Do not promote a hollow hub and re-anchor
  members one by one afterwards.
- `rebuild_index` is the ONLY **hub** `#toc` writer. It emits a complete strict PKF
  `<section>` with stable `data-sid`, one navigation entry per graph child and the
  child's frontmatter `description`. Structural `child-of` remains child→hub in the
  graph; downward TOC links are navigation, never inverted placement edges. Hub
  `<h2 id="overview">` prose is agent territory and survives rebuild.
- Top INDEX is different: its Contents is derived live from the graph and there is no
  stored machine `#toc` to rebuild or edit. Its authored semantic sections are the
  orchestrator's editorial territory.
- **Section verbs (memory211 W5)** — the granularity drift happens at SECTION level, so
  curation does too. `section_merge` rewrites the winner's section with `mergedContent`,
  splices the loser section out of its page, and the CLOUD writes the
  `supersedes` + `derived-from` provenance edges for you — a merge with no edge trail is
  an unfinished merge. `section_supersede` retires one section (optionally pointing at the
  surviving one). `rewire` fixes a single broken/wrong link without a page rewrite.
- There is no `run_dream` cloud-LLM op — `candidates` (read) + the write ops are
  the whole surface (memory203/13 §0.5: all memory LLM runs in your runtime, never the
  cloud's).

Enactment is the native `memory_curate` TOOL (the same tool surface every agent already
holds, alongside `memory_search` / `memory_load` / `memory_browse` / `memory_write`). Do
NOT look for a separate "memory-dream tool" or shell — `memory_curate` IS the enactment
surface. (A `prismer memory curate …` CLI exists for shell contexts; the TOOL is primary.)
If a curate response is `degraded:true`, no authoritative Cloud mutation occurred;
report the degraded state and never describe the requested convergence as completed.

## The convergence loop (keep it tight)

Run the loop end-to-end in a handful of calls — `memory_browse` gives you the whole
structure in ONE call, so you never need long exploratory search/load spelunking:

**STEP 1 — READ the candidates.**

```
memory_curate(op="candidates")
# → { ok:true, candidates: {
#      orphans:    { items:[ {pageId, path, reason:"orphan"}, … ], total },
#      duplicates: { items:[ {pageId, path, reason:"duplicate_cluster:<peerIds>"}, … ], total },
#      stale:      { items:[ {pageId, path, reason}, … ], total },
#      conflicts:  { items:[ {pageId, path, reason:"remote-conflict",
#                             metadata:{…, latestTwoVersionSummaries}}, … ], total },
#      oversized:  { items:[ {pageId, path, reason:"oversized:toc_entries,body_chars",
#                             metadata:{bodyChars, tocEntries, softThresholds, advisory:true}}, … ], total } } }
```

**STEP 1b — REVIEW the conflicts.** `memory_curate(op="candidates", kind="conflicts")`
lists pages whose current head landed via a remote-conflict LWW merge (two devices
diverged); each item carries the latest two version summaries (changeSummary /
authoredBy / createdAt) so you can judge which side won. For each one, confirm the
head is correct — `memory_load` it and check the LWW winner didn't clobber the better
content; if it did, `memory_write` the corrected body. Conflict is a STATE, not a
brand: a curation touch or clean rewrite of the page clears it (an identical-content
rewrite is a no-op and does NOT), so a reviewed page drops off this list on the next
`candidates` read.

**STEP 1c — REVIEW the oversized hubs.** `memory_curate(op="candidates",
kind="oversized")` lists hubs whose body chars or stored TOC entry count exceeds the
advisory soft thresholds, plus INDEX advisories based on its authored body size (its
Contents is graph-derived). These are **split suggestions, never enforcement** — a
lean hub (overview + TOC) keeps every multi-hop recall fast. For a hub with too many
children, split by sub-topic: pick the natural anchor leaf of each sub-cluster,
`promote_to_hub` it WITH its `childPaths`, and the moved children drop out of the
parent's TOC on the next rebuild. A hub that is oversized because its overview prose
grew into an essay: move the essay's durable content into a leaf under the hub and
shrink the overview back to a summary. Use your judgment — an advisory you deliberately
leave alone (and say so in the report) is a valid outcome.

**STEP 2 — BROWSE the structure.**

```
memory_browse(query="<dominant candidate topic>")
# → { index, hubs:[{path,title,pageType,snippet}], nearest:[…] }
```

One call shows you which hubs already exist and what each is about — decide whether a
candidate cluster belongs under an EXISTING hub (attach, don't mint a duplicate hub) or
needs a new one. Spot-check individual members with `memory_load` only where the title
is ambiguous; do not load every page.

**STEP 3 — DECIDE clusters (your LLM — this is the point).** Group the orphan leaves by
topic. A cluster is a set of leaves that genuinely share one topic and deserve a single
hub above them. For duplicate clusters, decide:

- Same topic, one is a clear superset → **merge** (fold content, supersede the loser).
- Adjacent but distinct → **link, don't merge** (write with `relation="related"` or a
  typed `<a rel="related">` with a canonical href) — merging distinct facts loses recall
  precision.
- Ambiguous / high-stakes → **do not enact**; leave it for human review. When unsure,
  prefer leaving two pages over deleting one.

**STEP 4 — ENACT per cluster: promote WITH children.**

```
memory_curate(op="promote_to_hub",
              pageId="<id of the cluster's natural anchor page>",
              childPaths=["project/helios-billing.pkf",
                          "project/helios-db-choice.pkf",
                          "project/helios-deploy.pkf", …])
```

One call: the anchor becomes a hub AND every member is attached under it as a child.
For a cluster that belongs under an EXISTING hub (found in STEP 2), don't promote —
attach the members to that hub (`memory_write` the member with
`parentHubPath="<existing hub path>"`; use `op="append-section"` rather than a
full-page rewrite when touching someone else's page). For merge losers and garbage:
`memory_curate(op="supersede", pageId="…", reason="…")`.

**STEP 5 — REBUILD hub navigation once per batch.**

```
memory_curate(op="rebuild_index")
```

Each touched hub's strict PKF `#toc` regenerates with child descriptions. The top INDEX
Contents changes automatically because it is a live graph projection—no INDEX body
revision is minted. Leaves that now have a hub parent drop out of the flat top level.

**STEP 6 — MAINTAIN authored prose (your editorial duty).** After the structure settles,
read the INDEX and touched hubs. Refresh each hub's `<h2 id="overview">` and any stale
authored INDEX semantic section. Reuse the loaded section's existing `data-sid`; for a
new section, run `pkf_mint_sids`, then `pkf_validate` on the complete resulting page
before persisting. Section-operation content is a complete `<section>…</section>`:

```
memory_write(
  path="project/helios.pkf",
  op="rewrite-section",
  section="overview",
  content="<section><h2 id=\"overview\" data-sid=\"<reuse-or-minted-sec-id>\">Overview</h2><p>Helios is the Q3 billing replatform —
  auth, billing and deploy decisions live here; the postmortems under it record why
  rate limits were re-tuned twice. Start at <a href=\"<canonical href from browse>\"
  rel=\"references\">the API spec</a>.</p></section>")
```

A hub you just promoted has no overview yet — `op="append-section", section="overview"`
seeds it. Never touch the `#toc` section while you are in there.

**STEP 7 — VERIFY and REPORT.** Call `memory_curate(op="candidates")` again — the
orphans you clustered should be gone. Then **report the structural changes in your
reply**: which hubs you created/promoted, how many children each absorbed, what you
superseded and why, which overviews you wrote/refreshed, which oversized advisories you
split or deliberately left, and the before→after orphan count. A convergence run that
ends without a structural report is unverifiable.

### Worked example — 8 scattered `project/helios-*` leaves → one hub

`candidates` returns 8 orphan leaves hanging off INDEX directly (`project/helios-auth.pkf`,
`project/helios-billing.pkf`, `project/helios-db-choice.pkf`, `project/helios-deploy.pkf`,
`project/helios-api-spec.pkf`, `project/helios-rate-limits.pkf`, `project/helios-oncall.pkf`,
`project/helios-postmortem-0420.pkf`).

```
# 1-2. read candidates + browse — no existing helios hub, all 8 are one topic
memory_curate(op="candidates", kind="orphans")
memory_browse(query="helios project")

# 3. decide: ONE cluster; helios-auth is the natural anchor

# 4. promote the anchor WITH the other 7 attached in the same call
memory_curate(op="promote_to_hub", pageId="<id-of-helios-auth>",
              childPaths=["project/helios-billing.pkf", "project/helios-db-choice.pkf",
                          "project/helios-deploy.pkf", "project/helios-api-spec.pkf",
                          "project/helios-rate-limits.pkf", "project/helios-oncall.pkf",
                          "project/helios-postmortem-0420.pkf"])

#    the 0420 postmortem is superseded by a newer incident page → archive it
memory_curate(op="supersede", pageId="<id-of-helios-postmortem-0420>",
              reason="merged into project/helios-auth#incidents")

# 5. rebuild once — hub #toc regenerates; INDEX Contents follows the graph live
memory_curate(op="rebuild_index")

# 6. seed the new hub's overview (the machine never writes this prose)
memory_write(path="project/helios-auth.pkf", op="append-section", section="overview",
             content="<section><h2 id=\"overview\" data-sid=\"<minted-sec-id>\">Overview</h2><p>Helios project knowledge —
             auth is the anchor; billing/db/deploy/api-spec/rate-limits/oncall hang
             under it. The 0420 postmortem is archived into #incidents.</p></section>")

# 7. verify: orphans 8 → 0 for this topic; REPORT the delta in your reply
memory_curate(op="candidates", kind="orphans")
```

Result: the derived INDEX Contents shows one described hub entry instead of 8 bare leaves; the facts
are reachable `INDEX → hub → leaf`, and the hub opens with prose that says what lives
there. The flat star collapsed into a readable tree — in ~7 tool calls.

## Folding content on a merge

When one page absorbs a true duplicate: copy any durable fact the survivor lacks into
the survivor's matching section (`memory_write` with `op="append-section"` /
`op="rewrite-section"` — never a whole-page rewrite of a page another agent authored;
the section body follows `pkf-writing`), then `supersede` the loser with a reason naming
the survivor's path. The loser is archived, not hard-deleted — it stays for audit and
redirect.

## Stop conditions

- Enact only **clear** merges; one ambiguous call left un-enacted is better than one
  wrong merge that destroys recall.
- Batch a handful of clusters, `rebuild_index` ONCE, verify, report, stop. Do not loop
  the whole graph every tick — Dream is incremental.
- Never hand-write a hub `#toc`; `rebuild_index` is its only writer. Never store an
  INDEX TOC copy—the reader derives Contents. Hub overviews and authored INDEX semantic
  sections are your editorial territory.

## Anti-patterns

- ❌ Promoting a hollow hub (no `childPaths`) and then re-anchoring members one at a
  time — pass the children in the promote call.
- ❌ Hand-writing `child-of` links inside a HUB pointing down at leaves — `child-of`
  edges point FROM the child TO the hub; the structural params get this right for you.
- ❌ Hand-editing a hub `#toc`, or creating a stored INDEX `#toc`; declare edges +
  `rebuild_index`. Leaving hubs with no overview prose is its own anti-pattern.
- ❌ Treating message-inline/Asset PKF as a Dream candidate before it becomes an
  authoritative Memory Page.
- ❌ Whole-page-rewriting another agent's page to fold in one fact — append a section
  (`op="append-section"`).
- ❌ Treating an `oversized` advisory as an order — it is a split *suggestion*; splitting
  a coherent hub just to satisfy a threshold destroys navigability. Judge, then report.
- ❌ Merging two pages because they share a topic word — they may carry distinct facts.
  Read them first; merge only clear duplicates.
- ❌ Hard-deleting. You `supersede` (reversible archive), never destroy.
- ❌ Running the whole graph every tick. Dream is incremental: a handful of clear
  merges, one rebuild_index, verify, stop.
- ❌ Enacting an ambiguous/high-stakes merge. Leave it for human review; Dream cannot
  reconstruct a wrongly-merged page.
- ❌ Retrying a `403 orchestrator_only` — you are not the appointed orchestrator; that
  is correct, not an error.
- ❌ A deputy assuming Dream rights because its bound member is the owner — the
  deputy agent itself must be the appointed `orchestratorAgentId`.
- ❌ Ending a convergence run without reporting the structural delta (hubs created,
  children attached, pages superseded, orphan count before→after).
