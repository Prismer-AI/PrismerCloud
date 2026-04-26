/**
 * Prismer IM — Structured Memory Extraction (P1 v1.8.0)
 *
 * Extracts durable memories from session journals using LLM.
 * Follows Claude Code's extractMemories pattern:
 *   1. Classify as user | feedback | project | reference
 *   2. Dedup against existing manifest
 *   3. Upsert via MemoryService
 *
 * Called by Plugin Stop Hook or POST /api/im/memory/extract.
 */

import type { MemoryService } from './memory.service';

const LOG = '[MemoryExtract]';

const MAX_CONTENT_SIZE = 8192;

function getLLMConfig() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  const apiBase =
    process.env.OPENAI_BASE_URL ||
    process.env.OPENAI_API_BASE_URL ||
    process.env.LLM_API_BASE ||
    'https://api.openai.com/v1';
  const model =
    process.env.LLM_EXTRACT_MODEL ||
    process.env.LLM_RECALL_MODEL ||
    process.env.DISTILL_MODEL ||
    process.env.DEFAULT_MODEL ||
    'gpt-4o-mini';
  return { apiKey, apiBase, model };
}

function sanitizePath(raw: string): string {
  let p = raw.replace(/\.\./g, '').replace(/^\/+/, '');
  p = p.replace(/[^a-zA-Z0-9_\-/.]/g, '_');
  if (p.length > 120) p = p.slice(0, 120);
  if (!p.endsWith('.md')) p += '.md';
  return p || 'untitled.md';
}

export interface ExtractInput {
  agentId: string;
  journal: string;
  scope?: string;
  existingPaths?: string[];
}

export interface ExtractedMemory {
  path: string;
  memoryType: 'user' | 'feedback' | 'project' | 'reference';
  description: string;
  content: string;
  action: 'create' | 'update';
}

export interface ExtractResult {
  extracted: ExtractedMemory[];
  saved: number;
  skipped: number;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Analyze the session journal and extract durable memories.

For each memory candidate, output a JSON object:
{
  "path": "descriptive-filename.md",
  "memoryType": "user" | "feedback" | "project" | "reference",
  "description": "One-line summary of what this memory contains",
  "content": "The actual memory content in markdown"
}

Classification rules:
- user: Personal preferences, communication style, workflow habits
- feedback: Explicit user feedback with Why + How-to-apply
- project: Project-specific facts (convert relative dates to absolute)
- reference: Reusable technical knowledge, patterns, conventions

Extraction rules:
- Only extract information NOT derivable from code or git history
- Feedback memories MUST include the reasoning (Why) and actionable steps (How-to-apply)
- Project memories MUST use absolute dates (e.g., "2026-04-03" not "yesterday")
- Do NOT extract ephemeral task state, debugging details, or error logs
- Maximum 3 new memories per session (quality over quantity)
- If an existing memory covers the same topic, output action: "update" with the path of the existing file

Return a JSON array of extracted memories. If nothing is worth extracting, return [].`;

/**
 * Extract structured memories from a session journal.
 */
export async function extractMemories(memoryService: MemoryService, input: ExtractInput): Promise<ExtractResult> {
  const { agentId, journal, scope = 'global' } = input;

  if (!journal || journal.trim().length < 50) {
    return { extracted: [], saved: 0, skipped: 0 };
  }

  // Load existing memory manifest for dedup context
  let existingManifest = '';
  try {
    const existing = await memoryService.listMemoryFiles(agentId, scope);
    if (existing.length > 0) {
      existingManifest =
        '\n\nExisting memories (check for duplicates/updates):\n' +
        existing.map((f: any) => `- ${f.path} [${f.memoryType}]: ${f.description || '(no description)'}`).join('\n');
    }
  } catch {
    // Non-blocking
  }

  const userPrompt = `Session journal (last ~4KB):
---
${journal.slice(-4096)}
---
${existingManifest}

Extract durable memories. Return JSON array only.`;

  try {
    const { apiKey, apiBase, model } = getLLMConfig();

    if (!apiKey) {
      console.warn(`${LOG} No LLM API key configured, skipping extraction`);
      return { extracted: [], saved: 0, skipped: 0 };
    }

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      console.warn(`${LOG} LLM extraction failed (${response.status})`);
      return { extracted: [], saved: 0, skipped: 0 };
    }

    const json = (await response.json()) as any;
    const text = json.choices?.[0]?.message?.content || '[]';

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      console.warn(`${LOG} LLM returned unparseable response`);
      return { extracted: [], saved: 0, skipped: 0 };
    }

    let candidates: ExtractedMemory[];
    try {
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) {
        console.warn(`${LOG} LLM returned non-array JSON`);
        return { extracted: [], saved: 0, skipped: 0 };
      }
      candidates = parsed;
    } catch (parseErr) {
      console.warn(`${LOG} JSON parse failed:`, (parseErr as Error).message);
      return { extracted: [], saved: 0, skipped: 0 };
    }

    if (candidates.length === 0) {
      return { extracted: [], saved: 0, skipped: 0 };
    }

    const capped = candidates.slice(0, 3);

    let saved = 0;
    let skipped = 0;
    const extracted: ExtractedMemory[] = [];

    for (const mem of capped) {
      if (!mem.path || !mem.content || !mem.memoryType) {
        skipped++;
        continue;
      }

      // Sanitize path — prevent traversal and enforce limits
      mem.path = sanitizePath(mem.path);

      // Enforce content size limit
      if (mem.content.length > MAX_CONTENT_SIZE) {
        mem.content = mem.content.slice(0, MAX_CONTENT_SIZE);
      }

      const validTypes = ['user', 'feedback', 'project', 'reference'];
      if (!validTypes.includes(mem.memoryType)) {
        mem.memoryType = 'reference';
      }

      try {
        const existing = await memoryService.readMemoryFileByPath(agentId, scope, mem.path);

        if (existing) {
          await memoryService.updateMemoryFile(existing.id, 'replace', mem.content);
          mem.action = 'update';
          console.log(`${LOG} Updated memory: ${mem.path}`);
        } else {
          await memoryService.writeMemoryFile(
            agentId,
            'agent',
            mem.path,
            mem.content,
            scope,
            mem.memoryType,
            mem.description,
          );
          mem.action = 'create';
          console.log(`${LOG} Created memory: ${mem.path} [${mem.memoryType}]`);
        }
        saved++;
        extracted.push(mem);
      } catch (err) {
        console.warn(`${LOG} Failed to save ${mem.path}:`, (err as Error).message);
        skipped++;
      }
    }

    console.log(`${LOG} Extraction complete: ${saved} saved, ${skipped} skipped from ${capped.length} candidates`);
    return { extracted, saved, skipped };
  } catch (err) {
    console.error(`${LOG} Extraction error:`, (err as Error).message);
    return { extracted: [], saved: 0, skipped: 0 };
  }
}
