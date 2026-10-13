import { describe, it, expect } from 'vitest';
import {
  compareVersions, decideNdiStep, detectBrowser, detectOs, FRAME_STALE_MS, isHelperOutdated, isLoopbackHost, retryDelayMs,
  ndiChecklist, ndiShortLabel, ndiStepMessage, parseHello, parseHelperStatus, showSourcePicker, sortSources, sourceLabel,
  type NdiGuide, type NdiHello, type NdiHelperStatus, type NdiStep, type NdiStepInput,
} from './ndiSteps';

const HELLO: NdiHello = { version: '0.1.9', protocol: 2, platform: 'windows', source: null };
const OLD_HELLO: NdiHello = { version: '0.1.8', protocol: null, platform: null, source: 'PC (Adobe After Effects)' };
const AE = 'ULTRA9-285K (Adobe After Effects)';

const status = (patch: Partial<NdiHelperStatus> = {}): NdiHelperStatus => ({
  state: 'live', error: null, mode: 'auto', preferred: null, source: AE,
  sources: [{ name: AE, local: true, afterEffects: true }],
  receiving: true, fps: 30, width: 1920, height: 1080, framesPaused: false,
  ...patch,
});

/** 預設：Chrome、允許了、連上新版小程序、正在收畫面 */
const input = (patch: Partial<NdiStepInput> = {}): NdiStepInput => ({
  browser: 'chromium', permission: 'granted', socket: 'open', everConnected: true, failures: 0,
  hello: HELLO, status: status(), wantFrames: true, lastFrameAt: 10_000, sourceSince: 5_000, now: 10_500,
  ...patch,
});

const step = (patch: Partial<NdiStepInput> = {}): NdiStep => decideNdiStep(input(patch)).step;

