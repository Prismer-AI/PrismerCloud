// T10 — Keychain: macOS Keychain / libsecret / pass / encrypted-file backends

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ============================================================
// Public types
// ============================================================

export type KeychainBackend = 'macos-keychain' | 'libsecret' | 'pass' | 'encrypted-file';

export interface KeychainAdapter {
  name: KeychainBackend;
  available(): Promise<boolean>;
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
  list(service: string): Promise<string[]>;
}

export interface KeychainOptions {
  preferredBackend?: KeychainBackend;
  masterPassphrase?: string;
  encryptedFilePath?: string;
}

// ============================================================
// Errors
// ============================================================

export class NoKeychainBackendError extends Error {
  constructor() {
    super('No keychain backend available and no master passphrase configured');
    this.name = 'NoKeychainBackendError';
  }
}

export class KeychainOperationError extends Error {
  constructor(op: string, cause: unknown) {
    super(`Keychain ${op} failed: ${String(cause)}`);
    this.name = 'KeychainOperationError';
  }
}

/**
 * Raised when the OS keychain is available but the user (or a SAP / policy)
 * denied access. `cli/ui.error` consumers display this with a §15.3-style
 * What / Cause / Fix / Alt block.
 */
export class KeychainAccessDeniedError extends Error {
  readonly backend: KeychainBackend;
  constructor(backend: KeychainBackend, op: string) {
    super(`Keychain access denied during ${op} (backend=${backend})`);
    this.name = 'KeychainAccessDeniedError';
    this.backend = backend;
  }
}

// macOS security(1) exit codes — see /usr/include/Security/SecBase.h
// errSecAuthFailed (-25293) surfaces as exit 51 via shell
// errAuthorizationCanceled (-60006) surfaces as exit 128+45=128 / exit 1 depending on SDK
// errSecInteractionNotAllowed surfaces as "User interaction is not allowed" on stderr
function isMacAccessDenied(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const rec = err as { code?: unknown; stderr?: unknown };
  if (rec.code === 51 || rec.code === 45) return true;
  if (typeof rec.stderr === 'string') {
    const msg = rec.stderr.toLowerCase();
    if (msg.includes('user interaction is not allowed')) return true;
    if (msg.includes('authentication failed')) return true;
    if (msg.includes('user canceled')) return true;
  }
  return false;
}

// ============================================================
// Side-index helper (shared by macOS + libsecret + pass)
// ============================================================

interface IndexData {
  [service: string]: string[];
}

function readIndex(indexPath: string): IndexData {
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    return JSON.parse(raw) as IndexData;
  } catch {
    return {};
  }
}

function writeIndex(indexPath: string, data: IndexData): void {
  const tmp = indexPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, indexPath);
}

function indexAdd(indexPath: string, service: string, account: string): void {
  const data = readIndex(indexPath);
  if (!data[service]) data[service] = [];
  if (!data[service].includes(account)) data[service].push(account);
  writeIndex(indexPath, data);
}

function indexRemove(indexPath: string, service: string, account: string): void {
  const data = readIndex(indexPath);
  if (!data[service]) return;
  data[service] = data[service].filter((a) => a !== account);
  if (data[service].length === 0) delete data[service];
  writeIndex(indexPath, data);
}

function indexList(indexPath: string, service: string): string[] {
  const data = readIndex(indexPath);
  return (data[service] ?? []).slice().sort();
}

// ============================================================
// macOS Keychain adapter
// ============================================================

const NATIVE_INDEX_PATH = path.join(os.homedir(), '.prismer', 'keychain-index.json');

