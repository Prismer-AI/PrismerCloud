/**
 * Daemon capability snapshot — what's actually executable inside this
 * container right now. Probed once at daemon startup, cached for the
 * process lifetime. Hermes adapter injects the snapshot into the agent
 * prompt context so the agent picks tools it knows exist.
 *
 * The probe list is intentionally aligned with what
 * `infra/sandbox-image/Dockerfile.daemon` installs (see
 * docs/release201/02-built-in-skill-container-review.md). Extra entries
 * are tolerated because each probe is best-effort and returns `null`
 * on missing binary / module.
 *
 * Why: P1-1 (dispatch-reliability overhaul) — Hermes used to receive a
 * generic "use real libraries" instruction and would hallucinate tools
 * or write text into a `.pdf` extension to satisfy a deliverable.
 * Surfacing the actual capability matrix lets the agent pick a tool
 * it knows is callable instead of guessing.
 */

import { execFileSync } from 'node:child_process';

export interface CapabilitySnapshot {
  os: { distro?: string; arch: string };
  /** Binary name → version string (best-effort) or absolute path, or null when missing. */
  binaries: Record<string, string | null>;
  /** Python distribution name → version, or null. */
  pythonPackages: Record<string, string | null>;
  /** Node package name → version (read from package.json), or null. */
  nodePackages: Record<string, string | null>;
  fonts: { cjk: boolean; common: string[] };
  /** Free-form caps the agent can read as 1-liners. */
  summary: string[];
}

// Probe set chosen to mirror Dockerfile.daemon installs plus a few
// "common companions" that are often present and useful when they are.
const BINARIES_TO_PROBE = [
  'pandoc',
  'wkhtmltopdf',
  'libreoffice',
  'soffice',
  'chromium',
  'chrome',
  'ffmpeg',
  'pdftotext',
  'tesseract',
  'unoconv',
  'imagemagick',
  'convert', // imagemagick binary name
  'file',
  'pnpm',
  'node',
  'python3',
  'hermes',
];

const PYTHON_PACKAGES_TO_PROBE = [
  'reportlab',
  'python-pptx',
  'openpyxl',
  'pandas',
  'matplotlib',
  'pillow',
  'pypdf',
  'pdfplumber',
  'docx',
  'python-docx',
  'weasyprint',
  'playwright',
  'imageio',
];

const NODE_PACKAGES_TO_PROBE = [
  'puppeteer',
  'pdf-lib',
  'sharp',
  'xlsx',
  'docx',
];

function probeBinary(name: string): string | null {
  try {
    // `which` resolves to absolute path; we use it as a quick existence
    // probe so we don't spawn the binary for missing ones.
    const path = execFileSync('which', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
      .toString()
      .trim();
    if (!path) return null;
    try {
      const raw = execFileSync(name, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      }).toString();
      const firstLine = raw.split('\n')[0] ?? '';
      const ver = firstLine.trim().slice(0, 80);
      return ver || path;
    } catch {
      // Binary present but `--version` not supported / non-zero exit.
      // Falling back to the path is still useful — the agent knows the
      // tool exists even if we can't surface a version string.
      return path;
    }
  } catch {
    return null;
  }
}

