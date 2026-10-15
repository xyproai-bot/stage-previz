// 比例尺輔助（3D 畫面上的人形 + 1 公尺網格）的算法：舞台面是哪一層、人形站哪、站在哪個面上。
// 只做數學，不碰 3D 場景，所以可以直接單元測試；StageScene 負責把結果擺進畫面，scaleReferenceScene.ts 負責從模型抓出朝上的面、打光線。
//
// 座標：場景單位（公尺 × unitsPerMeter）；y 向上；「前面」= 舞台正面朝觀眾的水平方向（stageCamera.ts 的 stageFrontDirection）。
//
// 怎麼找「舞台面」：真的舞台模型上方常有桁架 / 屋頂（頂面也是水平的），所以不能只取「最高的水平面」。
// 改成：把所有朝上的面依高度加總面積，面積最大的那一層 = 舞台面（地板最大）；人形站在那一層的前緣、左 / 中 / 右各一個。

export const FIGURE_HEIGHT_M = 1.7;
/** 人形頭上的字 */
export const FIGURE_LABEL = '1.7 m';
/** 面的朝上程度（法線 y）超過這個才算「站得住的地面」；牆、斜得太陡的面不算 */
export const STAND_MIN_NORMAL_Y = 0.7;
/** 舞台面那一層上下各多少公尺內都算同一層（地板、地屏、鋪的板子高度差一點點） */
export const DECK_TOLERANCE_M = 0.2;
/** 拖的時候，比舞台面高出多少公尺以內的面才算能站（再高的是桁架、屋頂，不是人站的地方） */
export const MAX_STAND_ABOVE_DECK_M = 3.5;

/** 不當地面的物件類型：LED（畫面牆，不是地板）、走位點 / 表演者（站在它們頭上很奇怪） */
const NOT_GROUND_CATEGORIES: ReadonlySet<string> = new Set(['led_panel', 'walk_point', 'performer']);
export function canStandOnCategory(category: string | undefined): boolean {
  return !NOT_GROUND_CATEGORIES.has(category ?? '');
}

export interface XZ { x: number; z: number }
export interface Box3Like { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
/** 往下打光線打到的一個點：高度 + 那個面的法線 y（朝上 = 1） */
export interface DownHit { y: number; normalY: number }
export type FigureSlot = 'left' | 'center' | 'right';
export interface FigureSpot extends XZ { slot: FigureSlot }
/** 一堆朝上的三角形（世界座標）：verts 每個三角形 9 個數字（三個頂點的 x, y, z），areas 是每個三角形的面積 */
export interface FaceSet { count: number; verts: ArrayLike<number>; areas: ArrayLike<number> }
/** 舞台面在「前後（u，往觀眾那一側為正）」和「左右（v，觀眾看過去往右為正）」兩條軸上的範圍 */
export interface UVExtent { uMin: number; uMax: number; vMin: number; vMax: number }
export interface DeckFootprint {
  /** 舞台面那一層的高度 */
  level: number;
  extent: UVExtent;
  /** 舞台面（面積加權）的重心，水平位置 */
  centroid: XZ;
  /** 範圍正中間，水平位置（網格放這裡） */
  center: XZ;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** 水平的正面方向（正規化；0 向量 → +Z）+ 觀眾面向舞台時他的右手邊 = (-front) × 上 = (fz, -fx) */
export function frontAxes(front: XZ): { fx: number; fz: number; rx: number; rz: number } {
  let fx = front.x, fz = front.z;
  const len = Math.hypot(fx, fz);
  if (len < 1e-9) { fx = 0; fz = 1; } else { fx /= len; fz /= len; }
  return { fx, fz, rx: fz, rz: -fx };
}

export function uvToWorld(front: XZ, u: number, v: number): XZ {
  const { fx, fz, rx, rz } = frontAxes(front);
  return { x: fx * u + rx * v, z: fz * u + rz * v };
}

/** 世界裡的外框（四個角）換成前後 / 左右的範圍 */
export function extentFromBox(box: Box3Like, front: XZ): UVExtent {
  const { fx, fz, rx, rz } = frontAxes(front);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) {
    const u = x * fx + z * fz, v = x * rx + z * rz;
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
  }
  return { uMin, uMax, vMin, vMax };
}

/**
 * 三個人形站的位置（水平）：舞台正面那一側的邊緣往內縮一點，左 / 中 / 右各一個。
 * 左右是觀眾看過去的左右（面朝舞台、前面 = 往觀眾那一側）。順序固定：左、中、右。
 */
export function figureSpotsFromExtent(e: UVExtent, front: XZ, unitsPerMeter: number): FigureSpot[] {
  const depth = e.uMax - e.uMin, width = e.vMax - e.vMin;
  const vc = (e.vMin + e.vMax) / 2;
  // 離前緣一小段（深度的 15%，至少 0.5 m、至多 1.5 m；太淺的舞台最多退到一半）
  const inset = Math.min(clamp(depth * 0.15, 0.5 * unitsPerMeter, 1.5 * unitsPerMeter), depth / 2);
  const u = e.uMax - inset;
  // 左右各離中間一段（寬度的 28%，至少 1 m、至多 8 m；窄的舞台不超出範圍）
  const side = Math.min(clamp(width * 0.28, 1 * unitsPerMeter, 8 * unitsPerMeter), width / 2);
  const at = (v: number, slot: FigureSlot): FigureSpot => ({ ...uvToWorld(front, u, v), slot });
  return [at(vc - side, 'left'), at(vc, 'center'), at(vc + side, 'right')];
}

/** 用世界裡的外框算站位（沒有舞台面可以用時的備案） */
export function pickFigureSpots(box: Box3Like, front: XZ, unitsPerMeter: number): FigureSpot[] {
  return figureSpotsFromExtent(extentFromBox(box, front), front, unitsPerMeter);
}

/** 沒有任何舞台物件時的位置（跟以前一樣：中間、左右各 3 m、離原點 1 m） */
export function defaultFigureSpots(unitsPerMeter: number): FigureSpot[] {
  return [
    { x: -3 * unitsPerMeter, z: 1 * unitsPerMeter, slot: 'left' },
    { x: 0, z: 1 * unitsPerMeter, slot: 'center' },
    { x: 3 * unitsPerMeter, z: 1 * unitsPerMeter, slot: 'right' },
  ];
}

/**
 * 舞台面是哪一層：朝上的面依高度（每 10 cm 一格，鄰近三格合併看）加總面積，最大的那一層。
 * 真的舞台地板是最大的水平面；桁架 / 屋頂的頂面面積小很多。沒有朝上的面 → null。
 * 回傳那一層的高度（面積加權平均）。
 */
export function findDeckLevel(faces: FaceSet, unitsPerMeter: number): number | null {
  if (faces.count === 0) return null;
  const bin = 0.1 * unitsPerMeter;
  const v = faces.verts;
  const key = (i: number) => Math.round(((v[9 * i + 1] + v[9 * i + 4] + v[9 * i + 7]) / 3) / bin);
  const area = new Map<number, number>();
  for (let i = 0; i < faces.count; i++) {
    const k = key(i);
    area.set(k, (area.get(k) ?? 0) + faces.areas[i]);
  }
  let bestKey = 0, best = -1;
  for (const k of area.keys()) {
    const sum = (area.get(k - 1) ?? 0) + (area.get(k) ?? 0) + (area.get(k + 1) ?? 0);
    if (sum > best || (sum === best && k > bestKey)) { best = sum; bestKey = k; }
  }
  if (best <= 0) return null;
  let wy = 0, w = 0;
  for (let i = 0; i < faces.count; i++) {
    if (Math.abs(key(i) - bestKey) > 1) continue;
    wy += ((v[9 * i + 1] + v[9 * i + 4] + v[9 * i + 7]) / 3) * faces.areas[i];
    w += faces.areas[i];
  }
  return w > 0 ? wy / w : bestKey * bin;
}

/** 加權分位數（用直方圖估，誤差 = 範圍 / 2048，這裡夠用） */
function weightedQuantiles(values: ArrayLike<number>, weights: ArrayLike<number>, n: number, qs: number[]): number[] {
  let lo = Infinity, hi = -Infinity, total = 0;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, values[i]); hi = Math.max(hi, values[i]); total += weights[i]; }
  if (n === 0 || total <= 0) return qs.map(() => 0);
  const BINS = 2048;
  const span = hi - lo || 1;
  const hist = new Float64Array(BINS);
  for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, Math.floor(((values[i] - lo) / span) * BINS))] += weights[i];
  return qs.map((q) => {
    const target = q * total;
    let cum = 0;
    for (let b = 0; b < BINS; b++) {
      if (hist[b] > 0 && cum + hist[b] >= target) return lo + ((b + (target - cum) / hist[b]) / BINS) * span;
      cum += hist[b];
    }
    return hi;
  });
}

