// WS-A (PP-0) — lifted from Paseo @getpaseo/protocol/messages (AgentAttachment
// discriminated union). Only the attachment schemas transitively needed by
// agent-sdk-types are lifted here; the full 124/130-message union is WS-D's job.
//
// Source (read-only): /Users/prismer/workspace/paseo/packages/protocol/src/messages.ts

import { z } from 'zod';

export const GitHubPrAttachmentSchema = z.object({
  type: z.literal('github_pr'),
  mimeType: z.literal('application/github-pr'),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
});

export const GitHubIssueAttachmentSchema = z.object({
  type: z.literal('github_issue'),
  mimeType: z.literal('application/github-issue'),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
});

export const TextAttachmentSchema = z.object({
  type: z.literal('text'),
  mimeType: z.literal('text/plain'),
  title: z.string().nullable().optional(),
  text: z.string(),
});

export const ReviewAttachmentContextLineSchema = z.object({
  oldLineNumber: z.number().int().positive().nullable(),
  newLineNumber: z.number().int().positive().nullable(),
  type: z.enum(['add', 'remove', 'context']),
  content: z.string(),
});

export const ReviewAttachmentCommentSchema = z.object({
  filePath: z.string(),
  side: z.enum(['old', 'new']),
  lineNumber: z.number().int().positive(),
  body: z.string(),
  context: z.object({
    hunkHeader: z.string(),
    targetLine: ReviewAttachmentContextLineSchema,
    lines: z.array(ReviewAttachmentContextLineSchema),
  }),
});

export const ReviewAttachmentSchema = z.object({
  type: z.literal('review'),
  mimeType: z.literal('application/paseo-review'),
  cwd: z.string(),
  mode: z.enum(['uncommitted', 'base']),
  baseRef: z.string().nullable().optional(),
  comments: z.array(ReviewAttachmentCommentSchema),
});

export const UploadedFileAttachmentSchema = z.object({
  type: z.literal('uploaded_file'),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string(),
});

export const AgentAttachmentSchema = z.discriminatedUnion('type', [
  GitHubPrAttachmentSchema,
  GitHubIssueAttachmentSchema,
  TextAttachmentSchema,
  ReviewAttachmentSchema,
  UploadedFileAttachmentSchema,
]);

export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;
