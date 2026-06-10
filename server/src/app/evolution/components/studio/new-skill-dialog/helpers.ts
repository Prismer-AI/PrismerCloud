/**
 * Pure helpers extracted from new-skill-dialog.tsx during the
 * release201 v2.0.8 UX hotfix A5+A6+A7 refactor. No React imports,
 * no i18n side effects — only data shape conversions used to build
 * the draft package (skill.md / skill.json / authoring/request.json).
 */

import { type SourceKind, detectSourceKind } from '../types';

export type DraftPayloadInput = {
  slug: string;
  intent: string;
  mode: DraftInputMode;
  sourceRefs: string[];
  sampleText: string;
  scriptText: string;
  attachments: AttachmentDraft[];
  detectedSource: SourceKind;
};

export type DraftPayloadFile = { path: string; content: string } | { path: string; contentBase64: string };

export type DraftPayload = {
  slug: string;
  name: string;
  description: string;
  files: DraftPayloadFile[];
  metadata: {
    authoring: {
      mode: DraftInputMode;
      sourceKind: SourceKind;
      sourceRefs: string[];
      attachmentRefs: string[];
      seedScriptPath: string | null;
      sessionId: string;
    };
  };
};

export type AttachmentDraft = {
  name: string;
  size: number;
  type: string;
  contentBase64: string;
};

export type DraftInputMode = 'plain' | 'script' | 'api' | 'doc';

export function extractSourceRef(intent: string): string {
  const url = intent.match(/https?:\/\/\S+/)?.[0];
  if (url) return url;
  const pathMatch = intent.match(/(\/|~|[a-zA-Z]:\\)[\w./-]+/);
  return pathMatch?.[0] ?? intent.slice(0, 200);
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[/\\]/g, '-')
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 120) || 'attachment'
  );
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

export function formatSourceMarkdown(refs: string[], attachments: AttachmentDraft[]): string {
  const lines: string[] = [];
  if (refs.length === 0 && attachments.length === 0) return '- Inline requirement only.';
  for (const ref of refs) lines.push(`- ${ref}`);
  for (const attachment of attachments)
    lines.push(`- refs/${sanitizeFileName(attachment.name)} (${formatBytes(attachment.size)})`);
  return lines.join('\n');
}

export function inferScriptPath(script: string): string {
  const trimmed = script.trimStart();
  const firstLine = trimmed.split('\n', 1)[0]?.trim() ?? '';
  if (
    firstLine.startsWith('python ') ||
    firstLine.startsWith('python3 ') ||
    trimmed.startsWith('#!/usr/bin/env python') ||
    trimmed.includes('import ')
  ) {
    return 'scripts/seed.py';
  }
  if (
    firstLine.startsWith('node ') ||
    firstLine.startsWith('npm ') ||
    firstLine.startsWith('pnpm ') ||
    trimmed.startsWith('#!/usr/bin/env node') ||
    trimmed.includes('console.log') ||
    trimmed.includes('=>')
  ) {
    return 'scripts/seed.js';
  }
  if (trimmed.startsWith('#!') || trimmed.includes('\n')) return 'scripts/seed.sh';
  return 'scripts/seed.txt';
}

export function inferScriptRequires(script: string): { bins?: string[]; python?: string[]; node?: string[] } {
  const lower = script.toLowerCase();
  if (inferScriptPath(script).endsWith('.py')) return { python: [] };
  if (inferScriptPath(script).endsWith('.js')) return { node: [] };
  const bins = ['bash'];
  if (lower.includes('curl')) bins.push('curl');
  if (lower.includes('jq')) bins.push('jq');
  return { bins: Array.from(new Set(bins)) };
}

/**
 * Pure builder that turns the dialog form state into the draft payload
 * passed to `createDraft`. Extracted from the inline handleSubmit body so
 * the React component stays under the 500-line budget and so this
 * conversion is unit-testable without mounting the dialog.
 */
