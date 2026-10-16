// 自動貼 UV 第 3 階段的整合測試：自己排的排法（位置 / 轉 90° / 翻轉 / 自己填的畫布）→ 真的 .glb 寫進去 → 重新讀回來 / 網站載入
//   - 轉 90° + 左右翻轉的弧牆：每個頂點的 UV == 獨立寫的公式算出來的畫布位置（0.01 像素）、一個 LED 點對一個畫布像素
//   - 三關檢查都過、網站載入後每個物件的位置 == 排好的長方形
//   - 3D 預覽的 UV == 寫進去的
//   - 舊版面：新排法轉過 / 翻過，舊影片的畫面還是貼回原本的位置（用版型真的會用的對應函式驗）
import { beforeAll, describe, expect, it } from 'vitest';
import type { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { DRACO_ENCODER_OPTIONS } from '../modelCompress/settings';
import { mapUvToTemplate, type Placement } from '../ledTemplate';
import { buildUvFixture, FIXTURE_OLD_CANVAS } from './uvFixture';
import { analyzeModelBytes, buildModelBytes, openModelBytes, type AnalyzeOk, type BuildOk } from './pipeline';
import { buildLegacy, buildPlan, type Plan, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { verifyUvScene } from './verifyScene';
import { buildUvPreview } from './previewUv';
import { arrangementFromPack, type ArrangeItem, type Arrangement } from './arrange';
import type { PrimGeom } from './surfaces';
import { shelfArrangement } from './testing';

let io: NodeIO;
let plain: Uint8Array;
let draco: Uint8Array;
const fixture = buildUvFixture();
const objects = fixture.objects.map(o => ({ id: o.id, meshName: o.meshName }));
const idOf = (n: string) => objects.find(o => o.meshName === n)!.id;
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const CANVAS = { width: 4096, height: 4096 };

beforeAll(async () => {
  await installNodeModelDecoders();
  io = await createNodeIO();
  plain = await io.writeBinary(buildUvFixture().doc);
  const d = buildUvFixture().doc;
  d.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ ...DRACO_ENCODER_OPTIONS });
  draco = await io.writeBinary(d);
});

function inputs(a: AnalyzeOk): PlanObjectIn[] {
  return fixture.objects.map((o, i) => ({
    id: o.id, name: o.display, order: i, info: a.infos[o.id], selected: o.meshName !== 'LED_H_沒選',
    sizes: { 0: { mode: 'pitch' as const, pitchMm: 20 }, 1: { mode: 'pitch' as const, pitchMm: 20 } },
    manuals: [],
  }));
}

/** 手排：指定的幾塊放在指定的位置 + 轉動；其餘的一塊一塊排在下面（不重疊），畫布自己填 4096 × 4096 */
const manual = (auto: Plan, spec: Record<string, Partial<ArrangeItem>>): Arrangement => shelfArrangement(auto.items, auto.pack, spec, CANVAS);

