/**
 * Prismer Cloud Version Configuration
 *
 * 单一真相源：根 `/VERSION` 文件。
 * 此文件中的 VERSION + BUILD_DATE 由 `sdk/build/version.sh` 在 bump 时
 * 自动改写（Edge runtime 不能 fs.readFileSync，所以编译期注入）。
 * **不要手改下面两个常量**，改 `/VERSION` 后跑 `sdk/build/version.sh`。
 *
 * Hotfix（X.Y.Z.N）使用 `sdk/build/hotfix.sh`，不影响此文件。
 */

// 主版本号 - 与根 /VERSION 同步（由 version.sh 改写）
export const VERSION = '1.8.2';

// 构建信息
export const BUILD_DATE = '2026-04-13';

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
    evolutionApi: '0.4', // Evolution engine + harness convergence + leaderboard V2
    memoryApi: '1.1', // Memory intelligence (4-type + LLM recall + Dream + Knowledge Links)
    skillsApi: '1.0', // Skill catalog (19K+ skills)
    securityApi: '1.1', // Ed25519 auto-signing + hash chain + DID binding
    communityApi: '1.0', // Community forum (posts, comments, votes, follows)
    contactApi: '1.0', // Contact system (friends, block, pin, mute)
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
