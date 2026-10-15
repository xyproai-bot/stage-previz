import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyLedSurface, createLedSurfaceUniforms, patchLedShader, setLedTemplate, configureLedMaterial } from './ledSurface';
import {
  buildObjectUniforms, mapUvToTemplate, spanFromUv, MAX_SCREENS_PER_OBJECT,
  type LedTemplatePlan, type Placement, type Rotation, type SrcSpan, type TemplateUniformData,
} from '../ledTemplate';

const FRAG = 'void main() {\n#include <emissivemap_fragment>\nvec3 outgoingLight = totalEmissiveRadiance;\n#include <opaque_fragment>\n}';
const newShader = () => ({ uniforms: {} as Record<string, { value: unknown }>, fragmentShader: FRAG });

/**
 * GLSL（ledSurface.ts 的 LED_EMISSIVE_MAP）逐行翻成 JS：同樣的運算、同樣的順序。
 * 用來證明 shader 的算法跟 lib/ledTemplate.ts 的 mapUvToTemplate 對得上（真的在 GPU 上的畫面由瀏覽器實測看）。
 */
function glslPort(u: TemplateUniformData, on: boolean, uv: [number, number]): { uv: [number, number]; covered: boolean } {
  if (!on) return { uv, covered: true };
  for (let i = 0; i < MAX_SCREENS_PER_OBJECT; i++) {
    if (i >= u.count) break;
    const s = u.src.slice(i * 4, i * 4 + 4);
    let dx = uv[0] - s[0], dy = uv[1] - s[1];
    dx -= Math.floor(dx + 1e-5);
    dy -= Math.floor(dy + 1e-5);
    if (dx <= s[2] + 1e-5 && dy <= s[3] + 1e-5) {
      const lx = Math.min(1, Math.max(0, dx / s[2])), ly = Math.min(1, Math.max(0, dy / s[3]));
      const m = u.mat.slice(i * 4, i * 4 + 4);
      const tx = m[0] * lx + m[1] * ly + u.off[i * 2];
      const ty = m[2] * lx + m[3] * ly + u.off[i * 2 + 1];
      const r = u.dst.slice(i * 4, i * 4 + 4);
      const lox = r[0] + u.half[0], loy = r[1] + u.half[1];
      const mix = (a: number, b: number, t: number) => a + (b - a) * t;
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      return {
        uv: [clamp(mix(r[0], r[2], tx), lox, Math.max(lox, r[2] - u.half[0])), clamp(mix(r[1], r[3], ty), loy, Math.max(loy, r[3] - u.half[1]))],
        covered: true,
      };
    }
  }
  return { uv, covered: false };
}

const plc = (over: Partial<Placement>): Placement => ({
  key: 's:x', objectId: 'a', uv: [0.1, 0.2, 0.6, 0.9], dest: { x: 30, y: 10, w: 80, h: 40 }, rotate: 0, flipH: false, flipV: false, ...over,
});
const plan = (screens: Placement[]): LedTemplatePlan => ({ v: 1, id: 't', name: 'T', canvas: { width: 200, height: 100 }, scalePct: 100, screens });
const srcFor = (p: Placement): SrcSpan | null => (p.uv ? spanFromUv(p.uv) : null);

