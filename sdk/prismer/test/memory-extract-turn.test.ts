// memory203/13 §0.5 — DAEMON-SIDE (in-pod) automatic memory extraction.
//
// extractFromTurn was rearchitected: the cloud-extract lane (POST
// /api/im/memory/extract, saved/skipped semantics, daemon writes into a
// ScopedMemoryStore) is RETIRED. The LLM call now runs IN-POD via the agent's
// own gateway (`${cloud.baseUrl}/api/v1/messages`, Anthropic wire) and the cloud
// does ZERO LLM for memory. The function's contract is now:
//   - deps: { cloud, recallPages }  (recallPages built from the LOCAL store by
//     the caller; extractFromTurn does NOT itself write any store — the caller,
//     hook-server, writes the returned pages via the handleWrite path).
//   - returns { pages: ExtractedPage[], error, rawTextChars?, truncated?,
//     errorStatus?, ... }  — there is NO `extracted` count field.
//
// What this proves (the invariants that survive the rearchitecture):
//   1. A representative turn flows through extractFromTurn with the gateway seam
//      STUBBED at /api/v1/messages, and the model's JSON is parsed into a page
//      whose PKF content parsePkf/assertPkfRoundTrips accept.
//   2. NEGATIVE CONTROL — a transient gateway 5xx is retried once (2 attempts)
//      and surfaces a non-silent error (pages:[], error set, errorStatus=503),
//      never a silent empty result.
//   3. Genuine zero-extraction ({"pages":[]}) and a heuristic skip both return
//      pages:[] error:null (not a pipeline failure), the latter without ever
//      calling the gateway.
//   4. PKF round-trip unit — markdown samples → normalizeToPkf → parsePkf all
//      parse, and assertPkfRoundTrips accepts valid / rejects garbage.
//
// The gateway seam: we inject a `fetchImpl` into CloudClient so the /api/v1/
// messages response is deterministic — this is the seam, NOT a mock of the code
// under test (extract.ts runs verbatim).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudClient } from '../src/auth.js';
import { extractFromTurn, type ExtractInput } from '../src/daemon/memory/extract.js';
// Cloud-side PKF canonicalization + the round-trip helper (reached via a
// relative path to the repo `src/` tree, same pattern as test/bundle.test.ts).
import {
  normalizeToPkf,
  assertPkfRoundTrips,
} from '../../../src/im/services/memory-pkf.js';
import { parsePkf } from '../../../src/lib/pkf/index.js';

beforeEach(() => {
  // Suppress the daemon logger's loud lines during the negative-control path.
  process.env.PRISMER_LOG_LEVEL = 'silent';
});

afterEach(() => {
  delete process.env.PRISMER_LOG_LEVEL;
});

/** A substantive turn that clears the heuristic filters (≥80 user / ≥200 asst chars). */
function substantiveInput(workspaceId: string): ExtractInput {
  return {
    userMessage:
      'Please record this for future sessions: our API base path is /api/v1 for all backend ' +
      'calls, and every service we build should default to that prefix unless told otherwise.',
    assistantResponse:
      'Understood — I will use /api/v1 as the API base for every backend request from now on, and ' +
      'I have noted it so future sessions pick it up automatically. Any new service or client I ' +
      'generate will default to the /api/v1 prefix for backend calls unless you explicitly override it.',
    conversationHistory: [],
    agentImUserId: 'im_agent_x',
    workspaceId,
    roleSlug: null,
    conversationId: 'conv_1',
    runId: 'run_1',
    sessionMetadata: { model: 'test', platform: 'unit' },
  };
}

/**
 * Build a CloudClient whose fetchImpl returns a deterministic Anthropic-wire
 * `/api/v1/messages` envelope carrying `text` as the assistant content — this is
 * the injected in-pod gateway seam the extractor calls.
 */
function gatewayReturningText(
  text: string,
  opts: { stopReason?: string } = {},
): { cloud: CloudClient; calls: () => number } {
  let calls = 0;
  const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('/api/v1/messages')) {
      calls += 1;
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
          stop_reason: opts.stopReason ?? 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-test', fetchImpl });
  return { cloud, calls: () => calls };
}

