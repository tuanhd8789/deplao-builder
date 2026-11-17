/**
 * Download the `.db.crypt` backup file (URL taken from the syncmsg_info event).
 *
 * Follows the download request of Zalo PC (`handleCustomHeaders` in main-dist/main.js, option `cookies: true`):
 * sends ALL session cookies of the auth domain in the `cookie` header, plus no-cache headers; no
 * `Origin`/`Referer`. The header set below is the one PR #269 captured from Zalo (including the `Sec-Fetch-*` of Electron net).
 *
 * Does not use `fetch` (undici), because it always overrides `sec-fetch-mode: cors` and adds headers on its own → it cannot reproduce
 * the Zalo request. Uses `https.request` to control all the headers, and still goes through the account's proxy.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { tr } from '../../../shared/i18n';

/** Zalo domains: session cookies are only sent to these domains. */
export const ZALO_HOST_RE = /(^|\.)(zalo\.me|zaloapp\.com|zdn\.vn|zadn\.vn)$/i;

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60 * 1000;
/**
 * The phone uploads the backup to `trans-bin.zaloapp.com` AFTER sending `syncmsg_info`, so right after
 * the event the file is often not there yet (the download returns 404). Poll for up to this long, with
 * backoff, before giving up.
 */
const READY_TIMEOUT_MS = 120 * 1000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 15000;

/** Status meaning "the file is not on the server yet / a transient error" → worth waiting and retrying. */
function isNotReady(status: number): boolean {
    return status === 404 || status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/** Status where dropping the session cookie might help (the cookie/session was rejected). */
function isCookieRelated(status: number): boolean {
    return status === 400 || status === 401 || status === 403;
}

/** Wait `ms`, but reject early with DownloadAbortedError if the sync is cancelled meanwhile. */
function sleep(ms: number, shouldAbort?: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const step = 250;
        let waited = 0;
        const timer = setInterval(() => {
            if (shouldAbort?.()) { clearInterval(timer); reject(new DownloadAbortedError()); return; }
            waited += step;
            if (waited >= ms) { clearInterval(timer); resolve(); }
        }, step);
    });
}

export class DownloadAbortedError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}

export interface BackupDownloadOptions {
    url: string;
    userAgent: string;
    /** Session cookie (string `a=b; c=d`), only sent when the host belongs to Zalo. */
    sessionCookie: string;
    /** The account's proxy agent (zca-js ctx.options.agent), if any. */
    agent?: http.Agent;
    destPath: string;
    expectedSize?: number;
    onProgress?: (percent: number) => void;
    shouldAbort?: () => boolean;
    log?: (message: string) => void;
}

export function zaloDownloadHeaders(userAgent: string, cookie: string): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent': userAgent,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US',
        'Cache-Control': 'no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'none',
        Connection: 'keep-alive',
    };
    if (cookie) headers.Cookie = cookie;
    return headers;
}

function get(url: URL, headers: Record<string, string>, agent: http.Agent | undefined, redirectsLeft: number): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'http:' ? http : https;
        const req = lib.request(url, { method: 'GET', headers, agent }, res => {
            const status = res.statusCode || 0;
            const location = res.headers.location;
            if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
                res.resume();
                const next = new URL(location, url);
                const nextHeaders = { ...headers };
                if (!ZALO_HOST_RE.test(next.hostname)) delete nextHeaders.Cookie;
                get(next, nextHeaders, agent, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            resolve(res);
        });
        req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(tr('Máy chủ Zalo không phản hồi khi tải bản sao lưu'))));
        req.on('error', reject);
        req.end();
    });
}

function decoderFor(res: http.IncomingMessage): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
    switch (String(res.headers['content-encoding'] || '').toLowerCase()) {
        case 'gzip':
        case 'x-gzip':
            return zlib.createGunzip();
        case 'deflate':
            return zlib.createInflate();
        case 'br':
            return zlib.createBrotliDecompress();
        default:
            return null;
    }
}

/** Read at most `max` bytes of the error body, for logging / display. */
async function readSnippet(res: http.IncomingMessage, max = 1024): Promise<string> {
    const decoder = decoderFor(res);
    const body: Readable = decoder ? res.pipe(decoder) : res;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for await (const chunk of body) {
            chunks.push(chunk as Buffer);
            size += (chunk as Buffer).length;
            if (size >= max) break;
        }
    } catch { /* error body could not be read */ }
    res.destroy();
    return Buffer.concat(chunks).subarray(0, max).toString('utf8').replace(/\s+/g, ' ').trim();
}

