/**
 * Immutable runtime/routing snapshot for work that outlives the provider turn.
 *
 * Post-turn extraction can execute after the native session has ended or after
 * a daemon restart, so it must not re-derive these values from mutable profile
 * defaults. Every field is optional for payloads written by older runtimes.
 */
export interface PostTurnExecutionContext {
  adapterName?: string;
  profileId?: string;
  profileName?: string;
  roleSlug?: string;
  model?: string;
  /** Provider reported by the terminal provider response; never profile intent. */
  provider?: string;
  /** Configured provider/chain intent retained only for legacy diagnostics. */
  proxyProvider?: string;
  providerTurnId?: string;
  attachedAssetIds?: string[];
  /** Set only by an in-process provider adapter after a terminal event. */
  routingEvidenceSource?: 'adapter';
}

/**
 * Terminal routing evidence gate shared by every post-turn lane.
 *
 * `proxyProvider` is configured intent and deliberately does not satisfy this
 * check. Extraction and receipt adoption may only begin after the completed
 * provider turn supplied both its served model and served provider.
 */
export function terminalRoutingEvidenceError(
  context: PostTurnExecutionContext | undefined,
): 'non_extractable:untrusted_routing_evidence' | 'non_extractable:no_execution_model' | 'non_extractable:no_terminal_provider' | null {
  if (context?.routingEvidenceSource !== 'adapter') return 'non_extractable:untrusted_routing_evidence';
  if (!context?.model?.trim()) return 'non_extractable:no_execution_model';
  if (!context.provider?.trim()) return 'non_extractable:no_terminal_provider';
  return null;
}
