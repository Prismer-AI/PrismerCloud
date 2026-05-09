import { NextRequest, NextResponse } from "next/server";

import { apiGuard } from "@/lib/api-guard";
import { createModuleLogger } from "@/lib/logger";
import { listRuntimeSigningKeys } from "@/lib/phase-a/signing-keys";
import prisma from "@/lib/prisma";

const log = createModuleLogger("Runtimes");

const runtimeSelect = {
  id: true,
  ownerDid: true,
  ownerImUserId: true,
  type: true,
  did: true,
  hostname: true,
  os: true,
  arch: true,
  version: true,
  endpoint: true,
  capabilities: true,
  status: true,
  load: true,
  lastHeartbeatAt: true,
  registeredAt: true,
  updatedAt: true,
} as const;

export async function GET(request: NextRequest) {
  try {
    const guard = await apiGuard(request, { tier: "tracked" });
    if (!guard.ok) return guard.response;

    const signingKeys = await listRuntimeSigningKeys(guard.auth.userId);
    const ownedDids = [...new Set(signingKeys.map((key) => key.did))];
    const runtimes = await prisma.iMRuntime.findMany({
      where: {
        OR: [{ ownerImUserId: guard.auth.userId }, ...(ownedDids.length > 0 ? [{ did: { in: ownedDids } }] : [])],
      },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      select: runtimeSelect,
    });

    const activeSigningKeys = signingKeys.filter((key) => {
      const expiresAt = key.expiresAt ? new Date(key.expiresAt) : null;
      return !key.revokedAt && (!expiresAt || expiresAt > new Date());
    }).length;

    return NextResponse.json({
      success: true,
      data: {
        runtimes,
        signingKeys,
        summary: {
          runtimeCount: runtimes.length,
          onlineCount: runtimes.filter((runtime: { status: string }) => runtime.status === "online" || runtime.status === "busy")
            .length,
          signingKeyCount: signingKeys.length,
          activeSigningKeys,
        },
      },
    });
  } catch (error) {
    log.error({ err: error }, "GET runtimes error");
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to fetch runtimes" } },
      { status: 500 },
    );
  }
}
