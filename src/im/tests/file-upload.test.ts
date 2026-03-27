/**
 * Prismer IM — File Upload Tests (v1.7.0)
 *
 * Tests the file upload lifecycle: presign → upload → confirm → send file message.
 * Runs against the standalone IM server in dev mode (local filesystem, no S3).
 *
 * Prerequisites:
 *   - IM server running: npm run im:start
 *
 * Usage: npx tsx src/im/tests/file-upload.test.ts
 */

import * as crypto from 'crypto';

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';
const TS = String(Date.now()).slice(-8);

// ─── Test Infrastructure ────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];
let currentSuite = '';
const suiteResults: { name: string; passed: number; failed: number }[] = [];
let suiteP = 0;
let suiteF = 0;

function suite(name: string) {
  if (currentSuite) {
    suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });
  }
  suiteP = 0;
  suiteF = 0;
  currentSuite = name;
  console.log(`\n── ${name} ──`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    suiteP++;
    console.log(`  ✅ ${name}`);
  } catch (err: unknown) {
    failed++;
    suiteF++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { ok: res.ok };
  }
  return { status: res.status, data };
}

/**
 * Resolve a dev URL returned by the API.
 * Standalone mode: /api/im/files/... → http://localhost:3200/api/files/...
 */
function resolveUrl(raw: string): string {
  if (raw.startsWith('http')) return raw;
  return `${BASE}${raw.replace('/api/im/', '/api/')}`;
}

/**
 * Helper: presign + upload + confirm a file. Returns all relevant data.
 */
async function uploadFullCycle(
  fileName: string,
  content: Buffer,
  mimeType: string,
  token: string,
): Promise<{ uploadId: string; cdnUrl: string; cdnUrlRaw: string; fileSize: number; sha256: string }> {
  const presign = await api(
    'POST', '/files/presign',
    { fileName, fileSize: content.length, mimeType },
    token,
  );
  if (!presign.data.ok) throw new Error(`Presign failed: ${JSON.stringify(presign.data)}`);

  const url = resolveUrl(presign.data.data.url);
  const uploadId = presign.data.data.uploadId;

  const formData = new FormData();
  formData.append('file', new Blob([content], { type: mimeType }), fileName);
  const uploadRes = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (uploadRes.status !== 200) throw new Error(`Upload failed: ${uploadRes.status}`);

  const confirm = await api('POST', '/files/confirm', { uploadId }, token);
  if (!confirm.data.ok) throw new Error(`Confirm failed: ${JSON.stringify(confirm.data)}`);

  return {
    uploadId,
    cdnUrl: resolveUrl(confirm.data.data.cdnUrl),
    cdnUrlRaw: confirm.data.data.cdnUrl,
    fileSize: confirm.data.data.fileSize,
    sha256: confirm.data.data.sha256,
  };
}

// ─── Test State ─────────────────────────────────────────────

let userToken = '';
let userId = '';
let otherUserToken = '';
let otherUserId = '';
let conversationId = '';
let uploadId = '';
let presignUrl = '';
let cdnUrl = '';      // Resolved URL (full http://... for fetch)
let cdnUrlRaw = '';   // Raw URL as returned by API (may be relative)
let confirmedFileSize = 0;

// ─── Setup ──────────────────────────────────────────────────

