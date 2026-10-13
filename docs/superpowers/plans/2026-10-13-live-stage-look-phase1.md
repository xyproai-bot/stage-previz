# 現場模式 第一段（暗場 + LED 照明 + 光暈 + 現場設定 + 鎖頭）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Realistic / Cinematic 換成一個「現場」模式：暗場、LED 依畫面顏色打光到舞台、相機光暈、可調的現場設定（全專案共用），鎖頭圖示不再一直蓋畫面。

**Architecture:** 新增 `web/src/lib/stageLook/` 放純邏輯（LED 面板分群成燈、畫面取色、畫質偵測、設定正規化）+ 兩個 three.js 管理器（RectAreaLight 燈組、只拍 LED 的動態環境光）。StageScene 只負責接線。現場設定跟校準 / 機關滑桿走同一個 `useProjectViewSettings` hook 存到 `projects.look_settings`。

**Tech Stack:** React 18、three.js r169（WebGL2：RectAreaLight、CubeCamera、PMREMGenerator.fromCubemap、UnrealBloomPass、NeutralToneMapping）、Cloudflare Worker + D1、Vitest（新加，只測純邏輯）。

**Spec:** `docs/superpowers/specs/2026-10-13-live-stage-look-design.md`

## Global Constraints

- 分支：`feat/live-stage-look`（已含 UV 修正 + 校準 / 機關滑桿共用）。
- Quick 模式畫面不能變（LED 像素 1:1、非 LED 物件仍用 ACES tone mapping）。
- `defaultRenderMode` 舊值 `'realistic' | 'cinematic'` 一律當 `'live'`。
- migration `0014_project_view_settings.sql` 尚未上正式 D1 → 直接在 0014 加 `look_settings` 欄。
- 現場設定只有 admin 能改（worker 403 擋），大家看到一樣。
- 現場設定數值範圍（前後端一致）：houseLight 0~1、exposure 0.2~3、ledLightStrength 0~5、bloomStrength 0~3、reflectionSharpness 0~1、ledViewFalloff 0~1。
- iPad / 低階：最多 8 盞 LED 燈、環境光 1 秒更新一次、pixelRatio 1、bloom 半解析度。桌機：24 盞、200ms、pixelRatio ≤ 1.5。
- 註解用中文、跟現有程式風格一致；不要動不相關的程式。

---

### Task 1: 測試環境 + 現場設定（lookSettings）

**Files:**
- Modify: `web/package.json`（加 vitest + `test` script）
- Create: `web/src/lib/stageLook/lookSettings.ts`
- Test: `web/src/lib/stageLook/lookSettings.test.ts`

**Interfaces:**
- Produces: `LookSettings`、`LOOK_SETTING_RANGES`、`DEFAULT_LOOK_SETTINGS`、`normalizeLookSettings(raw: unknown): LookSettings`

- [ ] **Step 1: 安裝 vitest**

Run: `cd web && npm install -D vitest@2.1.9`
然後在 `web/package.json` 的 `scripts` 加 `"test": "vitest run"`。

- [ ] **Step 2: 寫失敗的測試** — `web/src/lib/stageLook/lookSettings.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_LOOK_SETTINGS, LOOK_SETTING_RANGES, normalizeLookSettings } from './lookSettings';

describe('normalizeLookSettings', () => {
  it('沒有資料時回傳預設值', () => {
    expect(normalizeLookSettings(undefined)).toEqual(DEFAULT_LOOK_SETTINGS);
    expect(normalizeLookSettings(null)).toEqual(DEFAULT_LOOK_SETTINGS);
    expect(normalizeLookSettings('壞資料')).toEqual(DEFAULT_LOOK_SETTINGS);
  });

  it('只蓋掉有給的欄位', () => {
    const s = normalizeLookSettings({ exposure: 1.5 });
    expect(s.exposure).toBe(1.5);
    expect(s.houseLight).toBe(DEFAULT_LOOK_SETTINGS.houseLight);
  });

  it('超出範圍會夾回範圍內', () => {
    const s = normalizeLookSettings({ houseLight: 9, exposure: -1, ledLightStrength: 99 });
    expect(s.houseLight).toBe(LOOK_SETTING_RANGES.houseLight[1]);
    expect(s.exposure).toBe(LOOK_SETTING_RANGES.exposure[0]);
    expect(s.ledLightStrength).toBe(LOOK_SETTING_RANGES.ledLightStrength[1]);
  });

  it('非數字的欄位用預設值', () => {
    const s = normalizeLookSettings({ bloomStrength: 'abc', ledViewFalloff: NaN });
    expect(s.bloomStrength).toBe(DEFAULT_LOOK_SETTINGS.bloomStrength);
    expect(s.ledViewFalloff).toBe(DEFAULT_LOOK_SETTINGS.ledViewFalloff);
  });

  it('數字字串也收', () => {
    expect(normalizeLookSettings({ exposure: '2' }).exposure).toBe(2);
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd web && npx vitest run src/lib/stageLook/lookSettings.test.ts`
Expected: FAIL（找不到 `./lookSettings`）

- [ ] **Step 4: 實作** — `web/src/lib/stageLook/lookSettings.ts`

```ts
// 現場模式的可調設定（全專案共用，存在 projects.look_settings）
// 範圍要跟 cf-worker/worker.js 的 LOOK_SETTING_RANGES 一致

export interface LookSettings {
  /** 現場底光：舞台結構看得多清楚（0 = 全暗，只有 LED） */
  houseLight: number;
  /** 曝光：整體亮暗，像相機 */
  exposure: number;
  /** LED 照明：LED 照到舞台的強度 */
  ledLightStrength: number;
  /** 光暈：亮的 LED 周圍暈開多少 */
  bloomStrength: number;
  /** 倒影清晰度（第三段用） */
  reflectionSharpness: number;
  /** LED 側看變暗（第二段用） */
  ledViewFalloff: number;
}

export const LOOK_SETTING_RANGES: Record<keyof LookSettings, [number, number]> = {
  houseLight: [0, 1],
  exposure: [0.2, 3],
  ledLightStrength: [0, 5],
  bloomStrength: [0, 3],
  reflectionSharpness: [0, 1],
  ledViewFalloff: [0, 1],
};

export const DEFAULT_LOOK_SETTINGS: LookSettings = {
  houseLight: 0.15,
  exposure: 1,
  ledLightStrength: 1,
  bloomStrength: 0.6,
  reflectionSharpness: 0.6,
  ledViewFalloff: 0.3,
};

export function normalizeLookSettings(raw: unknown): LookSettings {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LOOK_SETTINGS };
  for (const key of Object.keys(LOOK_SETTING_RANGES) as (keyof LookSettings)[]) {
    if (!(key in src)) continue;
    const n = Number(src[key]);
    if (!Number.isFinite(n)) continue;
    const [min, max] = LOOK_SETTING_RANGES[key];
    out[key] = Math.min(max, Math.max(min, n));
  }
  return out;
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd web && npx vitest run src/lib/stageLook/lookSettings.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/stageLook/lookSettings.ts web/src/lib/stageLook/lookSettings.test.ts
git commit -m "feat(stage-look): 現場設定型別 / 預設 / 正規化 + vitest"
```

---

### Task 2: LED 面板分群成燈（ledEmitters）

**Files:**
- Create: `web/src/lib/stageLook/ledEmitters.ts`
- Test: `web/src/lib/stageLook/ledEmitters.test.ts`

**Interfaces:**
- Produces:
  - `interface UvRect { u0: number; v0: number; u1: number; v1: number }`（u0/v0 落在 [0,1)，u1/v1 可 > 1 表示跨邊界）
  - `interface LedEmitter { center: THREE.Vector3; normal: THREE.Vector3; heightAxis: THREE.Vector3; width: number; height: number; area: number; uv: UvRect | null }`（全部在 root 物件的 local 座標）
  - `buildLedEmitters(root: THREE.Object3D, opts?: { maxAngleDeg?: number; maxPerObject?: number }): LedEmitter[]`

