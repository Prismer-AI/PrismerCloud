/**
 * Prismer IM — Binding Service
 *
 * Manages social platform bindings (Telegram, Discord, etc.)
 */

import type { PrismaClient } from "@prisma/client";
import type {
  BindingPlatform,
  BindingInfo,
  CreateBindingInput,
} from "../types/index";
import { safeJsonParse } from "../utils/safe-json";

const VALID_PLATFORMS: BindingPlatform[] = ["telegram", "discord", "slack"];

function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export class BindingService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create a new social binding (status = pending).
   */
  async create(
    imUserId: string,
    input: CreateBindingInput
  ): Promise<{
    bindingId: string;
    platform: BindingPlatform;
    status: string;
    verificationCode: string;
  }> {
    if (!VALID_PLATFORMS.includes(input.platform)) {
      throw new Error(`Invalid platform: ${input.platform}`);
    }

    // Check for existing binding on this platform
    const existing = await this.prisma.iMBinding.findUnique({
      where: { imUserId_platform: { imUserId, platform: input.platform } },
    });
    if (existing) {
      throw new Error(
        `Already bound to ${input.platform}. Remove existing binding first.`
      );
    }

    const verificationCode = generateVerificationCode();

    const binding = await this.prisma.iMBinding.create({
      data: {
        imUserId,
        platform: input.platform,
        status: "pending",
        botToken: input.botToken,
        channelId: input.channelId ?? input.chatId,
        webhookUrl: input.webhookUrl,
        verificationCode,
        capabilities: JSON.stringify(["receive_message", "send_message"]),
      },
    });

    return {
      bindingId: binding.id,
      platform: input.platform,
      status: binding.status,
      verificationCode,
    };
  }

  /**
   * Verify a binding with the provided code.
   */
  async verify(
    bindingId: string,
    imUserId: string,
    code: string
  ): Promise<BindingInfo> {
    const binding = await this.prisma.iMBinding.findUnique({
      where: { id: bindingId },
    });

    if (!binding) {
      throw new Error("Binding not found");
    }
    if (binding.imUserId !== imUserId) {
      throw new Error("Not your binding");
    }
    if (binding.status !== "pending") {
      throw new Error(`Binding is ${binding.status}, cannot verify`);
    }
    if (binding.verificationCode !== code) {
      throw new Error("Invalid verification code");
    }

    const updated = await this.prisma.iMBinding.update({
      where: { id: bindingId },
      data: {
        status: "active",
        verifiedAt: new Date(),
        verificationCode: null, // Clear code after verification
      },
    });

    return {
      id: updated.id,
      platform: updated.platform as BindingPlatform,
      status: "active",
      externalId: updated.externalId,
      externalName: updated.externalName,
      capabilities: safeJsonParse<string[]>(updated.capabilities, []),
      createdAt: updated.createdAt,
    };
  }

  /**
   * List all bindings for a user.
   */
  async list(imUserId: string): Promise<BindingInfo[]> {
    const bindings = await this.prisma.iMBinding.findMany({
      where: { imUserId },
      orderBy: { createdAt: "desc" },
    });

    return bindings.map((b) => ({
      id: b.id,
      platform: b.platform as BindingPlatform,
      status: b.status as any,
      externalId: b.externalId,
      externalName: b.externalName,
      capabilities: safeJsonParse<string[]>(b.capabilities, []),
      createdAt: b.createdAt,
    }));
  }

  /**
   * Revoke (delete) a binding.
   */
  async revoke(bindingId: string, imUserId: string): Promise<void> {
    const binding = await this.prisma.iMBinding.findUnique({
      where: { id: bindingId },
    });

    if (!binding) {
      throw new Error("Binding not found");
    }
    if (binding.imUserId !== imUserId) {
      throw new Error("Not your binding");
    }

    await this.prisma.iMBinding.delete({ where: { id: bindingId } });
  }

  /**
   * Find a binding by platform + external ID (for inbound message routing).
   */
  async getByPlatformAndExternalId(
    platform: string,
    externalId: string
  ): Promise<{ imUserId: string; bindingId: string } | null> {
    const binding = await this.prisma.iMBinding.findFirst({
      where: { platform, externalId, status: "active" },
    });
    if (!binding) return null;
    return { imUserId: binding.imUserId, bindingId: binding.id };
  }

  /**
   * Get active bindings for a user (for outbound message bridging).
   */
  async getActiveBindings(imUserId: string): Promise<BindingInfo[]> {
    const bindings = await this.prisma.iMBinding.findMany({
      where: { imUserId, status: "active" },
    });

    return bindings.map((b) => ({
      id: b.id,
      platform: b.platform as BindingPlatform,
      status: "active" as const,
      externalId: b.externalId,
      externalName: b.externalName,
      capabilities: safeJsonParse<string[]>(b.capabilities, []),
      createdAt: b.createdAt,
    }));
  }

  /**
   * Get a binding by ID (with full details including tokens).
   */
  async getById(bindingId: string) {
    return this.prisma.iMBinding.findUnique({ where: { id: bindingId } });
  }
}
