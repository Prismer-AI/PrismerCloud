import { describe, expect, it } from 'vitest';
import { extractAgentReply } from '../src/commands/skill';

// apc/11 §0.17 gap #2 regression guard. The dispatch reply extractor used to
// ignore message `type` and return the FIRST agent row (ASC order), so a stale
// system_event shadowed the real reply forever and `cloud skill test` scored a
// fake ok:false. These tests pin the fix; mutating either half turns them red.
describe('extractAgentReply — skill test dispatch reply', () => {
  const AGENT = 'agent-uume';

  it('skips a stale system_event and returns the real later reply', () => {
    // Wire order is ASC by seq: infra event first, real reply later.
    const messages = [
      { senderId: AGENT, type: 'system_event', content: 'no AgentProfile for this agent' },
      { senderId: AGENT, type: 'text', content: 'doctor JSON: exit78 pass15/fail6' },
    ];
    expect(extractAgentReply({ messages }, AGENT)).toBe('doctor JSON: exit78 pass15/fail6');
  });

  it('never returns an infrastructure-typed message even if it is the only agent row', () => {
    const messages = [{ senderId: AGENT, type: 'system_event', content: 'stale event' }];
    expect(extractAgentReply({ messages }, AGENT)).toBeNull();
  });

  it('returns the LATEST real reply when several exist', () => {
    const messages = [
      { senderId: AGENT, type: 'text', content: 'first attempt' },
      { senderId: AGENT, type: 'text', content: 'final answer' },
    ];
    expect(extractAgentReply({ messages }, AGENT)).toBe('final answer');
  });

  it('ignores messages from other senders', () => {
    const messages = [
      { senderId: 'someone-else', type: 'text', content: 'human message' },
      { senderId: AGENT, type: 'text', content: 'agent reply' },
    ];
    expect(extractAgentReply({ messages }, AGENT)).toBe('agent reply');
  });

  it('returns null when the agent has only non-text infra rows among noise', () => {
    const messages = [
      { senderId: 'human', type: 'text', content: 'hi' },
      { senderId: AGENT, type: 'system', content: 'session started' },
    ];
    expect(extractAgentReply({ messages }, AGENT)).toBeNull();
  });

  // apc/11 §0.17 gap #2 (end-to-end anchor). A reused DM carries a prior run's
  // good reply; without the `afterIso` floor the poll returns it before the
  // agent answers THIS prompt, so a mumble/negative-control run scores a false
  // ok:true. These pin the anchor — dropping the createdAt<=afterMs guard reds.
  const PROMPT_TS = '2026-07-24T09:18:00.000Z';
  it('with afterIso: ignores a prior-run reply older than the prompt (returns null until the fresh one lands)', () => {
    const messages = [
      { senderId: AGENT, type: 'text', content: 'STALE good reply: exit78 pass15', createdAt: '2026-07-24T09:17:06.000Z' },
    ];
    // Only the stale reply exists so far → must NOT be accepted as this run's answer.
    expect(extractAgentReply({ messages }, AGENT, PROMPT_TS)).toBeNull();
  });

  it('with afterIso: returns the fresh reply created after the prompt, not the stale one', () => {
    const messages = [
      { senderId: AGENT, type: 'text', content: 'STALE good reply: exit78 pass15', createdAt: '2026-07-24T09:17:06.000Z' },
      { senderId: AGENT, type: 'text', content: 'The garden looks lovely in the springtime.', createdAt: '2026-07-24T09:18:09.000Z' },
    ];
    expect(extractAgentReply({ messages }, AGENT, PROMPT_TS)).toBe('The garden looks lovely in the springtime.');
  });

  it('with afterIso: a reply missing createdAt is treated as unanchorable (stale) → null', () => {
    const messages = [{ senderId: AGENT, type: 'text', content: 'no timestamp reply' }];
    expect(extractAgentReply({ messages }, AGENT, PROMPT_TS)).toBeNull();
  });
});
