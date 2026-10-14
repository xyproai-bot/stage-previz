# Mechanism v2 (機關 v2) — design

Date: 2026-10-15. Builds on v1 (`2026-10-14-mechanism-system-design.md`, implemented). Stage 1 is implemented on `feat/live-stage-look` (migration **0027**). **Stage 2 is implemented (migration 0030, see the note below).** **Stage 3 is implemented (migration 0031, see the note below).** Stage 4 is designed here and built later; it gets its own additive migration (next free number at that time; written below as 0030, which will move: 0028 went to comment attachments, 0029 to storage costs, 0030 to 對開 / 翻轉, 0031 to 一排機關).

UI strings are quoted exactly as they ship. No emoji; icons via `Icon` + lucide. In-page dialogs only.

## 0. Decisions at a glance

| # | Decision | Why |
|---|---|---|
| 1 | Timing lives on the existing per-cue row: `cue_mechanism_positions.delay_sec`, `.duration_sec` (NULL = follow the cue). | A move belongs to "this cue sets this axis". Every later stage (對開 one value, arrays one row per member, hoists one row per hoist) still writes exactly one row per cue × value-axis, so the model never changes again. |
| 2 | Timing is **not inherited**. A cue without its own value has no move and no timing. | Timing describes one move, not a state. Inheriting "start 2 s late" into an unrelated later cue would be wrong. |
| 3 | Move window: start = cue GO + delay; planned length = own duration, else the cue's span (arrive − GO for timed cues, 轉場 for click mode). Constant speed. Real speed = max(planned, distance ÷ max speed). | Same constant-speed model as v1. No accel/decel (owner). |
| 4 | Only cues that **set** a mechanism launch it. An inherited cue never interrupts a running or pending move. A setting cue takes over at its start: running move is cut where it is, a not-yet-started move is cancelled. | Needed for "start 2 s after the cue, take 8 s" when the next cue's GO falls inside those 8 s. Physically right: a cue that doesn't include an axis doesn't touch it. |
| 5 | With no timing set anywhere, every warning, CSV row and late value equals v1. The only visual difference: a machine already running late keeps max speed instead of slowing to fit the next cue's window. | Backward compatibility; v1 golden CSV unchanged apart from the new columns. |
| 6 | Speed fixes: a mechanism following the cue keeps v1's 「照機器速度」 (changes the cue's 轉場) and also gets 「只改這個機關（走 N 秒）」. A mechanism with its own duration only gets the duration fix. | The targeted fix doesn't move other objects. |
| 7 | 機關時間軸 is docked under the 3D view while the 機關 tab is open (the right column is 340 px, too narrow). Editing there writes the same rows. | Editing-timeline layout the owner knows from AE / Premiere. |
| 8 | Stages 2–4 add a `variant` column and side/rig columns; `kind` stays `linear`/`rotary` (its CHECK can't be widened without rebuilding a table that other tables cascade from). | No destructive migration, ever. |

## 1. Data model and migrations

**0027 (stage 1, applied):**
```sql
ALTER TABLE cue_mechanism_positions ADD COLUMN delay_sec REAL CHECK (delay_sec IS NULL OR (delay_sec >= 0 AND delay_sec <= 3600));
ALTER TABLE cue_mechanism_positions ADD COLUMN duration_sec REAL CHECK (duration_sec IS NULL OR (duration_sec >= 0 AND duration_sec <= 3600));
```
Stored to 0.001 s. Deleting the row (回到沿用) clears its timing.

**0030 (stage 2, 對開 / 翻轉; implemented. This section was drafted as 0028, but 0028 was taken by comment attachments and 0029 is reserved, so the file is `0030_mechanism_split_flip.sql`).** The columns also carry CHECKs (`variant IN ('split','hoist_rig','hoist')`, `side IN ('a','b')`):
```sql
ALTER TABLE mechanisms ADD COLUMN variant TEXT;        -- NULL 一般 | 'split' 對開 | 'hoist_rig' 吊掛 | 'hoist' 吊點 (stage 4)
ALTER TABLE mechanisms ADD COLUMN mirror TEXT;         -- split only: {"axis":{x,y,z},"pivot":{x,y,z}|null,"consoleLabel":"Axis 8"|null}
ALTER TABLE mechanism_objects ADD COLUMN side TEXT;    -- split: NULL/'a' = A 邊, 'b' = B 邊
```
Flip setup stores no schema: it computes `axis`/`pivot` and keeps the choice in `metadata.setup = { hinge: 'top'|'bottom'|'left'|'right'|'front'|'back', positive: 'first'|'second' }` (`first` = the first option of 正的角度 for that hinge, see `FLIP_HINGES`) so editing shows it again.

**0031 (stage 3, 一排機關; implemented as `0031_mechanism_groups.sql`, the design draft said 0029 which went to storage costs).** Differences from the draft: a group's `settings` JSON holds `{ namePrefix, numbering }` (what was chosen when creating it), the members are ordinary mechanisms (`variant` NULL), and the group row is deleted automatically when its last member is deleted (also by an old frontend). Two indexes were added (`idx_mechanism_groups_project`, `idx_mechanisms_group`).
```sql
CREATE TABLE mechanism_groups (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, "order" INTEGER NOT NULL DEFAULT 0, settings TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
ALTER TABLE mechanisms ADD COLUMN group_id TEXT REFERENCES mechanism_groups(id) ON DELETE SET NULL;
ALTER TABLE mechanisms ADD COLUMN group_index INTEGER;
```

**Stage 4, 多點吊掛 (next free number at that time):**
```sql
ALTER TABLE mechanisms ADD COLUMN rig_id TEXT REFERENCES mechanisms(id) ON DELETE CASCADE;  -- hoist → its rig
ALTER TABLE mechanisms ADD COLUMN rig_index INTEGER;                                        -- 吊點 1..4
ALTER TABLE mechanisms ADD COLUMN attach TEXT;                                              -- {x,y,z} scene units, rig base pose
```
A rig row (`variant='hoist_rig'`, `kind='linear'`, dummy travel 0~1) owns the objects; it has no value of its own. Each hoist row (`variant='hoist'`, `kind='linear'`, axis up, no objects, no parent) has its own travel, max speed, console label, per-cue value and timing. "Value axes" = every mechanism except `hoist_rig`; only value axes have tracks, checks and CSV rows.

## 2. API and permissions

Permissions are unchanged: reading is for members (share links: master cues only); writing is 製作 (`editor`); directors and animators get 403 「只有製作可以修改專案內容」.

Stage 1 (live):
- `PUT /api/projects/:p/songs/:s/cues/:c/mechanisms/:m` body `{ value?, delaySec?, durationSec? }`. A key that is absent stays unchanged, `null` means follow the cue, and a number sets it. Sending timing without `value` needs an existing own row, otherwise 400 「這個 cue 還沒有設定這個機關的位置，要一起送位置」. Errors: 「延遲要是 0 到 3600 秒，或留空跟著 cue」 and 「走幾秒要是 0 到 3600 秒，或留空跟著轉場」 (`field`). Response `{ ok, value, clamped, delaySec, durationSec }`.
- The positions lists (song, share, sheet) gain `delaySec` and `durationSec`.
- Copy sites carry timing: clone cue, project duplicate/export/import, templates (`mechanismPositions[].delaySec/durationSec`, only when set), and import from another song. Snapshot and convert write no timing.

Stage 2 adds `variant`, `mirror` and `objectSides` to `MechanismInput`. Stage 3 (implemented, details in `docs/mechanisms-api.md` 「一排機關」) adds `POST /mechanisms/batch` (`{ base, objectIds, namePrefix, groupName, numbering, overrides }`; `overrides` gives each object its own axis / pivot so a row of flaps each hinge on its own edge), `PATCH/DELETE /mechanism-groups/:g` (shared settings apply to every member; `?dissolve=1` is the 「只解散這一排」 option), and the bulk per-cue write `PUT /songs/:s/cues/:c/mechanism-positions` `{ items: [{ mechanismId, value, delaySec?, durationSec? }] }` (≤ 200 items, one transaction; `value: null` removes the row, which is what makes the undo a single call). `GET /mechanisms?mech=2` also returns `groups`. No `?mech=2` gating is needed for correctness (members are ordinary mechanisms, an old frontend ignores the extra fields), but `groups` is only sent with `?mech=2` so the old response stays byte-identical. Stage 4 lets `POST /mechanisms` take `{ variant:'hoist_rig', objectIds, hoists:[{ name, attach, travelMin, travelMax, maxSpeed, consoleLabel, defaultValue }] }` with 2–4 hoists, created in one batch.

From stage 2 on, old frontends must not show the new variants with the wrong motion. The new frontend sends `?mech=2` on mechanism reads and on the share bundle. Without it, the worker omits `split`, `hoist_rig` and `hoist` rows (every row whose `variant` is not NULL) and their positions, so those pieces show static instead of moving the wrong way. Implemented for `GET …/mechanisms`, `…/mechanism-sheet`, `…/songs/:s/mechanism-positions` and the share `…/data` and `…/mechanism-positions`; write responses (create / update) always return the full row. Flip is an ordinary rotary mechanism, so an old frontend still sees it and moves it correctly.

## 3. Shared pure logic (`web/src/lib/mechanisms/`)

**Timing (stage 1, `motion.ts`, `track.ts`):** `ownTimingsByCue(positions)` and `ownMoveFor(resolved, timings)`. `buildMechanismTimeline(mechs, cues, valuesFor, ownFor)` follows decision 4:
- **Setting cue:** `takeOver(start)` drops pending segments (marks them `cut.started=false`) and truncates a running one (`cut.started=true`, `reached`). It then pushes `[start, start+max(D, need)]` from the actual position.
- **Inherited cue:** if the last segment already ends at this cue's value, nothing happens. Late is reported on this cue only when that move was planned to finish by this cue's arrival. Otherwise (order mismatch) it takes over at GO, as in v1.
- **Without `ownFor`:** the exact v1 algorithm, kept for old callers.

`checkSongMechanisms(..., timings)` adds `delay`, `startAt`, `endAt`, `span`, `explicitDelay`, `explicitDuration`, `durationFix` and `cut` (reported only when the planned end lies after the take-over). `MechanismTweener.retarget(..., { timings })` waits `delay`, then moves over `duration ?? 轉場` (`'transition'`) or the max of that and need (`'real'`). `'instant'` ignores timing. No per-frame allocation (values object reused, segments are flat arrays).

**Patterns (stage 3, `patterns.ts`):** `applyPattern(members in group order, p) → { items:[{mechanismId,value,delaySec}], clamped }`.
- 一起: same value V, same delay.
- 依序: value V; delay = start + rank × 間隔. Rank is the order 1→N, N→1, 從中間往兩邊, or 從兩邊往中間.
- 波浪: v_i = 中間值 + 振幅 × sin(2π·i/週期 + 相位); delay_i = i × 間隔.
- 漸層: v_i = A + (B − A)·i/(N−1).

Each value is clamped into its own travel. Durations are untouched. The rows are ordinary rows, so each one stays individually editable.

**Mirrored sides (stage 2, `pose.ts`, `model.ts`):** `compileRig` makes two nodes with the same `id` (one value). Node B uses `mirror.axis` and `mirror.pivot`. Only the A node is in `rig.mechanisms` / `byId` (so the tweener runs each value once); node B lives in `rig.mirrors`, and the chain of every side-B object starts with it, so `applyChain` and `basePoseFromScene` need no new case (B is an ordinary linear or rotary node with an exact inverse). The form computes the mirror with `mirrorForSplit`: linear B axis = −axis; rotary B axis = −reflect(axis, n) and B pivot = centreB + reflect(pivotA − centreA, n), with n = normalize(centreB − centreA) (the two side bounding-box centres). For a left/right symmetric layout this is the same as the n = normalize(pivotB − pivotA) written earlier. A split mechanism cannot be a parent (checked in `normalizeMechanismInput`), and cannot use 轉換 cue 位置.

**Flip hinge (stage 2, `flip.ts`):** `hingeFromBox(box, hinge, front, positiveFirst)` returns axis + pivot. The world-space box is projected onto the stage's right / up / front axes, so a stage that is not aligned with X or Z still works (the box grows a little). The sign of each axis was checked with the right-hand rule in `flip.test.ts`: `first` = 上緣翻：下緣往觀眾翻出來; 下緣翻：上緣往觀眾倒; 左緣翻：右緣往觀眾轉出來; 右緣翻：左緣往觀眾轉出來; 前緣翻：後面抬高; 後緣翻：前面抬高. `second` is the opposite.
- 上緣 / 下緣: axis = audience-right, pivot at the top / bottom edge, at the centre of the depth.
- 左緣 / 右緣: axis = up, pivot at the left / right edge.
- 前緣 / 後緣 (tilting decks): axis = audience-right, pivot at the bottom of the front / back edge.

**Hoist pose (stage 4, `hoist.ts`, pure):** targets p_i = a_i + h_i·up (scene units).
- 2 points: rotate about the horizontal axis ⟂ (a₂−a₁) by asin(Δh/|d_h|), clamped, with a warning when |Δh| ≥ |d_h|.
- 3 points: the minimal rotation from the attach-plane normal to the plane normal through p_i.
- 4 points: least-squares plane z = αx+βy+γ over the horizontal coordinates. The (AᵀA)⁻¹Aᵀ matrix is precomputed per rig, so each frame is one 3×4 mat-vec. Warn when the max residual is > max(1 cm, 0.2 % of span): 「四個吊點的高度不在同一個平面上（差 {n} cm）：硬的東西會被扭到」.

Translation puts the attach centroid at mean(p). There is never yaw.

## 4. Composition with v1 and no double apply

The v1 rule still holds: stored = base pose; drawn = `applyChain(base, values)`, applied once per frame in StageScene's commit pass; drag-save = `basePoseFromScene(scene, values shown on the drop frame)`. Timing only changes **which values** a frame uses, never poses, so it cannot double-apply. The new node kinds (split side B, hoist rig) are extra cases inside `applyChain` / `basePoseFromScene`, each with an exact inverse. Every kind gets a round-trip test. Stage 1 touched StageScene only by passing `timings` to the tweener and adding `mechanismFrameAlways`, which asks `mechanismAtFrame` every frame for the editor's timeline preview.

## 5. UI (製作 only; directors and clients only see the motion)

**Stage 1 (built):**
- **Per-cue row.** Only when the cue sets the mechanism and isn't the first cue: 「延遲 [ ] 秒」「走 [ ] 秒」. The placeholder shows the cue's value. `TimerReset` 「延遲和走幾秒改回跟著 cue」. Summary: 「0:12.0 開始動，0:20.0 到位」 (timed), or 「GO 後 2 秒開始動，走 8 秒」, plus 「（走幾秒跟著轉場）」. A bad entry gives 「秒數要是 0 到 3600，已還原」.
- **Warnings:**
  - 「走 8 秒太快：這段要走 3 m（最高 0.25 m/秒），需要 12 秒」 with 「照機器速度（走 12 秒）」.
  - v1 too-fast plus 「只改這個機關（走 N 秒）」.
  - 「還沒走完，Cue 4「間奏」 0:50.0 就接手了：只走到 2.75 m」 and 「還沒開始動，… 就接手了」.
- **Tab toggle:** `ChartGantt` 「顯示機關時間軸」 (remembered per computer, try/catch).
- **機關時間軸:**
  - Title 「機關時間軸」, hint 「拖整條改延遲、拖右邊改走幾秒（按住 Alt 不吸附）；紅色 = 照最高速度來不及」.
  - Buttons: 「播放」/「暫停」, 「停止預覽」, 「縮小」/「放大」 (also Ctrl+wheel), 「整首放進來」, 「收起機關時間軸」.
  - Layout: one row per mechanism; cue numbers on the ruler, with the GO→到位 band; red bar plus hatched overrun; dashed rest for a move that is cut. Untimed cues are noted as 「N 個 cue 沒設時間」.
  - Empty states: 「這首歌的 cue 還沒有設「對應影片時間」：設了之後機關就會排在時間軸上」 and 「還沒有機關：先在右邊「機關」分頁新增機關」.
  - Keyboard: ←/→ change the delay, ↑/↓ change the duration (Shift = 1 s), saved on key-up.
  - Clicking a bar selects that cue and mechanism.
  - The ruler and Play drive a 3D preview at machine speed, with objects held at the selected cue. The playhead and clock update the DOM directly, with no React render per frame.
  - When the editor gains song-video playback, the timeline follows `video.currentTime` instead of its own clock.

**Stage 2 (built as written; the rotary form shows 「怎麼轉」 first, with 「轉台，或自己設定轉軸（進階）」 as the old behaviour and the six edges; the axis and pivot fields sit under 「進階」, disabled while an edge is chosen):** 「動作」 adds a 「對開（兩邊往反方向）」 toggle. The object list splits into 「A 邊」 and 「B 邊」 (with 「照位置自動分兩邊」), and there are two labels: 「控台編號（A 邊）」 and 「控台編號（B 邊）」. The value reads 「每邊 2 m（中間開 4 m）」. Rotary adds 「沿著上緣翻 / 下緣翻 / 左緣翻 / 右緣翻 / 前緣翻 / 後緣翻」; pivot/axis fields move under 「進階」.

**Stage 3 (built; the pattern UI is an inline panel under the group header, the 3D view previews while the numbers change, and 「套用到這個 cue」 saves; the button 「一次建立多個」 sits next to 「新增機關」 and each group has 「編輯這一排」 for the shared travel / speed / default / presets):** 「一次建立 N 個機關」 from the 3D selection: 「名稱開頭」 (「LED 升降」 → 「LED 升降 1…8」) and 「編號順序：從左到右 / 從右到左 / 從前到後 / 照選取順序」. Per cue, 「套用花樣」 offers 一起 / 依序（間隔 N 秒）/ 波浪（中間值、振幅、週期、相位）/ 漸層（從 A 到 B）, with a preview before saving. In the timeline, a group is a collapsible block; collapsed, it shows the union of its bars.

**Stage 4:** 「新增吊掛（多點）」. Pick 2–4 「吊點」 from the bounding-box corners or edges (「左前角」「右前角」「左後角」「右後角」「左緣中間」…) or type X/Y/Z. Each hoist row reads like a lift; the rig header shows the resulting 「傾斜 2.3°（前後）」. 「一起動」 sets every hoist to one value (single-point behaviour).

## 6. CSV export (機關總表)

The columns change from v1 in two ways. 延遲 and 開始時間 are new. 可用(秒) becomes 走幾秒, because it is now the move's own planned time:

`歌曲 Song, Cue #, Cue 名稱 Cue name, GO 時間 GO, 到位時間 Arrive, 轉場(秒) Move s, 機關 Axis, 控台編號 Console, 起點 From, 目標 Target, 單位 Unit, 常用位置 Preset, 行程 Distance, 延遲(秒) Delay s, 開始時間 Start, 走幾秒 Axis s, 需要(秒) Need s, 速度(單位/秒) Speed, 最高速度 Max, 檢查 Check`

- The timing cells are filled only on moving rows; 開始時間 only for timed cues.
- New check texts are 「太快：要走 N 秒」 (own duration), 「被 Cue N 接手，只走到 X」 and 「還沒動就被 Cue N 接手」.
- The legend note adds 「開始時間 = GO 時間 + 延遲；走幾秒沒另外設 = 跟著 cue 的轉場」.
- Stage 2 writes two rows per split (「{name}（A 邊）」/「（B 邊）」, each with its own console label).
- Stage 4 writes one row per hoist; the rig appears in the legend only.

Golden sample (`timing.test.ts`): lift 0~3.5 m at 0.25 m/s. Cue 2 has delay 2 and duration 8; cue 3 has duration 30; cue 4 follows the cue.
```csv
S01 開場,1,暗場,0:00.0,0:00.0,0,中央升降台,Axis 3,,0.000,m,,,,,,,,0.25,起始位置
S01 開場,2,升起,0:10.0,0:30.0,20,中央升降台,Axis 3,0.000,3.500,m,,3.500,2.0,0:12.0,8.0,14.0,0.438,0.25,太快：要走 14 秒
S01 開場,3,半降,0:35.0,0:40.0,5,中央升降台,Axis 3,3.500,2.000,m,,1.500,0.0,0:35.0,30.0,6.0,0.050,0.25,被 Cue 4 接手，只走到 2.750
S01 開場,4,收起,0:50.0,1:00.0,10,中央升降台,Axis 3,2.000,0.000,m,,2.000,0.0,0:50.0,10.0,8.0,0.200,0.25,會晚 1 秒到位
```

## 7. Backward compatibility

- Existing rows get NULL timing, so playback, warnings and export match v1. The v1 golden rows are unchanged apart from the two new columns.
- The old frontend on master with the new worker:
  - its PUT `{ value }` uses `ON CONFLICT … SET value` and keeps the timing;
  - it ignores the extra fields on reads;
  - its INSERT-style copies still work.
  - It plays with cue timing (it doesn't know delays), which is acceptable until master gets this frontend.
- The new frontend with an old worker: the fields are missing, so they read as null; timing writes are ignored.
- Rollout order for each stage: back up D1, apply the additive migration, push, then deploy the worker from the pushed tree. The old worker keeps working on the migrated database because it uses explicit column lists.

## 8. Test plan

- **Unit (vitest):**
  - `timing.test.ts`: windows with delay and duration; timing not inherited; an inherited cue does not interrupt; too fast with own duration; both fixes; cut and cancel; scrub determinism; tweener delay in each mode; body validation; the CSV golden above.
  - The existing `motion`/`cueSheet` tests still pass (v1 parity).
  - Later stages: `patterns.test.ts`, `hoist.test.ts` (2/3/4 points, coplanarity), and split/flip round trips in `pose.test.ts`.
- **Worker (node:test + node:sqlite):** `mechanismTiming.test.mjs` covers:
  - migration 0027 on old rows, plus the CHECKs;
  - 製作 writes, while director and animator get 403;
  - an old-style `{ value }` keeps the timing; timing alone without a row is a 400;
  - share lists are masters only;
  - clone and template copies.
- **End-to-end (local wrangler + Vite + Playwright):** set the delay and duration on one cue, then check the bar, the red state, the warning, resizing, moving, and the duration fix button.

## 9. Tasks

| Stage | Task | Files |
|---|---|---|
| 1 ✓ | Model, validation, timing types | `model.ts`, `track.ts` |
| 1 ✓ | Timeline take-over rules, checks, tweener delay | `motion.ts`, `timing.test.ts` |
| 1 ✓ | CSV columns | `cueSheet.ts` (+ golden) |
| 1 ✓ | 0027, worker PUT / reads / copies | `0027_mechanism_timing.sql`, `mechanisms.mjs`, `mechanismTiming.test.mjs` |
| 1 ✓ | API client, hooks (`commitTiming`, preview), StageScene timings | `mechanismApi.ts`, `useMechanisms.ts`, `StageScene.tsx` |
| 1 ✓ | Row fields and warnings, 機關時間軸, editor dock, help | `MechanismCueRow.tsx`, `MechanismTimeline.tsx`, `MechanismTab.tsx`, `ProjectEditor.tsx`, `Help.tsx` |
| 2 ✓ | 0030 (was 0028); split nodes in `pose.ts`; `hingeFromBox`; form (對開 toggle, sides, flip edges, 進階); `?mech=2` filter; CSV two rows | `pose.ts`, `model.ts`, `MechanismSetupForm.tsx`, `mechanisms.mjs`, `cueSheet.ts`, `api.ts` |
| 3 ✓ | 0031 (was 0029); batch create and group APIs; `patterns.ts`; pattern panel (inline, with a live 3D preview, not a dialog); group block in timeline; bulk PUT | `0031_mechanism_groups.sql`, `mechanisms.mjs`, `access.mjs`, new `group.ts`, `patterns.ts`, `MechanismBatchForm.tsx`, `MechanismGroupForm.tsx`, `MechanismPatternPanel.tsx`, `MechanismTab.tsx`, `MechanismTimeline.tsx`, `mechanismGroups.test.mjs`, `group.test.ts`, `patterns.test.ts` |
| 4 | 0030; `hoist.ts`; rig node in `pose.ts`; rig form and attach picker; tilt display and coplanarity checks (also sampled along moves); CSV per hoist | new `hoist.ts`, `pose.ts`, `MechanismSetupForm.tsx`, `motion.ts`, `cueSheet.ts` |
