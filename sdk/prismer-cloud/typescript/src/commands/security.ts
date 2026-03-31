import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  // ---------------------------------------------------------------------------
  // security command group
  // ---------------------------------------------------------------------------
  const security = parent
    .command('security')
    .description('Per-conversation encryption and key management');

  // security get <conversation-id>
  security
    .command('get <conversation-id>')
    .description('Get security settings for a conversation')
    .option('--json', 'Output raw JSON response')
    .action(async (convId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.security.getConversationSecurity(convId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        const d = res.data as Record<string, unknown> | undefined;
        process.stdout.write(`Encryption Mode: ${d?.encryptionMode ?? '-'}\n`);
        process.stdout.write(`Signing Policy:  ${d?.signingPolicy ?? '-'}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // security set <conversation-id>
  security
    .command('set <conversation-id>')
    .description('Set encryption mode for a conversation')
    .requiredOption('--mode <mode>', 'Encryption mode: none, available, or required')
    .option('--json', 'Output raw JSON response')
    .action(async (convId: string, opts: { mode: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.security.setConversationSecurity(convId, {
          encryptionMode: opts.mode as 'none' | 'available' | 'required',
        });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Encryption mode set to: ${opts.mode}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // security upload-key <conversation-id>
  security
    .command('upload-key <conversation-id>')
    .description('Upload an ECDH public key for a conversation')
    .requiredOption('--key <base64>', 'Base64-encoded public key')
    .option('--algorithm <alg>', 'Key algorithm', 'ecdh-p256')
    .option('--json', 'Output raw JSON response')
    .action(async (convId: string, opts: { key: string; algorithm: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.security.uploadKey(convId, opts.key, opts.algorithm);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Key uploaded (algorithm: ${opts.algorithm})\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // security keys <conversation-id>
  security
    .command('keys <conversation-id>')
    .description('List all member public keys for a conversation')
    .option('--json', 'Output raw JSON response')
    .action(async (convId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.security.getKeys(convId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const keys = res.data as unknown[] | undefined;
        if (opts.json) {
          process.stdout.write(JSON.stringify(keys, null, 2) + '\n');
          return;
        }
        if (!keys || (Array.isArray(keys) && keys.length === 0)) {
          process.stdout.write('No keys found.\n');
          return;
        }
        process.stdout.write('User ID'.padEnd(36) + 'Algorithm'.padEnd(16) + 'Public Key\n');
        for (const k of keys as Array<Record<string, unknown>>) {
          process.stdout.write(
            `${String(k.userId ?? '').padEnd(36)}${String(k.algorithm ?? '').padEnd(16)}${String(k.publicKey ?? '')}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // security revoke-key <conversation-id> <user-id>
  security
    .command('revoke-key <conversation-id> <user-id>')
    .description('Revoke a member key from a conversation')
    .option('--json', 'Output raw JSON response')
    .action(async (convId: string, userId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.security.revokeKey(convId, userId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Key revoked for user: ${userId}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // identity command group
  // ---------------------------------------------------------------------------
  const identity = parent
    .command('identity')
    .description('Identity key management and audit log verification');

  // identity server-key
  identity
    .command('server-key')
    .description("Get the server's identity public key")
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.identity.getServerKey();
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        const d = res.data as { publicKey?: string } | undefined;
        process.stdout.write(`Server Public Key: ${d?.publicKey ?? '-'}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // identity register-key
  identity
    .command('register-key')
    .description('Register an identity public key')
    .requiredOption('--algorithm <alg>', 'Key algorithm (e.g. ed25519, ecdh-p256)')
    .requiredOption('--public-key <base64>', 'Base64-encoded public key')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { algorithm: string; publicKey: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.identity.registerKey({
          algorithm: opts.algorithm,
          publicKey: opts.publicKey,
        });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Identity key registered (algorithm: ${opts.algorithm})\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // identity get-key <user-id>
  identity
    .command('get-key <user-id>')
    .description("Get a user's identity public key")
    .option('--json', 'Output raw JSON response')
    .action(async (userId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.identity.getKey(userId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        const d = res.data as Record<string, unknown> | undefined;
        process.stdout.write(`Algorithm:  ${d?.algorithm ?? '-'}\n`);
        process.stdout.write(`Public Key: ${d?.publicKey ?? '-'}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // identity revoke-key
  identity
    .command('revoke-key')
    .description('Revoke your own identity key')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.identity.revokeKey();
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write('Identity key revoked.\n');
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // identity audit-log <user-id>
  identity
    .command('audit-log <user-id>')
    .description('Get key audit log entries for a user')
    .option('--json', 'Output raw JSON response')
    .action(async (userId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.identity.getAuditLog(userId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const entries = res.data as unknown[] | undefined;
        if (opts.json) {
          process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
          return;
        }
        if (!entries || (Array.isArray(entries) && entries.length === 0)) {
          process.stdout.write('No audit log entries.\n');
          return;
        }
        process.stdout.write('Date'.padEnd(24) + 'Action'.padEnd(20) + 'Details\n');
        for (const e of entries as Array<Record<string, unknown>>) {
          const date = e.createdAt ? new Date(String(e.createdAt)).toLocaleString() : '';
          process.stdout.write(
            `${date.padEnd(24)}${String(e.action ?? '').padEnd(20)}${e.details ? JSON.stringify(e.details) : ''}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // identity verify-audit <user-id>
  identity
    .command('verify-audit <user-id>')
    .description('Verify the integrity of the key audit log for a user')
    .option('--json', 'Output raw JSON response')
    .action(async (userId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.identity.verifyAuditLog(userId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        const d = res.data as { valid?: boolean; errors?: unknown[] } | undefined;
        if (d?.valid) {
          process.stdout.write('Audit log verified: VALID\n');
        } else {
          process.stdout.write('Audit log verified: INVALID\n');
          if (d?.errors && Array.isArray(d.errors) && d.errors.length > 0) {
            process.stdout.write('Errors:\n');
            for (const err of d.errors) {
              process.stdout.write(`  - ${JSON.stringify(err)}\n`);
            }
          }
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
