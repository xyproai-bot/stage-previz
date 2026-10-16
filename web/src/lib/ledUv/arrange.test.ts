// 自動貼 UV 第 3 階段的純函式：轉 / 翻的組合、大小鎖死、畫布大小、對齊螢幕清單、連在一起、整組轉 / 翻、存檔格式
import { describe, expect, it } from 'vitest';
import { applyLocalTransform, localTransform, type PlacementInput, type Rotation } from '../ledTemplate';
import { patchDraftItems, type Draft } from '../ledTemplateDraft';
import { rotatePlacement90 } from '../ledTemplateEdit';
import { movePatches } from '../ledTemplateSelect';
import {
  arrangeTransformPatches, arrangementFromDoc, arrangementFromPack, autoCanvasOf, autoLayoutDoc, canTransformSelection, CANVAS_MAX, dimsOf,
  docFromArrangement, expandSelection, joinGroups, moveAllToTopLeft, normalizeDoc, parseArrangement, patchDoc, placedOf, problemsOf,
  pruneGroups, reconcileArrangement, reconcileDoc, resolveArrangement, setCanvasMode, setCustomCanvas, splitGroups, unitPatches,
  type ArrangeDoc, type ArrangeNative, type Arrangement, type UnitOp,
} from './arrange';
import { ALL_ORIENTATIONS, composeOrientation, invertOrientation, isIdentity, orientationOf, transformOf, type Orientation } from './orient';
import { canvasPoint } from './place';
import type { Placed } from './pack';
import { analyzeObject, assignVertices } from './surfaces';
import { gridPrim, mergePrims } from './testing';

const NATIVES: ArrangeNative[] = [
  { key: 'a', name: '弧牆下', w: 800, h: 200, fixed: false },
  { key: 'b', name: '弧牆上', w: 800, h: 200, fixed: false },
  { key: 'c', name: '右牆', w: 300, h: 500, fixed: false },
  { key: 'k', name: '保留的', w: 120, h: 60, fixed: true },
];
const PACK = {
  canvas: { width: 1200, height: 1000 },
  placed: new Map<string, Placed>([
    ['a', { x: 0, y: 200, w: 800, h: 200, rotate: 0, flipH: false, flipV: false }],
    ['b', { x: 0, y: 0, w: 800, h: 200, rotate: 0, flipH: false, flipV: false }],
    ['c', { x: 800, y: 0, w: 300, h: 500, rotate: 0, flipH: false, flipV: false }],
    ['k', { x: 0, y: 500, w: 120, h: 60, rotate: 0, flipH: false, flipV: false }],
  ]),
};
const base = (): ArrangeDoc => docFromArrangement(arrangementFromPack(NATIVES, PACK), NATIVES);
const item = (d: Draft, k: string): PlacementInput => d.items.find(i => i.key === k)!;

describe('orient：8 種擺法的組合與反轉', () => {
  const pts: [number, number][] = [[0, 0], [1, 0], [0, 1], [0.25, 0.75], [1, 1]];
  it('8 種都找得回來；組合 = 先做裡面的、再做外面的（用點驗，不是查表）；反轉 + 組合 = 不轉不翻', () => {
    expect(ALL_ORIENTATIONS).toHaveLength(8);
    for (const a of ALL_ORIENTATIONS) {
      expect(orientationOf(transformOf(a))).toEqual(a);
      expect(isIdentity(composeOrientation(a, invertOrientation(a)))).toBe(true);
      expect(isIdentity(composeOrientation(invertOrientation(a), a))).toBe(true);
      for (const b of ALL_ORIENTATIONS) {
        const c = composeOrientation(a, b);
        for (const p of pts) {
          const via = applyLocalTransform(transformOf(a), ...applyLocalTransform(transformOf(b), p[0], p[1]));
          const direct = applyLocalTransform(transformOf(c), p[0], p[1]);
          expect(direct[0]).toBeCloseTo(via[0], 12);
          expect(direct[1]).toBeCloseTo(via[1], 12);
        }
      }
    }
  });
});

