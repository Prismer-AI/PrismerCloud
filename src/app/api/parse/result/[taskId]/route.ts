import { NextRequest, NextResponse } from 'next/server';
import { getTaskResult, calculateParseCost } from '@/lib/parser-client';
import { apiGuard } from '@/lib/api-guard';

/**
 * GET /api/parse/result/{taskId}
 *
 * 获取异步解析任务的结果
 *
 * 默认返回完整数据（markdown + detections + images）
 *
 * Query params:
 * - wait: boolean - 是否等待任务完成 (默认 false)
 *
 * Response:
 * - document.markdown: 完整 markdown 内容
 * - document.detections: 检测元素数组（含 bbox、类型、内容）
 * - document.detectionSummary: 元素类型统计
 * - document.images: 图片列表（含 URL）
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const guard = await apiGuard(request, { tier: 'tracked' });
    if (!guard.ok) return guard.response;

    const { taskId } = await params;
    const { searchParams } = new URL(request.url);
    const wait = searchParams.get('wait') === 'true';

    // 获取结果（默认使用 JSON 格式 + detection，一次返回所有数据）
    const result = await getTaskResult(taskId, { 
      wait, 
      output: 'json',
      includeDetection: true 
    });
    
    if (!result.success) {
      const status = result.status === 'failed' ? 500 : 404;
      return NextResponse.json({
        success: false,
        taskId,
        error: result.error
      }, { status });
    }

    // 如果任务未完成
    if (result.status && result.status !== 'completed') {
      return NextResponse.json({
        success: true,
        taskId,
        status: result.status,
        message: 'Task is still processing. Use wait=true or poll /status endpoint.'
      }, { status: 202 });
    }

    // 格式化响应
    const pageCount = result.total_pages || 0;
    const imageCount = result.images?.length || 0;
    const mode = result.mode || 'hires';
    const cost = calculateParseCost(pageCount, imageCount, mode);

    return NextResponse.json({
      success: true,
      taskId,
      status: 'completed',
      document: {
        // 内容
        markdown: result.markdown,
        text: result.text,
        pageCount,
        // 元数据
        metadata: result.metadata,
        // 图片列表（含 URL）
        images: result.images,
        // 检测数据（含 bbox、类型、内容）
        detections: result.detections,
        detectionSummary: result.detection_summary
      },
      usage: {
        inputPages: pageCount,
        inputImages: imageCount,
        outputChars: result.usage?.output_chars || 0,
        outputTokens: result.usage?.output_tokens || 0
      },
      cost,
      cached: result.cached || false
    });

  } catch (error) {
    console.error('[Parse Result] Error:', error);
    return NextResponse.json({
      success: false,
      error: { 
        code: 'INTERNAL_ERROR', 
        message: 'Failed to get task result' 
      }
    }, { status: 500 });
  }
}