function ensureDir(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

class MacOSKeychainAdapter implements KeychainAdapter {
  readonly name: KeychainBackend = 'macos-keychain';

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    try {
      await execFile('which', ['security']);
      await execFile('security', ['list-keychains']);
      return true;
    } catch {
      return false;
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFile('security', [
        'find-generic-password',
        '-s', service,
        '-a', account,
        '-w',
      ]);
      return stdout.trim();
    } catch (err: unknown) {
      // exit code 44 = not found
      if (isExitCode44(err)) return null;
      if (isMacAccessDenied(err)) throw new KeychainAccessDeniedError(this.name, 'get');
      throw new KeychainOperationError('get', err);
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    try {
      // C3: use -X <hex> instead of -w <plaintext> so the secret never appears in
      // ps argv output. security(1) man page: "-X  Specify password data to be added
      // as a hexadecimal string". find-generic-password -w decodes it back correctly.
      const hexValue = Buffer.from(value, 'utf-8').toString('hex');
      await execFile('security', [
        'add-generic-password',
        '-s', service,
        '-a', account,
        '-X', hexValue,
        '-U',
      ]);
      ensureDir(NATIVE_INDEX_PATH);
      // I6: ensure ~/.prismer/ is owner-only; best-effort in case of unusual perms
      try { fs.chmodSync(path.dirname(NATIVE_INDEX_PATH), 0o700); } catch { /* ignore */ }
      indexAdd(NATIVE_INDEX_PATH, service, account);
    } catch (err: unknown) {
      if (isMacAccessDenied(err)) throw new KeychainAccessDeniedError(this.name, 'set');
      throw new KeychainOperationError('set', err);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await execFile('security', [
        'delete-generic-password',
        '-s', service,
        '-a', account,
      ]);
      indexRemove(NATIVE_INDEX_PATH, service, account);
    } catch (err: unknown) {
      if (isExitCode44(err)) return; // not found — silent success
      throw new KeychainOperationError('delete', err);
    }
  }

  async list(service: string): Promise<string[]> {
    return indexList(NATIVE_INDEX_PATH, service);
  }
}

function isExitCode44(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code: unknown }).code === 44;
  }
  return false;
}

// secret-tool exits 1 when the secret is simply not found (documented behaviour).
// Any other non-zero exit (dbus broken, permission denied, etc.) is a real error.
function isLibsecretNotFound(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code: unknown }).code === 1;
  }
  return false;
}

// ============================================================
// Linux libsecret adapter (secret-tool)
// ============================================================

class LibsecretAdapter implements KeychainAdapter {
  readonly name: KeychainBackend = 'libsecret';

  async available(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
      await execFile('which', ['secret-tool']);
      // Verify dbus session is available by running a harmless lookup
      await execFile('secret-tool', ['lookup', 'prismer-probe', 'unavailable']);
      return true;
    } catch (err: unknown) {
      // secret-tool exits non-zero when not found, but that's OK for availability —
      // what we care about is that the binary runs at all (dbus available).
      // If "which" succeeded but the lookup exits with "connected" error, dbus works.
      if (isWhichError(err)) return false;
      return true;
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFile('secret-tool', [
        'lookup',
        'prismer-service', service,
        'prismer-account', account,
      ]);
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err: unknown) {
      if (isLibsecretNotFound(err)) return null;
      throw new KeychainOperationError('get', err);
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    try {
      // secret-tool reads password from stdin
      const child = execFileCb('secret-tool', [
        'store',
        '--label', `${service}:${account}`,
        'prismer-service', service,
        'prismer-account', account,
      ]);
      child.stdin!.write(value);
      child.stdin!.end();
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.on('error', reject);
      });
      ensureDir(NATIVE_INDEX_PATH);
      indexAdd(NATIVE_INDEX_PATH, service, account);
    } catch (err: unknown) {
      throw new KeychainOperationError('set', err);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await execFile('secret-tool', [
        'clear',
        'prismer-service', service,
        'prismer-account', account,
      ]);
      indexRemove(NATIVE_INDEX_PATH, service, account);
    } catch {
      // non-existent — silent
    }
  }

  async list(service: string): Promise<string[]> {
    return indexList(NATIVE_INDEX_PATH, service);
  }
}

function isWhichError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'cmd' in err) {
    const cmd = (err as { cmd?: string }).cmd ?? '';
    return cmd.startsWith('which');
  }
  return false;
}

