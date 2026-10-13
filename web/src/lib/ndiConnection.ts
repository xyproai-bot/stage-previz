// AE 即時（NDI 小程序）連線管理：包 NdiClient，自己判斷什麼時候該連、該等、該重試，
// 對外只給一個「現在卡在哪一步」（NdiGuide，規則在 ndiSteps.ts）。
//
// - Safari：不連（直接擋，沒得問）
// - 瀏覽器還沒問過「允許存取這台裝置上的應用程式和服務」→ 不自動連，等使用者按「連接 AE 即時」
//   （按了才連 → 瀏覽器跳詢問；詢問中不重試）
// - 按了封鎖 → 不重試；權限改成允許時自動連
// - 允許了但連不到小程序 → 安靜地重試（2、3、5、8、10 秒…），切回這個分頁時馬上再試一次
// - 不需要畫面時（分享頁切到本地檔案、設定頁的檢查）→ 送 pause，小程序就不解碼
//
// 用法（React）：const ndi = useNdiConnection({ enabled, onFrame });  ndi.guide.step …

import { useCallback, useEffect, useRef, useState } from 'react';
import { NdiClient, type NdiClientStatus } from './ndiClient';
import {
  decideNdiStep, detectBrowser, detectOs, isLoopbackHost, parseHello, parseHelperStatus, retryDelayMs,
  FRAME_STALE_MS,
  type NdiBrowser, type NdiGuide, type NdiHello, type NdiHelperStatus, type NdiOs, type NdiPermission, type NdiSocketState,
} from './ndiSteps';

export const NDI_DEFAULT_URL = 'ws://127.0.0.1:7777';

export interface NdiEnv {
  browser: NdiBrowser;
  os: NdiOs;
  /** 網頁本身在這台電腦（開發用 localhost）：連 127.0.0.1 瀏覽器不會問 */
  loopbackPage: boolean;
}

export function detectNdiEnv(): NdiEnv {
  if (typeof navigator === 'undefined') return { browser: 'other', os: 'other', loopbackPage: false };
  return {
    browser: detectBrowser(navigator.userAgent || ''),
    os: detectOs(navigator.userAgent || '', navigator.platform || ''),
    loopbackPage: typeof location !== 'undefined' && isLoopbackHost(location.hostname),
  };
}

/** 問瀏覽器「連到這台裝置上的應用程式」的權限；不支援（Safari / 舊版）→ null */
async function queryLoopbackPermission(): Promise<PermissionStatus | null> {
  const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
  if (!perms?.query) return null;
  // Chrome / Edge 145+、Firefox 153+ 叫 loopback-network；更早一點的 Chrome 叫 local-network-access
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      return await perms.query({ name } as unknown as PermissionDescriptor);
    } catch {
      /* 這個瀏覽器不認得這個名字 → 試下一個 */
    }
  }
  return null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface ConnectionOptions {
  url?: string;
  /** 要不要收畫面（設定頁的檢查 = false）；預設 true */
  wantFrames?: boolean;
  /** 使用者已經按了按鈕（設定頁「檢查連線」）：權限還沒問過也直接連 */
  connectOnPrompt?: boolean;
  onFrame?: (bitmap: ImageBitmap) => void;
  env?: NdiEnv;
}

export class NdiConnection {
  readonly env: NdiEnv;
  private client: NdiClient;
  private listeners = new Set<() => void>();
  private perm: PermissionStatus | null = null;
  private permission: NdiPermission = 'checking';
  private socket: NdiSocketState = 'idle';
  private everConnected = false;
  private failures = 0;
  private gotHello = false;
  private hello: NdiHello | null = null;
  private status: NdiHelperStatus | null = null;
  private currentSource: string | null = null;
  private wantFrames: boolean;
  private connectOnPrompt: boolean;
  private lastFrameAt: number | null = null;
  private sourceSince: number | null = null;
  private framesThisTick = 0;
  private lastTickAt = 0;
  private measuredFps: number | null = null;
  private active = false;
  private destroyed = false;
  private retryTimer: number | null = null;
  private ticker: number | null = null;
  private onFrame?: (bitmap: ImageBitmap) => void;

  constructor(opts: ConnectionOptions = {}) {
    this.env = opts.env ?? detectNdiEnv();
    this.wantFrames = opts.wantFrames ?? true;
    this.connectOnPrompt = opts.connectOnPrompt ?? false;
    this.onFrame = opts.onFrame;
    this.client = new NdiClient({
      url: opts.url || NDI_DEFAULT_URL,
      reconnectIntervalMs: 0,  // 重試由這裡管（有退讓、看權限）
      onFrame: (bitmap) => this.handleFrame(bitmap),
      onBinary: () => this.active && this.wantFrames,
      onStatus: (s) => this.handleClientStatus(s),
      onMessage: (m) => this.handleMessage(m),
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.onFocus);
      document.addEventListener('visibilitychange', this.onFocus);
    }
    if (this.env.browser === 'safari') this.permission = 'unknown';
    else void this.checkPermission();
  }

