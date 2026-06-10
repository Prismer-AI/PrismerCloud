import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/lib/__tests__/**/*.test.ts',
      'src/app/workspace/lib/__tests__/**/*.test.ts',
      'src/app/workspace/lib/templates/__tests__/**/*.test.ts',
      'src/app/workspace/components/__tests__/**/*.test.tsx',
      'src/app/workspace/components/**/__tests__/**/*.test.ts',
      'src/app/workspace/components/**/__tests__/**/*.test.tsx',
      // S22 (release201/13 §3.2-3.7) — Studio Skills 4 sub-tab + Evidence
      // panel + Configure modal frontend tests.
      'src/app/evolution/components/**/__tests__/**/*.test.tsx',
      'src/app/evolution/components/**/__tests__/**/*.test.ts',
      // Wave 3 §4.1 — reconcile hook (im-channel-reconcile, send-fail-5s, refresh-cursor)
      'src/app/workspace/hooks/__tests__/**/*.test.tsx',
      'src/app/workspace/hooks/__tests__/**/*.test.ts',
      'src/im/tests/acp-*.test.ts',
      // v2.0 §4.8.2 (Wave 2-B2) — multi-daemon binding ownership tests
      'src/im/tests/agent-binding-*.test.ts',
      'src/im/tests/dispatch-honors-binding.test.ts',
      // 注：v2.0 §4.1 (Wave 2-B1) sync-seq / sync-publisher / idempotency-race
      // 是 tsx standalone runner (per CLAUDE.md IM test pattern)，不走 vitest。
      // 跑：npx tsx src/im/tests/sync-seq.test.ts ...
      'packages/**/*.test.ts',
      // src/im/skills/__tests__/ + src/im/services/__tests__ 是 tsx standalone test
      // 脚本，不是 vitest 格式 — 通过 `npm run test:skills` 运行
      // v2.0.8 cockpit BFF — vitest unit test for getCockpit fan-out
      // (mocks prisma + ApprovalService).
      'src/im/services/__tests__/insights-cockpit.test.ts',
      // release201 v2.0.8 Wave 3 H1 — lint:i18n CI guard
      'scripts/__tests__/**/*.test.ts',
      // release201 v2.0.8 Wave 5 B1 — agent-authored-skill cookbook capture
      // helper shape test (scripts/cookbook/capture-skill-authoring-sse.ts).
      'scripts/cookbook/__tests__/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // S50b — 2 files matched by include globs but are NOT vitest format:
      //   log-redaction.test.ts uses node:test (tsx --test), see file header §13.
      //   acp-approval.test.ts is a tsx standalone runner with process.exit,
      //   see file header §14 — `npx tsx src/im/tests/acp-approval.test.ts`.
      'src/lib/__tests__/log-redaction.test.ts',
      'src/im/tests/acp-approval.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/lib/__tests__/'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/lib': path.resolve(__dirname, './src/lib'),
      '@prismer/asset-viewers': path.resolve(__dirname, './packages/asset-viewers/src/index.ts'),
    },
  },
});