describe('大小鎖死：寬高是規格決定的', () => {
  it('轉 90° / 270° 對調寬高，轉 0° / 180° 不變；翻轉不影響大小', () => {
    expect(dimsOf(NATIVES[0], 0)).toEqual({ w: 800, h: 200 });
    expect(dimsOf(NATIVES[0], 90)).toEqual({ w: 200, h: 800 });
    expect(dimsOf(NATIVES[0], 180)).toEqual({ w: 800, h: 200 });
    expect(dimsOf(NATIVES[0], 270)).toEqual({ w: 200, h: 800 });
    expect(placedOf(NATIVES[0], { x: 5, y: 6, rotate: 90, flipH: true, flipV: false })).toEqual({ x: 5, y: 6, w: 200, h: 800, rotate: 90, flipH: true, flipV: false });
  });

  it('編輯器想把大小改掉（拖角落、打數字）→ 一律鎖回規格；位置照改', () => {
    const d = base();
    const resized = patchDoc(d, x => patchDraftItems(x, [{ key: 'a', patch: { dest: { x: 50, y: 60, w: 123, h: 77 } } }]), NATIVES);
    expect(item(resized, 'a').dest).toEqual({ x: 50, y: 60, w: 800, h: 200 });
    // 整組縮放（複選拖虛線外框）也一樣
    const scaled = patchDoc(d, x => patchDraftItems(x, movePatches(x.items, x.items.map(i => ({ x: i.dest.x * 2, y: i.dest.y * 2, w: i.dest.w * 2, h: i.dest.h * 2 })))), NATIVES);
    for (const n of NATIVES) {
      const it = item(scaled, n.key);
      expect({ w: it.dest.w, h: it.dest.h }).toEqual({ w: n.w, h: n.h });
    }
    expect(item(scaled, 'c').dest.x).toBe(1600);
  });

  it('保留原本 UV 的物件不能轉、不能翻（只能搬）', () => {
    const d = base();
    const t = patchDoc(d, x => patchDraftItems(x, [{ key: 'k', patch: { rotate: 90, flipH: true, dest: { x: 10, y: 10, w: 60, h: 120 } } }]), NATIVES);
    expect(item(t, 'k')).toMatchObject({ rotate: 0, flipH: false, flipV: false, dest: { x: 10, y: 10, w: 120, h: 60 } });
  });

  it('什麼都沒改 = 同一個物件（復原重做不會多一步）', () => {
    const d = base();
    expect(normalizeDoc(d, NATIVES)).toBe(d);
    expect(patchDoc(d, x => patchDraftItems(x, [{ key: 'a', patch: { dest: { ...item(d, 'a').dest } } }]), NATIVES)).toBe(d);
  });

  it('一般轉 90°（版型編輯器同一個函式）→ 寬高對調、中心不動、鎖死的大小也對', () => {
    const d = base();
    const r = patchDoc(d, x => patchDraftItems(x, [{ key: 'a', patch: rotatePlacement90(item(x, 'a'), 1) }]), NATIVES);
    expect(item(r, 'a')).toMatchObject({ rotate: 90, dest: { w: 200, h: 800 } });
    expect(item(r, 'a').dest.x + 100).toBe(400);   // 中心 x 不動
    expect(item(r, 'a').dest.y + 400).toBe(300);   // 中心 y 不動
  });
});

