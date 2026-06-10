'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Database, Loader2 } from 'lucide-react';

import { getWorkspaceToken } from '../../lib/im-api';
import type { AssetDTO } from '../../lib/types';

const QUERY_ROW_CAP = 5_000;
const QUERY_COL_CAP = 128;
const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 36;
const MAX_PRIVATE_BUFFER_BYTES = 512 * 1024 * 1024;
const DUCKDB_LOADED_KEY = 'prismer_duckdb_wasm_loaded_at';

type LoadMode = 'signed-url-range' | 'private-buffer';

interface DuckDBTableModel {
  columns: string[];
  rows: string[][];
  rowCount: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
  loadMode: LoadMode;
  engineVersion: string | null;
}

interface DuckDBProgress {
  label: string;
  detail?: string;
  percent?: number;
}

interface DuckDBTablePreviewProps {
  asset: AssetDTO;
  title: string;
  isDark: boolean;
  signedUrl?: string | null;
}

interface TableRowModel {
  rowNumber: number;
  cells: string[];
}

export function DuckDBTablePreview({ asset, title, isDark, signedUrl }: DuckDBTablePreviewProps) {
  const [progress, setProgress] = useState<DuckDBProgress>(() => ({
    label: hasLoadedDuckDBBefore() ? 'Initializing DuckDB-Wasm...' : 'Loading query engine (~10MB)...',
  }));
  const [model, setModel] = useState<DuckDBTableModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let workerUrl: string | null = null;
    let db: { terminate: () => Promise<void> } | null = null;
    let conn: { close: () => Promise<void> } | null = null;

    const update = (next: DuckDBProgress) => {
      if (!cancelled) setProgress(next);
    };

    async function run() {
      setModel(null);
      setError(null);
      update({
        label: hasLoadedDuckDBBefore() ? 'Initializing DuckDB-Wasm...' : 'Loading query engine (~10MB)...',
      });

      const duckdb = await import('@duckdb/duckdb-wasm');
      update({ label: 'Selecting DuckDB-Wasm bundle...' });
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      if (!bundle.mainWorker) throw new Error('DuckDB-Wasm did not provide a browser worker bundle.');

      workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
      );
      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger();
      const nextDb = new duckdb.AsyncDuckDB(logger, worker);
      db = nextDb;

      await nextDb.instantiate(bundle.mainModule, bundle.pthreadWorker, (instantiation) => {
        const percent =
          instantiation.bytesTotal > 0
            ? Math.round((instantiation.bytesLoaded / instantiation.bytesTotal) * 100)
            : undefined;
        update({
          label: 'Initializing DuckDB-Wasm...',
          detail:
            instantiation.bytesTotal > 0
              ? `${formatBytes(instantiation.bytesLoaded)} / ${formatBytes(instantiation.bytesTotal)}`
              : undefined,
          percent,
        });
      });
      try {
        window.localStorage.setItem(DUCKDB_LOADED_KEY, new Date().toISOString());
      } catch {
        /* non-fatal */
      }

      update({ label: 'Preparing asset bytes...' });
      const fileName = inputFileName(asset);
      let loadMode: LoadMode = 'private-buffer';
      if (signedUrl) {
        await nextDb.registerFileURL(fileName, signedUrl, duckdb.DuckDBDataProtocol.HTTP, false);
        loadMode = 'signed-url-range';
      } else {
        if (asset.sizeBytes != null && asset.sizeBytes > MAX_PRIVATE_BUFFER_BYTES) {
          throw new Error(
            `This private asset is ${formatBytes(asset.sizeBytes)}. DuckDB range mode needs a signed object URL; browser buffer fallback is capped at ${formatBytes(MAX_PRIVATE_BUFFER_BYTES)}.`,
          );
        }
        const token = getWorkspaceToken();
        if (!token) throw new Error('No auth token for DuckDB preview.');
        const res = await fetch(`/api/im/assets/${encodeURIComponent(asset.id)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`DuckDB preview download failed (${res.status}).`);
        const bytes = await readArrayBufferWithProgress(res, (percent, detail) => {
          update({ label: 'Downloading asset bytes...', detail, percent });
        });
        await nextDb.registerFileBuffer(fileName, bytes);
      }

      update({ label: 'Opening analytical query connection...' });
      const nextConn = await nextDb.connect();
      conn = nextConn;
      const tableName = 'asset_rows';
      const isParquet = isParquetAsset(asset);

      if (isParquet) {
        update({ label: 'Querying Parquet sample...', detail: `first ${QUERY_ROW_CAP.toLocaleString()} rows` });
      } else {
        update({ label: 'Detecting CSV schema...', detail: 'parsing in DuckDB worker' });
        await nextConn.insertCSVFromPath(fileName, {
          name: tableName,
          create: true,
          header: true,
          detect: true,
          delimiter: delimiterForAsset(asset),
        });
        update({ label: 'Querying table sample...', detail: `first ${QUERY_ROW_CAP.toLocaleString()} rows` });
      }

      const sql = isParquet
        ? `SELECT * FROM read_parquet('${fileName}') LIMIT ${QUERY_ROW_CAP}`
        : `SELECT * FROM "${tableName}" LIMIT ${QUERY_ROW_CAP}`;
      const result = await nextConn.query(sql);
      const version = await nextDb.getVersion().catch(() => null);
      const nextModel = tableToModel(result, loadMode, version);
      if (!cancelled) {
        setModel(nextModel);
        setProgress({ label: 'Ready' });
      }
    }

    run().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'DuckDB preview failed.');
      }
    });

    return () => {
      cancelled = true;
      abort.abort();
      void conn?.close().catch(() => {});
      void db?.terminate().catch(() => {});
      if (workerUrl) URL.revokeObjectURL(workerUrl);
    };
  }, [asset, signedUrl]);

  if (error) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center p-6 text-center"
        data-testid="asset-preview-duckdb-error"
      >
        <div className="max-w-md">
          <Database className={`mx-auto h-8 w-8 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
          <p className={`mt-3 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            DuckDB preview failed
          </p>
          <p className={`mt-2 text-xs leading-5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{error}</p>
        </div>
      </div>
    );
  }

  if (!model) {
    return <DuckDBLoading progress={progress} title={title} isDark={isDark} signedUrl={signedUrl} />;
  }

  const subtitle = [
    isParquetAsset(asset)
      ? 'Parquet via DuckDB-Wasm'
      : `${delimiterForAsset(asset) === '\t' ? 'TSV' : 'CSV'} via DuckDB-Wasm`,
    model.truncatedRows
      ? `showing first ${QUERY_ROW_CAP.toLocaleString()} rows`
      : `${model.rowCount.toLocaleString()} rows`,
    model.truncatedCols ? `first ${QUERY_COL_CAP} columns` : `${model.columns.length.toLocaleString()} columns`,
    model.loadMode === 'signed-url-range' ? 'signed URL/range path' : 'private buffer path',
  ].join(' · ');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-duckdb">
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{subtitle}</p>
          </div>
          {model.engineVersion ? (
            <span
              className={`shrink-0 rounded-lg border px-2 py-1 text-[10px] font-semibold ${
                isDark ? 'border-white/[0.08] text-zinc-400' : 'border-zinc-200 text-zinc-500'
              }`}
            >
              DuckDB {model.engineVersion}
            </span>
          ) : null}
        </div>
      </div>
      <DuckDBVirtualTable model={model} isDark={isDark} />
    </div>
  );
}

