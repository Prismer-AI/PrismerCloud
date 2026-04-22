// T12 — Shared CLI context: wires UI + Keychain for command handlers

import { UI, applyCommonFlags } from './ui.js';
import { Keychain } from '../keychain.js';
import { loadConfig, type PrismerConfig } from '../config.js';

export interface CliResolvedConfig extends PrismerConfig {
  apiToken?: string;
  cloudBaseUrl: string;
  agentId?: string;
}

export interface CliContext {
  ui: UI;
  keychain: Keychain;
  cwd: string;
  argv: string[];
}

export async function createCliContext(opts?: {
  argv?: string[];
  ui?: UI;
}): Promise<CliContext> {
  const argv = opts?.argv ?? process.argv;

  let ui: UI;
  if (opts?.ui) {
    ui = opts.ui;
  } else {
    const { mode, color } = applyCommonFlags(argv);
    ui = new UI({ mode, color });
  }

  const keychain = new Keychain();

  return {
    ui,
    keychain,
    cwd: process.cwd(),
    argv,
  };
}

export async function loadCliConfig(ctx: CliContext): Promise<CliResolvedConfig> {
  const config = await loadConfig({
    keychain: ctx.keychain,
  });

  return {
    ...config,
    apiToken: typeof config.apiKey === 'string' ? config.apiKey : undefined,
    cloudBaseUrl:
      typeof config.apiBase === 'string' && config.apiBase.length > 0
        ? config.apiBase
        : 'https://prismer.cloud/api',
    agentId:
      typeof config['agentId'] === 'string'
        ? (config['agentId'] as string)
        : typeof process.env['PRISMER_AGENT_ID'] === 'string'
          ? process.env['PRISMER_AGENT_ID']
          : undefined,
  };
}
