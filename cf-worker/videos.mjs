// 歌曲影片版本（純計算，不碰資料庫 / R2 / 網路）— videos.test.mjs 有測。
// 資料庫和 R2 的部分在 worker.js（「歌曲影片版本」那一段）；API 文件在 docs/videos-api.md。
//
// 這裡有：
//   歌曲代號    normalizeSongCodeInput / songCodeKey / nextSongCode / fillMissingSongCodes / matchSongByFilename
//   影片格式    videoMimeFor / extForMime / isDriveVideoFile / driveSourceRev
//   分段上傳    planParts / expectedPartSize / missingParts / nextCopyPart
//   版本號      nextVideoVersion / versionLabel
//   權限        videoUploadDecision / videoModifyDecision
//   貼連結      classifyVideoLink / interpretProbe / isBlockedHost
//   播放        signVideoPass / verifyVideoPass / parseRangeHeader

// ─────────────────────────────────────────────
// 大小 / 分段
// ─────────────────────────────────────────────

export const GIB = 1024 * 1024 * 1024;
export const MIB = 1024 * 1024;
export const DEFAULT_VIDEO_MAX_BYTES = 4 * GIB;
// 瀏覽器上傳每一段 16 MiB（一段失敗只重傳這一段；Cloudflare 免費方案一個請求最多 100 MB）
export const UPLOAD_PART_SIZE = 16 * MIB;
// 後台從連結 / Drive 複製時每一段 32 MiB（一輪複製好幾段）
export const COPY_PART_SIZE = 32 * MIB;
// R2 分段上傳：每段至少 5 MiB（最後一段除外）、最多 10000 段、除了最後一段每段一樣大
export const R2_MIN_PART_SIZE = 5 * MIB;
export const R2_MAX_PARTS = 10000;
export const VIDEO_TITLE_MAX = 120;
export const VIDEO_NOTE_MAX = 500;

/** 上限（bytes）：wrangler.toml 的 VIDEO_MAX_BYTES 可以改；亂填就用預設 4 GB */
export function videoMaxBytes(env) {
  const n = Number(env?.VIDEO_MAX_BYTES);
  return Number.isFinite(n) && n >= MIB ? Math.floor(n) : DEFAULT_VIDEO_MAX_BYTES;
}

/** 後台複製每段多大：wrangler.toml 的 VIDEO_COPY_PART_BYTES 可以改（5 MiB～95 MiB），沒填用 32 MiB */
export function copyPartSize(env) {
  const n = Number(env?.VIDEO_COPY_PART_BYTES);
  return Number.isInteger(n) && n >= R2_MIN_PART_SIZE && n <= 95 * MIB ? n : COPY_PART_SIZE;
}

/** 1.5 GB / 300 MB 這種給人看的大小 */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= GIB) return `${(v / GIB).toFixed(v >= 10 * GIB ? 0 : 1).replace(/\.0$/, '')} GB`;
  if (v >= MIB) return `${Math.round(v / MIB)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} bytes`;
}

/**
 * 檔案切成幾段
 * @returns {{ok: true, partSize: number, partCount: number} | {ok: false, error: string}}
 */
export function planParts(size, partSize = UPLOAD_PART_SIZE) {
  if (!Number.isInteger(size) || size <= 0) return { ok: false, error: '檔案大小不正確' };
  let ps = partSize;
  // 太大的檔案（超過 10000 段）→ 每段放大（正常上限 4 GB 不會遇到）
  while (Math.ceil(size / ps) > R2_MAX_PARTS) ps *= 2;
  return { ok: true, partSize: ps, partCount: Math.max(1, Math.ceil(size / ps)) };
}

/** 第 n 段（1 開始）應該是幾 bytes；超出範圍回 0 */
export function expectedPartSize(size, partSize, n) {
  const count = Math.ceil(size / partSize);
  if (!Number.isInteger(n) || n < 1 || n > count) return 0;
  return n < count ? partSize : size - partSize * (count - 1);
}

