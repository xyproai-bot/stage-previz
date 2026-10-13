import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyLedSurface, patchLedShader, updateLedSurface, createLedSurfaceUniforms } from './ledSurface';

const FRAG = 'void main() {\n#include <emissivemap_fragment>\n#include <lights_physical_fragment>\n}';

describe('patchLedShader', () => {
  it('在 emissivemap_fragment 後面插 LED 程式碼、加 uniforms', () => {
    const shader = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: `uniform vec3 diffuse;\n${FRAG}` };
    patchLedShader(shader, createLedSurfaceUniforms());
    expect(shader.fragmentShader).toContain('uniform float uLedOn;');
    const emissiveAt = shader.fragmentShader.indexOf('#include <emissivemap_fragment>');
    const ledAt = shader.fragmentShader.indexOf('uLedOn > 0.5');
    expect(ledAt).toBeGreaterThan(emissiveAt);
    expect(shader.uniforms.uLedTexels).toBeDefined();
    expect(shader.uniforms.uLedViewFalloff).toBeDefined();
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

  it('沒套過的材質 update 不會壞', () => {
    const m = new THREE.MeshStandardMaterial();
    expect(() => updateLedSurface(m, { on: false })).not.toThrow();
  });
});
