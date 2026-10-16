// 自動貼 UV 的整合測試用模型（程式產生，gltf-transform；node 和瀏覽器都能跑）
//   LED_A_主牆   12×4 m 的牆，硬邊（左右兩半的接縫頂點是複製的），舊 UV 正的
//   LED_B_左側 / LED_C_右側  兩個節點共用同一個形狀（instance）；PROP_X 也共用這個形狀（沒被處理，要原封不動）
//   LED_D_地屏   躺在地上，舊 UV 轉了 90 度
//   LED_E_小半圓  180 度弧面（第 1 階段保留原本的 UV）
//   LED_F_鏡像   X 縮放 -1 的節點
//   LED_G_雙翼   同一個 primitive 裡兩片分開的牆
//   LED_H_沒選   平面，但測試裡不勾（保留）
//   LED_I_框     平面 LED + 外框（另一個 primitive，不是 LED 材質）
//   MECH_01      一般物件

import { Document, type Accessor, type Buffer as GBuffer, type Primitive } from '@gltf-transform/core';
import { arcPrim, gridPrim, mergePrims } from './testing';
import type { PrimGeom } from './surfaces';
import type { Vec3 } from './geometry';

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];

/** 把舊 UV 搬到畫布上某個位置（u0, v0 是左上，du, dv 是範圍） */
function oldUv(p: PrimGeom, u0: number, v0: number, du: number, dv: number): PrimGeom {
  const uv = Float64Array.from(p.uv!);
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] = u0 + uv[i] * du;
    uv[i + 1] = v0 + uv[i + 1] * dv;
  }
  return { ...p, uv };
}

export interface UvFixtureObject { id: string; meshName: string; display: string }

export interface UvFixture {
  doc: Document;
  objects: UvFixtureObject[];
}

export const FIXTURE_OLD_CANVAS = { width: 8800, height: 2024 };