/** Get the server's error message (JSON error_message if present). */
function serverMessage(snippet: string): string {
    try {
        const json = JSON.parse(snippet);
        const msg = json?.error_message || json?.message || json?.error;
        if (msg) return `: ${String(msg).slice(0, 120)}`;
    } catch { /* not JSON */ }
    return '';
}

interface RoundFailure { status: number; detail: string; }

/**
 * One download attempt. Tries with the session cookie first (the request Zalo PC makes); only when that
 * fails with a cookie/session status (400/401/403) does it retry once WITHOUT the cookie. Returns the
 * saved result on success, or the PRIMARY (with-cookie) failure — so the reported status reflects the
 * real request, not the secondary no-cookie fallback.
 */
async function attemptDownloadRound(url: URL, where: string, opts: BackupDownloadOptions): Promise<{ bytes: number } | RoundFailure> {
    const zaloHost = ZALO_HOST_RE.test(url.hostname);
    const cookieChoices = zaloHost && opts.sessionCookie ? [opts.sessionCookie, ''] : [''];
    let primary: RoundFailure | null = null;
    for (let i = 0; i < cookieChoices.length; i++) {
        const cookie = cookieChoices[i];
        if (opts.shouldAbort?.()) throw new DownloadAbortedError();
        const res = await get(url, zaloDownloadHeaders(opts.userAgent, cookie), opts.agent, MAX_REDIRECTS);
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) return saveResponse(res, opts);

        const detail = await readSnippet(res);
        opts.log?.(`tải ${where} (${cookie ? 'cookie phiên' : 'không cookie'}) → HTTP ${status} `
            + `${res.headers['content-type'] || ''} ${detail.slice(0, 300)}`);
        if (i === 0) primary = { status, detail };
        // Only the cookie attempt (i === 0) can be retried without the cookie, and only when the status
        // looks cookie-related. A 404 (file not on the server yet) is not helped by dropping the cookie.
        if (i > 0 || !isCookieRelated(status)) break;
    }
    return primary ?? { status: 0, detail: '' };
}

export async function downloadBackupFile(opts: BackupDownloadOptions): Promise<{ bytes: number }> {
    let url: URL;
    try {
        url = new URL(opts.url);
    } catch {
        throw new Error(tr('Đường dẫn tải bản sao lưu không hợp lệ'));
    }
    if (url.protocol !== 'https:') throw new Error(tr('Đường dẫn tải bản sao lưu không hợp lệ'));

    const zaloHost = ZALO_HOST_RE.test(url.hostname);
    const where = `${url.host}${url.pathname}`;
    if (!zaloHost) opts.log?.(`host tải không thuộc Zalo (${url.host}) → không gửi cookie phiên`);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let backoff = RETRY_BASE_MS;
    let last: RoundFailure = { status: 0, detail: '' };
    for (;;) {
        if (opts.shouldAbort?.()) throw new DownloadAbortedError();
        const result = await attemptDownloadRound(url, where, opts);
        if ('bytes' in result) return result;
        last = result;
        // The backup may still be uploading from the phone → wait and retry while there is time left.
        if (isNotReady(last.status) && deadline - Date.now() > backoff) {
            opts.log?.(`bản sao lưu chưa sẵn trên máy chủ (HTTP ${last.status}), đợi ${Math.round(backoff / 1000)}s rồi thử lại...`);
            await sleep(backoff, opts.shouldAbort);
            backoff = Math.min(Math.round(backoff * 1.7), RETRY_MAX_MS);
            continue;
        }
        break;
    }
    const note = isNotReady(last.status) ? tr(' — máy chủ vẫn chưa có bản sao lưu sau khi chờ; thử lại hoặc chọn khoảng thời gian nhỏ hơn') : '';
    throw new Error(tr('Tải bản sao lưu thất bại (HTTP {{lastStatus}}{{v1}}{{v2}})',
        { lastStatus: last.status, v1: serverMessage(last.detail), v2: note }));
}

async function saveResponse(res: http.IncomingMessage, opts: BackupDownloadOptions): Promise<{ bytes: number }> {
    const decoder = decoderFor(res);
    const expected = Number(opts.expectedSize) || 0;
    const total = expected || (decoder ? 0 : Number(res.headers['content-length']) || 0);
    let received = 0;
    const meter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
            if (opts.shouldAbort?.()) return cb(new DownloadAbortedError());
            received += chunk.length;
            if (total) opts.onProgress?.((received / total) * 100);
            cb(null, chunk);
        },
    });
    const out = fs.createWriteStream(opts.destPath);
    if (decoder) await pipeline(res, decoder, meter, out);
    else await pipeline(res, meter, out);
    if (expected && received !== expected) {
        opts.log?.(`kích thước tải về ${received} khác file_size ${expected}`);
    }
    return { bytes: received };
}
