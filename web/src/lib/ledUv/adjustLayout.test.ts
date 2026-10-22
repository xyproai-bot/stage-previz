// 自動貼 UV：「調整排版」（套用過一次以後直接到第 3 步排版，拖完按「套用」）
//   - 套用時存的內容有「套用過」的記號；之後自動存草稿也帶著；排版沒動 = 跟記號對得上（「套用」是灰的：還沒改排版）
//   - 照上次存的內容直接套用，寫進模型的 UV 跟上次一模一樣（走四步和走「調整排版」是同一份內容、同一個套用）
//   - 只搬一塊再套用：只有那一塊的 UV 變，其他塊不變；升降的 _正面 / _L / _R 三塊螢幕都還在
import { beforeAll, describe, expect, it } from 'vitest';
import { Document, type Accessor, type Buffer as GBuffer, type Primitive } from '@gltf-transform/core';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { gridPrim, shelfArrangement } from './testing';
import type { PrimGeom } from './surfaces';
import type { Vec3 } from './geometry';
import { analyzeModelBytes, buildModelBytes } from './pipeline';
import { buildPlan, pieceScreensOf, pieceScreenUpdatesOf, splitManuals, type ManualBox, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { editIsApplied, editIsPristine, editSignature, parseEditSnapshot, withAppliedSig, type UvEditSnapshot } from './editState';
import type { Arrangement } from './arrange';

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const OLD = { width: 4000, height: 2000 };
const CANVAS = { width: 4096, height: 4096 };

function buildDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3', arr: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>): Accessor =>
    doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer as GBuffer);
  const toPrim = (g: PrimGeom, u0: number, du: number): Primitive => {
    const uv = new Float32Array(g.uv!.length);
    for (let i = 0; i < uv.length; i += 2) { uv[i] = u0 + g.uv![i] * du; uv[i + 1] = g.uv![i + 1] * 0.5; }
    return doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos))).setAttribute('TEXCOORD_0', acc('VEC2', uv)).setIndices(acc('SCALAR', new Uint32Array(g.index)));
  };
  const led = doc.createMaterial('LED_Screen');
  const scene = doc.createScene('Scene');
  const root = doc.createNode('LED_升降');
  scene.addChild(root);
  const mesh = (name: string, g: PrimGeom, u0: number, du: number) => {
    root.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(toPrim(g, u0, du).setMaterial(led))));
  };
  mesh('升降_正面', gridPrim([-2, 0, 0], X, Y, 4, 2, 3), 0, 0.4);
  mesh('升降_L', gridPrim([-2, 0, 0], Z, Y, 1.5, 2, 3), 0.5, 0.1);
  mesh('升降_R', gridPrim([2, 0, 0], Y, Z, 2, 1.5, 3), 0.7, 0.1);
  return doc;
}

const objects = [{ id: 'so_lift', meshName: 'LED_升降' }];
const pitch = { mode: 'pitch' as const, pitchMm: 20 };
const input = (info: PlanObjectIn['info'], extra: Partial<PlanObjectIn>): PlanObjectIn =>
  ({ id: 'so_lift', name: '升降', order: 0, info, selected: true, sizes: { 0: pitch, 1: pitch, 2: pitch }, manuals: [], ...extra });

const SNAP = (arrangement: Arrangement | null): UvEditSnapshot => ({ v: 1, selected: { so_lift: true }, excluded: {}, forms: {}, overrides: {}, seams: {}, gutter: '0', arrangement });
const roundtrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

beforeAll(async () => { await installNodeModelDecoders(); });

describe('調整排版：套用過的記號', () => {
  it('套用時存的內容有記號；存成 JSON 再讀回來還在，而且對得上（還沒改排版）', () => {
    const snap = SNAP(null);
    expect(editIsApplied(parseEditSnapshot(roundtrip(snap)))).toBe(false);   // 只有草稿 / 從沒套用過：沒有「調整排版」
    const applied = roundtrip(withAppliedSig(snap));
    const back = parseEditSnapshot(applied);
    expect(editIsApplied(back)).toBe(true);
    expect(editIsPristine(back)).toBe(true);
    expect(editSignature(back!)).toBe(editSignature(snap));                   // 記號不算在內容指紋裡（自動存不會因為它重存）
  });

  it('套用之後動過排版 / 設定（自動存時記號帶著）：還是「套用過的」，但不再是原樣', () => {
    const base = withAppliedSig(SNAP(null));
    const moved = { ...base, gutter: '8' };
    const back = parseEditSnapshot(roundtrip(moved));
    expect(editIsApplied(back)).toBe(true);
    expect(editIsPristine(back)).toBe(false);
    const moved2 = { ...base, selected: { so_lift: false } };
    expect(editIsPristine(parseEditSnapshot(roundtrip(moved2)))).toBe(false);
  });

  it('記號壞掉 / 亂填：當作沒有；多的欄位不影響其他內容', () => {
    expect(editIsApplied(parseEditSnapshot({ ...roundtrip(SNAP(null)), appliedSig: 123 }))).toBe(false);
    expect(editIsApplied(parseEditSnapshot({ ...roundtrip(SNAP(null)), appliedSig: '<script>' }))).toBe(false);
  });
});