describe('decideNdiStep：每一步', () => {
  it('Safari → browser_unsupported（不管其他狀態）', () => {
    expect(step({ browser: 'safari' })).toBe('browser_unsupported');
    expect(step({ browser: 'safari', socket: 'idle', permission: 'unknown', hello: null, status: null })).toBe('browser_unsupported');
  });

  it('權限還沒問過、沒連上過 → need_permission；按了連接在等 → pending', () => {
    const base = { permission: 'prompt' as const, socket: 'idle' as const, everConnected: false, hello: null, status: null, lastFrameAt: null };
    expect(step(base)).toBe('need_permission');
    const waiting = decideNdiStep(input({ ...base, socket: 'connecting' }));
    expect(waiting.step).toBe('need_permission');
    expect(waiting.pending).toBe(true);
    // 關掉詢問視窗沒選 → 連線失敗、權限還是 prompt → 再顯示按鈕
    const dismissed = decideNdiStep(input({ ...base, socket: 'closed', failures: 1 }));
    expect(dismissed.step).toBe('need_permission');
    expect(dismissed.pending).toBe(false);
  });

  it('按了封鎖 → permission_denied', () => {
    expect(step({ permission: 'denied', socket: 'closed', hello: null, status: null, failures: 1 })).toBe('permission_denied');
    expect(step({ permission: 'denied', socket: 'idle', everConnected: false, hello: null, status: null })).toBe('permission_denied');
  });

  it('允許了（或瀏覽器不用問）但連不到 → helper_missing', () => {
    const base = { socket: 'closed' as const, hello: null, status: null, failures: 1, lastFrameAt: null };
    expect(step({ ...base, permission: 'granted' })).toBe('helper_missing');
    expect(step({ ...base, permission: 'unknown' })).toBe('helper_missing');
    // 重試中（連線中但之前失敗過）不會閃成「連線中」
    expect(step({ ...base, socket: 'connecting', failures: 3 })).toBe('helper_missing');
    // 連上過、小程序後來關掉
    expect(step({ ...base, permission: 'prompt', everConnected: true })).toBe('helper_missing');
  });

  it('第一次連、還在問權限、等 hello → connecting', () => {
    expect(step({ socket: 'connecting', hello: null, status: null, failures: 0 })).toBe('connecting');
    expect(step({ permission: 'checking', socket: 'idle', hello: null, status: null })).toBe('connecting');
    expect(step({ socket: 'open', hello: null, status: null })).toBe('connecting');
    expect(step({ status: null, lastFrameAt: null })).toBe('connecting');
    expect(step({ status: status({ state: 'starting' }), lastFrameAt: null })).toBe('connecting');
  });

  it('舊版小程序（沒有 protocol / 版本太舊）→ helper_outdated；有畫面照樣 live', () => {
    expect(step({ hello: OLD_HELLO, status: null, lastFrameAt: null })).toBe('helper_outdated');
    expect(step({ hello: { ...HELLO, version: '0.1.5', protocol: 2 }, lastFrameAt: null })).toBe('helper_outdated');
    const live = decideNdiStep(input({ hello: OLD_HELLO, status: parseHelperStatus({ type: 'status', source: 'PC', fps: 25 }) }));
    expect(live.step).toBe('live');
    expect(live.outdated).toBe(true);
    // 舊版畫面停了 → 叫他更新
    expect(step({ hello: OLD_HELLO, lastFrameAt: 1_000, now: 10_000 })).toBe('helper_outdated');
  });

  it('小程序說沒裝 NDI / NDI 啟動失敗 → ndi_missing', () => {
    expect(step({ status: status({ state: 'ndi_missing', source: null, sources: [] }), lastFrameAt: null })).toBe('ndi_missing');
    const g = decideNdiStep(input({
      status: status({ state: 'ndi_error', error: { code: 'ndi_init_failed', message: 'NDI 初始化失敗' } }), lastFrameAt: null,
    }));
    expect(g.step).toBe('ndi_missing');
    expect(g.helperError).toBe('NDI 初始化失敗');
  });

  it('找不到任何來源 → no_source', () => {
    expect(step({ status: status({ state: 'searching', source: null, sources: [] }), lastFrameAt: null })).toBe('no_source');
    expect(step({ status: status({ state: 'standby', source: null }), lastFrameAt: null })).toBe('no_source');
  });

  it('接上來源但超過 3 秒沒畫面 → waiting_frames；3 秒內 → connecting', () => {
    const base = { status: status({ state: 'connecting', receiving: false }), lastFrameAt: null, sourceSince: 1_000 };
    expect(step({ ...base, now: 1_000 + FRAME_STALE_MS - 1 })).toBe('connecting');
    const g = decideNdiStep(input({ ...base, now: 1_000 + FRAME_STALE_MS + 1 }));
    expect(g.step).toBe('waiting_frames');
    expect(g.hadFrames).toBe(false);
    expect(g.row).toBe(4);
  });

  it('播到一半停住（AE 暫停 / 跑到背景）→ waiting_frames 且 hadFrames（LED 留最後一格）', () => {
    const g = decideNdiStep(input({ status: status({ state: 'connecting' }), lastFrameAt: 5_000, sourceSince: 1_000, now: 9_000 }));
    expect(g.step).toBe('waiting_frames');
    expect(g.hadFrames).toBe(true);
    expect(g.hasFrame).toBe(true);
    expect(ndiShortLabel(g)).toBe('AE 停住了');
  });

  it('換了來源：之前的畫面不算這個來源的', () => {
    const g = decideNdiStep(input({ lastFrameAt: 5_000, sourceSince: 6_000, now: 7_000, status: status({ state: 'connecting' }) }));
    expect(g.step).toBe('connecting');
    expect(g.hadFrames).toBe(false);
    expect(g.hasFrame).toBe(true);
    expect(step({ lastFrameAt: 5_000, sourceSince: 6_000, now: 6_000 + FRAME_STALE_MS + 1, status: status({ state: 'connecting' }) })).toBe('waiting_frames');
  });

  it('畫面正在進來 → live（小程序的 fps，沒有就用自己量的）', () => {
    const g = decideNdiStep(input());
    expect(g.step).toBe('live');
    expect(g.row).toBe(5);
    expect(g.fps).toBe(30);
    expect(g.source).toBe(AE);
    expect(decideNdiStep(input({ status: status({ fps: null }), measuredFps: 24.6 })).fps).toBe(25);
    // 小程序 state 慢一拍還是 connecting，但畫面已經在進來 → live
    expect(step({ status: status({ state: 'connecting' }) })).toBe('live');
    // 剛停住（還沒過 3 秒）：不顯示「0 fps」
    expect(decideNdiStep(input({ status: status({ fps: 0 }), measuredFps: 0 })).fps).toBeNull();
  });

  it('使用者電腦上的舊版小程序（0.1.7）實際送的訊息 → helper_outdated', () => {
    const hello = parseHello(JSON.parse('{"source":"ULTRA9-285K (Adobe After Effects)","type":"hello","version":"0.1.7"}'));
    const st = parseHelperStatus(JSON.parse('{"availableSources":["ULTRA9-285K (Adobe After Effects)"],"clients":4,"fps":33.732826232910156,"frameCount":43383,"lastError":null,"source":"ULTRA9-285K (Adobe After Effects)","type":"status"}'));
    const g = decideNdiStep(input({ hello, status: st, lastFrameAt: null }));
    expect(g.step).toBe('helper_outdated');
    expect(g.helperVersion).toBe('0.1.7');
    expect(ndiStepMessage(g, 'chromium').detail[0]).toBe('你的版本是 0.1.7，裝好新版後會自動連上');
  });

  it('設定頁的檢查（不收畫面）→ ready', () => {
    expect(step({ wantFrames: false, lastFrameAt: null, status: status({ state: 'standby' }) })).toBe('ready');
    // 不收畫面時，舊版送來的畫面不算 live
    expect(step({ wantFrames: false, hello: OLD_HELLO })).toBe('helper_outdated');
  });
});

