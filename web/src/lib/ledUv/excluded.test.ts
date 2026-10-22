// 自動貼 UV：「不放進畫布」（真的 .glb 整合測試）
//   不放進畫布的螢幕不在排版、不在畫布大小、不在對位圖 / AE 腳本 / 座標表（它們都從 previewLayout 來）、不在舊版面、不在新切的螢幕裡；
//   模型裡它的 UV 一個數字都不動；沒填點數也不擋住套用；3D 預覽知道它套用後不再是 LED。
import { beforeAll, describe, expect, it } from 'vitest';
import type { NodeIO } from '@gltf-transform/core';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { layoutToCsv } from '../ledMap';
import { buildUvFixture, FIXTURE_OLD_CANVAS } from './uvFixture';
import { analyzeModelBytes, buildModelBytes, openModelBytes, type AnalyzeOk } from './pipeline';
import { buildLegacy, buildPlan, excludedIdsOf, pieceScreensOf, type Plan, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { previewLayout, previewPanels } from './previewLayout';
import { buildUvPreview } from './previewUv';
import { EXCLUDE_TEXT, MODE_TEXT } from './text';

let io: NodeIO;
let plain: Uint8Array;
let ana: AnalyzeOk;
const fixture = buildUvFixture();
const objects = fixture.objects.map(o => ({ id: o.id, meshName: o.meshName }));
const idOf = (n: string) => objects.find(o => o.meshName === n)!.id;
const A = () => idOf('LED_A_主牆');
const G = () => idOf('LED_G_雙翼');   // 一個物件兩片分開的牆（會建新切出來的螢幕）

beforeAll(async () => {
  await installNodeModelDecoders();
  io = await createNodeIO();
  plain = await io.writeBinary(buildUvFixture().doc);
  const a = await analyzeModelBytes(io, plain, objects, FIXTURE_OLD_CANVAS);
  if (!a.ok) throw new Error(a.reason);
  ana = a;
});

function inputs(excludeIds: string[] = [], pick = (n: string) => n !== 'LED_H_沒選'): PlanObjectIn[] {
  return fixture.objects.map((o, i) => ({
    id: o.id, name: o.display, order: i, info: ana.infos[o.id], selected: pick(o.meshName), excluded: excludeIds.includes(o.id),
    sizes: { 0: { mode: 'pitch' as const, pitchMm: 20 }, 1: { mode: 'pitch' as const, pitchMm: 20 } },
    manuals: [],
  }));
}
const planOf = (ins: PlanObjectIn[]): Plan => buildPlan(ins, { front: ana.front, metersPerUnit: ana.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS });

describe('不放進畫布：排版', () => {
  it('這一塊的狀態是「不放進畫布」；不排版、沒有位置；其他的照常', () => {
    const base = planOf(inputs());
    const ex = planOf(inputs([A()]));
    const o = ex.objects.find(x => x.id === A())!;
    expect(o.mode).toBe('excluded');
    expect(o.reason).toContain('不放進畫布');
    expect(o.pieces).toEqual([]);
    expect(o.keep).toBeNull();
    expect(MODE_TEXT.excluded).toBe('不放進畫布');
    // 排版清單、位置、畫布大小
    expect(base.items.some(i => i.key === `o:${A()}`)).toBe(true);
    expect(ex.items.some(i => i.key === `o:${A()}`)).toBe(false);
    expect(base.pack.placed.has(`o:${A()}`)).toBe(true);
    expect(ex.pack.placed.has(`o:${A()}`)).toBe(false);
    expect(ex.items.length).toBe(base.items.length - 1);
    expect(ex.canvas.width * ex.canvas.height).toBeLessThanOrEqual(base.canvas.width * base.canvas.height);
    expect(ex.blockers).toEqual([]);
    // 別的物件的狀態不變
    for (const b of base.objects) if (b.id !== A()) expect(ex.objects.find(x => x.id === b.id)!.mode).toBe(b.mode);
    expect(excludedIdsOf(ex)).toEqual([A()]);
    expect(excludedIdsOf(base)).toEqual([]);
  });

  it('勾了「自動貼」又選「不放進畫布」→ 不放進畫布；沒填點數也不擋住套用；原本沒有 UV / 模型裡找不到的也可以', () => {
    const ins = inputs([A()]).map(i => (i.id === A() ? { ...i, selected: true, sizes: {} } : i));
    const ex = planOf(ins);
    expect(ex.objects.find(x => x.id === A())!.mode).toBe('excluded');
    expect(ex.blockers).toEqual([]);
    // 模型裡找不到的物件也能不放進畫布
    const missing = planOf(inputs().map(i => (i.id === A() ? { ...i, info: null, excluded: true } : i)));
    expect(missing.objects.find(x => x.id === A())!.mode).toBe('excluded');
    expect(missing.blockers).toEqual([]);
  });

  it('全部都不放進畫布 → 沒有東西可以貼，不能套用', () => {
    const all = planOf(inputs(objects.map(o => o.id)));
    expect(all.items).toEqual([]);
    expect(all.blockers.length).toBeGreaterThan(0);
    expect(excludedIdsOf(all)).toHaveLength(objects.length);
  });

  it('一個物件有好幾片分開的牆：不放進畫布 → 不建新切出來的螢幕', () => {
    expect(pieceScreensOf(planOf(inputs())).some(p => p.objectId === G())).toBe(true);
    expect(pieceScreensOf(planOf(inputs([G()]))).some(p => p.objectId === G())).toBe(false);
  });

  it('保留原本 UV 的物件也可以改選不放進畫布：不再佔畫布', () => {
    const H = idOf('LED_H_沒選');
    const keep = planOf(inputs());
    expect(keep.objects.find(x => x.id === H)!.mode).toBe('keep');
    expect(keep.items.some(i => i.key === `o:${H}`)).toBe(true);
    const ex = planOf(inputs([H]));
    expect(ex.items.some(i => i.key === `o:${H}`)).toBe(false);
    expect(ex.objects.find(x => x.id === H)!.keep).toBeNull();
  });
});

describe('不放進畫布：對位圖、AE 腳本、座標表、舊版面', () => {
  it('對位圖版面和座標表裡沒有它；其他的都還在', () => {
    const base = planOf(inputs());
    const ex = planOf(inputs([A()]));
    const nameA = fixture.objects.find(o => o.id === A())!.display;
    const ids = (p: Plan) => previewPanels(p).map(x => x.id);
    expect(ids(base)).toContain(`o:${A()}`);
    expect(ids(ex)).not.toContain(`o:${A()}`);
    expect(ids(ex)).toHaveLength(ids(base).length - 1);
    const csv = layoutToCsv(previewLayout(ex));
    expect(csv).not.toContain(nameA);
    expect(layoutToCsv(previewLayout(base))).toContain(nameA);
    // 畫布大小就是排出來的那張
    expect(previewLayout(ex).canvas).toEqual(ex.canvas);
  });

  it('舊版面（保護舊影片）也沒有它', () => {
    const lg = buildLegacy(planOf(inputs([A()])), inputs([A()]), FIXTURE_OLD_CANVAS);
    expect(lg.screens.some(s => s.objectId === A())).toBe(false);
    expect(lg.originalUv).not.toContain(A());
    expect(lg.unprotected.concat(lg.approximate)).not.toContain('主牆');
    const base = buildLegacy(planOf(inputs()), inputs(), FIXTURE_OLD_CANVAS);
    expect(base.screens.some(s => s.objectId === A())).toBe(true);
  });
});

describe('不放進畫布：寫進模型', () => {
  async function uvOf(bytes: Uint8Array, id: string): Promise<number[][]> {
    const read = readLedObjects(await io.readBinary(bytes), objects);
    return read.objects.get(id)!.refs.map(r => Array.from(r.prim.getAttribute('TEXCOORD_0')!.getArray()!));
  }

  it('它的 UV 一個數字都不動；別的物件照新排版；三關檢查都過', async () => {
    const ins = inputs([A()]);
    const plan = planOf(ins);
    const b = await buildModelBytes(io, plain, objects, plan, FIXTURE_OLD_CANVAS);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(await uvOf(b.bytes, A())).toEqual(await uvOf(plain, A()));
    // 有被處理的物件（地屏）UV 換了
    const D = idOf('LED_D_地屏');
    expect(await uvOf(b.bytes, D)).not.toEqual(await uvOf(plain, D));
    // 它的「原本的 UV」不會被存進第二組 UV（不處理的物件不需要）
    expect(b.uv1[A()]).toBeUndefined();
  });

  it('3D 預覽：列出不放進畫布的物件，也沒有它的新 UV', async () => {
    const plan = planOf(inputs([A()]));
    const opened = await openModelBytes(io, plain);
    if (!opened.ok) throw new Error(opened.reason);
    const pv = buildUvPreview(opened.doc, objects, plan, FIXTURE_OLD_CANVAS);
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    expect(pv.preview.excluded).toEqual([A()]);
    expect(Object.keys(pv.preview.objects)).not.toContain(A());
    expect(Object.keys(pv.preview.objects)).toContain(idOf('LED_D_地屏'));
    const none = buildUvPreview(opened.doc, objects, planOf(inputs()), FIXTURE_OLD_CANVAS);
    expect(none.ok && none.preview.excluded).toEqual([]);
  });
});

describe('不放進畫布：說明文字', () => {
  it('列上的提示就是要求的那句；沒有 emoji / 英文稱呼', () => {
    expect(EXCLUDE_TEXT.rowNote).toBe('套用後這塊不再是 LED（類型改成「其他」），要恢復就把類型改回 LED 面板再重新自動貼 UV');
    expect(EXCLUDE_TEXT.choiceAuto + EXCLUDE_TEXT.choiceKeep + EXCLUDE_TEXT.choiceExclude).toBe('自動貼保留原本 UV不放進畫布');
    expect(EXCLUDE_TEXT.summary(2, '提詞LED、側屏')).toContain('2 個物件（提詞LED、側屏）');
  });
});
