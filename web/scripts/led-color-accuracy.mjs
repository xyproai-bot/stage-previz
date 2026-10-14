#!/usr/bin/env node
// LED 顏色量測：3D 畫面裡正面看 LED，跟原檔差多少（灰階差幾階、彩色 ΔE2000）
//
//   node scripts/led-color-accuracy.mjs --label after
//   node scripts/led-color-accuracy.mjs --report before after      （兩次的結果排成一張表）
//
// 做的事：
//   1. 開 Vite 開發伺服器（web/led-color-harness.html：真的 StageScene + 做出來的小舞台）
//   2. 色卡（灰階 0…255、原色、75% 彩條、膚色、Macbeth）→ PNG；用 ffmpeg 做成 H.264（BT.709 limited，有標 / 沒標 /
//      full range）、VP9 影片
//   3. 另開一個「影片網站」（不同網址、CORS、可以拖拉）= R2 版本那條路；另開一個假的 NDI 小程序（WebSocket、
//      hello / status、每 100ms 一張 JPEG，JPEG 照小程序的作法做：2 倍縮小 + limited→full + 品質 75）
//   4. Chrome（headless，預設 SwiftShader 軟體繪圖；--gpu 用顯卡）打開量測頁，每種來源 × 快速 / 現場量一次
//   5. 結果：<out>/<label>.json、<label>.md、截圖 <label>-*.png
//
// 需要：playwright-core（npm i -D playwright-core，或 --playwright <playwright-core 資料夾>）、Chrome（--channel chrome，
//   沒有就用 playwright 的 chromium）、ffmpeg（PATH 或 --ffmpeg / FFMPEG）。

import { createServer as createViteServer } from 'vite';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── 參數 ───
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'ledcolor')));
const LABEL = opt('label', 'run');
const GPU = flag('gpu');
const QUICK = flag('quick');  // 少量：只量圖片 + 本地影片 + NDI
fs.mkdirSync(OUT, { recursive: true });

// ─── 兩次結果排成表 ───
if (flag('report')) {
  const i = argv.indexOf('--report');
  const a = argv[i + 1], b = argv[i + 2];
  const load = (l) => JSON.parse(fs.readFileSync(path.join(OUT, `${l}.json`), 'utf8'));
  const A = load(a), B = load(b);
  const rows = [];
  const fmt = (s) => (s ? `${s.greyMaxAbs.toFixed(1)} / ${s.colourDeMax.toFixed(2)} (${s.colourDeMean.toFixed(2)})` : '-');
  rows.push(`| 情境 | ${a}：灰階最大差 / ΔE 最大（平均） | ${b}：灰階最大差 / ΔE 最大（平均） | ${b} 達標 |`);
  rows.push('|---|---|---|---|');
  const keys = [...new Set([...Object.keys(A.runs), ...Object.keys(B.runs)])];
  for (const k of keys) {
    const sa = A.runs[k]?.summary, sb = B.runs[k]?.summary;
    rows.push(`| ${k} | ${fmt(sa)} | ${fmt(sb)} | ${sb ? (sb.pass ? '是' : '否') : '-'} |`);
  }
  const md = rows.join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, `compare-${a}-${b}.md`), md);
  console.log(md);
  process.exit(0);
}

// ─── 工具 ───
function loadPlaywright() {
  const tries = [opt('playwright'), process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'playwright'].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch { /* 下一個 */ }
  }
  throw new Error('找不到 playwright-core：npm i -D playwright-core，或 --playwright <playwright-core 資料夾>');
}