describe('ndiChecklist', () => {
  const rows = (g: NdiGuide) => ndiChecklist(g).map(r => r.state[0]).join('');
  it('停在目前那一格，前面打勾', () => {
    expect(rows(decideNdiStep(input({ browser: 'safari' })))).toBe('ctttt');
    expect(rows(decideNdiStep(input({ socket: 'closed', hello: null, status: null, failures: 2 })))).toBe('dcttt');
    expect(rows(decideNdiStep(input({ status: status({ state: 'ndi_missing' }), lastFrameAt: null })))).toBe('ddctt');
    expect(rows(decideNdiStep(input({ status: status({ state: 'searching', source: null }), lastFrameAt: null })))).toBe('dddct');
    expect(rows(decideNdiStep(input({ status: status({ state: 'connecting' }), lastFrameAt: null, sourceSince: 0, now: 9_000 })))).toBe('ddddc');
    expect(rows(decideNdiStep(input()))).toBe('ddddd');
    // 不收畫面的檢查：最後一格不知道
    expect(rows(decideNdiStep(input({ wantFrames: false, lastFrameAt: null })))).toBe('ddddt');
  });
  it('五格的名字', () => {
    expect(ndiChecklist(decideNdiStep(input())).map(r => r.label)).toEqual(['瀏覽器允許', '小程序', 'NDI Tools', '找到 AE', 'AE 在送畫面']);
  });
});

