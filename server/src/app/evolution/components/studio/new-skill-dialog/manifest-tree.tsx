'use client';

/**
 * ManifestTree — release201/24 §Phase1b.
 *
 * Renders a draft's flat `files[]` (path + optional size) as a collapsed
 * directory tree, for the conversational wizard's live preview. The existing
 * lifecycle surfaces only show a flat list (evidence-panel.tsx); a tree reads
 * better once a scenario-1 draft grows scripts/ + references/ subtrees.
 *
 * Pure + presentational — the parent owns data fetching / SSE refresh.
 */

import { FileText, Folder } from 'lucide-react';
import type { DraftFile } from '../types';

interface TreeNode {
  name: string;
  path: string;
  size?: number;
  children: Map<string, TreeNode>;
}

function buildTree(files: DraftFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const f of files) {
    const segments = f.path.split('/').filter(Boolean);
    let node = root;
    segments.forEach((seg, i) => {
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, path: segments.slice(0, i + 1).join('/'), children: new Map() };
        node.children.set(seg, child);
      }
      if (i === segments.length - 1) child.size = f.size;
      node = child;
    });
  }
  return root;
}

function kb(size?: number): string | null {
  if (size == null) return null;
  return `${Math.round(size / 102.4) / 10} KB`;
}

function TreeRow({ node, depth, isDark }: { node: TreeNode; depth: number; isDark: boolean }) {
  const isDir = node.children.size > 0;
  const children = Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0 ? 0 : 1;
    const bDir = b.children.size > 0 ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });
  return (
    <>
      <li
        className={`flex items-center gap-1.5 font-mono text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
        style={{ paddingLeft: depth * 12 }}
      >
        {isDir ? (
          <Folder className={`h-3 w-3 shrink-0 ${isDark ? 'text-violet-300/70' : 'text-violet-500/70'}`} />
        ) : (
          <FileText className="h-3 w-3 shrink-0 opacity-60" />
        )}
        <span className="truncate">{node.name}</span>
        {!isDir && kb(node.size) && (
          <span className={`ml-auto shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{kb(node.size)}</span>
        )}
      </li>
      {children.map((c) => (
        <TreeRow key={c.path} node={c} depth={depth + 1} isDark={isDark} />
      ))}
    </>
  );
}

export function ManifestTree({ isDark, files }: { isDark: boolean; files: DraftFile[] }) {
  if (!files || files.length === 0) return null;
  const root = buildTree(files);
  const top = Array.from(root.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0 ? 0 : 1;
    const bDir = b.children.size > 0 ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });
  return (
    <ul className="space-y-1" data-testid="wizard-manifest-tree">
      {top.map((n) => (
        <TreeRow key={n.path} node={n} depth={0} isDark={isDark} />
      ))}
    </ul>
  );
}
