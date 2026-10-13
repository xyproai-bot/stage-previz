// NdiConnection 的流程（假的 WebSocket / 假的瀏覽器權限）：什麼時候連、等、重試、暫停
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NdiConnection, type NdiEnv } from './ndiConnection';

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  binaryType = '';
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) { FakeWS.all.push(this); }
  send(text: string) { this.sent.push(text); }
  close() { this.readyState = 3; }
  // ── 測試用：小程序那邊 ──
  accept(hello: Record<string, unknown>) {
    this.readyState = 1;
    this.onopen?.({});
    this.onmessage?.({ data: JSON.stringify({ type: 'hello', ...hello }) });
  }
  status(st: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ type: 'status', ...st }) }); }
  frame() { this.onmessage?.({ data: new ArrayBuffer(8) }); }
  refuse() {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({ code: 1006 });
  }
  commands() { return this.sent.filter(s => s.startsWith('{')).map(s => JSON.parse(s)); }
}

function fakePermission(initial: PermissionState) {
  const fns = new Set<() => void>();
  return {
    state: initial,
    addEventListener: (_t: string, fn: () => void) => { fns.add(fn); },
    removeEventListener: (_t: string, fn: () => void) => { fns.delete(fn); },
    set(s: PermissionState) { this.state = s; fns.forEach(f => f()); },
  };
}

const CHROME: NdiEnv = { browser: 'chromium', os: 'windows', loopbackPage: false };
const NEW_HELLO = { version: '0.1.11', protocol: 2, platform: 'windows', port: 7777, source: '' };
const AE = 'ME (Adobe After Effects)';
const LIVE_STATUS = {
  state: 'connecting', error: null, mode: 'auto', preferred: null, source: AE,
  sources: [{ name: AE, local: true, afterEffects: true }, { name: 'OTHER (Adobe After Effects)', local: false, afterEffects: true }],
  receiving: false, fps: 0, width: 0, height: 0, framesPaused: false,
};

let perm: ReturnType<typeof fakePermission> | null;
const listeners = new Map<string, Set<() => void>>();
const on = (t: string, fn: () => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); };
const off = (t: string, fn: () => void) => { listeners.get(t)?.delete(fn); };
const fire = (t: string) => listeners.get(t)?.forEach(f => f());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  FakeWS.all = [];
  perm = fakePermission('granted');
  listeners.clear();
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    addEventListener: on,
    removeEventListener: off,
  });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: on, removeEventListener: off });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    platform: 'Win32',
    permissions: {
      query: async ({ name }: { name: string }) => {
        if (!perm || name !== 'loopback-network') throw new TypeError('unknown permission');
        return perm;
      },
    },
  });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 960, height: 540, close() {} }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 讓權限查詢 / 解 JPEG 這些 promise 跑完 */
const flush = () => vi.advanceTimersByTimeAsync(0);

function make(opts: ConstructorParameters<typeof NdiConnection>[0] = {}) {
  const frames: unknown[] = [];
  const conn = new NdiConnection({ env: CHROME, onFrame: (b) => frames.push(b), ...opts });
  return { conn, frames, step: () => conn.getGuide().step, guide: () => conn.getGuide() };
}

