import * as crypto from 'crypto';
import prisma from '../db';

export const PHOTO_MEMORY_SEGMENT_KIND = 'photo-memory-segment';

interface PhotoMemorySegmentInput {
  ownerId: string;
  workspaceId: string;
  content: string;
  metadata: Record<string, unknown>;
  fileName?: string;
}

export interface PhotoMemorySegmentMemoryFile {
  ownerId: string;
  ownerType: 'user';
  workspaceId: string;
  path: string;
  content: string;
  memoryType: typeof PHOTO_MEMORY_SEGMENT_KIND;
  description: string;
}

function stringField(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function ensureMarkdownExtension(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
}

function encodedPathSegment(raw: string): string {
  return encodeURIComponent(raw).replace(/%2F/gi, '%252F');
}

export function buildPhotoMemorySegmentMemoryFile(input: PhotoMemorySegmentInput): PhotoMemorySegmentMemoryFile {
  const segmentId = stringField(input.metadata, 'segmentId');
  const dateRangeStart = isoDay(stringField(input.metadata, 'dateRangeStart'));
  const dateRangeEnd = isoDay(stringField(input.metadata, 'dateRangeEnd'));
  const filenameFromMetadata = stringField(input.metadata, 'filename') ?? stringField(input.metadata, 'fileName');
  const stableFilename = ensureMarkdownExtension(filenameFromMetadata ?? input.fileName ?? segmentId ?? 'segment');

  let memoryPath: string;
  if (segmentId && dateRangeStart && dateRangeEnd) {
    const bareSegmentId = segmentId.startsWith('segment-') ? segmentId.slice('segment-'.length) : segmentId;
    memoryPath = `memory/wiki/${dateRangeStart}--${dateRangeEnd}/segment-${encodedPathSegment(bareSegmentId)}.md`;
  } else {
    memoryPath = `memory/wiki/${encodedPathSegment(stableFilename)}`;
  }

  const photoCountRaw = input.metadata.photoCount;
  const photoCount = typeof photoCountRaw === 'number' && Number.isFinite(photoCountRaw) ? photoCountRaw : null;
  const dateRange =
    dateRangeStart && dateRangeEnd ? `${dateRangeStart} - ${dateRangeEnd}` : (dateRangeStart ?? dateRangeEnd ?? null);
  const descriptionParts = ['Photo memory segment'];
  if (dateRange) descriptionParts.push(dateRange);
  if (photoCount != null) descriptionParts.push(`${photoCount} photos`);

  return {
    ownerId: input.ownerId,
    ownerType: 'user',
    workspaceId: input.workspaceId,
    path: memoryPath,
    content: input.content,
    memoryType: PHOTO_MEMORY_SEGMENT_KIND,
    description: descriptionParts.join(' · '),
  };
}

export async function upsertPhotoMemorySegmentMemoryFile(input: PhotoMemorySegmentInput) {
  const memoryFile = buildPhotoMemorySegmentMemoryFile(input);
  const contentHash = crypto.createHash('sha256').update(memoryFile.content).digest('hex');

  return prisma.iMMemoryFile.upsert({
    where: {
      workspaceId_path: {
        workspaceId: memoryFile.workspaceId,
        path: memoryFile.path,
      },
    },
    create: {
      ownerId: memoryFile.ownerId,
      ownerType: memoryFile.ownerType,
      workspaceId: memoryFile.workspaceId,
      path: memoryFile.path,
      content: memoryFile.content,
      memoryType: memoryFile.memoryType,
      description: memoryFile.description,
      version: 1,
      visibility: 'workspace',
      encrypted: false,
      contentHash,
      etag: contentHash,
      sourceKind: 'asset-hook',
      sourceRef: `prismer://workspace/${memoryFile.workspaceId}/memory/${memoryFile.path}`,
    },
    update: {
      ownerId: memoryFile.ownerId,
      ownerType: memoryFile.ownerType,
      content: memoryFile.content,
      memoryType: memoryFile.memoryType,
      description: memoryFile.description,
      stale: false,
      version: { increment: 1 },
      contentHash,
      etag: contentHash,
      sourceKind: 'asset-hook',
      sourceRef: `prismer://workspace/${memoryFile.workspaceId}/memory/${memoryFile.path}`,
    },
  });
}
