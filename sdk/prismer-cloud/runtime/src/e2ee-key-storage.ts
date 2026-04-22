/**
 * Prismer Runtime — E2EE Key Storage (v1.9.0)
 *
 * Secure storage for E2EE keys on daemon side.
 * Uses keychain backend with encrypted JSON fallback for offline/keyless systems.
 *
 * Storage model:
 *   - Primary: Keychain (macOS Keychain / libsecret / pass)
 *   - Fallback: Encrypted JSON file (~/.prismer/e2ee-keys.json)
 *   - Per-session keys with TTL (30 min default)
 *   - Automatic cleanup of expired keys
 *
 * Security:
 *   - Keys encrypted at rest (keychain or encrypted file)
 *   - Master passphrase required for file fallback
 *   - Automatic key rotation on session expiry
 *   - Forward secrecy: ephemeral keys discarded after session
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keychain } from './keychain';
import type { KeyPair } from './e2ee-crypto';

// ============================================================
// Types
// ============================================================

export interface E2EEKeyEntry {
  /** Session ID (userId:daemonId or userId:deviceId) */
  sessionId: string;
  /** User ID who owns this key */
  userId: string;
  /** Daemon ID or Device ID */
  endpointId: string;
  /** Local keypair (ephemeral) */
  keyPair: {
    publicKey: string;
    privateKey: string;
  };
  /** Remote public key */
  remotePublicKey: string;
  /** When this key was created */
  createdAt: number;
  /** When this key expires (unix timestamp) */
  expiresAt: number;
  /** Current sequence number */
  seq: number;
}

export interface E2EEStorageStats {
  totalKeys: number;
  activeKeys: number;
  expiredKeys: number;
  oldestKeyAge: number; // seconds
  newestKeyAge: number; // seconds
}

// ============================================================
// Constants
// ============================================================

const STORAGE_PATH = path.join(os.homedir(), '.prismer', 'e2ee-keys.json');
const STORAGE_SERVICE = 'prismer-e2ee';
const DEFAULT_TTL_SECONDS = 30 * 60; // 30 minutes
const KEY_ITERATIONS = 100000; // PBKDF2 iterations for encryption

// ============================================================
// E2EE Key Storage Class
// ============================================================

export class E2EEKeyStorage {
  private keychain: Keychain;
  private useEncryptedFile: boolean = false;
  private masterPassphrase?: string;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(options?: { masterPassphrase?: string }) {
    this.keychain = new Keychain({ masterPassphrase: options?.masterPassphrase });
    this.masterPassphrase = options?.masterPassphrase;
  }