  // ─── 給外面用的 ───

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  getGuide(at = now()): NdiGuide {
    return decideNdiStep({
      browser: this.env.browser,
      permission: this.permission,
      socket: this.socket,
      everConnected: this.everConnected,
      failures: this.failures,
      hello: this.hello,
      status: this.status,
      wantFrames: this.wantFrames && this.active,
      lastFrameAt: this.lastFrameAt,
      sourceSince: this.sourceSince,
      measuredFps: this.measuredFps,
      now: at,
    });
  }

  /** 頁面現在要不要 AE 即時（分享頁切到本地檔案 → false：送 pause、不重試） */
  setActive(active: boolean) {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    if (active) {
      if (this.socket === 'open') {
        if (this.wantFrames) this.client.resume();
        this.sourceSince = now();  // 從現在開始等畫面
      } else {
        this.maybeAutoConnect();
      }
    } else {
      this.clearRetry();
      if (this.socket === 'open') this.client.pause();
    }
    this.emit();
  }

  /** 「連接 AE 即時」按鈕：權限還沒問過也連（瀏覽器會跳詢問） */
  connect() {
    if (this.destroyed || this.env.browser === 'safari') return;
    if (this.socket === 'connecting' || this.socket === 'open') return;
    this.connectNow();
  }

  /** 「重新連線」：不管現在怎樣，重連一次 */
  retry() {
    if (this.destroyed || this.env.browser === 'safari') return;
    this.connectNow();
  }

  /** 選來源；null = 自動（這台電腦的 AE 優先） */
  selectSource(name: string | null) {
    if (this.socket !== 'open') return;
    this.client.selectSource(name);
    // 選單馬上跟著變；小程序接著會回一則新的 status
    if (this.status) this.status = { ...this.status, mode: name ? 'manual' : 'auto', preferred: name };
    this.emit();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearRetry();
    this.stopTicker();
    this.client.destroy();
    this.perm?.removeEventListener('change', this.onPermChange);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.onFocus);
      document.removeEventListener('visibilitychange', this.onFocus);
    }
    this.listeners.clear();
  }

  // ─── 權限 ───

  private async checkPermission() {
    const st = await queryLoopbackPermission();
    if (this.destroyed) return;
    if (st) {
      this.perm = st;
      this.permission = this.readPermission(st.state);
      st.addEventListener('change', this.onPermChange);
    } else {
      this.permission = 'unknown';
    }
    this.emit();
    this.maybeAutoConnect();
  }

  private readPermission(state: PermissionState): NdiPermission {
    // 網頁本身就在這台電腦（開發用 localhost）→ 連 127.0.0.1 不會跳詢問，直接連
    if (state === 'prompt' && this.env.loopbackPage) return 'unknown';
    return state;
  }

  private onPermChange = () => {
    if (!this.perm || this.destroyed) return;
    this.permission = this.readPermission(this.perm.state);
    this.emit();
    // 改成允許了（例如到網址列的設定打開）→ 馬上連；正在連（按了允許）就讓它連完
    if (this.permission === 'granted' && this.active && this.socket !== 'open' && this.socket !== 'connecting') {
      this.connectNow();
    }
  };

  private maybeAutoConnect() {
    if (!this.active || this.destroyed || this.env.browser === 'safari') return;
    if (this.socket === 'open' || this.socket === 'connecting') return;
    const p = this.permission;
    if (p === 'granted' || p === 'unknown' || (p === 'prompt' && this.connectOnPrompt)) this.connectNow();
  }

  // ─── 連線 ───

  private connectNow() {
    this.clearRetry();
    this.gotHello = false;
    this.client.connect();
  }

  private handleClientStatus(s: NdiClientStatus) {
    if (s.kind === 'connecting') {
      this.socket = 'connecting';
      this.emit();
    } else if (s.kind === 'disconnected') {
      this.socket = 'closed';
      this.failures += 1;  // 連上過再斷掉也算：下一次重試不會閃成「連線中」
      this.hello = null;
      this.status = null;
      this.currentSource = null;
      this.lastFrameAt = null;
      this.sourceSince = null;
      this.measuredFps = null;
      this.stopTicker();
      this.emit();
      this.scheduleRetry();
    }
    // 'connected'（hello）在 handleMessage 處理；'error' 後面一定接 'disconnected'
  }

  private scheduleRetry() {
    if (!this.active || this.destroyed) return;
    const p = this.permission;
    // 還在問權限 / 被封鎖 / 還沒問過（等使用者按按鈕，不要一直跳詢問）→ 不自動重試
    if (p === 'checking' || p === 'denied') return;
    if (p === 'prompt' && !this.everConnected) return;
    this.clearRetry();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.active && !this.destroyed) this.connectNow();
    }, retryDelayMs(this.failures));
  }

  private clearRetry() {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 切回這個分頁（可能剛裝好小程序）→ 不用等，馬上再試 */
  private onFocus = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this.active && this.socket === 'closed' && this.retryTimer !== null) this.connectNow();
  };

  // ─── 小程序送來的 ───

  private handleMessage(msg: Record<string, unknown>) {
    if (msg.type === 'hello') {
      this.hello = parseHello(msg);
      this.gotHello = true;
      this.socket = 'open';
      this.everConnected = true;
      this.failures = 0;
      this.status = null;
      this.lastFrameAt = null;
      this.measuredFps = null;
      this.currentSource = this.hello.source;
      this.sourceSince = now();
      if (!this.active || !this.wantFrames) this.client.pause();
      this.startTicker();
      this.emit();
    } else if (msg.type === 'status') {
      if (!this.gotHello) return;
      const st = parseHelperStatus(msg);
      if (st.source !== this.currentSource) {
        this.currentSource = st.source;
        this.sourceSince = now();  // 換來源了：重新等這個來源的畫面
      }
      this.status = st;
      this.emit();
    } else if (msg.type === 'select_ack') {
      this.client.requestStatus();
    }
  }

  private handleFrame(bitmap: ImageBitmap) {
    if (!this.active || !this.wantFrames || this.destroyed) {
      bitmap.close?.();
      return;
    }
    const t = now();
    const wasLive = this.lastFrameAt != null && this.sourceSince != null && this.lastFrameAt >= this.sourceSince
      && t - this.lastFrameAt <= FRAME_STALE_MS;
    this.lastFrameAt = t;
    this.framesThisTick += 1;
    if (this.onFrame) this.onFrame(bitmap);
    else bitmap.close?.();
    if (!wasLive) this.emit();  // 第一張 / 停了又來 → 馬上變 LIVE（其他時候每秒更新一次就好）
  }

  private startTicker() {
    this.stopTicker();
    this.lastTickAt = now();
    this.framesThisTick = 0;
    this.ticker = window.setInterval(() => {
      const t = now();
      const sec = (t - this.lastTickAt) / 1000;
      if (sec > 0) this.measuredFps = this.framesThisTick / sec;
      this.framesThisTick = 0;
      this.lastTickAt = t;
      this.emit();  // 「超過 3 秒沒畫面」要靠時間走才會變
    }, 1000);
  }

  private stopTicker() {
    if (this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private emit() {
    if (this.destroyed) return;
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* 一個壞掉不影響其他 */ }
    }
  }
}

