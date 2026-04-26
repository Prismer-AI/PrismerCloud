import { NextResponse } from 'next/server';
import { loadSpec } from '@/app/docs/_lib/openapi-loader';

export async function GET() {
  const spec = loadSpec();
  return NextResponse.json(spec.raw);
}
