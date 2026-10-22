import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { configureLedMaterial, setLedTemplate, updateLedSurface, type LedSurfaceUniforms } from './ledSurface';
import { ensureOwnLedMaterials, isOwnLedMaterial } from './ledOwnMaterial';
import { captureOriginal } from './materialOverrides';
import { setObjectOpacity, endObjectFade } from './objectFade';
import {
  buildObjectUniforms, spanFromUv, type LedTemplatePlan, type Placement, type SrcSpan, type TemplateUniformData,
} from '../ledTemplate';

// 真模型的情況：一個 C4D 材質「LED」，三塊 LED 物件都用它；StageScene 是 fromModel.clone(true) 出每個物件（材質實例照樣共用）
function sharedMaterialScene(count = 3) {
  const shared = new THREE.MeshStandardMaterial({ name: 'LED', color: 0x2d3a4b, roughness: 0.42, metalness: 0.1 });
  const nodes = Array.from({ length: count }, (_, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shared);
    m.name = `LED_${i}`;
    return m;
  });
  // 跟 StageScene 建物件一樣：從模型的節點 clone(true)
  const objects = nodes.map(n => n.clone(true) as THREE.Mesh);
  return { shared, objects };
}

const tex = () => { const t = new THREE.Texture(); t.colorSpace = THREE.SRGBColorSpace; return t; };
const uniformsOf = (m: THREE.Material) => m.userData.ledSurface as LedSurfaceUniforms;
const matOf = (o: THREE.Mesh) => o.material as THREE.MeshStandardMaterial;

// 三塊螢幕各自在整張 LED 畫布上的一格；版型把它們排到版型畫布的另外三個位置
const IDS = ['a', 'b', 'c'];
const SRC: Record<string, [number, number, number, number]> = { a: [0, 0, 0.5, 0.5], b: [0.5, 0, 1, 0.5], c: [0, 0.5, 0.5, 1] };
const DEST: Record<string, { x: number; y: number; w: number; h: number }> = {
  a: { x: 100, y: 50, w: 100, h: 50 }, b: { x: 0, y: 50, w: 100, h: 50 }, c: { x: 100, y: 0, w: 100, h: 50 },
};
const plc = (id: string): Placement => ({ key: `s:${id}`, objectId: id, uv: SRC[id], dest: DEST[id], rotate: 0, flipH: false, flipV: false });
const plan: LedTemplatePlan = { v: 1, id: 't', name: 'T', canvas: { width: 200, height: 100 }, scalePct: 100, screens: IDS.map(plc) };
const srcFor = (p: Placement): SrcSpan | null => (p.uv ? spanFromUv(p.uv) : null);
const dataOf = (id: string): TemplateUniformData => buildObjectUniforms(plan, id, srcFor);

/** StageScene 同步材質那個 effect 對每個 LED 物件做的事（現場模式、有版型）：先確保自己的材質，再設 LED 材質和版型 */
function applyLikeStageScene(objects: THREE.Mesh[], texture: THREE.Texture, brightness: (i: number) => number = () => 1) {
  objects.forEach((o, i) => {
    ensureOwnLedMaterials(o);
    o.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!(c as THREE.Mesh).isMesh || !m) return;
      captureOriginal(m);
      configureLedMaterial(m, { mode: 'live', texture, tint: new THREE.Color(1, 1, 1), brightness: brightness(i) });
      setLedTemplate(m, dataOf(IDS[i]));
    });
  });
}

describe('原因：模型裡的 LED 共用同一個材質', () => {
  it('fromModel.clone(true) 出來的物件，材質是同一個實例（三塊 LED 共用「LED」）', () => {
    const { shared, objects } = sharedMaterialScene();
    for (const o of objects) expect(o.material).toBe(shared);
  });

  it('不分開的話：每塊 LED 的版型都寫進同一組 uniforms，只剩最後一塊的放法（其他塊的 UV 落在範圍外 = 黑的）', () => {
    const { shared, objects } = sharedMaterialScene();
    const texture = tex();
    objects.forEach((_o, i) => {
      configureLedMaterial(shared, { mode: 'live', texture });
      setLedTemplate(shared, dataOf(IDS[i]));
    });
    const u = uniformsOf(shared);
    expect(Array.from(u.uLedTplSrc.value.slice(0, 4))).toEqual([0, 0.5, 0.5, 0.5]); // 只有最後一塊（c）的範圍
  });
});

