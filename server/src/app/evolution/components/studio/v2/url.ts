/**
 * Evolution Studio v2 — URL contract (release201/28 §2.3).
 *
 *   /evolution?tab=studio                                    → roster (default)
 *   /evolution?tab=studio&section=create[&agentId=&draftId=&from=doc|code|service|inline]
 *   /evolution?tab=studio&section=lifecycle[&draftId=]
 *   /evolution?tab=studio&section=installed&agentId=
 *   … (genes / profiles / snapshots / templates)
 *
 * State persists in the query string (not bare useState) so refresh / cross-
 * device keeps context — fixes doc 13 §3.1 P1-1.
 */

import type {
  CreatorSourceKind,
  StudioSection,
  StudioUrlState,
} from './types';
import { STUDIO_SECTIONS } from './types';

const SOURCE_KINDS: CreatorSourceKind[] = ['inline', 'doc', 'code', 'service'];

function isSection(v: string | null | undefined): v is StudioSection {
  return !!v && (STUDIO_SECTIONS as string[]).includes(v);
}

function isSourceKind(v: string | null | undefined): v is CreatorSourceKind {
  return !!v && (SOURCE_KINDS as string[]).includes(v);
}

/**
 * Map a legacy `?view=` / `?subview=` pair onto a v2 `section`.
 *
 *   view=my-agents                → profiles
 *   view=metrics                  → roster
 *   view=skills + subview=authoring → create
 *   subview=lifecycle             → lifecycle
 *   subview=installed             → installed
 *   subview=evolution             → genes
 *
 * Bare legacy sub-tab strings passed as `view` (e.g. `view=lifecycle`, which
 * library-surface emits) are honoured too.
 */
export function normalizeLegacyView(
  view: string | null | undefined,
  subview?: string | null | undefined,
): StudioSection {
  // sub-tab wins when present
  const sub = subview ?? null;
  if (sub === 'lifecycle') return 'lifecycle';
  if (sub === 'installed') return 'installed';
  if (sub === 'evolution') return 'genes';
  if (sub === 'authoring') return 'create';

  switch (view) {
    case 'my-agents':
    case 'profile':
    case 'overview':
      return 'profiles';
    case 'metrics':
      return 'roster';
    case 'skills':
    case 'authoring':
      return 'create';
    case 'lifecycle':
      return 'lifecycle';
    case 'installed':
      return 'installed';
    case 'evolution':
      return 'genes';
    default:
      return 'roster';
  }
}

/**
 * Parse the studio slice of a `URLSearchParams`. Falls back to legacy
 * `view`/`subview` via {@link normalizeLegacyView} when no `section` is set,
 * so old deep links land on the right surface.
 */
export function parseStudioUrl(
  searchParams: URLSearchParams | null | undefined,
): StudioUrlState {
  const sp = searchParams;
  const rawSection = sp?.get('section') ?? null;
  const section = isSection(rawSection)
    ? rawSection
    : normalizeLegacyView(sp?.get('view'), sp?.get('subview'));

  const rawFrom = sp?.get('from') ?? null;

  return {
    section,
    agentId: sp?.get('agentId') ?? null,
    draftId: sp?.get('draftId') ?? null,
    from: isSourceKind(rawFrom) ? rawFrom : null,
  };
}

/**
 * Build a `?tab=studio&section=…` query string (without the leading `?`).
 * `roster` is the default and is elided to keep URLs short.
 */
export function buildStudioUrl(
  section: StudioSection,
  opts: {
    agentId?: string | null;
    draftId?: string | null;
    from?: CreatorSourceKind | null;
  } = {},
): string {
  const params = new URLSearchParams();
  params.set('tab', 'studio');
  if (section !== 'roster') params.set('section', section);
  if (opts.agentId) params.set('agentId', opts.agentId);
  if (opts.draftId) params.set('draftId', opts.draftId);
  if (opts.from) params.set('from', opts.from);
  return params.toString();
}