/**
 * 舞台面那一層（level 上下 DECK_TOLERANCE_M）的範圍和重心。
 * 前後左右各取面積加權的 2% ～ 98%（頂點算），所以伸出去一小條的走道、零星的小台不會把「前緣」拉得很遠。
 */
export function deckFootprint(faces: FaceSet, level: number, front: XZ, unitsPerMeter: number): DeckFootprint | null {
  const { fx, fz, rx, rz } = frontAxes(front);
  const tol = DECK_TOLERANCE_M * unitsPerMeter;
  const v = faces.verts;
  const us: number[] = [], vs: number[] = [], ws: number[] = [];
  let cx = 0, cz = 0, total = 0;
  for (let i = 0; i < faces.count; i++) {
    const o = 9 * i;
    if (Math.abs((v[o + 1] + v[o + 4] + v[o + 7]) / 3 - level) > tol) continue;
    const a = faces.areas[i];
    for (let k = 0; k < 3; k++) {
      const x = v[o + 3 * k], z = v[o + 3 * k + 2];
      us.push(x * fx + z * fz); vs.push(x * rx + z * rz); ws.push(a / 3);
    }
    cx += ((v[o] + v[o + 3] + v[o + 6]) / 3) * a;
    cz += ((v[o + 2] + v[o + 5] + v[o + 8]) / 3) * a;
    total += a;
  }
  if (total <= 0) return null;
  const [uMin, uMax] = weightedQuantiles(us, ws, us.length, [0.02, 0.98]);
  const [vMin, vMax] = weightedQuantiles(vs, ws, vs.length, [0.02, 0.98]);
  const extent = { uMin, uMax, vMin, vMax };
  return {
    level,
    extent,
    centroid: { x: cx / total, z: cz / total },
    center: uvToWorld(front, (uMin + uMax) / 2, (vMin + vMax) / 2),
  };
}

/**
 * 從往下打光線打到的點，挑人形該站的高度：「幾乎水平朝上」的面裡最高的那一個。
 * 一個都沒有（光線沒打到、或打到的都是牆）→ fallbackY（外框最低點）。
 */
export function pickStandingY(hits: readonly DownHit[], fallbackY: number): number {
  let best = -Infinity;
  for (const h of hits) {
    if (h.normalY > STAND_MIN_NORMAL_Y && h.y > best) best = h.y;
  }
  return best === -Infinity ? fallbackY : best;
}

/** 網格：中心在舞台正中間（水平），高度 = 中間人形站的地面 */
export function gridCenter(center: XZ, deckY: number): { x: number; y: number; z: number } {
  return { x: center.x, y: deckY, z: center.z };
}
