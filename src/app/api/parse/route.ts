import { NextRequest, NextResponse } from 'next/server';
import {
  parseUrl,
  parseFile,
  parseBase64,
  calculateParseCost,
  ParseOptions,
  ParseResult,
  ParseMode
} from '@/lib/parser-client';
import {
  generateTaskId,
  createParseUsageRecord,
  recordUsageBackground
} from '@/lib/usage-recorder';
import { deposit } from '@/lib/context-api';
import { apiGuard } from '@/lib/api-guard';

/**
 * POST /api/parse
 *
 * 文档解析 API - 将 PDF/文档转换为结构化内容
 *
 * 支持格式:
 * - PDF 文件
 * - 图片 (OCR)
 * - Office 文档 (Word, Excel, PPT) [预留]
 *
 * 请求方式:
 * 1. 文件上传: multipart/form-data
 * 2. URL 引用: { url: "https://example.com/doc.pdf" }
 * 3. Base64: { base64: "JVBERi0...", filename: "doc.pdf" }
 *
 * 处理模式:
 * - fast: 同步快速解析 (PyMuPDF, ~15页/秒)
 * - hires: 异步高精度 OCR (DeepSeek, ~16页/分钟)
 * - auto: 自动选择
 *
 * 认证: 必需 (API Key 或 JWT) — billable
 */
export async function POST(request: NextRequest) {
  // Auth + balance pre-check
  const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 2 });
  if (!guard.ok) return guard.response;

  const startTime = Date.now();
  const requestId = generateTaskId('parse');
  const authHeader = guard.auth.authHeader;

  try {
    // 1. 检测请求类型并解析
    const contentType = request.headers.get('content-type') || '';

    let parseResult: ParseResult;
    let inputDescription: string;

    if (contentType.includes('multipart/form-data')) {
      // 文件上传模式
      const { result, description } = await handleFileUpload(request, requestId);
      parseResult = result;
      inputDescription = description;
    } else if (contentType.includes('application/json')) {
      // JSON 模式 (URL 或 Base64)
      const body = await request.json();
      const { result, description } = await handleJsonInput(body, requestId);
      parseResult = result;
      inputDescription = description;
    } else {
      return NextResponse.json({
        success: false,
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Content-Type must be multipart/form-data or application/json'
        }
      }, { status: 400 });
    }

    // 2. 处理解析结果
    if (!parseResult.success) {
      return NextResponse.json({
        success: false,
        requestId,
        error: parseResult.error
      }, { status: 500 });
    }

    // 3. 构建响应
    const processingTime = Date.now() - startTime;
    const isAsync = !!(parseResult.status && parseResult.status !== 'completed');

    const response = formatResponse(parseResult, requestId, processingTime, isAsync);

    // 4. 记录使用量 (后台异步，不阻塞响应)
    const pageCount = parseResult.total_pages || 0;
    const imageCount = parseResult.images?.length || 0;
    const mode = parseResult.mode || 'fast';

    recordUsageBackground(
      createParseUsageRecord({
        taskId: requestId,
        fileName: inputDescription,
        pageCount,
        imageCount,
        mode: mode as 'fast' | 'hires' | 'auto',
        tokensOutput: parseResult.usage?.output_tokens,
        processingTimeMs: processingTime
      }),
      authHeader
    );

    // 5. Auto-deposit: 将解析结果存入 Context Cache (fire-and-forget)
    // 使用 url#parse_mode=xxx 作为 key，避免不同 mode 之间的缓存污染
    if (parseResult.markdown && inputDescription.startsWith('http') && !isAsync) {
      const userId = guard.auth.userId;
      const depositUrl = `${inputDescription}#parse_mode=${mode}`;
      deposit(
        {
          url: depositUrl,
          hqcc: parseResult.markdown,
          raw: parseResult.text,
          visibility: 'private',
          meta: {
            source: 'parse_api',
            mode,
            originalUrl: inputDescription,
            pageCount,
            imageCount,
            parsed_at: new Date().toISOString()
          }
        },
        authHeader,
        userId
      ).catch(err => console.error('[Parse API] Auto-deposit failed:', err));
    }

    console.log(`[Parse API] Success: ${pageCount} pages, mode=${mode}, async=${isAsync}`);
    return NextResponse.json(response);

  } catch (error) {
    console.error('[Parse API] Error:', error);
    return NextResponse.json({
      success: false,
      requestId,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Failed to process request'
      }
    }, { status: 500 });
  }
}

/**
 * 处理文件上传
 */
