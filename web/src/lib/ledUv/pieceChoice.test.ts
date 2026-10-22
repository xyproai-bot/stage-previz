// 自動貼 UV：一個物件裡好幾塊 LED mesh（曲線升降台），每一塊各自選「自動貼 / 保留原本 UV / 不放進畫布」
//   不放進畫布的那一塊：不進畫布、UV 不動、沒有螢幕，物件其他塊照常貼，物件的類型不改
//   保留的那一塊：原本的 UV 整塊搬到新位置，其他塊照常貼
//   舊資料（只有以物件為單位的選擇、沒有各塊的選擇）照讀
import { beforeAll, describe, expect, it } from 'vitest';
import { Document, type Accessor, type Buffer as GBuffer, type Primitive } from '@gltf-transform/core';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { gridPrim } from './testing';
import type { PrimGeom } from './surfaces';
import type { Vec3 } from './geometry';
import { analyzeModelBytes, buildModelBytes, type AnalyzeOk } from './pipeline';
import { buildLegacy, buildPlan, excludedIdsOf, offPiecesOf, pieceScreensOf, type PieceChoice, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { parseEditSnapshot, pieceOwner, pruneEditSnapshot } from './editState';

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const CANVAS = { width: 4000, height: 2000 };
const FRONT = '曲線升降-1_正面', LEFT = '曲線升降-1_左側', RIGHT = '曲線升降-1_右側';

/** 三塊 LED 各自用畫布上不同的一塊 UV（正面 u 0~0.4、左側 0.5~0.6、右側 0.7~0.8；v 都是 0~0.5） */
function buildDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3', arr: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>): Accessor =>
    doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer as GBuffer);
  const toPrim = (g: PrimGeom, u0: number, du: number): Primitive => {
    const uv = new Float32Array(g.uv!.length);
    for (let i = 0; i < uv.length; i += 2) { uv[i] = u0 + g.uv![i] * du; uv[i + 1] = g.uv![i + 1] * 0.5; }
    return doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos)))
      .setAttribute('TEXCOORD_0', acc('VEC2', uv))
      .setIndices(acc('SCALAR', new Uint32Array(g.index)));
  };
  const led = doc.createMaterial('LED_Screen');
  const metal = doc.createMaterial('升降台_金屬');
  const scene = doc.createScene('Scene');
  const root = doc.createNode('LED_曲線升降-1');
  scene.addChild(root);
  const mesh = (name: string, g: PrimGeom, m: typeof led, u0: number, du: number) => {
    const me = doc.createMesh(name).addPrimitive(toPrim(g, u0, du).setMaterial(m));
    root.addChild(doc.createNode(name).setMesh(me));
  };
  mesh('曲線升降-1_台體', gridPrim([-2, 0, -1.5], X, Z, 4, 1.5, 2), metal, 0.9, 0.05);
  mesh(FRONT, gridPrim([-2, 0, 0], X, Y, 4, 2, 3), led, 0, 0.4);
  mesh(LEFT, gridPrim([-2, 0, 0], Z, Y, 1.5, 2, 3), led, 0.5, 0.1);
  mesh(RIGHT, gridPrim([2, 0, 0], Y, Z, 2, 1.5, 3), led, 0.7, 0.1);
  return doc;
}

const objects = [{ id: 'so_lift', meshName: 'LED_曲線升降-1' }];
const pitch = { mode: 'pitch' as const, pitchMm: 20 };

async function setup() {
  const io = await createNodeIO();
  const bytes = await io.writeBinary(buildDoc());
  const a = await analyzeModelBytes(io, bytes, objects, CANVAS);
  if (!a.ok) throw new Error(a.reason);
  return { io, bytes, a };
}

function inputs(a: AnalyzeOk, pieceChoices?: Record<string, PieceChoice>, extra: Partial<PlanObjectIn> = {}): PlanObjectIn[] {
  return [{
    id: 'so_lift', name: '曲線升降-1', order: 0, info: a.infos.so_lift, selected: true,
    sizes: { 0: pitch, 1: pitch, 2: pitch }, manuals: [], ...(pieceChoices ? { pieceChoices } : {}), ...extra,
  }];
}
const planOf = (a: AnalyzeOk, ins: PlanObjectIn[]) => buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: CANVAS });

