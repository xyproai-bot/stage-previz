import { describe, it, expect } from 'vitest';
import {
  applyMatrix, guideFileName, guideLayout, layoutPattern, localMatrix, patternSize, upDirection, upText,
} from './ledTemplatePattern';
import { applyLocalTransform, localTransform, type LedTemplatePlan, type Rotation, type ScreenDef } from './ledTemplate';

const def = (key: string, name: string, nativeW: number, nativeH: number): ScreenDef => ({
  key, objectId: key.slice(2), name, manual: false, uv: null, src: { us: 0, ul: 1, vs: 0, vl: 1 }, nativeW, nativeH,
});

describe('螢幕的「上方」在版型畫布上指哪裡', () => {
  it('轉動八種方向（順時針轉，轉完再翻）', () => {
    const run = (r: Rotation, fh = false, fv = false) => upText(upDirection(r, fh, fv));
    expect(run(0)).toBe('朝上');
    expect(run(90)).toBe('朝右');
    expect(run(180)).toBe('朝下');
    expect(run(270)).toBe('朝左');
    // 左右翻：只有水平方向會反
    expect(run(0, true, false)).toBe('朝上');
    expect(run(90, true, false)).toBe('朝左');
    expect(run(270, true, false)).toBe('朝右');
    // 上下翻：只有垂直方向會反
    expect(run(0, false, true)).toBe('朝下');
    expect(run(90, false, true)).toBe('朝右');
    expect(run(180, false, true)).toBe('朝上');
  });
  it('向量是單位向量，不會有 -0', () => {
    for (const r of [0, 90, 180, 270] as Rotation[]) for (const fh of [false, true]) for (const fv of [false, true]) {
      const u = upDirection(r, fh, fv);
      expect(Math.abs(u.dx) + Math.abs(u.dy)).toBe(1);
      expect(Object.is(u.dx, -0)).toBe(false);
      expect(Object.is(u.dy, -0)).toBe(false);
    }
  });
});

describe('本地座標 → 版型畫布的矩陣', () => {
  it('跟 localTransform / 目的地長方形算出來的一模一樣（八種方向）', () => {
    const dest = { x: 30, y: 70, w: 400, h: 120 };
    const native = { w: 800, h: 200 };
    for (const r of [0, 90, 180, 270] as Rotation[]) {
      for (const fh of [false, true]) for (const fv of [false, true]) {
        // 轉 90 / 270 時外框是對調過的，這裡只驗矩陣本身：任何本地點都落在 dest 裡，而且等於「單位座標經 localTransform 再放進 dest」
        const m = localMatrix(dest, native, r, fh, fv);
        for (const [lx, ly] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.3, 0.8]]) {
          const [tx, ty] = applyLocalTransform(localTransform(r, fh, fv), lx, ly);
          const [x, y] = applyMatrix(m, lx * native.w, ly * native.h);
          expect(x).toBeCloseTo(dest.x + tx * dest.w, 6);
          expect(y).toBeCloseTo(dest.y + ty * dest.h, 6);
          expect(x).toBeGreaterThanOrEqual(dest.x - 1e-9);
          expect(x).toBeLessThanOrEqual(dest.x + dest.w + 1e-9);
          expect(y).toBeGreaterThanOrEqual(dest.y - 1e-9);
          expect(y).toBeLessThanOrEqual(dest.y + dest.h + 1e-9);
        }
      }
    }
  });
  it('轉 90 度：螢幕左上角跑到版型長方形的右上角', () => {
    const m = localMatrix({ x: 0, y: 0, w: 200, h: 800 }, { w: 800, h: 200 }, 90, false, false);
    const [x, y] = applyMatrix(m, 0, 0);
    expect([x, y]).toEqual([200, 0]);
  });
});