- [ ] **Step 1: 寫失敗的測試** — `web/src/lib/stageLook/ledEmitters.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildLedEmitters } from './ledEmitters';

function planeMesh(w = 2, h = 1) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial());
}

describe('buildLedEmitters', () => {
  it('平面 → 一盞燈，尺寸 / 中心 / 法線 / UV 正確', () => {
    const [e, ...rest] = buildLedEmitters(planeMesh(2, 1));
    expect(rest).toHaveLength(0);
    expect(e.width).toBeCloseTo(2);
    expect(e.height).toBeCloseTo(1);
    expect(e.center.length()).toBeCloseTo(0);
    expect(e.normal.z).toBeCloseTo(1);
    expect(e.heightAxis.y).toBeCloseTo(1);
    expect(e.uv).not.toBeNull();
    expect(e.uv!.u0).toBeCloseTo(0);
    expect(e.uv!.u1).toBeCloseTo(1);
    expect(e.uv!.v0).toBeCloseTo(0);
    expect(e.uv!.v1).toBeCloseTo(1);
  });

  it('L 形兩面 → 兩盞燈，法線各自朝外', () => {
    const root = new THREE.Group();
    const a = planeMesh();
    const b = planeMesh();
    b.rotation.y = Math.PI / 2;
    b.position.set(1, 0, -1);
    root.add(a, b);
    const ems = buildLedEmitters(root);
    expect(ems).toHaveLength(2);
    const normals = ems.map(e => e.normal);
    expect(normals.some(n => n.z > 0.99)).toBe(true);
    expect(normals.some(n => n.x > 0.99)).toBe(true);
  });

  it('半圓柱 → 切成幾段，數量不超過 maxPerObject', () => {
    const geo = new THREE.CylinderGeometry(1, 1, 2, 16, 1, true, 0, Math.PI);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    const many = buildLedEmitters(mesh, { maxPerObject: 10 });
    expect(many.length).toBeGreaterThanOrEqual(3);
    for (const e of many) expect(Math.abs(e.normal.y)).toBeLessThan(0.01);
    expect(buildLedEmitters(mesh, { maxPerObject: 2 })).toHaveLength(2);
  });

  it('結果在 root 的 local 座標（root 自己轉不影響）', () => {
    const root = new THREE.Group();
    root.rotation.y = 1;
    root.position.set(5, 0, 0);
    const child = planeMesh();
    child.rotation.y = Math.PI / 2;
    root.add(child);
    const [e] = buildLedEmitters(root);
    expect(e.normal.x).toBeCloseTo(1);
    expect(e.center.length()).toBeCloseTo(0);
  });

  it('朝下的面板 → 法線向下，高度軸改用 Z', () => {
    // 結果是 root 的 local 座標 → 旋轉要放在子物件上
    const root = new THREE.Group();
    const m = planeMesh();
    m.rotation.x = Math.PI / 2;
    root.add(m);
    const [e] = buildLedEmitters(root);
    expect(e.normal.y).toBeCloseTo(-1);
    expect(Math.abs(e.heightAxis.z)).toBeCloseTo(1);
  });

  it('UV 在負值 → 換算回 0~1 範圍', () => {
    const m = planeMesh();
    const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 0.45 - 0.45);
    const [e] = buildLedEmitters(m);
    expect(e.uv!.v0).toBeCloseTo(0.55);
    expect(e.uv!.v1).toBeCloseTo(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd web && npx vitest run src/lib/stageLook/ledEmitters.test.ts`
Expected: FAIL（找不到 `./ledEmitters`）

- [ ] **Step 3: 實作** — `web/src/lib/stageLook/ledEmitters.ts`

```ts
// 把一個 LED 物件（可能是平面、L 形、曲面）切成幾塊「發光面」，每塊之後對應一盞 RectAreaLight。
// 做法：三角形依法線分群（夾角 < maxAngleDeg 算同一面），每群算面積加權中心 / 法線 / 寬高 / UV 範圍。
// 全部用 root 物件的 local 座標 → 物件之後怎麼移動（cue / 機關 / crossfade）都只要套 matrixWorld。

import * as THREE from 'three';

export interface UvRect { u0: number; v0: number; u1: number; v1: number }

export interface LedEmitter {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  /** 發光面「高」的方向（寬 = heightAxis × normal） */
  heightAxis: THREE.Vector3;
  width: number;
  height: number;
  area: number;
  /** 這塊在 LED 貼圖上的範圍（套過 fract；跨邊界時 u1 / v1 會 > 1）；沒 UV = null */
  uv: UvRect | null;
}

export interface EmitterOptions {
  maxAngleDeg?: number;
  maxPerObject?: number;
}

interface Tri {
  verts: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  uvs: [THREE.Vector2, THREE.Vector2, THREE.Vector2] | null;
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
  area: number;
}

interface Cluster { nSum: THREE.Vector3; n: THREE.Vector3; area: number; tris: Tri[] }

const MIN_TRI_AREA = 1e-12;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

export function buildLedEmitters(root: THREE.Object3D, opts: EmitterOptions = {}): LedEmitter[] {
  const cosThreshold = Math.cos(THREE.MathUtils.degToRad(opts.maxAngleDeg ?? 35));
  const maxPerObject = Math.max(1, opts.maxPerObject ?? 4);
  const tris = collectTriangles(root);
  if (tris.length === 0) return [];
  const clusters = clusterByNormal(tris, cosThreshold);
  mergeSmallest(clusters, maxPerObject);
  return clusters.map(toEmitter).filter((e): e is LedEmitter => e !== null);
}

function collectTriangles(root: THREE.Object3D): Tri[] {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  const tris: Tri[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const uv = geo.getAttribute('uv');
    m.multiplyMatrices(toRoot, mesh.matrixWorld);
    // 鏡像（負 scale）時三角形繞序反過來，正面法線要反向
    const flip = m.determinant() < 0;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const at = (i: number) => (index ? index.getX(i) : i);
    for (let i = 0; i + 2 < count; i += 3) {
      const ids = [at(i), at(i + 1), at(i + 2)];
      const verts = ids.map(k => new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(m)) as Tri['verts'];
      const e1 = new THREE.Vector3().subVectors(verts[1], verts[0]);
      const e2 = new THREE.Vector3().subVectors(verts[2], verts[0]);
      const cross = new THREE.Vector3().crossVectors(e1, e2);
      const area = cross.length() / 2;
      if (area < MIN_TRI_AREA) continue;
      const normal = cross.normalize();
      if (flip) normal.negate();
      const centroid = new THREE.Vector3().add(verts[0]).add(verts[1]).add(verts[2]).divideScalar(3);
      const uvs = uv ? (ids.map(k => new THREE.Vector2().fromBufferAttribute(uv, k)) as Tri['uvs']) : null;
      tris.push({ verts, uvs, normal, centroid, area });
    }
  });
  return tris;
}

function clusterByNormal(tris: Tri[], cosThreshold: number): Cluster[] {
  const sorted = [...tris].sort((a, b) => b.area - a.area);
  const clusters: Cluster[] = [];
  for (const t of sorted) {
    let best: Cluster | null = null;
    let bestDot = cosThreshold;
    for (const c of clusters) {
      const d = c.n.dot(t.normal);
      if (d >= bestDot) { bestDot = d; best = c; }
    }
    if (!best) {
      best = { nSum: new THREE.Vector3(), n: t.normal.clone(), area: 0, tris: [] };
      clusters.push(best);
    }
    best.tris.push(t);
    best.area += t.area;
    best.nSum.addScaledVector(t.normal, t.area);
    if (best.nSum.lengthSq() > 0) best.n.copy(best.nSum).normalize();
  }
  return clusters;
}

function mergeSmallest(clusters: Cluster[], max: number) {
  while (clusters.length > max) {
    clusters.sort((a, b) => b.area - a.area);
    const small = clusters.pop()!;
    let target = clusters[0];
    let bestDot = -Infinity;
    for (const c of clusters) {
      const d = c.n.dot(small.n);
      if (d > bestDot) { bestDot = d; target = c; }
    }
    target.tris.push(...small.tris);
    target.area += small.area;
    target.nSum.add(small.nSum);
    if (target.nSum.lengthSq() > 0) target.n.copy(target.nSum).normalize();
  }
}

function toEmitter(c: Cluster): LedEmitter | null {
  const normal = c.n.clone();
  const up = Math.abs(normal.dot(WORLD_UP)) > 0.9 ? WORLD_Z : WORLD_UP;
  const heightAxis = up.clone().addScaledVector(normal, -up.dot(normal)).normalize();
  const widthAxis = new THREE.Vector3().crossVectors(heightAxis, normal).normalize();

  const c0 = new THREE.Vector3();
  for (const t of c.tris) c0.addScaledVector(t.centroid, t.area);
  c0.divideScalar(c.area);

  let minW = Infinity, maxW = -Infinity, minH = Infinity, maxH = -Infinity;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  let hasUv = true;
  const d = new THREE.Vector3();
  for (const t of c.tris) {
    for (const p of t.verts) {
      d.subVectors(p, c0);
      const w = d.dot(widthAxis), h = d.dot(heightAxis);
      if (w < minW) minW = w;
      if (w > maxW) maxW = w;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    if (!t.uvs) { hasUv = false; continue; }
    for (const q of t.uvs) {
      if (q.x < uMin) uMin = q.x;
      if (q.x > uMax) uMax = q.x;
      if (q.y < vMin) vMin = q.y;
      if (q.y > vMax) vMax = q.y;
    }
  }
  const width = maxW - minW;
  const height = maxH - minH;
  if (!(width > 0) || !(height > 0)) return null;
  const center = c0.clone()
    .addScaledVector(widthAxis, (minW + maxW) / 2)
    .addScaledVector(heightAxis, (minH + maxH) / 2);

  let uv: UvRect | null = null;
  if (hasUv && Number.isFinite(uMin)) {
    const su = Math.floor(uMin), sv = Math.floor(vMin);
    uv = { u0: uMin - su, u1: uMax - su, v0: vMin - sv, v1: vMax - sv };
  }
  return { center, normal, heightAxis, width, height, area: c.area, uv };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd web && npx vitest run src/lib/stageLook/ledEmitters.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/stageLook/ledEmitters.ts web/src/lib/stageLook/ledEmitters.test.ts
git commit -m "feat(stage-look): LED 物件依法線分群成發光面（之後每塊一盞燈）"
```

