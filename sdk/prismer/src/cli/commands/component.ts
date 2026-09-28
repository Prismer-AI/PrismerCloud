import { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { stageComponent, verifyComponent, type ComponentStageRequest } from '../../components/tenant-package.js';

/** Private in-pod protocol: bounded stdin JSON, one receipt on stdout, never package code. */
export function buildComponentCommand(
  io: { input: Readable; output: Writable; root: string } = {
    input: process.stdin,
    output: process.stdout,
    root: join(homedir(), '.prismer', 'tenant-components'),
  },
): Command {
  const command = new Command('component').description('Environment-local component staging');
  for (const method of ['stage', 'verify'] as const) {
    command.command(method).action(async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timeout = setTimeout(() => io.input.destroy(new Error('component input timeout')), 30_000);
      try {
        for await (const chunk of io.input) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 12 * 1024 * 1024) throw new Error('component input limit exceeded');
          chunks.push(buffer);
        }
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ComponentStageRequest;
        const receipt = await (method === 'stage' ? stageComponent : verifyComponent)(request, io.root);
        io.output.write(`${JSON.stringify(receipt)}\n`);
      } catch {
        throw new Error('component staging protocol failed');
      } finally {
        clearTimeout(timeout);
      }
    });
  }
  return command;
}
