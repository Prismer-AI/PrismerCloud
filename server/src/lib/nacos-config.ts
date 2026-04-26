/**
 * Nacos configuration management for Prismer Cloud Next.js
 * 
 * All configuration is loaded from Nacos configuration center.
 * Environment variables can override Nacos values.
 * 
 * Priority: Environment Variables > Nacos
 * 
 * Note: Uses HTTP API directly instead of nacos npm package because:
 * - nacos npm package (v2.6.0) only supports Nacos Server 1.x
 * - Our server runs Nacos 2.4.3 which is incompatible
 * - HTTP API (/nacos/v1/cs/configs) works correctly with Nacos 2.x
 */

import yaml from 'yaml';

// Logger (simple console for now)
const logger = {
  info: (msg: string, ...args: any[]) => console.log(`[Nacos] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[Nacos] ⚠️  ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[Nacos] ❌ ${msg}`, ...args),
  debug: (msg: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      console.debug(`[Nacos] ${msg}`, ...args);
    }
  }
};

interface NacosConfig {
  serverAddr: string;
  namespace: string;
  dataId: string;
  group: string;
  username: string;
  password: string;
}

class NacosConfigLoader {
  private accessToken: string | null = null;
  private config: Record<string, string> = {};
  private initialized: boolean = false;
  private loading: Promise<boolean> | null = null;
  
  private configParams: NacosConfig;
  
  constructor(config?: Partial<NacosConfig>) {
    // Default configuration
    const serverAddr =
      process.env.CONFIG_CENTER_IP ||
      process.env.NACOS_SERVER_ADDR ||
      'localhost';

    // Determine app environment:
    // - If APP_ENV is set, use it directly (prod/test/dev)
    // - Otherwise, default to 'prod' in production, 'dev' in local development
    const appEnv =
      process.env.APP_ENV ??
      (process.env.NODE_ENV === 'production' ? 'prod' : 'dev');

    // Map APP_ENV to namespace
    const envNamespaceMap: Record<string, string> = {
      prod: process.env.NACOS_NAMESPACE || 'prod',
      production: process.env.NACOS_NAMESPACE || 'prod',
      test: process.env.NACOS_NAMESPACE || 'test',
      dev: process.env.NACOS_NAMESPACE || 'dev',
      development: process.env.NACOS_NAMESPACE || 'dev',
    };

     // Map APP_ENV to dataId (Nacos dataId is case-sensitive!)
    // All environments use "PrismerCloud"
    const envDataIdMap: Record<string, string> = {
      prod: 'PrismerCloud',
      production: 'PrismerCloud',
      test: 'PrismerCloud',
      dev: 'PrismerCloud',
      development: 'PrismerCloud',
    };

    const namespace =
      config?.namespace || envNamespaceMap[appEnv] || envNamespaceMap['dev'];
    const dataId =
      config?.dataId || envDataIdMap[appEnv] || envDataIdMap['dev'];

    this.configParams = {
      serverAddr,
      namespace,
      dataId,
      group: config?.group || 'DEFAULT_GROUP',
      username: config?.username || process.env.NACOS_USERNAME || 'nacos',
      password: config?.password || process.env.NACOS_PASSWORD || '',
    };
    
    if (!process.env.APP_ENV && process.env.NODE_ENV !== 'production') {
      logger.info(
        `🔧 Local dev mode (APP_ENV not set), using dev namespace: ${namespace}`,
      );
    } else {
      logger.info(`📋 Using namespace for APP_ENV=${appEnv}: ${namespace}`);
    }
  }
  
  /**
   * Initialize Nacos client and load configuration.
   * Uses singleton pattern to avoid duplicate initialization.
   */
  async initialize(): Promise<boolean> {
    // If already initialized, return immediately
    if (this.initialized) {
      return true;
    }
    
    // If currently loading, wait for it
    if (this.loading) {
      return this.loading;
    }
    
    // Start loading
    this.loading = this._doInitialize();
    const result = await this.loading;
    this.loading = null;
    
    return result;
  }
  
  private async _doInitialize(): Promise<boolean> {
    try {
      logger.info(`🔧 Initializing Nacos HTTP client: ${this.configParams.serverAddr}`);
      logger.info(`   Namespace: ${this.configParams.namespace}`);
      logger.info(`   Data ID: ${this.configParams.dataId}`);
      logger.info(`   Group: ${this.configParams.group}`);
      
      // Build base URL for Nacos HTTP API
      let baseUrl = this.configParams.serverAddr;
      if (!baseUrl.startsWith('http')) {
        baseUrl = `https://${baseUrl}`;
      }
      baseUrl = baseUrl.replace(/\/$/, '');
      
      // Login to get access token
      const loginUrl = `${baseUrl}/nacos/v1/auth/login`;
      const loginBody = `username=${encodeURIComponent(this.configParams.username)}&password=${encodeURIComponent(this.configParams.password)}`;
      
      const loginRes = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginBody,
      });
      
