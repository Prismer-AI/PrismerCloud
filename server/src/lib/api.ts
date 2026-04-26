import { Activity, ApiKeyData, ChartData, Invoice, PaymentMethod, Strategy, TaskResult, SourceResult } from '@/types';

// Usage record types
interface UsageMetrics {
  exa_searches?: number;
  urls_processed?: number;
  urls_cached?: number;
  urls_compressed?: number;
  tokens_input?: number;
  tokens_output?: number;
  processing_time_ms?: number;
}

interface UsageCost {
  search_credits?: number;
  compression_credits?: number;
  total_credits: number;
}

interface UsageSource {
  url: string;
  cached: boolean;
  tokens: number;
}

interface UsageRecordRequest {
  task_id: string;
  task_type: string;
  input: {
    type: 'query' | 'url';
    value: string;
  };
  metrics: UsageMetrics;
  cost: UsageCost;
  sources?: UsageSource[];
}

interface UsageRecordResponse {
  record_id: string;
  credits_deducted: number;
  credits_remaining: number;
}

// Simulate network latency
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Context API base URL - Use Next.js API routes as proxy
// Next.js routes will proxy to backend: https://prismer.cloud/api/v1/context
const CONTEXT_API_BASE = '/api/context';

/**
 * Get authorization headers with token from localStorage
 *
 * Priority:
 * 1. JWT token from prismer_auth (login session)
 * 2. API key from prismer_active_api_key (if no JWT)
 */
function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    // First, try to get JWT token from auth session
    const authStored = localStorage.getItem('prismer_auth');
    if (authStored) {
      const authData = JSON.parse(authStored);
      if (authData.token && authData.expiresAt > Date.now()) {
        headers['Authorization'] = `Bearer ${authData.token}`;
        return headers;
      }
    }

    // Fallback to active API key if no valid JWT
    const apiKeyStored = localStorage.getItem('prismer_active_api_key');
    if (apiKeyStored) {
      const keyData = JSON.parse(apiKeyStored);
      if (keyData.key && keyData.status === 'ACTIVE') {
        headers['Authorization'] = `Bearer ${keyData.key}`;
        return headers;
      }
    }
  } catch (error) {
    console.error('Failed to get auth token', error);
  }
  return headers;
}

/**
 * Check if user is authenticated (has valid JWT token or active API key)
 */
function isAuthenticated(): boolean {
  try {
    // Check JWT token
    const authStored = localStorage.getItem('prismer_auth');
    if (authStored) {
      const authData = JSON.parse(authStored);
      if (authData.token && authData.token.length >= 32 && authData.expiresAt > Date.now()) {
        return true;
      }
    }

    // Check active API key
    const apiKeyStored = localStorage.getItem('prismer_active_api_key');
    if (apiKeyStored) {
      const keyData = JSON.parse(apiKeyStored);
      if (keyData.key && keyData.status === 'ACTIVE') {
        return true;
      }
    }
  } catch {
    // Ignore errors
  }
  return false;
}

/**
 * Check if input is a valid URL
 */
function isValidUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Exa search result interface
interface ExaSearchResult {
  id: string;
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
  author?: string;
  links: string[];
  imageLinks: string[];
}

interface ExaSearchResponse {
  requestId: string;
  resolvedSearchType: string;
  results: ExaSearchResult[];
  totalResults: number;
}

interface ExaContentsResponse {
  results: ExaSearchResult[];
  totalResults: number;
}

