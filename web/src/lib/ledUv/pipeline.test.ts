// 自動貼 UV 的整合測試：真的 .glb（gltf-transform 讀寫 + Draco）、網站載入模型的方法（GLTFLoader），
// 檢查：節點 / 材質一個字都沒動、只有 UV 換了、對位圖上的位置剛好等於排好的長方形、一個 LED 點對一個畫布像素。
import { beforeAll, describe, expect, it } from 'vitest';
import type { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { patchGlbJson } from '../modelCompress/testing/stageFixture';
import { DRACO_ENCODER_OPTIONS } from '../modelCompress/settings';
import { readGltfJson } from '../modelCompress/glbJson';
import { buildUvFixture, FIXTURE_OLD_CANVAS } from './uvFixture';
import { analyzeModelBytes, buildModelBytes, precheckForUv, type AnalyzeOk, type BuildOk } from './pipeline';
import { buildPlan, buildLegacy, pieceScreensOf, type Plan, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { verifyUvEdit, verifyOutputUv } from './verifyUv';
import { verifyUvScene } from './verifyScene';
import { uvRegion } from './region';
import { sanitizeNodeName } from './docRead';
import { autoScaleFactor } from './docRead';
import { computeScaleFactor, classifyMeshName } from '../parseGlb';
import { parseModel } from '../modelLoader';
import { dot } from './geometry';
import { UNSUPPORTED_TEXT } from './text';

let io: NodeIO;
let plain: Uint8Array;
let draco: Uint8Array;
const fixture = buildUvFixture();
const objects = fixture.objects.map(o => ({ id: o.id, meshName: o.meshName }));
const byName = (n: string) => objects.find(o => o.meshName === n)!;
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

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
    sizes: { 0: { mode: 'pitch' as const, pitchMm: 20 }, 1: { mode: 'pitch' as const, pitchMm: 20 } },
    manuals: [],
  }));
}

async function run(bytes: Uint8Array, pick = (n: string) => n !== 'LED_H_沒選') {
  const a = await analyzeModelBytes(io, bytes, objects, FIXTURE_OLD_CANVAS);
  if (!a.ok) throw new Error(a.reason);
  const ins = inputs(a, pick);
  const plan = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS });
  const b = await buildModelBytes(io, bytes, objects, plan, FIXTURE_OLD_CANVAS);
  return { a, ins, plan, b };
}

describe('跟網站的規則一致（docRead 沒有 import three，重複的幾行用測試鎖住）', () => {
  it('節點名稱處理、命名規則、自動縮放倍率', () => {
    expect(sanitizeNodeName('LED 01.主牆[左]/a:b')).toBe('LED_01主牆左ab');
    for (const n of ['LED_01', 'led-02', 'STAGE_1', 'MECH_x', 'ARTIST_a', 'PROP_b', 'LIGHT_c', 'WALK_d', 'Floor', 'LEDX', '舞台']) {
      expect(/^(LED|STAGE|MECH|ARTIST|PROP|LIGHT|WALK)[_-]/i.test(n)).toBe(classifyMeshName(n).category !== 'other');
    }
    for (const s of [0, 0.2, 0.5, 3, 99, 100, 101, 5000]) expect(autoScaleFactor(s)).toBe(computeScaleFactor(s));
  });

  it('網站載入後的物件名稱 == 這裡找到的物件（包含空白、重複名稱）', async () => {
    const { Document } = await import('@gltf-transform/core');
    const doc = new Document();
    const scene = doc.createScene('Scene');
    const mk = (n: string) => doc.createNode(n);
    const wrap = mk('舞台 外層');
    for (const n of ['LED_01 主牆', 'LED_01 主牆', 'LED_02.左', 'PROP 1']) wrap.addChild(mk(n));
    scene.addChild(wrap);
    const bytes = await io.writeBinary(doc);
    const gltf = await parseModel(ab(bytes));
    const threeNames: string[] = [];
    gltf.scene.traverse(o => { if (o.name) threeNames.push(o.name); });
    const read = readLedObjects(await io.readBinary(bytes), [
      { id: 'a', meshName: 'LED_01_主牆' }, { id: 'b', meshName: 'LED_01_主牆_1' }, { id: 'c', meshName: 'LED_02左' },
    ]);
    // 三個都要找得到（找不到的 = 名字處理跟網站不一樣）
    expect(read.missing).toEqual([]);
    expect(threeNames).toEqual(expect.arrayContaining(['LED_01_主牆', 'LED_01_主牆_1', 'LED_02左']));
  });
});