---

### Task 3: 畫面取色（ledColorSampler + TextureColorReader）

**Files:**
- Create: `web/src/lib/stageLook/ledColorSampler.ts`（純函式）
- Create: `web/src/lib/stageLook/textureColorReader.ts`（DOM：把貼圖畫進小 canvas 讀像素）
- Test: `web/src/lib/stageLook/ledColorSampler.test.ts`

**Interfaces:**
- Consumes: `UvRect`（Task 2）
- Produces:
  - `srgb8ToLinear(v: number): number`
  - `averageUvRect(pixels: ArrayLike<number>, w: number, h: number, rect: UvRect, flipY: boolean, samples?: number): [number, number, number]`（線性 RGB 0~1）
  - `interface LedColorSource { image: CanvasImageSource; flipY: boolean }`
  - `class TextureColorReader { beginFrame(): void; sample(source: LedColorSource, rect: UvRect): [number, number, number] | null }`

- [ ] **Step 1: 寫失敗的測試** — `web/src/lib/stageLook/ledColorSampler.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { averageUvRect, srgb8ToLinear } from './ledColorSampler';

/** 建 w×h RGBA 影像；fill(x, y) 回傳 [r,g,b]（0~255），y = 0 是最上面一排 */
function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fill(x, y);
    const o = (y * w + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }
  return px;
}
const full = { u0: 0, v0: 0, u1: 1, v1: 1 };

describe('averageUvRect', () => {
  it('單色 → 那個顏色（線性）', () => {
    const c = averageUvRect(img(4, 2, () => [255, 0, 0]), 4, 2, full, false);
    expect(c[0]).toBeCloseTo(1);
    expect(c[1]).toBeCloseTo(0);
    expect(c[2]).toBeCloseTo(0);
  });

  it('只取 UV 範圍內：左半紅、右半藍，取左半 → 紅', () => {
    const px = img(4, 2, x => (x < 2 ? [255, 0, 0] : [0, 0, 255]));
    const c = averageUvRect(px, 4, 2, { u0: 0, v0: 0, u1: 0.5, v1: 1 }, false);
    expect(c[0]).toBeCloseTo(1);
    expect(c[2]).toBeCloseTo(0);
  });

  it('flipY：false 時 v=0 是最上排，true 時 v=0 是最下排', () => {
    const px = img(2, 2, (_x, y) => (y === 0 ? [0, 255, 0] : [0, 0, 0]));
    const topHalf = { u0: 0, v0: 0, u1: 1, v1: 0.5 };
    expect(averageUvRect(px, 2, 2, topHalf, false)[1]).toBeCloseTo(1);
    expect(averageUvRect(px, 2, 2, topHalf, true)[1]).toBeCloseTo(0);
  });

  it('跨邊界的範圍會繞回來', () => {
    const px = img(4, 1, x => (x === 0 || x === 3 ? [255, 255, 255] : [0, 0, 0]));
    const c = averageUvRect(px, 4, 1, { u0: 0.875, v0: 0, u1: 1.125, v1: 1 }, false);
    expect(c[0]).toBeCloseTo(1);
  });

  it('sRGB 轉線性', () => {
    expect(srgb8ToLinear(0)).toBe(0);
    expect(srgb8ToLinear(255)).toBeCloseTo(1);
    expect(srgb8ToLinear(128)).toBeCloseTo(0.2158, 3);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd web && npx vitest run src/lib/stageLook/ledColorSampler.test.ts`
Expected: FAIL（找不到 `./ledColorSampler`）

- [ ] **Step 3: 實作純函式** — `web/src/lib/stageLook/ledColorSampler.ts`

```ts
// 從 LED 貼圖像素算出某塊發光面（UV 範圍）的平均顏色 → 拿去當那盞燈的顏色。
// 平均要在「線性」空間做，不然暗的顏色權重會不對。

import type { UvRect } from './ledEmitters';

const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgb8ToLinear(v: number): number {
  return LUT[v] ?? 0;
}

/**
 * pixels：RGBA、第 0 排在最上面（canvas getImageData 的排法）
 * flipY：貼圖的 flipY（NDI live 是 false → v=0 在上面；一般圖片 true → v=0 在下面）
 */
export function averageUvRect(
  pixels: ArrayLike<number>, w: number, h: number,
  rect: UvRect, flipY: boolean, samples = 8,
): [number, number, number] {
  if (w <= 0 || h <= 0) return [0, 0, 0];
  let r = 0, g = 0, b = 0, n = 0;
  for (let j = 0; j < samples; j++) {
    const v = rect.v0 + ((j + 0.5) / samples) * (rect.v1 - rect.v0);
    const fv = v - Math.floor(v);
    const ty = flipY ? 1 - fv : fv;
    const y = Math.min(h - 1, Math.max(0, Math.floor(ty * h)));
    for (let i = 0; i < samples; i++) {
      const u = rect.u0 + ((i + 0.5) / samples) * (rect.u1 - rect.u0);
      const fu = u - Math.floor(u);
      const x = Math.min(w - 1, Math.max(0, Math.floor(fu * w)));
      const o = (y * w + x) * 4;
      r += LUT[pixels[o]];
      g += LUT[pixels[o + 1]];
      b += LUT[pixels[o + 2]];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd web && npx vitest run src/lib/stageLook/ledColorSampler.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: DOM 讀取器** — `web/src/lib/stageLook/textureColorReader.ts`

```ts
// 把 LED 貼圖（NDI canvas / mock canvas / 自訂圖片）縮畫到 64×32 小 canvas 讀像素，
// 同一輪取色裡同一張貼圖只畫一次。跨網域沒 CORS 的圖片會讀不到 → 回 null（燈就不跟畫面變色）。

import { averageUvRect } from './ledColorSampler';
import type { UvRect } from './ledEmitters';

export interface LedColorSource {
  image: CanvasImageSource;
  flipY: boolean;
}

export class TextureColorReader {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private cache = new Map<CanvasImageSource, ImageData | null>();

  constructor(private w = 64, private h = 32) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** 每一輪取色開始前呼叫（清掉上一輪的像素快取） */
  beginFrame() {
    this.cache.clear();
  }

  sample(source: LedColorSource, rect: UvRect): [number, number, number] | null {
    if (!this.ctx) return null;
    let data = this.cache.get(source.image);
    if (data === undefined) {
      try {
        this.ctx.clearRect(0, 0, this.w, this.h);
        this.ctx.drawImage(source.image, 0, 0, this.w, this.h);
        data = this.ctx.getImageData(0, 0, this.w, this.h);
      } catch {
        data = null;
      }
      this.cache.set(source.image, data);
    }
    if (!data) return null;
    return averageUvRect(data.data, this.w, this.h, rect, source.flipY);
  }
}
```

- [ ] **Step 6: type-check**

Run: `cd web && npx tsc -b 2>&1 | grep -v TS6310`
Expected: 沒有輸出

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/stageLook/ledColorSampler.ts web/src/lib/stageLook/ledColorSampler.test.ts web/src/lib/stageLook/textureColorReader.ts
git commit -m "feat(stage-look): 從 LED 貼圖取每塊發光面的平均顏色"
```

---

### Task 4: 畫質偵測（quality）

**Files:**
- Create: `web/src/lib/stageLook/quality.ts`
- Test: `web/src/lib/stageLook/quality.test.ts`

**Interfaces:**
- Produces: `type QualityProfile = 'high' | 'low'`、`interface QualitySpec { maxLights: number; envIntervalMs: number; pixelRatioCap: number; bloomScale: number }`、`QUALITY: Record<QualityProfile, QualitySpec>`、`detectQualityProfile(d: { maxTouchPoints: number; hardwareConcurrency: number; userAgent: string }): QualityProfile`