async function handleFileUpload(
  request: NextRequest,
  requestId: string
): Promise<{ result: ParseResult; description: string }> {
  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return {
      result: {
        success: false,
        error: { code: 'MISSING_FILE', message: 'file field is required' }
      },
      description: 'unknown'
    };
  }

  // 获取选项
  const options = extractOptionsFromFormData(formData);

  // 读取文件内容
  const buffer = Buffer.from(await file.arrayBuffer());

  console.log(`[Parse API] File upload: ${file.name} (${buffer.length} bytes)`);

  const result = await parseFile(buffer, file.name, options);

  return {
    result,
    description: file.name
  };
}

/**
 * 处理 JSON 输入 (URL 或 Base64)
 * 支持 snake_case 和 camelCase 参数名
 */
async function handleJsonInput(
  body: any,
  requestId: string
): Promise<{ result: ParseResult; description: string }> {
  const { url, base64, filename, ...optionsRaw } = body;

  const options: ParseOptions = {
    mode: optionsRaw.mode,
    output: optionsRaw.output,
    imageMode: optionsRaw.image_mode || optionsRaw.imageMode,
    promptType: optionsRaw.prompt_type || optionsRaw.promptType,
    wait: optionsRaw.wait,
    callbackUrl: optionsRaw.callback_url || optionsRaw.callbackUrl,
    includeDetection: optionsRaw.include_detection
  };

  if (url) {
    // URL 模式
    console.log(`[Parse API] URL mode: ${url}`);
    const result = await parseUrl(url, options);
    return { result, description: url };
  } else if (base64) {
    // Base64 模式
    if (!filename) {
      return {
        result: {
          success: false,
          error: { code: 'MISSING_FILENAME', message: 'filename is required when using base64' }
        },
        description: 'unknown'
      };
    }
    console.log(`[Parse API] Base64 mode: ${filename}`);
    const result = await parseBase64(base64, filename, options);
    return { result, description: filename };
  } else {
    return {
      result: {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Either url or base64 is required' }
      },
      description: 'unknown'
    };
  }
}

/**
 * 从 FormData 提取选项 (支持 snake_case 参数名)
 */
function extractOptionsFromFormData(formData: FormData): ParseOptions {
  return {
    mode: (formData.get('mode') as ParseMode) || undefined,
    output: (formData.get('output') as 'markdown' | 'json') || undefined,
    // 支持 snake_case 和 camelCase
    imageMode: (formData.get('image_mode') || formData.get('imageMode')) as 'embedded' | 's3' || undefined,
    promptType: (formData.get('prompt_type') || formData.get('promptType')) as any || undefined,
    wait: formData.get('wait') === 'true' ? true : (formData.get('wait') === 'false' ? false : undefined),
    callbackUrl: (formData.get('callback_url') || formData.get('callbackUrl')) as string || undefined,
    includeDetection: formData.get('include_detection') === 'true' ? true : undefined
  };
}

/**
 * 格式化响应
 */
function formatResponse(
  parseResult: ParseResult,
  requestId: string,
  processingTime: number,
  isAsync: boolean
) {
  const mode = parseResult.mode || 'fast';
  const pageCount = parseResult.total_pages || 0;
  const imageCount = parseResult.images?.length || 0;
  const cost = calculateParseCost(pageCount, imageCount, mode);

  if (isAsync) {
    // 异步响应 (HiRes 模式)
    return {
      success: true,
      requestId,
      mode,
      async: true,
      taskId: parseResult.task_id,
      status: parseResult.status,
      document: {
        pageCount,
        estimatedTime: pageCount * 3.6 // ~16-17 pages/min ≈ 3.6s/page
      },
      cost,
      endpoints: {
        status: `/api/parse/status/${parseResult.task_id}`,
        result: `/api/parse/result/${parseResult.task_id}`,
        stream: `/api/parse/stream/${parseResult.task_id}`
      },
      processingTime
    };
  } else {
    // 同步响应 (Fast 模式)
    return {
      success: true,
      requestId,
      mode,
      async: false,
      document: {
        markdown: parseResult.markdown,
        text: parseResult.text,
        pageCount,
        metadata: parseResult.metadata,
        images: parseResult.images,
        // Detection 数据 (HiRes 模式可用)
        detections: parseResult.detections,
        detectionSummary: parseResult.detection_summary,
        // v2.5: 双向索引信息
        bidirectionalIndexing: parseResult.bidirectional_indexing
      },
      usage: {
        inputPages: pageCount,
        inputImages: imageCount,
        outputChars: parseResult.usage?.output_chars || 0,
        outputTokens: parseResult.usage?.output_tokens || 0
      },
      cost,
      processingTime
    };
  }
}
