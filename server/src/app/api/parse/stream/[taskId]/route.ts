import { NextRequest } from 'next/server';
import { getStreamUrl } from '@/lib/parser-client';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('ParseStream');

/**
 * GET /api/parse/stream/{taskId}
 *
 * SSE 实时进度流
 * 转发后端 Parser 服务的 SSE 流
 *
 * 事件类型:
 * - progress: 处理进度更新
 * - page: 单页处理完成
 * - complete: 任务完成
 * - error: 错误
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureNacosConfig();

    const { taskId } = await params;

    // 验证认证
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authorization header is required' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const authResult = await getUserFromAuth(authHeader);
    if (!authResult.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'INVALID_TOKEN', message: authResult.error || 'Invalid token' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 获取后端 SSE URL
    const streamUrl = await getStreamUrl(taskId);
    log.debug({ streamUrl }, 'Connecting to stream');

    // 创建 SSE 响应
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // 连接到后端 SSE
          const response = await fetch(streamUrl, {
            headers: { Accept: 'text/event-stream' },
          });

          if (!response.ok) {
            const errorData = {
              type: 'error',
              data: { code: 'STREAM_ERROR', message: 'Failed to connect to stream' },
            };
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorData)}\n\n`));
            controller.close();
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            controller.close();
            return;
          }

          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              // 发送完成事件
              controller.enqueue(encoder.encode(`event: complete\ndata: {}\n\n`));
              break;
            }

            // 转发数据
            const text = decoder.decode(value, { stream: true });
            controller.enqueue(encoder.encode(text));
          }

          controller.close();
        } catch (error) {
          log.error({ err: error }, 'Stream error');
          const errorData = {
            type: 'error',
            data: { code: 'STREAM_ERROR', message: 'Stream connection failed' },
          };
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorData)}\n\n`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Stream setup error');
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create stream' },
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
