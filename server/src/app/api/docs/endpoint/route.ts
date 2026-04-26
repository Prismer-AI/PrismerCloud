import { NextRequest, NextResponse } from 'next/server';
import { getEndpointByPath } from '@/app/docs/_lib/openapi-loader';
import { findCookbooksForEndpoint } from '@/app/docs/_lib/cookbook-loader';
import { isValidLocale } from '@/app/docs/_lib/i18n';
import type { Locale } from '@/app/docs/_lib/i18n';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('DocsEndpoint');

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get('path');
  const method = req.nextUrl.searchParams.get('method') ?? undefined;
  let locale: Locale = 'en';
  const localeParam = req.nextUrl.searchParams.get('locale') ?? 'en';
  if (isValidLocale(localeParam)) {
    locale = localeParam;
  }

  if (!path) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_INPUT', message: 'path parameter required' } },
      { status: 400 },
    );
  }

  try {
    const endpoint = getEndpointByPath(path, method);
    if (!endpoint) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } },
        { status: 404 },
      );
    }

    const relatedCookbooks = findCookbooksForEndpoint(locale, endpoint.path).map((c) => c.slug);

    const codeSamples: Record<string, string> = {};
    for (const sample of endpoint.codeSamples ?? []) {
      codeSamples[sample.lang] = sample.source;
    }

    return NextResponse.json({
      success: true,
      data: {
        operationId: endpoint.operationId,
        method: endpoint.method,
        path: endpoint.path,
        summary: endpoint.summary,
        description: endpoint.description,
        group: endpoint.group,
        parameters: endpoint.parameters,
        bodyFields: endpoint.bodyFields,
        exampleRequests: endpoint.exampleRequests,
        exampleResponses: endpoint.exampleResponses,
        codeSamples,
        relatedCookbooks,
        cost: endpoint.cost,
        rateLimit: endpoint.rateLimit,
      },
    });
  } catch (err) {
    log.error({ err }, 'Internal error');
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
