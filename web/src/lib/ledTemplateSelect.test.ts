import { describe, it, expect } from 'vitest';
import {
  applyMarquee, boundsOf, clickSelect, flipPatches, groupTargets, isAdditive, marqueeBox, marqueeHits, moveGroupTo, movePatches,
  nudgeRects, pressSelect, pruneSelection, releaseSelect, rotatePatches, sameSelection, selectAllKeys, selectionTag, snapGroupMove,
} from './ledTemplateSelect';
import { commit, newHistory, redo, settle, snapMove, snapTargets, transient, undo } from './ledTemplateEdit';
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
