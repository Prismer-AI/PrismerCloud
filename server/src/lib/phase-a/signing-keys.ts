import prisma from "@/lib/prisma";

export interface RuntimeSigningKeyInput {
  did: string;
  public_key: string;
  key_id?: string;
  key_version?: number;
  algorithm?: string;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSigningKeyRotationInput extends RuntimeSigningKeyInput {
  previous_key_id?: string;
}

export interface NormalizedRuntimeSigningKeyInput {
  did: string;
  publicKey: string;
  keyId: string;
  keyVersion: number;
  algorithm: "ed25519";
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}

type RuntimeSigningKeyRow = {
  id: string;
  did: string;
  keyVersion: number;
  publicKey: string;
  algorithm: string;
  keyId: string | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  metadata: string;
};

const runtimeSigningKeySelect = {
  id: true,
  did: true,
  keyVersion: true,
  publicKey: true,
  algorithm: true,
  keyId: true,
  revokedAt: true,
  expiresAt: true,
  createdAt: true,
  metadata: true,
} as const;

export function normalizeRuntimeSigningKeyInput(input: RuntimeSigningKeyInput): NormalizedRuntimeSigningKeyInput {
  const did = input.did?.trim();
  if (!did || !/^did:(key|web):/.test(did)) {
    throw new Error("did must be a did:key or did:web identifier");
  }

  const keyVersion = input.key_version ?? 1;
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new Error("key_version must be a positive integer");
  }

  const algorithm = input.algorithm?.trim().toLowerCase() || "ed25519";
  if (algorithm !== "ed25519") {
    throw new Error("algorithm must be ed25519");
  }

  const publicKey = input.public_key?.trim();
  if (!isValidEd25519PublicKey(publicKey)) {
    throw new Error("public_key must be a base64/base64url encoded 32-byte Ed25519 public key");
  }

  const keyId = input.key_id?.trim() || `${did}#k${keyVersion}`;
  if (!keyId.startsWith(`${did}#`)) {
    throw new Error("key_id must use the did as prefix");
  }

  const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error("expires_at must be an ISO timestamp");
  }

  return {
    did,
    publicKey,
    keyId,
    keyVersion,
    algorithm,
    expiresAt,
    metadata: input.metadata ?? {},
  };
}

export async function createRuntimeSigningKey(ownerUserId: string, input: RuntimeSigningKeyInput) {
  const normalized = normalizeRuntimeSigningKeyInput(input);
  const metadata = buildRuntimeSigningKeyMetadata(ownerUserId, normalized.metadata);

  const existing = (await prisma.iMSigningKey.findUnique({
    where: { keyId: normalized.keyId },
    select: runtimeSigningKeySelect,
  })) as RuntimeSigningKeyRow | null;
  if (existing) {
    assertRuntimeSigningKeyCanUpdate(existing, ownerUserId, normalized.publicKey);
    return prisma.iMSigningKey.update({
      where: { id: existing.id },
      data: {
        publicKey: normalized.publicKey,
        algorithm: normalized.algorithm,
        expiresAt: normalized.expiresAt,
        revokedAt: null,
        metadata,
      },
      select: runtimeSigningKeySelect,
    });
  }

  return prisma.iMSigningKey.create({
    data: {
      did: normalized.did,
      keyVersion: normalized.keyVersion,
      publicKey: normalized.publicKey,
      algorithm: normalized.algorithm,
      keyId: normalized.keyId,
      expiresAt: normalized.expiresAt,
      metadata,
    },
    select: runtimeSigningKeySelect,
  });
}

export async function listRuntimeSigningKeys(ownerUserId: string) {
  const keys = (await prisma.iMSigningKey.findMany({
    where: {
      metadata: {
        contains: `"ownerUserId":"${ownerUserId}"`,
      },
    },
    orderBy: [{ did: "asc" }, { keyVersion: "desc" }],
    select: runtimeSigningKeySelect,
  })) as RuntimeSigningKeyRow[];
  return keys.filter((key) => metadataMatchesOwner(key.metadata, ownerUserId));
}

export async function revokeRuntimeSigningKey(ownerUserId: string, idOrKeyId: string) {
  const existing = await findOwnedRuntimeSigningKey(ownerUserId, idOrKeyId);
  if (!existing) {
    return null;
  }

  return prisma.iMSigningKey.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
    select: runtimeSigningKeySelect,
  });
}