describe('extractFromTurn — turn → page (happy path, in-pod gateway)', () => {
  it('parses the gateway JSON into a page with PKF content parsePkf accepts', async () => {
    const ws = 'ws_happy';

    // The model returns a page whose content is canonical PKF. Build it with the
    // same normalizeToPkf the cloud materialize path uses so the read-back asserts
    // PKF survived the daemon's light sanitiser.
    const { pkf } = normalizeToPkf('## Fact\nThe API base path is /api/v1 for all backend calls.', {
      type: 'project',
      title: 'API base path',
      description: 'API base path is /api/v1',
    });
    expect(assertPkfRoundTrips(pkf)).toBe(true);

    const modelJson = JSON.stringify({
      pages: [
        {
          path: 'project/api-base.pkf',
          title: 'API base path',
          placement: 'new',
          kind: 'project',
          content: pkf,
        },
      ],
    });
    const { cloud, calls } = gatewayReturningText(modelJson);

    const result = await extractFromTurn(substantiveInput(ws), { cloud, recallPages: [] });

    // Gateway was called exactly once; one page surfaced; no error.
    expect(calls()).toBe(1);
    expect(result.error).toBeNull();
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.path).toBe('project/api-base.pkf');
    expect(result.pages[0]?.placement).toBe('hub');
    expect(result.pages[0]?.pageType).toBe('hub');
    // kind=project → workspace-visible (user/feedback would be agent:self).
    expect(result.pages[0]?.visibility).toBe('workspace');

    // The extracted content is valid PKF the cloud materialize path consumes.
    const storedContent = result.pages[0]!.content;
    const parsed = parsePkf(storedContent);
    expect(parsed.parseFlags.frontmatterFound).toBe(true);
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(assertPkfRoundTrips(storedContent)).toBe(true);
  });

  // memory211 P6 — BOTH sides of the image-pointer parity, through the real
  // pipeline: the pairing declares the source from the `<figure><img src>`
  // reference alone (it matches ANY `prismer://asset/<id>` occurrence, and the
  // extraction prompt teaches that form for IMAGE/CHART assets), and the gate
  // — which used to recognize only `<a rel="derived-from">` — admits the page
  // instead of dropping the image-only deliverable wholesale.
  it('P6 — an image-only deliverable is PAIRED from its <figure><img src> pointer and ADMITTED by the gate', async () => {
    const ws = 'ws_image_deliverable';
    const assetId = 'ast_load_chart';
    const modelJson = JSON.stringify({
      pages: [
        {
          path: 'project/load-test.pkf',
          title: 'Load-test chart',
          placement: 'new',
          kind: 'project',
          content:
            '<script type="application/prismer+json">{"type":"reference","title":"Load test",' +
            '"description":"Throughput plateaus past C=200.","pkfVersion":"1.1"}</script>' +
            '<h1>Load-test chart</h1>' +
            `<section><h2 id="chart">Chart</h2><figure><img src="prismer://asset/${assetId}" ` +
            'alt="throughput vs concurrency"><figcaption>plateaus at 50k/s beyond C=200.</figcaption>' +
            '</figure></section>',
        },
      ],
    });
    const { cloud } = gatewayReturningText(modelJson);

    const result = await extractFromTurn(
      { ...substantiveInput(ws), attachedAssetIds: [assetId], attachedAssetSizes: { [assetId]: 65_536 } },
      { cloud, recallPages: [] },
    );

    expect(result.error).toBeNull();
    expect(result.pages).toHaveLength(1);
    // PAIRING side: the img reference alone declared the deliverable source.
    expect(result.pages[0]!.deliverableSource).toEqual({
      assetId,
      sizeBytes: 65_536,
    });
    // GATE side: the page is kept — no gateRejections, nothing dropped.
    expect(result.gateRejections ?? []).toEqual([]);
  });

  it('P6 negative control — the same page with NO pointer to its declared asset is still gated out', async () => {
    const ws = 'ws_image_deliverable_missing';
    const assetId = 'ast_other_chart';
    const modelJson = JSON.stringify({
      pages: [
        {
          path: 'project/load-test.pkf',
          title: 'Load-test chart',
          placement: 'new',
          kind: 'project',
          content:
            '<h1>Load-test chart</h1>' +
            `<section><h2 id="chart">Chart</h2><p>The curve flattens; the chart lives at ` +
            `prismer://asset/${assetId} but the page points at it only in prose.</p></section>`,
        },
      ],
    });
    const { cloud } = gatewayReturningText(modelJson);

    const result = await extractFromTurn(
      { ...substantiveInput(ws), attachedAssetIds: [assetId] },
      { cloud, recallPages: [] },
    );

    expect(result.pages).toHaveLength(0);
    expect(result.gateRejections).toEqual(['deliverable_pointer_missing']);
  });
});

