// 錄教學短片的共用小工具：網址、路徑、打本機後台、跑 wrangler / ffmpeg。
//
// 安全：這整套東西只准連本機（127.0.0.1 / localhost）。正式站、測試站的網址一律拒絕。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLIPS_DIR = HERE;
export const WEB_DIR = resolve(HERE, '..', '..');
export const REPO_DIR = resolve(WEB_DIR, '..');
export const CF_DIR = join(REPO_DIR, 'cf-worker');
export const WORK_DIR = join(HERE, '.work');           // 不進 git：假帳號登入碼、登入狀態、生成的影片 / 音樂、錄影暫存
export const OUT_DIR = join(WEB_DIR, 'public', 'help', 'tutorial');
export const ASSETS_DIR = join(HERE, 'assets');

export const API_BASE = process.env.CLIP_API_BASE || 'http://127.0.0.1:8799';
export const WEB_BASE = process.env.CLIP_WEB_BASE || 'http://127.0.0.1:5199';

/** 不是本機的網址一律不碰 */
export function assertLocal(u) {
  const host = new URL(u).hostname;
  if (!(host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host.endsWith('.localhost'))) {
    throw new Error(`只能連本機，不能連 ${host}`);
  }
}
assertLocal(API_BASE);
assertLocal(WEB_BASE);

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }
export function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeJson(p, v) { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(v, null, 2)); }
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function log(...a) { console.log(...a); }

// ─── 假帳號 ───
export const ACCOUNTS_FILE = join(WORK_DIR, 'accounts.json');
export const DEMO = {
  project: '示範演唱會',
  users: {
    producer: { id: 'u_demo_producer', name: '示範製作', role: 'admin' },
    animator: { id: 'u_demo_animator', name: '示範動畫師', role: 'animator' },
    director: { id: 'u_demo_director', name: '示範導演', role: 'director' },
  },
};

export function loadAccounts() {
  const a = readJson(ACCOUNTS_FILE);
  if (!a) throw new Error('找不到假帳號資料，請先跑：node seed.mjs');
  return a;
}

// ─── 打本機後台 ───
export async function api(token, method, path, body, { raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined && body !== null && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    h['Content-Type'] = h['Content-Type'] || 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(API_BASE + path, { method, headers: h, body: payload });
  if (raw) return r;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  if (!r.ok) {
    const e = new Error(`${method} ${path} → ${r.status} ${data?.error || text.slice(0, 200)}`);
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}

/** 走網站本來的登入（POST /api/auth/login），拿到這個帳號的登入字串 */
export async function loginWithCode(code) {
  const d = await api(null, 'POST', '/api/auth/login', { accessCode: code });
  return d.token;
}

// ─── wrangler（只用本機 D1） ───
const WRANGLER_JS = join(CF_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
export function d1Exec(sql) {
  ensureDir(WORK_DIR);
  const f = join(WORK_DIR, 'tmp.sql');
  writeFileSync(f, sql);
  const out = execFileSync(process.execPath, [WRANGLER_JS, 'd1', 'execute', 'stage-previz-db', '--local', '--file', f, '--json'],
    { cwd: CF_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(out); } catch { return out; }
}
export function d1Query(sql) {
  const r = d1Exec(sql);
  const last = Array.isArray(r) ? r[r.length - 1] : null;
  return last?.results || [];
}

// ─── ffmpeg ───
const FFMPEG_DIR_GUESS = 'C:/Users/phang/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin';
let ffDir = null;
export function ffmpegPath(tool = 'ffmpeg') {
  if (!ffDir) {
    const cands = [process.env.FFMPEG_DIR, FFMPEG_DIR_GUESS].filter(Boolean);
    ffDir = cands.find(d => existsSync(join(d, 'ffmpeg.exe')) || existsSync(join(d, 'ffmpeg'))) || '';
    if (!ffDir) {
      const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
      if (r.status === 0) ffDir = '';
      else throw new Error('找不到 ffmpeg，請設環境變數 FFMPEG_DIR 指到 ffmpeg 的 bin 資料夾');
    }
  }
  if (!ffDir) return tool;
  return join(ffDir, process.platform === 'win32' ? `${tool}.exe` : tool);
}
export function ff(args, opts = {}) {
  const r = spawnSync(ffmpegPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`ffmpeg 失敗：${(r.stderr || '').slice(0, 800)}`);
  return r;
}
export function probe(file) {
  const r = spawnSync(ffmpegPath('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,codec_name,pix_fmt:format=duration,size', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe 失敗：${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const s = j.streams?.[0] || {};
  return { width: s.width, height: s.height, codec: s.codec_name, pixFmt: s.pix_fmt, rate: s.r_frame_rate, duration: Number(j.format?.duration), size: Number(j.format?.size) };
}