describe('analyze：分類', () => {
  it('平面 / 弧面 / 共用形狀 / 兩片 / 外框', async () => {
    const a = await analyzeModelBytes(io, plain, objects, FIXTURE_OLD_CANVAS);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const kind = (n: string) => a.infos[byName(n).id]!;
    expect(a.front[2]).toBeGreaterThan(0.99);
    for (const n of ['LED_A_主牆', 'LED_B_左側', 'LED_C_右側', 'LED_D_地屏', 'LED_F_鏡像', 'LED_G_雙翼', 'LED_H_沒選', 'LED_I_框']) expect(kind(n).kind).toBe('ok');
    // 第 2 階段：圓柱的弧面也能貼（小半圓 180 度凸、凹弧 60 度凹）；波浪不是圓柱 → 不收
    expect(kind('LED_E_小半圓').kind).toBe('ok');
    expect(kind('LED_E_小半圓').pieces[0].arc!.convex).toBe(true);
    expect(kind('LED_K_凹弧').kind).toBe('ok');
    expect(kind('LED_K_凹弧').pieces[0].arc!.convex).toBe(false);
    expect(kind('LED_J_波浪').kind).toBe('unsupported');
    expect(kind('LED_J_波浪').unsupported).toBe('arc');
    expect(kind('LED_G_雙翼').pieces).toHaveLength(2);
    expect(kind('LED_I_框').pieces).toHaveLength(1);
    expect(kind('LED_I_框').pieces[0].widthU).toBeCloseTo(4, 5);
    // 地屏：畫面上方 = 舞台後方
    const floor = kind('LED_D_地屏').pieces[0].frame;
    expect(dot(floor.down, a.front)).toBeGreaterThan(0.99);
    // 鏡像節點：畫面右邊還是觀眾席看過去的右邊
    expect(kind('LED_F_鏡像').pieces[0].frame.right[0]).toBeGreaterThan(0.99);
    // 原本的 UV 範圍
    expect(kind('LED_A_主牆').oldRegion!.rect).toEqual({ x: 440, y: 202, w: 1760, h: 810 });
    expect(a.diag).toBeGreaterThan(30);
    expect(a.scaleFactor).toBe(1);
  });
});

async function sameBytesOutsideUv(input: Uint8Array, out: Uint8Array) {
  const a = await io.readBinary(input), b = await io.readBinary(out);
  const objs = readLedObjects(a, objects).objects;
  void objs;
  // 材質名稱還在
  expect(b.getRoot().listMaterials().map(m => m.getName())).toEqual(a.getRoot().listMaterials().map(m => m.getName()));
  expect(b.getRoot().listNodes().map(n => n.getName())).toEqual(a.getRoot().listNodes().map(n => n.getName()));
  expect(b.getRoot().listNodes().map(n => n.getTranslation())).toEqual(a.getRoot().listNodes().map(n => n.getTranslation()));
  expect(b.getRoot().listNodes().map(n => n.getScale())).toEqual(a.getRoot().listNodes().map(n => n.getScale()));
  return { a, b };
}

