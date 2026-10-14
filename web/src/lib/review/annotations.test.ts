import { describe, expect, it } from 'vitest';
import {
  ANN_COLORS, MAX_SHAPES, MAX_PEN_POINTS, annotationSummary, arrowHead, capPoints, containBox, drawAnnotation, fitFov,
  makeShape, parseAnnotation, serializeAnnotation, shapePath, simplifyPath, strokePx, toNormalized, type AnnShape, type Canvas2DLike,
} from './annotations';

const rect = { left: 100, top: 50, width: 800, height: 450 };

describe('畫記：座標換成 0~1（跟螢幕大小無關）', () => {
  it('滑鼠位置 → 0~1，超出去的夾在邊上', () => {
    expect(toNormalized(100, 50, rect)).toEqual([0, 0]);
    expect(toNormalized(500, 275, rect)).toEqual([0.5, 0.5]);
    expect(toNormalized(2000, -10, rect)).toEqual([1, 0]);
    expect(toNormalized(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual([0, 0]);
  });
  it('同一個地方在大螢幕、小螢幕畫，存起來一樣', () => {
    const big = toNormalized(1000, 300, { left: 0, top: 0, width: 2000, height: 1200 });
    const small = toNormalized(250, 75, { left: 0, top: 0, width: 500, height: 300 });
    expect(big).toEqual(small);
  });
});

describe('畫記：形狀', () => {
  it('箭頭 / 方框 / 圓圈只留頭尾兩點、四捨五入到 4 位', () => {
    const s = makeShape('arrow', '#ff3b30', [0.1, 0.2, 0.3, 0.3, 0.512345, 0.6], 16 / 9);
    expect(s).toEqual({ t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.1, 0.2, 0.5123, 0.6] });
    expect(makeShape('rect', '#ffcc00', [0.6, 0.6, 0.2, 0.1])!.p).toEqual([0.6, 0.6, 0.2, 0.1]);
  });
  it('點一下（太小）的方框 / 圓圈 / 箭頭不算', () => {
    expect(makeShape('ellipse', '#ff3b30', [0.5, 0.5, 0.501, 0.501])).toBeNull();
    expect(makeShape('arrow', '#ff3b30', [0.5, 0.5])).toBeNull();
  });
  it('筆：一個點也算（畫成小圓點）；不認得的顏色換成紅色', () => {
    expect(makeShape('pen', '#123456', [0.4, 0.4])).toEqual({ t: 'pen', c: '#ff3b30', w: 0.006, p: [0.4, 0.4] });
  });
  it('筆：直線上的點化簡掉，轉彎的點留著', () => {
    const line = Array.from({ length: 50 }, (_, i) => [i / 49, 0.5]).flat();
    expect(simplifyPath(line)).toEqual([0, 0.5, 1, 0.5]);
    const corner = [0, 0, 0.25, 0, 0.5, 0, 0.5, 0.25, 0.5, 0.5];
    expect(simplifyPath(corner)).toEqual([0, 0, 0.5, 0, 0.5, 0.5]);
  });
  it('筆：點太多 → 平均挑、頭尾留著', () => {
    const many = Array.from({ length: 1000 }, (_, i) => [i / 999, (i % 7) / 7]).flat();
    const capped = capPoints(many, MAX_PEN_POINTS);
    expect(capped.length).toBe(MAX_PEN_POINTS * 2);
    expect(capped.slice(0, 2)).toEqual(many.slice(0, 2));
    expect(capped.slice(-2)).toEqual(many.slice(-2));
    const zig = Array.from({ length: 1200 }, (_, i) => [i / 1199, i % 2 ? 0.2 : 0.8]).flat();
    expect(makeShape('pen', '#ffffff', zig)!.p.length).toBeLessThanOrEqual(MAX_PEN_POINTS * 2);
  });
});

describe('畫記：存起來 / 讀回來', () => {
  const shapes: AnnShape[] = [
    { t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.1, 0.1, 0.4, 0.3] },
    { t: 'ellipse', c: '#34c759', w: 0.006, p: [0.5, 0.5, 0.7, 0.8] },
  ];
  it('沒有形狀 = 不存', () => {
    expect(serializeAnnotation([], 1.7)).toBeNull();
  });
  it('存起來 → 讀回來一樣；後台也收這個格式', () => {
    const a = serializeAnnotation(shapes, 1.777777)!;
    expect(a).toEqual({ v: 1, aspect: 1.7778, shapes });
    expect(parseAnnotation(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });
  it('記下畫的那一格（打開留言時先停在這裡）', () => {
    const a = serializeAnnotation(shapes, 1.5, 9.04)!;
    expect(a.t).toBe(9.04);
    expect(parseAnnotation(JSON.parse(JSON.stringify(a)))!.t).toBe(9.04);
    expect(serializeAnnotation(shapes, 1.5, null)!.t).toBeUndefined();
  });
  it('超過上限的拿掉後面的', () => {
    const lots = Array.from({ length: MAX_SHAPES + 5 }, () => shapes[0]);
    expect(serializeAnnotation(lots, 1.5)!.shapes.length).toBe(MAX_SHAPES);
  });
  it('壞掉的資料：壞的那筆跳過，全部壞掉 = null', () => {
    expect(parseAnnotation(null)).toBeNull();
    expect(parseAnnotation({ aspect: 1.5, shapes: [{ t: 'star', c: '#ff3b30', w: 0.006, p: [0, 0, 1, 1] }] })).toBeNull();
    const mixed = parseAnnotation({ aspect: 1.5, shapes: [{ t: 'rect', c: '#FFFFFF', w: 0.006, p: [0, 0, 1, 1] }, { t: 'rect', c: 'pink', w: 0.006, p: [0, 0, 1, 1] }] });
    expect(mixed!.shapes).toEqual([{ t: 'rect', c: '#ffffff', w: 0.006, p: [0, 0, 1, 1] }]);
    expect(parseAnnotation({ aspect: 99, shapes })).toBeNull();
  });
  it('調色盤：紅色是第一個（預設）', () => {
    expect(ANN_COLORS[0].value).toBe('#ff3b30');
    expect(annotationSummary(serializeAnnotation(shapes, 1.5))).toBe('畫記 2 筆');
    expect(annotationSummary(null)).toBe('');
  });
});

describe('打開留言時畫面比例不一樣（手機 / iPad / 另一台電腦）', () => {
  it('寬的畫面：上下貼齊、左右留邊', () => {
    expect(containBox(2000, 1000, 1.5)).toEqual({ left: 250, top: 0, width: 1500, height: 1000 });
  });
  it('窄的畫面：左右貼齊、上下留邊', () => {
    expect(containBox(400, 800, 2)).toEqual({ left: 0, top: 300, width: 400, height: 200 });
  });
  it('一樣比例：整個畫面', () => {
    expect(containBox(1600, 900, 16 / 9)).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
  });
  it('窄的畫面要把鏡頭角度放大，左右才看得到當時的東西；寬的不用改', () => {
    expect(fitFov(50, 16 / 9, 2.2)).toBe(50);
    const wider = fitFov(50, 16 / 9, 0.5);
    // 左右看得到的範圍一樣：tan(新/2) × 新比例 = tan(舊/2) × 舊比例
    const half = (d: number) => Math.tan((d * Math.PI) / 360);
    expect(half(wider) * 0.5).toBeCloseTo(half(50) * (16 / 9), 6);
    expect(fitFov(50, null, 0.5)).toBe(50);
  });
  it('疊上去的畫記剛好對到當時同一個地方（畫面窄、角度放大之後）', () => {
    // 當時 16:9、fov 50；現在 9:16 的手機
    const saved = 16 / 9, now = 9 / 16, fov = 50;
    const box = containBox(900, 1600, saved);
    const nf = fitFov(fov, saved, now);
    // 當時畫面右上角那一點（x=1, y=0）在 3D 的方向：tan 值
    const tx = Math.tan((fov * Math.PI) / 360) * saved, ty = Math.tan((fov * Math.PI) / 360);
    // 現在的鏡頭看到這個方向會投影到螢幕的哪裡
    const sx = 450 + (tx / (Math.tan((nf * Math.PI) / 360) * now)) * 450;
    const sy = 800 - (ty / Math.tan((nf * Math.PI) / 360)) * 800;
    expect(sx).toBeCloseTo(box.left + box.width, 3);
    expect(sy).toBeCloseTo(box.top, 3);
  });
});

describe('畫出來（SVG / 縮圖）', () => {
  it('SVG path：方框、箭頭（含頭）、圓圈、筆', () => {
    expect(shapePath({ t: 'rect', c: '#ff3b30', w: 0.006, p: [0.5, 0.5, 0.1, 0.1] }, 100, 50)).toBe('M10 5H50V25H10Z');
    const a = shapePath({ t: 'arrow', c: '#ff3b30', w: 0.006, p: [0, 0, 1, 0] }, 100, 100);
    expect(a.startsWith('M0 0L100 0M')).toBe(true);
    expect(shapePath({ t: 'ellipse', c: '#ff3b30', w: 0.006, p: [0, 0, 1, 1] }, 100, 100)).toContain('A50 50');
    expect(shapePath({ t: 'pen', c: '#ff3b30', w: 0.006, p: [0, 0, 0.5, 0.5, 1, 0] }, 10, 10)).toBe('M0 0L5 5L10 0');
  });
  it('箭頭的頭在終點兩邊', () => {
    const [l, tip, r] = arrowHead(0, 0, 100, 0, 10);
    expect(tip).toEqual([100, 0]);
    expect(l[0]).toBeLessThan(100);
    expect(l[1]).toBeCloseTo(-r[1], 6);
  });
  it('線的粗細跟畫面高度走，至少 1.5 px', () => {
    expect(strokePx(0.006, 1000)).toBe(6);
    expect(strokePx(0.006, 100)).toBe(1.5);
  });
  it('縮圖：每一筆都畫到 2D 畫布上', () => {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push('save'), restore: () => calls.push('restore'), beginPath: () => calls.push('begin'), stroke: () => calls.push('stroke'),
      moveTo: () => {}, lineTo: () => {}, closePath: () => {}, ellipse: () => calls.push('ellipse'),
      lineWidth: 0, strokeStyle: '', lineCap: 'butt', lineJoin: 'miter', shadowColor: '', shadowBlur: 0,
    } as unknown as Canvas2DLike;
    drawAnnotation(ctx, { v: 1, aspect: 1.5, shapes: [
      { t: 'arrow', c: '#ff3b30', w: 0.006, p: [0, 0, 1, 1] },
      { t: 'ellipse', c: '#ffffff', w: 0.006, p: [0.2, 0.2, 0.4, 0.4] },
    ] }, 480, 320);
    expect(calls.filter(c => c === 'stroke').length).toBe(2);
    expect(calls).toContain('ellipse');
    expect(calls[0]).toBe('save');
    expect(calls.at(-1)).toBe('restore');
  });
});