function probePython(pkg: string): string | null {
  try {
    // importlib.metadata.version is the canonical way to read a package
    // version without importing the package itself (avoids side effects
    // and missing optional native deps for e.g. weasyprint).
    const out = execFileSync(
      'python3',
      [
        '-c',
        `import importlib.metadata as m\ntry:\n  print(m.version("${pkg}"))\nexcept Exception:\n  raise SystemExit(1)\n`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
    )
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function probeNode(pkg: string): string | null {
  try {
    const out = execFileSync(
      'node',
      [
        '-e',
        `try { console.log(require(\`${pkg}/package.json\`).version) } catch(e) { process.exit(1) }`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 },
    )
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

let cached: CapabilitySnapshot | null = null;

export function getCapabilitySnapshot(): CapabilitySnapshot {
  if (cached) return cached;

  const binaries: Record<string, string | null> = {};
  for (const b of BINARIES_TO_PROBE) binaries[b] = probeBinary(b);

  const pythonPackages: Record<string, string | null> = {};
  for (const p of PYTHON_PACKAGES_TO_PROBE) pythonPackages[p] = probePython(p);

  const nodePackages: Record<string, string | null> = {};
  for (const p of NODE_PACKAGES_TO_PROBE) nodePackages[p] = probeNode(p);

  // CJK font probe — `fc-list :lang=zh` would be more precise but is
  // slower; `fc-list` alone is fast enough and the regex below catches
  // Noto Sans/Serif CJK + Source Han Sans, which are what
  // `fonts-noto-cjk` (baked into Dockerfile.daemon) installs.
  let cjk = false;
  let commonFonts: string[] = [];
  try {
    const fonts = execFileSync('fc-list', [], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString();
    cjk =
      /\bNoto\s+(Sans|Serif)\s+CJK\b/i.test(fonts) ||
      /\bSourceHanSans\b/i.test(fonts);
    const m = fonts.match(
      /Noto Sans[^,:]*|Noto Serif[^,:]*|DejaVu Sans|Liberation Sans/g,
    );
    if (m) commonFonts = [...new Set(m.map((s) => s.trim()))].slice(0, 8);
  } catch {
    /* fc-list missing — leave cjk=false so the warning summary triggers */
  }

  const arch = process.arch;
  let distro: string | undefined;
  try {
    // Reading /etc/os-release via `cat` instead of fs.readFile keeps the
    // probe layer pure-execFileSync — easier to mock from tests if/when
    // we add them.
    const release = execFileSync('cat', ['/etc/os-release'], {
      timeout: 800,
    }).toString();
    const id = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
    distro = id?.trim();
  } catch {
    /* not linux / missing file — distro stays undefined */
  }

  const summary: string[] = [];
  // PDF generation
  if (pythonPackages['reportlab']) {
    summary.push(`PDF: reportlab ${pythonPackages['reportlab']}`);
  }
  if (pythonPackages['weasyprint']) {
    summary.push(`PDF: weasyprint ${pythonPackages['weasyprint']}`);
  }
  if (binaries['wkhtmltopdf']) summary.push('PDF: wkhtmltopdf available');
  if (nodePackages['pdf-lib']) {
    summary.push(`PDF: pdf-lib (Node) ${nodePackages['pdf-lib']}`);
  }
  // Doc conversion
  if (binaries['pandoc']) summary.push('Doc convert: pandoc available');
  if (binaries['libreoffice'] || binaries['soffice']) {
    summary.push('Office: libreoffice available (DOCX/XLSX/PPTX convert)');
  }
  // Office-format generation
  if (pythonPackages['python-pptx']) {
    summary.push(`PPTX: python-pptx ${pythonPackages['python-pptx']}`);
  }
  if (pythonPackages['openpyxl']) {
    summary.push(`XLSX: openpyxl ${pythonPackages['openpyxl']}`);
  }
  if (nodePackages['xlsx']) {
    summary.push(`XLSX: xlsx (Node) ${nodePackages['xlsx']}`);
  }
  if (pythonPackages['docx'] || pythonPackages['python-docx']) {
    summary.push(
      `DOCX: python-docx ${pythonPackages['python-docx'] ?? pythonPackages['docx']}`,
    );
  }
  // Media
  if (binaries['ffmpeg']) summary.push('Media: ffmpeg available');
  if (pythonPackages['imageio']) {
    summary.push(`Media: imageio ${pythonPackages['imageio']} (GIF assembly)`);
  }
  if (pythonPackages['pillow']) {
    summary.push(`Image: pillow ${pythonPackages['pillow']}`);
  }
  if (nodePackages['sharp']) summary.push(`Image: sharp ${nodePackages['sharp']}`);
  // Browser automation
  if (pythonPackages['playwright']) {
    summary.push(`Browser: playwright (Python) ${pythonPackages['playwright']}`);
  }
  if (binaries['chromium'] || binaries['chrome']) {
    summary.push('Browser: chromium/chrome binary present');
  }
  if (nodePackages['puppeteer']) {
    summary.push(`Browser: puppeteer (Node) ${nodePackages['puppeteer']}`);
  }
  // OCR / parsing
  if (binaries['tesseract']) summary.push('OCR: tesseract available');
  if (binaries['pdftotext']) summary.push('PDF parse: pdftotext available');
  if (pythonPackages['pypdf']) {
    summary.push(`PDF parse: pypdf ${pythonPackages['pypdf']}`);
  }
  if (pythonPackages['pdfplumber']) {
    summary.push(`PDF parse: pdfplumber ${pythonPackages['pdfplumber']}`);
  }
  // Data
  if (pythonPackages['pandas']) {
    summary.push(`Data: pandas ${pythonPackages['pandas']}`);
  }
  if (pythonPackages['matplotlib']) {
    summary.push(`Plotting: matplotlib ${pythonPackages['matplotlib']}`);
  }
  // Fonts (critical — CJK absence breaks Chinese PDFs silently)
  if (cjk) {
    summary.push('Fonts: CJK present (中文 OK in PDFs)');
  } else {
    summary.push(
      'Fonts: NO CJK detected — Chinese text in PDFs will render as boxes; warn user before generating CJK PDF',
    );
  }

  cached = {
    os: { distro, arch },
    binaries,
    pythonPackages,
    nodePackages,
    fonts: { cjk, common: commonFonts },
    summary,
  };
  return cached;
}

/**
 * Test-only. Clears the per-process cache so a unit test can re-mock
 * execFileSync and re-probe.
 */
export function _resetForTests(): void {
  cached = null;
}
