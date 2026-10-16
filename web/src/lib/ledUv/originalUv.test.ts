// 自動貼 UV 第 4 階段 · 舊影片的保護：原本的 UV 存進 TEXCOORD_1，舊影片取色直接用它。
//   真的 .glb（gltf-transform 讀寫，沒壓縮 + Draco）走完整流程：分析 → 排版 → 寫檔 → 三關檢查 → 網站載入（GLTFLoader）。
//   重點：畫面橫跨畫布邊緣的（舊版面的長方形放不進去）、弧長不均勻的（長方形版型約 4 % 的誤差）、整圈圓柱（拆接縫）都一個像素不差；
//         模型已經有別人的 TEXCOORD_1 就不動、退回長方形版型；重複套用帶著「最原始」的 UV，不是中間那一版。
import { beforeAll, describe, expect, it } from 'vitest';
import { Document, type NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { DRACO_ENCODER_OPTIONS } from '../modelCompress/settings';
import { analyzeModelBytes, buildModelBytes, type AnalyzeOk, type BuildOk } from './pipeline';
import { buildLegacy, buildPlan, type Plan, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { verifyUvScene } from './verifyScene';
import { ORIGINAL_UV_NAME, predictUv1 } from './writeUv';
import { parseModel } from '../modelLoader';
import { arcPrim, conePrim, gridPrim, wavePrim } from './testing';
import { tubePrim } from './testShapes';
import type { PrimGeom } from './surfaces';
import type { Vec3 } from './geometry';
import type * as THREE from 'three';

const OLD = { width: 8800, height: 2024 };
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** 把舊 UV（0~1 的格子）換成指定的範圍：u = u0 + f(s)·du，v = v0 + t·dv */
function withUv(p: PrimGeom, f: (s: number) => number, u0: number, du: number, v0: number, dv: number): PrimGeom {
  const uv = Float64Array.from(p.uv!);
  for (let i = 0; i < uv.length; i += 2) { uv[i] = u0 + f(uv[i]) * du; uv[i + 1] = v0 + uv[i + 1] * dv; }
  return { ...p, uv };
}

/** 燈光貼圖的 UV：只看頂點位置（壓縮後頂點順序會變，位置不會） */
const lightmapOf = (x: number, y: number, z: number): [number, number] => [0.3 + 0.01 * x + 0.002 * z, 0.4 + 0.01 * y];

function buildDoc(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3', arr: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const led = doc.createMaterial('LED_Screen').setEmissiveFactor([1, 1, 1]);
  const scene = doc.createScene('Scene');
  const add = (name: string, g: PrimGeom, at: Vec3, lightmap = false) => {
    const normals = new Float32Array(g.pos.length);
    for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos)))
      .setAttribute('NORMAL', acc('VEC3', normals))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(g.uv!)))
      .setIndices(acc('SCALAR', new Uint32Array(g.index)))
      .setMaterial(led);
    if (lightmap) {
      const lm = new Float32Array((g.pos.length / 3) * 2);
      for (let v = 0; v < g.pos.length / 3; v++) lm.set(lightmapOf(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]), v * 2);
      prim.setAttribute('TEXCOORD_1', acc('VEC2', lm));
    }
    const mesh = doc.createMesh(name).addPrimitive(prim);
    scene.addChild(doc.createNode(name).setMesh(mesh).setTranslation(at));
  };
  // 畫面橫跨畫布右邊（u 從 0.93 到 1.07）：舊版面的長方形放不進去
  add('LED_Wrap', withUv(arcPrim(20.9, 47, 6, 24), s => s, 0.93, 0.14, 0.2, 0.3), [0, 0, 0]);
  // 弧長不均勻（u = 弧長比例的 1.4 次方）：長方形版型貼不準
  add('LED_Uneven', withUv(arcPrim(8, 120, 3, 24), s => Math.pow(s, 1.4), 0.1, 0.3, 0.6, 0.2), [0, 8, 0]);
  // 整圈圓柱，接縫是共用的頂點
  add('LED_Tube', withUv(tubePrim(3, 2, 24, 3, 0), s => s, 0.5, 0.1, 0.1, 0.1), [30, 0, 0]);
  add('LED_Wave', withUv(wavePrim(14, 2, 0.8, 2, 36), s => s, 0.7, 0.2, 0.7, 0.1), [-30, 0, 0]);
  // 圓錐的一塊：不是平面也不是圓柱，LSCM 攤平（圓錐可以攤平，0 變形）
  add('LED_Cone', withUv(conePrim(5, 3, 90, 3, 24), s => s, 0.8, 0.1, 0.8, 0.15), [0, -20, 0]);
  // 模型已經有自己的第二組 UV（例如燈光貼圖）
  add('LED_Foreign', withUv(gridPrim([-3, 0, 0], [1, 0, 0], [0, 1, 0], 6, 2, 3), s => s, 0.2, 0.2, 0.4, 0.1), [0, 20, 0], true);
  return doc;
}

