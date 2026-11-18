/**
 * Hierarchical 3-tier automatic attachment download settings & pure resolution helpers.
 * Precedence: Thread (Conversation) override > Account override > Global App setting.
 *
 * Shared between Electron main / services (tsconfig.electron.json, ES2020 lib) and React UI.
 */

export type AutoDownloadMode = 'inherit' | 'on' | 'off';
export type AutoDownloadExplicit = 'on' | 'off';

export interface AutoDownloadPrefs {
  /** App-wide default: true = auto-download incoming/visible attachments (default). */
  globalEnabled: boolean;
  /** Per-account overrides keyed by accountId (zalo_id / fb id). Absence = 'inherit'. */
  accounts: Record<string, AutoDownloadExplicit>;
  /** Per-conversation overrides keyed by `${accountId}:${threadId}`. Absence = 'inherit'. */
  threads: Record<string, AutoDownloadExplicit>;
}

export const AUTO_DOWNLOAD_SETTINGS_KEY = 'media_auto_download_prefs';

export const DEFAULT_AUTO_DOWNLOAD_PREFS: AutoDownloadPrefs = {
  globalEnabled: true,
  accounts: {},
  threads: {},
};

function isExplicit(val: unknown): val is AutoDownloadExplicit {
  return val === 'on' || val === 'off';
}

export function makeThreadAutoDownloadKey(accountId: string, threadId: string): string {
  return `${String(accountId || '').trim()}:${String(threadId || '').trim()}`;
}

export function normalizeAutoDownloadPrefs(raw: unknown): AutoDownloadPrefs {
  let obj: any = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { globalEnabled: true, accounts: {}, threads: {} };
  }

  const accounts: Record<string, AutoDownloadExplicit> = {};
  if (obj.accounts && typeof obj.accounts === 'object') {
    for (const [k, v] of Object.entries(obj.accounts)) {
      const key = String(k || '').trim();
      if (key && isExplicit(v)) accounts[key] = v;
    }
  }

  const threads: Record<string, AutoDownloadExplicit> = {};
  if (obj.threads && typeof obj.threads === 'object') {
    for (const [k, v] of Object.entries(obj.threads)) {
      const key = String(k || '').trim();
      if (key && key.includes(':') && isExplicit(v)) threads[key] = v;
    }
  }

  return {
    globalEnabled: obj.globalEnabled !== false,
    accounts,
    threads,
  };
}

export function getAccountAutoDownloadMode(
  prefs: AutoDownloadPrefs | null | undefined,
  accountId?: string | null,
  altAccountId?: string | null,
): AutoDownloadMode {
  if (!prefs || !accountId) return 'inherit';
  const primary = prefs.accounts[String(accountId).trim()];
  if (isExplicit(primary)) return primary;
  if (altAccountId) {
    const secondary = prefs.accounts[String(altAccountId).trim()];
    if (isExplicit(secondary)) return secondary;
  }
  return 'inherit';
}

export function getThreadAutoDownloadMode(
  prefs: AutoDownloadPrefs | null | undefined,
  accountId?: string | null,
  threadId?: string | null,
  altAccountId?: string | null,
): AutoDownloadMode {
  if (!prefs || !accountId || !threadId) return 'inherit';
  const primary = prefs.threads[makeThreadAutoDownloadKey(accountId, threadId)];
  if (isExplicit(primary)) return primary;
  if (altAccountId) {
    const secondary = prefs.threads[makeThreadAutoDownloadKey(altAccountId, threadId)];
    if (isExplicit(secondary)) return secondary;
  }
  return 'inherit';
}

export function resolveEffectiveAccountAutoDownload(
  prefs: AutoDownloadPrefs | null | undefined,
  accountId?: string | null,
  altAccountId?: string | null,
): boolean {
  const safe = prefs || DEFAULT_AUTO_DOWNLOAD_PREFS;
  const accMode = getAccountAutoDownloadMode(safe, accountId, altAccountId);
  if (accMode === 'on') return true;
  if (accMode === 'off') return false;
  return safe.globalEnabled;
}

export function resolveEffectiveAutoDownload(
  prefs: AutoDownloadPrefs | null | undefined,
  accountId?: string | null,
  threadId?: string | null,
  altAccountId?: string | null,
): boolean {
  const safe = prefs || DEFAULT_AUTO_DOWNLOAD_PREFS;
  if (accountId && threadId) {
    const threadMode = getThreadAutoDownloadMode(safe, accountId, threadId, altAccountId);
    if (threadMode === 'on') return true;
    if (threadMode === 'off') return false;
  }
  if (accountId) {
    return resolveEffectiveAccountAutoDownload(safe, accountId, altAccountId);
  }
  return safe.globalEnabled;
}

export function withGlobalAutoDownload(
  prefs: AutoDownloadPrefs,
  globalEnabled: boolean,
): AutoDownloadPrefs {
  return {
    globalEnabled: !!globalEnabled,
    accounts: { ...prefs.accounts },
    threads: { ...prefs.threads },
  };
}

export function withAccountAutoDownload(
  prefs: AutoDownloadPrefs,
  accountId: string,
  mode: AutoDownloadMode,
): AutoDownloadPrefs {
  const key = String(accountId || '').trim();
  if (!key) return prefs;
  const accounts = { ...prefs.accounts };
  if (mode === 'inherit') delete accounts[key];
  else accounts[key] = mode;
  return {
    globalEnabled: prefs.globalEnabled,
    accounts,
    threads: { ...prefs.threads },
  };
}

export function withThreadAutoDownload(
  prefs: AutoDownloadPrefs,
  accountId: string,
  threadId: string,
  mode: AutoDownloadMode,
): AutoDownloadPrefs {
  const acc = String(accountId || '').trim();
  const thread = String(threadId || '').trim();
  if (!acc || !thread) return prefs;
  const key = makeThreadAutoDownloadKey(acc, thread);
  const threads = { ...prefs.threads };
  if (mode === 'inherit') delete threads[key];
  else threads[key] = mode;
  return {
    globalEnabled: prefs.globalEnabled,
    accounts: { ...prefs.accounts },
    threads,
  };
}

export function clearThreadAutoDownloadOverrides(
  prefs: AutoDownloadPrefs,
  accountIds?: string[],
): AutoDownloadPrefs {
  if (!accountIds || accountIds.length === 0) {
    return {
      globalEnabled: prefs.globalEnabled,
      accounts: { ...prefs.accounts },
      threads: {},
    };
  }
  const prefixes = new Set(accountIds.map((id) => `${String(id || '').trim()}:`).filter((p) => p.length > 1));
  const threads: Record<string, AutoDownloadExplicit> = {};
  for (const [k, v] of Object.entries(prefs.threads)) {
    let matches = false;
    for (const p of prefixes) {
      if (k.startsWith(p)) {
        matches = true;
        break;
      }
    }
    if (!matches) threads[k] = v;
  }
  return {
    globalEnabled: prefs.globalEnabled,
    accounts: { ...prefs.accounts },
    threads,
  };
}