describe('ndiStepMessage', () => {
  const msg = (patch: Partial<NdiStepInput>, browser: NdiStepInput['browser'] = 'chromium') =>
    ndiStepMessage(decideNdiStep(input(patch)), browser);

  it('每一步都有中文說明', () => {
    expect(msg({ browser: 'safari' }).title).toBe('Safari 不支援 AE 即時畫面，請改用 Chrome、Edge 或 Firefox 開這個連結');
    expect(msg({ permission: 'prompt', socket: 'idle', everConnected: false, hello: null, status: null }).title)
      .toBe('等一下瀏覽器會問你『允許存取這台裝置上的應用程式和服務』，請按『允許』');
    expect(msg({ socket: 'closed', hello: null, status: null, failures: 1 }).title).toBe('沒有偵測到 NDI 小程序');
    expect(msg({ socket: 'closed', hello: null, status: null, failures: 1 }).detail).toContain('裝好打開後會自動連上');
    expect(msg({ hello: OLD_HELLO, lastFrameAt: null }).title).toBe('小程序有新版，請下載更新');
    expect(msg({ status: status({ state: 'ndi_missing' }), lastFrameAt: null }).title).toBe('請先安裝 NDI Tools（免費）');
    expect(msg({ status: status({ state: 'searching', source: null }), lastFrameAt: null }).title)
      .toBe('找不到 AE：確認 AE 有開，偏好設定 → 視訊預覽 有勾 NDI');
    expect(msg({ status: status({ state: 'connecting' }), lastFrameAt: null, sourceSince: 0, now: 9_000 }).title)
      .toBe(`已連上 ${AE}，但 AE 沒在送畫面：AE 要在播放；偏好設定 → 視訊預覽 →『在背景時停用視訊輸出』要取消勾選`);
    expect(msg({}).title).toBe(`${AE} · 30 fps`);
    expect(msg({ socket: 'connecting', hello: null, status: null }).title).toBe('正在連接 NDI 小程序…');
    expect(msg({ wantFrames: false, lastFrameAt: null }).title).toBe(`小程序正常，找到 ${AE}`);
  });

  it('被擋住時照瀏覽器教怎麼改', () => {
    const denied = { permission: 'denied' as const, socket: 'closed' as const, hello: null, status: null, failures: 1 };
    expect(msg(denied, 'chromium').detail[0]).toBe('按網址列左邊的圖示 →「這個裝置上的應用程式」→ 允許');
    expect(msg(denied, 'firefox').detail[0]).toContain('設定 → 隱私與安全性 → 權限 →「裝置上的 App 與服務」');
    expect(msg(denied, 'other').detail.length).toBeGreaterThanOrEqual(2);
    expect(msg(denied).detail).toContain('改好後會自動連上');
  });

  it('短標示', () => {
    expect(ndiShortLabel(decideNdiStep(input()))).toBe('LIVE · 30 fps');
    expect(ndiShortLabel(decideNdiStep(input({ socket: 'closed', hello: null, status: null, failures: 1 })))).toBe('沒有偵測到小程序');
  });
});

describe('解析小程序訊息', () => {
  it('新版 hello / 舊版 hello', () => {
    expect(parseHello({ type: 'hello', version: '0.1.9', protocol: 2, platform: 'windows', port: 7777, source: '' }))
      .toEqual({ version: '0.1.9', protocol: 2, platform: 'windows', source: null });
    expect(parseHello({ type: 'hello', version: '0.1.8', source: 'PC (Adobe After Effects)' }))
      .toEqual({ version: '0.1.8', protocol: null, platform: null, source: 'PC (Adobe After Effects)' });
  });

  it('新版 status', () => {
    const s = parseHelperStatus({
      type: 'status', state: 'live', ndi: 'ready', error: null, mode: 'manual', preferred: 'B (Adobe After Effects)',
      source: 'B (Adobe After Effects)',
      sources: [{ name: 'A (Adobe After Effects)', local: true, afterEffects: true }, { name: 'B (Adobe After Effects)', local: false, afterEffects: true }],
      receiving: true, fps: 29.97, width: 1920, height: 1080, framesPaused: false,
    });
    expect(s.state).toBe('live');
    expect(s.mode).toBe('manual');
    expect(s.preferred).toBe('B (Adobe After Effects)');
    expect(s.sources).toHaveLength(2);
    expect(s.sources[0].local).toBe(true);
    expect(s.fps).toBeCloseTo(29.97);
  });

  it('error 物件 / 舊版 lastError / 舊版 availableSources', () => {
    expect(parseHelperStatus({ state: 'ndi_missing', error: { code: 'ndi_missing', message: '沒有安裝 NDI' } }).error)
      .toEqual({ code: 'ndi_missing', message: '沒有安裝 NDI' });
    const old = parseHelperStatus({ type: 'status', source: null, fps: 0, lastError: 'boom', availableSources: ['X (Adobe After Effects)', 'Y (OBS)'] });
    expect(old.state).toBeNull();
    expect(old.error).toEqual({ code: '', message: 'boom' });
    expect(old.sources).toEqual([
      { name: 'X (Adobe After Effects)', local: false, afterEffects: true },
      { name: 'Y (OBS)', local: false, afterEffects: false },
    ]);
  });

  it('看不懂的值不會壞', () => {
    const s = parseHelperStatus({ state: 'weird', sources: [null, 1, { name: '' }, { name: 'Z' }], fps: 'x' });
    expect(s.state).toBeNull();
    expect(s.sources).toEqual([{ name: 'Z', local: false, afterEffects: false }]);
    expect(s.fps).toBeNull();
  });
});

