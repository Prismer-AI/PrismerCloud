---
name: research-arxiv
scope: common
category: research
description: "Search arXiv papers by keyword, author, category, or ID."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  nativeReplaces: [arxiv]
  upstream: Hermes Agent skills/research/arxiv at 1a1f4a59e2
  hermes:
    tags: [Research, Arxiv, Papers, Academic, Science, API]
    related_skills: [office-artifacts, evidence-citations]
---

# arXiv Research

Search and retrieve academic papers from arXiv via their REST API. No API key.
Use the shipped Python 3.9+ standard-library script relative to this installed
skill directory, not a hardcoded Hermes repository path:

```bash
python3 "<skill-dir>/scripts/search_arxiv.py" "GRPO reinforcement learning" --max 5 --json
python3 "<skill-dir>/scripts/search_arxiv.py" --id 1706.03762v1 --json
```

The script preserves versioned identifiers and full abstracts, bounds response
size and retries transient HTTP errors, and rejects malformed feeds/options.
`unknown` metadata is a coverage gap, not permission to invent dates. Use
`evidence-citations` for quotations and `office-artifacts` for PDFs. Attach only
requested file outputs through `cloud task attach`/`cloud deliver`; honor PKF
carrier instructions for inline answers. Abstract retrieval is not full-paper reading.

## Quick Reference

| Action | Command |
|--------|---------|
| Search papers | `curl "https://export.arxiv.org/api/query?search_query=all:QUERY&max_results=5"` |
| Get specific paper | `curl "https://export.arxiv.org/api/query?id_list=2402.03300"` |
| Read abstract (web) | `web_extract(urls=["https://arxiv.org/abs/2402.03300"])` |
| Read full paper (PDF) | `web_extract(urls=["https://arxiv.org/pdf/2402.03300"])` |

## Searching Papers

The API returns Atom XML. Use an XML parser (the shipped script), not grep/sed.

### Basic search

```bash
curl --fail --silent --show-error --max-time 30 "https://export.arxiv.org/api/query?search_query=all:GRPO+reinforcement+learning&max_results=5"
```

### Clean output

```bash
python3 "<skill-dir>/scripts/search_arxiv.py" "GRPO reinforcement learning" --max 5 --sort date
```

## Search Query Syntax

| Prefix | Searches | Example |
|--------|----------|---------|
| `all:` | All fields | `all:transformer+attention` |
| `ti:` | Title | `ti:large+language+models` |
| `au:` | Author | `au:vaswani` |
| `abs:` | Abstract | `abs:reinforcement+learning` |
| `cat:` | Category | `cat:cs.AI` |
| `co:` | Comment | `co:accepted+NeurIPS` |

### Boolean operators

```
# AND (default when using +)
search_query=all:transformer+attention

# OR
search_query=all:GPT+OR+all:BERT

# AND NOT
search_query=all:language+model+ANDNOT+all:vision

# Exact phrase
search_query=ti:"chain+of+thought"

# Combined
search_query=au:hinton+AND+cat:cs.LG
```

## Sort and Pagination

| Parameter | Options |
|-----------|---------|
| `sortBy` | `relevance`, `lastUpdatedDate`, `submittedDate` |
| `sortOrder` | `ascending`, `descending` |
| `start` | Result offset (0-based) |
| `max_results` | Number of results (default 10, max 30000) |

```bash
# Latest 10 papers in cs.AI
curl --fail --silent --show-error --max-time 30 "https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=10"
```

## Fetching Specific Papers

```bash
# By arXiv ID
curl --fail --silent --show-error --max-time 30 "https://export.arxiv.org/api/query?id_list=2402.03300"

# Multiple papers
curl --fail --silent --show-error --max-time 30 "https://export.arxiv.org/api/query?id_list=2402.03300,2401.12345,2403.00001"
```

## BibTeX Generation

Retrieve structured metadata using `--json`, retaining the complete versioned ID.
Register the inspected abstract/PDF URL and title with `evidence-citations`, then
export its escaped `--style bibtex` entries. For article-specific author/year/
primaryClass fields, use only returned metadata and a BibTeX serializer; leave
missing fields absent rather than inventing a category or author. Compile the
actual bibliography and verify rendered URLs and unresolved-citation warnings.

## Reading Paper Content

After finding a paper, read it:

```
# Abstract page (fast, metadata + abstract)
web_extract(urls=["https://arxiv.org/abs/2402.03300"])

# Full paper (PDF → markdown via Firecrawl)
web_extract(urls=["https://arxiv.org/pdf/2402.03300"])
```

For local PDF processing, see `office-artifacts`. Use an available extraction
tool; these examples do not imply a Firecrawl account or full-text entitlement.

## Common Categories

| Category | Field |
|----------|-------|
| `cs.AI` | Artificial Intelligence |
| `cs.CL` | Computation and Language (NLP) |
| `cs.CV` | Computer Vision |
| `cs.LG` | Machine Learning |
| `cs.CR` | Cryptography and Security |
| `stat.ML` | Machine Learning (Statistics) |
| `math.OC` | Optimization and Control |
| `physics.comp-ph` | Computational Physics |

