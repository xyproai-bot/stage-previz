// LED 面板表面質感（現場模式）：在 MeshStandardMaterial 的 emissive 計算後面插 GLSL
//   1. 像素格：依貼圖解析度畫出一顆顆 LED（螢幕上太小就淡出，避免摩爾紋；平均亮度維持）
//   2. 側看變暗：法線跟視線夾角越大越暗（ledViewFalloff 可調）
// 黑亮底色 / 反射在 StageScene 設（roughness、envMapIntensity），這裡只管發光那一層。

import * as THREE from 'three';

export const LED_SURFACE = {
  /** 畫面暗的地方：接近黑、會反光的 LED 面板 */
  baseColor: 0x050505,
  roughness: 0.3,
  envMapIntensity: 0.5,
  /** 一顆 LED 佔像素間距的比例（0.72 → 顆粒之間有黑縫） */
  gridFill: 0.72,
};

/** NDI helper 預設縮小一半送出 → 收到的一個像素 = 2×2 顆 LED */
export const NDI_PIXEL_DENSITY = 2;

export interface LedSurfaceParams {
  on: boolean;
  /** LED 實際顆數（寬, 高） */
  texels: [number, number];
  /** 像素格強度（0 = 不畫） */
  gridStrength: number;
  /** 側看變暗程度 0~1 */
  viewFalloff: number;
}

export interface LedSurfaceUniforms {
  uLedOn: { value: number };
  uLedTexels: { value: THREE.Vector2 };
  uLedGridStrength: { value: number };
  uLedGridFill: { value: number };
  uLedViewFalloff: { value: number };
}

export function createLedSurfaceUniforms(): LedSurfaceUniforms {
  return {
    uLedOn: { value: 0 },
    uLedTexels: { value: new THREE.Vector2(1, 1) },
    uLedGridStrength: { value: 0 },
    uLedGridFill: { value: LED_SURFACE.gridFill },
    uLedViewFalloff: { value: 0 },
  };
}

const LED_UNIFORM_DECL = /* glsl */`
uniform float uLedOn;
uniform vec2 uLedTexels;
uniform float uLedGridStrength;
uniform float uLedGridFill;
uniform float uLedViewFalloff;
`;

const LED_FRAGMENT = /* glsl */`
#ifdef USE_EMISSIVEMAP
if ( uLedOn > 0.5 ) {
  // 1. 像素格：每顆 LED 是一個方點，點和點之間是黑縫
  vec2 ledTexel = vEmissiveMapUv * uLedTexels;
  vec2 ledFw = fwidth( ledTexel );
  float ledPerScreenPx = max( ledFw.x, ledFw.y );
  vec2 ledD = abs( fract( ledTexel ) - 0.5 );
  float ledHalf = 0.5 * uLedGridFill;
  float ledAa = clamp( ledPerScreenPx, 0.02, 0.5 );
  float ledDot = ( 1.0 - smoothstep( ledHalf - ledAa, ledHalf + ledAa, ledD.x ) )
               * ( 1.0 - smoothstep( ledHalf - ledAa, ledHalf + ledAa, ledD.y ) );
  // 一顆 LED 在螢幕上小於約 2 個像素就看不出格子 → 淡出（避免摩爾紋）
  float ledGridVis = uLedGridStrength * ( 1.0 - smoothstep( 0.25, 0.5, ledPerScreenPx ) );
  // 除以覆蓋率 → 平均亮度跟沒格子時一樣（亮點會更亮，靠近時有顆粒閃光感）
  float ledCoverage = uLedGridFill * uLedGridFill;
  totalEmissiveRadiance *= mix( 1.0, min( ledDot / ledCoverage, 2.0 ), ledGridVis );

  // 2. 側看變暗
  float ledNdv = clamp( abs( dot( normal, normalize( vViewPosition ) ) ), 0.0, 1.0 );
  totalEmissiveRadiance *= mix( 1.0, ledNdv * ledNdv, uLedViewFalloff );
}
#endif
`;

export function patchLedShader(
  shader: { uniforms: Record<string, { value: unknown }>; fragmentShader: string },
  uniforms: LedSurfaceUniforms,
) {
  Object.assign(shader.uniforms, uniforms);
  shader.fragmentShader = LED_UNIFORM_DECL + shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\n' + LED_FRAGMENT,
  );
}

export function applyLedSurface(material: THREE.MeshStandardMaterial) {
  if (material.userData.ledSurface) return;
  const uniforms = createLedSurfaceUniforms();
  material.userData.ledSurface = uniforms;
  material.onBeforeCompile = (shader) => patchLedShader(shader, uniforms);
  material.customProgramCacheKey = () => 'led-surface-v1';
  material.needsUpdate = true;
}

export function updateLedSurface(material: THREE.MeshStandardMaterial, params: Partial<LedSurfaceParams>) {
  const u = material.userData.ledSurface as LedSurfaceUniforms | undefined;
  if (!u) return;
  if (params.on !== undefined) u.uLedOn.value = params.on ? 1 : 0;
  if (params.texels) u.uLedTexels.value.set(Math.max(1, params.texels[0]), Math.max(1, params.texels[1]));
  if (params.gridStrength !== undefined) u.uLedGridStrength.value = params.gridStrength;
  if (params.viewFalloff !== undefined) u.uLedViewFalloff.value = params.viewFalloff;
}
