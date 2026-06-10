'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Columns2,
  ListTree,
  Loader2,
  Rows3,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Button } from '@/components/ui/button';

import { springSoft } from '../../lib/design';
import { DampedProgressBar } from './asset-loading-indicator';

if (typeof window !== 'undefined') {
  // 2026-05-20 — was `/pdf.worker.min.mjs?v=${pdfjs.version}`; Next.js
  // standalone returns 404 for `.mjs` extension under public/ even though
  // the file is shipped (other extensions like .svg/.png serve fine).
  // `/api/pdf-worker` proxies the same file with explicit Content-Type.
  pdfjs.GlobalWorkerOptions.workerSrc = `/api/pdf-worker?v=${pdfjs.version}`;
}

const MAX_PDF_PREVIEW_PAGES = 24;
// release202/13 §3b④ — PDF range streaming. When the preview is fed a URL
// (not pre-fetched bytes), pdfjs issues HTTP `Range` requests for pages on
// demand instead of one full GET. The byte route `/api/im/assets/:id` honors
// `Range`/206 (assets.ts ~:1719), so the first page renders fast and later
// pages stream in on scroll.
//   - disableStream:false   → allow chunked streaming.
//   - disableAutoFetch:true → don't eagerly pull the whole file after first chunk.
//   - rangeChunkSize:65536  → 64KB range windows.
const PDF_RANGE_CHUNK_SIZE = 65536;
const PDF_OPTIONS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  disableAutoFetch: true,
  disableStream: false,
  rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
};

// pdfjs document source: a `blob:`/`http:` URL string, raw bytes, or — for
// range streaming — a URL + auth headers object that react-pdf forwards to
// pdfjs as `{ url, httpHeaders, withCredentials }`.
type PdfFile = string | { data: Uint8Array } | { url: string; httpHeaders?: Record<string, string> };
type PdfReadingMode = 'single' | 'continuous' | 'double';

interface PdfOutlineItem {
  key: string;
  title: string;
  depth: number;
  pageNumber: number | null;
  url: string | null;
}

interface PdfSearchResult {
  pageNumber: number;
  snippet: string;
}

