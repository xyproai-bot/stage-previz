import { describe, it, expect } from 'vitest';
import {
  compareVersions, decideNdiStep, detectBrowser, detectOs, FRAME_STALE_MS, isHelperOutdated, isLoopbackHost, retryDelayMs,
  MIN_HELPER_VERSION, NDI_AUTOSTART_NOTE, OLD_HELPER_HINT, oldHelperBlocksHost,
  ndiAutostartNote, ndiChecklist, ndiShortLabel, ndiStepMessage, parseHello, parseHelperStatus, showSourcePicker, sortSources,
  sourceLabel, sourcePickerInStep, splitSourceName,
  type NdiGuide, type NdiHello, type NdiHelperStatus, type NdiStep, type NdiStepInput,
} from './ndiSteps';

const HELLO: NdiHello = { version: '0.1.11', protocol: 2, platform: 'windows', source: null };
const OLD_HELLO: NdiHello = { version: '0.1.8', protocol: null, platform: null, source: 'PC (Adobe After Effects)' };
const AE = 'ULTRA9-285K (Adobe After Effects)';

const status = (patch: Partial<NdiHelperStatus> = {}): NdiHelperStatus => ({
  state: 'live', error: null, mode: 'auto', preferred: null, source: AE,
  sources: [{ name: AE, local: true, afterEffects: true }],
  receiving: true, fps: 30, width: 1920, height: 1080, framesPaused: false,
  autostart: { wanted: true, registered: true, error: null },
  ...patch,
});

