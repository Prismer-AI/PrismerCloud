'use client';

/**
 * /agent-message-preview — 统一 Agent Message 组件的 throwaway 预览路由。
 *
 * 不污染 /workspace 生产路径（memory feedback_workspace_not_polluted_until_stable）：
 * 重写期 surface 落 root 级独立路由，稳定一个发版周期后再迁回 im-channel.tsx。
 *
 * 内容：
 *   - 左：模拟 session 面板（固定比例 560×640 + 内部 scroll，scroll 容器 ref
 *     传给活态 AgentMessage 做浮动跳转锚点）。filler + human trigger + 活态
 *     AgentMessage（useMockLifecycle 驱动）+ 下方 filler（让它能翻出顶沿）。
 *     顶部 ▶ 重放 + 速度选择 + dark/light 切换。
 *   - 右：静态 4 态展示（running / done / needs-action / failed）。
 *
 * SoT：docs/release201/32 + docs/release201/proto/agent-message.html
 */

import { useMemo, useRef, useState } from 'react';

import { AgentMessage } from '../workspace/components/agent-message/AgentMessage';
import { AgentMessageContainer } from '../workspace/components/agent-message/AgentMessageContainer';
import {
  buildDoneModel,
  buildFailedModel,
  buildHumanModel,
  buildNeedsActionModel,
  buildRunningModel,
  useMockLifecycle,
} from '../workspace/components/agent-message/mock';

// ─── 模拟 session 面板 ────────────────────────────────────────────────────

