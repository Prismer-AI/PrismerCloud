#!/usr/bin/env npx tsx
/**
 * One-shot ClawHub skill catalog sync script.
 *
 * Usage:
 *   # Step 1: Fetch all data (saves to /tmp/clawhub-skills.json, resumable)
 *   npx tsx scripts/sync-clawhub.ts fetch
 *
 *   # Step 2: Import into DB
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx scripts/sync-clawhub.ts import
 *
 *   # Or both in one go:
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx scripts/sync-clawhub.ts
 *
 *   # Against test MySQL:
 *   DATABASE_URL="mysql://prismer_cloud:REDACTED-MYSQL-PASSWORD@REDACTED-DB-HOST:3306/prismer_cloud" npx tsx scripts/sync-clawhub.ts import
 *
 * The fetch step caches to /tmp/clawhub-skills.json and resumes from where it
 * left off if interrupted. Delete the file to start fresh.
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';

const CLAWHUB_API = 'https://clawhub.ai/api/v1/skills';
const CACHE_FILE = '/tmp/clawhub-skills.json';
const PAGE_DELAY_MS = 800;
const FETCH_TIMEOUT_MS = 30_000;
const RATE_LIMIT_WAIT_MS = 15_000;
const MAX_RETRIES = 10;

interface ClawHubSkill {
  slug: string;
  displayName: string;
  summary: string;
  tags: { latest?: string };
  stats: {
    downloads: number;
    installsAllTime: number;
    installsCurrent: number;
    stars: number;
    versions: number;
    comments: number;
  };
  createdAt: number;
  updatedAt: number;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog: string | null;
    license: string | null;
  };
  metadata?: {
    os?: string[];
    systems?: string[] | null;
  };
}

interface ClawHubPage {
  items: ClawHubSkill[];
  nextCursor?: string | null;
}

interface CacheData {
  skills: ClawHubSkill[];
  nextCursor: string | null;
  complete: boolean;
  fetchedAt: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchPage(cursor: string | null, retries = 0): Promise<ClawHubPage | null> {
  const url = cursor ? `${CLAWHUB_API}?cursor=${cursor}` : CLAWHUB_API;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (resp.status === 429) {
      if (retries >= MAX_RETRIES) {
        console.error(`  ❌ Rate limited ${MAX_RETRIES} times, saving progress and stopping`);
        return null;
      }
      const wait = RATE_LIMIT_WAIT_MS * Math.min(retries + 1, 4);
      console.warn(`  ⏳ Rate limited, waiting ${wait / 1000}s (retry ${retries + 1}/${MAX_RETRIES})...`);
      await sleep(wait);
      return fetchPage(cursor, retries + 1);
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    return JSON.parse(raw) as ClawHubPage;
  } catch (err) {
    if (retries >= MAX_RETRIES) {
      console.error(`  ❌ Fetch failed after ${MAX_RETRIES} retries:`, (err as Error).message);
      return null;
    }
    const wait = 3000 * (retries + 1);
    console.warn(`  ⚠️ Fetch error: ${(err as Error).message}, waiting ${wait / 1000}s...`);
    await sleep(wait);
    return fetchPage(cursor, retries + 1);
  }
}

function saveCache(cache: CacheData) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function loadCache(): CacheData | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

async function doFetch(): Promise<ClawHubSkill[]> {
  // Resume from cache if available
  let cache = loadCache();
  if (cache?.complete) {
    console.log(`✅ Cache exists with ${cache.skills.length} skills (complete). Use 'import' to load into DB.`);
    console.log(`   Delete ${CACHE_FILE} to re-fetch.\n`);
    return cache.skills;
  }

  const allSkills = cache?.skills || [];
  let cursor = cache?.nextCursor || null;
  let pageNum = Math.floor(allSkills.length / 24); // approximate

  if (allSkills.length > 0) {
    console.log(`📎 Resuming from ${allSkills.length} cached skills (cursor: ${cursor?.slice(0, 20)}...)\n`);
  }

  console.log(`Fetching from ${CLAWHUB_API}...\n`);

  // Dedup by slug (in case of overlapping pages)
  const seen = new Set(allSkills.map(s => s.slug));

  while (true) {
    pageNum++;
    const page = await fetchPage(cursor);

    if (!page || !page.items || page.items.length === 0) {
      // Save what we have
      if (!page) {
        // Fetch failed — save progress for resume
        saveCache({ skills: allSkills, nextCursor: cursor, complete: false, fetchedAt: new Date().toISOString() });
        console.log(`\n⚠️ Fetch interrupted. Saved ${allSkills.length} skills to ${CACHE_FILE}`);
        console.log(`   Run 'fetch' again to resume.\n`);
      } else {
        // Reached end
        saveCache({ skills: allSkills, nextCursor: null, complete: true, fetchedAt: new Date().toISOString() });
        console.log(`\n✅ Fetch complete! ${allSkills.length} skills saved to ${CACHE_FILE}\n`);
      }
      return allSkills;
    }

    let added = 0;
    for (const item of page.items) {
      if (!seen.has(item.slug)) {
        allSkills.push(item);
        seen.add(item.slug);
        added++;
      }
    }

    console.log(`  Page ${pageNum}: +${added} new skills (total: ${allSkills.length})`);

    cursor = page.nextCursor || null;

    // Save progress every 5 pages
    if (pageNum % 5 === 0) {
      saveCache({ skills: allSkills, nextCursor: cursor, complete: false, fetchedAt: new Date().toISOString() });
    }

    if (!cursor) {
      saveCache({ skills: allSkills, nextCursor: null, complete: true, fetchedAt: new Date().toISOString() });
      console.log(`\n✅ Fetch complete! ${allSkills.length} skills saved to ${CACHE_FILE}\n`);
      return allSkills;
    }

    await sleep(PAGE_DELAY_MS);
  }
}

async function doImport(skills: ClawHubSkill[]) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    // Build existing index
    const existing = await prisma.iMSkill.findMany({
      where: { source: 'clawhub' },
      select: { slug: true, sourceId: true },
    });
    const existingMap = new Map(existing.map((s: { sourceId: string; slug: string }) => [s.sourceId, s.slug]));
    console.log(`Existing clawhub skills in DB: ${existing.length}`);
    console.log(`Skills to upsert: ${skills.length}\n`);

    let created = 0, updated = 0, errors = 0;

    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      const sourceId = `clawhub:${skill.slug}`;
      const slug = `clawhub-${skill.slug}`;
      const version = skill.latestVersion?.version || skill.tags?.latest || '0.0.0';

      const data = {
        name: skill.displayName || skill.slug,
        description: (skill.summary || '').slice(0, 2000),
        installs: skill.stats?.downloads || 0,
        stars: skill.stats?.stars || 0,
        metadata: JSON.stringify({
          version,
          updatedAt: skill.updatedAt,
          installsCurrent: skill.stats?.installsCurrent || 0,
          versions: skill.stats?.versions || 0,
          license: skill.latestVersion?.license,
          os: skill.metadata?.os,
        }),
      };

      try {
        if (existingMap.has(sourceId)) {
          await prisma.iMSkill.update({ where: { slug }, data });
          updated++;
        } else {
          await prisma.iMSkill.create({
            data: {
              slug,
              ...data,
              category: 'general',
              tags: JSON.stringify(skill.metadata?.os || []),
              author: '',
              source: 'clawhub',
              sourceUrl: `https://clawhub.ai/${skill.slug}`,
              sourceId,
              content: '',
            },
          });
          created++;
        }
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.error(`  ❌ Error on "${skill.slug}":`, (err as Error).message);
        }
      }

      if ((i + 1) % 100 === 0 || i === skills.length - 1) {
        console.log(`  Progress: ${i + 1}/${skills.length} (${created} new, ${updated} updated, ${errors} errors)`);
      }
    }

    console.log(`\n=== Import Complete ===`);
    console.log(`  Total processed: ${skills.length}`);
    console.log(`  Created:         ${created}`);
    console.log(`  Updated:         ${updated}`);
    console.log(`  Errors:          ${errors}`);
    console.log(`  Was in DB:       ${existing.length}`);
    console.log(`  Now in DB:       ${existing.length + created}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const cmd = process.argv[2] || 'all';
  console.log('=== ClawHub Skill Catalog Sync ===\n');

  if (cmd === 'fetch' || cmd === 'all') {
    const skills = await doFetch();
    if (cmd === 'all' && skills.length > 0) {
      await doImport(skills);
    }
  } else if (cmd === 'import') {
    const cache = loadCache();
    if (!cache || cache.skills.length === 0) {
      console.error(`No cached data found at ${CACHE_FILE}. Run 'fetch' first.`);
      process.exit(1);
    }
    console.log(`Loaded ${cache.skills.length} skills from cache (complete: ${cache.complete})\n`);
    await doImport(cache.skills);
  } else {
    console.log('Usage: sync-clawhub.ts [fetch|import|all]');
    console.log('  fetch  - Download from ClawHub API → /tmp/clawhub-skills.json');
    console.log('  import - Load from cache → database');
    console.log('  all    - Both (default)');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
