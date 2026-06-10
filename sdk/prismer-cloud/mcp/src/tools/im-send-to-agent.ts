import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface ParticipantUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  agentType?: string | null;
}

interface Participant {
  id: string;
  role: string;
  user: ParticipantUser;
}

/**
 * Build a structured error reply payload (still returned as ok: tool succeeded,
 * but the inner JSON marks ok: false so the LLM can surface it instead of
 * pretending the message was sent).
 */
function err(error: string, message: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, error, message }),
      },
    ],
  };
}

export function registerImSendToAgent(server: McpServer) {
  server.tool(
    'prismer.agent.send',
    'Send a message in the given conversation explicitly addressed to another agent. The platform will dispatch your message to that agent. ALWAYS use this instead of writing `@username` in plain text in your reply — this is the source of truth for routing. Steps: (1) call `prismer.conversation.listAgents` to find the target\'s username, (2) call this tool with `to_username` set. Returns `{ ok, message_id, dispatched_to }`. On `ok: false`, surface the error rather than pretending. Never call with `to_username` equal to your own username. This tool acts as the agent it\'s running for (env `PRISMER_AGENT_USERNAME`); the resulting message is attributed to that agent, not the human owner of the API key.',
    {
      conversation_id: z.string().min(1).describe('Conversation ID where the message will be posted'),
      to_username: z.string().min(1).describe('Username of the target agent (from prismer.conversation.listAgents). Do NOT pass your own username.'),
      content: z.string().min(1).describe('Message content to send'),
    },
    async ({ conversation_id, to_username, content }) => {
      try {
        // 1. Resolve username → userId via the conversation participants list.
        //    Same endpoint as prismer.conversation.listAgents — auth-scoped to the caller.
        let convResp: Record<string, unknown>;
        try {
          convResp = (await prismerFetch(
            `/api/im/conversations/${conversation_id}`,
          )) as Record<string, unknown>;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return err('conversation_lookup_failed', msg);
        }

        if (!convResp.ok) {
          const e = convResp.error as Record<string, string> | string | undefined;
          const m = typeof e === 'string' ? e : e?.message || 'Failed to load conversation';
          return err('conversation_lookup_failed', m);
        }

        const convData = convResp.data as Record<string, unknown> | undefined;
        const participants = (convData?.participants as Participant[]) || [];

        const target = participants.find(
          (p) => p.user?.role === 'agent' && p.user?.username === to_username,
        );

        if (!target) {
          return err(
            'agent_not_found',
            `No agent named '${to_username}' is a participant of conversation ${conversation_id}. Call prismer.conversation.listAgents to see available agents.`,
          );
        }

        const targetUserId = target.user.id;

        // 2. Self-mention guard. Resolve the caller's imUserId via /me.
        try {
          const meResp = (await prismerFetch('/api/im/me')) as Record<string, unknown>;
          if (meResp.ok) {
            const meData = meResp.data as Record<string, unknown> | undefined;
            const meUser = meData?.user as Record<string, unknown> | undefined;
            const callerId = (meUser?.id as string) || '';
            if (callerId && callerId === targetUserId) {
              return err(
                'self_mention_forbidden',
                'Cannot send a message addressed to yourself. Pick a different agent.',
              );
            }
          }
        } catch {
          // /me lookup failed — fall through and let the server enforce self-mention rules.
        }

        // 3. POST the message with structured mention metadata.
        const body = {
          content,
          type: 'text',
          metadata: {
            mentions: [
              {
                raw: `@${to_username}`,
                userId: targetUserId,
                username: to_username,
              },
            ],
            routingMode: 'explicit',
            routeTargets: [targetUserId],
            kind: 'agent_reply',
          },
        };

        let sendResp: Record<string, unknown>;
        try {
          sendResp = (await prismerFetch(`/api/im/messages/${conversation_id}`, {
            method: 'POST',
            body,
          })) as Record<string, unknown>;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return err('send_failed', msg);
        }

        if (!sendResp.ok) {
          const e = sendResp.error as Record<string, string> | string | undefined;
          const m = typeof e === 'string' ? e : e?.message || 'Send failed';
          return err('send_failed', m);
        }

        const data = sendResp.data as Record<string, unknown> | undefined;
        const message = data?.message as Record<string, unknown> | undefined;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  message_id: message?.id || null,
                  dispatched_to: [targetUserId],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return err('request_failed', msg);
      }
    },
  );
}
