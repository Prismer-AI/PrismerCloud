import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

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
        // /u/[userId] landing page — lightweight IM user lookup for Universal Link
        "src/app/u/**",
        // instrumentation.ts bootstraps IM server at startup
        "src/instrumentation.ts",
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
      // Pre-existing: React Compiler diagnostics inherited from v1.8.2 baseline.
      // TODO: refactor offending components, then re-tighten to "error".
      "react-hooks/refs": "warn",
      "react-hooks/component-hook-factories": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/static-components": "warn",
      "prefer-const": "warn",
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "sdk/**",
    "scripts/**",
    "prisma/generated/**",
    "ref/**",
  ]),
]);

export default eslintConfig;
