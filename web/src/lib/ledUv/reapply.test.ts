// 自動貼 UV：套用過一次以後再打開
//   上次切出來的各片螢幕（每片一個、範圍就是這片現在的 UV）不能讓多片的物件變成「已手動切」只剩一整塊；
//   這次套用把它們搬到新位置，不再多切一份；有被動過的才當手動切的
import { beforeAll, describe, expect, it } from 'vitest';
import { Document, type Accessor, type Buffer as GBuffer, type Primitive } from '@gltf-transform/core';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { gridPrim } from './testing';
import type { PrimGeom } from './surfaces';
import type { Vec3 } from './geometry';
import { analyzeModelBytes, buildModelBytes } from './pipeline';
import { buildLegacy, buildPlan, pieceScreensOf, pieceScreenUpdatesOf, splitManuals, type ManualBox, type PlanObjectIn } from './plan';

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const OLD = { width: 4000, height: 2000 };

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

beforeAll(async () => { await installNodeModelDecoders(); });

describe('套用過一次再打開', () => {
  it('上次切出來的各片螢幕不算手動切：三片照樣自動貼、套用時搬位置不多切、舊版面指向原本的螢幕', async () => {
    const io = await createNodeIO();
    const bytes = await io.writeBinary(buildDoc());
    const a1 = await analyzeModelBytes(io, bytes, objects, OLD);
    if (!a1.ok) throw new Error(a1.reason);
    const plan1 = buildPlan([input(a1.infos.so_lift, {})], { front: a1.front, metersPerUnit: a1.scaleFactor, oldCanvas: OLD });
    const built = await buildModelBytes(io, bytes, objects, plan1, plan1.canvas);
    if (!built.ok) throw new Error(built.reason);
    // 後台把 pieceScreensOf 的三片存成螢幕
    const screens: ManualBox[] = pieceScreensOf(plan1).map((s, i) => ({ id: `ls_${i}`, name: s.name, uv: s.uv }));
    expect(screens.length).toBe(3);

    // 第二次：模型已經是新 UV，畫布是上次的
    const canvas2 = plan1.canvas;
    const a2 = await analyzeModelBytes(io, built.bytes, objects, canvas2);
    if (!a2.ok) throw new Error(a2.reason);
    const info2 = a2.infos.so_lift!;
    const split = splitManuals(info2, screens, canvas2);
    expect(split.manuals).toEqual([]);
    expect(Object.values(split.pieceScreens!).sort()).toEqual(['ls_0', 'ls_1', 'ls_2']);

    const plan2 = buildPlan([input(info2, split)], { front: a2.front, metersPerUnit: a2.scaleFactor, oldCanvas: canvas2 });
    const o = plan2.objects[0];
    expect(o.mode).toBe('auto');
    expect(o.pieces.length).toBe(3);
    expect(pieceScreensOf(plan2)).toEqual([]);
    expect(pieceScreenUpdatesOf(plan2).map(u => u.id).sort()).toEqual(['ls_0', 'ls_1', 'ls_2']);
    const lg = buildLegacy(plan2, [input(info2, split)], canvas2);
    expect(lg.screens.map(s => s.key).sort()).toEqual(['s:ls_0', 's:ls_1', 's:ls_2']);
  });

  it('畫布大小填錯（不是這個模型 UV 對應的畫布）：螢幕對不上，照舊當手動切的（不亂猜）', async () => {
    const io = await createNodeIO();
    const bytes = await io.writeBinary(buildDoc());
    const a = await analyzeModelBytes(io, bytes, objects, OLD);
    if (!a.ok) throw new Error(a.reason);
    const info = a.infos.so_lift!;
    const r = info.oldPieces.map(p => p!.region.rect);
    const good: ManualBox[] = r.map((x, i) => ({ id: `m${i}`, name: `p${i}`, uv: [x.x / OLD.width, x.y / OLD.height, (x.x + x.w) / OLD.width, (x.y + x.h) / OLD.height] }));
    expect(splitManuals(info, good, OLD).manuals).toEqual([]);
    expect(splitManuals(info, good, { width: 5000, height: 2000 }).manuals.length).toBe(3);
    expect(splitManuals(info, good.slice(0, 2), OLD).manuals.length).toBe(2);   // 螢幕數不等於片數
  });
});
