---
name: web-artifacts-builder
description: Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts.
license: Complete terms in LICENSE.txt
---

## Delivering the bundled artifact

When the bundle script (`scripts/bundle-artifact.sh`) produces the
single-file HTML artifact, deliver that `bundle.html` with **`cloud deliver
<abs-path>`** — this is the one command for a final artifact: it attaches the
file to your current reply. Run `cloud deliver` once per output file. See the
**office-artifacts delivery contract** for the full rules (incl. the hermes
`--run-id` / `--conversation-id` flags).

Do NOT also run `cloud file send` on the same bundle — that posts a *separate*
file-only message, delivering it twice. `cloud file send` is only for ad-hoc
mid-conversation sharing, never for your final deliverable. And `cloud file
upload` is NOT a delivery command (it only uploads bytes and returns an
uploadId — nothing reaches the user) — always use `cloud deliver`.

Do NOT hand-build `POST /api/im/assets` calls or assemble ContentBlock JSON
yourself, and do NOT paste the HTML source into the reply body — large
bundles burn tokens on every downstream turn, and the delivery command
registers the asset so the chat renderer can offer a preview/open button.


# Web Artifacts Builder

To build powerful frontend claude.ai artifacts, follow these steps:
1. Initialize the frontend repo using `scripts/init-artifact.sh`
2. Develop your artifact by editing the generated code
3. Bundle all code into a single HTML file using `scripts/bundle-artifact.sh`
4. Display artifact to user
5. (Optional) Test the artifact

**Stack**: React 18 + TypeScript + Vite + Parcel (bundling) + Tailwind CSS + shadcn/ui

## Runtime baseline (release 201)

The Prismer sandbox image bakes `pnpm@9` and Node 20+, so `scripts/init-artifact.sh`
will skip the "install pnpm" branch and proceed directly to the workspace
create + dependency install. If `pnpm` is genuinely missing (non-sandbox env),
fail the task with a clear "sandbox image missing pnpm — rebuild required"
message rather than installing it on the fly: agent-time `npm install -g`
contaminates the per-task workdir and slows every dispatch.

## Design & Style Guidelines

VERY IMPORTANT: To avoid what is often referred to as "AI slop", avoid using excessive centered layouts, purple gradients, uniform rounded corners, and Inter font.

## Quick Start

### Step 1: Initialize Project

Run the initialization script to create a new React project:
```bash
bash scripts/init-artifact.sh <project-name>
cd <project-name>
```

This creates a fully configured project with:
- ✅ React + TypeScript (via Vite)
- ✅ Tailwind CSS 3.4.1 with shadcn/ui theming system
- ✅ Path aliases (`@/`) configured
- ✅ 40+ shadcn/ui components pre-installed
- ✅ All Radix UI dependencies included
- ✅ Parcel configured for bundling (via .parcelrc)
- ✅ Node 18+ compatibility (auto-detects and pins Vite version)

### Step 2: Develop Your Artifact

To build the artifact, edit the generated files. See **Common Development Tasks** below for guidance.

### Step 3: Bundle to Single HTML File

To bundle the React app into a single HTML artifact:
```bash
bash scripts/bundle-artifact.sh
```

This creates `bundle.html` - a self-contained artifact with all JavaScript, CSS, and dependencies inlined. This file can be directly shared in Claude conversations as an artifact.

**Requirements**: Your project must have an `index.html` in the root directory.

**What the script does**:
- Installs bundling dependencies (parcel, @parcel/config-default, parcel-resolver-tspaths, html-inline)
- Creates `.parcelrc` config with path alias support
- Builds with Parcel (no source maps)
- Inlines all assets into single HTML using html-inline

### Step 4: Share Artifact with User

Finally, share the bundled HTML file in conversation with the user so they can view it as an artifact.

### Step 5: Testing/Visualizing the Artifact (Optional)

Note: This is a completely optional step. Only perform if necessary or requested.

To test/visualize the artifact, use available tools (including other Skills or built-in tools like Playwright or Puppeteer). In general, avoid testing the artifact upfront as it adds latency between the request and when the finished artifact can be seen. Test later, after presenting the artifact, if requested or if issues arise.

## Reference

- **shadcn/ui components**: https://ui.shadcn.com/docs/components