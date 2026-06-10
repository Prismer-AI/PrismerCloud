# Evolution Studio v2 — surface-agent contract

This is the contract for the **4 parallel surface agents** who fill in the
section bodies (release201/28 §4 + Phase P1-P5). The shared base layer (shell,
rail, types, url, authoring-events, mock, i18n, design.ts grammar) is **owned by
the base builder — do not edit those files**. You only replace the body of your
section's stub file, keeping its **file path and export name unchanged**.

Truth sources: `docs/release201/28-evolution-studio-frontend-redesign.md` +
`docs/release201/proto/evolution-studio.html` (pixel/motion truth) +
`docs/release201/12-observability-surface.md` §8.8.

---

## 1. Sections → grammar → accent → stub file → export

All in `SECTION_GRAMMAR` (`./types.ts`). Read it; don't hardcode the accent.

| Section | Grammar (`design.ts`) | Accent | Stub file (replace body, keep path+export) | Export | Phase |
|---|---|---|---|---|---|
| `create` | `workshop` (steering variant) | `amber` (+ brand violet primary) | `creator/creator-surface.tsx` | `CreatorSurface` | P1 |
| `roster` | `map` | `indigo` | `roster/roster-surface.tsx` | `RosterSurface` | P3 |
| `lifecycle` | `pipeline` | `cyan` | `lifecycle/lifecycle-surface.tsx` | `LifecycleSurface` | P3 |
| `installed` | `shelf` | `violet` | `installed/installed-surface.tsx` | `InstalledSurface` | P3 |
| `genes` | `garden` | `emerald` | `genes/genes-surface.tsx` | `GenesSurface` | P4 |
| `profiles` | `identityCard` | `rose` | `profile/profile-surface.tsx` | `ProfileSurface` | P4 |
| `snapshots` | `vault` **[new]** | `sky` | `snapshots/snapshots-surface.tsx` | `SnapshotsSurface` | P5 |
| `templates` | `atelier` **[new]** | `indigo` | `templates/blueprint surface` → `templates/templates-surface.tsx` | `TemplatesSurface` | P5 |

Each surface receives props already wired by the shell — see the stub's
`*SurfaceProps` interface (agentId / draftId / onSelectAgent as applicable).
**Keep the props interface compatible** (you may add optional props; don't
remove existing ones — the shell passes them).

---

## 2. i18n keys (already added — `evolution.studio.v2.*`)

All 5 locales (`zh`/`en`/`de`/`fr`/`es`) are filled. Consume via
`useI18n()` → `t('evolution.studio.v2.…')`. **No bare strings.** Add new keys to
ALL 5 locales if you need more (en/zh inline under `studio.v2`; de/fr/es in the
`studioV2De/Fr/Es` constants near the alias assignment in `src/lib/i18n.ts`).

Shell/rail/shared (already wired, reuse freely):

- `…v2.title` = "Evolution Studio", `…v2.subtitle`, `…v2.createSkill`, `…v2.toWorkspace`
- `…v2.groups.{workspace,perAgent}`
- `…v2.sections.{roster,create,lifecycle,installed,genes,profiles,snapshots,templates}`
- `…v2.theme.{light,dark}`
- `…v2.states.{loading,error,empty,retry,offline}` — generic 5-state copy (offline takes `{ago}`)

Creator (`…v2.creator.*`):

- `steeringTitle`, `steeringHint`, `greeting`, `composerPlaceholder`
- `startBuilding`, `building`, `runEval`, `evaluating`, `promote`, `published`, `regenerate`, `autoOptimize`
- `emptyCanvasTitle`, `emptyCanvasHint`
- `sources.{inline,doc,code,service}`
- `status.{drafting,building,draftReady,evaluating,passRate,published}` — `passRate` takes `{rate}`
- `liveness`, `manifest`, `referencesPulled`, `evalSession`
- `queuedNoRunner`, `offline` (`{ago}`), `noOrchestrator`, `authorizeOrchestrator`

Per-surface (each has `title`, `hint`, `loading`, `error`, `empty`, `gated`):

- `…v2.roster.{title,hint,loading,error,empty,gated}`
- `…v2.lifecycle.{…}`
- `…v2.installed.{…}`
- `…v2.genes.{…}`
- `…v2.profiles.{…}`
- `…v2.snapshots.{…}`
- `…v2.templates.{…}`

If a key is missing for your surface, add it to all 5 locales — do not inline a
literal string.

---

## 3. Mock data (`./mock`)

`FF_STUDIO_MOCK` (default on; read via `STUDIO_MOCK_ENABLED` from `./flags`)
means render from fixtures. Same shapes as the live endpoints (`./types`), so
the live swap is a 0-UI-change source switch.

