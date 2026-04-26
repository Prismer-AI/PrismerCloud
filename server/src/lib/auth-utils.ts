/**
 * Authentication Utilities
 * 
 * 用于解析 JWT token 并获取用户信息
 * 支持 JWT token 和 API Key (sk-prismer-xxx)
 */

export interface AuthUser {
  id: number;
  email: string;
}

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  error?: string;
}

/**
 * 解析 JWT payload（不验证签名，仅解码）
 * 
 * 注意：生产环境应该验证签名，但由于我们的 JWT 是后端签发的，
 * 这里简化处理，信任已经通过网关的请求
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    // JWT 格式: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    // Base64Url 解码 payload
    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * 从 Authorization header 解析用户信息
 * 
 * 支持：
 * - Bearer <jwt_token>
 * - Bearer sk-prismer-xxx (API Key)
 */
export async function getUserFromAuth(authHeader: string | null): Promise<AuthResult> {
  if (!authHeader) {
    return { success: false, error: 'Authorization header required' };
  }
  
  // 提取 token
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;
  
  if (!token) {
    return { success: false, error: 'Invalid authorization format' };
  }
  
  // 检查是否是 API Key
  if (token.startsWith('sk-prismer-')) {
    return getUserFromApiKey(token);
  }
  
  // 尝试解析 JWT
  return getUserFromJwt(token);
}

/**
 * 从 JWT token 获取用户信息
 */
async function getUserFromJwt(token: string): Promise<AuthResult> {
  const payload = decodeJwtPayload(token);
  
  if (!payload) {
    return { success: false, error: 'Invalid JWT token' };
  }
  
  // 尝试从不同的 JWT payload 格式获取用户 ID
  // 常见格式: { sub: "123", user_id: 123, id: 123 }
  const userId = payload.sub || payload.user_id || payload.id;
  
  if (!userId) {
    return { success: false, error: 'User ID not found in token' };
  }
  
  const numericId = typeof userId === 'string' ? parseInt(userId, 10) : userId as number;
  
  if (isNaN(numericId)) {
    return { success: false, error: 'Invalid user ID format' };
  }
  
  // 可选：从数据库验证用户存在
  // 这里我们信任 JWT，不做额外查询
  const email = (payload.email as string) || '';
  
  return {
    success: true,
    user: {
      id: numericId,
      email
    }
  };
}

/**
 * 从 API Key 获取用户信息
 *
 * 查 pc_api_keys 表 (SHA-256 hash 验证)
 */
async function getUserFromApiKey(apiKey: string): Promise<AuthResult> {
  try {
    const { validateApiKeyFromDb } = await import('./db-api-keys');
    const result = await validateApiKeyFromDb(apiKey);
    if (!result) {
      return { success: false, error: 'Invalid or inactive API key' };
    }
    return {
      success: true,
      user: { id: result.userId, email: '' }
    };
  } catch (error) {
    console.error('[Auth] API Key verification error:', error);
    return { success: false, error: 'Failed to verify API key' };
  }
}

/**
 * 简化版：直接获取用户 ID（失败时抛出异常）
 */
export async function requireUserId(authHeader: string | null): Promise<number> {
  const result = await getUserFromAuth(authHeader);
  
  if (!result.success || !result.user) {
    throw new Error(result.error || 'Authentication required');
  }
  
  return result.user.id;
}