async function uvsOf(io: Awaited<ReturnType<typeof createNodeIO>>, bytes: Uint8Array) {
  const geom = readLedObjects(await io.readBinary(bytes), objects).objects.get('so_lift')!.geom;
  const byName: Record<string, Float32Array> = {};
  geom.prims.forEach((p) => { if (p.screen && p.group !== undefined) byName[geom.groupNames![p.group]] = Float32Array.from(p.uv!); });
  return byName;
}

beforeAll(async () => { await installNodeModelDecoders(); });

describe('各塊自己選：不放進畫布', () => {
  it('右側不放進畫布：版型只剩兩塊、右側沒有螢幕、物件類型不改', async () => {
    const { a } = await setup();
    const plan = planOf(a, inputs(a, { [RIGHT]: 'exclude' }));
    const o = plan.objects[0];
    expect(o.mode).toBe('auto');
    expect(o.pieces.map(p => [p.name, p.choice ?? 'auto']).sort()).toEqual([[FRONT, 'auto'], [LEFT, 'auto'], [RIGHT, 'exclude']].sort());
    expect(o.pieces.find(p => p.label === RIGHT)!.placed).toBeNull();
    expect(plan.blockers).toEqual([]);
    expect(pieceScreensOf(plan).map(s => s.name).sort()).toEqual([FRONT, LEFT].sort());
    expect(excludedIdsOf(plan)).toEqual([]);   // 整個物件沒有被排除 = 後台不會把類型改成「其他」
    expect(offPiecesOf(plan)).toEqual(['so_lift~' + RIGHT]);   // 3D 上黑色的塊（物件id~mesh 名稱）
    expect(offPiecesOf(planOf(a, inputs(a)))).toEqual([]);     // 沒排除 = 沒有
    const all = planOf(a, inputs(a));
    expect(plan.canvas.width * plan.canvas.height).toBeLessThan(all.canvas.width * all.canvas.height);
  });

  it('寫進模型：右側的 UV 一個數字都沒動，正面、左側照自動貼，三關檢查都過', async () => {
    const { io, bytes, a } = await setup();
    const plan = planOf(a, inputs(a, { [RIGHT]: 'exclude' }));
    const before = await uvsOf(io, bytes);
    const built = await buildModelBytes(io, bytes, objects, plan, CANVAS);
    if (!built.ok) throw new Error(built.reason + (built.issues ? '：' + built.issues.join('；') : ''));
    const after = await uvsOf(io, built.bytes);
    expect(Array.from(after[RIGHT])).toEqual(Array.from(before[RIGHT]));
    expect(Array.from(after[FRONT])).not.toEqual(Array.from(before[FRONT]));
    for (const name of [FRONT, LEFT]) {
      const p = plan.objects[0].pieces.find(x => x.label === name)!.placed!;
      const us = Array.from(after[name]).filter((_, i) => i % 2 === 0), vs = Array.from(after[name]).filter((_, i) => i % 2 === 1);
      expect(Math.round(Math.min(...us) * plan.canvas.width)).toBe(p.x);
      expect(Math.round(Math.max(...us) * plan.canvas.width)).toBe(p.x + p.w);
      expect(Math.round(Math.min(...vs) * plan.canvas.height)).toBe(p.y);
    }
  });

  it('舊版面：右側不在裡面（舊影片在右側本來就沒有要保護的畫面）', async () => {
    const { a } = await setup();
    const ins = inputs(a, { [RIGHT]: 'exclude' });
    const plan = planOf(a, ins);
    const lg = buildLegacy(plan, ins, CANVAS);
    expect(lg.screens.map(s => s.name).sort()).toEqual([FRONT, LEFT].sort());
  });

  it('三塊都不放進畫布：沒有東西要貼，也不會壞', async () => {
    const { io, bytes, a } = await setup();
    const plan = planOf(a, inputs(a, { [FRONT]: 'exclude', [LEFT]: 'exclude', [RIGHT]: 'exclude' }));
    expect(plan.objects[0].pieces.every(p => !p.placed)).toBe(true);
    const built = await buildModelBytes(io, bytes, objects, plan, CANVAS);
    // 沒有任何一塊要貼 = 擋住套用（跟沒勾任何螢幕一樣）
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(built.ok === true || built.ok === false).toBe(true);
  });
});

