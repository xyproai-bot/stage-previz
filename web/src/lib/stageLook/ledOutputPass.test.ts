import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { OutputShader } from 'three/examples/jsm/shaders/OutputShader.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { LedOutputPass, LED_OUTPUT_FRAGMENT } from './ledOutputPass';

type Uniforms = Record<string, THREE.IUniform>;

describe('LedOutputPass', () => {
  it('光暈改在這裡加：UnrealBloomPass 最後那一次加回畫面不畫了', () => {
    const bloom = new UnrealBloomPass(new THREE.Vector2(8, 8), 1, 0.3, 0.75);
    expect(bloom.blendMaterial.visible).toBe(true);
    const pass = new LedOutputPass(bloom);
    expect(bloom.blendMaterial.visible).toBe(false);
    expect(pass.material.fragmentShader).toBe(LED_OUTPUT_FRAGMENT);
  });

  it('three 的光暈還是 additive（SRC_ALPHA × ONE）→ 我們加 rgb × a 才一樣（升級 three 要重看）', () => {
    const bloom = new UnrealBloomPass(new THREE.Vector2(8, 8), 1, 0.3, 0.75);
    expect(bloom.blendMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(bloom.blendMaterial.premultipliedAlpha).toBe(false);
    expect(LED_OUTPUT_FRAGMENT).toContain('bloom = b.rgb * b.a;');
  });

  it('跟 three 原本的 OutputShader 用一樣的 tone mapping 選項（只多了 LED 判斷和光暈）', () => {
    for (const def of ['LINEAR_TONE_MAPPING', 'REINHARD_TONE_MAPPING', 'CINEON_TONE_MAPPING', 'ACES_FILMIC_TONE_MAPPING', 'AGX_TONE_MAPPING', 'NEUTRAL_TONE_MAPPING', 'SRGB_TRANSFER']) {
      expect(OutputShader.fragmentShader).toContain(def);
      expect(LED_OUTPUT_FRAGMENT).toContain(def);
    }
    expect(LED_OUTPUT_FRAGMENT).toContain('float ledMask = 1.0 - clamp( src.a, 0.0, 1.0 );');
  });

  it('光暈開著才去讀光暈的貼圖', () => {
    const spy = vi.spyOn(OutputPass.prototype, 'render').mockImplementation(() => {});
    const bloom = new UnrealBloomPass(new THREE.Vector2(8, 8), 1, 0.3, 0.75);
    const pass = new LedOutputPass(bloom);
    const u = pass.uniforms as Uniforms;
    const rt = new THREE.WebGLRenderTarget(4, 4);
    bloom.enabled = false;
    pass.render({} as THREE.WebGLRenderer, rt, rt, 0, false);
    expect(u.uBloomOn.value).toBe(0);
    expect(u.tBloom.value).toBeNull();
    bloom.enabled = true;
    pass.render({} as THREE.WebGLRenderer, rt, rt, 0, false);
    expect(u.uBloomOn.value).toBe(1);
    expect(u.tBloom.value).toBe(bloom.renderTargetsHorizontal[0].texture);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('沒有光暈也能用', () => {
    const pass = new LedOutputPass(null);
    expect((pass.uniforms as Uniforms).uBloomOn.value).toBe(0);
  });
});