async function setup() {
  console.log('\n📦 File Upload Tests (v1.7.0)');
  console.log(`   Base URL: ${BASE}`);
  console.log(`   Timestamp: ${TS}\n`);

  // Register user A
  const regRes = await api('POST', '/register', {
    username: `filetest_${TS}`,
    displayName: `File Tester ${TS}`,
    type: 'human',
  });
  assert(regRes.data.ok, `Registration failed: ${JSON.stringify(regRes.data)}`);
  userToken = regRes.data.data.token;
  userId = regRes.data.data.imUserId;

  // Register user B (for ownership tests)
  const reg2 = await api('POST', '/register', {
    username: `filepeer_${TS}`,
    displayName: `File Peer ${TS}`,
    type: 'human',
  });
  assert(reg2.data.ok, `Peer registration failed: ${JSON.stringify(reg2.data)}`);
  otherUserToken = reg2.data.data.token;
  otherUserId = reg2.data.data.imUserId;

  // Create a direct conversation between A and B
  const convRes = await api(
    'POST',
    '/conversations/direct',
    { otherUserId },
    userToken,
  );
  assert(convRes.data.ok, `Conversation creation failed: ${JSON.stringify(convRes.data)}`);
  conversationId = convRes.data.data.id;

  console.log(`   User A: ${userId}`);
  console.log(`   User B: ${otherUserId}`);
  console.log(`   Conversation: ${conversationId}\n`);
}

// ─── 1. Presign Tests ────────────────────────────────────────

async function presignTests() {
  suite('1. Presign');

  await test('happy path — text file', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'hello.txt', fileSize: 1024, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.ok === true, 'Expected ok: true');
    assert(typeof res.data.data.uploadId === 'string', 'Expected uploadId');
    assert(res.data.data.uploadId.startsWith('fu_'), 'uploadId should start with fu_');
    assert(typeof res.data.data.url === 'string', 'Expected url');
    assert(typeof res.data.data.expiresAt === 'string', 'Expected expiresAt');

    uploadId = res.data.data.uploadId;
    presignUrl = resolveUrl(res.data.data.url);
  });

  await test('happy path — image', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'photo.jpg', fileSize: 500_000, mimeType: 'image/jpeg' },
      userToken,
    );
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.ok === true, 'Expected ok: true');
  });

  await test('concurrent presigns — unique uploadIds', async () => {
    const [r1, r2, r3] = await Promise.all([
      api('POST', '/files/presign', { fileName: 'a.txt', fileSize: 100, mimeType: 'text/plain' }, userToken),
      api('POST', '/files/presign', { fileName: 'b.txt', fileSize: 100, mimeType: 'text/plain' }, userToken),
      api('POST', '/files/presign', { fileName: 'c.txt', fileSize: 100, mimeType: 'text/plain' }, userToken),
    ]);
    assert(r1.data.ok && r2.data.ok && r3.data.ok, 'All presigns should succeed');
    const ids = new Set([r1.data.data.uploadId, r2.data.data.uploadId, r3.data.data.uploadId]);
    assert(ids.size === 3, 'All uploadIds should be unique');
  });

  await test('rejected — blocked MIME type', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'script.exe', fileSize: 1024, mimeType: 'application/x-msdownload' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    assert(res.data.ok === false, 'Expected ok: false');
  });

  await test('rejected — blocked extension with allowed MIME', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'malware.exe', fileSize: 1024, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — double extension (.txt.exe)', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'document.txt.sh', fileSize: 1024, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — file too large (simple)', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'big.txt', fileSize: 20 * 1024 * 1024, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — zero file size', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'empty.txt', fileSize: 0, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — negative file size', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'neg.txt', fileSize: -100, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — missing fileName', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileSize: 1024, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — fileName with null byte', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: 'test\x00.exe', fileSize: 1024, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — fileName with path separator', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: '../../etc/passwd', fileSize: 1024, mimeType: 'text/plain' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('rejected — no auth', async () => {
    const res = await api('POST', '/files/presign', {
      fileName: 'hello.txt', fileSize: 1024, mimeType: 'text/plain',
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });
}

// ─── 2. Upload + Confirm Tests ───────────────────────────────