- [ ] **Step 1: 寫失敗的測試** — `web/src/lib/stageLook/quality.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { detectQualityProfile } from './quality';

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

describe('detectQualityProfile', () => {
  it('桌機多核心 → high', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 16, userAgent: WIN })).toBe('high');
  });
  it('iPadOS（偽裝成 Mac + 有觸控）→ low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 5, hardwareConcurrency: 8, userAgent: MAC })).toBe('low');
  });
  it('舊 iPad UA → low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 5, hardwareConcurrency: 6, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)' })).toBe('low');
  });
  it('4 核心以下 → low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 4, userAgent: WIN })).toBe('low');
  });
  it('真 Mac（沒觸控）→ high', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 10, userAgent: MAC })).toBe('high');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd web && npx vitest run src/lib/stageLook/quality.test.ts`
Expected: FAIL（找不到 `./quality`）

- [ ] **Step 3: 實作** — `web/src/lib/stageLook/quality.ts`

```ts
// 依裝置決定現場模式的畫質檔（iPad / 手機 / 低階電腦降一點，保持順暢）

export type QualityProfile = 'high' | 'low';

export interface QualitySpec {
  /** 全場最多幾盞 LED 燈 */
  maxLights: number;
  /** LED 環境光（反射 / 染色）多久更新一次 */
  envIntervalMs: number;
  /** renderer pixelRatio 上限 */
  pixelRatioCap: number;
  /** bloom 解析度比例 */
  bloomScale: number;
}

export const QUALITY: Record<QualityProfile, QualitySpec> = {
  high: { maxLights: 24, envIntervalMs: 200, pixelRatioCap: 1.5, bloomScale: 1 },
  low: { maxLights: 8, envIntervalMs: 1000, pixelRatioCap: 1, bloomScale: 0.5 },
};

export function detectQualityProfile(d: { maxTouchPoints: number; hardwareConcurrency: number; userAgent: string }): QualityProfile {
  const mobile = /iPad|iPhone|Android|Mobile/i.test(d.userAgent);
  // iPadOS 的 Safari 預設回報成 Mac，只能靠觸控點判斷
  const touchMac = /Macintosh/.test(d.userAgent) && d.maxTouchPoints > 1;
  if (mobile || touchMac) return 'low';
  if (d.hardwareConcurrency > 0 && d.hardwareConcurrency <= 4) return 'low';
  return 'high';
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd web && npx vitest run src/lib/stageLook/quality.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/stageLook/quality.ts web/src/lib/stageLook/quality.test.ts
git commit -m "feat(stage-look): 依裝置決定現場模式畫質檔"
```

---

### Task 5: LED 燈組（ledLightRig）

**Files:**
- Create: `web/src/lib/stageLook/ledLightRig.ts`
- Test: `web/src/lib/stageLook/ledLightRig.test.ts`

**Interfaces:**
- Consumes: `LedEmitter`、`UvRect`（Task 2）
- Produces:
  - `LED_LIGHT_BASE_INTENSITY: number`
  - `interface LedLightProps { brightness: number; castStrength: number; tint: THREE.Color }`
  - `emitterLightParams(avgLinear: [number, number, number], props: LedLightProps, strength: number): { color: THREE.Color; intensity: number }`
  - `class LedLightRig { constructor(scene: THREE.Scene); setObjectEmitters(objectId: string, emitters: LedEmitter[]): void; retainObjects(ids: Set<string>): void; setMaxLights(n: number): void; setEnabled(on: boolean): void; updatePoses(objects: Map<string, THREE.Object3D>): void; updateColors(sample: (objectId: string, uv: UvRect) => [number, number, number] | null, propsFor: (objectId: string) => LedLightProps, strength: number): void; readonly lightCount: number; dispose(): void }`

- [ ] **Step 1: 寫失敗的測試** — `web/src/lib/stageLook/ledLightRig.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LED_LIGHT_BASE_INTENSITY, LedLightRig, emitterLightParams } from './ledLightRig';
import { buildLedEmitters } from './ledEmitters';

const white = { brightness: 1, castStrength: 1, tint: new THREE.Color(1, 1, 1) };

describe('emitterLightParams', () => {
  it('全黑 → 不發光', () => {
    expect(emitterLightParams([0, 0, 0], white, 1).intensity).toBe(0);
  });
  it('顏色正規化到最亮的通道，強度跟著最亮通道', () => {
    const { color, intensity } = emitterLightParams([0.5, 0.25, 0], white, 1);
    expect(color.r).toBeCloseTo(1);
    expect(color.g).toBeCloseTo(0.5);
    expect(color.b).toBeCloseTo(0);
    expect(intensity).toBeCloseTo(0.5 * LED_LIGHT_BASE_INTENSITY);
  });
  it('tint / 亮度 / 照明強度會乘上去', () => {
    const red = { brightness: 2, castStrength: 0.5, tint: new THREE.Color(1, 0, 0) };
    const { color, intensity } = emitterLightParams([0.5, 0.5, 0.5], red, 3);
    expect(color.g).toBeCloseTo(0);
    expect(intensity).toBeCloseTo(0.5 * 2 * 0.5 * 3 * LED_LIGHT_BASE_INTENSITY);
  });
});

describe('LedLightRig', () => {
  function setup() {
    const scene = new THREE.Scene();
    const rig = new LedLightRig(scene);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshStandardMaterial());
    panel.position.set(3, 1, 0);
    scene.add(panel);
    return { scene, rig, panel };
  }

  it('每個發光面一盞燈，位置跟著物件走', () => {
    const { scene, rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.setEnabled(true);
    rig.updateColors(() => [1, 1, 1], () => white, 1);
    rig.updatePoses(new Map([['a', panel]]));
    const lights = scene.children.filter(c => (c as THREE.RectAreaLight).isRectAreaLight) as THREE.RectAreaLight[];
    expect(lights).toHaveLength(1);
    expect(lights[0].position.x).toBeCloseTo(3, 1);
    expect(lights[0].width).toBeCloseTo(2);
    expect(lights[0].visible).toBe(true);
  });

  it('超過上限時只亮面積大的', () => {
    const { rig, panel } = setup();
    const small = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshStandardMaterial());
    rig.setObjectEmitters('big', buildLedEmitters(panel));
    rig.setObjectEmitters('small', buildLedEmitters(small));
    rig.setMaxLights(1);
    rig.setEnabled(true);
    rig.updateColors(() => [1, 1, 1], () => white, 1);
    rig.updatePoses(new Map([['big', panel], ['small', small]]));
    expect(rig.lightCount).toBe(1);
  });

  it('retainObjects 會移掉不存在的物件的燈', () => {
    const { scene, rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.retainObjects(new Set());
    expect(scene.children.some(c => (c as THREE.RectAreaLight).isRectAreaLight)).toBe(false);
  });

  it('updateColors 用取到的顏色設燈色', () => {
    const { scene, rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.updateColors(() => [0, 0.5, 0], () => white, 1);
    const light = scene.children.find(c => (c as THREE.RectAreaLight).isRectAreaLight) as THREE.RectAreaLight;
    expect(light.color.g).toBeCloseTo(1);
    expect(light.color.r).toBeCloseTo(0);
    expect(light.intensity).toBeCloseTo(0.5 * LED_LIGHT_BASE_INTENSITY);
  });

  it('關閉時燈全部隱藏', () => {
    const { rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.setEnabled(false);
    rig.updatePoses(new Map([['a', panel]]));
    expect(rig.lightCount).toBe(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd web && npx vitest run src/lib/stageLook/ledLightRig.test.ts`
Expected: FAIL（找不到 `./ledLightRig`）

- [ ] **Step 3: 實作** — `web/src/lib/stageLook/ledLightRig.ts`

