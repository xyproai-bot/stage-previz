// LED 對位圖：每一塊 LED 在 AE 畫布上的哪裡（純函式，不碰 three / canvas）
//
// LED 怎麼吃畫面：所有 LED 共用同一張貼圖（AE 即時 / 本地檔案 / 影片版本），每一塊 LED 用自己的 UV 去拿那張貼圖的一部分。
//   - 貼圖 flipY = false（跟 glTF 一樣，UV 原點在左上）→ 畫布像素 x = u × 寬、y = v × 高（從上面往下數）
//   - 貼圖是 RepeatWrapping（超出 0~1 會繞回來）：C4D 匯出的 LED 常常整片 UV 在 v ∈ [-0.8, -0.45]，
//     實際拿到的是 v ∈ [0.2, 0.55] 那一段。所以這裡一律先「繞回 0~1」再算位置。
//   - 一塊 LED 剛好壓在畫布邊上（例：u ∈ [0.95, 1.05]）→ 左右兩邊各拿一段，位置寫成 x = 0.95 × 寬、寬度跨出去，標「跨畫布邊緣」。
//
// 一塊 LED 不是長方形（曲面、梯形、L 形）→ 位置寫外框（剛好包住的長方形），圖上另外畫出實際的形狀。

export interface CanvasSize { width: number; height: number }

/** 一個軸上的範圍（UV 單位）：start 在 [0, 1)，start + length 可能超過 1（= 跨畫布邊緣） */
export interface AxisSpan { start: number; length: number; wraps: boolean }

export interface PixelRect { x: number; y: number; w: number; h: number }

export interface LedPanelInput {
  id: string;
  name: string;
  /** 三角形的 UV：每 6 個數字一個三角形（u0 v0 u1 v1 u2 v2），原始值（還沒繞回） */
  tris: ArrayLike<number>;
}

export interface LedPanelLayout {
  id: string;
  name: string;
  /** 畫在圖上的顏色（每塊不一樣） */
  color: string;
  hue: number;
  u: AxisSpan;
  v: AxisSpan;
  /** 畫布像素（x, y 一定在畫布裡；跨邊緣時 x + w > 寬 或 y + h > 高） */
  rect: PixelRect;
  wrapsX: boolean;
  wrapsY: boolean;
  /** 繞回後的三角形（UV 單位，都落在 [start, start + length] 裡；方向一律逆時針） */
  tris: Float64Array;
  /** 外圍的邊（只屬於一個三角形的邊）：每 4 個數字一條（u0 v0 u1 v1） */
  edges: Float64Array;
  /** 三角形面積加起來 / 外框面積（≈1 = 長方形；小很多 = 不是長方形，外框只是包住它） */
  coverage: number;
  triCount: number;
}

export interface LedLayout {
  canvas: CanvasSize;
  panels: LedPanelLayout[];
  /** 找不到可以用的 UV 的 LED（沒有 UV / 全部擠成一個點） */
  skipped: string[];
}

const EPS = 1e-6;
/** 不跨邊比較直觀：跨邊緣的外框要比不跨的窄超過畫布的 1/4 才用跨邊的（剛好壓在接縫上的一定跨） */
const WRAP_PREFERENCE = 0.25;
/** UV 面積比這個小的三角形不算（側邊擠成一條線、一個點的面，不會顯示畫面） */
const MIN_UV_AREA = 1e-10;

/**
 * 一個軸上，這些範圍（每個三角形在這個軸上的 [最小, 最大]，原始值）繞回 0~1 後，用最窄的一段包住。
 * 沒有範圍 → null；有任何一個範圍本身就 ≥ 1 → 整條。
 */
export function axisSpan(intervals: ReadonlyArray<readonly [number, number]>): AxisSpan | null {
  const segs: [number, number][] = [];
  let straddles = false;
  for (const [a, b] of intervals) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (hi - lo >= 1 - EPS) return { start: 0, length: 1, wraps: false };
    const k = Math.floor(lo + EPS);
    const l = Math.max(0, lo - k);
    const h = hi - k;
    if (h > 1 + EPS) {
      straddles = true;
      segs.push([l, 1], [0, h - 1]);
    } else {
      segs.push([l, Math.min(h, 1)]);
    }
  }
  if (segs.length === 0) return null;
  segs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const merged: [number, number][] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + EPS) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const first = merged[0], last = merged[merged.length - 1];
  if (merged.length === 1 && first[0] <= EPS && first[1] >= 1 - EPS) return { start: 0, length: 1, wraps: false };
  // 中間最大的空檔
  let gap = 0, gapAt = -1;
  for (let i = 0; i + 1 < merged.length; i++) {
    const g = merged[i + 1][0] - merged[i][1];
    if (g > gap) { gap = g; gapAt = i; }
  }
  // 跨過 0 / 1 接縫的空檔
  const seamGap = straddles ? 0 : Math.max(0, 1 - last[1]) + first[0];
  const useWrap = gapAt >= 0 && (straddles ? gap > EPS : gap > seamGap + WRAP_PREFERENCE);
  if (!useWrap) {
    if (straddles) return { start: 0, length: 1, wraps: false };  // 跨接縫又沒有空檔 → 整條
    return { start: first[0], length: last[1] - first[0], wraps: false };
  }
  const start = merged[gapAt + 1][0];
  const length = 1 - gap;
  return { start, length, wraps: start + length > 1 + EPS };
}

