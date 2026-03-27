'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2, Send, Check, Bot, User, RefreshCw, ChevronDown, ChevronRight,
  MessageSquare, Users, Compass, Briefcase, Plus, Trash2, Search
} from 'lucide-react';
import { useApp } from '@/contexts/app-context';

// ─── Types ───────────────────────────────────────────────────

interface Identity {
  imUserId: string;
  username: string;
  token: string;
  role: 'human' | 'agent';
}

interface ChatMessage {
  id: string;
  sender: 'human' | 'agent';
  senderName: string;
  content: string;
  timestamp: Date;
}

interface ApiLogEntry {
  method: string;
  path: string;
  status: number;
  time: number;
  ok: boolean;
}

interface GroupInfo {
  groupId: string;
  conversationId: string;
  name: string;
}

interface DiscoveredAgent {
  userId: string;
  username: string;
  displayName?: string;
  agentType?: string;
  capabilities?: string[];
  status?: string;
}

interface WorkspaceInfo {
  workspaceId: string;
  conversationId: string;
}

type IMTab = 'direct' | 'group' | 'discover' | 'workspace';

// ─── Helpers ─────────────────────────────────────────────────

function randomName(prefix: string): string {
  const adjectives = ['swift', 'bright', 'calm', 'keen', 'bold', 'warm', 'cool', 'fair'];
  const nouns = ['fox', 'owl', 'wolf', 'bear', 'hawk', 'deer', 'lynx', 'hare'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${prefix}-${adj}-${noun}-${num}`;
}

async function imFetch(
  path: string,
  options: RequestInit,
  log: (entry: ApiLogEntry) => void
): Promise<{ data: Record<string, unknown>; status: number }> {
  const start = Date.now();
  const res = await fetch(path, options);
  const data = await res.json();
  log({
    method: (options.method || 'GET').toUpperCase(),
    path,
    status: res.status,
    time: Date.now() - start,
    ok: res.ok && (data.ok !== false),
  });
  return { data, status: res.status };
}

// ─── Component ───────────────────────────────────────────────

export function IMPanel({ isDark }: { isDark: boolean }) {
  const { activeApiKey, token, addToast } = useApp();

  // Identities
  const [human, setHuman] = useState<Identity | null>(null);
  const [agent, setAgent] = useState<Identity | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerError, setRegisterError] = useState('');

  // Active tab
  const [activeTab, setActiveTab] = useState<IMTab>('direct');

  // Direct Chat
  const [directMessages, setDirectMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sendAs, setSendAs] = useState<'human' | 'agent'>('human');
  const [isSending, setIsSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Group Chat
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
  const [groupMessages, setGroupMessages] = useState<ChatMessage[]>([]);
  const [groupInput, setGroupInput] = useState('');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [groupSendAs, setGroupSendAs] = useState<'human' | 'agent'>('human');
  const [isSendingGroup, setIsSendingGroup] = useState(false);
  const groupEndRef = useRef<HTMLDivElement>(null);

  // Discovery
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoverQuery, setDiscoverQuery] = useState('');

  // Workspace
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [wsMessages, setWsMessages] = useState<ChatMessage[]>([]);
  const [wsInput, setWsInput] = useState('');
  const [isInitWorkspace, setIsInitWorkspace] = useState(false);
  const [isSendingWs, setIsSendingWs] = useState(false);
  const wsEndRef = useRef<HTMLDivElement>(null);

  // API log
  const [apiLog, setApiLog] = useState<ApiLogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);

  const addLog = useCallback((entry: ApiLogEntry) => {
    setApiLog(prev => [...prev, entry]);
  }, []);

  // Auto-scroll chat areas
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [directMessages]);
  useEffect(() => { groupEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [groupMessages]);
  useEffect(() => { wsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [wsMessages]);

  const getAuthHeaders = useCallback((identity: Identity) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${identity.token}`,
  }), []);

  // ─── Register both identities ─────────────────────────────

  const doRegister = useCallback(async () => {
    setIsRegistering(true);
    setRegisterError('');
    setDirectMessages([]);
    setGroupInfo(null);
    setGroupMessages([]);
    setDiscoveredAgents([]);
    setWorkspaceInfo(null);
    setWsMessages([]);
    setApiLog([]);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authToken = activeApiKey?.key || token;
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    try {
      // Register human
      const humanName = randomName('user');
      const { data: hData } = await imFetch('/api/im/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'human', username: humanName, displayName: humanName }),
      }, addLog);

      if (!hData.ok) throw new Error((typeof hData.error === 'string' ? hData.error : 'Human registration failed'));
      const hInner = hData.data as Record<string, unknown>;
      const humanIdentity: Identity = {
        imUserId: hInner.imUserId as string,
        username: humanName,
        token: hInner.token as string,
        role: 'human',
      };

      // Register agent
      const agentName = randomName('bot');
      const { data: aData } = await imFetch('/api/im/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'agent',
          username: agentName,
          displayName: agentName,
          agentType: 'assistant',
          capabilities: ['chat', 'parse', 'search'],
          description: 'Demo assistant agent for playground testing',
        }),
      }, addLog);

      if (!aData.ok) throw new Error((typeof aData.error === 'string' ? aData.error : 'Agent registration failed'));
      const aInner = aData.data as Record<string, unknown>;
      const agentIdentity: Identity = {
        imUserId: aInner.imUserId as string,
        username: agentName,
        token: aInner.token as string,
        role: 'agent',
      };

      setHuman(humanIdentity);
      setAgent(agentIdentity);

      // Auto-send welcome message
      const welcomeMsg = `Hello! I'm ${agentName}. Try the tabs above to explore DM, Group Chat, Discovery, and Workspace APIs.`;
      const { data: msgData } = await imFetch(`/api/im/direct/${humanIdentity.imUserId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentIdentity.token}`,
        },
        body: JSON.stringify({ content: welcomeMsg, type: 'text' }),
      }, addLog);

      if (msgData.ok) {
        const msgInner = msgData.data as Record<string, unknown>;
        setDirectMessages([{
          id: (msgInner.messageId as string) || `msg-${Date.now()}`,
          sender: 'agent',
          senderName: agentName,
          content: welcomeMsg,
          timestamp: new Date(),
        }]);
      }
    } catch (err: unknown) {
      setRegisterError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setIsRegistering(false);
    }
  }, [activeApiKey, token, addLog]);

  // Auto-register on mount
  useEffect(() => {
    if (!human && !isRegistering) doRegister();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Direct Chat ──────────────────────────────────────────

  const handleDirectSend = async () => {
    if (!inputText.trim() || !human || !agent) return;
    setIsSending(true);

    const sender = sendAs === 'human' ? human : agent;
    const receiver = sendAs === 'human' ? agent : human;
    const content = inputText.trim();
    setInputText('');

    try {
      const { data } = await imFetch(`/api/im/direct/${receiver.imUserId}/messages`, {
        method: 'POST',
        headers: getAuthHeaders(sender),
        body: JSON.stringify({ content, type: 'text' }),
      }, addLog);

      const msgInner = data.ok ? (data.data as Record<string, unknown>) : null;
      setDirectMessages(prev => [...prev, {
        id: (msgInner?.messageId as string) || `msg-${Date.now()}`,
        sender: sendAs,
        senderName: sender.username,
        content,
        timestamp: new Date(),
      }]);

      if (!data.ok) addToast((typeof data.error === 'string' ? data.error : 'Send failed'), 'error');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Send failed', 'error');
    } finally {
      setIsSending(false);
    }
  };

  // ─── Group Chat ───────────────────────────────────────────

  const createGroup = async () => {
    if (!human || !agent) return;
    setIsCreatingGroup(true);
    try {
      const groupName = `demo-group-${Math.floor(Math.random() * 900) + 100}`;
      const { data } = await imFetch('/api/im/conversations/group', {
        method: 'POST',
        headers: getAuthHeaders(human),
        body: JSON.stringify({
          title: groupName,
          memberIds: [agent.imUserId],
        }),
      }, addLog);

      if (!data.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Group creation failed');
      const inner = data.data as Record<string, unknown>;
      const convId = (inner.id as string) || (inner.conversationId as string);
      setGroupInfo({
        groupId: (inner.groupId as string) || convId,
        conversationId: convId,
        name: groupName,
      });
      setGroupMessages([]);

      // Send a welcome message from agent
      if (convId) {
        const { data: msgData } = await imFetch(`/api/im/messages/${convId}`, {
          method: 'POST',
          headers: getAuthHeaders(agent),
          body: JSON.stringify({ content: `Agent joined group "${groupName}"!`, type: 'text' }),
        }, addLog);
        if (msgData.ok) {
          const msgInner = msgData.data as Record<string, unknown>;
          setGroupMessages([{
            id: (msgInner.messageId as string) || `msg-${Date.now()}`,
            sender: 'agent',
            senderName: agent.username,
            content: `Agent joined group "${groupName}"!`,
            timestamp: new Date(),
          }]);
        }
      }
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Group creation failed', 'error');
    } finally {
      setIsCreatingGroup(false);
    }
  };

  const handleGroupSend = async () => {
    if (!groupInput.trim() || !groupInfo || !human || !agent) return;
    setIsSendingGroup(true);

    const sender = groupSendAs === 'human' ? human : agent;
    const content = groupInput.trim();
    setGroupInput('');

    try {
      const { data } = await imFetch(`/api/im/messages/${groupInfo.conversationId}`, {
        method: 'POST',
        headers: getAuthHeaders(sender),
        body: JSON.stringify({ content, type: 'text' }),
      }, addLog);

      const msgInner = data.ok ? (data.data as Record<string, unknown>) : null;
      setGroupMessages(prev => [...prev, {
        id: (msgInner?.messageId as string) || `msg-${Date.now()}`,
        sender: groupSendAs,
        senderName: sender.username,
        content,
        timestamp: new Date(),
      }]);

      if (!data.ok) addToast((typeof data.error === 'string' ? data.error : 'Send failed'), 'error');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Send failed', 'error');
    } finally {
      setIsSendingGroup(false);
    }
  };

  const deleteGroup = async () => {
    setGroupInfo(null);
    setGroupMessages([]);
  };

  // ─── Discovery ────────────────────────────────────────────

  const discoverAgents = async (query?: string) => {
    if (!human) return;
    setIsDiscovering(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      params.set('limit', '10');
      const { data } = await imFetch(`/api/im/discover?${params.toString()}`, {
        method: 'GET',
        headers: getAuthHeaders(human),
      }, addLog);

      if (data.ok) {
        const items = (data.data as Record<string, unknown>)?.agents || (data.data as Record<string, unknown>)?.users || data.data;
        setDiscoveredAgents(Array.isArray(items) ? items.map((a: Record<string, unknown>) => ({
          userId: (a.userId || a.imUserId || a.id) as string,
          username: a.username as string,
          displayName: a.displayName as string | undefined,
          agentType: a.agentType as string | undefined,
          capabilities: a.capabilities as string[] | undefined,
          status: a.status as string | undefined,
        })) : []);
      }
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Discovery failed', 'error');
    } finally {
      setIsDiscovering(false);
    }
  };

  // ─── Workspace ────────────────────────────────────────────

  const initWorkspace = async () => {
    if (!human || !agent) return;
    setIsInitWorkspace(true);
    try {
      const wsId = `ws-${Math.floor(Math.random() * 900) + 100}`;
      const { data } = await imFetch('/api/im/workspace/init-group', {
        method: 'POST',
        headers: getAuthHeaders(human),
        body: JSON.stringify({
          workspaceId: wsId,
          title: `Workspace ${wsId}`,
          users: [{ userId: human.imUserId, displayName: human.username }],
          agents: [{ name: agent.username, displayName: agent.username }],
        }),
      }, addLog);

      if (!data.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Workspace init failed');
      const inner = data.data as Record<string, unknown>;
      setWorkspaceInfo({
        workspaceId: inner.workspaceId as string,
        conversationId: inner.conversationId as string,
      });
      setWsMessages([]);

      // Send initial message in workspace
      if (inner.conversationId) {
        const { data: msgData } = await imFetch(`/api/im/messages/${inner.conversationId}`, {
          method: 'POST',
          headers: getAuthHeaders(agent),
          body: JSON.stringify({ content: 'Workspace initialized. Agent is ready.', type: 'text' }),
        }, addLog);
        if (msgData.ok) {
          const msgInner = msgData.data as Record<string, unknown>;
          setWsMessages([{
            id: (msgInner.messageId as string) || `msg-${Date.now()}`,
            sender: 'agent',
            senderName: agent.username,
            content: 'Workspace initialized. Agent is ready.',
            timestamp: new Date(),
          }]);
        }
      }
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Workspace init failed', 'error');
    } finally {
      setIsInitWorkspace(false);
    }
  };

  const handleWsSend = async () => {
    if (!wsInput.trim() || !workspaceInfo || !human || !agent) return;
    setIsSendingWs(true);

    const sender = human; // workspace messages always from human
    const content = wsInput.trim();
    setWsInput('');

    try {
      const { data } = await imFetch(`/api/im/messages/${workspaceInfo.conversationId}`, {
        method: 'POST',
        headers: getAuthHeaders(sender),
        body: JSON.stringify({ content, type: 'text' }),
      }, addLog);

      const msgInner = data.ok ? (data.data as Record<string, unknown>) : null;
      setWsMessages(prev => [...prev, {
        id: (msgInner?.messageId as string) || `msg-${Date.now()}`,
        sender: 'human',
        senderName: sender.username,
        content,
        timestamp: new Date(),
      }]);
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Send failed', 'error');
    } finally {
      setIsSendingWs(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────

  const isReady = human && agent;
  const cardClass = `rounded-2xl border p-5 ${isDark ? 'bg-zinc-900/30 border-white/10' : 'bg-white border-zinc-200 shadow-sm'}`;

  const TAB_ITEMS: { id: IMTab; label: string; icon: typeof MessageSquare; desc: string }[] = [
    { id: 'direct', label: 'Direct', icon: MessageSquare, desc: 'POST /api/im/direct/:id/messages' },
    { id: 'group', label: 'Group', icon: Users, desc: 'POST /api/im/conversations/group' },
    { id: 'discover', label: 'Discover', icon: Compass, desc: 'GET /api/im/discover' },
    { id: 'workspace', label: 'Workspace', icon: Briefcase, desc: 'POST /api/im/workspace/init-group' },
  ];

  return (
    <div className="space-y-4">
      {/* Identity cards */}
      <div className={cardClass}>
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {isRegistering ? 'Setting up...' : isReady ? 'Identities' : 'Disconnected'}
          </h3>
          <button
            onClick={doRegister}
            disabled={isRegistering}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              isDark ? 'text-zinc-400 hover:text-white hover:bg-white/5' : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100'
            }`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRegistering ? 'animate-spin' : ''}`} />
            Reset
          </button>
        </div>

        {registerError ? (
          <div className={`rounded-xl p-3 text-xs ${isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-600 border border-red-200'}`}>
            {registerError}
            <button onClick={doRegister} className="ml-2 underline">Retry</button>
          </div>
        ) : isRegistering ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            Registering human + agent identities...
          </div>
        ) : isReady ? (
          <div className="grid grid-cols-2 gap-3">
            <IdentityCard identity={human} icon={<User className="w-4 h-4" />} isDark={isDark} />
            <IdentityCard identity={agent} icon={<Bot className="w-4 h-4" />} isDark={isDark} />
          </div>
        ) : null}
      </div>

      {/* Tabs */}
      <div className={`${cardClass} transition-opacity ${isReady ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="flex gap-1 mb-4 overflow-x-auto scrollbar-none">
          {TAB_ITEMS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                  activeTab === tab.id
                    ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-100 text-violet-700 border border-violet-300'
                    : isDark ? 'text-zinc-500 hover:text-zinc-300 border border-transparent' : 'text-zinc-500 hover:text-zinc-700 border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* API hint */}
        <div className={`text-[10px] font-mono mb-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {TAB_ITEMS.find(t => t.id === activeTab)?.desc}
        </div>

        {/* ─── Direct Chat Tab ─── */}
        {activeTab === 'direct' && (
          <div>
            <ChatArea messages={directMessages} endRef={chatEndRef} isDark={isDark} emptyText="Send a direct message to test the DM API" />
            <ChatInput
              value={inputText}
              onChange={setInputText}
              onSend={handleDirectSend}
              isSending={isSending}
              sendAs={sendAs}
              onToggleSendAs={() => setSendAs(s => s === 'human' ? 'agent' : 'human')}
              isDark={isDark}
            />
          </div>
        )}

        {/* ─── Group Chat Tab ─── */}
        {activeTab === 'group' && (
          <div>
            {!groupInfo ? (
              <div className="flex flex-col items-center justify-center py-10">
                <Users className={`w-8 h-8 mb-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
                <p className={`text-xs mb-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  Create a group with both identities
                </p>
                <button
                  onClick={createGroup}
                  disabled={isCreatingGroup}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-violet-600 to-cyan-500 text-white hover:opacity-90 transition-all"
                >
                  {isCreatingGroup ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Create Group
                </button>
              </div>
            ) : (
              <div>
                <div className={`flex items-center justify-between mb-3 px-2 py-1.5 rounded-lg text-xs ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
                  <div className="flex items-center gap-2">
                    <Users className={`w-3.5 h-3.5 ${isDark ? 'text-violet-400' : 'text-violet-600'}`} />
                    <span className={`font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{groupInfo.name}</span>
                    <span className={`font-mono text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{groupInfo.conversationId}</span>
                  </div>
                  <button onClick={deleteGroup} className={`p-1 rounded transition-colors ${isDark ? 'hover:bg-white/5 text-zinc-500' : 'hover:bg-zinc-200 text-zinc-400'}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <ChatArea messages={groupMessages} endRef={groupEndRef} isDark={isDark} emptyText="Group created — send a message" />
                <ChatInput
                  value={groupInput}
                  onChange={setGroupInput}
                  onSend={handleGroupSend}
                  isSending={isSendingGroup}
                  sendAs={groupSendAs}
                  onToggleSendAs={() => setGroupSendAs(s => s === 'human' ? 'agent' : 'human')}
                  isDark={isDark}
                />
              </div>
            )}
          </div>
        )}

        {/* ─── Discovery Tab ─── */}
        {activeTab === 'discover' && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-xl text-sm ${
                isDark ? 'bg-zinc-950 border border-white/10' : 'bg-zinc-50 border border-zinc-200'
              }`}>
                <Search className={`w-3.5 h-3.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
                <input
                  type="text"
                  value={discoverQuery}
                  onChange={(e) => setDiscoverQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') discoverAgents(discoverQuery || undefined); }}
                  placeholder="Search agents by name or capability..."
                  className={`flex-1 bg-transparent outline-none text-xs ${isDark ? 'text-white placeholder:text-zinc-600' : 'text-zinc-900 placeholder:text-zinc-400'}`}
                />
              </div>
              <button
                onClick={() => discoverAgents(discoverQuery || undefined)}
                disabled={isDiscovering}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-violet-600 to-cyan-500 text-white hover:opacity-90 transition-all"
              >
                {isDiscovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Compass className="w-3.5 h-3.5" />}
                Discover
              </button>
            </div>

            {discoveredAgents.length > 0 ? (
              <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-zinc-950 border-white/5' : 'bg-zinc-50 border-zinc-200'}`}>
                <div className="max-h-[300px] overflow-y-auto divide-y divide-zinc-800/50">
                  {discoveredAgents.map((a) => (
                    <div key={a.userId} className={`flex items-center gap-3 px-3 py-2.5 ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-zinc-100/50'}`}>
                      <div className={`flex items-center justify-center w-7 h-7 rounded-full shrink-0 ${isDark ? 'bg-cyan-500/20 text-cyan-400' : 'bg-cyan-100 text-cyan-600'}`}>
                        <Bot className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                            {a.displayName || a.username}
                          </span>
                          {a.status && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              a.status === 'online'
                                ? isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
                                : isDark ? 'bg-zinc-700 text-zinc-400' : 'bg-zinc-200 text-zinc-500'
                            }`}>
                              {a.status}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {a.agentType && (
                            <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{a.agentType}</span>
                          )}
                          {a.capabilities && a.capabilities.length > 0 && (
                            <div className="flex gap-1">
                              {a.capabilities.slice(0, 3).map((cap) => (
                                <span key={cap} className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/10 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
                                  {cap}
                                </span>
                              ))}
                              {a.capabilities.length > 3 && (
                                <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>+{a.capabilities.length - 3}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <span className={`text-[10px] font-mono shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        {a.userId.slice(0, 8)}...
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className={`flex flex-col items-center justify-center py-10 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                <Compass className="w-8 h-8 mb-3 opacity-50" />
                <p className="text-xs">Click Discover to find registered agents</p>
              </div>
            )}
          </div>
        )}

        {/* ─── Workspace Tab ─── */}
        {activeTab === 'workspace' && (
          <div>
            {!workspaceInfo ? (
              <div className="flex flex-col items-center justify-center py-10">
                <Briefcase className={`w-8 h-8 mb-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
                <p className={`text-xs mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  Initialize a workspace with human + agent
                </p>
                <p className={`text-[10px] mb-4 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                  Uses POST /api/im/workspace/init-group
                </p>
                <button
                  onClick={initWorkspace}
                  disabled={isInitWorkspace}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-violet-600 to-cyan-500 text-white hover:opacity-90 transition-all"
                >
                  {isInitWorkspace ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Briefcase className="w-3.5 h-3.5" />}
                  Init Workspace
                </button>
              </div>
            ) : (
              <div>
                <div className={`flex items-center justify-between mb-3 px-2 py-1.5 rounded-lg text-xs ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
                  <div className="flex items-center gap-2">
                    <Briefcase className={`w-3.5 h-3.5 ${isDark ? 'text-violet-400' : 'text-violet-600'}`} />
                    <span className={`font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Workspace</span>
                    <span className={`font-mono text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{workspaceInfo.workspaceId}</span>
                  </div>
                  <button onClick={() => { setWorkspaceInfo(null); setWsMessages([]); }} className={`p-1 rounded transition-colors ${isDark ? 'hover:bg-white/5 text-zinc-500' : 'hover:bg-zinc-200 text-zinc-400'}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <ChatArea messages={wsMessages} endRef={wsEndRef} isDark={isDark} emptyText="Workspace ready — send a message" />
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={wsInput}
                    onChange={(e) => setWsInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleWsSend(); } }}
                    placeholder="Message workspace..."
                    className={`flex-1 px-3 py-2 rounded-xl text-sm ${
                      isDark
                        ? 'bg-zinc-950 border border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50'
                        : 'bg-zinc-50 border border-zinc-200 text-zinc-900 placeholder:text-zinc-400 focus:border-violet-400'
                    } outline-none transition-colors`}
                  />
                  <button
                    onClick={handleWsSend}
                    disabled={isSendingWs || !wsInput.trim()}
                    className={`p-2 rounded-xl transition-all ${
                      isSendingWs || !wsInput.trim()
                        ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                        : 'bg-gradient-to-r from-violet-600 to-cyan-500 text-white hover:opacity-90'
                    }`}
                  >
                    {isSendingWs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* API Log */}
      {apiLog.length > 0 && (
        <div className={cardClass}>
          <button
            onClick={() => setShowLog(s => !s)}
            className={`flex items-center gap-2 w-full text-left text-xs font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
          >
            {showLog ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            API Log ({apiLog.length} calls)
          </button>

          {showLog && (
            <div className={`mt-3 rounded-xl border overflow-hidden ${isDark ? 'bg-zinc-950 border-white/5' : 'bg-zinc-50 border-zinc-200'}`}>
              <div className="max-h-[200px] overflow-y-auto">
                {apiLog.map((entry, i) => (
                  <div key={i} className={`flex items-center gap-2 px-3 py-1.5 text-xs font-mono border-b last:border-b-0 ${isDark ? 'border-white/5' : 'border-zinc-200'}`}>
                    <span className={`w-12 font-bold ${
                      entry.method === 'POST' ? (isDark ? 'text-emerald-400' : 'text-emerald-600')
                        : entry.method === 'GET' ? (isDark ? 'text-blue-400' : 'text-blue-600')
                        : entry.method === 'DELETE' ? (isDark ? 'text-red-400' : 'text-red-600')
                        : (isDark ? 'text-amber-400' : 'text-amber-600')
                    }`}>{entry.method}</span>
                    <span className={`flex-1 truncate ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{entry.path}</span>
                    <span className={entry.ok ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : (isDark ? 'text-red-400' : 'text-red-600')}>{entry.status}</span>
                    <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{entry.time}ms</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared Sub-components ─────────────────────────────────

function ChatArea({ messages, endRef, isDark, emptyText }: {
  messages: ChatMessage[];
  endRef: React.RefObject<HTMLDivElement | null>;
  isDark: boolean;
  emptyText: string;
}) {
  return (
    <div className={`rounded-xl border mb-3 min-h-[200px] max-h-[300px] overflow-y-auto ${isDark ? 'bg-zinc-950 border-white/5' : 'bg-zinc-50 border-zinc-200'}`}>
      {messages.length === 0 ? (
        <div className={`flex items-center justify-center h-[200px] text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {emptyText}
        </div>
      ) : (
        <div className="p-3 space-y-3">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.sender === 'human' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-xl px-3 py-2 ${
                msg.sender === 'human'
                  ? isDark ? 'bg-violet-500/20 text-violet-200' : 'bg-violet-100 text-violet-900'
                  : isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-white text-zinc-800 border border-zinc-200'
              }`}>
                <div className="flex items-center gap-1.5 mb-1">
                  {msg.sender === 'agent' ? <Bot className="w-3 h-3 opacity-60" /> : <User className="w-3 h-3 opacity-60" />}
                  <span className="text-[10px] font-medium opacity-60">{msg.senderName}</span>
                  <span className="text-[10px] opacity-40 ml-auto">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-xs leading-relaxed">{msg.content}</p>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

function ChatInput({ value, onChange, onSend, isSending, sendAs, onToggleSendAs, isDark }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  isSending: boolean;
  sendAs: 'human' | 'agent';
  onToggleSendAs: () => void;
  isDark: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onToggleSendAs}
        className={`flex items-center gap-1 px-2 py-2 rounded-lg text-xs font-medium transition-all shrink-0 ${
          sendAs === 'human'
            ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-100 text-violet-700 border border-violet-300'
            : isDark ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-cyan-100 text-cyan-700 border border-cyan-300'
        }`}
        title={`Sending as ${sendAs}. Click to switch.`}
      >
        {sendAs === 'human' ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
        {sendAs === 'human' ? 'Human' : 'Agent'}
      </button>

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        placeholder="Type a message..."
        className={`flex-1 px-3 py-2 rounded-xl text-sm ${
          isDark
            ? 'bg-zinc-950 border border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50'
            : 'bg-zinc-50 border border-zinc-200 text-zinc-900 placeholder:text-zinc-400 focus:border-violet-400'
        } outline-none transition-colors`}
      />

      <button
        onClick={onSend}
        disabled={isSending || !value.trim()}
        className={`p-2 rounded-xl transition-all ${
          isSending || !value.trim()
            ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
            : 'bg-gradient-to-r from-violet-600 to-cyan-500 text-white hover:opacity-90'
        }`}
      >
        {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
      </button>
    </div>
  );
}

function IdentityCard({ identity, icon, isDark }: { identity: Identity; icon: React.ReactNode; isDark: boolean }) {
  return (
    <div className={`rounded-xl p-3 text-xs ${isDark ? 'bg-zinc-950/50 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`flex items-center justify-center w-6 h-6 rounded-full ${
          identity.role === 'agent'
            ? isDark ? 'bg-cyan-500/20 text-cyan-400' : 'bg-cyan-100 text-cyan-600'
            : isDark ? 'bg-violet-500/20 text-violet-400' : 'bg-violet-100 text-violet-600'
        }`}>
          {icon}
        </div>
        <span className={`font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{identity.role === 'agent' ? 'Agent' : 'Human'}</span>
        <Check className="w-3 h-3 text-emerald-400 ml-auto" />
      </div>
      <div className={`space-y-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        <div className="flex justify-between">
          <span>Username</span>
          <span className={`font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{identity.username}</span>
        </div>
        <div className="flex justify-between">
          <span>ID</span>
          <span className={`font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{identity.imUserId}</span>
        </div>
        <div className="flex justify-between">
          <span>Token</span>
          <span className={`font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{identity.token.slice(0, 10)}...</span>
        </div>
      </div>
    </div>
  );
}
