// LED 面板表面質感 + 顏色照原檔：在 MeshStandardMaterial 的 shader 裡插 GLSL
//   0. 影片貼圖補做 sRGB 轉換（見 needsVideoSrgbDecode）；AE 即時的貼圖套顏色校正曲線（見 setLedColorLut）
//   1. 像素格：依貼圖解析度畫出一顆顆 LED（螢幕上太小就淡出，避免摩爾紋）；一格的平均亮度 = 原檔（亮的畫面縫裡補光，不會被截掉）
//   2. 側看變暗：法線跟視線夾角越大越暗（ledViewFalloff 可調；正面 ±20° 以內不變）
//   3. 顏色照原檔（uLedMode）：
//      - 快速：只有 LED 畫面（不受燈光、反光影響）
//      - 現場：LED 畫面 + 表面反光「照相機曲線多亮了多少」；主畫面那一次 alpha 寫 0，
//        ledOutputPass.ts 看到就不做 tone mapping / 曝光 → 正面看 = 原檔像素
//   數學跟 ledColorMath.ts 一樣（有單元測試）。黑亮底色 / 反射在 configureLedMaterial 設。

import * as THREE from 'three';
import { VIEW_FALLOFF_FLAT_COS2 } from './ledColorMath';
import type { NdiColorLut } from '../ndiColor';

export const LED_SURFACE = {
  /** 畫面暗的地方：接近黑、會反光的 LED 面板 */
  baseColor: 0x050505,
  roughness: 0.3,
  envMapIntensity: 0.5,
  /** 一顆 LED 佔像素間距的比例（0.72 → 顆粒之間有黑縫） */
  gridFill: 0.72,
};

/** 0.1.12 以前的 NDI 小程序固定縮一半送出 → 不知道畫布大小、小程序也沒回報時：收到的一個像素 = 2×2 顆 LED */
export const NDI_PIXEL_DENSITY = 2;

/**
 * AE 即時的貼圖上一共有幾顆 LED（像素格的密度用）：
 *   1. 知道 LED 畫布大小（專案設定 / 影片大小），而且收到的畫面形狀一樣（寬高比差 3% 以內）→ 就是畫布大小
 *      （AE 用 Half / Third、小程序有沒有縮都對）
 *   2. 小程序有回報縮成幾分之一（0.1.13 起；舊版用 NDI 尺寸 ÷ 送出尺寸）→ 收到的大小 × 那個倍數
 *   3. 都不知道 → 舊版的固定 2 倍
 */
export function ndiLedTexels(
  frame: { width: number; height: number },
  canvas: { width: number; height: number } | null | undefined,
  helperDownscale: number | null | undefined,
): [number, number] {
  const fw = Math.max(1, frame.width), fh = Math.max(1, frame.height);
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    const ratio = (canvas.width / canvas.height) / (fw / fh);
    if (Math.abs(ratio - 1) <= 0.03) return [canvas.width, canvas.height];
  }
  const d = helperDownscale != null && helperDownscale >= 1 ? helperDownscale : NDI_PIXEL_DENSITY;
  return [fw * d, fh * d];
}

/** off = 一般材質（不是 LED、沒有改）；quick = 快速模式；live = 現場模式 */
export type LedMode = 'off' | 'quick' | 'live';
const MODE_VALUE: Record<LedMode, number> = { off: 0, quick: 1, live: 2 };

export interface LedSurfaceParams {
  on: boolean;
  /** LED 實際顆數（寬, 高） */
  texels: [number, number];
  /** 像素格強度（0 = 不畫） */
  gridStrength: number;
  /** 側看變暗程度 0~1 */
  viewFalloff: number;
  mode: LedMode;
}

export interface LedSurfaceUniforms {
  uLedOn: { value: number };
  uLedTexels: { value: THREE.Vector2 };
  uLedGridStrength: { value: number };
  uLedGridFill: { value: number };
  uLedViewFalloff: { value: number };
  uLedMode: { value: number };
}

export function createLedSurfaceUniforms(): LedSurfaceUniforms {
  return {
    uLedOn: { value: 0 },
    uLedTexels: { value: new THREE.Vector2(1, 1) },
    uLedGridStrength: { value: 0 },
    uLedGridFill: { value: LED_SURFACE.gridFill },
    uLedViewFalloff: { value: 0 },
    uLedMode: { value: 0 },
  };
}

