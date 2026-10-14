// 畫記（畫在 3D 畫面上的筆、箭頭、方框、圓圈）——純函式（annotations.test.ts 有測）
//
// 座標一律 0~1，相對「畫的時候的 3D 畫面」：x 往右、y 往下；線的粗細 w 是畫面高度的比例。
// 存起來的是向量（不是圖片），所以跟螢幕大小無關；aspect = 畫的時候畫面的寬 / 高。
// 規則跟後台 cf-worker/comments.mjs 的 sanitizeAnnotation 一樣（後台最後把關）。
//
// 打開留言時畫面比例可能不一樣（手機 / iPad / 另一台電腦）：
//   containBox    畫記放在畫面中間、比例跟當時一樣（左右或上下留黑邊）
//   fitFov        配合 containBox 調鏡頭角度，讓當時整個畫面都看得到，畫記剛好疊在同樣的東西上

export type AnnTool = 'pen' | 'arrow' | 'rect' | 'ellipse';

export interface AnnShape {
  t: AnnTool;
  /** 顏色（只收 ANN_COLORS） */
  c: string;
  /** 線的粗細（畫面高度的比例） */
  w: number;
  /** [x0, y0, x1, y1, …]：筆 = 一串點；箭頭 = 起點、終點；方框 / 圓圈 = 兩個對角 */
  p: number[];
}

export interface Annotation {
  v: 1;
  /** 畫的時候 3D 畫面的寬 / 高 */
  aspect: number;
  shapes: AnnShape[];
}

export const ANN_COLORS: readonly { value: string; label: string }[] = [
  { value: '#ff3b30', label: '紅' },
  { value: '#ffcc00', label: '黃' },
  { value: '#34c759', label: '綠' },
  { value: '#0a84ff', label: '藍' },
  { value: '#ffffff', label: '白' },
];
export const DEFAULT_ANN_COLOR = '#ff3b30';
export const ANN_TOOLS: readonly AnnTool[] = ['pen', 'arrow', 'rect', 'ellipse'];
export const ANN_TOOL_LABEL: Record<AnnTool, string> = { pen: '筆', arrow: '箭頭', rect: '方框', ellipse: '圓圈' };
/** 預設線的粗細：畫面高度的 0.6%（1080p 約 6.5 px） */
export const ANN_STROKE = 0.006;
export const MAX_SHAPES = 60;
export const MAX_PEN_POINTS = 400;
export const MAX_TOTAL_POINTS = 4000;
/** 方框 / 圓圈 / 箭頭太小（手指點一下）就不算一筆 */
export const MIN_SHAPE_SIZE = 0.008;

const COLOR_SET = new Set(ANN_COLORS.map(c => c.value));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** 滑鼠 / 手指 / 筆的位置 → 0~1（相對畫的那塊） */
export function toNormalized(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): [number, number] {
  if (!(rect.width > 0) || !(rect.height > 0)) return [0, 0];
  return [clamp01((clientX - rect.left) / rect.width), clamp01((clientY - rect.top) / rect.height)];
}

/** 一點到線段的距離（化簡筆畫用，算的時候 x 乘上 aspect，左右上下一樣準） */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/**
 * 化簡筆畫（Ramer–Douglas–Peucker）：拿掉幾乎在直線上的點，存起來小很多、看起來一樣
 * @param flat [x0, y0, x1, y1, …]（0~1）
 * @param tolerance 容許誤差（畫面高度的比例，預設 0.0015）
 */
export function simplifyPath(flat: readonly number[], aspect = 1, tolerance = 0.0015): number[] {
  const n = Math.floor(flat.length / 2);
  if (n <= 2) return flat.slice(0, n * 2);
  const xs = Array.from({ length: n }, (_, i) => flat[i * 2] * aspect);
  const ys = Array.from({ length: n }, (_, i) => flat[i * 2 + 1]);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(xs[i], ys[i], xs[a], ys[a], xs[b], ys[b]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD > tolerance) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[i * 2], flat[i * 2 + 1]);
  return out;
}

/** 點太多 → 平均挑（頭尾一定留） */
export function capPoints(flat: readonly number[], max = MAX_PEN_POINTS): number[] {
  const n = Math.floor(flat.length / 2);
  if (n <= max) return flat.slice(0, n * 2);
  const out: number[] = [];
  for (let k = 0; k < max; k++) {
    const i = Math.round((k * (n - 1)) / (max - 1));
    out.push(flat[i * 2], flat[i * 2 + 1]);
  }
  return out;
}

/**
 * 一筆畫完 → 存起來的形狀；太小（點一下）回 null
 * @param points 拖的路徑 [x0, y0, …]（0~1）；方框 / 圓圈 / 箭頭只看第一點和最後一點
 */
