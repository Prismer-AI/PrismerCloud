import type { Command } from 'commander';

export const CLOUD_COMMAND_DEPRECATION =
  'Deprecated in prismer CLI; use cloud <command>. Supported until 3.0.0.';

export function cloudCommandDeprecation(command: string): string {
  return CLOUD_COMMAND_DEPRECATION.replace('<command>', command);
}

export function emitCloudCommandDeprecation(
  command: string,
  stderr: { write(chunk: string): unknown } = process.stderr,
): void {
  stderr.write(`${cloudCommandDeprecation(command)}\n`);
}

/** Attach the compatibility diagnostic only when an action actually runs. */
export function markCloudOwnedCompatibilityCommand(command: Command): Command {
  command.hook('preAction', () => emitCloudCommandDeprecation(command.name()));
  return command;
}