```ts
// LED 照明燈組：每塊發光面（LedEmitter）一盞 RectAreaLight。
// - 位置 / 方向 / 大小：每幀跟著 LED 物件的 matrixWorld（cue、機關滑桿、crossfade 都會動）
// - 顏色 / 強度：由外部定時取色後呼叫 updateColors（跟著畫面內容變）
// - 燈太多時只亮面積最大的 maxLights 盞（效能）

import * as THREE from 'three';
import type { LedEmitter, UvRect } from './ledEmitters';

/** LED 亮度 1、照明強度 1、全白畫面時的燈強度（實機調過再改這個數字） */
export const LED_LIGHT_BASE_INTENSITY = 4;

export interface LedLightProps {
  brightness: number;
  castStrength: number;
  tint: THREE.Color;
}

export function emitterLightParams(
  avgLinear: [number, number, number], props: LedLightProps, strength: number,
): { color: THREE.Color; intensity: number } {
  const r = avgLinear[0] * props.tint.r;
  const g = avgLinear[1] * props.tint.g;
  const b = avgLinear[2] * props.tint.b;
  const peak = Math.max(r, g, b);
  if (!(peak > 1e-4)) return { color: new THREE.Color(1, 1, 1), intensity: 0 };
  return {
    color: new THREE.Color(r / peak, g / peak, b / peak),
    intensity: peak * props.brightness * props.castStrength * strength * LED_LIGHT_BASE_INTENSITY,
  };
}

interface Entry {
  objectId: string;
  emitter: LedEmitter;
  light: THREE.RectAreaLight;
}

export class LedLightRig {
  private entries: Entry[] = [];
  private emittersByObject = new Map<string, LedEmitter[]>();
  private maxLights = Infinity;
  private enabled = false;
  private visibleCount = 0;
  private readonly tmp = { pos: new THREE.Vector3(), n: new THREE.Vector3(), h: new THREE.Vector3(), s: new THREE.Vector3(), target: new THREE.Vector3() };

  constructor(private scene: THREE.Scene) {}

  get lightCount() { return this.visibleCount; }

  /** 同一個陣列重複設定會略過（effect 每次跑都會呼叫） */
  setObjectEmitters(objectId: string, emitters: LedEmitter[]) {
    if (this.emittersByObject.get(objectId) === emitters) return;
    this.removeObject(objectId);
    this.emittersByObject.set(objectId, emitters);
    for (const emitter of emitters) {
      const light = new THREE.RectAreaLight(0xffffff, 0, emitter.width, emitter.height);
      light.visible = false;
      this.scene.add(light);
      this.entries.push({ objectId, emitter, light });
    }
    this.sortByArea();
  }

  retainObjects(ids: Set<string>) {
    for (const id of [...this.emittersByObject.keys()]) {
      if (!ids.has(id)) this.removeObject(id);
    }
  }

  setMaxLights(n: number) { this.maxLights = Math.max(0, n); }

  setEnabled(on: boolean) { this.enabled = on; }

  updatePoses(objects: Map<string, THREE.Object3D>) {
    const { pos, n, h, s, target } = this.tmp;
    let shown = 0;
    for (const e of this.entries) {
      const obj = objects.get(e.objectId);
      const allowed = this.enabled && !!obj && obj.visible && shown < this.maxLights;
      if (!allowed || !obj) { e.light.visible = false; continue; }
      obj.updateWorldMatrix(true, false);
      const mw = obj.matrixWorld;
      pos.copy(e.emitter.center).applyMatrix4(mw);
      n.copy(e.emitter.normal).transformDirection(mw);
      h.copy(e.emitter.heightAxis).transformDirection(mw);
      obj.getWorldScale(s);
      const scale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
      e.light.width = e.emitter.width * scale;
      e.light.height = e.emitter.height * scale;
      // 稍微往前推，避免燈跟面板本身重疊
      e.light.position.copy(pos).addScaledVector(n, Math.min(e.light.width, e.light.height) * 0.01);
      e.light.up.copy(h);
      target.copy(e.light.position).add(n);
      e.light.lookAt(target);
      e.light.visible = e.light.intensity > 0;
      if (e.light.visible) shown++;
    }
    this.visibleCount = shown;
  }

  updateColors(
    sample: (objectId: string, uv: UvRect) => [number, number, number] | null,
    propsFor: (objectId: string) => LedLightProps,
    strength: number,
  ) {
    for (const e of this.entries) {
      const props = propsFor(e.objectId);
      // 沒 UV 或讀不到貼圖 → 用白色（只吃 tint / 亮度）
      const avg = (e.emitter.uv && sample(e.objectId, e.emitter.uv)) || [1, 1, 1];
      const { color, intensity } = emitterLightParams(avg as [number, number, number], props, strength);
      e.light.color.copy(color);
      e.light.intensity = intensity;
    }
  }

  dispose() {
    for (const e of this.entries) {
      this.scene.remove(e.light);
      e.light.dispose();
    }
    this.entries = [];
    this.emittersByObject.clear();
  }

  private removeObject(objectId: string) {
    this.entries = this.entries.filter((e) => {
      if (e.objectId !== objectId) return true;
      this.scene.remove(e.light);
      e.light.dispose();
      return false;
    });
    this.emittersByObject.delete(objectId);
  }

  private sortByArea() {
    this.entries.sort((a, b) => b.emitter.area - a.emitter.area);
  }
}
```

（燈只有在 `intensity > 0` 時才算亮著，所以測試在 `updatePoses` 前會先 `updateColors`。）

- [ ] **Step 4: 跑測試確認通過**

Run: `cd web && npx vitest run src/lib/stageLook/ledLightRig.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/stageLook/ledLightRig.ts web/src/lib/stageLook/ledLightRig.test.ts
git commit -m "feat(stage-look): LED 燈組（每塊發光面一盞 RectAreaLight，跟著物件動、跟著畫面變色）"
```

---

### Task 6: 只拍 LED 的動態環境光（ledEnvironment）

**Files:**
- Create: `web/src/lib/stageLook/ledEnvironment.ts`

**Interfaces:**
- Produces: `LED_LAYER = 2`、`class LedEnvironment { constructor(renderer: THREE.WebGLRenderer, size?: number); update(scene: THREE.Scene, center: THREE.Vector3, radius: number): THREE.Texture; readonly texture: THREE.Texture | null; dispose(): void }`

（需要 WebGL，node 測不了；在 Task 9 實機驗證。）

- [ ] **Step 1: 實作** — `web/src/lib/stageLook/ledEnvironment.ts`

```ts
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
```

- [ ] **Step 2: type-check**

Run: `cd web && npx tsc -b 2>&1 | grep -v TS6310`
Expected: 沒有輸出

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/stageLook/ledEnvironment.ts
git commit -m "feat(stage-look): 只拍 LED 的動態環境光（取代白色攝影棚）"
```

---

### Task 7: 後台存現場設定（look_settings）

**Files:**
- Modify: `cf-worker/migrations/0014_project_view_settings.sql`
- Modify: `cf-worker/worker.js`（`updateProject` 允許 + 驗證 `look_settings`；share data 回傳）

**Interfaces:**
- Produces: `PATCH /api/projects/:id` body 可帶 `lookSettings`（或 `look_settings`）物件；`GET /api/projects/:id` 的 `project.look_settings` 是 JSON 字串；share data 多 `lookSettings` 物件。

- [ ] **Step 1: migration 加欄位** — 在 `0014_project_view_settings.sql` 最後加：

```sql
--   look_settings     — 現場模式設定 JSON：{ houseLight, exposure, ledLightStrength, bloomStrength, reflectionSharpness, ledViewFalloff }
ALTER TABLE projects ADD COLUMN look_settings TEXT NOT NULL DEFAULT '{}';
```

（把檔頭註解的欄位說明也補上 look_settings。）

- [ ] **Step 2: worker 允許欄位** — `updateProject` 的 `allowed` 陣列加 `'look_settings'`；camelCase 轉換那段加：

```js
  if ('lookSettings' in body && !('look_settings' in body)) body.look_settings = body.lookSettings;
```

`touchesViewSettings` 改成：

```js
  const touchesViewSettings = 'scale_correction' in body || 'mechanism_offsets' in body || 'look_settings' in body;
```

在 `mechanism_offsets` 驗證後面加：

```js
  if ('look_settings' in body) {
    const clean = sanitizeLookSettings(body.look_settings);
    if (!clean) return jsonResp({ error: 'look_settings 不合法' }, 400);
    body.look_settings = JSON.stringify(clean);
  }
```

`onlyMechanism` 改成「只改滑桿或現場設定時不寫 activity」：

```js
  // 滑桿 / 現場設定拖動會一直存，不寫 activity（不然 audit log 會被洗版）
  const onlyLiveTweaks = sets.length > 0 && Object.keys(body).every(k =>
    ['mechanism_offsets', 'mechanismOffsets', 'look_settings', 'lookSettings'].includes(k));
  if (!onlyLiveTweaks) {
```

（把原本的 `onlyMechanism` 判斷整段換掉。）

在 `sanitizeMechanismOffsets` 後面加：

```js
// 現場模式設定：範圍要跟 web/src/lib/stageLook/lookSettings.ts 的 LOOK_SETTING_RANGES 一致
const LOOK_SETTING_RANGES = {
  houseLight: [0, 1],
  exposure: [0.2, 3],
  ledLightStrength: [0, 5],
  bloomStrength: [0, 3],
  reflectionSharpness: [0, 1],
  ledViewFalloff: [0, 1],
};

function sanitizeLookSettings(raw) {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [key, [min, max]] of Object.entries(LOOK_SETTING_RANGES)) {
    if (!(key in obj)) continue;
    const n = Number(obj[key]);
    if (!isFinite(n)) return null;
    out[key] = Math.max(min, Math.min(max, n));
  }
  return out;
}
```

- [ ] **Step 3: share data 回傳** — share data handler 的 SELECT 改成：

```js
      `SELECT id, name, description, model_r2_key, scale_correction, mechanism_offsets, look_settings FROM projects WHERE id = ? AND status != 'archived' LIMIT 1`
```

回傳物件加：

```js
      lookSettings: safeJsonObj(proj.look_settings, {}),
