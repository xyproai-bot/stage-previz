// LED 版型編輯器：每塊螢幕的框裡畫「對位圖內容」（整張畫布的測試圖裡屬於這塊螢幕的那一段）。
// 這個檔案只算數字（不碰 canvas）：整張畫布的哪一段（可能跨接縫，所以最多 4 塊）、怎麼擺進框裡。
// 擺法跟 3D 的 LED 貼圖對應（ledTemplate.ts 的 uvToLocal / localTransform / mapUvToTemplate，shader 也是同一組）一模一樣：
//   整張畫布上的一點 → 螢幕本地座標 (0~1) → 轉動、翻轉 → 版型畫布上的框裡。
// 所以編輯器框裡看到的內容，就是把版型畫面貼回舞台後這塊 LED 上會出現的內容。
// 真的拿 canvas 畫在 lib/ledTemplateContentDraw.ts。

import { buildLedLayout, layoutPanel, panelColor, panelHue, type CanvasSize, type LedLayout, type PixelRect } from './ledMap';
import { localTransform, parseScreenKey, type Rotation, type ScreenDef, type SrcSpan } from './ledTemplate';
import type { Matrix6 } from './ledTemplatePattern';

/** 一塊來源：整張畫布圖上的一個長方形（畫布像素，一定在畫布裡）+ 把它擺進版型畫布的矩陣（畫布像素 → 版型畫布像素） */
export interface ContentPiece {
  src: PixelRect;
  matrix: Matrix6;
}

/** 螢幕在版型裡的放法（Placement / PlacementInput 都吃得下） */
export interface ContentPlacement {
  dest: PixelRect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
}

/** 一個軸上的一段：[from, to] 是畫布像素（在 0~size 裡），offset = 加上它才是「從螢幕起點算起、沒繞回」的位置 */
interface AxisPiece { from: number; to: number; offset: number }

const EPS = 1e-6;

/** 範圍 (start, length 都是 0~1 的比例) 放到 size 像素的軸上；跨過 0 / 1 接縫就切成兩段 */
export function axisPieces(start: number, length: number, size: number): AxisPiece[] {
  if (!(size > 0) || !(length > 0)) return [];
  const s = start - Math.floor(start);
  const x0 = s * size;
  const len = Math.min(1, length) * size;
  const x1 = x0 + len;
  if (x1 <= size + EPS) return [{ from: x0, to: Math.min(x1, size), offset: 0 }];
  const out: AxisPiece[] = [{ from: x0, to: size, offset: 0 }];
  if (x1 - size > EPS) out.push({ from: 0, to: x1 - size, offset: size });
  return out.filter(p => p.to - p.from > EPS);
}

/**
 * 這塊螢幕在整張畫布圖上要取的幾塊（沒跨接縫 = 1 塊，跨左右或上下 = 2 塊，兩個都跨 = 4 塊），
 * 每塊附一個矩陣：整張畫布上的像素 → 版型畫布上的像素。
 *
 *   螢幕本地座標 l = (畫布像素 - 螢幕起點) / 螢幕大小      （跟 uvToLocal 一樣，會繞回）
 *   版型上的位置 t = A·l + b                                 （localTransform：先轉再翻）
 *   版型畫布像素 = dest.xy + t × dest.wh
 */
export function contentPieces(span: SrcSpan, full: CanvasSize, p: ContentPlacement): ContentPiece[] {
  const lenX = span.ul * full.width, lenY = span.vl * full.height;
  if (!(lenX > 0) || !(lenY > 0)) return [];
  const x0 = (span.us - Math.floor(span.us)) * full.width;
  const y0 = (span.vs - Math.floor(span.vs)) * full.height;
  const t = localTransform(p.rotate, p.flipH, p.flipV);
  const { dest } = p;
  const out: ContentPiece[] = [];
  for (const ax of axisPieces(span.us, span.ul, full.width)) {
    for (const ay of axisPieces(span.vs, span.vl, full.height)) {
      // 沒繞回的螢幕本地像素：lx = px + ax.offset - x0
      const kx = ax.offset - x0, ky = ay.offset - y0;
      out.push({
        src: { x: ax.from, y: ay.from, w: ax.to - ax.from, h: ay.to - ay.from },
        matrix: [
          (dest.w * t.a[0]) / lenX, (dest.h * t.a[2]) / lenX,
          (dest.w * t.a[1]) / lenY, (dest.h * t.a[3]) / lenY,
          dest.x + dest.w * (t.b[0] + (t.a[0] * kx) / lenX + (t.a[1] * ky) / lenY),
          dest.y + dest.h * (t.b[1] + (t.a[2] * kx) / lenX + (t.a[3] * ky) / lenY),
        ],
      });
    }
  }
  return out;
}

