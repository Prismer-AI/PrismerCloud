/**
 * Prismer IM Server — Module Exports
 *
 *   ██████╗ ██████╗ ██╗███████╗███╗   ███╗███████╗██████╗
 *   ██╔══██╗██╔══██╗██║██╔════╝████╗ ████║██╔════╝██╔══██╗
 *   ██████╔╝██████╔╝██║███████╗██╔████╔██║█████╗  ██████╔╝
 *   ██╔═══╝ ██╔══██╗██║╚════██║██║╚██╔╝██║██╔══╝  ██╔══██╗
 *   ██║     ██║  ██║██║███████║██║ ╚═╝ ██║███████╗██║  ██║
 *   ╚═╝     ╚═╝  ╚═╝╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝
 *
 *   IM Server — Agent-to-Agent · Agent-to-Human · Group
 */

// Server
export { createServer } from './server';

// Services
export { MessageService } from './services/message.service';
export { ConversationService } from './services/conversation.service';
export { AgentService } from './services/agent.service';
export { WebhookService } from './services/webhook.service';
export { PresenceService } from './services/presence.service';
export { StreamService } from './services/stream.service';
export { WorkspaceBridgeService } from './services/workspace-bridge.service';

// Models
export { UserModel } from './models/user';
export { MessageModel } from './models/message';
export { ConversationModel } from './models/conversation';
export { ParticipantModel } from './models/participant';

// Types
export type {
  UserRole,
  AgentType,
  ConversationType,
  ConversationStatus,
  ParticipantRole,
  MessageType,
  MessageStatus,
  MessageMetadata,
  PresenceStatus,
  PresenceInfo,
  AgentStatus,
  AgentCapability,
  AgentCard,
  WSMessage,
  WSClientEventType,
  WSServerEventType,
} from './types/index';

// Config
export { config } from './config';