function DuckDBLoading({
  progress,
  title,
  isDark,
  signedUrl,
}: {
  progress: DuckDBProgress;
  title: string;
  isDark: boolean;
  signedUrl?: string | null;
}) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center p-6 text-center"
      data-testid="asset-preview-duckdb-loading"
    >
      <div className="w-full max-w-md">
        <Loader2 className={`mx-auto h-8 w-8 animate-spin ${isDark ? 'text-violet-200' : 'text-violet-700'}`} />
        <p className={`mt-3 truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <p className={`mt-2 text-xs leading-5 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{progress.label}</p>
        {progress.detail ? (
          <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>{progress.detail}</p>
        ) : null}
        <div className={`mt-4 h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-white/[0.08]' : 'bg-zinc-200'}`}>
          {typeof progress.percent === 'number' ? (
            <div
              className={`h-full rounded-full ${isDark ? 'bg-violet-300' : 'bg-violet-600'}`}
              style={{ width: `${Math.min(100, Math.max(8, progress.percent))}%` }}
            />
          ) : (
            <div
              className={`h-full w-1/3 animate-[duckdb-preview-loading_1.1s_ease-in-out_infinite] rounded-full ${
                isDark ? 'bg-violet-300' : 'bg-violet-600'
              }`}
            />
          )}
        </div>
        <style>{`
          @keyframes duckdb-preview-loading {
            0% { transform: translateX(-120%); }
            100% { transform: translateX(320%); }
          }
        `}</style>
        <p className={`mt-3 text-[11px] ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
          {signedUrl
            ? 'Using signed URL mode so DuckDB can issue range reads when the object store allows it.'
            : 'Using private buffer fallback because this asset requires browser Authorization headers.'}
        </p>
      </div>
    </div>
  );
}

function DuckDBVirtualTable({ model, isDark }: { model: DuckDBTableModel; isDark: boolean }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const data = useMemo<TableRowModel[]>(
    () => model.rows.map((cells, index) => ({ rowNumber: index + 1, cells })),
    [model.rows],
  );
  const columns = useMemo<ColumnDef<TableRowModel>[]>(
    () => [
      {
        id: '__rowNumber',
        header: '#',
        cell: ({ row }) => row.original.rowNumber.toLocaleString(),
      },
      ...model.columns.map(
        (column, index): ColumnDef<TableRowModel> => ({
          id: `col_${index}`,
          header: column,
          accessorFn: (row) => row.cells[index] ?? '',
          cell: (info) => String(info.getValue() ?? ''),
        }),
      ),
    ],
    [model.columns],
  );
  // TanStack Table exposes imperative helpers internally; keep the hook scoped to this viewer.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  if (tableRows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
        <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>This table is empty.</span>
      </div>
    );
  }

  const minWidth = 56 + model.columns.length * 150;
  const gridTemplateColumns = `56px repeat(${model.columns.length}, minmax(140px, 1fr))`;
  const cellBorder = isDark ? 'border-white/[0.06]' : 'border-zinc-200';
  const headerBg = isDark ? 'bg-zinc-950 text-zinc-400' : 'bg-zinc-50 text-zinc-600';
  const rowText = isDark ? 'text-zinc-200' : 'text-zinc-800';
  const headerGroup = table.getHeaderGroups()[0];

  return (
    <div ref={parentRef} className={`min-h-0 flex-1 overflow-auto ${isDark ? 'bg-zinc-950' : 'bg-white'}`}>
      <div className="relative" style={{ height: rowVirtualizer.getTotalSize() + HEADER_HEIGHT, minWidth }}>
        <div
          className={`sticky top-0 z-10 grid border-b text-[11px] font-semibold ${headerBg} ${cellBorder}`}
          style={{ gridTemplateColumns, height: HEADER_HEIGHT, minWidth }}
        >
          {headerGroup?.headers.map((header) => (
            <div key={header.id} className={`flex min-w-0 items-center border-r px-3 ${cellBorder}`}>
              <span className="truncate" title={String(header.column.columnDef.header ?? '')}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </span>
            </div>
          ))}
        </div>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const tableRow = tableRows[virtualRow.index];
          if (!tableRow) return null;
          const cells = tableRow.getVisibleCells().slice(1);
          return (
            <div
              key={virtualRow.key}
              className={`absolute left-0 grid border-b text-xs ${rowText} ${cellBorder}`}
              style={{
                gridTemplateColumns,
                height: virtualRow.size,
                minWidth,
                transform: `translateY(${virtualRow.start + HEADER_HEIGHT}px)`,
              }}
            >
              <div
                className={`flex items-center border-r px-3 font-mono text-[11px] ${
                  isDark ? 'bg-white/[0.02] text-zinc-500' : 'bg-zinc-50 text-zinc-500'
                } ${cellBorder}`}
              >
                {tableRow.original.rowNumber.toLocaleString()}
              </div>
              {cells.map((cell) => {
                const value = String(cell.getValue() ?? '');
                return (
                  <div key={cell.id} className={`truncate border-r px-3 py-2 ${cellBorder}`} title={value}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function tableToModel(
  table: {
    schema: { fields: Array<{ name: string }> };
    numRows: number;
    getChild: (name: string) => { get: (index: number) => unknown } | null;
  },
  loadMode: LoadMode,
  engineVersion: string | null,
): DuckDBTableModel {
  const fields = table.schema.fields.slice(0, QUERY_COL_CAP);
  const columns = fields.map((field, index) => field.name || `Column ${index + 1}`);
  const vectors = fields.map((field) => table.getChild(field.name));
  const rowCount = Math.min(table.numRows, QUERY_ROW_CAP);
  const rows: string[][] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    rows.push(vectors.map((vector) => formatValue(vector?.get(rowIndex))));
  }
  return {
    columns,
    rows,
    rowCount: table.numRows,
    truncatedRows: table.numRows >= QUERY_ROW_CAP,
    truncatedCols: table.schema.fields.length > QUERY_COL_CAP,
    loadMode,
    engineVersion,
  };
}

export function isDuckDBPreviewAsset(asset: AssetDTO): boolean {
  if (isParquetAsset(asset)) return true;
  return isDelimitedAsset(asset) && (asset.sizeBytes == null || asset.sizeBytes > 10 * 1024 * 1024);
}

function isDelimitedAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetName(asset);
  return mime.includes('csv') || mime.includes('tab-separated-values') || /\.(csv|tsv)$/i.test(name);
}

function isParquetAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetName(asset);
  return mime.includes('parquet') || /\.(parquet)$/i.test(name);
}

function delimiterForAsset(asset: AssetDTO): ',' | '\t' {
  const mime = asset.mime ?? '';
  const name = assetName(asset);
  return mime.includes('tab-separated-values') || /\.tsv$/i.test(name) ? '\t' : ',';
}

function inputFileName(asset: AssetDTO): string {
  const name = assetName(asset);
  if (/\.parquet$/i.test(name)) return 'asset.parquet';
  if (/\.tsv$/i.test(name) || delimiterForAsset(asset) === '\t') return 'asset.tsv';
  return 'asset.csv';
}

function assetName(asset: AssetDTO): string {
  const title = asset.metadata?.title;
  if (typeof title === 'string' && title.trim()) return title.toLowerCase();
  if (asset.filename?.trim()) return asset.filename.toLowerCase();
  return asset.storageUri.toLowerCase();
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (typeof value === 'object') {
    const maybeToJSON = value as { toJSON?: () => unknown; toString?: () => string };
    if (typeof maybeToJSON.toJSON === 'function') {
      return formatValue(maybeToJSON.toJSON());
    }
    if (typeof maybeToJSON.toString === 'function' && maybeToJSON.toString !== Object.prototype.toString) {
      return maybeToJSON.toString();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0] ?? 'KB';
  for (let index = 0; index < units.length; index += 1) {
    unit = units[index] ?? unit;
    if (value < 1024 || index === units.length - 1) break;
    value /= 1024;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function hasLoadedDuckDBBefore(): boolean {
  try {
    return Boolean(window.localStorage.getItem(DUCKDB_LOADED_KEY));
  } catch {
    return false;
  }
}

async function readArrayBufferWithProgress(
  response: Response,
  onProgress: (percent: number | undefined, detail: string | undefined) => void,
): Promise<Uint8Array> {
  const totalBytes = parseContentLength(response.headers.get('content-length'));
  const reader = response.body?.getReader();
  if (!reader) {
    onProgress(undefined, undefined);
    return new Uint8Array(await response.arrayBuffer());
  }

  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  onProgress(totalBytes ? 0 : undefined, totalBytes ? `0 / ${formatBytes(totalBytes)}` : undefined);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = new Uint8Array(value.byteLength);
    chunk.set(value);
    chunks.push(chunk);
    loadedBytes += chunk.byteLength;
    if (totalBytes) {
      onProgress(
        Math.min(100, Math.round((loadedBytes / totalBytes) * 100)),
        `${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`,
      );
    } else {
      onProgress(undefined, formatBytes(loadedBytes));
    }
  }

  const output = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (totalBytes) onProgress(100, `${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`);
  return output;
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