describe('shader 的版型取色跟 mapUvToTemplate 同一套算法', () => {
  it('八種方向 × 一堆點：結果一樣；範圍外 = 沒蓋到（黑）', () => {
    let checked = 0;
    for (const rot of [0, 90, 180, 270] as Rotation[]) {
      for (const flipH of [false, true]) for (const flipV of [false, true]) {
        const dest = rot === 90 || rot === 270 ? { x: 30, y: 10, w: 40, h: 80 } : { x: 30, y: 10, w: 80, h: 40 };
        const p = plc({ rotate: rot, flipH, flipV, dest });
        const pl = plan([p]);
        const data = buildObjectUniforms(pl, 'a', srcFor);
        for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
          const uv: [number, number] = [0.05 + i * 0.05, 0.1 + j * 0.07];
          const js = mapUvToTemplate(p, spanFromUv(p.uv!), pl.canvas, uv[0], uv[1]);
          const gl = glslPort(data, true, uv);
          if (js === null) { expect(gl.covered).toBe(false); continue; }
          expect(gl.covered).toBe(true);
          expect(gl.uv[0]).toBeCloseTo(js[0], 5);
          expect(gl.uv[1]).toBeCloseTo(js[1], 5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('跨接縫的螢幕、UV 在負的那一格（繞回）也一樣', () => {
    const p = plc({ key: 'o:a', uv: null });
    const span: SrcSpan = { us: 0.9, ul: 0.2, vs: 0.8, vl: 0.3 };
    const pl = plan([p]);
    const data = buildObjectUniforms(pl, 'a', () => span);
    for (const uv of [[0.95, 0.9], [0.05, 1.05], [-0.04, 0.9], [1.02, -0.05], [0.5, 0.5]] as [number, number][]) {
      const js = mapUvToTemplate(p, span, pl.canvas, uv[0], uv[1]);
      const gl = glslPort(data, true, uv);
      expect(gl.covered).toBe(js !== null);
      if (js) { expect(gl.uv[0]).toBeCloseTo(js[0], 5); expect(gl.uv[1]).toBeCloseTo(js[1], 5); }
    }
  });

  it('沒開版型（uLedTplOn = 0）：UV 原封不動、一定有蓋到 = 原本的取色', () => {
    const data = buildObjectUniforms(plan([plc({})]), 'a', srcFor);
    expect(glslPort(data, false, [0.123, 0.456])).toEqual({ uv: [0.123, 0.456], covered: true });
  });

  it('同一個物件放兩塊：用包住這點的那一塊', () => {
    const left = plc({ key: 's:l', uv: [0, 0, 0.5, 1], dest: { x: 0, y: 0, w: 100, h: 100 } });
    const right = plc({ key: 's:r', uv: [0.5, 0, 1, 1], dest: { x: 100, y: 0, w: 100, h: 100 } });
    const pl = plan([left, right]);
    const data = buildObjectUniforms(pl, 'a', srcFor);
    expect(data.count).toBe(2);
    expect(glslPort(data, true, [0.25, 0.5]).uv[0]).toBeCloseTo(0.25, 5);
    expect(glslPort(data, true, [0.75, 0.5]).uv[0]).toBeCloseTo(0.75, 5);
  });
});

describe('patchLedShader：版型取色放在讀貼圖那一行之前；沒開時走原本的路', () => {
  it('程式碼的順序和條件', () => {
    const shader = newShader();
    patchLedShader(shader, createLedSurfaceUniforms());
    const fs = shader.fragmentShader;
    expect(fs).toContain('#define LED_TPL_MAX 8');
    expect(fs).toContain('uniform vec4 uLedTplSrc[LED_TPL_MAX];');
    const init = fs.indexOf('vec2 ledSampleUv = vEmissiveMapUv;');
    const gate = fs.indexOf('if ( uLedTplOn > 0.5 )');
    const fetch = fs.indexOf('texture2D( emissiveMap, ledSampleUv )');
    const mul = fs.indexOf('totalEmissiveRadiance *= emissiveColor.rgb;');
    const black = fs.indexOf('if ( ledCovered < 0.5 ) totalEmissiveRadiance = vec3( 0.0 );');
    expect(init).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(init);
    expect(fetch).toBeGreaterThan(gate);
    expect(mul).toBeGreaterThan(fetch);
    // 沒蓋到的螢幕在顏色都算完（包括影片 sRGB 轉換和 AE 校正曲線）之後才歸零
    expect(black).toBeGreaterThan(mul);
    // 像素格還是用原本的 UV 和真實點數
    expect(fs).toContain('vec2 ledTexel = vEmissiveMapUv * uLedTexels;');
    expect(fs.slice(fs.indexOf('ledTexel')).includes('ledSampleUv')).toBe(false);
  });

  it('預設沒開、陣列大小對（uniform 值是攤平的 Float32Array，three 直接吃）', () => {
    const u = createLedSurfaceUniforms();
    expect(u.uLedTplOn.value).toBe(0);
    expect(u.uLedTplSrc.value.length).toBe(MAX_SCREENS_PER_OBJECT * 4);
    expect(u.uLedTplOff.value.length).toBe(MAX_SCREENS_PER_OBJECT * 2);
    expect(u.uLedTplSrc.value).toBeInstanceOf(Float32Array);
  });
});

describe('setLedTemplate', () => {
  const material = () => { const m = new THREE.MeshStandardMaterial(); applyLedSurface(m); return m; };
  it('設進材質的 uniforms；null = 關掉（回到原本的取色）', () => {
    const m = material();
    const data = buildObjectUniforms(plan([plc({ rotate: 90, flipH: true, dest: { x: 30, y: 10, w: 40, h: 80 } })]), 'a', srcFor);
    setLedTemplate(m, data);
    const u = m.userData.ledSurface;
    expect(u.uLedTplOn.value).toBe(1);
    expect(u.uLedTplCount.value).toBe(1);
    expect(Array.from(u.uLedTplSrc.value.slice(0, 4))).toEqual(data.src.slice(0, 4).map(Math.fround));
    expect(u.uLedTplHalf.value.x).toBeCloseTo(0.5 / 200, 8);
    setLedTemplate(m, null);
    expect(m.userData.ledSurface.uLedTplOn.value).toBe(0);
  });
  it('物件不在版型裡 = 開著、0 塊（整個黑的）', () => {
    const m = material();
    setLedTemplate(m, buildObjectUniforms(plan([plc({})]), 'nobody', srcFor));
    expect(m.userData.ledSurface.uLedTplOn.value).toBe(1);
    expect(m.userData.ledSurface.uLedTplCount.value).toBe(0);
  });
  it('不是 LED 材質 = 什麼都不做', () => {
    expect(() => setLedTemplate(new THREE.MeshStandardMaterial(), null)).not.toThrow();
  });
  it('configureLedMaterial（快速 / 現場）不會動到版型設定', () => {
    const m = material();
    setLedTemplate(m, buildObjectUniforms(plan([plc({})]), 'a', srcFor));
    configureLedMaterial(m, { mode: 'live', texture: null });
    expect(m.userData.ledSurface.uLedTplOn.value).toBe(1);
    configureLedMaterial(m, { mode: 'quick', texture: null });
    expect(m.userData.ledSurface.uLedTplOn.value).toBe(1);
  });
});
