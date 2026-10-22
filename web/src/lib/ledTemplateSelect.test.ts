import { describe, it, expect } from 'vitest';
import {
  applyMarquee, boundsOf, clickSelect, flipPatches, groupTargets, isAdditive, marqueeBox, marqueeHits, moveGroupTo, movePatches,
  nudgeRects, pressSelect, pruneSelection, releaseSelect, rotatePatches, sameSelection, scaleGroupPct, scaleGroupTo, scaleRects,
  selectAllKeys, selectionTag, snapGroupMove, snapGroupScale,
} from './ledTemplateSelect';
import { commit, newHistory, redo, settle, snapMove, snapResize, snapTargets, transient, undo } from './ledTemplateEdit';
import { patchDraftItems, removeScreensFromDraft, type Draft } from './ledTemplateDraft';

const C = { width: 1000, height: 400 };

const draft3: Draft = {
  id: 't1', name: '版型', width: 1000, height: 400, scalePct: 100,
  items: [
    { key: 'a', dest: { x: 100, y: 100, w: 100, h: 50 }, rotate: 0, flipH: false, flipV: false },
    { key: 'b', dest: { x: 250, y: 120, w: 60, h: 80 }, rotate: 0, flipH: true, flipV: false },
    { key: 'c', dest: { x: 400, y: 100, w: 100, h: 50 }, rotate: 90, flipH: false, flipV: true },
    { key: 'd', dest: { x: 700, y: 300, w: 100, h: 50 }, rotate: 0, flipH: false, flipV: false },
  ],
};
const dests = (d: Draft, keys: string[]) => keys.map(k => d.items.find(i => i.key === k)!.dest);