describe('ensureOwnLedMaterials：每個 LED 物件各自一份材質，版型各用各的', () => {
  it('三塊共用同一個材質的 LED，版型放好後各自留著自己的放法', () => {
    const { objects } = sharedMaterialScene();
    applyLikeStageScene(objects, tex());
    const mats = objects.map(matOf);
    expect(new Set(mats).size).toBe(3);
    mats.forEach((m, i) => {
      const u = uniformsOf(m);
      const d = dataOf(IDS[i]);
      expect(u.uLedTplOn.value).toBe(1);
      expect(u.uLedTplCount.value).toBe(1);
      expect(Array.from(u.uLedTplSrc.value.slice(0, 4))).toEqual(d.src.slice(0, 4).map(Math.fround));
      expect(Array.from(u.uLedTplDst.value.slice(0, 4))).toEqual(d.dst.slice(0, 4).map(Math.fround));
    });
    // 三塊的範圍真的不一樣
    const srcs = mats.map(m => Array.from(uniformsOf(m).uLedTplSrc.value.slice(0, 4)).join(','));
    expect(new Set(srcs).size).toBe(3);
    // uniforms 是各自的（不是同一個物件）
    expect(new Set(mats.map(m => uniformsOf(m))).size).toBe(3);
  });

  it('其他每個物件的設定也各自：亮度', () => {
    const { objects } = sharedMaterialScene();
    applyLikeStageScene(objects, tex(), i => [1, 0.5, 0.2][i]);
    expect(objects.map(o => matOf(o).emissiveIntensity)).toEqual([1, 0.5, 0.2]);
  });

  it('一個版型只放兩塊：沒放的那塊還是「開著、0 塊」（整塊黑），不會借到別人的放法', () => {
    const { objects } = sharedMaterialScene();
    const only: LedTemplatePlan = { ...plan, screens: [plc('a'), plc('b')] };
    objects.forEach((o, i) => {
      ensureOwnLedMaterials(o);
      configureLedMaterial(matOf(o), { mode: 'live', texture: tex() });
      setLedTemplate(matOf(o), buildObjectUniforms(only, IDS[i], srcFor));
    });
    expect(objects.map(o => uniformsOf(matOf(o)).uLedTplCount.value)).toEqual([1, 1, 0]);
    expect(uniformsOf(matOf(objects[2])).uLedTplOn.value).toBe(1);
  });

  it('沒有版型（「全部」）：每個複本的 LED 設定跟共用時一樣，版型是關的', () => {
    const { shared, objects } = sharedMaterialScene(2);
    // 共用的做法（以前）
    const ref = shared.clone();
    configureLedMaterial(ref, { mode: 'live', texture: tex(), tint: new THREE.Color(1, 0.5, 0.25), brightness: 0.8 });
    for (const o of objects) {
      ensureOwnLedMaterials(o);
      configureLedMaterial(matOf(o), { mode: 'live', texture: tex(), tint: new THREE.Color(1, 0.5, 0.25), brightness: 0.8 });
      setLedTemplate(matOf(o), null);
    }
    for (const o of objects) {
      const m = matOf(o);
      expect(m.color.getHex()).toBe(ref.color.getHex());
      expect(m.roughness).toBe(ref.roughness);
      expect(m.metalness).toBe(ref.metalness);
      expect(m.envMapIntensity).toBe(ref.envMapIntensity);
      expect(m.emissive.getHex()).toBe(ref.emissive.getHex());
      expect(m.emissiveIntensity).toBe(ref.emissiveIntensity);
      expect(m.toneMapped).toBe(ref.toneMapped);
      expect(m.side).toBe(ref.side);
      expect(uniformsOf(m).uLedTplOn.value).toBe(0);
      expect(uniformsOf(m).uLedMode.value).toBe(uniformsOf(ref).uLedMode.value);
    }
  });

  it('重複呼叫（每次選取 / 換 cue 都會重跑）不會再複製：同一份複本', () => {
    const { objects } = sharedMaterialScene(2);
    ensureOwnLedMaterials(objects[0]);
    const first = matOf(objects[0]);
    expect(isOwnLedMaterial(first)).toBe(true);
    ensureOwnLedMaterials(objects[0]);
    expect(matOf(objects[0])).toBe(first);
  });

  it('同一個物件裡共用同一個材質的 mesh 共用一份複本（設定是整個物件的）；框架（名稱沒有 LED）不是螢幕，照用原本的材質', () => {
    const a = new THREE.MeshStandardMaterial({ name: 'LED' });
    const b = new THREE.MeshStandardMaterial({ name: 'Frame' });
    const group = new THREE.Group();
    const m1 = new THREE.Mesh(new THREE.BufferGeometry(), a), m2 = new THREE.Mesh(new THREE.BufferGeometry(), a), m3 = new THREE.Mesh(new THREE.BufferGeometry(), b);
    group.add(m1, m2, m3);
    ensureOwnLedMaterials(group);
    expect(m1.material).toBe(m2.material);
    expect(m1.material).not.toBe(a);
    expect(m3.material).toBe(b);
    expect((m1.material as THREE.Material).name).toBe('LED');
  });

  it('材質名稱都沒有 LED 的舊物件（例如「Screen」）：跟以前一樣全部都是螢幕，不同材質各一份', () => {
    const a = new THREE.MeshStandardMaterial({ name: 'Screen' });
    const b = new THREE.MeshStandardMaterial({ name: 'Screen2' });
    const group = new THREE.Group();
    const m1 = new THREE.Mesh(new THREE.BufferGeometry(), a), m2 = new THREE.Mesh(new THREE.BufferGeometry(), a), m3 = new THREE.Mesh(new THREE.BufferGeometry(), b);
    group.add(m1, m2, m3);
    ensureOwnLedMaterials(group);
    expect(m1.material).toBe(m2.material);
    expect(m1.material).not.toBe(a);
    expect(m3.material).not.toBe(b);
    expect(m3.material).not.toBe(m1.material);
    expect((m3.material as THREE.Material).name).toBe('Screen2');
  });

  it('複本留著名字和 C4D 原值（材質面板依名稱的覆寫、「回到原本」照常）；來源材質一個字都沒動', () => {
    const { shared, objects } = sharedMaterialScene(2);
    // 來源是剛從模型來的樣子（還沒有記過原值）
    expect(shared.userData.original).toBeUndefined();
    applyLikeStageScene(objects, tex());
    for (const o of objects) {
      const m = matOf(o);
      expect(m.name).toBe('LED');
      const orig = captureOriginal(m);
      expect(orig).toEqual({ color: '2d3a4b', roughness: 0.42, metalness: 0.1, envIntensity: 1, opacity: 1, transparent: false });
    }
    // 共用的來源：沒有 LED 的東西、顏色還是 C4D 的
    expect(shared.userData.ledSurface).toBeUndefined();
    expect(shared.color.getHex()).toBe(0x2d3a4b);
    expect(shared.emissiveMap).toBeNull();
    expect(shared.toneMapped).toBe(true);
    expect(shared.onBeforeCompile.toString()).toBe(new THREE.MeshStandardMaterial().onBeforeCompile.toString());
  });

  it('來源已經被 LED 設過（有 ledSurface）：複本不帶 JSON 壞掉的 ledSurface，configure 後有自己全新的 uniforms', () => {
    const { shared, objects } = sharedMaterialScene(2);
    configureLedMaterial(shared, { mode: 'live', texture: tex() });
    const sourceUniforms = uniformsOf(shared);
    ensureOwnLedMaterials(objects[0]);
    const own = matOf(objects[0]);
    expect(own.userData.ledSurface).toBeUndefined();
    configureLedMaterial(own, { mode: 'live', texture: tex() });
    expect(uniformsOf(own)).not.toBe(sourceUniforms);
    expect(uniformsOf(own).uLedTexels.value).toBeInstanceOf(THREE.Vector2);
    expect(uniformsOf(own).uLedTplSrc.value).toBeInstanceOf(Float32Array);
  });

  it('shader 程式共用：複本的 cache key 一樣（只看貼圖種類），uniforms 各自接到自己的', () => {
    const { objects } = sharedMaterialScene(3);
    applyLikeStageScene(objects, tex());
    const mats = objects.map(matOf);
    expect(new Set(mats.map(m => m.customProgramCacheKey())).size).toBe(1);
    expect(mats[0].customProgramCacheKey()).toBe('led-surface-v2');
    const shaders = mats.map(m => {
      const s = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: '#include <emissivemap_fragment>\n#include <opaque_fragment>' };
      m.onBeforeCompile(s as never, {} as THREE.WebGLRenderer);
      return s;
    });
    shaders.forEach((s, i) => {
      expect(s.uniforms.uLedTplSrc).toBe(uniformsOf(mats[i]).uLedTplSrc);
      expect(s.fragmentShader).toBe(shaders[0].fragmentShader);
    });
  });

  it('改一塊的版型 / 亮度 / 模式不會動到別塊（updateLedSurface、setLedTemplate 都是各自的）', () => {
    const { objects } = sharedMaterialScene(2);
    applyLikeStageScene(objects, tex());
    updateLedSurface(matOf(objects[0]), { on: true, texels: [1920, 1080], mode: 'quick' });
    setLedTemplate(matOf(objects[1]), null);
    expect(uniformsOf(matOf(objects[1])).uLedOn.value).toBe(0);
    expect(uniformsOf(matOf(objects[1])).uLedMode.value).toBe(2);
    expect(uniformsOf(matOf(objects[0])).uLedTplOn.value).toBe(1);
  });

  it('淡入淡出的半透明複本接到這塊自己的 uniforms（淡的時候還是各自的放法）', () => {
    const { objects } = sharedMaterialScene(2);
    applyLikeStageScene(objects, tex());
    setObjectOpacity(objects[0], 0.5);
    setObjectOpacity(objects[1], 0.5);
    for (let i = 0; i < 2; i++) {
      const fadeCopy = objects[i].material as THREE.MeshStandardMaterial;
      expect(fadeCopy.transparent).toBe(true);
      expect(fadeCopy.userData.ledSurface).toBe(uniformsOf(fadeCopy));
      expect(Array.from(uniformsOf(fadeCopy).uLedTplSrc.value.slice(0, 4))).toEqual(dataOf(IDS[i]).src.slice(0, 4).map(Math.fround));
    }
    expect(uniformsOf(objects[0].material as THREE.Material)).not.toBe(uniformsOf(objects[1].material as THREE.Material));
    // 淡完換回的是自己那份複本，不是共用的來源
    const own0 = (() => { endObjectFade(objects[0]); return matOf(objects[0]); })();
    expect(isOwnLedMaterial(own0)).toBe(true);
    endObjectFade(objects[1]);
  });

  it('不是標準材質 / 多重材質的 mesh 不碰', () => {
    const basic = new THREE.MeshBasicMaterial();
    const a = new THREE.Mesh(new THREE.BufferGeometry(), basic);
    const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    const b = new THREE.Mesh(new THREE.BufferGeometry(), mats);
    const g = new THREE.Group();
    g.add(a, b);
    ensureOwnLedMaterials(g);
    expect(a.material).toBe(basic);
    expect(b.material).toBe(mats);
  });
});
