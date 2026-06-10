/**
 * Evolution Studio v2 — client-readable feature flags (release201/28).
 *
 * Client components can't read non-`NEXT_PUBLIC_` env, so the server flags in
 * `src/lib/feature-flags.ts` (`FEATURE_FLAGS.STUDIO_V2` / `.STUDIO_MOCK`) are
 * mirrored here via `NEXT_PUBLIC_FF_STUDIO_V2` / `NEXT_PUBLIC_FF_STUDIO_MOCK`.
 *
 * Both default TRUE — opt-out by setting the env to the string `'false'`.
 * `process.env.NEXT_PUBLIC_*` is inlined at build time by Next.js, so these
 * are safe to read in client components.
 */

export const STUDIO_V2_ENABLED: boolean = process.env.NEXT_PUBLIC_FF_STUDIO_V2 !== 'false';

export const STUDIO_MOCK_ENABLED: boolean = process.env.NEXT_PUBLIC_FF_STUDIO_MOCK !== 'false';