describe('Shift / Ctrl 點選的規則', () => {
  it('isAdditive：Shift、Ctrl、Cmd 任何一個都算加選', () => {
    expect(isAdditive({})).toBe(false);
    expect(isAdditive({ shiftKey: true })).toBe(true);
    expect(isAdditive({ ctrlKey: true })).toBe(true);
    expect(isAdditive({ metaKey: true })).toBe(true);
    expect(isAdditive({ altKey: true } as never)).toBe(false);
  });

  it('沒按鍵、點還沒選的 → 只選這一塊，直接可以拖', () => {
    expect(pressSelect(['a', 'b'], 'c', false)).toEqual({ selection: ['c'], pending: null });
    expect(pressSelect([], 'c', false)).toEqual({ selection: ['c'], pending: null });
  });

  it('沒按鍵、點已經在複選裡的 → 選取先不動（才能抓著其中一塊拖整組），放開沒拖才縮成這一塊', () => {
    const p = pressSelect(['a', 'b', 'c'], 'b', false);
    expect(p).toEqual({ selection: ['a', 'b', 'c'], pending: 'only' });
    expect(releaseSelect(p.selection, 'b', p.pending, false)).toEqual(['b']);
    expect(releaseSelect(p.selection, 'b', p.pending, true)).toEqual(['a', 'b', 'c']);
  });

  it('只選了一塊、又點同一塊 → 沒什麼要縮的', () => {
    expect(pressSelect(['a'], 'a', false)).toEqual({ selection: ['a'], pending: null });
  });

  it('按著 Shift / Ctrl 點還沒選的 → 加進去（可以直接拖整組）', () => {
    const p = pressSelect(['a'], 'c', true);
    expect(p).toEqual({ selection: ['a', 'c'], pending: null });
    expect(releaseSelect(p.selection, 'c', p.pending, false)).toEqual(['a', 'c']);
  });

  it('按著 Shift / Ctrl 點已經選了的 → 放開沒拖才拿掉；拖了就是在拖整組，不拿掉', () => {
    const p = pressSelect(['a', 'b', 'c'], 'b', true);
    expect(p).toEqual({ selection: ['a', 'b', 'c'], pending: 'toggle' });
    expect(releaseSelect(p.selection, 'b', p.pending, false)).toEqual(['a', 'c']);
    expect(releaseSelect(p.selection, 'b', p.pending, true)).toEqual(['a', 'b', 'c']);
  });

  it('清單那一列（一次點完）：沒按 = 只選這塊；按著 = 加選 / 取消選', () => {
    expect(clickSelect(['a', 'b'], 'c', false)).toEqual(['c']);
    expect(clickSelect(['a', 'b'], 'b', false)).toEqual(['b']);
    expect(clickSelect(['a'], 'c', true)).toEqual(['a', 'c']);
    expect(clickSelect(['a', 'c'], 'c', true)).toEqual(['a']);
    expect(clickSelect(['a'], 'a', true)).toEqual([]);
  });

  it('pruneSelection：撤銷後不存在的代號拿掉；都在就是原來那一個陣列', () => {
    const sel = ['a', 'b'];
    expect(pruneSelection(sel, () => true)).toBe(sel);
    expect(pruneSelection(sel, k => k !== 'b')).toEqual(['a']);
  });

  it('sameSelection / selectAllKeys', () => {
    expect(sameSelection(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameSelection(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(selectAllKeys(draft3.items)).toEqual(['a', 'b', 'c', 'd']);
    expect(selectAllKeys([])).toEqual([]);
  });
});

describe('框選', () => {
  it('marqueeBox：不管從哪個角拖起都一樣，保留小數', () => {
    expect(marqueeBox({ x: 300.5, y: 200 }, { x: 100, y: 50.25 })).toEqual({ x: 100, y: 50.25, w: 200.5, h: 149.75 });
    expect(marqueeBox({ x: 100, y: 50.25 }, { x: 300.5, y: 200 })).toEqual({ x: 100, y: 50.25, w: 200.5, h: 149.75 });
  });

  it('marqueeHits：碰到一點點就算，照 items 的順序', () => {
    const box = { x: 90, y: 90, w: 170, h: 40 };   // 蓋到 a 的右半和 b 的左上角
    expect(marqueeHits(box, draft3.items)).toEqual(['a', 'b']);
  });

  it('marqueeHits：只是邊貼邊（沒有重疊面積）不算；整個框在空白處 = 沒有', () => {
    expect(marqueeHits({ x: 200, y: 100, w: 30, h: 30 }, draft3.items)).toEqual([]);   // 剛好貼著 a 的右邊
    expect(marqueeHits({ x: 520, y: 0, w: 100, h: 50 }, draft3.items)).toEqual([]);
  });

  it('marqueeHits：框完全包住、或完全在螢幕裡面，都算碰到', () => {
    expect(marqueeHits({ x: 0, y: 0, w: 1000, h: 400 }, draft3.items)).toEqual(['a', 'b', 'c', 'd']);
    expect(marqueeHits({ x: 120, y: 110, w: 5, h: 5 }, draft3.items)).toEqual(['a']);
  });

  it('marqueeHits：沒有面積的框（只是點一下）什麼都沒碰到', () => {
    expect(marqueeHits({ x: 120, y: 110, w: 0, h: 0 }, draft3.items)).toEqual([]);
    expect(marqueeHits({ x: 120, y: 110, w: 20, h: 0 }, draft3.items)).toEqual([]);
  });

  it('applyMarquee：沒按鍵 = 只有框到的；按著 Shift / Ctrl = 原本選的 + 框到的（不重複）', () => {
    expect(applyMarquee(['d'], ['a', 'b'], false)).toEqual(['a', 'b']);
    expect(applyMarquee(['d', 'a'], ['a', 'b'], true)).toEqual(['d', 'a', 'b']);
    expect(applyMarquee(['d'], [], true)).toEqual(['d']);
    expect(applyMarquee(['d'], [], false)).toEqual([]);
  });
});

describe('整組移動 + 吸附', () => {
  const rects = dests(draft3, ['a', 'b', 'c']);   // 外框 x 100～500，y 100～200

  it('boundsOf：一組的外框', () => {
    expect(boundsOf(rects)).toEqual({ x: 100, y: 100, w: 400, h: 100 });
    expect(boundsOf([])).toBeNull();
  });

  it('groupTargets：畫布的邊 + 沒被選到的螢幕的邊，選到的自己的邊不算', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    expect(t.xs).toEqual([0, 700, 800, 1000]);
    expect(t.ys).toEqual([0, 300, 350, 400]);
  });

  it('整組平移同樣的距離，每塊的相對位置不變，位置都是整數', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    const m = snapGroupMove(rects, 30.4, 10.6, t, { threshold: 4, snap: false });
    expect(m.dx).toBe(30);
    expect(m.dy).toBe(11);
    expect(m.rects).toEqual(rects.map(r => ({ x: r.x + 30, y: r.y + 11, w: r.w, h: r.h })));
    expect(m.rects.every(r => Number.isInteger(r.x) && Number.isInteger(r.y))).toBe(true);
    expect(m.guides).toEqual([]);
  });

  it('吸附的是整組外框：右邊靠近沒被選到的 d 的左邊就吸過去（不是每塊各吸各的）', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    // 外框右邊本來在 500，往右移 197 → 697，離 d 的左邊 700 只差 3
    const m = snapGroupMove(rects, 197, 0, t, { threshold: 8, snap: true });
    expect(m.dx).toBe(200);
    expect(boundsOf(m.rects)!.x + boundsOf(m.rects)!.w).toBe(700);
    expect(m.guides).toContainEqual({ axis: 'x', at: 700 });
    // 組內相對位置沒變
    expect(m.rects[1].x - m.rects[0].x).toBe(rects[1].x - rects[0].x);
  });

  it('吸附：外框的左邊貼畫布左緣、上邊貼畫布上緣', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    const m = snapGroupMove(rects, -97, -96, t, { threshold: 8, snap: true });
    const b = boundsOf(m.rects)!;
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  it('組裡面自己的邊不會把整組吸住（只有外框對外面的線）', () => {
    // 往右移 150：b 的左邊 400 會剛好對到 c 原本左邊 400，但這兩個都是選到的，不算
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    const m = snapGroupMove(rects, 150, 0, t, { threshold: 8, snap: true });
    expect(m.dx).toBe(150);
  });

  it('Alt（snap = false）不吸附', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    const m = snapGroupMove(rects, 197, 0, t, { threshold: 8, snap: false });
    expect(m.dx).toBe(197);
    expect(m.guides).toEqual([]);
  });

  it('只選一塊時，跟單塊移動 snapMove 完全一樣', () => {
    const one = [draft3.items[0].dest];
    const t = groupTargets(C, draft3.items, ['a']);
    for (const [dx, dy, snap] of [[203.4, 3.6, true], [-97.6, -96.2, true], [12.5, 7.5, false], [350, 160, true]] as const) {
      const g = snapGroupMove(one, dx, dy, t, { threshold: 8, snap });
      const s = snapMove(one[0], one[0].x + dx, one[0].y + dy, t, { threshold: 8, snap });
      expect(g.rects[0]).toEqual(s.rect);
      expect(g.guides).toEqual(s.guides);
    }
  });

  it('沒有東西 = 空', () => {
    expect(snapGroupMove([], 10, 10, snapTargets(C, []), { threshold: 8, snap: true })).toEqual({ rects: [], dx: 0, dy: 0, guides: [] });
  });

  it('nudgeRects：整組一起微調', () => {
    expect(nudgeRects(rects, 10, -1).map(r => [r.x, r.y])).toEqual([[110, 99], [260, 119], [410, 99]]);
  });

  it('moveGroupTo：改整組外框的左 / 上，整組平移（只給一個就只動那一個方向）', () => {
    const moved = moveGroupTo(rects, { x: 50 });
    expect(boundsOf(moved)).toEqual({ x: 50, y: 100, w: 400, h: 100 });
    const moved2 = moveGroupTo(rects, { x: 0, y: 7 });
    expect(boundsOf(moved2)).toEqual({ x: 0, y: 7, w: 400, h: 100 });
    expect(moved2[1].x - moved2[0].x).toBe(150);
    expect(moveGroupTo([], { x: 3 })).toEqual([]);
  });
});