describe.each([['沒壓縮', () => plain], ['Draco', () => draco]] as const)('自己排的排法（%s）', (label, getInput) => {
  let input: Uint8Array;
  let ana: AnalyzeOk;
  let auto: Plan;
  let plan: Plan;
  let built: Awaited<ReturnType<typeof buildModelBytes>>;
  let keyE: string, keyD: string, keyK: string;
  const tol = label === '沒壓縮' ? 0.01 : 0.2;   // Draco 把位置量化過，獨立公式用解壓縮後的位置算，多一點誤差

  beforeAll(async () => {
    input = getInput();
    const a = await analyzeModelBytes(io, input, objects, FIXTURE_OLD_CANVAS);
    if (!a.ok) throw new Error(a.reason);
    ana = a;
    const ins = inputs(a);
    auto = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS });
    keyE = `o:${idOf('LED_E_小半圓')}`;
    keyD = `o:${idOf('LED_D_地屏')}`;
    keyK = `o:${idOf('LED_K_凹弧')}`;
    const arr = manual(auto, {
      [keyE]: { x: 40, y: 30, rotate: 90, flipH: true },              // 弧牆：轉 90° 再左右翻轉（= 沿對角線翻）
      [keyK]: { x: 300, y: 30, rotate: 270, flipV: true },
      [keyD]: { x: 600, y: 30, rotate: 180, flipH: true },            // 地屏（舊 UV 本來就轉過 90°）
      [`o:${idOf('LED_H_沒選')}`]: { x: 900, y: 30 },                  // 保留原本 UV 的物件也可以搬
    });
    plan = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS, arrangement: arr });
    built = await buildModelBytes(io, input, objects, plan, FIXTURE_OLD_CANVAS);
  });

  it('方案：沒有擋住套用的問題、沒有重疊；畫布 = 自己填的；位置 / 轉動 / 翻轉 / 鎖死的大小都對', () => {
    expect(plan.blockers).toEqual([]);
    expect(plan.problems).toEqual({ outside: [], overlaps: [] });
    expect(plan.arranged).toBe(true);
    expect(plan.canvas).toEqual(CANVAS);
    const e = plan.objects.find(o => o.id === idOf('LED_E_小半圓'))!.pieces[0];
    const autoE = auto.objects.find(o => o.id === idOf('LED_E_小半圓'))!.pieces[0];
    expect(autoE.placed!.w).toBe(628);
    expect(e.placed).toEqual({ x: 40, y: 30, w: 150, h: 628, rotate: 90, flipH: true, flipV: false });   // 大小 = 規格，轉 90° 對調
    const h = plan.objects.find(o => o.id === idOf('LED_H_沒選'))!;
    expect(h.mode).toBe('keep');
    expect(h.keep!.placed).toMatchObject({ x: 900, y: 30, rotate: 0, flipH: false });
  });

  it('三關檢查都過；網站載入後每個物件的位置 == 排好的長方形', async () => {
    expect(built.ok, JSON.stringify((built as { issues?: string[] }).issues ?? (built as { reason?: string }).reason)).toBe(true);
    const out = (built as BuildOk).bytes;
    expect((built as BuildOk).output.maxPixelError).toBeLessThan(0.01);
    const r = await verifyUvScene(ab(input), ab(out), plan, objects);
    expect(r.issues).toEqual([]);
    for (const o of plan.objects) {
      if (o.mode === 'auto' && o.pieces.length === 1) {
        const p = o.pieces[0].placed!;
        expect(r.rects[o.id], o.name).toEqual({ x: p.x, y: p.y, w: p.w, h: p.h });
      }
      if (o.mode === 'keep' && o.keep) expect(r.rects[o.id], o.name).toEqual({ x: o.keep.placed.x, y: o.keep.placed.y, w: o.keep.rect.w, h: o.keep.rect.h });
    }
  });

  /** 小半圓（arcPrim：R=4、180 度、高 3、24 段，節點在 (0, 0, 4) + 外層 (0.5, 0, -1)）每個頂點在螢幕上的位置 (lx, ly) */
  function arcLocal(prim: PrimGeom, v: number): [number, number] {
    const x = prim.pos[v * 3] - 0.5, y = prim.pos[v * 3 + 1], z = prim.pos[v * 3 + 2] - 3;
    const ang = (Math.atan2(x, z) * 180) / Math.PI;
    return [(ang + 90) / 180, 1 - y / 3];
  }

  it('轉 90° + 左右翻轉的弧牆：每個頂點的 UV == 獨立算的畫布位置（轉 90° 順時針 (x,y)→(1-y,x)，再左右翻 x→1-x，等於 (y, x)）', async () => {
    const out = (built as BuildOk).bytes;
    const doc = await io.readBinary(out);
    const so = readLedObjects(doc, objects).objects.get(idOf('LED_E_小半圓'))!;
    const prim = so.geom.prims[0];
    const pl = plan.objects.find(o => o.id === idOf('LED_E_小半圓'))!.pieces[0].placed!;
    let worst = 0;
    const n = prim.pos.length / 3;
    for (let v = 0; v < n; v++) {
      const [lx, ly] = arcLocal(prim, v);
      const px = pl.x + ly * pl.w, py = pl.y + lx * pl.h;   // 獨立公式
      worst = Math.max(worst, Math.abs(prim.uv![v * 2] * plan.canvas.width - px), Math.abs(prim.uv![v * 2 + 1] * plan.canvas.height - py));
    }
    expect(n).toBeGreaterThan(40);
    expect(worst).toBeLessThan(tol);
  });

  it('一個 LED 點 ↔ 一個畫布像素（轉過 + 翻過：沿弧第 i 個點在畫布的第 i 列、由上往下第 j 個點在第 j 欄）', async () => {
    const out = (built as BuildOk).bytes;
    const doc = await io.readBinary(out);
    const prim = readLedObjects(doc, objects).objects.get(idOf('LED_E_小半圓'))!.geom.prims[0];
    const pl = plan.objects.find(o => o.id === idOf('LED_E_小半圓'))!.pieces[0].placed!;
    const W = plan.canvas.width, H = plan.canvas.height;
    const w0 = pl.h, h0 = pl.w;   // 規格：弧長 628 點 × 高 150 點
    expect([w0, h0]).toEqual([628, 150]);
    // 24 段的欄：依角度分組，每欄有 底（y=0）、頂（y=3）兩個頂點
    const cols = new Map<number, { bottom?: number; top?: number }>();
    for (let v = 0; v < prim.pos.length / 3; v++) {
      const [lx] = arcLocal(prim, v);
      const k = Math.round(lx * 24);
      const c = cols.get(k) ?? {};
      if (prim.pos[v * 3 + 1] > 1.5) c.top = v; else c.bottom = v;
      cols.set(k, c);
    }
    expect(cols.size).toBe(25);
    const uvOf = (v: number): [number, number] => [prim.uv![v * 2] * W, prim.uv![v * 2 + 1] * H];
    let checked = 0;
    for (const i of [0, 1, 2, 100, 313, 626, 627]) {
      for (const j of [0, 1, 75, 148, 149]) {
        const ang = (-90 + (180 * (i + 0.5)) / w0) * (Math.PI / 180);
        const k = Math.min(23, Math.floor(((ang * 180) / Math.PI + 90) / (180 / 24)));
        const a0 = (-90 + (k * 180) / 24) * (Math.PI / 180), a1 = (-90 + ((k + 1) * 180) / 24) * (Math.PI / 180);
        // 沿這個角度的射線打到弦上的哪裡（弦：k 欄和 k+1 欄的頂點連線）
        const ax = 4 * Math.sin(a0), az = 4 * Math.cos(a0), bx = 4 * Math.sin(a1), bz = 4 * Math.cos(a1);
        const dx = Math.sin(ang), dz = Math.cos(ang);
        const t = (dx * az - dz * ax) / (dz * (bx - ax) - dx * (bz - az));
        const lerp = (p: [number, number], q: [number, number]): [number, number] => [p[0] * (1 - t) + q[0] * t, p[1] * (1 - t) + q[1] * t];
        const c0 = cols.get(k)!, c1 = cols.get(k + 1)!;
        const top = lerp(uvOf(c0.top!), uvOf(c1.top!)), bottom = lerp(uvOf(c0.bottom!), uvOf(c1.bottom!));
        const fy = (j + 0.5) / h0;   // 由上往下
        const u = top[0] * (1 - fy) + bottom[0] * fy, v = top[1] * (1 - fy) + bottom[1] * fy;
        expect(Math.floor(u + 1e-6), `點 (${i}, ${j}) 的欄`).toBe(pl.x + j);
        expect(Math.floor(v + 1e-6), `點 (${i}, ${j}) 的列`).toBe(pl.y + i);
        checked++;
      }
    }
    expect(checked).toBe(35);
  });

  it('3D 預覽的 UV == 真的寫進去的（同一個函數算的）：每個被處理的物件的外框一樣', async () => {
    const opened = await openModelBytes(io, input);
    if (!opened.ok) throw new Error(opened.reason);
    const pv = buildUvPreview(opened.doc, objects, plan, FIXTURE_OLD_CANVAS);
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    expect(pv.preview.canvas).toEqual(CANVAS);
    const outDoc = await io.readBinary((built as BuildOk).bytes);
    const outRead = readLedObjects(outDoc, objects);
    for (const n of ['LED_E_小半圓', 'LED_K_凹弧', 'LED_D_地屏']) {
      const prims = pv.preview.objects[idOf(n)];
      const so = outRead.objects.get(idOf(n))!;
      prims.forEach((p, i) => {
        const out = so.geom.prims[i].uv!;
        const ext = (a: ArrayLike<number>, o: number) => { let lo = Infinity, hi = -Infinity; for (let k = o; k < a.length; k += 2) { lo = Math.min(lo, a[k]); hi = Math.max(hi, a[k]); } return [lo, hi]; };
        for (const o of [0, 1]) {
          const [l1, h1] = ext(p.uv!, o), [l2, h2] = ext(out, o);
          expect(l1).toBeCloseTo(l2, 6);
          expect(h1).toBeCloseTo(h2, 6);
        }
      });
    }
  });

  it('舊版面：新排法轉過 / 翻過，舊影片的畫面還是貼回原本的位置（地屏的舊 UV 本來就轉過 90°，是最容易錯的）', async () => {
    const lg = buildLegacy(plan, inputs(ana), FIXTURE_OLD_CANVAS);
    const origDoc = await io.readBinary(input);
    const origRead = readLedObjects(origDoc, objects);
    const outDoc = await io.readBinary((built as BuildOk).bytes);
    const outRead = readLedObjects(outDoc, objects);
    const W = plan.canvas.width, H = plan.canvas.height, OW = FIXTURE_OLD_CANVAS.width, OH = FIXTURE_OLD_CANVAS.height;
    for (const n of ['LED_D_地屏', 'LED_E_小半圓', 'LED_K_凹弧']) {
      const id = idOf(n);
      const screen = lg.screens.find(s => s.objectId === id);
      expect(screen, n).toBeDefined();
      const o = plan.objects.find(x => x.id === id)!;
      const pl = o.pieces[0].placed!;
      const place: Placement = { key: screen!.key, objectId: id, uv: null, dest: screen!.dest, rotate: screen!.rotate, flipH: screen!.flipH, flipV: screen!.flipV };
      const span = { us: pl.x / W, ul: pl.w / W, vs: pl.y / H, vl: pl.h / H };
      const a = origRead.objects.get(id)!.geom.prims[0], b = outRead.objects.get(id)!.geom.prims[0];
      // 兩邊的頂點用位置對起來（Draco 會重排）
      const keyOf = (p: PrimGeom, v: number) => [0, 1, 2].map(k => p.pos[v * 3 + k].toFixed(2)).join(',');
      const oldUvAt = new Map<string, [number, number]>();
      for (let v = 0; v < a.pos.length / 3; v++) oldUvAt.set(keyOf(a, v), [a.uv![v * 2] * OW, a.uv![v * 2 + 1] * OH]);
      let checked = 0, worst = 0;
      for (let v = 0; v < b.pos.length / 3; v++) {
        const old = oldUvAt.get(keyOf(b, v));
        if (!old) continue;
        const t = mapUvToTemplate(place, span, FIXTURE_OLD_CANVAS, b.uv![v * 2], b.uv![v * 2 + 1]);
        expect(t, `${n} 頂點 ${v}`).not.toBeNull();
        worst = Math.max(worst, Math.abs(t![0] * OW - old[0]), Math.abs(t![1] * OH - old[1]));
        checked++;
      }
      expect(checked, n).toBeGreaterThanOrEqual(16);
      // 版型取樣往裡縮半個像素（不讀到隔壁），範圍也四捨五入成整數像素 → 差不到 1 個像素；方向錯了會差幾百像素
      expect(worst, n).toBeLessThan(1.01);
    }
  });
});

