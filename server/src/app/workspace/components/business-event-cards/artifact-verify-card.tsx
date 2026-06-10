'use client';

/**
 * Artifact-with-mimetype-verify-chip card (release201/12 §8c row 5).
 *
 * Fires on `task.evidence.attached` with kind=artifact. Shows a thumbnail
 * + the mime type + a chip indicating whether the magic-byte check passed
 * (status reported via payload.mime — when present and non-empty, the chip
 * shows "verified"; otherwise "unknown").
 */

import { FileCheck2, FileQuestion } from 'lucide-react';
import type { TaskEvidencePayload } from '../../lib/business-event-bus';

export interface ArtifactVerifyCardProps {
  isDark: boolean;
  payload: TaskEvidencePayload;
}

export function ArtifactVerifyCard({ isDark, payload }: ArtifactVerifyCardProps) {
  const verified = !!payload.mime && payload.mime !== 'application/octet-stream';
  return (
    <div
      data-testid="biz-card-artifact-verify"
      className={`flex items-start gap-3 rounded-2xl border p-3 text-xs ${
        isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-white/85'
      }`}
    >
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl ${
          isDark ? 'bg-white/[0.04]' : 'bg-zinc-100'
        }`}
      >
        {payload.thumbnailUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={payload.thumbnailUri} alt="evidence" className="h-full w-full object-cover" />
        ) : verified ? (
          <FileCheck2 className={`h-5 w-5 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`} />
        ) : (
          <FileQuestion className={`h-5 w-5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Evidence attached</p>
        <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          task {payload.taskId} · {payload.kind}
        </p>
        <div className="mt-2 inline-flex items-center gap-1">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              verified
                ? isDark
                  ? 'bg-emerald-500/20 text-emerald-100'
                  : 'bg-emerald-100 text-emerald-800'
                : isDark
                  ? 'bg-zinc-700/40 text-zinc-300'
                  : 'bg-zinc-200 text-zinc-700'
            }`}
          >
            {payload.mime ?? 'unknown'} {verified ? '✓' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
