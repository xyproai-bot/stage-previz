// 模型壓縮：壓縮 → 解開 → 對網站來說要跟原檔一模一樣
// （節點名稱 / 階層 / 世界矩陣、外框、自動縮放、UV、LED 對位圖、上傳時的物件預設位置）
// 另外也測「比對真的抓得到問題」：故意改壞壓縮檔，兩關都要喊不一樣。

import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { Accessor, TextureInfo, type NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { buildStageFixture, patchGlbJson, useMatrixForNode } from './testing/stageFixture';
import { createNodeIO, installNodeModelDecoders } from './testing/nodeDecoders';
import { assertSameModel, compareModels, toArrayBuffer } from './testing/assertSameModel';
import { compressGlb, precheckGlb, type CompressCoreResult } from './compressCore';
import { verifyDocuments } from './verifyDocument';
import { DRACO_ENCODER_OPTIONS } from './settings';
import { readGltfJson, decodersNeeded } from './glbJson';
import { parseModel } from '../modelLoader';
import { analyzeGltfScene, classifyMeshName, computeScaleFactor, findBestScope } from '../parseGlb';
import { collectUvTriangles, ledPanelInputs } from '../ledMapScene';
import { buildLedLayout, layoutPanel } from '../ledMap';
import { ledPanelRect } from './verifyScene';
import { loadLedPanelInputs } from '../ledCanvasPreview';

let io: NodeIO;
let original: Uint8Array;
let result: CompressCoreResult;
let compressed: Uint8Array;

async function fixtureGlb(scale = 1): Promise<Uint8Array> {
  const { doc, matrixNodeName } = buildStageFixture();
  if (scale !== 1) doc.getRoot().listNodes().find(n => n.getName() === '舞台')!.setScale([scale, scale, scale]);
  return useMatrixForNode(await io.writeBinary(doc), matrixNodeName);
}

beforeAll(async () => {
  await installNodeModelDecoders();
  io = await createNodeIO();
  original = await fixtureGlb();
  result = await compressGlb(original, io);
  compressed = result.output!;
}, 120_000);

function worldList(g: GLTF) {
  g.scene.updateMatrixWorld(true);
  const out: { name: string; type: string; world: number[] }[] = [];
  g.scene.traverse(o => out.push({ name: o.name, type: o.type, world: o.matrixWorld.toArray() }));
  return out;
}

function ledObjects(g: GLTF) {
  const scope = findBestScope(g.scene);
  return scope.children
    .filter(c => classifyMeshName(c.name).category === 'led_panel')
    .map((c, i) => ({ id: c.name, name: c.name, order: i, root: c }));
}

describe('模型壓縮（Draco）：壓完要跟原檔一模一樣', () => {
  it('測試模型有壓到、而且變小很多', () => {
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe('compressed');
    expect(result.afterBytes).toBeLessThan(result.beforeBytes * 0.5);
    expect(decodersNeeded(readGltfJson(compressed))).toEqual({ draco: true, meshopt: false });
    // 沒有被改成量化（量化會把縮放搬到節點上）
    expect(readGltfJson(compressed)!.extensionsUsed).not.toContain('KHR_mesh_quantization');
  });

  it('共用的兩關比對都過（assertSameModel）', async () => {
    const r = await assertSameModel(original, compressed, io);
    expect(r.doc.stats.primitivesMatched).toBeGreaterThanOrEqual(6);
    // 沒有索引的三角形、線段：Draco 不壓 → 原封不動
    expect(r.doc.stats.primitivesUnchanged).toBeGreaterThanOrEqual(2);
    // 實際誤差 / 容許誤差（容許誤差 = 範圍的 2^-21，約 float32 的 4 個最小刻度）
    expect(r.doc.stats.maxErrorRatio.POSITION).toBeLessThan(0.5);
    expect(r.doc.stats.maxErrorRatio.TEXCOORD_0).toBeLessThan(0.5);
    expect(r.doc.stats.trianglesOriginal).toBe(r.doc.stats.trianglesCompressed);
    expect(r.scene.stats.ledPanels).toBe(4);
  }, 60_000);

  it('節點名稱、階層、世界矩陣、場景外框、自動縮放倍率都一樣', async () => {
    const a = await parseModel(toArrayBuffer(original));
    const b = await parseModel(toArrayBuffer(compressed));
    const la = worldList(a), lb = worldList(b);
    expect(lb.map(x => `${x.type}:${x.name}`)).toEqual(la.map(x => `${x.type}:${x.name}`));
    la.forEach((x, i) => x.world.forEach((v, k) => {
      expect(Math.abs(v - lb[i].world[k])).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(v)));
    }));
    const ba = new THREE.Box3().setFromObject(a.scene), bb = new THREE.Box3().setFromObject(b.scene);
    const diag = ba.getSize(new THREE.Vector3()).length();
    expect(ba.min.distanceTo(bb.min)).toBeLessThanOrEqual(1e-5 * diag);
    expect(ba.max.distanceTo(bb.max)).toBeLessThanOrEqual(1e-5 * diag);
    expect(computeScaleFactor(bb.getSize(new THREE.Vector3()).length())).toBe(computeScaleFactor(diag));
    expect(findBestScope(b.scene).name).toBe(findBestScope(a.scene).name);
    // 上傳時存進資料庫的物件預設位置 / 旋轉 / 縮放：一模一樣
    const pa = analyzeGltfScene(a.scene), pb = analyzeGltfScene(b.scene);
    expect(pb.meshes.map(m => ({ ...m, sizeMeters: 0 }))).toEqual(pa.meshes.map(m => ({ ...m, sizeMeters: 0 })));
    expect(pb.scaleFactor).toBe(pa.scaleFactor);
    // 用 matrix 寫的（鏡像）節點也一樣
    const m4 = la.find(x => x.name === 'LED_04_天幕')!, m4b = lb.find(x => x.name === 'LED_04_天幕')!;
    m4.world.forEach((v, k) => expect(Math.abs(v - m4b.world[k])).toBeLessThan(1e-9));
    expect(new THREE.Matrix4().fromArray(m4.world).determinant()).toBeLessThan(0);
  }, 60_000);

  it('UV 在 float 精度內一樣（負的 v、跨邊緣的 u 都留著），貼圖還是 RepeatWrapping', async () => {
    const a = await parseModel(toArrayBuffer(original));
    const b = await parseModel(toArrayBuffer(compressed));
    for (const name of ['LED_01_主牆', '側屏_面', 'LED_03_地屏', 'LED_04_天幕']) {
      const ma = a.scene.getObjectByName(name) as THREE.Mesh, mb = b.scene.getObjectByName(name) as THREE.Mesh;
      const pa = ma.geometry.getAttribute('position'), ua = ma.geometry.getAttribute('uv');
      const pbuf = mb.geometry.getAttribute('position'), ub = mb.geometry.getAttribute('uv');
      // 原檔每個位置 → UV（這些格子沒有同位置不同 UV 的頂點）；壓縮後的頂點找最近的原檔頂點
      const cell = 1e-3;
      const ck = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      const grid = new Map<string, number[]>();
      for (let i = 0; i < pa.count; i++) {
        const k = ck(pa.getX(i), pa.getY(i), pa.getZ(i));
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
      let maxErr = 0, maxDist = 0, minV = Infinity, maxU = -Infinity;
      for (let j = 0; j < pbuf.count; j++) {
        const x = pbuf.getX(j), y = pbuf.getY(j), z = pbuf.getZ(j);
        let best = -1, bestD = Infinity;
        for (const dx of [-cell, 0, cell]) for (const dy of [-cell, 0, cell]) for (const dz of [-cell, 0, cell]) {
          for (const i of grid.get(ck(x + dx, y + dy, z + dz)) ?? []) {
            const d = Math.hypot(pa.getX(i) - x, pa.getY(i) - y, pa.getZ(i) - z);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
        expect(best, `${name} 第 ${j} 個頂點`).toBeGreaterThanOrEqual(0);
        maxDist = Math.max(maxDist, bestD);
        maxErr = Math.max(maxErr, Math.abs(ua.getX(best) - ub.getX(j)), Math.abs(ua.getY(best) - ub.getY(j)));
        minV = Math.min(minV, ub.getY(j));
        maxU = Math.max(maxU, ub.getX(j));
      }
      expect(maxDist, name).toBeLessThan(1e-5);
      expect(maxErr, name).toBeLessThan(1e-6);
      if (name === 'LED_01_主牆') expect(minV).toBeCloseTo(-0.8, 6);
      if (name === '側屏_面') expect(maxU).toBeCloseTo(1.05, 6);
      if (name === 'LED_03_地屏') expect(minV).toBeCloseTo(-1, 6);
    }
    // 貼圖的重複方式（資料層）
    const doc = await io.readBinary(compressed);
    const led = doc.getRoot().listMaterials().find(m => m.getName() === 'LED_Screen')!;
    expect(led.getEmissiveTextureInfo()!.getWrapS()).toBe(TextureInfo.WrapMode.REPEAT);
    expect(led.getEmissiveTextureInfo()!.getWrapT()).toBe(TextureInfo.WrapMode.REPEAT);
    expect(led.getEmissiveTexture()!.getImage()).toEqual(
      (await io.readBinary(original)).getRoot().listMaterials().find(m => m.getName() === 'LED_Screen')!.getEmissiveTexture()!.getImage());
  }, 60_000);

  it('LED 對位圖（ledMap）算出來的每塊 LED 位置一模一樣', async () => {
    const a = await parseModel(toArrayBuffer(original));
    const b = await parseModel(toArrayBuffer(compressed));
    for (const canvas of [{ width: 3840, height: 2160 }, { width: 8800, height: 2024 }]) {
      const la = buildLedLayout(ledPanelInputs(ledObjects(a)), canvas);
      const lb = buildLedLayout(ledPanelInputs(ledObjects(b)), canvas);
      expect(lb.skipped).toEqual(la.skipped);
      expect(lb.panels.map(p => [p.name, p.rect, p.wrapsX, p.wrapsY, p.triCount]))
        .toEqual(la.panels.map(p => [p.name, p.rect, p.wrapsX, p.wrapsY, p.triCount]));
      la.panels.forEach((p, i) => {
        expect(Math.abs(p.u.start - lb.panels[i].u.start)).toBeLessThan(1e-6);
        expect(Math.abs(p.v.start - lb.panels[i].v.start)).toBeLessThan(1e-6);
        expect(Math.abs(p.coverage - lb.panels[i].coverage)).toBeLessThan(1e-6);
      });
      // 主牆的 v 在 -0.8 ~ -0.45 → 繞回 0.2 ~ 0.55
      const wall = la.panels.find(p => p.name === 'LED_01_主牆')!;
      expect(wall.rect.y).toBe(Math.round(0.2 * canvas.height));
      expect(la.panels.find(p => p.name === 'LED_02_側屏')!.wrapsX).toBe(true);
    }
  }, 60_000);

  it('新專案精靈的 LED 畫布小預覽讀得出壓縮過的模型，LED 位置跟原檔一樣', async () => {
    const a = await parseModel(toArrayBuffer(original));
    const leds = ledObjects(a).map(o => ({ id: o.id, name: o.name, order: o.order, meshName: o.name }));
    const url = (u: Uint8Array) => URL.createObjectURL(new Blob([toArrayBuffer(u)], { type: 'model/gltf-binary' }));
    const canvas = { width: 3840, height: 2160 };
    const la = buildLedLayout(await loadLedPanelInputs(url(original), leds), canvas);
    const lb = buildLedLayout(await loadLedPanelInputs(url(compressed), leds), canvas);
    expect(lb.panels.length).toBe(4);
    expect(lb.panels.map(p => [p.name, p.rect])).toEqual(la.panels.map(p => [p.name, p.rect]));
  }, 60_000);

  it('比對用的快速 LED 位置（ledPanelRect）跟 LED 對位圖的 layoutPanel 算出來一樣', async () => {
    const a = await parseModel(toArrayBuffer(original));
    const sets: Float64Array[] = ledObjects(a).map(o => collectUvTriangles(o.root));
    // 亂數三角形：跨邊緣、整數倍平移、沒有面積、不是數字
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 0; k < 40; k++) {
      const n = 1 + Math.floor(rnd() * 30);
      const shiftU = Math.floor(rnd() * 5) - 2, shiftV = Math.floor(rnd() * 5) - 2;
      const base = rnd(), width = rnd() * 0.5;
      const arr: number[] = [];
      for (let t = 0; t < n; t++) {
        for (let c = 0; c < 3; c++) arr.push(shiftU + base + rnd() * width, shiftV + rnd() * (k % 3 === 0 ? 1.2 : 0.3));
      }
      if (k % 5 === 0) arr.push(0.1, 0.1, 0.1, 0.1, 0.1, 0.1);
      if (k % 7 === 0) arr.push(NaN, 0, 1, 1, 0, 1);
      sets.push(Float64Array.from(arr));
    }
    for (const canvas of [{ width: 3840, height: 2160 }, { width: 8800, height: 2024 }, { width: 1000, height: 3 }]) {
      for (const tris of sets) {
        const full = layoutPanel({ id: 'x', name: 'x', tris }, canvas, 0);
        const fast = ledPanelRect(tris, canvas);
        expect(fast === null).toBe(full === null);
        if (full && fast) {
          expect(fast.rect).toEqual(full.rect);
          expect(fast.u).toEqual(full.u);
          expect(fast.v).toEqual(full.v);
        }
      }
    }
  }, 60_000);

  it('公分單位的模型（自動 ×0.01）和太小的模型（自動 ×100）也一樣', async () => {
    for (const [scale, factor] of [[100, 0.01], [0.01, 100]] as const) {
      const glb = await fixtureGlb(scale);
      const r = await compressGlb(glb, io);
      expect(r.status).toBe('compressed');
      await assertSameModel(glb, r.output!, io);
      const g = await parseModel(toArrayBuffer(r.output!));
      expect(computeScaleFactor(new THREE.Box3().setFromObject(g.scene).getSize(new THREE.Vector3()).length())).toBe(factor);
    }
  }, 120_000);
});

describe('比對真的抓得到問題（故意改壞壓縮檔）', () => {
  async function expectBothFail(bad: Uint8Array) {
    const r = await compareModels(original, bad, io);
    expect(r.doc.ok).toBe(false);
    expect(r.scene.ok).toBe(false);
    return r;
  }

  it('節點位置動了 0.001 → 兩關都不過', async () => {
    const bad = patchGlbJson(compressed, (j) => {
      const n = (j.nodes as { name: string; translation?: number[] }[]).find(x => x.name === 'MECH_01_升降台')!;
      n.translation = [n.translation![0] + 0.001, n.translation![1], n.translation![2]];
    });
    const r = await expectBothFail(bad);
    expect(r.doc.issues.join()).toContain('MECH_01_升降台');
  });

  it('節點改名 → 兩關都不過', async () => {
    await expectBothFail(patchGlbJson(compressed, (j) => {
      (j.nodes as { name: string }[]).find(x => x.name === 'LED_01_主牆')!.name = 'LED_01_主墻';
    }));
  });

  it('貼圖重複方式從 Repeat 改成 Clamp → 兩關都不過', async () => {
    const r = await expectBothFail(patchGlbJson(compressed, (j) => {
      for (const s of (j.samplers as { wrapS?: number; wrapT?: number }[])) { s.wrapS = 33071; s.wrapT = 33071; }
    }));
    expect(r.scene.issues.join()).toContain('貼圖格');
  });

  it('UV 精度太低（8 bits）→ 第一關不過、LED 對位圖也對不起來', async () => {
    const doc = await io.readBinary(original);
    doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
      ...DRACO_ENCODER_OPTIONS,
      quantizationBits: { ...DRACO_ENCODER_OPTIONS.quantizationBits, TEX_COORD: 8 },
    });
    const lossy = await io.writeBinary(doc);
    const r = await compareModels(original, lossy, io);
    expect(r.doc.ok).toBe(false);
    expect(r.doc.issues.join()).toMatch(/頂點/);
    expect(r.scene.issues.join()).toMatch(/LED/);
  }, 60_000);

  it('位置精度太低（10 bits）→ 第一關不過', async () => {
    const doc = await io.readBinary(original);
    doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
      ...DRACO_ENCODER_OPTIONS,
      quantizationBits: { ...DRACO_ENCODER_OPTIONS.quantizationBits, POSITION: 10 },
    });
    const r = await compareModels(original, await io.writeBinary(doc), io);
    expect(r.doc.ok).toBe(false);
  }, 60_000);

  it('一個三角形的面翻過來 → 第一關不過', async () => {
    const dec = await io.readBinary(compressed);
    for (const e of dec.getRoot().listExtensionsUsed()) if (e.extensionName === 'KHR_draco_mesh_compression') e.dispose();  // 寫成沒壓縮的
    const prim = dec.getRoot().listMeshes().find(m => m.getName() === 'LED_01_主牆')!.listPrimitives()[0];
    const idx = prim.getIndices()!;
    const arr = idx.getArray()!.slice();
    [arr[1], arr[2]] = [arr[2], arr[1]];
    idx.setArray(arr);
    const flipped = await io.readBinary(await io.writeBinary(dec));
    const report = verifyDocuments(await io.readBinary(original), flipped);
    expect(report.ok).toBe(false);
    expect(report.issues.join()).toContain('方向');
  }, 60_000);
});

