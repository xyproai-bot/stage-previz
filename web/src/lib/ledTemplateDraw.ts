// LED 畫布版型的測試圖（貼在 3D 的 LED 上）和模板圖（下載給動畫師的 PNG）：用 canvas 畫。
// 排版的數字在 lib/ledTemplatePattern.ts（純函式，有單元測試），這裡只負責畫。

import { exportScales, type CanvasSize, type LedLayout } from './ledMap';
import { drawTestPattern } from './ledMapDraw';
import type { LedTemplatePlan, ScreenDef, SrcSpan } from './ledTemplate';
import { contentPieces } from './ledTemplateContent';
import { guideLayout, layoutPattern, type Matrix6, type PatternItem } from './ledTemplatePattern';

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", Consolas, "SF Mono", Menlo, monospace';

/** 朝上的粗箭頭，中心在原點、長 len */
function arrowUpPath(ctx: CanvasRenderingContext2D, len: number) {
  const hw = len * 0.3, headLen = len * 0.44, sw = len * 0.1;
  ctx.beginPath();
  ctx.moveTo(0, -len / 2);
  ctx.lineTo(hw, -len / 2 + headLen);
  ctx.lineTo(sw, -len / 2 + headLen);
  ctx.lineTo(sw, len / 2);
  ctx.lineTo(-sw, len / 2);
  ctx.lineTo(-sw, -len / 2 + headLen);
  ctx.lineTo(-hw, -len / 2 + headLen);
  ctx.closePath();
}

/** 畫一支箭頭，指向 (dx, dy)；中心 (cx, cy)、長 len */
function drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, len: number, dx: number, dy: number, fill: string, edge: string, edgeW: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(dx, -dy));
  arrowUpPath(ctx, len);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = edgeW;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.restore();
}