describe('各自在原地轉 90° / 翻轉', () => {
  const three = draft3.items.slice(0, 3);

  it('rotatePatches：每一塊各自轉，中心不動、寬高對調', () => {
    const patches = rotatePatches(three, 1);
    expect(patches.map(p => p.key)).toEqual(['a', 'b', 'c']);
    const a = patches[0].patch;
    expect(a.rotate).toBe(90);
    expect(a.dest).toEqual({ x: 125, y: 75, w: 50, h: 100 });   // 中心 (150,125) 不動
    expect(patches[2].patch.rotate).toBe(180);                  // 原本 90 的轉成 180
  });

  it('flipPatches：每一塊各自翻（原本翻過的翻回來）', () => {
    const h = flipPatches(three, 'h');
    expect(h.map(p => p.patch.flipH)).toEqual([true, false, true]);
    const v = flipPatches(three, 'v');
    expect(v.map(p => p.patch.flipV)).toEqual([true, true, false]);
  });
});

describe('復原：一次動作 = 一步', () => {
  const keys = ['a', 'b', 'c'];
  const sel = draft3.items.filter(i => keys.includes(i.key));

  it('整組拖一下（途中很多次，放開記一步）→ 復原一次三塊全部回去', () => {
    const base = draft3;
    let h = newHistory(base);
    const t = groupTargets(C, base.items, keys);
    // 拖的途中：每次都只是 transient
    for (const dx of [5, 20, 60, 120]) {
      const m = snapGroupMove(sel.map(i => i.dest), dx, 10, t, { threshold: 4, snap: true });
      h = transient(h, patchDraftItems(h.present, movePatches(sel, m.rects)));
    }
    h = settle(h, base);
    expect(h.past.length).toBe(1);
    expect(dests(h.present, keys)).not.toEqual(dests(base, keys));
    const u = undo(h);
    expect(u.present).toBe(base);
    expect(dests(u.present, keys)).toEqual(dests(base, keys));
    expect(redo(u).present).toBe(h.present);
  });

  it('同一組連按方向鍵微調（同一個標籤、很快）合成一步', () => {
    let h = newHistory(draft3);
    const tag = selectionTag('nudge', keys);
    for (let i = 0; i < 5; i++) {
      const cur = h.present.items.filter(it => keys.includes(it.key));
      h = commit(h, patchDraftItems(h.present, movePatches(cur, nudgeRects(cur.map(c => c.dest), 1, 0))), { tag, now: 1000 + i * 50 });
    }
    expect(h.past.length).toBe(1);
    expect(dests(h.present, keys).map(r => r.x)).toEqual([105, 255, 405]);
    expect(undo(h).present).toBe(draft3);
  });

  it('selectionTag：選的先後不同也是同一組；跟只選一塊時的舊格式一樣', () => {
    expect(selectionTag('nudge', ['c', 'a', 'b'])).toBe(selectionTag('nudge', ['a', 'b', 'c']));
    expect(selectionTag('nudge', ['a'])).toBe('nudge:a');
    expect(selectionTag('nudge', ['a', 'b'])).not.toBe(selectionTag('nudge', ['a', 'c']));
  });

  it('各自轉 90° 一次 = 一步，復原三塊都回去', () => {
    let h = newHistory(draft3);
    h = commit(h, patchDraftItems(h.present, rotatePatches(sel, 1)), {});
    expect(h.past.length).toBe(1);
    expect(h.present.items.filter(i => keys.includes(i.key)).map(i => i.rotate)).toEqual([90, 90, 180]);
    expect(undo(h).present).toBe(draft3);
  });

  it('左右翻轉一次 = 一步', () => {
    let h = newHistory(draft3);
    h = commit(h, patchDraftItems(h.present, flipPatches(sel, 'h')), {});
    expect(h.past.length).toBe(1);
    expect(undo(h).present).toBe(draft3);
  });

  it('一次拿掉好幾塊 = 一步，復原全部回來', () => {
    let h = newHistory(draft3);
    h = commit(h, removeScreensFromDraft(h.present, keys), {});
    expect(h.present.items.map(i => i.key)).toEqual(['d']);
    expect(h.past.length).toBe(1);
    expect(undo(h).present.items.map(i => i.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('改數字欄位（整組的左）連續改，同一個標籤合成一步', () => {
    let h = newHistory(draft3);
    const tag = selectionTag('g:x', keys);
    for (const [n, at] of [[110, 1000], [120, 1100], [130, 1200]] as const) {
      const cur = h.present.items.filter(it => keys.includes(it.key));
      h = commit(h, patchDraftItems(h.present, movePatches(cur, moveGroupTo(cur.map(c => c.dest), { x: n }))), { tag, now: at });
    }
    expect(h.past.length).toBe(1);
    expect(boundsOf(dests(h.present, keys))!.x).toBe(130);
  });
});

describe('整組縮放', () => {
  // 三塊：外框 x 100～500、y 100～200（寬 400、高 100）
  const rects = dests(draft3, ['a', 'b', 'c']);
  const T = snapTargets(C, []);
  const free = { threshold: 8, snap: false, keepAspect: false };
  const lock = { threshold: 8, snap: false, keepAspect: true };

  it('scaleRects：位置（離不動點多遠）和大小乘同樣的倍數', () => {
    const out = scaleRects(rects, { x: 100, y: 100 }, 2, 3);
    expect(out[0]).toEqual({ x: 100, y: 100, w: 200, h: 150 });
    expect(out[1]).toEqual({ x: 400, y: 160, w: 120, h: 240 });   // x: 100 + 150×2、y: 100 + 20×3
    expect(out[2]).toEqual({ x: 700, y: 100, w: 200, h: 150 });
  });

  it('scaleRects：用「邊」四捨五入，貼在一起的兩塊縮完還是貼在一起；位置大小都是整數', () => {
    const touching = [{ x: 0, y: 0, w: 33, h: 10 }, { x: 33, y: 0, w: 33, h: 10 }, { x: 66, y: 0, w: 34, h: 10 }];
    const out = scaleRects(touching, { x: 0, y: 0 }, 0.37, 1);
    expect(out[0].x + out[0].w).toBe(out[1].x);
    expect(out[1].x + out[1].w).toBe(out[2].x);
    expect(out.every(r => Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h))).toBe(true);
    expect(out[2].x + out[2].w).toBe(37);   // 100 × 0.37
  });

  it('scaleRects：再小每一塊也至少 1 像素', () => {
    const out = scaleRects(rects, { x: 100, y: 100 }, 0.001, 0.001);
    expect(out.every(r => r.w >= 1 && r.h >= 1)).toBe(true);
  });

  it('右下角（se）：左上角不動，整組乘同樣的倍數', () => {
    // 外框 400×100，把右下角拖到 (900, 300) → 寬 800（×2）；鎖比例所以高 200
    const r = snapGroupScale(rects, 'se', 900, 300, T, lock);
    expect(r.box).toEqual({ x: 100, y: 100, w: 800, h: 200 });
    expect(r.sx).toBe(2);
    expect(r.sy).toBe(2);
    expect(r.rects[0]).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(r.rects[1]).toEqual({ x: 400, y: 140, w: 120, h: 160 });
    expect(boundsOf(r.rects)).toEqual(r.box);
  });

  it('左上角（nw）：右下角（500, 200）不動', () => {
    const r = snapGroupScale(rects, 'nw', 300, 150, T, lock);   // 寬 400 → 200（×0.5）
    expect(r.box).toEqual({ x: 300, y: 150, w: 200, h: 50 });
    expect(boundsOf(r.rects)).toEqual({ x: 300, y: 150, w: 200, h: 50 });
    const b = boundsOf(r.rects)!;
    expect(b.x + b.w).toBe(500);
    expect(b.y + b.h).toBe(200);
  });

  it('右上角（ne）、左下角（sw）也是對面的角不動', () => {
    const ne = snapGroupScale(rects, 'ne', 700, 50, T, lock);   // 左下角 (100, 200) 不動；寬 600（×1.5）
    expect(ne.box).toEqual({ x: 100, y: 50, w: 600, h: 150 });
    const sw = snapGroupScale(rects, 'sw', 0, 140, T, lock);    // 右上角 (500, 100) 不動；橫向 ×1.25、直向只有 ×0.4 → 以橫向為準
    expect(sw.box).toEqual({ x: 0, y: 100, w: 500, h: 125 });
  });

  it('邊（e / w / n / s）：只縮那一個方向，對面的邊不動，另一個方向完全不動', () => {
    const e = snapGroupScale(rects, 'e', 300, 999, T, lock);   // 就算 keepAspect 也只縮橫向
    expect(e.box).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(e.sy).toBe(1);
    expect(e.rects.map(r => [r.y, r.h])).toEqual(rects.map(r => [r.y, r.h]));
    const w = snapGroupScale(rects, 'w', 300, 0, T, lock);
    expect(w.box).toEqual({ x: 300, y: 100, w: 200, h: 100 });
    const s = snapGroupScale(rects, 's', 0, 300, T, lock);
    expect(s.box).toEqual({ x: 100, y: 100, w: 400, h: 200 });
    expect(s.rects.map(r => [r.x, r.w])).toEqual(rects.map(r => [r.x, r.w]));
    const n = snapGroupScale(rects, 'n', 0, 150, T, lock);
    expect(n.box).toEqual({ x: 100, y: 150, w: 400, h: 50 });
  });

  it('鎖長寬比（預設）：以拉得比較多的那一邊為準，長寬比不變', () => {
    // 外框 400×100：橫向拉到 ×2，直向只拉到 ×1.2 → 以橫向為準
    const a = snapGroupScale(rects, 'se', 900, 220, T, lock);
    expect(a.box.w).toBe(800);
    expect(a.box.h).toBe(200);
    // 直向拉到 ×3、橫向 ×1.1 → 以直向為準
    const b = snapGroupScale(rects, 'se', 540, 400, T, lock);
    expect(b.box.h).toBe(300);
    expect(b.box.w).toBe(1200);
  });

  it('Shift（keepAspect = false）：橫直各縮各的', () => {
    const r = snapGroupScale(rects, 'se', 900, 220, T, free);
    expect(r.box).toEqual({ x: 100, y: 100, w: 800, h: 120 });
    expect(r.sx).toBe(2);
    expect(r.sy).toBeCloseTo(1.2, 10);
    expect(r.rects[1].h).toBe(96);   // 80 × 1.2
  });

  it('不會翻過去：拖過對面就停在 1 像素，每一塊至少 1 像素', () => {
    const r = snapGroupScale(rects, 'se', 0, 0, T, free);
    expect(r.box.w).toBe(1);
    expect(r.box.h).toBe(1);
    expect(r.rects.every(x => x.w >= 1 && x.h >= 1)).toBe(true);
    const l = snapGroupScale(rects, 'nw', 9999, 9999, T, lock);
    expect(l.box.w).toBeGreaterThanOrEqual(1);
    expect(l.box.h).toBeGreaterThanOrEqual(1);
    expect(l.rects.every(x => x.w >= 1 && x.h >= 1)).toBe(true);
  });

  it('滑鼠位置有小數也會先四捨五入，結果都是整數', () => {
    const r = snapGroupScale(rects, 'se', 733.4, 217.6, T, free);
    expect(r.box).toEqual({ x: 100, y: 100, w: 633, h: 118 });
    expect(r.rects.every(x => [x.x, x.y, x.w, x.h].every(Number.isInteger))).toBe(true);
  });

  it('吸附：被拖的邊靠近沒被選到的螢幕的邊就吸過去（自由縮放）', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);   // 有 d 的左邊 700、畫布邊 1000…
    const r = snapGroupScale(rects, 'se', 697, 230, t, { threshold: 8, snap: true, keepAspect: false });
    expect(r.box.x + r.box.w).toBe(700);
    expect(r.guides).toContainEqual({ axis: 'x', at: 700 });
    expect(r.box.h).toBe(130);   // y 沒有靠近的線（目標是 300 / 350 / 400，差太多）
  });

  it('吸附：鎖長寬比時，吸到的那一邊決定倍數，另一邊照比例跟著算', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    const r = snapGroupScale(rects, 'se', 697, 200, t, { threshold: 8, snap: true, keepAspect: true });
    expect(r.box).toEqual({ x: 100, y: 100, w: 600, h: 150 });   // 右邊吸到 700 → ×1.5 → 高 150
    expect(r.guides).toContainEqual({ axis: 'x', at: 700 });
  });

  it('吸附：吸畫布的邊；組裡面自己的邊不會吸', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    const r = snapGroupScale(rects, 'se', 600, 397, t, { threshold: 8, snap: true, keepAspect: false });
    expect(r.box.y + r.box.h).toBe(400);   // 畫布下緣
    // 滑鼠到 b 的右邊（310）附近：b 是選到的，不是吸附的線
    const near = snapGroupScale(rects, 'se', 312, 150, t, { threshold: 8, snap: true, keepAspect: false });
    expect(near.box.w).toBe(212);
  });

  it('Alt（snap = false）不吸附', () => {
    const t = groupTargets(C, draft3.items, ['a', 'b', 'c']);
    const r = snapGroupScale(rects, 'se', 697, 230, t, { threshold: 8, snap: false, keepAspect: false });
    expect(r.box.w).toBe(597);
    expect(r.guides).toEqual([]);
  });

  it('只選一塊也一樣：等於縮那一塊自己', () => {
    const one = [draft3.items[0].dest];   // (100,100,100,50)
    const r = snapGroupScale(one, 'se', 300, 100, T, free);
    expect(r.rects[0]).toEqual({ x: 100, y: 100, w: 200, h: 1 });
  });

  it('單塊縮放走同一套：自由縮放（Shift）時跟原本的單塊縮放 snapResize 結果一樣', () => {
    const start = { x: 100, y: 100, w: 200, h: 100 };
    const t = snapTargets(C, [{ x: 500, y: 0, w: 100, h: 400 }]);
    for (const hd of ['nw', 'ne', 'sw', 'se'] as const) {
      for (const [mx, my, snap] of [[330.4, 190.2, true], [497, 60, true], [10, 10, false], [150, 400, true], [100, 100, true]] as const) {
        const a = snapGroupScale([start], hd, mx, my, t, { threshold: 8, snap, keepAspect: false });
        const b = snapResize(start, hd, mx, my, t, { threshold: 8, snap });
        expect(a.rects[0]).toEqual(b.rect);
      }
    }
  });

  it('單塊縮放鎖長寬比（預設）：長寬比不變', () => {
    const start = { x: 100, y: 100, w: 200, h: 100 };
    const r = snapGroupScale([start], 'se', 500, 250, snapTargets(C, []), { threshold: 8, snap: false, keepAspect: true });
    expect(r.rects[0]).toEqual({ x: 100, y: 100, w: 400, h: 200 });
  });

  it('沒有東西 = 空', () => {
    expect(snapGroupScale([], 'se', 10, 10, T, lock).rects).toEqual([]);
    expect(scaleGroupTo([], { w: 10 }, true)).toEqual([]);
    expect(scaleGroupPct([], 50)).toEqual([]);
  });

  it('scaleGroupPct：50 = 縮成一半，左上角不動；200 = 放大一倍', () => {
    const half = scaleGroupPct(rects, 50);
    expect(boundsOf(half)).toEqual({ x: 100, y: 100, w: 200, h: 50 });
    expect(half[0]).toEqual({ x: 100, y: 100, w: 50, h: 25 });
    expect(half[1]).toEqual({ x: 175, y: 110, w: 30, h: 40 });
    expect(boundsOf(scaleGroupPct(rects, 200))).toEqual({ x: 100, y: 100, w: 800, h: 200 });
    expect(scaleGroupPct(rects, 100)).toEqual(rects);
  });

  it('scaleGroupPct：不合理的百分比不動；縮很小每一塊也至少 1 像素', () => {
    expect(scaleGroupPct(rects, 0)).toEqual(rects);
    expect(scaleGroupPct(rects, -5)).toEqual(rects);
    expect(scaleGroupPct(rects, Number.NaN)).toEqual(rects);
    expect(scaleGroupPct(rects, 0.1).every(r => r.w >= 1 && r.h >= 1)).toBe(true);
  });

  it('scaleGroupTo：改寬或高，左上角不動；鎖長寬比時另一邊照比例，沒鎖就不動', () => {
    expect(boundsOf(scaleGroupTo(rects, { w: 200 }, true))).toEqual({ x: 100, y: 100, w: 200, h: 50 });
    expect(boundsOf(scaleGroupTo(rects, { w: 200 }, false))).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(boundsOf(scaleGroupTo(rects, { h: 300 }, true))).toEqual({ x: 100, y: 100, w: 1200, h: 300 });
    expect(boundsOf(scaleGroupTo(rects, { h: 300 }, false))).toEqual({ x: 100, y: 100, w: 400, h: 300 });
    const tiny = scaleGroupTo(rects, { w: 0 }, false);   // 寬最小 1，每一塊至少 1 像素
    expect(tiny.every(r => r.w >= 1 && r.h >= 1)).toBe(true);
    expect(boundsOf(tiny)!.w).toBeLessThanOrEqual(3);
  });

  it('一次拖曳 = 復原一步：拖的途中只換現在的樣子，放開記一步，復原整組回原樣', () => {
    const keys = ['a', 'b', 'c'];
    const sel = draft3.items.filter(i => keys.includes(i.key));
    const t = groupTargets(C, draft3.items, keys);
    let h = newHistory(draft3);
    for (const [mx, my] of [[520, 210], [640, 240], [900, 300]] as const) {
      const g = snapGroupScale(sel.map(i => i.dest), 'se', mx, my, t, { threshold: 4, snap: true, keepAspect: true });
      h = transient(h, patchDraftItems(h.present, movePatches(sel, g.rects)));
    }
    h = settle(h, draft3);
    expect(h.past.length).toBe(1);
    expect(boundsOf(dests(h.present, keys))).toEqual({ x: 100, y: 100, w: 800, h: 200 });
    expect(h.present.items[3]).toBe(draft3.items[3]);   // 沒選到的 d 不動
    const u = undo(h);
    expect(u.present).toBe(draft3);
  });

  it('縮完的大小跟標準大小差太多，「被拉伸」的判斷照原本的規則算（大小直接寫在草稿裡）', () => {
    const g = snapGroupScale(dests(draft3, ['a', 'b']), 'se', 700, 300, T, free);
    const next = patchDraftItems(draft3, movePatches([draft3.items[0], draft3.items[1]], g.rects));
    expect(next.items[0].dest.w).toBeGreaterThan(draft3.items[0].dest.w);
    expect(next.items[0].rotate).toBe(0);   // 只改位置大小，轉動翻轉不動
    expect(next.items[1].flipH).toBe(true);
  });
});