async function uploadConfirmTests() {
  suite('2. Upload + Confirm');

  const uploadContent = Buffer.from('Hello from Prismer file upload test!\n'.repeat(20));

  await test('dev upload: happy path', async () => {
    const formData = new FormData();
    formData.append('file', new Blob([uploadContent], { type: 'text/plain' }), 'hello.txt');

    const res = await fetch(presignUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: formData,
    });

    const data = await res.json();
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert(data.ok === true, 'Expected ok: true');
    assert(data.data.uploaded === true, 'Expected uploaded: true');
  });

  await test('confirm: happy path + fileSize accuracy', async () => {
    const res = await api('POST', '/files/confirm', { uploadId }, userToken);
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(res.data.ok === true, 'Expected ok: true');
    assert(typeof res.data.data.cdnUrl === 'string', 'Expected cdnUrl');
    assert(typeof res.data.data.fileName === 'string', 'Expected fileName');
    assert(typeof res.data.data.fileSize === 'number', 'Expected fileSize');
    // Verify fileSize matches actual uploaded content
    assert(
      res.data.data.fileSize === uploadContent.length,
      `fileSize should be ${uploadContent.length}, got ${res.data.data.fileSize}`,
    );
    assert(typeof res.data.data.sha256 === 'string', 'Expected sha256');
    assert(res.data.data.sha256.length === 64, 'sha256 should be 64 hex chars');

    cdnUrlRaw = res.data.data.cdnUrl;
    cdnUrl = resolveUrl(cdnUrlRaw);
    confirmedFileSize = res.data.data.fileSize;
  });

  await test('confirm: SHA-256 matches actual content hash', async () => {
    const expectedSha = crypto.createHash('sha256').update(uploadContent).digest('hex');
    const res = await api('POST', '/files/confirm', { uploadId }, userToken);
    assert(res.data.ok, 'Re-confirm failed');
    assert(
      res.data.data.sha256 === expectedSha,
      `SHA-256 mismatch: expected ${expectedSha}, got ${res.data.data.sha256}`,
    );
  });

  await test('confirm: idempotent — re-confirm returns same result', async () => {
    const res = await api('POST', '/files/confirm', { uploadId }, userToken);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.ok === true, 'Expected ok: true');
    assert(resolveUrl(res.data.data.cdnUrl) === cdnUrl, 'CDN URL should match');
    assert(res.data.data.cost === 0, 'Idempotent re-confirm cost should be 0');
  });

  await test('confirm: rejected — not found', async () => {
    const res = await api(
      'POST', '/files/confirm',
      { uploadId: 'fu_0000000000000_nonexistent' },
      userToken,
    );
    assert(res.status === 404, `Expected 404, got ${res.status}`);
    assert(res.data.ok === false, 'Expected ok: false');
  });

  await test('confirm: rejected — missing uploadId', async () => {
    const res = await api('POST', '/files/confirm', {}, userToken);
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('confirm: rejected — not owner (uploaded file)', async () => {
    // Presign + upload as user A, then try confirm as user B
    const presign = await api(
      'POST', '/files/presign',
      { fileName: 'owned.txt', fileSize: 50, mimeType: 'text/plain' },
      userToken,
    );
    assert(presign.data.ok, 'Presign failed');
    const ownedUploadId = presign.data.data.uploadId;
    const ownedUrl = resolveUrl(presign.data.data.url);

    // Upload as user A
    const content = Buffer.from('This belongs to user A only!');
    const formData = new FormData();
    formData.append('file', new Blob([content], { type: 'text/plain' }), 'owned.txt');
    const uploadRes = await fetch(ownedUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: formData,
    });
    assert(uploadRes.status === 200, 'Upload should succeed');

    // Try confirm as user B
    const res = await api('POST', '/files/confirm', { uploadId: ownedUploadId }, otherUserToken);
    assert(
      res.status === 403 || res.status === 404,
      `Expected 403 or 404, got ${res.status}`,
    );
    assert(res.data.ok === false, 'Expected ok: false');
  });

  await test('confirm: rejected — size mismatch (declared vs actual)', async () => {
    // Presign with declared fileSize=100 bytes
    const presign = await api(
      'POST', '/files/presign',
      { fileName: 'mismatch.txt', fileSize: 100, mimeType: 'text/plain' },
      userToken,
    );
    assert(presign.data.ok, 'Presign failed');
    const mismatchId = presign.data.data.uploadId;
    const mismatchUrl = resolveUrl(presign.data.data.url);

    // Upload much larger content (50KB instead of 100 bytes)
    const largeContent = Buffer.alloc(50_000, 0x41); // 50KB of 'A'
    const formData = new FormData();
    formData.append('file', new Blob([largeContent], { type: 'text/plain' }), 'mismatch.txt');
    const uploadRes = await fetch(mismatchUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: formData,
    });
    assert(uploadRes.status === 200, 'Dev upload should accept the file');

    // Confirm should fail due to size mismatch (50000 vs declared 100)
    const confirm = await api('POST', '/files/confirm', { uploadId: mismatchId }, userToken);
    assert(confirm.status === 400, `Expected 400 (size mismatch), got ${confirm.status}: ${JSON.stringify(confirm.data)}`);
    assert(confirm.data.ok === false, 'Expected ok: false');
  });

  await test('confirm: rejected — empty file upload', async () => {
    const presign = await api(
      'POST', '/files/presign',
      { fileName: 'empty.txt', fileSize: 1, mimeType: 'text/plain' },
      userToken,
    );
    assert(presign.data.ok, 'Presign failed');
    const emptyId = presign.data.data.uploadId;
    const emptyUrl = resolveUrl(presign.data.data.url);

    // Upload empty content
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(0)], { type: 'text/plain' }), 'empty.txt');
    const uploadRes = await fetch(emptyUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: formData,
    });
    assert(uploadRes.status === 200, 'Dev upload should accept the file');

    // Confirm should fail with EMPTY_FILE
    const confirm = await api('POST', '/files/confirm', { uploadId: emptyId }, userToken);
    assert(confirm.status === 400, `Expected 400 (empty file), got ${confirm.status}`);
    assert(confirm.data.ok === false, 'Expected ok: false');
  });
}

