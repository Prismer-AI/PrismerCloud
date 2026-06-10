/**
 * §30 B3.x — UnifiedCreationModal barrel.
 *
 * Re-exports the shell + its public types so consumers (TopBar, page.tsx,
 * left-rail, etc.) import from a single stable path:
 *
 *   import { UnifiedCreationModal } from '@/app/workspace/components/unified-creation';
 *
 * B3.2-B3.5 will plug their sub-flow components into the modal's child
 * slots — they don't need to be re-exported here unless something outside
 * the directory needs them.
 */

export {
  UnifiedCreationModal,
  type UnifiedCreationModalProps,
  type UnifiedCreationEvent,
} from './UnifiedCreationModal';

export { CeoAuthorizationModal, type CeoAuthorizationModalProps } from './CeoAuthorizationModal';
export { RoleTemplateBrowser, type RoleTemplateBrowserProps } from './template-browser';