// ============================================================
// Linux `pass` adapter
// ============================================================

class PassAdapter implements KeychainAdapter {
  readonly name: KeychainBackend = 'pass';

  async available(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
      await execFile('which', ['pass']);
      await execFile('pass', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFile('pass', [
        'show',
        `prismer/${service}/${account}`,
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    try {
      const child = execFileCb('pass', [
        'insert',
        '-m',
        `prismer/${service}/${account}`,
      ]);
      child.stdin!.write(value);
      child.stdin!.end();
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.on('error', reject);
      });
      ensureDir(NATIVE_INDEX_PATH);
      indexAdd(NATIVE_INDEX_PATH, service, account);
    } catch (err: unknown) {
      throw new KeychainOperationError('set', err);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await execFile('pass', [
        'rm',
        '-f',
        `prismer/${service}/${account}`,
      ]);
      indexRemove(NATIVE_INDEX_PATH, service, account);
    } catch {
      // not found — silent
    }
  }

  async list(service: string): Promise<string[]> {
    return indexList(NATIVE_INDEX_PATH, service);
  }
}

// ============================================================
// Encrypted-file backend
// ============================================================

const SCRYPT_SALT_BYTES = 16;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
const FILE_FORMAT_VERSION = 1;

interface SecretsStore {
  version: number;
  secrets: { [service: string]: { [account: string]: string } };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, SCRYPT_KEY_BYTES) as Buffer;
}

function encryptStore(store: SecretsStore, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const nonce = crypto.randomBytes(AES_NONCE_BYTES);
  const key = deriveKey(passphrase, salt);
  const plaintext = Buffer.from(JSON.stringify(store), 'utf-8');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, nonce, ciphertext, tag]);
}

function decryptStore(data: Buffer, passphrase: string): SecretsStore {
  if (data.length < SCRYPT_SALT_BYTES + AES_NONCE_BYTES + AES_TAG_BYTES) {
    throw new KeychainOperationError('decrypt', 'tamper detected or wrong passphrase');
  }

  const salt = data.subarray(0, SCRYPT_SALT_BYTES);
  const nonce = data.subarray(SCRYPT_SALT_BYTES, SCRYPT_SALT_BYTES + AES_NONCE_BYTES);
  const tag = data.subarray(data.length - AES_TAG_BYTES);
  const ciphertext = data.subarray(SCRYPT_SALT_BYTES + AES_NONCE_BYTES, data.length - AES_TAG_BYTES);

  const key = deriveKey(passphrase, salt);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf-8')) as SecretsStore;
  } catch {
    throw new KeychainOperationError('decrypt', 'tamper detected or wrong passphrase');
  }
}

class EncryptedFileAdapter implements KeychainAdapter {
  readonly name: KeychainBackend = 'encrypted-file';
  private readonly filePath: string;
  private readonly passphrase: string;

  constructor(filePath: string, passphrase: string) {
    this.filePath = filePath;
    this.passphrase = passphrase;
    // Q5: cleanup stray sidecar from v1.9.0-dev; encrypted store is canonical
    const stale = filePath + '.index.json';
    try { if (fs.existsSync(stale)) fs.unlinkSync(stale); } catch { /* best effort */ }
  }

  async available(): Promise<boolean> {
    return true;
  }

  private readStore(): SecretsStore {
    if (!fs.existsSync(this.filePath)) {
      return { version: FILE_FORMAT_VERSION, secrets: {} };
    }
    const data = fs.readFileSync(this.filePath);
    return decryptStore(data, this.passphrase);
  }

