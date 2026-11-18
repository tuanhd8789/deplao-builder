import React from 'react';
import { Button, Select, Switch } from '@/components/ui';
import { DownloadIcon } from '@/components/common/icons';
import { AccountAvatar } from '@/components/common/accounts/AccountAvatar';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAutoDownloadStore, useAccountAutoDownloadState } from '@/store/media/autoDownloadStore';
import {
  getAccountAutoDownloadMode,
  resolveEffectiveAccountAutoDownload,
  type AutoDownloadMode,
} from '../../../../models/media/autoDownload';
import { getChannelLabel, resolveAccountChannel } from '../../../../configs/channels/channelConfig';
import { SettingsRow, SettingsSection } from '../settingsUi';
import { tr } from '../../../../shared/i18n';

/**
 * Storage Settings block: controls app-wide automatic attachment downloading plus quick per-account overrides
 * and resets for per-conversation overrides.
 */
export default function AutoDownloadSettingsSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const prefs = useAutoDownloadStore((s) => s.prefs);
  const setGlobalEnabled = useAutoDownloadStore((s) => s.setGlobalEnabled);
  const setAccountMode = useAutoDownloadStore((s) => s.setAccountMode);
  const clearThreadOverrides = useAutoDownloadStore((s) => s.clearThreadOverrides);

  const threadOverrideCount = Object.keys(prefs.threads).length;

  return (
    <SettingsSection
      title={tr('Tự động tải file đính kèm')}
      description={tr('Kiểm soát việc tự động tải ảnh, video, ghi âm và tệp về máy. Khi tắt, bạn vẫn bấm trực tiếp vào từng file trong hội thoại để tải khi cần.')}
    >
      <SettingsRow
        title={tr('Tự động tải trên toàn bộ phần mềm')}
        description={
          prefs.globalEnabled
            ? tr('Mặc định đang bật cho mọi tài khoản và cuộc trò chuyện (trừ nơi đặt tắt riêng).')
            : tr('Mặc định đang tắt cho toàn phần mềm — chỉ tải khi bạn bấm xem hoặc bật riêng.')
        }
        control={
          <Switch
            aria-label={tr('Tự động tải file đính kèm trên toàn bộ phần mềm')}
            checked={prefs.globalEnabled}
            onCheckedChange={(checked) => { void setGlobalEnabled(checked); }}
          />
        }
      />

      {accounts.length > 0 && (
        <div className="space-y-1 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {tr('Cài đặt theo từng tài khoản')}
            </span>
            {threadOverrideCount > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{tr('{{count}} hội thoại đang đặt riêng', { count: threadOverrideCount })}</span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => { void clearThreadOverrides(); }}
                >
                  {tr('Đặt lại theo mặc định')}
                </Button>
              </div>
            )}
          </div>

          <div className="divide-y divide-border/40 rounded-lg border border-border/50 bg-muted/20">
            {accounts.map((acc) => {
              const name = acc.full_name || acc.display_name || acc.zalo_id;
              const mode = getAccountAutoDownloadMode(prefs, acc.zalo_id, acc.facebook_id);
              const effective = resolveEffectiveAccountAutoDownload(prefs, acc.zalo_id, acc.facebook_id);
              const globalLabel = prefs.globalEnabled ? tr('Đang bật') : tr('Đang tắt');

              return (
                <div key={acc.zalo_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <AccountAvatar account={acc} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">{name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {getChannelLabel(resolveAccountChannel(acc))}
                      {' · '}
                      <span className={effective ? 'text-foreground/80' : 'text-amber-500 dark:text-amber-400'}>
                        {effective ? tr('Đang tự động tải') : tr('Không tự động tải')}
                      </span>
                    </p>
                  </div>
                  <Select
                    aria-label={tr('Tự động tải file cho {{name}}', { name })}
                    value={mode}
                    onChange={(e) => { void setAccountMode(acc.zalo_id, e.target.value as AutoDownloadMode); }}
                    wrapperClassName="w-52"
                  >
                    <option value="inherit">{tr('Theo cài đặt chung ({{state}})', { state: globalLabel })}</option>
                    <option value="on">{tr('Luôn tự động tải')}</option>
                    <option value="off">{tr('Không tự động tải')}</option>
                  </Select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {accounts.length === 0 && threadOverrideCount > 0 && (
        <SettingsRow
          title={tr('Hội thoại đặt chế độ riêng')}
          description={tr('{{count}} cuộc trò chuyện đang ghi đè cấu hình chung.', { count: threadOverrideCount })}
          control={
            <Button variant="ghost" size="sm" onClick={() => { void clearThreadOverrides(); }}>
              {tr('Đặt lại theo mặc định')}
            </Button>
          }
        />
      )}
    </SettingsSection>
  );
}

/**
 * Compact per-account row placed directly inside each AccountCard in Settings → Accounts.
 */
export function AutoDownloadAccountLine({ accountId }: { accountId: string }) {
  const { mode, effective, globalEnabled } = useAccountAutoDownloadState(accountId);
  const setAccountMode = useAutoDownloadStore((s) => s.setAccountMode);
  const globalLabel = globalEnabled ? tr('Đang bật') : tr('Đang tắt');

  return (
    <div className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5">
      <span className="flex-shrink-0 text-muted-foreground">
        <DownloadIcon className="h-4 w-4" />
      </span>
      <span className="flex-shrink-0 text-[13px] text-foreground">{tr('Tự động tải file đính kèm')}</span>
      <span className="ml-auto min-w-0 truncate text-right text-xs text-muted-foreground">
        {effective ? tr('Đang bật') : tr('Đang tắt')}
      </span>
      <Select
        aria-label={tr('Tự động tải file đính kèm')}
        value={mode}
        onChange={(e) => { void setAccountMode(accountId, e.target.value as AutoDownloadMode); }}
        wrapperClassName="w-48 flex-shrink-0"
      >
        <option value="inherit">{tr('Theo mặc định ({{state}})', { state: globalLabel })}</option>
        <option value="on">{tr('Tự động tải')}</option>
        <option value="off">{tr('Không tự động tải')}</option>
      </Select>
    </div>
  );
}