/**
 * 所有 LED 材質共用（StageScene 每幀設）：
 *   uLedMaskOut — 現場模式主畫面（畫進 composer）那一次 = 1：LED 的 alpha 寫 0（倒影、環境光、VR 那幾次 = 0）
 *   uLedExposure — 現場的曝光（= renderer.toneMappingExposure），算表面反光照相機曲線多亮用
 */
export const LED_SHARED_UNIFORMS = {
  uLedMaskOut: { value: 0 },
  uLedExposure: { value: 1 },
  /** AE 即時的顏色校正曲線（256×1；值是 sRGB 8-bit → 顯卡讀出來就是 linear）；只有標了 ledColorLut 的貼圖用 */
  uLedColorLut: { value: createColorLutTexture() },
  /** 1 = 套曲線；0 = 不套（舊版小程序 / 不是 AE 的來源） */
  uLedColorLutOn: { value: 0 },
};

function createColorLutTexture(): THREE.DataTexture {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) data.set([i, i, i, 255], i * 4);
  const t = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/**
 * 換 AE 即時的顏色校正曲線（null = 不套）。曲線只套在 userData.ledColorLut = true 的貼圖（AE 即時那張），
 * 影片 / 圖片 / 測試圖不受影響。
 */
export function setLedColorLut(lut: NdiColorLut | null): void {
  const u = LED_SHARED_UNIFORMS;
  if (!lut) {
    u.uLedColorLutOn.value = 0;
    return;
  }
  const tex = u.uLedColorLut.value;
  const data = tex.image.data as Uint8Array;
  for (let i = 0; i < 256; i++) {
    data[i * 4] = lut.r[i];
    data[i * 4 + 1] = lut.g[i];
    data[i * 4 + 2] = lut.b[i];
    data[i * 4 + 3] = 255;
  }
  tex.needsUpdate = true;
  u.uLedColorLutOn.value = 1;
}

/** 這張貼圖要不要套 AE 即時的顏色校正（StageScene 建 NDI 貼圖時標） */
export function usesLedColorLut(tex: THREE.Texture | null | undefined): boolean {
  return !!tex && tex.userData?.ledColorLut === true;
}

const LED_UNIFORM_DECL = /* glsl */`
uniform float uLedOn;
uniform vec2 uLedTexels;
uniform float uLedGridStrength;
uniform float uLedGridFill;
uniform float uLedViewFalloff;
uniform float uLedMode;
uniform float uLedMaskOut;
uniform float uLedExposure;

// three r169 的 NeutralToneMapping（現場模式 OutputPass 用的那條），曝光用 uLedExposure
vec3 ledNeutral( vec3 color ) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  color *= uLedExposure;
  float x = min( color.r, min( color.g, color.b ) );
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < StartCompression ) return color;
  float d = 1. - StartCompression;
  float newPeak = 1. - d * d / ( peak + d - StartCompression );
  color *= newPeak / peak;
  float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
  return mix( color, vec3( newPeak ), g );
}

// ∫ smoothstep( e0, e1, t ) dt，從 -∞ 積到 x
float ledSmoothInt( float e0, float e1, float x ) {
  float w = e1 - e0;
  if ( x <= e0 ) return 0.0;
  if ( x >= e1 ) return 0.5 * w + ( x - e1 );
  float t = ( x - e0 ) / w;
  return w * ( t * t * t - 0.5 * t * t * t * t );
}

// 一顆 LED 亮點（1 - smoothstep）在一格裡的平均（一個方向）
float ledDotMean1D( float h, float aa ) {
  return 1.0 - 2.0 * ( ledSmoothInt( h - aa, h + aa, 0.5 ) - ledSmoothInt( h - aa, h + aa, 0.0 ) );
}
`;

/**
 * three r169 的影片貼圖（VideoTexture）存成一般 RGBA8、顯卡不做 sRGB 轉換，
 * 只有放在 map 時 three 會在 shader 裡補轉（DECODE_VIDEO_TEXTURE），放在 emissiveMap 不會。
 * LED 畫面放在 emissiveMap → 影片沒轉 → 比同一格畫面的圖片 / NDI 亮、黑色發灰。
 * 這種貼圖由 LED shader 自己轉。
 */
export function needsVideoSrgbDecode(tex: THREE.Texture | null | undefined): boolean {
  return !!tex && (tex as THREE.VideoTexture).isVideoTexture === true
    && THREE.ColorManagement.getTransfer(tex.colorSpace) === THREE.SRGBTransfer;
}

