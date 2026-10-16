// 自動貼 UV：照舞台的樣子排版（純函式）
//
// 規則（製作的決定：「照舞台的樣子排」，畫布大一點沒關係）：
//   - 左邊的螢幕排在左邊、上面的排在上面（左右是站在觀眾席看過去的左右）
//   - 牆上的螢幕依高度分成幾排，上面那排在畫布上方；同一排由左到右
//   - 躺在地上的螢幕（地屏）另外一組放在最下面，依深度分排：離觀眾越遠的排越上面
//   - 每一排在畫布裡置中；排與排之間、螢幕之間的間隔 = gutter（預設 0）
//   - 畫布寬高都無條件進位到 roundTo 的倍數（預設 8，HEVC 喜歡偶數）
// 同樣的輸入永遠排出一樣的結果（沒有亂數；平手時依名字、鍵值排序）。

import type { Rotation } from '../ledTemplate';

export interface PackItem {
  /** 唯一的代號（螢幕片或保留的物件） */
  key: string;
  name: string;
  /** 畫布上的大小（點） */
  w: number;
  h: number;
  /** 舞台上的位置（世界座標，單位不重要，只比大小）：x = 觀眾席看過去由左到右、y = 高度、d = 離觀眾多遠（越大越靠近觀眾） */
  x: number;
  y: number;
  d: number;
  /** 舞台上的高度範圍 / 深度範圍（分排用） */
  yRange: [number, number];
  dRange: [number, number];
  /** 躺在地上（地屏）：true 的排在牆的下面，依深度分排 */
  floor: boolean;
}

export interface Placed { x: number; y: number; w: number; h: number; rotate: Rotation; flipH: boolean; flipV: boolean }

export interface PackOptions {
  gutter?: number;
  roundTo?: number;
}

export interface PackResult {
  canvas: { width: number; height: number };
  placed: Map<string, Placed>;
  /** 排的順序（給表格用）：由上到下、由左到右 */
  order: string[];
  rows: number;
}

const roundUp = (n: number, m: number): number => (m <= 1 ? n : Math.ceil(n / m) * m);

interface Row { items: PackItem[]; v: number; vh: number }

/** 把一群東西依「垂直位置」分排：中心點相差不超過 (較小那個高度的一半) 就同一排 */
function groupRows(items: PackItem[], vOf: (i: PackItem) => number, hOf: (i: PackItem) => number): Row[] {
  const sorted = [...items].sort((a, b) => vOf(b) - vOf(a) || a.x - b.x || a.key.localeCompare(b.key));
  const rows: Row[] = [];
  for (const it of sorted) {
    const v = vOf(it), h = hOf(it);
    const row = rows.find(r => Math.abs(v - r.v) <= 0.5 * Math.min(h, r.vh) + 1e-9);
    if (row) row.items.push(it);
    else rows.push({ items: [it], v, vh: h });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x || a.key.localeCompare(b.key));
  return rows;
}

export function packStageShaped(items: readonly PackItem[], opts: PackOptions = {}): PackResult {
  const gutter = Math.max(0, Math.round(opts.gutter ?? 0));
  const roundTo = Math.max(1, Math.round(opts.roundTo ?? 8));
  const walls = items.filter(i => !i.floor);
  const floors = items.filter(i => i.floor);
  const rows: Row[] = [
    ...groupRows(walls, i => i.y, i => i.yRange[1] - i.yRange[0]),
    // 地屏：離觀眾越遠（d 越小）越上面 → 用 -d 當「高度」
    ...groupRows(floors, i => -i.d, i => i.dRange[1] - i.dRange[0]),
  ];

  const lines: PackItem[][] = rows.map(r => r.items);
  const lineW = lines.map(l => l.reduce((s, i) => s + i.w, 0) + gutter * Math.max(0, l.length - 1));
  const lineH = lines.map(l => l.reduce((m, i) => Math.max(m, i.h), 0));
  const contentW = lineW.reduce((m, w) => Math.max(m, w), 0);
  const contentH = lineH.reduce((s, h) => s + h, 0) + gutter * Math.max(0, lines.length - 1);
  const width = items.length ? roundUp(contentW, roundTo) : 0;
  const height = items.length ? roundUp(contentH, roundTo) : 0;

  const placed = new Map<string, Placed>();
  const order: string[] = [];
  let y = 0;
  lines.forEach((line, li) => {
    let x = Math.floor((width - lineW[li]) / 2);
    for (const it of line) {
      placed.set(it.key, { x, y: y + Math.floor((lineH[li] - it.h) / 2), w: it.w, h: it.h, rotate: 0, flipH: false, flipV: false });
      order.push(it.key);
      x += it.w + gutter;
    }
    y += lineH[li] + gutter;
  });
  return { canvas: { width, height }, placed, order, rows: lines.length };
}

/** 排好的長方形有沒有互相重疊或超出畫布（測試、畫面提醒用） */
export function layoutProblems(result: Pick<PackResult, 'canvas' | 'placed'>): string[] {
  const out: string[] = [];
  const list = [...result.placed.entries()];
  for (const [k, p] of list) {
    if (p.x < 0 || p.y < 0 || p.x + p.w > result.canvas.width || p.y + p.h > result.canvas.height) out.push(`${k} 超出畫布`);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i][1], b = list[j][1];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${list[i][0]} 和 ${list[j][0]} 重疊`);
    }
  }
  return out;
}
