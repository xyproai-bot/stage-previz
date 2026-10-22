// 自動貼 UV：一個物件裡有好幾塊 LED mesh（曲線升降台：台體 + 正面 LED + 左側 LED + 右側 LED）
//   每個 LED mesh 是獨立的一片（就算貼在一起也不會焊成一片）、名稱用 mesh 名稱；
//   只有一塊 LED mesh、或整個物件都當螢幕（舊模型）→ 跟以前一模一樣
import { beforeAll, describe, expect, it } from 'vitest';
import { Document, type Accessor, type Buffer as GBuffer, type Primitive } from '@gltf-transform/core';
import { createNodeIO, installNodeModelDecoders } from '../modelCompress/testing/nodeDecoders';
import { gridPrim } from './testing';
import type { PrimGeom } from './surfaces';
import type { Vec3 } from './geometry';
import { analyzeModelBytes, type AnalyzeOk } from './pipeline';
import { buildPlan, pieceScreensOf, type PlanObjectIn } from './plan';
import { readLedObjects } from './docRead';
import { analyzeObject, stageFrontOf } from './surfaces';

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const CANVAS = { width: 4000, height: 2000 };

function buildDoc(opts: { ledMaterialName: string; frontOnly?: boolean }) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3', arr: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>): Accessor =>
    doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer as GBuffer);
  const toPrim = (g: PrimGeom): Primitive => doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos)))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(g.uv!)))
    .setIndices(acc('SCALAR', new Uint32Array(g.index)));
  const led = doc.createMaterial(opts.ledMaterialName);
  const metal = doc.createMaterial('升降台_金屬');
  const scene = doc.createScene('Scene');
  const root = doc.createNode('LED_曲線升降-1');
  scene.addChild(root);
  const mesh = (name: string, g: PrimGeom, m: typeof led) => {
    const me = doc.createMesh(name).addPrimitive(toPrim(g).setMaterial(m));
    root.addChild(doc.createNode(name).setMesh(me));
  };
  // 台體：不是 LED 材質
  mesh('曲線升降-1_台體', gridPrim([-2, 0, -1.5], X, Z, 4, 1.5, 2), metal);
  // 正面、左側、右側：三塊 LED，貼在同一條邊上（共用角落頂點）
  mesh('曲線升降-1_正面', gridPrim([-2, 0, 0], X, Y, 4, 2, 3), led);
  if (!opts.frontOnly) {
    mesh('曲線升降-1_左側', gridPrim([-2, 0, 0], Z, Y, 1.5, 2, 3), led);   // 法線朝 -X
    mesh('曲線升降-1_右側', gridPrim([2, 0, 0], Y, Z, 2, 1.5, 3), led);    // 法線朝 +X
  }
  return doc;
}

const objects = [{ id: 'so_lift', meshName: 'LED_曲線升降-1' }];

async function analyze(doc: Document): Promise<AnalyzeOk> {
  const io = await createNodeIO();
  const bytes = await io.writeBinary(doc);
  const a = await analyzeModelBytes(io, bytes, objects, CANVAS);
  if (!a.ok) throw new Error(a.reason);
  return a;
}

beforeAll(async () => { await installNodeModelDecoders(); });

describe('一個物件裡有好幾塊 LED mesh（自動貼 UV）', () => {
  it('讀進來時：每個 LED 節點一塊、名稱是 mesh 名稱；台體不算', () => {
    const read = readLedObjects(buildDoc({ ledMaterialName: 'LED_Screen' }), objects);
    const geom = read.objects.get('so_lift')!.geom;
    expect(geom.groupNames).toEqual(['曲線升降-1_正面', '曲線升降-1_左側', '曲線升降-1_右側']);
    expect(geom.prims.filter(p => p.screen).map(p => p.group)).toEqual([0, 1, 2]);
    expect(geom.prims.filter(p => !p.screen).every(p => p.group === undefined)).toBe(true);
  });

  it('貼在一起的三塊也是三片（以前焊成一片 L 形，不能貼）；名稱 = mesh 名稱', async () => {
    const a = await analyze(buildDoc({ ledMaterialName: 'LED_Screen' }));
    const info = a.infos.so_lift!;
    expect(info.kind).toBe('ok');
    expect(info.pieces.map(p => p.label).sort()).toEqual(['曲線升降-1_右側', '曲線升降-1_左側', '曲線升降-1_正面']);
    expect(info.pieces.every(p => p.kind === 'flat')).toBe(true);
  });

  it('對照：不分塊的話（以前的做法），貼在一起的三塊焊成一片 L 形，不能貼', () => {
    const geom = readLedObjects(buildDoc({ ledMaterialName: 'LED_Screen' }), objects).objects.get('so_lift')!.geom;
    const plain = { prims: geom.prims.map(p => ({ ...p, group: undefined })) };
    const info = analyzeObject(plain, stageFrontOf([plain]));
    expect(info.kind === 'ok' && info.pieces.length === 3).toBe(false);
  });

  it('排版：每片各有名稱、各自的位置；新切的螢幕也用 mesh 名稱', async () => {
    const a = await analyze(buildDoc({ ledMaterialName: 'LED_Screen' }));
    const ins: PlanObjectIn[] = [{
      id: 'so_lift', name: '曲線升降-1', order: 0, info: a.infos.so_lift, selected: true,
      sizes: { 0: { mode: 'pitch', pitchMm: 20 }, 1: { mode: 'pitch', pitchMm: 20 }, 2: { mode: 'pitch', pitchMm: 20 } }, manuals: [],
    }];
    const plan = buildPlan(ins, { front: a.front, metersPerUnit: a.scaleFactor, oldCanvas: CANVAS });
    const o = plan.objects[0];
    expect(o.mode).toBe('auto');
    expect(o.pieces.map(p => p.name).sort()).toEqual(['曲線升降-1_右側', '曲線升降-1_左側', '曲線升降-1_正面']);
    expect(new Set(o.pieces.map(p => p.key)).size).toBe(3);
    expect(o.pieces.every(p => p.placed)).toBe(true);
    const screens = pieceScreensOf(plan);
    expect(screens.map(s => s.name).sort()).toEqual(['曲線升降-1_右側', '曲線升降-1_左側', '曲線升降-1_正面']);
  });

  it('只有一塊 LED mesh：跟以前一樣（一片、沒有 mesh 名稱、用物件名稱）', async () => {
    const a = await analyze(buildDoc({ ledMaterialName: 'LED_Screen', frontOnly: true }));
    const info = a.infos.so_lift!;
    expect(info.pieces).toHaveLength(1);
    expect(info.pieces[0].label).toBeUndefined();
    const read = readLedObjects(buildDoc({ ledMaterialName: 'LED_Screen', frontOnly: true }), objects);
    expect(read.objects.get('so_lift')!.geom.groupNames).toBeUndefined();
  });

  it('整個物件都當螢幕（材質名稱沒有 LED 的舊模型）：不拆，跟以前一樣', () => {
    const read = readLedObjects(buildDoc({ ledMaterialName: 'Screen' }), objects);
    const geom = read.objects.get('so_lift')!.geom;
    expect(geom.groupNames).toBeUndefined();
    expect(geom.prims.every(p => p.group === undefined && p.screen)).toBe(true);
  });
});
