// AE 即時（NDI 小程序）連線：現在卡在哪一步？— 純邏輯，不碰瀏覽器 / React，方便測試
//
// 輸入：瀏覽器種類、瀏覽器「允許連到這台裝置上的應用程式」權限、WebSocket 狀態、
//       小程序的 hello / status、最後一張畫面的時間
// 輸出：一個步驟（NdiGuide.step）+ 檢查清單第幾格 + 給畫面顯示的字
//
// 分享頁 / 動畫師工作站的引導卡片、3D 工具列的 NDI 標示、設定頁「檢查連線」都用這份，只有一個說法。

/**
 * 小程序要多新才算「新版」：0.1.11 起認得新網址 previz.haimiaan.com / test.previz.haimiaan.com
 * （0.1.10 以前在這兩個網址會把連線擋掉）；0.1.10 起只自動接這台電腦的 AE、會回報開機自動啟動有沒有設好
 */
export const MIN_HELPER_VERSION = '0.1.11';

/**
 * 0.1.10 以前的小程序不認得的網址（握手直接被擋，瀏覽器看起來跟「小程序沒開」一模一樣，
 * 網頁也沒辦法分辨：小程序對一般網頁請求不回任何東西）
 */
export function oldHelperBlocksHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'previz.haimiaan.com' || h === 'test.previz.haimiaan.com';
}
/** 小程序協議版本：0.1.8 以前沒有這欄（= 1） */
export const MIN_HELPER_PROTOCOL = 2;
/** 超過這麼久沒收到新畫面 → 「AE 沒在送畫面」 */
export const FRAME_STALE_MS = 3000;

export type NdiBrowser = 'chromium' | 'firefox' | 'safari' | 'other';
export type NdiOs = 'windows' | 'mac' | 'other';
/** checking = 還在問瀏覽器；unknown = 瀏覽器不支援查詢（舊版 / 不需要問） */
export type NdiPermission = 'checking' | 'granted' | 'prompt' | 'denied' | 'unknown';
/** idle = 還沒開始連；open = 收到 hello 了 */
export type NdiSocketState = 'idle' | 'connecting' | 'open' | 'closed';
export type NdiHelperState = 'starting' | 'ndi_missing' | 'ndi_error' | 'searching' | 'standby' | 'connecting' | 'live';

/**
 * 小程序送來的畫面顏色怎麼處理過（0.1.13 起回報；舊版沒有 → null = 以前的做法）
 *   raw             NDI 給的原始像素 → 網頁自己校正 AE 即時的顏色（ndiColor.ts）
 *   limited_to_full 小程序把 16–235 拉成 0–255（0.1.12 以前的做法）→ 照以前，不另外校正
 */
export type NdiColorPipeline = 'raw' | 'limited_to_full';

export interface NdiHello {
  version: string;
  /** 0.1.8 以前沒有 → null */
  protocol: number | null;
  platform: string | null;
  source: string | null;
  /** 0.1.13 起；舊版沒有 → null */
  colorPipeline: NdiColorPipeline | null;
}

export interface NdiHelperSource {
  name: string;
  /** 這台電腦送的 */
  local: boolean;
  /** 名稱有 After Effects */
  afterEffects: boolean;
}

/** 開機自動啟動的實際狀況（0.1.10 起；舊版沒有 → null） */
export interface NdiHelperAutostart {
  /** 設定要開機自動啟動 */
  wanted: boolean;
  /** 真的有登記好（指到目前這個小程序） */
  registered: boolean;
  /** 上次登記失敗的原因（中文）；成功 = null */
  error: string | null;
}

export interface NdiHelperStatus {
  /** 0.1.8 以前沒有 → null */
  state: NdiHelperState | null;
  error: { code: string; message: string } | null;
  mode: 'auto' | 'manual';
  preferred: string | null;
  source: string | null;
  sources: NdiHelperSource[];
  receiving: boolean;
  fps: number | null;
  width: number;
  height: number;
  /** 送出來的 JPEG 尺寸（還沒收到畫面 = 0） */
  outWidth: number;
  outHeight: number;
  /** 0.1.13 起：小程序縮成幾分之一（1 = 原樣送）；舊版沒有 / 還沒收到畫面 → null */
  downscale: number | null;
  /** 0.1.13 起；舊版沒有 → null */
  colorPipeline: NdiColorPipeline | null;
  framesPaused: boolean;
  autostart: NdiHelperAutostart | null;
}

