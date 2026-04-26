import { NextRequest, NextResponse } from 'next/server';
import { getCookbook } from '@/app/docs/_lib/cookbook-loader';
import { isValidLocale } from '@/app/docs/_lib/i18n';
import type { Locale } from '@/app/docs/_lib/i18n';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('DocsCookbook');

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const localeParam = req.nextUrl.searchParams.get('locale') ?? 'en';
  const format = req.nextUrl.searchParams.get('format');

  if (!isValidLocale(localeParam)) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_INPUT', message: 'Invalid locale' } },
      { status: 400 },
    );
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_INPUT', message: 'Invalid slug format' } },
      { status: 400 },
    );
  }

  try {
    const locale = localeParam as Locale;
    const cookbook = getCookbook(locale, slug);
    if (!cookbook) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Cookbook not found' } },
        { status: 404 },
      );
    }

    if (format === 'json') {
      return NextResponse.json({
        success: true,
        data: {
          title: cookbook.title,
          description: cookbook.description,
          estimatedTime: cookbook.estimatedTime,
          endpoints: cookbook.endpoints,
          content: cookbook.content,
        },
      });
    }

    // Default: raw markdown
    return new NextResponse(cookbook.content, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    });
  } catch (err) {
    log.error({ err }, 'Internal error');
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
