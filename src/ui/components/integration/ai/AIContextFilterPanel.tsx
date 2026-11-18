/**
 * AIContextFilterPanel.tsx
 * Multi-dimensional context filter builder for AI Chat (up to 1,000 matching messages):
 * - Time range (presets or custom date-time)
 * - Channels / Accounts / Conversations (multi-select or All)
 * - Local Labels & CRM Tags
 * - Thread type (All / Direct 1-1 / Group)
 * - Senders (Tôi + multi-select senders in selected threads)
 * - Limit (1..1000) & live match preview
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import type { AIContextFilter, ZaloCachedLabel } from '../../../../models/ai/ai';
import { CheckIcon, CloseIcon, CloudIcon, HardDriveIcon, SearchIcon, TagIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';

interface FilterOptions {
  accounts: Array<{ zalo_id: string; full_name: string; channel: string }>;
  threads: Array<{
    account_id: string;
    thread_id: string;
    name: string;
    contact_type: string;
    channel: string;
    local_label_ids: number[];
    crm_tag_ids: number[];
    zalo_label_keys?: string[];
  }>;
  localLabels: Array<{ id: number; name: string; color: string; emoji: string }>;
  crmTags: Array<{ id: number; owner_zalo_id: string; name: string; color: string; emoji: string }>;
  zaloLabels: ZaloCachedLabel[];
}

interface ZaloLabelGroup {
  groupKey: string;
  text: string;
  color: string;
  emoji?: string;
  keys: string[];
  convCount: number;
}

interface SenderOption {
  senderId: string;
  displayName: string;
  isSelf: boolean;
  msgCount: number;
}

interface Props {
  value: AIContextFilter;
  onChange: (next: AIContextFilter) => void;
  hasActiveThread?: boolean;
  compact?: boolean;
  onClose?: () => void;
  onPreviewUpdate?: (info: { count: number; threadCount: number }) => void;
}

const CHANNEL_LABELS: Record<string, string> = {
  zalo: 'Zalo',
  facebook: 'Facebook',
  telegram_user: 'Telegram',
  telegram_bot: 'TG Bot',
};

function toLocalDatetimeValue(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function summarizeContextFilter(filter: AIContextFilter, hasActiveThread: boolean): string {
  if (filter.mode === 'off' || filter.enabled === false) return tr('Ngữ cảnh tắt');
  if (filter.mode === 'current_thread' && hasActiveThread) {
    return tr('Hội thoại đang mở ({{count}} tin)', { count: filter.limit || 30 });
  }
  const parts: string[] = [];
  const timeLabels: Record<string, string> = {
    all: tr('Mọi lúc'),
    today: tr('Hôm nay'),
    yesterday: tr('Hôm qua'),
    '7d': tr('7 ngày'),
    '30d': tr('30 ngày'),
    custom: tr('Khoảng ngày'),
  };
  parts.push(timeLabels[filter.timePreset || '7d'] || tr('7 ngày'));
  if (filter.threadKeys?.length) parts.push(tr('{{n}} hội thoại', { n: filter.threadKeys.length }));
  else parts.push(tr('Tất cả hội thoại'));
  if (filter.threadType === 'direct') parts.push('1-1');
  else if (filter.threadType === 'group') parts.push(tr('Nhóm'));
  const totalSelectedLabels =
    (filter.localLabelIds?.length || 0) +
    (filter.crmTagIds?.length || 0) +
    (filter.zaloLabelKeys?.length || 0);
  if (totalSelectedLabels > 0) {
    parts.push(tr('{{n}} nhãn', { n: totalSelectedLabels }));
  }
  if (filter.senderIds?.length) parts.push(tr('{{n}} người gửi', { n: filter.senderIds.length }));
  parts.push(`${filter.limit || 200} tin`);
  return parts.join(' · ');
}

function normalizeConvId(raw: unknown): string {
  return String(raw || '').trim().replace(/^[ug](?=\d)/i, '');
}

export default function AIContextFilterPanel({
  value,
  onChange,
  hasActiveThread = false,
  compact = false,
  onClose,
  onPreviewUpdate,
}: Props) {
  const appZaloLabels = useAppStore((s) => s.labels);
  const setAppZaloLabels = useAppStore((s) => s.setLabels);
  const [options, setOptions] = useState<FilterOptions>({
    accounts: [],
    threads: [],
    localLabels: [],
    crmTags: [],
    zaloLabels: [],
  });
  const [loadingOpts, setLoadingOpts] = useState(false);
  const [refreshingZaloLabels, setRefreshingZaloLabels] = useState(false);
  const [labelSourceTab, setLabelSourceTab] = useState<'local' | 'zalo'>(() =>
    value.zaloLabelKeys?.length && !(value.localLabelIds?.length || value.crmTagIds?.length) ? 'zalo' : 'local',
  );
  const [senders, setSenders] = useState<SenderOption[]>([]);
  const [loadingSenders, setLoadingSenders] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  const [senderSearch, setSenderSearch] = useState('');
  const [previewInfo, setPreviewInfo] = useState<{ count: number; threadCount: number } | null>(null);
  const [checking, setChecking] = useState(false);

  const mode = value.mode || (hasActiveThread ? 'current_thread' : 'custom_filter');

  const applyOptionsResponse = useCallback((res: any) => {
    if (!res?.success) return;
    const nextZaloLabels: ZaloCachedLabel[] = res.zaloLabels || [];
    setOptions({
      accounts: res.accounts || [],
      threads: res.threads || [],
      localLabels: res.localLabels || [],
      crmTags: res.crmTags || [],
      zaloLabels: nextZaloLabels,
    });
    // Auto-switch tab to Zalo labels when only Zalo labels are available or actively selected
    const hasDeplao = (res.localLabels?.length || 0) + (res.crmTags?.length || 0) > 0;
    const hasZalo = nextZaloLabels.length > 0;
    if (value.zaloLabelKeys?.length && !(value.localLabelIds?.length || value.crmTagIds?.length)) {
      setLabelSourceTab('zalo');
    } else if (!hasDeplao && hasZalo) {
      setLabelSourceTab('zalo');
    }
  }, [value.zaloLabelKeys?.length, value.localLabelIds?.length, value.crmTagIds?.length]);

  // Load filter options (accounts, threads, local/CRM labels, and Zalo labels)
  useEffect(() => {
    let cancelled = false;
    setLoadingOpts(true);
    ipc.ai?.getContextFilterOptions?.({
      clientZaloLabels: useAppStore.getState().labels,
    }).then((res) => {
      if (!cancelled) applyOptionsResponse(res);
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoadingOpts(false);
    });
    return () => { cancelled = true; };
  }, [applyOptionsResponse]);

  const handleRefreshZaloLabels = async () => {
    if (refreshingZaloLabels) return;
    setRefreshingZaloLabels(true);
    try {
      const res = await ipc.ai?.getContextFilterOptions?.({ forceRefreshZaloLabels: true });
      if (res?.success) {
        applyOptionsResponse(res);
        // Keep appStore in sync for each Zalo account returned
        const byAcc = new Map<string, any[]>();
        for (const lbl of res.zaloLabels || []) {
          const arr = byAcc.get(lbl.accountId) || [];
          arr.push({
            id: lbl.id,
            text: lbl.text,
            color: lbl.color,
            emoji: lbl.emoji || '',
            conversations: lbl.conversations || [],
            textKey: lbl.text,
            offset: 0,
            createTime: 0,
          });
          byAcc.set(lbl.accountId, arr);
        }
        for (const [accId, list] of byAcc.entries()) {
          setAppZaloLabels(accId, list);
        }
      }
    } catch {}
    setRefreshingZaloLabels(false);
  };

  // Load available senders when filters (including labels) change in custom_filter mode
  useEffect(() => {
    if (mode !== 'custom_filter') return;
    let cancelled = false;
    setLoadingSenders(true);
    ipc.ai?.getContextSenders?.({
      accountIds: value.accountIds,
      channels: value.channels,
      threadKeys: value.threadKeys,
      threadType: value.threadType,
      localLabelIds: value.localLabelIds,
      crmTagIds: value.crmTagIds,
      zaloLabelKeys: value.zaloLabelKeys,
      labelMatchMode: value.labelMatchMode,
      timePreset: value.timePreset,
      fromTs: value.fromTs,
      toTs: value.toTs,
    }).then((res) => {
      if (cancelled) return;
      if (res?.success) setSenders(res.senders || []);
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoadingSenders(false);
    });
    return () => { cancelled = true; };
  }, [
    mode,
    value.accountIds,
    value.channels,
    value.threadKeys,
    value.threadType,
    value.localLabelIds,
    value.crmTagIds,
    value.zaloLabelKeys,
    value.labelMatchMode,
    value.timePreset,
    value.fromTs,
    value.toTs,
  ]);

  // Merge DB-cached Zalo labels with any fresh UI-only labels in appStore, grouped cleanly by name
  const mergedZaloLabels = useMemo<ZaloCachedLabel[]>(() => {
    const byAcc = new Map<string, ZaloCachedLabel[]>();
    for (const lbl of options.zaloLabels) {
      const list = byAcc.get(lbl.accountId) || [];
      list.push(lbl);
      byAcc.set(lbl.accountId, list);
    }
    for (const [accId, list] of Object.entries(appZaloLabels || {})) {
      if (!byAcc.has(accId) && Array.isArray(list) && list.length > 0) {
        byAcc.set(
          accId,
          list.map((l) => ({
            accountId: accId,
            id: Number(l.id),
            text: String(l.text || ''),
            color: String(l.color || '#3b82f6'),
            emoji: String(l.emoji || ''),
            conversations: (l.conversations || []).map(normalizeConvId).filter(Boolean),
          })),
        );
      }
    }
    const all: ZaloCachedLabel[] = [];
    const accFilter = value.accountIds?.length ? new Set(value.accountIds) : null;
    for (const [accId, list] of byAcc.entries()) {
      if (accFilter && !accFilter.has(accId)) continue;
      all.push(...list);
    }
    return all;
  }, [options.zaloLabels, appZaloLabels, value.accountIds]);

  const zaloLabelGroups = useMemo<ZaloLabelGroup[]>(() => {
    const byName = new Map<string, ZaloLabelGroup & { convSet: Set<string> }>();
    for (const lbl of mergedZaloLabels) {
      const groupKey = lbl.text.trim().toLowerCase() || String(lbl.id);
      const labelKey = `${lbl.accountId}:${lbl.id}`;
      let group = byName.get(groupKey);
      if (!group) {
        group = {
          groupKey,
          text: lbl.text || `#${lbl.id}`,
          color: lbl.color || '#3b82f6',
          emoji: lbl.emoji || '',
          keys: [],
          convCount: 0,
          convSet: new Set<string>(),
        };
        byName.set(groupKey, group);
      }
      if (!group.keys.includes(labelKey)) group.keys.push(labelKey);
      for (const cid of lbl.conversations || []) {
        group.convSet.add(`${lbl.accountId}::${normalizeConvId(cid)}`);
      }
    }
    return Array.from(byName.values()).map(({ convSet, ...rest }) => ({
      ...rest,
      convCount: convSet.size,
    }));
  }, [mergedZaloLabels]);

  // Also index Zalo label keys on threads from UI fallback if backend cache lacked them initially
  const threadZaloKeyLookup = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const lbl of mergedZaloLabels) {
      const k = `${lbl.accountId}:${lbl.id}`;
      for (const cid of lbl.conversations || []) {
        const tk = `${lbl.accountId}::${normalizeConvId(cid)}`;
        const arr = map.get(tk);
        if (arr) {
          if (!arr.includes(k)) arr.push(k);
        } else {
          map.set(tk, [k]);
        }
      }
    }
    return map;
  }, [mergedZaloLabels]);

  const runPreview = useCallback(async (filterToCheck: AIContextFilter) => {
    if (filterToCheck.mode === 'off' || filterToCheck.enabled === false) {
      setPreviewInfo({ count: 0, threadCount: 0 });
      onPreviewUpdate?.({ count: 0, threadCount: 0 });
      return;
    }
    setChecking(true);
    try {
      const res = await ipc.ai?.queryContextMessages?.(filterToCheck);
      if (res?.success) {
        const info = { count: res.count || 0, threadCount: res.threadCount || 0 };
        setPreviewInfo(info);
        onPreviewUpdate?.(info);
      }
    } catch {}
    setChecking(false);
  }, [onPreviewUpdate]);

  const filteredThreads = useMemo(() => {
    const q = threadSearch.trim().toLowerCase();
    const localIds = value.localLabelIds || [];
    const crmIds = value.crmTagIds || [];
    const zaloKeys = value.zaloLabelKeys || [];
    const hasLabelFilter = localIds.length > 0 || crmIds.length > 0 || zaloKeys.length > 0;
    const matchAll = value.labelMatchMode === 'all';
    const selectedZaloGroups = matchAll
      ? zaloLabelGroups.filter((g) => g.keys.some((k) => zaloKeys.includes(k)))
      : [];

    return options.threads.filter(t => {
      if (value.accountIds?.length && !value.accountIds.includes(t.account_id)) return false;
      if (value.channels?.length && !value.channels.includes(t.channel)) return false;
      if (value.threadType === 'direct' && t.contact_type !== 'user') return false;
      if (value.threadType === 'group' && t.contact_type === 'user') return false;

      if (hasLabelFilter) {
        const tZaloKeys = t.zalo_label_keys?.length
          ? t.zalo_label_keys
          : (threadZaloKeyLookup.get(`${t.account_id}::${t.thread_id}`) || []);
        if (matchAll) {
          const okLocal = localIds.every((id) => t.local_label_ids.includes(id));
          const okCrm = crmIds.every((id) => t.crm_tag_ids.includes(id));
          const okZalo = selectedZaloGroups.every((g) => g.keys.some((k) => tZaloKeys.includes(k)));
          if (!okLocal || !okCrm || !okZalo) return false;
        } else {
          const hitLocal = localIds.some((id) => t.local_label_ids.includes(id));
          const hitCrm = crmIds.some((id) => t.crm_tag_ids.includes(id));
          const hitZalo = zaloKeys.some((k) => tZaloKeys.includes(k));
          if (!hitLocal && !hitCrm && !hitZalo) return false;
        }
      }

      if (q && !`${t.name} ${t.thread_id}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [
    options.threads,
    threadSearch,
    value.accountIds,
    value.channels,
    value.threadType,
    value.localLabelIds,
    value.crmTagIds,
    value.zaloLabelKeys,
    value.labelMatchMode,
    zaloLabelGroups,
    threadZaloKeyLookup,
  ]);

  const filteredSenders = useMemo(() => {
    const q = senderSearch.trim().toLowerCase();
    return senders.filter(s => !q || s.displayName.toLowerCase().includes(q) || s.senderId.toLowerCase().includes(q));
  }, [senders, senderSearch]);

  const selectedThreadSet = useMemo(
    () => new Set((value.threadKeys || []).map(t => `${t.accountId}::${t.threadId}`)),
    [value.threadKeys],
  );

  const toggleThread = (accountId: string, threadId: string) => {
    const key = `${accountId}::${threadId}`;
    const current = value.threadKeys || [];
    const next = selectedThreadSet.has(key)
      ? current.filter(t => `${t.accountId}::${t.threadId}` !== key)
      : [...current, { accountId, threadId }];
    onChange({ ...value, threadKeys: next });
  };

  const toggleNumberIn = (field: 'localLabelIds' | 'crmTagIds', id: number) => {
    const cur = value[field] || [];
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    onChange({ ...value, [field]: next });
  };

  const toggleStringIn = (field: 'accountIds' | 'channels' | 'senderIds', item: string) => {
    const cur = value[field] || [];
    const next = cur.includes(item) ? cur.filter(x => x !== item) : [...cur, item];
    onChange({ ...value, [field]: next });
  };

  const toggleZaloLabelGroup = (groupKeys: string[]) => {
    const cur = new Set(value.zaloLabelKeys || []);
    const isActive = groupKeys.some((k) => cur.has(k));
    if (isActive) {
      for (const k of groupKeys) cur.delete(k);
    } else {
      for (const k of groupKeys) cur.add(k);
    }
    onChange({ ...value, zaloLabelKeys: Array.from(cur) });
  };

  const setLimit = (raw: string) => {
    const n = parseInt(raw, 10);
    const clamped = Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 200;
    onChange({ ...value, limit: clamped });
  };

  return (
    <div className={`bg-card border border-border rounded-xl ${compact ? 'p-2.5 space-y-2.5 text-xs' : 'p-4 space-y-3 text-xs'}`}>
      {/* Top mode switcher */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {hasActiveThread && (
            <button
              type="button"
              onClick={() => onChange({ ...value, enabled: true, mode: 'current_thread' })}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                mode === 'current_thread'
                  ? 'bg-blue-600 text-white'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {tr('Hội thoại đang mở')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onChange({ ...value, enabled: true, mode: 'custom_filter' })}
            className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
              mode === 'custom_filter'
                ? 'bg-purple-600 text-white'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {tr('Lọc đa điều kiện')}
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...value, enabled: false, mode: 'off' })}
            className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
              mode === 'off'
                ? 'bg-accent text-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {tr('Tắt ngữ cảnh')}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {mode === 'custom_filter' && (
            <button
              type="button"
              onClick={() => onChange({
                enabled: true,
                mode: 'custom_filter',
                timePreset: '7d',
                threadType: 'all',
                limit: 200,
              })}
              className="px-2 py-1 rounded-md text-[11px] bg-muted hover:bg-accent text-muted-foreground hover:text-foreground"
            >
              {tr('Đặt lại')}
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted"
              title={tr('Thu gọn')}
            >
              <CloseIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {mode === 'current_thread' && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="text-muted-foreground">{tr('Số tin nhắn gần nhất của hội thoại hiện tại:')}</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={value.limit || 30}
            onChange={e => setLimit(e.target.value)}
            className="w-20 bg-background border border-input rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:border-blue-500"
          />
          <span className="text-[11px] text-muted-foreground">{tr('(tối đa 1.000 tin)')}</span>
        </div>
      )}

      {mode === 'custom_filter' && (
        <div className="space-y-3">
          {/* 1. Time range + Thread type + Limit */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">{tr('Khoảng thời gian')}</label>
              <div className="flex flex-wrap gap-1">
                {([
                  { id: 'all', label: tr('Tất cả') },
                  { id: 'today', label: tr('Hôm nay') },
                  { id: 'yesterday', label: tr('Hôm qua') },
                  { id: '7d', label: tr('7 ngày') },
                  { id: '30d', label: tr('30 ngày') },
                  { id: 'custom', label: tr('Tuỳ chọn') },
                ] as const).map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onChange({ ...value, timePreset: p.id })}
                    className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                      (value.timePreset || '7d') === p.id
                        ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {value.timePreset === 'custom' && (
                <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                  <input
                    type="datetime-local"
                    value={toLocalDatetimeValue(value.fromTs)}
                    onChange={e => onChange({ ...value, fromTs: e.target.value ? new Date(e.target.value).getTime() : null })}
                    className="bg-background border border-input rounded-md px-2 py-1 text-[11px] text-foreground"
                  />
                  <input
                    type="datetime-local"
                    value={toLocalDatetimeValue(value.toTs)}
                    onChange={e => onChange({ ...value, toTs: e.target.value ? new Date(e.target.value).getTime() : null })}
                    className="bg-background border border-input rounded-md px-2 py-1 text-[11px] text-foreground"
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div>
                <label className="block text-[11px] font-medium text-muted-foreground mb-1">{tr('Loại hội thoại & Số tin tối đa')}</label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {([
                    { id: 'all', label: tr('Tất cả') },
                    { id: 'direct', label: tr('Trực tiếp 1-1') },
                    { id: 'group', label: tr('Nhóm') },
                  ] as const).map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onChange({ ...value, threadType: t.id })}
                      className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                        (value.threadType || 'all') === t.id
                          ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                  <div className="flex items-center gap-1 ml-auto">
                    <span className="text-[11px] text-muted-foreground">{tr('Tối đa:')}</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={value.limit || 200}
                      onChange={e => setLimit(e.target.value)}
                      className="w-16 bg-background border border-input rounded-md px-2 py-1 text-[11px] text-foreground"
                    />
                  </div>
                </div>
              </div>

              <div>
                <input
                  type="text"
                  value={value.keyword || ''}
                  onChange={e => onChange({ ...value, keyword: e.target.value })}
                  placeholder={tr('Lọc từ khóa trong nội dung tin nhắn (tùy chọn)...')}
                  className="w-full bg-background border border-input rounded-md px-2.5 py-1 text-[11px] text-foreground placeholder-muted-foreground focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          {/* 2. Channels & Accounts */}
          {options.accounts.length > 0 && (
            <div>
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                {tr('Kênh & Tài khoản nguồn (bỏ chọn hết = tất cả)')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {['zalo', 'facebook', 'telegram_user', 'telegram_bot'].map(ch => {
                  const hasCh = options.accounts.some(a => a.channel === ch);
                  if (!hasCh) return null;
                  const active = value.channels?.includes(ch);
                  return (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => toggleStringIn('channels', ch)}
                      className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                        active ? 'border-purple-500 bg-purple-600/25 text-purple-200' : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {CHANNEL_LABELS[ch] || ch}
                    </button>
                  );
                })}
                {options.accounts.map(acc => {
                  const active = value.accountIds?.includes(acc.zalo_id);
                  return (
                    <button
                      key={acc.zalo_id}
                      type="button"
                      onClick={() => toggleStringIn('accountIds', acc.zalo_id)}
                      className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                        active ? 'border-blue-500 bg-blue-600/25 text-blue-200' : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {acc.full_name || acc.zalo_id}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. Labels: Deplao (Local + CRM) & Zalo Cloud Labels */}
          {(options.localLabels.length > 0 || options.crmTags.length > 0 || zaloLabelGroups.length > 0 || options.accounts.some(a => !a.channel || a.channel === 'zalo')) && (() => {
            const deplaoSelectedCount = (value.localLabelIds?.length || 0) + (value.crmTagIds?.length || 0);
            const selectedZaloGroupCount = zaloLabelGroups.filter((g) =>
              g.keys.some((k) => (value.zaloLabelKeys || []).includes(k)),
            ).length;
            const totalSelected = deplaoSelectedCount + selectedZaloGroupCount;
            const matchMode = value.labelMatchMode || 'any';

            return (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <TagIcon className="w-3 h-3 text-muted-foreground" />
                    <span className="text-[11px] font-medium text-muted-foreground">{tr('Lọc theo Nhãn')}</span>
                    <div className="inline-flex bg-muted/70 rounded-md p-0.5 gap-0.5 ml-1">
                      <button
                        type="button"
                        onClick={() => setLabelSourceTab('local')}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                          labelSourceTab === 'local'
                            ? 'bg-blue-600 text-white'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <HardDriveIcon className="w-3 h-3" />
                        <span>{tr('Nhãn Deplao')}</span>
                        {deplaoSelectedCount > 0 && (
                          <span className="px-1 rounded-full bg-white/20 text-[9px]">{deplaoSelectedCount}</span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setLabelSourceTab('zalo')}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                          labelSourceTab === 'zalo'
                            ? 'bg-blue-600 text-white'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <CloudIcon className="w-3 h-3" />
                        <span>{tr('Nhãn Zalo')}</span>
                        {selectedZaloGroupCount > 0 && (
                          <span className="px-1 rounded-full bg-white/20 text-[9px]">{selectedZaloGroupCount}</span>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {totalSelected > 1 && (
                      <div className="inline-flex bg-muted/60 rounded-md p-0.5 gap-0.5 text-[10px]">
                        <button
                          type="button"
                          onClick={() => onChange({ ...value, labelMatchMode: 'any' })}
                          className={`px-1.5 py-0.5 rounded transition-colors ${
                            matchMode === 'any' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                          }`}
                          title={tr('Khớp hội thoại có ít nhất 1 nhãn đã chọn')}
                        >
                          {tr('Có 1 nhãn')}
                        </button>
                        <button
                          type="button"
                          onClick={() => onChange({ ...value, labelMatchMode: 'all' })}
                          className={`px-1.5 py-0.5 rounded transition-colors ${
                            matchMode === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                          }`}
                          title={tr('Chỉ lấy hội thoại có đủ tất cả nhãn đã chọn')}
                        >
                          {tr('Đủ nhãn')}
                        </button>
                      </div>
                    )}

                    {labelSourceTab === 'zalo' && (
                      <button
                        type="button"
                        disabled={refreshingZaloLabels}
                        onClick={() => { void handleRefreshZaloLabels(); }}
                        className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 disabled:opacity-50"
                        title={tr('Tải lại danh sách Nhãn Zalo mới nhất')}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={refreshingZaloLabels ? 'animate-spin' : ''}>
                          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                        </svg>
                        <span>{refreshingZaloLabels ? tr('Đang tải...') : tr('Cập nhật')}</span>
                      </button>
                    )}

                    {totalSelected > 0 && (
                      <button
                        type="button"
                        onClick={() => onChange({ ...value, localLabelIds: [], crmTagIds: [], zaloLabelKeys: [] })}
                        className="text-[10px] text-muted-foreground hover:text-foreground underline"
                      >
                        {tr('Xoá lọc')}
                      </button>
                    )}
                  </div>
                </div>

                {labelSourceTab === 'local' ? (
                  <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {options.localLabels.length === 0 && options.crmTags.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground italic py-1">
                        {tr('Chưa có Nhãn Local / Tag CRM. Hãy chuyển sang tab Nhãn Zalo hoặc tạo nhãn trong Cài đặt.')}
                      </span>
                    ) : (
                      <>
                        {options.localLabels.map(lbl => {
                          const active = value.localLabelIds?.includes(lbl.id);
                          return (
                            <button
                              key={`ll_${lbl.id}`}
                              type="button"
                              onClick={() => toggleNumberIn('localLabelIds', lbl.id)}
                              className={`px-2 py-0.5 rounded-full text-[11px] border inline-flex items-center gap-1 transition-colors ${
                                active ? 'border-blue-400 bg-blue-600/30 text-white' : 'border-border bg-background text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              <span>{lbl.emoji || '🏷️'}</span>
                              <span>{lbl.name}</span>
                            </button>
                          );
                        })}
                        {options.crmTags.map(tag => {
                          const active = value.crmTagIds?.includes(tag.id);
                          return (
                            <button
                              key={`crm_${tag.id}`}
                              type="button"
                              onClick={() => toggleNumberIn('crmTagIds', tag.id)}
                              className={`px-2 py-0.5 rounded-full text-[11px] border inline-flex items-center gap-1 transition-colors ${
                                active ? 'border-emerald-400 bg-emerald-600/30 text-white' : 'border-border bg-background text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              <span>{tag.emoji || '🔖'}</span>
                              <span>{tag.name} (CRM)</span>
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {zaloLabelGroups.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground italic py-1">
                        {refreshingZaloLabels ? tr('Đang tải nhãn Zalo...') : tr('Chưa có dữ liệu Nhãn Zalo — bấm "Cập nhật" để tải.')}
                      </span>
                    ) : (
                      zaloLabelGroups.map(grp => {
                        const active = grp.keys.some((k) => (value.zaloLabelKeys || []).includes(k));
                        return (
                          <button
                            key={`zl_${grp.groupKey}`}
                            type="button"
                            onClick={() => toggleZaloLabelGroup(grp.keys)}
                            className={`px-2 py-0.5 rounded-full text-[11px] border inline-flex items-center gap-1.5 transition-colors ${
                              active ? 'border-blue-400 bg-blue-600/30 text-white' : 'border-border bg-background text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <span
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: grp.color || '#3b82f6' }}
                            />
                            {grp.emoji && <span>{grp.emoji}</span>}
                            <span>{grp.text}</span>
                            <span className="text-[10px] opacity-70">({grp.convCount})</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* 4. Multi-select Conversations & Senders */}
          <div className={`grid gap-2.5 ${compact ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
            {/* Conversations */}
            <div className="border border-border rounded-lg bg-background/60 p-2 flex flex-col">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[11px] font-medium text-foreground">
                  {tr('Chọn hội thoại')} ({value.threadKeys?.length ? tr('{{n}} đã chọn', { n: value.threadKeys.length }) : tr('Tất cả')})
                </span>
                {!!value.threadKeys?.length && (
                  <button
                    type="button"
                    onClick={() => onChange({ ...value, threadKeys: [] })}
                    className="text-[10px] text-blue-400 hover:underline"
                  >
                    {tr('Chọn tất cả')}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 bg-card border border-input rounded-md px-2 py-1 mb-1.5">
                <SearchIcon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <input
                  type="text"
                  value={threadSearch}
                  onChange={e => setThreadSearch(e.target.value)}
                  placeholder={tr('Tìm hội thoại...')}
                  className="w-full bg-transparent text-[11px] outline-none text-foreground"
                />
              </div>
              <div className="max-h-36 overflow-y-auto space-y-0.5">
                {loadingOpts ? (
                  <div className="text-[11px] text-muted-foreground py-3 text-center">{tr('Đang tải...')}</div>
                ) : filteredThreads.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground py-3 text-center">{tr('Không có hội thoại khớp')}</div>
                ) : (
                  filteredThreads.slice(0, 120).map(t => {
                    const checked = selectedThreadSet.has(`${t.account_id}::${t.thread_id}`);
                    return (
                      <button
                        key={`${t.account_id}_${t.thread_id}`}
                        type="button"
                        onClick={() => toggleThread(t.account_id, t.thread_id)}
                        className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[11px] transition-colors ${
                          checked ? 'bg-blue-600/20 text-foreground' : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                          checked ? 'bg-blue-600 border-blue-600 text-white' : 'border-input'
                        }`}>
                          {checked && <CheckIcon className="w-2.5 h-2.5" />}
                        </span>
                        <span className="truncate flex-1">{t.name}</span>
                        <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0">
                          {CHANNEL_LABELS[t.channel] || t.channel}{t.contact_type === 'group' ? ' · Nhóm' : ''}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Senders */}
            <div className="border border-border rounded-lg bg-background/60 p-2 flex flex-col">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[11px] font-medium text-foreground flex items-center gap-1">
                  <UsersIcon className="w-3 h-3" />
                  <span>{tr('Người gửi')} ({value.senderIds?.length ? tr('{{n}} đã chọn', { n: value.senderIds.length }) : tr('Tất cả')})</span>
                </span>
                {!!value.senderIds?.length && (
                  <button
                    type="button"
                    onClick={() => onChange({ ...value, senderIds: [] })}
                    className="text-[10px] text-blue-400 hover:underline"
                  >
                    {tr('Tất cả')}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 bg-card border border-input rounded-md px-2 py-1 mb-1.5">
                <SearchIcon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <input
                  type="text"
                  value={senderSearch}
                  onChange={e => setSenderSearch(e.target.value)}
                  placeholder={tr('Tìm người gửi...')}
                  className="w-full bg-transparent text-[11px] outline-none text-foreground"
                />
              </div>
              <div className="max-h-36 overflow-y-auto space-y-0.5">
                {loadingSenders ? (
                  <div className="text-[11px] text-muted-foreground py-3 text-center">{tr('Đang tải người gửi...')}</div>
                ) : filteredSenders.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground py-3 text-center">{tr('Chưa có dữ liệu người gửi')}</div>
                ) : (
                  filteredSenders.map(s => {
                    const checked = !!value.senderIds?.includes(s.senderId);
                    return (
                      <button
                        key={s.senderId}
                        type="button"
                        onClick={() => toggleStringIn('senderIds', s.senderId)}
                        className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[11px] transition-colors ${
                          checked ? 'bg-purple-600/20 text-foreground' : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                          checked ? 'bg-purple-600 border-purple-600 text-white' : 'border-input'
                        }`}>
                          {checked && <CheckIcon className="w-2.5 h-2.5" />}
                        </span>
                        <span className="truncate flex-1">{s.displayName}</span>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0">{s.msgCount} tin</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* 5. Live Preview Action Bar */}
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/60 flex-wrap">
            <div className="text-[11px] text-muted-foreground">
              {previewInfo
                ? tr('Khớp {{count}} tin nhắn từ {{threads}} hội thoại', { count: previewInfo.count, threads: previewInfo.threadCount })
                : tr('Bấm "Kiểm tra khớp" để xem trước số tin nhắn sẽ nạp vào AI')}
            </div>
            <button
              type="button"
              disabled={checking}
              onClick={() => runPreview(value)}
              className="px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/40 text-blue-300 text-[11px] font-medium transition-colors disabled:opacity-50"
            >
              {checking ? tr('Đang kiểm tra...') : tr('Kiểm tra khớp')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
