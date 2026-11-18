import React from 'react';
import { DownloadIcon } from '@/components/common/icons';
import { Select } from '@/components/ui';
import { useAutoDownloadStore, useThreadAutoDownloadState } from '@/store/media/autoDownloadStore';
import type { AutoDownloadMode } from '../../../../models/media/autoDownload';
import { tr } from '../../../../shared/i18n';

/**
 * Per-conversation automatic attachment download control shown inside the right ConversationInfo / GroupInfoPanel sidebar.
 */
export default function ConversationAutoDownloadSection({
  accountId,
  threadId,
  bordered = true,
  className = '',
}: {
  accountId: string;
  threadId: string;
  bordered?: boolean;
  className?: string;
}) {
  const { mode, effective, inheritedEffective } = useThreadAutoDownloadState(accountId, threadId);
  const setThreadMode = useAutoDownloadStore((s) => s.setThreadMode);
  const inheritedLabel = inheritedEffective ? tr('Đang bật') : tr('Đang tắt');

  return (
    <section className={`space-y-2 px-4 py-3 ${bordered ? 'border-t border-border' : ''} ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <DownloadIcon className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{tr('Tự động tải file đính kèm')}</span>
        </p>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
            effective ? 'bg-primary/15 text-primary' : 'bg-amber-500/15 text-amber-500 dark:text-amber-400'
          }`}
        >
          {effective ? tr('Đang bật') : tr('Đang tắt')}
        </span>
      </div>

      <Select
        value={mode}
        aria-label={tr('Tự động tải file đính kèm')}
        onChange={(e) => { void setThreadMode(accountId, threadId, e.target.value as AutoDownloadMode); }}
      >
        <option value="inherit">{tr('Theo tài khoản ({{state}})', { state: inheritedLabel })}</option>
        <option value="on">{tr('Luôn tự động tải')}</option>
        <option value="off">{tr('Không tự động tải')}</option>
      </Select>

      <p className="text-[11px] leading-4 text-subtle-foreground">
        {effective
          ? tr('Ảnh, video và tệp gửi mới sẽ tự động tải về máy.')
          : tr('Không tự tải nền cho hội thoại này — bấm trực tiếp vào ảnh/file để tải khi cần.')}
      </p>
    </section>
  );
}
