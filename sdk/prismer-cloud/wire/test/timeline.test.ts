/**
 * @prismer/wire — timeline.ts test suite
 *
 * Covers TimelineEntry, BackfillRequest/Response, SeqAck, EpochMarker.
 */

import { describe, it, expect } from 'vitest';
import {
  TimelineEntrySchema,
  BackfillRequestSchema,
  BackfillResponseSchema,
  SeqAckSchema,
  EpochMarkerSchema,
} from '../src/timeline.js';

function mustParse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

function mustFail(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}

describe('TimelineEntry', () => {
  it('valid entry parses', () => {
    mustParse(TimelineEntrySchema, {
      seq: 7,
      ts: 1700000000000,
      kind: 'agent.tool.post',
      payload: { callId: 'c1', ok: true },
    });
  });

  it('accepts optional epoch', () => {
    mustParse(TimelineEntrySchema, {
      seq: 0,
      ts: 0,
      kind: 'agent.register',
      payload: null,
      epoch: 3,
    });
  });

  it('rejects missing kind', () => {
    mustFail(TimelineEntrySchema, { seq: 1, ts: 1, payload: {} });
  });

  it('rejects non-integer seq', () => {
    mustFail(TimelineEntrySchema, { seq: 1.5, ts: 1, kind: 'k', payload: {} });
  });
});

describe('BackfillRequest / BackfillResponse', () => {
  it('request with since only', () => {
    mustParse(BackfillRequestSchema, { since: 100 });
  });

  it('request with since + limit', () => {
    mustParse(BackfillRequestSchema, { since: 100, limit: 500 });
  });

  it('rejects limit > 10000', () => {
    mustFail(BackfillRequestSchema, { since: 0, limit: 10001 });
  });

  it('response with empty entries is valid', () => {
    mustParse(BackfillResponseSchema, { entries: [], hasMore: false });
  });

  it('response with entries + nextSeq', () => {
    mustParse(BackfillResponseSchema, {
      entries: [{ seq: 1, ts: 1, kind: 'agent.state', payload: { status: 'idle' } }],
      hasMore: true,
      nextSeq: 2,
    });
  });

  it('rejects response missing hasMore', () => {
    mustFail(BackfillResponseSchema, { entries: [] });
  });
});

describe('SeqAck', () => {
  it('parses valid seq', () => {
    mustParse(SeqAckSchema, { seq: 42 });
  });

  it('rejects negative seq', () => {
    mustFail(SeqAckSchema, { seq: -1 });
  });
});

describe('EpochMarker', () => {
  it('parses valid marker', () => {
    mustParse(EpochMarkerSchema, {
      epoch: 5,
      startedAt: 1700000000000,
      daemonId: 'd-abc',
    });
  });

  it('rejects missing daemonId', () => {
    mustFail(EpochMarkerSchema, { epoch: 0, startedAt: 0 });
  });
});
