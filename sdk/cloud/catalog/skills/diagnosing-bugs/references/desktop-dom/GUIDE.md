# Desktop DOM and CSS Diagnosis

Adapted from Hermes inspecting-hermes-desktop-dom; this is a supporting method,
not an independent Hermes launch protocol.

## Target and permissions

Inspect the repository's actual Electron harness and startup configuration.
Prismer uses apps/desktop with a prebuilt Vite WorkspaceShell. A web HMR update
does not establish that the desktop renderer was rebuilt. Confirm the running
build, PID, renderer URL and user-data directory before diagnosing stale UI.
Do not assume Hermes dev-cdp.ts, eval.mjs, cdp.mjs, HERMES_DESKTOP_* or port 9222
exist in Prismer. These helpers are not bundled here.

Use the browser/CDP tool already exposed by the host, or an installed Playwright
client connected to a user-authorized loopback CDP endpoint. List /json/version
and /json/list for that exact port; match the renderer URL/title and PID. A port
list is not permission to inspect another window. Never bind CDP publicly.
If no endpoint is available, use the project's real harness in a new isolated
instance with its own task-owned user-data directory and ports. Do not restart,
kill or relaunch the user's app. Report blocked if an isolated harness is absent.

## Read the rendered state

First inspect a screenshot at the target viewport. Then query a narrow selector
from actual DOM evidence. With an existing Playwright Page named page:

```javascript
const facts = await page.locator(selector).evaluate(el => ({
  tag: el.tagName,
  classes: el.className,
  rect: el.getBoundingClientRect().toJSON(),
  display: getComputedStyle(el).display,
  padding: getComputedStyle(el).padding,
  fontWeight: getComputedStyle(el).fontWeight,
  parents: (() => {
    const rows = [];
    let node = el.parentElement;
    while (node && rows.length < 6) {
      rows.push({tag: node.tagName, classes: node.className});
      node = node.parentElement;
    }
    return rows;
  })()
}));
```

Use the matching rule inspector for stylesheet origin/specificity. Inheritance,
plugin styles and state selectors can override local utility classes; do not
edit every call site before identifying the winning rule. Re-read computed style,
geometry and screenshot after the change. Check mobile/desktop dimensions,
keyboard focus, console and network failures. DOM facts do not replace visual QA.

## Evidence and cleanup

Record target identity, build, viewport, selector, expected/actual properties,
the winning rule, screenshot and console errors. Avoid entire DOM dumps or
session content containing secrets. A DevTools marker alone is not a paused
exception: collect the stack and source map for runtime faults.

Poll readiness with a bounded timeout. End only the test processes you started,
detach without leaving the target paused, and preserve task-bound evidence.
Never infer a broken port from an isolated app exiting due to missing backend
configuration. No actual Electron/CDP live acceptance is implied by this guide.
