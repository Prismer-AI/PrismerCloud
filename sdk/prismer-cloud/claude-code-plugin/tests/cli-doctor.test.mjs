import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

describe('CLI Doctor', () => {
  let tempDir;
  let tempHome;
  let originalEnv;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cli-doctor-test-${randomUUID()}`);
    tempHome = join(tempDir, '.claude-home');
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(tempDir, { recursive: true });

    originalEnv = { ...process.env };
    process.env.HOME = tempHome;
    process.env.CLAUDE_PLUGIN_DATA = join(tempDir, 'cache');
  });

  afterEach(async () => {
    process.env = originalEnv;
    try {
      await import('fs/promises').then(fs => fs.rm(tempDir, { recursive: true, force: true }));
    } catch {}
  });

  it('should output structured report with all checks', async () => {
    const { runDoctor } = await import('../scripts/cli.mjs');
    
    // Mock console methods to capture output
    const outputs = [];
    const mockLog = (msg) => outputs.push(msg);
    const originalConsoleLog = console.log;
    console.log = mockLog;

    try {
      await runDoctor();
      
      // Check that report was generated
      const output = outputs.join('\n');
      expect(output).toContain('Diagnostic Report');
      expect(output).toContain('Plugin Version Match');
      expect(output).toContain('API Key Validity');
      expect(output).toContain('Hooks Registration');
      expect(output).toContain('Cache Directory');
      expect(output).toContain('MCP Server Config');
      expect(output).toContain('Plugin Root Path');
      expect(output).toContain('Summary:');
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it('should detect missing API key', async () => {
    const { runDoctor } = await import('../scripts/cli.mjs');
    
    // Remove config file
    const configDir = join(tempHome, '.prismer');
    try { unlinkSync(join(configDir, 'config.toml')); } catch {}

    const outputs = [];
    const mockLog = (msg) => outputs.push(msg);
    const originalConsoleLog = console.log;
    console.log = mockLog;

    try {
      await runDoctor();
      
      const output = outputs.join('\n');
      expect(output).toContain('API Key Validity');
      expect(output).toMatch(/❌|⚠️/); // Should be fail or warn
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it('should detect missing hooks.json', async () => {
    const { runDoctor } = await import('../scripts/cli.mjs');
    
    // Remove hooks file
    try { unlinkSync(join(tempHome, '.claude', 'hooks.json')); } catch {}

    const outputs = [];
    const mockLog = (msg) => outputs.push(msg);
    const originalConsoleLog = console.log;
    console.log = mockLog;

    try {
      await runDoctor();
      
      const output = outputs.join('\n');
      expect(output).toContain('Hooks Registration');
      expect(output).toContain('not found');
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it('should check cache directory readability', async () => {
    const { runDoctor } = await import('../scripts/cli.mjs');
    
    const outputs = [];
    const mockLog = (msg) => outputs.push(msg);
    const originalConsoleLog = console.log;
    console.log = mockLog;

    try {
      await runDoctor();
      
      const output = outputs.join('\n');
      expect(output).toContain('Cache Directory');
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it('should validate MCP server config', async () => {
    const { runDoctor } = await import('../scripts/cli.mjs');
    
    const outputs = [];
    const mockLog = (msg) => outputs.push(msg);
    const originalConsoleLog = console.log;
    console.log = mockLog;

    try {
      await runDoctor();
      
      const output = outputs.join('\n');
      expect(output).toContain('MCP Server Config');
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it('should check plugin root path', async () => {
    const { runDoctor } = await import('../scripts/cli.mjs');
    
    const outputs = [];
    const mockLog = (msg) => outputs.push(msg);
    const originalConsoleLog = console.log;
    console.log = mockLog;

    try {
      await runDoctor();
      
      const output = outputs.join('\n');
      expect(output).toContain('Plugin Root Path');
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it('should include summary with counts', async () => {
    const { runDoctor } = await import('../scripts/cli.mjs');
    
    const outputs = [];
    const mockLog = (msg) => outputs.push(msg);
    const originalConsoleLog = console.log;
    console.log = mockLog;

    try {
      await runDoctor();
      
      const output = outputs.join('\n');
      expect(output).toMatch(/Summary: \d+ passed, \d+ warnings?, \d+ failed/);
    } finally {
      console.log = originalConsoleLog;
    }
  });
});