describe('畫布大小', () => {
  it('自動 = 剛好包住全部（進位到 8 的倍數、至少 16）；一塊都沒有 = 0', () => {
    expect(autoCanvasOf([{ x: 0, y: 0, w: 801, h: 203 }])).toEqual({ width: 808, height: 208 });
    expect(autoCanvasOf([{ x: 0, y: 0, w: 3, h: 3 }])).toEqual({ width: 16, height: 16 });
    expect(autoCanvasOf([])).toEqual({ width: 0, height: 0 });
  });

  it('預設排法的畫布 == 自動排版的畫布（沒動過的人看到的跟以前一樣）', () => {
    const d = base();
    expect({ w: d.width, h: d.height }).toEqual({ w: 1104, h: 560 });
    expect(d.canvasMode).toBe('auto');
  });

  it('自動畫布跟著螢幕長：拖遠了變大，拖回來變小；自己填的不跟著變，範圍 16 ~ 32768', () => {
    const d = base();
    const far = patchDoc(d, x => patchDraftItems(x, [{ key: 'c', patch: { dest: { x: 2000, y: 0, w: 300, h: 500 } } }]), NATIVES);
    expect({ w: far.width, h: far.height }).toEqual({ w: 2304, h: 560 });
    const custom = setCustomCanvas(far, { width: 8800, height: 2024 }, NATIVES);
    expect(custom).toMatchObject({ canvasMode: 'custom', width: 8800, height: 2024 });
    const moved = patchDoc(custom, x => patchDraftItems(x, [{ key: 'c', patch: { dest: { x: 10, y: 10, w: 300, h: 500 } } }]), NATIVES);
    expect({ w: moved.width, h: moved.height }).toEqual({ w: 8800, h: 2024 });
    expect(setCustomCanvas(custom, { width: 99999 }, NATIVES).width).toBe(CANVAS_MAX);
    expect(setCustomCanvas(custom, { height: 1 }, NATIVES).height).toBe(16);
    const back = setCanvasMode(custom, 'auto', NATIVES);
    expect(back.canvasMode).toBe('auto');
    expect(back.width).toBe(autoCanvasOf(back.items.map(i => i.dest)).width);
    expect(setCanvasMode(back, 'auto', NATIVES)).toBe(back);
  });

  it('超出畫布 / 重疊會抓到；貼在一起（邊對邊）不算重疊', () => {
    const placed = new Map<string, Placed>([
      ['a', { x: 0, y: 200, w: 800, h: 200, rotate: 0, flipH: false, flipV: false }],
      ['b', { x: 0, y: 0, w: 800, h: 200, rotate: 0, flipH: false, flipV: false }],
      ['c', { x: 700, y: 100, w: 300, h: 500, rotate: 0, flipH: false, flipV: false }],
      ['k', { x: -5, y: 500, w: 120, h: 60, rotate: 0, flipH: false, flipV: false }],
    ]);
    const p = problemsOf(placed, { width: 900, height: 1000 });
    expect(p.outside.sort()).toEqual(['c', 'k']);
    expect(p.overlaps).toEqual([['a', 'c'], ['b', 'c']]);
    expect(problemsOf(new Map([...placed].filter(([k]) => k === 'a' || k === 'b')), { width: 800, height: 400 })).toEqual({ outside: [], overlaps: [] });
  });
});

describe('對齊螢幕清單（點數改了、勾的螢幕變了）', () => {
  it('還在的保留位置 / 轉動 / 翻轉，大小跟著新規格；新多出來的放自動排的位置；不見的拿掉', () => {
    const arr: Arrangement = {
      v: 1, canvasMode: 'auto', canvas: { width: 100, height: 100 },
      items: [
        { key: 'a', x: 40, y: 50, rotate: 90, flipH: true, flipV: false },
        { key: 'gone', x: 1, y: 1, rotate: 0, flipH: false, flipV: false },
      ],
      groups: [['a', 'gone']],
    };
    const next: ArrangeNative[] = [{ ...NATIVES[0], w: 1000, h: 300 }, NATIVES[1]];
    const rec = reconcileArrangement(arr, next, PACK);
    expect(rec.items).toEqual([
      { key: 'a', x: 40, y: 50, rotate: 90, flipH: true, flipV: false },
      { key: 'b', x: 0, y: 0, rotate: 0, flipH: false, flipV: false },
    ]);
    expect(rec.groups).toEqual([]);
    // 內容沒變 → 同一個物件
    expect(reconcileArrangement(rec, next, PACK)).toBe(rec);
    const r = resolveArrangement(next, PACK, arr);
    expect(r.placed.get('a')).toMatchObject({ w: 300, h: 1000, rotate: 90, flipH: true });
  });

  it('草稿也一樣：點數改了，位置 / 轉動留著，大小換成新的', () => {
    let d = base();
    d = patchDoc(d, x => patchDraftItems(x, [{ key: 'a', patch: { ...rotatePlacement90(item(x, 'a'), 1), } }]), NATIVES);
    const bigger = NATIVES.map(n => (n.key === 'a' ? { ...n, w: 900, h: 250 } : n));
    const r = reconcileDoc(d, bigger, PACK);
    expect(item(r, 'a')).toMatchObject({ rotate: 90, dest: { w: 250, h: 900 } });
    expect(reconcileDoc(r, bigger, PACK)).toBe(r);
  });
});

