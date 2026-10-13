// 地板倒影（現場模式）：three.js Reflector 的鏡像相機做法，但不另外放鏡子 mesh —
// 把倒影「注入」到既有的地板材質：片段落在反射平面上、而且朝上時，取樣鏡像 render target。
//   - 鏡像 RT 半解析度 + mipmap → 依清晰度 / 粗糙度選 mip 當模糊
//   - Fresnel：越斜看越亮（真的亮面地板就是這樣）
//   - 畫倒影那一次把 uReflOn 關掉，避免讀寫同一張 RT（WebGL feedback loop）

import * as THREE from 'three';

export interface FloorReflectionUniforms {
  uReflOn: { value: number };
  uReflMap: { value: THREE.Texture | null };
  uReflTexMatrix: { value: THREE.Matrix4 };
  uReflPlaneY: { value: number };
  uReflEps: { value: number };
  uReflStrength: { value: number };
  uReflSharpness: { value: number };
  uReflMaxLod: { value: number };
}

export function createFloorReflectionUniforms(): FloorReflectionUniforms {
  return {
    uReflOn: { value: 0 },
    uReflMap: { value: null },
    uReflTexMatrix: { value: new THREE.Matrix4() },
    uReflPlaneY: { value: 0 },
    uReflEps: { value: 0.001 },
    uReflStrength: { value: 0.5 },
    uReflSharpness: { value: 0.6 },
    uReflMaxLod: { value: 8 },
  };
}

const VERT_DECL = 'varying vec3 vReflWorldPos;\n';
const VERT_CODE = '\nvReflWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n';

const FRAG_DECL = /* glsl */`
varying vec3 vReflWorldPos;
uniform float uReflOn;
uniform sampler2D uReflMap;
uniform mat4 uReflTexMatrix;
uniform float uReflPlaneY;
uniform float uReflEps;
uniform float uReflStrength;
uniform float uReflSharpness;
uniform float uReflMaxLod;
uniform float uReflMaterialOn;
`;

const FRAG_CODE = /* glsl */`
if ( uReflOn > 0.5 && uReflMaterialOn > 0.5 ) {
  vec3 reflWorldN = inverseTransformDirection( normal, viewMatrix );
  if ( reflWorldN.y > 0.95 && abs( vReflWorldPos.y - uReflPlaneY ) < uReflEps ) {
    vec4 reflUv = uReflTexMatrix * vec4( vReflWorldPos, 1.0 );
    // 清晰度低 / 材質粗 → 取比較模糊的 mip
    float reflBlur = clamp( ( 1.0 - uReflSharpness ) * 0.8 + material.roughness * 0.3, 0.0, 1.0 );
    vec3 reflColor = textureLod( uReflMap, reflUv.xy / reflUv.w, reflBlur * uReflMaxLod ).rgb;
    float reflNdv = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
    float reflFresnel = 0.04 + 0.96 * pow( 1.0 - reflNdv, 5.0 );
    reflectedLight.indirectSpecular += reflColor * uReflStrength * mix( 0.35, 1.0, reflFresnel );
  }
}
`;

export function patchFloorShader(
  shader: { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string },
  uniforms: FloorReflectionUniforms,
  materialOn: { value: number } = { value: 1 },
) {
  Object.assign(shader.uniforms, uniforms);
  // 每個材質自己的開關（材質面板勾了「鏡面地板」時，沒勾的材質不反光）
  shader.uniforms.uReflMaterialOn = materialOn;
  shader.vertexShader = VERT_DECL + shader.vertexShader.replace(
    '#include <worldpos_vertex>', '#include <worldpos_vertex>' + VERT_CODE,
  );
  shader.fragmentShader = FRAG_DECL + shader.fragmentShader.replace(
    '#include <aomap_fragment>', FRAG_CODE + '#include <aomap_fragment>',
  );
}

export function applyFloorReflection(material: THREE.MeshStandardMaterial, uniforms: FloorReflectionUniforms) {
  if (material.userData.floorReflection) return;
  material.userData.floorReflection = true;
  const materialOn = { value: 1 };
  material.userData.reflMaterialOn = materialOn;
  material.onBeforeCompile = (shader) => patchFloorShader(shader, uniforms, materialOn);
  material.customProgramCacheKey = () => 'floor-refl-v1';
  material.needsUpdate = true;
}

/** 這個材質要不要反光（沒套過倒影的材質會略過） */
export function setFloorReflectionFor(material: THREE.Material, on: boolean) {
  const u = material.userData.reflMaterialOn as { value: number } | undefined;
  if (u) u.value = on ? 1 : 0;
}

