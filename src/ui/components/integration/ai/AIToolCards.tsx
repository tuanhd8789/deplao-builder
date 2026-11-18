/**
 * AIToolCards.tsx
 * Displays executed Read tool traces (collapsible) and interactive Human-in-the-Loop
 * confirmation cards for Write tools (ERP Task/Calendar/Note, CRM Note, Labels, Send Message).
 */
import React, { useState } from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { sendQuickText } from '@/lib/chat/send/quickChatSend';
import { CheckIcon, CloseIcon, WrenchIcon } from '@/components/common/icons';
import type { AIExecutedToolTrace, AIPendingToolAction } from '../../../../models/ai/ai';
import { tr } from '../../../../shared/i18n';

export function ExecutedToolsBadge({ tools }: { tools?: AIExecutedToolTrace[] }) {
  const [open, setOpen] = useState(false);
  if (!tools || tools.length === 0) return null;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/60 transition-colors"
      >
        <WrenchIcon className="w-3 h-3 text-blue-400" />
        <span>{tr('Đã tra cứu {{count}} công cụ', { count: tools.length })}</span>
        <span className="text-[10px] opacity-70">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-1.5 space-y-1 pl-2 border-l-2 border-blue-500/40">
          {tools.map((t, idx) => (
            <div key={t.id || idx} className="text-[11px] bg-background/50 rounded px-2 py-1 border border-border/50">
              <div className="font-medium text-foreground flex items-center justify-between gap-2">
                <span>{t.label || t.name}</span>
                <span className="text-[10px] text-green-400">{t.summary}</span>
              </div>
              {t.args && Object.keys(t.args).length > 0 && (
                <div className="text-[10px] text-muted-foreground truncate mt-0.5 font-mono">
                  {JSON.stringify(t.args)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PendingActionCard({
  action,
  onUpdate,
}: {
  action: AIPendingToolAction;
  onUpdate: (updated: AIPendingToolAction) => void;
}) {
  const [running, setRunning] = useState(false);
  const showNotification = useAppStore(s => s.showNotification);

  const handleConfirm = async () => {
    if (running || action.status !== 'pending') return;
    setRunning(true);

    try {
      if (action.toolName === 'send_chat_message') {
        const accountId = String(action.args?.accountId || '');
        const threadId = String(action.args?.threadId || '');
        const message = String(action.args?.message || '');
        if (!accountId || !threadId || !message) {
          throw new Error(tr('Thiếu thông tin tài khoản, hội thoại hoặc nội dung gửi'));
        }
        const accounts = useAccountStore.getState().accounts;
        const acc = accounts.find(a => a.zalo_id === accountId);
        const channel = String(acc?.channel || action.args?.channel || 'zalo');
        const auth = acc ? buildZaloAuth(acc, accountId) : undefined;
        const sendRes = await sendQuickText(
          {
            accountId,
            channel,
            threadId,
            threadType: Number(action.args?.threadType) === 1 ? 1 : 0,
            auth,
          },
          message,
        );
        if (!sendRes.success) {
          throw new Error(sendRes.error || tr('Gửi tin thất bại'));
        }
        const summary = tr('Đã gửi tin tới {{target}}', { target: action.args?.threadName || threadId });
        showNotification(summary, 'success');
        onUpdate({ ...action, status: 'approved', resultSummary: summary });
      } else {
        const res = await ipc.ai?.executeToolAction?.({
          toolName: action.toolName,
          args: action.args || {},
          assistantId: action.assistantId,
        });
        if (!res?.success) {
          throw new Error(res?.error || res?.summary || tr('Thực thi thất bại'));
        }
        const summary = res.summary || tr('Đã thực hiện thành công');
        showNotification(summary, 'success');
        onUpdate({ ...action, status: 'approved', resultSummary: summary });
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      showNotification(msg, 'error');
      onUpdate({ ...action, status: 'error', resultSummary: msg });
    } finally {
      setRunning(false);
    }
  };

  const handleReject = () => {
    if (running || action.status !== 'pending') return;
    onUpdate({ ...action, status: 'rejected', resultSummary: tr('Đã bỏ qua') });
  };

  const borderCls =
    action.status === 'approved' ? 'border-green-500/40 bg-green-950/20'
    : action.status === 'rejected' ? 'border-border/50 bg-muted/30 opacity-65'
    : action.status === 'error' ? 'border-red-500/40 bg-red-950/20'
    : 'border-amber-500/40 bg-amber-950/15';

  return (
    <div className={`mt-2 rounded-lg border p-2.5 text-xs ${borderCls}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground flex items-center gap-1.5">
            <WrenchIcon className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
            <span className="truncate">{action.title}</span>
          </div>
          {action.description && (
            <p className="text-[11px] text-muted-foreground mt-1 whitespace-pre-wrap break-words">
              {action.description}
            </p>
          )}
        </div>
      </div>

      {action.status === 'pending' ? (
        <div className="flex items-center gap-2 mt-2.5">
          <button
            type="button"
            disabled={running}
            onClick={handleConfirm}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium transition-colors"
          >
            <CheckIcon className="w-3.5 h-3.5" />
            <span>{running ? tr('Đang thực hiện...') : tr('Xác nhận thực hiện')}</span>
          </button>
          <button
            type="button"
            disabled={running}
            onClick={handleReject}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted hover:bg-accent text-muted-foreground hover:text-foreground text-[11px] transition-colors"
          >
            <CloseIcon className="w-3 h-3" />
            <span>{tr('Bỏ qua')}</span>
          </button>
        </div>
      ) : (
        <div className={`mt-2 text-[11px] font-medium ${
          action.status === 'approved' ? 'text-green-400'
          : action.status === 'error' ? 'text-red-400'
          : 'text-muted-foreground'
        }`}>
          {action.status === 'approved' ? `✓ ${action.resultSummary || tr('Đã thực hiện')}`
          : action.status === 'error' ? `✕ ${action.resultSummary || tr('Lỗi')}`
          : `— ${tr('Đã bỏ qua')}`}
        </div>
      )}
    </div>
  );
}

export function PendingActionList({
  actions,
  onUpdateAction,
}: {
  actions?: AIPendingToolAction[];
  onUpdateAction: (updated: AIPendingToolAction) => void;
}) {
  const [runningAll, setRunningAll] = useState(false);
  const showNotification = useAppStore(s => s.showNotification);

  if (!actions || actions.length === 0) return null;

  const backendPending = actions.filter(a => a.status === 'pending' && !a.clientSideExecution);

  const handleConfirmAll = async () => {
    if (runningAll || backendPending.length < 2) return;
    setRunningAll(true);
    let okCount = 0;
    let failCount = 0;
    for (const act of backendPending) {
      try {
        const res = await ipc.ai?.executeToolAction?.({
          toolName: act.toolName,
          args: act.args || {},
          assistantId: act.assistantId,
        });
        if (!res?.success) {
          throw new Error(res?.error || res?.summary || tr('Thực thi thất bại'));
        }
        okCount++;
        onUpdateAction({ ...act, status: 'approved', resultSummary: res.summary || tr('Đã thực hiện thành công') });
      } catch (err: any) {
        failCount++;
        onUpdateAction({ ...act, status: 'error', resultSummary: err?.message || String(err) });
      }
    }
    setRunningAll(false);
    if (okCount > 0 && failCount === 0) {
      showNotification(tr('Đã xác nhận và thực hiện {{count}} thao tác', { count: okCount }), 'success');
    } else if (failCount > 0) {
      showNotification(tr('Hoàn tất {{ok}} thao tác, {{fail}} lỗi', { ok: okCount, fail: failCount }), 'warning');
    }
  };

  return (
    <div className="mt-2 space-y-1.5">
      {backendPending.length >= 2 && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-amber-950/25 border border-amber-500/30 text-[11px]">
          <span className="text-amber-300 font-medium">
            {tr('{{count}} thao tác đề xuất đang chờ duyệt', { count: backendPending.length })}
          </span>
          <button
            type="button"
            disabled={runningAll}
            onClick={handleConfirmAll}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium transition-colors"
          >
            <CheckIcon className="w-3.5 h-3.5" />
            <span>{runningAll ? tr('Đang xử lý...') : tr('Xác nhận tất cả ({{count}})', { count: backendPending.length })}</span>
          </button>
        </div>
      )}
      {actions.map(act => (
        <PendingActionCard
          key={act.id}
          action={act}
          onUpdate={onUpdateAction}
        />
      ))}
    </div>
  );
}
