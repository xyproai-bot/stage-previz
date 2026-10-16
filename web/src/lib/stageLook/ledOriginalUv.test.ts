// 舊影片用模型存的原本 UV（uv1）取色：選用規則（純函式）、shader 的程式碼和算法、每個物件自己的材質各自開關、版型快照多一個 originalUv 清單
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyLedSurface, configureLedMaterial, createLedSurfaceUniforms, patchLedShader, setLedOriginalUv, setLedTemplate } from './ledSurface';
import { materialsWithOriginalUv, planWantsOriginalUv } from './ledOriginalUv';
import { ensureOwnLedMaterials } from './ledOwnMaterial';
import { buildObjectUniforms, mapUvToTemplate, parsePlan, spanFromUv, type LedTemplatePlan, type Placement, type SrcSpan, type TemplateUniformData } from '../ledTemplate';

const FRAG = 'void main() {\n#include <emissivemap_fragment>\nvec3 outgoingLight = totalEmissiveRadiance;\n#include <opaque_fragment>\n}';
const VERT = 'void main() {\n#include <uv_pars_vertex>\n#include <uv_vertex>\n#include <begin_vertex>\n}';
const newShader = () => ({ uniforms: {} as Record<string, { value: unknown }>, fragmentShader: FRAG, vertexShader: VERT });

const plc = (over: Partial<Placement> = {}): Placement => ({
  key: 'o:a', objectId: 'a', uv: null, dest: { x: 30, y: 10, w: 80, h: 40 }, rotate: 0, flipH: false, flipV: false, ...over,
});
const plan = (extra: Partial<LedTemplatePlan> = {}): LedTemplatePlan => ({ v: 1, id: 't', name: '舊版面', canvas: { width: 200, height: 100 }, scalePct: 100, screens: [plc()], ...extra });

/** ledSurface.ts 的 LED_EMISSIVE_MAP 取色那幾行逐行翻成 JS：uLedUvSet = 1 用 uv1，否則原本的路（版型或原 UV） */
function glslPort(args: { uvSet: number; tplOn: boolean; tpl: TemplateUniformData; uv: [number, number]; uv1: [number, number] }): { uv: [number, number]; covered: boolean } {
  if (args.uvSet > 0.5) return { uv: args.uv1, covered: true };
  if (!args.tplOn) return { uv: args.uv, covered: true };
  const u = args.tpl;
  for (let i = 0; i < u.count; i++) {
    const s = u.src.slice(i * 4, i * 4 + 4);
    let dx = args.uv[0] - s[0], dy = args.uv[1] - s[1];
    dx -= Math.floor(dx + 1e-5); dy -= Math.floor(dy + 1e-5);
    if (dx <= s[2] + 1e-5 && dy <= s[3] + 1e-5) return { uv: [dx / s[2], dy / s[3]], covered: true };
  }
  return { uv: args.uv, covered: false };
}

