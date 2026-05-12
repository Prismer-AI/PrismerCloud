/**
 * Parser Service Client
 * 
 * 封装与 parser.prismer.dev OCR 服务的通信
 * 
 * 服务能力:
 * - Fast 模式: PyMuPDF CPU 快速解析 (~15页/秒)
 * - HiRes 模式: DeepSeek-OCR GPU 高精度解析 (~16-17页/分钟)
 * 
 * 费用模型:
 * - Fast: 0.01 credits/页
 * - HiRes: 0.1 credits/页, 0.05 credits/图
 */

import { ensureNacosConfig } from './nacos-config';

// ============================================================================
// Types
// ============================================================================

export type ParseMode = 'auto' | 'fast' | 'hires';
export type OutputFormat = 'markdown' | 'json';
export type ImageMode = 'embedded' | 's3';
export type PromptType = 'document' | 'image' | 'free' | 'figure' | 'describe' | 'custom';

// Detection 类型 - OCR 识别的文档元素 (与后端 v2.5 对齐)
export type DetectionType = 
  | 'title'           // 标题
  | 'sub_title'       // 子标题
  | 'text'            // 正文
  | 'image'           // 图片
  | 'image_caption'   // 图片说明
  | 'table'           // 表格
  | 'table_caption'   // 表格说明
  | 'formula'         // 公式
  | 'code'            // 代码块
  | 'list'            // 列表
  | 'header'          // 页眉
  | 'footer';         // 页脚

export interface Detection {
  id: string;                          // 唯一标识 (e.g., "p1_title_0")
  type: DetectionType;                 // 元素类型
  page: number;                        // 所在页码
  bbox: [number, number, number, number]; // 边界框 [x1, y1, x2, y2]
  content?: string;                    // 提取的文本内容 (text/title/table HTML)
  confidence?: number;                 // 置信度 (0-1)
  latex?: string;                      // LaTeX 公式 (formula/equation 类型)
  image_url?: string;                  // 图片 URL (image 类型，需 image_mode=s3)
}

export interface DetectionSummary {
  total_count: number;
  by_type: Record<DetectionType, number>;
}

export interface ParseOptions {
  mode?: ParseMode;
  output?: OutputFormat;
  imageMode?: ImageMode;
  promptType?: PromptType;
  wait?: boolean;                     // 是否等待完成 (false=立即返回异步任务)
  callbackUrl?: string;               // 任务完成后的回调 URL
  includeDetection?: boolean;         // 是否返回 detection 数据
}

