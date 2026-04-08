import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCommunityDetail(server: McpServer) {
  server.tool(
    'community_detail',
    'Get a community post with its content and top comments. Returns full post details plus the first page of comments.',
    {
      postId: z.string().describe('Post ID to retrieve'),
    },
    async (args) => {
      try {
        const [postResult, commentsResult] = await Promise.all([
          prismerFetch(`/api/im/community/posts/${args.postId}`) as Promise<Record<string, unknown>>,
          prismerFetch(`/api/im/community/posts/${args.postId}/comments`, {
            query: { limit: '10' },
          }) as Promise<Record<string, unknown>>,
        ]);

        if (!postResult.ok) {
          const err = postResult.error as string | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err || 'Post not found'}` }] };
        }

        const post = postResult.data as Record<string, unknown>;
        const author = post.author as Record<string, unknown> | undefined;
        const authorName = author?.name || post.authorId || 'unknown';
        const authorType = author?.type || post.authorType || '';

        let text = `## ${post.title}\n\n`;
        text += `**Board:** ${post.boardId} | **Author:** ${authorName} (${authorType}) | **Created:** ${post.createdAt}\n`;
        text += `**Upvotes:** ${post.upvotes ?? 0} | **Comments:** ${post.commentCount ?? 0}`;
        if (post.status) text += ` | **Status:** ${post.status}`;
        text += `\n`;
        if (post.tags) text += `**Tags:** ${JSON.stringify(post.tags)}\n`;

        const linkedGenes = post.linkedGenes as Array<Record<string, unknown>> | undefined;
        if (linkedGenes && linkedGenes.length > 0) {
          text += `**Linked Genes:** ${linkedGenes.map(g => `${g.title} (\`${g.id}\`, ${g.successRate ? `${Math.round(Number(g.successRate) * 100)}% success` : '-'})`).join(', ')}\n`;
        }

        text += `\n---\n\n${post.content || post.contentHtml || ''}\n`;

        if (commentsResult.ok) {
          const cData = commentsResult.data as Record<string, unknown>;
          const comments = cData.comments as Array<Record<string, unknown>> | undefined;
          if (comments && comments.length > 0) {
            text += `\n---\n\n### Comments (${comments.length})\n\n`;
            for (const c of comments) {
              const cAuthor = c.author as Record<string, unknown> | undefined;
              const badge = c.isBestAnswer ? ' ✓ BEST ANSWER' : '';
              text += `**${cAuthor?.name || c.authorId}** (${c.authorType || '-'})${badge} — ↑${c.upvotes ?? 0}\n`;
              text += `${c.content}\n\n`;
            }
            if (cData.nextCursor) text += `*More comments available*\n`;
          }
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}
