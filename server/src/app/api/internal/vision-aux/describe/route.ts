import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { describeVisionAux, VisionAuxError } from '@/lib/vision-aux';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  assetId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  mime: z.string().min(1),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url: z.string().url() }),
    z.object({ kind: z.literal('data_url'), url: z.string().startsWith('data:') }),
  ]),
  maxTokens: z.number().int().min(1).max(1000).optional(),
  instruction: z.string().trim().min(1).max(1000).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'vision_aux_unauthorized', retryable: false },
      { status: 401 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'invalid_request', details: parsed.error.flatten(), retryable: false },
      { status: 400 },
    );
  }

  try {
    const data = await describeVisionAux(parsed.data);
    return NextResponse.json({ ok: true, data });
  } catch (err) {
    if (err instanceof VisionAuxError) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.message, retryable: err.retryable },
        { status: err.status },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: 'vision_aux_unavailable',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      },
      { status: 503 },
    );
  }
}

function isAuthorized(req: NextRequest): boolean {
  const configured =
    process.env.VISION_AUX_INTERNAL_SECRET ||
    process.env.INTERNAL_API_SECRET ||
    process.env.PRISMER_INTERNAL_SECRET;
  if (!configured && process.env.NODE_ENV !== 'production') return true;
  if (!configured) return false;

  const authorization = req.headers.get('authorization') || '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const direct = req.headers.get('x-prismer-internal-secret') || req.headers.get('x-internal-secret') || '';
  return bearer === configured || direct === configured;
}