export type NdiStep =
  | 'browser_unsupported'  // Safari：直接擋，沒得問
  | 'need_permission'      // 瀏覽器還沒問過「允許存取這台裝置上的應用程式和服務」
  | 'permission_denied'    // 按了封鎖
  | 'connecting'           // 正在連（很快就會變成別的，不用跳卡片）
  | 'helper_missing'       // 連不到小程序
  | 'helper_outdated'      // 小程序是舊版
  | 'ndi_missing'          // 小程序說沒裝 NDI Tools（或 NDI 啟動失敗）
  | 'no_source'            // 找不到任何 NDI 來源（AE 沒開 NDI 輸出）
  | 'no_local_source'      // 這台電腦的 AE 沒在送 NDI；網路上有別台電腦的來源（不會自動接，要自己選）
  | 'waiting_frames'       // 接上來源了，但超過 3 秒沒畫面
  | 'live'                 // 畫面正在進來
  | 'ready';               // 不收畫面的檢查（設定頁）：小程序正常、找到來源

export interface NdiStepInput {
  browser: NdiBrowser;
  permission: NdiPermission;
  socket: NdiSocketState;
  /** 這次打開頁面後連上過小程序 */
  everConnected: boolean;
  /** 連續連不上幾次（連上就歸零） */
  failures: number;
  hello: NdiHello | null;
  status: NdiHelperStatus | null;
  /** 要不要收畫面（設定頁的檢查 = false） */
  wantFrames: boolean;
  /** 最後一張畫面的時間（這條連線；沒有 = null） */
  lastFrameAt: number | null;
  /** 開始接目前這個來源的時間（連上 / 換來源 / 恢復收畫面時重算） */
  sourceSince: number | null;
  /** 瀏覽器自己量的每秒張數（舊版小程序沒回報 fps 時用） */
  measuredFps?: number | null;
  /** 這個網址 0.1.10 以前的小程序不認得（連不到時也可能是舊版擋掉的） */
  oldHelperBlocked?: boolean;
  now: number;
}

export interface NdiGuide {
  step: NdiStep;
  /** 檢查清單停在第幾格（0 瀏覽器允許 … 4 AE 在送畫面；5 = 全部 OK） */
  row: number;
  /** 正在連（按了「連接」在等瀏覽器 / 小程序回應） */
  pending: boolean;
  /** 小程序是舊版（畫面照樣用） */
  outdated: boolean;
  /** 這條連線收過畫面（LED 用 AE 畫面，停住時留在最後一格） */
  hasFrame: boolean;
  /** 目前這個來源收過畫面（之後停了 = AE 暫停 / 跑到背景） */
  hadFrames: boolean;
  helperVersion: string | null;
  source: string | null;
  fps: number | null;
  sources: NdiHelperSource[];
  mode: 'auto' | 'manual';
  preferred: string | null;
  /** 小程序回報的錯誤（中文，可以直接顯示） */
  helperError: string | null;
  /** 小程序想開機自動啟動、但沒登記成功（只是提醒，不擋 AE 即時） */
  autostartFailed: boolean;
  /** 連不到小程序，但也可能是裝了舊版、不認得這個網址（分不出來，兩種都要說） */
  maybeOldHelper: boolean;
  /** 小程序的畫面顏色怎麼處理過（舊版 / 還沒連上 → null） */
  colorPipeline: NdiColorPipeline | null;
  /** 目前的來源是 After Effects（AE 即時的顏色校正只套在 AE 的畫面） */
  sourceIsAe: boolean;
  /** 小程序把 NDI 畫面縮成幾分之一（舊版用 width / outWidth 算；不知道 → null） */
  helperDownscale: number | null;
}

// ─── 解析小程序送來的訊息 ───

const HELPER_STATES: readonly NdiHelperState[] = ['starting', 'ndi_missing', 'ndi_error', 'searching', 'standby', 'connecting', 'live'];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isAfterEffects = (name: string) => /after\s*effects/i.test(name);

