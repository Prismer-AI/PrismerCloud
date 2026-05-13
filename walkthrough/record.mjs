// Playwright walkthrough recorder for PrismerCloud self-host.
// Outputs a single .webm video + per-page screenshots.
//
// Usage: npx playwright install chromium  # one-off
//        node /tmp/prismer-walkthrough/record.mjs
//
// Tip: lower viewport + 1.0 deviceScaleFactor keeps the file small.

import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = '/tmp/prismer-walkthrough';
const VIDEO_DIR = join(OUT_DIR, '_video_raw');
mkdirSync(VIDEO_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STORY = [
  {
    title: '01 Landing — The Intelligence Runtime for AI Agents',
    url: 'http://localhost:3000/',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(2500);
      // Slow scroll through the hero + pricing
      await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'smooth' }));
      await sleep(2000);
      await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'smooth' }));
      await sleep(2500);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(1500);
    },
  },
  {
    title: '02 Playground — Context API live preview',
    url: 'http://localhost:3000/playground',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(3000);
      // Hover the API mode chips
      const modes = page.locator('[data-mode], button:has-text("Context"), button:has-text("Parse"), button:has-text("IM")').first();
      if (await modes.count()) await modes.hover().catch(() => {});
      await sleep(2500);
    },
  },
  {
    title: '03 Evolution — Cross-Agent Learning Network (Map)',
    url: 'http://localhost:3000/evolution',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(3500);
      // Hover gene list to draw eyes
      const gene = page.locator('text=/Rate Limit Backoff|TS Type Fix|Timeout Recovery/').first();
      if (await gene.count()) await gene.hover().catch(() => {});
      await sleep(2000);
    },
  },
  {
    title: '04 Evolution → Marketplace tab',
    url: 'http://localhost:3000/evolution',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(1500);
      const tab = page.getByRole('button', { name: /Marketplace/i }).first();
      if (await tab.count()) await tab.click().catch(() => {});
      await sleep(3000);
    },
  },
  {
    title: '05 Evolution → Leaderboard tab',
    url: 'http://localhost:3000/evolution',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(1000);
      const tab = page.getByRole('button', { name: /Leaderboard/i }).first();
      if (await tab.count()) await tab.click().catch(() => {});
      await sleep(3000);
    },
  },
  {
    title: '06 Community — Agent-era Stack Overflow',
    url: 'http://localhost:3000/community',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(2500);
      // Show Human / Agent toggle
      const human = page.getByRole('button', { name: /Human/i }).first();
      if (await human.count()) await human.hover().catch(() => {});
      await sleep(1500);
    },
  },
  {
    title: '07 Docs — API + 10 cookbooks',
    url: 'http://localhost:3000/docs',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(2500);
      await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'smooth' }));
      await sleep(2500);
      await page.evaluate(() => window.scrollTo({ top: 1200, behavior: 'smooth' }));
      await sleep(2500);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(1500);
    },
  },
  {
    title: '08 Cookbook — 5-Minute Quick Start',
    url: 'http://localhost:3000/docs/en/cookbook/quickstart',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(2000);
      await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'smooth' }));
      await sleep(2500);
      await page.evaluate(() => window.scrollTo({ top: 1400, behavior: 'smooth' }));
      await sleep(2500);
    },
  },
  {
    title: '09 Cookbook — Evolution Feedback Loop (5 steps)',
    url: 'http://localhost:3000/docs/en/cookbook/evolution-loop',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(2000);
      await page.evaluate(() => window.scrollTo({ top: 800, behavior: 'smooth' }));
      await sleep(2500);
      await page.evaluate(() => window.scrollTo({ top: 1800, behavior: 'smooth' }));
      await sleep(2500);
    },
  },
  {
    title: '10 Dashboard — AUTH_DISABLED self-host (no login wall)',
    url: 'http://localhost:3000/dashboard',
    actions: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(3000);
      // Click through dashboard tabs
      for (const name of ['Api Keys', 'Billing', 'Evolution', 'Overview']) {
        const tab = page.getByRole('button', { name: new RegExp(name, 'i') }).first();
        if (await tab.count()) await tab.click().catch(() => {});
        await sleep(2000);
      }
    },
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
  });

  const page = await context.newPage();

  for (let i = 0; i < STORY.length; i++) {
    const step = STORY[i];
    console.log(`[${String(i + 1).padStart(2, '0')}/${STORY.length}] ${step.title}`);
    try {
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      console.log(`    goto failed: ${e.message.slice(0, 100)}`);
    }
    try {
      await step.actions(page);
    } catch (e) {
      console.log(`    actions error: ${e.message.slice(0, 100)}`);
    }
  }

  await context.close(); // flushes the video to disk
  await browser.close();

  // Move the (single) recorded video into a stable name.
  const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'));
  if (files.length === 0) {
    console.error('No video produced');
    process.exit(1);
  }
  const out = join(OUT_DIR, 'walkthrough.webm');
  if (existsSync(out)) {
    // back up old
    renameSync(out, out.replace('.webm', `-${Date.now()}.webm`));
  }
  renameSync(join(VIDEO_DIR, files[0]), out);
  console.log(`\nVideo: ${out}`);
})();
