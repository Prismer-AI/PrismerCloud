'use client';

import { useState } from 'react';
import { Download, Check, Share2 } from 'lucide-react';
import { glass } from './helpers';
import { Sparkline } from './sparkline';

interface AgentCardData {
  agentId: string;
  agentName: string;
  ownerUsername: string;
  rank: number | null;
  percentile: number | null;
  value: { tokenSaved: number; moneySaved: number; co2Reduced: number; devHoursSaved: number };
  trend: number[];
  badges: string[];
  err: number | null;
}

interface AgentCardProps {
  data: AgentCardData;
  isDark: boolean;
}

export function AgentCard({ data, isDark }: AgentCardProps) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    setExportError(false);
    try {
      const res = await fetch('/api/im/evolution/card/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'agent', id: data.agentId, format: 'png', resolution: '2x' }),
      });
      if (!res.ok) throw new Error('Render failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.agentName}-card.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
      setTimeout(() => setExportError(false), 3000);
    } finally {
      setExporting(false);
    }
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}/evolution/profile/${data.ownerUsername || data.agentId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`rounded-xl p-6 ${glass(isDark, 'elevated')}`}>
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <div className="w-12 h-12 rounded-full bg-violet-500/20 flex items-center justify-center text-violet-400 font-bold text-lg">
          {data.agentName.charAt(0)}
        </div>
        <div className="flex-1">
          <div className={`font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{data.agentName}</div>
          <div className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            by @{data.ownerUsername}
            {data.rank && ` · Rank #${data.rank}`}
            {data.percentile && ` · Top ${(100 - data.percentile).toFixed(0)}%`}
          </div>
        </div>
      </div>

      {/* Value metrics */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className="text-emerald-400 text-xl font-bold tabular-nums">${data.value.moneySaved.toFixed(0)}</div>
          <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Saved</div>
        </div>
        <div>
          <div className="text-blue-400 text-xl font-bold tabular-nums">{data.value.co2Reduced.toFixed(1)} kg</div>
          <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>CO2 Reduced</div>
        </div>
        <div>
          <div className="text-purple-400 text-xl font-bold tabular-nums">
            {data.value.devHoursSaved.toFixed(0)} hrs
          </div>
          <div className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Dev Time</div>
        </div>
      </div>

      {/* Trend sparkline */}
      {data.trend.length >= 2 && (
        <div className="mb-4">
          <div className={`text-xs mb-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            ERR Trend {data.err !== null && `→ ${data.err > 0 ? '+' : ''}${Math.round(data.err * 100)}%`}
          </div>
          <Sparkline data={data.trend} width={320} height={48} />
        </div>
      )}

      {/* Badges */}
      {data.badges.length > 0 && (
        <div className="flex gap-2 mb-4 flex-wrap">
          {data.badges.map((b) => (
            <span
              key={b}
              className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-violet-500/10 text-violet-300' : 'bg-violet-100 text-violet-600'}`}
            >
              {b.replace('_', ' ')}
            </span>
          ))}
        </div>
      )}

      {/* Export actions */}
      <div className={`flex gap-2 pt-3 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 text-white text-sm font-medium hover:shadow-lg hover:shadow-violet-500/25 transition-shadow disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          {exporting ? '导出中...' : exportError ? '导出失败' : '导出名片'}
        </button>
        <button
          onClick={handleCopyLink}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm border ${isDark ? 'border-zinc-700 text-zinc-300 hover:border-zinc-600' : 'border-zinc-300 text-zinc-600 hover:border-zinc-400'}`}
        >
          {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
          {copied ? '已复制' : '分享链接'}
        </button>
      </div>
    </div>
  );
}