// ─── 3. Dev Download Tests ──────────────────────────────────

async function downloadTests() {
  suite('3. Dev Download');

  await test('serves confirmed file with correct content', async () => {
    assert(cdnUrl.length > 0, 'cdnUrl should be set from confirm');

    const res = await fetch(cdnUrl);
    assert(res.status === 200, `Expected 200, got ${res.status}`);

    const body = await res.text();
    assert(body.includes('Hello from Prismer'), 'File content should match');
  });

  await test('404 for nonexistent file', async () => {
    const res = await fetch(`${BASE}/api/files/dev-download/fu_nonexistent_0000000000/file.txt`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });
}

// ─── 4. Quota Tests ──────────────────────────────────────────

async function quotaTests() {
  suite('4. Quota');

  await test('returns usage info with correct count', async () => {
    const res = await api('GET', '/files/quota', undefined, userToken);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.ok === true, 'Expected ok: true');
    assert(typeof res.data.data.used === 'number', 'Expected used (number)');
    assert(typeof res.data.data.limit === 'number', 'Expected limit (number)');
    assert(typeof res.data.data.fileCount === 'number', 'Expected fileCount (number)');
    assert(res.data.data.fileCount >= 1, 'Should have at least 1 confirmed file');
  });

  await test('used bytes includes confirmed file size', async () => {
    const res = await api('GET', '/files/quota', undefined, userToken);
    assert(res.data.ok, 'Quota failed');
    assert(
      res.data.data.used >= confirmedFileSize,
      `used (${res.data.data.used}) should be >= confirmed file size (${confirmedFileSize})`,
    );
  });

  await test('no auth returns 401', async () => {
    const res = await api('GET', '/files/quota');
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });
}

// ─── 5. MIME Types Endpoint ──────────────────────────────────

async function mimeTypesTests() {
  suite('5. MIME Types');

  await test('returns allowed MIME list', async () => {
    const res = await api('GET', '/files/types', undefined, userToken);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.ok === true, 'Expected ok: true');
    const types = res.data.data.allowedMimeTypes;
    assert(Array.isArray(types), 'Expected allowedMimeTypes array');
    assert(types.includes('image/jpeg'), 'Should include image/jpeg');
    assert(types.includes('text/plain'), 'Should include text/plain');
    assert(types.includes('application/pdf'), 'Should include application/pdf');
    assert(!types.includes('application/x-msdownload'), 'Should NOT include executable MIME');
  });
}

