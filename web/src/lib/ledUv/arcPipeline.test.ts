// 自動貼 UV 第 2 階段的整合測試：真的 .glb（gltf-transform 讀寫 + Draco）、網站載入模型的方法（GLTFLoader）
// 弧面（凸的小半圓、凹弧）寫進模型 → 重新讀回來 / 網站載入：左右沒有反、弧長均勻、一個 LED 點對一個畫布像素、3D 預覽跟寫進去的一樣、舊版面
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { DRACO_ENCODER_OPTIONS } from '../modelCompress/settings';
import { parseModel } from '../modelLoader';
import { findBestScope } from '../parseGlb';
import { buildUvFixture, FIXTURE_OLD_CANVAS } from './uvFixture';
import { analyzeModelBytes, buildModelBytes, openModelBytes, analyzeDoc, type AnalyzeOk, type BuildOk } from './pipeline';
import { buildLegacy, buildPlan, type Plan, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { verifyUvScene } from './verifyScene';
import { buildUvPreview } from './previewUv';
import { applyUvPreview } from './previewApply';
import { dot, cross, normalize, sub, type Vec3 } from './geometry';
import { verifyDocuments } from '../modelCompress/verifyDocument';
import { compareSnapshots, disposeGltf, snapshotScene } from '../modelCompress/verifyScene';

let io: NodeIO;
let plain: Uint8Array;
let draco: Uint8Array;
const fixture = buildUvFixture();
const objects = fixture.objects.map(o => ({ id: o.id, meshName: o.meshName }));
const byName = (n: string) => objects.find(o => o.meshName === n)!;
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const ARCS = ['LED_E_小半圓', 'LED_K_凹弧'];

beforeAll(async () => {
  await installNodeModelDecoders();
  io = await createNodeIO();
  plain = await io.writeBinary(buildUvFixture().doc);
  const d = buildUvFixture().doc;
  d.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ ...DRACO_ENCODER_OPTIONS });
  draco = await io.writeBinary(d);
});

function inputs(a: AnalyzeOk, pick: (name: string) => boolean): PlanObjectIn[] {
  return fixture.objects.map((o, i) => ({
    id: o.id, name: o.display, order: i, info: a.infos[o.id], selected: pick(o.meshName),
    // 20 mm 點距；每個物件最多兩片
    sizes: { 0: { mode: 'pitch' as const, pitchMm: 20 }, 1: { mode: 'pitch' as const, pitchMm: 20 } },
    manuals: [],
  }));
}

async function run(bytes: Uint8Array) {
  const a = await analyzeModelBytes(io, bytes, objects, FIXTURE_OLD_CANVAS);
  if (!a.ok) throw new Error(a.reason);
  const ins = inputs(a, n => n !== 'LED_H_沒選');
  const plan = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS });
  const b = await buildModelBytes(io, bytes, objects, plan, FIXTURE_OLD_CANVAS);
  return { a, ins, plan, b };
}