/** 還沒傳的段（排好） */
export function missingParts(partCount, uploadedNumbers) {
  const have = new Set((uploadedNumbers || []).map(Number));
  const out = [];
  for (let i = 1; i <= partCount; i++) if (!have.has(i)) out.push(i);
  return out;
}

/** 後台複製：下一段要抓哪個範圍（都好了回 null） */
export function nextCopyPart({ size, partSize, doneParts }) {
  const have = doneParts instanceof Set ? doneParts : new Set(doneParts || []);
  const count = Math.ceil(size / partSize);
  for (let n = 1; n <= count; n++) {
    if (have.has(n)) continue;
    const start = (n - 1) * partSize;
    const end = Math.min(size, start + partSize) - 1;
    return { partNumber: n, start, end, length: end - start + 1, partCount: count };
  }
  return null;
}

// ─────────────────────────────────────────────
// 影片格式
// ─────────────────────────────────────────────

// 瀏覽器能播、我們收的格式（LED 上要播，所以只收這三種）
export const VIDEO_MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
export const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'];
const MIME_ALIASES = { 'video/x-m4v': 'video/mp4', 'video/mov': 'video/quicktime', 'video/x-quicktime': 'video/quicktime' };
// 「看不出是什麼」的類型 → 改看副檔名
const GENERIC_MIMES = ['', 'application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/x-download', 'application/force-download', 'application/download'];
// Drive 資料夾裡算「影片」的副檔名（列進清單；能不能播另外看 videoMimeFor）
const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mxf', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'flv', 'hevc'];

export function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function cleanMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[m] || m;
}

/**
 * 這個檔案是我們收的影片嗎？是 → 回標準的 mime（video/mp4 / video/quicktime / video/webm），不是 → null
 * 類型寫得清楚就看類型；類型是「一般檔案」（octet-stream）或沒寫 → 看副檔名
 */
export function videoMimeFor({ mime, filename } = {}) {
  const m = cleanMime(mime);
  if (ALLOWED_VIDEO_MIMES.includes(m)) return m;
  if (GENERIC_MIMES.includes(m) || m.startsWith('video/')) {
    // video/x-matroska 之類瀏覽器播不了的 → 副檔名是 mp4 也不收（真的是 mkv）
    if (m.startsWith('video/')) return null;
    return VIDEO_MIME_BY_EXT[fileExt(filename)] || null;
  }
  return null;
}

export function extForMime(mime) {
  const m = cleanMime(mime);
  if (m === 'video/quicktime') return 'mov';
  if (m === 'video/webm') return 'webm';
  return 'mp4';
}

/** Drive 資料夾裡這個檔案算不算影片（不是影片的不列進清單） */
export function isDriveVideoFile(f) {
  if (!f) return false;
  const m = cleanMime(f.mimeType);
  if (m.startsWith('video/')) return true;
  if (m === 'application/vnd.google-apps.folder' || m.startsWith('application/vnd.google-apps.')) return false;
  return VIDEO_EXTS.includes(fileExt(f.name));
}

/** Drive 檔案內容的版本：有 md5 用 md5，沒有用「修改時間|大小」 */
export function driveSourceRev(f) {
  if (f?.md5Checksum) return `md5:${f.md5Checksum}`;
  return `mt:${f?.modifiedTime || ''}|${f?.size || ''}`;
}

/** Drive 同步時，同一首歌、同一個檔案、同一個內容版本只建一版 */
export function driveVersionKey(songId, driveFileId, rev) {
  return `${songId}|${driveFileId}|${rev}`;
}