describe('layoutPattern', () => {
  const defs = [def('o:a', '底幕', 800, 200), def('o:b', '左翼', 100, 400)];
  const plan: Pick<LedTemplatePlan, 'screens'> = {
    screens: [
      { key: 'o:b', objectId: 'b', uv: null, dest: { x: 0, y: 0, w: 400, h: 100 }, rotate: 90 as Rotation, flipH: false, flipV: false },
      { key: 'o:gone', objectId: 'gone', uv: null, dest: { x: 0, y: 0, w: 10, h: 10 }, rotate: 0 as Rotation, flipH: false, flipV: false },
      { key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 100, w: 800, h: 200 }, rotate: 0 as Rotation, flipH: true, flipV: false },
    ],
  };
  it('模型裡找不到的螢幕略過；順序照版型；顏色跟著螢幕清單的順序（不是放的順序）', () => {
    const items = layoutPattern(plan, defs);
    expect(items.map(i => i.key)).toEqual(['o:b', 'o:a']);
    expect(items[0].index).toBe(1);
    expect(items[1].index).toBe(0);
    expect(items[0].color).not.toBe(items[1].color);
  });
  it('文字：真實點數和版型裡的像素、朝向、鏡像', () => {
    const [b, a] = layoutPattern(plan, defs);
    expect(b.nativeText).toBe('100×400');
    expect(b.destText).toBe('400×100');
    expect(b.upText).toBe('朝右');
    expect(b.mirrored).toBe(false);
    expect(a.mirrored).toBe(true);
  });
});

describe('模板圖的排版', () => {
  it('很扁的長條：箭頭在左、文字在右；其他：箭頭在上、文字在下', () => {
    const strip = guideLayout({ x: 0, y: 100, w: 4400, h: 200 });
    expect(strip.layout).toBe('side');
    expect(strip.arrow.cx).toBeLessThan(strip.text.x + 1);
    expect(strip.arrow.len).toBeLessThanOrEqual(200 * 0.6 + 1e-9);
    const box = guideLayout({ x: 10, y: 10, w: 300, h: 400 });
    expect(box.layout).toBe('stack');
    expect(box.arrow.cy).toBeLessThan(box.text.y);
    expect(box.text.h).toBeGreaterThan(0);
  });
  it('箭頭和文字都在長方形裡面', () => {
    for (const d of [{ x: 0, y: 0, w: 4400, h: 200 }, { x: 50, y: 50, w: 300, h: 500 }, { x: 0, y: 0, w: 120, h: 120 }]) {
      const g = guideLayout(d);
      expect(g.arrow.cx - g.arrow.len / 2).toBeGreaterThanOrEqual(d.x - 1e-9);
      expect(g.arrow.cx + g.arrow.len / 2).toBeLessThanOrEqual(d.x + d.w + 1e-9);
      expect(g.arrow.cy - g.arrow.len / 2).toBeGreaterThanOrEqual(d.y - 1e-9);
      expect(g.arrow.cy + g.arrow.len / 2).toBeLessThanOrEqual(d.y + d.h + 1e-9);
      expect(g.text.x + g.text.w).toBeLessThanOrEqual(d.x + d.w + 1e-9);
      expect(g.text.y + g.text.h).toBeLessThanOrEqual(d.y + d.h + 1e-9);
    }
  });
  it('檔名：專案名、版型名、尺寸；名字裡不能放的字換成底線', () => {
    expect(guideFileName('主舞臺', { name: '中間底幕', canvas: { width: 4400, height: 200 } })).toBe('LED版型圖-主舞臺-中間底幕-4400x200.png');
    expect(guideFileName('a/b', { name: 'x:y', canvas: { width: 16, height: 16 } })).toBe('LED版型圖-a_b-x_y-16x16.png');
    expect(guideFileName(undefined, { name: '版', canvas: { width: 16, height: 16 } })).toBe('LED版型圖-專案-版-16x16.png');
  });
});

describe('測試圖貼圖的大小', () => {
  it('小畫布原尺寸；大畫布縮到單邊 4096、面積 600 萬以內，比例不變', () => {
    expect(patternSize({ width: 800, height: 200 })).toEqual({ width: 800, height: 200, scale: 1 });
    const big = patternSize({ width: 10496, height: 5120 });
    expect(big.width).toBeLessThanOrEqual(4096);
    expect(big.width * big.height).toBeLessThanOrEqual(6e6 * 1.01);
    expect(big.width / big.height).toBeCloseTo(10496 / 5120, 2);
  });
});
