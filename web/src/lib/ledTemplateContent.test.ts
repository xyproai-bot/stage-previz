import { describe, expect, it } from 'vitest';
import { mapUvToTemplate, ROTATIONS, type Placement, type Rotation, type SrcSpan } from './ledTemplate';
import { applyMatrix, upDirection } from './ledTemplatePattern';
import type { PixelRect } from './ledMap';
import { axisPieces, contentPieces, intersectsView, invertMatrix, layoutFromSpans, worthDrawing } from './ledTemplateContent';

const FLIPS: [boolean, boolean][] = [[false, false], [true, false], [false, true], [true, true]];

function placementOf(_span: SrcSpan, dest: PixelRect, rotate: Rotation, flipH: boolean, flipV: boolean): Placement {
  return { key: 'o:a', objectId: 'a', uv: null, dest, rotate, flipH, flipV };
}

describe('axisPieces（一個軸上取哪幾段）', () => {
  it('沒跨接縫 = 一段', () => {
    expect(axisPieces(0.25, 0.5, 400)).toEqual([{ from: 100, to: 300, offset: 0 }]);
  });
  it('整條、從 0 開始 = 一段', () => {
    expect(axisPieces(0, 1, 400)).toEqual([{ from: 0, to: 400, offset: 0 }]);
  });
  it('跨右邊接縫 = 兩段，後一段從 0 開始、offset = 畫布大小', () => {
    const p = axisPieces(0.75, 0.5, 400);
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual({ from: 300, to: 400, offset: 0 });
    expect(p[1].from).toBe(0);
    expect(p[1].to).toBeCloseTo(100, 6);
    expect(p[1].offset).toBe(400);
  });
  it('整條但不是從 0 開始 = 還是兩段（接縫在中間）', () => {
    const p = axisPieces(0.25, 1, 400);
    expect(p.map(x => [x.from, x.to])).toEqual([[100, 400], [0, 100]]);
  });
  it('剛好貼到右邊不多切一段（浮點誤差也不會）', () => {
    expect(axisPieces(0.6, 0.4, 400)).toHaveLength(1);
    expect(axisPieces(0.7, 0.3, 4400)).toHaveLength(1);
  });
  it('寬度 0 或畫布 0 = 沒有', () => {
    expect(axisPieces(0.2, 0, 400)).toEqual([]);
    expect(axisPieces(0.2, 0.5, 0)).toEqual([]);
  });
});