interface CompressResponse {
  hqcc: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface CacheResult {
  url: string;
  cached: boolean;
  hqcc: string;
  raw: string;
  meta: Record<string, unknown>;
}

// Streaming compression callback type
type StreamCallback = (chunk: string, done: boolean) => void;

/**
 * Calculate content size metrics
 */
function calculateSize(content: string) {
  const charCount = content.length;
  const byteCount = new Blob([content]).size;
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;

  return {
    characters: charCount,
    bytes: byteCount,
    words: wordCount,
    formatted: {
      characters: charCount.toLocaleString(),
      bytes: formatBytes(byteCount),
      words: wordCount.toLocaleString(),
    },
  };
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * API Service Layer
 *
 * This module provides a clean interface for all API calls.
 * Playground uses real Context API, other endpoints use mock data.
 */
export const api = {
  // ===== Activities =====
  async getActivities(page: number = 1, limit: number = 20): Promise<Activity[]> {
    // Skip if not authenticated
    if (!isAuthenticated()) {
      return [];
    }

    try {
      const res = await fetch(`/api/activities?page=${page}&limit=${limit}`, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      // Handle auth errors silently
      if (res.status === 401 || res.status === 403) {
        return [];
      }

      const data = await res.json();

      if (!res.ok || !data.success) {
        // Silently handle all errors - backend may not be ready
        // Only log in development for debugging
        if (process.env.NODE_ENV === 'development' && res.status !== 500) {
          console.warn('[API] Activities API returned error:', res.status);
        }
        return [];
      }

      return data.data || [];
    } catch (error) {
      // Silently fail - backend may not be ready
      return [];
    }
  },

  // ===== Playground Processing =====
  /**
   * Submit task for processing
   *
   * 使用统一的 /api/context/load API:
   * - 自动检测输入类型 (URL or Query)
   * - 包含缓存检查、压缩、存储
   * - 自动记录使用量 (usage recording)
   */
  async submitTask(
    input: string,
    strategy: Strategy,
    onStream?: StreamCallback,
    options?: { format?: string; topK?: number; useAutoprompt?: boolean },
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const trimmedInput = input.trim();
    const inputIsUrl = isValidUrl(trimmedInput);

    console.log(`[submitTask] Using /api/context/load, input type: ${inputIsUrl ? 'URL' : 'Query'}`);

    try {
      // 调用统一的 load API
      const response = await fetch('/api/context/load', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          input: trimmedInput,
          processing: { strategy: this._strategyToString(strategy) },
          return: {
            format: options?.format || 'hqcc',
            topK: options?.topK || 10,
          },
          search: !inputIsUrl ? { useAutoprompt: options?.useAutoprompt ?? true } : undefined,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[submitTask] Load API error:', errorData);
        throw new Error(errorData.error?.message || 'Load API failed');
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error?.message || 'Load failed');
      }

      // 根据模式适配返回格式
      // 获取处理时间 (API 返回 processingTime，转为前端期望的 processing_time_ms)
      const processingTimeMs = data.processingTime || Date.now() - startTime;

      if (data.mode === 'single_url') {
        // 单 URL 模式
        const result = data.result;
        const hqcc = result.hqcc || '';

        if (onStream) {
          onStream(hqcc, true);
        }

        return {
          hqcc,
          raw: result.raw || '',
          json: {
            url: result.url,
            title: result.title,
            cached: result.cached,
            processing_time_ms: processingTimeMs,
            mode: data.mode,
            cost: data.cost,
            savings: data.savings,
            meta: result.meta,
            requestId: data.requestId,
          },
          inputType: 'url',
        };
      } else if (data.mode === 'query') {
        // Query 搜索模式 - 多结果
        const results = data.results || [];

        if (results.length === 0) {
          return this._buildNoResultsResponse(trimmedInput, startTime, 'query');
        }

        // 主结果
        const primary = results[0];
        const hqcc = primary.hqcc || '';

        if (onStream) {
          onStream(hqcc, true);
        }

        // 构建 sources 数组
        const sources: SourceResult[] = results.map((r: any, idx: number) => ({
          id: `source_${idx}`,
          title: r.title || r.url,
          url: r.url,
          hqcc: r.hqcc || '',
          raw: r.raw || '',
          cached: r.cached || false,
        }));

        return {
          hqcc,
          raw: primary.raw || '',
          json: {
            query: trimmedInput,
            resultCount: results.length,
            processing_time_ms: processingTimeMs,
            mode: data.mode,
            cost: data.cost,
            savings: data.savings,
            requestId: data.requestId,
          },
          sources,
          activeSourceIndex: 0,
          inputType: 'query',
        };
      } else {
        // 未知模式，尝试基本处理
        console.warn('[submitTask] Unknown mode:', data.mode);
        return {
          hqcc: '',
          raw: '',
          json: data,
          inputType: inputIsUrl ? 'url' : 'query',
        };
      }
    } catch (error) {
      console.error('[submitTask] Error:', error);
      // Fallback 到旧的处理方式（兼容性）
      console.log('[submitTask] Falling back to legacy processing...');
      if (inputIsUrl) {
        return await this._processUrl(trimmedInput, strategy, startTime, onStream);
      } else {
        return await this._processQuery(trimmedInput, strategy, startTime, onStream);
      }
    }
  },

  /**
   * Convert Strategy enum to string for API
   */
  _strategyToString(strategy: Strategy): string {
    switch (strategy) {
      case Strategy.TECHNICAL:
        return 'technical';
      case Strategy.FINANCE:
        return 'finance';
      case Strategy.ACADEMIC:
        return 'academic';
      case Strategy.LEGAL:
        return 'legal';
      default:
        return 'auto';
    }
  },

  /**
   * URL 处理流程
   * 1. 先查 Context Server
   * 2. 未命中则用 Exa get_contents 获取内容
   * 3. 压缩并存储
   */
  async _processUrl(
    url: string,
    strategy: Strategy,
    startTime: number,
    onStream?: StreamCallback,
  ): Promise<TaskResult> {
    try {
      // Step 1: 尝试从 Context Server 获取
      console.log('[processUrl] Step 1: Checking Context Server...');
      const cached = await this._tryWithdrawFromContext(url);

      if (cached) {
        console.log('[processUrl] Cache hit! Returning cached result.');
        if (onStream) {
          onStream(cached.hqcc, true);
        }
        return this._buildCachedResult(cached, url, startTime);
      }

      // Step 2: Context Server 未命中，获取 URL 内容
      console.log('[processUrl] Step 2: Cache miss, fetching URL content...');

      const contentRes = await fetch('/api/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [url] }),
      });

      if (!contentRes.ok) {
        const errorData = await contentRes.json().catch(() => ({}));
        console.error('[processUrl] Content fetch failed:', errorData);
        throw new Error(errorData.error || 'Failed to fetch URL content');
      }

      const contentData: ExaContentsResponse = await contentRes.json();

      if (!contentData.results || contentData.results.length === 0 || !contentData.results[0].text) {
        console.log('[processUrl] No content found for URL');
        return this._buildNoResultsResponse(url, startTime, 'url');
      }

      const content = contentData.results[0];

      // Check content quality
      if (content.text.length < 500) {
        console.log('[processUrl] Content too short:', content.text.length);
        return this._buildNoResultsResponse(url, startTime, 'url', 'Content too short (< 500 characters)');
      }

      // Step 3: 压缩内容
      console.log('[processUrl] Step 3: Compressing content...');
      const { hqcc, model } = await this._compressContent(content, strategy, onStream);

      // Step 4: 后台存储到 Context Server
      console.log('[processUrl] Step 4: Depositing to Context Server (background)...');
      this._depositToContext(url, hqcc, content.text, strategy, model, content.imageLinks);

      // Step 5: 返回结果（单一来源，不显示多 source 切换器）
      return this._buildSingleSourceResult(content, hqcc, model, url, strategy, startTime);
    } catch (error) {
      console.error('[processUrl] Error:', error);
      throw new Error('Failed to process URL');
    }
  },

  /**
   * Query 处理流程
   * 1. 搜索引擎查询
   * 2. 压缩第一个结果
   * 3. 其他结果按需压缩
   */
  async _processQuery(
    query: string,
    strategy: Strategy,
    startTime: number,
    onStream?: StreamCallback,
  ): Promise<TaskResult> {
    try {
      // Step 1: 搜索
      console.log('[processQuery] Step 1: Searching...');

      const searchRes = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      if (!searchRes.ok) {
        throw new Error('Search failed');
      }

      const searchData: ExaSearchResponse = await searchRes.json();

      // Step 2: 过滤低质量结果
      const MIN_CONTENT_LENGTH = 1000;
      const qualityResults = (searchData.results || []).filter((r) => r.text && r.text.length >= MIN_CONTENT_LENGTH);

      console.log(
        `[processQuery] Found ${searchData.results?.length || 0} results, ${qualityResults.length} quality results`,
      );

      if (qualityResults.length === 0) {
        return this._buildNoResultsResponse(
          query,
          startTime,
          'query',
          `No substantial content found. ${searchData.results?.length || 0} results filtered (< ${MIN_CONTENT_LENGTH} chars)`,
        );
      }

      // Take up to 10 quality results
      const topResults = qualityResults.slice(0, 10);

      // Step 3: 检查各结果的缓存状态
      console.log('[processQuery] Step 3: Checking cache for each result...');
      const cacheResults = await this._checkMultipleCache(topResults);
      const cacheHits = Array.from(cacheResults.values()).filter((c) => c.cached).length;
      console.log(`[processQuery] Cache hits: ${cacheHits}/${topResults.length}`);

      // Step 4: 压缩主要结果（如果未缓存）
      const primary = topResults[0];
      const primaryCache = cacheResults.get(primary.url);

      let hqcc: string;
      let compressModel = '';
      let usedCache = false;

      if (primaryCache?.cached && primaryCache.hqcc) {
        console.log('[processQuery] Primary source cache hit!');
        hqcc = primaryCache.hqcc;
        compressModel = (primaryCache.meta?.model as string) || 'cached';
        usedCache = true;
        if (onStream) {
          onStream(hqcc, true);
        }
      } else {
        console.log('[processQuery] Step 4: Compressing primary result...');
        const compressed = await this._compressContent(primary, strategy, onStream);
        hqcc = compressed.hqcc;
        compressModel = compressed.model;

        // 后台存储
        this._depositToContext(primary.url, hqcc, primary.text, strategy, compressModel, primary.imageLinks);
      }

      // Step 5: 构建多来源结果
      return this._buildMultiSourceResult(
        topResults,
        cacheResults,
        hqcc,
        compressModel,
        query,
        strategy,
        startTime,
        usedCache,
        searchData.totalResults,
      );
    } catch (error) {
      console.error('[processQuery] Error:', error);
      throw new Error('Failed to process query');
    }
  },

  /**
   * 尝试从 Context Server 获取缓存
   */
  async _tryWithdrawFromContext(url: string): Promise<CacheResult | null> {
    try {
      const headers = getAuthHeaders();
      console.log('[_tryWithdrawFromContext] Checking cache for:', url);
      console.log('[_tryWithdrawFromContext] Has auth header:', !!headers['Authorization']);

      const [hqccRes, rawRes] = await Promise.all([
        fetch(`${CONTEXT_API_BASE}/withdraw`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ raw_link: url, format: 'HQCC', embed: false }),
        }),
        fetch(`${CONTEXT_API_BASE}/withdraw`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ raw_link: url, format: 'intr', embed: false }),
        }),
      ]);

      console.log('[_tryWithdrawFromContext] Response status:', hqccRes.status);

      const hqccData = await hqccRes.json();
      const rawData = await rawRes.json();

      console.log('[_tryWithdrawFromContext] hqcc found:', hqccData.found, 'has content:', !!hqccData.hqcc_content);

      // Log any errors from the API
      if (hqccData.error || hqccData._debug) {
        console.log('[_tryWithdrawFromContext] API error/debug:', hqccData.error || hqccData._debug);
      }

      if (hqccData.found && hqccData.hqcc_content) {
        console.log('[_tryWithdrawFromContext] Cache HIT!');
        return {
          url,
          cached: true,
          hqcc: hqccData.hqcc_content,
          raw: rawData.intr_content || hqccData.hqcc_content,
          meta: hqccData.meta || {},
        };
      }

      console.log('[_tryWithdrawFromContext] Cache miss');
      return null;
    } catch (error) {
      console.error('[tryWithdrawFromContext] Error:', error);
      return null;
    }
  },

  /**
   * 检查多个 URL 的缓存状态
   */
  async _checkMultipleCache(results: ExaSearchResult[]): Promise<Map<string, CacheResult>> {
    const cacheMap = new Map<string, CacheResult>();
    const urls = results.map((r) => r.url);

    console.log(`[_checkMultipleCache] Batch checking ${urls.length} URLs...`);

    try {
      // Use batch endpoint - 1 request instead of N*2 requests!
      const batchRes = await fetch(`${CONTEXT_API_BASE}/withdraw/batch`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ raw_links: urls, format: 'HQCC' }),
      });

      if (!batchRes.ok) {
        console.warn('[_checkMultipleCache] Batch request failed, status:', batchRes.status);
        // Fallback: mark all as not cached
        results.forEach((r) => {
          cacheMap.set(r.url, { url: r.url, cached: false, hqcc: '', raw: r.text, meta: {} });
        });
        return cacheMap;
      }

      const batchData = await batchRes.json();
      console.log(
        `[_checkMultipleCache] Batch result: ${batchData.summary?.found || 0}/${batchData.summary?.total || urls.length} cached`,
      );

      // Map results from batch response
      const batchResultsMap = new Map<
        string,
        { found: boolean; hqcc_content?: string; meta?: Record<string, unknown> }
      >();
      if (batchData.results && Array.isArray(batchData.results)) {
        batchData.results.forEach(
          (item: { raw_link: string; found: boolean; hqcc_content?: string; meta?: Record<string, unknown> }) => {
            batchResultsMap.set(item.raw_link, item);
          },
        );
      }

      // Build cache results map
      results.forEach((r) => {
        const batchItem = batchResultsMap.get(r.url);
        if (batchItem && batchItem.found && batchItem.hqcc_content) {
          cacheMap.set(r.url, {
            url: r.url,
            cached: true,
            hqcc: batchItem.hqcc_content,
            raw: r.text, // Use original text as fallback
            meta: batchItem.meta || {},
          });
        } else {
          cacheMap.set(r.url, {
            url: r.url,
            cached: false,
            hqcc: '',
            raw: r.text,
            meta: {},
          });
        }
      });

      return cacheMap;
    } catch (error) {
      console.error('[_checkMultipleCache] Batch error:', error);
      // Fallback: mark all as not cached
      results.forEach((r) => {
        cacheMap.set(r.url, { url: r.url, cached: false, hqcc: '', raw: r.text, meta: {} });
      });
      return cacheMap;
    }
  },

  /**
   * 压缩内容
   */
  async _compressContent(
    content: ExaSearchResult,
    strategy: Strategy,
    onStream?: StreamCallback,
  ): Promise<{ hqcc: string; model: string }> {
    let hqcc = '';
    let model = '';

    if (onStream) {
      // Streaming mode
      const compressRes = await fetch('/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.text,
          url: content.url,
          title: content.title,
          strategy: strategy,
          imageLinks: content.imageLinks || [],
          stream: true,
        }),
      });

      if (!compressRes.ok) {
        throw new Error('Content compression failed');
      }

      const reader = compressRes.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.content) {
                  hqcc += data.content;
                  onStream(hqcc, false);
                }
                if (data.done) {
                  model = data.model;
                  onStream(hqcc, true);
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      }
    } else {
      // Non-streaming mode
      const compressRes = await fetch('/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.text,
          url: content.url,
          title: content.title,
          strategy: strategy,
          imageLinks: content.imageLinks || [],
        }),
      });

      if (!compressRes.ok) {
        throw new Error('Content compression failed');
      }

      const compressData: CompressResponse = await compressRes.json();
      hqcc = compressData.hqcc;
      model = compressData.model;
    }

    return { hqcc, model };
  },

  /**
   * 后台存储到 Context Server
   * Only deposits if user is authenticated - skip for anonymous users
   */
  _depositToContext(
    url: string,
    hqcc: string,
    rawContent: string,
    strategy: Strategy,
    model: string,
    imageLinks?: string[],
  ): void {
    // Skip deposit if user is not authenticated
    if (!isAuthenticated()) {
      console.log('[depositToContext] Skipping deposit - user not authenticated');
      return;
    }

    fetch(`${CONTEXT_API_BASE}/deposit`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        raw_link: url,
        hqcc_content: hqcc,
        intr_content: rawContent,
        meta: {
          strategy,
          source: 'playground',
          model,
          image_links: imageLinks || [],
          processed_at: new Date().toISOString(),
        },
      }),
    }).catch((err) => console.error('[depositToContext] Background deposit failed:', err));
  },

  /**
   * 构建缓存命中结果
   */
  _buildCachedResult(cached: CacheResult, url: string, startTime: number): TaskResult {
    const rawSize = calculateSize(cached.raw);
    const hqccSize = calculateSize(cached.hqcc);

    return {
      hqcc: cached.hqcc,
      raw: cached.raw,
      inputType: 'url',
      json: {
        document_id: `doc_${Date.now().toString(36)}`,
        source_url: url,
        extraction_timestamp: new Date().toISOString(),
        processing_time_ms: Date.now() - startTime,
        metadata: {
          ...(cached.meta || {}),
          cache_hit: true,
          input_type: 'url',
          size_metrics: {
            raw_data: { ...rawSize, formatted: rawSize.formatted },
            hqcc: { ...hqccSize, formatted: hqccSize.formatted },
            compression_ratio: this._calcCompressionRatio(rawSize.bytes, hqccSize.bytes),
          },
        },
        content_analysis: {
          word_count: hqccSize.words,
          has_tables: cached.hqcc.includes('|'),
          has_figures: false,
          figure_count: 0,
          table_count: Math.floor((cached.hqcc.match(/\|/g) || []).length / 10),
          citation_count: (cached.hqcc.match(/\[\d+\]/g) || []).length,
        },
        embeddings: { model: 'prismer-embed-v2', dimensions: 1024, vector_preview: null },
        cost: { credits_used: 0, cache_hit: true },
      },
    };
  },

  /**
   * 构建单来源结果（URL 处理）
   */
  _buildSingleSourceResult(
    content: ExaSearchResult,
    hqcc: string,
    model: string,
    url: string,
    strategy: Strategy,
    startTime: number,
  ): TaskResult {
    const rawSize = calculateSize(content.text);
    const hqccSize = calculateSize(hqcc);

    return {
      hqcc,
      raw: content.text,
      inputType: 'url',
      json: {
        document_id: `doc_${Date.now().toString(36)}`,
        source_url: url,
        extraction_timestamp: new Date().toISOString(),
        processing_time_ms: Date.now() - startTime,
        metadata: {
          strategy,
          source: 'exa_get_contents',
          model,
          input_type: 'url',
          title: content.title,
          image_links: content.imageLinks || [],
          size_metrics: {
            raw_data: { ...rawSize, formatted: rawSize.formatted },
            hqcc: { ...hqccSize, formatted: hqccSize.formatted },
            compression_ratio: this._calcCompressionRatio(rawSize.bytes, hqccSize.bytes),
          },
        },
        content_analysis: {
          word_count: hqccSize.words,
          has_tables: hqcc.includes('|'),
          has_figures: (content.imageLinks || []).length > 0,
          figure_count: (content.imageLinks || []).length,
          table_count: Math.floor((hqcc.match(/\|/g) || []).length / 10),
          citation_count: (hqcc.match(/\[\d+\]/g) || []).length,
        },
        embeddings: { model: 'prismer-embed-v2', dimensions: 1024, vector_preview: null },
        cost: {
          credits_used: hqcc.length > 0 ? (hqcc.split(/\s+/).length / 750) * 0.01 : 0.05,
          cache_hit: false,
        },
      },
    };
  },

  /**
   * 构建多来源结果（Query 处理）
   */
  _buildMultiSourceResult(
    topResults: ExaSearchResult[],
    cacheMap: Map<string, CacheResult>,
    hqcc: string,
    compressModel: string,
    query: string,
    strategy: Strategy,
    startTime: number,
    usedCache: boolean,
    totalSearchResults: number,
  ): TaskResult {
    const primary = topResults[0];
    const primaryCache = cacheMap.get(primary.url);

    // Build sources array
    const sources: SourceResult[] = topResults.map((r, i) => {
      const cache = cacheMap.get(r.url);
      const sourceHqcc =
        i === 0
          ? hqcc
          : cache?.cached && cache.hqcc
            ? cache.hqcc
            : `## ${r.title}\n\n**Source URL:** ${r.url}\n\n${r.text.slice(0, 2000)}${r.text.length > 2000 ? '...\n\n*[Content truncated - select this source to compress]*' : ''}`;

      return {
        id: `source_${i}`,
        title: r.title,
        url: r.url,
        hqcc: sourceHqcc,
        raw: cache?.raw || r.text,
        imageLinks: r.imageLinks || [],
        cached: cache?.cached || false,
      };
    });

    const cachedSourceCount = sources.filter((s) => s.cached).length;
    const rawContent = primaryCache?.raw || primary.text;
    const rawSize = calculateSize(rawContent);
    const hqccSize = calculateSize(hqcc);
    const allImageLinks = topResults.flatMap((r) => r.imageLinks || []).slice(0, 10);

    return {
      hqcc,
      raw: rawContent,
      sources,
      activeSourceIndex: 0,
      inputType: 'query',
      json: {
        document_id: `doc_${Date.now().toString(36)}`,
        source_url: query,
        extraction_timestamp: new Date().toISOString(),
        processing_time_ms: Date.now() - startTime,
        metadata: {
          strategy,
          source: usedCache ? 'context_cache' : 'exa_search',
          model: compressModel,
          input_type: 'query',
          search_query: query,
          search_results_count: totalSearchResults,
          sources_found: sources.length,
          sources_cached: cachedSourceCount,
          primary_source: {
            title: primary.title,
            url: primary.url,
            cached: usedCache,
          },
          image_links: allImageLinks,
          size_metrics: {
            raw_data: { ...rawSize, formatted: rawSize.formatted },
            hqcc: { ...hqccSize, formatted: hqccSize.formatted },
            compression_ratio: this._calcCompressionRatio(rawSize.bytes, hqccSize.bytes),
          },
        },
        content_analysis: {
          word_count: hqccSize.words,
          has_tables: hqcc.includes('|'),
          has_figures: allImageLinks.length > 0,
          figure_count: allImageLinks.length,
          table_count: Math.floor((hqcc.match(/\|/g) || []).length / 10),
          citation_count: (hqcc.match(/\[\d+\]/g) || []).length,
        },
        embeddings: { model: 'prismer-embed-v2', dimensions: 1024, vector_preview: null },
        cost: {
          credits_used: usedCache ? 0 : hqcc.length > 0 ? (hqcc.split(/\s+/).length / 750) * 0.01 : 0.05,
          cache_hit: usedCache,
          sources_cache_hits: cachedSourceCount,
        },
      },
    };
  },

  /**
   * 构建无结果响应
   */
  _buildNoResultsResponse(input: string, startTime: number, inputType: 'url' | 'query', reason?: string): TaskResult {
    const message =
      inputType === 'url'
        ? `## No Content Found\n\nUnable to fetch content from **${input}**.\n\n${reason || 'The URL may be inaccessible, require authentication, or contain no extractable text.'}\n\n### Suggestions:\n- Check if the URL is accessible in your browser\n- Try a different URL\n- Use one of the preset examples`
        : `## No Quality Results Found\n\nNo substantial content found for query: **${input}**.\n\n${reason || 'Search returned no results with sufficient content.'}\n\n### Suggestions:\n- Try a more specific search query\n- Use a direct URL instead\n- Use one of the preset examples`;

    return {
      hqcc: message,
      raw: `Input: ${input}\nType: ${inputType}\nStatus: No results\nReason: ${reason || 'Unknown'}`,
      inputType,
      json: {
        document_id: null,
        source_url: input,
        extraction_timestamp: new Date().toISOString(),
        processing_time_ms: Date.now() - startTime,
        metadata: {
          input_type: inputType,
          status: 'no_results',
          reason: reason || 'No content found',
        },
        cost: { credits_used: 0, cache_hit: false },
      },
    };
  },

  /**
   * 计算压缩率
   */
  _calcCompressionRatio(rawBytes: number, hqccBytes: number): string {
    if (rawBytes === 0) return '0%';
    if (hqccBytes <= rawBytes) {
      return ((1 - hqccBytes / rawBytes) * 100).toFixed(2) + '%';
    }
    return '-' + ((hqccBytes / rawBytes - 1) * 100).toFixed(2) + '%';
  },

  // ===== Dashboard Stats =====
  async getDashboardStats(period: string = '7d'): Promise<{
    chartData: ChartData[];
    monthlyRequests: number;
    cacheHitRate: number;
    creditsRemaining: number;
    savings: {
      monthlyTokensInput: number;
      monthlyTokensOutput: number;
      monthlyTokensSaved: number;
      monthlyMoneySaved: number;
    };
  }> {
    const defaultSavings = {
      monthlyTokensInput: 0,
      monthlyTokensOutput: 0,
      monthlyTokensSaved: 0,
      monthlyMoneySaved: 0,
    };
    const defaultStats = {
      chartData: [],
      monthlyRequests: 0,
      cacheHitRate: 0,
      creditsRemaining: 0,
      savings: defaultSavings,
    };

    // Skip if not authenticated
    if (!isAuthenticated()) {
      return defaultStats;
    }

    try {
      const res = await fetch(`/api/dashboard/stats?period=${period}`, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      // Handle auth and backend errors silently
      if (res.status === 401 || res.status === 403 || res.status === 500) {
        return defaultStats;
      }

      const data = await res.json();

      if (!res.ok || !data.success) {
        // Silently fail - backend may not be ready
        return defaultStats;
      }

      // Transform chartData: map 'date' to 'name' for recharts compatibility
      const rawChartData = data.data?.chartData || [];
      const chartData: ChartData[] = rawChartData.map((item: { date?: string; name?: string; requests: number }) => ({
        name: item.date || item.name || '',
        requests: item.requests || 0,
      }));

      return {
        chartData,
        monthlyRequests: data.data?.monthlyRequests || 0,
        cacheHitRate: data.data?.cacheHitRate || 0,
        creditsRemaining: data.data?.creditsRemaining || 0,
        savings: data.data?.savings || defaultSavings,
      };
    } catch (error) {
      // Silently fail
      return defaultStats;
    }
  },

  // ===== API Keys =====
  async getApiKeys(): Promise<ApiKeyData[]> {
    try {
      const res = await fetch('/api/keys', {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        console.error('[API] Failed to fetch API keys:', data);
        return []; // Return empty array on error
      }

      // Transform backend response to frontend format
      return (data.data || []).map((key: any) => ({
        id: key.id,
        key: key.key,
        label: key.label || 'API Key',
        created: key.created
          ? new Date(key.created).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : 'Unknown',
        status: key.status || 'ACTIVE',
      }));
    } catch (error) {
      console.error('[API] Error fetching API keys:', error);
      return [];
    }
  },

  async createApiKey(label?: string): Promise<ApiKeyData> {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ label: label || 'New Key' }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || 'Failed to create API key');
    }

    const key = data.data;
    return {
      id: key.id,
      key: key.key, // This should be the full key from backend
      label: key.label || 'New Key',
      created: key.created
        ? new Date(key.created).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      status: key.status || 'ACTIVE',
    };
  },

  async revokeApiKey(id: string): Promise<void> {
    const res = await fetch(`/api/keys/${id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ action: 'revoke' }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error?.message || 'Failed to revoke API key');
    }
  },

  async deleteApiKey(id: string): Promise<void> {
    const res = await fetch(`/api/keys/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error?.message || 'Failed to delete API key');
    }
  },

  // ===== Payment Methods =====
  async getPaymentMethods(): Promise<PaymentMethod[]> {
    // Skip if not authenticated
    if (!isAuthenticated()) {
      return [];
    }

    try {
      const res = await fetch('/api/billing/payment-methods', {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      // Handle auth and backend errors silently
      if (res.status === 401 || res.status === 403 || res.status === 500) {
        return [];
      }

      const data = await res.json();

      if (!res.ok || !data.success) {
        // Silently fail - backend may not be ready
        return [];
      }

      return data.data || [];
    } catch (error) {
      // Silently fail
      return [];
    }
  },

  /**
   * Add a card payment method
   * Returns SetupIntent client_secret for Stripe.js confirmation
   */
  /**
   * Add a card payment method using Stripe PaymentMethod token
   * @param paymentMethodId - The PaymentMethod ID from Stripe.js (pm_xxx)
   */
  async addCardPaymentMethod(paymentMethodId: string): Promise<PaymentMethod> {
    const res = await fetch('/api/billing/payment-methods', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        type: 'card',
        token: paymentMethodId, // Pass the Stripe PaymentMethod ID as token
      }),
    });

    const data = await res.json();
    console.log('[API] addCardPaymentMethod response:', res.status, data);

    if (!res.ok || !data.success) {
      const errorMsg = data.error?.message || data.error?.msg || data.message || 'Failed to add card';
      console.error('[API] Card setup error:', errorMsg, data);
      throw new Error(errorMsg);
    }

    return data.data;
  },

  /**
   * Add an Alipay payment method
   * Returns redirect URL for Alipay authorization
   */
  async addAlipayPaymentMethod(returnUrl: string): Promise<{
    setup_intent_id: string;
    redirect_url: string;
    client_secret: string;
  }> {
    const res = await fetch('/api/billing/payment-methods', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        type: 'alipay',
        return_url: returnUrl,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || 'Failed to create Alipay setup');
    }

    return data.data;
  },

  /**
   * Confirm Alipay authorization after redirect
   */
  async confirmAlipayPaymentMethod(setupIntentId: string): Promise<PaymentMethod> {
    const res = await fetch('/api/billing/payment-methods/confirm-alipay', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ setup_intent_id: setupIntentId }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || 'Failed to confirm Alipay');
    }

    return data.data;
  },

  /**
   * Legacy method for backward compatibility
   * @deprecated Use addCardPaymentMethod or addAlipayPaymentMethod instead
   */
  async addPaymentMethod(type: 'card' | 'alipay', details: Record<string, unknown>): Promise<PaymentMethod> {
    // This is kept for backward compatibility but should trigger the new flow
    if (type === 'alipay') {
      const returnUrl =
        typeof window !== 'undefined' ? `${window.location.origin}/dashboard#billing` : '/dashboard#billing';
      const result = await this.addAlipayPaymentMethod(returnUrl);
      // For Alipay, we need to redirect - return a placeholder
      // The actual redirect should be handled by the calling code
      return {
        id: result.setup_intent_id,
        type: 'alipay',
        default: false,
        // @ts-expect-error - Adding redirect info for caller
        _redirect_url: result.redirect_url,
        _client_secret: result.client_secret,
      };
    } else {
      // Card flow requires paymentMethodId from Stripe.js
      const paymentMethodId = details.paymentMethodId as string;
      if (!paymentMethodId) {
        throw new Error('Card payment requires paymentMethodId from Stripe.js');
      }
      const result = await this.addCardPaymentMethod(paymentMethodId);
      return {
        id: result.id,
        type: 'card',
        default: result.default || false,
      };
    }
  },

  async removePaymentMethod(id: string): Promise<void> {
    const res = await fetch(`/api/billing/payment-methods/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error?.message || 'Failed to remove payment method');
    }
  },

  async setDefaultPaymentMethod(id: string): Promise<void> {
    const res = await fetch(`/api/billing/payment-methods/${id}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ default: true }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error?.message || 'Failed to set default payment method');
    }
  },

  /**
   * Purchase credits via topup
   */
  async purchaseCredits(
    credits: number,
    priceCents: number,
    paymentMethodId: string,
  ): Promise<{
    paymentId: string;
    paymentIntentId?: string;
    status: string;
    credits?: number;
    requiresAction?: boolean;
    clientSecret?: string;
  }> {
    const res = await fetch('/api/billing/topup', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        amount: priceCents,
        credits: credits,
        paymentMethodId: paymentMethodId,
      }),
    });

    const data = await res.json();
    console.log('[API] purchaseCredits response:', res.status, data);

    if (!res.ok || !data.success) {
      const errorMsg = data.error?.message || data.error?.msg || data.message || 'Failed to purchase credits';
      console.error('[API] Purchase error:', errorMsg, data);
      throw new Error(errorMsg);
    }

    return data.data;
  },

  // ===== Invoices =====
  async getInvoices(): Promise<Invoice[]> {
    try {
      const res = await fetch('/api/billing/invoices', {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      const text = await res.text();
      if (!text) return [];

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return [];
      }

      if (!res.ok || !data.success) {
        console.error('[API] Failed to fetch invoices:', data);
        return [];
      }

      return data.data || [];
    } catch (error) {
      console.error('[API] Error fetching invoices:', error);
      return [];
    }
  },

  // ===== Usage Recording =====
  /**
   * Record usage for billing purposes
   * Called after completing a task (search, compress, etc.)
   */
  async recordUsage(request: UsageRecordRequest): Promise<UsageRecordResponse | null> {
    try {
      // Skip recording if user is not authenticated
      if (!isAuthenticated()) {
        console.log('[API] Skipping usage record - user not authenticated');
        return null;
      }

      const res = await fetch('/api/usage/record', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(request),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        console.error('[API] Failed to record usage:', data);
        return null;
      }

      console.log('[API] Usage recorded:', data.data);
      return data.data;
    } catch (error) {
      console.error('[API] Error recording usage:', error);
      return null;
    }
  },

  /**
   * Generate a unique task ID
   */
  generateTaskId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `task_${timestamp}_${random}`;
  },
};
