/**
 * Context Metadata Extraction
 *
 * Primary: parse ```prismer-meta``` block from LLM output (compress prompt 要求 LLM 附带)
 * Fallback: regex extract headings + code langs from HQCC (for legacy content without meta block)
 *
 * extractMeta() also strips the meta block from HQCC so it doesn't pollute content.
 */

export interface ContentMeta {
  title: string;
  keywords: string[];
}

/** Result includes cleaned HQCC (meta block stripped) */
export interface ExtractionResult extends ContentMeta {
  hqcc: string; // HQCC with prismer-meta block removed
}

const META_BLOCK_RE = /```prismer-meta\s*\n([\s\S]*?)```\s*$/;

/**
 * Extract metadata from HQCC + strip the meta block from content.
 * Returns cleaned HQCC + title + keywords.
 */
export function extractMeta(hqcc: string): ExtractionResult {
  const match = hqcc.match(META_BLOCK_RE);

  if (match) {
    // LLM produced a prismer-meta block — parse it
    const block = match[1];
    const cleanedHqcc = hqcc.replace(META_BLOCK_RE, '').trimEnd();
    return {
      hqcc: cleanedHqcc,
      ...parseMetaBlock(block),
    };
  }

  // Fallback: regex extraction for legacy content
  return {
    hqcc, // no block to strip
    ...fallbackExtract(hqcc),
  };
}

function parseMetaBlock(block: string): ContentMeta {
  let title = '';
  let keywords: string[] = [];

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('title:')) {
      title = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('keywords:')) {
      keywords = trimmed
        .slice(9)
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0);
    }
  }

  return {
    title: title.slice(0, 200) || 'Untitled',
    keywords: keywords.slice(0, 30),
  };
}

function fallbackExtract(hqcc: string): ContentMeta {
  const lines = hqcc.split('\n');

  const h1 = lines.find((l) => /^#\s/.test(l));
  const title = h1
    ? h1.replace(/^#\s*/, '').trim()
    : (lines.find((l) => l.trim().length > 0) || hqcc.slice(0, 100)).trim();

  const headings = lines
    .filter((l) => /^#{1,3}\s/.test(l))
    .map((l) =>
      l
        .replace(/^#+\s*/, '')
        .trim()
        .toLowerCase(),
    );

  const codeLangs = [...hqcc.matchAll(/```(\w+)/g)].map((m) => m[1].toLowerCase());

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of [...headings, ...codeLangs]) {
    const k = item.trim();
    if (k.length >= 2 && !seen.has(k)) {
      seen.add(k);
      keywords.push(k);
    }
  }

  return { title: title.slice(0, 200), keywords: keywords.slice(0, 30) };
}
