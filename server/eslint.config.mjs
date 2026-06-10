import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import { createRequire } from "node:module";

// Custom in-repo rules (CJS via createRequire for ESM flat config).
const require = createRequire(import.meta.url);
const noWildcardSubRouterMiddleware = require("./eslint-rules/no-wildcard-sub-router-middleware.js");

const customPlugin = {
  rules: {
    "no-wildcard-sub-router-middleware": noWildcardSubRouterMiddleware,
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // ── Wave 6 G3: 防 Hono sub-router 用 `*` 通配（参 W3 hidden bug）──
  {
    plugins: { custom: customPlugin },
    rules: {
      "custom/no-wildcard-sub-router-middleware": "error",
    },
  },

  // ── Architecture boundary enforcement ──────────────────────
  {
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "app",        pattern: ["src/app/**"],        mode: "full" },
        { type: "im",         pattern: ["src/im/**"],         mode: "full" },
        { type: "lib",        pattern: ["src/lib/**"],        mode: "full" },
        { type: "components", pattern: ["src/components/**"],  mode: "full" },
        { type: "contexts",   pattern: ["src/contexts/**"],    mode: "full" },
        { type: "types",      pattern: ["src/types/**"],       mode: "full" },
      ],
      "boundaries/ignore": [
        // IM route handler is the only bridge — it calls app.fetch() in-process
        "src/app/api/im/**",
        // .well-known handlers need direct Prisma access (DID, AASA)
        "src/app/.well-known/**",
        // Invite-bound registration (P0.1) bridges to the IM invite service to
        // resolve the inviteeEmail server-side + auto-accept the invite.
        "src/app/api/auth/register/**",
        // /u/[userId] landing page — lightweight IM user lookup for Universal Link
        "src/app/u/**",
        // instrumentation.ts bootstraps IM server at startup
        "src/instrumentation.ts",
        // Global navbar profile dropdown mounts the workspace self-profile dialog.
        // The dialog reaches into workspace's design tokens + im-api helpers; cleanest
        // long-term fix is to lift `surface`/`radius`/`avatarGradient`/`avatarInitials`
        // from `src/app/workspace/lib/design.ts` to `src/lib/design.ts` and relocate
        // the dialog under `src/components/`. Deferred to keep Task 2 surgical.
        // TODO(naming-system v2): perform that relocation, then delete this entry.
        "src/app/workspace/components/self-profile-dialog.tsx",
        // F2 login-QR dialog — same situation as self-profile-dialog: mounts off the
        // navbar profile dropdown and reuses workspace design tokens (surface/radius).
        "src/app/workspace/components/login-qr-dialog.tsx",
      ],
    },
    rules: {
      "boundaries/dependencies": ["error", {
        default: "disallow",
        rules: [
          // app layer: can use self, lib, components, contexts, types
          { from: "app", allow: ["app", "lib", "components", "contexts", "types"] },
          // im layer: can use self, lib, types (isolated server — no React, no app)
          { from: "im",  allow: ["im", "lib", "types"] },
          // components: can use self, lib, contexts, types
          { from: "components", allow: ["components", "lib", "contexts", "types"] },
          // contexts: can use self, lib, types
          { from: "contexts", allow: ["contexts", "lib", "types"] },
          // lib: can use self, types (lowest layer)
          { from: "lib",  allow: ["lib", "types"] },
          // types: standalone, self only
          { from: "types", allow: ["types"] },
        ],
      }],
    },
  },

  // ── Gradual strictness: downgrade pre-existing issues to warn ──
  // TODO: Tighten to "error" once codebase is cleaned up
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      // Pre-existing: dynamic require() in server/IM code (Node.js context)
      "@typescript-eslint/no-require-imports": "warn",
      // Pre-existing: Function type in legacy API handlers
      "@typescript-eslint/no-unsafe-function-type": "warn",
      // Pre-existing: setState patterns in useEffect (React 19 compiler rules)
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/static-components": "warn",
      "prefer-const": "warn",
    },
  },

  // ── R1 finding F5 (2026-05-19): allow __tests__ files to cross layer
  //    boundaries. Tests need to import from any layer they exercise
  //    (e.g. src/lib/__tests__/sandbox-resources-schema.test.ts probes
  //    `src/app/api/sandboxes/[id]/resources/route.ts`). Boundaries rule
  //    is a code-architecture safeguard, not a test-isolation contract.
  {
    files: [
      "src/**/__tests__/**/*.test.ts",
      "src/**/__tests__/**/*.test.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    rules: {
      "boundaries/dependencies": "off",
    },
  },

  // ── v200 §08 A1: sandbox routes must go through the provider registry ──
  // Direct `@/lib/k8s-sandbox` imports inside `src/app/api/sandboxes/**`
  // bypass the provider-agnostic abstraction (08 §4.5). Only the
  // `_admin/sandbox-metrics` route is exempt — it reads `IMContainer` rows
  // directly from Prisma and does not invoke provider methods.
  //
  // Type-only imports (`import type { ... }`) remain allowed since they
  // do not pull in the implementation at runtime — routes still need
  // shared shapes (RunCmdArgs / SnapshotResult / etc.) until those move
  // to `src/lib/execution/`.
  {
    files: ["src/app/api/sandboxes/**/*.ts"],
    ignores: ["src/app/api/sandboxes/_admin/sandbox-metrics/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@/lib/k8s-sandbox",
            importNames: ["k8sSandbox", "K8sSandboxError", "isAlreadyAbsentK8sError"],
            message: "Sandbox routes must access providers via @/lib/sandbox/registry (resolvePersistent / resolveEphemeral). Catch ProviderError from @/lib/execution/errors. See docs/release200/08-execution-environment-design.md §4.5.",
          },
        ],
      }],
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    ".claude/**",
    ".worktrees/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "sdk/**",
    "scripts/**",
    "prisma/generated/**",
    "ref/**",
    "e2e-playwright/**",
    "playwright-report/**",
    "test-results/**",
    "public/pdf.worker.min.mjs",
  ]),
]);

export default eslintConfig;