/**
 * Drive 同步：哪些檔案要建新的一版（新的檔案，或內容改過）
 *   沒對到歌的不建；看過的（包含刪掉的版本、貼 Drive 連結交過的同一個內容）不再建
 *   照 Drive 修改時間由舊到新排（版本號照時間排）
 *   不支援的格式 / 太大 / 沒有大小 → status 'failed' + 原因（讓人在版本清單看到為什麼沒進來）
 * @param {{ pairs: {file: object, songId: string|null}[], seen: Set<string>, maxBytes: number }} p
 * @returns {{ file: object, songId: string, rev: string, mime: string|null, size: number|null,
 *             status: 'processing'|'failed', error: string|null,
 *             width: number|null, height: number|null, durationSec: number|null }[]}
 */
export function planDriveVersions({ pairs, seen, maxBytes = DEFAULT_VIDEO_MAX_BYTES }) {
  const out = [];
  const queued = new Set();
  for (const { file: f, songId } of pairs || []) {
    if (!songId || !f?.id) continue;
    const rev = driveSourceRev(f);
    const key = driveVersionKey(songId, f.id, rev);
    if (seen?.has(key) || queued.has(key)) continue;
    queued.add(key);
    const mime = videoMimeFor({ mime: f.mimeType, filename: f.name });
    const size = f.size ? Number(f.size) : null;
    let status = 'processing', error = null;
    if (!mime) { status = 'failed'; error = unsupportedFormatMessage(f.name, f.mimeType); }
    else if (!size || !Number.isFinite(size)) { status = 'failed'; error = 'Drive 沒有給這個檔案的大小，沒辦法複製'; }
    else if (size > maxBytes) { status = 'failed'; error = `檔案太大（${formatBytes(size)}），上限是 ${formatBytes(maxBytes)}`; }
    const vm = f.videoMediaMetadata || {};
    const dim = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 20000 ? n : null; };
    const ms = Number(vm.durationMillis);
    out.push({
      file: f, songId, rev, mime, size: Number.isFinite(size) ? size : null, status, error,
      width: dim(vm.width), height: dim(vm.height),
      durationSec: Number.isFinite(ms) && ms > 0 ? Math.round(ms) / 1000 : null,
    });
  }
  return out.sort((a, b) => String(a.file.modifiedTime || '').localeCompare(String(b.file.modifiedTime || '')));
}

/** 不支援的格式要跟人說什麼 */
export function unsupportedFormatMessage(filename, mime) {
  const ext = fileExt(filename);
  const what = ext ? `.${ext}` : (cleanMime(mime) || '這個格式');
  return `${what} 瀏覽器播不了，只收 MP4 / MOV / WebM，請轉檔後再交`;
}

// ─────────────────────────────────────────────
// 版本號
// ─────────────────────────────────────────────

/**
 * 下一個版本號：比「發過的最大號碼」和「目前最大版本」都大 1（刪掉的號碼不會再用）
 * worker.js 的 SQL 也是一樣的算法（finalizeVideoReady）
 */
export function nextVideoVersion(seq, maxExisting) {
  const a = Number.isFinite(Number(seq)) ? Number(seq) : 0;
  const b = Number.isFinite(Number(maxExisting)) ? Number(maxExisting) : 0;
  return Math.max(a, b, 0) + 1;
}

export function versionLabel(version) {
  return Number.isInteger(version) && version > 0 ? `V${version}` : '';
}

// ─────────────────────────────────────────────
// 歌曲代號（S01…）
// ─────────────────────────────────────────────

export const SONG_CODE_MAX = 12;
const SONG_CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/;

/**
 * 使用者輸入的代號 → 大寫、去頭尾空白
 * 規則：英文字母、數字、中間可以有「-」，1～12 字（「_」和空白不行，因為檔名用它們隔開代號和歌名）
 * @returns {{code: string} | {error: string}}
 */
export function normalizeSongCodeInput(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: '代號不能是空的' };
  const code = String(raw).trim().toUpperCase();
  if (!code) return { error: '代號不能是空的' };
  if (code.length > SONG_CODE_MAX) return { error: `代號最多 ${SONG_CODE_MAX} 個字` };
  if (!SONG_CODE_RE.test(code)) return { error: '代號只能用英文字母、數字和中間的「-」（例：S01、ENC-1）' };
  return { code };
}