/** UV 範圍 → 畫布像素（邊界四捨五入；x / y 一定在畫布裡） */
export function spanToPixels(span: AxisSpan, size: number): { pos: number; len: number } {
  let p0 = Math.round(span.start * size);
  const p1 = Math.round((span.start + span.length) * size);
  let len = p1 - p0;
  if (p0 >= size) { p0 -= size; }
  if (len < 0) len = 0;
  return { pos: p0, len };
}

/** 把一個數字 x 平移整數，落在 [start, start + 1) 裡 */
function shiftInto(x: number, start: number): number {
  return Math.floor(x - start + EPS);
}

const keyOf = (u: number, v: number) => `${Math.round(u * 1e5)},${Math.round(v * 1e5)}`;

/** 每塊 LED 一個顏色：黃金角度分色，相鄰的差很多 */
export function panelHue(index: number): number {
  return (index * 137.508 + 160) % 360;
}

export function panelColor(index: number): string {
  return `hsl(${panelHue(index).toFixed(1)}, 72%, 58%)`;
}

/** 一塊 LED 的 UV 三角形 → 位置、繞回後的三角形、外圍的邊；沒有能用的三角形 → null */
export function layoutPanel(input: LedPanelInput, canvas: CanvasSize, index: number): LedPanelLayout | null {
  const src = input.tris;
  const n = Math.floor(src.length / 6);
  const keep: number[] = [];
  const uRanges: [number, number][] = [];
  const vRanges: [number, number][] = [];
  for (let t = 0; t < n; t++) {
    const o = t * 6;
    const u0 = src[o], v0 = src[o + 1], u1 = src[o + 2], v1 = src[o + 3], u2 = src[o + 4], v2 = src[o + 5];
    if (![u0, v0, u1, v1, u2, v2].every(Number.isFinite)) continue;
    const area = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
    if (area < MIN_UV_AREA) continue;
    keep.push(t);
    uRanges.push([Math.min(u0, u1, u2), Math.max(u0, u1, u2)]);
    vRanges.push([Math.min(v0, v1, v2), Math.max(v0, v1, v2)]);
  }
  const u = axisSpan(uRanges);
  const v = axisSpan(vRanges);
  if (!u || !v || keep.length === 0) return null;

  // 繞回：每個三角形整個平移到外框那一段裡（同一個三角形三個點一起移，不會被拆開）；同一個位置的重複三角形（正反兩面）只留一個
  const tris: number[] = [];
  const seen = new Set<string>();
  const edgeCount = new Map<string, { n: number; e: [number, number, number, number] }>();
  let areaSum = 0;
  keep.forEach((t, i) => {
    const o = t * 6;
    const ku = u.length >= 1 - EPS ? Math.floor(uRanges[i][0] + EPS) : shiftInto(uRanges[i][0], u.start);
    const kv = v.length >= 1 - EPS ? Math.floor(vRanges[i][0] + EPS) : shiftInto(vRanges[i][0], v.start);
    let p = [src[o] - ku, src[o + 1] - kv, src[o + 2] - ku, src[o + 3] - kv, src[o + 4] - ku, src[o + 5] - kv];
    // 方向統一（畫布 y 朝下時逆時針 = 數學上的負面積；統一就好，填色時正反面不會互相抵消）
    const cross = (p[2] - p[0]) * (p[5] - p[1]) - (p[4] - p[0]) * (p[3] - p[1]);
    if (cross < 0) p = [p[0], p[1], p[4], p[5], p[2], p[3]];
    const ks = [keyOf(p[0], p[1]), keyOf(p[2], p[3]), keyOf(p[4], p[5])];
    const triKey = [...ks].sort().join('|');
    if (seen.has(triKey)) return;
    seen.add(triKey);
    tris.push(...p);
    areaSum += Math.abs(cross) / 2;
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const ka = ks[a], kb = ks[b];
      const k = ka < kb ? ka + '#' + kb : kb + '#' + ka;
      const cur = edgeCount.get(k);
      if (cur) cur.n++;
      else edgeCount.set(k, { n: 1, e: [p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1]] });
    }
  });
  const edges: number[] = [];
  for (const { n: c, e } of edgeCount.values()) if (c === 1) edges.push(...e);

  const px = spanToPixels(u, canvas.width);
  const py = spanToPixels(v, canvas.height);
  const rect = { x: px.pos, y: py.pos, w: px.len, h: py.len };
  return {
    id: input.id,
    name: input.name,
    color: panelColor(index),
    hue: panelHue(index),
    u, v,
    rect,
    wrapsX: rect.x + rect.w > canvas.width,
    wrapsY: rect.y + rect.h > canvas.height,
    tris: Float64Array.from(tris),
    edges: Float64Array.from(edges),
    coverage: u.length * v.length > 0 ? areaSum / (u.length * v.length) : 0,
    triCount: tris.length / 6,
  };
}