describe.each([['沒壓縮', () => plain], ['Draco', () => draco]] as const)('弧面套用（%s）', (_label, getInput) => {
  let input: Uint8Array;
  let res: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    input = getInput();
    res = await run(input);
  });

  it('小半圓、凹弧自動貼，三關檢查都過；網站載入後位置 == 排好的長方形', async () => {
    expect(res.plan.blockers).toEqual([]);
    for (const n of ARCS) {
      const o = res.plan.objects.find(x => x.id === byName(n).id)!;
      expect(o.mode, n).toBe('auto');
      expect(o.pieces[0].surface).toBe('arc');
    }
    expect(res.b.ok, JSON.stringify((res.b as { issues?: string[] }).issues)).toBe(true);
    const out = (res.b as BuildOk).bytes;
    const r = await verifyUvScene(ab(input), ab(out), res.plan, objects);
    expect(r.issues).toEqual([]);
    for (const n of ARCS) {
      const o = res.plan.objects.find(x => x.id === byName(n).id)!;
      const pl = o.pieces[0].placed!;
      expect(r.rects[o.id]).toEqual({ x: pl.x, y: pl.y, w: pl.w, h: pl.h });
    }
    expect((res.b as BuildOk).output.maxPixelError).toBeLessThan(0.01);
  });

  it('小半圓 20 mm 點距：寬 = 真正的弧長 628 點、高 150 點（不是弦長）', () => {
    const o = res.plan.objects.find(x => x.id === byName('LED_E_小半圓').id)!;
    expect(o.pieces[0].placed!.w).toBe(Math.round((Math.PI * 4 * 1000) / 20));
    expect(o.pieces[0].placed!.h).toBe(150);
    const k = res.plan.objects.find(x => x.id === byName('LED_K_凹弧').id)!;
    expect(k.pieces[0].placed!.w).toBe(Math.round(((8 * 60 * Math.PI) / 180 * 1000) / 20));
  });

  it('不會左右反：用跟 GPU 一樣的方式看（觀眾站在法線那一側，鏡頭朝向表面），UV 的 u 往畫面右邊增加、v 往畫面下方增加', async () => {
    const out = (res.b as BuildOk).bytes;
    const doc = await io.readBinary(out);
    const read = readLedObjects(doc, objects);
    for (const n of ARCS) {
      const so = read.objects.get(byName(n).id)!;
      const prim = so.geom.prims[0];
      const o = res.plan.objects.find(x => x.id === byName(n).id)!;
      const W = res.plan.canvas.width, H = res.plan.canvas.height;
      let checked = 0;
      for (let t = 0; t + 2 < prim.index.length; t += 3) {
        const [a, b, c] = [prim.index[t], prim.index[t + 1], prim.index[t + 2]];
        const P = (v: number): Vec3 => [prim.pos[v * 3], prim.pos[v * 3 + 1], prim.pos[v * 3 + 2]];
        const [pa, pb, pc] = [P(a), P(b), P(c)];
        const nrm = normalize(cross(sub(pb, pa), sub(pc, pa)));  // 繞向的法線（LED 畫的那一面）
        // 這個三角形的 UV 梯度：u 增加的方向、v 增加的方向（世界裡，在三角形的平面上）
        const e1 = sub(pb, pa), e2 = sub(pc, pa);
        const du1 = (prim.uv![b * 2] - prim.uv![a * 2]) * W, du2 = (prim.uv![c * 2] - prim.uv![a * 2]) * W;
        const dv1 = (prim.uv![b * 2 + 1] - prim.uv![a * 2 + 1]) * H, dv2 = (prim.uv![c * 2 + 1] - prim.uv![a * 2 + 1]) * H;
        const det = du1 * dv2 - du2 * dv1;
        if (Math.abs(det) < 1e-9) continue;
        // 解 e = (du, dv) 的線性組合：dP/du、dP/dv
        const dPdu: Vec3 = [0, 1, 2].map(k => (e1[k] * dv2 - e2[k] * dv1) / det) as Vec3;
        const dPdv: Vec3 = [0, 1, 2].map(k => (e2[k] * du1 - e1[k] * du2) / det) as Vec3;
        // 站在法線那一側、朝表面看、頭朝世界朝上：畫面右邊 = (看過去的方向) × 上 = (-nrm) × Y
        const right = cross([-nrm[0], -nrm[1], -nrm[2]], [0, 1, 0]);
        expect(dot(dPdu, right), `${n} 第 ${t / 3} 個三角形：u 要往畫面右邊增加`).toBeGreaterThan(0);
        expect(dPdu[1] * 1 + 0, `${n} u 方向不會是上下`).toBeLessThan(1e-3);
        expect(dPdv[1], `${n} 第 ${t / 3} 個三角形：v 要往下增加（世界 y 變小）`).toBeLessThan(0);
        checked++;
      }
      expect(checked, n).toBeGreaterThan(20);
      expect(o.mode).toBe('auto');
    }
  });

  it('一個 LED 點 ↔ 一個畫布像素（小半圓：沿弧每個點的中心，投到網格的面上、內插 UV，剛好落在 排好的位置 + 點的編號）', async () => {
    const out = (res.b as BuildOk).bytes;
    const doc = await io.readBinary(out);
    const so = readLedObjects(doc, objects).objects.get(byName('LED_E_小半圓').id)!;
    const prim = so.geom.prims[0];
    const o = res.plan.objects.find(x => x.id === byName('LED_E_小半圓').id)!;
    const pl = o.pieces[0].placed!;
    // 小半圓放在 (0,0,4)，外面還有一層「舞台」節點 (0.5, 0, -1)：圓心 (0.5, 0, 3)，弧從 x = -R 到 +R（站在 +Z 看過去 左 → 右）
    const cx = 0.5, cz = 3;
    let checked = 0;
    for (const i of [0, 1, 2, 100, Math.floor(pl.w / 2), pl.w - 3, pl.w - 2, pl.w - 1]) {
      const frac = (i + 0.5) / pl.w;
      const ang = (-90 + 180 * frac) * (Math.PI / 180);  // 這個點在圓上的角度（arcPrim：x = sin a·R，z = cos a·R）
      // 沿這個角度的射線打到網格的哪個三角形（網格是弦，不是圓；用角度對應）
      let found: [number, number] | null = null;
      for (let t = 0; t + 2 < prim.index.length && !found; t += 3) {
        const ids = [prim.index[t], prim.index[t + 1], prim.index[t + 2]];
        const angs = ids.map(v => Math.atan2(prim.pos[v * 3] - cx, prim.pos[v * 3 + 2] - cz));
        const lo = Math.min(...angs), hi = Math.max(...angs);
        if (ang < lo - 1e-9 || ang > hi + 1e-9) continue;
        // 同一高度（網格中間）的兩個頂點在角度範圍的兩端；在弦上找 radial 方向的交點
        const dir = [Math.sin(ang), Math.cos(ang)];
        // 弦：lo 端的頂點 A、hi 端的頂點 B（同一個高度層）
        const lowIds = ids.filter(v => Math.abs(Math.atan2(prim.pos[v * 3] - cx, prim.pos[v * 3 + 2] - cz) - lo) < 1e-9);
        const highIds = ids.filter(v => Math.abs(Math.atan2(prim.pos[v * 3] - cx, prim.pos[v * 3 + 2] - cz) - hi) < 1e-9);
        if (!lowIds.length || !highIds.length) continue;
        const A = lowIds[0], B = highIds[0];
        const ax = prim.pos[A * 3] - cx, az = prim.pos[A * 3 + 2] - cz, bx = prim.pos[B * 3] - cx, bz = prim.pos[B * 3 + 2] - cz;
        // 解 s·dir = A + t(B-A)
        const ex = bx - ax, ez = bz - az;
        const det = dir[0] * -ez - dir[1] * -ex;
        const tt = (dir[0] * az - dir[1] * ax) / det;
        const u = prim.uv![A * 2] * (1 - tt) + prim.uv![B * 2] * tt;
        found = [u * res.plan.canvas.width, 0];
      }
      expect(found, `點 ${i} 找不到面`).not.toBeNull();
      // 粗網格（24 段 / 180 度）：弦上的 UV 是線性的，跟弧長差不到 0.1 個像素
      expect(Math.floor(found![0] + 1e-6), `點 ${i}`).toBe(pl.x + i);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it('3D 預覽的新 UV == 真的寫進模型的 UV（同一個函數算的）；非螢幕的 primitive 不換', async () => {
    const opened = await openModelBytes(io, input);
    if (!opened.ok) throw new Error(opened.reason);
    const pv = buildUvPreview(opened.doc, objects, res.plan, FIXTURE_OLD_CANVAS);
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    expect(pv.preview.canvas).toEqual({ width: res.plan.canvas.width, height: res.plan.canvas.height });
    const outDoc = await io.readBinary((res.b as BuildOk).bytes);
    const outRead = readLedObjects(outDoc, objects);
    for (const n of [...ARCS, 'LED_A_主牆', 'LED_D_地屏']) {
      const id = byName(n).id;
      const prims = pv.preview.objects[id];
      expect(prims, n).toBeDefined();
      const so = outRead.objects.get(id)!;
      expect(prims.length).toBe(so.geom.prims.length);
      prims.forEach((p, i) => {
        expect(p.count).toBe(so.geom.prims[i].pos.length / 3);
        expect(p.uv).not.toBeNull();
        // 輸出檔（Draco 的話頂點會重排）：比 UV 的範圍就夠了；沒壓縮的逐個比
        const out = so.geom.prims[i].uv!;
        let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
        for (let k = 0; k < p.uv!.length; k += 2) { lo = Math.min(lo, p.uv![k]); hi = Math.max(hi, p.uv![k]); }
        for (let k = 0; k < out.length; k += 2) { lo2 = Math.min(lo2, out[k]); hi2 = Math.max(hi2, out[k]); }
        expect(lo).toBeCloseTo(lo2, 6);
        expect(hi).toBeCloseTo(hi2, 6);
        if (_label === '沒壓縮') for (let k = 0; k < out.length; k++) expect(p.uv![k]).toBeCloseTo(out[k], 6);
      });
    }
    // 保留的物件（沒選）也有新 UV：新畫布裡它搬到新位置了
    expect(pv.preview.objects[byName('LED_J_波浪').id]).toBeDefined();
    // 沒處理的物件（不在方案裡）沒有
    expect(Object.keys(pv.preview.objects).length).toBe(res.plan.objects.filter(o => o.mode === 'auto' || o.mode === 'keep').length);
  });

  it('3D 預覽換到網站載入的場景上：UV 換成預覽的、還原後完全是原本的 geometry；對不上的物件不換', async () => {
    const opened = await openModelBytes(io, input);
    if (!opened.ok) throw new Error(opened.reason);
    const pv = buildUvPreview(opened.doc, objects, res.plan, FIXTURE_OLD_CANVAS);
    if (!pv.ok) throw new Error(pv.reason);
    const gltf = await parseModel(ab(input));
    const scope = findBestScope(gltf.scene);
    const rootOf = (id: string): THREE.Object3D | undefined => {
      const name = objects.find(o => o.id === id)!.meshName;
      return scope.children.find(c => (c.name || '').trim() === name);
    };
    const meshOf = (id: string): THREE.Mesh => {
      let m: THREE.Mesh | null = null;
      rootOf(id)!.traverse(o => { if (!m && (o as THREE.Mesh).isMesh) m = o as THREE.Mesh; });
      return m!;
    };
    const arcId = byName('LED_E_小半圓').id;
    const m0 = meshOf(arcId);
    const geo0 = m0.geometry, uv0 = geo0.getAttribute('uv'), pos0 = geo0.getAttribute('position');
    const applied = applyUvPreview(pv.preview, rootOf);
    expect(applied.missing).toEqual([]);
    expect(applied.applied.length).toBe(Object.keys(pv.preview.objects).length);
    const m1 = meshOf(arcId);
    expect(m1.geometry).not.toBe(geo0);
    expect(m1.geometry.getAttribute('position')).toBe(pos0);  // 共用，不複製
    const want = pv.preview.objects[arcId][0].uv!;
    const got = m1.geometry.getAttribute('uv');
    expect(got.count * 2).toBe(want.length);
    for (let k = 0; k < want.length; k += 17) expect(got.array[k]).toBeCloseTo(want[k], 7);
    // 共用形狀的 LED_B / LED_C：各自換自己的（不是同一份 geometry）
    expect(meshOf(byName('LED_B_左側').id).geometry).not.toBe(meshOf(byName('LED_C_右側').id).geometry);
    applied.restore();
    expect(meshOf(arcId).geometry).toBe(geo0);
    expect(geo0.getAttribute('uv')).toBe(uv0);
    applied.restore();  // 再還原一次不會壞
    // 對不上（頂點數不一樣）→ 整個物件不換
    const bad = JSON.parse(JSON.stringify({ ...pv.preview, objects: {} }));
    bad.objects[arcId] = pv.preview.objects[arcId].map(p => ({ count: p.count + 1, first: p.first, uv: p.uv }));
    const a2 = applyUvPreview(bad, rootOf);
    expect(a2.missing).toEqual([arcId]);
    expect(meshOf(arcId).geometry).toBe(geo0);
    a2.restore();
  });

  it('舊版面：弧面也放進去（原本的 UV 是均勻的弧長 → 一點都不歪）', () => {
    const legacy = buildLegacy(res.plan, res.ins, FIXTURE_OLD_CANVAS);
    expect(legacy.unprotected).toEqual([]);
    for (const n of ARCS) {
      const s = legacy.screens.find(x => x.key === `o:${byName(n).id}`);
      expect(s, n).toBeDefined();
      expect(legacy.approximate).not.toContain(n.replace(/^LED_[A-Z]_/, ''));
    }
  });
});

describe('分析：換類型只重算那個物件，用同一份模型', () => {
  it('analyzeDoc 的 overrides / only：只回要的物件；指定平面 → 平面', async () => {
    const opened = await openModelBytes(io, plain);
    if (!opened.ok) throw new Error(opened.reason);
    const id = byName('LED_E_小半圓').id;
    const all = analyzeDoc(opened.doc, opened.draco, objects, FIXTURE_OLD_CANVAS);
    expect(Object.keys(all.infos).length).toBe(objects.length);
    expect(all.infos[id]!.pieces[0].kind).toBe('arc');
    const one = analyzeDoc(opened.doc, opened.draco, objects, FIXTURE_OLD_CANVAS, { only: [id], overrides: { [id]: 'flat' } });
    expect(Object.keys(one.infos)).toEqual([id]);
    expect(one.infos[id]!.pieces[0].kind).toBe('flat');
    expect(one.front).toEqual(all.front);
    const forcedArc = analyzeDoc(opened.doc, opened.draco, objects, FIXTURE_OLD_CANVAS, { only: [byName('LED_A_主牆').id], overrides: { [byName('LED_A_主牆').id]: 'arc' } });
    expect(forcedArc.infos[byName('LED_A_主牆').id]!.unsupported).toBe('arcfail');
  });

  it('指定平面的弧面一樣能套用（變形照實算），三關檢查都過', async () => {
    const a = await analyzeModelBytes(io, plain, objects, FIXTURE_OLD_CANVAS, { overrides: { [byName('LED_E_小半圓').id]: 'flat' } });
    if (!a.ok) throw new Error(a.reason);
    const ins = inputs(a, n => n === 'LED_E_小半圓').map(i => (i.id === byName('LED_E_小半圓').id ? { ...i, override: 'flat' as const } : i));
    const plan: Plan = buildPlan(ins, { front: a.front, metersPerUnit: 1, oldCanvas: FIXTURE_OLD_CANVAS });
    expect(plan.blockers).toEqual([]);
    const o = plan.objects.find(x => x.id === byName('LED_E_小半圓').id)!;
    expect(o.pieces[0].surface).toBe('flat');
    expect(o.pieces[0].distortion.max).toBeGreaterThan(0.05);
    const b = await buildModelBytes(io, plain, objects, plan, FIXTURE_OLD_CANVAS);
    expect(b.ok, JSON.stringify((b as { issues?: string[] }).issues)).toBe(true);
  });
});

describe('檢查的容差（用真的 stage.glb 才發現的兩個誤報；放寬以後真的動過的還是抓得到）', () => {
  it('縮放 0.99999994（差 6e-8）被 gltf-transform 寫檔時當成預設值省略 → 第二關照過；真的動過（1e-4）一樣被抓到', async () => {
    const f = buildUvFixture();
    const stage = f.doc.getRoot().listNodes().find(n => n.getName() === '舞台')!;
    stage.setScale([1, 0.99999994, 0.99999994]);
    const bytes = await io.writeBinary(f.doc);
    const a = await io.readBinary(bytes);
    const out = await io.readBinary(await io.writeBinary(a));
    expect(out.getRoot().listNodes().find(n => n.getName() === '舞台')!.getScale()).toEqual([1, 1, 1]);  // 真的被省略了
    expect(verifyDocuments(a, out).ok).toBe(true);
    const moved = await io.readBinary(await io.writeBinary(a));
    moved.getRoot().listNodes().find(n => n.getName() === '舞台')!.setScale([1, 1.0001, 1]);
    const bad = verifyDocuments(a, moved);
    expect(bad.ok).toBe(false);
    expect(bad.issues.join()).toContain('縮放');
  });

  it('推算出來的大小：Draco 原檔容許 0.5 % 的差（檔頭的外框多留了一個量化格）；差 2 % 還是不一樣', async () => {
    const g = await parseModel(ab(plain));
    const a = await snapshotScene(g);
    disposeGltf(g);
    const clone = (): typeof a => JSON.parse(JSON.stringify(a));
    const b = clone();
    b.parsed.sceneSizeMeters = a.parsed.sceneSizeMeters * 0.999;
    b.parsed.meshes.forEach(m => { m.sizeMeters *= 0.999; });
    expect(compareSnapshots(a, b).length).toBeGreaterThan(0);                           // 預設：一點點差也抓
    expect(compareSnapshots(a, b, { sizeSlackRel: 0.005 })).toEqual([]);                // 容許 0.5 %
    const c = clone();
    c.parsed.sceneSizeMeters = a.parsed.sceneSizeMeters * 1.02;
    expect(compareSnapshots(a, c, { sizeSlackRel: 0.005 }).join()).toContain('場景大小');
  });
});
