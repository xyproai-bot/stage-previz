import { describe, it, expect } from 'vitest';
import {
  clipRectToCanvas, commit, fitCanvasToItems, fitView, findFreeSpot, flaggedKeys, gridStep, newHistory, nextSplitName, nudgeRect,
  pickObjectForRect, redo, rectFromPoints, rectToUv, rotatePlacement90, setRotation, settle, snapLine, snapMove, snapResize, snapTargets,
  spanRects, toCanvas, toScreen, transient, undo, uvToRect, zoomAt, HISTORY_LIMIT,
} from './ledTemplateEdit';

const C = { width: 1000, height: 400 };

describe('吸附', () => {
  it('snapTargets：畫布的邊 + 別人的邊（去掉重複）', () => {
    const t = snapTargets(C, [{ x: 100, y: 50, w: 200, h: 100 }, { x: 300, y: 50, w: 100, h: 100 }]);
    expect(t.xs).toEqual([0, 100, 300, 400, 1000]);
    expect(t.ys).toEqual([0, 50, 150, 400]);
  });

  it('snapLine：選最近的，超過距離不吸', () => {
    expect(snapLine([98, 250], [100, 300], 5)).toEqual({ delta: 2, at: 100 });
    expect(snapLine([90], [100], 5)).toBeNull();
    expect(snapLine([97, 301], [100, 300], 5)).toEqual({ delta: -1 + 0, at: 300 });   // 301 離 300 比 97 離 100 近
  });

  it('snapMove：先四捨五入成整數，左邊靠近別人的右邊就吸過去（接得剛剛好）', () => {
    const t = snapTargets(C, [{ x: 0, y: 0, w: 200, h: 100 }]);
    const r = snapMove({ x: 500, y: 300, w: 100, h: 50 }, 203.4, 3.6, t, { threshold: 8, snap: true });
    expect(r.rect).toEqual({ x: 200, y: 0, w: 100, h: 50 });
    expect(r.guides).toEqual([{ axis: 'x', at: 200 }, { axis: 'y', at: 0 }]);
  });

  it('snapMove：右邊靠近畫布右緣也會吸（整塊貼齊）', () => {
    const t = snapTargets(C, []);
    const r = snapMove({ x: 0, y: 0, w: 100, h: 50 }, 897.6, 100, t, { threshold: 8, snap: true });
    expect(r.rect.x).toBe(900);
    expect(r.rect.y).toBe(100);
  });

  it('snapMove：Alt（snap = false）不吸附，但位置一定是整數', () => {
    const t = snapTargets(C, [{ x: 0, y: 0, w: 200, h: 100 }]);
    const r = snapMove({ x: 500, y: 300, w: 100, h: 50 }, 203.4, 3.6, t, { threshold: 8, snap: false });
    expect(r.rect).toEqual({ x: 203, y: 4, w: 100, h: 50 });
    expect(r.guides).toEqual([]);
  });

  it('snapResize：拖右下角，對角（左上）不動，邊靠近別人的邊會吸', () => {
    const t = snapTargets(C, [{ x: 600, y: 0, w: 100, h: 400 }]);
    const r = snapResize({ x: 100, y: 100, w: 100, h: 50 }, 'se', 597.2, 199.6, t, { threshold: 8, snap: true });
    expect(r.rect).toEqual({ x: 100, y: 100, w: 500, h: 100 });
  });

  it('snapResize：拖左上角，右下角不動', () => {
    const t = snapTargets(C, []);
    const r = snapResize({ x: 100, y: 100, w: 100, h: 50 }, 'nw', 40, 60, t, { threshold: 0, snap: false });
    expect(r.rect).toEqual({ x: 40, y: 60, w: 160, h: 90 });
  });

  it('snapResize：拖過對角不會翻過去，最小 1 像素', () => {
    const t = snapTargets(C, []);
    const r = snapResize({ x: 100, y: 100, w: 100, h: 50 }, 'se', 20, 20, t, { threshold: 0, snap: false });
    expect(r.rect).toEqual({ x: 100, y: 100, w: 1, h: 1 });
    const l = snapResize({ x: 100, y: 100, w: 100, h: 50 }, 'nw', 500, 500, t, { threshold: 0, snap: false });
    expect(l.rect).toEqual({ x: 199, y: 149, w: 1, h: 1 });
  });

  it('snapResize：Shift 鎖長寬比（以拉得多的那邊為準）', () => {
    const t = snapTargets(C, []);
    const r = snapResize({ x: 0, y: 0, w: 200, h: 100 }, 'se', 400, 150, t, { threshold: 8, snap: true, keepAspect: true });
    expect(r.rect).toEqual({ x: 0, y: 0, w: 400, h: 200 });
    const tall = snapResize({ x: 0, y: 0, w: 200, h: 100 }, 'se', 220, 300, t, { threshold: 8, snap: true, keepAspect: true });
    expect(tall.rect).toEqual({ x: 0, y: 0, w: 600, h: 300 });
  });

  it('nudgeRect', () => {
    expect(nudgeRect({ x: 5, y: 5, w: 10, h: 10 }, -1, 10)).toEqual({ x: 4, y: 15, w: 10, h: 10 });
  });
});