describe('contentPieces：畫出來的方向跟 LED 對應（mapUvToTemplate）一模一樣', () => {
  const FULL = { width: 400, height: 240 };
  const TPL = { width: 1000, height: 600 };
  const dest: PixelRect = { x: 130, y: 70, w: 200, h: 90 };
  const spans: Record<string, SrcSpan> = {
    '一般': { us: 0.1, ul: 0.4, vs: 0.2, vl: 0.5 },
    '貼著右下': { us: 0.6, ul: 0.4, vs: 0.5, vl: 0.5 },
    '左右跨接縫': { us: 0.8, ul: 0.35, vs: 0.1, vl: 0.3 },
    '上下跨接縫': { us: 0.2, ul: 0.3, vs: 0.85, vl: 0.3 },
    '兩邊都跨': { us: 0.9, ul: 0.25, vs: 0.8, vl: 0.4 },
  };

  for (const [name, span] of Object.entries(spans)) {
    for (const rotate of ROTATIONS) {
      for (const [flipH, flipV] of FLIPS) {
        it(`${name}：轉 ${rotate}°${flipH ? ' 左右翻' : ''}${flipV ? ' 上下翻' : ''}`, () => {
          const p = placementOf(span, dest, rotate, flipH, flipV);
          const pieces = contentPieces(span, FULL, p);
          expect(pieces.length).toBeGreaterThan(0);
          let checked = 0;
          for (const lx of [0.08, 0.5, 0.93]) {
            for (const ly of [0.1, 0.5, 0.9]) {
              // LED 上的一點（整張畫布 UV，會繞回）
              const u = (span.us + lx * span.ul) % 1;
              const v = (span.vs + ly * span.vl) % 1;
              const expected = mapUvToTemplate(p, span, TPL, u, v);
              expect(expected).not.toBeNull();
              const px = u * FULL.width, py = v * FULL.height;
              const piece = pieces.find(s => px >= s.src.x - 1e-6 && px <= s.src.x + s.src.w + 1e-6 && py >= s.src.y - 1e-6 && py <= s.src.y + s.src.h + 1e-6);
              expect(piece, `(${px}, ${py}) 沒有落在任何一塊`).toBeTruthy();
              const [X, Y] = applyMatrix(piece!.matrix, px, py);
              expect(X).toBeCloseTo(expected![0] * TPL.width, 5);
              expect(Y).toBeCloseTo(expected![1] * TPL.height, 5);
              checked++;
            }
          }
          expect(checked).toBe(9);
        });
      }
    }
  }

  it('所有塊拼起來剛好蓋滿框（不多不少）', () => {
    for (const span of Object.values(spans)) {
      for (const rotate of ROTATIONS) {
        const pieces = contentPieces(span, FULL, { dest, rotate, flipH: false, flipV: true });
        let area = 0;
        for (const s of pieces) {
          // 塊的四個角擺進版型後的面積
          const c = [[s.src.x, s.src.y], [s.src.x + s.src.w, s.src.y], [s.src.x + s.src.w, s.src.y + s.src.h]].map(([x, y]) => applyMatrix(s.matrix, x, y));
          area += Math.abs((c[1][0] - c[0][0]) * (c[2][1] - c[1][1]) - (c[1][1] - c[0][1]) * (c[2][0] - c[1][0]));
        }
        expect(area).toBeCloseTo(dest.w * dest.h, 3);
      }
    }
  });

  it('螢幕的「上」在框裡指的方向，跟編輯器的箭頭（upDirection）一樣', () => {
    const span = spans['一般'];
    for (const rotate of ROTATIONS) {
      for (const [flipH, flipV] of FLIPS) {
        const [piece] = contentPieces(span, FULL, { dest, rotate, flipH, flipV });
        // 螢幕本地 (0, -1)（往上）在畫布圖上是 (0, -len)；用矩陣的線性部分轉過去
        const lenY = span.vl * FULL.height;
        const o = applyMatrix(piece.matrix, piece.src.x, piece.src.y);
        const up = applyMatrix(piece.matrix, piece.src.x, piece.src.y - lenY);
        const dx = Math.sign(Math.round(up[0] - o[0])), dy = Math.sign(Math.round(up[1] - o[1]));
        const want = upDirection(rotate, flipH, flipV);
        expect([dx + 0, dy + 0]).toEqual([want.dx, want.dy]);
      }
    }
  });

  it('不轉不翻：螢幕的左上角 = 框的左上角；轉 90°（順時針）：螢幕的左上角跑到框的右上角', () => {
    const span = spans['一般'];
    const sx = span.us * FULL.width, sy = span.vs * FULL.height;
    const [a] = contentPieces(span, FULL, { dest, rotate: 0, flipH: false, flipV: false });
    expect(applyMatrix(a.matrix, sx, sy)).toEqual([dest.x, dest.y]);
    const [b] = contentPieces(span, FULL, { dest, rotate: 90, flipH: false, flipV: false });
    const tl = applyMatrix(b.matrix, sx, sy);
    expect(tl[0]).toBeCloseTo(dest.x + dest.w, 6);
    expect(tl[1]).toBeCloseTo(dest.y, 6);
    const [c] = contentPieces(span, FULL, { dest, rotate: 0, flipH: true, flipV: false });
    const tr = applyMatrix(c.matrix, sx, sy);
    expect(tr[0]).toBeCloseTo(dest.x + dest.w, 6);
    expect(tr[1]).toBeCloseTo(dest.y, 6);
  });
});

describe('contentPieces：把整張畫布當一張小圖逐像素畫一遍，再照 LED 的對應讀回來，每個像素都是自己', () => {
  const FULL = { width: 24, height: 16 };
  const TPL = { width: 40, height: 30 };
  const value = (x: number, y: number) => x + 1000 * y;

  // 軟體版的「畫進框裡」：框裡每個像素中心反推回整張畫布的哪個像素
  function rasterize(span: SrcSpan, rotate: Rotation, flipH: boolean, flipV: boolean, nativeW: number, nativeH: number) {
    const swap = rotate === 90 || rotate === 270;
    const dest: PixelRect = { x: 5, y: 7, w: swap ? nativeH : nativeW, h: swap ? nativeW : nativeH };
    const pieces = contentPieces(span, FULL, { dest, rotate, flipH, flipV });
    const img = new Map<string, number>();
    for (let Y = dest.y; Y < dest.y + dest.h; Y++) {
      for (let X = dest.x; X < dest.x + dest.w; X++) {
        for (const s of pieces) {
          const inv = invertMatrix(s.matrix)!;
          const [sx, sy] = applyMatrix(inv, X + 0.5, Y + 0.5);
          if (sx >= s.src.x && sx < s.src.x + s.src.w && sy >= s.src.y && sy < s.src.y + s.src.h) {
            img.set(`${X},${Y}`, value(Math.floor(sx), Math.floor(sy)));
          }
        }
      }
    }
    return { dest, img };
  }

  const cases: [string, SrcSpan, number, number][] = [
    ['一般', { us: 6 / 24, ul: 8 / 24, vs: 4 / 16, vl: 6 / 16 }, 8, 6],
    ['兩邊都跨接縫', { us: 20 / 24, ul: 8 / 24, vs: 12 / 16, vl: 6 / 16 }, 8, 6],
  ];

  for (const [name, span, nw, nh] of cases) {
    for (const rotate of ROTATIONS) {
      for (const [flipH, flipV] of FLIPS) {
        it(`${name}：轉 ${rotate}°${flipH ? ' 左右翻' : ''}${flipV ? ' 上下翻' : ''}`, () => {
          const { dest, img } = rasterize(span, rotate, flipH, flipV, nw, nh);
          const p = placementOf(span, dest, rotate, flipH, flipV);
          // 框裡每個像素都有畫到
          expect(img.size).toBe(dest.w * dest.h);
          // LED 上每個像素：照 mapUvToTemplate 去版型圖上讀，讀到的就是整張畫布上的那個像素
          for (let j = 0; j < nh; j++) {
            for (let i = 0; i < nw; i++) {
              const px = (Math.round(span.us * FULL.width) + i) % FULL.width;
              const py = (Math.round(span.vs * FULL.height) + j) % FULL.height;
              const t = mapUvToTemplate(p, span, TPL, (px + 0.5) / FULL.width, (py + 0.5) / FULL.height);
              expect(t).not.toBeNull();
              const tx = Math.floor(t![0] * TPL.width), ty = Math.floor(t![1] * TPL.height);
              expect(img.get(`${tx},${ty}`), `LED (${px}, ${py}) → 版型 (${tx}, ${ty})`).toBe(value(px, py));
            }
          }
        });
      }
    }
  }
});