// AE 即時的顏色校正：linear → sRGB 8-bit 的值 → 查曲線（曲線貼圖是 sRGB，顯卡讀出來就是 linear）
const LED_COLOR_LUT_DECL = /* glsl */`
uniform sampler2D uLedColorLut;
uniform float uLedColorLutOn;
vec3 ledApplyColorLut( vec3 lin ) {
  vec3 s = clamp( mix( 1.055 * pow( max( lin, vec3( 0.0 ) ), vec3( 1.0 / 2.4 ) ) - 0.055, lin * 12.92, vec3( lessThanEqual( lin, vec3( 0.0031308 ) ) ) ), 0.0, 1.0 );
  vec3 u = ( s * 255.0 + 0.5 ) / 256.0;
  return vec3( texture2D( uLedColorLut, vec2( u.r, 0.5 ) ).r, texture2D( uLedColorLut, vec2( u.g, 0.5 ) ).g, texture2D( uLedColorLut, vec2( u.b, 0.5 ) ).b );
}
`;

// 取代 three 的 <emissivemap_fragment>：一樣讀 emissiveMap，影片貼圖多做一次 sRGB → linear（公式同 three 的 map_fragment）；
// AE 即時的貼圖（LED_COLOR_LUT）套顏色校正
const LED_EMISSIVE_MAP = /* glsl */`
#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
  #ifdef LED_DECODE_VIDEO
  emissiveColor.rgb = mix( pow( emissiveColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), emissiveColor.rgb * 0.0773993808, vec3( lessThanEqual( emissiveColor.rgb, vec3( 0.04045 ) ) ) );
  #endif
  #ifdef LED_COLOR_LUT
  if ( uLedColorLutOn > 0.5 ) emissiveColor.rgb = ledApplyColorLut( emissiveColor.rgb );
  #endif
  totalEmissiveRadiance *= emissiveColor.rgb;
#endif
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
  if ( ledGridVis > 0.0 ) {
    // 除以一格的平均 → 平均亮度跟原檔一樣（亮點會更亮）
    float ledMean1 = ledDotMean1D( ledHalf, ledAa );
    float ledMean = ledMean1 * ledMean1;
    // 亮的畫面：亮點最亮只能到 1（畫面最亮就是 1）→ 一部分光分到縫裡，一格的平均還是一樣
    float ledPeak = max( totalEmissiveRadiance.r, max( totalEmissiveRadiance.g, totalEmissiveRadiance.b ) );
    float ledFill = clamp( ( ledPeak - ledMean ) / ( max( ledPeak, 1e-5 ) * ( 1.0 - ledMean ) ), 0.0, 1.0 );
    totalEmissiveRadiance *= mix( 1.0, mix( ledDot / ledMean, 1.0, ledFill ), ledGridVis );
  }

  // 2. 側看變暗（正面 ±20° 以內不變）
  float ledNdv = clamp( abs( dot( normal, normalize( vViewPosition ) ) ), 0.0, 1.0 );
  totalEmissiveRadiance *= mix( 1.0, min( 1.0, ledNdv * ledNdv / ${VIEW_FALLOFF_FLAT_COS2.toFixed(6)} ), uLedViewFalloff );
}
#endif
`;

// 插在 <opaque_fragment> 前：決定 LED 這一點最後的顏色
const LED_OUTPUT = /* glsl */`
if ( uLedMode > 1.5 ) {
  // 現場：LED 畫面照原檔；表面反光 / 打到 LED 的燈照相機曲線加上去（黑的地方跟舞台一樣被壓、亮的地方幾乎不墊高）
  vec3 ledSurfaceLight = max( outgoingLight - totalEmissiveRadiance, vec3( 0.0 ) );
  outgoingLight = totalEmissiveRadiance + max( ledNeutral( totalEmissiveRadiance + ledSurfaceLight ) - ledNeutral( totalEmissiveRadiance ), vec3( 0.0 ) );
} else if ( uLedMode > 0.5 ) {
  // 快速：只有 LED 畫面
  outgoingLight = totalEmissiveRadiance;
}
`;

// 插在 <opaque_fragment> 後：主畫面那一次，不透明的 LED 把 alpha 寫 0（= 這是 LED 畫面，最後不要再壓色）
//   淡入淡出中的複本是半透明（沒有 OPAQUE）→ alpha 要拿來混色，不標（淡的那一下照舞台的曲線）
const LED_MASK = /* glsl */`
#ifdef OPAQUE
if ( uLedMaskOut > 0.5 && uLedMode > 1.5 ) gl_FragColor.a = 0.0;
#endif
`;

