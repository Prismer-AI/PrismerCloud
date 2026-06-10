'use client';

/**
 * §30 Task 42 — Simple mode Step 3 "Upload company materials".
 *
 * Optional document upload between team review (Step 1) and the provisioning
 * loader (now Step 3). The user can drop up to {@link MAX_FILES} files
 * (≤{@link MAX_FILE_SIZE_MB} MB each) which we upload through the workspace
 * asset pipeline; the resulting AssetDTO IDs are kept on the modal shell
 * and forwarded to `use-simple-provisioning` so the group chat gets a
 * trailing "📎 已附上企业材料" message after Welcome.
 *
 * Both actions (跳过 / 继续) advance to Step 3. Upload is best-effort —
 * per-file failures surface inline with a retry affordance and never block
 * the user from moving on.
 *
 * Networking is delegated to `uploadAssetWithDirectFallback` (asset-upload.ts)
 * which handles SHA-256 hashing + direct-upload negotiation + multipart fallback
 * + progress reporting via XHR. We pass `imFetch` so workspace auth is wired
 * the same way as the rest of the workspace page.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { File as FileIcon, FileSpreadsheet, FileText, Image as ImageIcon, Upload, X } from 'lucide-react';

import { imFetch } from '../../lib/im-api';
import { uploadAssetWithDirectFallback, type AssetUploadProgress } from '../../lib/asset-upload';
import type { AssetDTO } from '../../lib/types';
import { radius, s } from '../../lib/design';
import { FooterButton } from './parts';

const ACCEPT_MIME = '.pdf,.docx,.doc,.md,.markdown,.pptx,.ppt,.png,.jpg,.jpeg,.webp,.txt';
const MAX_FILES = 5;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export interface SimpleStepUploadProps {
  isDark: boolean;
  workspaceId: string;
  uploadedAssetIds: string[];
  onAssetUploaded: (asset: AssetDTO) => void;
  onAssetRemoved: (assetId: string) => void;
  onSkip: () => void;
  onContinue: () => void;
}

interface PendingUpload {
  /** Stable local id so React lists stay keyed across status transitions. */
  localId: string;
  file: File;
  status: 'uploading' | 'success' | 'error';
  progress: AssetUploadProgress | null;
  assetId?: string;
  errorMessage?: string;
}

let pendingCounter = 0;
function nextLocalId(): string {
  pendingCounter += 1;
  return `pending-${Date.now()}-${pendingCounter}`;
}

function iconForFile(file: File) {
  const m = (file.type || '').toLowerCase();
  if (m.startsWith('image/')) return ImageIcon;
  if (m.includes('spreadsheet') || file.name.endsWith('.xlsx') || file.name.endsWith('.csv')) return FileSpreadsheet;
  if (m.includes('pdf') || m.includes('text') || m.includes('word') || m.includes('markdown')) return FileText;
  return FileIcon;
}