export function makeShape(tool: AnnTool, color: string, points: readonly number[], aspect = 1, width = ANN_STROKE): AnnShape | null {
  const n = Math.floor(points.length / 2);
  if (n < 1) return null;
  const c = COLOR_SET.has(color) ? color : DEFAULT_ANN_COLOR;
  if (tool === 'pen') {
    let p = simplifyPath(points.slice(0, n * 2).map(clamp01), aspect);
    p = capPoints(p).map(r4);
    // 只點一下 → 一個點（畫成小圓點）
    return { t: 'pen', c, w: r4(width), p };
  }
  const x0 = clamp01(points[0]), y0 = clamp01(points[1]);
  const x1 = clamp01(points[(n - 1) * 2]), y1 = clamp01(points[(n - 1) * 2 + 1]);
  if (Math.hypot((x1 - x0) * aspect, y1 - y0) < MIN_SHAPE_SIZE) return null;
  return { t: tool, c, w: r4(width), p: [r4(x0), r4(y0), r4(x1), r4(y1)] };
}

/** 畫好的形狀 → 要存的畫記（沒有形狀 = null；超過上限的拿掉後面的） */
export function serializeAnnotation(shapes: readonly AnnShape[], aspect: number): Annotation | null {
  const list = shapes.filter(Boolean).slice(0, MAX_SHAPES);
  if (list.length === 0 || !(aspect > 0)) return null;
  let total = 0;
  const out: AnnShape[] = [];
  for (const s of list) {
    total += Math.floor(s.p.length / 2);
    if (total > MAX_TOTAL_POINTS) break;
    out.push({ t: s.t, c: s.c, w: r4(s.w), p: s.p.map(v => r4(clamp01(v))) });
  }
  return out.length ? { v: 1, aspect: r4(Math.max(0.2, Math.min(6, aspect))), shapes: out } : null;
}

/** 後台來的畫記（或亂掉的資料）→ 畫得出來的；不合格回 null */
export function parseAnnotation(raw: unknown): Annotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as { aspect?: unknown; shapes?: unknown };
  if (!isNum(a.aspect) || a.aspect < 0.2 || a.aspect > 6 || !Array.isArray(a.shapes)) return null;
  const shapes: AnnShape[] = [];
  for (const s of a.shapes.slice(0, MAX_SHAPES)) {
    if (!s || typeof s !== 'object') continue;
    const x = s as Partial<AnnShape>;
    if (!x.t || !ANN_TOOLS.includes(x.t)) continue;
    if (typeof x.c !== 'string' || !COLOR_SET.has(x.c.toLowerCase())) continue;
    if (!isNum(x.w) || x.w <= 0 || x.w > 0.05) continue;
    if (!Array.isArray(x.p) || x.p.length < 2 || x.p.length % 2 || !x.p.every(isNum)) continue;
    if (x.t !== 'pen' && x.p.length !== 4) continue;
    shapes.push({ t: x.t, c: x.c.toLowerCase(), w: x.w, p: x.p.map(clamp01) });
  }
  return shapes.length ? { v: 1, aspect: a.aspect, shapes } : null;
}

export interface Box { left: number; top: number; width: number; height: number }

/** 比例 aspect 的畫面放進 W × H 裡（置中、完整看得到） */
export function containBox(viewW: number, viewH: number, aspect: number): Box {
  if (!(viewW > 0) || !(viewH > 0) || !(aspect > 0)) return { left: 0, top: 0, width: Math.max(0, viewW), height: Math.max(0, viewH) };
  const viewAspect = viewW / viewH;
  if (viewAspect >= aspect) {
    const width = viewH * aspect;
    return { left: (viewW - width) / 2, top: 0, width, height: viewH };
  }
  const height = viewW / aspect;
  return { left: 0, top: (viewH - height) / 2, width: viewW, height };
}

/**
 * 畫面比例比當時窄（直的手機看寬畫面）→ 把鏡頭角度放大，讓當時左右的東西都看得到（containBox 會上下留邊）；
 * 比當時寬 → 角度不變（左右留邊）。three.js 的 fov 是上下的角度。
 */
export function fitFov(fovDeg: number, savedAspect: number | null | undefined, viewAspect: number): number {
  if (!(savedAspect && savedAspect > 0) || !(viewAspect > 0) || viewAspect >= savedAspect) return fovDeg;
  const half = (fovDeg * Math.PI) / 360;
  const wider = Math.atan(Math.tan(half) * (savedAspect / viewAspect));
  return Math.min(150, (wider * 360) / Math.PI);
}

