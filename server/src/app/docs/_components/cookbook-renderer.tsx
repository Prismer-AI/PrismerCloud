'use client';

import { useMemo } from 'react';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import { CodeGroup } from './code-group';

interface Props {
  content: string;
}

interface ParsedBlock {
  type: 'markdown' | 'code-group';
  content: string;
  tabs?: { label: string; language: string; code: string }[];
}

function parseContent(raw: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    if (lines[i].trim() === ':::code-group') {
      i++;
      const tabs: { label: string; language: string; code: string }[] = [];
      while (i < lines.length && lines[i].trim() !== ':::') {
        const match = lines[i].match(/^```(\w+)/);
        if (match) {
          const lang = match[1];
          const label =
            lang === 'typescript'
              ? 'TypeScript'
              : lang === 'python'
                ? 'Python'
                : lang === 'go'
                  ? 'Go'
                  : lang === 'bash'
                    ? 'REST'
                    : lang;
          i++;
          const codeLines: string[] = [];
          while (i < lines.length && !lines[i].startsWith('```')) {
            codeLines.push(lines[i]);
            i++;
          }
          tabs.push({ label, language: lang, code: codeLines.join('\n') });
          i++; // skip closing ```
        } else {
          i++;
        }
      }
      if (lines[i]?.trim() === ':::') i++;
      blocks.push({ type: 'code-group', content: '', tabs });
    } else {
      const mdLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== ':::code-group') {
        mdLines.push(lines[i]);
        i++;
      }
      const content = mdLines.join('\n').trim();
      if (content) {
        blocks.push({ type: 'markdown', content });
      }
    }
  }
  return blocks;
}

export function CookbookRenderer({ content }: Props) {
  const blocks = useMemo(() => parseContent(content), [content]);

  return (
    <div className="space-y-6">
      {blocks.map((block, i) => {
        if (block.type === 'code-group' && block.tabs) {
          return <CodeGroup key={i} tabs={block.tabs} />;
        }
        return (
          <div key={i} className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={block.content} />
          </div>
        );
      })}
    </div>
  );
}
