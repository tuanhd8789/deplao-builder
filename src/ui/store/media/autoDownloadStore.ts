import { create } from 'zustand';
import ipc from '@/lib/ipc';
import { useAccountStore } from '../accounts/accountStore';
import {
  clearThreadAutoDownloadOverrides,
  DEFAULT_AUTO_DOWNLOAD_PREFS,
  getAccountAutoDownloadMode,
  getThreadAutoDownloadMode,
  normalizeAutoDownloadPrefs,
  resolveEffectiveAccountAutoDownload,
  resolveEffectiveAutoDownload,
  withAccountAutoDownload,
  withGlobalAutoDownload,
  withThreadAutoDownload,
  type AutoDownloadMode,
  type AutoDownloadPrefs,
} from '../../../models/media/autoDownload';

function resolveAccountAlias(accountId?: string | null): string | undefined {
  const id = String(accountId || '').trim();
  if (!id) return undefined;
  const accounts = useAccountStore.getState().accounts;
  const matched = accounts.find((a) => a.zalo_id === id || a.facebook_id === id);
  if (!matched) return undefined;
  return matched.zalo_id === id ? matched.facebook_id : matched.zalo_id;
}

function canonicalAccountKey(accountId?: string | null): string {
  const id = String(accountId || '').trim();
  if (!id) return '';
  const accounts = useAccountStore.getState().accounts;
  const matched = accounts.find((a) => a.zalo_id === id || a.facebook_id === id);
  return matched?.zalo_id || id;
}

interface AutoDownloadState {
  prefs: AutoDownloadPrefs;
  loaded: boolean;
  reload: () => Promise<void>;
  setGlobalEnabled: (enabled: boolean) => Promise<void>;
  setAccountMode: (accountId: string, mode: AutoDownloadMode) => Promise<void>;
  setThreadMode: (accountId: string, threadId: string, mode: AutoDownloadMode) => Promise<void>;
  clearThreadOverrides: (accountId?: string) => Promise<void>;
  shouldAutoDownload: (accountId?: string | null, threadId?: string | null) => boolean;
}

export const useAutoDownloadStore = create<AutoDownloadState>((set, get) => ({
  prefs: DEFAULT_AUTO_DOWNLOAD_PREFS,
  loaded: false,

  reload: async () => {
    try {
      const res = await ipc.file?.getAutoDownloadPrefs?.();
      if (res?.success && res.prefs) {
        set({ prefs: normalizeAutoDownloadPrefs(res.prefs), loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  setGlobalEnabled: async (enabled) => {
    const optimistic = withGlobalAutoDownload(get().prefs, enabled);
    set({ prefs: optimistic });
    try {
      const res = await ipc.file?.setAutoDownloadPrefs?.({ globalEnabled: enabled });
      if (res?.success && res.prefs) {
        set({ prefs: normalizeAutoDownloadPrefs(res.prefs), loaded: true });
      }
    } catch {}
  },

  setAccountMode: async (accountId, mode) => {
    const key = canonicalAccountKey(accountId);
    if (!key) return;
    const optimistic = withAccountAutoDownload(get().prefs, key, mode);
    set({ prefs: optimistic });
    try {
      const res = await ipc.file?.setAutoDownloadPrefs?.({ accountMode: { accountId: key, mode } });
      if (res?.success && res.prefs) {
        set({ prefs: normalizeAutoDownloadPrefs(res.prefs), loaded: true });
      }
    } catch {}
  },

  setThreadMode: async (accountId, threadId, mode) => {
    const key = canonicalAccountKey(accountId);
    const tid = String(threadId || '').trim();
    if (!key || !tid) return;
    const optimistic = withThreadAutoDownload(get().prefs, key, tid, mode);
    set({ prefs: optimistic });
    try {
      const res = await ipc.file?.setAutoDownloadPrefs?.({
        threadMode: { accountId: key, threadId: tid, mode },
      });
      if (res?.success && res.prefs) {
        set({ prefs: normalizeAutoDownloadPrefs(res.prefs), loaded: true });
      }
    } catch {}
  },

  clearThreadOverrides: async (accountId) => {
    const key = accountId ? canonicalAccountKey(accountId) : '';
    const alt = key ? resolveAccountAlias(key) : undefined;
    const optimistic = key
      ? clearThreadAutoDownloadOverrides(get().prefs, alt ? [key, alt] : [key])
      : clearThreadAutoDownloadOverrides(get().prefs);
    set({ prefs: optimistic });
    try {
      const res = await ipc.file?.setAutoDownloadPrefs?.({
        clearThreadOverrides: key ? { accountId: key } : true,
      });
      if (res?.success && res.prefs) {
        set({ prefs: normalizeAutoDownloadPrefs(res.prefs), loaded: true });
      }
    } catch {}
  },

  shouldAutoDownload: (accountId, threadId) => {
    const alt = resolveAccountAlias(accountId);
    return resolveEffectiveAutoDownload(get().prefs, accountId, threadId, alt);
  },
}));

/**
 * Subscribe to main-process auto-download policy updates + workspace switches.
 * Safe to invoke from App mount effect; returns cleanup unsubscriber.
 */
export function initAutoDownloadStore(): () => void {
  const reload = () => {
    void useAutoDownloadStore.getState().reload();
  };
  reload();
  const unsubChanged = ipc.on?.('file:autoDownloadPrefsChanged', (next: AutoDownloadPrefs) => {
    useAutoDownloadStore.setState({ prefs: normalizeAutoDownloadPrefs(next), loaded: true });
  });
  const unsubWs = ipc.on?.('workspace:switched', reload);
  const unsubSync = ipc.on?.('workspace:syncComplete', reload);
  return () => {
    unsubChanged?.();
    unsubWs?.();
    unsubSync?.();
  };
}

export function useShouldAutoDownload(accountId?: string | null, threadId?: string | null): boolean {
  return useAutoDownloadStore((s) =>
    resolveEffectiveAutoDownload(s.prefs, accountId, threadId, resolveAccountAlias(accountId)),
  );
}

export function useAccountAutoDownloadState(accountId?: string | null): {
  mode: AutoDownloadMode;
  effective: boolean;
  globalEnabled: boolean;
} {
  return useAutoDownloadStore((s) => {
    const alt = resolveAccountAlias(accountId);
    return {
      mode: getAccountAutoDownloadMode(s.prefs, accountId, alt),
      effective: resolveEffectiveAccountAutoDownload(s.prefs, accountId, alt),
      globalEnabled: s.prefs.globalEnabled,
    };
  });
}

export function useThreadAutoDownloadState(accountId?: string | null, threadId?: string | null): {
  mode: AutoDownloadMode;
  effective: boolean;
  inheritedEffective: boolean;
} {
  return useAutoDownloadStore((s) => {
    const alt = resolveAccountAlias(accountId);
    const mode = getThreadAutoDownloadMode(s.prefs, accountId, threadId, alt);
    const inheritedEffective = resolveEffectiveAccountAutoDownload(s.prefs, accountId, alt);
    const effective = mode === 'on' ? true : mode === 'off' ? false : inheritedEffective;
    return { mode, effective, inheritedEffective };
  });
}