function parseColorPipeline(v: unknown): NdiColorPipeline | null {
  return v === 'raw' || v === 'limited_to_full' ? v : null;
}

export function parseHello(msg: Record<string, unknown>): NdiHello {
  return {
    version: str(msg.version) ?? '0',
    protocol: num(msg.protocol),
    platform: str(msg.platform),
    source: str(msg.source),
    colorPipeline: parseColorPipeline(msg.colorPipeline),
  };
}

export function parseHelperStatus(msg: Record<string, unknown>): NdiHelperStatus {
  const state = HELPER_STATES.includes(msg.state as NdiHelperState) ? (msg.state as NdiHelperState) : null;
  let error: NdiHelperStatus['error'] = null;
  if (msg.error && typeof msg.error === 'object') {
    const e = msg.error as Record<string, unknown>;
    const message = str(e.message);
    if (message) error = { code: str(e.code) ?? '', message };
  } else if (str(msg.lastError)) {
    error = { code: '', message: msg.lastError as string };
  }
  let sources: NdiHelperSource[] = [];
  if (Array.isArray(msg.sources)) {
    sources = msg.sources.flatMap((s): NdiHelperSource[] => {
      if (!s || typeof s !== 'object') return [];
      const o = s as Record<string, unknown>;
      const name = str(o.name);
      if (!name) return [];
      return [{ name, local: o.local === true, afterEffects: typeof o.afterEffects === 'boolean' ? o.afterEffects : isAfterEffects(name) }];
    });
  } else if (Array.isArray(msg.availableSources)) {
    // 0.1.8 以前只有名稱：不知道是不是這台電腦
    sources = msg.availableSources.flatMap((n): NdiHelperSource[] => {
      const name = str(n);
      return name ? [{ name, local: false, afterEffects: isAfterEffects(name) }] : [];
    });
  }
  return {
    state,
    error,
    mode: msg.mode === 'manual' ? 'manual' : 'auto',
    preferred: str(msg.preferred),
    source: str(msg.source),
    sources,
    receiving: msg.receiving === true,
    fps: num(msg.fps),
    width: num(msg.width) ?? 0,
    height: num(msg.height) ?? 0,
    outWidth: num(msg.outWidth) ?? 0,
    outHeight: num(msg.outHeight) ?? 0,
    downscale: (() => { const d = num(msg.downscale); return d != null && d >= 1 ? d : null; })(),
    colorPipeline: parseColorPipeline(msg.colorPipeline),
    framesPaused: msg.framesPaused === true,
    autostart: parseAutostart(msg.autostart),
  };
}

function parseAutostart(v: unknown): NdiHelperAutostart | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.wanted !== 'boolean' || typeof o.registered !== 'boolean') return null;
  return { wanted: o.wanted, registered: o.registered, error: str(o.error) };
}

/** 比版本：a < b → 負數；看不懂的部分當 0 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(p => parseInt(p, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 小程序縮成幾分之一：0.1.13 起直接回報；舊版用 NDI 尺寸 ÷ 送出尺寸算（0.1.12 以前固定 2） */
export function helperDownscaleOf(st: Pick<NdiHelperStatus, 'downscale' | 'width' | 'height' | 'outWidth' | 'outHeight'>): number | null {
  if (st.downscale != null) return st.downscale;
  if (st.width > 0 && st.outWidth > 0) return Math.max(1, Math.round(st.width / st.outWidth));
  return null;
}

export function isHelperOutdated(hello: NdiHello): boolean {
  if (hello.protocol == null || hello.protocol < MIN_HELPER_PROTOCOL) return true;
  return compareVersions(hello.version, MIN_HELPER_VERSION) < 0;
}

// ─── 認瀏覽器 / 作業系統 ───

export function detectBrowser(ua: string): NdiBrowser {
  // iPhone / iPad 上的瀏覽器全部是 Safari 核心（一樣擋）
  if (/iPhone|iPad|iPod/.test(ua)) return 'safari';
  if (/Firefox\/|FxiOS/.test(ua)) return 'firefox';
  if (/Edg\/|EdgA\/|OPR\/|Chrome\/|Chromium\/|CriOS/.test(ua)) return 'chromium';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}