/** 比對用的代號：大寫、數字前面的 0 去掉（S1 = S01 = S001） */
export function songCodeKey(code) {
  return String(code || '').trim().toUpperCase().replace(/\d+/g, (d) => String(parseInt(d, 10)));
}

/** 新歌的代號：S + 目前最大的 S 號碼 + 1（兩位數，S01、S02…S10…） */
export function nextSongCode(existingCodes) {
  const keys = new Set();
  let max = 0;
  for (const c of existingCodes || []) {
    if (!c) continue;
    keys.add(songCodeKey(c));
    const m = /^S(\d+)$/i.exec(String(c).trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  while (keys.has(songCodeKey(`S${n}`))) n++;
  return `S${String(n).padStart(2, '0')}`;
}

/**
 * 沒有代號的歌補上代號（依歌單順序），回傳要寫進資料庫的 [{ id, code }]
 * @param {{id: string, code?: string|null}[]} songs  已經依順序排好
 */
export function fillMissingSongCodes(songs) {
  const codes = (songs || []).map(s => s.code).filter(Boolean);
  const out = [];
  for (const s of songs || []) {
    if (s.code) continue;
    const code = nextSongCode(codes);
    codes.push(code);
    out.push({ id: s.id, code });
  }
  return out;
}

/** 代號有沒有被這個專案的其他歌用掉（S1 和 S01 算同一個）；有 → 回那首歌 */
export function songCodeTakenBy(code, songs, exceptSongId = null) {
  const k = songCodeKey(code);
  return (songs || []).find(s => s.id !== exceptSongId && s.code && songCodeKey(s.code) === k) || null;
}

/**
 * 檔名開頭的代號對到哪首歌：
 *   S01_歌名.mp4、S01-歌名.mp4、S01 歌名.mp4、S01.mp4、s1_xxx.mp4 → 代號 S01 的歌
 *   代號後面一定要接「不是英文字母 / 數字」的字（S01A_x.mp4 不算 S01）
 *   代號裡可以有「-」：ENC-1_x.mp4 → ENC-1；同時有 S01 和 S01-B 時 S01-B_x.mp4 → S01-B（取最長的）
 * @param {string} filename
 * @param {{id: string, code?: string|null}[]} songs
 * @returns {string|null} song id
 */
export function matchSongByFilename(filename, songs) {
  const head = /^[A-Za-z0-9-]+/.exec(String(filename || '').trim());
  if (!head) return null;
  const parts = head[0].split('-');
  const byKey = new Map();
  for (const s of songs || []) if (s.code) byKey.set(songCodeKey(s.code), s.id);
  // 從最長的開始試：「S01-B-final」→「S01-B-FINAL」「S01-B」「S01」
  for (let n = parts.length; n >= 1; n--) {
    const cand = parts.slice(0, n).join('-');
    if (!cand || cand.endsWith('-')) continue;
    const id = byKey.get(songCodeKey(cand));
    if (id) return id;
  }
  return null;
}

// ─────────────────────────────────────────────
// 權限
// ─────────────────────────────────────────────

/**
 * 能不能幫這首歌交影片（上傳 / 貼連結）
 *   admin（全站或這個專案）→ 可以
 *   動畫師 → 這首歌沒指派人，或指派給他自己
 *   導演 → 只能看
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function videoUploadDecision({ role, userId, song }) {
  if (!role) return { ok: false, status: 403, error: '沒有權限存取此專案' };
  if (role === 'admin') return { ok: true };
  if (role === 'animator') {
    if (song?.animator_user_id && song.animator_user_id !== userId) {
      return { ok: false, status: 403, error: '這首歌指派給其他動畫師，只有他或 admin 可以交影片' };
    }
    return { ok: true };
  }
  if (role === 'director') return { ok: false, status: 403, error: '導演可以看影片；交影片請找負責的動畫師或 admin' };
  return { ok: false, status: 403, error: '沒有權限交影片' };
}

/**
 * 能不能改 / 刪 / 繼續上傳這一版：admin，或交這一版的人（而且還有交影片的權限）
 */
export function videoModifyDecision({ role, userId, song, video }) {
  const base = videoUploadDecision({ role, userId, song });
  if (!base.ok) return base;
  if (role === 'admin') return { ok: true };
  if (!video?.created_by || video.created_by !== userId) {
    return { ok: false, status: 403, error: '只有交這一版的人或 admin 可以改它' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────
// 貼連結
// ─────────────────────────────────────────────

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every(n => n >= 0 && n <= 255) ? p : null;
}

/** 不讓後台去抓的網址：本機、內部網路、我們自己 */
export function isBlockedHost(hostname, selfHosts = []) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (selfHosts.map(s => String(s).toLowerCase()).includes(h)) return true;
  const p = ipv4Parts(h);
  if (p) {
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (h.includes(':')) {
    // IPv6：本機、內部、link-local 都擋；其他 IPv6 位址也不收（正常分享連結不會用）
    return true;
  }
  return false;
}

function b64urlString(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function lastPathName(u) {
  const seg = u.pathname.split('/').filter(Boolean).pop() || '';
  try { return decodeURIComponent(seg); } catch { return seg; }
}

const LINK_ERRORS = {
  empty: '請貼上影片連結',
  invalid: '這不是網址，請貼完整的連結（https:// 開頭）',
  protocol: '只收 https:// 或 http:// 開頭的連結',
  blocked: '這個網址後台沒辦法去抓（本機或內部網路的位址）',
  driveFolder: '這是 Drive 資料夾的連結，請貼單一影片檔的連結（整個資料夾請在專案設定綁定 Drive 資料夾同步）',
  googleDoc: '這是 Google 文件 / 試算表 / 簡報，不是影片檔',
  dropboxFolder: '這是 Dropbox 資料夾的連結，請貼單一影片檔的連結',
  dropboxHome: '這是你自己 Dropbox 裡的網址，後台打不開；請在檔案上按「分享」→「複製連結」再貼',
  onedriveNotShare: '這是 OneDrive 裡的瀏覽網址，不是分享連結；請在檔案上按「分享」→「複製連結」再貼',
  streaming: '不收 YouTube / Vimeo 這類影音網站的連結（拿不到原始檔），請直接上傳影片檔',
  unsupported: '這個網站的連結沒辦法直接下載，請改用 Google Drive / Dropbox / OneDrive 的分享連結，或直接上傳',
};

/**
 * 看貼的連結是哪一種、要去哪裡下載
 * @returns {{ok: true, kind: 'drive', fileId: string, resourceKey: string|null, url: string}
 *         | {ok: true, kind: 'dropbox'|'onedrive'|'sharepoint'|'direct', downloadUrl: string, url: string, filenameHint: string}
 *         | {ok: false, error: string}}
 */
export function classifyVideoLink(raw, { selfHosts = [] } = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: LINK_ERRORS.empty };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: LINK_ERRORS.invalid }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: LINK_ERRORS.protocol };
  if (u.username || u.password) return { ok: false, error: LINK_ERRORS.invalid };
  const host = u.hostname.toLowerCase();
  if (isBlockedHost(host, selfHosts)) return { ok: false, error: LINK_ERRORS.blocked };
  const path = u.pathname;

  // Google Drive
  if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'drive.usercontent.google.com') {
    if (/\/folders\//.test(path) || /\/drive\/(u\/\d+\/)?(my-drive|shared-with-me|recent)/.test(path)) {
      return { ok: false, error: LINK_ERRORS.driveFolder };
    }
    if (host === 'docs.google.com' && /^\/(document|spreadsheets|presentation|forms|drawings)\//.test(path)) {
      return { ok: false, error: LINK_ERRORS.googleDoc };
    }
    let id = null;
    const m = /\/file\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(path);
    if (m) id = m[1];
    else if (u.searchParams.get('id')) id = u.searchParams.get('id');
    if (!id || !DRIVE_ID_RE.test(id)) return { ok: false, error: '看不懂這個 Google Drive 連結，請在檔案上按「共用」→「複製連結」再貼' };
    const rk = u.searchParams.get('resourcekey') || u.searchParams.get('resourceKey');
    return { ok: true, kind: 'drive', fileId: id, resourceKey: rk && /^[A-Za-z0-9_-]{1,200}$/.test(rk) ? rk : null, url: u.toString() };
  }

  // Dropbox
  if (host === 'dropbox.com' || host === 'www.dropbox.com' || host.endsWith('.dropbox.com')) {
    if (host.startsWith('dl.')) {
      return { ok: true, kind: 'dropbox', downloadUrl: u.toString(), url: u.toString(), filenameHint: lastPathName(u) };
    }
    if (/^\/(sh|scl\/fo)\//.test(path)) return { ok: false, error: LINK_ERRORS.dropboxFolder };
    if (/^\/(home|preview)\b/.test(path)) return { ok: false, error: LINK_ERRORS.dropboxHome };
    if (!/^\/(s|scl\/fi)\//.test(path)) return { ok: false, error: '看不懂這個 Dropbox 連結，請在檔案上按「分享」→「複製連結」再貼' };
    const d = new URL(u.toString());
    d.hostname = 'www.dropbox.com';
    d.searchParams.delete('raw');
    d.searchParams.set('dl', '1');
    return { ok: true, kind: 'dropbox', downloadUrl: d.toString(), url: u.toString(), filenameHint: lastPathName(u) };
  }
  if (host === 'dl.dropboxusercontent.com' || host.endsWith('.dropboxusercontent.com')) {
    return { ok: true, kind: 'dropbox', downloadUrl: u.toString(), url: u.toString(), filenameHint: lastPathName(u) };
  }

  // OneDrive（個人）：用分享 API 轉成下載網址（盡量；微軟有時候不給下載）
  if (host === '1drv.ms' || host === 'onedrive.live.com' || host === 'www.onedrive.live.com') {
    if (host !== '1drv.ms' && !u.searchParams.get('authkey') && !/\/(redir|embed|download)\b/.test(path) && !u.searchParams.get('resid')) {
      return { ok: false, error: LINK_ERRORS.onedriveNotShare };
    }
    const shareId = 'u!' + b64urlString(u.toString());
    return {
      ok: true, kind: 'onedrive',
      downloadUrl: `https://api.onedrive.com/v1.0/shares/${shareId}/root/content`,
      url: u.toString(), filenameHint: '',
    };
  }
  // SharePoint / 公司版 OneDrive：分享連結後面加 download=1
  if (host.endsWith('.sharepoint.com')) {
    if (/\/_layouts\/15\/onedrive\.aspx/i.test(path)) return { ok: false, error: LINK_ERRORS.onedriveNotShare };
    const d = new URL(u.toString());
    d.searchParams.set('download', '1');
    return { ok: true, kind: 'sharepoint', downloadUrl: d.toString(), url: u.toString(), filenameHint: '' };
  }

  // 影音網站：沒有原始檔可以下載
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|bilibili\.com|youku\.com|tiktok\.com|instagram\.com|facebook\.com)$/.test(host)) {
    return { ok: false, error: LINK_ERRORS.streaming };
  }
  // 需要網頁操作才能下載的網站
  if (/(^|\.)(wetransfer\.com|we\.tl|icloud\.com|box\.com|pan\.baidu\.com|mega\.nz)$/.test(host)) {
    return { ok: false, error: LINK_ERRORS.unsupported };
  }

  // 其他：直接下載網址（.mp4 / .mov / .webm；沒有副檔名的話後台抓的時候看檔案類型）
  return { ok: true, kind: 'direct', downloadUrl: u.toString(), url: u.toString(), filenameHint: lastPathName(u) };
}

/** Content-Disposition 裡的檔名（filename*=UTF-8''… 優先） */
export function filenameFromContentDisposition(cd) {
  const s = String(cd || '');
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(s);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* 往下 */ } }
  const q = /filename\s*=\s*"([^"]*)"/.exec(s);
  if (q) return q[1];
  const p = /filename\s*=\s*([^;]+)/.exec(s);
  return p ? p[1].trim() : '';
}