function findFfmpeg() {
  const cands = [opt('ffmpeg'), process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

/** 量測需要的 ts 函式（ΔE 等）直接從 src 讀：用 Vite 的 ssrLoadModule */
let acc;

// ─── 影片網站（= R2：另一個網址、CORS、Range）───
function startMediaServer(dir) {
  const types = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''));
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    const headers = {
      'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...headers, 'Access-Control-Allow-Headers': 'Range' }); res.end(); return; }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ─── 假的 NDI 小程序（協議見 ndi-helper/README.md）───
function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function startFakeHelper() {
  const state = { jpeg: null, clients: new Set() };
  const SOURCE = 'HARNESS (Adobe After Effects)';
  const status = () => JSON.stringify({
    type: 'status', version: '0.1.12', state: 'live', ndi: 'ready', error: null, lastError: null, mode: 'auto', preferred: null,
    source: SOURCE, sources: [{ name: SOURCE, local: true, afterEffects: true }], availableSources: [SOURCE],
    connected: true, receiving: true, fps: 10, clients: state.clients.size, framesPaused: false,
    autostart: { wanted: true, registered: true, error: null },
  });
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (op, buf) => { try { socket.write(wsFrame(op, buf)); } catch { /* 斷了 */ } };
    send(1, Buffer.from(JSON.stringify({ type: 'hello', version: '0.1.12', protocol: 2, platform: 'windows', port: 0, source: SOURCE })));
    send(1, Buffer.from(status()));
    state.clients.add(socket);
    const tick = setInterval(() => { if (state.jpeg) send(2, state.jpeg); }, 100);
    const st = setInterval(() => send(1, Buffer.from(status())), 1000);
    const end = () => { clearInterval(tick); clearInterval(st); state.clients.delete(socket); };
    socket.on('data', (buf) => { if ((buf[0] & 0x0f) === 8) { end(); socket.end(); } });
    socket.on('close', end);
    socket.on('error', end);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

// ─── 主程式 ───
const { chromium } = loadPlaywright();
const ffmpeg = findFfmpeg();
const mediaDir = path.join(OUT, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

const vite = await createViteServer({ root: WEB_DIR, logLevel: 'warn', server: { host: '127.0.0.1', port: 5199, strictPort: false } });
await vite.listen();
const vitePort = vite.httpServer.address().port;
acc = await vite.ssrLoadModule('/src/lib/stageLook/colorAccuracy.ts');
const media = await startMediaServer(mediaDir);
const mediaBase = `http://127.0.0.1:${media.address().port}`;
const helper = await startFakeHelper();
const ndiUrl = `ws://127.0.0.1:${helper.server.address().port}`;

const launchArgs = [
  '--autoplay-policy=no-user-gesture-required',
  '--force-color-profile=srgb',
  ...(GPU ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
];
let browser;
const channel = opt('channel', 'chrome');
try {
  browser = await chromium.launch({ channel, headless: true, args: launchArgs });
} catch (e) {
  console.warn(`開不了 ${channel}（${e.message.split('\n')[0]}），改用 playwright 的 chromium（可能不能放 H.264）`);
  browser = await chromium.launch({ headless: true, args: launchArgs });
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const consoleLines = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

const cleanup = async () => {
  try { await browser.close(); } catch { /* */ }
  try { await vite.close(); } catch { /* */ }
  media.close();
  helper.server.close();
  for (const s of helper.state.clients) s.destroy();
};

const results = { label: LABEL, gpu: GPU, browser: browser.version(), when: new Date().toISOString(), runs: {}, extras: {} };
const record = (key, patches, extra = {}) => {
  // expected 用量測頁給的（通常是色卡；測試圖 = 貼圖上的值、亮度 0.5 = 算過的）
  const fixed = patches.map(p => acc.comparePatch({ name: p.name, group: p.group, rgb: p.expected }, p.measured));
  const summary = acc.summarize(fixed);
  results.runs[key] = { summary, patches: fixed, ...extra };
  const s = summary;
  console.log(`${key.padEnd(44)} 灰階最大差 ${s.greyMaxAbs.toFixed(1).padStart(5)}  平均 ${s.greyMeanDiff.toFixed(1).padStart(5)}  ΔE 最大 ${s.colourDeMax.toFixed(2).padStart(6)}（${s.worstColour}） 平均 ${s.colourDeMean.toFixed(2)}  ${s.pass ? '達標' : ''}`);
};
const saveDataUrl = (name, dataUrl) => fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));

try {
  await page.goto(`http://127.0.0.1:${vitePort}/led-color-harness.html`);
  await page.waitForFunction(() => window.__ledHarness?.ready || window.__ledHarness?.error, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__ledHarness.error);
  if (err) throw new Error(err);

  // 色卡 PNG + 影片
  const pngB64 = await page.evaluate(() => window.__ledHarness.chartPngBase64());
  fs.writeFileSync(path.join(mediaDir, 'chart.png'), Buffer.from(pngB64, 'base64'));
  const videos = {};
  if (ffmpeg) {
    const enc = (name, args) => {
      const out = path.join(mediaDir, name);
      const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', path.join(mediaDir, 'chart.png'), '-t', '2', ...args, out], { encoding: 'utf8' });
      if (r.status !== 0) { console.warn(`ffmpeg ${name} 失敗：${r.stderr}`); return; }
      videos[name] = `${mediaBase}/${name}`;
    };
    const x264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '2', '-profile:v', 'high', '-movflags', '+faststart'];
    const tag = (range, prim = 'bt709') => `setparams=range=${range}:color_primaries=${prim}:color_trc=${prim}:colorspace=${prim}`;
    const yuv = (range) => `scale=out_color_matrix=bt709:out_range=${range},format=yuv420p`;
    enc('h264-bt709-tv.mp4', ['-vf', `${yuv('tv')},${tag('tv')}`, ...x264]);
    enc('h264-untagged.mp4', ['-vf', `${yuv('tv')},${tag('unknown', 'unknown')}`, ...x264]);
    enc('h264-bt709-pc.mp4', ['-vf', `${yuv('pc')},${tag('pc')}`, ...x264]);
    enc('vp9-bt709-tv.webm', ['-vf', `${yuv('tv')},${tag('tv')}`, '-c:v', 'libvpx-vp9', '-crf', '4', '-b:v', '0']);
  } else {
    console.warn('沒有 ffmpeg → 不量影片');
  }

  // 小程序的 JPEG（現在預設：limited→full 開著；另一種：關掉）
  const jpegLut = Buffer.from(await page.evaluate(() => window.__ledHarness.helperJpegBase64(true)), 'base64');
  const jpegNoLut = Buffer.from(await page.evaluate(() => window.__ledHarness.helperJpegBase64(false)), 'base64');
  fs.writeFileSync(path.join(mediaDir, 'helper-limited-to-full.jpg'), jpegLut);
  fs.writeFileSync(path.join(mediaDir, 'helper-passthrough.jpg'), jpegNoLut);

  const set = (s) => page.evaluate((sc) => window.__ledHarness.setScenario(sc), s);
  const measure = () => page.evaluate(() => window.__ledHarness.measureStable());
  const shot = async (name) => saveDataUrl(`${LABEL}-${name}.png`, await page.evaluate(() => window.__ledHarness.sideBySide()));
  const screenshot = async (name) => page.screenshot({ path: path.join(OUT, `${LABEL}-${name}.png`), clip: { x: 0, y: 0, width: 1280, height: 800 } });

  const mainVideo = videos['h264-bt709-tv.mp4'];
  const modes = ['live', 'quick'];
  for (const mode of modes) {
    const sources = [
      ['image', { source: 'image' }],
      ...(mainVideo ? [['localVideo', { source: 'localVideo', mediaUrl: mainVideo }], ['urlVideo', { source: 'urlVideo', mediaUrl: mainVideo }]] : []),
      ['ndi（小程序 limited→full 開，現在預設）', { source: 'ndi', ndiUrl, jpeg: 'lut' }],
      ['ndi（小程序 limited→full 關）', { source: 'ndi', ndiUrl, jpeg: 'nolut' }],
      ...(QUICK ? [] : [['testPattern', { source: 'testPattern' }]]),
    ];
    for (const [name, s] of sources) {
      if (s.jpeg) helper.state.jpeg = s.jpeg === 'lut' ? jpegLut : jpegNoLut;
      const { jpeg, ...scenario } = s;
      const info = await set({ mode, view: 'head', ...scenario });
      const patches = s.source === 'testPattern'
        ? await page.evaluate(() => window.__ledHarness.measureFlat())
        : await measure();
      const led = await page.evaluate(() => window.__ledHarness.ledInfo());
      record(`${mode} / ${name}`, patches, { info, led });
      if (!jpeg || jpeg === 'lut') await shot(`${mode}-${s.source}`);
    }

    if (!QUICK && mainVideo) {
      // 其他影片格式（同一張色卡）
      for (const [file, label] of [['h264-untagged.mp4', 'H.264 沒標色彩空間'], ['h264-bt709-pc.mp4', 'H.264 full range'], ['vp9-bt709-tv.webm', 'VP9']]) {
        if (!videos[file]) continue;
        await set({ mode, view: 'head', source: 'localVideo', mediaUrl: videos[file] });
        record(`${mode} / localVideo（${label}）`, await measure());
      }
    }
  }

  if (!QUICK) {
    // 現場模式的其他情況
    await set({ mode: 'live', view: 'head', source: 'image', stress: true });
    record('live / image + 對面白色 LED（LED 表面反光）', await measure());
    await shot('live-stress');

    // 每塊 LED 的亮度 0.5：期望 = 原檔的光 × 0.5
    await set({ mode: 'live', view: 'head', source: 'image', stress: false, brightness: 0.5 });
    const half = (await measure()).map(p => ({
      ...p, expected: p.expected.map(v => Math.round(acc.linearToSrgb(acc.srgbToLinear(v / 255) * 0.5) * 255)),
    }));
    record('live / image，LED 亮度 0.5（期望 = 原檔光量 × 0.5）', half);

    // 調了現場設定（曝光 1.6、底光 0.6）：LED 畫面還是原檔
    await set({ mode: 'live', view: 'head', source: 'image', brightness: 1, look: { exposure: 1.6, houseLight: 0.6 } });
    record('live / image，曝光 1.6 + 底光 0.6', await measure());
    // 光暈開到 1：亮的格子會暈到旁邊（看暈開後中間還準不準，只是參考）
    await set({ mode: 'live', view: 'head', source: 'image', look: { bloomStrength: 1 } });
    record('live / image，光暈 1（參考）', await measure());
    await shot('live-bloom1');

    // 近看（像素格看得到）：中間 ±5 顆 LED 的光的平均
    await set({ mode: 'live', view: 'head', source: 'image', look: {} });
    const close = await page.evaluate(() => window.__ledHarness.measureClose(['灰 64', '灰 128', '灰 192', '灰 240', '灰 255', '紅', '75% 白', '淺膚色', '天空藍']));
    record('live / image 近看（像素格，光的平均）', close, { close });
    await screenshot('live-closeup');

    // 一般舞台視角（截圖：舞台其他地方、地板倒影）
    await set({ mode: 'live', view: 'stage', source: 'image', look: {} });
    await page.waitForTimeout(2500);
    await screenshot('live-stage');
    if (mainVideo) {
      await set({ mode: 'live', view: 'stage', source: 'localVideo', mediaUrl: mainVideo });
      await page.waitForTimeout(1500);
      await screenshot('live-stage-video');
    }
    await set({ mode: 'quick', view: 'stage', source: 'image' });
    await page.waitForTimeout(1500);
    await screenshot('quick-stage');
  }

  // 小播放器（同一個 <video> 直接顯示）vs LED：同一格畫面
  if (mainVideo) {
    for (const [file, label] of [['h264-bt709-tv.mp4', 'H.264 BT.709'], ...(QUICK ? [] : [['h264-untagged.mp4', 'H.264 沒標'], ['h264-bt709-pc.mp4', 'H.264 full range'], ['vp9-bt709-tv.webm', 'VP9']])]) {
      if (!videos[file]) continue;
      await set({ mode: 'live', view: 'head', source: 'localVideo', mediaUrl: videos[file] });
      const led = await measure();
      const box = await page.evaluate(() => window.__ledHarness.showVideo(true));
      const buf = await page.screenshot({ clip: { x: 0, y: 0, width: box.width, height: box.height } });
      const mini = await page.evaluate(([d, w, h]) => window.__ledHarness.samplePng(d, 0, 0, w, h), [`data:image/png;base64,${buf.toString('base64')}`, box.width, box.height]);
      const v2d = await page.evaluate(() => window.__ledHarness.sampleVideo2d());
      await page.evaluate(() => window.__ledHarness.showVideo(false));
      record(`小播放器畫面 vs 原檔（${label}）`, mini);
      record(`video 畫進 canvas vs 原檔（${label}）`, v2d);
      // LED 跟小播放器比（期望 = 小播放器顯示的值）
      record(`LED vs 小播放器（${label}，現場）`, led.map((p, i) => ({ ...p, expected: mini[i].measured.map(v => Math.round(v)) })));
      if (file === 'h264-bt709-tv.mp4') fs.writeFileSync(path.join(OUT, `${LABEL}-miniplayer.png`), buf);
    }
  }

  results.console = consoleLines.slice(0, 200);
  fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(results, null, 2));
  const md = ['| 情境 | 灰階最大差（8 位元階） | 灰階平均偏差 | ΔE2000 最大 | ΔE2000 平均 | 最差的格子 | 達標 |', '|---|---|---|---|---|---|---|'];
  for (const [k, r] of Object.entries(results.runs)) {
    const s = r.summary;
    md.push(`| ${k} | ${s.greyMaxAbs.toFixed(1)} | ${s.greyMeanDiff.toFixed(1)} | ${s.colourDeMax.toFixed(2)} | ${s.colourDeMean.toFixed(2)} | ${s.worstColour ?? '-'} | ${s.pass ? '是' : '否'} |`);
  }
  fs.writeFileSync(path.join(OUT, `${LABEL}.md`), md.join('\n') + '\n');
  console.log(`\n結果：${path.join(OUT, `${LABEL}.json`)}`);
} catch (e) {
  console.error('量測失敗：', e);
  console.error(consoleLines.slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
}