const NAMES = ['LED_Wrap', 'LED_Uneven', 'LED_Tube', 'LED_Wave', 'LED_Cone', 'LED_Foreign'];
const objects = NAMES.map((n, i) => ({ id: `so_${i}`, meshName: n }));
const idOf = (n: string) => objects.find(o => o.meshName === n)!.id;

let io: NodeIO;
let plain: Uint8Array;
let draco: Uint8Array;

beforeAll(async () => {
  await installNodeModelDecoders();
  io = await createNodeIO();
  plain = await io.writeBinary(buildDoc());
  const d = buildDoc();
  d.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ ...DRACO_ENCODER_OPTIONS });
  draco = await io.writeBinary(d);
}, 60_000);

function inputs(a: AnalyzeOk, pitchMm = 20): PlanObjectIn[] {
  return objects.map((o, i) => ({
    id: o.id, name: o.meshName, order: i, info: a.infos[o.id], selected: true,
    sizes: { 0: { mode: 'pitch' as const, pitchMm } }, manuals: [],
  }));
}

async function run(bytes: Uint8Array, pitchMm = 20) {
  const a = await analyzeModelBytes(io, bytes, objects, OLD);
  if (!a.ok) throw new Error(a.reason);
  const ins = inputs(a, pitchMm);
  const plan: Plan = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: OLD });
  const b = await buildModelBytes(io, bytes, objects, plan, OLD);
  return { a, ins, plan, b };
}

/** 一個 primitive 每個三角形的每個角：(位置, 值) → 值。頂點順序壓縮後會變，所以用位置（公分）當鑰匙 */
function cornersOf(prim: { pos: ArrayLike<number>; index: ArrayLike<number> }, values: ArrayLike<number> | null | undefined): Map<string, number[][]> {
  const m = new Map<string, number[][]>();
  if (!values) return m;
  const key = (v: number) => `${Math.round(prim.pos[v * 3] * 100)},${Math.round(prim.pos[v * 3 + 1] * 100)},${Math.round(prim.pos[v * 3 + 2] * 100)}`;
  for (let c = 0; c < prim.index.length; c++) {
    const v = prim.index[c];
    const k = key(v);
    const list = m.get(k) ?? [];
    list.push([values[v * 2], values[v * 2 + 1]]);
    m.set(k, list);
  }
  return m;
}

