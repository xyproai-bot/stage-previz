# 現場模式 第四段（材質面板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 舞台材質不再被洗成同一種塑膠：預設就是 C4D 匯出的樣子；admin 可以依 C4D 材質名稱調顏色 / 亮霧面 / 金屬感 / 反射 / 透明度，並勾選哪些材質是「鏡面地板」。全專案共用。

**Architecture:**
- `materialOverrides.ts`（純邏輯）：型別、範圍、`normalizeMaterialOverrides`、`captureOriginal`（第一次碰到材質時記下 GLB 原值）、`applyMaterialSettings`（原值 → 依名稱覆寫 → 舊的單一物件 materialProps 最優先）。
- `floorReflection.ts` 加每個材質自己的開關 uniform；`floorPlane.ts` 加 `meshFilter`。有任何材質勾「鏡面地板」→ 只有那些材質反光、反射平面從它們找；都沒勾 → 維持第三段的自動判斷。
- 後台 `projects.material_overrides`（加進尚未上線的 0014），admin 限定、拖動不寫 activity；分享頁也帶。
- `useProjectViewSettings` 加 `materialOverrides` / `setMaterialOverride(name, patch | null)`（防抖合併存）。
- `MaterialPanel.tsx`：列出模型裡的材質（名稱、用到幾個物件），點開調整；admin 才看得到「🎨 材質」按鈕。

**Tech Stack:** three.js r169、React、Cloudflare Worker + D1、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-13-live-stage-look-design.md`（第 6 節）

## Global Constraints

- 範圍（前後端一致）：roughness 0~1、metalness 0~1、envIntensity 0~5、opacity 0~1、color `#rrggbb`、mirrorFloor boolean。
- 材質名稱當 key（可以是中文 / 符號 / 空字串；長度 ≤ 100）；最多 300 個材質。
- LED 物件的材質不列在面板（LED 由現場模式 / LED 質感處理）。
- 舊的單一物件 `materialProps` 仍然最優先（相容既有資料）。
- 沒模型時的方塊替身維持 category 顏色（它的「原值」就是 category 顏色）。

---

### Task 1: 材質覆寫純邏輯（materialOverrides）

**Files:** Create `web/src/lib/stageLook/materialOverrides.ts`、Test `web/src/lib/stageLook/materialOverrides.test.ts`

**Interfaces:**
- `interface MaterialOverride { color?: string; roughness?: number; metalness?: number; envIntensity?: number; opacity?: number; mirrorFloor?: boolean }`
- `type MaterialOverrides = Record<string, MaterialOverride>`
- `MATERIAL_RANGES: { roughness: [0,1]; metalness: [0,1]; envIntensity: [0,5]; opacity: [0,1] }`
- `normalizeMaterialOverrides(raw: unknown): MaterialOverrides`
- `interface MaterialOriginal { color: string; roughness: number; metalness: number; envIntensity: number; opacity: number; transparent: boolean }`
- `captureOriginal(m: THREE.MeshStandardMaterial): MaterialOriginal`（存在 `m.userData.original`，已有就直接回傳）
- `applyMaterialSettings(m: THREE.MeshStandardMaterial, override?: MaterialOverride, perObject?: { color?: string; roughness?: number; metalness?: number; opacity?: number }): void`
- `hasMirrorFloor(o: MaterialOverrides): boolean`

- [ ] **Step 1: 失敗測試**

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyMaterialSettings, captureOriginal, hasMirrorFloor, normalizeMaterialOverrides } from './materialOverrides';

describe('normalizeMaterialOverrides', () => {
  it('壞資料 → 空物件', () => {
    expect(normalizeMaterialOverrides(null)).toEqual({});
    expect(normalizeMaterialOverrides([1, 2])).toEqual({});
  });
  it('夾範圍、丟掉不認識的欄位與壞顏色、空的覆寫不留', () => {
    const o = normalizeMaterialOverrides({
      霧銀: { roughness: 2, metalness: -1, envIntensity: 9, opacity: 0.5, color: '#AABBCC', junk: 1 },
      壞顏色: { color: 'red' },
      地板: { mirrorFloor: true },
    });
    expect(o.霧銀).toEqual({ roughness: 1, metalness: 0, envIntensity: 5, opacity: 0.5, color: '#aabbcc' });
    expect(o.壞顏色).toBeUndefined();
    expect(o.地板).toEqual({ mirrorFloor: true });
  });
});

