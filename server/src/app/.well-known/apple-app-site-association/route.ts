/**
 * Apple App Site Association — Universal Link 配置
 *
 * GET /.well-known/apple-app-site-association
 *
 * iOS 在 App 安装时抓一次，缓存约 24 小时。
 * 返回 JSON（必须是 application/json，不能 redirect，不能是 HTML）。
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const APP_ID = '548SC8T8AK.Prismer.lumin';

const AASA = {
  applinks: {
    details: [
      {
        appIDs: [APP_ID],
        components: [
          {
            '/': '/u/*',
            comment: 'User profile deep link for Lumin QR friend-add',
          },
        ],
      },
    ],
  },
};

export async function GET() {
  return NextResponse.json(AASA, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
