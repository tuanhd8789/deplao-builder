/**
 * AIRoomModal.tsx
 * Create / Edit modal for Phase 2 (Multi-AI Group Room) and Phase 3 (Cross-Channel Bridged Room).
 */
import React, { useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import type {
  AIBridgeChannel,
  AIBridgeDirection,
  AIBridgeOutboundMode,
  AIRoom,
  AIRoomBridge,
  AIRoomMember,
  AIRoomRoutingMode,
  AIRoomTriggerMode,
  AIRoomType,
} from '../../../../models/ai/aiRoom';
import { getAIPlatformMeta } from './aiPlatformMeta';
import { BotIcon, CheckIcon, CloseIcon, SearchIcon, TrashIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';

interface AssistantItem {
  id: string;
  name: string;
  platform: string;
  model: string;
  enabled: boolean;
}

interface FilterThreadItem {
  account_id: string;
  thread_id: string;
  name: string;
  contact_type: string;
  channel: string;
}

interface FilterAccountItem {
  zalo_id: string;
  full_name: string;
  channel: string;
}

interface Props {
  open: boolean;
  initialRoom?: AIRoom | null;
  assistants: AssistantItem[];
  onClose: () => void;
  onSaved: (room: AIRoom) => void;
}

function defaultAlias(name: string): string {
  return String(name || 'AI')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 20) || 'AI';
}

function channelTag(ch: string): { label: string; cls: string } {
  if (ch === 'facebook') return { label: 'Facebook', cls: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' };
  if (ch === 'telegram_user') return { label: 'Telegram', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/30' };
  if (ch === 'telegram_bot') return { label: 'TG Bot', cls: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' };
  return { label: 'Zalo', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/30' };
}

export default function AIRoomModal({ open, initialRoom, assistants, onClose, onSaved }: Props) {
  const showNotification = useAppStore(s => s.showNotification);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roomType, setRoomType] = useState<AIRoomType>('multi_ai');
  const [routingMode, setRoutingMode] = useState<AIRoomRoutingMode>('mention');
  const [moderatorAiId, setModeratorAiId] = useState<string>('');
  const [aiTriggerMode, setAiTriggerMode] = useState<AIRoomTriggerMode>('all_internal');
  const [maxTurnsPerMsg, setMaxTurnsPerMsg] = useState<number>(3);

  const [members, setMembers] = useState<AIRoomMember[]>([]);
  const [bridges, setBridges] = useState<AIRoomBridge[]>([]);

  const [accounts, setAccounts] = useState<FilterAccountItem[]>([]);
  const [allThreads, setAllThreads] = useState<FilterThreadItem[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [accountFilter, setAccountFilter] = useState<string>('');
  const [threadSearch, setThreadSearch] = useState<string>('');
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initialRoom) {
      setName(initialRoom.name || '');
      setDescription(initialRoom.description || '');
      setRoomType(initialRoom.roomType || 'multi_ai');
      setRoutingMode(initialRoom.routingMode || 'mention');
      setModeratorAiId(initialRoom.moderatorAiId || initialRoom.members[0]?.assistantId || '');
      setAiTriggerMode(initialRoom.aiTriggerMode || 'all_internal');
      setMaxTurnsPerMsg(initialRoom.maxTurnsPerMsg || 3);
      setMembers(initialRoom.members || []);
      setBridges(initialRoom.bridges || []);
    } else {
      setName('');
      setDescription('');
      setRoomType('multi_ai');
      setRoutingMode('round_table');
      const first2 = assistants.slice(0, 2);
      setMembers(
        first2.map((a, idx) => ({
          roomId: '',
          assistantId: a.id,
          alias: defaultAlias(a.name),
          roleInstruction: '',
          sortOrder: idx,
          assistantName: a.name,
          platform: a.platform,
          model: a.model,
        })),
      );
      setModeratorAiId(first2[0]?.id || '');
      setAiTriggerMode('all_internal');
      setMaxTurnsPerMsg(3);
      setBridges([]);
    }
  }, [open, initialRoom, assistants]);

  useEffect(() => {
    if (!open) return;
    setLoadingThreads(true);
    ipc.ai?.getContextFilterOptions?.()
      .then(res => {
        if (res?.success) {
          setAccounts(res.accounts || []);
          setAllThreads(res.threads || []);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingThreads(false));
  }, [open]);

  const toggleMember = (a: AssistantItem) => {
    setMembers(prev => {
      const exists = prev.some(m => m.assistantId === a.id);
      if (exists) {
        const next = prev.filter(m => m.assistantId !== a.id);
        if (moderatorAiId === a.id) {
          setModeratorAiId(next[0]?.assistantId || '');
        }
        return next;
      }
      const next: AIRoomMember[] = [
        ...prev,
        {
          roomId: initialRoom?.id || '',
          assistantId: a.id,
          alias: defaultAlias(a.name),
          roleInstruction: '',
          sortOrder: prev.length,
          assistantName: a.name,
          platform: a.platform,
          model: a.model,
        },
      ];
      if (!moderatorAiId) setModeratorAiId(a.id);
      return next;
    });
  };

  const updateMemberField = (assistantId: string, patch: Partial<AIRoomMember>) => {
    setMembers(prev => prev.map(m => (m.assistantId === assistantId ? { ...m, ...patch } : m)));
  };

  const addBridge = (t: FilterThreadItem) => {
    const exists = bridges.some(b => b.accountId === t.account_id && b.threadId === t.thread_id);
    if (exists) return;
    const ch = (['zalo', 'facebook', 'telegram_user', 'telegram_bot'].includes(t.channel)
      ? t.channel
      : 'zalo') as AIBridgeChannel;
    setBridges(prev => [
      ...prev,
      {
        roomId: initialRoom?.id || '',
        accountId: t.account_id,
        channel: ch,
        threadId: t.thread_id,
        threadType: t.contact_type === 'group' || t.contact_type === 'channel' ? 1 : 0,
        threadName: t.name || t.thread_id,
        relayDirection: 'both',
        outboundMode: 'approval',
        includeAiReplies: true,
        enabled: true,
      },
    ]);
    setRoomType('bridge');
  };

  const updateBridgeField = (idx: number, patch: Partial<AIRoomBridge>) => {
    setBridges(prev => prev.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  };

  const removeBridge = (idx: number) => {
    setBridges(prev => prev.filter((_, i) => i !== idx));
  };

  const filteredThreads = useMemo(() => {
    const kw = threadSearch.trim().toLowerCase();
    const addedSet = new Set(bridges.map(b => `${b.accountId}::${b.threadId}`));
    return allThreads
      .filter(t => !addedSet.has(`${t.account_id}::${t.thread_id}`))
      .filter(t => channelFilter === 'all' || t.channel === channelFilter)
      .filter(t => !accountFilter || t.account_id === accountFilter)
      .filter(t => !kw || (t.name || '').toLowerCase().includes(kw) || t.thread_id.toLowerCase().includes(kw))
      .slice(0, 60);
  }, [allThreads, bridges, channelFilter, accountFilter, threadSearch]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      showNotification(tr('Vui lòng nhập tên phòng/nhóm'), 'error');
      return;
    }
    if (members.length === 0 && bridges.length === 0) {
      showNotification(tr('Hãy chọn ít nhất 1 trợ lý AI hoặc 1 nguồn hội thoại kết nối'), 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        id: initialRoom?.id,
        name: name.trim(),
        description: description.trim(),
        roomType: bridges.length > 0 ? 'bridge' : roomType,
        routingMode,
        moderatorAiId: moderatorAiId || members[0]?.assistantId || null,
        aiTriggerMode,
        maxTurnsPerMsg,
        enabled: true,
        members: members.map((m, i) => ({ ...m, sortOrder: i })),
        bridges,
      };
      const res = await ipc.ai?.saveRoom?.(payload);
      if (res?.success && res.room) {
        showNotification(tr('Đã lưu nhóm AI / phòng liên thông'), 'success');
        onSaved(res.room);
      } else {
        showNotification(res?.error || tr('Lưu phòng thất bại'), 'error');
      }
    } catch (e: any) {
      showNotification(e?.message || String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9995] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-600/20 text-purple-300 flex items-center justify-center">
              <UsersIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground">
                {initialRoom ? tr('Cấu hình Nhóm AI & Cầu nối Đa kênh') : tr('Tạo Nhóm Chat AI / Phòng Liên Nền Tảng')}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {tr('Kết hợp nhiều Trợ lý AI cùng thảo luận hoặc nối với hội thoại Zalo, Facebook Messenger, Telegram')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* 1. Basic info */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-foreground/80 mb-1">{tr('Tên nhóm / phòng chat *')}</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={tr('VD: Tổ tư vấn Sales + CSKH, Phòng Dự án đa kênh...')}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-foreground/80 mb-1">{tr('Mô tả ngắn')}</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={tr('VD: Nhóm điều phối đơn hàng Zalo & Telegram cho team')}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* 2. Multi-AI Members & Orchestration (Phase 2) */}
          <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <BotIcon className="w-4 h-4 text-blue-400" />
                <span className="text-xs font-bold text-foreground">
                  {tr('1. Thành viên Trợ lý AI ({{count}} đã chọn)', { count: members.length })}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={routingMode}
                  onChange={e => setRoutingMode(e.target.value as AIRoomRoutingMode)}
                  className="bg-background border border-input rounded-lg px-2.5 py-1 text-[11px] text-foreground outline-none focus:border-blue-500"
                >
                  <option value="mention">{tr('Chế độ @mention (gọi đích danh / trưởng nhóm)')}</option>
                  <option value="round_table">{tr('Thảo luận vòng tròn (nhiều AI nối tiếp nhau)')}</option>
                  <option value="moderator">{tr('AI Điều phối (trưởng nhóm tự chia việc & chốt)')}</option>
                </select>
                <select
                  value={aiTriggerMode}
                  onChange={e => setAiTriggerMode(e.target.value as AIRoomTriggerMode)}
                  className="bg-background border border-input rounded-lg px-2.5 py-1 text-[11px] text-foreground outline-none focus:border-blue-500"
                >
                  <option value="all_internal">{tr('AI trả lời khi bạn nhắn trong phòng')}</option>
                  <option value="all_messages">{tr('AI tự trả lời cả tin từ Zalo/FB/TG')}</option>
                  <option value="mention_only">{tr('Chỉ trả lời khi có @tên AI hoặc @ai')}</option>
                  <option value="manual">{tr('Thủ công (chỉ bấm nút gọi AI)')}</option>
                </select>
                <div className="flex items-center gap-1 bg-background border border-input rounded-lg px-2 py-1">
                  <span className="text-[10px] text-muted-foreground">{tr('Lượt AI tối đa:')}</span>
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={maxTurnsPerMsg}
                    onChange={e => setMaxTurnsPerMsg(Math.min(6, Math.max(1, Number(e.target.value) || 3)))}
                    className="w-9 bg-transparent text-[11px] text-foreground text-center outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Assistant picker pills */}
            <div className="flex flex-wrap gap-1.5">
              {assistants.map(a => {
                const picked = members.some(m => m.assistantId === a.id);
                const meta = getAIPlatformMeta(a.platform);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleMember(a)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border transition-colors ${
                      picked
                        ? 'bg-blue-600/20 border-blue-500/50 text-blue-200 font-medium'
                        : 'bg-background border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] text-white ${meta.color}`}>
                      {picked ? <CheckIcon className="w-3 h-3" /> : meta.icon}
                    </span>
                    <span>{a.name}</span>
                  </button>
                );
              })}
            </div>

            {/* Selected AI role table */}
            {members.length > 0 && (
              <div className="space-y-2 pt-1">
                {members.map((m, idx) => {
                  const isMod = moderatorAiId === m.assistantId;
                  return (
                    <div key={m.assistantId} className="grid grid-cols-12 gap-2 items-center bg-background/70 border border-border rounded-lg p-2">
                      <div className="col-span-3 min-w-0">
                        <div className="font-semibold text-foreground truncate">{m.assistantName || m.assistantId}</div>
                        <button
                          type="button"
                          onClick={() => setModeratorAiId(m.assistantId)}
                          className={`text-[10px] mt-0.5 px-1.5 py-0.5 rounded border ${
                            isMod
                              ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 font-medium'
                              : 'border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {isMod ? tr('★ Trưởng nhóm') : tr('Đặt làm trưởng nhóm')}
                        </button>
                      </div>
                      <div className="col-span-3">
                        <div className="flex items-center bg-muted/40 border border-input rounded px-2 py-1">
                          <span className="text-muted-foreground mr-0.5">@</span>
                          <input
                            type="text"
                            value={m.alias}
                            onChange={e => updateMemberField(m.assistantId, { alias: e.target.value.replace(/\s+/g, '') })}
                            placeholder={tr('Alias')}
                            className="w-full bg-transparent text-[11px] text-foreground outline-none"
                          />
                        </div>
                      </div>
                      <div className="col-span-5">
                        <input
                          type="text"
                          value={m.roleInstruction}
                          onChange={e => updateMemberField(m.assistantId, { roleInstruction: e.target.value })}
                          placeholder={tr('Vai trò (VD: Chuyên viên chốt đơn, Kế toán kiểm tra công nợ...)')}
                          className="w-full bg-muted/40 border border-input rounded px-2 py-1 text-[11px] text-foreground outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="col-span-1 flex items-center justify-end gap-1">
                        {idx > 0 && (
                          <button
                            type="button"
                            onClick={() => setMembers(prev => {
                              const arr = [...prev];
                              const tmp = arr[idx - 1];
                              arr[idx - 1] = arr[idx];
                              arr[idx] = tmp;
                              return arr;
                            })}
                            className="px-1 text-muted-foreground hover:text-foreground"
                            title={tr('Đẩy lên')}
                          >↑</button>
                        )}
                        <button
                          type="button"
                          onClick={() => setMembers(prev => prev.filter(x => x.assistantId !== m.assistantId))}
                          className="p-1 text-muted-foreground hover:text-red-400"
                          title={tr('Bỏ khỏi nhóm')}
                        >
                          <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 3. Cross-Channel Bridges (Phase 3) */}
          <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div className="text-xs font-bold text-foreground">
                  {tr('2. Cầu nối Nguồn chat Zalo / Facebook / Telegram ({{count}} hội thoại đã nối)', { count: bridges.length })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {tr('Mỗi tin nhắn từ các nguồn này tự đổ vào phòng; có thể chọn Duyệt trước hoặc Tự động chuyển tiếp qua hàng đợi chống khóa tài khoản.')}
                </p>
              </div>
            </div>

            {/* Active bridges */}
            {bridges.length > 0 && (
              <div className="space-y-1.5">
                {bridges.map((b, idx) => {
                  const tag = channelTag(b.channel);
                  return (
                    <div key={`${b.accountId}::${b.threadId}`} className="flex flex-wrap items-center gap-2 bg-background border border-border rounded-lg px-2.5 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${tag.cls}`}>{tag.label}</span>
                      <span className="text-xs font-medium text-foreground truncate max-w-[180px]" title={b.threadName}>
                        {b.threadName}
                      </span>
                      <select
                        value={b.relayDirection}
                        onChange={e => updateBridgeField(idx, { relayDirection: e.target.value as AIBridgeDirection })}
                        className="bg-muted/50 border border-input rounded px-1.5 py-0.5 text-[10px] text-foreground outline-none"
                      >
                        <option value="both">{tr('Hai chiều (Nhận & Gửi)')}</option>
                        <option value="inbound_only">{tr('Chỉ nhận vào phòng')}</option>
                        <option value="outbound_only">{tr('Chỉ gửi ra ngoài')}</option>
                      </select>
                      <select
                        value={b.outboundMode}
                        onChange={e => updateBridgeField(idx, { outboundMode: e.target.value as AIBridgeOutboundMode })}
                        className="bg-muted/50 border border-input rounded px-1.5 py-0.5 text-[10px] text-foreground outline-none"
                      >
                        <option value="approval">{tr('🔒 Duyệt trước khi phát')}</option>
                        <option value="auto_relay">{tr('⚡ Tự động chuyển tiếp')}</option>
                      </select>
                      <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={b.includeAiReplies}
                          onChange={e => updateBridgeField(idx, { includeAiReplies: e.target.checked })}
                        />
                        <span>{tr('Phát cả tin AI (Auto)')}</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeBridge(idx)}
                        className="ml-auto p-1 text-muted-foreground hover:text-red-400"
                        title={tr('Ngắt kết nối nguồn này')}
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add bridge picker */}
            <div className="bg-background/80 border border-border rounded-lg p-2.5 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 bg-muted/40 border border-input rounded-lg px-2 py-1 flex-1 min-w-[160px]">
                  <SearchIcon className="w-3.5 h-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={threadSearch}
                    onChange={e => setThreadSearch(e.target.value)}
                    placeholder={tr('Tìm khách hàng hoặc nhóm Zalo / Facebook / Telegram để thêm vào phòng...')}
                    className="w-full bg-transparent text-[11px] text-foreground outline-none"
                  />
                </div>
                <select
                  value={channelFilter}
                  onChange={e => setChannelFilter(e.target.value)}
                  className="bg-background border border-input rounded-lg px-2 py-1 text-[11px] text-foreground outline-none"
                >
                  <option value="all">{tr('Mọi kênh')}</option>
                  <option value="zalo">Zalo</option>
                  <option value="facebook">Facebook</option>
                  <option value="telegram_user">Telegram</option>
                  <option value="telegram_bot">Telegram Bot</option>
                </select>
                <select
                  value={accountFilter}
                  onChange={e => setAccountFilter(e.target.value)}
                  className="bg-background border border-input rounded-lg px-2 py-1 text-[11px] text-foreground outline-none max-w-[160px]"
                >
                  <option value="">{tr('Mọi tài khoản')}</option>
                  {accounts.map(acc => (
                    <option key={acc.zalo_id} value={acc.zalo_id}>
                      {acc.full_name || acc.zalo_id} ({acc.channel})
                    </option>
                  ))}
                </select>
              </div>

              <div className="max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5 pr-0.5">
                {loadingThreads ? (
                  <div className="col-span-2 text-center py-3 text-muted-foreground">{tr('Đang tải danh sách hội thoại...')}</div>
                ) : filteredThreads.length === 0 ? (
                  <div className="col-span-2 text-center py-3 text-muted-foreground">{tr('Không tìm thấy hội thoại phù hợp.')}</div>
                ) : (
                  filteredThreads.map(t => {
                    const tag = channelTag(t.channel);
                    const accName = accounts.find(a => a.zalo_id === t.account_id)?.full_name || '';
                    return (
                      <button
                        key={`${t.account_id}::${t.thread_id}`}
                        type="button"
                        onClick={() => addBridge(t)}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border hover:border-blue-500/50 hover:bg-muted/50 text-left transition-colors"
                      >
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0 ${tag.cls}`}>{tag.label}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-medium text-foreground truncate">{t.name || t.thread_id}</div>
                          <div className="text-[9px] text-muted-foreground truncate">
                            {t.contact_type === 'group' ? tr('Nhóm') : tr('Cá nhân')}{accName ? ` · ${accName}` : ''}
                          </div>
                        </div>
                        <span className="text-[11px] text-blue-400 font-semibold flex-shrink-0">+ {tr('Thêm')}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 bg-card">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {tr('Hủy')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSubmit}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
          >
            {saving ? tr('Đang lưu...') : initialRoom ? tr('Lưu thay đổi') : tr('Tạo nhóm ngay')}
          </button>
        </div>
      </div>
    </div>
  );
}
