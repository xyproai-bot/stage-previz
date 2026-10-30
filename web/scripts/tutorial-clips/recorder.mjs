// 錄影的底層：開頁面、假游標、用 CDP 的 screencast 一格一格接下來、存成圖片和時間表（之後 encode.mjs 轉成 mp4）。
//
// 為什麼不用 Playwright 內建的錄影：它的畫質低（VP8 低位元率），字會糊。
// 這裡用 deviceScaleFactor 1.5 錄（畫面放大 1.5 倍），再縮成 1280×720，字比較清楚。
//
// 假游標：只在錄影腳本裡用 addInitScript 加（不動網站程式）。游標會跟著真的滑鼠事件走，
// 按下去時有一圈小波紋；拖檔案時游標旁邊會跟著一個檔案小卡（像檔案總管拖檔案的樣子）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SETUP_INIT_SCRIPT, VIEW, statePath } from './browser.mjs';
import { WEB_BASE, WORK_DIR, sleep } from './lib.mjs';

export const SCALE = 1.5;                      // 錄影的顯示比例（browser.mjs 的 RECORD_ARGS）
export const RAW_DIR = join(WORK_DIR, 'raw');  // 每段短片的原始畫格：raw/<id>/f000001.jpg + frames.json

// ─── 假游標（注入頁面） ───
export const CURSOR_INIT_SCRIPT = `
(() => {
  if (window.__fakeCursorInstalled) return;
  window.__fakeCursorInstalled = true;
  const css = \`
    #__fc { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; }
    #__fc .arrow { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-3px, -2px);
      filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
    #__fc .ripple { position: absolute; left: 0; top: 0; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
      border: 3px solid rgba(255,255,255,.95); box-shadow: 0 0 0 2px rgba(16,199,138,.8); opacity: 0; }
    #__fc .ripple.go { animation: __fcr .55s ease-out forwards; }
    @keyframes __fcr { 0% { transform: scale(.4); opacity: 1; } 100% { transform: scale(3.2); opacity: 0; } }
    #__fc .ghost { position: absolute; left: 16px; top: 14px; display: none; align-items: center; gap: 8px; padding: 7px 12px 7px 9px;
      background: rgba(34,37,44,.96); color: #fff; border: 1px solid rgba(255,255,255,.35); border-radius: 8px;
      font: 600 13px/1.2 "Microsoft JhengHei", "PingFang TC", system-ui, sans-serif; white-space: nowrap;
      box-shadow: 0 6px 18px rgba(0,0,0,.5); }
    #__fc .ghost svg { width: 18px; height: 18px; flex: none; }
  \`;
  const st = document.createElement('style'); st.textContent = css;
  const root = document.createElement('div'); root.id = '__fc';
  root.innerHTML = '<svg class="arrow" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.6 24 L15 22.4 L11.4 15 L18.5 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    + '<div class="ripple"></div>'
    + '<div class="ghost"><svg viewBox="0 0 24 24" fill="none" stroke="#10c78a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg><span></span></div>';
  const mount = () => {
    const de = document.documentElement;
    if (de && !de.contains(root)) { de.appendChild(st); de.appendChild(root); }
  };
  mount();
  document.addEventListener('DOMContentLoaded', mount);
  let x = window.__cursorStart ? window.__cursorStart.x : 1120, y = window.__cursorStart ? window.__cursorStart.y : 640;
  const place = () => { root.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  place();
  const move = (e) => { x = e.clientX; y = e.clientY; place(); };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('mousedown', (e) => {
    x = e.clientX; y = e.clientY; place();
    const r = root.querySelector('.ripple'); r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
  }, true);
  window.__fcGhost = (label) => {
    const g = root.querySelector('.ghost');
    if (!label) { g.style.display = 'none'; return; }
    g.querySelector('span').textContent = label; g.style.display = 'flex';
  };
  setInterval(mount, 500);
})();
`;

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** 一段短片的瀏覽器分頁 + 假游標 + 錄影 */
export class Clip {
  /**
   * @param {import('playwright').Browser} browser
   * @param {{ role: 'animator'|'director'|'producer', source?: 'version'|'ndi'|'file'|null, initScripts?: string[] }} o
   */
  static async open(browser, { role, source = 'version', initScripts = [] }) {
    const ctx = await browser.newContext({
      viewport: null, locale: 'zh-TW', storageState: statePath(role), acceptDownloads: true,
    });
    await ctx.addInitScript(SETUP_INIT_SCRIPT);
    if (source) await ctx.addInitScript(`try { localStorage.setItem('sp_led_source:studio', ${JSON.stringify(source)}); } catch (e) {}`);
    await ctx.addInitScript(CURSOR_INIT_SCRIPT);
    for (const s of initScripts) await ctx.addInitScript(s);
    const page = await ctx.newPage();
    const clip = new Clip(ctx, page);
    page.on('pageerror', (e) => console.log('  [頁面錯誤]', String(e.message).slice(0, 160)));
    return clip;
  }