describe('captureOriginal / applyMaterialSettings', () => {
  it('第一次記下原值，之後不會被覆寫', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.2, metalness: 0.8 });
    const o1 = captureOriginal(m);
    m.roughness = 0.9;
    const o2 = captureOriginal(m);
    expect(o2).toBe(o1);
    expect(o1.roughness).toBeCloseTo(0.2);
    expect(o1.color).toBe('336699');
  });
  it('沒覆寫 → 回到原值', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.2, metalness: 0.8 });
    captureOriginal(m);
    m.roughness = 0.9; m.color.set('#ff0000');
    applyMaterialSettings(m);
    expect(m.roughness).toBeCloseTo(0.2);
    expect(m.color.getHexString()).toBe('336699');
  });
  it('名稱覆寫蓋原值；單一物件設定再蓋名稱覆寫', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.2, metalness: 0.8 });
    captureOriginal(m);
    applyMaterialSettings(m, { roughness: 0.5, color: '#00ff00', opacity: 0.4 }, { roughness: 0.7 });
    expect(m.roughness).toBeCloseTo(0.7);
    expect(m.color.getHexString()).toBe('00ff00');
    expect(m.opacity).toBeCloseTo(0.4);
    expect(m.transparent).toBe(true);
    expect(m.metalness).toBeCloseTo(0.8);
  });
  it('hasMirrorFloor', () => {
    expect(hasMirrorFloor({ a: { roughness: 1 } })).toBe(false);
    expect(hasMirrorFloor({ a: { mirrorFloor: true } })).toBe(true);
  });
});
```

- [ ] **Step 2: 確認失敗**（找不到模組）
- [ ] **Step 3: 實作**

```ts
// 舞台材質（依 C4D 材質名稱）：
//   原值（GLB 匯出的樣子）→ 名稱覆寫（材質面板，全專案共用）→ 單一物件 materialProps（舊功能，最優先）
// 範圍要跟 cf-worker/worker.js 的 MATERIAL_RANGES 一致

import * as THREE from 'three';

export interface MaterialOverride {
  color?: string;
  roughness?: number;
  metalness?: number;
  envIntensity?: number;
  opacity?: number;
  mirrorFloor?: boolean;
}

export type MaterialOverrides = Record<string, MaterialOverride>;

export const MATERIAL_RANGES = {
  roughness: [0, 1],
  metalness: [0, 1],
  envIntensity: [0, 5],
  opacity: [0, 1],
} as const;

const NUM_KEYS = Object.keys(MATERIAL_RANGES) as (keyof typeof MATERIAL_RANGES)[];

