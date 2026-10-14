import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyLedSurface, patchLedShader, updateLedSurface, createLedSurfaceUniforms, needsVideoSrgbDecode, configureLedMaterial, LED_SHARED_UNIFORMS, LED_SURFACE } from './ledSurface';

const FRAG = 'void main() {\n#include <emissivemap_fragment>\n#include <lights_physical_fragment>\nvec3 outgoingLight = totalEmissiveRadiance;\n#include <opaque_fragment>\n#include <tonemapping_fragment>\n}';
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
    // 所有 LED 共用同一個 uniform 物件（StageScene 每幀改一次就全部生效）
    expect(shader.uniforms.uLedMaskOut).toBe(LED_SHARED_UNIFORMS.uLedMaskOut);
    expect(shader.uniforms.uLedExposure).toBe(LED_SHARED_UNIFORMS.uLedExposure);
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

  it('顏色照原檔：opaque_fragment 前決定 LED 的顏色、後面（只有不透明的）把 alpha 寫 0', () => {
    const shader = newShader();
    patchLedShader(shader, createLedSurfaceUniforms());
    const fs = shader.fragmentShader;
    const decide = fs.indexOf('uLedMode > 1.5');
    const opaque = fs.indexOf('#include <opaque_fragment>');
    const mask = fs.indexOf('gl_FragColor.a = 0.0');
    expect(decide).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(opaque);
    expect(mask).toBeGreaterThan(opaque);
    expect(mask).toBeLessThan(fs.indexOf('#include <tonemapping_fragment>'));
    // 半透明（淡入淡出的複本）不寫：alpha 要拿來混色
    expect(fs.slice(opaque, mask)).toContain('#ifdef OPAQUE');
    expect(fs).toContain('uLedMaskOut > 0.5');
  });

  it('three 的 opaque_fragment 還是 gl_FragColor = vec4( outgoingLight, diffuseColor.a )（升級 three 要重看）', () => {
    expect(THREE.ShaderChunk.opaque_fragment).toContain('gl_FragColor = vec4( outgoingLight, diffuseColor.a );');
    expect(THREE.ShaderLib.physical.fragmentShader).toContain('#include <opaque_fragment>');
    expect(THREE.ShaderLib.physical.fragmentShader).toContain('vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;');
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
    expect(m.customProgramCacheKey()).toBe('led-surface-v2');
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
    expect(m.customProgramCacheKey()).toBe('led-surface-v2-video');
    const shader = newShader();
    m.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('#define LED_DECODE_VIDEO');

    // 複本（objectFade 的作法）：沿用同一組函式，看的是複本自己的 emissiveMap
    const copy = m.clone();
    copy.onBeforeCompile = m.onBeforeCompile;
    copy.customProgramCacheKey = m.customProgramCacheKey;
    copy.emissiveMap = new THREE.Texture();
    expect(copy.customProgramCacheKey()).toBe('led-surface-v2');
    expect(m.customProgramCacheKey()).toBe('led-surface-v2-video');

    m.emissiveMap = null;
    expect(m.customProgramCacheKey()).toBe('led-surface-v2');
  });

  it('mode：off / quick / live → 0 / 1 / 2', () => {
    const m = new THREE.MeshStandardMaterial();
    applyLedSurface(m);
    const u = m.userData.ledSurface;
    expect(u.uLedMode.value).toBe(0);
    updateLedSurface(m, { mode: 'live' });
    expect(u.uLedMode.value).toBe(2);
    updateLedSurface(m, { mode: 'quick' });
    expect(u.uLedMode.value).toBe(1);
    updateLedSurface(m, { mode: 'off' });
    expect(u.uLedMode.value).toBe(0);
  });

  it('沒套過的材質 update 不會壞', () => {
    const m = new THREE.MeshStandardMaterial();
    expect(() => updateLedSurface(m, { on: false })).not.toThrow();
  });
});

describe('configureLedMaterial', () => {
  const tex = () => { const t = new THREE.Texture(); t.colorSpace = THREE.SRGBColorSpace; return t; };

  it('現場：黑亮底、畫面放 emissiveMap、tint × 亮度、不在材質裡壓色', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x888888, map: tex() });
    const t = tex();
    configureLedMaterial(m, { mode: 'live', texture: t, tint: new THREE.Color(1, 0.5, 0.25), brightness: 0.8 });
    expect(m.emissiveMap).toBe(t);
    expect(m.map).toBeNull();
    expect(m.color.getHex()).toBe(LED_SURFACE.baseColor);
    expect(m.roughness).toBe(LED_SURFACE.roughness);
    expect(m.envMapIntensity).toBe(LED_SURFACE.envMapIntensity);
    expect(m.emissiveIntensity).toBe(0.8);
    expect(m.emissive.g).toBeCloseTo(0.5);
    expect(m.toneMapped).toBe(false);
    expect(m.transparent).toBe(false);
    expect(m.userData.ledSurface.uLedMode.value).toBe(2);
  });

  it('快速：只有畫面（底色黑、不反光、亮度 / tint 不算 → 1:1）', () => {
    const m = new THREE.MeshStandardMaterial();
    const t = tex();
    configureLedMaterial(m, { mode: 'quick', texture: t });
    expect(m.emissiveMap).toBe(t);
    expect(m.map).toBeNull();
    expect(m.color.getHex()).toBe(0x000000);
    expect(m.envMapIntensity).toBe(0);
    expect(m.emissive.getHex()).toBe(0xffffff);
    expect(m.emissiveIntensity).toBe(1);
    expect(m.toneMapped).toBe(false);
    expect(m.userData.ledSurface.uLedMode.value).toBe(1);
    expect(m.userData.ledSurface.uLedOn.value).toBe(0);
  });

  it('換貼圖才要重編 shader', () => {
    const m = new THREE.MeshStandardMaterial();
    const t = tex();
    configureLedMaterial(m, { mode: 'live', texture: t });
    const v = m.version;
    configureLedMaterial(m, { mode: 'live', texture: t, brightness: 0.5 });
    expect(m.version).toBe(v);
    configureLedMaterial(m, { mode: 'live', texture: tex() });
    expect(m.version).toBeGreaterThan(v);
  });
});
