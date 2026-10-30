import { describe, expect, it } from 'vitest';
import { placeBubble, type Placement } from './tourPlacement';

const bubble = { w: 340, h: 180 };
const desktop = { w: 1280, h: 800 };

/** 說明框放好以後的四個邊都要在畫面內、離邊至少 gutter */
function expectInside(p: Placement, bub = bubble, vp = desktop, gutter = 16) {
  if (p.mode !== 'anchored') throw new Error('不是 anchored');
  expect(p.x).toBeGreaterThanOrEqual(gutter);
  expect(p.y).toBeGreaterThanOrEqual(gutter);
  expect(p.x + bub.w).toBeLessThanOrEqual(vp.w - gutter);
  expect(p.y + bub.h).toBeLessThanOrEqual(vp.h - gutter);
}

describe('placeBubble：說明框擺哪裡', () => {
  it('窄畫面（寬 < 640）→ 貼在底部', () => {
    expect(placeBubble({ x: 10, y: 10, w: 100, h: 40 }, bubble, { w: 375, h: 700 })).toEqual({ mode: 'sheet' });
    expect(placeBubble(null, bubble, { w: 639, h: 700 })).toEqual({ mode: 'sheet' });
    // 剛好 640 不算窄
    expect(placeBubble({ x: 10, y: 10, w: 100, h: 40 }, bubble, { w: 640, h: 700 }).mode).toBe('anchored');
  });

  it('沒有目標 → 放中間', () => {
    expect(placeBubble(null, bubble, desktop)).toEqual({ mode: 'center' });
  });

  it('目標在上半部 → 放下面', () => {
    const p = placeBubble({ x: 600, y: 20, w: 120, h: 34 }, bubble, desktop);
    expect(p.mode).toBe('anchored');
    if (p.mode === 'anchored') {
      expect(p.side).toBe('below');
      expect(p.y).toBeGreaterThan(20 + 34);
    }
    expectInside(p);
  });

  it('目標在最下面 → 放上面', () => {
    const p = placeBubble({ x: 600, y: 740, w: 120, h: 40 }, bubble, desktop);
    expect(p.mode).toBe('anchored');
    if (p.mode === 'anchored') {
      expect(p.side).toBe('above');
      expect(p.y + bubble.h).toBeLessThanOrEqual(740);
    }
    expectInside(p);
  });

  it('目標佔滿高度、左邊有空 → 放右邊或左邊', () => {
    const p = placeBubble({ x: 400, y: 0, w: 120, h: 800 }, bubble, desktop);
    expect(p.mode).toBe('anchored');
    if (p.mode === 'anchored') {
      expect(['right', 'left']).toContain(p.side);
      if (p.side === 'right') expect(p.x).toBeGreaterThanOrEqual(400 + 120);
      if (p.side === 'left') expect(p.x + bubble.w).toBeLessThanOrEqual(400);
    }
    expectInside(p);
  });

  it('目標靠左邊、上下放不下 → 放右邊', () => {
    const p = placeBubble({ x: 0, y: 0, w: 200, h: 800 }, bubble, desktop);
    expect(p.mode).toBe('anchored');
    if (p.mode === 'anchored') expect(p.side).toBe('right');
    expectInside(p);
  });

  it('目標大到四邊都放不下（舞台整個畫面）→ 放在目標裡面靠下，不是蓋在正中間', () => {
    const p = placeBubble({ x: 100, y: 60, w: 1080, h: 700 }, bubble, desktop);
    expect(p.mode).toBe('anchored');
    if (p.mode === 'anchored') expect(p.side).toBe('inside');
    expectInside(p);
  });

  it('目標連裡面也放不下 → 放中間', () => {
    expect(placeBubble({ x: 0, y: 0, w: 300, h: 200 }, { w: 340, h: 180 }, { w: 640, h: 220 })).toEqual({ mode: 'center' });
  });

  it('目標靠右邊緣：座標夾在 gutter 內，不會超出畫面', () => {
    const p = placeBubble({ x: 1230, y: 20, w: 40, h: 34 }, bubble, desktop);
    expectInside(p);
    const q = placeBubble({ x: 4, y: 20, w: 40, h: 34 }, bubble, desktop);
    expectInside(q);
  });

  it('說明框置中對齊目標（放得下時）', () => {
    const p = placeBubble({ x: 560, y: 20, w: 160, h: 34 }, bubble, desktop);
    if (p.mode !== 'anchored') throw new Error('x');
    expect(p.x + bubble.w / 2).toBeCloseTo(640, 0);
  });
});
