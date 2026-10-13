# 現場模式 第三段（地板倒影）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現場模式下舞台地板（最大的朝上水平面）映出 LED 和舞台的倒影，強度 / 清晰度可調；iPad 預設關。

**Architecture:**
- `floorPlane.ts`：在世界座標找面積最大的朝上水平面高度（第四段材質面板做好後改成「勾選鏡面地板的材質」）。
- `floorReflection.ts`：three.js `Reflector` 的鏡像相機數學（反射位置 / up、oblique 近平面裁切），每幀把場景從鏡像相機畫進半解析度、有 mipmap 的 render target；非 LED 材質用 `onBeforeCompile` 注入：片段落在反射平面上且朝上時，用 texture matrix 投影取樣倒影，依清晰度 / 粗糙度選 mip（模糊），用 Fresnel 加到 indirectSpecular。畫倒影那一次把取樣關掉（避免讀寫同一張 RT）。
- StageScene 接線；現場設定新增 `floorReflection`（倒影強度），面板加「地板倒影」「倒影清晰度」。

**Tech Stack:** three.js r169（WebGLRenderTarget mipmaps、textureLod、oblique clip）、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-13-live-stage-look-design.md`（第 5 節；鏡面地板材質勾選延到第四段）

## Global Constraints

- 只在現場模式畫倒影；快速模式完全不受影響（`uReflOn = 0`）。
- 低畫質檔（iPad）預設不畫倒影（`reflectionScale = 0`）；桌機半解析度（0.5）。
- `floorReflection` 範圍 0~1、預設 0.5；前後端 `LOOK_SETTING_RANGES` 都要加（worker 還沒上線，跟 0014 一起）。
- 不能有新的 console error / WebGL feedback loop 警告。

---

### Task 1: 找地板高度（floorPlane）

**Files:**
- Create: `web/src/lib/stageLook/floorPlane.ts`
- Test: `web/src/lib/stageLook/floorPlane.test.ts`

**Interfaces:**
- Produces: `detectFloorPlane(roots: THREE.Object3D[], opts?: { minUpDot?: number; binSize?: number }): { y: number; area: number } | null`

- [ ] **Step 1: 寫失敗的測試**

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { detectFloorPlane } from './floorPlane';

function floor(w: number, d: number, y: number) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial());
  m.rotation.x = -Math.PI / 2; // 朝上
  m.position.y = y;
  m.updateMatrixWorld(true);
  return m;
}

describe('detectFloorPlane', () => {
  it('單一朝上平面 → 它的高度', () => {
    const p = detectFloorPlane([floor(4, 4, 2)]);
    expect(p).not.toBeNull();
    expect(p!.y).toBeCloseTo(2);
    expect(p!.area).toBeCloseTo(16);
  });

  it('多個平面 → 面積最大的那個', () => {
    const p = detectFloorPlane([floor(10, 10, 0), floor(2, 2, 1)]);
    expect(p!.y).toBeCloseTo(0);
  });

  it('只有牆 / 朝下的天花板 → null', () => {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial());
    const ceiling = floor(4, 4, 3);
    ceiling.rotation.x = Math.PI / 2; // 朝下
    ceiling.updateMatrixWorld(true);
    expect(detectFloorPlane([wall, ceiling])).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**：`cd web && npx vitest run src/lib/stageLook/floorPlane.test.ts` → FAIL（找不到模組）

- [ ] **Step 3: 實作**

```ts
// 找舞台地板：世界座標裡面積最大的「朝上水平面」高度 → 地板倒影的反射平面
// （第四段材質面板做好後，改成優先用使用者勾選「鏡面地板」的材質）

import * as THREE from 'three';