describe('轉 90° / 改轉動', () => {
  it('順時針轉 90°：寬高對調、中心不動、轉動 +90', () => {
    const r = rotatePlacement90({ dest: { x: 100, y: 100, w: 400, h: 100 }, rotate: 0 });
    expect(r).toEqual({ dest: { x: 250, y: -50, w: 100, h: 400 }, rotate: 90 });
  });
  it('轉四次回到原本的位置和轉動', () => {
    let p = { dest: { x: 10, y: 20, w: 300, h: 70 }, rotate: 0 as 0 | 90 | 180 | 270 };
    for (let i = 0; i < 4; i++) p = rotatePlacement90(p, 1);
    expect(p).toEqual({ dest: { x: 10, y: 20, w: 300, h: 70 }, rotate: 0 });
  });
  it('逆時針：0 → 270', () => {
    expect(rotatePlacement90({ dest: { x: 0, y: 0, w: 100, h: 100 }, rotate: 0 }, -1).rotate).toBe(270);
  });
  it('奇數差的寬高：中心四捨五入成整數', () => {
    const r = rotatePlacement90({ dest: { x: 0, y: 0, w: 101, h: 50 }, rotate: 0 });
    expect(Number.isInteger(r.dest.x) && Number.isInteger(r.dest.y)).toBe(true);
    expect(r.dest.w).toBe(50);
    expect(r.dest.h).toBe(101);
  });
  it('setRotation：0 → 180 不換寬高；0 → 90 換；90 → 270 不換', () => {
    const base = { dest: { x: 0, y: 0, w: 200, h: 100 }, rotate: 0 as 0 | 90 | 180 | 270 };
    expect(setRotation(base, 180).dest).toEqual(base.dest);
    const r90 = setRotation(base, 90);
    expect(r90.dest.w).toBe(100);
    expect(r90.dest.h).toBe(200);
    expect(setRotation(r90, 270).dest).toEqual(r90.dest);
  });
});

describe('重疊 / 超出畫布', () => {
  it('兩塊重疊兩塊都標；剛好貼齊不算重疊', () => {
    const m = flaggedKeys([
      { key: 'a', dest: { x: 0, y: 0, w: 100, h: 100 } },
      { key: 'b', dest: { x: 50, y: 50, w: 100, h: 100 } },
      { key: 'c', dest: { x: 100, y: 0, w: 100, h: 50 } },
    ], C);
    expect([...m.get('a')!]).toEqual(['overlap']);
    expect([...m.get('b')!]).toEqual(['overlap']);
    expect(m.has('c')).toBe(false);   // c 只是貼著 a 的右邊、b 的上面，沒有重疊
  });
  it('貼齊不算重疊', () => {
    const m = flaggedKeys([
      { key: 'a', dest: { x: 0, y: 0, w: 100, h: 100 } },
      { key: 'b', dest: { x: 100, y: 0, w: 100, h: 100 } },
    ], C);
    expect(m.size).toBe(0);
  });
  it('超出畫布（任何一邊）', () => {
    const m = flaggedKeys([
      { key: 'r', dest: { x: 950, y: 0, w: 100, h: 50 } },
      { key: 'l', dest: { x: -1, y: 0, w: 10, h: 10 } },
      { key: 'ok', dest: { x: 900, y: 350, w: 100, h: 50 } },
    ], C);
    expect([...m.get('r')!]).toEqual(['outside']);
    expect([...m.get('l')!]).toEqual(['outside']);
    expect(m.has('ok')).toBe(false);
  });
});