describe('全部靠左上 / 自動排一次', () => {
  it('全部靠左上：整組平移，最左最上的貼著 (0, 0)，相對位置（貼著的）完全不變', () => {
    let d = base();
    d = patchDoc(d, x => patchDraftItems(x, movePatches(x.items, x.items.map(i => ({ ...i.dest, x: i.dest.x + 137, y: i.dest.y + 55 })))), NATIVES);
    const top = moveAllToTopLeft(d, NATIVES);
    expect(Math.min(...top.items.map(i => i.dest.x))).toBe(0);
    expect(Math.min(...top.items.map(i => i.dest.y))).toBe(0);
    for (const i of d.items) {
      const j = item(top, i.key);
      expect(j.dest.x - i.dest.x).toBe(-137);
      expect(j.dest.y - i.dest.y).toBe(-55);
    }
    expect(moveAllToTopLeft(top, NATIVES)).toBe(top);
  });

  it('自動排一次：位置 / 轉動 / 翻轉重來；畫布模式、自己填的大小、連在一起的組保留', () => {
    let d = base();
    d = patchDoc(d, x => patchDraftItems(x, [{ key: 'a', patch: { ...rotatePlacement90(item(x, 'a'), 1), flipH: true } }, { key: 'c', patch: { dest: { x: 3, y: 4, w: 300, h: 500 } } }]), NATIVES);
    d = { ...d, groups: [['a', 'b']] };
    d = setCustomCanvas(d, { width: 8800, height: 2024 }, NATIVES);
    const re = autoLayoutDoc(d, NATIVES, PACK);
    for (const n of NATIVES) expect(item(re, n.key).dest).toEqual({ x: PACK.placed.get(n.key)!.x, y: PACK.placed.get(n.key)!.y, w: n.w, h: n.h });
    expect(item(re, 'a')).toMatchObject({ rotate: 0, flipH: false, flipV: false });
    expect(re).toMatchObject({ canvasMode: 'custom', width: 8800, height: 2024, groups: [['a', 'b']] });
  });
});

describe('連在一起', () => {
  it('點一塊就選到整組；連起來的跟原本的組併成一大組；拆開', () => {
    const groups = [['a', 'b']];
    expect(expandSelection(['b'], groups)).toEqual(['b', 'a']);
    expect(expandSelection(['c'], groups)).toEqual(['c']);
    expect(joinGroups(groups, ['c', 'a'])).toEqual([['c', 'a', 'b']]);
    expect(joinGroups(groups, ['c'])).toEqual([['a', 'b']]);
    expect(joinGroups([['a', 'b'], ['c', 'k']], ['b', 'k']).map(g => [...g].sort())).toEqual([['a', 'b', 'c', 'k']]);
    expect(splitGroups([['a', 'b'], ['c', 'k']], ['a'])).toEqual([['c', 'k']]);
    expect(pruneGroups([['a', 'x'], ['b', 'c', 'b']], new Set(['a', 'b', 'c']))).toEqual([['b', 'c']]);
  });
});

/** 一塊放在畫布上以後，螢幕上的位置 (lx, ly) 在畫布上的像素 */
function pixelOf(it: PlacementInput, lx: number, ly: number): [number, number] {
  const p: Placed = { x: it.dest.x, y: it.dest.y, w: it.dest.w, h: it.dest.h, rotate: it.rotate, flipH: it.flipH, flipV: it.flipV };
  return canvasPoint(p, lx, ly);
}

/** 看起來一樣的擺法寫法可以不同（轉 180° 再左右翻 = 上下翻）：比位置 + 實際的轉換矩陣 */
const look = (items: PlacementInput[]) => items.map(i => ({ key: i.key, dest: i.dest, o: orientationOf(transformOf({ rotate: i.rotate, flipH: i.flipH, flipV: i.flipV })) }));