export interface ParseResult {
  success: boolean;
  task_id?: string;
  status?: 'pending' | 'preparing' | 'processing' | 'completed' | 'failed';
  mode?: ParseMode;
  total_pages?: number;
  markdown?: string;
  text?: string;
  usage?: {
    credits_used: number;
    input_pages: number;
    input_images: number;
    output_chars: number;
    output_tokens: number;
  };
  metadata?: {
    title?: string;
    author?: string;
    created_at?: string;
    file_type?: string;
  };
  images?: Array<{
    page: number;
    url: string;
    caption?: string;
  }>;
  // Detection 数据 (HiRes 模式)
  detections?: Detection[];
  detection_summary?: DetectionSummary;
  // 双向索引信息 (v2.5)
  bidirectional_indexing?: {
    detection_ids_count: number;
    ref_markers_count: number;
    enabled: boolean;
  };
  processing_time_ms?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface TaskStatus {
  success: boolean;
  task_id: string;
  status: 'pending' | 'preparing' | 'processing' | 'completed' | 'failed';
  progress?: {
    total_pages: number;
    completed_pages: number;
    percent: number;
    pages_per_minute?: number;
    estimated_remaining?: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface TaskResult extends ParseResult {
  cached?: boolean;
}

// ============================================================================
// Parser Client
// ============================================================================

/**
 * 获取 Parser 服务基础 URL
 */
async function getParserBaseUrl(): Promise<string> {
  await ensureNacosConfig();
  return process.env.PARSER_API_URL || 'https://parser.prismer.dev';
}

/**
 * 将前端选项映射为后端 API 参数 (snake_case)
 */
function mapOptionsToBackend(options: ParseOptions): Record<string, string> {
  const params: Record<string, string> = {};
  
  if (options.mode) params.mode = options.mode;
  if (options.output) params.output = options.output;
  if (options.imageMode) params.image_mode = options.imageMode;
  if (options.promptType) params.prompt_type = options.promptType;
  if (options.wait !== undefined) params.wait = String(options.wait);
  if (options.callbackUrl) params.callback_url = options.callbackUrl;
  if (options.includeDetection !== undefined) params.include_detection = String(options.includeDetection);
  
  return params;
}

// CDN Base URL for S3 images
const IMAGE_CDN_BASE = 'https://cdn.prismer.ai/parser';

/**
 * 后端 detection 原始格式
 */
interface BackendDetection {
  id: string;
  label: string;
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  text?: string;
  metadata?: {
    image_path?: string;      // 图片路径 (label=image)
    caption?: string;         // 图片说明
    caption_id?: string;      // 说明关联 ID
    latex?: string;           // LaTeX 公式 (label=formula)
    table_html?: string;      // 表格 HTML (label=table)
  };
}

/**
 * 构建完整图片 URL
 * 如果是相对路径，拼接 CDN base URL + task_id
 */
function buildImageUrl(imagePath: string, taskId: string): string {
  if (!imagePath) return '';
  // 如果已经是完整 URL，直接返回
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }
  // 相对路径，拼接 CDN URL
  return `${IMAGE_CDN_BASE}/${taskId}/${imagePath}`;
}

/**
 * 从后端 JSON 响应中提取 detection 数据和拼接 markdown
 * 
 * 特殊元素处理:
 * - image: 使用 metadata.image_path 生成 ![](url)，拼接 CDN URL
 * - table: content 已经是 HTML <table>，保留原样
 * - equation/formula: content 已经是 LaTeX \[...\]，保留原样
 */
function extractDetectionsAndMarkdown(data: Record<string, unknown>, taskId: string): { 
  detections?: Detection[]; 
  detection_summary?: DetectionSummary;
  markdown?: string;
  images?: Array<{ page: number; url: string; caption?: string }>;
} {
  // 检查是否有 pages 数组（JSON 格式输出）
  const pages = data.pages as Array<{
    page_number: number;
    detections?: BackendDetection[];
    detection_count?: number;
  }> | undefined;
  
  if (!pages || !Array.isArray(pages)) {
    return {};
  }
  
  // 从所有页面提取 detections 并拼接 markdown
  const allDetections: Detection[] = [];
  const byType: Record<string, number> = {};
  const markdownParts: string[] = [];
  const images: Array<{ page: number; url: string; caption?: string }> = [];
  
  for (const page of pages) {
    if (page.detections && Array.isArray(page.detections)) {
      for (const d of page.detections) {
        // 映射后端格式到我们的格式
        const detection: Detection = {
          id: d.id,
          type: d.label as DetectionType,
          page: page.page_number,
          bbox: d.boxes?.[0] ? [d.boxes[0].x1, d.boxes[0].y1, d.boxes[0].x2, d.boxes[0].y2] : [0, 0, 0, 0],
          content: d.text,
        };
        
        // 特殊元素处理
        if (d.label === 'image' && d.metadata?.image_path) {
          // 构建完整图片 URL
          const fullUrl = buildImageUrl(d.metadata.image_path, taskId);
          detection.image_url = fullUrl;
          images.push({
            page: page.page_number,
            url: fullUrl,
            caption: d.metadata.caption
          });
          // 生成图片 markdown
          const imgMd = d.metadata.caption 
            ? `![${d.metadata.caption}](${fullUrl})`
            : `![](${fullUrl})`;
          markdownParts.push(imgMd);
        } else if (d.label === 'formula' && d.metadata?.latex) {
          detection.latex = d.metadata.latex;
          markdownParts.push(d.metadata.latex);
        } else if (d.text) {
          // 普通文本、标题、表格等（text 已是 markdown/HTML）
          markdownParts.push(d.text);
        }
        
        allDetections.push(detection);
        byType[d.label] = (byType[d.label] || 0) + 1;
      }
    }
  }
  
  if (allDetections.length === 0) {
    return {};
  }
  
  return {
    detections: allDetections,
    detection_summary: {
      total_count: (data.total_detections as number) || allDetections.length,
      by_type: byType as Record<DetectionType, number>
    },
    markdown: markdownParts.join('\n\n'),
    images: images.length > 0 ? images : undefined
  };
}

/**
 * 通过 URL 解析文档
 */
export async function parseUrl(
  url: string,
  options: ParseOptions = {}
): Promise<ParseResult> {
  const baseUrl = await getParserBaseUrl();
  
  const body = {
    url,
    ...mapOptionsToBackend(options)
  };
  
  console.log(`[ParserClient] POST ${baseUrl}/parse (URL mode)`);
  console.log(`[ParserClient] Options:`, options);
  
  const response = await fetch(`${baseUrl}/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('[ParserClient] Error:', data);
    return {
      success: false,
      error: {
        code: data.error?.code || 'PARSER_ERROR',
        message: data.error?.message || data.detail || 'Parser service error'
      }
    };
  }
  
  console.log(`[ParserClient] Success: ${data.total_pages} pages, mode=${data.mode}`);
  
  // 映射后端响应字段
  return {
    success: true,
    task_id: data.task_id,
    status: data.status,
    mode: data.mode,
    total_pages: data.total_pages,
    markdown: data.markdown_content,  // 后端使用 markdown_content
    usage: data.usage,
    processing_time_ms: data.processing_time ? Math.round(data.processing_time * 1000) : undefined,
    bidirectional_indexing: data.bidirectional_indexing
  };
}

/**
 * 通过文件上传解析文档
 */
export async function parseFile(
  fileBuffer: Buffer,
  filename: string,
  options: ParseOptions = {}
): Promise<ParseResult> {
  const baseUrl = await getParserBaseUrl();
  
  // 创建 FormData
  const formData = new FormData();
  // 将 Buffer 转换为 Uint8Array 以兼容 Blob
  const uint8Array = new Uint8Array(fileBuffer);
  const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
  formData.append('file', blob, filename);
  
  // 添加选项
  const mappedOptions = mapOptionsToBackend(options);
  Object.entries(mappedOptions).forEach(([key, value]) => {
    formData.append(key, value);
  });
  
  console.log(`[ParserClient] POST ${baseUrl}/parse (File mode: ${filename})`);
  console.log(`[ParserClient] Options:`, options);
  
  const response = await fetch(`${baseUrl}/parse`, {
    method: 'POST',
    body: formData
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('[ParserClient] Error:', data);
    return {
      success: false,
      error: {
        code: data.error?.code || 'PARSER_ERROR',
        message: data.error?.message || data.detail || 'Parser service error'
      }
    };
  }
  
  console.log(`[ParserClient] Success: ${data.total_pages} pages, mode=${data.mode}`);
  
  // 映射后端响应字段
  return {
    success: true,
    task_id: data.task_id,
    status: data.status,
    mode: data.mode,
    total_pages: data.total_pages,
    markdown: data.markdown_content,  // 后端使用 markdown_content
    usage: data.usage,
    processing_time_ms: data.processing_time ? Math.round(data.processing_time * 1000) : undefined,
    bidirectional_indexing: data.bidirectional_indexing
  };
}

/**
 * 通过 Base64 解析文档
 */
export async function parseBase64(
  base64: string,
  filename: string,
  options: ParseOptions = {}
): Promise<ParseResult> {
  const baseUrl = await getParserBaseUrl();
  
  const body = {
    base64,
    filename,
    ...mapOptionsToBackend(options)
  };
  
  console.log(`[ParserClient] POST ${baseUrl}/parse (Base64 mode: ${filename})`);
  console.log(`[ParserClient] Options:`, options);
  
  const response = await fetch(`${baseUrl}/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('[ParserClient] Error:', data);
    return {
      success: false,
      error: {
        code: data.error?.code || 'PARSER_ERROR',
        message: data.error?.message || data.detail || 'Parser service error'
      }
    };
  }
  
  console.log(`[ParserClient] Success: ${data.total_pages} pages, mode=${data.mode}`);
  
  // 映射后端响应字段
  return {
    success: true,
    task_id: data.task_id,
    status: data.status,
    mode: data.mode,
    total_pages: data.total_pages,
    markdown: data.markdown_content,  // 后端使用 markdown_content
    usage: data.usage,
    processing_time_ms: data.processing_time ? Math.round(data.processing_time * 1000) : undefined,
    bidirectional_indexing: data.bidirectional_indexing
  };
}

/**
 * 查询任务状态
 * 后端端点: GET /parse/{taskId}
 */
export async function getTaskStatus(taskId: string): Promise<TaskStatus> {
  const baseUrl = await getParserBaseUrl();
  
  console.log(`[ParserClient] GET ${baseUrl}/parse/${taskId}`);
  
  const response = await fetch(`${baseUrl}/parse/${taskId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('[ParserClient] Status error:', data);
    return {
      success: false,
      task_id: taskId,
      status: 'failed',
      error: {
        code: data.error?.code || 'STATUS_ERROR',
        message: data.error?.message || data.detail || 'Failed to get task status'
      }
    };
  }
  
  // 映射后端响应格式到我们的格式
  return {
    success: true,
    task_id: data.task_id || taskId,
    status: data.status,
    progress: {
      total_pages: data.total_pages,
      completed_pages: data.completed_pages,
      percent: data.page_progress_percent || 0,
      pages_per_minute: data.pages_per_minute,
      estimated_remaining: data.estimated_remaining_seconds
    }
  };
}

/**
 * 获取任务结果
 * 后端端点: GET /parse/{taskId}/result
 */
export async function getTaskResult(
  taskId: string,
  options: { wait?: boolean; output?: OutputFormat; includeDetection?: boolean } = {}
): Promise<TaskResult> {
  const baseUrl = await getParserBaseUrl();
  
  const params = new URLSearchParams();
  if (options.wait !== undefined) params.set('wait', String(options.wait));
  if (options.output) params.set('output', options.output);
  if (options.includeDetection !== undefined) params.set('include_detection', String(options.includeDetection));
  
  const url = `${baseUrl}/parse/${taskId}/result${params.toString() ? '?' + params.toString() : ''}`;
  console.log(`[ParserClient] GET ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('[ParserClient] Result error:', data);
    return {
      success: false,
      error: {
        code: data.error?.code || 'RESULT_ERROR',
        message: data.error?.message || data.detail || 'Failed to get task result'
      }
    };
  }
  
  // 提取 detection 数据（JSON 模式下也会拼接 markdown 和图片列表）
  const { detections, detection_summary, markdown: markdownFromJson, images: imagesFromJson } = extractDetectionsAndMarkdown(data, taskId);
  
  // 映射后端响应格式
  // markdown 优先用后端返回的 markdown_content，如果没有则用 JSON 拼接的
  return {
    success: data.success !== false,
    task_id: taskId,
    status: 'completed',
    mode: data.mode,
    total_pages: data.total_pages,
    markdown: (data.markdown_content as string) || markdownFromJson,
    text: data.text_content,
    usage: data.usage ? {
      credits_used: data.usage.credits_used || 0,
      input_pages: data.usage.input_pages || data.total_pages,
      input_images: data.usage.input_images || 0,
      output_chars: (data.markdown_content as string)?.length || markdownFromJson?.length || 0,
      output_tokens: Math.round(((data.markdown_content as string)?.length || markdownFromJson?.length || 0) / 4)
    } : {
      credits_used: 0,
      input_pages: data.total_pages,
      input_images: 0,
      output_chars: (data.markdown_content as string)?.length || markdownFromJson?.length || 0,
      output_tokens: Math.round(((data.markdown_content as string)?.length || markdownFromJson?.length || 0) / 4)
    },
    images: imagesFromJson || (data.total_images_extracted > 0 ? Array(data.total_images_extracted as number).fill(null).map((_, i) => ({
      page: i + 1,
      url: '',
      caption: undefined
    })) : undefined),
    detections,
    detection_summary,
    // v2.5: 双向索引信息
    bidirectional_indexing: data.bidirectional_indexing as ParseResult['bidirectional_indexing'],
    processing_time_ms: Math.round((data.processing_time || 0) * 1000)
  };
}

/**
 * 创建 SSE 流连接 URL
 * 后端端点: GET /parse/{taskId}/stream
 */
export async function getStreamUrl(taskId: string): Promise<string> {
  const baseUrl = await getParserBaseUrl();
  return `${baseUrl}/parse/${taskId}/stream`;
}

/**
 * 计算解析费用
 */
export function calculateParseCost(
  pageCount: number,
  imageCount: number,
  mode: ParseMode
): { credits: number; breakdown: { pages: number; images: number } } {
  const pageRate = mode === 'hires' ? 0.1 : 0.01;
  const imageRate = mode === 'hires' ? 0.05 : 0;
  
  const pageCost = pageCount * pageRate;
  const imageCost = imageCount * imageRate;
  
  return {
    credits: Math.round((pageCost + imageCost) * 10000) / 10000,
    breakdown: {
      pages: Math.round(pageCost * 10000) / 10000,
      images: Math.round(imageCost * 10000) / 10000
    }
  };
}