/** 矩陣的反運算（版型畫布像素 → 整張畫布像素）；壓扁的矩陣 = null */
export function invertMatrix(m: Matrix6): Matrix6 | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    d / det, -b / det,
    -c / det, a / det,
    (c * f - d * e) / det, (b * e - a * f) / det,
  ];
}

/** 版面上放得下就畫：框在畫面上小於 2 個像素的不畫 */
export function worthDrawing(dest: PixelRect, zoom: number): boolean {
  return dest.w * zoom >= 2 && dest.h * zoom >= 2;
}

/** 框跟畫面（host 的大小）有沒有交集：沒有就不用畫（拉得很近的時候大部分的框在畫面外） */
export function intersectsView(dest: PixelRect, view: { zoom: number; panX: number; panY: number }, size: { w: number; h: number }): boolean {
  const x0 = dest.x * view.zoom + view.panX, y0 = dest.y * view.zoom + view.panY;
  return x0 < size.w && y0 < size.h && x0 + dest.w * view.zoom > 0 && y0 + dest.h * view.zoom > 0;
}

// ───────────────────────── 整張畫布的 LED 排法（從每個物件的範圍來）─────────────────────────

export interface SpanObject { id: string; name: string; order: number }

/** 範圍 → 兩個三角形（蓋滿整個長方形；會繞回的範圍往 1 以上延伸，layoutPanel 會自己繞回來） */
export function spanTriangles(span: SrcSpan): number[] {
  const u0 = span.us, u1 = span.us + span.ul, v0 = span.vs, v1 = span.vs + span.vl;
  return [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
}

/**
 * 整張畫布的 LED 排法，用「每個 LED 物件在整張畫布上的範圍」重建（編輯器已經向 3D 畫面要過這份範圍，不用再多問一次）：
 * 每個物件當成它範圍的長方形，順序和上色跟 3D 一樣（物件順序 → 名字）。跟 3D 真正的排法差在：
 * 不是長方形的 LED（斜的、缺角的）這裡當整個外框，測試圖畫滿框。沒有範圍的物件（沒有 UV）跳過，跟 3D 一樣。
 */
export function layoutFromSpans(objects: readonly SpanObject[], spans: Readonly<Record<string, SrcSpan>>, canvas: CanvasSize): LedLayout {
  const inputs = [...objects]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .filter(o => !!spans[o.id])
    .map(o => ({ id: o.id, name: o.name, tris: spanTriangles(spans[o.id]) }));
  return buildLedLayout(inputs, canvas);
}

/**
 * 一個物件裡有好幾塊 LED（螢幕代號 o:物件id~mesh名稱）或手動切成好幾塊（s:螢幕id）時，整張畫布的測試圖也要一塊一塊各自畫：
 * 把這個物件那一個整體的格子，換成每塊 LED 各自一格（自己的外框顏色、名稱、x y w h、角落座標），
 * 這樣每塊取出來的圖是完整的一張，不是物件那張圖被切開。沒有被拆的物件原封不動；沒有任何物件被拆 = 原樣回傳。
 * 顏色照換完以後的順序重新分。
 */
export function splitLayoutByScreens(layout: LedLayout, defs: readonly ScreenDef[]): LedLayout {
  const partsOf = new Map<string, ScreenDef[]>();
  for (const d of defs) {
    const k = parseScreenKey(d.key);
    // 物件裡的一塊 LED mesh（o:物件id~mesh名稱），或手動切的螢幕（s:螢幕id，自動貼 UV 套用後切出來的也是這種）
    if (!k || (k.kind === 'object' && k.part === undefined)) continue;
    const id = k.kind === 'object' ? k.id : d.objectId;
    const list = partsOf.get(id);
    if (list) list.push(d); else partsOf.set(id, [d]);
  }
  if (partsOf.size === 0) return layout;
  let changed = false;
  const panels: LedLayout['panels'] = [];
  for (const p of layout.panels) {
    const parts = partsOf.get(p.id);
    if (!parts) { panels.push(p); continue; }
    const made = parts
      .map(d => layoutPanel({ id: d.key, name: d.name, tris: spanTriangles(d.src) }, layout.canvas, 0))
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (made.length === 0) { panels.push(p); continue; }
    changed = true;
    panels.push(...made);
  }
  if (!changed) return layout;
  return { ...layout, panels: panels.map((p, i) => ({ ...p, hue: panelHue(i), color: panelColor(i) })) };
}