describe('整組當一個整體轉 / 翻', () => {
  // 一組四塊，各種擺法，外框 1100 × 700
  const unit = (): PlacementInput[] => [
    { key: 'a', dest: { x: 100, y: 300, w: 800, h: 200 }, rotate: 0, flipH: false, flipV: false },
    { key: 'b', dest: { x: 100, y: 100, w: 800, h: 200 }, rotate: 180, flipH: true, flipV: false },
    { key: 'c', dest: { x: 900, y: 100, w: 300, h: 500 }, rotate: 90, flipH: false, flipV: true },
    { key: 'd', dest: { x: 100, y: 500, w: 200, h: 300 }, rotate: 270, flipH: true, flipV: true },
  ];
  const apply = (items: PlacementInput[], op: UnitOp): PlacementInput[] => {
    const patches = new Map(unitPatches(items, op).map(p => [p.key, p.patch]));
    return items.map(i => ({ ...i, ...patches.get(i.key)! } as PlacementInput));
  };
  const box = (items: PlacementInput[]) => ({
    x: Math.min(...items.map(i => i.dest.x)), y: Math.min(...items.map(i => i.dest.y)),
    x1: Math.max(...items.map(i => i.dest.x + i.dest.w)), y1: Math.max(...items.map(i => i.dest.y + i.dest.h)),
  });

  it('每一塊上的每一點：轉 / 翻以後的位置 == 整組外框做同樣動作的位置（獨立寫的公式，不是呼叫同一個函式）', () => {
    const before = unit();
    const b0 = box(before), W = b0.x1 - b0.x, H = b0.y1 - b0.y;
    const samples: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1], [0.3, 0.8], [0.5, 0.5]];
    for (const op of ['rotCW', 'rotCCW', 'flipH', 'flipV'] as UnitOp[]) {
      const after = apply(before, op);
      const b1 = box(after);
      // 中心不動（整數四捨五入，最多差 0.5）
      expect(Math.abs((b1.x + b1.x1) / 2 - (b0.x + b0.x1) / 2)).toBeLessThanOrEqual(0.5);
      expect(Math.abs((b1.y + b1.y1) / 2 - (b0.y + b0.y1) / 2)).toBeLessThanOrEqual(0.5);
      for (let k = 0; k < before.length; k++) {
        for (const [lx, ly] of samples) {
          const [px, py] = pixelOf(before[k], lx, ly);
          const rx = px - b0.x, ry = py - b0.y;
          const [qx, qy] = pixelOf(after[k], lx, ly);
          const expected = op === 'rotCW' ? [b1.x + (H - ry), b1.y + rx]
            : op === 'rotCCW' ? [b1.x + ry, b1.y + (W - rx)]
              : op === 'flipH' ? [b1.x + (W - rx), b1.y + ry]
                : [b1.x + rx, b1.y + (H - ry)];
          expect(qx, `${op} ${before[k].key} (${lx},${ly}) x`).toBeCloseTo(expected[0], 9);
          expect(qy, `${op} ${before[k].key} (${lx},${ly}) y`).toBeCloseTo(expected[1], 9);
        }
      }
      // 大小還是規格：轉 90° 的寬高對調，其他不變
      before.forEach((it, i) => {
        const swapped = op === 'rotCW' || op === 'rotCCW';
        expect(after[i].dest.w).toBe(swapped ? it.dest.h : it.dest.w);
        expect(after[i].dest.h).toBe(swapped ? it.dest.w : it.dest.h);
      });
    }
  });

  it('貼著的邊轉完還是貼著；順時針轉 4 次 = 原樣；先轉再轉回去 = 原樣；翻兩次 = 原樣', () => {
    const before = unit();
    let cur = before;
    for (let i = 0; i < 4; i++) cur = apply(cur, 'rotCW');
    // 中心有四捨五入，4 次回到原本的位置（不是漂走）
    expect(look(cur)).toEqual(look(before));
    expect(look(apply(apply(before, 'rotCW'), 'rotCCW'))).toEqual(look(before));
    expect(look(apply(apply(before, 'flipH'), 'flipH'))).toEqual(look(before));
    expect(look(apply(apply(before, 'flipV'), 'flipV'))).toEqual(look(before));
    // a 的上邊（y=300）貼著 b 的下邊（300）；轉完貼著的距離還是 0
    const r = apply(before, 'rotCW');
    const a = r.find(i => i.key === 'a')!.dest, b = r.find(i => i.key === 'b')!.dest;
    expect(a.x === b.x + b.w || b.x === a.x + a.w).toBe(true);
  });

  it('arrangeTransformPatches：整組一起轉；單獨的各自在原地轉（跟版型編輯器一樣）；保留的跳過；整組裡有保留的就整組不動', () => {
    const a = item(base(), 'a'), b = item(base(), 'b'), c = item(base(), 'c'), k = item(base(), 'k');
    const none = new Set<string>();
    const g = arrangeTransformPatches('rotate', [a, b], [['a', 'b']], none);
    expect(g.map(p => p.key).sort()).toEqual(['a', 'b']);
    expect(g.find(p => p.key === 'a')!.patch.dest).toEqual(unitPatches([a, b], 'rotCW').find(p => p.key === 'a')!.patch.dest);
    const single = arrangeTransformPatches('rotate', [c], [['a', 'b']], none);
    expect(single).toEqual([{ key: 'c', patch: rotatePlacement90(c, 1) }]);
    expect(arrangeTransformPatches('flipH', [c], [], none)).toEqual([{ key: 'c', patch: { flipH: true } }]);
    expect(arrangeTransformPatches('rotate', [k], [], new Set(['k']))).toEqual([]);
    expect(arrangeTransformPatches('rotate', [a, k], [['a', 'k']], new Set(['k']))).toEqual([]);
    expect(canTransformSelection([k], [], new Set(['k']))).toBe(false);
    expect(canTransformSelection([a, k], [], new Set(['k']))).toBe(true);
  });
});