describe('invertMatrix / 畫面判斷', () => {
  it('反運算接回原本的點；壓扁的矩陣 = null', () => {
    const m: [number, number, number, number, number, number] = [0, 2, -3, 0, 10, 20];
    const inv = invertMatrix(m)!;
    const [x, y] = applyMatrix(m, 4, 5);
    const [bx, by] = applyMatrix(inv, x, y);
    expect(bx).toBeCloseTo(4, 9);
    expect(by).toBeCloseTo(5, 9);
    expect(invertMatrix([1, 2, 2, 4, 0, 0])).toBeNull();
  });
  it('太小的框不畫；在畫面外的框不畫', () => {
    expect(worthDrawing({ x: 0, y: 0, w: 100, h: 100 }, 0.01)).toBe(false);
    expect(worthDrawing({ x: 0, y: 0, w: 100, h: 100 }, 0.5)).toBe(true);
    const view = { zoom: 1, panX: 0, panY: 0 };
    expect(intersectsView({ x: 10, y: 10, w: 50, h: 50 }, view, { w: 300, h: 200 })).toBe(true);
    expect(intersectsView({ x: 400, y: 10, w: 50, h: 50 }, view, { w: 300, h: 200 })).toBe(false);
    expect(intersectsView({ x: -80, y: 10, w: 50, h: 50 }, view, { w: 300, h: 200 })).toBe(false);
  });
});

describe('layoutFromSpans：用每個物件的範圍重建整張畫布的 LED 排法', () => {
  const canvas = { width: 1000, height: 400 };
  const objs = [
    { id: 'b', name: '右幕', order: 2 },
    { id: 'a', name: '左幕', order: 1 },
    { id: 'c', name: '沒有 UV', order: 3 },
  ];
  const spans = {
    a: { us: 0.1, ul: 0.2, vs: 0.25, vl: 0.5 },
    b: { us: 0.85, ul: 0.3, vs: 0, vl: 1 },
  };
  const layout = layoutFromSpans(objs, spans, canvas);

  it('照物件順序排、沒有範圍的跳過', () => {
    expect(layout.panels.map(p => p.name)).toEqual(['左幕', '右幕']);
  });
  it('位置 = 範圍乘上畫布大小', () => {
    expect(layout.panels[0].rect).toEqual({ x: 100, y: 100, w: 200, h: 200 });
    expect(layout.panels[0].wrapsX).toBe(false);
  });
  it('跨左右接縫的範圍還是跨接縫，起點和寬度不變', () => {
    const r = layout.panels[1];
    expect(r.wrapsX).toBe(true);
    expect(r.rect.x).toBe(850);
    expect(r.rect.w).toBe(300);
  });
  it('用重建出來的排法找到的範圍，跟原本的範圍一致（版型編輯器取的就是同一段）', () => {
    for (const p of layout.panels) {
      const id = p.name === '左幕' ? 'a' : 'b';
      const s = spans[id as 'a' | 'b'];
      expect(p.u.start).toBeCloseTo(s.us, 9);
      expect(p.u.length).toBeCloseTo(s.ul, 9);
      expect(p.v.start).toBeCloseTo(s.vs, 9);
      expect(p.v.length).toBeCloseTo(s.vl, 9);
    }
  });
});
