/**
 * @prismer/wire — Permission schemas and types
 *
 * Canonical import path for @prismer/sandbox-runtime (Track 2).
 * Re-exports PermissionRule, PermissionMode, PermissionRuleSource,
 * PermissionBehavior from schemas.ts / types.ts.
 */

export {
  PermissionModeSchema,
  PermissionRuleSourceSchema,
  PermissionBehaviorSchema,
  PermissionRuleSchema,
} from './schemas.js';

export type {
  PermissionMode,
  PermissionRuleSource,
  PermissionBehavior,
  PermissionRule,
} from './types.js';