export function normalizeMaterialOverrides(raw: unknown): MaterialOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: MaterialOverrides = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>).slice(0, 300)) {
    if (name.length > 100 || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const src = v as Record<string, unknown>;
    const o: MaterialOverride = {};
    for (const k of NUM_KEYS) {
      if (!(k in src)) continue;
      const n = Number(src[k]);
      if (!Number.isFinite(n)) continue;
      const [min, max] = MATERIAL_RANGES[k];
      o[k] = Math.min(max, Math.max(min, n));
    }
    if (typeof src.color === 'string' && /^#[0-9a-f]{6}$/i.test(src.color)) o.color = src.color.toLowerCase();
    if (src.mirrorFloor === true) o.mirrorFloor = true;
    if (Object.keys(o).length > 0) out[name] = o;
  }
  return out;
}

export interface MaterialOriginal {
  color: string;
  roughness: number;
  metalness: number;
  envIntensity: number;
  opacity: number;
  transparent: boolean;
}

export function captureOriginal(m: THREE.MeshStandardMaterial): MaterialOriginal {
  const existing = m.userData.original as MaterialOriginal | undefined;
  if (existing) return existing;
  const original: MaterialOriginal = {
    color: m.color.getHexString(),
    roughness: m.roughness,
    metalness: m.metalness,
    envIntensity: m.envMapIntensity,
    opacity: m.opacity,
    transparent: m.transparent,
  };
  m.userData.original = original;
  return original;
}

export function applyMaterialSettings(
  m: THREE.MeshStandardMaterial,
  override?: MaterialOverride,
  perObject?: { color?: string; roughness?: number; metalness?: number; opacity?: number },
) {
  const o = captureOriginal(m);
  const pick = <T,>(per: T | undefined, ov: T | undefined, orig: T): T => (per !== undefined ? per : ov !== undefined ? ov : orig);
  m.color.set(pick(perObject?.color, override?.color, '#' + o.color));
  m.roughness = pick(perObject?.roughness, override?.roughness, o.roughness);
  m.metalness = pick(perObject?.metalness, override?.metalness, o.metalness);
  m.envMapIntensity = pick(undefined, override?.envIntensity, o.envIntensity);
  const opacity = pick(perObject?.opacity, override?.opacity, o.opacity);
  m.opacity = opacity;
  const transparent = opacity < 1 || (override?.opacity === undefined && perObject?.opacity === undefined && o.transparent);
  if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
}

export function hasMirrorFloor(o: MaterialOverrides): boolean {
  return Object.values(o).some(v => v.mirrorFloor);
}
```

- [ ] **Step 4: 測試通過**（6 tests）→ **Step 5: Commit** `feat(stage-look): 材質覆寫（C4D 原值 → 名稱覆寫 → 單一物件）`

---

### Task 2: 鏡面地板依材質勾選（floorReflection / floorPlane）

**Files:** Modify `floorReflection.ts` + test、`floorPlane.ts` + test

- [ ] **Step 1: 測試**
  - floorReflection：`applyFloorReflection` 後 `material.userData.reflMaterialOn.value === 1`；`setFloorReflectionFor(m, false)` → 0；patch 後 fragment 含 `uReflMaterialOn > 0.5`。
  - floorPlane：`detectFloorPlane([big, small], { meshFilter: m => m === small })` 回傳 small 的高度。
- [ ] **Step 2: 實作**
  - `patchFloorShader(shader, uniforms, materialOn = { value: 1 })`：`shader.uniforms.uReflMaterialOn = materialOn`；FRAG_DECL 加 `uniform float uReflMaterialOn;`；條件改成 `if ( uReflOn > 0.5 && uReflMaterialOn > 0.5 ) {`。
  - `applyFloorReflection`：建立 `material.userData.reflMaterialOn = { value: 1 }` 並傳給 patch。
  - `export function setFloorReflectionFor(m: THREE.Material, on: boolean) { const u = m.userData.reflMaterialOn; if (u) u.value = on ? 1 : 0; }`
  - `detectFloorPlane` opts 加 `meshFilter?: (mesh: THREE.Mesh) => boolean`，traverse 時不符合就跳過。
- [ ] **Step 3: 測試通過 → Commit** `feat(stage-look): 鏡面地板可依材質指定`

---

### Task 3: 後台 material_overrides

**Files:** `cf-worker/migrations/0014_project_view_settings.sql`、`cf-worker/worker.js`

- [ ] 0014 加 `ALTER TABLE projects ADD COLUMN material_overrides TEXT NOT NULL DEFAULT '{}';` 與註解。
- [ ] `updateProject`：allowed 加 `material_overrides`；camelCase `materialOverrides` 轉換；`touchesViewSettings` 加入；`sanitizeMaterialOverrides`（同 Task 1 規則，回 object；壞的整包回 null → 400）；`onlyLiveTweaks` 名單加 `material_overrides` / `materialOverrides`；錯誤訊息改「只有 admin 能改 3D 檢視設定」。
- [ ] share data SELECT 加 `material_overrides`、回傳 `materialOverrides: safeJsonObj(proj.material_overrides, {})`。
- [ ] 本機 wrangler dev + 假帳號驗：admin 存 → 200 且被清理；director → 403；`[1]` → 400；share 有欄位。
- [ ] Commit `feat(worker): 專案存材質覆寫 material_overrides（admin 限定）`

---

### Task 4: 前端讀寫（api + hook）

- [ ] `api.ts`：`ProjectViewSettings.materialOverrides: MaterialOverrides`；`getProjectViewSettings` 讀 `material_overrides` → `normalizeMaterialOverrides`；`SharePublicData.materialOverrides?: MaterialOverrides`。
- [ ] hook：state + ref + `applyMaterials`；載入時 reset / 套用；`setMaterialOverride(name: string, patch: Partial<MaterialOverride> | null)`：null = 刪掉那個材質的覆寫；否則合併 → `normalizeMaterialOverrides` → `scheduleSave({ materialOverrides: next })`；介面 / 回傳加上。
- [ ] tsc + vitest → Commit `feat(stage-look): 前端讀寫材質覆寫`

---

### Task 5: StageScene + 材質面板 + 頁面

- [ ] **StageScene props**：`materialOverrides?: MaterialOverrides`、`onMaterialOverrideChange?: (name: string, patch: Partial<MaterialOverride> | null) => void`。
- [ ] **材質轉換保留名稱**：sync effect 把非 Standard 材質換成 Standard 時加 `stdMat.name = old.name;`。
- [ ] **一般物件分支**：把「baseColor / metalness 0.1 / roughness 0.6 / envMapIntensity 1 / opacity」那段換成

```ts
          applyMaterialSettings(m, materialOverrides?.[m.name], {
            color: mat.color, roughness: mat.roughness, metalness: mat.metalness, opacity: mat.opacity,
          });
          if (!isLed && floorReflRef.current) {
            applyFloorReflection(m, floorReflRef.current.uniforms);
            setFloorReflectionFor(m, mirrorFlagged ? !!materialOverrides?.[m.name]?.mirrorFloor : true);
          }
```

  （`const mirrorFlagged = hasMirrorFloor(materialOverrides || {});` 放 effect 開頭；effect 依賴加 `materialOverrides`；刪掉原本的 category 上色與 `CATEGORY_COLORS` 在這段的使用。注意 LED 在快速模式沒貼圖時也走這個分支：維持 `isLed` 時不掛倒影。）
- [ ] **找地板 effect**：依賴加 `materialOverrides`；`const flagged = new Set(Object.entries(materialOverrides || {}).filter(([, v]) => v.mirrorFloor).map(([k]) => k));` 有勾 → `detectFloorPlane(roots, { meshFilter: m => flagged.has((m.material as THREE.Material).name) })`。
- [ ] **材質清單**：`const [modelMaterials, setModelMaterials] = useState<ModelMaterialInfo[]>([])`；在找地板 effect 裡順便算：非 LED 物件的材質依名稱分組（count、原值 `captureOriginal`），用名稱串列比對有變才 `setModelMaterials`。
- [ ] **MaterialPanel.tsx**（新）：props `materials: ModelMaterialInfo[]`、`overrides: MaterialOverrides`、`onChange(name, patch|null)`、`onClose()`。每列：名稱（空名顯示「（沒有名稱）」）+ 用到幾個物件 + 有改過的標記；點開：顏色（input color）、亮面 ↔ 霧面（roughness）、金屬感、反射強度（envIntensity 0~5）、透明度、☐ 鏡面地板、「回到 C4D 原本」按鈕（`onChange(name, null)`）。數值顯示 = 覆寫 ?? 原值。樣式比照 LookSettingsPanel（inline style、右上浮動、可捲動、max-height 70%）。
- [ ] **工具列**：有 `onMaterialOverrideChange` 才顯示「🎨 材質」；開材質面板時關現場設定面板，反之亦然。
- [ ] **頁面**：ProjectEditor / Studio / Preview 傳 `materialOverrides={view.materialOverrides}`、`onMaterialOverrideChange={view.canEdit ? view.setMaterialOverride : undefined}`；Share 傳 `normalizeMaterialOverrides(data.materialOverrides)`；CueStoryboard 加 prop 往下傳。
- [ ] tsc + vitest + build → Commit `feat(stage-scene): 材質面板（依 C4D 材質名稱調整、鏡面地板勾選）`

---

### Task 6: 實機驗證

- [ ] 主舞臺：預設材質變回 C4D 的樣子（霧銀 / 黑亮+銀蔥 / yakali' 不再同一種灰），快速 / 現場都正常。
- [ ] 🎨 材質：列出材質（不含 LED）；改「yakali'」亮面 → 台面倒影變清楚；勾鏡面地板 → 只有它反光。
- [ ] 回到 C4D 原本 → 還原。
- [ ] 2026 金曲獎同樣檢查；console 沒 error；截圖給用戶。