describe('調整排版 → 套用 == 走四步', () => {
  it('照上次存的排法直接套用：UV 一個數字都沒變；只搬一塊：只有那塊的 UV 變，三塊螢幕都還在', async () => {
    const io = await createNodeIO();
    const bytes = await io.writeBinary(buildDoc());
    const a1 = await analyzeModelBytes(io, bytes, objects, OLD);
    if (!a1.ok) throw new Error(a1.reason);
    const auto1 = buildPlan([input(a1.infos.so_lift, {})], { front: a1.front, metersPerUnit: a1.scaleFactor, oldCanvas: OLD });
    // 第一次：走完四步（自己排過：三塊分開放、第二塊轉 90°）
    const keys = auto1.items.map(i => i.key);
    expect(keys.length).toBe(3);
    const arr1 = shelfArrangement(auto1.items, auto1.pack, { [keys[0]]: { x: 100, y: 100 }, [keys[1]]: { x: 900, y: 300, rotate: 90 } }, CANVAS);
    const plan1 = buildPlan([input(a1.infos.so_lift, {})], { front: a1.front, metersPerUnit: a1.scaleFactor, oldCanvas: OLD, arrangement: arr1 });
    expect(plan1.blockers).toEqual([]);
    const built1 = await buildModelBytes(io, bytes, objects, plan1, OLD);
    if (!built1.ok) throw new Error(built1.reason);
    const screens: ManualBox[] = pieceScreensOf(plan1).map((s, i) => ({ id: `ls_${i}`, name: s.name, uv: s.uv }));
    expect(screens.length).toBe(3);
    // 後台存下來的 edit（套用出來的，有記號）
    const saved = roundtrip(withAppliedSig(SNAP(arr1)));

    // 重新打開：「調整排版」讀回來的內容
    const restored = parseEditSnapshot(saved)!;
    expect(editIsPristine(restored)).toBe(true);
    const reopen = async (arrangement: Arrangement | null) => {
      const a2 = await analyzeModelBytes(io, built1.bytes, objects, plan1.canvas);
      if (!a2.ok) throw new Error(a2.reason);
      const split = splitManuals(a2.infos.so_lift!, screens, plan1.canvas);
      const ins = [input(a2.infos.so_lift!, split)];
      const plan = buildPlan(ins, { front: a2.front, metersPerUnit: a2.scaleFactor, oldCanvas: plan1.canvas, arrangement: arrangement ?? undefined });
      return { a2, plan };
    };
    const same = await reopen(restored.arrangement);
    expect(same.plan.canvas).toEqual(plan1.canvas);
    expect(same.plan.objects[0].pieces.map(p => p.placed)).toEqual(plan1.objects[0].pieces.map(p => p.placed));   // 排版 = 上次套用時的位置
    expect(pieceScreensOf(same.plan)).toEqual([]);                                   // 不多切一份
    expect(pieceScreenUpdatesOf(same.plan).map(u => u.id).sort()).toEqual(['ls_0', 'ls_1', 'ls_2']);   // 三塊螢幕都搬到新位置

    // 沒改直接套用：寫進模型的 UV 跟上次一模一樣
    const built2 = await buildModelBytes(io, built1.bytes, objects, same.plan, plan1.canvas);
    if (!built2.ok) throw new Error(built2.reason);
    const uvsOf = async (b: Uint8Array) => readLedObjects(await io.readBinary(b), objects).objects.get('so_lift')!.geom.prims.map(p => Array.from(p.uv!));
    const u1 = await uvsOf(built1.bytes), u2 = await uvsOf(built2.bytes);
    expect(u2.length).toBe(3);
    u2.forEach((uv, i) => uv.forEach((v, j) => expect(v).toBeCloseTo(u1[i][j], 6)));

    // 只搬第二塊
    const movedArr: Arrangement = { ...restored.arrangement!, items: restored.arrangement!.items.map(it => (it.key === keys[1] ? { ...it, x: it.x + 400, y: it.y + 200 } : it)) };
    const moved = await reopen(movedArr);
    const built3 = await buildModelBytes(io, built1.bytes, objects, moved.plan, plan1.canvas);
    if (!built3.ok) throw new Error(built3.reason);
    const u3 = await uvsOf(built3.bytes);
    const changed = u3.map((uv, i) => uv.some((v, j) => Math.abs(v - u1[i][j]) > 1e-6));
    expect(changed.filter(Boolean).length).toBe(1);
    expect(pieceScreensOf(moved.plan)).toEqual([]);
    expect(pieceScreenUpdatesOf(moved.plan).map(u => u.id).sort()).toEqual(['ls_0', 'ls_1', 'ls_2']);
    // 搬過的那一塊：新的 UV 外框 == 排好的長方形（跟走四步排出來的一樣算法）
    const placed = moved.plan.objects[0].pieces.map(p => p.placed!);
    expect(placed.filter((p, i) => JSON.stringify(p) !== JSON.stringify(plan1.objects[0].pieces[i].placed)).length).toBe(1);
  });
});