      if (loginRes.ok) {
        const loginData = await loginRes.json();
        this.accessToken = loginData.accessToken;
        logger.info('✅ Nacos login successful');
      } else {
        logger.warn(`⚠️  Nacos login failed: ${loginRes.status}, will try without auth`);
      }
      
      const configLoaded = await this.loadConfig();
      
      if (!configLoaded) {
        logger.warn('⚠️  Nacos configuration not loaded, will fall back to .env file');
      }
      
      this.initialized = true;
      return configLoaded;
      
    } catch (error) {
      logger.warn(`❌ Failed to initialize Nacos: ${error instanceof Error ? error.message : String(error)}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      return false;
    }
  }
  
  /**
   * Load configuration from Nacos via HTTP API and update environment variables.
   * Supports both YAML and .env (key=value) formats.
   */
  async loadConfig(): Promise<boolean> {
    try {
      logger.info(`📥 Loading config from Nacos (dataId=${this.configParams.dataId}, group=${this.configParams.group})`);
      
      // Build base URL for Nacos HTTP API
      let baseUrl = this.configParams.serverAddr;
      if (!baseUrl.startsWith('http')) {
        baseUrl = `https://${baseUrl}`;
      }
      baseUrl = baseUrl.replace(/\/$/, '');
      
      // Build query params
      const params = new URLSearchParams({
        dataId: this.configParams.dataId,
        group: this.configParams.group,
        tenant: this.configParams.namespace,
      });
      
      if (this.accessToken) {
        params.set('accessToken', this.accessToken);
      }
      
      const configUrl = `${baseUrl}/nacos/v1/cs/configs?${params.toString()}`;
      
      const res = await fetch(configUrl, {
        method: 'GET',
        headers: { 'Accept': 'text/plain' },
      });
      
      if (!res.ok) {
        if (res.status === 404) {
          logger.warn(
            `No configuration found in Nacos for dataId=${this.configParams.dataId}, ` +
            `namespace=${this.configParams.namespace}, group=${this.configParams.group}. ` +
            `Will fall back to .env file.`
          );
        } else {
          logger.warn(`Nacos config fetch failed: ${res.status} ${res.statusText}`);
        }
        return false;
      }
      
      const configStr = await res.text();
      
      if (!configStr || configStr.trim().length === 0) {
        logger.warn('Empty configuration from Nacos');
        return false;
      }
      
      // Parse configuration string
      const configDict = this._parseConfigString(configStr);
      
      if (!configDict || Object.keys(configDict).length === 0) {
        logger.warn('Empty configuration from Nacos after parsing');
        return false;
      }
      
      // Flatten configuration
      const flattened = this._isFlatConfig(configDict)
        ? Object.fromEntries(Object.entries(configDict).map(([k, v]) => [k.toUpperCase(), v]))
        : this._flattenConfig(configDict);
      
      this.config = flattened;
      
      // Update environment variables (only if not already set)
      this._updateEnvVars(flattened);
      
      logger.info(`✅ Loaded ${Object.keys(flattened).length} configuration items from Nacos`);
      return true;
      
    } catch (error) {
      logger.warn(`❌ Failed to load config from Nacos: ${error instanceof Error ? error.message : String(error)}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      return false;
    }
  }
  
  /**
   * Parse configuration string, supporting both YAML and .env formats.
   */
  private _parseConfigString(configStr: string): Record<string, any> {
    // First, try YAML parsing
    try {
      const configDict = yaml.parse(configStr);
      if (typeof configDict === 'object' && configDict !== null) {
        logger.info('📋 Parsed configuration as YAML format');
        return configDict as Record<string, any>;
      }
    } catch (yamlError) {
      // Not YAML, continue to .env format
    }
    
    // Fall back to .env format (key=value pairs)
    logger.info('📋 Parsing configuration as .env format');
    const configDict: Record<string, string> = {};
    
    for (const line of configStr.trim().split('\n')) {
      const trimmed = line.trim();
      
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      
      // Parse key=value
      if (trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const keyTrimmed = key.trim();
        let value = valueParts.join('=').trim();
        
        // Remove quotes if present
        if (value && (value.startsWith('"') || value.startsWith("'"))) {
          const quote = value[0];
          if (value.endsWith(quote)) {
            value = value.slice(1, -1);
          }
        } else {
          // Remove inline comments (but preserve # in quoted strings)
          const commentIndex = value.indexOf('#');
          if (commentIndex >= 0) {
            value = value.substring(0, commentIndex).trim();
          }
        }
        
        configDict[keyTrimmed] = value;
      }
    }
    
    return configDict;
  }
  
  /**
   * Check if config is already flat (no nested objects).
   */
  private _isFlatConfig(configDict: Record<string, any>): boolean {
    return !Object.values(configDict).some(v => typeof v === 'object' && v !== null && !Array.isArray(v));
  }
  
  /**
   * Flatten nested configuration to environment variable format.
   * Example: {"openai": {"api_key": "xxx"}} -> {"OPENAI_API_KEY": "xxx"}
   */
  private _flattenConfig(configDict: Record<string, any>, prefix: string = ''): Record<string, string> {
    const flattened: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(configDict)) {
      const newKey = prefix ? `${prefix}_${key}`.toUpperCase() : key.toUpperCase();
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(flattened, this._flattenConfig(value as Record<string, any>, newKey));
      } else {
        flattened[newKey] = String(value);
      }
    }
    
    return flattened;
  }
  
  /**
   * Update environment variables from configuration.
   * Only sets variables that are not already set (allows env override).
   */
  private _updateEnvVars(configDict: Record<string, string>): void {
    for (const [key, value] of Object.entries(configDict)) {
      // Only set if not already in environment (allow override)
      if (!(key in process.env)) {
        process.env[key] = value;
        logger.debug(`Set env var from Nacos: ${key}`);
      } else {
        logger.debug(`Env var already set, keeping: ${key}`);
      }
    }
  }
  
  /**
   * Reload configuration from Nacos.
   */
  async reload(): Promise<boolean> {
    logger.info('🔄 Reloading Nacos configuration...');
    return this.loadConfig();
  }
  
  /**
   * Get Nacos connection status.
   */
  getStatus(): Record<string, any> {
    return {
      enabled: this.initialized,
      serverAddr: this.configParams.serverAddr,
      namespace: this.configParams.namespace,
      dataId: this.configParams.dataId,
      group: this.configParams.group,
      configCount: Object.keys(this.config).length,
      initialized: this.initialized,
      hasAccessToken: !!this.accessToken,
    };
  }
}

// ============================================================
// Global instance (singleton)
// ============================================================

let _nacosLoader: NacosConfigLoader | null = null;

/**
 * Initialize Nacos configuration.
 * Should be called before accessing settings to load from Nacos.
 * Uses singleton pattern to avoid duplicate initialization.
 */
export async function initNacosConfig(
  enableNacos: boolean = true,
  config?: Partial<NacosConfig>
): Promise<NacosConfigLoader | null> {
  // Return existing loader if already initialized (singleton pattern)
  if (_nacosLoader !== null && _nacosLoader.getStatus().initialized) {
    logger.debug('Nacos loader already initialized, reusing existing instance');
    return _nacosLoader;
  }
  
  if (!enableNacos) {
    logger.info('Nacos configuration disabled');
    return null;
  }
  
  _nacosLoader = new NacosConfigLoader(config);
  
  // Try to initialize, but don't fail if config doesn't exist
  const configLoaded = await _nacosLoader.initialize();
  
  if (configLoaded) {
    logger.info('✅ Nacos configuration loaded successfully');
  } else {
    logger.info('ℹ️  Nacos configuration not found, using .env file as fallback');
  }
  
  // Return loader even if config wasn't loaded (client is still initialized)
  return _nacosLoader;
}

/**
 * Get Nacos connection status.
 */
export function getNacosStatus(): Record<string, any> {
  if (_nacosLoader) {
    return _nacosLoader.getStatus();
  }
  return {
    enabled: false,
    status: 'Nacos loader not initialized',
  };
}

/**
 * Reload configuration from Nacos.
 */
export async function reloadNacosConfig(): Promise<boolean> {
  if (_nacosLoader) {
    return _nacosLoader.reload();
  }
  return false;
}

/**
 * Ensure Nacos config is loaded (for use in API routes).
 * This is a convenience function that initializes if needed.
 */
export async function ensureNacosConfig(): Promise<void> {
  // Self-host mode: skip Nacos entirely, use .env
  if (process.env.NACOS_DISABLED === 'true') {
    return;
  }
  if (!_nacosLoader || !_nacosLoader.getStatus().initialized) {
    await initNacosConfig();
  }
}