describe.each([['沒壓縮', () => plain], ['Draco', () => draco]] as const)('套用（%s）', (_label, getInput) => {
  let input: Uint8Array;
  let res: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    input = getInput();
    res = await run(input);
  });

  it('三關檢查都過，輸出檔格式跟原檔一樣（壓縮 → 壓縮、沒壓縮 → 沒壓縮）', () => {
    expect(res.plan.blockers).toEqual([]);
    expect(res.b.ok, JSON.stringify((res.b as { issues?: string[] }).issues)).toBe(true);
    const out = (res.b as BuildOk).bytes;
    const info = readGltfJson(out)!;
    expect(info.extensionsUsed.includes('KHR_draco_mesh_compression')).toBe(_label === 'Draco');
    expect((res.b as BuildOk).output.maxPixelError).toBeLessThan(0.01);
  });

  it('網站載入後：節點、材質、外框都一樣，每個被處理的物件的對位圖位置 == 排好的長方形', async () => {
    const out = (res.b as BuildOk).bytes;
    const r = await verifyUvScene(ab(input), ab(out), res.plan, objects);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    for (const o of res.plan.objects) {
      if (o.mode === 'auto' && o.pieces.length === 1) expect(r.rects[o.id]).toEqual({ x: o.pieces[0].placed!.x, y: o.pieces[0].placed!.y, w: o.pieces[0].placed!.w, h: o.pieces[0].placed!.h });
      if (o.mode === 'keep') expect(r.rects[o.id]).toEqual({ x: o.keep!.placed.x, y: o.keep!.placed.y, w: o.keep!.rect.w, h: o.keep!.rect.h });
    }
  });

  it('節點名稱 / 位置 / 材質名稱「LED_Screen」都沒動；共用形狀的 PROP_X 完全沒被處理', async () => {
    const out = (res.b as BuildOk).bytes;
    const { a, b } = await sameBytesOutsideUv(input, out);
    const propA = a.getRoot().listNodes().find(n => n.getName() === 'PROP_X_備用')!.getMesh()!.listPrimitives()[0];
    const propB = b.getRoot().listNodes().find(n => n.getName() === 'PROP_X_備用')!.getMesh()!.listPrimitives()[0];
    // PROP_X 的 UV 跟原檔一樣（壓縮檔頂點會重排，所以比 UV 的範圍和平均）
    const stat = (u: ArrayLike<number>) => { let s = 0, mn = Infinity, mx = -Infinity; for (let i = 0; i < u.length; i++) { s += u[i]; mn = Math.min(mn, u[i]); mx = Math.max(mx, u[i]); } return [s / u.length, mn, mx]; };
    const sa = stat(propA.getAttribute('TEXCOORD_0')!.getArray()!), sb = stat(propB.getAttribute('TEXCOORD_0')!.getArray()!);
    sa.forEach((v, i) => expect(sb[i]).toBeCloseTo(v, 5));
    // B 和 C 現在各用自己的形狀，UV 不一樣
    const nodeB = b.getRoot().listNodes().find(n => n.getName() === 'LED_B_左側')!, nodeC = b.getRoot().listNodes().find(n => n.getName() === 'LED_C_右側')!;
    expect(nodeB.getMesh()).not.toBe(nodeC.getMesh());
    expect(nodeB.getMesh()).not.toBe(b.getRoot().listNodes().find(n => n.getName() === 'PROP_X_備用')!.getMesh());
    expect(res.b.ok && (res.b as BuildOk).clonedMeshes).toBeGreaterThanOrEqual(2);
  });

  it('沒選的平面和弧面（保留）：形狀大小不變、搬到新位置；外框 == 平移後的範圍', async () => {
    const out = (res.b as BuildOk).bytes;
    const rep = verifyOutputUv(await io.readBinary(out), objects, res.plan, res.a.infos);
    expect(rep.issues).toEqual([]);
    const h = res.plan.objects.find(o => o.name === '沒選')!;
    const e = res.plan.objects.find(o => o.name === 'LED_J_波浪'.replace(/^LED_[A-Z]_/, ''))!;
    expect(h.mode).toBe('keep');
    expect(e.mode).toBe('keep');
    expect(e.reason).toBe(UNSUPPORTED_TEXT.arc);
    expect(e.freeform).toBeDefined();
    expect(rep.rects[h.id]).toEqual({ x: h.keep!.placed.x, y: h.keep!.placed.y, w: h.keep!.rect.w, h: h.keep!.rect.h });
    expect(h.keep!.rect.w).toBe(res.a.infos[byName('LED_H_沒選').id]!.oldRegion!.rect.w);
  });

  it('一個 LED 點 ↔ 一個畫布像素（主牆：每個點的中心，依物理位置找三角形、內插 UV，剛好落在 排好的位置 + 點的編號）', async () => {
    const out = (res.b as BuildOk).bytes;
    const doc = await io.readBinary(out);
    const so = readLedObjects(doc, objects).objects.get(byName('LED_A_主牆').id)!;
    const pl = res.plan.objects.find(o => o.name === '主牆')!.pieces[0].placed!;
    const prim = so.geom.prims[0];
    const piece = res.a.infos[byName('LED_A_主牆').id]!.pieces[0].frame;
    const cols = pl.w, rows = pl.h;
    const wU = piece.maxX - piece.minX, hU = piece.maxY - piece.minY;
    let checked = 0;
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [cols - 1, rows - 1], [Math.floor(cols / 2), Math.floor(rows / 2)], [cols - 2, 3], [100, rows - 1]]) {
      // 這個點的中心在世界裡的位置
      const x = piece.minX + ((i + 0.5) / cols) * wU, y = piece.minY + ((j + 0.5) / rows) * hU;
      const world = [0, 1, 2].map(k => piece.origin[k] + piece.right[k] * x + piece.down[k] * y);
      // 找包住它的三角形（在平面上做重心座標）
      let found: [number, number] | null = null;
      for (let t = 0; t + 2 < prim.index.length && !found; t += 3) {
        const [a, b, c] = [prim.index[t], prim.index[t + 1], prim.index[t + 2]];
        const P = (v: number) => [prim.pos[v * 3], prim.pos[v * 3 + 1], prim.pos[v * 3 + 2]];
        const pa = P(a), pb = P(b), pc = P(c);
        // 投影到 right/down 座標
        const to2 = (p: number[]) => [dot([p[0] - piece.origin[0], p[1] - piece.origin[1], p[2] - piece.origin[2]], piece.right), dot([p[0] - piece.origin[0], p[1] - piece.origin[1], p[2] - piece.origin[2]], piece.down)];
        const A = to2(pa), B = to2(pb), C = to2(pc), Q = to2(world);
        const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
        if (Math.abs(den) < 1e-12) continue;
        const l1 = ((B[1] - C[1]) * (Q[0] - C[0]) + (C[0] - B[0]) * (Q[1] - C[1])) / den;
        const l2 = ((C[1] - A[1]) * (Q[0] - C[0]) + (A[0] - C[0]) * (Q[1] - C[1])) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const u = l1 * prim.uv![a * 2] + l2 * prim.uv![b * 2] + l3 * prim.uv![c * 2];
        const v = l1 * prim.uv![a * 2 + 1] + l2 * prim.uv![b * 2 + 1] + l3 * prim.uv![c * 2 + 1];
        found = [u * res.plan.canvas.width, v * res.plan.canvas.height];
      }
      expect(found, `點 ${i},${j} 找不到三角形`).not.toBeNull();
      expect(Math.floor(found![0] + 1e-6)).toBe(pl.x + i);
      expect(Math.floor(found![1] + 1e-6)).toBe(pl.y + j);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it('雙翼：兩片各自一個螢幕，各自量到的範圍等於排好的位置', async () => {
    const out = (res.b as BuildOk).bytes;
    const doc = await io.readBinary(out);
    const so = readLedObjects(doc, objects).objects.get(byName('LED_G_雙翼').id)!;
    const obj = res.plan.objects.find(o => o.name === '雙翼')!;
    expect(obj.pieces).toHaveLength(2);
    const prim = so.geom.prims[0];
    // 左邊那片（x < 0）的頂點 UV 範圍 == pieces[0]
    for (const [pi, p] of obj.pieces.entries()) {
      const tris: number[] = [];
      for (let t = 0; t + 2 < prim.index.length; t += 3) {
        const cx = (prim.pos[prim.index[t] * 3] + prim.pos[prim.index[t + 1] * 3] + prim.pos[prim.index[t + 2] * 3]) / 3;
        if ((pi === 0) === (cx < 0)) for (let k = 0; k < 3; k++) tris.push(prim.uv![prim.index[t + k] * 2], prim.uv![prim.index[t + k] * 2 + 1]);
      }
      const r = uvRegion(tris, res.plan.canvas)!;
      expect(r.rect).toEqual({ x: p.placed!.x, y: p.placed!.y, w: p.placed!.w, h: p.placed!.h });
    }
    expect(pieceScreensOf(res.plan).map(s => s.ref)).toEqual([`${byName('LED_G_雙翼').id}#0`, `${byName('LED_G_雙翼').id}#1`]);
  });

  it('舊版面：每塊畫在原本的位置；沒有跨邊緣', () => {
    const legacy = buildLegacy(res.plan, res.ins, FIXTURE_OLD_CANVAS);
    expect(legacy.unprotected).toEqual([]);
    expect(legacy.approximate).toEqual([]);
    expect(legacy.screens.length).toBeGreaterThanOrEqual(8);
    // 有外框的 LED：舊版面只看螢幕面，外框亂放的舊 UV 不會把範圍撐大
    const withFrame = legacy.screens.find(s => s.key === `o:${byName('LED_I_框').id}`)!;
    expect(withFrame.dest.w).toBe(704);
    expect(res.a.infos[byName('LED_I_框').id]!.oldRegion!.rect.w).toBeGreaterThan(704);
    const d = legacy.screens.find(s => s.key === `o:${byName('LED_D_地屏').id}`)!;
    expect(d.dest).toEqual(res.a.infos[byName('LED_D_地屏').id]!.oldRegion!.rect);
    // 地屏原本轉了 90 度 → 舊版面要轉回來
    expect(d.rotate).toBe(90);
  });
});