describe.each([['沒壓縮', () => plain], ['Draco', () => draco]] as const)('原本的 UV 存進 TEXCOORD_1（%s）', (_label, getInput) => {
  let input: Uint8Array;
  let res: Awaited<ReturnType<typeof run>>;
  let out: Uint8Array;
  beforeAll(async () => {
    input = getInput();
    res = await run(input);
    expect(res.plan.blockers).toEqual([]);
    expect(res.b.ok, JSON.stringify((res.b as { issues?: string[] }).issues ?? (res.b as { reason?: string }).reason)).toBe(true);
    out = (res.b as BuildOk).bytes;
  }, 60_000);

  it('套用前先預測：沒有 TEXCOORD_1 的 = fresh；模型自己有第二組 UV 的 = blocked', () => {
    expect(res.a.uv1[idOf('LED_Wrap')]).toBe('fresh');
    expect(res.a.uv1[idOf('LED_Uneven')]).toBe('fresh');
    expect(res.a.uv1[idOf('LED_Tube')]).toBe('fresh');
    expect(res.a.uv1[idOf('LED_Wave')]).toBe('fresh');
    expect(res.a.uv1[idOf('LED_Cone')]).toBe('fresh');
    expect(res.a.uv1[idOf('LED_Foreign')]).toBe('blocked');
    const b = res.b as BuildOk;
    expect(b.uv1).toEqual(res.a.uv1);
    expect(b.splitPrimitives).toBeGreaterThanOrEqual(1);      // 整圈圓柱拆了接縫
  });

  it('輸出：每個三角形的每個角，TEXCOORD_1 == 原本的 TEXCOORD_0（連跨過畫布邊緣的 1.07 都一樣）；TEXCOORD_0 是新的', async () => {
    const before = readLedObjects(await io.readBinary(input), objects).objects;
    const after = readLedObjects(await io.readBinary(out), objects).objects;
    for (const n of ['LED_Wrap', 'LED_Uneven', 'LED_Tube', 'LED_Wave', 'LED_Cone']) {
      const id = idOf(n);
      const pb = before.get(id)!.geom.prims[0], pa = after.get(id)!.geom.prims[0];
      const refPrim = after.get(id)!.refs[0].prim;
      const uv1 = refPrim.getAttribute('TEXCOORD_1');
      expect(uv1, n).not.toBeNull();
      expect(uv1!.getName(), n).toBe(ORIGINAL_UV_NAME);     // 記號壓縮後還在
      const want = cornersOf(pb, pb.uv);
      const got = cornersOf(pa, uv1!.getArray()!);
      expect(got.size, n).toBe(want.size);
      let worst = 0, checked = 0;
      for (const [k, list] of got) {
        const w = want.get(k)!;
        expect(w, `${n} ${k}`).toBeDefined();
        for (const g of list) {
          // 這個位置原本的 UV 有哪幾個（接縫上的頂點可能有兩個）：最近的那個要對上
          const d = Math.min(...w.map(o => Math.max(Math.abs(o[0] - g[0]) * OLD.width, Math.abs(o[1] - g[1]) * OLD.height)));
          worst = Math.max(worst, d);
          checked++;
        }
      }
      expect(checked, n).toBeGreaterThan(50);
      expect(worst, n).toBeLessThan(0.01);                    // 原本的畫布像素，誤差不到 0.01 個
      // 新的 UV 跟原本的不一樣
      expect(Math.abs((pa.uv![0] ?? 0) - (pb.uv![0] ?? 0)) + Math.abs((pa.uv![1] ?? 0) - (pb.uv![1] ?? 0))).toBeGreaterThan(0);
    }
    // 跨過畫布邊緣的那個：原本的 u 真的超過 1（沒有被收回 0~1）
    const wrap = after.get(idOf('LED_Wrap'))!.refs[0].prim.getAttribute('TEXCOORD_1')!.getArray()!;
    expect(Math.max(...Array.from(wrap).filter((_, i) => i % 2 === 0))).toBeGreaterThan(1.05);
  });

  it('模型自己有第二組 UV 的物件：一個字都不動（不是我們存的）', async () => {
    const after = readLedObjects(await io.readBinary(out), objects).objects.get(idOf('LED_Foreign'))!;
    const uv1 = after.refs[0].prim.getAttribute('TEXCOORD_1')!;
    expect(uv1.getName()).not.toBe(ORIGINAL_UV_NAME);
    const arr = uv1.getArray()!;
    const pos = after.refs[0].prim.getAttribute('POSITION')!.getArray()!;
    let worst = 0;
    for (let v = 0; v < pos.length / 3; v++) {
      const want = lightmapOf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      worst = Math.max(worst, Math.abs(arr[v * 2] - want[0]), Math.abs(arr[v * 2 + 1] - want[1]));
    }
    expect(arr.length).toBeGreaterThan(10);
    expect(worst).toBeLessThan(1e-5);
  });

  it('網站載入後（GLTFLoader）：被處理的 LED mesh 都有 uv1，跟 uv 不是同一組；沒被處理過的（原檔沒有）不會多出來', async () => {
    const g = await parseModel(ab(out));
    const found: Record<string, { uv1: boolean; same: boolean }> = {};
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      const name = NAMES.includes(m.name) ? m.name : NAMES.includes(m.parent?.name ?? '') ? m.parent!.name : '';
      if (!m.isMesh || !name) return;
      const geo = m.geometry;
      const u0 = geo.getAttribute('uv'), u1 = geo.getAttribute('uv1');
      let same = !!u1 && u0.count === u1.count;
      for (let i = 0; same && i < u0.count; i++) if (u0.getX(i) !== u1.getX(i) || u0.getY(i) !== u1.getY(i)) same = false;
      found[name] = { uv1: !!u1, same };
    });
    for (const n of ['LED_Wrap', 'LED_Uneven', 'LED_Tube', 'LED_Wave', 'LED_Cone', 'LED_Foreign']) {
      expect(found[n]?.uv1, n).toBe(true);
      expect(found[n]?.same, n).toBe(false);
    }
    const r = await verifyUvScene(ab(input), ab(out), res.plan, objects);
    expect(r.issues).toEqual([]);
  });

  it('舊影片取色模擬：三角形裡任何一點，新模型用 uv1 取到的畫布像素 == 原本的模型用原本的 UV 取到的（連跨過邊緣、弧長不均勻的）', async () => {
    const before = readLedObjects(await io.readBinary(input), objects).objects;
    const after = readLedObjects(await io.readBinary(out), objects).objects;
    for (const n of ['LED_Wrap', 'LED_Uneven', 'LED_Wave', 'LED_Tube', 'LED_Cone']) {
      const id = idOf(n);
      const pb = before.get(id)!.geom.prims[0], pa = after.get(id)!.geom.prims[0];
      const uv1 = after.get(id)!.refs[0].prim.getAttribute('TEXCOORD_1')!.getArray()!;
      // 原本的：位置 → 原本的 UV（逐角）；新的：每個三角形用 uv1 內插
      const want = cornersOf(pb, pb.uv);
      let checked = 0, worst = 0;
      for (let t = 0; t + 2 < pa.index.length; t += 3) {
        const vs = [pa.index[t], pa.index[t + 1], pa.index[t + 2]];
        const key = (v: number) => `${Math.round(pa.pos[v * 3] * 100)},${Math.round(pa.pos[v * 3 + 1] * 100)},${Math.round(pa.pos[v * 3 + 2] * 100)}`;
        // 三個角在原本的檔案裡的 UV
        const olds = vs.map(v => {
          const list = want.get(key(v))!;
          const g = [uv1[v * 2], uv1[v * 2 + 1]];
          return list.reduce((best, o) => (Math.hypot(o[0] - g[0], o[1] - g[1]) < Math.hypot(best[0] - g[0], best[1] - g[1]) ? o : best));
        });
        for (const [a, b] of [[0.3, 0.3], [0.1, 0.8], [0.6, 0.2]]) {
          const c = 1 - a - b;
          const newPx = [0, 1].map(k => (vs.reduce((s, v, i) => s + [a, b, c][i] * uv1[v * 2 + k], 0)) * (k === 0 ? OLD.width : OLD.height));
          const oldPx = [0, 1].map(k => (olds.reduce((s, o, i) => s + [a, b, c][i] * o[k], 0)) * (k === 0 ? OLD.width : OLD.height));
          worst = Math.max(worst, Math.abs(newPx[0] - oldPx[0]), Math.abs(newPx[1] - oldPx[1]));
          checked++;
        }
      }
      expect(checked, n).toBeGreaterThan(100);
      expect(worst, n).toBeLessThan(0.01);
    }
  });

  it('舊版面長方形版型的缺點（新方法要補的）：跨過邊緣的放不進去、不均勻的有誤差；有 uv1 以後這兩種都算保護好了', () => {
    const plain0 = buildLegacy(res.plan, res.ins, OLD);
    expect(plain0.unprotected).toContain('LED_Wrap');
    expect(plain0.approximate).toContain('LED_Uneven');
    expect(plain0.originalUv).toEqual([]);
    const fresh = new Set(Object.entries(res.a.uv1).filter(([, s]) => s === 'fresh').map(([id]) => id));
    const withUv1 = buildLegacy(res.plan, res.ins, OLD, fresh);
    expect(withUv1.unprotected).not.toContain('LED_Wrap');
    expect(withUv1.approximate).not.toContain('LED_Uneven');
    expect(withUv1.originalUv.sort()).toEqual(['LED_Cone', 'LED_Tube', 'LED_Uneven', 'LED_Wave', 'LED_Wrap'].map(idOf).sort());
    // 有自己的第二組 UV 的退回長方形版型（仍然是近似）
    expect(withUv1.originalUv).not.toContain(idOf('LED_Foreign'));
    expect(withUv1.screens.some(s => s.key === `o:${idOf('LED_Foreign')}`)).toBe(true);
  });
});