export function detectOs(ua: string, platform = ''): NdiOs {
  const s = `${platform} ${ua}`;
  if (/Win/i.test(s)) return 'windows';
  if (/Mac|iPhone|iPad|iPod/i.test(s)) return 'mac';
  return 'other';
}

/** 網頁本身就在這台電腦（開發用 localhost）→ 連 127.0.0.1 不用瀏覽器問 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

// ─── 來源清單 ───

/** AE 排前面，同樣是 AE 的話這台電腦的先 */
export function sortSources(sources: NdiHelperSource[]): NdiHelperSource[] {
  const rank = (s: NdiHelperSource) => (s.afterEffects ? 0 : 2) + (s.local ? 0 : 1);
  return sources.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s);
}

/** NDI 來源名稱是「機器名 (程式名)」→ 拆開；拆不開 = null */
export function splitSourceName(name: string): { machine: string; program: string } | null {
  const m = /^([^()]+?)\s*\((.+)\)\s*$/.exec(name.trim());
  return m ? { machine: m[1], program: m[2] } : null;
}

/** 選單上的字：「這台電腦的 Adobe After Effects」/「OTHER-PC 的 Adobe After Effects」 */
export function sourceLabel(s: NdiHelperSource): string {
  const parts = splitSourceName(s.name);
  if (s.local) return parts ? `這台電腦的 ${parts.program}` : `${s.name}（這台電腦）`;
  return parts ? `${parts.machine} 的 ${parts.program}` : s.name;
}

/**
 * 什麼時候給選來源：
 * - 這台電腦的 AE 沒在送、網路上有別台的（就算只有一個也要能選，小程序不會自動接別台）
 * - 來源多於一個
 * - 手動選過（只剩一個也要能選回自動）
 */
export function showSourcePicker(g: NdiGuide): boolean {
  if (g.step === 'no_local_source' && g.sources.length > 0) return true;
  return g.sources.length > 1 || (g.mode === 'manual' && g.sources.length > 0);
}

/** 選單放在檢查清單卡住那一格的說明裡（說明會叫他「在下面選」）；其他時候放在清單下面 */
export function sourcePickerInStep(g: NdiGuide): boolean {
  return g.step === 'waiting_frames' || g.step === 'no_local_source';
}

// ─── 現在卡在哪一步 ───

