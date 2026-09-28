---
name: prismer-gif-search
scope: common
category: media
description: "Search/download bounded GIFs from Tenor using a
  credential-redacting Python helper."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [ linux, macos, windows ]
prerequisites:
  env_vars: [ TENOR_API_KEY ]
  commands: [ python3 ]
metadata:
  nativeReplaces: [ gif-search ]
  hermes:
    tags: [ GIF, Media, Search, Tenor, API ]
  requiresExplicitGrant: true
---

# GIF Search (Tenor API)

Search and download GIFs through the bundled Python standard-library helper. Existing GIF discovery is distinct from generating a GIF.

## When to use

Useful for finding reaction GIFs, creating visual content, and sending GIFs in chat.

## Setup

Inject TENOR_API_KEY through the authorized task environment; do not write it to a shared home or log it:

```bash
TENOR_API_KEY=your_key_here
```

Obtain a key through the official Tenor workflow; check the current account quota and terms, rather than assuming historical pricing.

## Prerequisites

- Python 3 (standard library only)
- `TENOR_API_KEY` environment variable

## Search for GIFs

```bash
# Search and get GIF URLs
python3 scripts/tenor.py 'thumbs up' --limit 5

# Get smaller/preview versions
python3 scripts/tenor.py 'nice work' --limit 3
```

## Download a GIF

```bash
# Search and download the top result
python3 scripts/tenor.py celebration --limit 1 --output new-celebration.gif
```

## Get Full Metadata

```bash
python3 scripts/tenor.py cat --limit 3
```

## API Parameters

| Parameter | Description |
|-----------|-------------|
| `q` | Search query (helper uses structured URL encoding) |
| `limit` | Max results (1-50, default 20) |
| `key` | API key (from `$TENOR_API_KEY` env var) |
| `media_filter` | Filter formats: `gif`, `tinygif`, `mp4`, `tinymp4`, `webm` |
| `contentfilter` | Safety: `off`, `low`, `medium`, `high` |
| `locale` | Language: `en_US`, `es`, `fr`, etc. |

## Available Media Formats

Each result has multiple formats under `.media_formats`:

| Format | Use case |
|--------|----------|
| `gif` | Full quality GIF |
| `tinygif` | Small preview GIF |
| `mp4` | Video version (smaller file size) |
| `tinymp4` | Small preview video |
| `webm` | WebM video |
| `nanogif` | Tiny thumbnail |

## Notes

- URL-encode the query: spaces as `+`, special chars as `%XX`
- For sending in chat, `tinygif` URLs are lighter weight
- GIF URLs can be used directly in markdown: `![alt](url)`

The helper rejects redirects/non-Tenor media, non-200 status, MIME mismatch, oversized data and malformed GIF headers. It never logs the credential or overwrites an existing output. Run under the task's process timeout; inspect/decode the returned GIF before delivery because header checks alone do not prove every frame is valid.
