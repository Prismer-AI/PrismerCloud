import { NextRequest, NextResponse } from "next/server";

import { apiGuard } from "@/lib/api-guard";
import { createModuleLogger } from "@/lib/logger";
import { createRuntimeSigningKey, listRuntimeSigningKeys } from "@/lib/phase-a/signing-keys";

const log = createModuleLogger("RuntimeSigningKeys");

export async function GET(request: NextRequest) {
  try {
    const guard = await apiGuard(request, { tier: "tracked" });
    if (!guard.ok) return guard.response;

    const keys = await listRuntimeSigningKeys(guard.auth.userId);
    return NextResponse.json({ success: true, data: keys });
  } catch (error) {
    log.error({ err: error }, "GET runtime signing keys error");
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to fetch runtime signing keys" } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const guard = await apiGuard(request, { tier: "tracked" });
    if (!guard.ok) return guard.response;

    const body = await request.json().catch(() => ({}));
    const key = await createRuntimeSigningKey(guard.auth.userId, body);
    return NextResponse.json({ success: true, data: key }, { status: 201 });
  } catch (error: any) {
    log.error({ err: error }, "POST runtime signing key error");
    const message = error?.message || "Failed to register runtime signing key";
    const status = /did|key|algorithm|expires_at/.test(message) ? 400 : 500;
    return NextResponse.json(
      {
        success: false,
        error: {
          code: status === 400 ? "INVALID_RUNTIME_SIGNING_KEY" : "INTERNAL_ERROR",
          message,
        },
      },
      { status },
    );
  }
}
