import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('DeveloperDocs');

/**
 * Developer Documentation API
 *
 * Provides Skill.md for AI coding tools (Claude Code, Cursor, etc.)
 *
 * GET /api/docs/developer          → JSON with content + metadata
 * GET /api/docs/developer?doc=skill → Raw markdown
 */

interface DeveloperDocsResponse {
  success: boolean;
  docs: {
    skill: {
      content: string;
      version: string;
      lastUpdated: string;
    };
  };
  urls: {
    skill: string;
  };
}

function loadDocFile(filename: string): string {
  try {
    const filePath = join(process.cwd(), 'public', 'docs', filename);
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    log.error({ err: error, filename }, 'Failed to load doc file');
    return `# Error\n\nFailed to load ${filename}`;
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const specificDoc = searchParams.get('doc');

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://cloud.prismer.dev';

  // If requesting specific doc, return raw markdown
  if (specificDoc === 'skill') {
    const content = loadDocFile('Skill.md');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // Return doc as JSON
  const skillContent = loadDocFile('Skill.md');

  const response: DeveloperDocsResponse = {
    success: true,
    docs: {
      skill: {
        content: skillContent,
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
      },
    },
    urls: {
      skill: `${baseUrl}/api/docs/developer?doc=skill`,
    },
  };

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
