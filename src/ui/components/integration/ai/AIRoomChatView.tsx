/**
 * AIRoomChatView.tsx
 * Group chat interface for Phase 2 (Multi-AI Group Room) and Phase 3 (Cross-Channel Bridged Room).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import AIMarkdownRenderer from './AIMarkdownRenderer';
import { ExecutedToolsBadge, PendingActionList } from './AIToolCards';
import AIContextFilterPanel, { summarizeContextFilter } from './AIContextFilterPanel';
import type { AIContextFilter, AIPendingToolAction } from '../../../../models/ai/ai';
import type { AIRoom, AIRoomMessage, AIRoomRelayDelivery } from '../../../../models/ai/aiRoom';
import {
  BotIcon,
  ClipboardListIcon,
  SettingsIcon,
  TrashIcon,
  UsersIcon,
  WrenchIcon,
} from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';

function channelPill(channel?: string | null): { label: string; cls: string } {
  if (channel === 'facebook') return { label: 'FB', cls: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' };
  if (channel === 'telegram_user') return { label: 'Telegram', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/30' };
  if (channel === 'telegram_bot') return { label: 'TG Bot', cls: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' };
  return { label: 'Zalo', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/30' };
}

function parseFilterJson(raw?: string | null): AIContextFilter {
  if (!raw) return { enabled: false, mode: 'off', timePreset: '7d', threadType: 'all', limit: 200 };
  try {
    return { enabled: false, mode: 'off', timePreset: '7d', threadType: 'all', limit: 200, ...JSON.parse(raw) };
  } catch {
    return { enabled: false, mode: 'off', timePreset: '7d', threadType: 'all', limit: 200 };
  }
}

interface Props {
  room: AIRoom;
  onEditRoom: () => void;
  onRoomDeleted: (roomId: string) => void;
  onRoomUpdated: (room: AIRoom) => void;
}

export default function AIRoomChatView({ room, onEditRoom, onRoomDeleted, onRoomUpdated }: Props) {
  const { showNotification, aiToolsEnabled, setAiToolsEnabled } = useAppStore();

  const [messages, setMessages] = useState<AIRoomMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');

  const [contextFilter, setContextFilter] = useState<AIContextFilter>(() => parseFilterJson(room.contextFilterJson));
  const [filterOpen, setFilterOpen] = useState(false);

  const [triggerAI, setTriggerAI] = useState(true);
  const [selectedBridgeKeys, setSelectedBridgeKeys] = useState<string[]>([]);
  const [relayingMsgId, setRelayingMsgId] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const outboundBridges = useMemo(
    () => (room.bridges || []).filter(b => b.enabled && b.relayDirection !== 'inbound_only'),
    [room.bridges],
  );

  useEffect(() => {
    setContextFilter(parseFilterJson(room.contextFilterJson));
    setSelectedBridgeKeys([]);
  }, [room.id, room.contextFilterJson]);

  const loadMessages = useCallback(async () => {
    if (!ipc.ai?.getRoomMessages) return;
    setLoadingMessages(true);
    try {
      const res = await ipc.ai.getRoomMessages({ roomId: room.id, limit: 200 });
      if (res?.success) setMessages(res.messages || []);
    } catch {}
    setLoadingMessages(false);
  }, [room.id]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Real-time stream from Electron EventBroadcaster ('ai:roomMessage')
  useEffect(() => {
    const unsub = ipc.on?.('ai:roomMessage', (payload: any) => {
      if (!payload || payload.roomId !== room.id || !payload.message) return;
      const incoming: AIRoomMessage = payload.message;
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === incoming.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = incoming;
          return next;
        }
        return [...prev, incoming];
      });
    });
    return () => { unsub?.(); };
  }, [room.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const handleContextFilterChange = (next: AIContextFilter) => {
    setContextFilter(next);
    ipc.ai?.saveRoom?.({
      ...room,
      contextFilterJson: JSON.stringify(next),
    }).then(res => {
      if (res?.success && res.room) onRoomUpdated(res.room);
    }).catch(() => {});
  };

  const resolveContextBlock = useCallback(async (): Promise<{ block?: string; summary: string }> => {
    if (contextFilter.mode !== 'custom_filter' || contextFilter.enabled === false) {
      return { block: undefined, summary: '' };
    }
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
  }, [contextFilter]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !ipc.ai?.sendRoomMessage) return;

    setSending(true);
    setInput('');
    try {
      const { block, summary } = await resolveContextBlock();
      const res = await ipc.ai.sendRoomMessage({
        roomId: room.id,
        content: text,
        targetBridgeKeys: selectedBridgeKeys.length > 0 ? selectedBridgeKeys : undefined,
        triggerAI,
        contextBlock: block,
        contextSummary: summary || undefined,
        enableTools: aiToolsEnabled,
      });
      if (!res?.success) {
        showNotification(res?.error || tr('Gửi tin nhắn thất bại'), 'error');
      }
    } catch (e: any) {
      showNotification(e?.message || String(e), 'error');
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [input, sending, room.id, selectedBridgeKeys, triggerAI, resolveContextBlock, aiToolsEnabled, showNotification]);

  const handleTriggerAI = async (assistantId?: string) => {
    if (sending || !ipc.ai?.triggerRoomAI) return;
    setSending(true);
    try {
      const { block } = await resolveContextBlock();
      const res = await ipc.ai.triggerRoomAI({
        roomId: room.id,
        assistantId,
        contextBlock: block,
        enableTools: aiToolsEnabled,
      });
      if (!res?.success) {
        showNotification(res?.error || tr('Không gọi được trợ lý AI'), 'error');
      }
    } catch (e: any) {
      showNotification(e?.message || String(e), 'error');
    } finally {
      setSending(false);
    }
  };

  const handleBroadcastMessage = async (msg: AIRoomMessage, targetKeys?: string[]) => {
    if (!ipc.ai?.broadcastRoomMessage || relayingMsgId === msg.id) return;
    setRelayingMsgId(msg.id);
    try {
      const prefixSender = msg.senderType === 'assistant'
        ? `🤖 ${msg.senderName}`
        : msg.senderType === 'external'
          ? `${channelPill(msg.sourceChannel).label} · ${msg.senderName}`
          : undefined;

      const filteredTargets = targetKeys && targetKeys.length > 0
        ? targetKeys
        : outboundBridges
            .filter(b => !(msg.senderType === 'external' && b.accountId === msg.sourceAccountId && b.threadId === msg.sourceThreadId))
            .map(b => `${b.accountId}::${b.threadId}`);

      const res = await ipc.ai.broadcastRoomMessage({
        roomId: room.id,
        messageId: msg.id,
        content: msg.content,
        prefixSender,
        targetBridgeKeys: filteredTargets,
      });
      if (res?.success) {
        const okCount = (res.deliveries || []).filter((d: AIRoomRelayDelivery) => d.status === 'sent').length;
        const failCount = (res.deliveries || []).length - okCount;
        showNotification(
          failCount === 0
            ? tr('Đã phát tin tới {{count}} hội thoại', { count: okCount })
            : tr('Đã gửi {{ok}}, lỗi {{fail}}', { ok: okCount, fail: failCount }),
          failCount === 0 ? 'success' : 'warning',
        );
      } else {
        showNotification(res?.error || tr('Phát tin thất bại'), 'error');
      }
    } catch (e: any) {
      showNotification(e?.message || String(e), 'error');
    } finally {
      setRelayingMsgId(null);
    }
  };

  const updatePendingAction = (msgId: number, updated: AIPendingToolAction) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      const nextActions = (m.meta?.pendingActions || []).map(a => (a.id === updated.id ? updated : a));
      const nextMeta = { ...(m.meta || {}), pendingActions: nextActions };
      ipc.ai?.updateRoomMessageMeta?.({ messageId: m.id, metadataJson: JSON.stringify(nextMeta) }).catch(() => {});
      return { ...m, meta: nextMeta };
    }));
  };

  const handleDeleteRoom = async () => {
    const ok = await showConfirm({
      title: tr('Xóa nhóm chat AI'),
      message: tr('Xóa phòng chat "{{name}}" và toàn bộ lịch sử tin nhắn trong phòng? (Không xóa tin nhắn gốc trên Zalo/FB/Telegram)', { name: room.name }),
      confirmText: tr('Xóa phòng'),
      variant: 'danger',
    });
    if (!ok) return;
    await ipc.ai?.deleteRoom?.(room.id);
    onRoomDeleted(room.id);
  };

  const insertMention = (alias: string) => {
    setInput(prev => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@${alias} `);
    inputRef.current?.focus();
  };

  const toggleBridgeTarget = (key: string) => {
    setSelectedBridgeKeys(prev => (prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]));
  };

  const filterSummary = summarizeContextFilter(contextFilter, false);
  const routingLabel =
    room.routingMode === 'round_table'
      ? tr('Thảo luận vòng tròn')
      : room.routingMode === 'moderator'
        ? tr('AI Điều phối')
        : tr('@mention');

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border bg-card/60 flex items-center justify-between gap-3 flex-wrap flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white flex-shrink-0 ${
            room.bridges.length > 0 ? 'bg-gradient-to-br from-purple-600 to-blue-600' : 'bg-purple-600'
          }`}>
            <UsersIcon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-foreground truncate">{room.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                {routingLabel} · {room.members.length} AI
              </span>
              {room.bridges.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  {tr('{{count}} nguồn Zalo/FB/TG', { count: room.bridges.length })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {room.members.map(m => {
                const alias = (m.alias || m.assistantName || 'AI').replace(/\s+/g, '');
                return (
                  <button
                    key={m.assistantId}
                    type="button"
                    onClick={() => insertMention(alias)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/25 transition-colors"
                    title={m.roleInstruction || tr('Bấm để @tag trợ lý này')}
                  >
                    @{alias}
                  </button>
                );
              })}
              {room.bridges.map(b => {
                const tag = channelPill(b.channel);
                return (
                  <span
                    key={`${b.accountId}::${b.threadId}`}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${tag.cls}`}
                    title={`${tag.label}: ${b.threadName} (${b.outboundMode === 'auto_relay' ? 'Tự động' : 'Duyệt trước'})`}
                  >
                    {tag.label}: {b.threadName}
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setFilterOpen(v => !v)}
            className={`px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
              filterOpen || (contextFilter.mode === 'custom_filter' && contextFilter.enabled !== false)
                ? 'border-blue-500/50 bg-blue-600/15 text-blue-300'
                : 'border-border bg-card text-muted-foreground hover:text-foreground'
            }`}
          >
            🎯 {filterSummary}
          </button>

          <button
            type="button"
            onClick={() => setAiToolsEnabled(!aiToolsEnabled)}
            className={`px-2.5 py-1.5 rounded-lg text-xs border transition-colors inline-flex items-center gap-1.5 ${
              aiToolsEnabled
                ? 'border-emerald-500/50 bg-emerald-600/15 text-emerald-300'
                : 'border-border bg-card text-muted-foreground hover:text-foreground'
            }`}
          >
            <WrenchIcon className="w-3.5 h-3.5" />
            <span>{aiToolsEnabled ? tr('Tools: Bật') : tr('Tools: Tắt')}</span>
          </button>

          <button
            type="button"
            onClick={onEditRoom}
            className="p-2 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground transition-colors"
            title={tr('Cấu hình thành viên AI & cầu nối')}
          >
            <SettingsIcon className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleDeleteRoom}
            className="p-2 rounded-lg border border-border bg-card text-muted-foreground hover:text-red-400 transition-colors"
            title={tr('Xóa phòng')}
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Collapsible Context Filter */}
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

      {/* Message stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
        <div className="max-w-4xl mx-auto space-y-4">
          {loadingMessages ? (
            <div className="text-center py-12 text-xs text-muted-foreground">{tr('Đang tải lịch sử phòng...')}</div>
          ) : messages.length === 0 ? (
            <div className="text-center py-14 space-y-2">
              <UsersIcon className="w-10 h-10 text-purple-400 mx-auto" />
              <div className="text-sm font-semibold text-foreground">{tr('Phòng chat sẵn sàng hoạt động')}</div>
              <p className="text-xs text-muted-foreground max-w-lg mx-auto">
                {room.bridges.length > 0
                  ? tr('Tin nhắn mới từ các hội thoại Zalo, Facebook, Telegram đã nối sẽ tự động hiển thị tại đây. Bạn có thể gọi nhiều AI cùng phân tích và phát câu trả lời ra đúng kênh cần gửi.')
                  : tr('Hãy gửi yêu cầu hoặc bấm @TênAI bên dưới để nhiều Trợ lý AI cùng thảo luận và sử dụng công cụ quản lý.')}
              </p>
            </div>
          ) : (
            messages.map(msg => {
              const deliveries = msg.meta?.relayDeliveries || [];

              if (msg.senderType === 'user') {
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[82%] rounded-2xl px-4 py-2.5 bg-blue-600 text-white text-sm leading-relaxed space-y-1.5">
                      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      {deliveries.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1 border-t border-white/20 text-[10px]">
                          {deliveries.map((d, i) => (
                            <span key={i} className={`px-1.5 py-0.5 rounded ${d.status === 'sent' ? 'bg-emerald-500/30 text-emerald-100' : 'bg-red-500/40 text-red-100'}`}>
                              {d.status === 'sent' ? '✓' : '✕'} {channelPill(d.channel).label}: {d.threadName}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              if (msg.senderType === 'external') {
                const tag = channelPill(msg.sourceChannel);
                const otherTargets = outboundBridges.filter(
                  b => !(b.accountId === msg.sourceAccountId && b.threadId === msg.sourceThreadId),
                );
                return (
                  <div key={msg.id} className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-muted/45 border border-border text-sm space-y-2">
                      <div className="flex items-center gap-2 flex-wrap text-xs">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${tag.cls}`}>
                          {tag.label}
                        </span>
                        <span className="font-semibold text-foreground">{msg.senderName}</span>
                        {msg.sourceThreadName && (
                          <span className="text-[11px] text-muted-foreground">· {msg.sourceThreadName}</span>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          {new Date(msg.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>

                      <div className="text-foreground whitespace-pre-wrap break-words">{msg.content}</div>

                      {deliveries.length > 0 && (
                        <div className="flex flex-wrap gap-1 text-[10px]">
                          {deliveries.map((d, i) => (
                            <span key={i} className={`px-1.5 py-0.5 rounded border ${
                              d.status === 'sent'
                                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                                : 'bg-red-500/15 border-red-500/30 text-red-300'
                            }`}>
                              {d.status === 'sent' ? '✓ Tự chuyển tới' : '✕ Lỗi'} {channelPill(d.channel).label}: {d.threadName}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/50 text-[11px]">
                        {room.members.length > 0 && (
                          <button
                            type="button"
                            disabled={sending}
                            onClick={() => handleTriggerAI()}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 transition-colors"
                          >
                            <BotIcon className="w-3 h-3" />
                            <span>{tr('Gọi AI phân tích / trả lời')}</span>
                          </button>
                        )}
                        {otherTargets.length > 0 && (
                          <button
                            type="button"
                            disabled={relayingMsgId === msg.id}
                            onClick={() => handleBroadcastMessage(msg)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 transition-colors"
                          >
                            <span>📤 {relayingMsgId === msg.id ? tr('Đang gửi...') : tr('Chuyển tiếp sang {{count}} kênh khác', { count: otherTargets.length })}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              // Assistant bubble
              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="max-w-[88%] rounded-2xl px-4 py-3 bg-card border border-border shadow-sm text-sm leading-relaxed space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-blue-300">
                        <BotIcon className="w-3.5 h-3.5" />
                        <span>{msg.senderName}</span>
                      </span>
                      {msg.meta?.assistantAlias && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">
                          @{msg.meta.assistantAlias}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {new Date(msg.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    {msg.meta?.executedTools && <ExecutedToolsBadge tools={msg.meta.executedTools} />}

                    <AIMarkdownRenderer content={msg.content} isUser={false} />

                    {msg.meta?.pendingActions && msg.meta.pendingActions.length > 0 && (
                      <PendingActionList
                        actions={msg.meta.pendingActions}
                        onUpdateAction={updated => updatePendingAction(msg.id, updated)}
                      />
                    )}

                    {deliveries.length > 0 && (
                      <div className="flex flex-wrap gap-1 text-[10px]">
                        {deliveries.map((d, i) => (
                          <span key={i} className={`px-1.5 py-0.5 rounded border ${
                            d.status === 'sent'
                              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                              : 'bg-red-500/15 border-red-500/30 text-red-300'
                          }`}>
                            {d.status === 'sent' ? '✓ Đã gửi ra' : '✕ Lỗi'} {channelPill(d.channel).label}: {d.threadName}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Actions bar (Copy + Outbound Broadcast buttons) */}
                    <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(msg.content)}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        <ClipboardListIcon className="w-3.5 h-3.5" />
                        <span>{tr('Copy')}</span>
                      </button>

                      {outboundBridges.length > 0 && msg.content.trim() && (
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-[10px] text-muted-foreground/80">· {tr('Phát ra:')}</span>
                          {outboundBridges.map(b => (
                            <button
                              key={`${b.accountId}::${b.threadId}`}
                              type="button"
                              disabled={relayingMsgId === msg.id}
                              onClick={() => handleBroadcastMessage(msg, [`${b.accountId}::${b.threadId}`])}
                              className="px-1.5 py-0.5 rounded bg-muted hover:bg-blue-600/25 hover:text-blue-200 border border-border text-[10px] transition-colors"
                            >
                              📤 {channelPill(b.channel).label}: {b.threadName}
                            </button>
                          ))}
                          {outboundBridges.length > 1 && (
                            <button
                              type="button"
                              disabled={relayingMsgId === msg.id}
                              onClick={() => handleBroadcastMessage(msg)}
                              className="px-2 py-0.5 rounded bg-blue-600/20 hover:bg-blue-600/35 text-blue-300 border border-blue-500/30 text-[10px] font-medium transition-colors"
                            >
                              {relayingMsgId === msg.id ? tr('Đang gửi...') : tr('Tất cả kênh')}
                            </button>
                          )}
                        </div>
                      )}

                      {typeof msg.meta?.totalTokens === 'number' && msg.meta.totalTokens > 0 && (
                        <span className="ml-auto">{msg.meta.totalTokens} tokens</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-card border border-border rounded-2xl px-4 py-3 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                <span>{tr('Đang xử lý & phối hợp các thành viên trong nhóm...')}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="px-5 py-3 border-t border-border bg-card/50 flex-shrink-0 space-y-2">
        <div className="max-w-4xl mx-auto flex items-center gap-1.5 flex-wrap text-[11px]">
          {room.members.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => insertMention('all')}
                className="px-2 py-0.5 rounded-md bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30"
              >
                @all
              </button>
              {room.members.map(m => {
                const alias = (m.alias || m.assistantName || 'AI').replace(/\s+/g, '');
                return (
                  <button
                    key={m.assistantId}
                    type="button"
                    onClick={() => insertMention(alias)}
                    className="px-2 py-0.5 rounded-md bg-muted hover:bg-accent text-foreground/85 border border-border"
                  >
                    @{alias}
                  </button>
                );
              })}
            </>
          )}

          {outboundBridges.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap ml-auto">
              <span className="text-[10px] text-muted-foreground">{tr('Gửi kèm ra:')}</span>
              {outboundBridges.map(b => {
                const key = `${b.accountId}::${b.threadId}`;
                const selected = selectedBridgeKeys.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleBridgeTarget(key)}
                    className={`px-2 py-0.5 rounded-md text-[10px] border transition-colors ${
                      selected
                        ? 'bg-emerald-600/25 border-emerald-500/50 text-emerald-200 font-medium'
                        : 'bg-background border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {selected ? '✓ ' : ''}{channelPill(b.channel).label}: {b.threadName}
                  </button>
                );
              })}
            </div>
          )}

          <label className="inline-flex items-center gap-1.5 ml-2 cursor-pointer text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={triggerAI}
              onChange={e => setTriggerAI(e.target.checked)}
            />
            <span>{tr('Gọi AI')}</span>
          </label>
        </div>

        <div className="max-w-4xl mx-auto flex items-end gap-2 bg-background border border-border rounded-2xl px-4 py-2.5 focus-within:border-blue-500 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              outboundBridges.length > 0 && selectedBridgeKeys.length > 0
                ? tr('Nhập tin nhắn (sẽ gửi ra {{count}} hội thoại đã chọn)...', { count: selectedBridgeKeys.length })
                : tr('Nhắn vào nhóm (dùng @TênAI hoặc @all để gọi các AI cùng thảo luận)...')
            }
            rows={2}
            className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground resize-none outline-none max-h-40 overflow-y-auto"
          />
          <button
            type="button"
            disabled={sending || !input.trim()}
            onClick={handleSend}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold transition-colors flex-shrink-0"
          >
            {tr('Gửi')}
          </button>
        </div>
      </div>
    </div>
  );
}
