/**
 * AIHubPage.tsx
 * Full-screen AI Workspace ("Chat với Trợ lý AI" như một danh bạ tài khoản).
 * - Left sidebar: danh bạ từng Trợ lý AI + danh sách phiên trò chuyện + nút xem Roadmap Phase 2-3.
 * - Main panel: khung chat Markdown chuẩn, Bộ lọc ngữ cảnh đa chiều (lên đến 1.000 tin),
 *   Tool Calling (tự động tra cứu + thẻ xác nhận hành động), và thẻ gợi ý nhanh.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { getAIPlatformMeta } from './aiPlatformMeta';
import AIMarkdownRenderer from './AIMarkdownRenderer';
import { ExecutedToolsBadge, PendingActionList } from './AIToolCards';
import AIContextFilterPanel, { summarizeContextFilter } from './AIContextFilterPanel';
import AIRoomModal from './AIRoomModal';
import AIRoomChatView from './AIRoomChatView';
import type {
  AIChatMessageMetadata,
  AIContextFilter,
  AIPendingToolAction,
} from '../../../../models/ai/ai';
import type { AIRoom } from '../../../../models/ai/aiRoom';
import {
  BotIcon,
  ClipboardListIcon,
  CloseIcon,
  FileTextIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  TrashIcon,
  UsersIcon,
  WrenchIcon,
} from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';

interface AssistantSummary {
  id: string;
  name: string;
  platform: string;
  model: string;
  isDefault: boolean;
  enabled: boolean;
  contextMessageCount?: number;
}

interface HubSession {
  id: string;
  zalo_id: string;
  thread_id: string;
  assistant_id: string;
  title?: string;
  scope?: string;
  context_filter_json?: string | null;
  last_message_at: number;
  message_count?: number;
}

interface ChatMsg {
  dbId?: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
  segments?: Array<{ type: 'text' | 'image'; content: any }>;
  meta?: AIChatMessageMetadata;
}

const DEFAULT_HUB_FILTER: AIContextFilter = {
  enabled: false,
  mode: 'off',
  timePreset: '7d',
  threadType: 'all',
  limit: 200,
};

function parseFilterJson(raw?: string | null): AIContextFilter {
  if (!raw) return { ...DEFAULT_HUB_FILTER };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_HUB_FILTER, ...parsed };
  } catch {
    return { ...DEFAULT_HUB_FILTER };
  }
}

export default function AIHubPage() {
  const {
    setView,
    openIntegrationPanelTo,
    aiToolsEnabled,
    setAiToolsEnabled,
  } = useAppStore();

  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [loadingAssistants, setLoadingAssistants] = useState(true);
  const [selectedAssistantId, setSelectedAssistantId] = useState<string>('');

  const [rooms, setRooms] = useState<AIRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<AIRoom | null>(null);

  const [sessions, setSessions] = useState<HubSession[]>([]);
  const [sessionScopeFilter, setSessionScopeFilter] = useState<'hub' | 'all'>('hub');
  const [sessionSearch, setSessionSearch] = useState('');
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [contextFilter, setContextFilter] = useState<AIContextFilter>({ ...DEFAULT_HUB_FILTER });
  const [filterOpen, setFilterOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [roadmapOpen, setRoadmapOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load enabled assistants
  useEffect(() => {
    (async () => {
      setLoadingAssistants(true);
      try {
        const res = await ipc.ai?.listAssistants();
        if (res?.success) {
          const enabled = (res.assistants || []).filter((a: AssistantSummary) => a.enabled);
          setAssistants(enabled);
          const def = enabled.find((a: AssistantSummary) => a.isDefault) || enabled[0];
          if (def) setSelectedAssistantId(def.id);
        }
      } catch {}
      setLoadingAssistants(false);
    })();
  }, []);

  const loadSessions = useCallback(async () => {
    if (!ipc.ai?.listAllConversations) return;
    try {
      const res = await ipc.ai.listAllConversations({
        scope: sessionScopeFilter === 'hub' ? 'hub' : undefined,
        limit: 100,
      });
      if (res?.success) setSessions(res.conversations || []);
    } catch {}
  }, [sessionScopeFilter]);

  const loadRooms = useCallback(async () => {
    if (!ipc.ai?.listRooms) return;
    try {
      const res = await ipc.ai.listRooms();
      if (res?.success) setRooms(res.rooms || []);
    } catch {}
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    loadRooms();
    const unsub = ipc.on?.('ai:roomUpdated', () => {
      loadRooms();
    });
    return () => { unsub?.(); };
  }, [loadRooms]);

  const loadConversationMessages = useCallback(async (convId: string) => {
    try {
      const res = await ipc.ai?.getConversationMessages({ conversationId: convId });
      if (res?.success && res.messages) {
        setMessages(res.messages.map((m: any) => ({
          dbId: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          segments: m.segments_json ? JSON.parse(m.segments_json) : undefined,
          meta: m.metadata_json ? JSON.parse(m.metadata_json) : undefined,
        })));
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    }
  }, []);

  // On assistant initial load, pick latest hub session for that assistant or keep empty ready state
  useEffect(() => {
    if (!selectedAssistantId || activeConvId) return;
    const match = sessions.find(s => s.assistant_id === selectedAssistantId && (s.scope === 'hub' || !s.scope));
    if (match) {
      setActiveConvId(match.id);
      setContextFilter(parseFilterJson(match.context_filter_json));
      loadConversationMessages(match.id);
    }
  }, [selectedAssistantId, sessions, activeConvId, loadConversationMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const handleSelectAssistant = (assistantId: string) => {
    setSelectedRoomId(null);
    setSelectedAssistantId(assistantId);
    const match = sessions.find(s => s.assistant_id === assistantId);
    if (match) {
      setActiveConvId(match.id);
      setContextFilter(parseFilterJson(match.context_filter_json));
      loadConversationMessages(match.id);
    } else {
      setActiveConvId(null);
      setMessages([]);
      setContextFilter({ ...DEFAULT_HUB_FILTER });
    }
  };

  const handleSelectSession = (s: HubSession) => {
    setSelectedRoomId(null);
    setActiveConvId(s.id);
    if (s.assistant_id && assistants.some(a => a.id === s.assistant_id)) {
      setSelectedAssistantId(s.assistant_id);
    }
    setContextFilter(parseFilterJson(s.context_filter_json));
    loadConversationMessages(s.id);
  };

  const handleSelectRoom = (roomId: string) => {
    setSelectedRoomId(roomId);
  };

  const handleNewSession = useCallback(async (assistantOverride?: string) => {
    const aid = assistantOverride || selectedAssistantId;
    if (!aid || loading) return;
    try {
      if (ipc.ai?.createConversation) {
        const res = await ipc.ai.createConversation({
          zaloId: '__global__',
          threadId: '__hub__',
          assistantId: aid,
          scope: 'hub',
          contextFilterJson: JSON.stringify(contextFilter),
        });
        if (res?.success && res.conversation) {
          setActiveConvId(res.conversation.id);
          setMessages([]);
          await loadSessions();
          setTimeout(() => inputRef.current?.focus(), 80);
          return;
        }
      }
    } catch {}
    setActiveConvId(null);
    setMessages([]);
  }, [selectedAssistantId, loading, contextFilter, loadSessions]);

  const handleDeleteSession = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (loading) return;
    try {
      await ipc.ai?.deleteConversation({ conversationId: convId });
      if (activeConvId === convId) {
        setActiveConvId(null);
        setMessages([]);
      }
      loadSessions();
    } catch {}
  };

  const handleContextFilterChange = (next: AIContextFilter) => {
    setContextFilter(next);
    if (activeConvId && ipc.ai?.updateConversationMeta) {
      ipc.ai.updateConversationMeta({
        conversationId: activeConvId,
        contextFilterJson: JSON.stringify(next),
      }).catch(() => {});
    }
  };

  const resolveContextBlock = useCallback(async (forceOn = false): Promise<{ block?: string; summary: string }> => {
    const mode = contextFilter.mode || 'off';
    if (!forceOn && (mode === 'off' || contextFilter.enabled === false)) {
      return { block: undefined, summary: '' };
    }
    const queryFilter: AIContextFilter = mode === 'custom_filter'
      ? contextFilter
      : { ...contextFilter, enabled: true, mode: 'custom_filter', timePreset: contextFilter.timePreset || '7d', limit: contextFilter.limit || 200 };
    try {
      const res = await ipc.ai?.queryContextMessages?.(queryFilter);
      if (res?.success && res.formattedContext) {
        const summary = `${res.count} tin / ${res.threadCount} hội thoại`;
        return {
          block: `[Ngữ cảnh tin nhắn đã lọc (${summary})]\n${res.formattedContext}`,
          summary,
        };
      }
    } catch {}
    return { block: undefined, summary: '' };
  }, [contextFilter]);

  const sendMessage = useCallback(async (promptText?: string) => {
    const text = (promptText ?? input).trim();
    if (!text || !selectedAssistantId || loading) return;

    const userMsg: ChatMsg = { role: 'user', content: text, createdAt: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    if (promptText === undefined) setInput('');
    setLoading(true);

    let convId = activeConvId;
    if (!convId) {
      try {
        if (ipc.ai?.createConversation) {
          const res = await ipc.ai.createConversation({
            zaloId: '__global__',
            threadId: '__hub__',
            assistantId: selectedAssistantId,
            scope: 'hub',
            contextFilterJson: JSON.stringify(contextFilter),
          });
          if (res?.success && res.conversation) {
            convId = res.conversation.id;
            setActiveConvId(convId);
          }
        } else {
          const res = await ipc.ai?.getOrCreateConversation({
            zaloId: '__global__',
            threadId: '__hub__',
            assistantId: selectedAssistantId,
            scope: 'hub',
          });
          if (res?.success && res.conversation) {
            convId = res.conversation.id;
            setActiveConvId(convId);
          }
        }
      } catch {}
    }

    if (convId) {
      ipc.ai?.addConversationMessage({ conversationId: convId, role: 'user', content: text }).catch(() => {});
    }

    try {
      const historyToSend = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));
      const { block, summary } = await resolveContextBlock(false);

      const res = ipc.ai?.chatWithTools
        ? await ipc.ai.chatWithTools({
            assistantId: selectedAssistantId,
            messages: historyToSend,
            enableTools: aiToolsEnabled,
            contextBlock: block,
          })
        : await ipc.ai?.chat(
            selectedAssistantId,
            block
              ? [{ role: 'user', content: block }, { role: 'assistant', content: 'Đã nắm ngữ cảnh.' }, ...historyToSend]
              : historyToSend,
            false,
          );

      if (res?.success && (res.result || (res as any).pendingActions?.length)) {
        const rawText = res.result || '';
        const meta: AIChatMessageMetadata = {
          executedTools: (res as any).executedTools || [],
          pendingActions: (res as any).pendingActions || [],
          totalTokens: res.totalTokens,
          contextSummary: summary || undefined,
        };
        let savedId: number | undefined;
        if (convId) {
          try {
            const addRes = await ipc.ai?.addConversationMessage({
              conversationId: convId,
              role: 'assistant',
              content: rawText,
              metadataJson: JSON.stringify(meta),
            });
            savedId = addRes?.id;
          } catch {}
        }
        setMessages(prev => [...prev, {
          dbId: savedId,
          role: 'assistant',
          content: rawText,
          createdAt: Date.now(),
          meta,
        }]);
        loadSessions();
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${res?.error || tr('Không có phản hồi')}`, createdAt: Date.now() }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err?.message || String(err)}`, createdAt: Date.now() }]);
    }
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [input, selectedAssistantId, loading, activeConvId, contextFilter, messages, resolveContextBlock, aiToolsEnabled, loadSessions]);

  const handleSummarizeContext = useCallback(async () => {
    if (!selectedAssistantId || loading) return;
    if (contextFilter.mode !== 'custom_filter' || contextFilter.enabled === false) {
      setFilterOpen(true);
      return;
    }
    await sendMessage('Hãy tóm tắt và phân tích chi tiết các tin nhắn trong bộ lọc ngữ cảnh hiện tại thành bảng tổng hợp: chủ đề chính, khách hàng nổi bật, vấn đề tồn đọng và đề xuất hành động.');
  }, [selectedAssistantId, loading, contextFilter, sendMessage]);

  const updatePendingAction = useCallback((msgIndex: number, updated: AIPendingToolAction) => {
    setMessages(prev => prev.map((m, idx) => {
      if (idx !== msgIndex) return m;
      const nextActions = (m.meta?.pendingActions || []).map(a => a.id === updated.id ? updated : a);
      const nextMeta: AIChatMessageMetadata = { ...(m.meta || {}), pendingActions: nextActions };
      if (m.dbId && ipc.ai?.updateMessageMeta) {
        ipc.ai.updateMessageMeta({ messageId: m.dbId, metadataJson: JSON.stringify(nextMeta) }).catch(() => {});
      }
      return { ...m, meta: nextMeta };
    }));
  }, []);

  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    return sessions.filter(s => {
      if (sessionScopeFilter === 'hub' && s.scope && s.scope !== 'hub' && s.scope !== 'panel') return false;
      if (q && !(s.title || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sessions, sessionScopeFilter, sessionSearch]);

  const activeAssistant = assistants.find(a => a.id === selectedAssistantId);
  const activeMeta = activeAssistant ? getAIPlatformMeta(activeAssistant.platform) : null;
  const filterSummary = summarizeContextFilter(contextFilter, false);

  const starterPrompts = [
    {
      title: tr('Tổng hợp tin nhắn 7 ngày'),
      prompt: tr('Dùng tool tra cứu các hội thoại gần đây và tóm tắt những khách hàng đang chờ phản hồi hoặc hỏi giá.'),
    },
    {
      title: tr('Kiểm tra việc & lịch ERP'),
      prompt: tr('Kiểm tra danh sách công việc (Task) và lịch hẹn ERP trong 7 ngày tới, sắp xếp theo mức độ ưu tiên.'),
    },
    {
      title: tr('Tra cứu khách hàng CRM'),
      prompt: tr('Liệt kê các khách hàng gần đây kèm nhãn và ghi chú CRM để mình nắm tình hình chăm sóc.'),
    },
    {
      title: tr('Giao việc / Đặt lịch tự động'),
      prompt: tr('Giúp mình tạo 1 công việc theo dõi khách hàng ưu tiên cao vào chiều mai.'),
    },
  ];

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* ── Left Sidebar: Assistants & Conversation History ───────────────────── */}
      <aside className="w-72 flex-shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <BotIcon className="w-5 h-5 text-purple-400 flex-shrink-0" />
            <h1 className="text-sm font-bold text-foreground truncate">{tr('Trợ lý AI Hub')}</h1>
          </div>
          <button
            type="button"
            onClick={() => {
              setView('integration');
              openIntegrationPanelTo('ai-assistant', 'list');
            }}
            className="text-[11px] px-2 py-1 rounded-lg bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title={tr('Quản lý / Tạo trợ lý AI')}
          >
            {tr('+ Trợ lý')}
          </button>
        </div>

        {/* Multi-AI & Bridged Rooms (Phase 2 & 3) */}
        <div className="px-3 py-2.5 border-b border-border/70">
          <div className="flex items-center justify-between gap-2 mb-2 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-300">
              {tr('Nhóm AI & Đa kênh')} ({rooms.length})
            </span>
            <button
              type="button"
              onClick={() => { setEditingRoom(null); setRoomModalOpen(true); }}
              className="text-[10px] px-2 py-0.5 rounded-md bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors"
            >
              {tr('+ Tạo nhóm')}
            </button>
          </div>
          {rooms.length === 0 ? (
            <button
              type="button"
              onClick={() => { setEditingRoom(null); setRoomModalOpen(true); }}
              className="w-full py-2 px-2.5 rounded-xl border border-dashed border-purple-500/35 hover:border-purple-400/60 bg-purple-950/10 text-[11px] text-purple-300/90 hover:text-purple-200 transition-colors text-left"
            >
              {tr('+ Tạo nhóm nhiều AI hoặc nối Zalo / FB / Telegram')}
            </button>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto pr-0.5">
              {rooms.map(r => {
                const selected = r.id === selectedRoomId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => handleSelectRoom(r.id)}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-left transition-colors border ${
                      selected
                        ? 'bg-purple-600/20 border-purple-500/50 text-foreground'
                        : 'border-transparent hover:bg-muted text-foreground/85'
                    }`}
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-white ${
                      r.bridges.length > 0 ? 'bg-gradient-to-br from-purple-600 to-blue-600' : 'bg-purple-600'
                    }`}>
                      <UsersIcon className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold truncate">{r.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {r.members.length} AI{r.bridges.length > 0 ? ` · ${r.bridges.length} kênh` : ''}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Assistants contact list */}
        <div className="px-3 py-2.5 border-b border-border/70">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
            {tr('Danh bạ Trợ lý AI')} ({assistants.length})
          </div>
          {loadingAssistants ? (
            <div className="text-xs text-muted-foreground px-1 py-2">{tr('Đang tải...')}</div>
          ) : assistants.length === 0 ? (
            <div className="text-xs text-muted-foreground px-1 py-2">
              {tr('Chưa có trợ lý AI nào được bật.')}
            </div>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto pr-0.5">
              {assistants.map(a => {
                const meta = getAIPlatformMeta(a.platform);
                const selected = !selectedRoomId && a.id === selectedAssistantId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => handleSelectAssistant(a.id)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors border ${
                      selected
                        ? 'bg-blue-600/15 border-blue-500/40 text-foreground'
                        : 'border-transparent hover:bg-muted text-foreground/85'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-lg ${meta.color} text-white flex items-center justify-center flex-shrink-0`}>
                      {meta.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold truncate flex items-center gap-1.5">
                        <span className="truncate">{a.name}</span>
                        {a.isDefault && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 flex-shrink-0">
                            {tr('Mặc định')}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">{meta.label} · {a.model}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Sessions history */}
        <div className="flex-1 min-h-0 flex flex-col px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 mb-2 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {tr('Lịch sử hỏi đáp')}
            </span>
            <button
              type="button"
              onClick={() => handleNewSession()}
              disabled={!selectedAssistantId || loading}
              className="text-[11px] px-2 py-0.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium transition-colors"
            >
              {tr('+ Cuộc mới')}
            </button>
          </div>

          <div className="flex items-center gap-1 mb-2">
            <div className="flex-1 flex items-center gap-1.5 bg-background border border-input rounded-lg px-2 py-1">
              <SearchIcon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <input
                type="text"
                value={sessionSearch}
                onChange={e => setSessionSearch(e.target.value)}
                placeholder={tr('Tìm phiên chat...')}
                className="w-full bg-transparent text-[11px] outline-none text-foreground"
              />
            </div>
            <button
              type="button"
              onClick={() => setSessionScopeFilter(s => s === 'hub' ? 'all' : 'hub')}
              className="px-2 py-1 rounded-lg border border-border bg-background text-[10px] text-muted-foreground hover:text-foreground"
              title={tr('Chuyển giữa phiên AI Hub và tất cả phiên (gồm trong hội thoại)')}
            >
              {sessionScopeFilter === 'hub' ? 'Hub' : tr('Tất cả')}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 pr-0.5">
            {filteredSessions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground text-center py-6">
                {tr('Chưa có phiên trò chuyện nào.')}
              </p>
            ) : (
              filteredSessions.map(s => {
                const isSelected = s.id === activeConvId;
                const aObj = assistants.find(a => a.id === s.assistant_id);
                return (
                  <div
                    key={s.id}
                    onClick={() => handleSelectSession(s)}
                    className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                      isSelected ? 'bg-muted text-foreground' : 'hover:bg-muted/60 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">
                        {s.title || tr('Cuộc trò chuyện mới')}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {aObj?.name || 'AI'} · {new Date(s.last_message_at).toLocaleDateString('vi-VN')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={e => handleDeleteSession(s.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background text-muted-foreground hover:text-red-400 transition-all"
                      title={tr('Xóa')}
                    >
                      <TrashIcon className="w-3 h-3" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Phase 2-3 Roadmap teaser */}
        <div className="p-3 border-t border-border bg-muted/20">
          <button
            type="button"
            onClick={() => setRoadmapOpen(true)}
            className="w-full p-2.5 rounded-xl border border-purple-500/30 bg-purple-950/20 hover:bg-purple-950/35 text-left transition-colors"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-purple-300">
              <UsersIcon className="w-4 h-4 flex-shrink-0" />
              <span>{tr('Nhóm AI & Đa kênh (Phase 2–3)')}</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
              {tr('Xem thiết kế & lộ trình phòng chat nhiều AI + Bridge Zalo / Facebook / Telegram.')}
            </p>
          </button>
        </div>
      </aside>

      {/* ── Main Chat Workspace ──────────────────────────────────────────────── */}
      {(() => {
        const activeRoom = selectedRoomId ? rooms.find(r => r.id === selectedRoomId) : null;
        if (activeRoom) {
          return (
            <AIRoomChatView
              room={activeRoom}
              onEditRoom={() => { setEditingRoom(activeRoom); setRoomModalOpen(true); }}
              onRoomDeleted={(deletedId) => {
                setRooms(prev => prev.filter(r => r.id !== deletedId));
                setSelectedRoomId(null);
              }}
              onRoomUpdated={(updated) => {
                setRooms(prev => prev.map(r => (r.id === updated.id ? updated : r)));
              }}
            />
          );
        }
        return (
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="px-5 py-3 border-b border-border bg-card/60 flex items-center justify-between gap-3 flex-wrap flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {activeAssistant && activeMeta ? (
              <>
                <div className={`w-9 h-9 rounded-xl ${activeMeta.color} text-white flex items-center justify-center flex-shrink-0`}>
                  {activeMeta.icon}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{activeAssistant.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{activeMeta.label} · {activeAssistant.model}</div>
                </div>
              </>
            ) : (
              <div className="text-sm font-semibold text-muted-foreground">{tr('Chưa chọn trợ lý AI')}</div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setFilterOpen(v => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs border transition-colors flex items-center gap-1.5 ${
                filterOpen || (contextFilter.mode === 'custom_filter' && contextFilter.enabled !== false)
                  ? 'border-blue-500/50 bg-blue-600/15 text-blue-300'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>🎯 {tr('Bộ lọc ngữ cảnh:')} {filterSummary}</span>
            </button>

            <button
              type="button"
              onClick={() => setAiToolsEnabled(!aiToolsEnabled)}
              className={`px-3 py-1.5 rounded-lg text-xs border transition-colors inline-flex items-center gap-1.5 ${
                aiToolsEnabled
                  ? 'border-emerald-500/50 bg-emerald-600/15 text-emerald-300'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
              title={tr('Cho phép AI tự động dùng Tool tra cứu Tin nhắn, CRM, ERP, POS và đề xuất hành động')}
            >
              <WrenchIcon className="w-3.5 h-3.5" />
              <span>{aiToolsEnabled ? tr('Tools: Bật') : tr('Tools: Tắt')}</span>
            </button>

            <button
              type="button"
              onClick={handleSummarizeContext}
              disabled={!selectedAssistantId || loading}
              className="px-3 py-1.5 rounded-lg text-xs bg-purple-900/50 hover:bg-purple-800/60 disabled:opacity-40 text-purple-200 transition-colors inline-flex items-center gap-1.5"
            >
              <FileTextIcon className="w-3.5 h-3.5" />
              <span>{tr('Tóm tắt ngữ cảnh')}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setView('integration');
                openIntegrationPanelTo('ai-assistant', 'list');
              }}
              className="p-2 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground transition-colors"
              title={tr('Cấu hình Trợ lý AI')}
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Collapsible Context Filter Builder */}
        {filterOpen && (
          <div className="px-5 py-3 border-b border-border bg-muted/20 flex-shrink-0 max-h-[55vh] overflow-y-auto">
            <div className="max-w-4xl mx-auto">
              <AIContextFilterPanel
                value={contextFilter}
                onChange={handleContextFilterChange}
                hasActiveThread={false}
                onClose={() => setFilterOpen(false)}
              />
            </div>
          </div>
        )}

        {/* Messages Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
          <div className="max-w-4xl mx-auto space-y-4">
            {!selectedAssistantId ? (
              <div className="text-center py-20 space-y-4">
                <BotIcon className="w-12 h-12 text-purple-400 mx-auto" />
                <h2 className="text-lg font-semibold text-foreground">{tr('Chưa có Trợ lý AI nào được kích hoạt')}</h2>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  {tr('Hãy tạo hoặc bật ít nhất một Trợ lý AI (OpenAI, Claude, Gemini, DeepSeek...) để bắt đầu làm việc.')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setView('integration');
                    openIntegrationPanelTo('ai-assistant', 'list');
                  }}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium inline-flex items-center gap-2"
                >
                  <SparklesIcon className="w-4 h-4" />
                  <span>{tr('Thiết lập Trợ lý AI')}</span>
                </button>
              </div>
            ) : messages.length === 0 ? (
              <div className="py-10 space-y-6">
                <div className="text-center space-y-2">
                  <h2 className="text-xl font-bold text-foreground">
                    {tr('Xin chào! Mình là {{name}}', { name: activeAssistant?.name || 'Trợ lý AI' })}
                  </h2>
                  <p className="text-sm text-muted-foreground max-w-xl mx-auto">
                    {tr('Bạn có thể lọc tới 1.000 tin nhắn đa kênh (Zalo, Facebook, Telegram) theo thời gian, nhãn/tag, nhóm hay người gửi — hoặc để mình tự gọi Tool tra cứu CRM, ERP và POS.')}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl mx-auto">
                  {starterPrompts.map((sp, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => sendMessage(sp.prompt)}
                      className="text-left p-3.5 rounded-xl border border-border bg-card hover:border-blue-500/50 hover:bg-muted/50 transition-all"
                    >
                      <div className="text-xs font-semibold text-foreground">{sp.title}</div>
                      <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{sp.prompt}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-card text-foreground border border-border shadow-sm'
                  }`}>
                    {msg.role === 'assistant' && msg.meta?.executedTools && (
                      <ExecutedToolsBadge tools={msg.meta.executedTools} />
                    )}

                    <AIMarkdownRenderer
                      content={msg.content}
                      segments={msg.segments}
                      isUser={msg.role === 'user'}
                    />

                    {msg.role === 'assistant' && msg.meta?.pendingActions && msg.meta.pendingActions.length > 0 && (
                      <PendingActionList
                        actions={msg.meta.pendingActions}
                        onUpdateAction={updated => updatePendingAction(i, updated)}
                      />
                    )}

                    {msg.role === 'assistant' && !msg.content.startsWith('Error:') && msg.content.trim() && (
                      <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => navigator.clipboard.writeText(msg.content)}
                          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                        >
                          <ClipboardListIcon className="w-3.5 h-3.5" />
                          <span>{tr('Copy nội dung')}</span>
                        </button>
                        {msg.meta?.contextSummary && (
                          <span>· {msg.meta.contextSummary}</span>
                        )}
                        {typeof msg.meta?.totalTokens === 'number' && msg.meta.totalTokens > 0 && (
                          <span className="ml-auto">{msg.meta.totalTokens} tokens</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-card border border-border rounded-2xl px-4 py-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  <span>{tr('Trợ lý AI đang suy nghĩ & kiểm tra dữ liệu...')}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        {selectedAssistantId && (
          <div className="px-5 py-3 border-t border-border bg-card/50 flex-shrink-0">
            <div className="max-w-4xl mx-auto flex items-end gap-2 bg-background border border-border rounded-2xl px-4 py-2.5 focus-within:border-blue-500 transition-colors">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={tr('Nhập yêu cầu hoặc câu hỏi (Enter gửi, Shift+Enter xuống dòng)...')}
                rows={2}
                className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground resize-none outline-none max-h-40 overflow-y-auto"
              />
              <button
                type="button"
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold transition-colors flex-shrink-0"
              >
                {tr('Gửi')}
              </button>
            </div>
          </div>
        )}
      </main>
        );
      })()}

      {/* Room Create / Edit Modal */}
      <AIRoomModal
        open={roomModalOpen}
        initialRoom={editingRoom}
        assistants={assistants}
        onClose={() => { setRoomModalOpen(false); setEditingRoom(null); }}
        onSaved={(savedRoom) => {
          setRooms(prev => {
            const exists = prev.some(r => r.id === savedRoom.id);
            return exists ? prev.map(r => (r.id === savedRoom.id ? savedRoom : r)) : [savedRoom, ...prev];
          });
          setSelectedRoomId(savedRoom.id);
          setRoomModalOpen(false);
          setEditingRoom(null);
        }}
      />

      {/* Phase 2-3 Guide Modal */}
      {roadmapOpen && (
        <div className="fixed inset-0 z-[9995] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setRoadmapOpen(false)}>
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-foreground">{tr('Kiến trúc Trợ lý AI Deplao (Phase 1 – 3)')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{tr('Tài liệu chi tiết lưu tại docs/AI-UPGRADE-ROADMAP.md')}</p>
              </div>
              <button
                type="button"
                onClick={() => setRoadmapOpen(false)}
                className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs leading-relaxed text-foreground/90">
              <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-950/15">
                <div className="font-bold text-emerald-300 mb-1">Phase 1 — Đã hoàn thành</div>
                <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                  <li>Sidebar phải tự đẩy & thu gọn vùng chat + Global AI Drawer (`Ctrl+Shift+A`).</li>
                  <li>Bộ lọc ngữ cảnh đa chiều tới 1.000 tin nhắn (Nhãn Zalo, Nhãn Deplao, Tag CRM, nhiều hội thoại & người gửi).</li>
                  <li>28 Tool Calling CRM, HRM/Phòng ban, Dự án/Công việc, Lịch, Ghi chú, Báo cáo & khóa cứng quyền Xóa.</li>
                </ul>
              </div>
              <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-950/15">
                <div className="font-bold text-emerald-300 mb-1">Phase 2 — Nhóm Chat Nhiều AI Nội Bộ (Đã sẵn sàng)</div>
                <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                  <li>Mời nhiều Trợ lý AI (Sales, CSKH, Kế toán, Quản lý...) vào chung 1 nhóm, đặt `@alias` và nhiệm vụ riêng.</li>
                  <li>Hỗ trợ 3 chế độ phối hợp: `@mention`, Thảo luận vòng tròn (Round-table) và AI Điều phối (Moderator tự giao việc & chốt kết quả).</li>
                </ul>
              </div>
              <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-950/15">
                <div className="font-bold text-emerald-300 mb-1">Phase 3 — Phòng Chat Liên Nền Tảng (Đã sẵn sàng)</div>
                <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                  <li>Kết nối hội thoại Zalo, Facebook Messenger, Telegram và Telegram Bot vào chung 1 phòng họp.</li>
                  <li>Tự động chống lặp tin nhắn (Echo Guard), đi qua hàng đợi `AccountSendQueue`, hỗ trợ Duyệt trước hoặc Tự động chuyển tiếp.</li>
                </ul>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRoadmapOpen(false);
                  setEditingRoom(null);
                  setRoomModalOpen(true);
                }}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition-colors"
              >
                {tr('+ Tạo Nhóm AI / Phòng Đa Kênh ngay')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