describe('版本', () => {
  it('compareVersions', () => {
    expect(compareVersions('0.1.9', '0.1.9')).toBe(0);
    expect(compareVersions('0.1.8', '0.1.9')).toBeLessThan(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.0-beta', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
  });
  it('isHelperOutdated', () => {
    expect(isHelperOutdated(HELLO)).toBe(false);
    expect(isHelperOutdated({ ...HELLO, version: '0.2.0' })).toBe(false);
    expect(isHelperOutdated(OLD_HELLO)).toBe(true);
    expect(isHelperOutdated({ ...HELLO, protocol: 1 })).toBe(true);
    expect(isHelperOutdated({ ...HELLO, version: '0.1.8' })).toBe(true);
  });
});

describe('瀏覽器 / 作業系統', () => {
  const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  const EDGE = CHROME_WIN + ' Edg/147.0.0.0';
  const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:154.0) Gecko/20100101 Firefox/154.0';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/147.0 Mobile/15E148 Safari/604.1';
  it('detectBrowser', () => {
    expect(detectBrowser(CHROME_WIN)).toBe('chromium');
    expect(detectBrowser(EDGE)).toBe('chromium');
    expect(detectBrowser(FIREFOX_MAC)).toBe('firefox');
    expect(detectBrowser(SAFARI)).toBe('safari');
    expect(detectBrowser(CHROME_IOS)).toBe('safari');
    expect(detectBrowser('curl/8')).toBe('other');
  });
  it('detectOs', () => {
    expect(detectOs(CHROME_WIN, 'Win32')).toBe('windows');
    expect(detectOs(FIREFOX_MAC, 'MacIntel')).toBe('mac');
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64')).toBe('other');
  });
  it('isLoopbackHost', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
    expect(isLoopbackHost('stage-previz.vercel.app')).toBe(false);
  });
});

describe('來源清單', () => {
  const list = [
    { name: 'OBS-PC (OBS)', local: false, afterEffects: false },
    { name: 'OTHER (Adobe After Effects)', local: false, afterEffects: true },
    { name: 'ME (NDI Test Patterns)', local: true, afterEffects: false },
    { name: 'ME (Adobe After Effects)', local: true, afterEffects: true },
  ];
  it('AE 排前面、這台電腦的先', () => {
    expect(sortSources(list).map(s => s.name)).toEqual([
      'ME (Adobe After Effects)', 'OTHER (Adobe After Effects)', 'ME (NDI Test Patterns)', 'OBS-PC (OBS)',
    ]);
  });
  it('這台電腦的標出來', () => {
    expect(sourceLabel(list[3])).toBe('ME (Adobe After Effects)（這台電腦）');
    expect(sourceLabel(list[1])).toBe('OTHER (Adobe After Effects)');
  });
  it('多於一個來源才給選', () => {
    const g = decideNdiStep(input());
    expect(showSourcePicker(g)).toBe(false);
    expect(showSourcePicker(decideNdiStep(input({ status: status({ sources: list }) })))).toBe(true);
    // 手動選過、只剩一個也要能選回自動
    expect(showSourcePicker(decideNdiStep(input({ status: status({ mode: 'manual', preferred: AE }) })))).toBe(true);
  });
});

describe('retryDelayMs', () => {
  it('越來越久，最多 10 秒', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryDelayMs)).toEqual([2000, 2000, 3000, 5000, 8000, 10000, 10000]);
  });
});
