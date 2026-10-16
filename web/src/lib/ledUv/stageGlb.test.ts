// 自動貼 UV 第 2 階段：用真的 stage.glb（3ds Max 匯出、Draco 壓過、200 萬個三角形、LED 都是彎的）
//   辨識 → 排版 → 寫進模型 → 三關檢查 → 網站載入後位置對
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NodeIO } from '@gltf-transform/core';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { analyzeModelBytes, buildModelBytes, type AnalyzeOk, type BuildOk } from './pipeline';
import { buildPlan, type PlanObjectIn } from './plan';
import { verifyUvScene } from './verifyScene';
import { DISTORTION_OK } from './surfaces';
import { readLedObjects } from './docRead';
import { shelfArrangement, uvReadingCheck } from './testing';

const url = new URL('../../../../stage.glb', import.meta.url);
const have = existsSync(url);
const names = ['LED_1_DOWN', 'LED_1_UP', 'LED_4', 'LED_Sky', 'LED2_Stage', 'LED3_Stage'];
const objects = names.map((n, i) => ({ id: `so_${i}`, meshName: n }));
const OLD = { width: 8800, height: 2024 };
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

let io: NodeIO;
let bytes: Uint8Array;
let ana: AnalyzeOk;

beforeAll(async () => {
  if (!have) return;
  await installNodeModelDecoders();
  io = await createNodeIO();
  bytes = new Uint8Array(readFileSync(url));
  const a = await analyzeModelBytes(io, bytes, objects, OLD);
  if (!a.ok) throw new Error(a.reason);
  ana = a;
}, 120_000);