describe('patchDraftItems / removeScreensFromDraft', () => {
  it('沒有任何一塊真的變了 → 還是同一個草稿（不會多一步）', () => {
    expect(patchDraftItems(draft3, [])).toBe(draft3);
    expect(patchDraftItems(draft3, movePatches(draft3.items, draft3.items.map(i => ({ ...i.dest }))))).toBe(draft3);
    expect(patchDraftItems(draft3, [{ key: 'zzz', patch: { flipH: true } }])).toBe(draft3);
  });

  it('沒被改到的螢幕維持同一個物件；沒選到的完全不動', () => {
    const next = patchDraftItems(draft3, flipPatches([draft3.items[0]], 'h'));
    expect(next.items[0].flipH).toBe(true);
    expect(next.items[1]).toBe(draft3.items[1]);
    expect(next.items[3]).toBe(draft3.items[3]);
  });

  it('removeScreensFromDraft：沒有要拿掉的 = 同一個草稿', () => {
    expect(removeScreensFromDraft(draft3, ['x', 'y'])).toBe(draft3);
    expect(removeScreensFromDraft(draft3, ['b', 'd']).items.map(i => i.key)).toEqual(['a', 'c']);
  });
});

describe('置中：整組放到畫布正中間', () => {
  it('左右置中：整組外框置中，相對位置不變', async () => {
    const { centerGroupOnCanvas } = await import('./ledTemplateSelect');
    const out = centerGroupOnCanvas([{ x: 0, y: 10, w: 100, h: 50 }, { x: 150, y: 20, w: 50, h: 50 }], { width: 1000, height: 500 }, 'x');
    expect(out).toEqual([{ x: 400, y: 10, w: 100, h: 50 }, { x: 550, y: 20, w: 50, h: 50 }]);
  });
  it('上下置中：只動上下', async () => {
    const { centerGroupOnCanvas } = await import('./ledTemplateSelect');
    const out = centerGroupOnCanvas([{ x: 7, y: 0, w: 10, h: 100 }], { width: 1000, height: 500 }, 'y');
    expect(out).toEqual([{ x: 7, y: 200, w: 10, h: 100 }]);
  });
  it('沒有東西 → 空的', async () => {
    const { centerGroupOnCanvas } = await import('./ledTemplateSelect');
    expect(centerGroupOnCanvas([], { width: 10, height: 10 }, 'x')).toEqual([]);
  });
});