export function detectFloorPlane(
  roots: THREE.Object3D[], opts: { minUpDot?: number; binSize?: number } = {},
): { y: number; area: number } | null {
  const minUpDot = opts.minUpDot ?? 0.95;
  const tris: { y: number; area: number }[] = [];
  const box = new THREE.Box3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || !mesh.visible) return;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const mw = mesh.matrixWorld;
      const flip = mw.determinant() < 0;
      const index = geo.getIndex();
      const count = index ? index.count : pos.count;
      const at = (i: number) => (index ? index.getX(i) : i);
      for (let i = 0; i + 2 < count; i += 3) {
        a.fromBufferAttribute(pos, at(i)).applyMatrix4(mw);
        b.fromBufferAttribute(pos, at(i + 1)).applyMatrix4(mw);
        c.fromBufferAttribute(pos, at(i + 2)).applyMatrix4(mw);
        box.expandByPoint(a); box.expandByPoint(b); box.expandByPoint(c);
        n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
        const area = n.length() / 2;
        if (area < 1e-12) continue;
        n.normalize();
        if (flip) n.negate();
        if (n.y < minUpDot) continue;
        tris.push({ y: (a.y + b.y + c.y) / 3, area });
      }
    });
  }
  if (tris.length === 0) return null;
  const size = box.getSize(new THREE.Vector3()).length();
  const binSize = opts.binSize ?? Math.max(size / 400, 1e-6);
  const bins = new Map<number, { area: number; ySum: number }>();
  for (const t of tris) {
    const k = Math.round(t.y / binSize);
    const bin = bins.get(k) || { area: 0, ySum: 0 };
    bin.area += t.area;
    bin.ySum += t.y * t.area;
    bins.set(k, bin);
  }
  let best: { area: number; ySum: number } | null = null;
  for (const bin of bins.values()) if (!best || bin.area > best.area) best = bin;
  return best ? { y: best.ySum / best.area, area: best.area } : null;
}
```

- [ ] **Step 4: 跑測試確認通過**（3 tests）

- [ ] **Step 5: Commit** `feat(stage-look): 找舞台地板高度（最大朝上水平面）`

---

### Task 2: 地板倒影模組（floorReflection）

**Files:**
- Create: `web/src/lib/stageLook/floorReflection.ts`
- Test: `web/src/lib/stageLook/floorReflection.test.ts`

**Interfaces:**
- Produces:
  - `interface FloorReflectionUniforms { uReflOn; uReflMap; uReflTexMatrix; uReflPlaneY; uReflEps; uReflStrength; uReflSharpness; uReflMaxLod }`（皆 `{ value }`）
  - `createFloorReflectionUniforms(): FloorReflectionUniforms`
  - `patchFloorShader(shader: { uniforms; vertexShader: string; fragmentShader: string }, uniforms): void`
  - `applyFloorReflection(material: THREE.MeshStandardMaterial, uniforms): void`（冪等，cache key `floor-refl-v1`）
  - `computeMirrorCamera(camera: THREE.PerspectiveCamera, planeY: number, virtualCamera: THREE.PerspectiveCamera, textureMatrix: THREE.Matrix4, clipBias?: number): boolean`
  - `class FloorReflection { readonly uniforms; constructor(renderer: THREE.WebGLRenderer); setPlane(y: number | null, eps: number): void; setSettings(strength: number, sharpness: number): void; setEnabled(on: boolean): void; setSize(w: number, h: number): void; render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void; dispose(): void }`

- [ ] **Step 1: 寫失敗的測試**

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyFloorReflection, computeMirrorCamera, createFloorReflectionUniforms, patchFloorShader } from './floorReflection';

describe('patchFloorShader', () => {
  it('vertex 加世界座標 varying、fragment 在 aomap 前加倒影', () => {
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: 'void main() {\n#include <worldpos_vertex>\n}',
      fragmentShader: 'void main() {\n#include <lights_fragment_end>\n#include <aomap_fragment>\n}',
    };
    patchFloorShader(shader, createFloorReflectionUniforms());
    expect(shader.vertexShader).toContain('vReflWorldPos =');
    const refl = shader.fragmentShader.indexOf('uReflOn > 0.5');
    expect(refl).toBeGreaterThan(shader.fragmentShader.indexOf('#include <lights_fragment_end>'));
    expect(refl).toBeLessThan(shader.fragmentShader.indexOf('#include <aomap_fragment>'));
    expect(shader.uniforms.uReflMap).toBeDefined();
  });
});

describe('applyFloorReflection', () => {
  it('冪等、cache key 固定', () => {
    const m = new THREE.MeshStandardMaterial();
    const u = createFloorReflectionUniforms();
    applyFloorReflection(m, u);
    const first = m.onBeforeCompile;
    applyFloorReflection(m, u);
    expect(m.onBeforeCompile).toBe(first);
    expect(m.customProgramCacheKey()).toBe('floor-refl-v1');
  });
});

describe('computeMirrorCamera', () => {
  function cam(pos: [number, number, number], look: [number, number, number]) {
    const c = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    c.position.set(...pos);
    c.lookAt(...look);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  }

  it('鏡像相機在地板下方對稱的位置', () => {
    const c = cam([0, 5, 10], [0, 0, 0]);
    const v = new THREE.PerspectiveCamera();
    const tm = new THREE.Matrix4();
    expect(computeMirrorCamera(c, 1, v, tm)).toBe(true);
    expect(v.position.x).toBeCloseTo(0);
    expect(v.position.y).toBeCloseTo(-3);
    expect(v.position.z).toBeCloseTo(10);
  });

  it('地板上看到 Q 倒影的那一點，取樣到的正是 Q 在倒影圖裡的位置', () => {
    const c = cam([2, 4, 8], [0, 0, 0]);
    const v = new THREE.PerspectiveCamera();
    const tm = new THREE.Matrix4();
    computeMirrorCamera(c, 0, v, tm);
    // 地板上方的點 Q，鏡像點 Q'；主相機往 Q' 看的視線跟地板交點 P = 看到 Q 倒影的位置
    const q = new THREE.Vector3(0.5, 1.5, -2);
    const qMirror = new THREE.Vector3(q.x, -q.y, q.z);
    const t = c.position.y / (c.position.y - qMirror.y);
    const p = c.position.clone().lerp(qMirror, t);
    expect(p.y).toBeCloseTo(0);
    const uv = (w: THREE.Vector3) => {
      const h = new THREE.Vector4(w.x, w.y, w.z, 1).applyMatrix4(tm);
      return [h.x / h.w, h.y / h.w];
    };
    const [pu, pv] = uv(p);
    const [qu, qv] = uv(q);
    expect(pu).toBeCloseTo(qu, 4);
    expect(pv).toBeCloseTo(qv, 4);
  });

  it('相機在地板下面 → 不畫', () => {
    const c = cam([0, -2, 5], [0, 0, 0]);
    expect(computeMirrorCamera(c, 0, new THREE.PerspectiveCamera(), new THREE.Matrix4())).toBe(false);
  });
});
```