/** Content-Range: bytes 0-0/12345 → 12345（沒有 / 不知道 → null） */
export function totalFromContentRange(cr) {
  const m = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)\s*$/i.exec(String(cr || '').trim());
  return m ? Number(m[1]) : null;
}

const KIND_ACCESS_ERRORS = {
  drive: '連接的 Google 帳號讀不到這個檔案：請把檔案共用給連接的帳號，或改成「知道連結的使用者都能查看」',
  dropbox: '這個 Dropbox 連結打不開（可能要登入或已經失效），請重新「複製連結」',
  onedrive: 'OneDrive 不讓後台直接下載這個連結。請在 OneDrive 把檔案「下載」到電腦，再用「上傳」交（或改用 Google Drive / Dropbox 連結）',
  sharepoint: '公司版 OneDrive / SharePoint 的連結要登入才能下載，後台抓不到。請下載到電腦後用「上傳」交',
  direct: '這個網址要登入或沒有公開，後台抓不到；請改成公開的下載連結，或直接上傳',
};
const KIND_HTML_ERRORS = {
  drive: '這個 Drive 檔案沒有公開，連接的 Google 帳號也看不到：請把檔案共用給連接的帳號，或改成「知道連結的使用者都能查看」',
  dropbox: '這個 Dropbox 連結打開是網頁，不是影片檔（可能是資料夾或要登入），請貼單一影片檔的分享連結',
  onedrive: KIND_ACCESS_ERRORS.onedrive,
  sharepoint: KIND_ACCESS_ERRORS.sharepoint,
  direct: '這個網址打開是網頁，不是影片檔；請貼影片的直接下載連結（結尾是 .mp4 / .mov / .webm），或直接上傳',
};

