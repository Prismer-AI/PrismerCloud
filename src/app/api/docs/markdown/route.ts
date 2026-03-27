import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GET /api/docs/markdown — Serve API.md as raw markdown.
 *
 * For AI agents: fetch this URL to get the complete API reference
 * in markdown format that can be parsed without loss.
 *
 * Supports:
 * - Accept: text/markdown → raw markdown (default)
 * - Accept: application/json → { ok: true, data: { content, version } }
 * - ?format=json → force JSON wrapper
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const forceJson = url.searchParams.get('format') === 'json';
  const accept = request.headers.get('accept') || '';

  const apiMdPath = path.join(process.cwd(), 'docs', 'API.md');

  let content: string;
  try {
    content = fs.readFileSync(apiMdPath, 'utf-8');
  } catch {
    return NextResponse.json({ ok: false, error: 'API.md not found' }, { status: 404 });
  }

  // Extract version from frontmatter
  const versionMatch = content.match(/\*\*Version:\*\*\s*(.+)/);
  const version = versionMatch?.[1]?.trim() || 'unknown';

  if (forceJson || accept.includes('application/json')) {
    return NextResponse.json({
      ok: true,
      data: {
        content,
        version,
        format: 'markdown',
        charCount: content.length,
        lineCount: content.split('\n').length,
      },
    });
  }

  // Default: raw markdown
  return new NextResponse(content, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      'X-Prismer-Version': version,
    },
  });
}
