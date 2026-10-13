# Mechanism system (機關系統) — design

Date: 2026-10-14. Status: implemented on `feat/live-stage-look` (see section 15 for what changed during implementation). Roadmap: `docs/ROADMAP.md` section 3.
Branch at time of writing: `feat/live-stage-look`. Migration number: **0023**. 0022 belongs to the invite-links work, and the two have no dependency on each other.

Language: this spec is in English. Every string that appears in the UI is quoted in Traditional Chinese, exactly as it should ship. The UI uses no emoji, only the `Icon` component (`web/src/components/Icon.tsx`, lucide-react). `web/src/test/noEmojiInUi.test.ts` enforces this.

---

## 0. Decisions at a glance

| # | Decision | Why (one line) |
|---|---|---|
| 1 | Three new tables: `mechanisms`, `mechanism_objects`, `cue_mechanism_positions`. Mechanism values are **not** stored inside `cue_object_states`. | Object states inherit as a whole record (cueStates.mjs). Putting mechanism values in object rows would break position inheritance for later cues. A separate table also gives FK cascades and simple cue-sheet queries. |
| 2 | A mechanism value is a **scalar offset from the object's cue pose**: meters for 直線, degrees for 旋轉. 0 means "where the cue put the object". | This matches the old slider (it stored meters and converted with `scaleCorrection` when drawing). It is also what an automation operator thinks in. The model's scale is never touched. |
| 3 | Mechanisms form a **tree** (`parent_id`, e.g. a lift inside a revolve). Each object belongs directly to at most one mechanism. | One clear composition order, physically correct, and ready for collision checks later. |
| 4 | Inheritance: a cue's own value, else the nearest earlier **master** cue (by `order`) that set it, else the mechanism default. This is the same rule as object states. One shared pure function computes it for every page. | Share, director, studio and editor give identical results. |
| 5 | **One place applies the mechanisms**: once per frame, at the end, in StageScene. Tweens, the video timeline and drag-to-save all work in base (cue) space. Saving uses the exact inverse. | This removes the class of bug fixed in 23af5a1 (offset applied twice), and makes rotation mechanisms move along arcs instead of chords. |
| 6 | Playback when a 轉場 (transition) is too short: **the machine moves at its real maximum speed and arrives late.** The admin sees a warning and a one-click 「照機器速度」 fix. | The preview's job is to expose problems before the venue does. Mechanisms with no speed set keep today's behavior. |
| 7 | Speed check uses the *effective* move window (`cueWindows` clamps the start to the previous cue's arrival). If the gap between video times is too short, it says so instead of offering a fix that cannot work. | Making 轉場 longer does not help when the previous cue arrives later than the new start would be. |
| 8 | Export: **CSV (UTF-8 with BOM, opens in Excel)**, one row per song × cue × mechanism, plus a legend. Built in the browser. | Operators sort and filter by axis, add their own columns, and re-key values into their console. Excel can also print it as a PDF. A PDF cannot become a spreadsheet. |
| 9 | Existing project-wide slider values are converted by migration 0023 into per-LED mechanisms. Their default equals the old offset and they have no speed limit, so **nothing visibly changes**. The old column is kept, and the old site's writes are mirrored into the new tables during the preview period. | The frontend preview and the live site share one backend and one database. |
| 10 | All mechanism code lives in new modules (`web/src/lib/mechanisms/*`, `web/src/components/mechanisms/*`, `cf-worker/mechanisms.mjs`). Edits to Preview/Share/Studio/ProjectEditor/api.ts are one-line prop swaps, done late. | Other agents are editing those files right now. |

---

## 1. Goals and non-goals

Goals (from the roadmap and the brief):
1. Define each mechanism once: which objects it moves (a group), its type (直線移動 / 旋轉), its direction or axis, its travel range (行程, min/max in m or °), its max speed (最高速度, m/s or °/s), and optional named positions (常用位置, e.g. 收起 / 半開 / 全開).
2. Each cue stores its own position for each mechanism and inherits from the previous cue when unset. The slider is clamped to the travel range. A named position is one click; dragging and typing give precise values.
3. Speed check with a one-click 「照機器速度」. Defined playback behavior when 轉場 is too short.
4. Export a mechanism cue sheet (機關總表) that is useful to a stage-automation operator.
5. Do not block collision highlighting later.
6. Animators (動畫師) and directors (導演) cannot edit mechanisms. They just see them move.

Non-goals for this version: acceleration and deceleration ramps (加減速); collision detection; dragging the mechanism itself in 3D (dragging an object still edits that object's own cue position); live control of real machines.

---

## 2. Current state (exactly what exists today)

### 2.1 Data
- `cf-worker/migrations/0014_project_view_settings.sql:3,8` adds `projects.mechanism_offsets TEXT NOT NULL DEFAULT '{}'`, with the shape `{ "<stage_object_id>": { "x": meters, "y": meters } }`. There is one set per project, shared by every cue of every song.
- The stage object category `'mechanism'` exists (`0002_stage_objects.sql:14`; `web/src/lib/api.ts:518`; `web/src/components/stageCategories.ts:7` label 「機關」). The GLB prefixes `STAGE_` / `MECH_` map to it (`web/src/lib/parseGlb.ts:44-45`). The default seed includes 「旋轉舞臺」 and 「中央升降台」 (`cf-worker/worker.js:2401-2402`). **The slider never moves these objects.** They only move through ordinary per-cue object positions and rotations, like any other object.
- `stage_objects.metadata` has a comment that mentions 「機關旋轉軸」 (`0002_stage_objects.sql:19`). Nothing uses it.

### 2.2 Backend
- `cf-worker/worker.js:571` puts `mechanism_offsets` in the PATCH-able project fields. Lines 580-581 map camelCase. Lines 586-589 make it global-admin only. Lines 642-646 sanitize it with `sanitizeMechanismOffsets` (lines 700-716: at most 500 entries, each value clamped to ±100 m, zeros dropped). Lines 692-693 skip the activity log for slider-only writes.
- `cf-worker/access.mjs:21` (comment) and `:334-338` (`PROJECT_GLOBAL_ADMIN_FIELDS`) put `mechanism_offsets` under "global admin only".
- The share bundle returns `mechanismOffsets` (`cf-worker/worker.js:5297` select, `:5342` response).
- Duplicating a project copies `scale_correction` but **not** `mechanism_offsets` (`worker.js:820-832`). Project export/import does not include it either (`worker.js:1074-1121`, `1125+`). Both are existing gaps that this design closes.
- Object-state inheritance: `cf-worker/cueStates.mjs:5-8,30-87` (`buildCueStates`), fed by `loadCueStates` (`worker.js:2449-2488`). The "earlier cues" query filters by `order` only, not by `status`.

### 2.3 Frontend
- `web/src/components/MechanismPanel.tsx` (139 lines) shows two sliders (X 左右 / Y 上下, ±10 m by default, `range = 10` at line 21) for every `led_panel` object only (line 23). It is mounted under the song list in the editor's left column (`web/src/pages/ProjectEditor.tsx:980-988`, imported at line 7) and shown to admins only.
- `web/src/lib/projectViewSettings.ts` stores the offsets together with calibration and look settings: a 500 ms debounced save (line 29); a one-time localStorage migration of the key `mechanism-offsets:<projectId>` (lines 33-53, 151-152); `updateMechanismOffset` and `resetAllMechanismOffsets` (lines 211-231).
- `web/src/lib/api.ts:259-296` parses the offsets (`MechanismOffsets` type at line 262). `SharePublicData.mechanismOffsets` is at lines 1217-1218.
- Applying the offset: `scenePosition()` in `web/src/lib/cueTimeline.ts:106-117` adds `offset / scaleCorrection` to x/y, for `led_panel` only. Called from `web/src/components/StageScene.tsx:893` (video-timeline frame), `:918` (timeline switched off), and `:1353` (states effect). Props are at `StageScene.tsx:132-135` and refs at `:252-255`. The effect re-runs when `mechanismOffsets` changes (deps at `:1422`).
- Reversing it on drag: `cuePositionFromScene()` in `web/src/lib/mechanismOffset.ts:12-22`, used at `StageScene.tsx:621-628` by `toCuePosition` for single and multi-select drags. Tests: `web/src/lib/mechanismOffset.test.ts`.
- Pages pass the project-wide offsets: `ProjectEditor.tsx:1035`, `Preview.tsx:686`, `Studio.tsx:582`, `Share.tsx:461`, `CueStoryboard.tsx:27-29,274-275`.
- Calibration text that mentions the slider: `StageScene.tsx:2410` (title) and `:2453` (dialog), 「…測距、比例尺、機關滑桿都會用這個倍率」. Code comment in `web/src/lib/numberField.ts:4`.

### 2.4 The double-apply bug (commit 23af5a1)
Before the fix, dragging an LED in 3D read the **scene** position (cue position + offset) and saved it as the cue position. Drawing then added the offset again, so the LED jumped away by one offset. The fix subtracts the offset before saving (`cuePositionFromScene`). It only handles translation along X/Y. It works only because the offset is a constant that never animates. Per-cue values that animate, and rotation mechanisms, need a structural fix (section 6.3), not another subtraction.

### 2.5 Units and model scale (must not change)
Object positions are stored in **scaled scene units**: the model's automatic scale factor applied at load. That scale must not change, because changing it would corrupt every stored cue position (memory note `project_model_scale_locked`; code comment at `StageScene.tsx:175`). Real-world meters come from the project's measuring calibration: `meters = sceneUnits × scaleCorrection`, using `sceneToMeters` / `metersToScene` in `web/src/lib/numberField.ts:28-38`. The admin sets the factor with the 3D measure tool (「設為已知距離」, `StageScene.tsx:2404-2490`). It is stored in `projects.scale_correction` and defaults to 1 (uncalibrated).

### 2.6 What happens to each existing piece

| Item | Fate |
|---|---|
| `projects.mechanism_offsets` | 0023 converts it into mechanisms. The column is kept: still readable by the old live site and mirrored into the new tables until the new frontend is on master. After that the backend refuses writes to it. The column is never dropped, because dropping is a data deletion and saves nothing. |
| `MechanismPanel.tsx` | Replaced by the 機關 tab (section 7). Deleted in the cleanup task. |
| `mechanismOffset.ts`, `cueTimeline.scenePosition` | Replaced by `lib/mechanisms/pose.ts`. Their tests become parity tests and are then removed in cleanup. |
| `projectViewSettings.ts` mechanism parts, `api.ts` `MechanismOffsets` | Removed in cleanup. Scale and look settings stay. |
| StageScene `mechanismOffsets` prop | Kept during the transition. If a page still passes it, StageScene converts it on the fly with the same legacy conversion (section 4.4), so un-migrated pages look identical. Removed in cleanup. |
| Calibration text 「機關滑桿」 | Becomes 「機關」. |

---

## 3. Terms (UI and the automation world)

| UI term | Meaning here | Automation-console term |
|---|---|---|
| 機關 | One controllable axis of stage machinery | axis |
| 直線移動 / 旋轉 | Linear (lift, track, wagon) / rotary (revolve, tilt) | linear axis / rotary axis |
| 方向 / 轉軸 | Which way the number grows / the rotation axis | direction / axis of rotation |
| 轉軸中心 | Pivot point of a rotary mechanism | — |
| 行程 | Allowed range, min ~ max | travel, soft limits |
| 最高速度 | Max speed, m/秒 or °/秒 | max velocity |
| 常用位置 (收起 / 半開 / 全開 …) | Named target positions | positions, presets |
| 預設位置 | Position when no cue has set it | home / start position |
| 轉場 | Seconds the stage takes to arrive at a cue | move time, cue time |
| 沿用 | Inherited from an earlier cue | tracking |
| 控台編號 | The axis name on the operator's console, e.g. "Axis 12" | axis number / label |

Consoles generally describe a move by target position plus speed or time, with acceleration and deceleration, and enforce software travel limits per axis. The export (section 9) mirrors that: per cue and per axis, it lists the target, distance, time and speed. Acceleration is out of scope and stated in the sheet's notes.

---

## 4. Data model (D1)

### 4.1 Why tables, not JSON on cues and not `cue_object_states`
- **Not `cue_object_states.custom_props`.** `buildCueStates` inherits the *latest earlier row of an object as a whole*. If a cue row existed only to carry a mechanism value, later cues would inherit that row's null position and fall back to the object's default. A mechanism also moves a group, so its value is per mechanism, not per object.
- **Not a JSON column on `cues`.** Two admins editing different mechanisms on the same cue would overwrite each other (read, modify, write). Deleting a mechanism would leave stale keys. Copy operations need remapping either way.
- **Tables** give per-row upserts, `ON DELETE CASCADE` from cues, mechanisms and objects, and three straightforward queries for the cue sheet. `cueStates.mjs` and the states endpoint, which every page relies on, stay untouched.

### 4.2 Migration `cf-worker/migrations/0023_mechanisms.sql`

```sql
-- 0023 機關系統：每個機關設定一次（帶哪些物件、方向、行程、速度、常用位置），每個 cue 存自己的機關位置。
-- （0022 是邀請連結；兩個 migration 沒有相依）
--
-- mechanisms
--   kind           'linear' 直線移動 / 'rotary' 旋轉
--   axis           JSON {x,y,z}：場景座標的單位向量。直線 = 數字變大時往哪裡動；旋轉 = 轉軸（右手定則決定正的角度）
--   pivot          JSON {x,y,z}：旋轉中心，場景單位（跟 cue 位置同一種單位）；直線 = NULL
--   travel_min/max 行程（直線：公尺；旋轉：度）。0 = 物件在 cue 裡原本的位置
--   default_value  沒有 cue 設定時的位置
--   max_speed      最高速度（公尺/秒、度/秒）；NULL = 不檢查速度，照轉場秒數移動
--   presets        JSON [{"name":"全開","value":3.5}]：常用位置，最多 12 個
--   parent_id      裝在哪個機關上（例：轉台上的升降台）→ 跟著那個機關一起動
--   console_label  自動化控台上的軸名（選填，匯出機關總表用）
--   metadata       JSON，之後放加減速、碰撞外框等；現在 NULL
--   legacy_object_id / legacy_axis  從舊的「全專案機關滑桿」轉過來的（哪片 LED、'x' 或 'y'）；新建的是 NULL
--   edited_at      在新介面改過（定義，或任何 cue 的位置）的時間；NULL = 沒改過，舊滑桿的修改還會同步過來
CREATE TABLE IF NOT EXISTS mechanisms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('linear', 'rotary')),
  axis TEXT NOT NULL DEFAULT '{"x":0,"y":1,"z":0}',
  pivot TEXT,
  travel_min REAL NOT NULL DEFAULT 0,
  travel_max REAL NOT NULL DEFAULT 1,
  default_value REAL NOT NULL DEFAULT 0,
  max_speed REAL,
  presets TEXT NOT NULL DEFAULT '[]',
  parent_id TEXT,
  console_label TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  legacy_object_id TEXT,
  legacy_axis TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (travel_max > travel_min),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES mechanisms(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mechanisms_project ON mechanisms(project_id, "order");

-- 機關帶哪些物件（一組）。一個物件只能「直接」放在一個機關（要疊就用 parent_id）
CREATE TABLE IF NOT EXISTS mechanism_objects (
  mechanism_id TEXT NOT NULL,
  stage_object_id TEXT NOT NULL,
  PRIMARY KEY (mechanism_id, stage_object_id),
  FOREIGN KEY (mechanism_id) REFERENCES mechanisms(id) ON DELETE CASCADE,
  FOREIGN KEY (stage_object_id) REFERENCES stage_objects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mechanism_objects_object ON mechanism_objects(stage_object_id);

-- 每個 cue 自己設的機關位置（沒有 = 沿用前面的 cue / 預設位置）
CREATE TABLE IF NOT EXISTS cue_mechanism_positions (
  cue_id TEXT NOT NULL,
  mechanism_id TEXT NOT NULL,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cue_id, mechanism_id),
  FOREIGN KEY (cue_id) REFERENCES cues(id) ON DELETE CASCADE,
  FOREIGN KEY (mechanism_id) REFERENCES mechanisms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cmp_mechanism ON cue_mechanism_positions(mechanism_id);

-- ── 舊的全專案機關滑桿 → 機關（畫面不能變）────────────────────────────
-- 跟以前一樣只看 LED 面板、0 不轉。每片 LED：
--   只有左右 → 「<名稱> 左右」帶這片 LED；只有上下 → 「<名稱> 上下」帶這片 LED；
--   兩個都有 → 「上下」帶 LED、「上下」裝在「左右」上（兩個位移加起來 = 以前的位置）
-- 預設位置 = 舊位移；行程 = 舊滑桿的 -10 ~ 10 公尺（舊值超過就放寬到包含它）；不填速度 → 不檢查、不會慢下來
-- id 固定（mlx_ / mly_ + 物件 id）→ 重跑也不會多出來，後台同步舊滑桿時也找得到
INSERT OR IGNORE INTO mechanisms
  (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets,
   parent_id, "order", legacy_object_id, legacy_axis)
WITH legacy AS (
  SELECT p.id AS project_id, o.id AS object_id, o."order" AS object_order,
         COALESCE(NULLIF(TRIM(o.display_name), ''), o.mesh_name) AS label,
         COALESCE(CAST(json_extract(j.value, '$.x') AS REAL), 0) AS x,
         COALESCE(CAST(json_extract(j.value, '$.y') AS REAL), 0) AS y
    FROM projects p
    JOIN json_each(CASE WHEN json_valid(p.mechanism_offsets) THEN p.mechanism_offsets ELSE '{}' END) j
    JOIN stage_objects o ON o.id = j.key AND o.project_id = p.id AND o.category = 'led_panel'
)
SELECT 'mlx_' || object_id, project_id, label || ' 左右', 'linear', '{"x":1,"y":0,"z":0}', NULL,
       MIN(-10, x), MAX(10, x), x, NULL, '[]', NULL, object_order * 2, object_id, 'x'
  FROM legacy WHERE x != 0;

INSERT OR IGNORE INTO mechanisms
  (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets,
   parent_id, "order", legacy_object_id, legacy_axis)
WITH legacy AS ( /* same CTE as above */ )
SELECT 'mly_' || object_id, project_id, label || ' 上下', 'linear', '{"x":0,"y":1,"z":0}', NULL,
       MIN(-10, y), MAX(10, y), y, NULL, '[]',
       CASE WHEN x != 0 THEN 'mlx_' || object_id END, object_order * 2 + 1, object_id, 'y'
  FROM legacy WHERE y != 0;

INSERT OR IGNORE INTO mechanism_objects (mechanism_id, stage_object_id)
WITH legacy AS ( /* same CTE as above */ )
SELECT CASE WHEN y != 0 THEN 'mly_' ELSE 'mlx_' END || object_id, object_id
  FROM legacy WHERE x != 0 OR y != 0;
```
(In the real file the CTE is written out three times. SQLite allows `INSERT … WITH … SELECT`. JSON1 is available in D1.)

Notes:
- This SQL (tables plus conversion) was dry-run on 2026-10-14 in an in-memory `node:sqlite` with `foreign_keys = ON` after applying the real migrations 0001–0021. Results:
  - x only → `mlx_`;
  - x and y → `mly_` with `parent_id = mlx_`;
  - a blank display name falls back to the mesh name;
  - a y of 12 widens the range to -10 ~ 12;
  - non-LED, deleted-object and invalid-JSON projects are skipped;
  - a second run adds nothing;
  - deleting an object removes its membership, and deleting a cue removes its positions;
  - a second direct membership for an object is rejected.
- Offsets whose object was deleted, or is no longer `led_panel`, had no visible effect, and the JOIN skips them as well.
- Mechanism names are **not** UNIQUE in the database. Two LEDs with the same display name would make the migration silently skip one if they were. The API enforces unique names on create and rename.
- Stage-object ids look like `so_` plus about 20 characters, so `mlx_` + id stays well under the 64-character `ID_RE`.

### 4.3 Shapes in the API and the frontend (`web/src/lib/mechanisms/model.ts`)

```ts
export type MechanismKind = 'linear' | 'rotary';
export interface MechanismPreset { name: string; value: number }
export interface MechVec3 { x: number; y: number; z: number }   // local type: this file has no imports (the worker imports it)
export interface Mechanism {
  id: string;
  name: string;
  kind: MechanismKind;
  axis: MechVec3;                 // unit vector, scene axes, Y up
  pivot: MechVec3 | null;         // rotary only, scene units
  travelMin: number;              // m | °
  travelMax: number;
  defaultValue: number;
  maxSpeed: number | null;        // m/s | °/s; null = no speed check
  presets: MechanismPreset[];     // sorted by value
  parentId: string | null;
  objectIds: string[];
  consoleLabel: string | null;
  order: number;
  metadata: Record<string, unknown> | null;
  cueCount: number;               // how many cues have their own value (delete confirmation, setup list)
  updatedAt: string;
}
export type MechanismValues = Record<string, number>;          // mechanismId → value
export interface CueMechanismPosition { cueId: string; mechanismId: string; value: number; updatedAt: string }
```

Validation lives in `normalizeMechanismInput(raw, ctx)` and is shared by the editor (inline errors) and the worker (final check).

| Field | Rule | Error (zh-TW) |
|---|---|---|
| name | trimmed, 1 to 40 characters; unique in the project (checked by the worker) | 「機關名稱不能空白」 / 「這個專案已經有叫「{name}」的機關」 |
| kind | `linear` or `rotary` | 「機關類型不正確」 |
| axis | finite, length > 1e-6, then normalized | 「方向不正確」 |
| pivot | rotary: finite, each coordinate within ±1e5; linear: forced to null | 「轉軸中心要是數字」 |
| travelMin / travelMax | finite; max > min; linear within ±1000 m; rotary within ±36000° (multi-turn allowed) | 「行程的最高要比最低大」 |
| defaultValue | clamped into the travel range | — |
| maxSpeed | null, or 0 < v ≤ 100 m/s (linear) / ≤ 3600 °/s (rotary) | 「最高速度要是正的數字，或留空不檢查」 |
| presets | at most 12; name 1 to 20 characters, unique within the mechanism; value clamped into range | 「常用位置最多 12 個」 / 「常用位置的名稱重複了：「{name}」」 |
| objectIds | at most 200; must belong to the project (worker) | 「有物件不在這個專案裡」 |
| parentId | null, or a mechanism in the project; no cycles; depth ≤ 4 | 「不能選自己，或裝在自己上面的機關」 / 「機關一層套一層最多 4 層」 |
| consoleLabel | at most 40 characters | — |
| per-cue value | finite; the worker clamps it into the range and returns the stored value | 「位置要是數字」 |

An object that is already directly in another mechanism returns **409** with
`{ error: '「{object}」已經在「{mech}」裡，一個物件只能直接放在一個機關', conflicts: [{ objectId, objectName, mechanismId, mechanismName }] }`.
The UI then asks 「要把它移到「{name}」嗎？」 and resends with `moveObjects: true`.

### 4.4 Legacy conversion as a function (same result as the SQL)
`legacyOffsetsToMechanisms(offsets, stageObjects)` in `model.ts` returns the rows the SQL would create. It is used in three places:
1. **Worker mirroring during the transition.** While the old live site still exists, `updateProject` also calls `syncLegacyMechanismOffsets(env, projectId, offsets)` (in `cf-worker/mechanisms.mjs`) whenever the body contains `mechanism_offsets`. Per LED it upserts `mlx_<id>` / `mly_<id>` (default value, range widened to include the value, membership on `mly_` when it exists, parent link), **only when neither of them has an `edited_at`**. If they were touched in the new UI, the old slider can no longer overwrite them.
2. **StageScene fallback.** A page that still passes `mechanismOffsets` gets them converted on the fly.
3. **Parity test** against the SQL (section 11).

Any edit in the new UI sets `edited_at`: a definition PATCH, or any per-cue PUT or DELETE for that mechanism.

---

## 5. API routes and permissions

### 5.1 Permissions
These lines are added to the table at the top of `access.mjs`:
```
//   機關：看定義、每首歌每個 cue 的機關位置                                所有成員（分享連結：只看）
//   機關：新增 / 改 / 刪 / 排序、設定每個 cue 的機關位置、機關總表資料        admin（這個專案的 admin）
```
Mechanisms are project *content* (like cue positions), so writes need `editor`, meaning the project's admin. The old slider was global-admin only because it sat with the 3D view settings. Moving it to `editor` is deliberate and matches who can already move objects in cues. Directors and animators get 403 with `needDeniedMessage('editor')`, which is 「只有 admin 可以修改專案內容」.

### 5.2 Routes

| Method and path (under `/api/projects/:id`) | kind | need | Body → response |
|---|---|---|---|
| `GET /mechanisms` | `mechanisms.list` | member | → `{ mechanisms: Mechanism[] }` (by `order`; includes `cueCount`) |
| `POST /mechanisms` | `mechanisms.create` | editor | `MechanismInput & { moveObjects?: true }` → 201 `{ mechanism }` / 409 conflicts |
| `POST /mechanisms/reorder` | `mechanisms.reorder` | editor | `{ ids: string[] }` → `{ ok }` |
| `PATCH /mechanisms/:mechId` | `mechanisms.item` | editor | `Partial<MechanismInput> & { moveObjects? }` → `{ mechanism, outOfRangeCount }` |
| `DELETE /mechanisms/:mechId` | `mechanisms.item` | editor | → `{ ok, removedPositions }` (logged) |
| `GET /songs/:songId/mechanism-positions` | `mechPositions.list` | member | → `{ positions: CueMechanismPosition[] }` (own values, every cue of the song) |
| `PUT /songs/:songId/cues/:cueId/mechanisms/:mechId` | `mechPositions.item` | editor | `{ value }` → `{ ok, value, clamped }` |
| `DELETE /songs/:songId/cues/:cueId/mechanisms/:mechId` | `mechPositions.item` | editor | → `{ ok, removed }` (back to 沿用) |
| `GET /mechanism-sheet` | `mechanisms.sheet` | editor | → `{ songs: [{ id, name, code, order, cues: [{ id, name, order, videoTimeSec, crossfadeSeconds }] }], positions }` (master cues only; one request for the export) |

Share (no login, read-only; `/api/share/:token/...` and `/api/s/:slug/...`, handled in the existing share handler next to `wantStates`):
- The `data` bundle gains `mechanisms: Mechanism[]`.
- `GET songs/:songId/mechanism-positions` returns `{ positions }` for **master** cues only. The existing `link.song_id` scope check applies.

`describeProjectRoute` additions (`cf-worker/access.mjs`):
```js
    case 'mechanisms':
      if (!a) {
        if (read) return r('mechanisms.list', 'member');
        if (m === 'POST') return r('mechanisms.create', 'editor');
        return bad('mechanisms');
      }
      if (a === 'reorder' && !b) return m === 'POST' ? r('mechanisms.reorder', 'editor') : bad('mechanisms.reorder');
      if (!b) {
        if (m === 'PATCH' || m === 'DELETE') return r('mechanisms.item', 'editor', { mechId: a });
        return bad('mechanisms.item');
      }
      return null;
    case 'mechanism-sheet':
      return read ? r('mechanisms.sheet', 'editor') : bad('mechanisms.sheet');

    // inside case 'songs', after `if (b === 'videos') ...`
      if (b === 'mechanism-positions' && !c) {
        return read ? r('mechPositions.list', 'member', { songId }) : bad('mechPositions.list');
      }
    // inside the cue branch, after `if (d === 'states') { ... }`
      if (d === 'mechanisms') {
        if (!e) return null;
        if (m === 'PUT' || m === 'DELETE') return r('mechPositions.item', 'editor', { songId, cueId, mechId: e });
        return bad('mechPositions.item');
      }
```
`handleProjectsRouter` adds `route.mechId` to its id check loop. `loadProjectContext` adds
`SELECT id, kind, travel_min, travel_max FROM mechanisms WHERE id = ? AND project_id = ?` as `ctx.mechanism`. The router returns 404 「這個專案裡找不到這個機關」 when it is missing. Archived projects are already read-only through the router.

Handlers live in `cf-worker/mechanisms.mjs`. `worker.js` only gains `case` lines in `dispatchProjectRoute`, the share sub-path, and the copy-site calls below. The API is documented in a new `docs/mechanisms-api.md`, in the style of `videos-api.md`.

### 5.3 Every place that copies or clears cue content

| Site | `worker.js` | Mechanism handling |
|---|---|---|
| Duplicate project | 811+ | Copy mechanisms (new ids, `parent_id` remapped), `mechanism_objects` via `objIdMap`, and positions via `cueIdMap`. |
| Export / import project | 1074 / 1125 | Export adds `mechanisms`, `mechanismObjects`, `cueMechanismPositions`. Import remaps them; older files simply have none. |
| New cue `cloneFrom` | 1812 | Copy the source cue's own positions. |
| New cue `snapshotStates` | 1828 | Optional `snapshotMechanisms: { [mechId]: value }` from the client (current resolved values), stored as own values. |
| Cue template create / apply | 963 / 1844 | `payload.mechanismPositions: [{ name, value }]`, matched **by mechanism name** on apply and clamped into range. Global templates work across projects for that reason. |
| Import cues from another song | 1632 | Same project: copy by mechanism id. Another project: match by name. |
| Reset cue (`cues/:cueId/reset`) | 1893 | Also clears that cue's positions. The editor confirmation becomes 「重置「{name}」？這個 cue 自己設的物件位置和機關位置都會清掉，改回沿用上一個 cue。」 |
| Replace all objects (`bulk`, `replace`) | 2333-2357 | The cascade removes memberships. The 409 count gains `mechanismObjects`, and the message adds 「…也會清掉 {n} 個機關裡選的物件」. Mechanism definitions and per-cue values are kept, so the admin re-picks objects. |
| Delete object / cue / song / project | — | FK cascades. |

Activity log: mechanism create, update, delete and reorder are logged. Per-cue values are not logged, matching `upsertCueState`, so dragging a slider does not flood the log.

---

## 6. Shared logic

### 6.1 Modules

| File | Pure? | Used by |
|---|---|---|
| `web/src/lib/mechanisms/model.ts` | yes, **no imports** (the worker imports it, like `shareSlug.ts`) | worker, all pages |
| `web/src/lib/mechanisms/track.ts` | yes, type-only imports | all pages (inheritance) |
| `web/src/lib/mechanisms/motion.ts` | yes (no three); imports `cueWindows` from `cueTimeline.ts` | StageScene, editor warnings, export |
| `web/src/lib/mechanisms/pose.ts` | three.js | StageScene |
| `web/src/lib/mechanisms/cueSheet.ts` | yes | editor export |
| `web/src/lib/mechanisms/mechanismApi.ts` | fetch | hooks (kept separate from `api.ts`, like `videoApi.ts`) |
| `web/src/lib/mechanisms/useMechanisms.ts` | React | pages |

Worker tests run on Node 24, which executes `.ts` files directly. Shared files must therefore stay in erasable TS syntax: no `enum`, no `namespace`, no parameter properties (the same constraint already noted in `shareSlug.ts`).

### 6.2 Inheritance (`track.ts`, same rule as `cueStates.mjs`)

```
resolveSongMechanisms(mechs, cues, own: Map<cueId, MechanismValues>) → Map<cueId, Record<mechId, Resolved>>
  Resolved = { value, stored, source: 'own' | 'inherited' | 'default', fromCueId, clamped }

  masters = cues where status === 'master', sorted by order (ties: input order)
  last = {}                                    // mechId → { value, cueId }
  for c in masters:
    for m in mechs:
      o = own(c)[m]
      if o != null      → own,       last[m] = { o, c }
      else if last[m]   → inherited  (fromCueId = last[m].cueId)
      else              → default    (m.defaultValue)
  for c not master (proposal / alternate):
    start from the resolved row of the last master with order < c.order (or the defaults), then apply own(c)
  output value = clamp(stored, travelMin, travelMax); clamped = (value !== stored)
```
- Each mechanism is one scalar, so "nearest earlier cue that set it" is exactly the `buildCueStates` rule (own → earlier cue by `order` → default).
- **Only master cues carry inheritance.** The share page only ever receives master cues, so including proposals would make the share page disagree with the editor. `loadCueStates` currently includes non-master cues in its earlier set (`worker.js:2470-2486` has no status filter). That only affects object states, is out of scope, and is recorded in section 13.
- Clamping happens on output only. Stored values are never rewritten when the range changes. The panel shows the difference (section 7.4), and playback, panel and export all use the clamped value.

### 6.3 Composition, and why it can't double-apply (`pose.ts`)

**One rule:** what is stored is the *base* pose (the cue's object position and rotation, in scaled scene units). What is drawn is `scene = M(base, values)`. What is saved from a drag is `base = M⁻¹(scene, values)`. M and M⁻¹ live in one file, and StageScene applies M in **exactly one place**.

Compiled rig, rebuilt only when definitions or `scaleCorrection` change:
```
compileRig(mechs, scaleCorrection):
  per mechanism: axis (THREE.Vector3, unit), pivot (Vector3, scene units), parent,
                 linearSceneScale = 1 / scaleCorrection        // meters → scene units (same as numberField.metersToScene)
  per object: chain = [direct mechanism, its parent, grandparent, …]   (innermost first, cycle-safe, ≤ 4)

applyChain(chain, values, basePos, baseQuat, outPos, outQuat):      // no allocations: shared temporaries
  out = base
  for m in chain:                                                     // innermost → outermost
    v = values[m.id] ?? m.defaultValue    (already clamped)
    linear: outPos += m.axis * (v * m.linearSceneScale)
    rotary: q = axisAngle(m.axis, v° → rad); outPos = m.pivot + q·(outPos − m.pivot); outQuat = q · outQuat

basePoseFromScene(chain, values, scenePos, sceneQuat):               // exact inverse
  for m in reverse(chain): linear: pos −= axis·v·s;  rotary: q⁻¹ = axisAngle(axis, −v); pos = pivot + q⁻¹·(pos − pivot); quat = q⁻¹·quat
```
- Angles are applied as axis-angle of the current value. Values are never wrapped, so 0 → 720° makes two full turns. Interpolation happens on the scalar value, never by slerping between two orientations (slerp would take the short way and cut through the revolve).
- A child's pivot is expressed in the base frame, and the parent is applied after the child. A lift inside a revolve therefore orbits correctly, and the lift's own pivot is carried along.
- Linear values are meters, rotary values degrees, pivots scene units. The model scale never changes. Re-calibrating (`scaleCorrection`) changes how many scene units a 2 m travel covers, which is correct because the machine's spec is in meters. The setup panel says so when the project is not calibrated (section 7.5).
- With the legacy fixture (LED in `mly_` whose parent is `mlx_`, both linear), `applyChain` returns exactly `scenePosition()`, and `basePoseFromScene` returns exactly `cuePositionFromScene()`. That is the parity test.

**StageScene integration (the structural fix):**
1. Add `basePoseRef: Map<objectId, { pos: Vector3, quat: Quaternion }>`. Every path that today writes `mesh.position` / `mesh.quaternion` writes the base pose instead:
   - the states effect (`StageScene.tsx:1351-1388`);
   - the video timeline frame (`:881-898`);
   - the timeline-off branch (`:899-931`);
   - the tween step (`:933-948`).
   Tweens store `fromPos/toPos` **in base space**, and `fromPos` is the current base pose, not `mesh.position`.
2. Add a commit pass at the end of every frame. It first takes the mechanism values for this frame (section 6.4). Then for each object with `mesh.parent === scene` that is not currently attached to the dragging gizmo, it writes `mesh = applyChain(base)`. Objects without a chain get `mesh = base`. The states effect also commits once immediately, so snapshots and thumbnails never see a one-frame lag.
3. Drag end (`:621-671`): `toCuePosition` becomes `basePoseFromScene(chain, displayedValues, worldPos, worldQuat)` for both position and rotation, using the **values that were displayed on the drop frame**. The result is written into `basePoseRef` immediately (optimistic). Otherwise the next commit would snap the object back to its old base pose during the save round trip.
4. `scenePosition` and `mechanismOffsets` disappear from the states effect deps. A mechanism value change no longer re-runs the effect or retargets object tweens. It only changes the commit pass.

Cost: one chain apply per object in a mechanism per frame, with pre-allocated temporaries. That is a few hundred vector operations for a large stage, about 0.05 ms per frame.

### 6.4 Motion (`motion.ts`)

The speed model is constant velocity (等速), the same as object moves (`cueMoveProgress`). A mechanism with `maxSpeed === null` has no limit and moves exactly in the 轉場 time, like objects.

**Clicking a cue (editor, director, studio, share without video): `MechanismTweener`.** The time source is injected (`nowMs`), as with `AdaptiveQuality`, so it is testable.
```
retarget(targets, nowMs, { animate, minSeconds })
  per mechanism: from = valueAt(nowMs) (mid-move allowed), to = targets[m]
    !animate or from == to          → hold at `to`
    duration = max(minSeconds, maxSpeed ? |to − from| / maxSpeed : 0)
    duration == 0                   → jump
    else                            → linear from→to over `duration`
valuesAt(nowMs) → MechanismValues (reuses one output object)
```
- `animate` is true when the **cue changed**: StageScene tracks the cue key for which targets were last applied. Edits inside the same cue (slider, 常用位置 button, typed value) jump instantly, as the old slider did.
- `minSeconds = cueTransitionSeconds(cue)`. Real machine speed applies everywhere, including the editor. The panel shows the *target* values, so editing never waits for the animation.
- CueStoryboard thumbnails pass `mechanismMotion="instant"`.

**Video timeline (share page today; director page once roadmap section 1 lands): `buildMechanismTimeline`.**
It uses the same windows as objects (`cueWindows(cues)`: a move starts at `max(arrive − 轉場, previous arrive)`). Segments are precomputed per mechanism whenever cues or positions change.
```
segments = []; first timed cue → hold its value for t ≤ its arrive
for each timed cue i ≥ 1 (by video time):  s = start_i, a = arrive_i, target = resolved_i[m]
  p = valueAt(segments, s)            // actual position at s, possibly still moving from a late previous segment
  truncate the previous segment at s  // a new cue takes over from wherever the machine is
  d = |target − p|; if d == 0 → continue
  dur = a − s; if maxSpeed: dur = max(dur, d / maxSpeed)
  push { t0: s, t1: s + dur, v0: p, v1: target }      // dur == 0 → instant step at s
valueAt(t): binary search for the last t0 ≤ t → t ≥ t1 ? v1 : lerp
```
`valuesAt(t)` is a pure function of video time, so pause and scrubbing in either direction always land on the same picture. Late arrival falls out naturally: the move simply ends after `a`.

**Playback decision: real machine speed (arrives late). Chosen because:**
- It shows what will physically happen. A director approving an impossibly fast lift would discover it at the venue. An animator syncing an LED reveal to the lift sees the real timing and can adjust the content, or ask 製作 to fix it.
- It is the honest default for clients too. Every viewer sees the same thing, which is one of the stated goals.
- The alternative "start early so it arrives on time" changes the GO time. That is a programming decision for 製作, so we don't do it silently. It is exactly what 「照機器速度」 offers as an explicit fix: a longer 轉場 means an earlier start with the same arrival.
- The alternative "follow 轉場 anyway" hides the problem in the one tool meant to find it.
- Nothing changes for mechanisms without a max speed, including every migrated legacy one.

Directors, animators and share viewers see the motion only, with no warnings. Warnings are for 製作 (requirement 6).

### 6.5 Speed check (`motion.ts → checkSongMechanisms`)
For each master cue and each mechanism with `maxSpeed`:
- **Previous cue:** for a cue with a video time, the previous timed cue by video time (what playback does). Otherwise, the previous master cue in list order (what clicking does).
- `from` is the previous cue's resolved value, `to` this cue's. `d = |to − from|`. If `d < 1e-6` the result is 「不動」 and there is nothing to check.
- `need = d / maxSpeed`.
- `available` = for a timed cue, `arrive − start` from `cueWindows`; for an untimed cue, `cueTransitionSeconds(cue)`.
- Result:
  - `ok` if `need ≤ available + 0.05 s`.
  - Otherwise `tooFast { need, available, fix }`. `fix = ceil(need × 10) / 10` seconds, **unless** the cue is timed and `arrive − previousArrive < need`. In that case `fix = null` and the reason is `gap`: no 轉場 can help because the start is clamped by the previous cue.
- **Late chain (timed cues):** the timeline simulation also reports `lateBy = actualArrive − arrive` when it exceeds 0.05 s. This catches a previous move that hasn't finished when this cue starts.
- **Order mismatch:** if the video-time order of timed cues differs from list order, one song-level notice (section 7.4).

The fix for a cue is the maximum `fix` over its mechanisms. It is applied through the existing cue PATCH (`crossfadeSeconds`) and then re-checked.

---

## 7. Editor UI (製作 only)

### 7.1 Placement
- A new right-hand tab in `ProjectEditor`: 「機關」, shown as 「機關 (3)」 with the count. When any cue in the selected song has a speed problem, the tab gets a small warning dot with title 「有 {n} 個 cue 的機關來不及到位」. Tabs become 「Cue」「物件狀態」「機關」「提案」「物件」.
- The old left-column `MechanismPanel` (`ProjectEditor.tsx:980-988`) is removed.
- The tab body is `web/src/components/mechanisms/MechanismTab.tsx`. ProjectEditor only adds the tab key, one `case`, and spreads `{...mech.sceneProps}` onto its StageScene. The hook is `useEditorMechanisms(projectId, songId, cues, selectedCueId)`.
- The tab has two parts: 「這個 cue 的機關位置」 at the top, and 「設定機關」 below.

### 7.2 Per-cue panel (top of the tab)
```
這個 cue 的機關位置 · Cue 3「副歌」                         [FileSpreadsheet] 匯出機關總表
───────────────────────────────────────────────────────────────────────────────
[Cog] 中央升降台   上下                               3.50 m   [CornerDownRight] 沿用「主歌」
      [收起] [半開] [全開*]
      0 m |==============================o| 3.5 m      [ 3.5  ] m   [RotateCcw]
[RotateCw] 旋轉舞台   轉台                             90°      這個 cue 設定
      [正面] [側面*] [背面]
      -180° |---------------o------------| 180°      [ 90   ] °   [RotateCcw]
      [TriangleAlert] 轉場 5 秒太快：這段要轉 90°，最高 6°/秒，需要 15 秒   [Gauge] 照機器速度（15 秒）
```
- Each row shows the name, a direction word (「上下」「左右」「前後」「轉台」「前後翻」「左右翻」), and the value (m: up to 3 decimals; °: 1 decimal).
- Source label:
  - 「這個 cue 設定」;
  - 「沿用「{cue name}」」 (dimmed, `CornerDownRight` icon);
  - 「預設位置」.
- 常用位置 chips: one click saves that value for this cue. The active chip is highlighted when the value equals the preset within 1e-6.
- Slider (`input[type=range]`):
  - min/max = travel range; it physically cannot leave the range;
  - while dragging, the 3D view previews live without saving; release saves once (PUT);
  - it snaps to a preset within 1 % of the range (hold Alt to disable);
  - keyboard steps 0.01 m / 0.5°, Shift ×10;
  - `aria-label` 「「{name}」的位置」.
- Numeric field: Enter or blur saves. The value is clamped and the field shows the clamped value. Invalid input is restored with 「位置要是數字，已還原」, the same behavior as `numberField.ts`.
- Back to inherited (`RotateCcw`): title and aria-label 「回到沿用上一個 cue」. Disabled when the cue has no own value. This is a DELETE.
- With no cue selected, the header becomes 「預設位置（沒選 cue）」 and edits change `defaultValue`. This matches 「沒選 cue：改的是物件預設位置」 for objects.
- Undo: each committed change (preset, slider release, typed value, back to inherited) pushes one step into the editor's existing per-cue `EditHistory` scope (`historyScope(selectedCueId)`), so Ctrl+Z works across objects and mechanisms. Speed fixes go through the cue meta PATCH, as typing a 轉場 does today.
- An empty project shows `Cog` (xl) and 「還沒有機關」 with the hint 「升降台、轉台、滑軌這類會動的機械，先在下面「新增機關」設定一次，之後每個 cue 選位置就好」.

### 7.3 Setup (bottom of the tab; the form opens inline, not as a modal, so the 3D view stays usable)
List rows: 「中央升降台　0 ~ 3.5 m · 0.25 m/秒 · 2 個物件 · 12 個 cue 有設定」 with `Pencil` 「編輯」. The parent also shows 「帶動：{child names}」. Rows reorder with up and down buttons (same pattern as songs). Buttons: `Plus` 「新增機關」.

Form fields (`MechanismSetupForm.tsx`):

| Label | Control | Notes |
|---|---|---|
| 名稱 | text, placeholder 「例：中央升降台」 | |
| 動作 | segmented 「直線移動」 / 「旋轉」 | icons `MoveVertical` / `RotateCw` |
| 數字變大時往 (直線) | 「往上」「往下」「往觀眾」「往舞台後方」「往左」「往右」 | Left and right are as seen from the audience. "Toward the audience" uses `stageFrontDirection()` (`web/src/lib/stageCamera.ts`, the LED-facing direction), exposed through a new `sceneQueryRef`. The result is stored as a unit vector. |
| 轉軸 (旋轉) | 「水平轉（像轉台）」「前後翻」「左右翻」 + 「正的角度：從上面看順時針 / 逆時針」 (or 「往觀眾倒 / 往後倒」, 「往左倒 / 往右倒」) | The direction choice flips the axis sign. |
| 轉軸中心 (旋轉) | X / Y / Z in meters (shown via `sceneToMeters`), `Crosshair` 「用物件中心」 | Default: bounding-box center of the group in base pose. The `sceneQueryRef.groupCenter(ids)` query un-applies the parent chain. |
| 帶動的物件 | searchable checklist grouped by category (`CATEGORY_INFO` icons) + `Layers` 「用 3D 畫面選取的物件（{n} 個）」 | Shift-click in 3D builds the selection (existing behavior). Objects already elsewhere show 「已在「{mech}」」, and checking one asks to move it. |
| 跟著另一個機關動（選填） | select 「不用」 / mechanism names | hint 「例：裝在轉台上的升降台，選「旋轉舞台」」 |
| 行程 | 「最低」 「最高」 (m or °) | `Ruler` icon |
| 預設位置 | number | hint 「沒有 cue 設定時停在這裡」 |
| 最高速度 | number (m/秒 or °/秒), placeholder 「選填」 | `Gauge`; hint 「填了才會檢查轉場夠不夠；沒填就照轉場秒數移動」 |
| 常用位置 | rows of name + value, `Bookmark` 「加入 收起 / 半開 / 全開」 (fills min / midpoint / max), 「新增常用位置」 | at most 12 |
| 控台編號（選填） | text | hint 「自動化控台上這個軸的名字，例：Axis 12。匯出機關總表時一起列出」 |

Buttons: 「儲存」, 「取消」, `Trash2` 「刪除機關」.
Delete confirmation: 「刪除「{name}」？會一起清掉 {cueCount} 個 cue 裡設定的機關位置，不能復原。」 (this uses the existing in-page dialog pattern, or `confirm()` until roadmap section 4 replaces those).
If a range change leaves stored values outside the range, the PATCH returns `outOfRangeCount` and the UI shows 「有 {n} 個 cue 存的位置超出新的行程，播放時會停在邊界」.

Optional nice-to-have (Task 13b): when a mechanism row is focused, draw its travel in 3D: a line along the axis from min to max with ticks at presets, or an arc for rotary.

### 7.4 Warnings (`TriangleAlert`, amber text; admin only)
- Too fast, fixable: 「轉場 {avail} 秒太快：這段要走 {d}（最高 {v}/秒），需要 {need} 秒」, button `Gauge` 「照機器速度（{fix} 秒）」, title 「把這個 cue 的轉場改成 {fix} 秒；這個 cue 的其他物件也會用 {fix} 秒移動」.
- Too fast, gap-limited: 「跟上一個 cue 只隔 {gap} 秒，機器需要 {need} 秒：把這個 cue 的影片時間往後挪，或減少行程」 (no button).
- Late chain: 「上一段還沒走完，會晚 {late} 秒到位」.
- Out of range: 「存的是 {stored}，超出行程（{min} ~ {max}），播放時停在 {clamped}」.
- Order mismatch (song level, top of the tab): 「cue 的順序跟影片時間對不上：機關會從影片時間的上一個 cue 出發」.
- Uncalibrated project (setup area): 「還沒做測距校準：機關的行程是用公尺算的，先用工具列的測距把尺寸校準好，畫面上移動的距離才準」.
- Object hint in the 物件狀態 tab (small line in `ObjectAttributePanel`): 「這個物件在「{mech}」上（目前 {value}），畫面上的位置還要加上機關。要改{mech}請到「機關」分頁」.

### 7.5 Icons (lucide-react 1.38.0, all verified to exist)
`Cog` (機關), `MoveVertical` / `MoveHorizontal` / `Move3d` (linear directions), `RotateCw` (rotary), `Ruler` (行程), `Gauge` (速度, speed fix), `Bookmark` (常用位置), `TriangleAlert` (warnings), `CornerDownRight` (沿用), `RotateCcw` (back to inherited, same as the existing per-axis reset), `Crosshair` (pivot), `Layers` (group / selection), `FileSpreadsheet` (export), `Plus`, `Pencil`, `Trash2`, `ArrowUp` / `ArrowDown` (reorder). Icon-only buttons need `title` and `aria-label` in Chinese, as the `Icon.tsx` header requires.

---

## 8. Playback: director page, share page, studio

### 8.1 StageScene props (the old ones stay until cleanup)
```ts
/** 機關定義（每個專案設定一次）；沒給 = 沒有機關（還有給 mechanismOffsets 的舊頁面會自動換算） */
mechanisms?: Mechanism[] | null;
/** 目前這個 cue 的機關位置（已經沿用 / 夾在行程內）；換 cue 時照機器速度走過去，同一個 cue 裡改值直接跳 */
mechanismTargets?: MechanismValues;
/** 跟著影片時間：只在 poseAtFrame 有回傳位置的那幾幀才問；回傳 null = 用 mechanismTargets */
mechanismAtFrame?: () => MechanismValues | null;
/** 'real'（預設）= 照機器速度；'instant' = 直接到位（分鏡縮圖） */
mechanismMotion?: 'real' | 'instant';
/** 查舞台：舞台正面方向、一組物件的中心（設定機關用） */
sceneQueryRef?: React.MutableRefObject<StageSceneQuery | null>;
```
Gating `mechanismAtFrame` on `poseAtFrame` keeps all the "is the video timeline active" logic in one place, the page's `poseAtFrame` (`Share.tsx:307-314`). When the timeline stops (the user clicks an untimed cue, or switches to AE live), the tweener retargets from the last displayed values.

### 8.2 Page wiring (one hook and one prop spread per page)
- **Share** (`Share.tsx:459-471`): `useShareMechanisms(shareRef, songId, accessToken, cues, selectedCueId, cueRefresh)` reads `data.mechanisms` and fetches song positions once per song (cached like `cueStatesCacheRef`). It returns `{ sceneProps, timeline }`. The page adds `mechanismAtFrame={() => timeline?.valuesAt(local.video.currentTime) ?? null}`.
- **Director, Preview** (`Preview.tsx:661-700`): `useStageMechanisms(projectId, songId, cues, selectedCueId, refreshTick)` uses click mode today. When the video-version agent adds video-time playback, it passes the same `mechanismAtFrame` built from the hook's `timeline`.
- **Studio** (`Studio.tsx:565-592`): same hook, click mode. AE live has no video time.
- **CueStoryboard** (`CueStoryboard.tsx:274-275`): per-thumbnail `mechanismTargets` from the resolved table and `mechanismMotion="instant"`.
- **Refresh:** the director and studio pages already refresh every 25 s (`LIVE_REFRESH_MS`, `web/src/lib/liveRefresh.ts`). The hook refetches positions and definitions on the same tick, so an admin's change shows up within about 30 s, as states and comments already do.
- There is no mechanism UI on these pages. The read-only scene has no gizmo. The backend refuses writes (403).

### 8.3 Performance on low-end laptops
- **Per frame:** about 20 mechanisms × a binary search over at most about 100 segments, plus one chain apply per object in a mechanism. No allocations: the rig, the segments, the values object and all temporaries are reused. Measured cost should be under 0.1 ms per frame. Verify with 4× CPU throttling (section 11.3).
- **No React per frame.** Values flow through refs, the way `poseAtFrame` already works. The editor panel shows targets, not live values, so it does not re-render during motion.
- **Rebuild only on data change:** the rig (definitions or `scaleCorrection`), the segments (cues, positions, definitions).
- **GPU cost is unchanged.** Moving objects need no material or shader changes. The LED light rig already follows `matrixWorld` every frame (`web/src/lib/stageLook/ledLightRig.ts:2,95`). `AdaptiveQuality` (`web/src/lib/stageLook/quality.ts`) is untouched and keeps dropping bloom, reflections and lights by measured FPS. The LED environment capture updates at the quality level's `envIntervalMs` (1–2 s on low), so moving LEDs reflect with that lag. That is acceptable and costs nothing extra.
- **Network:** one definitions request per project and one positions request per song, both cached, refreshed on the 25 s tick.

---

## 9. Export: 機關總表 (CSV)

**Format choice: CSV for Excel.** An automation operator re-keys targets into the console (Kinesys, TAIT Navigator, eChameleon). They need to sort and filter per axis and add their own columns (their cue numbers, notes). CSV opens in Excel, Numbers and Google Sheets, and any of those can print it to PDF. A PDF cannot be turned back into a sheet. A printable view could reuse the same rows later (`exportPdf.ts` pattern) if anyone asks.

- Button 「匯出機關總表」 (`FileSpreadsheet`) in the 機關 tab, with hint 「用 Excel 打開；整個專案每首歌、每個 cue、每個機關一行」. The whole show goes into one file, since operators program the whole show. They can filter by song in Excel.
- Data: `GET /mechanism-sheet` (one request) is resolved with `track.ts` and checked with `motion.ts`, so the sheet matches the warnings exactly. Built in the browser by `cueSheet.ts` and downloaded as a Blob.
- File: `機關總表-{project}-{yyyy-mm-dd}.csv`, UTF-8 **with BOM** (otherwise Excel on Windows garbles the Chinese), CRLF line endings, comma separators, RFC 4180 quoting. Text cells beginning with `= + - @` get a leading `'` (formula-injection guard). Numeric cells are never prefixed, so negative values stay numbers.
- Numbers: linear positions in meters with 3 decimals (millimeter precision); degrees with 1 decimal; seconds with 1 decimal; speed m/s with 3 decimals and °/s with 1 decimal. Times use the app's own 影片時間 format `m:ss.s`.
- Rows: every mechanism for every master cue (so the sheet also works as a "where is everything at cue N" check), sorted by song order, cue order, then mechanism order. A legend follows the table.

Columns: 歌曲 Song · Cue # · Cue 名稱 · GO 時間 (start = arrive − available) · 到位時間 (= 影片時間) · 轉場(秒) · 機關 Axis · 控台編號 · 起點 From · 目標 Target · 單位 · 常用位置 (if the target equals a preset) · 行程 Distance · 可用(秒) · 需要(秒) (= distance ÷ max speed) · 速度(單位/秒) (= distance ÷ available) · 最高速度 · 檢查.

**Sample** (song S03 夜曲. Mechanisms: 中央升降台 linear up, 0~3.5 m, 0.25 m/s; 旋轉舞台 revolve, -180~180°, 6°/s; 左側 LED 滑軌 linear left, 0~4 m, 0.5 m/s. Cue 5 has no video time.)
```csv
歌曲 Song,Cue #,Cue 名稱 Cue name,GO 時間 GO,到位時間 Arrive,轉場(秒) Move s,機關 Axis,控台編號 Console,起點 From,目標 Target,單位 Unit,常用位置 Preset,行程 Distance,可用(秒) Avail s,需要(秒) Need s,速度(單位/秒) Speed,最高速度 Max,檢查 Check
S03 夜曲,1,開場,0:00.0,0:00.0,0,中央升降台,Axis 3,,0.000,m,收起,,,,,0.25,起始位置
S03 夜曲,1,開場,0:00.0,0:00.0,0,旋轉舞台,Revolve,,0.0,°,正面,,,,,6,起始位置
S03 夜曲,1,開場,0:00.0,0:00.0,0,左側 LED 滑軌,Axis 7,,0.000,m,收起,,,,,0.5,起始位置
S03 夜曲,2,主歌,0:10.0,0:30.0,20,中央升降台,Axis 3,0.000,3.500,m,全開,3.500,20.0,14.0,0.175,0.25,OK
S03 夜曲,2,主歌,0:10.0,0:30.0,20,旋轉舞台,Revolve,0.0,0.0,°,正面,0.0,,,,6,不動
S03 夜曲,2,主歌,0:10.0,0:30.0,20,左側 LED 滑軌,Axis 7,0.000,0.000,m,收起,0.000,,,,0.5,不動
S03 夜曲,3,副歌,1:00.0,1:05.0,5,中央升降台,Axis 3,3.500,3.500,m,全開,0.000,,,,0.25,不動
S03 夜曲,3,副歌,1:00.0,1:05.0,5,旋轉舞台,Revolve,0.0,90.0,°,側面,90.0,5.0,15.0,18.0,6,太快：轉場要 15 秒
S03 夜曲,3,副歌,1:00.0,1:05.0,5,左側 LED 滑軌,Axis 7,0.000,4.000,m,全開,4.000,5.0,8.0,0.800,0.5,太快：轉場要 8 秒
S03 夜曲,4,間奏,1:05.0,1:12.0,10,中央升降台,Axis 3,3.500,0.000,m,收起,3.500,7.0,14.0,0.500,0.25,太快：跟上一個 cue 只隔 7 秒
S03 夜曲,4,間奏,1:05.0,1:12.0,10,旋轉舞台,Revolve,90.0,90.0,°,側面,0.0,,,,6,會晚 3 秒到位
S03 夜曲,4,間奏,1:05.0,1:12.0,10,左側 LED 滑軌,Axis 7,4.000,4.000,m,全開,0.000,,,,0.5,不動
S03 夜曲,5,尾奏,,,8,中央升降台,Axis 3,0.000,0.000,m,收起,0.000,,,,0.25,不動
S03 夜曲,5,尾奏,,,8,旋轉舞台,Revolve,90.0,0.0,°,正面,90.0,8.0,15.0,11.3,6,太快：轉場要 15 秒
S03 夜曲,5,尾奏,,,8,左側 LED 滑軌,Axis 7,4.000,0.000,m,收起,4.000,8.0,8.0,0.500,0.5,OK

# 機關說明 Axes
# 中央升降台（Axis 3）：直線，0 = cue 裡原本的位置，正的數字往上；行程 0 m ~ 3.5 m；最高 0.25 m/秒；常用位置 收起 0 / 半開 1.75 / 全開 3.5
# 旋轉舞台（Revolve）：旋轉（水平轉（像轉台）），0 = 模型原本的方向，正的角度從上面看順時針；行程 -180° ~ 180°；最高 6°/秒；常用位置 正面 0 / 側面 90 / 背面 180
# 左側 LED 滑軌（Axis 7）：直線，0 = cue 裡原本的位置，正的數字往左（觀眾看過去）；行程 0 m ~ 4 m；最高 0.5 m/秒；常用位置 收起 0 / 全開 4
# 註：需要秒數 = 行程 ÷ 最高速度，以等速計算、沒有算加減速，實際會再久一點。GO 時間 = 到位時間 − 可用秒數；沒有影片時間的 cue 由現場叫 GO。
```
Cue 4 shows the gap case. 轉場 is 10 s, but the move cannot start before cue 3 arrives at 1:05, so only 7 s are available. The fix is to move the cue's video time, not to change 轉場. Cue 4's revolve row shows the late chain: cue 3's revolve starts at 1:00 and needs 15 s, so at 1:05 it is only at 30° and reaches 90° at 1:15, 3 s after cue 4's 1:12. (The first draft of this sample said 「不動」 there, which contradicted the late-chain rule in 6.5.) These exact rows are the golden fixture for the `cueSheet.ts` test. The slide's 常用位置 are 收起 0 / 全開 4.

---

## 10. Collision highlighting later: what is reserved

Nothing in the model blocks it:
- **World pose of every object at any time** is already computable, purely: the base timeline (`poseAtTime`) composed with `applyChain(rig, mechanismTimeline.valuesAt(t))`, or the tweener in click mode.
- **The mechanism tree** says which objects move together, so pairs moving together on the same mechanism branch never need testing.
- **`mechanisms.metadata`** (JSON, currently null) is reserved for `{ clearanceM, envelope: 'bbox' | 'mesh', ignoreWith: [mechId] }`. `stage_objects.metadata` can carry per-object envelopes. No new tables are needed.
- **Detection:** sample each song at about 10 Hz with mesh bounding boxes (OBB) and test pairs on different branches. Results are per (song, t, objectA, objectB). Highlighting uses the existing per-mesh emissive and selection path, and warnings appear next to the speed warnings in the 機關 tab and as a 「碰撞」 column in the sheet.

---

## 11. Test plan

### 11.1 Unit tests (vitest, `web/src/lib/mechanisms/*.test.ts`)
- `model.test.ts`:
  - every validation rule and message in section 4.3;
  - axis normalization and the direction presets (front vector relative to a fake `stageFrontDirection`);
  - preset sorting, clamping and midpoint fill;
  - `legacyOffsetsToMechanisms`: only x / only y / both (parent link) / zero dropped / non-LED dropped / range widened for |x| > 10.
- `track.test.ts`, mirroring `cf-worker/cueStates.test.mjs` cases:
  - own beats inherited;
  - nearest earlier cue wins regardless of input order;
  - default with no earlier value;
  - another mechanism's value never leaks;
  - proposals don't affect masters;
  - a proposal resolves against the preceding master;
  - clamping on output, with `clamped` and `stored` reported;
  - a range narrowed after values were stored.
- `motion.test.ts`:
  - `requiredSeconds`;
  - `checkSongMechanisms`: ok / fixable (fix rounded up to 0.1 s) / gap-limited (`fix = null`) / no max speed / not moving / untimed cue uses list predecessor and 轉場;
  - order mismatch flag;
  - timeline: on time; late arrival; late move overtaken by the next window (truncate and restart from the mid position); 直接切換 with and without speed; before the first cue; after the last; `valuesAt` called in random time order returns identical values (scrubbing);
  - tweener: duration = max(轉場, d/v); retarget mid-move continues from the current value; same-cue edits jump; `instant` mode.
- `pose.test.ts`:
  - **parity**: the legacy fixture equals `scenePosition` / `cuePositionFromScene` for every case in `mechanismOffset.test.ts` (scale 1, 1.6, 2);
  - round trip `basePoseFromScene(applyChain(x)) ≈ x` for linear, rotary with an off-origin pivot at 90° and 270°, multi-turn 720°, and a nested lift-in-revolve chain;
  - quaternion composition;
  - objects without a chain are unchanged;
  - "drop where you released" scenarios copied from 23af5a1, extended to rotation.
- `cueSheet.test.ts`:
  - the section 9 sample as a golden file;
  - BOM and CRLF;
  - quoting of commas, quotes and newlines in names;
  - formula guard on text but not on negative numbers;
  - number formatting.
- `mechanismApi.test.ts`: response parsing and defaults (like `videoApi.test.ts`).
- `noEmojiInUi.test.ts` already covers the new components.

### 11.2 Worker tests (`node --test`, added to the `cf-worker/package.json` test script)
- `access.test.mjs`: every new route: kind, need, `mechId` / `songId` / `cueId` extraction, method not allowed, unknown sub-path returns null.
- `mechanisms.test.mjs`:
  - pure helpers in `mechanisms.mjs` (row ↔ API mapping, conflict detection, cycle and depth check);
  - **migration test with `node:sqlite`** (built into Node 24):
    1. apply `0001`…`0022` (if present) to an in-memory DB with `PRAGMA foreign_keys = ON`;
    2. insert projects, LEDs and a non-LED with offsets;
    3. apply `0023`;
    4. assert the rows equal `legacyOffsetsToMechanisms` (imported from the `.ts`) and that re-running is idempotent;
    5. delete an object and confirm the membership is gone; delete a cue and confirm its positions are gone.
  - `syncLegacyMechanismOffsets` against the same in-memory DB: mirrors while `edited_at IS NULL`, and stops after an edit.

### 11.3 End-to-end scenario (local dev against the production backend, driven in the Claude browser pane; ends with the required UX audit pass)
1. **Nothing changes.** Open a project that has old slider offsets. Before and after the switch, at the same 重置攝影機 view, the editor, director page, studio and share link look identical (screenshot diff). The 機關 tab lists 「{LED} 左右/上下」 with defaults equal to the old offsets.
2. Create 「中央升降台」: two objects (lift + the LED on it), 直線 / 往上, 0 ~ 3.5 m, 0.25 m/秒, 加入 收起/半開/全開.
3. Cue 2, click 「全開」: the lift rises at once (edit = jump). Cue 3 shows 「沿用「主歌」」. Ctrl+Z in cue 2 returns it to 沿用.
4. Set cue 2 轉場 = 5 s: the warning shows 「需要 14 秒」. Click 「照機器速度（14 秒）」: 轉場 becomes 14 and the warning disappears. Click cue 1 → cue 2: the lift takes 14 s.
5. In cue 3, drag the LED that rides on the lift and release. It stays where it was dropped, and after a reload too (no double-apply).
6. Create 「旋轉舞台」 with the lift as child (跟著另一個機關動). At 90°, the lift orbits around the pivot (an arc, not a chord). Drag an object standing on the revolve: no jump.
7. Share link with a local video: scrub forwards and backwards through cue 3. Positions are deterministic, and with a short 轉場 the revolve visibly arrives late. No warnings are visible to the viewer.
8. Director page and studio: cue clicks show machine speed. There is no 機關 tab or panel. `PUT …/mechanisms/:id` as a director returns 403 「只有 admin 可以修改專案內容」.
9. 匯出機關總表 → open in Excel on Windows: Chinese is intact, numbers are numeric, filters work, and the rows match the panel's warnings.
10. Delete 「中央升降台」: the confirmation shows the cue count. Afterwards the stage returns to base poses and the export no longer lists it.
11. Performance: DevTools 4× CPU throttle, 20 mechanisms × 40 cues, share timeline playing. FPS stays within 5 % of the same project without mechanisms, and adaptive quality does not drop a level because of mechanisms.
12. Old site during preview: change an old LED slider on the live site, and the preview's derived mechanism default follows (mirroring). After editing that mechanism in the preview, old-site slider changes no longer affect it.

---

## 12. Implementation plan (in order; each task has its own test and leaves the app working)

Files marked (shared) are being edited by other agents. Touch them late, rebase first, and keep the diff to the lines listed.

| # | Task | Files | Test / done when |
|---|---|---|---|
| 1 | Types, limits, validation, direction presets, legacy conversion | `web/src/lib/mechanisms/model.ts` | `model.test.ts` |
| 2 | Inheritance resolver | `lib/mechanisms/track.ts` | `track.test.ts` |
| 3 | Speed check, video-timeline segments, tweener | `lib/mechanisms/motion.ts` | `motion.test.ts` |
| 4 | Pose composition and inverse (three) | `lib/mechanisms/pose.ts` | `pose.test.ts` incl. legacy parity |
| 5 | Migration 0023 | `cf-worker/migrations/0023_mechanisms.sql`, `cf-worker/mechanisms.test.mjs`, `cf-worker/package.json` | node:sqlite migration and parity tests |
| 6 | Routes and permissions | `cf-worker/access.mjs`, `access.test.mjs` | route tests |
| 7 | Handlers: CRUD, reorder, positions, sheet, share positions, share bundle | `cf-worker/mechanisms.mjs`; `worker.js` (dispatch cases, id check, `loadProjectContext`, share sub-path and bundle) | helper tests; manual curl against `wrangler dev` |
| 8 | Copy and clear sites (section 5.3), legacy mirroring in `updateProject` | `worker.js`, `mechanisms.mjs` | sync test; duplicate / clone / template / import / reset checked on `wrangler dev` |
| 9 | API docs | `docs/mechanisms-api.md` | review |
| 10 | Frontend API client | `lib/mechanisms/mechanismApi.ts` | `mechanismApi.test.ts` |
| 11 | StageScene: base-pose layer, commit pass, tweener, timeline hook-in, drag inverse, `sceneQueryRef`, legacy `mechanismOffsets` fallback | `web/src/components/StageScene.tsx` | `vitest` + `tsc`; with **no page changes**, every page still looks identical (E2E step 1) |
| 12 | Hooks | `lib/mechanisms/useMechanisms.ts` | type-check; used in 13–16 |
| 13 | Editor 機關 tab: per-cue panel and undo | `components/mechanisms/MechanismTab.tsx`, `MechanismCueRow.tsx`, `mechanisms.css`; **(shared)** `ProjectEditor.tsx`: tab key, one `case`, scene-props spread, remove the left `MechanismPanel` | E2E 2–5 |
| 13b | (optional) Travel line in 3D for the focused mechanism | `StageScene.tsx`, `pose.ts` | visual check |
| 14 | Setup form (objects, groups, parent, pivot, presets, console label) | `components/mechanisms/MechanismSetupForm.tsx` | E2E 2, 6 |
| 15 | Warnings and 「照機器速度」; reset-cue confirmation text; object hint | `MechanismTab.tsx`; **(shared)** `ProjectEditor.tsx` (two strings, one hint line) | E2E 4 |
| 16 | Read-only pages: share (incl. timeline), director, studio, storyboard | **(shared)** `Share.tsx`, `Preview.tsx`, `Studio.tsx`; `CueStoryboard.tsx` | E2E 7–8 |
| 17 | Export 機關總表 | `lib/mechanisms/cueSheet.ts`, button in `MechanismTab.tsx` | `cueSheet.test.ts` golden; E2E 9 |
| 18 | Help text: 機關 tab, calibration wording 「機關滑桿」→「機關」 | `HelpModal.tsx` / `Help.tsx`, `StageScene.tsx:2410,2453`, `numberField.ts:4` | `noEmojiInUi.test.ts` |
| 19 | UX audit pass (required by the project memory), then the owner reviews the Vercel preview | — | the full E2E list |
| 20 | (after owner answer, section 14) 「把現有 cue 的位置轉成機關位置」 | `MechanismTab.tsx`, `mechanisms.mjs` (one bulk endpoint) | unit test of the conversion; manual on a copy of the project |
| 21 | Cleanup after master: delete `MechanismPanel.tsx`, `mechanismOffset.ts` (+ test), `scenePosition`, the mechanism parts of `projectViewSettings.ts`, `MechanismOffsets` in **(shared)** `api.ts`, the StageScene `mechanismOffsets` prop; the worker refuses `mechanism_offsets` writes with 「機關改版了，請重新整理頁面」 and stops mirroring | listed files | full test suites green |

Conversion algorithm for Task 20, so it is unambiguous. For a mechanism M with axis `a` (linear) and objects O, take the first object in O as the reference. For each cue with its own position for the reference object, the axis component is `c = dot(pos − defaultPos, a)` (for rotary: the yaw/pitch/roll difference about `a`, reference object only). Convert only when every object in O that has an own row in that cue shares the same component within 1 mm / 0.1°. Then set the cue's M value to `c` (converted to meters) and remove that component from those rows. Cues that don't satisfy this are listed and left untouched: 「{n} 個 cue 的物件動法不一致，沒有轉：…」.

---

## 13. Rollout and coordination

1. **Backend first** (Tasks 5–8). The change is additive: the live site keeps reading and writing `mechanism_offsets`, which is mirrored into the new tables. Deploying the worker and applying 0023 to production D1 changes nothing the live site shows. The roadmap rule still needs the owner's OK before production, so ask once, together with the preview link, in plain words: 「後台先更新，正式網站看起來不會變」.
   - If 0022 (invite links) has not landed yet, applying 0023 first is fine: wrangler applies any unapplied files and the two are independent.
2. **Frontend on a feature branch**, then the Vercel preview, then the owner's OK, then master (memory note `feedback_deploy_preview_first`). The preview uses the production backend. The old site keeps working throughout.
3. **Cleanup** (Task 21) after the new frontend is on master. The column stays, as nothing is deleted.
4. **Rollback:** until cleanup, reverting the frontend restores the old slider with current values, because of the mirroring.
5. **Concurrent agents:** the video-version UI agent owns `Preview.tsx`, `Share.tsx`, `Studio.tsx`, `ProjectEditor.tsx` and `api.ts`. This plan adds no code to `api.ts` until cleanup, keeps page edits to prop swaps and tab wiring, and gives the director page a ready `mechanismAtFrame` for when that agent adds video-time playback.
6. **Engineering note, not for the owner:** `loadCueStates` lets proposals take part in object inheritance (no status filter). Mechanisms use master cues only (section 6.2). Aligning objects is a one-line SQL filter, but it changes existing object behavior for projects with proposals, so it should be its own reviewed fix.

---

## 14. Open questions for the owner

Only one question changes what gets built. The rest is decided above.

1. **Lifts and turntables that were already animated cue by cue.** Some projects (for example ones seeded with 「旋轉舞臺」/「中央升降台」) may already move those objects through ordinary cue positions. If an admin then defines a mechanism for them, the two movements would add up. Should the 機關 tab offer a one-click 「把現有 cue 的位置轉成機關位置」 (Task 20)?
   - **Recommended default: yes, build it.** It only runs when the admin clicks it, shows what it changed and what it skipped, and can be tried on a copy of the project (複製專案) first. Without it, the speed check and the export say nothing useful for those projects until someone re-enters every cue by hand.

Plain-words version for the owner: 「你現在的專案裡，升降台 / 轉台是一個 cue 一個 cue 手動擺高度、角度的嗎？如果是，我做一個按鈕，一鍵把它們變成機關的位置，之後就能檢查速度、匯出總表。我建議做。」

---

## 15. Implementation notes and deviations (2026-10-14)

Everything in sections 1–12 is built except Task 21 (cleanup after master), which waits for the production release. These are the places where the build differs from the text above, and why.

**Validation (4.3)**
- Names longer than 40 characters, preset names longer than 20 and console labels longer than 40 are shortened instead of rejected (the inputs have `maxLength`, so this only affects API callers). Travel limits outside ±1000 m / ±36000° are clamped to the limit.
- Extra messages: 「行程要填數字」 (travel not a number), 「一個機關最多帶 200 個物件」, 「找不到要裝上去的機關」 (parent id not in the project).
- Preset rows with an empty name or a non-numeric value are dropped silently (an unfinished row in the form should not block saving).
- The parent depth check counts the ancestors plus the height of the mechanism's own subtree, so re-parenting a mechanism that already has children cannot exceed 4 levels.

**Motion (6.4, 6.5)**
- **The editor no longer plays at machine speed by default** (owner feedback: waiting 14 s for a lift while editing feels broken). `mechanismMotion` has a third mode, `'transition'`: on a cue change every mechanism moves over exactly the new cue's 轉場 seconds, like the objects, so everything arrives together; 轉場 0 = 直接切換. ProjectEditor uses `'transition'` unless the admin ticks 「照機器速度播放」 in the 機關 tab (off by default, remembered per viewer in localStorage `sp_mech_real_speed`, read and written inside try/catch); then it uses `'real'` (machine speed, arrives late). The speed warnings and the 機關總表 are unchanged: they always check machine speed. The director page, share page and studio keep `'real'`; storyboard thumbnails keep `'instant'`. `motion.ts` exposes `moveSeconds(distance, maxSpeed, transition, motion)` for the three modes. This replaces the 6.4 line "Real machine speed applies everywhere, including the editor."
- `MechanismTweener.retarget` leaves a mechanism alone when its target did not change. Without this, editing one mechanism inside a cue (an instant jump) would also snap every other mechanism that was still moving after a cue change.
- The sheet's 檢查 column also shows 「會晚 N 秒到位」 (late chain on an OK or 不動 row) and 「沒填最高速度」 (moving, no speed set). The panel shows the late chain with 「上一段還沒走完，會晚 {late} 秒到位」 as specified.
- The too-fast warning says 「這段要轉 90°」 for rotary and 「這段要走 3.5 m」 for linear (7.2 mock-up and 7.4 text combined).

**Export (9)**
- The legend is generated from the data: 「0 = cue 裡原本的位置」 for linear, 「0 = 模型原本的方向」 for rotary, the direction and positive-angle words from the form's options, then travel, speed (or 「沒填最高速度（不檢查）」) and presets. The sample's hand-written zero descriptions (「0 = 舞台面」) cannot be derived.
- `GET /mechanism-sheet` also returns `mechanisms`, so the export is one request.
- The 歌曲 column is `{code} {name}`.

**API and backend (5)**
- Task 20 is `POST /mechanisms/:mechId/convert-cue-positions` with `{ dryRun?: true }`. It only runs for a mechanism that has no per-cue values yet (409 「這個機關已經有 cue 設了位置，只有還沒在 cue 裡設過位置的機關可以轉」), because existing values would make the inheritance chains ambiguous.
- The conversion algorithm is generalized so that **every cue looks exactly the same afterwards** (verified by a randomized unit test and an E2E pass on a duplicated project): it walks each song in object-inheritance order, measures the reference object's component in every cue (own or inherited), converts consistent cues, and for cues it cannot convert it writes the mechanism value explicitly (default) and, where an object inherits an already-converted row, materializes that row in the cue. Skipped cues are reported with a reason: `inconsistent` (「{n} 個 cue 的物件動法不一致，沒有轉：…」) or `range` (「{n} 個 cue 轉出來會超出行程，沒有轉：…」). Mechanism values are only written where they differ from what inheritance would give. The count of converted cues only includes cues where the reference object has its own row.
- Legacy mirroring only touches LEDs whose offsets changed in that PATCH (old vs new value). A legacy mechanism deleted in the new UI therefore stays deleted unless someone moves that slider again on the old site. When an axis goes back to 0 the unedited legacy mechanism for that axis is removed (same result as running 0023 on the new data).
- Moving objects out of another mechanism (`moveObjects: true`) marks that mechanism as edited, so the old slider cannot put the LED back.
- Duplicate project also copies `mechanism_offsets` (remapped to the new object ids) and keeps legacy mechanisms as `mlx_`/`mly_` + the new object id with their `edited_at`, so the copy behaves the same on both sites. Import keeps legacy ids the same way.
- Cue templates store the source cue's own mechanism values (`mechanismPositions`).
- The 403 text is now 「只有製作可以修改專案內容」 (changed by the accounts work).

**Frontend (7, 8)**
- The 機關 tab header has a 「換 cue」 select, so the admin can move through cues without leaving the tab. Clicking an object in 3D and Shift+J/K no longer switch away from the 機關 tab (they still switch from the other tabs to 物件狀態), so the setup form stays open while building a selection.
- Pages keep passing `mechanismOffsets` next to `{...mech.sceneProps}`. While the mechanisms are loading (`mechanisms === null`) StageScene uses the legacy conversion, so the LEDs do not jump on first load; once loaded, `mechanisms` wins.
- The object hint in 物件狀態 is provided through a React context (`MechanismHintProvider`), so `ObjectStateEditor` / `ObjectAttributePanel` gained one line instead of new props.
- The travel line (13b) is drawn at the first object of the mechanism (the lift / revolve itself), not the centre of all objects, which can be far apart.
- 「從目前 3D 狀態建立 cue」 sends `snapshotMechanisms` with the selected cue's resolved values through a small `withMechanismSnapshot` helper, because `api.ts`'s `createCue` type is not touched until cleanup.
- The setup form scrolls itself into view when it opens.