function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SimpleStepUpload(props: SimpleStepUploadProps) {
  const { isDark, workspaceId, uploadedAssetIds, onAssetUploaded, onAssetRemoved, onSkip, onContinue } = props;
  const theme = isDark ? 'dark' : 'light';

  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [uploaded, setUploaded] = useState<AssetDTO[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Total slots used: confirmed uploads + in-flight (excluding failed, which the
  // user must explicitly retry or discard).
  const inFlightCount = useMemo(
    () => pending.filter((p) => p.status === 'uploading').length,
    [pending],
  );
  const totalUsed = uploaded.length + inFlightCount;
  const remainingSlots = Math.max(0, MAX_FILES - totalUsed);

  const updatePending = useCallback((localId: string, patch: Partial<PendingUpload>) => {
    setPending((prev) => prev.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  }, []);

  const removePending = useCallback((localId: string) => {
    setPending((prev) => prev.filter((row) => row.localId !== localId));
  }, []);

  const beginUpload = useCallback(
    async (entry: PendingUpload) => {
      try {
        const res = await uploadAssetWithDirectFallback({
          file: entry.file,
          workspaceId,
          metadata: { title: entry.file.name, source: 'simple_mode_company_materials' },
          imFetch,
          onProgress: (progress) => updatePending(entry.localId, { progress }),
        });
        if (!res.ok) {
          updatePending(entry.localId, {
            status: 'error',
            errorMessage: res.message || res.error || '上传失败',
          });
          return;
        }
        const asset = res.data;
        updatePending(entry.localId, { status: 'success', assetId: asset.id });
        setUploaded((prev) => [...prev, asset]);
        onAssetUploaded(asset);
        // Drop the pending row once it's been promoted to the uploaded list —
        // keeps the UI from showing the same file twice.
        setTimeout(() => removePending(entry.localId), 300);
      } catch (err) {
        updatePending(entry.localId, {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : '上传失败',
        });
      }
    },
    [workspaceId, updatePending, removePending, onAssetUploaded],
  );

  const acceptFiles = useCallback(
    (incoming: FileList | File[] | null) => {
      if (!incoming) return;
      const arr = Array.from(incoming);
      if (arr.length === 0) return;

      // Slot guard — refuse to start any new uploads if we're already at cap.
      if (remainingSlots === 0) {
        setWarning(`最多支持上传 ${MAX_FILES} 个文件`);
        return;
      }

      const accepted: PendingUpload[] = [];
      const messages: string[] = [];
      const slots = remainingSlots;
      let used = 0;
      for (const file of arr) {
        if (used >= slots) {
          messages.push(`已达到 ${MAX_FILES} 个文件上限,其余文件已忽略`);
          break;
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
          messages.push(`"${file.name}" 超过 ${MAX_FILE_SIZE_MB}MB 上限,已跳过`);
          continue;
        }
        accepted.push({
          localId: nextLocalId(),
          file,
          status: 'uploading',
          progress: null,
        });
        used += 1;
      }
      setWarning(messages.length > 0 ? messages.join('；') : null);
      if (accepted.length === 0) return;
      setPending((prev) => [...prev, ...accepted]);
      for (const entry of accepted) {
        void beginUpload(entry);
      }
    },
    [remainingSlots, beginUpload],
  );

  const onPickFiles = useCallback(() => {
    if (remainingSlots === 0) {
      setWarning(`最多支持上传 ${MAX_FILES} 个文件`);
      return;
    }
    inputRef.current?.click();
  }, [remainingSlots]);

  const onInputChange = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      acceptFiles(ev.currentTarget.files);
      ev.currentTarget.value = '';
    },
    [acceptFiles],
  );

  const onDrop = useCallback(
    (ev: React.DragEvent<HTMLDivElement>) => {
      ev.preventDefault();
      setDragging(false);
      if (ev.dataTransfer?.files) acceptFiles(ev.dataTransfer.files);
    },
    [acceptFiles],
  );

  const onDragOver = useCallback((ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setDragging(false);
  }, []);

  const retry = useCallback(
    (localId: string) => {
      const row = pending.find((p) => p.localId === localId);
      if (!row) return;
      updatePending(localId, { status: 'uploading', errorMessage: undefined, progress: null });
      void beginUpload({ ...row, status: 'uploading', errorMessage: undefined, progress: null });
    },
    [pending, updatePending, beginUpload],
  );

  const removeUploaded = useCallback(
    (assetId: string) => {
      setUploaded((prev) => prev.filter((a) => a.id !== assetId));
      onAssetRemoved(assetId);
    },
    [onAssetRemoved],
  );

  // Keep the visible uploaded set in sync with parent's authoritative list (in
  // case the modal resets state externally between mounts).
  // Note: parent owns the canonical IDs array; we use it to filter our own
  // chip list defensively.
  const visibleUploaded = useMemo(
    () => uploaded.filter((a) => uploadedAssetIds.includes(a.id)),
    [uploaded, uploadedAssetIds],
  );

  return (
    <div className="flex w-full flex-col gap-4 py-2" data-testid="simple-step-upload">
      <header className="space-y-1">
        <h2 className={`text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>上传企业材料</h2>
        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          Agent 会自动用这些文档作为上下文(可选,可跳过)。支持 PDF / Word / Markdown / PPT / 图片,单文件 ≤
          {MAX_FILE_SIZE_MB}MB,最多 {MAX_FILES} 个。
        </p>
      </header>

      {/* ── Dropzone ─────────────────────────────────────────────── */}
      <motion.div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={onPickFiles}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPickFiles();
          }
        }}
        animate={{ scale: dragging ? 1.01 : 1 }}
        transition={{ duration: 0.12 }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed px-6 py-10 text-center ${radius.pane} ${
          dragging
            ? isDark
              ? 'border-violet-400/70 bg-violet-500/[0.06]'
              : 'border-violet-500/70 bg-violet-50'
            : isDark
              ? 'border-white/[0.12] bg-white/[0.02] hover:border-white/[0.2]'
              : 'border-zinc-300 bg-zinc-50 hover:border-zinc-400'
        }`}
        data-testid="simple-step-upload-dropzone"
      >
        <Upload className={`h-6 w-6 ${isDark ? 'text-zinc-300' : 'text-zinc-500'}`} aria-hidden />
        <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
          拖拽文件到此处,或点击选择文件
        </p>
        <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          已使用 {totalUsed} / {MAX_FILES}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_MIME}
          className="hidden"
          onChange={onInputChange}
          data-testid="simple-step-upload-input"
        />
      </motion.div>

      {warning ? (
        <div
          className={`px-3 py-2 text-xs ${radius.button} ${
            isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'
          }`}
          role="status"
        >
          {warning}
        </div>
      ) : null}

      {/* ── Pending uploads (in-flight + failed) ─────────────────── */}
      {pending.length > 0 ? (
        <ul className="space-y-2" data-testid="simple-step-upload-pending-list">
          {pending.map((row) => {
            const Icon = iconForFile(row.file);
            const percent = row.progress?.percent ?? null;
            return (
              <li
                key={row.localId}
                className={`flex items-center gap-3 border px-3 py-2 ${radius.button} ${s(theme, 'card')}`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-xs font-medium ${
                      row.status === 'error'
                        ? isDark
                          ? 'text-rose-300'
                          : 'text-rose-600'
                        : isDark
                          ? 'text-zinc-200'
                          : 'text-zinc-700'
                    }`}
                    title={row.file.name}
                  >
                    {row.file.name}
                  </p>
                  {row.status === 'uploading' ? (
                    <div
                      className={`mt-1 h-1 w-full overflow-hidden ${radius.button} ${
                        isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'
                      }`}
                      aria-hidden
                    >
                      <div
                        className={`h-full ${isDark ? 'bg-violet-400' : 'bg-violet-500'} transition-[width] duration-150`}
                        style={{ width: `${percent ?? 5}%` }}
                      />
                    </div>
                  ) : null}
                  {row.status === 'error' ? (
                    <p className={`mt-1 text-[11px] ${isDark ? 'text-rose-400' : 'text-rose-500'}`}>
                      {row.errorMessage || '上传失败'}
                    </p>
                  ) : null}
                </div>
                {row.status === 'error' ? (
                  <button
                    type="button"
                    onClick={() => retry(row.localId)}
                    className={`shrink-0 px-2 py-1 text-[11px] ${radius.button} ${
                      isDark
                        ? 'bg-white/[0.06] text-zinc-200 hover:bg-white/[0.1]'
                        : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                    }`}
                  >
                    重试
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => removePending(row.localId)}
                  aria-label="移除"
                  className={`shrink-0 inline-flex h-6 w-6 items-center justify-center ${radius.button} ${
                    isDark ? 'text-zinc-400 hover:bg-white/[0.08]' : 'text-zinc-500 hover:bg-zinc-100'
                  }`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* ── Uploaded chips ───────────────────────────────────────── */}
      {visibleUploaded.length > 0 ? (
        <div className="flex flex-wrap gap-2" data-testid="simple-step-upload-uploaded-list">
          {visibleUploaded.map((asset) => {
            const Icon = iconForFile({ name: asset.filename ?? '', type: asset.mime ?? '' } as File);
            const name = asset.filename ?? '附件';
            return (
              <span
                key={asset.id}
                className={`inline-flex items-center gap-2 px-2.5 py-1 text-xs ${radius.button} ${
                  isDark ? 'bg-emerald-500/[0.12] text-emerald-200' : 'bg-emerald-50 text-emerald-700'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="max-w-[16ch] truncate" title={name}>
                  {name}
                </span>
                {asset.sizeBytes ? <span className="opacity-70">· {formatBytes(asset.sizeBytes)}</span> : null}
                <button
                  type="button"
                  onClick={() => removeUploaded(asset.id)}
                  aria-label={`移除 ${name}`}
                  className={`-mr-1 inline-flex h-4 w-4 items-center justify-center ${radius.button} hover:bg-black/[0.06]`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      {/* ── Footer (in-content, since modal footer is hidden on this step) ─ */}
      <div className="mt-2 flex items-center justify-between gap-2 pt-2">
        <FooterButton isDark={isDark} variant="ghost" onClick={onSkip} data-testid="simple-step-upload-skip">
          跳过
        </FooterButton>
        <FooterButton
          isDark={isDark}
          variant="primary"
          onClick={onContinue}
          data-testid="simple-step-upload-continue"
        >
          继续
        </FooterButton>
      </div>
    </div>
  );
}

export default SimpleStepUpload;
