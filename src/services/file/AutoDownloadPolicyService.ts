import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';
import {
  AUTO_DOWNLOAD_SETTINGS_KEY,
  clearThreadAutoDownloadOverrides,
  DEFAULT_AUTO_DOWNLOAD_PREFS,
  normalizeAutoDownloadPrefs,
  resolveEffectiveAutoDownload,
  withAccountAutoDownload,
  withGlobalAutoDownload,
  withThreadAutoDownload,
  type AutoDownloadMode,
  type AutoDownloadPrefs,
} from '../../models/media/autoDownload';

/**
 * Manages the 3-tier automatic attachment download policy with an O(1) in-memory cache
 * synced with SQLite (`app_settings`). Scoped per DB path so workspace/storage switches stay clean.
 */
class AutoDownloadPolicyService {
  private static instance: AutoDownloadPolicyService;

  private cachedDbPath: string | null = null;
  private cachedPrefs: AutoDownloadPrefs | null = null;
  private fbAliasMap = new Map<string, string>();
  private fbAliasLoadedAt = 0;

  private constructor() {}

  public static getInstance(): AutoDownloadPolicyService {
    if (!AutoDownloadPolicyService.instance) {
      AutoDownloadPolicyService.instance = new AutoDownloadPolicyService();
    }
    return AutoDownloadPolicyService.instance;
  }

  public invalidateCache(): void {
    this.cachedDbPath = null;
    this.cachedPrefs = null;
    this.fbAliasMap.clear();
    this.fbAliasLoadedAt = 0;
  }

  private ensureLoaded(): AutoDownloadPrefs {
    try {
      const db = DatabaseService.getInstance();
      const dbPath = db?.getDbPath?.() || '';
      if (!db || !dbPath) {
        return DEFAULT_AUTO_DOWNLOAD_PREFS;
      }
      if (this.cachedPrefs && this.cachedDbPath === dbPath) {
        return this.cachedPrefs;
      }
      const raw = db.getSetting(AUTO_DOWNLOAD_SETTINGS_KEY);
      const parsed = raw ? normalizeAutoDownloadPrefs(raw) : { globalEnabled: true, accounts: {}, threads: {} };
      this.cachedDbPath = dbPath;
      this.cachedPrefs = parsed;
      return parsed;
    } catch {
      return this.cachedPrefs || DEFAULT_AUTO_DOWNLOAD_PREFS;
    }
  }

  private resolveAltAccountId(accountId?: string | null, altAccountId?: string | null): string | undefined {
    const cleanAlt = String(altAccountId || '').trim();
    if (cleanAlt && cleanAlt !== accountId) return cleanAlt;
    const id = String(accountId || '').trim();
    if (!id) return undefined;

    const now = Date.now();
    if (now - this.fbAliasLoadedAt > 30_000) {
      try {
        const db = DatabaseService.getInstance();
        if (db?.getDbPath?.()) {
          const rows = db.getFBAccounts?.() || [];
          const next = new Map<string, string>();
          for (const row of rows) {
            const uuid = String(row?.id || '').trim();
            const fbId = String(row?.facebook_id || '').trim();
            if (uuid && fbId && uuid !== fbId) {
              next.set(uuid, fbId);
              next.set(fbId, uuid);
            }
          }
          this.fbAliasMap = next;
          this.fbAliasLoadedAt = now;
        }
      } catch {
        // Non-fatal: keep existing map
      }
    }
    return this.fbAliasMap.get(id);
  }

  public getPrefs(): AutoDownloadPrefs {
    const prefs = this.ensureLoaded();
    return {
      globalEnabled: prefs.globalEnabled,
      accounts: { ...prefs.accounts },
      threads: { ...prefs.threads },
    };
  }

  public savePrefs(next: AutoDownloadPrefs): AutoDownloadPrefs {
    const normalized = normalizeAutoDownloadPrefs(next);
    try {
      const db = DatabaseService.getInstance();
      const dbPath = db?.getDbPath?.() || '';
      if (db && dbPath) {
        db.setSetting(AUTO_DOWNLOAD_SETTINGS_KEY, JSON.stringify(normalized));
        this.cachedDbPath = dbPath;
      }
    } catch (err: any) {
      Logger.warn(`[AutoDownloadPolicy] savePrefs DB error: ${err?.message || err}`);
    }
    this.cachedPrefs = normalized;
    try {
      // Lazy require to avoid circular dependency with EventBroadcaster at module init
      const EventBroadcaster = require('../event/EventBroadcaster').default;
      EventBroadcaster?.sendDirect?.('file:autoDownloadPrefsChanged', normalized);
    } catch {
      // Renderer may not be ready yet
    }
    return this.getPrefs();
  }

  public setGlobal(enabled: boolean): AutoDownloadPrefs {
    return this.savePrefs(withGlobalAutoDownload(this.ensureLoaded(), enabled));
  }

  public setAccountMode(accountId: string, mode: AutoDownloadMode): AutoDownloadPrefs {
    let prefs = withAccountAutoDownload(this.ensureLoaded(), accountId, mode);
    const alt = this.resolveAltAccountId(accountId);
    if (alt) {
      prefs = withAccountAutoDownload(prefs, alt, 'inherit');
      if (mode !== 'inherit') {
        prefs = withAccountAutoDownload(prefs, accountId, mode);
      }
    }
    return this.savePrefs(prefs);
  }

  public setThreadMode(accountId: string, threadId: string, mode: AutoDownloadMode): AutoDownloadPrefs {
    let prefs = withThreadAutoDownload(this.ensureLoaded(), accountId, threadId, mode);
    const alt = this.resolveAltAccountId(accountId);
    if (alt) {
      prefs = withThreadAutoDownload(prefs, alt, threadId, 'inherit');
      if (mode !== 'inherit') {
        prefs = withThreadAutoDownload(prefs, accountId, threadId, mode);
      }
    }
    return this.savePrefs(prefs);
  }

  public clearThreadOverrides(accountId?: string): AutoDownloadPrefs {
    const prefs = this.ensureLoaded();
    if (!accountId) {
      return this.savePrefs(clearThreadAutoDownloadOverrides(prefs));
    }
    const ids = [accountId];
    const alt = this.resolveAltAccountId(accountId);
    if (alt) ids.push(alt);
    return this.savePrefs(clearThreadAutoDownloadOverrides(prefs, ids));
  }

  /**
   * Synchronous O(1) check used by high-throughput message ingress paths across Zalo, Facebook, and Telegram.
   */
  public shouldAutoDownload(
    accountId?: string | null,
    threadId?: string | null,
    altAccountId?: string | null,
  ): boolean {
    const prefs = this.ensureLoaded();
    const resolvedAlt = this.resolveAltAccountId(accountId, altAccountId);
    return resolveEffectiveAutoDownload(prefs, accountId, threadId, resolvedAlt);
  }
}

export default AutoDownloadPolicyService;
