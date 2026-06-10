const MB = 1024 * 1024;

type AgentOutputCategory = 'text' | 'code' | 'visualization' | 'chart-dsl' | 'data' | 'document' | 'image' | 'archive';

interface AgentOutputRule {
  category: AgentOutputCategory;
  maxBytes: number;
  extensions: Set<string>;
  mimeAllowed: (mime: string) => boolean;
}

export type AgentOutputPolicyResult =
  | { ok: true; mime: string; category: AgentOutputCategory; maxBytes: number }
  | { ok: false; reason: string };

// Real executables stay blocked. Office docs (.doc/.docx/.xls/.xlsx/.ppt/.pptx)
// + .zip are now ALLOWED agent deliverables (office-artifacts skill produces
// them) — kept in sync with src/im/services/agent-output-policy.ts (release202/09).
const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.dmg',
  '.pkg',
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.dll',
  '.dylib',
  '.so',
  '.bin',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
]);

const OFFICE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

const RASTER_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.cpp': 'text/x-c++src',
  '.c': 'text/x-csrc',
  '.h': 'text/x-chdr',
  '.sql': 'text/x-sql',
  '.sh': 'text/x-shellscript',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.mmd': 'text/x-mermaid',
  '.puml': 'text/x-plantuml',
  '.dot': 'text/x-graphviz',
  '.csv': 'text/csv',
  // Document outputs — PDF is the canonical "agent generated a report/doc and
  // posted it to the group" deliverable (reportlab etc.). magic-bytes.ts has
  // ALWAYS handled PDF (`%PDF-` → application/pdf, content-vs-declaration
  // check); this name-whitelist was the only layer missing it, which silently
  // rejected every agent PDF at the outbox uploader. release201/30 §4.
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

const RULES: AgentOutputRule[] = [
  {
    category: 'text',
    maxBytes: 20 * MB,
    extensions: new Set(['.md', '.markdown', '.txt']),
    mimeAllowed: (mime) => mime === 'text/markdown' || mime === 'text/plain',
  },
  {
    category: 'code',
    maxBytes: 5 * MB,
    extensions: new Set([
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.go',
      '.rs',
      '.java',
      '.cpp',
      '.c',
      '.h',
      '.sql',
      '.sh',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.html',
      '.htm',
      '.css',
    ]),
    mimeAllowed: (mime) =>
      mime.startsWith('text/x-') ||
      mime === 'text/css' ||
      mime === 'text/html' ||
      mime === 'application/javascript' ||
      mime === 'text/javascript' ||
      mime === 'application/typescript' ||
      mime === 'application/json' ||
      mime === 'application/xml' ||
      mime === 'text/xml' ||
      mime === 'application/yaml' ||
      mime === 'application/x-yaml' ||
      mime === 'application/toml',
  },
  {
    category: 'visualization',
    maxBytes: 5 * MB,
    extensions: new Set(['.svg', '.html', '.htm']),
    mimeAllowed: (mime) => mime === 'image/svg+xml' || mime === 'text/html',
  },
  {
    category: 'chart-dsl',
    maxBytes: 1 * MB,
    extensions: new Set(['.mmd', '.puml', '.dot']),
    mimeAllowed: (mime) => mime === 'text/x-mermaid' || mime === 'text/x-plantuml' || mime === 'text/x-graphviz',
  },
  {
    category: 'data',
    maxBytes: 10 * MB,
    extensions: new Set(['.csv']),
    mimeAllowed: (mime) => mime === 'text/csv',
  },
  {
    category: 'data',
    maxBytes: 5 * MB,
    extensions: new Set(['.json']),
    mimeAllowed: (mime) => mime === 'application/json',
  },
  {
    category: 'document',
    maxBytes: 50 * MB,
    extensions: new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt']),
    mimeAllowed: (mime) => mime === 'application/pdf' || OFFICE_MIMES.has(mime),
  },
  {
    category: 'image',
    maxBytes: 25 * MB,
    extensions: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
    mimeAllowed: (mime) => RASTER_IMAGE_MIMES.has(mime),
  },
  {
    category: 'archive',
    maxBytes: 30 * MB,
    extensions: new Set(['.zip']),
    mimeAllowed: (mime) => mime === 'application/zip' || mime === 'application/x-zip-compressed',
  },
];

export function inferAgentOutputMime(filename: string): string | null {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? null;
}

export function validateAgentOutputAsset(input: {
  filename: string;
  mime?: string | null;
  sizeBytes: number;
}): AgentOutputPolicyResult {
  const ext = extensionOf(input.filename);
  const mime = normalizeMime(input.mime) ?? inferAgentOutputMime(input.filename);
  if (!mime) return { ok: false, reason: 'agent output mime is required or must be inferable from filename' };
  if (!ext) return { ok: false, reason: 'agent output filename must include an allowed extension' };
  if (BLOCKED_EXTENSIONS.has(ext)) return { ok: false, reason: `agent output extension ${ext} is not allowed` };
  if (mime === 'application/octet-stream') return { ok: false, reason: 'agent output MIME application/octet-stream is not allowed' };
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    return { ok: false, reason: `agent output media MIME ${mime} is not allowed` };
  }
  if (mime.startsWith('image/') && mime !== 'image/svg+xml' && !RASTER_IMAGE_MIMES.has(mime)) {
    return { ok: false, reason: `agent output image MIME ${mime} is not allowed; use png/jpeg/gif/webp or SVG` };
  }
  if (input.sizeBytes > 50 * MB) return { ok: false, reason: 'agent output exceeds 50 MB hard limit' };

  const rule = RULES.find((candidate) => candidate.extensions.has(ext) && candidate.mimeAllowed(mime));
  if (!rule) return { ok: false, reason: `agent output ${ext || '(no extension)'} with MIME ${mime} is not allowed` };
  if (input.sizeBytes > rule.maxBytes) {
    return {
      ok: false,
      reason: `agent output ${rule.category} asset exceeds ${Math.round(rule.maxBytes / MB)} MB limit`,
    };
  }
  return { ok: true, mime, category: rule.category, maxBytes: rule.maxBytes };
}

function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const normalized = mime.toLowerCase().split(';')[0]?.trim();
  return normalized || null;
}

function extensionOf(filename: string): string {
  const name = filename.toLowerCase().trim();
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx) : '';
}