export function patchLedShader(
  shader: { uniforms: Record<string, { value: unknown }>; fragmentShader: string },
  uniforms: LedSurfaceUniforms,
  decodeVideo = false,
  colorLut = false,
) {
  Object.assign(shader.uniforms, uniforms, LED_SHARED_UNIFORMS);
  shader.fragmentShader = (decodeVideo ? '#define LED_DECODE_VIDEO\n' : '')
    + (colorLut ? '#define LED_COLOR_LUT\n' + LED_COLOR_LUT_DECL : '')
    + LED_UNIFORM_DECL + shader.fragmentShader
    .replace('#include <emissivemap_fragment>', LED_EMISSIVE_MAP + LED_FRAGMENT)
    .replace('#include <opaque_fragment>', LED_OUTPUT + '#include <opaque_fragment>' + LED_MASK);
}

export function applyLedSurface(material: THREE.MeshStandardMaterial) {
  if (material.userData.ledSurface) return;
  const uniforms = createLedSurfaceUniforms();
  material.userData.ledSurface = uniforms;
  // 用 this（不是 material）：淡入淡出的材質複本會沿用這兩個函式，要看的是複本自己的貼圖
  // 換成 / 換掉影片貼圖時 StageScene 會設 needsUpdate → cache key 不同 → 換一份有 / 沒有轉換的 shader
  material.onBeforeCompile = function (this: THREE.MeshStandardMaterial, shader) {
    patchLedShader(shader, uniforms, needsVideoSrgbDecode(this.emissiveMap), usesLedColorLut(this.emissiveMap));
  };
  material.customProgramCacheKey = function (this: THREE.MeshStandardMaterial) {
    return (needsVideoSrgbDecode(this.emissiveMap) ? 'led-surface-v2-video' : 'led-surface-v2')
      + (usesLedColorLut(this.emissiveMap) ? '-lut' : '');
  };
  material.needsUpdate = true;
}

export function updateLedSurface(material: THREE.MeshStandardMaterial, params: Partial<LedSurfaceParams>) {
  const u = material.userData.ledSurface as LedSurfaceUniforms | undefined;
  if (!u) return;
  if (params.on !== undefined) u.uLedOn.value = params.on ? 1 : 0;
  if (params.texels) u.uLedTexels.value.set(Math.max(1, params.texels[0]), Math.max(1, params.texels[1]));
  if (params.gridStrength !== undefined) u.uLedGridStrength.value = params.gridStrength;
  if (params.viewFalloff !== undefined) u.uLedViewFalloff.value = params.viewFalloff;
  if (params.mode !== undefined) u.uLedMode.value = MODE_VALUE[params.mode];
}

const WHITE = new THREE.Color(0xffffff);

/**
 * LED 材質設成「畫面照原檔」（StageScene 現場 / 快速模式的 LED 都走這裡；量測頁跟著同一份）
 *   live：底色接近黑、roughness 0.3 → 畫面暗的地方是黑亮面，會映出其他 LED；畫面 = emissiveMap × tint × 亮度
 *   quick：只有畫面（不打燈、不反光、不吃亮度 / tint：給動畫師 1:1 對顏色）
 *   兩種都 toneMapped = false（直接畫到螢幕時也不壓色）；現場模式在 composer 裡由 ledOutputPass 跳過壓色
 */
export function configureLedMaterial(
  m: THREE.MeshStandardMaterial,
  opts: { mode: 'live' | 'quick'; texture: THREE.Texture | null; tint?: THREE.Color; brightness?: number },
) {
  const live = opts.mode === 'live';
  applyLedSurface(m);
  m.color.setHex(live ? LED_SURFACE.baseColor : 0x000000);
  m.metalness = 0;
  m.roughness = live ? LED_SURFACE.roughness : 1;
  m.envMapIntensity = live ? LED_SURFACE.envMapIntensity : 0;
  m.opacity = 1;
  if (m.transparent) { m.transparent = false; m.needsUpdate = true; }
  if (m.toneMapped !== false) { m.toneMapped = false; m.needsUpdate = true; }
  // 模型自己的底色貼圖不要（舊版快速模式會把 LED 畫面放在 map）
  if (m.map) { m.map = null; m.needsUpdate = true; }
  if (m.emissiveMap !== opts.texture) { m.emissiveMap = opts.texture; m.needsUpdate = true; }
  m.emissive.copy(live && opts.tint ? opts.tint : WHITE);
  m.emissiveIntensity = live ? (opts.brightness ?? 1) : 1;
  updateLedSurface(m, { mode: opts.mode, ...(live ? {} : { on: false }) });
}
