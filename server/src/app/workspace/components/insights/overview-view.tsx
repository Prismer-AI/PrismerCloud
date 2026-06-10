'use client';

/**
 * Overview view — alias to the 「一人公司」 cockpit (release 2.1).
 *
 * The previous "6 widget grid + approval queue" cockpit was retired and
 * replaced with a 4-counter / 2-timeseries / agent-table / stuck-tasks /
 * approval-queue cockpit (see `cockpit-view.tsx`). `InsightsSurface`
 * still imports `{ OverviewView }` from this file, so we re-export the
 * cockpit under that name to keep the surface wiring untouched.
 *
 * History:
 *   - 2026-05-30 cockpit-v1 (this file's prior body) — replaced the
 *     6-zone-canvas + floating-avatar metaphor that left users on broken
 *     drill-down URLs.
 *   - 2026-05-30 cockpit-v2 — restructured around the "one-person company"
 *     job-to-be-done: counters tell the operator where to look, lists tell
 *     them what to act on, in one screen.
 */

export { CockpitView as OverviewView } from './cockpit-view';
export type { CockpitViewProps as OverviewViewProps } from './cockpit-view';
