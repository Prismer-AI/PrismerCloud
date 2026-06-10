'use client';

/**
 * icons.tsx — emoji-free tool/step glyphs for the unified Agent Message.
 *
 * release201/32 follow-up: the timeline + status card previously used emoji
 * (🧠 🔍 🌐 📝 …) as step/tool icons. Emoji render inconsistently across
 * platforms and read as toy-like. This module maps tool slugs → monochrome
 * lucide icons (the project's existing SVG icon set), so every step glyph is
 * a real vector that inherits `currentColor` + size.
 *
 * Built local to agent-message/ for now (message-first scope). When the task
 * card adopts the same status-atom vocabulary, lift this into design.ts.
 */

import { createElement } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  Terminal,
  Search,
  Globe,
  FilePen,
  FileText,
  Upload,
  Radio,
  Brain,
  Wrench,
  CheckCircle2,
  Hammer,
  Code2,
  ListTodo,
  Users,
} from 'lucide-react';

/** tool slug → lucide icon. Unknown tool → Wrench (generic action). */
const TOOL_GLYPH: Record<string, LucideIcon> = {
  terminal: Terminal,
  bash: Terminal,
  shell: Terminal,
  search_files: Search,
  grep: Search,
  browser_navigate: Globe,
  fetch: Globe,
  write_file: FilePen,
  edit_file: FilePen,
  read_file: FileText,
  skill_view: FileText,
  asset_upload: Upload,
  broadcast: Radio,
  build: Hammer,
  execute_code: Code2,
  run_code: Code2,
  python: Code2,
  todo: ListTodo,
  delegate_task: Users,
};

/** Resolve the lucide icon for a tool slug. */
function toolGlyph(tool: string | undefined): LucideIcon {
  if (!tool) return Wrench;
  return TOOL_GLYPH[tool] ?? Wrench;
}

/**
 * Stable, module-scope icon components. Rendering a dynamic
 * `const Icon = toolGlyph(t); <Icon/>` inside a component trips
 * `react-hooks/static-components`; resolving via createElement inside these
 * fixed wrappers keeps the JSX-rendered component identity stable.
 */
export function ToolIcon({ tool, ...props }: LucideProps & { tool: string | undefined }) {
  return createElement(toolGlyph(tool), props);
}

export function ReasoningIcon(props: LucideProps) {
  return createElement(Brain, props);
}

export function CompletedIcon(props: LucideProps) {
  return createElement(CheckCircle2, props);
}