/** 全部 LED 的位置（照給的順序上色） */
export function buildLedLayout(panels: readonly LedPanelInput[], canvas: CanvasSize): LedLayout {
  const out: LedPanelLayout[] = [];
  const skipped: string[] = [];
  panels.forEach((p) => {
    const l = layoutPanel(p, canvas, out.length);
    if (l) out.push(l);
    else skipped.push(p.name);
  });
  return { canvas, panels: out, skipped };
}

/** 位置一樣的 LED（例：左右兩面放一樣畫面）放在一起標名字 */
export function groupSameRect(panels: readonly LedPanelLayout[]): { rect: PixelRect; panels: LedPanelLayout[] }[] {
  const groups = new Map<string, { rect: PixelRect; panels: LedPanelLayout[] }>();
  for (const p of panels) {
    const k = `${p.rect.x},${p.rect.y},${p.rect.w},${p.rect.h}`;
    const g = groups.get(k);
    if (g) g.panels.push(p);
    else groups.set(k, { rect: p.rect, panels: [p] });
  }
  return [...groups.values()];
}

/** 跨畫布邊緣時要畫幾份（往左 / 往上平移一個畫布再畫一次） */
export function wrapOffsets(p: Pick<LedPanelLayout, 'wrapsX' | 'wrapsY'>, canvas: CanvasSize): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  if (p.wrapsX) out.push([-canvas.width, 0]);
  if (p.wrapsY) out.push([0, -canvas.height]);
  if (p.wrapsX && p.wrapsY) out.push([-canvas.width, -canvas.height]);
  return out;
}

export function rectText(r: PixelRect): string {
  return `x ${r.x}  y ${r.y}  w ${r.w}  h ${r.h}`;
}

function wrapNote(p: LedPanelLayout): string {
  if (p.wrapsX && p.wrapsY) return '左右、上下';
  if (p.wrapsX) return '左右';
  if (p.wrapsY) return '上下';
  return '';
}