/**
 * 後台先用「Range: bytes=0-0」試抓一下，看檔案多大、能不能分段、是什麼格式
 * @param {object} p
 * @param {number} p.status                 HTTP 狀態
 * @param {Record<string,string|null>} p.headers  content-type / content-range / content-length / content-disposition（小寫）
 * @param {string} p.kind                   classifyVideoLink 的 kind（drive 公開下載也用 'drive'）
 * @param {string} [p.filenameHint]         網址上的檔名
 * @param {string} [p.knownMime]            Drive API 給的類型
 * @param {number} [p.knownSize]            Drive API 給的大小
 * @param {number} p.maxBytes
 * @returns {{ok: true, size: number, rangeSupported: boolean, mime: string, filename: string}
 *         | {ok: false, error: string, status?: number}}
 */
export function interpretProbe({ status, headers = {}, kind = 'direct', filenameHint = '', knownMime = '', knownSize = null, maxBytes = DEFAULT_VIDEO_MAX_BYTES }) {
  const h = (k) => headers[k] ?? null;
  if (status === 401 || status === 403) return { ok: false, error: KIND_ACCESS_ERRORS[kind] || KIND_ACCESS_ERRORS.direct };
  if (status === 404 || status === 410) return { ok: false, error: '找不到這個檔案（連結錯了，或檔案被刪掉 / 移走了）' };
  if (status === 416) return { ok: false, error: '這個檔案是空的' };
  if (status === 429) return { ok: false, error: '來源網站說請求太多，請過幾分鐘再試' };
  if (status !== 200 && status !== 206) return { ok: false, error: `來源網站回應錯誤（HTTP ${status}），請稍後再試或直接上傳` };

  const ctype = cleanMime(h('content-type'));
  if (ctype.startsWith('text/html') || ctype === 'application/xhtml+xml') {
    return { ok: false, error: KIND_HTML_ERRORS[kind] || KIND_HTML_ERRORS.direct };
  }
  const filename = filenameFromContentDisposition(h('content-disposition')) || filenameHint || '';
  const mime = videoMimeFor({ mime: ctype || knownMime, filename }) || videoMimeFor({ mime: knownMime, filename });
  if (!mime) {
    if (ctype && !GENERIC_MIMES.includes(ctype) && !ctype.startsWith('video/')) {
      return { ok: false, error: `這個連結不是影片檔（是 ${ctype}）；只收 MP4 / MOV / WebM` };
    }
    return { ok: false, error: unsupportedFormatMessage(filename, ctype || knownMime) };
  }

  let size = null;
  let rangeSupported = false;
  if (status === 206) {
    size = totalFromContentRange(h('content-range'));
    rangeSupported = true;
  } else {
    const cl = Number(h('content-length'));
    size = Number.isFinite(cl) && cl > 0 && h('content-length') !== null ? cl : null;
  }
  if (size === null && Number.isFinite(Number(knownSize)) && Number(knownSize) > 0) size = Number(knownSize);
  if (size === null) return { ok: false, error: '來源網站沒有說檔案多大，後台沒辦法複製；請下載後用「上傳」交' };
  if (size <= 0) return { ok: false, error: '這個檔案是空的' };
  if (size > maxBytes) return { ok: false, error: `檔案太大（${formatBytes(size)}），上限是 ${formatBytes(maxBytes)}`, status: 413 };
  return { ok: true, size, rangeSupported, mime, filename };
}