export async function rotateRuntimeSigningKey(ownerUserId: string, input: RuntimeSigningKeyRotationInput) {
  const previous = await resolvePreviousRuntimeSigningKey(ownerUserId, input);
  const nextVersion = input.key_version ?? ((previous?.keyVersion ?? 0) + 1);
  const normalized = normalizeRuntimeSigningKeyInput({
    ...input,
    key_version: nextVersion,
  });
  const metadata = buildRuntimeSigningKeyMetadata(ownerUserId, {
    ...normalized.metadata,
    rotatedFromKeyId: previous?.keyId ?? null,
  });

  return prisma.$transaction(async (tx: any) => {
    const existing = (await tx.iMSigningKey.findUnique({
      where: { keyId: normalized.keyId },
      select: runtimeSigningKeySelect,
    })) as RuntimeSigningKeyRow | null;
    if (existing) {
      assertRuntimeSigningKeyCanUpdate(existing, ownerUserId, normalized.publicKey);
    }

    const next = existing
      ? await tx.iMSigningKey.update({
          where: { id: existing.id },
          data: {
            publicKey: normalized.publicKey,
            algorithm: normalized.algorithm,
            expiresAt: normalized.expiresAt,
            revokedAt: null,
            metadata,
          },
          select: runtimeSigningKeySelect,
        })
      : await tx.iMSigningKey.create({
          data: {
            did: normalized.did,
            keyVersion: normalized.keyVersion,
            publicKey: normalized.publicKey,
            algorithm: normalized.algorithm,
            keyId: normalized.keyId,
            expiresAt: normalized.expiresAt,
            metadata,
          },
          select: runtimeSigningKeySelect,
        });

    if (previous && previous.id !== next.id && !previous.revokedAt) {
      await tx.iMSigningKey.update({
        where: { id: previous.id },
        data: { revokedAt: new Date() },
      });
    }

    return next;
  });
}

export function assertRuntimeSigningKeyCanUpdate(
  key: Pick<RuntimeSigningKeyRow, "metadata" | "publicKey">,
  ownerUserId: string,
  publicKey: string,
): void {
  assertRuntimeSigningKeyOwner(key.metadata, ownerUserId);
  if (key.publicKey !== publicKey) {
    throw new Error("key_id already exists with different public_key");
  }
}

export function assertRuntimeSigningKeyOwner(metadata: string | null | undefined, ownerUserId: string): void {
  if (!metadataMatchesOwner(metadata, ownerUserId)) {
    throw new Error("key_id already exists for another owner");
  }
}

export function isValidEd25519PublicKey(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return decodeBase64Any(value).length === 32;
  } catch {
    return false;
  }
}

function decodeBase64Any(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function buildRuntimeSigningKeyMetadata(ownerUserId: string, metadata: Record<string, unknown>): string {
  return JSON.stringify({
    ...metadata,
    ownerUserId,
    phase: "phase_a",
    purpose: "runtime_admission",
  });
}

async function findOwnedRuntimeSigningKey(ownerUserId: string, idOrKeyId: string) {
  const key = (await prisma.iMSigningKey.findFirst({
    where: {
      OR: [{ id: idOrKeyId }, { keyId: idOrKeyId }],
    },
    select: runtimeSigningKeySelect,
  })) as RuntimeSigningKeyRow | null;
  if (!key || !metadataMatchesOwner(key.metadata, ownerUserId)) {
    return null;
  }
  return key;
}

async function resolvePreviousRuntimeSigningKey(ownerUserId: string, input: RuntimeSigningKeyRotationInput) {
  if (input.previous_key_id) {
    const key = await findOwnedRuntimeSigningKey(ownerUserId, input.previous_key_id);
    if (!key) {
      throw new Error("previous_key_id was not found for this user");
    }
    if (key.did !== input.did) {
      throw new Error("previous_key_id must belong to the same did");
    }
    return key;
  }

  const candidates = (await prisma.iMSigningKey.findMany({
    where: {
      did: input.did,
      metadata: {
        contains: `"ownerUserId":"${ownerUserId}"`,
      },
    },
    orderBy: { keyVersion: "desc" },
    take: 10,
    select: runtimeSigningKeySelect,
  })) as RuntimeSigningKeyRow[];
  return candidates.find((key) => metadataMatchesOwner(key.metadata, ownerUserId)) ?? null;
}

export function metadataMatchesOwner(metadata: string | null | undefined, ownerUserId: string): boolean {
  if (!metadata) {
    return false;
  }
  try {
    const parsed = JSON.parse(metadata);
    return parsed?.ownerUserId === ownerUserId && parsed?.phase === "phase_a" && parsed?.purpose === "runtime_admission";
  } catch {
    return false;
  }
}