export function decideNdiStep(i: NdiStepInput): NdiGuide {
  const g: NdiGuide = {
    step: 'connecting',
    row: 1,
    pending: i.socket === 'connecting',
    outdated: false,
    hasFrame: false,
    hadFrames: false,
    helperVersion: null,
    source: null,
    fps: null,
    sources: [],
    mode: 'auto',
    preferred: null,
    helperError: null,
    autostartFailed: false,
    maybeOldHelper: false,
    colorPipeline: null,
    sourceIsAe: false,
    helperDownscale: null,
  };
  const at =(step: NdiStep, row: number): NdiGuide => ({ ...g, step, row });

  if (i.browser === 'safari') return at('browser_unsupported', 0);

  if (i.socket === 'open' && i.hello) {
    const st = i.status;
    g.outdated = isHelperOutdated(i.hello);
    g.helperVersion = i.hello.version;
    g.source = st ? st.source : i.hello.source;
    g.sources = st ? sortSources(st.sources) : [];
    g.mode = st?.mode ?? 'auto';
    g.preferred = st?.preferred ?? null;
    g.helperError = st?.error?.message ?? null;
    g.autostartFailed = !!st?.autostart && st.autostart.wanted && !st.autostart.registered;
    g.colorPipeline = st?.colorPipeline ?? i.hello.colorPipeline;
    g.sourceIsAe = !!g.source && (st?.sources.find(s => s.name === g.source)?.afterEffects ?? isAfterEffects(g.source));
    g.helperDownscale = st ? helperDownscaleOf(st) : null;
    g.hasFrame = i.lastFrameAt != null;
    g.hadFrames = i.lastFrameAt != null && (i.sourceSince == null || i.lastFrameAt >= i.sourceSince);
    // 剛換來源時，舊來源最後幾張不算
    const fresh = g.hadFrames && i.lastFrameAt != null && i.now - i.lastFrameAt <= FRAME_STALE_MS;
    if (i.wantFrames && fresh) {
      // 小程序回報的優先；沒有（舊版）就用自己量的；0 不顯示（剛停住、還沒過 3 秒）
      const fps = st?.fps != null && st.fps > 0 ? st.fps : i.measuredFps;
      g.fps = fps != null && fps >= 0.5 ? Math.round(fps) : null;
      return at('live', 5);
    }
    if (g.outdated) return at('helper_outdated', 1);
    if (!st || !st.state || st.state === 'starting') return at('connecting', 2);
    if (st.state === 'ndi_missing' || st.state === 'ndi_error') return at('ndi_missing', 2);
    if (st.state === 'searching' || !g.source) {
      // 0.1.10 起：只有別台電腦的來源 → 不自動接，等使用者選
      return at(st.error?.code === 'no_local_source' ? 'no_local_source' : 'no_source', 3);
    }
    if (!i.wantFrames) return at('ready', 4);
    // 從「最後一張畫面」或「開始接這個來源」算起，超過 3 秒沒畫面
    const since = Math.max(i.lastFrameAt ?? -Infinity, i.sourceSince ?? -Infinity);
    if (Number.isFinite(since) && i.now - since > FRAME_STALE_MS) return at('waiting_frames', 4);
    return at('connecting', 4);
  }

  if (i.socket === 'open') return at('connecting', 1);  // 連上了，等 hello
  if (i.permission === 'denied') return at('permission_denied', 0);
  if (i.permission === 'prompt' && !i.everConnected) return at('need_permission', 0);
  if (i.permission === 'checking' || i.socket === 'idle') return at('connecting', 1);
  if (i.socket === 'connecting' && i.failures === 0) return at('connecting', 1);
  return { ...at('helper_missing', 1), maybeOldHelper: i.oldHelperBlocked === true };
}

// ─── 檢查清單 ───

export const NDI_CHECKLIST_LABELS = ['瀏覽器允許', '小程序', 'NDI Tools', '找到 AE', 'AE 在送畫面'] as const;

export type NdiChecklistState = 'done' | 'current' | 'todo';

export function ndiChecklist(g: NdiGuide): { label: string; state: NdiChecklistState }[] {
  return NDI_CHECKLIST_LABELS.map((label, i) => {
    let state: NdiChecklistState = i < g.row ? 'done' : i === g.row ? 'current' : 'todo';
    // 設定頁的檢查不收畫面 → 最後一格不知道，不標成「卡在這」
    if (g.step === 'ready' && i === g.row) state = 'todo';
    return { label, state };
  });
}

// ─── 給畫面顯示的字 ───

export interface NdiStepMessage {
  /** 主要的一句話 */
  title: string;
  /** 補充（怎麼做） */
  detail: string[];
}

export const PERMISSION_PROMPT_TEXT = '允許存取這台裝置上的應用程式和服務';

/** 新網址上連不到小程序時多說的一句（舊版小程序在這裡跟沒開看起來一樣） */
export const OLD_HELPER_HINT = '已經裝了也開著的話：可能是小程序版本太舊，不認得這個網址，請下載最新版';

export function permissionFixSteps(browser: NdiBrowser): string[] {
  const chrome = 'Chrome / Edge：按網址列左邊的圖示 →「這個裝置上的應用程式」→ 允許';
  const firefox = 'Firefox：按網址列的權限圖示，或 設定 → 隱私與安全性 → 權限 →「裝置上的 App 與服務」→ 允許';
  if (browser === 'chromium') return [chrome.replace('Chrome / Edge：', '')];
  if (browser === 'firefox') return [firefox.replace('Firefox：', '')];
  return [chrome, firefox];
}