describe('存檔格式', () => {
  it('排法 → JSON → 讀回來一模一樣；亂七八糟的格式被擋下來', () => {
    let d = base();
    d = patchDoc(d, x => patchDraftItems(x, [{ key: 'a', patch: { ...rotatePlacement90(item(x, 'a'), 1), flipH: true } }]), NATIVES);
    d = { ...d, groups: [['a', 'b']] };
    d = setCustomCanvas(d, { width: 8800, height: 2024 }, NATIVES);
    const arr = arrangementFromDoc(d);
    const back = parseArrangement(JSON.parse(JSON.stringify(arr)));
    expect(back).toEqual(arr);
    expect(parseArrangement(null)).toBeNull();
    expect(parseArrangement({ v: 2, items: [] })).toBeNull();
    expect(parseArrangement({ v: 1, items: [{ key: 'a', x: 1.5, y: 0, rotate: 0, flipH: false, flipV: false }] })).toBeNull();
    expect(parseArrangement({ v: 1, items: [{ key: 'a', x: 1, y: 0, rotate: 45, flipH: false, flipV: false }] })).toBeNull();
    expect(parseArrangement({ v: 1, items: [{ key: 'a', x: 1, y: 0, rotate: 0, flipH: false, flipV: false }, { key: 'a', x: 1, y: 0, rotate: 0, flipH: false, flipV: false }] })).toBeNull();
    // 組裡不存在的螢幕被拿掉
    const g = parseArrangement({ v: 1, canvasMode: 'auto', canvas: { width: 100, height: 100 }, items: [{ key: 'a', x: 1, y: 0, rotate: 0, flipH: false, flipV: false }], groups: [['a', 'zzz']] })!;
    expect(g.groups).toEqual([]);
  });

  it('解出來的轉動只有四種，旋轉型別守住', () => {
    const r: Rotation[] = [0, 90, 180, 270];
    for (const rot of r) expect(localTransform(rot, false, false).a.length).toBe(4);
    const o: Orientation = { rotate: 90, flipH: true, flipV: false };
    expect(orientationOf(transformOf(o))).toEqual(o);
  });
});

describe('不是螢幕的 primitive（外框、背板、舞台結構）整個歸同一片', () => {
  it('橫跨好幾片螢幕的大板子：每個頂點都歸同一片，不會有三角形把兩片拉在一起（排版排得很遠時才不會把物件的外框撐到整張畫布）', () => {
    const wings = mergePrims([gridPrim([-20, 1, -4], [1, 0, 0], [0, 1, 0], 4, 3, 2), gridPrim([16, 1, -4], [1, 0, 0], [0, 1, 0], 4, 3, 2)]);
    const plate = gridPrim([-22, 0, -4.5], [1, 0, 0], [0, 1, 0], 44, 5, 12, { screen: false });
    const a = analyzeObject({ prims: [wings, plate] }, [0, 0, 1]);
    expect(a.kind).toBe('ok');
    expect(a.pieces).toHaveLength(2);
    const asPlate = assignVertices(plate, a.pieces);
    expect(new Set(asPlate.piece).size).toBe(1);
    // 當成螢幕的話，同一塊板子的頂點會分屬兩片，有三角形橫跨（這是以前的行為，也是會出問題的地方）
    const asScreen = assignVertices({ ...plate, screen: true }, a.pieces);
    expect(new Set(asScreen.piece).size).toBe(2);
    // 螢幕自己的三角形不受影響：沒有三角形橫跨兩片
    const asWings = assignVertices(wings, a.pieces);
    for (let t = 0; t + 2 < wings.index.length; t += 3) {
      expect(new Set([asWings.piece[wings.index[t]], asWings.piece[wings.index[t + 1]], asWings.piece[wings.index[t + 2]]]).size).toBe(1);
    }
  });
});