describe('NdiConnection', () => {
  it('權限還沒問過：不自動連，按「連接」才連；按允許後小程序沒開 → 安靜重試（越來越久）', async () => {
    perm = fakePermission('prompt');
    const { conn, step, guide } = make();
    conn.setActive(true);
    await flush();
    expect(step()).toBe('need_permission');
    expect(FakeWS.all).toHaveLength(0);

    conn.connect();
    expect(FakeWS.all).toHaveLength(1);
    expect(guide().pending).toBe(true);
    // 詢問中：不會再開第二條
    conn.connect();
    expect(FakeWS.all).toHaveLength(1);

    perm!.set('granted');            // 按了允許
    FakeWS.all[0].refuse();          // 但小程序沒開
    expect(step()).toBe('helper_missing');
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all).toHaveLength(2);
    expect(step()).toBe('helper_missing');  // 重試中不閃成「連線中」
    FakeWS.all[1].refuse();
    await vi.advanceTimersByTimeAsync(2999);
    expect(FakeWS.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all).toHaveLength(3);
    conn.destroy();
  });

  it('關掉詢問視窗（權限還是沒問過）→ 不自動再問', async () => {
    perm = fakePermission('prompt');
    const { conn, step } = make();
    conn.setActive(true);
    await flush();
    conn.connect();
    FakeWS.all[0].refuse();
    expect(step()).toBe('need_permission');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(1);
    conn.destroy();
  });

  it('被封鎖 → permission_denied、不重試；到設定改成允許 → 自動連', async () => {
    perm = fakePermission('denied');
    const { conn, step } = make();
    conn.setActive(true);
    await flush();
    expect(step()).toBe('permission_denied');
    expect(FakeWS.all).toHaveLength(0);
    perm!.set('granted');
    expect(FakeWS.all).toHaveLength(1);
    FakeWS.all[0].accept(NEW_HELLO);
    expect(step()).toBe('connecting');
    conn.destroy();
  });

  it('已經允許過 → 打開就自動連；舊版小程序 → helper_outdated，有畫面照樣 LIVE', async () => {
    const { conn, step, guide, frames } = make();
    conn.setActive(true);
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    FakeWS.all[0].accept({ version: '0.1.8', source: AE });
    expect(step()).toBe('helper_outdated');
    FakeWS.all[0].frame();
    await flush();
    expect(frames).toHaveLength(1);
    expect(step()).toBe('live');
    expect(guide().outdated).toBe(true);
    conn.destroy();
  });

  it('新版小程序：找不到 AE → 接上但沒畫面 3 秒 → 畫面來了 LIVE → 停住', async () => {
    const { conn, step, guide } = make();
    conn.setActive(true);
    await flush();
    const ws = FakeWS.all[0];
    ws.accept(NEW_HELLO);
    ws.status({ state: 'searching', source: null, sources: [] });
    expect(step()).toBe('no_source');
    ws.status(LIVE_STATUS);
    expect(step()).toBe('connecting');
    await vi.advanceTimersByTimeAsync(3100);
    expect(step()).toBe('waiting_frames');
    expect(guide().hadFrames).toBe(false);
    ws.frame();
    await flush();
    expect(step()).toBe('live');
    expect(guide().sources.map(s => s.name)).toEqual([AE, 'OTHER (Adobe After Effects)']);
    await vi.advanceTimersByTimeAsync(3100);
    expect(step()).toBe('waiting_frames');
    expect(guide().hadFrames).toBe(true);   // AE 停住：LED 留最後一格
    expect(guide().hasFrame).toBe(true);
    conn.destroy();
  });

  it('0.1.10：這台電腦的 AE 沒在送、只有別台的 → no_local_source、給選；選了別台 → 送 select_source、接上就 LIVE', async () => {
    const { conn, step, guide } = make();
    conn.setActive(true);
    await flush();
    const ws = FakeWS.all[0];
    ws.accept(NEW_HELLO);
    const REMOTE = 'OTHER-PC (Adobe After Effects)';
    ws.status({
      state: 'searching', mode: 'auto', preferred: null, source: null,
      error: { code: 'no_local_source', message: '找不到這台電腦的 After Effects NDI 輸出' },
      sources: [{ name: REMOTE, local: false, afterEffects: true }],
      receiving: false, fps: 0, width: 0, height: 0, framesPaused: false,
      autostart: { wanted: true, registered: true, error: null },
    });
    expect(step()).toBe('no_local_source');
    expect(guide().sources.map(s => s.name)).toEqual([REMOTE]);
    conn.selectSource(REMOTE);
    expect(ws.commands()).toContainEqual({ type: 'select_source', name: REMOTE });
    expect(guide().mode).toBe('manual');
    ws.status({ ...LIVE_STATUS, mode: 'manual', preferred: REMOTE, source: REMOTE, sources: [{ name: REMOTE, local: false, afterEffects: true }] });
    expect(step()).toBe('connecting');
    ws.frame();
    await flush();
    expect(step()).toBe('live');
    expect(guide().source).toBe(REMOTE);
    conn.destroy();
  });

  it('0.1.9（會自己接別台）→ 叫他更新；有畫面照樣 LIVE', async () => {
    const { conn, step, guide, frames } = make();
    conn.setActive(true);
    await flush();
    const ws = FakeWS.all[0];
    ws.accept({ ...NEW_HELLO, version: '0.1.9' });
    ws.status(LIVE_STATUS);
    expect(step()).toBe('helper_outdated');
    ws.frame();
    await flush();
    expect(frames).toHaveLength(1);
    expect(step()).toBe('live');
    expect(guide().outdated).toBe(true);
    conn.destroy();
  });

  it('開機自動啟動沒設好 → 只是提醒（照樣 LIVE）', async () => {
    const { conn, step, guide } = make();
    conn.setActive(true);
    await flush();
    const ws = FakeWS.all[0];
    ws.accept(NEW_HELLO);
    ws.status({ ...LIVE_STATUS, autostart: { wanted: true, registered: false, error: '存取被拒' } });
    ws.frame();
    await flush();
    expect(step()).toBe('live');
    expect(guide().autostartFailed).toBe(true);
    ws.status({ ...LIVE_STATUS, autostart: { wanted: true, registered: true, error: null } });
    expect(guide().autostartFailed).toBe(false);
    conn.destroy();
  });

  it('沒裝 NDI Tools → ndi_missing', async () => {
    const { conn, step } = make();
    conn.setActive(true);
    await flush();
    FakeWS.all[0].accept(NEW_HELLO);
    FakeWS.all[0].status({ state: 'ndi_missing', error: { code: 'ndi_missing', message: '沒有安裝 NDI Runtime' }, sources: [] });
    expect(step()).toBe('ndi_missing');
    conn.destroy();
  });

  it('選來源送 select_source（null = 自動），選單馬上跟著變', async () => {
    const { conn, guide } = make();
    conn.setActive(true);
    await flush();
    const ws = FakeWS.all[0];
    ws.accept(NEW_HELLO);
    ws.status(LIVE_STATUS);
    conn.selectSource('OTHER (Adobe After Effects)');
    expect(ws.commands()).toContainEqual({ type: 'select_source', name: 'OTHER (Adobe After Effects)' });
    expect(guide().mode).toBe('manual');
    expect(guide().preferred).toBe('OTHER (Adobe After Effects)');
    conn.selectSource(null);
    expect(ws.commands()).toContainEqual({ type: 'select_source', name: null });
    expect(guide().mode).toBe('auto');
    conn.destroy();
  });

  it('切走（分享頁換成本地檔案）→ pause、不解畫面、不重試；切回來 → resume', async () => {
    const { conn, frames } = make();
    conn.setActive(true);
    await flush();
    const ws = FakeWS.all[0];
    ws.accept(NEW_HELLO);
    ws.status(LIVE_STATUS);
    conn.setActive(false);
    expect(ws.commands()).toContainEqual({ type: 'pause' });
    ws.frame();
    await flush();
    expect(frames).toHaveLength(0);
    conn.setActive(true);
    expect(ws.commands()).toContainEqual({ type: 'resume' });
    ws.frame();
    await flush();
    expect(frames).toHaveLength(1);
    // 切走時小程序關掉 → 不重試
    conn.setActive(false);
    ws.refuse();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWS.all).toHaveLength(1);
    conn.destroy();
  });

  it('還沒要用（分享頁一開始就是本地檔案）→ 不連', async () => {
    const { conn } = make();
    await flush();
    expect(FakeWS.all).toHaveLength(0);
    conn.setActive(true);
    expect(FakeWS.all).toHaveLength(1);
    conn.destroy();
  });

  it('Safari → 不連', async () => {
    const { conn, step } = make({ env: { browser: 'safari', os: 'mac', loopbackPage: false } });
    conn.setActive(true);
    await flush();
    expect(step()).toBe('browser_unsupported');
    conn.connect();
    conn.retry();
    expect(FakeWS.all).toHaveLength(0);
    conn.destroy();
  });

  it('瀏覽器不支援權限查詢 → 直接連', async () => {
    perm = null;
    const { conn } = make();
    conn.setActive(true);
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    FakeWS.all[0].refuse();
    expect(conn.getGuide().step).toBe('helper_missing');
    conn.destroy();
  });

  it('設定頁的檢查：按了就連（會跳詢問）、連上送 pause、不收畫面 → ready', async () => {
    perm = fakePermission('prompt');
    const { conn, step, frames } = make({ wantFrames: false, connectOnPrompt: true });
    conn.setActive(true);
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    const ws = FakeWS.all[0];
    ws.accept(NEW_HELLO);
    expect(ws.commands()).toContainEqual({ type: 'pause' });
    ws.status({ ...LIVE_STATUS, state: 'standby' });
    expect(step()).toBe('ready');
    ws.frame();
    await flush();
    expect(frames).toHaveLength(0);
    conn.destroy();
  });

  it('切回這個分頁（剛裝好小程序）→ 不用等，馬上再試', async () => {
    const { conn } = make();
    conn.setActive(true);
    await flush();
    FakeWS.all[0].refuse();
    expect(FakeWS.all).toHaveLength(1);
    fire('focus');
    expect(FakeWS.all).toHaveLength(2);
    conn.destroy();
  });

  it('新網址（舊版小程序會擋）：連不到 → helper_missing + 可能是舊版；連上舊版 → helper_outdated', async () => {
    const { conn, step, guide } = make({ env: { ...CHROME, oldHelperBlocked: true } });
    conn.setActive(true);
    await flush();
    FakeWS.all[0].refuse();
    expect(step()).toBe('helper_missing');
    expect(guide().maybeOldHelper).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.all).toHaveLength(2);   // 照原本的重試
    FakeWS.all[1].accept({ ...NEW_HELLO, version: '0.1.10' });
    expect(step()).toBe('helper_outdated');
    expect(guide().maybeOldHelper).toBe(false);
    conn.destroy();
  });

  it('0.1.10 小程序（不認得新網址，在舊網址連得上）→ 叫他更新', async () => {
    const { conn, step } = make();
    conn.setActive(true);
    await flush();
    FakeWS.all[0].accept({ ...NEW_HELLO, version: '0.1.10' });
    FakeWS.all[0].status(LIVE_STATUS);
    expect(step()).toBe('helper_outdated');
    conn.destroy();
  });

  it('localhost 開發：權限「還沒問過」當成不用問，直接連', async () => {
    perm = fakePermission('prompt');
    const { conn } = make({ env: { ...CHROME, loopbackPage: true } });
    conn.setActive(true);
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    conn.destroy();
  });
});