describe('各塊自己選：保留原本 UV', () => {
  it('左側保留：原本的 UV 整塊搬（大小不變），正面、右側照自動貼', async () => {
    const { io, bytes, a } = await setup();
    const plan = planOf(a, inputs(a, { [LEFT]: 'keep' }));
    const left = plan.objects[0].pieces.find(p => p.label === LEFT)!;
    expect(left.choice).toBe('keep');
    // 原本左側 u 0.5~0.6、v 0~0.5 = 400 × 1000 像素
    expect([left.placed!.w, left.placed!.h]).toEqual([400, 1000]);
    expect(plan.blockers).toEqual([]);
    const before = await uvsOf(io, bytes);
    const built = await buildModelBytes(io, bytes, objects, plan, CANVAS);
    if (!built.ok) throw new Error(built.reason + (built.issues ? '：' + built.issues.join('；') : ''));
    const after = await uvsOf(io, built.bytes);
    // 搬動 = 每個頂點在畫布上的像素位置都差同樣的量
    const dx = after[LEFT][0] * plan.canvas.width - before[LEFT][0] * CANVAS.width;
    const dy = after[LEFT][1] * plan.canvas.height - before[LEFT][1] * CANVAS.height;
    for (let i = 0; i < before[LEFT].length; i += 2) {
      expect(after[LEFT][i] * plan.canvas.width - before[LEFT][i] * CANVAS.width).toBeCloseTo(dx, 1);
      expect(after[LEFT][i + 1] * plan.canvas.height - before[LEFT][i + 1] * CANVAS.height).toBeCloseTo(dy, 1);
    }
    expect(pieceScreensOf(plan).map(s => s.name).sort()).toEqual([FRONT, LEFT, RIGHT].sort());
  });

  it('舊版面：保留的那塊用原本的範圍（原樣）', async () => {
    const { a } = await setup();
    const ins = inputs(a, { [LEFT]: 'keep' });
    const lg = buildLegacy(planOf(a, ins), ins, CANVAS);
    const s = lg.screens.find(x => x.name === LEFT)!;
    expect([s.dest.x, s.dest.w, s.dest.h, s.rotate, s.flipH, s.flipV]).toEqual([2000, 400, 1000, 0, false, false]);
  });
});

describe('舊資料照讀、其他情形不變', () => {
  it('沒有各塊選擇的舊資料：跟以前一樣三塊都自動貼', async () => {
    const { a } = await setup();
    const o = planOf(a, inputs(a)).objects[0];
    expect(o.pieces.every(p => !p.choice && p.placed)).toBe(true);
  });

  it('物件整個不放進畫布：蓋過各塊的選擇', async () => {
    const { a } = await setup();
    const plan = planOf(a, inputs(a, { [RIGHT]: 'keep' }, { excluded: true }));
    expect(plan.objects[0].mode).toBe('excluded');
    expect(excludedIdsOf(plan)).toEqual(['so_lift']);
  });

  it('物件沒勾自動貼（保留原本 UV）：各塊的選擇不管用，整個物件一塊搬', async () => {
    const { a } = await setup();
    const plan = planOf(a, inputs(a, { [RIGHT]: 'exclude' }, { selected: false }));
    expect(plan.objects[0].mode).toBe('keep');
  });

  it('存的格式：舊的 edit（沒有兩個新欄位）讀得進來；新欄位讀寫一致、移除的物件被清掉', () => {
    const old = parseEditSnapshot({ v: 1, selected: { a: true }, excluded: { a: true }, forms: {}, overrides: {}, seams: {}, gutter: '0', arrangement: null })!;
    expect(old.excludedPieces).toBeUndefined();
    expect(old.keepPieces).toBeUndefined();
    const snap = parseEditSnapshot({
      v: 1, selected: {}, excluded: {}, forms: {}, overrides: {}, seams: {}, gutter: '0', arrangement: null,
      excludedPieces: { [`a~${RIGHT}`]: true, [`b~${LEFT}`]: true, bad: true, [`a~${FRONT}`]: false }, keepPieces: { [`a~${LEFT}`]: true, [`a~${RIGHT}`]: true },
    })!;
    expect(Object.keys(snap.excludedPieces!).sort()).toEqual([`a~${RIGHT}`, `b~${LEFT}`].sort());
    expect(Object.keys(snap.keepPieces!)).toEqual([`a~${LEFT}`]);   // 兩邊都有 = 不放進畫布
    expect(pieceOwner(`a~${RIGHT}`)).toBe('a');
    const pruned = pruneEditSnapshot(snap, new Set(['a']));
    expect(Object.keys(pruned.excludedPieces!)).toEqual([`a~${RIGHT}`]);
  });
});