describe('選用規則：快照列了這個物件才用', () => {
  it('planWantsOriginalUv：originalUv 有列才 true；沒有 / 沒快照 = false（舊的後台、一般版型都不受影響）', () => {
    expect(planWantsOriginalUv(plan({ originalUv: ['a', 'b'] }), 'a')).toBe(true);
    expect(planWantsOriginalUv(plan({ originalUv: ['a', 'b'] }), 'c')).toBe(false);
    expect(planWantsOriginalUv(plan(), 'a')).toBe(false);
    expect(planWantsOriginalUv(null, 'a')).toBe(false);
    expect(planWantsOriginalUv(undefined, 'a')).toBe(false);
  });

  it('parsePlan 讀得到 originalUv（壞的丟掉、重複的合併）；舊版前端不認識這個欄位，screens 照舊', () => {
    const raw = { ...plan(), originalUv: ['a', 'a', 'b', 7, '../x', 'ok_1'] };
    const p = parsePlan(raw)!;
    expect(p.originalUv).toEqual(['a', 'b', 'ok_1']);
    expect(p.screens).toHaveLength(1);
    expect(parsePlan(plan())!.originalUv).toBeUndefined();
    expect(parsePlan({ ...plan(), originalUv: 'a' })!.originalUv).toBeUndefined();
    expect(parsePlan(JSON.stringify(raw))!.originalUv).toEqual(['a', 'b', 'ok_1']);
  });

  it('materialsWithOriginalUv：用到這個材質的每一個 mesh 都有 uv1 才算；外框（另一個材質、沒有 uv1）不拖累螢幕', () => {
    const geo = (withUv1: boolean) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
      if (withUv1) g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(6), 2));
      return g;
    };
    const led = new THREE.MeshStandardMaterial({ name: 'LED' }), frame = new THREE.MeshStandardMaterial({ name: 'frame' });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geo(true), led), new THREE.Mesh(geo(true), led), new THREE.Mesh(geo(false), frame));
    const ok = materialsWithOriginalUv(root);
    expect(ok.has(led)).toBe(true);
    expect(ok.has(frame)).toBe(false);
    // 同一個材質有一個 mesh 沒有 uv1 → 整個材質退回
    const mixed = new THREE.Group();
    mixed.add(new THREE.Mesh(geo(true), led), new THREE.Mesh(geo(false), led));
    expect(materialsWithOriginalUv(mixed).has(led)).toBe(false);
    expect(materialsWithOriginalUv(new THREE.Group()).size).toBe(0);
  });
});

describe('shader：uv1 只換「去貼圖哪裡取色」，其他一個位元都不變', () => {
  it('頂點：宣告 uv1（three 沒宣告才宣告）、過同一個貼圖變換送出 vLedUv1；fragment 收 vLedUv1', () => {
    const sh = newShader();
    patchLedShader(sh, createLedSurfaceUniforms());
    const vs = sh.vertexShader!;
    expect(vs).toContain('varying vec2 vLedUv1;');
    expect(vs).toContain('#ifndef USE_UV1\nattribute vec2 uv1;\n#endif');
    expect(vs).toContain('vLedUv1 = ( emissiveMapTransform * vec3( uv1, 1 ) ).xy;');
    expect(vs.indexOf('#include <uv_pars_vertex>')).toBeLessThan(vs.indexOf('varying vec2 vLedUv1;'));
    expect(vs.indexOf('#include <uv_vertex>')).toBeLessThan(vs.indexOf('vLedUv1 = '));
    // 宣告只出現一次、都在 USE_EMISSIVEMAP 裡
    expect(vs.split('attribute vec2 uv1;').length).toBe(2);
    expect(sh.fragmentShader).toContain('varying vec2 vLedUv1;');
    expect(sh.fragmentShader).toContain('uniform float uLedUvSet;');
    expect(sh.uniforms.uLedUvSet).toBeDefined();
  });

  it('fragment：uLedUvSet 的判斷在版型之前；沒開時走原本的路（版型的判斷、讀貼圖、像素格都沒動）', () => {
    const sh = newShader();
    patchLedShader(sh, createLedSurfaceUniforms());
    const fs = sh.fragmentShader;
    const init = fs.indexOf('vec2 ledSampleUv = vEmissiveMapUv;');
    const orig = fs.indexOf('if ( uLedUvSet > 0.5 ) {');
    const set = fs.indexOf('ledSampleUv = vLedUv1;');
    const tpl = fs.indexOf('} else if ( uLedTplOn > 0.5 ) {');
    const fetch = fs.indexOf('texture2D( emissiveMap, ledSampleUv )');
    expect(init).toBeGreaterThan(-1);
    expect(orig).toBeGreaterThan(init);
    expect(set).toBeGreaterThan(orig);
    expect(tpl).toBeGreaterThan(set);
    expect(fetch).toBeGreaterThan(tpl);
    // 像素格還是用現在的 UV（真實點數），不碰 uv1
    expect(fs).toContain('vec2 ledTexel = vEmissiveMapUv * uLedTexels;');
    expect(fs.slice(fs.indexOf('ledTexel')).includes('vLedUv1')).toBe(false);
    // 取色以後的顏色處理（影片 sRGB 轉換、AE 曲線、乘上亮度）沒有任何跟 uv1 有關的分支
    const colour = fs.slice(fetch);
    expect(colour.includes('uLedUvSet')).toBe(false);
  });

  it('沒有 vertexShader 的舊用法（測試、其他呼叫）照舊可以用', () => {
    const sh: { uniforms: Record<string, { value: unknown }>; fragmentShader: string; vertexShader?: string } = { uniforms: {}, fragmentShader: FRAG };
    patchLedShader(sh, createLedSurfaceUniforms());
    expect(sh.fragmentShader).toContain('vLedUv1');
    expect((sh as { vertexShader?: string }).vertexShader).toBeUndefined();
  });

  it('預設關掉；setLedOriginalUv 開關；不是 LED 材質什麼都不做', () => {
    expect(createLedSurfaceUniforms().uLedUvSet.value).toBe(0);
    const m = new THREE.MeshStandardMaterial();
    applyLedSurface(m);
    expect(m.userData.ledSurface.uLedUvSet.value).toBe(0);
    setLedOriginalUv(m, true);
    expect(m.userData.ledSurface.uLedUvSet.value).toBe(1);
    setLedOriginalUv(m, false);
    expect(m.userData.ledSurface.uLedUvSet.value).toBe(0);
    expect(() => setLedOriginalUv(new THREE.MeshStandardMaterial(), true)).not.toThrow();
  });

  it('取色的算法：開了 = 一定是 uv1（連版型沒蓋到的位置也是）；沒開 = 跟原本的版型 / 原 UV 一樣', () => {
    const p = plan();
    const data = buildObjectUniforms(p, 'a', (_: Placement): SrcSpan | null => spanFromUv([0.1, 0.2, 0.6, 0.9]));
    for (const [uv, uv1] of [[[0.3, 0.5], [0.97, 0.01]], [[0.9, 0.95], [1.04, 0.5]], [[0.12, 0.25], [0.5, 0.5]]] as [number, number][][]) {
      const on = glslPort({ uvSet: 1, tplOn: true, tpl: data, uv: uv as [number, number], uv1: uv1 as [number, number] });
      expect(on.uv).toEqual(uv1);
      expect(on.covered).toBe(true);
      const off = glslPort({ uvSet: 0, tplOn: true, tpl: data, uv: uv as [number, number], uv1: uv1 as [number, number] });
      const js = mapUvToTemplate(p.screens[0], spanFromUv([0.1, 0.2, 0.6, 0.9]), p.canvas, uv[0], uv[1]);
      expect(off.covered).toBe(js !== null);
      const none = glslPort({ uvSet: 0, tplOn: false, tpl: data, uv: uv as [number, number], uv1: uv1 as [number, number] });
      expect(none.uv).toEqual(uv);
    }
  });
});

