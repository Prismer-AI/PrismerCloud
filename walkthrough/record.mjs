// Playwright walkthrough recorder for PrismerCloud self-host (v2.0.8).
// Outputs a single .webm video + per-scene screenshots.
//
// Usage: # playwright must be resolvable (e.g. run a copy from server/, which
//        # has it in node_modules, against a running docker compose stack):
//        cp walkthrough/record.mjs server/.wt-record.mjs && node server/.wt-record.mjs
//
// Auth: scenes marked `auth: true` run with a logged-in session. The script
// logs in via /api/auth/login (frontend posts SHA256(plaintext)) and injects
// the `prismer_auth` localStorage blob the AppContext expects. Create the
// user first (self-host: register needs an email provider, so seed im_users
// directly — see walkthrough.md "环境准备").
//
// Tip: lower viewport + 1.0 deviceScaleFactor keeps the file small.

import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const BASE = process.env.WT_BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.WT_EMAIL || 'walkthrough@localhost.dev';
const PASSWORD = process.env.WT_PASSWORD || 'Walkthrough123!';
const OUT_DIR = process.env.WT_OUT || '/tmp/prismer-walkthrough';
const VIDEO_DIR = join(OUT_DIR, '_video_raw');
mkdirSync(VIDEO_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const sha = createHash('sha256').update(PASSWORD).digest('hex');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: sha }),
  });
  const data = await res.json();
  if (!data?.token) throw new Error(`login failed: ${JSON.stringify(data).slice(0, 200)}`);
  return {
    isAuthenticated: true,
    user: data.user,
    token: data.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    loginAt: Date.now(),
  };
}

const scrollTour = (stops) => async (page) => {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(2500);
  for (const top of stops) {
    await page.evaluate((t) => window.scrollTo({ top: t, behavior: 'smooth' }), top);
    await sleep(2200);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(1200);
};

const STORY = [
  {
    shot: '01-landing',
    title: '01 Landing — The Harness for AI Agent Evolution',
    url: `${BASE}/`,
    actions: scrollTour([400, 900]),
  },
  {
    shot: '02-playground',
    title: '02 Playground — Context / Parse / IM live preview',
    url: `${BASE}/playground`,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(3000);
      const modes = page
        .locator('[data-mode], button:has-text("Context"), button:has-text("Parse"), button:has-text("IM")')
        .first();
      if (await modes.count()) await modes.hover().catch(() => {});
      await sleep(2000);
    },
  },
  {
    shot: '03-evolution',
    title: '03 Evolution — Cross-Agent Learning Network (Map)',
    url: `${BASE}/evolution`,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(3500);
      const gene = page.locator('text=/Rate Limit Backoff|TS Type Fix|Timeout Recovery/').first();
      if (await gene.count()) await gene.hover().catch(() => {});
      await sleep(2000);
    },
  },
  {
    shot: '04-evolution-marketplace',
    title: '04 Evolution → Marketplace tab',
    url: `${BASE}/evolution`,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(1500);
      const tab = page.getByRole('button', { name: /Marketplace/i }).first();
      if (await tab.count()) await tab.click().catch(() => {});
      await sleep(3000);
    },
  },
  {
    shot: '05-evolution-leaderboard',
    title: '05 Evolution → Leaderboard tab',
    url: `${BASE}/evolution`,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(1000);
      const tab = page.getByRole('button', { name: /Leaderboard/i }).first();
      if (await tab.count()) await tab.click().catch(() => {});
      await sleep(3000);
    },
  },
  {
    shot: '06-community',
    title: '06 Community — Agent-era Stack Overflow',
    url: `${BASE}/community`,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(2500);
      const human = page.getByRole('button', { name: /Human/i }).first();
      if (await human.count()) await human.hover().catch(() => {});
      await sleep(1500);
    },
  },
  {
    shot: '07-docs',
    title: '07 Docs — API reference + cookbooks',
    url: `${BASE}/docs`,
    actions: scrollTour([600, 1200]),
  },
  {
    shot: '08-cookbook-quickstart',
    title: '08 Cookbook — 5-Minute Quick Start',
    url: `${BASE}/docs/en/cookbook/quickstart`,
    actions: scrollTour([700, 1400]),
  },
  {
    shot: '09-workspace',
    title: '09 Workspace — agent sessions + left rail (NEW in 2.0)',
    url: `${BASE}/workspace`,
    auth: true,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await sleep(5000);
    },
  },
  {
    shot: '10-workspace-tasks',
    title: '10 Workspace → Task board (create → dispatch → done)',
    url: `${BASE}/workspace`,
    auth: true,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await sleep(2500);
      for (const name of ['Task Kanban', 'Tasks']) {
        const el = page.getByText(name, { exact: false }).first();
        if (await el.count()) {
          await el.click().catch(() => {});
          break;
        }
      }
      await sleep(3500);
    },
  },
  {
    shot: '11-workspace-insights',
    title: '11 Workspace → Insights cockpit (NEW in 2.0)',
    url: `${BASE}/workspace/insights`,
    auth: true,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await sleep(4000);
    },
  },
  {
    shot: '12-dashboard',
    title: '12 Dashboard — API keys / usage / billing-free self-host',
    url: `${BASE}/dashboard`,
    auth: true,
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(3000);
      for (const name of ['Api Keys', 'Evolution', 'Overview']) {
        const tab = page.getByRole('button', { name: new RegExp(name, 'i') }).first();
        if (await tab.count()) await tab.click().catch(() => {});
        await sleep(2000);
      }
    },
  },
];

(async () => {
  const auth = await login().catch((e) => {
    console.log(`login failed (${e.message}) — auth scenes will show the login wall`);
    return null;
  });

  // WT_CHROMIUM: explicit browser binary (e.g. when the playwright-pinned
  // revision isn't downloaded but a nearby cached revision exists).
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WT_CHROMIUM || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
  });
  if (auth) {
    await context.addInitScript((blob) => {
      try {
        localStorage.setItem('prismer_auth', blob);
      } catch {}
    }, JSON.stringify(auth));
  }

  const page = await context.newPage();

  for (let i = 0; i < STORY.length; i++) {
    const step = STORY[i];
    console.log(`[${String(i + 1).padStart(2, '0')}/${STORY.length}] ${step.title}`);
    try {
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      console.log(`    goto failed: ${e.message.slice(0, 100)}`);
    }
    try {
      await step.actions(page);
    } catch (e) {
      console.log(`    actions error: ${e.message.slice(0, 100)}`);
    }
    try {
      await page.screenshot({ path: join(OUT_DIR, `${step.shot}.png`) });
    } catch (e) {
      console.log(`    screenshot error: ${e.message.slice(0, 100)}`);
    }
  }

  await context.close(); // flushes the video to disk
  await browser.close();

  const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'));
  if (files.length === 0) {
    console.error('No video produced');
    process.exit(1);
  }
  const out = join(OUT_DIR, 'walkthrough.webm');
  if (existsSync(out)) renameSync(out, out.replace('.webm', `-${Date.now()}.webm`));
  renameSync(join(VIDEO_DIR, files[0]), out);
  console.log(`\nVideo: ${out}`);
  console.log(`Shots: ${OUT_DIR}/NN-*.png`);
})();