| Import | Shape | For |
|---|---|---|
| `MOCK_OVERVIEW` | `StudioOverview` (workspace + orchestrator + agents) | shell / roster / orchestrator resolution |
| `MOCK_AGENTS` | `AgentSummary[]` (5) | roster, context chip |
| `MOCK_DRAFTS` | `DraftSummary[]` | lifecycle |
| `MOCK_MANIFEST` + `MOCK_MANIFEST_SIZES` | `ManifestFile[]` (4) | creator artifact tree |
| `MOCK_SOURCE_REFS` | `SourceRef[]` | creator references layer |
| `MOCK_EVAL_RUN` | `EvalRun` (5 cases) | creator confidence layer / lifecycle |
| `MOCK_SKILL_MD` / `MOCK_SKILL_JSON` | string | creator preview tabs |
| `MOCK_INSTALLED` | `Record<agentId, InstalledSkill[]>` | installed |
| `MOCK_GENES` | `Record<agentId, GeneNode[]>` | genes |
| `MOCK_PROFILES` | `Record<agentId, AgentProfile>` | profiles |
| `MOCK_SNAPSHOTS` | `Record<agentId, AgentSnapshot[]>` | snapshots |
| `MOCK_TEMPLATES` | `RoleTemplate[]` | templates |
| `simulateAuthoringRun(draftId, emit)` | replays a phased `AuthoringEvent` timeline; returns `cancel()` | **Creator** — drive the canvas in mock mode; call `cancel()` on unmount |

All imports: `import { MOCK_… } from '../mock'` (relative to your section dir).

---

## 4. AuthoringEvent contract (`./authoring-events`)

Creator only. Subscribe to the normalised union, never raw SSE:

- `useAuthoringEvents(draftId, enabled)` → ordered `AuthoringEvent[]` for that draft.
  Pass `enabled = !STUDIO_MOCK_ENABLED` so mock mode drives the canvas via
  `simulateAuthoringRun` instead.
- Union members (doc 28 §6.1): `authoring.phase`, `authoring.message`,
  `authoring.source.pulled`, `authoring.file.writing`, `authoring.file.written`,
  `authoring.preview.delta`, `authoring.tool`, `eval.progress`, `eval.finished`,
  `authoring.failed`.