describe('空位 / 包住畫布', () => {
  it('第一塊放在左上角', () => {
    expect(findFreeSpot({ w: 100, h: 50 }, [], C)).toEqual({ x: 0, y: 0 });
  });
  it('已經有一塊就放在它旁邊（由上到下、由左到右）', () => {
    expect(findFreeSpot({ w: 100, h: 50 }, [{ x: 0, y: 0, w: 100, h: 50 }], C)).toEqual({ x: 100, y: 0 });
  });
  it('一排放滿了就放下一排', () => {
    const row = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({ x: i * 100, y: 0, w: 100, h: 50 }));
    expect(findFreeSpot({ w: 100, h: 50 }, row, C)).toEqual({ x: 0, y: 50 });
  });
  it('畫布放不下就放在所有東西的下面（超出畫布）', () => {
    expect(findFreeSpot({ w: 2000, h: 100 }, [{ x: 0, y: 0, w: 100, h: 60 }], C)).toEqual({ x: 0, y: 60 });
    expect(findFreeSpot({ w: 2000, h: 100 }, [], C)).toEqual({ x: 0, y: 0 });
  });
  it('fitCanvasToItems：剛好包住，至少 16', () => {
    expect(fitCanvasToItems([])).toBeNull();
    expect(fitCanvasToItems([{ dest: { x: 10, y: 0, w: 90, h: 8 } }, { dest: { x: 0, y: 8, w: 40, h: 12 } }])).toEqual({ width: 100, height: 20 });
    expect(fitCanvasToItems([{ dest: { x: 0, y: 0, w: 4, h: 4 } }])).toEqual({ width: 16, height: 16 });
  });
});

