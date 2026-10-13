// 畫 LED 對位圖（下載的 PNG）和 LED 測試圖（3D 上沒有畫面時 LED 顯示的）
// 兩張圖都畫在同一個「畫布像素」座標上（跟 AE 合成一樣大）：ctx 先縮放，裡面的數字一律是畫布像素。

import {
  exportScales, groupSameRect, legendLines, pickLegendCorner, rectText, wrapOffsets,
  type CanvasSize, type LedLayout, type LedMapMeta, type LedPanelLayout, type PixelRect,
} from './ledMap';

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", Consolas, "SF Mono", Menlo, monospace';
/** 三角形太多的 LED（細的曲面）不照形狀裁切，直接用外框（畫起來才不會卡） */
const MAX_CLIP_TRIS = 20000;

function trianglesPath(p: LedPanelLayout, c: CanvasSize): Path2D {
  const path = new Path2D();
  const t = p.tris;
  for (let i = 0; i + 5 < t.length; i += 6) {
    path.moveTo(t[i] * c.width, t[i + 1] * c.height);
    path.lineTo(t[i + 2] * c.width, t[i + 3] * c.height);
    path.lineTo(t[i + 4] * c.width, t[i + 5] * c.height);
    path.closePath();
  }
  return path;
}

function edgesPath(p: LedPanelLayout, c: CanvasSize): Path2D {
  const path = new Path2D();
  const e = p.edges;
  for (let i = 0; i + 3 < e.length; i += 4) {
    path.moveTo(e[i] * c.width, e[i + 1] * c.height);
    path.lineTo(e[i + 2] * c.width, e[i + 3] * c.height);
  }
  return path;
}

function clipPanel(ctx: CanvasRenderingContext2D, p: LedPanelLayout, c: CanvasSize) {
  if (p.triCount <= MAX_CLIP_TRIS) ctx.clip(trianglesPath(p, c));
  else { ctx.beginPath(); ctx.rect(p.rect.x, p.rect.y, p.rect.w, p.rect.h); ctx.clip(); }
}

/** 大的先畫、小的後畫（小的疊在上面看得到） */
function byAreaDesc(panels: readonly LedPanelLayout[]): LedPanelLayout[] {
  return [...panels].sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
}

/** 每 step 一條線（對齊畫布原點），只畫在 r 裡面 */
function gridLines(ctx: CanvasRenderingContext2D, r: PixelRect, step: number, skipEvery = 0) {
  ctx.beginPath();
  for (let x = Math.ceil(r.x / step) * step; x <= r.x + r.w; x += step) {
    if (skipEvery && x % skipEvery === 0) continue;
    ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h);
  }
  for (let y = Math.ceil(r.y / step) * step; y <= r.y + r.h; y += step) {
    if (skipEvery && y % skipEvery === 0) continue;
    ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y);
  }
  ctx.stroke();
}