describe('不用壓的情況', () => {
  it('已經用 Draco 壓過的（3ds Max 匯出的 stage.glb）→ 不壓，但網站讀得出來', async () => {
    const url = new URL('../../../../stage.glb', import.meta.url);
    if (!existsSync(url)) return;  // 沒有這個範例檔就跳過
    const glb = readFileSync(url);
    expect(precheckGlb(glb)).toBe('這個模型已經壓縮過了');
    const r = await compressGlb(glb, io);
    expect(r.status).toBe('skipped');
    const g = await parseModel(toArrayBuffer(glb));
    const names: string[] = [];
    g.scene.traverse(o => names.push(o.name));
    expect(names).toContain('LED_1_DOWN');
    expect(names).toContain('LED2_Stage');
  }, 120_000);

  it('壓過的再壓一次 → 不壓（已經壓縮過）', async () => {
    expect((await compressGlb(compressed, io)).status).toBe('skipped');
  });

  it('.gltf（文字檔）、用了不認得的擴充、有外部檔案 → 不壓', () => {
    const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }));
    expect(precheckGlb(gltf)).toMatch(/gltf/);
    const unknown = patchGlbJson(original, (j) => { j.extensionsUsed = [...((j.extensionsUsed as string[]) ?? []), 'VENDOR_magic']; });
    expect(precheckGlb(unknown)).toMatch(/VENDOR_magic/);
    const external = patchGlbJson(original, (j) => { (j.images as { uri?: string }[])[0].uri = 'led.png'; });
    expect(precheckGlb(external)).toMatch(/外面/);
    expect(precheckGlb(new Uint8Array(40))).toMatch(/讀不出/);
  });

  it('沒有三角形可以壓（只有線段）→ 不壓', async () => {
    const { doc } = buildStageFixture({ floorSegments: 2 });
    for (const m of doc.getRoot().listMeshes()) {
      for (const p of m.listPrimitives()) if (p.getMode() !== 1) p.dispose();
    }
    const r = await compressGlb(await io.writeBinary(doc), io);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/三角形/);
  });
});

describe('資料格式沒變', () => {
  it('每個頂點資料的型別（float / 正規化整數）跟原檔一樣', async () => {
    const a = await io.readBinary(original), b = await io.readBinary(compressed);
    const fmt = (acc: Accessor) => `${acc.getType()}:${acc.getComponentType()}:${acc.getNormalized()}`;
    const la = a.getRoot().listMeshes().flatMap(m => m.listPrimitives().flatMap(p => p.listSemantics().map(s => `${m.getName()}.${s}=${fmt(p.getAttribute(s)!)}`)));
    const lb = b.getRoot().listMeshes().flatMap(m => m.listPrimitives().flatMap(p => p.listSemantics().map(s => `${m.getName()}.${s}=${fmt(p.getAttribute(s)!)}`)));
    expect(lb).toEqual(la);
  });
});
