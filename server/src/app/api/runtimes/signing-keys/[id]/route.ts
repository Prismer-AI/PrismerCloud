import { NextRequest, NextResponse } from "next/server";

import { apiGuard } from "@/lib/api-guard";
import { createModuleLogger } from "@/lib/logger";
import { revokeRuntimeSigningKey } from "@/lib/phase-a/signing-keys";

const log = createModuleLogger("RuntimeSigningKey");

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await apiGuard(request, { tier: "tracked" });
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const key = await revokeRuntimeSigningKey(guard.auth.userId, decodeURIComponent(id));
    if (!key) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: "Runtime signing key not found" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: key });
  } catch (error) {
    log.error({ err: error }, "DELETE runtime signing key error");
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to revoke runtime signing key" } },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return DELETE(request, context);
}
