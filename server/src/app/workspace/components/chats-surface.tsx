'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { MessageSquare, PanelRightClose, PanelRightOpen, Plus, Users } from 'lucide-react';

import { ImChannel, type ComposerUploadProgressView } from './im-channel';
import { PeopleDirectory, type PeopleDirectoryLookupResult } from './people-directory';
import { SessionContextSidebar } from './session-context-sidebar';
import { SessionDirectory } from './session-directory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/contexts/i18n-context';
import type { AgentLiveStatus } from '../lib/agent-status';
import type { AgentPhaseRow } from '../lib/agent-phase-store';
import { radius, surface } from '../lib/design';
import type {
  AgentDTO,
  AssetDTO,
  ContactFriendDTO,
  ContactRequestDTO,
  ConversationDTO,
  TaskDTO,
  UserProfileDTO,
  WorkspaceFileDTO,
} from '../lib/types';

type ChatDirectoryTab = 'sessions' | 'people';

export interface ChatsSurfaceProps {
  isDark: boolean;
  conversations: ConversationDTO[];
  selectedConversation: ConversationDTO | null;
  selectedConversationId: string | null;
  currentUserId?: string | null;
  workspaceId?: string | null;
  me: UserProfileDTO | null;
  contacts: ContactFriendDTO[];
  agents: AgentDTO[];
  agentStatuses?: Map<string, AgentLiveStatus>;
  receivedRequests: ContactRequestDTO[];
  sentRequests: ContactRequestDTO[];
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  linkedTasks: TaskDTO[];
  linkedAgents: AgentDTO[];
  sessionAssets: AssetDTO[];
  recentAssets: AssetDTO[];
  agentTypeByImUserId: Record<string, string>;
  /** imUserId → ASCII username (ceo/engineer/marketer) — reliable role-icon source. */
  usernameByImUserId: Record<string, string>;
  /** All known agent usernames — used to detect agent senders by member username. */
  agentUsernames: Set<string>;
  taskPhaseMap?: Map<string, AgentPhaseRow>;
  /** 2026-05-29 — dispatch in-flight set per agent imUserId for placeholder rendering. */
  dispatchInFlight?: Map<string, Set<string>>;
  refreshing?: boolean;
  showMobileBack?: boolean;
  prefillContactUserId?: string | null;
  headerActions?: ReactNode;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  onSelectSession: (id: string | null) => void;
  onNewSession: () => void;
  onRefresh: () => void | Promise<void>;
  onRenameSession?: (session: ConversationDTO) => void;
  onArchiveSession?: (session: ConversationDTO) => void;
  onDeleteSession?: (session: ConversationDTO) => void;
  onTogglePinSession?: (session: ConversationDTO, pinned: boolean) => void | Promise<void>;
  onToggleMuteSession?: (session: ConversationDTO, muted: boolean) => void | Promise<void>;
  onUploadAsset: () => void;
  onComposerUploadAsset: () => void;
  onComposerPasteFiles: (files: File[]) => void | Promise<void>;
  onOpenAssets: () => void;
  onOpenTask: (taskId: string) => void;
  onTaskChanged: () => void | Promise<void>;
  onAddMember: () => void;
  onOpenAsset: (assetId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onLookupUser?: (identifier: string) => Promise<PeopleDirectoryLookupResult | null>;
  onSendFriendRequest?: (userId: string, reason?: string) => Promise<void> | void;
  onAcceptContactRequest?: (requestId: string) => Promise<void> | void;
  onRejectContactRequest?: (requestId: string) => Promise<void> | void;
  onCancelContactRequest?: (requestId: string) => Promise<void> | void;
  onStartContactChat: (userId: string) => Promise<void> | void;
  onRetryMessage?: (messageId: string) => void;
  /** release201/26 §8 Phase 4 — retry a run whose daemon resume failed. */
  onRetryRun?: (taskId: string) => void;
  onSaveMessageAsMemory?: (payload: {
    conversationId: string;
    messageId: string;
    text: string;
    authorImUserId: string;
    createdAt: string;
  }) => void;
  onForwardMessage?: (payload: {
    conversationId: string;
    messageId: string;
    text: string;
    senderName: string;
    createdAt: string;
  }) => void;
  /**
   * release201 S12 — Open Insights as an in-shell surface for a given
   * project. Threaded through to `SessionContextSidebar` so the
   * "Open project insights" affordance in the project-scope tab works
   * without leaving the workspace shell.
   */
  onOpenProjectInsights?: (projectId: string) => void;
  /**
   * release201/30 Phase 2 — inline upload progress payload threaded
   * through from page.tsx. ImChannel renders it inside the composer.
   * `null` hides the row.
   */
  uploadProgress?: ComposerUploadProgressView | null;
}

export function ChatsSurface({
  isDark,
  conversations,
  selectedConversation,
  selectedConversationId,
  currentUserId,
  workspaceId,
  me,
  contacts,
  agents,
  agentStatuses,
  receivedRequests,
  sentRequests,
  assets,
  files,
  linkedTasks,
  linkedAgents,
  sessionAssets,
  recentAssets,
  agentTypeByImUserId,
  usernameByImUserId,
  agentUsernames,
  taskPhaseMap,
  dispatchInFlight,
  refreshing = false,
  showMobileBack = false,
  prefillContactUserId,
  headerActions,
  notify,
  onSelectSession,
  onNewSession,
  onRefresh,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  onTogglePinSession,
  onToggleMuteSession,
  onUploadAsset,
  onComposerUploadAsset,
  onComposerPasteFiles,
  onOpenAssets,
  onOpenTask,
  onTaskChanged,
  onAddMember,
  onOpenAsset,
  onOpenAgent,
  onLookupUser,
  onSendFriendRequest,
  onAcceptContactRequest,
  onRejectContactRequest,
  onCancelContactRequest,
  onStartContactChat,
  onRetryMessage,
  onRetryRun,
  onSaveMessageAsMemory,
  onForwardMessage,
  onOpenProjectInsights,
  uploadProgress = null,
}: ChatsSurfaceProps) {
  const { t } = useI18n();
  const [directoryTab, setDirectoryTab] = useState<ChatDirectoryTab>('sessions');
  const [contextOpen, setContextOpen] = useState(false);

  useEffect(() => {
    if (prefillContactUserId) setDirectoryTab('people');
  }, [prefillContactUserId]);

  useEffect(() => {
    setContextOpen(false);
  }, [selectedConversationId]);

  const selectedAgent = useMemo(() => {
    return selectedConversationId
      ? agents.find((agent) =>
          selectedConversation?.participants?.some((participant) => participant.userId === agent.userId),
        )
      : null;
  }, [agents, selectedConversation, selectedConversationId]);

  const contextItemCount = linkedTasks.length + sessionAssets.length;
  const contextHeaderAction = selectedConversation ? (
    <button
      type="button"
      onClick={() => setContextOpen((value) => !value)}
      data-testid="session-context-toggle"
      aria-label={contextOpen ? t('workspace.chats.closeContext') : t('workspace.chats.openContext')}
      title={contextOpen ? t('workspace.chats.closeContext') : t('workspace.chats.openContext')}
      className={`relative inline-flex h-8 w-8 items-center justify-center rounded-xl border transition-colors ${
        contextOpen
          ? isDark
            ? 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200'
            : 'border-cyan-200 bg-cyan-50 text-cyan-700'
          : isDark
            ? 'border-white/[0.06] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
            : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {contextOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
      {contextItemCount > 0 ? (
        <span
          className={`absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-[9px] font-bold leading-4 ${
            isDark ? 'bg-cyan-400 text-zinc-950' : 'bg-cyan-600 text-white'
          }`}
        >
          {contextItemCount > 9 ? '9+' : contextItemCount}
        </span>
      ) : null}
    </button>
  ) : null;

  // 2026-05-30 (A3) — chats surface is now an outer rounded-3xl container
  // holding TWO inner rounded cards (left directory + right channel) with a
  // gap between them. Replaces the prior single-grid layout that divided the
  // panes with a 1px border.
  return (
    <section
      data-testid="workspace-chats-surface"
      className={cn(
        'flex min-h-0 flex-1 gap-3 overflow-hidden border p-3 shadow-[0_22px_70px_-56px_rgba(76,29,149,0.34)]',
        radius.pane,
        isDark ? surface.pane.dark : surface.pane.light,
      )}
    >
      <aside
        className={cn(
          selectedConversation ? 'hidden lg:flex' : 'flex',
          'min-h-0 w-full shrink-0 flex-col overflow-hidden border lg:w-[300px]',
          radius.card,
          isDark ? surface.card.dark : surface.card.light,
        )}
      >
        <div className={`shrink-0 border-b px-3 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
          <div
            className={`flex rounded-xl border p-1 text-xs font-semibold ${
              isDark ? 'border-white/[0.06] bg-zinc-950/60' : 'border-zinc-200 bg-zinc-100/80'
            }`}
          >
            <DirectoryTabButton
              isDark={isDark}
              active={directoryTab === 'sessions'}
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              label={t('workspace.chats.sessions')}
              onClick={() => setDirectoryTab('sessions')}
            />
            <DirectoryTabButton
              isDark={isDark}
              active={directoryTab === 'people'}
              icon={<Users className="h-3.5 w-3.5" />}
              label={
                receivedRequests.length > 0
                  ? t('workspace.chats.contactsCount', { count: receivedRequests.length })
                  : t('workspace.chats.contacts')
              }
              onClick={() => setDirectoryTab('people')}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2 pt-3">
          {directoryTab === 'sessions' ? (
            <SessionDirectory
              isDark={isDark}
              sessions={conversations}
              selectedSessionId={selectedConversationId}
              refreshing={refreshing}
              onSelectSession={(id) => onSelectSession(id)}
              onNewSession={onNewSession}
              onRefresh={onRefresh}
              onRenameSession={onRenameSession}
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
              onTogglePinSession={onTogglePinSession}
              onToggleMuteSession={onToggleMuteSession}
              className="h-full rounded-none border-0 shadow-none"
            />
          ) : (
            <PeopleDirectory
              isDark={isDark}
              me={me}
              friends={contacts}
              agents={agents}
              agentStatuses={agentStatuses}
              receivedRequests={receivedRequests}
              sentRequests={sentRequests}
              prefillUserId={prefillContactUserId}
              prefillIdentifier={prefillContactUserId}
              onReload={async () => {
                await onRefresh();
              }}
              onOpenSession={(conversationId) => onSelectSession(conversationId)}
              onLookupUser={onLookupUser}
              onSendFriendRequest={onSendFriendRequest}
              onAcceptRequest={onAcceptContactRequest}
              onRejectRequest={onRejectContactRequest}
              onCancelRequest={onCancelContactRequest}
              onStartDirectChat={(userId) => onStartContactChat(userId)}
              onOpenProfile={(person) => {
                const agent = agents.find((candidate) => candidate.userId === person.id);
                if (agent) onOpenAgent(agent.agentId);
              }}
              notify={notify}
              compact
              title={t('workspace.chats.contacts')}
              subtitle={t('workspace.chats.contactsSubtitle')}
              className="h-full"
            />
          )}
        </div>
      </aside>

      <div
        className={cn(
          selectedConversation ? 'flex' : 'hidden lg:flex',
          'relative min-h-0 min-w-0 flex-1 overflow-hidden',
        )}
      >
        {selectedConversation ? (
          <>
            <div
              className={cn(
                'flex h-full min-h-0 min-w-0 flex-1 overflow-hidden border',
                radius.card,
                isDark ? surface.card.dark : surface.card.light,
              )}
              onPointerDownCapture={(event) => {
                if (!contextOpen) return;
                const target = event.target as HTMLElement | null;
                if (target?.closest('[data-testid="session-context-toggle"]')) return;
                setContextOpen(false);
              }}
            >
              <ImChannel
                isDark={isDark}
                stageMode
                conversation={selectedConversation}
                currentUserId={currentUserId}
                workspaceId={workspaceId}
                notify={notify}
                assets={assets}
                files={files}
                onNewChannel={onNewSession}
                onUploadAsset={onUploadAsset}
                onComposerUploadAsset={onComposerUploadAsset}
                onComposerPasteFiles={onComposerPasteFiles}
                onOpenAssets={onOpenAssets}
                onOpenTask={onOpenTask}
                onTaskChanged={onTaskChanged}
                onMobileBack={showMobileBack ? () => onSelectSession(null) : undefined}
                headerActions={
                  <>
                    {headerActions}
                    {contextHeaderAction}
                  </>
                }
                onAddMember={onAddMember}
                linkedTasks={linkedTasks}
                linkedAgents={linkedAgents}
                agentTypeByImUserId={agentTypeByImUserId}
                usernameByImUserId={usernameByImUserId}
                agentUsernames={agentUsernames}
                agentStatuses={agentStatuses}
                taskPhaseMap={taskPhaseMap}
                dispatchInFlight={dispatchInFlight}
                onRetryMessage={onRetryMessage}
                onRetryRun={onRetryRun}
                recentAssets={recentAssets}
                onOpenAsset={onOpenAsset}
                onOpenAgent={onOpenAgent}
                onSaveMessageAsMemory={onSaveMessageAsMemory}
                onForwardMessage={onForwardMessage}
                uploadProgress={uploadProgress}
              />
            </div>
            <SessionContextSidebar
              isDark={isDark}
              open={contextOpen}
              tasks={linkedTasks}
              assets={sessionAssets}
              onToggleOpen={() => setContextOpen((value) => !value)}
              onOpenTask={onOpenTask}
              onOpenAsset={onOpenAsset}
              onOpenProjectInsights={onOpenProjectInsights}
            />
          </>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <div
              className={`w-full max-w-md rounded-3xl border px-6 py-7 text-center ${
                isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200 bg-white/70'
              }`}
            >
              <div
                className={`mx-auto flex h-12 w-12 items-center justify-center rounded-2xl ${
                  isDark ? 'bg-violet-500/16 text-violet-200' : 'bg-violet-100 text-violet-700'
                }`}
              >
                <MessageSquare className="h-5 w-5" />
              </div>
              <h2 className={`mt-4 text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
                {t('workspace.chats.selectSession')}
              </h2>
              <p className={`mt-2 text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('workspace.chats.selectSessionHint')}
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={onNewSession}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white shadow-sm"
                >
                  <Plus className="h-4 w-4" />
                  {t('workspace.chats.newSession')}
                </button>
                <button
                  type="button"
                  onClick={() => setDirectoryTab('people')}
                  className={`inline-flex h-10 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition-colors ${
                    isDark
                      ? 'border-white/[0.08] bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]'
                      : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'
                  }`}
                >
                  <Users className="h-4 w-4" />
                  {t('workspace.chats.contacts')}
                </button>
              </div>
              {selectedAgent ? (
                <p className={`mt-4 text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
                  {t('workspace.chats.lastActiveAgent', { name: selectedAgent.name })}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function DirectoryTabButton({
  isDark,
  active,
  icon,
  label,
  onClick,
}: {
  isDark: boolean;
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 transition-colors ${
        active
          ? isDark
            ? 'bg-white/[0.08] text-zinc-100'
            : 'bg-white text-zinc-950 shadow-sm'
          : isDark
            ? 'text-zinc-500 hover:text-zinc-200'
            : 'text-zinc-600 hover:text-zinc-950'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
