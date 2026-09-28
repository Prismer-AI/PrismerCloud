/**
 * @prismer/sdk/pkf — the PKF public seam (product209/15 PKF-D2).
 *
 * Re-exports the frozen `@prismer/pkf` surface (parse/validate/inspect,
 * v1.1 constants, budgets, two-phase validation, URI classification). The
 * core is BUNDLED into this entry at build time (tsup noExternal) — the
 * published tarball never depends on the monorepo package name.
 *
 * Public subpath contract: consumers import `@prismer/sdk/pkf`, never app
 * component deep paths.
 */
export * from '@prismer/pkf';