  /**
   * Initialize storage (try keychain, fallback to encrypted file)
   */
  async initialize(): Promise<void> {
    try {
      // Try keychain first
      const backend = await this.keychain.backend();
      const available = await backend.available();
      if (available) {
        this.useEncryptedFile = false;
        return;
      }
    } catch (err) {
      // Keychain not available, fall back to encrypted file
    }

    // Fallback to encrypted file
    if (!this.masterPassphrase) {
      throw new Error(
        'E2EE key storage: Keychain not available and no master passphrase provided. ' +
        'Set PRISMER_MASTER_PASSPHRASE environment variable.'
      );
    }

    this.useEncryptedFile = true;
    await this.ensureStorageFile();

    // Start periodic cleanup (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      void this.cleanupExpiredKeys().catch((err) => {
        console.error('[E2EEKeyStorage] Cleanup failed:', err);
      });
    }, 5 * 60 * 1000);
  }

  /**
   * Store E2EE key for a session
   */
  async storeKey(entry: E2EEKeyEntry): Promise<void> {
    const now = Date.now();
    const expiresAt = now + DEFAULT_TTL_SECONDS * 1000;

    const keyEntry: E2EEKeyEntry = {
      ...entry,
      createdAt: now,
      expiresAt,
    };

    if (this.useEncryptedFile) {
      await this.storeInEncryptedFile(keyEntry);
    } else {
      await this.storeInKeychain(keyEntry);
    }
  }

  /**
   * Retrieve E2EE key for a session
   */
  async getKey(sessionId: string): Promise<E2EEKeyEntry | null> {
    let entry: E2EEKeyEntry | null;

    if (this.useEncryptedFile) {
      entry = await this.getFromEncryptedFile(sessionId);
    } else {
      entry = await this.getFromKeychain(sessionId);
    }

    if (!entry) return null;

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      await this.removeKey(sessionId);
      return null;
    }

    return entry;
  }

  /**
   * Remove E2EE key for a session
   */
  async removeKey(sessionId: string): Promise<void> {
    if (this.useEncryptedFile) {
      await this.removeFromEncryptedFile(sessionId);
    } else {
      await this.removeFromKeychain(sessionId);
    }
  }

  /**
   * Get all keys for a user (for recovery)
   */
  async getAllKeysForUser(userId: string): Promise<E2EEKeyEntry[]> {
    if (this.useEncryptedFile) {
      return await this.getAllFromEncryptedFile(userId);
    } else {
      return await this.getAllFromKeychain(userId);
    }
  }

  /**
   * Get storage statistics
   */
  async getStats(userId?: string): Promise<E2EEStorageStats> {
    const now = Date.now();
    let keys: E2EEKeyEntry[];

    if (userId) {
      keys = await this.getAllKeysForUser(userId);
    } else {
      // Get all keys (for admin stats)
      if (this.useEncryptedFile) {
        const data = await this.readEncryptedFile();
        keys = Object.values(data);
      } else {
        // Keychain: we can only list by user
        keys = [];
      }
    }

    const activeKeys = keys.filter((k) => k.expiresAt > now);
    const expiredKeys = keys.filter((k) => k.expiresAt <= now);

    const ages = activeKeys.map((k) => (now - k.createdAt) / 1000);
    const oldestKeyAge = Math.min(...ages, 0);
    const newestKeyAge = Math.max(...ages, 0);

    return {
      totalKeys: keys.length,
      activeKeys: activeKeys.length,
      expiredKeys: expiredKeys.length,
      oldestKeyAge,
      newestKeyAge,
    };
  }

  /**
   * Cleanup expired keys
   */
  async cleanupExpiredKeys(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    if (this.useEncryptedFile) {
      const data = await this.readEncryptedFile();
      for (const [sessionId, entry] of Object.entries(data)) {
        if (entry.expiresAt <= now) {
          delete data[sessionId];
          cleaned++;
        }
      }
      if (cleaned > 0) {
        await this.writeEncryptedFile(data);
      }
    } else {
      // Keychain: we need to list all keys and check expiry
      const accounts = await this.keychain.list(STORAGE_SERVICE);
      for (const account of accounts) {
        const entryJson = await this.keychain.get(STORAGE_SERVICE, account);
        if (entryJson) {
          const entry = JSON.parse(entryJson) as E2EEKeyEntry;
          if (entry.expiresAt <= now) {
            await this.keychain.delete(STORAGE_SERVICE, account);
            cleaned++;
          }
        }
      }
    }

    if (cleaned > 0) {
      console.log(`[E2EEKeyStorage] Cleaned up ${cleaned} expired keys`);
    }
  }

  /**
   * Shutdown storage (cleanup interval)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  // ============================================================
  // Encrypted File Storage Methods
  // ============================================================

  private async ensureStorageFile(): Promise<void> {
    const dir = path.dirname(STORAGE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (!fs.existsSync(STORAGE_PATH)) {
      const empty = {};
      await this.writeEncryptedFile(empty);
      // Set restrictive permissions
      fs.chmodSync(STORAGE_PATH, 0o600);
    }
  }

  private async readEncryptedFile(): Promise<Record<string, E2EEKeyEntry>> {
    try {
      const encrypted = fs.readFileSync(STORAGE_PATH, 'utf-8');
      if (!encrypted.trim()) return {};

      const decrypted = this.decryptFile(encrypted);
      return JSON.parse(decrypted) as Record<string, E2EEKeyEntry>;
    } catch (err) {
      console.error('[E2EEKeyStorage] Failed to read encrypted file:', err);
      return {};
    }
  }

  private async writeEncryptedFile(data: Record<string, E2EEKeyEntry>): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    const encrypted = this.encryptFile(json);

    const tmpPath = STORAGE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, encrypted, 'utf-8');
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, STORAGE_PATH);
  }

  private encryptFile(plaintext: string): string {
    if (!this.masterPassphrase) {
      throw new Error('Master passphrase required for file encryption');
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(
      this.masterPassphrase,
      salt,
      KEY_ITERATIONS,
      32,
      'sha256'
    );

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const authTag = cipher.getAuthTag();

    const result = Buffer.concat([salt, iv, encrypted, authTag]);
    return result.toString('base64');
  }

  private decryptFile(encrypted: string): string {
    if (!this.masterPassphrase) {
      throw new Error('Master passphrase required for file decryption');
    }

    const data = Buffer.from(encrypted, 'base64');
    const salt = data.slice(0, 16);
    const iv = data.slice(16, 32);
    const ciphertext = data.slice(32, data.length - 16);
    const authTag = data.slice(data.length - 16);

    const key = crypto.pbkdf2Sync(
      this.masterPassphrase,
      salt,
      KEY_ITERATIONS,
      32,
      'sha256'
    );

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf-8');
  }

  private async storeInEncryptedFile(entry: E2EEKeyEntry): Promise<void> {
    const data = await this.readEncryptedFile();
    data[entry.sessionId] = entry;
    await this.writeEncryptedFile(data);
  }

  private async getFromEncryptedFile(sessionId: string): Promise<E2EEKeyEntry | null> {
    const data = await this.readEncryptedFile();
    return data[sessionId] || null;
  }

  private async removeFromEncryptedFile(sessionId: string): Promise<void> {
    const data = await this.readEncryptedFile();
    delete data[sessionId];
    await this.writeEncryptedFile(data);
  }

  private async getAllFromEncryptedFile(userId: string): Promise<E2EEKeyEntry[]> {
    const data = await this.readEncryptedFile();
    return Object.values(data).filter((k) => k.userId === userId);
  }

  // ============================================================
  // Keychain Storage Methods
// ============================================================

  private async storeInKeychain(entry: E2EEKeyEntry): Promise<void> {
    const value = JSON.stringify(entry);
    await this.keychain.set(STORAGE_SERVICE, entry.sessionId, value);
  }

  private async getFromKeychain(sessionId: string): Promise<E2EEKeyEntry | null> {
    const value = await this.keychain.get(STORAGE_SERVICE, sessionId);
    if (!value) return null;

    try {
      return JSON.parse(value) as E2EEKeyEntry;
    } catch (err) {
      console.error('[E2EEKeyStorage] Failed to parse keychain entry:', err);
      return null;
    }
  }

  private async removeFromKeychain(sessionId: string): Promise<void> {
    await this.keychain.delete(STORAGE_SERVICE, sessionId);
  }

  private async getAllFromKeychain(userId: string): Promise<E2EEKeyEntry[]> {
    const accounts = await this.keychain.list(STORAGE_SERVICE);
    const keys: E2EEKeyEntry[] = [];

    for (const account of accounts) {
      const entry = await this.getFromKeychain(account);
      if (entry && entry.userId === userId) {
        keys.push(entry);
      }
    }

    return keys;
  }
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Generate session ID for E2EE storage
 * Format: {userId}:{endpointId}
 */
export function generateSessionId(userId: string, endpointId: string): string {
  return `${userId}:${endpointId}`;
}

/**
 * Parse session ID into components
 */
export function parseSessionId(sessionId: string): { userId: string; endpointId: string } {
  const colonIdx = sessionId.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
  return {
    userId: sessionId.slice(0, colonIdx),
    endpointId: sessionId.slice(colonIdx + 1),
  };
}

/**
 * Create E2EE key entry from runtime context
 */
export function createKeyEntry(
  userId: string,
  endpointId: string,
  keyPair: KeyPair,
  remotePublicKey: string,
  seq: number = 0
): E2EEKeyEntry {
  return {
    sessionId: generateSessionId(userId, endpointId),
    userId,
    endpointId,
    keyPair: {
      publicKey: keyPair.publicKey.toString('base64'),
      privateKey: keyPair.privateKey.toString('base64'),
    },
    remotePublicKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + DEFAULT_TTL_SECONDS * 1000,
    seq,
  };
}
