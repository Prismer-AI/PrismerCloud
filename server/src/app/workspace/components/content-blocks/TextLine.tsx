'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { ContentBlockText } from './types';

/**
 * Plain-text ContentBlock renderer (kind='text').
 *
 * Renders markdown via react-markdown (parity with `MessageBody`'s
 * markdown branch). Sized for inline use inside a message bubble — color
 * is inherited from the parent bubble so it works on both light glass +
 * gradient bubbles.
 *
 * Trimmed long text past 4_000 chars (same threshold as MessageBody) so a
 * runaway model output doesn't blow up the bubble.
 */
export function TextLine({
  block,
  isOwn = false,
  isDark = false,
  className,
}: {
  block: ContentBlockText;
  isOwn?: boolean;
  isDark?: boolean;
  className?: string;
}) {
  const text = block.text ?? '';
  const truncated = text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
  const linkColor = isOwn ? 'text-white underline underline-offset-2' : 'text-violet-500 underline underline-offset-2';
  return (
    <div
      data-testid="content-block-text"
      data-content-kind="text"
      className={
        className ??
        `prose-chat min-w-0 max-w-full break-words text-[15px] leading-relaxed [&_p]:m-0 [&_p+p]:mt-2 [&_ul]:my-1.5 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:pl-5 [&_ol]:list-decimal [&_li]:my-0.5 [&_strong]:font-semibold [&_em]:italic`
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ children, ...props }) {
            return (
              <a {...props} className={linkColor} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          pre({ children, ...props }) {
            return (
              <pre
                className={`my-2 max-w-full overflow-x-auto rounded-lg p-2.5 font-mono text-[12px] leading-relaxed ${
                  isOwn ? 'bg-white/15' : isDark ? 'bg-white/[0.06]' : 'bg-black/[0.05]'
                }`}
                {...props}
              >
                {children}
              </pre>
            );
          },
          code({ className: cn, children, ...props }: { className?: string; children?: React.ReactNode }) {
            const isFenced = typeof cn === 'string' && cn.startsWith('language-');
            if (isFenced) {
              return (
                <code className={cn} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className={`break-all rounded px-1 py-0.5 font-mono text-[13px] ${
                  isOwn ? 'bg-white/15' : isDark ? 'bg-white/[0.08]' : 'bg-black/[0.06]'
                }`}
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {truncated}
      </ReactMarkdown>
    </div>
  );
}
