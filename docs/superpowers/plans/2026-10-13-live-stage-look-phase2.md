# 現場模式 第二段（LED 面板質感）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現場模式下 LED 面板像真的 LED 牆：靠近看得到像素顆粒（遠了自然淡出不出摩爾紋）、畫面暗的地方是會反光的黑亮面、側邊看會變暗（可調）。

**Architecture:** 新增 `web/src/lib/stageLook/ledSurface.ts`：用 `onBeforeCompile` 在 MeshStandardMaterial 的 `emissivemap_fragment` 後面插 GLSL（像素遮罩 + 視角衰減），uniform 放 `material.userData.ledSurface`。StageScene 現場 LED 分支把底色改黑亮（roughness 0.3、envMapIntensity 0.5，反射靠第一段的 LED 環境光），並在 100ms 取色迴圈裡更新每個 LED 材質的 uniform（貼圖解析度、側看衰減）。

**Tech Stack:** three.js r169（`vEmissiveMapUv`、`fwidth`、WebGL2）、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-13-live-stage-look-design.md`（第 4 節）

## Global Constraints

- 只影響現場模式的 LED（注入的程式碼包在 `#ifdef USE_EMISSIVEMAP` 且 `uLedOn > 0.5`；快速模式 LED 用 `map` 不用 emissiveMap → 不受影響）。
- NDI helper 預設把畫面縮小一半送出 → NDI live 貼圖的一個像素 = 2×2 顆 LED（`NDI_PIXEL_DENSITY = 2`）；自訂圖片 = 1；mock 動態貼圖不畫像素格。
- 側看衰減用現場設定 `ledViewFalloff`（0~1，預設 0.3），加進 🎚 設定面板。
- 不能有新的 console error；Quick 模式畫面不變。

---

### Task 1: LED 表面 shader 模組（ledSurface）

**Files:**
- Create: `web/src/lib/stageLook/ledSurface.ts`
- Test: `web/src/lib/stageLook/ledSurface.test.ts`

**Interfaces:**
- Produces:
  - `LED_SURFACE = { baseColor: 0x050505, roughness: 0.3, envMapIntensity: 0.5, gridFill: 0.72 }`
  - `NDI_PIXEL_DENSITY = 2`
  - `interface LedSurfaceParams { on: boolean; texels: [number, number]; gridStrength: number; viewFalloff: number }`
  - `patchLedShader(shader: { uniforms: Record<string, { value: unknown }>; fragmentShader: string }, uniforms: LedSurfaceUniforms): void`
  - `applyLedSurface(material: THREE.MeshStandardMaterial): void`（冪等）
  - `updateLedSurface(material: THREE.MeshStandardMaterial, params: Partial<LedSurfaceParams>): void`

- [ ] **Step 1: 寫失敗的測試** — `web/src/lib/stageLook/ledSurface.test.ts`

```ts
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd web && npx vitest run src/lib/stageLook/ledSurface.test.ts`
Expected: FAIL（找不到 `./ledSurface`）

- [ ] **Step 3: 實作** — `web/src/lib/stageLook/ledSurface.ts`

```ts
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd web && npx vitest run src/lib/stageLook/ledSurface.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/stageLook/ledSurface.ts web/src/lib/stageLook/ledSurface.test.ts
git commit -m "feat(stage-look): LED 表面 shader（像素顆粒 + 側看變暗）"
```

---

### Task 2: 接進 StageScene + 設定面板

**Files:**
- Modify: `web/src/components/StageScene.tsx`
- Modify: `web/src/components/LookSettingsPanel.tsx`

**Interfaces:**
- Consumes: Task 1 全部；第一段的 `lookRef`、`ledSourcesRef`、render loop 100ms 取色區塊

- [ ] **Step 1: import**

```ts
import { LED_SURFACE, NDI_PIXEL_DENSITY, applyLedSurface, updateLedSurface } from '../lib/stageLook/ledSurface';
```

- [ ] **Step 2: refs** — 在 `ledLightPropsRef` 旁加：

```ts
  // 現場模式的 LED 材質（每 100ms 更新像素格 / 側看衰減）
  const ledMaterialsRef = useRef<Set<THREE.MeshStandardMaterial>>(new Set());
```

- [ ] **Step 3: 材質 effect 的現場 LED 分支**（`if (isLed && isLit) {`）

把開頭的

```ts
          m.color.setHex(0x000000);
          m.metalness = 0;
          m.roughness = 1;
          m.envMapIntensity = 0;
```

換成