describe('selectionInfo：選取外框 / 全部外框', () => {
  const items = [
    { key: 'a', dest: { x: 10, y: 20, w: 100, h: 50 } },
    { key: 'b', dest: { x: 200, y: 0, w: 40, h: 300 } },
    { key: 'c', dest: { x: 0, y: 0, w: 8, h: 8 } },
  ];
  it('選了兩塊 = 兩塊的外框和左上角', async () => {
    const m = await import('./ledTemplateSelect');
    const i = m.selectionInfo(items, ['a', 'b'])!;
    expect(i).toEqual({ all: false, count: 2, box: { x: 10, y: 0, w: 230, h: 300 } });
    expect(m.selectionInfoText(i)).toBe('選了 2 塊：寬 230 × 高 300 點 · 左上 10, 0');
  });
  it('沒選 = 全部的外框；全選得到一樣的外框；沒有螢幕 = null', async () => {
    const m = await import('./ledTemplateSelect');
    const none = m.selectionInfo(items, [])!;
    expect(m.selectionInfoText(none)).toBe('全部 3 塊：寬 240 × 高 300 點');
    expect(m.selectionInfo(items, m.selectAllKeys(items))!.box).toEqual(none.box);
    expect(m.selectionInfo([], [])).toBeNull();
  });
});