// ─────────────────────────────────────────────
// 播放用的通行證（<video src> 帶不了登入 header → 網址上帶這個）
// ─────────────────────────────────────────────

// 每 6 小時換一次（同一段時間拿到的網址一樣 → 瀏覽器快取有用），有效 6～12 小時
export const VIDEO_PASS_BUCKET_MS = 6 * 3600 * 1000;
const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(data)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameStr(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** 某個人看某一版影片的通行證：「到期時間.userId.簽章」 */
export async function signVideoPass(secret, { videoId, userId, now = Date.now() }) {
  const exp = (Math.floor(now / VIDEO_PASS_BUCKET_MS) + 2) * VIDEO_PASS_BUCKET_MS;
  const sig = await hmac(secret, `video-pass|${videoId}|${userId}|${exp}`);
  return `${exp}.${userId}.${sig}`;
}

/** 通行證對不對（對 → 回 userId，不對 / 過期 → null） */
export async function verifyVideoPass(secret, token, { videoId, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [expStr, userId, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now || exp > now + 3 * VIDEO_PASS_BUCKET_MS) return null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) return null;
  const expected = await hmac(secret, `video-pass|${videoId}|${userId}|${exp}`);
  return sameStr(sig, expected) ? userId : null;
}

/**
 * 播放請求的 Range header（只處理一段；多段或看不懂的照規定忽略 → 回整個檔案）
 *   'bytes=0-99' → {start: 0, end: 99}；'bytes=100-' → 到最後；'bytes=-50' → 最後 50 bytes；結尾超過檔案 → 截到最後
 * @returns {{start: number, end: number} | 'unsatisfiable' | null}  null = 沒有 / 忽略（回 200 整個檔案）
 */
export function parseRangeHeader(header, size) {
  if (header === null || header === undefined || !Number.isFinite(size) || size <= 0) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(header));
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (b !== '' && Number(b) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}
