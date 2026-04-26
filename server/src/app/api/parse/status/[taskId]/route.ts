import { NextRequest, NextResponse } from 'next/server';
import { getTaskStatus } from '@/lib/parser-client';
import { apiGuard } from '@/lib/api-guard';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('ParseStatus');

/**
 * GET /api/parse/status/{taskId}
 *
 * 查询异步解析任务的状态
 *
 * 响应:
 * - status: pending | preparing | processing | completed | failed
 * - progress: { totalPages, completedPages, percent, ... }
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const guard = await apiGuard(request, { tier: 'tracked' });
    if (!guard.ok) return guard.response;

    const { taskId } = await params;

    // 查询后端状态
    const status = await getTaskStatus(taskId);

    if (!status.success) {
      return NextResponse.json(
        {
          success: false,
          taskId,
          error: status.error,
        },
        { status: 404 },
      );
    }

    // 格式化响应
    return NextResponse.json({
      success: true,
      taskId: status.task_id,
      status: status.status,
      progress: status.progress
        ? {
            totalPages: status.progress.total_pages,
            completedPages: status.progress.completed_pages,
            percent: status.progress.percent,
            pagesPerMinute: status.progress.pages_per_minute,
            estimatedRemaining: status.progress.estimated_remaining,
          }
        : undefined,
    });
  } catch (error) {
    log.error({ err: error }, 'Parse status error');
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get task status',
        },
      },
      { status: 500 },
    );
  }
}