Full list: https://arxiv.org/category_taxonomy

## Helper Script

The `scripts/search_arxiv.py` script handles XML parsing and provides clean output:

```bash
python3 "<skill-dir>/scripts/search_arxiv.py" "GRPO reinforcement learning"
python3 "<skill-dir>/scripts/search_arxiv.py" "transformer attention" --max 10 --sort date
python3 "<skill-dir>/scripts/search_arxiv.py" --author "Yann LeCun" --max 5
python3 "<skill-dir>/scripts/search_arxiv.py" --category cs.AI --sort date
python3 "<skill-dir>/scripts/search_arxiv.py" --id 2402.03300
python3 "<skill-dir>/scripts/search_arxiv.py" --id 2402.03300,2401.12345
```

No dependencies — uses only Python stdlib.

---

## Semantic Scholar (Citations, Related Papers, Author Profiles)

arXiv doesn't provide citation data or recommendations. The optional **Semantic
Scholar API** provides JSON. Check current endpoint access, authentication and
rate-limit responses; do not assume a fixed public or API-key quota.

### Get paper details + citations

```bash
# By arXiv ID
curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300?fields=title,authors,citationCount,referenceCount,influentialCitationCount,year,abstract" | python -m json.tool

# By Semantic Scholar paper ID or DOI
curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1234/example?fields=title,citationCount"
```

### Get citations OF a paper (who cited it)

```bash
curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300/citations?fields=title,authors,year,citationCount&limit=10" | python -m json.tool
```

### Get references FROM a paper (what it cites)

```bash
curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300/references?fields=title,authors,year,citationCount&limit=10" | python -m json.tool
```

### Search papers (alternative to arXiv search, returns JSON)

```bash
curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/paper/search?query=GRPO+reinforcement+learning&limit=5&fields=title,authors,year,citationCount,externalIds" | python -m json.tool
```

### Get paper recommendations

```bash
curl --fail --silent --show-error --max-time 30 -X POST "https://api.semanticscholar.org/recommendations/v1/papers/" \
  -H "Content-Type: application/json" \
  -d '{"positivePaperIds": ["arXiv:2402.03300"], "negativePaperIds": []}' | python -m json.tool
```

### Author profile

```bash
curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/author/search?query=Yann+LeCun&fields=name,hIndex,citationCount,paperCount" | python -m json.tool
```

### Useful Semantic Scholar fields

`title`, `authors`, `year`, `abstract`, `citationCount`, `referenceCount`, `influentialCitationCount`, `isOpenAccess`, `openAccessPdf`, `fieldsOfStudy`, `publicationVenue`, `externalIds` (contains arXiv ID, DOI, etc.)

---

## Complete Research Workflow

1. **Discover**: `python3 "<skill-dir>/scripts/search_arxiv.py" "your topic" --sort date --max 10`
2. **Assess impact**: `curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/paper/arXiv:ID?fields=citationCount,influentialCitationCount"`
3. **Read abstract**: `web_extract(urls=["https://arxiv.org/abs/ID"])`
4. **Read full paper**: `web_extract(urls=["https://arxiv.org/pdf/ID"])`
5. **Find related work**: `curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/paper/arXiv:ID/references?fields=title,citationCount&limit=20"`
6. **Get recommendations**: POST to Semantic Scholar recommendations endpoint
7. **Track authors**: `curl --fail --silent --show-error --max-time 30 "https://api.semanticscholar.org/graph/v1/author/search?query=NAME"`

## Rate Limits

| API | Rate | Auth |
|-----|------|------|
| arXiv | Space requests by at least 3 seconds; honor server limits | No key for public metadata |
| Semantic Scholar | Honor current service limits and Retry-After | Endpoint/account dependent |

## Notes

- arXiv returns Atom XML — use the helper script or parsing snippet for clean output
- Semantic Scholar returns JSON — pipe through `python -m json.tool` for readability
- arXiv IDs: old format (`hep-th/0601001`) vs new (`2402.03300`)
- PDF: `https://arxiv.org/pdf/{id}` — Abstract: `https://arxiv.org/abs/{id}`
- HTML (when available): `https://arxiv.org/html/{id}`
- For local PDF processing, see `office-artifacts`.

## ID Versioning

- `arxiv.org/abs/1706.03762` always resolves to the **latest** version
- `arxiv.org/abs/1706.03762v1` points to a **specific** immutable version
- When generating citations, preserve the version suffix you actually read to prevent citation drift (a later version may substantially change content)
- The API `<id>` field returns the versioned URL (e.g., `http://arxiv.org/abs/1706.03762v7`)

## Withdrawn Papers

Papers can be withdrawn after submission. When this happens:
- The `<summary>` field contains a withdrawal notice (look for "withdrawn" or "retracted")
- Metadata fields may be incomplete
- Always check the summary before treating a result as a valid paper
