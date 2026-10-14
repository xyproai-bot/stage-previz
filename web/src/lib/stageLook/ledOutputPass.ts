// 現場模式最後一步（取代 three 的 OutputPass）：tone mapping + 曝光 + 轉 sRGB，但 LED 畫面照原檔
//   - LED shader 在主畫面那一次把 alpha 寫成 0（ledSurface.ts 的 uLedMaskOut）→ 這裡看到 alpha 0 就不壓色、不乘曝光，
//     只轉 sRGB → 正面看 LED 的像素 = 原檔的像素
//   - 舞台其他地方（alpha 1）跟以前一模一樣：Neutral tone mapping + 曝光
//   - 光暈：UnrealBloomPass 原本最後一步是把光暈「加回」畫面（additive，SRC_ALPHA × ONE）；改在這裡加，
//     加在 LED 上的那一份照相機曲線算（= 旁邊舞台同樣多的光暈看起來一樣亮，LED 邊上不會有一條接縫）。
//     光暈本身（抓亮的地方、模糊）沒改；少畫一次全畫面的加法
//   數學跟 ledColorMath.ts 的 outputPassLinear 一樣（有單元測試）。

import type * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export const LED_OUTPUT_FRAGMENT = /* glsl */`
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uBloomOn;

#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>

varying vec2 vUv;

vec3 stageToneMap( vec3 color ) {
  #ifdef LINEAR_TONE_MAPPING
    return LinearToneMapping( color );
  #elif defined( REINHARD_TONE_MAPPING )
    return ReinhardToneMapping( color );
  #elif defined( CINEON_TONE_MAPPING )
    return CineonToneMapping( color );
  #elif defined( ACES_FILMIC_TONE_MAPPING )
    return ACESFilmicToneMapping( color );
  #elif defined( AGX_TONE_MAPPING )
    return AgXToneMapping( color );
  #elif defined( NEUTRAL_TONE_MAPPING )
    return NeutralToneMapping( color );
  #else
    return color;
  #endif
}

void main() {
  vec4 src = texture2D( tDiffuse, vUv );
  vec3 bloom = vec3( 0.0 );
  if ( uBloomOn > 0.5 ) {
    vec4 b = texture2D( tBloom, vUv );
    bloom = b.rgb * b.a;
  }
  vec3 lit = stageToneMap( src.rgb + bloom );
  // LED 畫面：原檔顏色 + 光暈照相機曲線多亮了多少
  vec3 led = src.rgb + max( lit - stageToneMap( src.rgb ), 0.0 );
  float ledMask = 1.0 - clamp( src.a, 0.0, 1.0 );
  gl_FragColor = vec4( mix( lit, led, ledMask ), 1.0 );
  #ifdef SRGB_TRANSFER
    gl_FragColor = sRGBTransferOETF( gl_FragColor );
  #endif
}
`;

type Uniforms = Record<string, THREE.IUniform>;

export class LedOutputPass extends OutputPass {
  private bloom: UnrealBloomPass | null;

  constructor(bloom: UnrealBloomPass | null) {
    super();
    this.bloom = bloom;
    const u = this.uniforms as Uniforms;
    u.tBloom = { value: null };
    u.uBloomOn = { value: 0 };
    this.material.fragmentShader = LED_OUTPUT_FRAGMENT;
    this.material.needsUpdate = true;
    // 光暈改在這裡加：關掉 UnrealBloomPass 最後那一次加回畫面（材質不畫 = 那一步直接跳過）
    if (bloom) bloom.blendMaterial.visible = false;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    const u = this.uniforms as Uniforms;
    const b = this.bloom;
    const on = !!b && b.enabled;
    u.uBloomOn.value = on ? 1 : 0;
    u.tBloom.value = on ? b.renderTargetsHorizontal[0].texture : null;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