（倒影圖本身左右是翻的，所以不測「跟主相機螢幕位置一樣」，而是測「看到 Q 倒影的地板點 P 取樣到 Q」。）

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作** `web/src/lib/stageLook/floorReflection.ts`

```ts
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
`;

const FRAG_CODE = /* glsl */`
if ( uReflOn > 0.5 ) {
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
) {
  Object.assign(shader.uniforms, uniforms);
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
  material.onBeforeCompile = (shader) => patchFloorShader(shader, uniforms);
  material.customProgramCacheKey = () => 'floor-refl-v1';
  material.needsUpdate = true;
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
```

- [ ] **Step 4: 跑測試確認通過**（5 tests）

- [ ] **Step 5: Commit** `feat(stage-look): 地板倒影模組（鏡像相機 + 注入地板材質）`

---

### Task 3: 設定 + 畫質 + StageScene 接線

**Files:**
- Modify: `web/src/lib/stageLook/lookSettings.ts`（加 `floorReflection`）＋ test
- Modify: `cf-worker/worker.js`（`LOOK_SETTING_RANGES` 加 `floorReflection: [0, 1]`）
- Modify: `web/src/lib/stageLook/quality.ts`（`reflectionScale`: high 0.5、low 0）＋ test
- Modify: `web/src/components/LookSettingsPanel.tsx`（加「地板倒影」「倒影清晰度」）
- Modify: `web/src/components/StageScene.tsx`