```ts
          // 黑亮面：畫面暗的地方像真的 LED 面板會反光（反射來自 LED 環境光）
          m.color.setHex(LED_SURFACE.baseColor);
          m.metalness = 0;
          m.roughness = LED_SURFACE.roughness;
          m.envMapIntensity = LED_SURFACE.envMapIntensity;
          applyLedSurface(m);
          ledMaterials.add(m);
```

並把這段上面的註解改成描述新的行為（黑亮底 + 自發光 + 像素格 / 側看由 ledSurface shader 處理）。

在快速 LED 分支（`} else if (isLed && ledTexture) {`）與一般物件分支開頭各加一行：

```ts
          updateLedSurface(m, { on: false });
```

- [ ] **Step 4: effect 開頭 / 結尾**

`const ledIds = new Set<string>();` 下面加：

```ts
    const ledMaterials = new Set<THREE.MeshStandardMaterial>();
```

effect 結尾（`ledRigRef.current?.retainObjects(ledIds);` 前）加：

```ts
    ledMaterialsRef.current = ledMaterials;
```

`ledSourcesRef` 記錄時多存貼圖種類：把

```ts
        ledSourcesRef.current.set(id, ledTexture
          ? { image: ledTexture.image as CanvasImageSource, flipY: ledTexture.flipY }
          : null);
```

保持不變（取色用），另外在 render loop 用材質本身的 emissiveMap 判斷密度（Step 5）。

- [ ] **Step 5: render loop 100ms 區塊**（`rig.updateColors(...)` 後面）加：

```ts
          // LED 表面：像素格密度跟著貼圖解析度、側看衰減跟著現場設定
          const liveTexture = ndiLiveTextureRef.current?.texture;
          const mockTexture = ndiMockTextureRef.current?.texture;
          for (const mat of ledMaterialsRef.current) {
            const tex = mat.emissiveMap;
            const img = tex?.image as { width?: number; height?: number } | undefined;
            const density = tex && tex === liveTexture ? NDI_PIXEL_DENSITY : 1;
            updateLedSurface(mat, {
              on: !!tex,
              texels: [(img?.width || 1) * density, (img?.height || 1) * density],
              gridStrength: tex && tex !== mockTexture ? 1 : 0,
              viewFalloff: lookRef.current.ledViewFalloff,
            });
          }
```

離開現場模式時要關掉：render mode effect 裡 `ledRigRef.current?.setEnabled(live);` 後面加：

```ts
    if (!live) for (const mat of ledMaterialsRef.current) updateLedSurface(mat, { on: false });
```

- [ ] **Step 6: 設定面板加「LED 側看變暗」** — `LookSettingsPanel.tsx` 的 `ROWS` 最後加：

```ts
  { key: 'ledViewFalloff', label: 'LED 側看變暗', hint: '從側邊看 LED 會暗多少（真的 LED 牆側看會變暗）', step: 0.05 },
```

- [ ] **Step 7: 型別 / 測試 / build**

Run: `cd web && npx tsc -b 2>&1 | grep -v TS6310; npx vitest run; npm run build 2>&1 | grep -E "error|built"`
Expected: tsc 沒輸出、vitest 全過、`✓ built`

- [ ] **Step 8: Commit**

```bash
git add web/src/components/StageScene.tsx web/src/components/LookSettingsPanel.tsx
git commit -m "feat(stage-scene): 現場模式 LED 面板質感（像素顆粒 / 黑亮面 / 側看變暗）"
```

---

### Task 3: 實機驗證

- [ ] **Step 1:** dev server + 用戶 NDI（AE）開主舞臺管理頁，切 🎤 現場。
- [ ] **Step 2:** 拉近到一片 LED → 看得到顆粒、顆粒之間黑縫；拉遠 → 顆粒淡出、沒有摩爾紋 / 閃爍條紋。
- [ ] **Step 3:** 從側邊看 LED → 比正面暗；設定面板「LED 側看變暗」拉到 0 → 側看跟正面一樣亮。
- [ ] **Step 4:** 畫面黑的地方（例如中隔幕）→ 是黑亮面，看得到其他 LED 的反光。
- [ ] **Step 5:** 切回 ⚡ 快速 → LED 像素 1:1、沒有顆粒、跟以前一樣。
- [ ] **Step 6:** console 沒有新的 error（特別是 shader compile error）。
- [ ] **Step 7:** 截圖給用戶（遠景 + 近看顆粒 + 側看），依回饋調 `LED_SURFACE` / 閾值後 commit。