describe('擋住不對的情況', () => {
  it('檢查真的抓得到問題：節點被動過、頂點被動過、外框不對、UV 對不上', async () => {
    const a = await io.readBinary(plain), b = await io.readBinary(plain);
    expect(verifyUvEdit(a, b, new Set())).toEqual([]);
    b.getRoot().listNodes()[0].setTranslation([9, 9, 9]);
    expect(verifyUvEdit(a, b, new Set()).join()).toContain('位置');
    const c = await io.readBinary(plain);
    const prim = c.getRoot().listMeshes()[0].listPrimitives()[0];
    (prim.getAttribute('POSITION')!.getArray() as Float32Array)[0] += 0.5;
    expect(verifyUvEdit(a, c, new Set()).join()).toContain('POSITION');
    // UV 被動過但沒有宣告 → 抓得到
    const d = await io.readBinary(plain);
    (d.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TEXCOORD_0')!.getArray() as Float32Array)[0] += 0.5;
    expect(verifyUvEdit(a, d, new Set()).join()).toContain('TEXCOORD_0');
    // 輸出檔量到的外框不對 → 抓得到
    const r = await run(plain);
    const wrongPlan: Plan = JSON.parse(JSON.stringify(r.plan));
    wrongPlan.objects.find(o => o.mode === 'auto')!.pieces[0].placed!.x += 8;
    const rep = verifyOutputUv(await io.readBinary((r.b as BuildOk).bytes), objects, wrongPlan, r.a.infos);
    expect(rep.ok).toBe(false);
  });

  it('不收：meshopt / 量化 / 不認得的擴充 / .gltf / 外部檔案；Draco 和沒壓縮都收', () => {
    expect(precheckForUv(plain)).toEqual({ ok: true, draco: false });
    expect(precheckForUv(draco)).toEqual({ ok: true, draco: true });
    const withExt = (name: string) => patchGlbJson(plain, (j) => { j.extensionsUsed = [name]; });
    expect(precheckForUv(withExt('EXT_meshopt_compression'))).toMatchObject({ ok: false });
    expect(precheckForUv(withExt('KHR_mesh_quantization'))).toMatchObject({ ok: false });
    expect(precheckForUv(withExt('VENDOR_unknown_thing'))).toMatchObject({ ok: false });
    expect(precheckForUv(new TextEncoder().encode('{"asset":{"version":"2.0"}}'))).toMatchObject({ ok: false });
    expect(precheckForUv(new Uint8Array(40))).toMatchObject({ ok: false });
  });

  it('沒有 UV 的 LED 平面也能貼（原本沒有，現在有）', async () => {
    const f = buildUvFixture();
    for (const prim of f.doc.getRoot().listMeshes().flatMap(m => m.listPrimitives())) prim.setAttribute('TEXCOORD_0', null);
    const bytes = await io.writeBinary(f.doc);
    const a = await analyzeModelBytes(io, bytes, objects, FIXTURE_OLD_CANVAS);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.infos[byName('LED_A_主牆').id]!.oldRegion).toBeNull();
    const ins = inputs(a, n => n === 'LED_A_主牆');
    const plan = buildPlan(ins, { front: a.front, metersPerUnit: 1, oldCanvas: FIXTURE_OLD_CANVAS });
    expect(plan.blockers).toEqual([]);
    expect(plan.objects.find(o => o.mode === 'none')).toBeTruthy();
    const b = await buildModelBytes(io, bytes, objects, plan, FIXTURE_OLD_CANVAS);
    expect(b.ok, JSON.stringify((b as { issues?: string[] }).issues)).toBe(true);
    const layout = (await verifyUvScene(ab(bytes), ab((b as BuildOk).bytes), plan, objects));
    expect(layout.issues).toEqual([]);
  });
});
