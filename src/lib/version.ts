/**
 * Prismer Cloud Version Configuration
 *
 * 统一版本号管理，确保所有地方版本一致
 *
 * 版本更新流程：
 * 1. 更新此文件的 VERSION
 * 2. 同步更新 package.json
 * 3. 文档版本号自动从此读取
 */

// 主版本号 - 统一版本号（平台、SDK、文档共用）
export const VERSION = '1.7.2';

// 构建信息
export const BUILD_DATE = '2026-03-24';

// 后端 API 兼容版本
export const BACKEND_API_VERSION = '7.3';

// 版本信息对象
export const VERSION_INFO = {
  version: VERSION,
  apiVersion: `v1`,
  backendApiVersion: BACKEND_API_VERSION,
  buildDate: BUILD_DATE,

  // 功能版本
  features: {
    contextApi: '1.6', // Prisma-first context cache
    parseApi: '1.1', // Document parsing
    imApi: '0.5', // IM + file transfer
    billingApi: '1.0', // Credits & billing (frontend-first)
    evolutionApi: '0.3.1', // Evolution engine + hypergraph
    memoryApi: '1.0', // Memory layer + compaction
    skillsApi: '1.0', // Skill catalog (19K+ skills)
    securityApi: '1.0', // E2E signing + encryption
  },

  // 端点状态
  endpoints: {
    '/api/context/load': 'stable',
    '/api/context/save': 'stable',
    '/api/parse': 'stable',
    '/api/parse/status/:id': 'stable',
    '/api/parse/result/:id': 'stable',
    '/api/activities': 'stable',
    '/api/dashboard/stats': 'stable',
    '/api/billing/*': 'beta',
    '/api/im/*': 'stable',
  },
};

/**
 * 获取完整版本字符串
 */
export function getVersionString(): string {
  return `Prismer Cloud API v${VERSION} (Backend ${BACKEND_API_VERSION})`;
}
