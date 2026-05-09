import { NextRequest, NextResponse } from "next/server";

import { apiGuard } from "@/lib/api-guard";
import { createModuleLogger } from "@/lib/logger";
import { rotateRuntimeSigningKey } from "@/lib/phase-a/signing-keys";

const log = createModuleLogger("RuntimeSigningKeyRotation");

export async function POST(request: NextRequest) {
  try {
    const guard = await apiGuard(request, { tier: "tracked" });
    if (!guard.ok) return guard.response;

    const body = await request.json().catch(() => ({}));
    const key = await rotateRuntimeSigningKey(guard.auth.userId, body);
    return NextResponse.json({ success: true, data: key }, { status: 201 });
  } catch (error: any) {
    log.error({ err: error }, "POST runtime signing key rotation error");
    const message = error?.message || "Failed to rotate runtime signing key";
    const status = /did|key|algorithm|expires_at|previous_key_id/.test(message) ? 400 : 500;
    return NextResponse.json(
      {
        success: false,
        error: {
          code: status === 400 ? "INVALID_RUNTIME_SIGNING_KEY_ROTATION" : "INTERNAL_ERROR",
          message,
        },
      },
      { status },
    );
  }
}
