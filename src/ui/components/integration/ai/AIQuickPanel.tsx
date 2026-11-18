/**
 * AIQuickPanel.tsx
 * Docked / Global side panel for chatting with AI across the entire Deplao app.
 * - Works both inside a conversation (auto-injects up to 1000 thread messages) AND globally
 *   across Dashboard, CRM, ERP, Workflow, Analytics, Settings, etc.
 * - Supports multi-dimensional context filter (time range, threads, labels/tags, 1-1/group, senders).
 * - Renders Markdown (tables, code blocks, lists) + Tool Calling traces + Confirmation Cards.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { parseStructuredResponse } from '../../../../shared/ai/aiUtils';
import type {
  AIChatMessageMetadata,
  AIContextFilter,
  AIExecutedToolTrace,
  AIPendingToolAction,
} from '../../../../models/ai/ai';
import AIMarkdownRenderer from './AIMarkdownRenderer';
import { ExecutedToolsBadge, PendingActionList } from './AIToolCards';
import AIContextFilterPanel, { summarizeContextFilter } from './AIContextFilterPanel';
import {
  BotIcon,
  ClipboardListIcon,
  EditIcon,
  FileTextIcon,
  HelpCircleIcon,
  LightningIcon,
  SparklesIcon,
  TrashIcon,
  WrenchIcon,
} from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

interface ChatMsg {
  dbId?: number;
  role: 'user' | 'assistant';
  content: string;
  segments?: Array<{ type: 'text' | 'image'; content: any }>;
  meta?: AIChatMessageMetadata;
}

interface AssistantSummary {
  id: string;
  name: string;
  platform: string;
  model: string;
  isDefault: boolean;
  enabled: boolean;
  contextMessageCount?: number;
}

interface SessionItem {
  id: string;
  title?: string;
  assistant_id: string;
  last_message_at: number;
  context_filter_json?: string | null;
}

const PLATFORM_ICON_TEXTS: Record<string, string> = {
  openai: '[AI]', gemini: '[G]', claude: '[C]', deepseek: '[DS]', grok: '[Grok]', mistral: '[M]', '9router': '[9R]', openrouter: '[OR]',
};

const clampContextCount = (value: number) => Math.min(1000, Math.max(1, Math.round(value)));

export default function AIQuickPanel({ onClose }: { onClose: () => void }) {
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingAssistants, setLoadingAssistants] = useState(true);
  const [assistantContextMsgCount, setAssistantContextMsgCount] = useState(30);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { activeThreadId } = useChatStore();
  const { activeAccountId } = useAccountStore();
  const {
    view,
    setView,
    aiAutoInjectZaloContext,
    setAiAutoInjectZaloContext,
    aiQuickPanelContextCountOverride,
    setAiQuickPanelContextCountOverride,
    aiToolsEnabled,
    setAiToolsEnabled,
    aiThreadAssistantMap,
    setAiThreadAssistant,
  } = useAppStore();

  const isThreadView = view === 'chat' && !!(activeAccountId && activeThreadId);
  const scopeZaloId = isThreadView ? activeAccountId! : '__global__';
  const scopeThreadId = isThreadView ? activeThreadId! : '__panel__';

  const effectiveContextMsgCount = aiQuickPanelContextCountOverride ?? assistantContextMsgCount;

  const [contextFilter, setContextFilter] = useState<AIContextFilter>(() => ({
    enabled: aiAutoInjectZaloContext,
    mode: isThreadView ? (aiAutoInjectZaloContext ? 'current_thread' : 'off') : 'off',
    timePreset: '7d',
    threadType: 'all',
    limit: effectiveContextMsgCount,
  }));

  // Keep contextFilter mode aligned when switching between Chat thread and Global view
  useEffect(() => {
    setContextFilter(prev => {
      if (prev.mode === 'custom_filter') return prev;
      if (isThreadView) {
        return {
          ...prev,
          enabled: aiAutoInjectZaloContext,
          mode: aiAutoInjectZaloContext ? 'current_thread' : 'off',
          limit: effectiveContextMsgCount,
        };
      }
      return {
        ...prev,
        enabled: false,
        mode: 'off',
      };
    });
  }, [isThreadView, aiAutoInjectZaloContext, effectiveContextMsgCount]);

  // Load assistants + restore cached assistant
  useEffect(() => {
    (async () => {
      setLoadingAssistants(true);
      try {
        const res = await ipc.ai?.listAssistants();
        if (res?.success) {
          const enabled = (res.assistants || []).filter((a: AssistantSummary) => a.enabled);
          setAssistants(enabled);
          const threadKey = isThreadView ? `${activeAccountId}_${activeThreadId}` : '__global__';
          const cachedId = aiThreadAssistantMap[threadKey] || '';
          const cached = cachedId ? enabled.find((a: AssistantSummary) => a.id === cachedId) : null;
          const def = cached || enabled.find((a: AssistantSummary) => a.isDefault) || enabled[0];
          if (def) setActiveId(def.id);
        }
      } catch {}
      setLoadingAssistants(false);
    })();
  }, []);

  // Auto scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const loadMessagesForConversation = useCallback(async (convId: string) => {
    try {
      const msgRes = await ipc.ai?.getConversationMessages({ conversationId: convId });
      if (msgRes?.success && msgRes.messages?.length > 0) {
        const loaded: ChatMsg[] = msgRes.messages.map((m: any) => ({
          dbId: m.id,
          role: m.role,
          content: m.content,
          segments: m.segments_json ? JSON.parse(m.segments_json) : undefined,
          meta: m.metadata_json ? JSON.parse(m.metadata_json) : undefined,
        }));
        setMessages(loaded);
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!ipc.ai?.listAllConversations) return;
    try {
      const res = await ipc.ai.listAllConversations({
        zaloId: scopeZaloId,
        threadId: scopeThreadId,
        assistantId: activeId || undefined,
        limit: 30,
      });
      if (res?.success) setSessions(res.conversations || []);
    } catch {}
  }, [scopeZaloId, scopeThreadId, activeId]);

  // Load conversation when scope OR assistant changes
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setConversationId(null);
      return;
    }

    const threadKey = isThreadView ? `${activeAccountId}_${activeThreadId}` : '__global__';
    setAiThreadAssistant(threadKey, activeId);

    const currentAssistant = assistants.find(a => a.id === activeId);
    const initialDefault = clampContextCount(currentAssistant?.contextMessageCount || 30);
    setAssistantContextMsgCount(initialDefault);

    (async () => {
      try {
        const res = await ipc.ai?.getAssistant(activeId);
        if (res?.success && res.assistant) {
          setAssistantContextMsgCount(clampContextCount(res.assistant.contextMessageCount || 30));
        }
      } catch {}

      try {
        const convRes = await ipc.ai?.getOrCreateConversation({
          zaloId: scopeZaloId,
          threadId: scopeThreadId,
          assistantId: activeId,
          scope: isThreadView ? 'thread' : 'panel',
        });
        if (convRes?.success && convRes.conversation) {
          setConversationId(convRes.conversation.id);
          await loadMessagesForConversation(convRes.conversation.id);
        } else {
          setConversationId(null);
          setMessages([]);
        }
      } catch {
        setConversationId(null);
        setMessages([]);
      }
      refreshSessions();
    })();
  }, [activeId, scopeZaloId, scopeThreadId, assistants, isThreadView]);

  /** Fetch context from current active thread (up to 1000 messages from DB) */
  const getCurrentThreadContext = useCallback(async (limitCount: number): Promise<{ text: string | null; summary: string }> => {
    if (!activeAccountId || !activeThreadId) return { text: null, summary: '' };
    const key = `${activeAccountId}_${activeThreadId}`;
    let msgs: any[] = useChatStore.getState().messages[key] || [];
    const targetLimit = clampContextCount(limitCount);

    if (msgs.length < targetLimit) {
      try {
        const PAGE = 100;
        const seen = new Set<string>();
        const all: any[] = [];
        let before: number | undefined;
        for (let i = 0; i < 40 && all.length < targetLimit; i++) {
          const res: any = await DataAccessor.getMessages({
            zaloId: activeAccountId, threadId: activeThreadId, limit: PAGE, offset: 0, ...(before ? { before } : {}),
          });
          const page: any[] = res?.messages || res?.items || [];
          let added = 0;
          for (const m of page) {
            const id = String(m.msg_id ?? m.id ?? `${m.timestamp}_${all.length}`);
            if (seen.has(id)) continue;
            seen.add(id); all.push(m); added++;
          }
          if (added === 0 || page.length === 0) break;
          const oldest = Math.min(...page.map((m: any) => Number(m.timestamp) || Infinity));
          if (!Number.isFinite(oldest)) break;
          before = oldest;
        }
        if (all.length > msgs.length) msgs = all.reverse();
      } catch {}
    }

    const recent = msgs.slice(-targetLimit);
    if (recent.length === 0) return { text: null, summary: '' };
    const pad = (n: number) => String(n).padStart(2, '0');
    const contextText = recent.map((m: any) => {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content?.msg || JSON.stringify(m.content));
      const ts = Number(m.timestamp);
      const d = Number.isFinite(ts) && ts > 0 ? new Date(ts < 1e12 ? ts * 1000 : ts) : null;
      const time = d ? `[${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}] ` : '';
      const who = m.is_sent ? 'Tôi' : (m.sender_name || (m.sender_id ? `Khách ${m.sender_id}` : 'Khách'));
      return `${time}${who}: ${content}`;
    }).join('\n');
    return {
      text: contextText ? `[Ngữ cảnh hội thoại hiện tại - ${recent.length} tin nhắn gần nhất]\n${contextText}` : null,
      summary: `${recent.length} tin từ hội thoại hiện tại`,
    };
  }, [activeAccountId, activeThreadId]);

  /** Resolve context according to active AIContextFilter */
  const resolveContextBlock = useCallback(async (forceOn = false): Promise<{ block: string | undefined; summary: string }> => {
    const effectiveMode = contextFilter.mode || (isThreadView ? 'current_thread' : 'off');
    if (!forceOn && (effectiveMode === 'off' || contextFilter.enabled === false)) {
      return { block: undefined, summary: '' };
    }

    if (effectiveMode === 'custom_filter') {
      try {
        const res = await ipc.ai?.queryContextMessages?.(contextFilter);
        if (res?.success && res.formattedContext) {
          const summary = `${res.count} tin / ${res.threadCount} hội thoại`;
          return {
            block: `[Ngữ cảnh tin nhắn đã lọc (${summary})]\n${res.formattedContext}`,
            summary,
          };
        }
      } catch {}
      return { block: undefined, summary: '' };
    }

    if (isThreadView) {
      const limit = contextFilter.limit || effectiveContextMsgCount;
      const cur = await getCurrentThreadContext(limit);
      return { block: cur.text || undefined, summary: cur.summary };
    }
    return { block: undefined, summary: '' };
  }, [contextFilter, isThreadView, effectiveContextMsgCount, getCurrentThreadContext]);

  const handleFilterChange = useCallback((next: AIContextFilter) => {
    setContextFilter(next);
    if (next.mode === 'current_thread') {
      setAiAutoInjectZaloContext(true);
      if (next.limit) setAiQuickPanelContextCountOverride(next.limit);
    } else if (next.mode === 'off') {
      setAiAutoInjectZaloContext(false);
    }
  }, [setAiAutoInjectZaloContext, setAiQuickPanelContextCountOverride]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId || loading) return;

    const userMsg: ChatMsg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    let convId = conversationId;
    if (!convId) {
      try {
        const convRes = await ipc.ai?.getOrCreateConversation({
          zaloId: scopeZaloId,
          threadId: scopeThreadId,
          assistantId: activeId,
          scope: isThreadView ? 'thread' : 'panel',
        });
        if (convRes?.success && convRes.conversation) {
          convId = convRes.conversation.id;
          setConversationId(convId);
        }
      } catch {}
    }
    if (convId) {
      ipc.ai?.addConversationMessage({ conversationId: convId, role: 'user', content: text }).catch(() => {});
    }

    try {
      const panelMsgs = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));
      const { block, summary } = await resolveContextBlock(false);

      let res: any;
      if (ipc.ai?.chatWithTools) {
        res = await ipc.ai.chatWithTools({
          assistantId: activeId,
          messages: panelMsgs,
          enableTools: aiToolsEnabled,
          contextBlock: block,
        });
      } else {
        const fallbackMsgs = block
          ? [{ role: 'user', content: block }, { role: 'assistant', content: 'Đã nắm ngữ cảnh.' }, ...panelMsgs]
          : panelMsgs;
        res = await ipc.ai?.chat(activeId, fallbackMsgs, false);
      }

      if (res?.success && (res.result || res.pendingActions?.length)) {
        const rawText = res.result || '';
        const maybeSegments = parseStructuredResponse(rawText);
        const meta: AIChatMessageMetadata = {
          executedTools: res.executedTools || [],
          pendingActions: res.pendingActions || [],
          totalTokens: res.totalTokens,
          contextSummary: summary || undefined,
        };
        const assistantMsg: ChatMsg = {
          role: 'assistant',
          content: rawText,
          segments: maybeSegments || undefined,
          meta,
        };

        let savedMsgId: number | undefined;
        if (convId) {
          try {
            const addRes = await ipc.ai?.addConversationMessage({
              conversationId: convId,
              role: 'assistant',
              content: rawText,
              segmentsJson: maybeSegments ? JSON.stringify(maybeSegments) : undefined,
              metadataJson: JSON.stringify(meta),
            });
            savedMsgId = addRes?.id;
          } catch {}
        }

        setMessages(prev => [...prev, { ...assistantMsg, dbId: savedMsgId }]);
        refreshSessions();
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${res?.error || tr('Không có phản hồi')}` }]);
      }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    }
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [input, activeId, loading, messages, conversationId, scopeZaloId, scopeThreadId, isThreadView, resolveContextBlock, aiToolsEnabled, refreshSessions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertToChat = (text: string) => {
    window.dispatchEvent(new CustomEvent('ai:insertToChat', { detail: { text } }));
  };

  const handleNewChat = useCallback(async () => {
    if (loading || !activeId) return;
    try {
      if (ipc.ai?.createConversation) {
        const res = await ipc.ai.createConversation({
          zaloId: scopeZaloId,
          threadId: scopeThreadId,
          assistantId: activeId,
          scope: isThreadView ? 'thread' : 'panel',
        });
        if (res?.success && res.conversation) {
          setConversationId(res.conversation.id);
          setMessages([]);
          refreshSessions();
          setTimeout(() => inputRef.current?.focus(), 100);
          return;
        }
      }
    } catch {}
    setMessages([]);
    setConversationId(null);
  }, [loading, activeId, scopeZaloId, scopeThreadId, isThreadView, refreshSessions]);

  const handleDeleteSession = useCallback(async (id: string) => {
    if (!id || loading) return;
    try {
      await ipc.ai?.deleteConversation({ conversationId: id });
      if (id === conversationId) {
        setMessages([]);
        setConversationId(null);
      }
      refreshSessions();
    } catch {}
  }, [loading, conversationId, refreshSessions]);

  const handleSummarize = useCallback(async () => {
    if (!activeId || loading) return;
    const { block, summary } = await resolveContextBlock(true);
    if (!block) return;
    setLoading(true);
    const userMsg: ChatMsg = { role: 'user', content: tr('Tóm tắt ngữ cảnh đã chọn ({{v1}})', { v1: summary || tr('ngữ cảnh') }) };
    setMessages(prev => [...prev, userMsg]);
    try {
      const prompt = `Hãy tóm tắt chi tiết nội dung hội thoại dưới đây bằng Markdown:
- **Chủ đề chính & bối cảnh**
- **Yêu cầu / vấn đề của khách hàng**
- **Những điểm đã thống nhất & việc cần làm tiếp theo**
- **Trạng thái hiện tại**`;
      const res = ipc.ai?.chatWithTools
        ? await ipc.ai.chatWithTools({
            assistantId: activeId,
            messages: [{ role: 'user', content: prompt }],
            enableTools: false,
            contextBlock: block,
          })
        : await ipc.ai?.chat(activeId, [{ role: 'user', content: `${prompt}\n\n${block}` }], false);
      if (res?.success && res.result) {
        setMessages(prev => [...prev, { role: 'assistant', content: res.result! }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${res?.error || tr('Không có phản hồi')}` }]);
      }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    }
    setLoading(false);
  }, [activeId, loading, resolveContextBlock]);

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

  const contextSummaryText = summarizeContextFilter(contextFilter, isThreadView);

  return (
    <div className="w-full h-full flex flex-col bg-card">
      {/* Header */}
      <div className="px-3.5 py-2.5 border-b border-border flex-shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5 min-w-0">
            <BotIcon className="w-4 h-4 text-purple-400 flex-shrink-0" />
            <span className="truncate">{tr('Trợ lý AI')}</span>
            {!isThreadView && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 font-medium flex-shrink-0">
                {tr('Toàn app')}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setView('ai')}
              className="px-2 py-1 rounded-md text-[11px] bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title={tr('Mở không gian Chat AI toàn màn hình (AI Hub)')}
            >
              {tr('Mở rộng ⤢')}
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              title={tr('Đóng')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Assistant selector */}
        {loadingAssistants ? (
          <div className="text-xs text-muted-foreground">{tr('Đang tải...')}</div>
        ) : assistants.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              {trx('Chưa có trợ lý AI nào.<0/>Tạo trợ lý để bắt đầu hỗ trợ chat thông minh.', { 0: <br/> })}
            </p>
            <button
              onClick={() => {
                const { setView: go, openIntegrationPanelTo } = useAppStore.getState();
                go('integration');
                openIntegrationPanelTo('ai-assistant', 'list');
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
            >
              {trx('<0/> Tạo trợ lý AI ngay', { 0: <SparklesIcon className="w-4 h-4" /> })}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <select
              value={activeId}
              onChange={e => setActiveId(e.target.value)}
              className="flex-1 min-w-0 bg-background border border-input rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:border-blue-500"
            >
              {assistants.map(a => (
                <option key={a.id} value={a.id}>
                  {PLATFORM_ICON_TEXTS[a.platform] || '[AI]'} {a.name} - {a.model}
                  {a.isDefault ? tr(' [Mac dinh]') : ''}
                </option>
              ))}
            </select>
            {sessions.length > 1 && (
              <select
                value={conversationId || ''}
                onChange={e => {
                  const id = e.target.value;
                  if (id) {
                    setConversationId(id);
                    loadMessagesForConversation(id);
                  }
                }}
                className="w-28 bg-background border border-input rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground focus:outline-none focus:border-blue-500"
                title={tr('Chuyển phiên hỏi đáp đã lưu')}
              >
                {sessions.map((s, idx) => (
                  <option key={s.id} value={s.id}>
                    {s.title ? s.title.slice(0, 26) : `${tr('Phiên')} #${sessions.length - idx}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* Controls bar */}
      {activeId && (
        <div className="px-3 py-2 border-b border-border/50 flex-shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setFilterOpen(v => !v)}
              className={`px-2 py-1 rounded-md text-[11px] border transition-colors truncate max-w-[175px] ${
                filterOpen || (contextFilter.mode !== 'off' && contextFilter.enabled !== false)
                  ? 'border-blue-500/50 bg-blue-600/15 text-blue-300'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`}
              title={contextSummaryText}
            >
              🎯 {contextSummaryText}
            </button>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setAiToolsEnabled(!aiToolsEnabled)}
                className={`p-1.5 rounded-md border text-[11px] transition-colors ${
                  aiToolsEnabled
                    ? 'border-emerald-500/50 bg-emerald-600/15 text-emerald-300'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground'
                }`}
                title={aiToolsEnabled ? tr('Tool Calling: Đang bật (AI có thể tự tra cứu CRM/ERP/POS/Tin nhắn)') : tr('Tool Calling: Đang tắt')}
              >
                <WrenchIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleNewChat}
                disabled={loading}
                className="text-[11px] px-2 py-1 rounded-md bg-blue-900/50 text-blue-200 hover:bg-blue-800/60 disabled:opacity-40 transition-colors"
                title={tr('Tạo cuộc trò chuyện AI mới')}
              >
                {tr('+ Mới')}
              </button>
              {conversationId && messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleDeleteSession(conversationId)}
                  disabled={loading}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-muted disabled:opacity-40 transition-colors"
                  title={tr('Xóa phiên chat hiện tại')}
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              )}
              {(isThreadView || contextFilter.mode === 'custom_filter') && (
                <button
                  type="button"
                  onClick={handleSummarize}
                  disabled={loading}
                  className="text-[11px] px-2 py-1 rounded-md bg-purple-900/50 text-purple-200 hover:bg-purple-800/60 disabled:opacity-40 transition-colors inline-flex items-center gap-1"
                  title={tr('AI tóm tắt ngữ cảnh đang chọn')}
                >
                  <FileTextIcon className="w-3.5 h-3.5" />
                  <span>{tr('Tóm tắt')}</span>
                </button>
              )}
            </div>
          </div>

          {filterOpen && (
            <AIContextFilterPanel
              value={contextFilter}
              onChange={handleFilterChange}
              hasActiveThread={isThreadView}
              compact
              onClose={() => setFilterOpen(false)}
            />
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && activeId && (
          <div className="text-center py-8 px-2 space-y-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              {isThreadView
                ? tr('Hỏi bất kỳ điều gì — AI tự nắm ngữ cảnh hội thoại và có thể dùng Tool tra cứu CRM, ERP, POS hoặc lọc tới 1.000 tin nhắn.')
                : tr('Trợ lý AI toàn ứng dụng — mở bộ lọc 🎯 để chọn nhiều hội thoại, khoảng thời gian, nhãn/tag, người gửi hoặc dùng Tool hỏi trực tiếp.')}
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[92%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-background/70 text-foreground border border-border'
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
                <div className="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-border/50 flex-wrap">
                  {isThreadView && (
                    <button
                      onClick={() => {
                        const textToInsert = msg.segments
                          ? msg.segments.filter(s => s.type === 'text').map(s => s.content).join('\n')
                          : msg.content;
                        insertToChat(textToInsert);
                      }}
                      className="text-[10px] px-2 py-0.5 rounded bg-blue-900/40 text-blue-400 hover:bg-blue-800/50 transition-colors inline-flex items-center gap-1"
                      title={tr('Chèn vào ô chat')}
                    >
                      <EditIcon className="w-3 h-3" />
                      <span>{tr('Chèn vào chat')}</span>
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const textToCopy = msg.segments
                        ? msg.segments.filter(s => s.type === 'text').map(s => s.content).join('\n')
                        : msg.content;
                      navigator.clipboard.writeText(textToCopy);
                    }}
                    className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
                    title={tr('Copy')}
                  >
                    <ClipboardListIcon className="w-3 h-3" />
                    <span>{tr('Copy')}</span>
                  </button>
                  {msg.meta?.contextSummary && (
                    <span className="ml-auto text-[10px] text-muted-foreground">{msg.meta.contextSummary}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-background/70 border border-border rounded-xl px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}/>
                <span className="text-[11px] text-muted-foreground ml-1">{tr('Đang xử lý...')}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      {activeId && (
        <div className="px-3 pb-3 pt-1 flex-shrink-0">
          <div className="flex items-end gap-2 bg-background border border-border rounded-xl px-3 py-2 focus-within:border-blue-500 transition-colors">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={tr('Nhập câu hỏi cho trợ lý AI...')}
              rows={1}
              className="flex-1 bg-transparent text-sm text-foreground placeholder-subtle-foreground resize-none outline-none max-h-28 overflow-y-auto"
              style={{ minHeight: '1.5rem' }}
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="w-7 h-7 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center text-white transition-colors flex-shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