/** 跨邊緣的 LED：在畫布裡最大的那一段（標籤放這裡） */
function largestPiece(p: LedPanelLayout, c: CanvasSize): PixelRect {
  const { x, y, w, h } = p.rect;
  const xs: [number, number][] = p.wrapsX ? [[x, c.width - x], [0, x + w - c.width]] : [[x, w]];
  const ys: [number, number][] = p.wrapsY ? [[y, c.height - y], [0, y + h - c.height]] : [[y, h]];
  let best: PixelRect = { x, y, w: Math.min(w, c.width - x), h: Math.min(h, c.height - y) };
  let bestArea = -1;
  for (const [px, pw] of xs) for (const [py, ph] of ys) {
    if (pw * ph > bestArea) { bestArea = pw * ph; best = { x: px, y: py, w: pw, h: ph }; }
  }
  return best;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// ───────────────────────── 對位圖 ─────────────────────────

/** 對位圖：深色底、每 100 px 格線、每塊 LED 的形狀 + 外框 + 名字 + x y w h、小說明 */
export function drawAlignmentMap(ctx: CanvasRenderingContext2D, layout: LedLayout, meta: LedMapMeta, scale: number) {
  const c = layout.canvas;
  const W = c.width, H = c.height;
  // 字的大小跟著畫布（4K 畫布 = 1）
  const u = Math.min(4, Math.max(0.5, Math.max(W, H) / 3840));
  const hair = (n: number) => Math.max(n, 1 / scale);  // 至少 1 個輸出像素
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#0c0d10';
  ctx.fillRect(0, 0, W, H);

  // 格線：100 / 500 / 1000
  const whole = { x: 0, y: 0, w: W, h: H };
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = hair(1);
  gridLines(ctx, whole, 100, 500);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = hair(1.5);
  gridLines(ctx, whole, 500, 1000);
  ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.lineWidth = hair(2);
  gridLines(ctx, whole, 1000);

  // 尺標（上、左），每 1000 px（畫布小就每 500）
  const tick = Math.max(W, H) >= 4000 ? 1000 : 500;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `${Math.round(16 * u)}px ${MONO}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (let x = tick; x < W; x += tick) ctx.fillText(String(x), x + 6 * u, 6 * u);
  for (let y = tick; y < H; y += tick) ctx.fillText(String(y), 6 * u, y + 6 * u);

  // LED：填色 + 裡面比較亮的格線 + 實際形狀的外框 + （不是長方形時）虛線外框
  const panels = byAreaDesc(layout.panels);
  for (const p of panels) {
    for (const [dx, dy] of wrapOffsets(p, c)) {
      ctx.save();
      ctx.translate(dx, dy);
      const tri = trianglesPath(p, c);
      ctx.fillStyle = `hsla(${p.hue.toFixed(1)}, 72%, 52%, 0.30)`;
      ctx.fill(tri);
      ctx.save();
      clipPanel(ctx, p, c);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = hair(1);
      gridLines(ctx, p.rect, 100);
      ctx.restore();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = hair(3 * u);
      ctx.lineJoin = 'round';
      ctx.stroke(edgesPath(p, c));
      if (p.coverage < 0.98) {
        ctx.setLineDash([14 * u, 10 * u]);
        ctx.lineWidth = hair(1.5 * u);
        ctx.strokeRect(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  // 名字 + 位置（最後畫，才不會被別塊蓋住）
  for (const g of groupSameRect(layout.panels)) {
    const p = g.panels[0];
    const name = g.panels.map(x => x.name).join('、');
    const notes: string[] = [];
    if (p.wrapsX || p.wrapsY) notes.push(p.wrapsX && p.wrapsY ? '跨畫布邊緣（左右、上下接著）' : p.wrapsX ? '跨畫布左右邊緣' : '跨畫布上下邊緣');
    if (p.coverage < 0.98) notes.push('不是長方形：虛線是外框');
    drawPanelLabel(ctx, name, p.rect, notes, p, largestPiece(p, c), c, u);
  }

  // 小說明（放在蓋到 LED 最少的角落）
  drawLegend(ctx, layout, meta, u);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawPanelLabel(ctx: CanvasRenderingContext2D, name: string, rect: PixelRect, notes: string[], p: LedPanelLayout, area: PixelRect, c: CanvasSize, u: number) {
  const pad = 8 * u, margin = 10 * u, minFs = 24 * u;
  // 位置：一行寫完（x y w h），窄的 LED 改成兩行（x y / w h）
  const oneLine = [rectText(rect), ...notes];
  const twoLines = [`x ${rect.x}  y ${rect.y}`, `w ${rect.w}  h ${rect.h}`, ...notes];
  const measure = (fs: number, sub: string[]) => {
    ctx.font = `600 ${fs}px ${FONT}`;
    let w = ctx.measureText(name).width;
    ctx.font = `${fs * 0.62}px ${MONO}`;
    for (const l of sub) w = Math.max(w, ctx.measureText(l).width);
    return { w: w + pad * 2, h: fs * 1.25 + sub.length * fs * 0.62 * 1.35 + pad * 2 };
  };
  const fits = (b: { w: number; h: number }) => b.w <= area.w - margin * 2 && b.h <= area.h - margin * 2;
  // 字的大小：塞得進這一塊就放裡面（最大 56u、最小 24u），太小的 LED 就放外面
  const tryFit = (sub: string[]) => {
    let fs = Math.min(56 * u, Math.max(minFs, area.h * 0.16));
    let box = measure(fs, sub);
    while (!fits(box) && fs > minFs) {
      fs = Math.max(minFs, fs * 0.85);
      box = measure(fs, sub);
    }
    return fits(box) ? { fs, box, sub } : null;
  };
  const inside = tryFit(oneLine) ?? tryFit(twoLines);
  let fs: number, box: { w: number; h: number }, sub: string[], bx: number, by: number;
  if (inside) {
    ({ fs, box, sub } = inside);
    bx = area.x + margin; by = area.y + margin;
  } else {
    // 太小的 LED：字放外面，大小照一般的（不要擠成看不到）；下面放得下放下面，不然放上面；左右不超出畫布
    fs = 28 * u; sub = oneLine; box = measure(fs, sub);
    bx = Math.min(Math.max(0, area.x), Math.max(0, c.width - box.w));
    by = area.y + area.h + margin + box.h <= c.height ? area.y + area.h + margin : Math.max(0, area.y - margin - box.h);
  }
  ctx.fillStyle = 'rgba(8,9,12,0.78)';
  roundRect(ctx, bx, by, box.w, box.h, 6 * u);
  ctx.fill();
  ctx.strokeStyle = p.color;
  ctx.lineWidth = Math.max(1, 2 * u);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.fillText(name, bx + pad, by + pad);
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = `${fs * 0.62}px ${MONO}`;
  sub.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + fs * 1.25 + i * fs * 0.62 * 1.35));
}

function drawLegend(ctx: CanvasRenderingContext2D, layout: LedLayout, meta: LedMapMeta, u: number) {
  const c = layout.canvas;
  const lines = legendLines(meta, layout.panels.length);
  if (layout.skipped.length > 0) lines.push(`沒有 UV、沒畫出來：${layout.skipped.slice(0, 6).join('、')}${layout.skipped.length > 6 ? ' …' : ''}`);
  const titleFs = 34 * u, fs = 22 * u, pad = 18 * u, lh = fs * 1.45;
  ctx.font = `700 ${titleFs}px ${FONT}`;
  let w = ctx.measureText(lines[0]).width;
  ctx.font = `${fs}px ${FONT}`;
  for (const l of lines.slice(1)) w = Math.max(w, ctx.measureText(l).width);
  const box = { w: Math.min(c.width, w + pad * 2), h: Math.min(c.height, titleFs * 1.4 + (lines.length - 1) * lh + pad * 2) };
  const corner = pickLegendCorner(layout.panels, c, box);
  const m = 12 * u;
  const bx = corner === 'tl' || corner === 'bl' ? m : c.width - box.w - m;
  const by = corner === 'tl' || corner === 'tr' ? m : c.height - box.h - m;
  ctx.fillStyle = 'rgba(12,13,16,0.9)';
  roundRect(ctx, bx, by, box.w, box.h, 8 * u);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = Math.max(1, 1.5 * u);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#10c78a';
  ctx.font = `700 ${titleFs}px ${FONT}`;
  ctx.fillText(lines[0], bx + pad, by + pad);
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.font = `${fs}px ${FONT}`;
  lines.slice(1).forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + titleFs * 1.4 + i * lh));
}

export interface AlignmentMapPng { blob: Blob; scale: number; width: number; height: number }

/** 畫成 PNG（原尺寸；瀏覽器畫不了就縮小，scale 會 < 1） */
export async function renderAlignmentMapPng(layout: LedLayout, meta: LedMapMeta): Promise<AlignmentMapPng> {
  const { width: W, height: H } = layout.canvas;
  for (const s of exportScales(W, H)) {
    const cw = Math.max(1, Math.round(W * s)), ch = Math.max(1, Math.round(H * s));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    let blob: Blob | null = null;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      drawAlignmentMap(ctx, layout, { ...meta, scale: s }, s);
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    } catch (e) {
      console.warn('[ledMap] PNG at scale', s, 'failed', e);
    } finally {
      canvas.width = 0; canvas.height = 0;  // 馬上放掉記憶體
    }
    if (blob) return { blob, scale: s, width: cw, height: ch };
  }
  throw new Error('這台電腦的瀏覽器畫不出這麼大的圖');
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ───────────────────────── 測試圖 ─────────────────────────

// 彩條：75% 亮度（跟電視測試圖一樣），現場模式的光暈不會把它吃掉
const BARS = ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf'];

/**
 * 測試圖：每塊 LED 自己的名字、x y w h、每 100 px 格線、彩條、灰階、中心十字、四個角的記號、邊框。
 * 最亮的地方 ≈ 85%（線性約 0.69），低於光暈門檻 0.75。
 */
export function drawTestPattern(ctx: CanvasRenderingContext2D, layout: LedLayout, scale: number) {
  const c = layout.canvas;
  const px = 1 / scale;  // 貼圖上 1 個像素有多少畫布像素
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  const names = new Map<string, string>();
  for (const g of groupSameRect(layout.panels)) {
    const n = g.panels.map(x => x.name).join('、');
    for (const p of g.panels) names.set(p.id, n);
  }
  for (const p of byAreaDesc(layout.panels)) {
    for (const [dx, dy] of wrapOffsets(p, c)) {
      ctx.save();
      ctx.translate(dx, dy);
      clipPanel(ctx, p, c);
      drawPanelPattern(ctx, p, names.get(p.id) || p.name, px);
      ctx.restore();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawPanelPattern(ctx: CanvasRenderingContext2D, p: LedPanelLayout, name: string, px: number) {
  const { x, y, w, h } = p.rect;
  if (w <= 0 || h <= 0) return;
  const m = Math.min(w, h);
  const hue = p.hue.toFixed(1);
  const cx = x + w / 2, cy = y + h / 2;
  const lw = (frac: number, minPx: number) => Math.max(minPx * px, m * frac);

  // 底色（每塊不同色、很暗）
  ctx.fillStyle = `hsl(${hue}, 34%, 13%)`;
  ctx.fillRect(x, y, w, h);

  // 格線：每 100 px，每 500 px 粗一點（對齊畫布原點，跟對位圖同一套）
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = Math.max(1.2 * px, 1.5);
  gridLines(ctx, p.rect, 100, 500);
  ctx.strokeStyle = 'rgba(255,255,255,0.38)';
  ctx.lineWidth = Math.max(1.8 * px, 2.5);
  gridLines(ctx, p.rect, 500);

  // 中心：整條十字 + 圓 + 中間粗的十字
  ctx.strokeStyle = 'rgba(217,217,217,0.55)';
  ctx.lineWidth = lw(0.004, 1.5);
  ctx.beginPath();
  ctx.moveTo(x, cy); ctx.lineTo(x + w, cy);
  ctx.moveTo(cx, y); ctx.lineTo(cx, y + h);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(217,217,217,0.7)';
  ctx.lineWidth = lw(0.007, 2);
  ctx.beginPath();
  ctx.arc(cx, cy, m * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  const arm = m * 0.07;
  ctx.strokeStyle = '#d9d9d9';
  ctx.lineWidth = lw(0.012, 2);
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
  ctx.stroke();

  // 彩條 + 灰階（下半部）
  const bx = x + w * 0.08, bw = w * 0.84;
  const by = y + h * 0.66, bh = h * 0.12;
  BARS.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(bx + (bw * i) / BARS.length, by, bw / BARS.length + 0.5 * px, bh);
  });
  const steps = 8;
  for (let i = 0; i < steps; i++) {
    const v = Math.round((191 * i) / (steps - 1));
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(bx + (bw * i) / steps, by + bh, bw / steps + 0.5 * px, h * 0.05);
  }

  // 邊框（看得到四邊 = 沒有被切掉）
  const bwid = lw(0.012, 3);
  ctx.strokeStyle = `hsl(${hue}, 70%, 55%)`;
  ctx.lineWidth = bwid;
  ctx.strokeRect(x + bwid / 2, y + bwid / 2, w - bwid, h - bwid);

  // 四個角：L 形記號；左上多一個實心三角形（看得出有沒有翻過來）
  const L = m * 0.14, t = lw(0.02, 2.5), inset = bwid;
  ctx.fillStyle = '#d9d9d9';
  const corner = (ox: number, oy: number, sx: number, sy: number) => {
    ctx.fillRect(sx > 0 ? ox : ox - L, sy > 0 ? oy : oy - t, L, t);
    ctx.fillRect(sx > 0 ? ox : ox - t, sy > 0 ? oy : oy - L, t, L);
  };
  corner(x + inset, y + inset, 1, 1);
  corner(x + w - inset, y + inset, -1, 1);
  corner(x + inset, y + h - inset, 1, -1);
  corner(x + w - inset, y + h - inset, -1, -1);
  ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
  ctx.beginPath();
  ctx.moveTo(x + inset + t * 1.8, y + inset + t * 1.8);
  ctx.lineTo(x + inset + t * 1.8 + L * 0.55, y + inset + t * 1.8);
  ctx.lineTo(x + inset + t * 1.8, y + inset + t * 1.8 + L * 0.55);
  ctx.closePath();
  ctx.fill();

  // 名字 + x y w h
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fs = Math.max(6 * px, h * 0.15);
  ctx.font = `700 ${fs}px ${FONT}`;
  const nw = ctx.measureText(name).width;
  if (nw > w * 0.8) { fs = Math.max(6 * px, (fs * w * 0.8) / nw); ctx.font = `700 ${fs}px ${FONT}`; }
  const ny = y + h * 0.24;
  const fs2 = Math.max(5 * px, Math.min(fs * 0.42, h * 0.07));
  // 字後面墊一塊半透明黑，格線上也看得清楚
  const tw = Math.min(ctx.measureText(name).width, w * 0.84);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(cx - tw / 2 - fs * 0.3, ny - fs * 0.62, tw + fs * 0.6, fs * 1.24 + fs2 * 1.5);
  ctx.fillStyle = '#d9d9d9';
  ctx.fillText(name, cx, ny, w * 0.84);
  ctx.font = `${fs2}px ${MONO}`;
  ctx.fillStyle = '#a6a6a6';
  ctx.fillText(rectText(p.rect), cx, ny + fs * 0.62 + fs2 * 0.75, w * 0.84);

  // 左上 / 右下角的座標
  const fs3 = Math.max(5 * px, m * 0.045);
  ctx.font = `${fs3}px ${MONO}`;
  ctx.fillStyle = '#bdbdbd';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${x}, ${y}`, x + inset + t * 1.8, y + inset + t * 1.8 + L * 0.62);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${x + w}, ${y + h}`, x + w - inset - t * 1.8, y + h - inset - t * 1.8);
}