/** 字太寬就縮小到塞得進 maxW；回傳最後用的字級 */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, fs: number, maxW: number, minFs: number): number {
  let size = fs;
  ctx.font = `${weight} ${size}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW && w > 0) {
    size = Math.max(minFs, (size * maxW) / w);
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return size;
}

// ───────────────────────── 測試圖（貼在 3D 的 LED 上）─────────────────────────

/**
 * 版型的測試圖：畫在跟版型畫布一樣比例的 canvas 上（scale = canvas 像素 / 版型像素）。
 * 每塊螢幕畫在「自己的方向」裡 —— 版型裡轉過、翻過的螢幕，這裡會是橫的 / 鏡像的，貼回 3D 的 LED 上才會是正的。
 * 每塊：自己的顏色、名字、真實點數、一支指著螢幕上方的箭頭、像素格；左上角有個三角形（鏡像了看得出來）。
 */
export function drawTemplatePattern(ctx: CanvasRenderingContext2D, canvas: CanvasSize, items: readonly PatternItem[], scale: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#04050a';
  ctx.fillRect(0, 0, Math.ceil(canvas.width * scale), Math.ceil(canvas.height * scale));
  for (const it of items) {
    const [a, b, c, d, e, f] = it.matrix;
    ctx.save();
    ctx.setTransform(a * scale, b * scale, c * scale, d * scale, e * scale, f * scale);
    const lw = it.native.w, lh = it.native.h;
    const m = Math.min(lw, lh);
    // 本地座標 1 個單位 = 輸出圖上幾個像素（線寬至少 1.4 個輸出像素，不然縮小以後就看不到）
    const px = Math.max(1e-6, Math.min(Math.hypot(a * scale, b * scale), Math.hypot(c * scale, d * scale)));
    const line = (outPx: number) => Math.max(outPx / px, 0.5);
    ctx.beginPath();
    ctx.rect(0, 0, lw, lh);
    ctx.clip();

    ctx.fillStyle = `hsl(${it.hue.toFixed(1)}, 55%, 27%)`;
    ctx.fillRect(0, 0, lw, lh);

    // 像素格：真實點數（每 step 個 LED 一條線，每 5 條粗一點）
    const step = lw >= 1600 ? 100 : lw >= 400 ? 50 : 10;
    const gridPath = (every: number, skip: number) => {
      ctx.beginPath();
      for (let gx = every; gx < lw; gx += every) { if (skip && gx % skip === 0) continue; ctx.moveTo(gx, 0); ctx.lineTo(gx, lh); }
      for (let gy = every; gy < lh; gy += every) { if (skip && gy % skip === 0) continue; ctx.moveTo(0, gy); ctx.lineTo(lw, gy); }
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = line(1.4);
    gridPath(step, step * 5);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = line(2.2);
    gridPath(step * 5, 0);

    // 邊框
    const bw = Math.max(m * 0.014, line(3));
    ctx.strokeStyle = `hsl(${it.hue.toFixed(1)}, 75%, 62%)`;
    ctx.lineWidth = bw;
    ctx.strokeRect(bw / 2, bw / 2, lw - bw, lh - bw);

    // 箭頭（本地座標裡永遠朝上）+ 文字
    const g = guideLayout({ x: 0, y: 0, w: lw, h: lh });
    drawArrow(ctx, g.arrow.cx, g.arrow.cy, g.arrow.len, 0, -1, '#ffffff', 'rgba(0,0,0,0.75)', Math.max(g.arrow.len * 0.03, line(1.5)));
    const t = g.text;
    const lines = [it.name, `實際 ${it.nativeText}`, `版型 ${it.destText}`];
    const blockH = (fs: number) => fs * 1.25 + fs * 0.5 * 1.35 * 2;
    let fs = Math.min(t.h * 0.34, t.w * 0.2, m * 0.2);
    fs = fitFont(ctx, lines[0], '700', FONT, fs, t.w * 0.9, 3);
    if (blockH(fs) > t.h * 0.94) fs *= (t.h * 0.94) / blockH(fs);
    const sub = Math.max(2, fs * 0.5);
    const tcx = t.x + t.w / 2;
    let ty = t.y + (t.h - blockH(fs)) / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // 字後面墊半透明黑，格線上也看得清楚
    ctx.font = `700 ${fs}px ${FONT}`;
    const plate = Math.min(t.w * 0.96, Math.max(ctx.measureText(lines[0]).width, sub * 9) + fs);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(tcx - plate / 2, ty - fs * 0.12, plate, blockH(fs) + fs * 0.2);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${fs}px ${FONT}`;
    ctx.fillText(lines[0], tcx, ty, t.w * 0.94);
    ty += fs * 1.25;
    ctx.font = `${sub}px ${MONO}`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(lines[1], tcx, ty, t.w * 0.94);
    ty += sub * 1.35;
    ctx.fillText(lines[2], tcx, ty, t.w * 0.94);

    // 左上角三角形（看得出有沒有翻過來）
    const tri = Math.max(Math.min(m * 0.12, lw * 0.1), line(8));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(bw, bw); ctx.lineTo(bw + tri, bw); ctx.lineTo(bw, bw + tri);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** 畫一張測試圖到指定大小的 canvas */
export function paintTemplatePattern(canvasEl: HTMLCanvasElement, plan: Pick<LedTemplatePlan, 'canvas' | 'screens'>, defs: readonly ScreenDef[], scale: number) {
  const ctx = canvasEl.getContext('2d');
  if (!ctx) throw new Error('這個瀏覽器沒有 2D 畫布');
  drawTemplatePattern(ctx, plan.canvas, layoutPattern(plan, defs), scale);
}

// ───────────────────────── 模板圖（給 AE 的參考圖層）─────────────────────────

/**
 * 模板圖：深色底，每塊螢幕一個長方形 + 名字 + 版型裡的像素大小 + 一支指著「這塊螢幕的上方」的箭頭；字是正的。
 * scale = 輸出像素 / 版型像素。
 */
export function drawTemplateGuide(ctx: CanvasRenderingContext2D, plan: Pick<LedTemplatePlan, 'name' | 'canvas' | 'scalePct'>, items: readonly PatternItem[], scale: number, content: GuideContent | null = null) {
  const W = plan.canvas.width, H = plan.canvas.height;
  const u = Math.min(4, Math.max(0.5, Math.max(W, H) / 3840));
  const hair = (n: number) => Math.max(n, 1 / scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#0c0d10';
  ctx.fillRect(0, 0, W, H);

  // 格線：每 100 像素一條（太密就不畫），每 500 粗一點
  if (scale * 100 >= 5) {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = hair(1);
    ctx.beginPath();
    for (let x = 100; x < W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 100; y < H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = hair(1.5);
  ctx.beginPath();
  for (let x = 500; x < W; x += 500) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 500; y < H; y += 500) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  for (const it of items) {
    const { x, y, w, h } = it.dest;
    const span = content?.spanOf(it.key) ?? null;
    if (content && span) {
      drawScreenTile(ctx, it, span, content.layout, [scale, 0, 0, scale, 0, 0], scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      continue;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = `hsla(${it.hue.toFixed(1)}, 55%, 32%, 0.5)`;
    ctx.fillRect(x, y, w, h);
    const bw = Math.max(hair(2), Math.min(w, h) * 0.012, 2 * u);
    ctx.strokeStyle = it.color;
    ctx.lineWidth = bw;
    ctx.strokeRect(x + bw / 2, y + bw / 2, w - bw, h - bw);

    const g = guideLayout(it.dest);
    drawArrow(ctx, g.arrow.cx, g.arrow.cy, g.arrow.len, it.up.dx, it.up.dy, '#ffffff', 'rgba(0,0,0,0.75)', Math.max(g.arrow.len * 0.03, hair(1.5)));

    const t = g.text;
    const lines: { text: string; weight: string; family: string; k: number; color: string }[] = [
      { text: it.name, weight: '700', family: FONT, k: 1, color: '#ffffff' },
      { text: `${it.destText} 像素`, weight: '600', family: MONO, k: 0.62, color: '#ffffff' },
      { text: `位置 ${it.dest.x}, ${it.dest.y} · 上方${it.upText}${it.mirrored ? ' · 鏡像' : ''}`, weight: '400', family: MONO, k: 0.36, color: 'rgba(255,255,255,0.78)' },
      { text: `實際 ${it.nativeText}`, weight: '400', family: MONO, k: 0.36, color: 'rgba(255,255,255,0.62)' },
    ];
    const heightOf = (fs: number) => lines.reduce((s, l) => s + fs * l.k * 1.3, 0);
    let fs = Math.min(t.h * 0.3, t.w * 0.2, 120 * u);
    fs = fitFont(ctx, lines[0].text, '700', FONT, fs, t.w * 0.9, 3);
    // 最長的那行也要塞得進寬度
    for (const l of lines.slice(1)) {
      ctx.font = `${l.weight} ${fs * l.k}px ${l.family}`;
      const lwid = ctx.measureText(l.text).width;
      if (lwid > t.w * 0.92) fs *= (t.w * 0.92) / lwid;
    }
    if (heightOf(fs) > t.h * 0.94) fs *= (t.h * 0.94) / heightOf(fs);
    let ty = t.y + (t.h - heightOf(fs)) / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const l of lines) {
      ctx.font = `${l.weight} ${Math.max(1, fs * l.k)}px ${l.family}`;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, t.x + t.w / 2, ty, t.w * 0.94);
      ty += fs * l.k * 1.3;
    }
    ctx.restore();
  }

  // 畫布外框
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = hair(2);
  ctx.strokeRect(0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** 模板圖裡每塊螢幕畫「網站上那張測試圖」要的東西：整張畫布的測試圖排法 + 每塊螢幕取整張畫布的哪一段 */
export interface GuideContent { layout: LedLayout; spanOf: (key: string) => SrcSpan | null }

function composeMatrix(b: Matrix6, m: Matrix6): Matrix6 {
  return [
    b[0] * m[0] + b[2] * m[1], b[1] * m[0] + b[3] * m[1],
    b[0] * m[2] + b[2] * m[3], b[1] * m[2] + b[3] * m[3],
    b[0] * m[4] + b[2] * m[5] + b[4], b[1] * m[4] + b[3] * m[5] + b[5],
  ];
}

/**
 * 畫一塊螢幕：網站上這塊 LED 顯示的測試圖（外框顏色、格線、圓和十字、color bar、灰階、名稱、x/y/w/h、角落座標），
 * 照這塊在版型裡的轉動、翻轉擺進 dest。
 * base = 版型畫布像素 → 輸出像素的矩陣（整張模板圖 = 單純縮放；單塊的圖 = 再平移到這塊的左上角）；px = 輸出像素 / 版型像素
 */
export function drawScreenTile(ctx: CanvasRenderingContext2D, it: PatternItem, span: SrcSpan, layout: LedLayout, base: Matrix6, px: number) {
  const { x, y, w, h } = it.dest;
  ctx.save();
  ctx.setTransform(...base);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  for (const piece of contentPieces(span, layout.canvas, it)) {
    const m = composeMatrix(base, piece.matrix);
    ctx.save();
    ctx.setTransform(...m);
    ctx.beginPath();
    ctx.rect(piece.src.x, piece.src.y, piece.src.w, piece.src.h);
    ctx.clip();
    const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    drawTestPattern(ctx, layout, k > 0 ? k : px, { matrix: m });
    ctx.restore();
  }
  // 不疊「上方」箭頭：下載的圖要跟網站上的測試圖一樣（用戶 10-22）
  ctx.restore();
}

export interface TemplateGuidePng { blob: Blob; scale: number; width: number; height: number }

/**
 * 畫成 PNG（版型畫布的原尺寸；瀏覽器畫不了就縮小，scale 會 < 1；最小的也畫不了就丟錯）。
 * 用一般的 canvas（有 OffscreenCanvas 的瀏覽器也一樣能畫，這裡不需要在背景執行緒）。
 */
export async function renderTemplateGuidePng(
  plan: Pick<LedTemplatePlan, 'name' | 'canvas' | 'scalePct' | 'screens'>, defs: readonly ScreenDef[],
  opts: { maxSide?: number; content?: GuideContent | null } = {},
): Promise<TemplateGuidePng> {
  const { width: W, height: H } = plan.canvas;
  const items = layoutPattern(plan, defs);
  // maxSide：夾在 AE 腳本裡的小張版（腳本會把它放大回版型畫布的大小）
  const cap = opts.maxSide ? Math.min(1, opts.maxSide / Math.max(W, H)) : 1;
  const scales = exportScales(W, H).map(s => Math.min(s, cap)).filter((s, i, a) => a.indexOf(s) === i);
  for (const s of scales) {
    const cw = Math.max(1, Math.round(W * s)), ch = Math.max(1, Math.round(H * s));
    const el = document.createElement('canvas');
    el.width = cw;
    el.height = ch;
    let blob: Blob | null = null;
    try {
      const ctx = el.getContext('2d');
      if (!ctx) continue;
      drawTemplateGuide(ctx, plan, items, s, opts.content ?? null);
      blob = await new Promise<Blob | null>(resolve => el.toBlob(resolve, 'image/png'));
    } catch (e) {
      console.warn('[ledTemplate] guide PNG at scale', s, 'failed', e);
    } finally {
      el.width = 0; el.height = 0;   // 馬上放掉記憶體
    }
    if (blob) return { blob, scale: s, width: cw, height: ch };
  }
  throw new Error('這台電腦的瀏覽器畫不出這麼大的圖');
}

/** 單塊螢幕的圖（大小 = 這塊在版型畫布上的像素大小；畫不了就縮小再試，scale 會 < 1） */
export async function renderTilePng(it: PatternItem, span: SrcSpan, layout: LedLayout): Promise<TemplateGuidePng> {
  const { w: W, h: H } = it.dest;
  for (const s of exportScales(W, H).flatMap(v => [v, v / 2]).filter((v, i, a) => a.indexOf(v) === i)) {
    const cw = Math.max(1, Math.round(W * s)), ch = Math.max(1, Math.round(H * s));
    const el = document.createElement('canvas');
    el.width = cw;
    el.height = ch;
    let blob: Blob | null = null;
    try {
      const ctx = el.getContext('2d');
      if (!ctx) continue;
      drawScreenTile(ctx, it, span, layout, [s, 0, 0, s, -it.dest.x * s, -it.dest.y * s], s);
      blob = await new Promise<Blob | null>(resolve => el.toBlob(resolve, 'image/png'));
    } catch (e) {
      console.warn('[ledTemplate] tile PNG at scale', s, 'failed', e);
    } finally {
      el.width = 0; el.height = 0;
    }
    if (blob) return { blob, scale: s, width: cw, height: ch };
  }
  throw new Error(`這台電腦的瀏覽器畫不出「${it.name}」這麼大的圖`);
}
