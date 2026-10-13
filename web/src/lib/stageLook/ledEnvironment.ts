// 動態 LED 環境光：在舞台中央放一台 CubeCamera，只拍 LED（LED_LAYER），
// 烘成 PMREM 後當 scene.environment →
//   1. 亮面材質會映出 LED 畫面
//   2. 所有物件被 LED 的顏色微微染色（漫反射環境光）
// 取代原本的 RoomEnvironment（明亮攝影棚，會讓舞台像白天的石膏模型）。

import * as THREE from 'three';

/** LED mesh 要 layers.enable(LED_LAYER)，CubeCamera 只拍這層 */
export const LED_LAYER = 2;

export class LedEnvironment {
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCamera: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private black = new THREE.Color(0x000000);

  constructor(private renderer: THREE.WebGLRenderer, size = 128) {
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
    this.cubeCamera = new THREE.CubeCamera(0.01, 1000, this.cubeRT);
    // CubeCamera 的 6 台子相機共用這個 layers 物件
    this.cubeCamera.layers.set(LED_LAYER);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  get texture(): THREE.Texture | null {
    return this.envRT?.texture ?? null;
  }

  /** center = 舞台中心；radius = 舞台大小（決定 near / far） */
  update(scene: THREE.Scene, center: THREE.Vector3, radius: number): THREE.Texture {
    const near = Math.max(0.001, radius / 1000);
    const far = Math.max(10, radius * 20);
    for (const child of this.cubeCamera.children) {
      const cam = child as THREE.PerspectiveCamera;
      if (cam.near !== near || cam.far !== far) {
        cam.near = near;
        cam.far = far;
        cam.updateProjectionMatrix();
      }
    }
    this.cubeCamera.position.copy(center);
    this.cubeCamera.updateMatrixWorld(true);

    const prevEnv = scene.environment;
    const prevBg = scene.background;
    scene.environment = null;
    scene.background = this.black;
    this.cubeCamera.update(this.renderer, scene);
    scene.environment = prevEnv;
    scene.background = prevBg;

    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    return this.envRT.texture;
  }

  dispose() {
    this.cubeRT.dispose();
    this.envRT?.dispose();
    this.envRT = null;
    this.pmrem.dispose();
  }
}