describe('縮放平移', () => {
  it('fitView：整張畫布置中塞進畫面', () => {
    const v = fitView({ width: 1000, height: 400 }, { w: 800, h: 400 }, 0);
    expect(v.zoom).toBeCloseTo(0.8, 6);
    expect(v.panX).toBeCloseTo(0, 6);
    expect(v.panY).toBeCloseTo(40, 6);
  });
  it('fitView：小畫布最多放大 8 倍', () => {
    expect(fitView({ width: 100, height: 50 }, { w: 2000, h: 2000 }).zoom).toBe(8);
  });
  it('zoomAt：游標底下的畫布位置不動', () => {
    const v = { zoom: 1, panX: 10, panY: 20 };
    const anchor = { x: 300, y: 200 };
    const before = toCanvas(v, anchor);
    const z = zoomAt(v, 2.5, anchor);
    const after = toCanvas(z, anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(z.zoom).toBe(2.5);
  });
  it('toScreen / toCanvas 互為反函數', () => {
    const v = { zoom: 0.37, panX: 41, panY: -8 };
    const p = toCanvas(v, toScreen(v, { x: 1234, y: 567 }));
    expect(p.x).toBeCloseTo(1234, 6);
    expect(p.y).toBeCloseTo(567, 6);
  });
  it('縮放有上下限', () => {
    expect(zoomAt({ zoom: 60, panX: 0, panY: 0 }, 10, { x: 0, y: 0 }).zoom).toBe(64);
    expect(zoomAt({ zoom: 0.005, panX: 0, panY: 0 }, 0.01, { x: 0, y: 0 }).zoom).toBe(0.004);
  });
  it('gridStep：兩條線在畫面上至少隔 36 px', () => {
    expect(gridStep(1)).toBe(50);
    expect(gridStep(0.1)).toBe(500);
    expect(gridStep(8)).toBe(5);
    expect(gridStep(40)).toBe(1);
  });
});

describe('復原 / 重做', () => {
  it('commit → undo → redo', () => {
    let h = newHistory(1);
    h = commit(h, 2);
    h = commit(h, 3);
    expect(h.present).toBe(3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(undo(h)).toBe(h);   // 沒得退了
    h = redo(h);
    expect(h.present).toBe(2);
    h = commit(h, 9);          // 做了新的就不能重做舊的
    expect(h.future).toEqual([]);
  });
  it('同一個 tag 很快連續記 = 一步（鍵盤連按微調）', () => {
    let h = newHistory(0);
    h = commit(h, 1, { tag: 'nudge', now: 1000 });
    h = commit(h, 2, { tag: 'nudge', now: 1100 });
    h = commit(h, 3, { tag: 'nudge', now: 1200 });
    expect(h.past).toEqual([0]);
    expect(undo(h).present).toBe(0);
    // 隔太久就是新的一步
    h = commit(h, 4, { tag: 'nudge', now: 5000 });
    expect(h.past).toEqual([0, 3]);
  });
  it('拖曳：途中 transient 不記，放開 settle 記一步', () => {
    let h = newHistory('a');
    h = transient(h, 'b');
    h = transient(h, 'c');
    expect(h.past).toEqual([]);
    h = settle(h, 'a');
    expect(h.present).toBe('c');
    expect(undo(h).present).toBe('a');
  });
  it('最多記 100 步', () => {
    let h = newHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = commit(h, i);
    expect(h.past.length).toBe(HISTORY_LIMIT);
  });
});

describe('在整張畫布上切螢幕', () => {
  const FULL = { width: 8800, height: 2000 };
  it('rectFromPoints：從哪個角拖都一樣，整數', () => {
    expect(rectFromPoints({ x: 100.4, y: 50.6 }, { x: 10, y: 10 })).toEqual({ x: 10, y: 10, w: 90, h: 41 });
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 100.4, y: 50.6 })).toEqual({ x: 10, y: 10, w: 90, h: 41 });
  });
  it('clipRectToCanvas：裁在畫布裡；完全在外面 = null', () => {
    expect(clipRectToCanvas({ x: -50, y: 10, w: 100, h: 20 }, C)).toEqual({ x: 0, y: 10, w: 50, h: 20 });
    expect(clipRectToCanvas({ x: 990, y: 390, w: 100, h: 100 }, C)).toEqual({ x: 990, y: 390, w: 10, h: 10 });
    expect(clipRectToCanvas({ x: 1000, y: 0, w: 10, h: 10 }, C)).toBeNull();
  });
  it('rectToUv / uvToRect 來回', () => {
    const r = { x: 2200, y: 500, w: 4400, h: 1000 };
    const uv = rectToUv(r, FULL);
    expect(uv).toEqual([0.25, 0.25, 0.75, 0.75]);
    expect(uvToRect(uv, FULL)).toEqual(r);
  });
  it('spanRects：沒繞回 = 一塊；跨 u 接縫 = 兩塊；兩邊都跨 = 四塊', () => {
    expect(spanRects({ us: 0.25, ul: 0.5, vs: 0.25, vl: 0.5 }, FULL)).toEqual([{ x: 2200, y: 500, w: 4400, h: 1000 }]);
    const wrap = spanRects({ us: 0.9, ul: 0.2, vs: 0, vl: 0.5 }, FULL);
    expect(wrap).toEqual([{ x: 7920, y: 0, w: 880, h: 1000 }, { x: 0, y: 0, w: 880, h: 1000 }]);
    expect(spanRects({ us: 0.9, ul: 0.2, vs: 0.8, vl: 0.4 }, FULL)).toHaveLength(4);
  });
  it('pickObjectForRect：跟哪個物件重疊最多就是哪個', () => {
    const objs = [
      { objectId: 'left', src: { us: 0, ul: 0.5, vs: 0, vl: 1 } },
      { objectId: 'right', src: { us: 0.5, ul: 0.5, vs: 0, vl: 1 } },
    ];
    expect(pickObjectForRect({ x: 5000, y: 0, w: 1000, h: 500 }, objs, FULL)).toBe('right');
    expect(pickObjectForRect({ x: 3800, y: 0, w: 1000, h: 500 }, objs, FULL)).toBe('left');
    expect(pickObjectForRect({ x: 0, y: 0, w: 10, h: 10 }, [{ objectId: 'x', src: { us: 0.5, ul: 0.1, vs: 0.5, vl: 0.1 } }], FULL)).toBeNull();
  });
  it('nextSplitName：不跟已經有的重複，最多 40 字', () => {
    expect(nextSplitName('主舞台', [])).toBe('主舞台 1');
    expect(nextSplitName('主舞台', ['主舞台 1', '主舞台 2'])).toBe('主舞台 3');
    expect(nextSplitName('字'.repeat(60), []).length).toBeLessThanOrEqual(40);
  });
});