const _planeNormal = new THREE.Vector3(0, 1, 0);
const _planePoint = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _view = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _lookAt = new THREE.Vector3();
const _target = new THREE.Vector3();
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();

/** 依主相機算鏡像相機 + 倒影貼圖矩陣（three.js Reflector 同一套數學）；相機在地板下 → false */
export function computeMirrorCamera(
  camera: THREE.PerspectiveCamera, planeY: number,
  virtualCamera: THREE.PerspectiveCamera, textureMatrix: THREE.Matrix4, clipBias = 0.0001,
): boolean {
  camera.updateMatrixWorld();
  _camPos.setFromMatrixPosition(camera.matrixWorld);
  _planePoint.set(_camPos.x, planeY, _camPos.z);
  _view.subVectors(_planePoint, _camPos);
  if (_view.dot(_planeNormal) > 0) return false;
  _view.reflect(_planeNormal).negate().add(_planePoint);

  _rot.extractRotation(camera.matrixWorld);
  _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
  _target.subVectors(_planePoint, _lookAt).reflect(_planeNormal).negate().add(_planePoint);

  virtualCamera.position.copy(_view);
  virtualCamera.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_planeNormal);
  virtualCamera.lookAt(_target);
  virtualCamera.near = camera.near;
  virtualCamera.far = camera.far;
  virtualCamera.updateMatrixWorld();
  virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

  textureMatrix.set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0,
  );
  textureMatrix.multiply(virtualCamera.projectionMatrix);
  textureMatrix.multiply(virtualCamera.matrixWorldInverse);

  // oblique 近平面：只畫地板以上的東西
  _plane.setFromNormalAndCoplanarPoint(_planeNormal, _planePoint);
  _plane.applyMatrix4(virtualCamera.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const pm = virtualCamera.projectionMatrix;
  _q.x = (Math.sign(_clip.x) + pm.elements[8]) / pm.elements[0];
  _q.y = (Math.sign(_clip.y) + pm.elements[9]) / pm.elements[5];
  _q.z = -1.0;
  _q.w = (1.0 + pm.elements[10]) / pm.elements[14];
  _clip.multiplyScalar(2.0 / _clip.dot(_q));
  pm.elements[2] = _clip.x;
  pm.elements[6] = _clip.y;
  pm.elements[10] = _clip.z + 1.0 - clipBias;
  pm.elements[14] = _clip.w;
  return true;
}

export class FloorReflection {
  readonly uniforms = createFloorReflectionUniforms();
  private rt: THREE.WebGLRenderTarget;
  private virtualCamera = new THREE.PerspectiveCamera();
  private planeY: number | null = null;
  private enabled = false;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.rt = new THREE.WebGLRenderTarget(512, 256, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.uniforms.uReflMap.value = this.rt.texture;
    this.updateMaxLod();
  }

  setPlane(y: number | null, eps: number) {
    this.planeY = y;
    if (y !== null) this.uniforms.uReflPlaneY.value = y;
    this.uniforms.uReflEps.value = eps;
  }

  setSettings(strength: number, sharpness: number) {
    this.uniforms.uReflStrength.value = strength;
    this.uniforms.uReflSharpness.value = sharpness;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.uniforms.uReflOn.value = 0;
  }

  setSize(w: number, h: number) {
    this.rt.setSize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    this.updateMaxLod();
  }

  /** 每幀在主畫面之前呼叫 */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    if (!this.enabled || this.planeY === null || this.uniforms.uReflStrength.value <= 0) {
      this.uniforms.uReflOn.value = 0;
      return;
    }
    if (!computeMirrorCamera(camera, this.planeY, this.virtualCamera, this.uniforms.uReflTexMatrix.value)) {
      this.uniforms.uReflOn.value = 0;
      return;
    }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevXr = r.xr.enabled;
    this.uniforms.uReflOn.value = 0; // 畫倒影時地板不取樣自己
    r.xr.enabled = false;
    r.setRenderTarget(this.rt);
    r.state.buffers.depth.setMask(true);
    r.clear();
    r.render(scene, this.virtualCamera);
    r.xr.enabled = prevXr;
    r.setRenderTarget(prevTarget);
    this.uniforms.uReflOn.value = 1;
  }

  dispose() {
    this.rt.dispose();
  }

  private updateMaxLod() {
    this.uniforms.uReflMaxLod.value = Math.max(0, Math.floor(Math.log2(Math.max(this.rt.width, this.rt.height))) - 1);
  }
}