```

- [ ] **Step 4: 本機驗證**

```bash
cd cf-worker && node --check worker.js
CI=1 npx wrangler d1 migrations apply stage-previz-db --local --persist-to .wrangler/test-state
```

用 Task 7 前那套假資料（`TADMIN-LOCAL` admin、`TDIR-LOCAL` director、`p_test1`、share `tshare1`）跑 `wrangler dev --local --persist-to .wrangler/test-state --port 8787`，然後：
- admin `PATCH {"lookSettings":{"exposure":1.4,"bloomStrength":9}}` → 200；GET 回 `look_settings` = `{"exposure":1.4,"bloomStrength":3}`
- director 同樣 PATCH → 403
- `{"lookSettings":{"exposure":"abc"}}` → 400
- share data 有 `lookSettings`
- activity_log 沒有新增 lookSettings 的紀錄

Expected: 全部符合。測完停掉 wrangler dev、刪 `.wrangler/test-state`。

- [ ] **Step 5: Commit**

```bash
git add cf-worker/migrations/0014_project_view_settings.sql cf-worker/worker.js
git commit -m "feat(worker): 專案存現場模式設定 look_settings（admin 限定）"
```

---

### Task 8: 前端讀寫現場設定（api + hook）

**Files:**
- Modify: `web/src/lib/api.ts`（`ProjectViewSettings` 加 `lookSettings`；讀 `look_settings`；`SharePublicData.lookSettings`）
- Modify: `web/src/lib/projectViewSettings.ts`（pending 存檔改成合併 patch；加 `lookSettings` / `setLookSettings`）

**Interfaces:**
- Consumes: `LookSettings`、`normalizeLookSettings`、`DEFAULT_LOOK_SETTINGS`（Task 1）
- Produces: `ProjectViewSettingsState` 多 `lookSettings: LookSettings`、`setLookSettings: (patch: Partial<LookSettings>) => void`

- [ ] **Step 1: api.ts**

`import` 區加：

```ts
import { normalizeLookSettings, type LookSettings } from './stageLook/lookSettings';
```

`ProjectViewSettings` 改成：

```ts
export interface ProjectViewSettings {
  scaleCorrection: number;
  mechanismOffsets: MechanismOffsets;
  lookSettings: LookSettings;
}
```

`getProjectViewSettings` 的回傳型別參數加 `look_settings?: string`，結尾改成：

```ts
  let look: unknown = {};
  try { look = JSON.parse(data.project?.look_settings || '{}'); } catch { /* 壞資料當沒有 */ }
  return {
    scaleCorrection: isFinite(n) && n > 0 ? n : 1,
    mechanismOffsets: offsets,
    lookSettings: normalizeLookSettings(look),
  };
```

`SharePublicData` 加：

```ts
  lookSettings?: Partial<LookSettings>;
```

- [ ] **Step 2: projectViewSettings.ts — 存檔改成合併 patch**

把 `pendingRef` 型別改成：

```ts
  const pendingRef = useRef<{ timer: number; projectId: string; patch: Partial<api.ProjectViewSettings> } | null>(null);
```

`flushOffsets` 改名 `flushPending`，送出 `p.patch`，錯誤訊息改成「設定儲存失敗：」：

```ts
  const flushPending = useCallback((keepalive = false) => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    api.updateProjectViewSettings(p.projectId, p.patch, { keepalive })
      .catch(e => toast.error('設定儲存失敗：' + (e instanceof Error ? e.message : String(e))));
  }, []);
```

`scheduleSave` 改成合併：

```ts
  const scheduleSave = useCallback((patch: Partial<api.ProjectViewSettings>) => {
    if (!projectId) return;
    const prev = pendingRef.current;
    if (prev) clearTimeout(prev.timer);
    const merged = prev && prev.projectId === projectId ? { ...prev.patch, ...patch } : patch;
    pendingRef.current = {
      projectId,
      patch: merged,
      timer: window.setTimeout(() => flushPending(), SAVE_DELAY_MS),
    };
  }, [projectId, flushPending]);
```

`updateMechanismOffset` 改呼叫 `scheduleSave({ mechanismOffsets: next })`；`resetAllMechanismOffsets` 改成 `scheduleSave({ mechanismOffsets: {} }); flushPending();`；其他地方的 `flushOffsets` 全部改 `flushPending`。

加現場設定 state（放在 `mechanismOffsets` state 旁邊）：

```ts
  const [lookSettings, setLook] = useState<LookSettings>(DEFAULT_LOOK_SETTINGS);
  const lookRef = useRef<LookSettings>(DEFAULT_LOOK_SETTINGS);
  const applyLook = (s: LookSettings) => { lookRef.current = s; setLook(s); };
```

載入 effect 開頭 `applyOffsets({});` 後面加 `applyLook(DEFAULT_LOOK_SETTINGS);`；結尾 `applyOffsets(settings.mechanismOffsets);` 後面加 `applyLook(settings.lookSettings);`。

加 setter（放在 `resetAllMechanismOffsets` 後面）：

```ts
  const setLookSettings = useCallback((patch: Partial<LookSettings>) => {
    if (!canEdit) return;
    const next = normalizeLookSettings({ ...lookRef.current, ...patch });
    applyLook(next);
    scheduleSave({ lookSettings: next });
  }, [canEdit, scheduleSave]);
```

import 加：

```ts
import { DEFAULT_LOOK_SETTINGS, normalizeLookSettings, type LookSettings } from './stageLook/lookSettings';
```

`ProjectViewSettingsState` 介面加：

```ts
  lookSettings: LookSettings;
  setLookSettings: (patch: Partial<LookSettings>) => void;
```

return 物件加 `lookSettings, setLookSettings`。

檔頭用法註解加一行 `lookSettings={view.lookSettings} onLookSettingsChange={view.canEdit ? view.setLookSettings : undefined}`。

- [ ] **Step 3: type-check + 單元測試**

Run: `cd web && npx tsc -b 2>&1 | grep -v TS6310; npx vitest run`
Expected: tsc 沒輸出；vitest 全過

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/projectViewSettings.ts
git commit -m "feat(stage-look): 前端讀寫現場設定（跟校準 / 滑桿同一個 hook、合併存檔）"
```

---

### Task 9: StageScene 接上現場模式

**Files:**
- Create: `web/src/components/LookSettingsPanel.tsx`
- Modify: `web/src/components/StageScene.tsx`

**Interfaces:**
- Consumes: Task 1~6 全部
- Produces: StageScene props 新增 `lookSettings?: LookSettings`、`onLookSettingsChange?: (patch: Partial<LookSettings>) => void`；`defaultRenderMode?: 'quick' | 'live' | 'realistic' | 'cinematic'`

- [ ] **Step 1: 現場設定面板** — `web/src/components/LookSettingsPanel.tsx`

```tsx
import { DEFAULT_LOOK_SETTINGS, LOOK_SETTING_RANGES, type LookSettings } from '../lib/stageLook/lookSettings';

interface Props {
  settings: LookSettings;
  onChange: (patch: Partial<LookSettings>) => void;
  onClose: () => void;
}

const ROWS: { key: keyof LookSettings; label: string; hint: string; step: number }[] = [
  { key: 'houseLight', label: '現場底光', hint: '舞台結構看得多清楚（0 = 只有 LED）', step: 0.01 },
  { key: 'exposure', label: '曝光', hint: '整體亮暗，像相機', step: 0.05 },
  { key: 'ledLightStrength', label: 'LED 照明', hint: 'LED 照到舞台的強度', step: 0.05 },
  { key: 'bloomStrength', label: '光暈', hint: '亮的 LED 周圍暈開多少', step: 0.05 },
];

/** 現場模式設定（admin 才看得到；改了全專案共用） */
export default function LookSettingsPanel({ settings, onChange, onClose }: Props) {
  const reset = () => {
    const patch: Partial<LookSettings> = {};
    for (const r of ROWS) patch[r.key] = DEFAULT_LOOK_SETTINGS[r.key];
    onChange(patch);
  };
  return (
    <div
      data-ui-element
      style={{
        position: 'absolute', top: 64, right: 12, zIndex: 45, width: 260,
        background: 'rgba(20, 20, 24, 0.92)', backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: 12,
        color: '#eee', fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>🎚 現場設定</strong>
        <button className="btn btn--ghost btn--sm" onClick={reset} title="回到預設值">重設</button>
        <button className="btn btn--ghost btn--sm" onClick={onClose} title="關閉">×</button>
      </div>
      {ROWS.map(r => {
        const [min, max] = LOOK_SETTING_RANGES[r.key];
        return (
          <label key={r.key} style={{ display: 'block', marginBottom: 10 }} title={r.hint}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{r.label}</span>
              <span style={{ opacity: 0.7 }}>{settings[r.key].toFixed(2)}</span>
            </div>
            <input
              type="range" min={min} max={max} step={r.step}
              value={settings[r.key]}
              onChange={e => onChange({ [r.key]: parseFloat(e.target.value) })}
              style={{ width: '100%' }}
            />
          </label>
        );
      })}
      <div style={{ opacity: 0.6, fontSize: 11 }}>改了會自動存，導演 / 動畫師看到的一樣</div>
    </div>
  );
}
```