describe('排法對不上螢幕清單、畫布太小', () => {
  it('超出畫布的螢幕 = 擋住套用（寫白話的原因）；重疊 = 只提醒；排法少了一塊就用自動排的位置', async () => {
    const a = await analyzeModelBytes(io, plain, objects, FIXTURE_OLD_CANVAS);
    if (!a.ok) throw new Error(a.reason);
    const ins = inputs(a);
    const auto = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS });
    const arr = manual(auto, {});
    const small = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS, arrangement: { ...arr, canvas: { width: 1000, height: 1000 } } });
    expect(small.problems!.outside.length).toBeGreaterThan(0);
    expect(small.blockers.some(b => b.includes('超出畫布'))).toBe(true);
    const e = arr.items.find(i => i.key === `o:${idOf('LED_E_小半圓')}`)!;
    const d = arr.items.find(i => i.key === `o:${idOf('LED_D_地屏')}`)!;
    const over = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS, arrangement: { ...arr, items: arr.items.map(i => (i === d ? { ...d, x: e.x, y: e.y } : i)) } });
    expect(over.problems!.overlaps.length).toBeGreaterThan(0);
    expect(over.blockers.filter(b => b.includes('超出'))).toEqual([]);
    expect(over.warnings.some(w => w.includes('重疊'))).toBe(true);
    const partial = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS, arrangement: { ...arr, items: arr.items.slice(0, 2) } });
    for (const o of partial.objects) if (o.mode === 'auto') for (const p of o.pieces) expect(p.placed, o.name).not.toBeNull();
  });

  it('沒有排法 = 跟以前完全一樣（自動排的畫布和位置）', async () => {
    const a = await analyzeModelBytes(io, plain, objects, FIXTURE_OLD_CANVAS);
    if (!a.ok) throw new Error(a.reason);
    const ins = inputs(a);
    const p0 = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS });
    const p1 = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS, arrangement: null });
    expect(p0.arranged).toBe(false);
    expect(p0.canvas).toEqual(p0.pack.canvas);
    expect(JSON.stringify(p1.objects.map(o => o.pieces.map(p => p.placed)))).toBe(JSON.stringify(p0.objects.map(o => o.pieces.map(p => p.placed))));
    // 把自動排的結果原封不動當成排法交進去，結果一樣（排法 == 預設）
    const same = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: FIXTURE_OLD_CANVAS, arrangement: arrangementFromPack(p0.items, p0.pack) });
    expect(same.canvas).toEqual(p0.canvas);
    expect(JSON.stringify(same.objects.map(o => [o.pieces.map(p => p.placed), o.keep?.placed]))).toBe(JSON.stringify(p0.objects.map(o => [o.pieces.map(p => p.placed), o.keep?.placed])));
  });
});
