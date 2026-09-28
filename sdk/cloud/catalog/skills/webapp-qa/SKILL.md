---
name: webapp-qa
scope: common
description: Perform scoped exploratory QA of a web application, reproduce defects, collect screenshots and console evidence, and deliver a prioritized report.
license: MIT
metadata:
  nativeReplaces: [dogfood]
  upstream: Hermes Agent skills/software-development/dogfood at 1a1f4a59e2
---
# Web Application QA

For the full five-phase exploratory method, read references/dogfood/GUIDE.md;
its taxonomy and report-template links resolve within this bundle.

Use the user-supplied target URL, scope and existing test accounts. Inspect the
available browser tools or Playwright setup first; never invent browser tool
names. Without a working browser, report the blocker and limit claims to checks
actually performed.

1. Map the main user journeys, navigation, forms and error/empty states.
2. Exercise each journey with positive and negative inputs. Inspect console and
   network failures after navigation and significant interactions.
3. Inspect screenshots at desktop and mobile sizes for clipping, overlap,
   loading failures and keyboard accessibility.
4. Reproduce each suspected defect. Record URL, exact steps, expected/actual
   behavior, console evidence and screenshot file. Separate application bugs
   from unavailable dependencies or test-environment failures.
5. Deduplicate, prioritize by user impact, and use references/issue-taxonomy.md
   plus templates/dogfood-report-template.md as report structure.
6. State tested, untested and blocked areas. Passing HTTP status alone is not a
   passing user journey. Never fill missing evidence with plausible descriptions.
7. Attach the report and requested evidence as task-bound assets using the
   actual platform delivery contract. Do not invent flags or use MEDIA markers.

Use a task-owned local fixture for browser-tool smoke tests before touching a
live account. Record desktop/mobile viewport, keyboard, console, clipping and
positive/negative form results independently; a fixture does not certify the
user's real application.

Keep test mutations within the user's authorized scope. Do not submit real
payments or send external messages as incidental QA actions.