const REMOTE = { name: 'OTHER-PC (Adobe After Effects)', local: false, afterEffects: true };
/** 0.1.10：這台電腦的 AE 沒在送，網路上只有別台的 → 不自動接 */
const NO_LOCAL = (sources = [REMOTE]) => status({
  state: 'searching', source: null, sources, receiving: false, fps: 0, width: 0, height: 0,
  error: { code: 'no_local_source', message: '找不到這台電腦的 After Effects NDI 輸出' },
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
    expect(step({
      status: status({ state: 'searching', source: null, sources: [], error: { code: 'no_source', message: '找不到 NDI 來源' } }),
      lastFrameAt: null,
    })).toBe('no_source');
  });

  it('這台電腦的 AE 沒在送、只有別台的來源（0.1.10）→ no_local_source，停在「找到 AE」', () => {
    const g = decideNdiStep(input({ status: NO_LOCAL([REMOTE, { name: 'OBS-PC (OBS)', local: false, afterEffects: false }]), lastFrameAt: null }));
    expect(g.step).toBe('no_local_source');
    expect(g.row).toBe(3);
    expect(g.source).toBeNull();
    expect(g.sources.map(s => s.name)).toEqual(['OTHER-PC (Adobe After Effects)', 'OBS-PC (OBS)']);
    // 設定頁的檢查（不收畫面）也一樣
    expect(step({ wantFrames: false, status: NO_LOCAL(), lastFrameAt: null })).toBe('no_local_source');
    // 選了別台、接上之後就照一般流程
    expect(step({ status: status({ mode: 'manual', preferred: REMOTE.name, source: REMOTE.name, sources: [REMOTE] }) })).toBe('live');
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
    expect(rows(decideNdiStep(input({ status: NO_LOCAL(), lastFrameAt: null })))).toBe('dddct');
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

  it('這台電腦的 AE 沒在送 NDI：說怎麼檢查 + 叫他在下面選別台', () => {
    const m = msg({ status: NO_LOCAL(), lastFrameAt: null });
    expect(m.title).toBe('這台電腦的 AE 沒有在送 NDI');
    expect(m.detail).toEqual([
      '確認 AE 開著、偏好設定 → 視訊預覽 有勾 NDI、AE 在播放',
      '要看網路上別台電腦的 AE，請在下面選',
    ]);
    // 設定頁一樣的說法
    expect(msg({ wantFrames: false, status: NO_LOCAL(), lastFrameAt: null })).toEqual(m);
  });

  it('被擋住時照瀏覽器教怎麼改', () => {
    const denied = { permission: 'denied' as const, socket: 'closed' as const, hello: null, status: null, failures: 1 };
    expect(msg(denied, 'chromium').detail[0]).toBe('按網址列左邊的圖示 →「這個裝置上的應用程式」→ 允許');
    expect(msg(denied, 'firefox').detail[0]).toContain('設定 → 隱私與安全性 → 權限 →「裝置上的 App 與服務」');
    expect(msg(denied, 'other').detail.length).toBeGreaterThanOrEqual(2);
    expect(msg(denied).detail).toContain('改好後會自動連上');
  });

  it('新網址上連不到：可能沒開、也可能是舊版擋掉（分不出來）→ 兩種都說，一樣給下載', () => {
    const closed = { socket: 'closed' as const, hello: null, status: null, failures: 1, lastFrameAt: null };
    const g = decideNdiStep(input({ ...closed, oldHelperBlocked: true }));
    expect(g.step).toBe('helper_missing');
    expect(g.maybeOldHelper).toBe(true);
    expect(ndiStepMessage(g, 'chromium')).toEqual({
      title: '沒有偵測到 NDI 小程序',
      detail: [OLD_HELPER_HINT, '裝好打開後會自動連上'],
    });
    expect(OLD_HELPER_HINT).toBe('已經裝了也開著的話：可能是小程序版本太舊，不認得這個網址，請下載最新版');
    expect(ndiShortLabel(g)).toBe('沒有偵測到小程序');
    // 舊網址 / 本機開發：舊版小程序連得上 → 不多說
    const old = decideNdiStep(input(closed));
    expect(old.maybeOldHelper).toBe(false);
    expect(ndiStepMessage(old, 'chromium').detail).toEqual(['裝好打開後會自動連上']);
    // 其他步驟不受影響
    expect(decideNdiStep(input({ oldHelperBlocked: true })).maybeOldHelper).toBe(false);
    expect(decideNdiStep(input({ ...closed, permission: 'denied', oldHelperBlocked: true })).maybeOldHelper).toBe(false);
  });

  it('短標示', () => {
    expect(ndiShortLabel(decideNdiStep(input()))).toBe('LIVE · 30 fps');
    expect(ndiShortLabel(decideNdiStep(input({ status: NO_LOCAL(), lastFrameAt: null })))).toBe('找不到這台電腦的 AE');
    expect(ndiShortLabel(decideNdiStep(input({ status: status({ state: 'searching', source: null, sources: [] }), lastFrameAt: null })))).toBe('找不到 AE');
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
    expect(s.autostart).toBeNull();  // 0.1.9 沒有這欄
  });

  it('0.1.10 status：找不到這台的 AE + 開機自動啟動狀況', () => {
    const s = parseHelperStatus({
      type: 'status', version: '0.1.10', state: 'searching', ndi: 'ready',
      error: { code: 'no_local_source', message: '找不到這台電腦的 After Effects NDI 輸出' }, lastError: '找不到這台電腦的 After Effects NDI 輸出',
      mode: 'auto', preferred: null, source: null,
      sources: [{ name: 'OTHER-PC (Adobe After Effects)', local: false, afterEffects: true }],
      availableSources: ['OTHER-PC (Adobe After Effects)'],
      connected: false, receiving: false, fps: 0, width: 0, height: 0, framesPaused: false,
      autostart: { wanted: true, registered: false, error: '寫入登錄檔失敗：存取被拒' },
    });
    expect(s.state).toBe('searching');
    expect(s.error).toEqual({ code: 'no_local_source', message: '找不到這台電腦的 After Effects NDI 輸出' });
    expect(s.source).toBeNull();
    expect(s.sources).toEqual([{ name: 'OTHER-PC (Adobe After Effects)', local: false, afterEffects: true }]);
    expect(s.autostart).toEqual({ wanted: true, registered: false, error: '寫入登錄檔失敗：存取被拒' });
    expect(parseHelperStatus({ autostart: { wanted: true, registered: true, error: null } }).autostart)
      .toEqual({ wanted: true, registered: true, error: null });
  });

  it('autostart 看不懂 → null', () => {
    expect(parseHelperStatus({ autostart: null }).autostart).toBeNull();
    expect(parseHelperStatus({ autostart: 'yes' }).autostart).toBeNull();
    expect(parseHelperStatus({ autostart: { wanted: 'true', registered: false } }).autostart).toBeNull();
    expect(parseHelperStatus({ autostart: { wanted: true } }).autostart).toBeNull();
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
    expect(MIN_HELPER_VERSION).toBe('0.1.11');
    expect(isHelperOutdated(HELLO)).toBe(false);
    expect(isHelperOutdated({ ...HELLO, version: '0.1.12' })).toBe(false);
    // 0.1.10 不認得新網址 previz.haimiaan.com → 要更新
    expect(isHelperOutdated({ ...HELLO, version: '0.1.10' })).toBe(true);
    // 0.1.9 會自己接到網路上別台電腦的畫面 → 要更新
    expect(isHelperOutdated({ ...HELLO, version: '0.1.9' })).toBe(true);
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
  it('oldHelperBlocksHost：只有新網址（0.1.10 以前的小程序不認得）', () => {
    expect(oldHelperBlocksHost('previz.haimiaan.com')).toBe(true);
    expect(oldHelperBlocksHost('test.previz.haimiaan.com')).toBe(true);
    expect(oldHelperBlocksHost('Previz.Haimiaan.com')).toBe(true);
    expect(oldHelperBlocksHost('stage-previz.vercel.app')).toBe(false);
    expect(oldHelperBlocksHost('stage-previz-git-feat-live-stage-look-xyproai.vercel.app')).toBe(false);
    expect(oldHelperBlocksHost('localhost')).toBe(false);
    expect(oldHelperBlocksHost('evil.previz.haimiaan.com')).toBe(false);
    expect(oldHelperBlocksHost('')).toBe(false);
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
  it('這台電腦的標「這台電腦」、別台的標機器名', () => {
    expect(sourceLabel(list[3])).toBe('這台電腦的 Adobe After Effects');
    expect(sourceLabel(list[1])).toBe('OTHER 的 Adobe After Effects');
    expect(sourceLabel(list[0])).toBe('OBS-PC 的 OBS');
    // 名稱不是「機器名 (程式名)」→ 原樣（這台電腦的加註）
    expect(sourceLabel({ name: 'Weird', local: true, afterEffects: false })).toBe('Weird（這台電腦）');
    expect(sourceLabel({ name: 'Weird', local: false, afterEffects: false })).toBe('Weird');
  });
  it('splitSourceName：機器名 / 程式名（程式名裡可以有括號）', () => {
    expect(splitSourceName('ULTRA9-285K (Adobe After Effects)')).toEqual({ machine: 'ULTRA9-285K', program: 'Adobe After Effects' });
    expect(splitSourceName('PC (Adobe After Effects (2))')).toEqual({ machine: 'PC', program: 'Adobe After Effects (2)' });
    expect(splitSourceName('no parens')).toBeNull();
  });
  it('多於一個來源才給選', () => {
    const g = decideNdiStep(input());
    expect(showSourcePicker(g)).toBe(false);
    expect(showSourcePicker(decideNdiStep(input({ status: status({ sources: list }) })))).toBe(true);
    // 手動選過、只剩一個也要能選回自動
    expect(showSourcePicker(decideNdiStep(input({ status: status({ mode: 'manual', preferred: AE }) })))).toBe(true);
  });
  it('這台電腦的 AE 沒在送、只有一個別台的來源 → 也要給選（小程序不會自動接別台）', () => {
    const g = decideNdiStep(input({ status: NO_LOCAL([REMOTE]), lastFrameAt: null }));
    expect(g.step).toBe('no_local_source');
    expect(showSourcePicker(g)).toBe(true);
    expect(sourcePickerInStep(g)).toBe(true);
    // 一個來源都沒有 → 沒東西可選
    expect(showSourcePicker({ ...g, sources: [] })).toBe(false);
    // 一般情況（只有這台的一個、自動）→ 不用選，選單不放在說明裡
    const live = decideNdiStep(input());
    expect(showSourcePicker(live)).toBe(false);
    expect(sourcePickerInStep(live)).toBe(false);
    // 停住時的選單在說明裡
    expect(sourcePickerInStep(decideNdiStep(input({ status: status({ state: 'connecting' }), lastFrameAt: null, sourceSince: 0, now: 9_000 })))).toBe(true);
  });
});

describe('0.1.9 小程序（使用者電腦上現在裝的）', () => {
  const V019: NdiHello = { version: '0.1.9', protocol: 2, platform: 'windows', source: null };
  const st019 = status({ autostart: null });
  const rows = (g: NdiGuide) => ndiChecklist(g).map(r => r.state[0]).join('');
  it('沒畫面 → 叫他更新', () => {
    const g = decideNdiStep(input({ hello: V019, status: st019, lastFrameAt: null }));
    expect(g.step).toBe('helper_outdated');
    expect(g.outdated).toBe(true);
    const m = ndiStepMessage(g, 'chromium');
    expect(m.title).toBe('小程序有新版，請下載更新');
    expect(m.detail).toEqual(['你的版本是 0.1.9，裝好新版後會自動連上']);
    expect(ndiShortLabel(g)).toBe('小程序要更新');
    expect(rows(g)).toBe('dcttt');
  });
  it('有畫面照樣用（LIVE，只標出要更新）', () => {
    const g = decideNdiStep(input({ hello: V019, status: st019 }));
    expect(g.step).toBe('live');
    expect(g.outdated).toBe(true);
    expect(g.hasFrame).toBe(true);
  });
  it('設定頁的檢查 → 叫他更新', () => {
    expect(step({ hello: V019, status: st019, wantFrames: false, lastFrameAt: null })).toBe('helper_outdated');
  });
});

describe('開機自動啟動沒設好（0.1.10）', () => {
  const failed = { wanted: true, registered: false, error: '寫入登錄檔失敗' };
  it('想開、沒登記成功 → 提醒；不擋 AE 即時', () => {
    const live = decideNdiStep(input({ status: status({ autostart: failed }) }));
    expect(live.autostartFailed).toBe(true);
    expect(live.step).toBe('live');
    expect(ndiAutostartNote(live)).toBe('小程序沒辦法設成開機自動啟動（可能被電腦管家類軟體擋掉），下次開機要手動打開');
    expect(NDI_AUTOSTART_NOTE).toBe(ndiAutostartNote(live));
    // 其他步驟照常（例如找不到這台的 AE、設定頁的檢查）
    const noLocal = decideNdiStep(input({ status: { ...NO_LOCAL(), autostart: failed }, lastFrameAt: null }));
    expect(noLocal.step).toBe('no_local_source');
    expect(noLocal.autostartFailed).toBe(true);
    const ready = decideNdiStep(input({ wantFrames: false, lastFrameAt: null, status: status({ state: 'standby', autostart: failed }) }));
    expect(ready.step).toBe('ready');
    expect(ndiAutostartNote(ready)).toBe(NDI_AUTOSTART_NOTE);
  });
  it('有登記好 / 使用者自己關掉 / 舊版沒回報 / 還沒連上 → 不提醒', () => {
    const note = (autostart: NdiHelperStatus['autostart']) => ndiAutostartNote(decideNdiStep(input({ status: status({ autostart }) })));
    expect(note({ wanted: true, registered: true, error: null })).toBeNull();
    expect(note({ wanted: false, registered: false, error: null })).toBeNull();
    expect(note(null)).toBeNull();
    expect(decideNdiStep(input({ socket: 'closed', hello: null, status: null, failures: 1 })).autostartFailed).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('越來越久，最多 10 秒', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryDelayMs)).toEqual([2000, 2000, 3000, 5000, 8000, 10000, 10000]);
  });
});