describe.runIf(have)('真的 stage.glb：彎的 LED', () => {
  it('LED_1_DOWN / LED_1_UP / LED_4：同一道凸的圓弧牆（半徑約 20.9 m、47 度），弧長 17.27 m、變形 < 0.5 %', () => {
    for (const n of ['LED_1_DOWN', 'LED_1_UP', 'LED_4']) {
      const info = ana.infos[objects.find(o => o.meshName === n)!.id]!;
      expect(info.kind, n).toBe('ok');
      const p = info.pieces[0];
      expect(p.kind).toBe('arc');
      expect(p.arc!.convex).toBe(true);
      expect(p.arc!.radius).toBeGreaterThan(20.5);
      expect(p.arc!.radius).toBeLessThan(21.3);
      expect((p.arc!.span * 180) / Math.PI).toBeGreaterThan(47);
      expect((p.arc!.span * 180) / Math.PI).toBeLessThan(48);
      expect(p.widthU).toBeGreaterThan(17.1);
      expect(p.widthU).toBeLessThan(17.4);
      expect(p.distortion.max).toBeLessThan(DISTORTION_OK);
      expect(p.facing).toBeGreaterThan(0.95);
    }
  });

  it('LED_Sky（波浪形）：沿 Y 擠出的曲面（第 4 階段）→ 側面形狀照弧長拉直，變形 < 0.5 %（以前是硬貼會變形、保留原本的 UV）', () => {
    const info = ana.infos[objects.find(o => o.meshName === 'LED_Sky')!.id]!;
    expect(info.kind).toBe('ok');
    const p = info.pieces[0];
    expect(p.kind).toBe('ext');
    expect(Math.abs(p.ext!.axis[1])).toBeGreaterThan(0.999);     // 擠出方向 = 世界 Y
    expect(p.ext!.profileVertical).toBe(false);                  // 波浪是左右方向
    expect(p.heightU).toBeGreaterThan(1.4);                      // 高 1.5 m
    expect(p.heightU).toBeLessThan(1.6);
    expect(p.widthU).toBeGreaterThan(45.4);                      // 弧長比兩端的距離（45.4 m）長
    expect(p.distortion.max).toBeLessThan(DISTORTION_OK);
    expect(p.facing).toBeGreaterThan(0.9);
  });

  it('LED2_Stage / LED3_Stage：一道凹的弧牆（半徑約 15 m、29 度）+ 六塊平面；舞台地板那一大塊不是螢幕', () => {
    for (const n of ['LED2_Stage', 'LED3_Stage']) {
      const info = ana.infos[objects.find(o => o.meshName === n)!.id]!;
      expect(info.kind, n).toBe('ok');
      expect(info.pieces).toHaveLength(7);
      const arcs = info.pieces.filter(p => p.kind === 'arc');
      expect(arcs).toHaveLength(1);
      expect(arcs[0].arc!.convex).toBe(false);
      expect(arcs[0].arc!.radius).toBeGreaterThan(14.5);
      expect(arcs[0].arc!.radius).toBeLessThan(15.6);
      expect(arcs[0].widthU).toBeGreaterThan(7.5);
      expect(arcs[0].widthU).toBeLessThan(7.9);
    }
  });

  it('排版、寫進模型、三關檢查都過；網站載入後每個物件的位置 == 排好的長方形（Draco 輸入 → Draco 輸出）', async () => {
    const ins: PlanObjectIn[] = objects.map((o, i) => ({
      id: o.id, name: o.meshName, order: i, info: ana.infos[o.id], selected: true,  // LED_Sky 勾了也貼不了（不是平面也不是圓柱）→ 保留
      sizes: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [k, { mode: 'pitch' as const, pitchMm: 20 }])), manuals: [],
    }));
    const plan = buildPlan(ins, { front: ana.front, metersPerUnit: ana.scaleFactor, oldCanvas: OLD });
    expect(plan.blockers).toEqual([]);
    expect(plan.objects.find(o => o.name === 'LED_Sky')!.mode).toBe('auto');
    expect(plan.objects.find(o => o.name === 'LED_Sky')!.pieces[0].surface).toBe('ext');
    const up = plan.objects.find(o => o.name === 'LED_1_UP')!;
    expect(up.pieces[0].placed!.w).toBeGreaterThan(850);  // 17.27 m / 20 mm
    expect(up.pieces[0].placed!.w).toBeLessThan(870);
    const b = await buildModelBytes(io, bytes, objects, plan, OLD);
    expect(b.ok, JSON.stringify((b as { issues?: string[] }).issues ?? (b as { reason?: string }).reason)).toBe(true);
    const out = (b as BuildOk).bytes;
    expect((b as BuildOk).draco).toBe(true);
    expect((b as BuildOk).output.maxPixelError).toBeLessThan(0.01);
    const r = await verifyUvScene(ab(bytes), ab(out), plan, objects);
    expect(r.issues).toEqual([]);
    // 接縫：弧牆上、弧牆下同一個點距、同樣的寬 → 畫布上左右對齊（弧長一樣，每一欄是同一段弧）、上面的在上、不重疊（要不要上下剛好貼在一起，看排版：同一排有比較高的螢幕就會置中，手動排是第 3 階段）
    const upP = up.pieces[0].placed!, downP = plan.objects.find(o => o.name === 'LED_1_DOWN')!.pieces[0].placed!;
    expect(upP.x).toBe(downP.x);
    expect(upP.w).toBe(downP.w);
    expect(upP.y + upP.h).toBeLessThanOrEqual(downP.y);
    // 不會左右 / 上下反：用真的輸出檔，每個三角形用 GPU 的方式獨立檢查（凸的三道弧牆）
    const outRead = readLedObjects(await io.readBinary(out), objects);
    for (const n of ['LED_1_DOWN', 'LED_1_UP', 'LED_4']) {
      const so = outRead.objects.get(objects.find(o => o.meshName === n)!.id)!;
      const chk = uvReadingCheck(so.geom.prims[0], plan.canvas.width, plan.canvas.height);
      expect(chk.checked, n).toBeGreaterThan(500);
      expect(chk.bad, n).toBe(0);
    }
    for (const o of plan.objects) {
      if (o.mode === 'auto' && o.pieces.length === 1) expect(r.rects[o.id], o.name).toEqual({ x: o.pieces[0].placed!.x, y: o.pieces[0].placed!.y, w: o.pieces[0].placed!.w, h: o.pieces[0].placed!.h });
    }
  }, 300_000);

  // 第 3 階段：自己排。弧牆上直接疊在弧牆下面（邊對邊貼在一起）、右邊那道轉 90° 再左右翻轉，畫布自己填寬 8800
  it('自己排：上下兩道弧牆貼在一起，測試圖跨過接縫是連續的（沒有錯位）；轉 90° + 翻轉的那道方向對；三關檢查都過', async () => {
    const ins: PlanObjectIn[] = objects.map((o, i) => ({
      id: o.id, name: o.meshName, order: i, info: ana.infos[o.id], selected: true,
      sizes: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [k, { mode: 'pitch' as const, pitchMm: 20 }])), manuals: [],
    }));
    const ctx = { front: ana.front, metersPerUnit: ana.scaleFactor, oldCanvas: OLD };
    const auto = buildPlan(ins, ctx);
    const n = (name: string) => auto.items.find(i => i.name === name)!;
    const up = n('LED_1_UP'), down = n('LED_1_DOWN'), four = n('LED_4');
    const arr = shelfArrangement(auto.items, auto.pack, {
      [up.key]: { x: 0, y: 0 },
      [down.key]: { x: 0, y: up.h },                                  // 上緣剛好貼著弧牆上的下緣
      [four.key]: { x: up.w + 100, y: 0, rotate: 90, flipH: true },
    }, { width: 8800, height: 4000 }, 1000);
    const plan = buildPlan(ins, { ...ctx, arrangement: arr });
    expect(plan.blockers).toEqual([]);
    expect(plan.canvas).toEqual({ width: 8800, height: 4000 });
    expect(plan.problems).toEqual({ outside: [], overlaps: [] });
    const pl = (name: string) => plan.objects.find(o => o.name === name)!.pieces[0].placed!;
    expect(pl('LED_1_UP').y + pl('LED_1_UP').h).toBe(pl('LED_1_DOWN').y);
    expect(pl('LED_4')).toMatchObject({ rotate: 90, flipH: true, w: four.h, h: four.w });

    const b = await buildModelBytes(io, bytes, objects, plan, OLD);
    expect(b.ok, JSON.stringify((b as { issues?: string[] }).issues ?? (b as { reason?: string }).reason)).toBe(true);
    const out = (b as BuildOk).bytes;
    expect((b as BuildOk).output.maxPixelError).toBeLessThan(0.01);
    const r = await verifyUvScene(ab(bytes), ab(out), plan, objects);
    expect(r.issues).toEqual([]);
    for (const o of plan.objects) {
      if (o.mode === 'auto' && o.pieces.length === 1) expect(r.rects[o.id], o.name).toEqual({ x: o.pieces[0].placed!.x, y: o.pieces[0].placed!.y, w: o.pieces[0].placed!.w, h: o.pieces[0].placed!.h });
    }

    const outRead = readLedObjects(await io.readBinary(out), objects);
    const W = plan.canvas.width, H = plan.canvas.height;
    const prim = (name: string) => outRead.objects.get(objects.find(o => o.meshName === name)!.id)!.geom.prims[0];
    // 接縫：弧牆下最上面一排的頂點 vs 弧牆上最下面一排的頂點（3D 位置重合），畫布上的位置要一樣 → 測試圖跨過去是連續的
    const dp = prim('LED_1_DOWN'), upP = prim('LED_1_UP');
    let dMaxY = -Infinity, uMinY = Infinity;
    for (let v = 0; v < dp.pos.length / 3; v++) dMaxY = Math.max(dMaxY, dp.pos[v * 3 + 1]);
    for (let v = 0; v < upP.pos.length / 3; v++) uMinY = Math.min(uMinY, upP.pos[v * 3 + 1]);
    expect(Math.abs(dMaxY - uMinY)).toBeLessThan(0.01);   // 兩道牆在 3D 裡真的是接在一起的（差 2.5 mm）
    const top = new Map<string, number>();
    for (let v = 0; v < dp.pos.length / 3; v++) if (dp.pos[v * 3 + 1] > dMaxY - 0.02) top.set(`${Math.round(dp.pos[v * 3] * 200)},${Math.round(dp.pos[v * 3 + 2] * 200)}`, v);
    let pairs = 0, worstU = 0, worstV = 0;
    for (let v = 0; v < upP.pos.length / 3; v++) {
      if (upP.pos[v * 3 + 1] > uMinY + 0.02) continue;
      const m = top.get(`${Math.round(upP.pos[v * 3] * 200)},${Math.round(upP.pos[v * 3 + 2] * 200)}`);
      if (m === undefined) continue;
      pairs++;
      worstU = Math.max(worstU, Math.abs(upP.uv![v * 2] * W - dp.uv![m * 2] * W));
      worstV = Math.max(worstV, Math.abs(upP.uv![v * 2 + 1] * H - dp.uv![m * 2 + 1] * H));
    }
    expect(pairs).toBeGreaterThan(20);
    expect(worstU).toBeLessThan(0.01);   // 每一欄是同一段弧（弧長一樣、起點一樣）：實測一點都不差
    expect(worstV).toBeLessThan(0.01);   // 上面這道的下緣 == 下面這道的上緣：實測一點都不差

    // 沒轉的兩道：左右、上下沒有反
    for (const name of ['LED_1_DOWN', 'LED_1_UP']) {
      const chk = uvReadingCheck(prim(name), W, H);
      expect(chk.checked, name).toBeGreaterThan(500);
      expect(chk.bad, name).toBe(0);
    }
    // 轉 90° + 左右翻轉的那道：先把排法的轉動反過來（(畫布 x, 畫布 y) = (ly, lx) → u = lx, v = ly），再用同一個獨立檢查
    const p4 = prim('LED_4'), w4 = pl('LED_4');
    const swapped = Float64Array.from({ length: p4.uv!.length }, (_, k) => (k % 2 === 0 ? p4.uv![k + 1] * H - w4.y : p4.uv![k - 1] * W - w4.x));
    const chk4 = uvReadingCheck({ ...p4, uv: swapped }, 1, 1);
    expect(chk4.checked).toBeGreaterThan(500);
    expect(chk4.bad).toBe(0);
  }, 300_000);
});