  constructor(ctx, page) {
    this.ctx = ctx;
    this.page = page;
    this.pos = { x: 1120, y: 640 };
    this.frames = [];
    this.cdp = null;
    this.writes = [];
  }

  async goto(path) {
    await this.page.goto(WEB_BASE + path);
  }

  async close() { await this.ctx.close(); }

  pause(ms) { return sleep(ms); }

  // ─── 游標 ───
  /** 讓真的滑鼠和假游標一開始就在這個位置（錄影開始前） */
  async placeCursor(x, y) {
    this.pos = { x, y };
    await this.page.mouse.move(x, y);
  }

  async moveTo(x, y, ms = 700) {
    const { x: x0, y: y0 } = this.pos;
    const dist = Math.hypot(x - x0, y - y0);
    if (dist < 1) return;
    const bow = Math.min(40, dist * 0.06) * (x >= x0 ? -1 : 1);     // 輕輕彎一點，像手移的
    const nx = -(y - y0) / dist, ny = (x - x0) / dist;
    const t0 = performance.now();
    for (;;) {
      const p = Math.min(1, (performance.now() - t0) / ms);
      const e = ease(p);
      const arc = Math.sin(Math.PI * e) * bow;
      await this.page.mouse.move(x0 + (x - x0) * e + nx * arc, y0 + (y - y0) * e + ny * arc);
      if (p >= 1) break;
      await sleep(6);
    }
    this.pos = { x, y };
  }

  /** locator / 選擇器的中心點（CSS 像素）；offset = 在元素內的位置（0~1） */
  async centerOf(target, { fx = 0.5, fy = 0.5, left = null } = {}) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target.first();
    await loc.waitFor({ state: 'visible', timeout: 20000 });
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});   // 在面板裡被捲到外面的，先捲進來
    const b = await loc.boundingBox();
    if (!b) throw new Error('找不到要點的東西的位置');
    return { x: left != null ? b.x + left : b.x + b.width * fx, y: b.y + b.height * fy, box: b };
  }

  async hover(target, opts = {}) {
    const { x, y } = await this.centerOf(target, opts);
    await this.moveTo(x, y, opts.ms ?? 650);
  }

  async click(target, opts = {}) {
    const { x, y } = await this.centerOf(target, opts);
    await this.moveTo(x, y, opts.ms ?? 650);
    await sleep(opts.beforeMs ?? 140);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    await sleep(opts.afterMs ?? 120);
  }

  async clickAt(x, y, opts = {}) {
    await this.moveTo(x, y, opts.ms ?? 650);
    await sleep(opts.beforeMs ?? 140);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    await sleep(opts.afterMs ?? 120);
  }

  /** 按住滑鼠，沿著一串點拖過去，再放開（轉 3D 視角用） */
  async dragPath(points, { msPerLeg = 450 } = {}) {
    const [first, ...rest] = points;
    await this.moveTo(first.x, first.y, 600);
    await sleep(120);
    await this.page.mouse.down();
    for (const p of rest) await this.moveTo(p.x, p.y, msPerLeg);
    await this.page.mouse.up();
    await sleep(100);
  }

  /** 滾輪（正 = 往下 = 拉遠，負 = 拉近），分幾次慢慢滾 */
  async wheel(dy, { steps = 8, gapMs = 45 } = {}) {
    for (let i = 0; i < steps; i++) { await this.page.mouse.wheel(0, dy / steps); await sleep(gapMs); }
  }

  /** 游標旁邊跟著一張檔案小卡（拖檔案時） */
  async ghost(label) {
    await this.page.evaluate((l) => window.__fcGhost && window.__fcGhost(l), label || null);
  }

  // ─── 錄影 ───
  async startRecording(id) {
    const dir = join(RAW_DIR, id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.frames = [];
    this.writes = [];
    this.cdp = await this.ctx.newCDPSession(this.page);
    let n = 0;
    this.cdp.on('Page.screencastFrame', (f) => {
      const idx = ++n;
      const name = `f${String(idx).padStart(6, '0')}.jpg`;
      this.frames.push({ file: name, ts: f.metadata.timestamp });
      this.writes.push(writeFile(join(dir, name), Buffer.from(f.data, 'base64')));
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 92, maxWidth: Math.round(VIEW.width * SCALE), maxHeight: Math.round(VIEW.height * SCALE), everyNthFrame: 1,
    });
    this.startedAt = Date.now() / 1000;
    // 頁面完全靜止的話不會有畫格：游標輕輕動一下，逼它畫出第一格
    await this.page.mouse.move(this.pos.x + 1, this.pos.y);
    await this.page.mouse.move(this.pos.x, this.pos.y);
  }

  async stopRecording() {
    await sleep(150);
    const endTs = Date.now() / 1000;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(this.writes);
    const out = { endTs, frames: this.frames, scale: SCALE, viewport: VIEW };
    writeFileSync(join(this.dir, 'frames.json'), JSON.stringify(out));
    return out;
  }
}