- [ ] **Step 2: StageScene imports / 型別 / props**

- 刪掉 `import { RoomEnvironment } ...`。
- 加：

```ts
import LookSettingsPanel from './LookSettingsPanel';
import { DEFAULT_LOOK_SETTINGS, type LookSettings } from '../lib/stageLook/lookSettings';
import { buildLedEmitters, type LedEmitter } from '../lib/stageLook/ledEmitters';
import { LedLightRig, type LedLightProps } from '../lib/stageLook/ledLightRig';
import { LedEnvironment, LED_LAYER } from '../lib/stageLook/ledEnvironment';
import { TextureColorReader, type LedColorSource } from '../lib/stageLook/textureColorReader';
import { QUALITY, detectQualityProfile } from '../lib/stageLook/quality';
```

- `Props` 的 `defaultRenderMode?: RenderMode;` 改成 `defaultRenderMode?: RenderMode | 'realistic' | 'cinematic';`，並加：

```ts
  /** 現場模式設定（存在專案上全員共用）；沒傳用預設 */
  lookSettings?: LookSettings;
  /** 有傳才顯示「🎚 現場設定」面板 — 只有 admin */
  onLookSettingsChange?: (patch: Partial<LookSettings>) => void;
```

- `type RenderMode = 'quick' | 'realistic' | 'cinematic';` 改成 `type RenderMode = 'quick' | 'live';`
- 元件參數解構加 `lookSettings = DEFAULT_LOOK_SETTINGS, onLookSettingsChange`。
- `useState<RenderMode>(defaultRenderMode || 'quick')` 改成：

```ts
  // 舊的 realistic / cinematic 都併成「現場」
  const [renderMode, setRenderMode] = useState<RenderMode>(
    defaultRenderMode && defaultRenderMode !== 'quick' ? 'live' : 'quick',
  );
  const [lookPanelOpen, setLookPanelOpen] = useState(false);
```

- [ ] **Step 3: refs**

刪掉 `ledLightsRef`、`envRTRef` 兩個 ref（含註解），在原位置加：

```ts
  // 現場模式：LED 燈組 / 只拍 LED 的環境光 / 取色器 / 每個 LED 物件的發光面
  const ledRigRef = useRef<LedLightRig | null>(null);
  const ledEnvRef = useRef<LedEnvironment | null>(null);
  const colorReaderRef = useRef<TextureColorReader | null>(null);
  const emitterCacheRef = useRef<WeakMap<THREE.Object3D, LedEmitter[]>>(new WeakMap());
  // objectId → 目前 LED 用的貼圖（取色用）/ 燈的參數
  const ledSourcesRef = useRef<Map<string, LedColorSource | null>>(new Map());
  const ledLightPropsRef = useRef<Map<string, LedLightProps>>(new Map());
  const helpersRef = useRef<{ grid: THREE.GridHelper; axes: THREE.AxesHelper } | null>(null);
  // 舞台中心 / 大小（環境光 CubeCamera 放這裡）
  const stageBoundsRef = useRef<{ center: THREE.Vector3; radius: number }>({ center: new THREE.Vector3(0, 1, 0), radius: 10 });
  const qualityRef = useRef(QUALITY[detectQualityProfile({
    maxTouchPoints: navigator.maxTouchPoints || 0,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    userAgent: navigator.userAgent,
  })]);
  const lookRef = useRef<LookSettings>(lookSettings);
  lookRef.current = lookSettings;
  const showLabelsRef = useRef(true);
```

- [ ] **Step 4: mount effect**