export function buildDraftPayload(input: DraftPayloadInput): DraftPayload {
  const { slug, intent, mode, sourceRefs, sampleText, scriptText, attachments, detectedSource } = input;
  const description = intent.trim();
  const name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const hasScript = scriptText.trim().length > 0;
  const refs = sourceRefs.length > 0 ? sourceRefs : detectedSource === 'inline-spec' ? [] : [extractSourceRef(intent)];
  const runtimeKind = mode === 'api' ? 'http-endpoint' : hasScript ? 'inline-script' : 'text-workflow';
  const requires = {
    capabilities: [
      ...(attachments.length > 0 ? ['workspace-assets'] : []),
      ...(mode === 'api' ? ['external-network'] : []),
      ...(hasScript ? ['filesystem'] : []),
    ],
    ...(hasScript ? inferScriptRequires(scriptText) : {}),
  };
  const approvalScopes =
    mode === 'api' || hasScript ? ['network/filesystem/secrets if requested by implementation'] : [];
  const sourceMarkdown = formatSourceMarkdown(refs, attachments);
  const sampleTasks = sampleText.trim()
    ? [
        {
          title: `${name} sample task`,
          prompt: sampleText.trim(),
          acceptanceCriteria: ['Output matches the requested format and cites any referenced input material.'],
        },
      ]
    : [];
  const skillMd = `---
name: ${slug}
description: ${description}
license: MIT
---

# ${name}

${description}

## Source Materials

${sourceMarkdown}

${hasScript ? `## Seed Script\n\n\`\`\`\n${scriptText.trim()}\n\`\`\`\n` : ''}

${sampleText.trim() ? `## Sample Task\n\n${sampleText.trim()}\n` : ''}

## Pipeline

1. Authoring agent reviews the requirement package and source materials.
2. Authoring agent turns the request into a concrete skill contract.
3. Implementation, validation, and sample-task coverage are filled in during lifecycle.

## Boundaries

- Do not execute scripts or call external services without explicit approval.
- Preserve uploaded references as source material; do not treat them as final implementation.
`;
  const skillJson = JSON.stringify(
    {
      schemaVersion: 1,
      slug,
      name,
      description,
      category: 'workflow',
      version: '0.1.0',
      license: 'MIT',
      compatibility: ['prismer-sdk'],
      runtime: {
        kind: runtimeKind,
        requires,
        ...(hasScript
          ? {
              executableJson: {
                kind: 'seed-script',
                path: inferScriptPath(scriptText),
              },
            }
          : {}),
      },
      inputs: [],
      outputs: [],
      sampleTasks,
      security: {
        dataAccess: Array.from(
          new Set([
            'workspace-assets',
            ...(mode === 'api' ? ['external-network'] : []),
            ...(hasScript ? ['filesystem'] : []),
          ]),
        ),
        humanApprovalRequiredFor: approvalScopes,
      },
      provenance: {
        sourceKind: detectedSource,
        sourceRefs: refs,
        authoredBy: 'studio-new-skill-dialog',
        authoredAt: new Date().toISOString(),
      },
      metadata: {
        authoringIntent: {
          mode,
          attachmentCount: attachments.length,
          hasSeedScript: hasScript,
        },
      },
    },
    null,
    2,
  );
  const requestPackage = JSON.stringify(
    {
      intent: description,
      mode,
      sourceKind: detectedSource,
      sourceRefs: refs,
      sampleTask: sampleText.trim() || null,
      attachments: attachments.map(({ name: attachName, size, type }) => ({ name: attachName, size, type })),
      seedScript: hasScript ? { path: inferScriptPath(scriptText), content: scriptText.trim() } : null,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const files: DraftPayloadFile[] = [
    { path: 'SKILL.md', content: skillMd },
    { path: 'skill.json', content: skillJson },
    { path: 'authoring/request.json', content: requestPackage },
    ...(hasScript ? [{ path: inferScriptPath(scriptText), content: scriptText.trim() }] : []),
    ...attachments.map((attachment) => ({
      path: `refs/${sanitizeFileName(attachment.name)}`,
      contentBase64: attachment.contentBase64,
    })),
  ];
  return {
    slug,
    name,
    description,
    files,
    metadata: {
      authoring: {
        mode,
        sourceKind: detectedSource,
        sourceRefs: refs,
        attachmentRefs: attachments.map((attachment) => `refs/${sanitizeFileName(attachment.name)}`),
        seedScriptPath: hasScript ? inferScriptPath(scriptText) : null,
        sessionId: `studio-${Date.now()}`,
      },
    },
  };
}

export function resolveDetectedSource({
  initialSource,
  mode,
  intent,
  sourceRefsText,
}: {
  initialSource?: SourceKind;
  mode: DraftInputMode;
  intent: string;
  sourceRefsText: string;
}): SourceKind {
  if (initialSource) return initialSource;
  if (mode === 'script') return 'code-source';
  if (mode === 'api') return 'service-endpoint';
  if (mode === 'doc') return 'doc-url';
  return detectSourceKind(`${intent}\n${sourceRefsText}`);
}