describe('重複套用：帶著最原始的 UV 往前走，不是中間那一版', () => {
  it('套用兩次（第二次換了點距 = 整個重排）：第二版的 TEXCOORD_1 還是原檔的 TEXCOORD_0，狀態是 carried', async () => {
    for (const first of [plain, draco]) {
      const r1 = await run(first, 20);
      expect(r1.b.ok).toBe(true);
      const out1 = (r1.b as BuildOk).bytes;
      // 第二次：從第一次的輸出再來一次，點距不同
      const r2 = await run(out1, 40);
      expect(r2.a.uv1[idOf('LED_Wrap')]).toBe('carried');
      expect(r2.a.uv1[idOf('LED_Foreign')]).toBe('blocked');
      expect(r2.b.ok, JSON.stringify((r2.b as { issues?: string[] }).issues ?? (r2.b as { reason?: string }).reason)).toBe(true);
      const out2 = (r2.b as BuildOk).bytes;
      expect((r2.b as BuildOk).uv1[idOf('LED_Wrap')]).toBe('carried');
      expect(r1.plan.canvas).not.toEqual(r2.plan.canvas);          // 兩次的排法真的不一樣
      const orig = readLedObjects(await io.readBinary(first), objects).objects;
      const mid = readLedObjects(await io.readBinary(out1), objects).objects;
      const last = readLedObjects(await io.readBinary(out2), objects).objects;
      for (const n of ['LED_Wrap', 'LED_Uneven', 'LED_Wave', 'LED_Tube', 'LED_Cone']) {
        const id = idOf(n);
        const want = cornersOf(orig.get(id)!.geom.prims[0], orig.get(id)!.geom.prims[0].uv);
        const pl = last.get(id)!.geom.prims[0];
        const uv1 = last.get(id)!.refs[0].prim.getAttribute('TEXCOORD_1')!;
        expect(uv1.getName()).toBe(ORIGINAL_UV_NAME);
        const got = cornersOf(pl, uv1.getArray()!);
        let worst = 0;
        for (const [k, list] of got) for (const g of list) worst = Math.max(worst, Math.min(...want.get(k)!.map(o => Math.max(Math.abs(o[0] - g[0]) * OLD.width, Math.abs(o[1] - g[1]) * OLD.height))));
        expect(worst, n).toBeLessThan(0.02);                       // 跟「最原始的檔」一樣（不是第一次套用後的 UV）
        // 中間那一版的 UV 跟最原始的不一樣（證明第二次沒有拿中間那一版當原本的）
        const midUv = mid.get(id)!.geom.prims[0].uv!;
        const origUv = orig.get(id)!.geom.prims[0].uv!;
        expect(Array.from(midUv).some((v, i) => Math.abs(v - (origUv[i] ?? v)) > 1e-3) || midUv.length !== origUv.length).toBe(true);
      }
      // 預測也一樣
      const read = readLedObjects(await io.readBinary(out1), objects);
      expect(predictUv1(read.objects.get(idOf('LED_Tube'))!)).toBe('carried');
      expect(predictUv1(read.objects.get(idOf('LED_Foreign'))!)).toBe('blocked');
    }
  }, 120_000);
});