function FillerMessage({ tag, text, isDark }: { tag: string; text: string; isDark: boolean }) {
  return (
    <div className="msg group">
      <div className="flex gap-2.5">
        <div className="w-7 h-7 rounded-full bg-zinc-700 grid place-items-center text-[11px] text-zinc-200">
          {tag}
        </div>
        <div
          className={`rounded-xl rounded-tl-sm border px-3 py-2 text-[13px] max-w-[78%] ${
            isDark ? 'bg-zinc-900/50 border-white/[0.07] text-zinc-400' : 'bg-zinc-50 border-zinc-200 text-zinc-600'
          }`}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

function LiveSession({ isDark }: { isDark: boolean }) {
  const [speed, setSpeed] = useState(2);
  const { model, playing, replay } = useMockLifecycle({ speed });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const human = useMemo(() => buildHumanModel(), []);

  const fillerBelow = ['产', '市', '研', '运', '法', '财'];

  return (
    <div>
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">
            release201/32 · workspace chat session
          </div>
          <h1 className={`text-lg font-semibold tracking-tight ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            统一 Agent Message · 活态
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className={`text-[11px] rounded-lg px-2 py-1 border ${
              isDark ? 'bg-white/5 border-white/10 text-zinc-200' : 'bg-white border-zinc-200 text-zinc-700'
            }`}
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
          <button
            onClick={replay}
            disabled={playing}
            className="text-[11px] px-2.5 py-1 rounded-lg bg-cyan-500/90 hover:bg-cyan-400 text-zinc-950 font-medium disabled:opacity-50 transition-colors"
          >
            ▶ 重放
          </button>
        </div>
      </div>

      {/* session frame：固定比例 + 内部 scroll，relative 容器供浮动 chip sticky 定位 */}
      <div
        className={`relative rounded-2xl border overflow-hidden ${
          isDark ? 'border-white/[0.08] bg-zinc-950/50' : 'border-zinc-200 bg-white/60'
        }`}
        style={{ backdropFilter: 'blur(20px)' }}
      >
        {/* session top bar */}
        <div
          className={`px-4 py-2.5 border-b flex items-center gap-2 ${
            isDark ? 'border-white/[0.06] bg-zinc-900/40' : 'border-zinc-200 bg-zinc-50'
          }`}
        >
          <span className="text-zinc-500 text-[13px]">#</span>
          <code className="text-[12px] text-zinc-400">xzaxb3p2zyqf</code>
          <span className={`ml-2 text-[13px] font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
            向我介绍 Prismer Cloud 这个产品
          </span>
        </div>

        {/* scrollable message list */}
        <div ref={scrollRef} className="overflow-y-auto px-4 py-4 space-y-5" style={{ height: 640 }}>
          <div className="text-[12px] text-zinc-600 text-center py-1">— 今天 —</div>

          <FillerMessage tag="产" text="大家好，今天对齐下产品介绍的事。" isDark={isDark} />

          {/* human trigger */}
          <AgentMessage model={human} isDark={isDark} />

          {/* 活态 AgentMessage（生命周期驱动 + 浮动锚点） */}
          <AgentMessage model={model} isDark={isDark} scrollContainer={scrollRef} />

          {/* filler below：让活态消息能翻出顶沿 */}
          {fillerBelow.map((t, i) => (
            <FillerMessage key={i} tag={t} text={`收到，等工程师的 PDF 出来我这边补一版。(#${i + 1})`} isDark={isDark} />
          ))}
        </div>
      </div>
      <p className="mt-2 text-[10.5px] text-zinc-600">
        向下滚动让执行中的消息翻出顶部 → 浮动跳转 chip 紧贴 session 上沿出现。
      </p>
    </div>
  );
}

// ─── 静态 4 态展示 ────────────────────────────────────────────────────────

function StaticGallery({ isDark }: { isDark: boolean }) {
  const states = useMemo(
    () => [
      { label: 'running', model: buildRunningModel() },
      { label: 'done', model: buildDoneModel() },
      { label: 'needs-action', model: buildNeedsActionModel() },
      { label: 'failed', model: buildFailedModel() },
    ],
    [],
  );

  return (
    <aside className="space-y-5">
      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">静态 4 态</div>
      {states.map(({ label, model }) => (
        <div key={label}>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">{label}</div>
          <div
            className={`rounded-2xl border p-3 ${
              isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-white/50'
            }`}
          >
            <AgentMessage model={model} isDark={isDark} />
          </div>
        </div>
      ))}
    </aside>
  );
}

// ─── 真实链路 demo：AdapterMessageInput → Container → adapter → AgentMessage ──
//
// 不经 mock 直驱 <AgentMessage>，而是喂结构兼容 im-channel MessageDTO 的
// AdapterMessageInput，走 AgentMessageContainer + adapter.messageToModel 全链路。
// 无 dispatchId → timeline 为空 → 渲染 done 态 reply。验证多模态 ContentBlock
// body + bodyExtras(prismer-links slot) 真实落地。
function RealChainDemo({ isDark }: { isDark: boolean }) {
  const realChainMessage = useMemo(
    () => ({
      id: 'real-chain-1',
      content:
        'PDF 已生成并发送到群里，共 2 页。详见 prismer://asset/asset_8f3。@marketer 有问题随时提。',
      // 多模态 ContentBlock[]：text + file（走 MessageContentBlocks，非纯 markdown）。
      contentBlocks: [
        { kind: 'text', text: 'PDF 已生成并发送到群里，共 2 页。' },
        { kind: 'file', assetId: 'asset_8f3', mediaType: 'application/pdf', filename: 'Prismer_Cloud_产品介绍.pdf' },
      ],
      attachments: [
        { assetId: 'asset_8f3', mime: 'application/pdf', sizeBytes: 82534, filename: 'Prismer_Cloud_产品介绍.pdf' },
      ],
      metadata: {},
      createdAt: new Date().toISOString(),
    }),
    [],
  );

  return (
    <div className="mt-10">
      <div className={`text-[11px] uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        真实链路 · AdapterMessageInput → Container → adapter → AgentMessage（多模态 body + prismer-links slot）
      </div>
      <div
        className={`rounded-2xl border p-5 ${
          isDark ? 'border-white/[0.07] bg-zinc-950/40' : 'border-zinc-200 bg-white/70'
        }`}
        style={{ backdropFilter: 'blur(20px)' }}
      >
        <AgentMessageContainer
          message={realChainMessage}
          conversationId={null}
          dispatchId={null}
          sender={{ id: 'eng-1', name: '工程师', role: 'ENGINEER', isAgent: true, avatarSeed: 'eng-1', avatarEmoji: '👑' }}
          isDark={isDark}
        />
      </div>

      {/* release201/32 §9 — running 挂载路径(runningPlaceholder)。无真实 timeline →
          状态卡进入 running 态(spinner + 呼吸背光),验证执行中挂载点渲染无误。 */}
      <div className={`text-[11px] uppercase tracking-wider mt-6 mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        running 挂载 · runningPlaceholder（执行中、reply 未落地）
      </div>
      <div
        className={`rounded-2xl border p-5 ${isDark ? 'border-white/[0.07] bg-zinc-950/40' : 'border-zinc-200 bg-white/70'}`}
        style={{ backdropFilter: 'blur(20px)' }}
      >
        <AgentMessageContainer
          runningPlaceholder
          message={{ id: 'pending:demo', content: '' }}
          conversationId={null}
          dispatchId={null}
          sender={{ id: 'ceo-1', name: 'CEO', role: 'ORCHESTRATOR', isAgent: true, avatarSeed: 'ceo-1', avatarEmoji: '👑' }}
          isDark={isDark}
        />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function AgentMessagePreviewPage() {
  const [isDark, setIsDark] = useState(true);

  return (
    <div className={isDark ? 'dark' : ''}>
      <div className={`min-h-screen ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
        {/* 背景渐变（dark hero 感，对齐 HTML 稿） */}
        {isDark && (
          <div
            className="fixed inset-0 -z-10"
            style={{
              background:
                'radial-gradient(900px 500px at 12% -5%,rgba(167,139,250,.10),transparent 60%),' +
                'radial-gradient(800px 500px at 95% 8%,rgba(34,211,238,.08),transparent 60%),' +
                'radial-gradient(700px 500px at 50% 115%,rgba(52,211,153,.06),transparent 60%)',
            }}
          />
        )}

        <div className="max-w-[1080px] mx-auto px-6 py-7">
          <div className="flex justify-end mb-3">
            <button
              onClick={() => setIsDark((v) => !v)}
              className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
                isDark
                  ? 'bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10'
                  : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {isDark ? '☀ Light' : '🌙 Dark'}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,560px)_1fr] gap-8 items-start">
            <LiveSession isDark={isDark} />
            <StaticGallery isDark={isDark} />
          </div>

          {/* P1/P2 真实链路验证：AdapterMessageInput → AgentMessageContainer →
              adapter.messageToModel → <AgentMessage>。证明真实数据管线(含多模态
              ContentBlock body + prismer-links slot)端到端渲染,而非 mock 直驱。 */}
          <RealChainDemo isDark={isDark} />
        </div>
      </div>
    </div>
  );
}
