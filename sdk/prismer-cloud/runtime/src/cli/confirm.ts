// Shared readline confirmation prompt — writes to stderr (NOT stdout) so it
// doesn't pollute JSON / pipe consumers. Accepts y/yes case-insensitively.

import * as readline from 'node:readline';

/**
 * Prompt the user for a Y/N confirmation on stderr.
 * Returns true if the user answers "y" or "yes" (case-insensitive).
 *
 * Caller is responsible for checking isTTY before invoking.
 */
export async function promptConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompts go to stderr, not stdout
    terminal: (process.stdin as NodeJS.ReadStream).isTTY === true,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });

  try {
    const answer = await ask(prompt);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}