export function buildUvFixture(): UvFixture {
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'stage-previz uv fixture';
  const buffer = doc.createBuffer();
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3', arr: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>): Accessor =>
    doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer as GBuffer);
  const toPrim = (g: PrimGeom, withNormal = true): Primitive => {
    const p = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos)))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(g.uv!)))
      .setIndices(acc('SCALAR', new Uint32Array(g.index)));
    if (withNormal) {
      const n = new Float32Array(g.pos.length);
      for (let i = 0; i < n.length; i += 3) n[i + 2] = 1;
      p.setAttribute('NORMAL', acc('VEC3', n));
    }
    return p;
  };
  const led = doc.createMaterial('LED_Screen').setEmissiveFactor([1, 1, 1]);
  const metal = doc.createMaterial('Truss_Metal').setBaseColorFactor([0.5, 0.5, 0.55, 1]);
  const scene = doc.createScene('Scene');
  const wrapper = doc.createNode('舞台').setTranslation([0.5, 0, -1]).setExtras({ c4d: 'wrapper' });
  scene.addChild(wrapper);
  const meshNode = (name: string, meshName: string, prims: Primitive[]) => {
    const mesh = doc.createMesh(meshName);
    prims.forEach(p => mesh.addPrimitive(p));
    return doc.createNode(name).setMesh(mesh);
  };

  // A：兩半各自一個格子（接縫頂點複製），一個 primitive
  const half1 = oldUv(gridPrim([-6, 1, -6], X, Y, 6, 4, 3), 0.05, 0.1, 0.1, 0.4);
  const half2 = oldUv(gridPrim([0, 1, -6], X, Y, 6, 4, 3), 0.15, 0.1, 0.1, 0.4);
  wrapper.addChild(meshNode('LED_A_主牆', 'LED_A_主牆', [toPrim(mergePrims([half1, half2])).setMaterial(led)]));

  // B / C：共用同一個 mesh（3×3），一個在左、一個在右；PROP_X 也共用
  const sharedMesh = doc.createMesh('側屏').addPrimitive(toPrim(oldUv(gridPrim([-1.5, 0, 0], X, Y, 3, 3, 3), 0.4, 0.2, 0.05, 0.3)).setMaterial(led));
  wrapper.addChild(doc.createNode('LED_B_左側').setMesh(sharedMesh).setTranslation([-10, 2, -5]));
  wrapper.addChild(doc.createNode('LED_C_右側').setMesh(sharedMesh).setTranslation([10, 3, -5]));
  wrapper.addChild(doc.createNode('PROP_X_備用').setMesh(sharedMesh).setTranslation([0, 6, -5]));

  // D：地屏（躺平），舊 UV 轉了 90 度（畫面的左邊朝舞台後方）
  const floor = oldUv(gridPrim([-3, 0, -2], Z, X, 4, 6, 3, { oldUv: (s, t) => [1 - s, t] }), 0.55, 0.5, 0.1, 0.3);
  wrapper.addChild(meshNode('LED_D_地屏', 'LED_D_地屏', [toPrim(floor).setMaterial(led)]).setTranslation([0, 0.01, 2]));

  // E：弧面
  wrapper.addChild(meshNode('LED_E_小半圓', 'LED_E_小半圓', [toPrim(oldUv(arcPrim(4, 180, 3, 24), 0.7, 0.55, 0.2, 0.35)).setMaterial(led)]).setTranslation([0, 0, 4]));

  // F：鏡像節點（scale x = -1）
  const quad = oldUv(gridPrim([-1.5, 0, 0], X, Y, 3, 2, 2), 0.8, 0.1, 0.06, 0.2);
  wrapper.addChild(meshNode('LED_F_鏡像', 'LED_F_鏡像', [toPrim(quad).setMaterial(led)]).setTranslation([14, 1, -4]).setScale([-1, 1, 1]));

  // G：同一個 primitive 兩片分開的牆
  const wingL = oldUv(gridPrim([-20, 1, -4], X, Y, 4, 3, 2), 0.2, 0.7, 0.04, 0.2);
  const wingR = oldUv(gridPrim([16, 1, -4], X, Y, 4, 3, 2), 0.3, 0.7, 0.04, 0.2);
  wrapper.addChild(meshNode('LED_G_雙翼', 'LED_G_雙翼', [toPrim(mergePrims([wingL, wingR])).setMaterial(led)]));

  // H：平面但不勾
  wrapper.addChild(meshNode('LED_H_沒選', 'LED_H_沒選', [toPrim(oldUv(gridPrim([-2, 6, -7], X, Y, 4, 2, 2), 0.6, 0.05, 0.08, 0.1)).setMaterial(led)]));

  // I：LED + 外框
  const ledI = oldUv(gridPrim([2, 7, -7], X, Y, 4, 2, 2), 0.85, 0.5, 0.08, 0.1);
  const frameI = oldUv(gridPrim([1.8, 6.8, -7.05], X, Y, 4.4, 2.4, 2, { screen: false }), 0.1, 0.9, 0.5, 0.05);
  wrapper.addChild(meshNode('LED_I_框', 'LED_I_框', [toPrim(ledI).setMaterial(led), toPrim(frameI).setMaterial(metal)]));

  // 一般物件
  wrapper.addChild(meshNode('MECH_01_升降台', 'MECH_01_升降台', [toPrim(oldUv(gridPrim([-1, 0, 0], X, Z, 2, 2, 1), 0, 0, 1, 1)).setMaterial(metal)]).setTranslation([0, 0, 2]));

  const names = ['LED_A_主牆', 'LED_B_左側', 'LED_C_右側', 'LED_D_地屏', 'LED_E_小半圓', 'LED_F_鏡像', 'LED_G_雙翼', 'LED_H_沒選', 'LED_I_框'];
  const objects = names.map((n, i) => ({ id: `so_${i}`, meshName: n, display: n.replace(/^LED_[A-Z]_/, '') }));
  return { doc, objects };
}
