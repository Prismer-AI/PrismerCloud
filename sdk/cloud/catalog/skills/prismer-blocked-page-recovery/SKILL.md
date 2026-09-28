---
name: prismer-blocked-page-recovery
scope: common
description: "Use when a fetch fails: 403/429, paywall, WAF, bot wall."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [ linux, macos, windows ]
metadata:
  nativeReplaces: [ blocked-page-recovery ]
  hermes:
    tags: [ Research, Archives, Wayback, Paywall, WAF, Fallback ]
    related_skills: [ grounded-citations ]
  requiresExplicitGrant: true
---

## Prismer execution contract

This is the uniquely named `prismer-blocked-page-recovery` skill, adapted from Hermes.
Use the actual tools exposed by the executing host; examples using terminal,
process, delegate_task, vision_analyze or browser_* are not tool registrations.
Missing dependencies do not hide this skill. Report command startup, version,
account/permissions and task-specific live verification separately. Use task-owned
artifact paths and existing user authorization; do not change shared accounts,
Runtime/provider configuration, global security settings or unrelated work.
See NOTICE.md and LICENSE for resource provenance. Runtime availability and
upstream-entry suppression are owned by the integration layer.


# Blocked-Page Recovery

When a page won't fetch — 403/429, Cloudflare "Just a moment...", a paywall,
or a bot-detection interstitial — don't give up and don't loop on the same
URL. Third-party services often hold a **copy** of the page. Work down this
ladder, cheapest first.

## The ladder

```
1. Wayback Machine  — archive.org "available" API  (snapshot + timestamp)
2. archive.today    — domain rotation: archive.ph → .md → .li → .is
3. Jina Reader      — only if JINA_API_KEY is set  (live server-side render)
4. API-first pivot  — look for /api/, /graphql, .json, or RSS on the same host
5. Real browser     — browser tool as the last, most expensive resort
```

Resolve SKILL_ROOT to this installed directory and use a task-owned output directory.
Only publicly authorized targets without credentials/query/fragment are accepted;
never submit private URLs or signed links to third parties. DNS is checked for
non-public addresses; this is not a substitute for host egress policy.
Run the three archive/render routes with the bundled script (API/browser are manual):

```bash
python3 "$SKILL_ROOT/scripts/recover_page.py" "https://example.com/blocked-article" --json --out "$TASK_OUTPUT_DIR/candidate.html"
```

The script tries each route in order, validates every body (see "Fake
successes" below), and prints the first candidate with status=candidate, verified=false and recovered=false.
Exit 0 means a candidate exists, not verified recovery. Inspect full saved content,
match expected title/body/source identity, and record that review before citing.
Unrelated large pages cannot be certified by byte length. Existing output files
are never overwritten. The network budget is bounded to 1..120 seconds after DNS;
host DNS/connect behavior still depends on the operating system.

## Provenance discipline (non-negotiable)

Every recovered copy carries a provenance you MUST preserve when citing:

| Route | Provenance | How to cite |
|-------|-----------|-------------|
| Wayback / archive.today | `snapshot` | Cite WITH the snapshot date: "as archived 2026-08-06". Never present a snapshot as the live page — it may be stale. |
| Undated archive | `snapshot-undated` | Preserve final immutable URL; date unknown, do not invent it. |\n| Jina Reader | `live` | Re-render candidate; inspect body identity before citing. |
| Live fetch / browser | `live` | Cite normally. |

If the user needs *current* data (prices, availability, breaking news), a
snapshot is context, not an answer — say so explicitly and note its age.

## Manual routes

### 1. Wayback Machine (best provenance, try first)

```bash
# Discovery: returns closest snapshot URL + timestamp as JSON
curl --fail-with-body -sS --max-time 20 "https://archive.org/wayback/available?url={URL}"
# Then fetch archived_snapshots.closest.url
```

For enumerating many snapshots (or recovering deleted pages), the CDX index:

```bash
curl -sL "https://web.archive.org/cdx/search/cdx?url={URL}&output=json&limit=10"
```

CDX intermittently returns 503 under load — if it does, fall back to the
`available` API; don't retry-hammer it.

Works for: any publicly crawled URL. Fails for: robots-blocked sites,
never-crawled URLs, JS-only SPAs (snapshots don't render).

### 2. archive.today (paywalls, deleted content)

User-submitted archives — often has paywalled news articles Wayback lacks.
Rate-limits aggressively (429) and rotates domains, so iterate:

Use the bounded script, not a curl loop that treats HTTP errors as shell success.
It records the final archive URL and marks dates unknown when they cannot be
verified. Do not bypass its input, output-size and redirect protections manually.

**Validate the body, not the status code** — a 429 still ships several KB of
rate-limit HTML that looks like a success to a size check alone.

### 3. Jina Reader (requires JINA_API_KEY)

`r.jina.ai` re-renders the live page in a real browser server-side and
returns markdown. Anonymous access is dead (401 → Turnstile); a key is
required:

```bash
python3 "$SKILL_ROOT/scripts/recover_page.py" "$PUBLIC_URL" --json --out "$TASK_OUTPUT_DIR/candidate.txt"
```

Handles JS SPAs that archives can't. Skip this route entirely when the env
var is unset.

### 4. API-first pivot

WAFs protect the HTML surface far more aggressively than the data endpoints
behind it. After 2-3 blocked attempts on a site, stop fighting the HTML and
look for:

- `/api/...`, `/graphql`, or `.json` variants of the page URL
- An RSS/Atom feed (`/feed`, `/rss`, `<link rel="alternate">` in any copy
  you did recover)
- A sitemap (`/sitemap.xml`) revealing canonical URLs that may not be gated

## Fake successes — routes that LIE

These return HTTP 200 with a plausible body that is NOT the page. Heuristics reject some of them, but no script result proves page identity. Review each candidate:

- **Google Cache is dead** (since mid-2024). `webcache.googleusercontent.com`
  returns 200 + tens of KB, but it's a Google Search interstitial with a JS
  redirect, not a cache. Never use it.
- **AMP caches** (`*.cdn.ampproject.org`) mostly return a ~300-byte
  `<title>Redirecting</title>` meta-refresh stub pointing back at the
  original (blocked) URL. Treating that as success creates a fetch loop.
- **Rate-limit bodies**: archive.today 429 pages are multi-KB HTML. Check for
  the target's actual content (title words, expected strings), not just size.

Detection heuristics the script applies: body under a per-route byte floor;
meta-refresh/JS-redirect content of any size; HTML and Markdown interstitial
titles ("Just a moment", "Redirecting", "Google Search", "Attention Required").

## Proxy relays: don't

Generic "web proxy" relays are man-in-the-middle by construction. Never send
cookies or Authorization headers through one, and don't use them for anything
the user will rely on — provenance is unverifiable. Prefer archives, which at
least timestamp their copies.
