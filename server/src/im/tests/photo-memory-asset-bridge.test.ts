import { buildPhotoMemorySegmentMemoryFile } from '../services/asset-memory-bridge.service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

test('builds canonical mobile-compatible memory path from segment metadata', () => {
  const file = buildPhotoMemorySegmentMemoryFile({
    ownerId: 'imu_1',
    workspaceId: 'ws_1',
    content: '# Segment\n\nSeattle coffee receipt',
    fileName: 'segment-abc.md',
    metadata: {
      kind: 'photo-memory-segment',
      segmentId: 'segment-abc',
      dateRangeStart: '2026-04-01T08:30:00Z',
      dateRangeEnd: '2026-04-30T23:59:59Z',
      photoCount: 100,
      photoRefs: [{ localId: 'PHAsset-1', sourceHash: 'hash-1' }],
    },
  });

  assert(file.ownerId === 'imu_1', 'ownerId should be current imUserId');
  assert(file.ownerType === 'user', 'ownerType should be user');
  assert(file.workspaceId === 'ws_1', 'workspaceId should be carried onto the memory file');
  assert(file.path === 'memory/wiki/2026-04-01--2026-04-30/segment-abc.md', `unexpected path ${file.path}`);
  assert(file.content.includes('Seattle coffee receipt'), 'content should be uploaded markdown');
  assert(file.memoryType === 'photo-memory-segment', 'memoryType should identify photo memory segments');
  assert(file.description.includes('2026-04-01 - 2026-04-30'), 'description should include date range');
  assert(file.description.includes('100 photos'), 'description should include photo count');
});

test('falls back to stable metadata filename path', () => {
  const file = buildPhotoMemorySegmentMemoryFile({
    ownerId: 'imu_1',
    workspaceId: 'ws_1',
    content: 'markdown',
    fileName: 'ignored.md',
    metadata: {
      kind: 'photo-memory-segment',
      filename: 'trip album',
    },
  });

  assert(file.path === 'memory/wiki/trip%20album.md', `unexpected fallback path ${file.path}`);
});