function csvCell(s: string | number): string {
  const t = String(s);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** 位置表 CSV（Excel 打得開：前面有 BOM、換行 CRLF） */
export function layoutToCsv(layout: LedLayout): string {
  const rows: (string | number)[][] = [['名稱', 'x', 'y', 'w', 'h', 'x+w', 'y+h', '跨畫布邊緣', '不是長方形']];
  for (const p of layout.panels) {
    const r = p.rect;
    rows.push([p.name, r.x, r.y, r.w, r.h, r.x + r.w, r.y + r.h, wrapNote(p), p.coverage < 0.98 ? '是（位置是外框）' : '']);
  }
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export interface LedMapMeta {
  projectName: string;
  /** yyyy-mm-dd */
  date: string;
  canvas: CanvasSize;
  /** 畫布大小哪來的：project = 製作設定的；media = 照目前影片 / 圖片；default = 預設 */
  canvasSource: 'project' | 'media' | 'default';
  /** 輸出的圖有縮小（瀏覽器畫不了原尺寸）：0~1；沒縮 = 1 */
  scale?: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** 位置表 JSON（給 AE 腳本 / 程式讀） */
export function layoutToJson(layout: LedLayout, meta: LedMapMeta): string {
  return JSON.stringify({
    project: meta.projectName,
    date: meta.date,
    canvas: { width: layout.canvas.width, height: layout.canvas.height, source: meta.canvasSource },
    uvOrigin: 'top-left',
    panels: layout.panels.map(p => ({
      id: p.id,
      name: p.name,
      x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h,
      wrapsX: p.wrapsX, wrapsY: p.wrapsY,
      rectangular: p.coverage >= 0.98,
      uv: { u0: round4(p.u.start), v0: round4(p.v.start), u1: round4(p.u.start + p.u.length), v1: round4(p.v.start + p.v.length) },
      triangles: p.triCount,
    })),
    skipped: layout.skipped,
  }, null, 2) + '\n';
}

export function canvasSourceText(src: LedMapMeta['canvasSource']): string {
  return src === 'project' ? '製作設定的' : src === 'media' ? '照目前影片 / 圖片的大小' : '預設大小，製作還沒設定';
}

/** 對位圖左上角（或比較空的角落）的小說明 */
export function legendLines(meta: LedMapMeta, panelCount: number): string[] {
  const lines = [
    'LED 對位圖',
    `專案：${meta.projectName || '（未命名）'}`,
    `日期：${meta.date}`,
    `畫布：${meta.canvas.width} × ${meta.canvas.height} px（${canvasSourceText(meta.canvasSource)}）`,
    `LED ${panelCount} 塊 · 格線每 100 px · 位置是左上角 x, y 和寬 w、高 h`,
  ];
  if (meta.scale !== undefined && meta.scale < 1) {
    lines.push(`這張圖縮小成 ${Math.round(meta.scale * 100)}%（瀏覽器畫不了原尺寸），標的數字都是原尺寸的像素`);
  }
  return lines;
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

function overlap(a: PixelRect, b: PixelRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 說明框放哪個角落：蓋到 LED 最少的那個（一樣的話照 左上 → 右上 → 左下 → 右下） */
export function pickLegendCorner(panels: readonly Pick<LedPanelLayout, 'rect'>[], canvas: CanvasSize, box: { w: number; h: number }): Corner {
  const pos: Record<Corner, PixelRect> = {
    tl: { x: 0, y: 0, w: box.w, h: box.h },
    tr: { x: canvas.width - box.w, y: 0, w: box.w, h: box.h },
    bl: { x: 0, y: canvas.height - box.h, w: box.w, h: box.h },
    br: { x: canvas.width - box.w, y: canvas.height - box.h, w: box.w, h: box.h },
  };
  let best: Corner = 'tl';
  let bestArea = Infinity;
  for (const c of ['tl', 'tr', 'bl', 'br'] as Corner[]) {
    const a = panels.reduce((s, p) => s + overlap(pos[c], p.rect), 0);
    if (a < bestArea - 0.5) { bestArea = a; best = c; }
  }
  return best;
}

function safeName(s: string): string {
  return (s || '專案').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || '專案';
}

/** 檔名：LED對位圖-主舞臺-10496x5120-2026-10-14.png */
export function ledMapFileName(kind: 'png' | 'csv' | 'json', meta: Pick<LedMapMeta, 'projectName' | 'canvas' | 'date'>): string {
  const base = kind === 'png' ? 'LED對位圖' : 'LED位置表';
  return `${base}-${safeName(meta.projectName)}-${meta.canvas.width}x${meta.canvas.height}-${meta.date}.${kind}`;
}

export function todayString(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 製作輸入的「寬 × 高」：10496 x 5120、10496×5120、10496, 5120 都可以 */
export function parseCanvasInput(text: string): CanvasSize | null {
  const m = /^\s*(\d{1,6})\s*(?:[x×X*,，]|\s)\s*(\d{1,6})\s*$/.exec(text);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 輸出 PNG 要試的縮放：先試原尺寸（不超過瀏覽器限制：單邊 16384、面積 1.2 億像素），
 * 畫不出來再試小一點（最後一個是 iPad / iPhone 的上限 1677 萬像素）
 */
export function exportScales(width: number, height: number): number[] {
  const fit = (maxSide: number, maxArea: number) => Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxArea / (width * height)));
  const list = [fit(16384, 120e6), fit(16384, 60e6), fit(8192, 16.7e6)];
  return list.filter((s, i) => s > 0 && list.indexOf(s) === i);
}

/** 3D 上的測試圖貼圖要多大：跟畫布同比例，單邊不超過 maxSide、面積不超過 maxArea（夠清楚又不吃太多顯示記憶體） */
export function testPatternSize(canvas: CanvasSize, maxSide: number, maxArea: number): { width: number; height: number; scale: number } {
  const { width, height } = canvas;
  const scale = Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxArea / (width * height)));
  return { width: Math.max(16, Math.round(width * scale)), height: Math.max(16, Math.round(height * scale)), scale };
}

/** 預設畫布：製作設定的 → 目前影片 / 圖片的大小 → 3840 × 2160 */
export const DEFAULT_LED_CANVAS: CanvasSize = { width: 3840, height: 2160 };

export function resolveLedCanvas(project: CanvasSize | null | undefined, media: CanvasSize | null | undefined): { canvas: CanvasSize; source: LedMapMeta['canvasSource'] } {
  if (project && project.width > 0 && project.height > 0) return { canvas: project, source: 'project' };
  if (media && media.width >= 16 && media.height >= 16) return { canvas: { width: Math.round(media.width), height: Math.round(media.height) }, source: 'media' };
  return { canvas: DEFAULT_LED_CANVAS, source: 'default' };
}
