// 用 ffmpeg 生示範用的 LED 動畫和音樂（全部原創、程式生成，不用任何現成的影片或歌）。
//   LED 動畫：大小跟專案的 LED 畫布一樣，每片 LED 在畫布上的位置各畫一塊彩色漸層 + 白色外框，
//            LED 貼對位置的話，每片的畫面就是自己那塊，看得出對位對不對。
//   音樂：簡單的和弦，只是讓「沒有影片的歌」有一首音樂可以聽、cue 有時間可以對。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_DIR, ensureDir, ff } from './lib.mjs';

export const MEDIA_DIR = join(WORK_DIR, 'media');

/** 四組顏色，換成別的就會是不同版本 / 不同歌的感覺 */
export const PALETTES = {
  warm: ['0xff4d1a', '0xffb300', '0xff2d6f', '0xffe066'],     // 熱色
  cool: ['0x00c2ff', '0x2f5bff', '0x00e5c0', '0x8a4bff'],     // 冷色
  green: ['0x2aff7a', '0x00b3a4', '0xc6ff00', '0x0a74ff'],
  magenta: ['0xff2ec4', '0x8c2eff', '0xff8a2e', '0x2ec9ff'],
  rainbow: ['0xff0044', '0xffaa00', '0x22dd55', '0x2288ff'],
};

const TYPES = ['linear', 'radial', 'circular', 'spiral'];

/**
 * @param {{ out: string, canvas: {width:number,height:number}, rects: {x:number,y:number,w:number,h:number}[], palette: keyof PALETTES, seconds?: number, seed?: number }} o
 */
export function makeLedAnimation({ out, canvas, rects, palette, seconds = 16, seed = 1 }) {
  ensureDir(MEDIA_DIR);
  const cols = PALETTES[palette];
  if (!cols) throw new Error(`沒有這組顏色：${palette}`);
  const inputs = ['-f', 'lavfi', '-i', `color=c=black:s=${canvas.width}x${canvas.height}:r=30:d=${seconds}`];
  const parts = [];
  let last = '0:v';
  rects.forEach((r, i) => {
    const c = [0, 1, 2, 3].map(k => cols[(k + i) % 4]);
    const type = TYPES[(i + seed) % TYPES.length];
    inputs.push('-f', 'lavfi', '-i',
      `gradients=s=${r.w}x${r.h}:r=30:d=${seconds}:c0=${c[0]}:c1=${c[1]}:c2=${c[2]}:c3=${c[3]}:nb_colors=4:speed=${(0.012 + (i % 5) * 0.004).toFixed(3)}:seed=${seed * 100 + i}:type=${type}`);
    const t = Math.max(2, Math.min(4, Math.round(Math.min(r.w, r.h) / 40)));
    parts.push(`[${i + 1}:v]eq=brightness='0.06*sin(2*PI*t/2+${i})',drawbox=x=0:y=0:w=iw:h=ih:color=white@0.9:t=${t}[g${i}]`);
    parts.push(`[${last}][g${i}]overlay=x=${r.x}:y=${r.y}:shortest=0[o${i}]`);
    last = `o${i}`;
  });
  ff([
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', `[${last}]`,
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '30', '-keyint_min', '30',
    '-movflags', '+faststart', '-an', out,
  ]);
  return out;
}

/** 一首簡單的和弦音樂（mp3），給「沒有影片的歌」用 */
export function makeMusic({ out, seconds = 40 }) {
  ensureDir(MEDIA_DIR);
  if (existsSync(out)) { /* 重生一次，結果一樣 */ }
  const tone = (f, vol) => ['-f', 'lavfi', '-i', `sine=f=${f}:d=${seconds}:r=44100,volume=${vol},tremolo=f=2:d=0.6`];
  ff([
    ...tone(220, 0.35), ...tone(277.18, 0.25), ...tone(329.63, 0.25), ...tone(110, 0.3),
    '-filter_complex', '[0:a][1:a][2:a][3:a]amix=inputs=4:normalize=0,afade=t=in:d=0.5,afade=t=out:st=' + (seconds - 1.5) + ':d=1.5[a]',
    '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '96k', out,
  ]);
  return out;
}