- [ ] **Step 1: lookSettings** — `LookSettings` 加 `floorReflection: number;`（註解：地板倒影強度），`LOOK_SETTING_RANGES.floorReflection = [0, 1]`，`DEFAULT_LOOK_SETTINGS.floorReflection = 0.5`；測試加一條「floorReflection 預設 0.5、超出夾回 1」。worker 的 `LOOK_SETTING_RANGES` 同步加。

- [ ] **Step 2: quality** — `QualitySpec` 加 `reflectionScale: number`（倒影 RT 解析度比例，0 = 不畫）；high 0.5、low 0；測試加一條「low 檔 reflectionScale 是 0」。

- [ ] **Step 3: 面板** — `ROWS` 加：

```ts
  { key: 'floorReflection', label: '地板倒影', hint: '亮面地板映出 LED 的強度（0 = 關）', step: 0.05 },
  { key: 'reflectionSharpness', label: '倒影清晰度', hint: '倒影清楚還是模糊', step: 0.05 },
```

- [ ] **Step 4: StageScene**
  - import `FloorReflection, applyFloorReflection` 與 `detectFloorPlane`。
  - ref：`const floorReflRef = useRef<FloorReflection | null>(null);`
  - mount：`ledEnvRef` 建好後 `floorReflRef.current = new FloorReflection(renderer);`；cleanup dispose。
  - resize：`const rs = qualityRef.current.reflectionScale; if (rs > 0) floorReflRef.current?.setSize(w * rs, h * rs);`
  - render loop：`if (live && composerRef.current && !inXR)` 之前加 `if (live && !inXR) floorReflRef.current?.render(scene, camera);`
  - render mode effect：`floorReflRef.current?.setSettings(look.floorReflection, look.reflectionSharpness); floorReflRef.current?.setEnabled(live && qualityRef.current.reflectionScale > 0);`
  - 材質 effect：非 LED 的兩個分支（快速 LED 分支除外、一般物件分支）在 `updateLedSurface(m, { on: false });` 後加 `if (!isLed && floorReflRef.current) applyFloorReflection(m, floorReflRef.current.uniforms);`
  - 找地板：新 effect（放在材質 effect 後面）：

```ts
  // ── 地板倒影：找最大的朝上水平面當反射平面（換模型 / 物件移動後重算）──
  useEffect(() => {
    const refl = floorReflRef.current;
    if (!refl) return;
    const roots: THREE.Object3D[] = [];
    meshesRef.current.forEach((obj, id) => {
      if (stageObjMap.get(id)?.category !== 'led_panel') roots.push(obj);
    });
    const plane = detectFloorPlane(roots);
    refl.setPlane(plane ? plane.y : null, Math.max(stageBoundsRef.current.radius * 0.002, 1e-4));
  }, [states, modelVersion]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 5:** `npx tsc -b`、`npx vitest run`、`npm run build` 全過 → Commit `feat(stage-scene): 現場模式地板倒影（強度 / 清晰度可調，iPad 預設關）`

---

### Task 4: 實機驗證

- [ ] 主舞臺現場模式：地板映出 LED（顏色 / 位置對，倒影在 LED 正下方延伸）
- [ ] 「地板倒影」拉 0 → 倒影消失；「倒影清晰度」拉高 → 清楚、拉低 → 模糊
- [ ] 相機移到地板下方 → 不畫倒影、不出錯
- [ ] 2026 金曲獎同樣檢查
- [ ] 快速模式沒有倒影；console 沒有 error / feedback loop 警告
- [ ] 截圖給用戶；依回饋調強度公式後 commit
