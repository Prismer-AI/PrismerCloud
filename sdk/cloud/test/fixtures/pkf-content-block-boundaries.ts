import type { ContentBlockInput, ContentBlockOutput } from '../../src/types';

const source =
  '<script type="application/prismer+json">{"type":"note","title":"Type fixture","pkfVersion":"1.1"}</script><section><h2 id="fixture">Fixture</h2></section>';

export const validNestedInput: ContentBlockInput = {
  kind: 'tool_result',
  toolCallId: 'tool-input',
  output: [{ kind: 'pkf', source }],
};

export const forgedNestedInput: ContentBlockInput = {
  kind: 'tool_result',
  toolCallId: 'tool-forged',
  output: [
    {
      kind: 'pkf',
      source,
      // @ts-expect-error Server-owned locators cannot be supplied through nested input.
      blockId: 'pkfib_forged',
      blockRevision: 1,
      sourceHash: 'forged',
      authority: { status: 'verified', source: 'pkf_inline_blocks' },
    },
  ],
};

export const validNestedOutput: ContentBlockOutput = {
  kind: 'tool_result',
  toolCallId: 'tool-output',
  output: [
    {
      kind: 'pkf',
      source,
      blockId: 'pkfib_authoritative',
      blockRevision: 1,
      sourceHash: 'authoritative',
      authority: { status: 'verified', source: 'pkf_inline_blocks' },
    },
  ],
};

export const incompleteNestedOutput: ContentBlockOutput = {
  kind: 'tool_result',
  toolCallId: 'tool-incomplete',
  output: [
    // @ts-expect-error Nested PKF output must carry locator and authority fields.
    { kind: 'pkf', source },
  ],
};
