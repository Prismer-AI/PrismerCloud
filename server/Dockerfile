FROM node:20-alpine AS base

# 安装依赖
FROM base AS deps
WORKDIR /app

# 添加构建工具
RUN apk add --no-cache libc6-compat

# 复制依赖文件
COPY package.json package-lock.json* ./

# 安装依赖（npm ci requires package-lock.json; use npm install as fallback）
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# 构建应用
FROM base AS builder
WORKDIR /app

# 设置构建优化环境变量
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=4096"

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建参数 - 用于构建时验证（可选）
ARG BUILD_ENV=production
ARG OPENAI_API_KEY=""
ARG OPENAI_API_BASE_URL=""
ARG EXASEARCH_API_KEY=""
ARG DEFAULT_MODEL=""

# 打印构建环境信息
RUN echo "Building for environment: ${BUILD_ENV}"

# 生成 Prisma clients（SQLite for dev, MySQL for prod）
RUN npx prisma generate
RUN npx prisma generate --schema=prisma/schema.mysql.prisma

# 构建 Next.js 应用（服务端环境变量在运行时注入）
RUN npm run build

# Custom server: rename Next.js default → _next_server.js, install our wrapper
# server.prod.js is plain JS — no tsup/compilation needed. It monkey-patches
# http.createServer to intercept the HTTP server Next.js creates via startServer(),
# adding WebSocket (/ws) and SSE (/sse) support on the same port.
RUN mv .next/standalone/server.js .next/standalone/_next_server.js \
 && cp server.prod.js .next/standalone/server.js

# Ensure 'ws' is in standalone node_modules (Next.js trace may not include it
# since only the custom server imports it, not any Next.js route)
RUN cp -r node_modules/ws .next/standalone/node_modules/ws

# 清理不必要的文件
RUN rm -rf node_modules/.cache

# 生产环境
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install Prisma CLI for runtime db push (used by docker-entrypoint.sh)
RUN npm install -g prisma@6

# 创建非 root 用户
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 复制公共资源
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 设置正确的权限
RUN mkdir .next
RUN chown nextjs:nodejs .next

# 复制 standalone 输出
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 复制 Prisma schemas + generated MySQL client（standalone trace 可能不包含）
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# OpenAPI spec — read at runtime by /api/docs/openapi for docs page
COPY --from=builder --chown=nextjs:nodejs /app/docs/openapi.yaml ./docs/openapi.yaml

# Entrypoint script — runs Prisma db push for IM tables then starts server
COPY --from=builder --chown=nextjs:nodejs /app/scripts/docker-entrypoint.sh ./docker-entrypoint.sh

# Seed gene data — read at runtime by EvolutionService via process.cwd()/src/im/data/
COPY --from=builder --chown=nextjs:nodejs /app/src/im/data ./src/im/data

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 运行时环境变量（通过 docker run -e 传入）
# OPENAI_API_KEY, OPENAI_API_BASE_URL, EXASEARCH_API_KEY, DEFAULT_MODEL
# IM_SERVER_ENABLED=true/false, REDIS_URL, JWT_SECRET

# 运行自定义服务器 — HTTP + WebSocket + SSE on same port
# Entrypoint runs Prisma db push (IM tables) then starts Node server
# IM Server 通过 instrumentation.ts 在同一进程启动
CMD ["sh", "docker-entrypoint.sh"]
