import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyLedSurface, patchLedShader, updateLedSurface, createLedSurfaceUniforms, needsVideoSrgbDecode } from './ledSurface';

const FRAG = 'void main() {\n#include <emissivemap_fragment>\n#include <lights_physical_fragment>\n}';
const newShader = (fragmentShader = FRAG) => ({ uniforms: {} as Record<string, { value: unknown }>, fragmentShader });

describe('patchLedShader', () => {
  it('取代 emissivemap_fragment（讀完 emissiveMap 接著 LED 程式碼）、加 uniforms', () => {
    const shader = newShader(`uniform vec3 diffuse;\n${FRAG}`);
    patchLedShader(shader, createLedSurfaceUniforms());
    const fs = shader.fragmentShader;
    expect(fs).toContain('uniform float uLedOn;');
    expect(fs).not.toContain('#include <emissivemap_fragment>');
    const emissiveAt = fs.indexOf('totalEmissiveRadiance *= emissiveColor.rgb;');
    const ledAt = fs.indexOf('uLedOn > 0.5');
    expect(emissiveAt).toBeGreaterThan(-1);
    expect(ledAt).toBeGreaterThan(emissiveAt);
    expect(fs.indexOf('#include <lights_physical_fragment>')).toBeGreaterThan(ledAt);
    expect(shader.uniforms.uLedTexels).toBeDefined();
    expect(shader.uniforms.uLedViewFalloff).toBeDefined();
    // 不是影片 → 不開 sRGB 轉換
    expect(fs).not.toContain('#define LED_DECODE_VIDEO');
  });

  it('影片貼圖 → 開 sRGB 轉換，而且在乘進 totalEmissiveRadiance 之前轉', () => {
    const shader = newShader();
    patchLedShader(shader, createLedSurfaceUniforms(), true);
    const fs = shader.fragmentShader;
    expect(fs.startsWith('#define LED_DECODE_VIDEO\n')).toBe(true);
    const decodeAt = fs.indexOf('#ifdef LED_DECODE_VIDEO');
    expect(decodeAt).toBeGreaterThan(fs.indexOf('texture2D( emissiveMap'));
    expect(decodeAt).toBeLessThan(fs.indexOf('totalEmissiveRadiance *= emissiveColor.rgb;'));
  });

  it('three 的 emissivemap_fragment 還是我們取代的樣子（升級 three 要重看：新版可能自己會轉影片）', () => {
    expect(THREE.ShaderChunk.emissivemap_fragment.replace(/\s+/g, ' ').trim()).toBe(
      '#ifdef USE_EMISSIVEMAP vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv ); totalEmissiveRadiance *= emissiveColor.rgb; #endif',
    );
  });
});

describe('needsVideoSrgbDecode', () => {
  const video = () => new THREE.VideoTexture({} as HTMLVideoElement);
  it('sRGB 的影片貼圖才要轉', () => {
    const v = video();
    v.colorSpace = THREE.SRGBColorSpace;
    expect(needsVideoSrgbDecode(v)).toBe(true);
  });
  it('圖片 / NDI canvas 貼圖、沒標 sRGB 的影片、沒有貼圖 → 不轉（顯卡已經轉了，或本來就是 linear）', () => {
    const img = new THREE.Texture();
    img.colorSpace = THREE.SRGBColorSpace;
    expect(needsVideoSrgbDecode(img)).toBe(false);
    const canvas = new THREE.CanvasTexture({} as HTMLCanvasElement);
    canvas.colorSpace = THREE.SRGBColorSpace;
    expect(needsVideoSrgbDecode(canvas)).toBe(false);
    expect(needsVideoSrgbDecode(video())).toBe(false);
    expect(needsVideoSrgbDecode(null)).toBe(false);
    expect(needsVideoSrgbDecode(undefined)).toBe(false);
  });
});

describe('applyLedSurface / updateLedSurface', () => {
  it('重複套用只會設一次 onBeforeCompile，cache key 固定', () => {
    const m = new THREE.MeshStandardMaterial();
    applyLedSurface(m);
    const first = m.onBeforeCompile;
    applyLedSurface(m);
    expect(m.onBeforeCompile).toBe(first);
    expect(m.customProgramCacheKey()).toBe('led-surface-v1');
  });

  it('update 會改 uniform 的值（編譯前也能先設）', () => {
    const m = new THREE.MeshStandardMaterial();
    applyLedSurface(m);
    updateLedSurface(m, { on: true, texels: [1920, 1080], gridStrength: 1, viewFalloff: 0.4 });
    const u = m.userData.ledSurface;
    expect(u.uLedOn.value).toBe(1);
    expect(u.uLedTexels.value.x).toBe(1920);
    expect(u.uLedTexels.value.y).toBe(1080);
    expect(u.uLedViewFalloff.value).toBeCloseTo(0.4);
    updateLedSurface(m, { on: false });
    expect(u.uLedOn.value).toBe(0);
  });

  it('emissiveMap 是影片 → 換一份有 sRGB 轉換的 shader（cache key 不同）；淡入淡出的複本看自己的貼圖', () => {
    const m = new THREE.MeshStandardMaterial();
    applyLedSurface(m);
    const vid = new THREE.VideoTexture({} as HTMLVideoElement);
    vid.colorSpace = THREE.SRGBColorSpace;
    m.emissiveMap = vid;
    expect(m.customProgramCacheKey()).toBe('led-surface-v1-video');
    const shader = newShader();
    m.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('#define LED_DECODE_VIDEO');

    // 複本（objectFade 的作法）：沿用同一組函式，看的是複本自己的 emissiveMap
    const copy = m.clone();
    copy.onBeforeCompile = m.onBeforeCompile;
    copy.customProgramCacheKey = m.customProgramCacheKey;
    copy.emissiveMap = new THREE.Texture();
    expect(copy.customProgramCacheKey()).toBe('led-surface-v1');
    expect(m.customProgramCacheKey()).toBe('led-surface-v1-video');

    m.emissiveMap = null;
    expect(m.customProgramCacheKey()).toBe('led-surface-v1');
  });

  it('沒套過的材質 update 不會壞', () => {
    const m = new THREE.MeshStandardMaterial();
    expect(() => updateLedSurface(m, { on: false })).not.toThrow();
  });
});
