// 把錄好的畫格（raw/<id>/）轉成教學頁用的 mp4 + 封面 jpg，另外做一張「6 格縮圖」給人檢查。
//
//   node encode.mjs                 全部
//   node encode.mjs overview        只轉這一段
//   --grid-dir <資料夾>             6 格縮圖放哪裡（預設：系統暫存資料夾 / stage-previz-clips；不放進 repo）
//
// 輸出（進 repo）：web/public/help/tutorial/<id>.mp4（H.264、yuv420p、faststart、沒有聲音）和 <id>.jpg（封面）
// 每段的裁切放大、封面時間點寫在 clips.mjs 的 CLIPS 表裡（crop 用 CSS 像素；沒寫 h 就是 16:9）。
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_DIR, WORK_DIR, ensureDir, ff, log, probe } from './lib.mjs';
import { RAW_DIR } from './recorder.mjs';

export const OUT_W = 1280;
export const OUT_H = 720;
export const MAX_MP4_BYTES = 2 * 1024 * 1024;        // 每支不超過 2 MB
export const MAX_JPG_BYTES = 150 * 1024;             // 封面不超過 150 KB

function gridDirFromArgs() {
  const i = process.argv.indexOf('--grid-dir');
  return i >= 0 ? process.argv[i + 1] : join(tmpdir(), 'stage-previz-clips');
}

/**
 * @param {string} id
 * @param {{ crop?: {x:number,y:number,w:number,h?:number}, trimStart?: number, trimEnd?: number, posterAt?: number, gridDir?: string, outDir?: string }} opt
 *   crop：要放大的區域（CSS 像素，左上角 x,y 和寬 w）。沒寫 h：高 = w × 9/16，放大成 1280×720。
 *         寫了 h（不是 16:9，例：只留 3D 畫面、把上面的工具列切掉）：不放大，照 w×h（CSS 像素）輸出。
 *   trimStart / trimEnd：頭尾各剪掉幾秒；posterAt：封面取第幾秒（剪完以後算）
 */
export function encodeClip(id, opt = {}) {
  const dir = join(RAW_DIR, id);
  if (!existsSync(join(dir, 'frames.json'))) throw new Error(`${id}：還沒錄（找不到 ${dir}）`);
  const meta = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
  const { frames, endTs, scale } = meta;
  if (frames.length === 0) throw new Error(`${id}：沒有收到任何畫格`);
  const outDir = ensureDir(opt.outDir ?? OUT_DIR);
  const mp4 = join(outDir, `${id}.mp4`);
  const jpg = join(outDir, `${id}.jpg`);
  const work = ensureDir(join(WORK_DIR, 'encode'));

  // 畫格清單：每一格停多久 = 到下一格的時間（最後一格停到錄影結束）
  let list = '';
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].ts : endTs;
    const d = Math.max(0.001, next - frames[i].ts);
    list += `file '${join(dir, frames[i].file).replace(/\\/g, '/')}'\nduration ${d.toFixed(6)}\n`;
  }
  list += `file '${join(dir, frames[frames.length - 1].file).replace(/\\/g, '/')}'\n`;
  const listFile = join(work, `${id}.txt`);
  writeFileSync(listFile, list);

  const total = endTs - frames[0].ts;
  const t0 = opt.trimStart ?? 0;
  const dur = total - t0 - (opt.trimEnd ?? 0);
  const c = opt.crop;
  const filters = ['fps=30'];
  if (c) {
    const ch = c.h ?? (c.w * 9) / 16;
    if (c.x < 0 || c.y < 0 || c.x + c.w > meta.viewport.width || c.y + ch > meta.viewport.height) {
      throw new Error(`${id}：裁切範圍超出畫面（x ${c.x}、y ${c.y}、寬 ${c.w}、高 ${ch.toFixed(0)}；畫面 ${meta.viewport.width}×${meta.viewport.height}）`);
    }
    const w = Math.round(c.w * scale), h = Math.round(ch * scale);
    filters.push(`crop=${w}:${h}:${Math.round(c.x * scale)}:${Math.round(c.y * scale)}`);
  }
  // 畫格是 JPEG（全範圍、BT.601）→ 轉成一般影片用的 yuv420p（有限範圍、BT.709）並標好，播放器顏色才對
  const even = (n) => Math.round(n / 2) * 2;
  const [outW, outH] = c?.h ? [even(c.w), even(c.h)] : [OUT_W, OUT_H];
  filters.push(`scale=${outW}:${outH}:flags=lanczos+accurate_rnd:in_range=full:out_range=limited:in_color_matrix=bt601:out_color_matrix=bt709`, 'setsar=1', 'format=yuv420p');  // setsar=1：裁切不是剛好 16:9 時，像素還是正方形（不然瀏覽器會顯示成 1282 寬）
  const vf = filters.join(',');

  let crf = 23;
  for (;;) {
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-ss', String(t0), '-t', dur.toFixed(3), '-vf', vf,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', '-an', mp4]);
    if (statSync(mp4).size <= MAX_MP4_BYTES || crf >= 34) break;
    crf += 2;
  }

  // 封面：看得懂在做什麼的那一格
  const at = Math.min(Math.max(0, opt.posterAt ?? (dur / 2)), Math.max(0, dur - 0.1));
  for (let q = 3; q <= 14; q++) {
    ff(['-ss', at.toFixed(3), '-i', mp4, '-frames:v', '1', '-q:v', String(q), '-update', '1', jpg]);
    if (statSync(jpg).size <= MAX_JPG_BYTES) break;
  }

  // 6 格縮圖（給人檢查；不進 repo）
  const gridDir = ensureDir(opt.gridDir ?? gridDirFromArgs());
  const grid = join(gridDir, `${id}-grid.jpg`);
  const p = probe(mp4);
  const fr = [];
  for (let i = 0; i < 6; i++) fr.push(((i + 0.5) / 6) * p.duration);
  const sel = fr.map(t => `eq(n\\,${Math.round(t * 30)})`).join('+');
  ff(['-i', mp4, '-vf', `select='${sel}',scale=640:360,tile=3x2:padding=4:color=white`, '-frames:v', '1', '-fps_mode', 'vfr', '-q:v', '3', '-update', '1', grid]);

  const info = { id, seconds: p.duration, bytes: statSync(mp4).size, width: p.width, height: p.height, jpgBytes: statSync(jpg).size, crf, grid };
  log(`  ${id}: ${p.width}×${p.height}  ${p.duration.toFixed(1)} 秒  ${(info.bytes / 1024).toFixed(0)} KB  封面 ${(info.jpgBytes / 1024).toFixed(0)} KB`);
  return info;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { CLIPS } = await import('./clips.mjs');
  const ids = process.argv.slice(2).filter(a => !a.startsWith('--') && process.argv[process.argv.indexOf('--grid-dir') + 1] !== a);
  const todo = ids.length ? ids : Object.keys(CLIPS);
  const results = [];
  for (const id of todo) {
    const c = CLIPS[id];
    if (!c) { log(`沒有這一段：${id}`); continue; }
    if (!existsSync(join(RAW_DIR, id, 'frames.json'))) { log(`  ${id}: 還沒錄，跳過`); continue; }
    results.push(encodeClip(id, c.encode || {}));
  }
  const bytes = results.reduce((s, r) => s + r.bytes, 0);
  log(`共 ${results.length} 支，mp4 合計 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}
