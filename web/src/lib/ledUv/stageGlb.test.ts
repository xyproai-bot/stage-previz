// 自動貼 UV 第 2 階段：用真的 stage.glb（3ds Max 匯出、Draco 壓過、200 萬個三角形、LED 都是彎的）
//   辨識 → 排版 → 寫進模型 → 三關檢查 → 網站載入後位置對
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NodeIO } from '@gltf-transform/core';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { analyzeModelBytes, buildModelBytes, type AnalyzeOk, type BuildOk } from './pipeline';
import { buildPlan, type PlanObjectIn } from './plan';
import { verifyUvScene } from './verifyScene';
import { UNSUPPORTED_TEXT } from './text';
import { DISTORTION_OK, DISTORTION_WARN } from './surfaces';
import { readLedObjects } from './docRead';
import { uvReadingCheck } from './testing';

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

  it('LED_Sky（波浪形）不是平面也不是圓柱：保留原本的 UV，告訴製作硬貼會變形多少（紅色）', () => {
    const info = ana.infos[objects.find(o => o.meshName === 'LED_Sky')!.id]!;
    expect(info.kind).toBe('unsupported');
    expect(info.unsupported).toBe('arc');
    expect(info.freeform!.distortion.max).toBeGreaterThan(DISTORTION_WARN);
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
    expect(plan.objects.find(o => o.name === 'LED_Sky')!.mode).toBe('keep');
    expect(plan.objects.find(o => o.name === 'LED_Sky')!.reason).toBe(UNSUPPORTED_TEXT.arc);
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
});