- `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));` 改成 `renderer.setPixelRatio(Math.min(window.devicePixelRatio, qualityRef.current.pixelRatioCap));`
- 整段「Material Phase C：HDR IBL」(RoomEnvironment / PMREM try 區塊）換成：

```ts
    // ── 現場模式：LED 燈組 + 只拍 LED 的環境光 + 取色器 ──
    ledRigRef.current = new LedLightRig(scene);
    ledRigRef.current.setMaxLights(qualityRef.current.maxLights);
    try {
      ledEnvRef.current = new LedEnvironment(renderer);
    } catch (e) {
      console.warn('[StageScene] LED environment init failed:', e);
    }
    colorReaderRef.current = new TextureColorReader();
```

- grid / axes 建好後加：`helpersRef.current = { grid, axes };`
- cleanup：刪掉 `envRTRef` 那兩行，加：

```ts
      try { ledRigRef.current?.dispose(); } catch {}
      ledRigRef.current = null;
      try { ledEnvRef.current?.dispose(); } catch {}
      ledEnvRef.current = null;
      colorReaderRef.current = null;
      helpersRef.current = null;
```

- [ ] **Step 5: render loop**

在 tick 的變數區（`let lastTickTs` 附近）加：

```ts
    let lastColorTs = 0;
    let lastEnvTs = 0;
```

把 mock 動畫那段之後、render 之前改成：

```ts
      const live = rmode === 'live';
      const rig = ledRigRef.current;
      if (live && rig) {
        rig.updatePoses(meshesRef.current);
        // 取色：每 100ms 一次（跟著畫面內容變色）
        if (nowTs - lastColorTs > 100 && colorReaderRef.current) {
          lastColorTs = nowTs;
          const reader = colorReaderRef.current;
          reader.beginFrame();
          const sources = ledSourcesRef.current;
          const props = ledLightPropsRef.current;
          const fallback: LedLightProps = { brightness: 1, castStrength: 1, tint: new THREE.Color(1, 1, 1) };
          rig.updateColors(
            (id, uv) => { const src = sources.get(id); return src ? reader.sample(src, uv) : null; },
            (id) => props.get(id) || fallback,
            lookRef.current.ledLightStrength,
          );
        }
        // 環境光：依畫質檔定時更新
        const env = ledEnvRef.current;
        if (env && !renderer.xr.isPresenting && nowTs - lastEnvTs > qualityRef.current.envIntervalMs) {
          lastEnvTs = nowTs;
          const b = stageBoundsRef.current;
          scene.environment = env.update(scene, b.center, b.radius);
        }
      }
```

render 判斷 `if (rmode === 'cinematic' && composerRef.current && !inXR)` 改成 `if (live && composerRef.current && !inXR)`（`inXR` 宣告要移到這段前面或沿用）。

鎖頭那行改成只在可編輯 + Label 開著時更新：

```ts
      // 鎖頭 pin：只在可編輯頁、Label 開著時顯示
      if (!inXR && !readOnlyRef.current && showLabelsRef.current) {
        updateLockPins(lockPinLayerRef.current, statesRef.current || [], meshesRef.current, camera, container);
      }
```

（若 StageScene 還沒有 `readOnlyRef`，在 refs 區加 `const readOnlyRef = useRef(readOnly); readOnlyRef.current = readOnly;`。）

- [ ] **Step 6: resize（bloom 依畫質縮放）**

`bloomPassRef.current?.setSize(w, h);` 改成：

```ts
      const bs = qualityRef.current.bloomScale;
      bloomPassRef.current?.setSize(Math.round(w * bs), Math.round(h * bs));
```

- [ ] **Step 7: 模型載入時記下舞台中心 / 大小**

auto-fit camera 區塊裡（`homeViewRef.current = ...` 後面）加：

```ts
          stageBoundsRef.current = { center: finalCenter.clone(), radius: finalDiag / 2 };
```

- [ ] **Step 8: render mode effect 整段換掉**

```ts
  // ── Render mode（quick / live）+ 現場設定 ──
  useEffect(() => {
    const env = envLightsRef.current;
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!env || !scene || !renderer) return;
    const live = renderMode === 'live';
    const look = lookSettings;
    // 現場：暗場，底光可調；Quick：維持原本明亮工作燈
    env.ambient.intensity = live ? 0.02 + look.houseLight * 0.5 : 0.55;
    env.hemi.intensity = live ? 0.03 + look.houseLight * 0.6 : 0.3;
    if (env.key) env.key.intensity = live ? look.houseLight * 0.4 : 0.7;
    (scene.background as THREE.Color).set(live ? 0x050506 : 0x16181c);
    if (helpersRef.current) {
      helpersRef.current.grid.visible = !live;
      helpersRef.current.axes.visible = !live;
    }
    // 現場：Neutral tone mapping 保留 LED 飽和色；Quick 維持 ACES（畫面不變）
    renderer.toneMapping = live ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = live ? look.exposure : 1;
    if (!live) scene.environment = null;
    scene.environmentIntensity = live ? 0.5 + look.ledLightStrength * 0.5 : 1;
    const bloom = bloomPassRef.current;
    if (bloom) {
      bloom.strength = look.bloomStrength;
      bloom.radius = 0.55;
      bloom.threshold = 0.6;
    }
    ledRigRef.current?.setEnabled(live);
  }, [renderMode, lookSettings]);
```

- [ ] **Step 9: 材質 effect**

- 刪掉 `const ledLights = ledLightsRef.current;`。
- `obj.traverse` 裡第一行（取得 `m` 之前）加：`if (isLed) c.layers.enable(LED_LAYER);`
- `const isLit = renderMode !== 'quick'; // realistic + cinematic 都打 LED` 註解改成 `// 現場模式才打 LED`。
- 整段「3. LED RectAreaLight（realistic / cinematic 都打）」到 `else if (light) {...}` 結束，換成：

```ts
      // 3. LED 照明：記下取色來源 / 燈參數，發光面只算一次（換模型才重算）
      if (isLed && so) {
        ledSourcesRef.current.set(id, ledTexture ? { image: ledTexture.image as CanvasImageSource, flipY: ledTexture.flipY } : null);
        ledLightPropsRef.current.set(id, {
          brightness: so.ledProps?.brightness ?? 1,
          castStrength: so.ledProps?.castLightStrength ?? 1,
          tint: ledTint.clone(),
        });
        let emitters = emitterCacheRef.current.get(obj);
        if (!emitters) {
          emitters = buildLedEmitters(obj, { maxAngleDeg: 35, maxPerObject: 4 });
          emitterCacheRef.current.set(obj, emitters);
        }
        ledRigRef.current?.setObjectEmitters(id, emitters);
        ledIds.add(id);
      }
```

- 在 `meshes.forEach(...)` 之前加 `const ledIds = new Set<string>();`，結尾那個清理 `ledLights` 的 `for` 迴圈換成：

```ts
    ledRigRef.current?.retainObjects(ledIds);
    for (const id of [...ledSourcesRef.current.keys()]) {
      if (!ledIds.has(id)) { ledSourcesRef.current.delete(id); ledLightPropsRef.current.delete(id); }
    }
```

- `void RectAreaLightHelper;` 那行保留不動。

- [ ] **Step 10: Label / 鎖頭顯示**

Label visibility effect 改成：

```ts
  // ── Label visibility（鎖頭 pin 跟著 Label，且唯讀頁不顯示）──
  useEffect(() => {
    showLabelsRef.current = showLabels;
    const layer = labelLayerRef.current;
    if (layer) layer.style.display = showLabels ? '' : 'none';
    const lockLayer = lockPinLayerRef.current;
    if (lockLayer) lockLayer.style.display = showLabels && !readOnly ? '' : 'none';
  }, [showLabels, readOnly]);
```

label 文字的兩處 `(s.locked ? '🔒 ' : '')` 都改成 `(s.locked && !readOnly ? '🔒 ' : '')`，並把 `readOnly` 加進那個 sync effect 的依賴陣列。

- [ ] **Step 11: 工具列**

`cycleRenderMode`、`renderModeLabel`、`renderModeNext` 換成：

```ts
  // 兩個模式：⚡ 快速（像素 1:1 對顏色）↔ 🎤 現場（暗場 + LED 照明 + 光暈）
  const cycleRenderMode = useCallback(() => {
    setRenderMode(m => (m === 'quick' ? 'live' : 'quick'));
  }, []);
  const renderModeLabel = renderMode === 'live' ? '🎤 現場' : '⚡ 快速';
  const renderModeNext = renderMode === 'live' ? '快速（像素 1:1 對顏色）' : '現場（暗場 + LED 照明 + 光暈）';
```

模式按鈕後面加現場設定按鈕：

```tsx
        {renderMode === 'live' && onLookSettingsChange && (
          <button
            className={'tool ' + (lookPanelOpen ? 'is-active' : '')}
            onClick={() => setLookPanelOpen(o => !o)}
            title="現場設定：底光 / 曝光 / LED 照明 / 光暈（所有人共用）"
          >🎚 設定</button>
        )}
```

在 toolbar `</div>` 後面加：

```tsx
      {lookPanelOpen && renderMode === 'live' && onLookSettingsChange && (
        <LookSettingsPanel settings={lookSettings} onChange={onLookSettingsChange} onClose={() => setLookPanelOpen(false)} />
      )}
```

- [ ] **Step 12: 型別 / build / 單元測試**

Run: `cd web && npx tsc -b 2>&1 | grep -v TS6310; npx vitest run; npm run build 2>&1 | grep -E "error|built"`
Expected: tsc 沒輸出、vitest 全過、`✓ built`

- [ ] **Step 13: Commit**

```bash
git add web/src/components/LookSettingsPanel.tsx web/src/components/StageScene.tsx
git commit -m "feat(stage-scene): 現場模式（暗場 + LED 依畫面顏色打光 + 光暈 + 現場設定）；鎖頭只在編輯 + Label 時顯示"
```

---

### Task 10: 各頁面接上現場設定

**Files:**
- Modify: `web/src/pages/ProjectEditor.tsx`、`web/src/pages/Studio.tsx`、`web/src/pages/Preview.tsx`、`web/src/pages/Share.tsx`、`web/src/components/CueStoryboard.tsx`

**Interfaces:**
- Consumes: `view.lookSettings`、`view.setLookSettings`（Task 8）；StageScene `lookSettings` / `onLookSettingsChange`（Task 9）

- [ ] **Step 1: ProjectEditor / Studio / Preview** — 每個 `<StageScene` 加：

```tsx
              lookSettings={view.lookSettings}
              onLookSettingsChange={view.canEdit ? view.setLookSettings : undefined}
```

ProjectEditor 傳給 `<CueStoryboard` 的 props 加 `lookSettings={view.lookSettings}`。

- [ ] **Step 2: Share** — `<StageScene` 加：

```tsx
              lookSettings={normalizeLookSettings(data.lookSettings)}
```

並 `import { normalizeLookSettings } from '../lib/stageLook/lookSettings';`

- [ ] **Step 3: CueStoryboard** — Props 加 `lookSettings?: LookSettings;`（import type），解構加 `lookSettings`，hidden `<StageScene` 加 `lookSettings={lookSettings}`。

- [ ] **Step 4: defaultRenderMode** — Studio 的 `defaultRenderMode="realistic"`、Preview / Share / CueStoryboard 的 `"cinematic"` 都改成 `"live"`。

- [ ] **Step 5: 型別 / build**

Run: `cd web && npx tsc -b 2>&1 | grep -v TS6310; npm run build 2>&1 | grep -E "error|built"`
Expected: tsc 沒輸出、`✓ built`

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/ProjectEditor.tsx web/src/pages/Studio.tsx web/src/pages/Preview.tsx web/src/pages/Share.tsx web/src/components/CueStoryboard.tsx
git commit -m "feat: 各頁面接上現場設定，預設現場模式"
```

---

### Task 11: 實機調校 + 驗證

**Files:**
- Modify（只在需要調數值時）：`web/src/lib/stageLook/ledLightRig.ts`（`LED_LIGHT_BASE_INTENSITY`）、`web/src/components/StageScene.tsx`（底光對應、environmentIntensity、bloom threshold / radius）

- [ ] **Step 1: 本機起 dev server**（preview_start `stage-previz-web`），用正式後台 + 用戶的 NDI helper（AE 送畫面）。

- [ ] **Step 2: 主舞臺（p_4sz3gy0dmv6aizku）現場模式檢查**
- 背景暗、grid / axes 不見
- 每片 LED 前方的地板 / 結構被畫面顏色照到（紅畫面 → 偏紅）
- 亮的 LED 有光暈、LED 顏色不灰
- 鎖頭圖示：Label 關掉時不見
- console 沒有新錯誤；FPS 正常（`renderer.info.render.calls` 不暴增）

- [ ] **Step 3: 2026 金曲獎（p_opbbvdhtmp28vrku）同樣檢查**（另一種模型結構：LED 有 Alpha / Mat.1 子物件）。

- [ ] **Step 4: Quick 模式對照** — 切回 ⚡ 快速，畫面跟改之前一樣（LED 像素 1:1、grid 在、亮工作燈）。

- [ ] **Step 5: 調數值** — 依實際畫面調 `LED_LIGHT_BASE_INTENSITY`、底光對應、`environmentIntensity` 公式、bloom threshold；每次調完重看。

- [ ] **Step 6: iPad 寬度**（resize_window tablet）確認順暢、燈數 ≤ 8（`maxTouchPoints` 模擬不到時至少確認畫面正常）。

- [ ] **Step 7: 截圖給用戶看（現場模式 2 張：主舞臺 + 金曲獎），等用戶回饋再調。**

- [ ] **Step 8: Commit 調整後的數值**

```bash
git add -A web/src
git commit -m "tune(stage-look): 依實機畫面調 LED 照明 / 底光 / 光暈數值"
```