- The bus owns a single shared EventSource with proper open/close ref-counting —
  do NOT open your own EventSource (that was the old studio's SSE leak).

Gated honesty (§3.5 / §0.2.4): no runner ⇒ render `…v2.creator.queuedNoRunner`
(`queued · no runner`); never fake progress or 100% pass. Offline ⇒
`…v2.creator.offline` with `{ago}`.

---

## 5. Design system (mandatory — 12 §8.8 + memory `feedback_use_design_system_primitives`)

- **0 direct `@radix-ui/*` imports.** Use `src/components/ui/*` wrappers:
  `button`, `tabs`, `alert-dialog`, `dialog`, `sheet`, `badge`, `toast`,
  `progress`, `award`, `siri-orb`, `morph-loading`, `markdown-renderer`,
  `code-block`, `syntax-highlighter`. Do NOT re-roll Dialog/Tabs/Sheet/Toast/
  Button/Badge/AlertDialog.
- **0 new hardcoded colours.** No `bg-white` / `text-gray-` / `border-zinc-` /
  `bg-emerald-` literals in v2 paths. Pull from `design.ts`:
  - surfaces: `s(theme, 'pane'|'card'|'modal'|'inset')`
  - radius: `radius.{pane,card,chip,button,small}`
  - accent: `grammarAccentClasses[accent]` (`.text/.ring/.bg/.dot/.glow`) keyed
    off `SECTION_GRAMMAR[section].accent`
  - brand violet: `var(--prismer-primary)` / `from-[var(--grad-from)] to-[var(--grad-to)]`
- **Motion = framer-motion + `design.ts` springs only.** No inline `@keyframes`,
  no CSS-in-JS. Use `springSoft` (cards), `springSnap` (chips/dots),
  `springLiquid` (file flow / pipeline), `springFlip` (chip configure),
  `springSplat` (publish/distill celebration), `springDrag` (DnD/scrubber),
  `springHeavy` (big surfaces). Named presets in `motionPreset`. **Wrap every
  animation with `useReducedMotion()`** → fall back to `motionReduced` (or
  `initial={false}` / instant).
- **Icons = Lucide only.**
- **Theme:** `useTheme()` → `const isDark = resolvedTheme === 'dark'`, then
  `theme = isDark ? 'dark' : 'light'`. Both themes must render.
- **Five states everywhere:** empty / loading / error / **gated** / data — all
  rendered, all i18n'd. Reference the shared `SectionPlaceholder` component
  (`./section-placeholder.tsx`) for the accent+grammar visual pattern.

### Mirror these existing composites (don't re-invent)

- shell/rail rhythm → `src/app/workspace/.../left-rail.tsx` + `top-bar.tsx`
- chat bubbles (Creator steering) → `im-channel.tsx`
- file tree (Creator artifact) → `library-files-panel.tsx`
- card containers (Roster/Snapshots/Templates) → `card-shelf.tsx`
- orb avatar (Profile) → `src/components/ui/siri-orb.tsx`
- gauge (Creator eval) → self-rendered SVG + `useSpring` (NOT recharts)

---

## 6. URL + section state (`./url`, owned by shell)

The shell owns section ↔ URL sync (`?tab=studio&section=…&agentId=&draftId=`).
You receive resolved `agentId` / `draftId` as props and call the provided
`onSelectAgent` callback (roster) — do not write the URL yourself.

`parseStudioUrl` / `buildStudioUrl` / `normalizeLegacyView` live in `./url` if
you need to build a deep link (e.g. Creator "Promote" → cross-link to lifecycle).

---

## 6a. Shared data layer (`./data/*` — owned by the base builder)

The shell resolves the active workspace + agent roster ONCE and fans it out via
React context. Surface agents **consume** these; do not re-resolve the workspace
or re-roll auth in your surface.

### `useStudioContext()` — `./data/use-studio-context`

```ts
const {
  workspaceId,    // string | null
  workspaceName,  // string  (real name, or mock fallback name)
  agents,         // AgentSummary[]  — every agent in the active workspace
  agentId,        // string | null   — URL-derived active agent (controlled by shell)
  setAgentId,     // (id: string | null) => void  — writes ?agentId= via the shell
  loading,        // boolean
  error,          // boolean
  isMock,         // boolean — true when served from ../mock (offline demo)
} = useStudioContext();
```

- Provider (`<StudioContextProvider>`) is mounted by the shell **outside**
  `StudioShellInner`; calling the hook outside it throws.
- **real-first / mock-fallback**: authed + non-empty live data → live; only when
  `STUDIO_MOCK_ENABLED` AND the live source is unavailable (unauthed / empty /
  threw) does it fall back to `MOCK_OVERVIEW`. An authed user with a genuinely
  empty workspace sees the **empty** state, not mock agents.
- Roster already consumes this. For per-agent surfaces, read `agents` /
  `agentId` here instead of importing `MOCK_OVERVIEW` directly.
- Roster facet counts (`skills` / `genes` / `snapshots`) are **0** on live
  agents (the roster payload doesn't carry them — no fake numbers). If your
  surface needs real counts, fetch them per-agent (e.g. `fetchInstalled` /
  `fetchStudioGenes` from `../../types`).

### `fetchRoleTemplates(filters?)` — `./data/role-templates`

```ts
fetchRoleTemplates(filters?: { category?; agentType?; status? }): Promise<RoleTemplate[]>
```

- Wraps `GET /api/im/role_templates`; reuses the shared `authHeader` + `getJson`
  from `../../types`. real-first, falls back to `MOCK_TEMPLATES` only when
  `STUDIO_MOCK_ENABLED` and the live list is empty/failed.
- **Honesty**: LIST is open; **writes (create/edit template) are admin-only**
  (backend `adminOnly()` on POST/PATCH). This client exposes **read only** —
  gate any template-authoring action to admins and expect 403 for non-admins.
- Flattens the live i18n DTO (`name`/`requiredSkills`/`mcpServers`) into the v2
  `RoleTemplate` plain-string read shape at the client boundary.

### `fetchAgentProfile(agentId)` + `updateOperatingPrinciples(...)` — `./data/profile`

```ts
fetchAgentProfile(agentId: string | null): Promise<StudioProfile | null>   // re-export of types.ts fetchProfile
updateOperatingPrinciples(workspaceId, agentId, principles: string[]): Promise<void>
```

- **Write surface is principles-only.** `operatingPrinciples` is the **only**
  field writable through this client. personality (rigor / creativity /
  risk_tolerance), identity (did / agentType / handle) and credits are
  **read-only** — render them as display, route edits to their own owners. Do
  NOT add personality/identity writes here.
- `updateOperatingPrinciples` is two-step: `GET /agent_profiles?agentId=&workspaceId=`
  to resolve the row `{ id, config, version }`, then `PATCH /agent_profiles/:id`
  with `{ config: { ...prev, operatingPrinciples }, version }` (PATCH replaces
  the whole config blob, so prev keys are preserved). **Throws** when no profile
  row exists — surface an explicit degraded state, never silently drop the write.

---

## 7. Forbidden (CI/review will reject)

- Fake progress / fake 100% pass when no runner (use `queued · no runner`).
- Any surface degrading to a `<table>` + inline-button back-office list (each
  surface must quote its spatial grammar; no "list-detail").
- Editing shared base files (shell / rail / types / url / authoring-events /
  mock / i18n base / design.ts) — only the base builder owns those.
- Renaming a stub file or its export.
- Bare CN/EN strings; direct `@radix-ui/*`; new hardcoded colours; inline
  `@keyframes`; non-Lucide icons; CSS-in-JS.
- Log lines: `[studio-v2] mock data in prod`, `[authoring-canvas] fake progress`,
  `[studio-v2] hardcoded color`.