// ─── React ───

export interface UseNdiConnectionOptions {
  /** 現在要 AE 即時嗎；第一次 true 才開始（之後 false = 暫停、不斷線） */
  enabled: boolean;
  url?: string;
  /** 要不要收畫面（設定頁的檢查 = false） */
  wantFrames?: boolean;
  /** 使用者已經按了按鈕：權限還沒問過也直接連 */
  userInitiated?: boolean;
  onFrame?: (bitmap: ImageBitmap) => void;
}

export interface NdiConnectionHandle {
  guide: NdiGuide;
  env: NdiEnv;
  /** 「連接 AE 即時」 */
  connect: () => void;
  /** 「重新連線」 */
  retry: () => void;
  selectSource: (name: string | null) => void;
}

function initialGuide(env: NdiEnv): NdiGuide {
  return decideNdiStep({
    browser: env.browser, permission: 'checking', socket: 'idle', everConnected: false, failures: 0,
    hello: null, status: null, wantFrames: true, lastFrameAt: null, sourceSince: null, now: 0,
  });
}

export function useNdiConnection(opts: UseNdiConnectionOptions): NdiConnectionHandle {
  const { enabled, url, wantFrames = true, userInitiated = false } = opts;
  const onFrameRef = useRef(opts.onFrame);
  onFrameRef.current = opts.onFrame;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [env] = useState(detectNdiEnv);
  const [guide, setGuide] = useState<NdiGuide>(() => initialGuide(env));
  // 第一次要用到才建立（沒開 AE 即時的頁面不去問權限、不連）
  const [armed, setArmed] = useState(enabled);
  if (enabled && !armed) setArmed(true);
  const connRef = useRef<NdiConnection | null>(null);

  useEffect(() => {
    if (!armed) return;
    const conn = new NdiConnection({
      url, wantFrames, env, connectOnPrompt: userInitiated,
      onFrame: (bitmap) => {
        const f = onFrameRef.current;
        if (f) f(bitmap);
        else bitmap.close?.();
      },
    });
    connRef.current = conn;
    let lastKey = '';
    const update = () => {
      const g = conn.getGuide();
      const key = JSON.stringify(g);
      if (key !== lastKey) {
        lastKey = key;
        setGuide(g);
      }
    };
    const unsubscribe = conn.subscribe(update);
    conn.setActive(enabledRef.current);
    update();
    return () => {
      unsubscribe();
      conn.destroy();
      if (connRef.current === conn) connRef.current = null;
    };
  }, [armed, url, wantFrames, userInitiated, env]);

  useEffect(() => {
    connRef.current?.setActive(enabled);
  }, [enabled, armed]);

  const connect = useCallback(() => connRef.current?.connect(), []);
  const retry = useCallback(() => connRef.current?.retry(), []);
  const selectSource = useCallback((name: string | null) => connRef.current?.selectSource(name), []);
  return { guide, env, connect, retry, selectSource };
}