export function PdfAssetPreview({
  bytes,
  objectUrl,
  rangeSource,
  isDark,
}: {
  bytes: ArrayBuffer | null;
  objectUrl: string | null;
  /**
   * release202/13 §3b④ — range-streaming source. When provided, pdfjs is fed
   * the asset URL + auth headers directly (instead of a pre-fetched whole
   * blob), so it pulls pages via `Range`/206 on demand. Takes precedence over
   * `bytes`; ignored if `objectUrl` is also given (objectUrl wins for callers
   * that still hand over a fully-fetched blob).
   */
  rangeSource?: { url: string; httpHeaders?: Record<string, string> } | null;
  title: string;
  isDark: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [pageNumber, setPageNumber] = useState(1);
  const [readingMode, setReadingMode] = useState<PdfReadingMode>('continuous');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setHostWidth(width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Stable identity for the range source so the memos / effects below don't
  // re-trigger on every parent render (the object literal would be new each time).
  const rangeUrl = rangeSource?.url ?? null;
  const rangeHeaderKey = rangeSource?.httpHeaders ? JSON.stringify(rangeSource.httpHeaders) : null;

  const renderFile = useMemo<PdfFile | null>(() => {
    if (objectUrl) return objectUrl;
    if (rangeUrl) return { url: rangeUrl, httpHeaders: rangeSource?.httpHeaders };
    if (bytes) return { data: new Uint8Array(bytes) };
    return null;
    // rangeHeaderKey participates so a header change rebuilds the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, objectUrl, rangeUrl, rangeHeaderKey]);

  // Outline/search runs its own `pdfjs.getDocument`. With range streaming both
  // share the same URL (each opens an independent range-fetching task) — no
  // need to clone bytes. Only the legacy bytes path still copies the buffer.
  const utilityFile = useMemo<PdfFile | null>(() => {
    if (objectUrl) return objectUrl;
    if (rangeUrl) return { url: rangeUrl, httpHeaders: rangeSource?.httpHeaders };
    if (bytes) return { data: new Uint8Array(bytes.slice(0)) };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, objectUrl, rangeUrl, rangeHeaderKey]);

  const {
    outline,
    loadingOutline,
    searchResults,
    searchQuery,
    currentResultIndex,
    searching,
    runSearch,
    clearSearch,
    navigateSearch,
  } = usePdfShellModel({
    pdfFile: utilityFile,
    maxPages: Math.min(numPages || MAX_PDF_PREVIEW_PAGES, MAX_PDF_PREVIEW_PAGES),
    onPageChange: setPageNumber,
  });

  const navigablePages = Math.min(numPages || 0, MAX_PDF_PREVIEW_PAGES);
  const pageWidth = Math.max(320, Math.min(1100, hostWidth - (outlineOpen ? 280 : 32))) * scale;
  const pagesToRender = pageNumbersForMode(readingMode, pageNumber, navigablePages);

  useEffect(() => {
    const page = document.querySelector(`[data-pdf-page="${pageNumber}"]`);
    page?.scrollIntoView({ block: 'nearest' });
  }, [pageNumber, readingMode]);

  useEffect(() => {
    if (!navigablePages) return;
    const step = readingMode === 'double' ? 2 : 1;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const advance = (delta: number) => {
        event.preventDefault();
        setPageNumber((prev) => Math.min(navigablePages, Math.max(1, prev + delta)));
      };
      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
        case 'j':
          advance(step);
          return;
        case 'ArrowLeft':
        case 'PageUp':
        case 'k':
          advance(-step);
          return;
        case 'Home':
          event.preventDefault();
          setPageNumber(1);
          return;
        case 'End':
          event.preventDefault();
          setPageNumber(navigablePages);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigablePages, readingMode]);

  const customTextRenderer = useCallback(
    (textItem: { str: string }) => {
      const needle = searchQuery.trim();
      if (!needle) return textItem.str;
      const haystack = textItem.str;
      const lower = haystack.toLowerCase();
      const target = needle.toLowerCase();
      let cursor = lower.indexOf(target);
      if (cursor < 0) return haystack;
      const out: string[] = [];
      let pos = 0;
      while (cursor >= 0) {
        out.push(escapeHtml(haystack.slice(pos, cursor)));
        out.push(`<mark class="pdf-search-hit">${escapeHtml(haystack.slice(cursor, cursor + needle.length))}</mark>`);
        pos = cursor + needle.length;
        cursor = lower.indexOf(target, pos);
      }
      out.push(escapeHtml(haystack.slice(pos)));
      return out.join('');
    },
    [searchQuery],
  );

  if (!renderFile) return <PdfPreviewEmpty isDark={isDark} label="PDF preview data is missing." />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-pdf">
      <style>{`
        [data-testid="asset-preview-pdf"] mark.pdf-search-hit {
          background: rgba(245, 158, 11, 0.55);
          color: inherit;
          border-radius: 2px;
          padding: 0 1px;
        }
        [data-testid="asset-preview-pdf"] .react-pdf__Page__textContent mark.pdf-search-hit {
          /* react-pdf paints the text layer with transparent fill so the canvas
             beneath shows through; restore visibility of the highlight box. */
          opacity: 1;
        }
      `}</style>
      <div className={`border-b px-4 py-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className={`min-w-0 text-[11px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {numPages ? `${numPages} page${numPages === 1 ? '' : 's'}` : ''}
            {numPages > MAX_PDF_PREVIEW_PAGES ? ` · first ${MAX_PDF_PREVIEW_PAGES}` : ''}
            {error ? ` · ${error}` : ''}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setOutlineOpen((prev) => !prev)}
              aria-label="Toggle PDF outline"
            >
              <ListTree className="h-3.5 w-3.5" />
            </Button>
            <ReadingModeButton
              mode="continuous"
              activeMode={readingMode}
              onSelect={setReadingMode}
              icon={<Rows3 className="h-3.5 w-3.5" />}
            />
            <ReadingModeButton
              mode="single"
              activeMode={readingMode}
              onSelect={setReadingMode}
              icon={<BookOpen className="h-3.5 w-3.5" />}
            />
            <ReadingModeButton
              mode="double"
              activeMode={readingMode}
              onSelect={setReadingMode}
              icon={<Columns2 className="h-3.5 w-3.5" />}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPageNumber((prev) => Math.max(1, prev - 1))}
              disabled={pageNumber <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className={`min-w-16 text-center text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {pageNumber} / {navigablePages || '?'}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPageNumber((prev) => Math.min(navigablePages || prev, prev + 1))}
              disabled={!navigablePages || pageNumber >= navigablePages}
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setScale((prev) => Math.max(0.6, Number((prev - 0.1).toFixed(2))))}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className={`min-w-12 text-center text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {Math.round(scale * 100)}%
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setScale((prev) => Math.min(2, Number((prev + 0.1).toFixed(2))))}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <PdfSearchBar
          key={searchQuery}
          isDark={isDark}
          query={searchQuery}
          searching={searching}
          resultCount={searchResults.length}
          currentResultIndex={currentResultIndex}
          onSearch={runSearch}
          onClear={clearSearch}
          onNavigate={navigateSearch}
        />
      </div>
      <div className="flex min-h-0 flex-1 bg-zinc-100 dark:bg-zinc-950">
        {outlineOpen ? (
          <PdfOutlinePanel
            outline={outline}
            loading={loadingOutline}
            isDark={isDark}
            maxPage={navigablePages}
            onSelectPage={setPageNumber}
          />
        ) : null}
        <div ref={hostRef} className="min-h-0 flex-1 overflow-auto p-4">
          <Document
            file={renderFile}
            options={PDF_OPTIONS}
            loading={<PdfPreviewEmpty isDark={isDark} label="Loading PDF preview..." />}
            error={<PdfPreviewEmpty isDark={isDark} label="PDF preview failed." />}
            onLoadSuccess={({ numPages: nextPages }) => {
              setError(null);
              setNumPages(nextPages);
              const nextLimit = Math.min(nextPages, MAX_PDF_PREVIEW_PAGES);
              setPageNumber((prev) => Math.min(Math.max(1, prev), nextLimit));
            }}
            onLoadError={(err) => {
              setError(err.message);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={springSoft}
              className="mx-auto flex w-full max-w-[1100px] flex-col gap-4"
            >
              {pagesToRender.map((nextPage) => (
                <div
                  key={nextPage}
                  data-pdf-page={nextPage}
                  className={`overflow-hidden rounded-lg border bg-white shadow-xl shadow-black/5 ${
                    isDark ? 'border-white/[0.06]' : 'border-zinc-200'
                  }`}
                >
                  <Page
                    pageNumber={nextPage}
                    width={pageWidth}
                    loading={
                      nextPage === pageNumber ? <PdfPreviewEmpty isDark={isDark} label="Loading page..." /> : null
                    }
                    renderAnnotationLayer
                    renderTextLayer
                    customTextRenderer={customTextRenderer}
                  />
                </div>
              ))}
              {numPages > MAX_PDF_PREVIEW_PAGES ? (
                <p className={`pb-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  Preview limited to the first {MAX_PDF_PREVIEW_PAGES} pages.
                </p>
              ) : null}
            </motion.div>
          </Document>
        </div>
      </div>
    </div>
  );
}

function ReadingModeButton({
  mode,
  activeMode,
  icon,
  onSelect,
}: {
  mode: PdfReadingMode;
  activeMode: PdfReadingMode;
  icon: React.ReactNode;
  onSelect: (mode: PdfReadingMode) => void;
}) {
  return (
    <Button
      type="button"
      variant={activeMode === mode ? 'default' : 'secondary'}
      size="sm"
      onClick={() => onSelect(mode)}
      aria-label={`${mode} reading mode`}
    >
      {icon}
    </Button>
  );
}

function PdfSearchBar({
  isDark,
  query,
  searching,
  resultCount,
  currentResultIndex,
  onSearch,
  onClear,
  onNavigate,
}: {
  isDark: boolean;
  query: string;
  searching: boolean;
  resultCount: number;
  currentResultIndex: number;
  onSearch: (query: string) => void;
  onClear: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
}) {
  const [draft, setDraft] = useState(query);

  return (
    <form
      className={`mt-3 flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 ${
        isDark ? 'border-white/[0.08] bg-white/[0.04]' : 'border-zinc-200 bg-zinc-50'
      }`}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft);
      }}
    >
      <Search className={isDark ? 'h-4 w-4 text-zinc-500' : 'h-4 w-4 text-zinc-400'} />
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${
          isDark ? 'text-zinc-100 placeholder:text-zinc-600' : 'text-zinc-900 placeholder:text-zinc-400'
        }`}
        placeholder="Search PDF"
        aria-label="Search PDF"
      />
      {searching ? <Loader2 className="h-4 w-4 animate-spin text-zinc-500" /> : null}
      {query ? (
        <span className={`min-w-20 text-right text-[11px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {resultCount > 0 ? `${currentResultIndex + 1}/${resultCount}` : '0 results'}
        </span>
      ) : null}
      {query ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onNavigate('prev')}
            disabled={!resultCount}
            aria-label="Previous search result"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onNavigate('next')}
            disabled={!resultCount}
            aria-label="Next search result"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setDraft('');
              onClear();
            }}
            aria-label="Clear PDF search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : null}
    </form>
  );
}

function PdfOutlinePanel({
  outline,
  loading,
  isDark,
  maxPage,
  onSelectPage,
}: {
  outline: PdfOutlineItem[];
  loading: boolean;
  isDark: boolean;
  maxPage: number;
  onSelectPage: (page: number) => void;
}) {
  return (
    <aside className={`hidden w-72 shrink-0 border-r md:block ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
      <div className="h-full overflow-auto p-3">
        <p className={`mb-2 text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Outline</p>
        {loading ? <PdfPreviewEmpty isDark={isDark} label="Loading outline..." /> : null}
        {!loading && outline.length === 0 ? (
          <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>No outline in this PDF.</p>
        ) : null}
        <div className="space-y-1">
          {outline.map((item) => {
            const disabled = !item.pageNumber || item.pageNumber > maxPage;
            return (
              <button
                key={item.key}
                type="button"
                disabled={disabled}
                onClick={() => item.pageNumber && onSelectPage(item.pageNumber)}
                className={`block w-full rounded-md px-2 py-1.5 text-left text-xs ${
                  disabled
                    ? isDark
                      ? 'text-zinc-600'
                      : 'text-zinc-400'
                    : isDark
                      ? 'text-zinc-300 hover:bg-white/[0.06]'
                      : 'text-zinc-700 hover:bg-white'
                }`}
                style={{ paddingLeft: 8 + item.depth * 12 }}
              >
                <span className="line-clamp-2">{item.title}</span>
                {item.pageNumber ? (
                  <span className="mt-0.5 block text-[10px] opacity-60">p. {item.pageNumber}</span>
                ) : null}
                {!item.pageNumber && item.url ? (
                  <span className="mt-0.5 block text-[10px] opacity-60">external</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function usePdfShellModel({
  pdfFile,
  maxPages,
  onPageChange,
}: {
  pdfFile: PdfFile | null;
  maxPages: number;
  onPageChange: (page: number) => void;
}) {
  const documentRef = useRef<Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null>(null);
  const pageTextCacheRef = useRef<Map<number, string>>(new Map());
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [loadingOutline, setLoadingOutline] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PdfSearchResult[]>([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(0);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!pdfFile) return;
    let cancelled = false;
    // Merge range-streaming + cmap/font options so the outline/search task
    // also pulls by `Range` (string/bytes sources ignore the URL-only fields).
    const loadingTask = pdfjs.getDocument(
      typeof pdfFile === 'string' ? { url: pdfFile, ...PDF_OPTIONS } : { ...pdfFile, ...PDF_OPTIONS },
    );
    documentRef.current = null;
    pageTextCacheRef.current = new Map();
    setOutline([]);
    setLoadingOutline(true);
    setSearchQuery('');
    setSearchResults([]);
    setCurrentResultIndex(0);

    void (async () => {
      try {
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        documentRef.current = pdf;
        const rawOutline = await pdf.getOutline();
        if (cancelled) return;
        setOutline(await flattenPdfOutline(pdf, rawOutline ?? []));
      } catch {
        if (!cancelled) setOutline([]);
      } finally {
        if (!cancelled) setLoadingOutline(false);
      }
    })();

    return () => {
      cancelled = true;
      void loadingTask.destroy();
      documentRef.current = null;
    };
  }, [pdfFile]);

  const runSearch = async (query: string) => {
    const normalized = query.trim();
    setSearchQuery(normalized);
    setCurrentResultIndex(0);
    if (!normalized || !documentRef.current) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const results: PdfSearchResult[] = [];
      const limit = Math.min(maxPages, documentRef.current.numPages);
      for (let page = 1; page <= limit; page += 1) {
        const text = await pageText(documentRef.current, pageTextCacheRef.current, page);
        const lower = text.toLowerCase();
        const needle = normalized.toLowerCase();
        let index = lower.indexOf(needle);
        while (index >= 0 && results.length < 500) {
          results.push({ pageNumber: page, snippet: snippetFor(text, index, normalized.length) });
          index = lower.indexOf(needle, index + needle.length);
        }
      }
      setSearchResults(results);
      if (results[0]) onPageChange(results[0].pageNumber);
    } finally {
      setSearching(false);
    }
  };

  const navigateSearch = (direction: 'prev' | 'next') => {
    if (searchResults.length === 0) return;
    setCurrentResultIndex((prev) => {
      const next =
        direction === 'next' ? (prev + 1) % searchResults.length : prev === 0 ? searchResults.length - 1 : prev - 1;
      const result = searchResults[next];
      if (result) onPageChange(result.pageNumber);
      return next;
    });
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setCurrentResultIndex(0);
  };

  return {
    outline,
    loadingOutline,
    searchResults,
    searchQuery,
    currentResultIndex,
    searching,
    runSearch,
    clearSearch,
    navigateSearch,
  };
}

async function flattenPdfOutline(
  pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>,
  items: Array<{ title?: string; dest?: unknown; url?: string | null; items?: unknown[] }>,
  depth = 0,
  prefix = '',
): Promise<PdfOutlineItem[]> {
  const output: PdfOutlineItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = prefix ? `${prefix}.${index}` : String(index);
    const pageNumber = await outlinePageNumber(pdf, item.dest);
    output.push({
      key,
      title: item.title?.trim() || 'Untitled',
      depth,
      pageNumber,
      url: typeof item.url === 'string' ? item.url : null,
    });
    if (Array.isArray(item.items) && item.items.length > 0) {
      output.push(
        ...(await flattenPdfOutline(
          pdf,
          item.items as Array<{ title?: string; dest?: unknown; url?: string | null; items?: unknown[] }>,
          depth + 1,
          key,
        )),
      );
    }
  }
  return output;
}

async function outlinePageNumber(
  pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>,
  dest: unknown,
): Promise<number | null> {
  try {
    const resolvedDest = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolvedDest) || !resolvedDest[0]) return null;
    const pageIndex = await pdf.getPageIndex(resolvedDest[0]);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

async function pageText(
  pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>,
  cache: Map<number, string>,
  pageNumber: number,
): Promise<string> {
  const cached = cache.get(pageNumber);
  if (cached != null) return cached;
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const text = textContent.items
    .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
    .join(' ');
  cache.set(pageNumber, text);
  return text;
}

function pageNumbersForMode(mode: PdfReadingMode, currentPage: number, maxPage: number): number[] {
  if (!maxPage) return [];
  const safePage = Math.min(Math.max(1, currentPage), maxPage);
  if (mode === 'single') return [safePage];
  if (mode === 'double') return [safePage, safePage + 1].filter((page) => page <= maxPage);
  return Array.from({ length: maxPage }, (_, index) => index + 1);
}

function snippetFor(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function PdfPreviewEmpty({ isDark, label }: { isDark: boolean; label: string }) {
  const isLoading = label.startsWith('Loading');
  return (
    <div
      className={`flex h-full min-h-[160px] flex-col items-center justify-center gap-3 px-4 text-center text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
    >
      {isLoading ? (
        <div className="w-full max-w-[220px]">
          <DampedProgressBar isDark={isDark} percent={null} />
        </div>
      ) : null}
      <span>{label}</span>
    </div>
  );
}