/** 箭頭的頭（三個點），size = 頭的長度（像素） */
export function arrowHead(x0: number, y0: number, x1: number, y1: number, size: number): [number, number][] {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const spread = Math.PI / 7;
  return [
    [x1 - size * Math.cos(ang - spread), y1 - size * Math.sin(ang - spread)],
    [x1, y1],
    [x1 - size * Math.cos(ang + spread), y1 - size * Math.sin(ang + spread)],
  ];
}

/** 線在 W × H 的那塊上有幾像素粗（至少 1.5） */
export function strokePx(w: number, boxH: number): number {
  return Math.max(1.5, w * boxH);
}

/** 一個形狀 → SVG path 的 d（在 W × H 的那塊上，像素） */
export function shapePath(s: AnnShape, W: number, H: number): string {
  const P = (i: number): [number, number] => [s.p[i * 2] * W, s.p[i * 2 + 1] * H];
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  const n = Math.floor(s.p.length / 2);
  if (s.t === 'pen') {
    if (n === 1) {
      // 一個點 → 很短的線（圓頭，看起來是一個點）
      const [x, y] = P(0);
      return `M${f(x)} ${f(y)}L${f(x + 0.01)} ${f(y)}`;
    }
    let d = '';
    for (let i = 0; i < n; i++) { const [x, y] = P(i); d += `${i ? 'L' : 'M'}${f(x)} ${f(y)}`; }
    return d;
  }
  const [x0, y0] = P(0);
  const [x1, y1] = P(1);
  if (s.t === 'arrow') {
    const head = arrowHead(x0, y0, x1, y1, Math.max(10, strokePx(s.w, H) * 3.2));
    return `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}M${f(head[0][0])} ${f(head[0][1])}L${f(head[1][0])} ${f(head[1][1])}L${f(head[2][0])} ${f(head[2][1])}`;
  }
  if (s.t === 'rect') {
    const l = Math.min(x0, x1), t = Math.min(y0, y1), r = Math.max(x0, x1), b = Math.max(y0, y1);
    return `M${f(l)} ${f(t)}H${f(r)}V${f(b)}H${f(l)}Z`;
  }
  // ellipse：兩個半圓弧
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.max(0.5, Math.abs(x1 - x0) / 2), ry = Math.max(0.5, Math.abs(y1 - y0) / 2);
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}

/** 最小的 2D 畫布介面（縮圖合成用；測試可以給假的） */
export interface Canvas2DLike {
  save(): void; restore(): void; beginPath(): void; stroke(): void;
  moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  lineWidth: number; strokeStyle: string | CanvasGradient | CanvasPattern; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin;
  shadowColor: string; shadowBlur: number;
}

/** 把畫記畫到 2D 畫布上（W × H = 整張畫，跟畫的時候的 3D 畫面一樣比例） */
export function drawAnnotation(ctx: Canvas2DLike, ann: Annotation, W: number, H: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = Math.max(1, H / 300);
  for (const s of ann.shapes) {
    ctx.strokeStyle = s.c;
    ctx.lineWidth = strokePx(s.w, H);
    const n = Math.floor(s.p.length / 2);
    const P = (i: number): [number, number] => [s.p[i * 2] * W, s.p[i * 2 + 1] * H];
    ctx.beginPath();
    if (s.t === 'pen') {
      const [x, y] = P(0);
      ctx.moveTo(x, y);
      if (n === 1) ctx.lineTo(x + 0.01, y);
      for (let i = 1; i < n; i++) { const [px, py] = P(i); ctx.lineTo(px, py); }
    } else {
      const [x0, y0] = P(0);
      const [x1, y1] = P(1);
      if (s.t === 'arrow') {
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        const head = arrowHead(x0, y0, x1, y1, Math.max(10 * (H / 720), strokePx(s.w, H) * 3.2));
        ctx.moveTo(head[0][0], head[0][1]); ctx.lineTo(head[1][0], head[1][1]); ctx.lineTo(head[2][0], head[2][1]);
      } else if (s.t === 'rect') {
        const l = Math.min(x0, x1), t = Math.min(y0, y1), r = Math.max(x0, x1), b = Math.max(y0, y1);
        ctx.moveTo(l, t); ctx.lineTo(r, t); ctx.lineTo(r, b); ctx.lineTo(l, b); ctx.closePath();
      } else {
        ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, Math.abs(x1 - x0) / 2), Math.max(0.5, Math.abs(y1 - y0) / 2), 0, 0, Math.PI * 2);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** 留言上的小字：「畫記 3 筆」 */
export function annotationSummary(ann: Annotation | null | undefined): string {
  const n = ann?.shapes.length ?? 0;
  return n > 0 ? `畫記 ${n} 筆` : '';
}
