import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { isLedMaterialName, ledScreenMeshes, screenFlags } from './ledScreen';
import { collectUvTriangles } from './ledMapScene';
import { stageFrontDirection } from './stageCamera';
import { ensureOwnLedMaterials } from './stageLook/ledOwnMaterial';
import { materialsWithOriginalUv } from './stageLook/ledOriginalUv';
import { buildLedEmitters } from './stageLook/ledEmitters';

/** 一片 w×h 的平面（朝 +Z），可以指定位置和朝向、UV 範圍 */
function plane(name: string, matName: string, opts: { x?: number; z?: number; faceBack?: boolean; uv?: [number, number, number, number]; uv1?: boolean } = {}): THREE.Mesh {
  const g = new THREE.PlaneGeometry(2, 1);
  const [u0, v0, u1, v1] = opts.uv ?? [0, 0, 1, 1];
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  if (opts.uv1) g.setAttribute('uv1', uv.clone());
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ name: matName }));
  m.name = name;
  m.position.set(opts.x ?? 0, 0, opts.z ?? 0);
  if (opts.faceBack) m.rotation.y = Math.PI;
  return m;
}

describe('screenFlags（純函式）', () => {
  it('混合物件：只有材質名稱含 LED 的是螢幕（不分大小寫）', () => {
    expect(screenFlags([['LED_Screen'], ['螢幕框架_黑'], ['升降台_側面'], ['my_led_face']])).toEqual([true, false, false, true]);
  });
  it('全部都是 LED 材質 → 全部都是螢幕', () => {
    expect(screenFlags([['LED_Screen'], ['LED_2']])).toEqual([true, true]);
  });
  it('一個 LED 名稱都沒有（舊模型的「Screen」）→ 照舊全部都是螢幕', () => {
    expect(screenFlags([['Screen'], ['Frame'], [null], [undefined]])).toEqual([true, true, true, true]);
  });
  it('一個 mesh 有好幾個材質：其中一個含 LED 就算螢幕', () => {
    expect(screenFlags([['Frame', 'LED_face'], ['Frame']])).toEqual([true, false]);
  });
  it('isLedMaterialName', () => {
    expect(isLedMaterialName('led')).toBe(true);
    expect(isLedMaterialName('PGM_Led_Main')).toBe(true);
    expect(isLedMaterialName('Screen')).toBe(false);
    expect(isLedMaterialName(undefined)).toBe(false);
  });
});

describe('LED 物件裡的框架、台體不算螢幕（three 場景）', () => {
  function mixed() {
    const root = new THREE.Group();
    root.add(plane('face', 'LED_Screen', { uv: [0.5, 0.5, 0.75, 0.75], uv1: true }));
    root.add(plane('frame', '螢幕框架_黑', { z: -0.2, faceBack: true, uv: [0, 0, 1, 1] }));
    return root;
  }
  function screenOnly(mat: string) {
    const root = new THREE.Group();
    root.add(plane('a', mat, { x: -1, uv: [0, 0, 0.5, 1] }));
    root.add(plane('b', mat, { x: 1, uv: [0.5, 0, 1, 1] }));
    return root;
  }

  it('ledScreenMeshes：混合 → 只有 LED 那片；全部 LED → 全部；沒有 LED 名稱 → 全部', () => {
    expect([...ledScreenMeshes(mixed())].map(m => m.name)).toEqual(['face']);
    expect([...ledScreenMeshes(screenOnly('LED_Screen'))].map(m => m.name)).toEqual(['a', 'b']);
    expect([...ledScreenMeshes(screenOnly('Screen'))].map(m => m.name)).toEqual(['a', 'b']);
  });

  it('對位圖的 UV 三角形：混合物件只拿螢幕那片（框架的 UV 不算）', () => {
    const tris = collectUvTriangles(mixed());
    expect(tris.length).toBe(2 * 6);
    for (let i = 0; i < tris.length; i++) expect(tris[i]).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(collectUvTriangles(screenOnly('Screen')).length).toBe(4 * 6);
  });

  it('舞台正面方向：背面朝後的框架不會把方向拉反', () => {
    const root = mixed();
    // 框架比螢幕大很多、朝後：以前會被算進去，正面變成 -Z
    (root.children[1] as THREE.Mesh).scale.set(4, 4, 1);
    const f = stageFrontDirection([root]);
    expect(f.z).toBeCloseTo(1, 6);
  });

  it('LED 物件各自一份材質：只複製螢幕的材質，框架照用原本的材質', () => {
    const root = mixed();
    const frameMat = (root.children[1] as THREE.Mesh).material;
    const faceMat = (root.children[0] as THREE.Mesh).material;
    ensureOwnLedMaterials(root);
    expect((root.children[1] as THREE.Mesh).material).toBe(frameMat);
    expect((root.children[0] as THREE.Mesh).material).not.toBe(faceMat);
    expect(((root.children[0] as THREE.Mesh).material as THREE.Material).name).toBe('LED_Screen');
    // 沒有 LED 名稱的舊物件：跟以前一樣每個 mesh 都換成複本
    const old = screenOnly('Screen');
    const before = old.children.map(c => (c as THREE.Mesh).material);
    ensureOwnLedMaterials(old);
    old.children.forEach((c, i) => expect((c as THREE.Mesh).material).not.toBe(before[i]));
  });

  it('原本 UV（uv1）的材質只看螢幕', () => {
    const root = mixed();
    const set = materialsWithOriginalUv(root);
    expect([...set].map(m => m.name)).toEqual(['LED_Screen']);
  });

  it('現場模式的 LED 照明只從螢幕發光（框架不發光）', () => {
    const root = mixed();
    (root.children[1] as THREE.Mesh).scale.set(4, 4, 1);
    const em = buildLedEmitters(root);
    expect(em.length).toBe(1);
    expect(em[0].normal.z).toBeCloseTo(1, 6);
  });
});