export function ndiStepMessage(g: NdiGuide, browser: NdiBrowser): NdiStepMessage {
  switch (g.step) {
    case 'browser_unsupported':
      return { title: 'Safari 不支援 AE 即時畫面，請改用 Chrome、Edge 或 Firefox 開這個連結', detail: [] };
    case 'need_permission':
      return {
        title: g.pending
          ? `瀏覽器在問你『${PERMISSION_PROMPT_TEXT}』，請按『允許』`
          : `等一下瀏覽器會問你『${PERMISSION_PROMPT_TEXT}』，請按『允許』`,
        detail: g.pending ? [] : ['這是讓網頁連到你電腦上的 NDI 小程序，只要允許一次'],
      };
    case 'permission_denied':
      return { title: '瀏覽器擋住了連到 NDI 小程序', detail: [...permissionFixSteps(browser), '改好後會自動連上'] };
    case 'connecting':
      return { title: '正在連接 NDI 小程序…', detail: [] };
    case 'helper_missing':
      return {
        title: '沒有偵測到 NDI 小程序',
        detail: [
          ...(g.maybeOldHelper ? [OLD_HELPER_HINT] : []),
          '裝好打開後會自動連上',
        ],
      };
    case 'helper_outdated':
      return {
        title: '小程序有新版，請下載更新',
        detail: [`你的版本是 ${g.helperVersion ?? '舊版'}，裝好新版後會自動連上`],
      };
    case 'ndi_missing':
      return {
        title: '請先安裝 NDI Tools（免費）',
        detail: [...(g.helperError ? [g.helperError] : []), '裝好後小程序會自己找到，不用重開'],
      };
    case 'no_source':
      return { title: '找不到 AE：確認 AE 有開，偏好設定 → 視訊預覽 有勾 NDI', detail: [] };
    case 'no_local_source':
      return {
        title: '這台電腦的 AE 沒有在送 NDI',
        detail: [
          '確認 AE 開著、偏好設定 → 視訊預覽 有勾 NDI、AE 在播放',
          '要看網路上別台電腦的 AE，請在下面選',
        ],
      };
    case 'waiting_frames':
      return {
        title: `已連上 ${g.source ?? 'AE'}，但 AE 沒在送畫面：AE 要在播放；偏好設定 → 視訊預覽 →『在背景時停用視訊輸出』要取消勾選`,
        detail: [],
      };
    case 'live':
      return { title: `${g.source ?? 'AE'}${g.fps != null ? ` · ${g.fps} fps` : ''}`, detail: [] };
    case 'ready':
      return { title: `小程序正常，找到 ${g.source ?? 'AE'}`, detail: ['打開專案的 AE 即時就會看到畫面'] };
  }
}

/** 短短一句（3D 工具列的 NDI 標示、分享頁上面的狀態） */
export function ndiShortLabel(g: NdiGuide): string {
  switch (g.step) {
    case 'browser_unsupported': return '瀏覽器不支援';
    case 'need_permission': return g.pending ? '等你按允許' : '要先允許連線';
    case 'permission_denied': return '瀏覽器擋住了';
    case 'connecting': return '連線中…';
    case 'helper_missing': return '沒有偵測到小程序';
    case 'helper_outdated': return '小程序要更新';
    case 'ndi_missing': return '沒裝 NDI Tools';
    case 'no_source': return '找不到 AE';
    case 'no_local_source': return '找不到這台電腦的 AE';
    case 'waiting_frames': return g.hadFrames ? 'AE 停住了' : '等 AE 送畫面';
    case 'live': return g.fps != null ? `LIVE · ${g.fps} fps` : 'LIVE';
    case 'ready': return '已連上';
  }
}

/** 開機自動啟動沒設好時的提醒（不擋 AE 即時）；沒問題 = null */
export const NDI_AUTOSTART_NOTE = '小程序沒辦法設成開機自動啟動（可能被電腦管家類軟體擋掉），下次開機要手動打開';

export function ndiAutostartNote(g: NdiGuide): string | null {
  return g.autostartFailed ? NDI_AUTOSTART_NOTE : null;
}

// ─── 重試 ───

/** 連不到小程序時多久再試一次：2 → 3 → 5 → 8 秒，之後每 10 秒（安靜地一直試） */
export function retryDelayMs(failures: number): number {
  const steps = [2000, 3000, 5000, 8000];
  return steps[Math.max(0, failures - 1)] ?? 10000;
}
