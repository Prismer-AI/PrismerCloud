---
name: browser-use
scope: common
description: LLM-driven browser automation via the pre-installed browser-use library (chromium already in the image). Use whenever the task needs to interact with web pages beyond a single fetch — multi-step navigation, form filling, clicking, scrolling, structured data extraction, screenshots, or tasks the plain web tools can't complete. Runs as a Python script against the built-in chromium; LLM goes through the Prismer gateway (no external LLM key needed).
---

# Browser-Use (Web Automation)

The sandbox image ships `browser-use` (installed in `/home/user/.venv`) and a full
chromium build (playwright). This skill drives them: write a short Python script
with `Agent(task=..., llm=..., browser=...)`, run it, report the result.

## When to use

- Multi-step web tasks: search → open → extract → compare → download
- Form filling / login flows / clicking through pages
- Structured extraction (tables, listings, prices) that a single fetch can't parse
- Screenshots / visual confirmation of a page state
- Anything needing JS-rendered content (SPA pages the fetch tools miss)

For a single plain fetch, prefer the existing web tools (lighter). Reach for
browser-use when they come back empty or the task is interactive.

## How to run

```bash
# chromium executable (version dir may change — resolve dynamically):
CHROME="$(find /home/user/.cache/ms-playwright -name chrome -type f | head -1)"

# LLM = our gateway (OpenAI-compatible). PRISMER_BASE_URL / PRISMER_API_KEY
# are already in the environment; never hardcode them in the script.
cat > /tmp/bu_task.py <<'PY'
import os, asyncio
from browser_use import Agent, ChatOpenAI, Browser

async def main():
    llm = ChatOpenAI(
        base_url=f"{os.environ['PRISMER_BASE_URL']}/api/v1",
        api_key=os.environ['PRISMER_API_KEY'],
        model=os.environ.get('PRISMER_MODEL', 'deepseek-v4-flash'),
        temperature=0.0,
        # REQUIRED for the Prismer gateway: browser-use defaults to forcing
        # JSON-schema structured output (response_format=json_schema) which
        # our upstream models reject with 400 "response_format type
        # unavailable" (verified 2026-08-07). Disable it; the agent still
        # extracts via its normal flow.
        dont_force_structured_output=True,
    )
    browser = Browser(
        headless=True,
        executable_path=os.environ['CHROME'],
    )
    agent = Agent(
        task="<TASK>",  # be specific: steps, URLs, what to extract, output format
        llm=llm,
        browser=browser,
    )
    history = await agent.run(max_steps=30)
    print("RESULT:", history.final_result())
    print("URLS:", history.urls())
    print("ERRORS:", history.errors())
    await browser.close()

asyncio.run(main())
PY
CHROME="$CHROME" /home/user/.venv/bin/python /tmp/bu_task.py
rm -f /tmp/bu_task.py
```

## Task-writing rules (from browser-use docs)

- **Be specific**: `"Go to https://…, use extract with query 'first 3 quotes and their authors', save to quotes.csv via write_file"` — open-ended tasks fail.
- **Name actions**: "use search action for …", "use click to open first result in a new tab", "use send_keys with 'Tab Tab Enter'" — the agent maps these to its built-in tools.
- **Error recovery**: if navigation is blocked, fall back to a search engine; if a click fails, use keyboard navigation (`send_keys`).
- **max_steps**: default 100; keep 30 for focused tasks, raise for long flows.
- **Anti-bot**: if a page blocks automation, try `use_cloud=True` — NOT available here (no Browser-Use Cloud key). Fall back to search/cache.

## Environment facts

| Item | Value |
| --- | --- |
| Python | `/home/user/.venv/bin/python` (browser-use installed here) |
| Chromium | `$(find /home/user/.cache/ms-playwright -name chrome -type f \| head -1)` |
| LLM | Prismer gateway (`PRISMER_BASE_URL` + `PRISMER_API_KEY`, OpenAI-compatible) |
| Model | `PRISMER_MODEL` env (default `deepseek-v4-flash`) — adjust for the task |
| Telemetry | browser-use collects anonymous telemetry by default — set `ANONYMIZED_TELEMETRY=false` |

## Output contract

Report to the user: `history.final_result()` (the extracted answer), the URLs
visited, and any errors. If `history.is_successful()` is False, say so plainly
with `history.errors()` — do not invent a completion. Attach screenshots
(`history.screenshot_paths()`) as task assets when they matter.