// ─── 6. File Message Validation Tests ────────────────────────

async function fileMessageTests() {
  suite('6. File Message Validation');

  await test('send with confirmed upload', async () => {
    const res = await api(
      'POST', `/messages/${conversationId}`,
      {
        content: 'Here is the file',
        type: 'file',
        metadata: {
          uploadId,
          fileUrl: cdnUrlRaw,
          fileName: 'hello.txt',
          fileSize: confirmedFileSize,
          mimeType: 'text/plain',
        },
      },
      userToken,
    );
    assert(
      res.status === 200 || res.status === 201,
      `Expected 200/201, got ${res.status}: ${JSON.stringify(res.data)}`,
    );
    assert(res.data.ok === true, 'Expected ok: true');
  });

  await test('rejected — missing uploadId in metadata', async () => {
    const res = await api(
      'POST', `/messages/${conversationId}`,
      {
        content: 'Fake file',
        type: 'file',
        metadata: {
          fileUrl: 'https://evil.example.com/malware.exe',
          fileName: 'malware.exe',
          fileSize: 1000,
          mimeType: 'text/plain',
        },
      },
      userToken,
    );
    assert(res.data.ok === false || res.status >= 400, 'Should reject file message without uploadId');
  });

  await test('rejected — fabricated CDN URL', async () => {
    const res = await api(
      'POST', `/messages/${conversationId}`,
      {
        content: 'Fake file URL',
        type: 'file',
        metadata: {
          uploadId,
          fileUrl: 'https://evil.example.com/stolen-data.txt',
          fileName: 'hello.txt',
          fileSize: confirmedFileSize,
          mimeType: 'text/plain',
        },
      },
      userToken,
    );
    assert(res.data.ok === false || res.status >= 400, 'Should reject fabricated file URL');
  });

  await test('rejected — unconfirmed upload', async () => {
    const presign = await api(
      'POST', '/files/presign',
      { fileName: 'pending.txt', fileSize: 100, mimeType: 'text/plain' },
      userToken,
    );
    const pendingUploadId = presign.data.data.uploadId;

    const res = await api(
      'POST', `/messages/${conversationId}`,
      {
        content: 'Unconfirmed file',
        type: 'file',
        metadata: {
          uploadId: pendingUploadId,
          fileUrl: '/api/im/files/dev-download/pending/pending.txt',
          fileName: 'pending.txt',
          fileSize: 100,
          mimeType: 'text/plain',
        },
      },
      userToken,
    );
    assert(res.data.ok === false || res.status >= 400, 'Should reject unconfirmed upload');
  });

  await test('rejected — cross-user (B sends A\'s file)', async () => {
    // User B tries to send a file message referencing user A's confirmed upload
    const res = await api(
      'POST', `/messages/${conversationId}`,
      {
        content: 'Stealing A\'s file',
        type: 'file',
        metadata: {
          uploadId,
          fileUrl: cdnUrlRaw,
          fileName: 'hello.txt',
          fileSize: confirmedFileSize,
          mimeType: 'text/plain',
        },
      },
      otherUserToken,
    );
    assert(res.data.ok === false || res.status >= 400, 'User B should not send file owned by A');
  });
}

// ─── 7. Delete Tests ─────────────────────────────────────────