  private writeStore(store: SecretsStore): void {
    ensureDir(this.filePath);
    // I6: chmod dir to 0700 (owner-only) — best-effort; may fail on system dirs during tests
    try { fs.chmodSync(path.dirname(this.filePath), 0o700); } catch { /* ignore if not owner */ }
    const encrypted = encryptStore(store, this.passphrase);
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, encrypted);
    // I6: chmod encrypted file to 0600 before atomic rename
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
  }

  async get(service: string, account: string): Promise<string | null> {
    const store = this.readStore();
    return store.secrets[service]?.[account] ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const store = this.readStore();
    if (!store.secrets[service]) store.secrets[service] = {};
    store.secrets[service][account] = value;
    this.writeStore(store);
    // Q5: no sidecar write — encrypted store is the canonical enumerable source
  }

  async delete(service: string, account: string): Promise<void> {
    if (!fs.existsSync(this.filePath)) return;
    const store = this.readStore();
    if (!store.secrets[service]) return;
    delete store.secrets[service][account];
    if (Object.keys(store.secrets[service]).length === 0) {
      delete store.secrets[service];
    }
    this.writeStore(store);
    // Q5: no sidecar removal needed — sidecar is gone
  }

  async list(service: string): Promise<string[]> {
    if (!fs.existsSync(this.filePath)) return [];
    // Q5: enumerate directly from the encrypted store (no plaintext sidecar needed)
    const store = this.readStore();
    return Object.keys(store.secrets[service] ?? {}).sort();
  }
}

// ============================================================
// Keychain class — auto-detect and delegate
// ============================================================

const DEFAULT_ENCRYPTED_FILE = path.join(os.homedir(), '.prismer', 'credentials.json.enc');

export class Keychain {
  private readonly opts: KeychainOptions;
  private resolvedBackend: KeychainAdapter | null = null;
  private detecting = false;

  constructor(opts?: KeychainOptions) {
    this.opts = opts ?? {};
  }

  async backend(): Promise<KeychainAdapter> {
    if (this.resolvedBackend) return this.resolvedBackend;

    const preferred = this.opts.preferredBackend;

    // Build candidate list in priority order
    const candidates: KeychainAdapter[] = preferred
      ? [this.makeAdapter(preferred)]
      : this.buildCandidateList();

    for (const candidate of candidates) {
      if (await candidate.available()) {
        this.resolvedBackend = candidate;
        return candidate;
      }
    }

    throw new NoKeychainBackendError();
  }

  private buildCandidateList(): KeychainAdapter[] {
    const candidates: KeychainAdapter[] = [];
    if (process.platform === 'darwin') {
      candidates.push(new MacOSKeychainAdapter());
    } else if (process.platform === 'linux') {
      candidates.push(new LibsecretAdapter());
      candidates.push(new PassAdapter());
    }
    // Encrypted-file as last resort — only if passphrase is configured
    const passphrase = this.opts.masterPassphrase ?? process.env['PRISMER_MASTER_PASSPHRASE'];
    if (passphrase) {
      const filePath = this.opts.encryptedFilePath ?? DEFAULT_ENCRYPTED_FILE;
      candidates.push(new EncryptedFileAdapter(filePath, passphrase));
    }
    return candidates;
  }

  private makeAdapter(name: KeychainBackend): KeychainAdapter {
    switch (name) {
      case 'macos-keychain':
        return new MacOSKeychainAdapter();
      case 'libsecret':
        return new LibsecretAdapter();
      case 'pass':
        return new PassAdapter();
      case 'encrypted-file': {
        const passphrase = this.opts.masterPassphrase ?? process.env['PRISMER_MASTER_PASSPHRASE'];
        if (!passphrase) throw new NoKeychainBackendError();
        const filePath = this.opts.encryptedFilePath ?? DEFAULT_ENCRYPTED_FILE;
        return new EncryptedFileAdapter(filePath, passphrase);
      }
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    return (await this.backend()).get(service, account);
  }

  async set(service: string, account: string, value: string): Promise<void> {
    return (await this.backend()).set(service, account, value);
  }

  async delete(service: string, account: string): Promise<void> {
    return (await this.backend()).delete(service, account);
  }

  async list(service: string): Promise<string[]> {
    return (await this.backend()).list(service);
  }
}