describe('extractFromTurn — negative control (error surfacing)', () => {
  it('surfaces a non-silent error (and retries once) on a transient gateway 5xx', async () => {
    const ws = 'ws_5xx';

    let attempts = 0;
    const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/api/v1/messages')) {
        attempts += 1;
        return new Response(JSON.stringify({ error: { code: 'upstream', message: 'boom' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-test', fetchImpl });

    const result = await extractFromTurn(substantiveInput(ws), { cloud, recallPages: [] });

    // 1 retry → 2 attempts total; surfaced error; no pages; status carried through.
    expect(attempts).toBe(2);
    expect(result.pages).toHaveLength(0);
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/503|status=503/);
    expect(result.errorStatus).toBe(503);
  });

  it('genuine zero-extraction returns pages:[] with error:null (not a failure)', async () => {
    const { cloud } = gatewayReturningText(JSON.stringify({ pages: [] }));

    const result = await extractFromTurn(substantiveInput('ws_zero'), { cloud, recallPages: [] });

    expect(result.pages).toHaveLength(0);
    expect(result.error).toBeNull(); // nothing worth saving ≠ a pipeline error
  });

  it('heuristic skip (too-short turn) returns pages:[] error:null without calling the gateway', async () => {
    const { cloud, calls } = gatewayReturningText(JSON.stringify({ pages: [] }));

    const result = await extractFromTurn(
      { ...substantiveInput('ws_skip'), userMessage: 'hi', assistantResponse: 'hello there' },
      { cloud, recallPages: [] },
    );

    expect(calls()).toBe(0); // never reached the gateway
    expect(result.pages).toHaveLength(0);
    expect(result.error).toBeNull();
  });
});

describe('PKF round-trip — normalizeToPkf → parsePkf', () => {
  const samples: Array<{ name: string; md: string; type: string }> = [
    {
      name: 'two-section feedback',
      md: '## Why\nUser said long preambles waste their time.\n\n## How to apply\nAnswer first, keep rationale to one line.',
      type: 'feedback',
    },
    {
      name: 'single-section project fact',
      md: '## Deploy flow\nTags are pushed to trigger GitLab CI; APP_ENV selects the namespace.',
      type: 'project',
    },
    {
      name: 'reference with bullet body',
      md: '## Convention\nAll backend calls default to the /api/v1 prefix.',
      type: 'reference',
    },
  ];

  for (const s of samples) {
    it(`${s.name} → normalizeToPkf → parsePkf parses with frontmatter + sections`, () => {
      const { pkf, parsed } = normalizeToPkf(s.md, { type: s.type, title: s.name });
      // normalizeToPkf already parsed once; assert that projection is usable.
      expect(parsed.parseFlags.frontmatterFound).toBe(true);
      expect(parsed.sections.length).toBeGreaterThan(0);
      // Independent re-parse (round-trip) of the stored body.
      const reparsed = parsePkf(pkf);
      expect(reparsed.parseFlags.frontmatterFound).toBe(true);
      expect(reparsed.sections.length).toBeGreaterThan(0);
      expect(assertPkfRoundTrips(pkf)).toBe(true);
    });
  }

  it('assertPkfRoundTrips rejects garbage (empty / no frontmatter / bare stub)', () => {
    expect(assertPkfRoundTrips('')).toBe(false);
    expect(assertPkfRoundTrips('   ')).toBe(false);
    expect(assertPkfRoundTrips('<p>no frontmatter, no h2</p>')).toBe(false);
    // Bare frontmatter stub with no sections / links is not a usable page.
    expect(
      assertPkfRoundTrips('<script type="application/prismer+json">{"type":"note"}</script>'),
    ).toBe(false);
  });
});