describe('每個 LED 物件自己的材質各自開關（跟版型一樣不能互相蓋掉）', () => {
  it('一個物件用 uv1、旁邊的物件照舊用版型；configureLedMaterial 不會把開關關掉', () => {
    const shared = new THREE.MeshStandardMaterial({ name: 'LED' });
    const objs = ['a', 'b'].map(id => { const g = new THREE.BufferGeometry(); const m = new THREE.Mesh(g, shared); m.name = id; return m; });
    const tex = new THREE.Texture();
    objs.forEach((o, i) => {
      ensureOwnLedMaterials(o);
      const m = o.material as THREE.MeshStandardMaterial;
      configureLedMaterial(m, { mode: 'live', texture: tex });
      setLedTemplate(m, buildObjectUniforms(plan({ screens: [plc({ key: 'o:' + o.name, objectId: o.name })] }), o.name, () => null));
      setLedOriginalUv(m, i === 0);
    });
    const u = (o: THREE.Mesh) => (o.material as THREE.MeshStandardMaterial).userData.ledSurface;
    expect(u(objs[0]).uLedUvSet.value).toBe(1);
    expect(u(objs[1]).uLedUvSet.value).toBe(0);
    configureLedMaterial(objs[0].material as THREE.MeshStandardMaterial, { mode: 'quick', texture: tex });
    expect(u(objs[0]).uLedUvSet.value).toBe(1);
    expect(shared.userData.ledSurface).toBeUndefined();   // 模型裡共用的來源材質完全不動
  });
});
