/**
 * X-movbngcw 模块测试套件
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Xmovbngcw, SmokeTestResult, SystemHealthStatus } from '../x-movbngcw';

// 模拟 logger
vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('X-movbngcw', () => {
  let xmovbngcw: Xmovbngcw;

  beforeEach(() => {
    xmovbngcw = new Xmovbngcw({
      timeoutMs: 5000,
      retries: 1,
      enableDetailedLogging: false,
    });
  });

  describe('基本功能', () => {
    it('应该正确初始化', () => {
      expect(xmovbngcw).toBeDefined();
    });

    it('应该使用默认配置', () => {
      const instance = new Xmovbngcw();
      expect(instance).toBeDefined();
    });

    it('应该接受自定义配置', () => {
      const instance = new Xmovbngcw({ timeoutMs: 10000 });
      expect(instance).toBeDefined();
    });
  });

  describe('环境检查', () => {
    it('应该成功检查环境', async () => {
      const result = await xmovbngcw.checkEnvironment();

      expect(result.success).toBe(true);
      expect(result.module).toBe('environment');
      expect(result.message).toContain('Environment verified');
      expect(result.details).toHaveProperty('nodeVersion');
      expect(result.details).toHaveProperty('platform');
    });
  });

  describe('数据库检查', () => {
    it('应该成功检查数据库连接', async () => {
      const result = await xmovbngcw.checkDatabaseConnectivity();

      expect(result.success).toBe(true);
      expect(result.module).toBe('database');
      expect(result.message).toContain('Database connectivity verified');
    });
  });

  describe('API 检查', () => {
    it('应该成功检查 API 端点', async () => {
      const result = await xmovbngcw.checkApiEndpoints();

      expect(result.success).toBe(true);
      expect(result.module).toBe('api');
      expect(result.message).toContain('API endpoints verified');
      expect(result.details).toHaveProperty('endpoints');
    });
  });

  describe('内存检查', () => {
    it('应该成功检查内存使用', async () => {
      const result = await xmovbngcw.checkMemoryUsage();

      expect(result.module).toBe('memory');
      expect(result.details).toHaveProperty('heapUsedMB');
      expect(result.details).toHaveProperty('heapTotalMB');
    });

    it('应该包含有效的内存信息', async () => {
      const result = await xmovbngcw.checkMemoryUsage();

      expect(typeof result.details?.heapUsedMB).toBe('number');
      expect(typeof result.details?.heapTotalMB).toBe('number');
      expect(result.details?.heapUsedMB).toBeGreaterThanOrEqual(0);
    });
  });

  describe('磁盘检查', () => {
    it('应该成功检查磁盘空间', async () => {
      const result = await xmovbngcw.checkDiskSpace();

      expect(result.success).toBe(true);
      expect(result.module).toBe('disk');
      expect(result.details).toHaveProperty('freeSpaceGB');
    });
  });

  describe('快速健康检查', () => {
    it('应该返回 M4OK-movbngcw 标记', async () => {
      const result = await xmovbngcw.quickHealthCheck();

      expect(result.success).toBe(true);
      expect(result.message).toBe('M4OK-movbngcw');
      expect(result.module).toBe('quick-health');
    });

    it('应该包含操作状态信息', async () => {
      const result = await xmovbngcw.quickHealthCheck();

      expect(result.details).toHaveProperty('status');
      expect(result.details?.status).toBe('operational');
    });
  });

  describe('完整 Smoke Test', () => {
    it('应该运行完整的 smoke test 套件', async () => {
      const result = await xmovbngcw.runSmokeTest();

      expect(result).toHaveProperty('overall');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('environment');
      expect(result).toHaveProperty('version');

      expect(['healthy', 'degraded', 'unhealthy']).toContain(result.overall);
      expect(result.checks.length).toBeGreaterThanOrEqual(5);
    });

    it('应该正确计算整体状态', async () => {
      const result = await xmovbngcw.runSmokeTest();

      const failedCount = result.checks.filter((c) => !c.success).length;

      if (failedCount === 0) {
        expect(result.overall).toBe('healthy');
      } else if (failedCount >= 3) {
        expect(result.overall).toBe('unhealthy');
      } else {
        expect(result.overall).toBe('degraded');
      }
    });

    it('每个检查都应该包含必要字段', async () => {
      const result = await xmovbngcw.runSmokeTest();

      for (const check of result.checks) {
        expect(check).toHaveProperty('success');
        expect(check).toHaveProperty('module');
        expect(check).toHaveProperty('message');
        expect(check).toHaveProperty('timestamp');
        expect(check).toHaveProperty('durationMs');
        expect(typeof check.success).toBe('boolean');
        expect(typeof check.module).toBe('string');
        expect(typeof check.message).toBe('string');
      }
    });
  });

  describe('性能测试', () => {
    it('应该在合理时间内完成', async () => {
      const startTime = Date.now();
      await xmovbngcw.runSmokeTest();
      const duration = Date.now() - startTime;

      // 应该在 5 秒内完成
      expect(duration).toBeLessThan(5000);
    });

    it('每个检查都应记录持续时间', async () => {
      const result = await xmovbngcw.runSmokeTest();

      for (const check of result.checks) {
        expect(typeof check.durationMs).toBe('number');
        expect(check.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

/**
 * 集成测试
 */
describe('X-movbngcw 集成测试', () => {
  it('应该支持多次连续调用', async () => {
    const xmovbngcw = new Xmovbngcw();

    const result1 = await xmovbngcw.quickHealthCheck();
    const result2 = await xmovbngcw.quickHealthCheck();
    const result3 = await xmovbngcw.quickHealthCheck();

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result3.success).toBe(true);
  });

  it('应该保持一致的输出格式', async () => {
    const xmovbngcw = new Xmovbngcw();
    const result = await xmovbngcw.runSmokeTest();

    // 验证输出格式一致性
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