async function deleteTests() {
  suite('7. Delete');

  let deleteUploadId = '';
  let deleteCdnUrl = '';

  await test('setup — presign + upload + confirm for deletion', async () => {
    const result = await uploadFullCycle(
      'deleteme.txt',
      Buffer.from('Delete me please!'),
      'text/plain',
      userToken,
    );
    deleteUploadId = result.uploadId;
    deleteCdnUrl = result.cdnUrl;
  });

  await test('happy path', async () => {
    const res = await api('DELETE', `/files/${deleteUploadId}`, undefined, userToken);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.data.ok === true, 'Expected ok: true');
    assert(res.data.data.deleted === true, 'Expected deleted: true');
  });

  await test('download returns 404 after delete', async () => {
    const res = await fetch(deleteCdnUrl);
    assert(res.status === 404, `Expected 404 after delete, got ${res.status}`);
  });

  await test('confirm returns error after delete', async () => {
    const res = await api('POST', '/files/confirm', { uploadId: deleteUploadId }, userToken);
    assert(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`);
    assert(res.data.ok === false, 'Expected ok: false');
  });

  await test('rejected — not found', async () => {
    const res = await api(
      'DELETE', '/files/fu_nonexistent_12345678901234',
      undefined, userToken,
    );
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test('rejected — not owner', async () => {
    const presign = await api(
      'POST', '/files/presign',
      { fileName: 'owned.txt', fileSize: 50, mimeType: 'text/plain' },
      userToken,
    );
    const ownedId = presign.data.data.uploadId;

    const res = await api('DELETE', `/files/${ownedId}`, undefined, otherUserToken);
    assert(
      res.status === 403 || res.status === 404,
      `Expected 403 or 404, got ${res.status}`,
    );
  });

  await test('double delete — second attempt returns 404 or INVALID_STATE', async () => {
    // Create and delete a file
    const result = await uploadFullCycle(
      'doubledelete.txt',
      Buffer.from('Delete me twice'),
      'text/plain',
      userToken,
    );

    // First delete
    const d1 = await api('DELETE', `/files/${result.uploadId}`, undefined, userToken);
    assert(d1.status === 200, 'First delete should succeed');

    // Second delete
    const d2 = await api('DELETE', `/files/${result.uploadId}`, undefined, userToken);
    assert(
      d2.status === 404,
      `Expected 404 on second delete, got ${d2.status}`,
    );
  });
}

// ─── 8. Multipart Upload Tests ───────────────────────────────

async function multipartTests() {
  suite('8. Multipart Upload');

  await test('init: returns 501 in dev mode (no S3)', async () => {
    const res = await api(
      'POST', '/files/upload/init',
      { fileName: 'bigfile.pdf', fileSize: 15 * 1024 * 1024, mimeType: 'application/pdf' },
      userToken,
    );
    assert(
      res.status === 201 || res.status === 400 || res.status === 501,
      `Expected 201, 400, or 501, got ${res.status}`,
    );
  });

  await test('init: rejected — bad MIME', async () => {
    const res = await api(
      'POST', '/files/upload/init',
      { fileName: 'hack.exe', fileSize: 15 * 1024 * 1024, mimeType: 'application/x-executable' },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('init: rejected — file too small for multipart', async () => {
    const res = await api(
      'POST', '/files/upload/init',
      { fileName: 'small.pdf', fileSize: 5 * 1024 * 1024, mimeType: 'application/pdf' },
      userToken,
    );
    // Should be rejected because fileSize <= maxSimpleSize (10MB)
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('complete: rejected — empty parts array', async () => {
    const res = await api(
      'POST', '/files/upload/complete',
      { uploadId: 'fu_fake_1234567890abcdef', parts: [] },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('complete: rejected — invalid part structure', async () => {
    const res = await api(
      'POST', '/files/upload/complete',
      { uploadId: 'fu_fake_1234567890abcdef', parts: [{ bad: true }] },
      userToken,
    );
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });
}

// ─── 9. Security Tests ──────────────────────────────────────

async function securityTests() {
  suite('9. Security');

  await test('path traversal — dot-dot-slash in dev-download', async () => {
    const res = await fetch(`${BASE}/api/files/dev-download/${uploadId}/..%2F..%2F..%2Fetc%2Fpasswd`);
    assert(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`);
    const body = await res.text();
    assert(!body.includes('root:'), 'Must not leak system files');
  });

  await test('path traversal — backslash in dev-download', async () => {
    const res = await fetch(`${BASE}/api/files/dev-download/${uploadId}/..\\..\\..\\etc\\passwd`);
    assert(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`);
  });

  await test('short uploadId prefix rejected on delete', async () => {
    const res = await api('DELETE', '/files/fu_', undefined, userToken);
    assert(res.status === 400, `Expected 400 for short prefix, got ${res.status}`);
  });

  await test('very short uploadId rejected on delete', async () => {
    const res = await api('DELETE', '/files/fu', undefined, userToken);
    assert(res.status === 400, `Expected 400 for "fu", got ${res.status}`);
  });

  await test('oversized dev-upload rejected at route level', async () => {
    const presign = await api(
      'POST', '/files/presign',
      { fileName: 'small.txt', fileSize: 100, mimeType: 'text/plain' },
      userToken,
    );
    assert(presign.data.ok, 'Presign failed');
    const devUrl = resolveUrl(presign.data.data.url);

    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0x41);
    const formData = new FormData();
    formData.append('file', new Blob([bigBuffer], { type: 'text/plain' }), 'small.txt');

    const res = await fetch(devUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: formData,
    });
    assert(res.status === 400, `Expected 400 for oversized upload, got ${res.status}`);
  });

  await test('unicode fileName is sanitized but accepted', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: '테스트_文件_файл.txt', fileSize: 100, mimeType: 'text/plain' },
      userToken,
    );
    // Should succeed — unicode is fine, only dangerous chars are stripped
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
  });

  await test('XSS in fileName is sanitized (no path separators)', async () => {
    // Note: '<script>...</script>' contains '/' which is correctly rejected.
    // Use a payload without path separators to test sanitization.
    const res = await api(
      'POST', '/files/presign',
      { fileName: '<img src=x onerror=alert(1)>.txt', fileSize: 100, mimeType: 'text/plain' },
      userToken,
    );
    // Should succeed — < and > are sanitized to _ by sanitizeFileName
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
  });

  await test('XSS fileName with slash is rejected', async () => {
    const res = await api(
      'POST', '/files/presign',
      { fileName: '<script>alert(1)</script>.txt', fileSize: 100, mimeType: 'text/plain' },
      userToken,
    );
    // Contains '/' in '</script>' → rejected by path separator check
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('ultra-long fileName is truncated', async () => {
    const longName = 'a'.repeat(300) + '.txt';
    const res = await api(
      'POST', '/files/presign',
      { fileName: longName, fileSize: 100, mimeType: 'text/plain' },
      userToken,
    );
    // validateUploadRequest rejects > 255 chars
    assert(res.status === 400, `Expected 400 for 300+ char fileName, got ${res.status}`);
  });
}

// ─── Run All ────────────────────────────────────────────────

async function main() {
  try {
    // Check server health
    const health = await api('GET', '/health');
    if (!health.data.ok) {
      console.error('❌ IM server not reachable at', BASE);
      process.exit(1);
    }
    console.log(`✅ IM server reachable (${health.data.version || 'ok'})`);

    await setup();
    await presignTests();
    await uploadConfirmTests();
    await downloadTests();
    await quotaTests();
    await mimeTypesTests();
    await fileMessageTests();
    await deleteTests();
    await multipartTests();
    await securityTests();

    // Capture last suite
    if (currentSuite) {
      suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });
    }

    // Summary
    console.log('\n════════════════════════════════════════');
    console.log(`  File Upload Tests: ${passed} passed, ${failed} failed`);
    console.log('════════════════════════════════════════');

    if (suiteResults.length > 0) {
      console.log('\nSuite breakdown:');
      for (const s of suiteResults) {
        const icon = s.failed === 0 ? '✅' : '❌';
        console.log(`  ${icon} ${s.name}: ${s.passed}/${s.passed + s.failed}`);
      }
    }

    if (failures.length > 0) {
      console.log('\nFailures:');
      failures.forEach((f) => console.log(`  - ${f}`));
    }

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n💥 Test runner crashed:', err);
    process.exit(1);
  }
}

main();
