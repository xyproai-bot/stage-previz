# Cue 庫 (cue library) — design

Date: 2026-10-22. Status: design approved in concept by the owner; this document is the implementation contract.
Related: `2026-10-14-mechanism-system-design.md`, `2026-10-15-mechanism-v2-design.md`, `2026-10-15-led-canvas-templates-design.md` (template switches), migration 0040 (default hidden).

The owner works like a lighting-console / d3 operator. He wants to build a set of **project-level preset cues ("looks")** once, then in each song just **pick which look is active when** (one look for the whole song, or a switch at the chorus). Today every song has its own cues and he has to rebuild them per song.

In Taiwanese concert mechanism (機關) crews, a new cue is made by **"save as" (另存)**: start from the current stage look, change things, record it as a *new* cue. You don't edit the previous one. The UI is built around that.

---

## 0. Decisions at a glance

| # | Decision |
|---|----------|
| D1 | **Reference, not copy.** A song slot points at a library cue. Editing the library cue changes every song that uses it. |
| D2 | **Variants by 另存 / duplication.** No per-song overrides. A different look for one song means a new library cue. |
| D3 | **Each library cue is a complete look.** Objects or mechanisms the cue doesn't mention are at their default (object default position; hidden if `default_hidden`; mechanism `default_value`). There is no carry-forward between slots any more. A library cue must look the same in every song, so it can't depend on what came before it. |
| D4 | **`cues` rows become the slots** (`{song, order, video time, transition, status}` + new `library_cue_id`). The look content moves to new library tables. Slot ids don't change, so comments, LED template switches (「跟著 Cue 走」), share URLs, activity, AE markers and the CSV keep working. |
| D5 | **Migration bakes each old cue's fully resolved state** (including carried-forward values) into a library cue, so every song looks exactly the same. It also bakes mechanism "own vs inherited" status, so motion is identical too. Truly identical cues (same look and same name) are merged. Names are 「<歌代號> <cue 名>」; merged cues keep the shared name. |
| D6 | **Per-project switch** `projects.cue_library` (0 = today's model, 1 = Cue 庫). Production and test share one worker and one D1, so the backend can ship at any time: legacy projects take exactly today's code paths. A duplicated test project is switched first; production projects are switched at cutover (Stage 10). Old tables are never modified, so rollback means flipping the switch back. |
| D7 | **Console editing model.** In a Cue 庫 project, stage edits go into **「還沒存的改動」** (a programmer/draft). The primary action is **「另存成新的 cue」**. **「更新 Cue N」** writes in place: it is secondary and deliberate, and asks for confirmation when other songs use the cue. **「放棄」** throws the draft away. |
| D8 | **(REPLACED by section 10.2: free-text labels)** ~~Console numbering.~~ Each library cue has a unique decimal number per project (1, 2, 2.5, 2.75, at most 3 decimals) plus a name. 另存 suggests a number between the base and the next cue (2 → 2.5). |
| D9 | **常用擺位 (cue templates) stay** as a cross-project palette. In a Cue 庫 project, 「套用常用擺位」 applies into the draft, and 「存成常用擺位」 saves a library cue's full look. Templates are not converted to library cues. |
| D10 | **Deleting a library cue is blocked while any song uses it.** Removing a slot or deleting a song never deletes library cues. |

Vocabulary used below: **library cue** = a row of `library_cues` (UI 「Cue 庫的 cue」). **Slot** = a row of `cues` (UI 「這首歌的 cue」). **Look** = a library cue's object rows plus mechanism rows.

---

## 1. What exists today (grounded)

### 1.1 Tables

- `cues` (0001, 0013, 0020): `id, song_id, name, "order", position_xyz/rotation_xyz/fov` (unused camera fields), `crossfade_seconds` (0 = hard cut, default 1), `video_time_sec` (NULL = no video time; manual), `status` ('master'|'proposal'|'alternate'; proposals are dormant, with no UI to create them), `base_cue_id`, `thumbnail_r2_key`.
- `cue_object_states` (0002): `UNIQUE(cue_id, stage_object_id)`, with `position/rotation/scale` JSON or NULL, `visible INTEGER DEFAULT 1`, `custom_props`, `updated_at`. An existing row is an "override"; NULL fields fall through.
- `cue_mechanism_positions` (0023, 0027): `PK(cue_id, mechanism_id)`, `value NOT NULL`, `delay_sec`, `duration_sec` (NULL = follow the cue). Timing belongs to the cue's own row and is never inherited.
- `song_template_switches.cue_id → cues(id) ON DELETE CASCADE` (0039). 「跟著 Cue 走」 follows `cues.video_time_sec`.
- `comments.cue_id` (0026): the cue at comment time. It may dangle.
- `cue_templates` (0009): 常用擺位. The payload is the source cue's *own* rows by `mesh_name`, plus `mechanismPositions` by mechanism name (`createCueTemplate`, `mech.templateMechanismPositions`). `project_id NULL` = global.
- `stage_objects.default_hidden` (0040).

### 1.2 Resolution rules today (the exact behaviour migration must reproduce)

**Objects.** `cf-worker/cueStates.mjs` `buildCueStates(objectRows, earlierRows)` is fed by `loadCueStates` in `worker.js`. The same function serves admin, director, workstation and share.
- Earlier rows are the same song with **`c."order" <` this cue's order (strict; ties don't count)**, **all statuses**, SQL `ORDER BY c."order"`. The sort is stable on input order for equal order.
- Tracking is **whole-row**: the latest earlier row replaces the previous record *including its NULL fields*. Quirk: cue1 `{pos P}`, cue2 `{visible 0, pos NULL}`, cue3 no row → cue3's position is the **default**, not P.
- Field pick: own non-NULL → tracked row's field → default.
- Visible: own → tracked row's visible → (if `default_hidden` and some earlier row set visible) the latest explicit visible → `!default_hidden`.
- `tracked = !hasOverride && tracked-row-exists`. `customProps` is never tracked.
- `upsertCueState` merges sent fields. `createCue` with `snapshotStates` inserts without `visible`, so `DEFAULT 1` applies (snapshot rows are explicitly visible).

**Mechanisms.** `web/src/lib/mechanisms/track.ts` `resolveSongMechanisms` runs in the frontend for the editor, director, workstation, share and CSV.
- Only **master** cues propagate, sorted by `order` (ties broken by `listCues` order: `"order", created_at`).
- A proposal starts from the nearest earlier master and adds its own values.
- Each value carries `source: 'own' | 'inherited' | 'default'`, a raw `stored` value, and is clamped to travel at read time.

**Motion.** `web/src/lib/mechanisms/motion.ts` `buildMechanismTimeline` / `checkSongMechanisms` / `MechanismTweener`:
- `ownMoveFor` returns timing only when `source === 'own'`.
- An *own* row always takes over (it cuts an unfinished previous segment).
- An *inherited* value doesn't interrupt when the machine already ends there. Otherwise it moves with the cue transition.
- Motion depends only on (resolved values, which rows are own, own timings, cue windows).

### 1.3 Time, order, transition

The list order (`order`, drag/上移下移, `reorderCues`) and the video time (`video_time_sec`, `CueMetaEditor` in ProjectEditor) are independent today.
- Video playback uses `cueWindows` (`lib/cueTimeline.ts`): timed cues are sorted by time. GO = max(arrive − transition, previous arrive).
- Tracking uses `order`. `motion.ts timedOrderMismatch` already detects when the list order and the time order disagree.

### 1.4 Everything that references cue ids or order

| Feature | Where | Reference |
|---|---|---|
| Cue CRUD / reorder / reset | `worker.js` `listCues/createCue/updateCue/deleteCue/reorderCues/resetCue`; routes in `access.mjs` (`cues.*`, need `editor` for writes) | cue id, order |
| Object states | `listCueStates/upsertCueState/deleteCueState` | cue id |
| Reset all cues of a song | `cueStatesBatch.mjs` (`cue-object-states` list/clear/restore), `web/src/lib/cueResetAll.ts` | cue ids of the song |
| Mechanism positions / timing | `mechanisms.mjs` `putCuePosition/putCuePositionsBulk/deleteCuePosition/loadSongPositions/mechanismSheet/cloneCuePositions/snapshotCuePositions/applyNamedPositions/clearCuePositions/convertCuePositions`; `loadMechanisms` `cue_count` | cue id |
| Mechanism timeline / patterns | `components/mechanisms/MechanismTimeline.tsx`, `MechanismPatternPanel.tsx`, `useMechanisms.ts` | cue id, order, time |
| 常用擺位 | `createCueTemplate` (fromCueId), `createCue` (fromTemplateId), `CueTemplatePickerDialog` | cue id |
| LED template switches | `ledTemplates.mjs` (`song_template_switches.cue_id`, `loadMasterCueTimes`), `lib/ledTemplateTimeline.ts`, `LedTimelineDialog.tsx`, `aeTimelineScript.ts` markers use the cue **name** as label | slot id, slot time, name |
| Comments / review | `comments.cue_id`, `lib/review/useReviewSession.ts` (current cue id) | slot id |
| Share link | `worker.js` `handleShareRouter`: `songs/:id/cues` (master only), `cues/:id/states` (`loadCueStates`), `mechanism-positions` (`masterOnly`) | slot id |
| Director / workstation | `pages/Preview.tsx`, `pages/Studio.tsx`: `listCues`, `listCueStates` per cue, J/K | slot id, order |
| Editor | `pages/ProjectEditor.tsx`: `CueList`, `CueAddSplitButton`, `cueRowMenuItems`, J/K (`k === 'j'`), object writes `api.setCueState/resetCueState` (around the `handleObjectChange` path), `api.resetCue`, reset-all | slot id |
| CSV 機關總表 | `mechanismSheet` + `lib/mechanisms/cueSheet.ts` | slot id, order, time, name |
| Storyboard / diff / PDF | `CueStoryboard.tsx`, `CueDiffDialog.tsx`, `lib/exportPdf.ts` | slot id, name |
| Copy / export / import | `duplicateProject`, `exportProject` (schemaVersion 1), `importProject`, `mech.copyMechanismsToProject/exportMechanisms/importMechanisms`, `ledTpl.copyTemplatesToProject` | cue id maps |
| Import cues from another song | `importCuesFromSong`, `ImportCuesDialog.tsx` | cue rows |
| Activity log | `logActivity` target types `cue`, `cue_state`; `lib/activityText.ts` | ids + names |
| Undo | `lib/editHistory.ts` scope `cue:<id>`, `lib/cueStateUndo.ts` | cue id |
| Default hidden | `cueStates.mjs`, `lib/defaultHidden.ts` texts | — |

Frontend → endpoint map: everything goes through `web/src/lib/api.ts` (cues, states, batch, templates, share) and `web/src/lib/mechanisms/mechanismApi.ts` (positions, timing, bulk, sheet, share positions). The capability pattern already exists: `?mech=N` (`mechanisms.mjs mechLevel`).

---

## 2. Model

### 2.1 Schema — migration `0042_cue_library.sql` (additive only)

```sql
-- 0042 Cue 庫：專案層級的 cue（畫面），每首歌的 cue（cues 列）指到它
CREATE TABLE IF NOT EXISTS library_cues (
  id TEXT PRIMARY KEY,                       -- 'lc_…'
  project_id TEXT NOT NULL,
  number REAL NOT NULL CHECK (number > 0 AND number < 100000),   -- 1, 2, 2.5（最多 3 位小數，存之前四捨五入到 0.001）
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  based_on_id TEXT,                          -- 另存的來源（只記錄，畫面不靠它）
  migrated_from TEXT,                        -- JSON：搬家時從哪些 cues.id 來的；NULL = 在 Cue 庫建的
  rev INTEGER NOT NULL DEFAULT 0,            -- 畫面每改一次 +1（更新時檢查有沒有被別人改過）
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (based_on_id) REFERENCES library_cues(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_library_cues_number ON library_cues(project_id, number);

-- 每個 Cue 庫的 cue 裡每個物件（沒有列 = 預設位置；欄位 NULL = 那個欄位用預設）
--   own = 1：這個 cue 自己設的（own_fields：1 位置 2 角度 4 大小 8 顯示 16 自訂；其他欄位是搬家時從前面的 cue 帶過來的值）
--   own = 0：整列都是搬家時從前面的 cue 帶過來的（畫面上寫「沿用」）
CREATE TABLE IF NOT EXISTS library_cue_object_states (
  library_cue_id TEXT NOT NULL,
  stage_object_id TEXT NOT NULL,
  position TEXT, rotation TEXT, scale TEXT,
  visible INTEGER CHECK (visible IS NULL OR visible IN (0, 1)),
  custom_props TEXT,
  own INTEGER NOT NULL DEFAULT 1 CHECK (own IN (0, 1)),
  own_fields INTEGER NOT NULL DEFAULT 0 CHECK (own_fields BETWEEN 0 AND 31),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (library_cue_id, stage_object_id),
  CHECK (own = 1 OR own_fields = 0),
  FOREIGN KEY (library_cue_id) REFERENCES library_cues(id) ON DELETE CASCADE,
  FOREIGN KEY (stage_object_id) REFERENCES stage_objects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lcos_object ON library_cue_object_states(stage_object_id);

-- 每個 Cue 庫的 cue 裡每個機關（沒有列 = 機關預設位置）
--   carried = 0：這個 cue 叫機器動（照自己的延遲 / 走幾秒；跟現在「自己設的」一樣，會接手還沒走完的上一段）
--   carried = 1：位置是畫面的一部分，但不打斷正在往這裡走的機器（跟現在「沿用」一樣）；只有搬家會寫出這種列，時間一定是 NULL
CREATE TABLE IF NOT EXISTS library_cue_mechanism_positions (
  library_cue_id TEXT NOT NULL,
  mechanism_id TEXT NOT NULL,
  value REAL NOT NULL,
  delay_sec REAL CHECK (delay_sec IS NULL OR (delay_sec >= 0 AND delay_sec <= 3600)),
  duration_sec REAL CHECK (duration_sec IS NULL OR (duration_sec >= 0 AND duration_sec <= 3600)),
  carried INTEGER NOT NULL DEFAULT 0 CHECK (carried IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (library_cue_id, mechanism_id),
  CHECK (carried = 0 OR (delay_sec IS NULL AND duration_sec IS NULL)),
  FOREIGN KEY (library_cue_id) REFERENCES library_cues(id) ON DELETE CASCADE,
  FOREIGN KEY (mechanism_id) REFERENCES mechanisms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lcmp_mechanism ON library_cue_mechanism_positions(mechanism_id);

-- 每首歌的 cue 指到哪個 Cue 庫的 cue（NULL = 還沒搬，舊模式的專案）
-- 外鍵不加 ON DELETE：還有歌在用就刪不掉（後台先擋，回 409）；刪整個專案時同一個陳述式 cascade 兩邊，結束時檢查 → 刪得掉
ALTER TABLE cues ADD COLUMN library_cue_id TEXT REFERENCES library_cues(id);
CREATE INDEX IF NOT EXISTS idx_cues_library ON cues(library_cue_id);

-- 0 = 跟以前一樣（每首歌自己的 cue、沿用前面的 cue）；1 = Cue 庫
ALTER TABLE projects ADD COLUMN cue_library INTEGER NOT NULL DEFAULT 0;
```

Notes:
- The old tables are not touched by 0042 or by the migration. In a Cue 庫 project they are frozen (read only by the migration and the rollback path).
- `cues.name`, `crossfade_seconds`, `video_time_sec`, `status` and `order` stay on the slot. The camera fields stay too (unused).
- Stage 1's test must prove that hard-deleting a project with slots and library cues succeeds (both cascades run in one statement, and the NO ACTION check runs at statement end), and that deleting a used library cue directly fails.

### 2.2 Resolving a slot (D3)

Slot S → library cue L = `S.library_cue_id`. For each stage object `o` (row `r` = L's row for o, or none):
- `effective.position = r?.position != NULL ? parse(r.position) : o.default_position`. The same goes for `rotation` and `scale`.
- `effective.visible = r?.visible != NULL ? !!r.visible : !o.default_hidden`.
- `override = r && r.own ? { position: bit1 ? parse : null, rotation: bit2 …, scale: bit4 …, visible: bit8 ? !!r.visible : null, customProps: bit16 ? parse : null, updatedAt: r.updated_at } : null`.
- `tracked = !!r && !r.own`.
- The other fields are the same as today (`objectId, meshName, displayName, category, order, locked, default, defaultHidden`).
- New additive field `sources: { position|rotation|scale|visible: 'own'|'carried'|'default' }`.

For each mechanism m (row `p`):
- `p` with `carried = 0` → `source 'own'`, `stored = p.value`, timing `{delaySec, durationSec}`.
- `p` with `carried = 1` → `source 'inherited'`, `stored = p.value`, no timing.
- No `p` → `source 'default'`, `stored = m.default_value`.
- `value` = `stored` clamped to travel. `fromCueId` = own: this slot id; inherited/default: null.

Why there is no carry-forward between slots:
- A referenced look has to be the same in every song. If look L inherited from "the previous slot", L would look different in each song, and 「更新 L」 would have no single meaning.
- The 另存 workflow already copies the whole current look into the new cue, so nothing is lost.
- "Unset = default" is the only context-free rule. `default_hidden` keeps its meaning: an object the look doesn't mention is hidden.

Motion is unchanged. `buildMechanismTimeline` / `checkSongMechanisms` / `MechanismTweener` get `valuesFor(slot)` and `ownFor(slot)` from the rule above. `carried = 1` means exactly what "inherited" means today.

### 2.3 Slots: ordering and validation

- A slot is `{ id, song_id, library_cue_id (NOT NULL in Cue 庫 projects), video_time_sec (nullable), crossfade_seconds, order, status }`.
- New writes (new API) keep the order consistent with time. After a slot is added or its time changes, the server rewrites `order` = 0..n−1 using a stable sort. The key of slot i is its time if set, else the key of the previous slot in the current order (−1 for leading untimed slots). Untimed legacy slots stay attached behind their predecessor, and ties keep their current relative order. Implement as pure `orderSlots()` in `cf-worker/cueLibrary.mjs`, mirrored in `web/src/lib/cueLibrary.ts` (parity test).
- Migration never re-sorts. If a song's legacy list order disagrees with time (`timedOrderMismatch`), the song list shows a notice before any write re-sorts it.
- Time (new API): finite, 0 ≤ t ≤ 36000, rounded to 0.001. Within one song, two slots can't share a time (|Δ| < 0.0005 → 409 「這首歌 1:23 已經有 cue 了」). Legacy ties are kept and displayed. `null` = 「不對應影片時間」 (manual GO only), allowed.
- 上移 / 下移 (the existing `cues/reorder`) is allowed only when the result keeps timed slots in time order. Otherwise 400 「有時間的 cue 照時間排，不能手動移」.
- The same library cue may appear several times in one song. Consecutive identical slots are allowed (nothing moves).
- Transition = `crossfade_seconds` per slot (0 = hard cut). The default for a new slot is 1.

### 2.4 Numbering (D8)

- Stored REAL, unique per project. Input validation: finite, 0 < n < 100000, at most 3 decimals (`Math.abs(n*1000 - Math.round(n*1000)) < 1e-6`). Store `Math.round(n*1000)/1000`.
- Display: `String(n)` (2.5, 12, 12.25). Lists show the number as a badge and then the name. In sentences: 「Cue 12「副歌全開」」.
- `suggestNumber(existing, after)` (pure, backend and frontend parity):
  - `after == null` → `floor(max(existing, 0)) + 1`.
  - Let `next` = the smallest existing number > `after`. None → `floor(after) + 1`.
  - Else, if `floor(after) + 1 < next` → that integer.
  - Else take `mid = (after + next) / 2`, and for d = 1..3 take the first `round(mid, d)` that is strictly between and unused. Examples: 2 & 3 → 2.5; 2.5 & 3 → 2.8; 2 & 2.5 → 2.3.
  - If nothing fits → `floor(max) + 1`, and the dialog says 「中間沒有空的編號，先放到最後」.
- The library list is sorted by number. 「重新編號」 (renumber all to 1..N in the current order, one undoable step) is a nice-to-have in Stage 7.

### 2.5 Usage and delete (D10)

- `usage(L)` = the slots referencing L (all statuses) grouped by song: `songCount`, `slotCount`, and `[{cueId, songId, songName, songCode, videoTimeSec}]`.
- UI: 「3 首歌在用」 (with 「、5 次」 when slotCount > songCount) or 「沒有歌在用」.
- `DELETE /library-cues/:id` when slotCount > 0 → 409 `{ error: '還有 3 首歌在用這個 cue，先從這些歌拿掉才能刪', usage }`.
- Removing a slot or deleting a song keeps library cues. The song delete confirm adds 「這首歌用到的 Cue 庫的 cue 不會被刪掉」.

### 2.6 Mode switch (D6)

- `projects.cue_library`: GET project and list projects return `cueLibrary: boolean`. Frontends show the new UI only when it's true.
- All content reads and writes branch in one place: `cf-worker/cueLibraryRoutes.mjs` helpers `isLibraryProject(ctx)`, `libraryCueOfSlot(env, projectId, slotId)`, `slotStates(...)`, `songPositions(...)`. Legacy projects call today's functions unchanged.
- New projects: `createProject` sets `cue_library = 1` when `app_settings.cue_library_new_projects = '1'` (the same pattern as `login_code_storage`). That key is set at cutover (Stage 10), so no deploy is needed.

---

## 3. Migration (bake) — exact equality

### 3.1 Principle

Don't re-implement tracking. **Bake from the legacy resolvers' own output.** Per slot:
- **Objects:** call the existing `buildCueStates` (fed exactly like `loadCueStates`), extended with the additive `sources` per field: `'own'` (own non-NULL), `'tracked'` (taken from the tracked row or, for visible, the default-hidden "latest explicit" rule), `'default'`.
- **Mechanisms:** call `cf-worker/mechanismTrack.mjs`, a line-by-line JS port of `track.ts` `resolveSongMechanisms` + `ownTimingsByCue`. It gets the same inputs as the frontend: cues ordered `"order", created_at`; positions from `loadSongPositions` without `masterOnly`.

Bake rows for slot S:
- **Object state with `override != null`:** row with `own = 1`; `own_fields` = the bits of the non-NULL override fields; `position/rotation/scale` = `JSON(effective.x)` unless that field's source is `'default'` (then NULL); `visible` = `effective.visible ? 1 : 0` unless the source is default (NULL); `custom_props` = override.customProps JSON or NULL; `updated_at` = override.updatedAt.
- **Object with `tracked = true`:** row with `own = 0, own_fields = 0`, fields as above, `custom_props` NULL. A row is written even if all fields are NULL, so `tracked` stays identical.
- **Otherwise:** no row (assert that every source is default).
- **Mechanism `source 'own'`:** row `carried = 0, value = stored`, own delay/duration.
- **Mechanism `'inherited'`:** row `carried = 1, value = stored` (raw, not clamped).
- **Mechanism `'default'`:** no row.
- Bake over all mechanisms of the project (all variants, ignoring the `?mech` level filter), except `hoist_rig` (it has no value).

### 3.2 Merging, names, numbers

- **Look key** = canonical JSON of the trimmed name, plus the object rows sorted by object id (parsed JSON values, visible, custom, own, own_fields), plus the mechanism rows sorted by id (value, delay, duration, carried). `updated_at` is excluded.
- Slots with an equal key share one library cue. **"Truly identical" means the same look and the same cue name.** For example, the copies made by 「從別首歌匯入 cue」 merge; two all-default cues named 開場 and 間奏 do not.
- **Names:** a singleton is `"<song code> <cue name>"`. The code is `songs.code`; if it's missing, use the song name truncated to 12 characters. A merged group uses the shared cue name without a code. Truncate to 100 characters (`CUE_NAME_MAX`).
- **Numbers:** sequential integers 1..N in setlist order (song `order`, then slot `order`, then `created_at`) of each look's first occurrence. See open question 1.
- **Ids are deterministic:** `'lc_' + first 20 hex chars of sha256(projectId + ':' + firstSlotId)`. Re-runs produce identical SQL.
- `migrated_from` = the JSON array of slot ids.

### 3.3 Script — `cf-worker/scripts/migrate-cue-library.mjs`

This is offline and follows the precedent of `scripts/hash-login-codes.mjs`.

1. **Input:** a `wrangler d1 export` SQL file. That file is also the backup. Load it into `node:sqlite`, wrap it with `testing/d1-sqlite.mjs`, and run the **real legacy code** (`loadCueStates`, `loadSongPositions`, `mechanismTrack.mjs`). Using SQLite means ties come out in the same order as on D1.
2. For each project with `cue_library = 0` (or `--project <id>` for a test copy): bake (3.1), merge (3.2), apply locally, set `cue_library = 1` locally, and run **verification (3.4) through the worker's routes on the local copy**.
3. **Output:** `cue-library.sql` plus `cue-library-report.json`. Exit non-zero if any difference is found; in that case no SQL is written.
4. **SQL per project** is idempotent, in this order:
   1. `UPDATE cues SET library_cue_id = NULL WHERE song_id IN (SELECT id FROM songs WHERE project_id = ?)`
   2. `DELETE FROM library_cues WHERE project_id = ?`
   3. chunked multi-row `INSERT` of cues and rows (≤ 50 rows per statement)
   4. `UPDATE cues SET library_cue_id = …`
   5. `UPDATE projects SET cue_library = 1 WHERE id = ? AND cue_library = 0`
   6. one `activity_log` row: 「把 N 個 cue 搬進 Cue 庫（M 個 Cue 庫的 cue）」

   Projects already at 1 are skipped unless `--rebake`, which is allowed only right after activation and discards library-era edits.
5. **Other modes:**
   - `--verify-only <export>`: re-run verification against a post-apply export.
   - `--revert`: emit `UPDATE projects SET cue_library = 0 WHERE id IN (…)`. The old tables are intact; edits made in Cue 庫 mode are lost.
6. **Report:** per project, the slot count, library cues created, merged groups (name + songs), rows written, differences (must be 0), and informational warnings (order ties, time/order mismatches, out-of-range stored mechanism values).

### 3.4 Verification — what "zero differences" means

For every slot of every migrated project, compare legacy vs Cue 庫:
- **Objects** (`GET …/cues/:id/states` before vs after): per object, `effective` (deep-equal of parsed values), `override` (null-ness and each field; **`updatedAt` excluded**, because merged cues keep the first slot's timestamp), `tracked`, `defaultHidden`, `locked`, `order`, `default`.
- **Mechanisms:** per slot and mechanism, `value`, `stored`, `source`, `clamped`, and own timings. `fromCueId` is excluded; it's a label only.
- **Motion:** identical by construction, because motion reads only these inputs (1.2). As a guard, the Stage 3 vitest parity test runs `buildMechanismTimeline` on legacy-resolved vs library-resolved fixtures.
- **Slots:** the same ids, `order`, `video_time_sec`, `crossfade_seconds`, `status`, `name`. Every slot has a `library_cue_id` in its own project.
- **Share routes:** the same object states and positions, through the share token path.
- **Integrity:** every library row's object or mechanism belongs to the project. No library cue is unused right after migration.

### 3.5 Runbooks

- **Test project (from Stage 3 on):**
  1. Duplicate a real project in the UI (「複製專案」).
  2. Export.
  3. Run the script with `--project <copy id>`.
  4. Apply the SQL to remote.
  5. Run `--verify-only` on a fresh export.

  Production projects are untouched.
- **Production cutover (Stage 10, added to `docs/release-checklist.md`):**
  1. Check that the worker includes Stages 1–9 and that 0042 is applied (`wrangler d1 migrations list stage-previz-db --remote`).
  2. Ask the team not to edit for 15 minutes.
  3. Back up: `npx wrangler d1 export stage-previz-db --remote --output …-before-cue-library.sql`, and record the D1 Time Travel bookmark (`npx wrangler d1 time-travel info stage-previz-db`).
  4. Script → 0 differences.
  5. Apply.
  6. Re-export → `--verify-only` → 0 differences, all projects at 1.
  7. Set `app_settings.cue_library_new_projects = '1'`.
  8. Spot-check two songs on the director page and on a share link.
- **Rollback:** the `--revert` SQL (fast; loses Cue 庫-era edits), or a Time Travel restore to the bookmark.

---

## 4. API

All routes go under `/api/projects/:id/` through `describeProjectRoute` (`access.mjs`). Reads need `member`, writes need `editor` (this project's 製作). Every Cue 庫 route on a legacy project returns 400 「這個專案還沒有 Cue 庫」. Handlers live in `cf-worker/cueLibraryRoutes.mjs` and return `{status, body}` like `mechanisms.mjs`.

### 4.1 Library cues (new)

| Method & path | Body → response |
|---|---|
| `GET library-cues` | → `{ libraryCues: [{ id, number, name, note, basedOnId, rev, createdAt, updatedAt, usage: {songCount, slotCount, slots:[…]}, counts: {objects, mechanisms} }] }`, sorted by number |
| `POST library-cues` (另存 / new / copy) | `{ number?, name, basedOnId?, look?, place? }`. `look` omitted + `basedOnId` → exact copy of the base look (flags and timing kept). `look` omitted, no base → empty look. `place`: `{ songId, replaceCueId }` (re-point that slot) or `{ songId, videoTimeSec, crossfadeSeconds? }` (add a slot). One D1 batch. → `{ libraryCue, slot? }`. 409 on duplicate number or time |
| `GET library-cues/:lc` | → one library cue with usage |
| `PATCH library-cues/:lc` | `{ name?, number?, note? }` (number validated, unique) |
| `DELETE library-cues/:lc` | 409 with usage when used |
| `GET library-cues/:lc/look` | → `{ rev, updatedAt, objects: [LookObjectRow], mechanisms: [LookMechRow] }` (raw rows; used by the draft layer) |
| `PUT library-cues/:lc/look` | `{ ifRev?, objects, mechanisms }` replaces the whole look atomically → `{ rev, previous: { objects, mechanisms } }`. 409 `{ error: '這個 cue 剛剛被別人改過', rev }` when `ifRev` is stale. Used by 更新, by undo/redo, and by 全部回到預設 |
| `GET library-cues/:lc/states` | → `CueState[]` (2.2), the same shape as the slot states |
| `PUT/DELETE library-cues/:lc/states/:obj`, `PUT/DELETE library-cues/:lc/mechanism-positions/:mech`, `PUT library-cues/:lc/mechanism-positions` (bulk) | Per-row writes with the same body rules as today's slot routes. A PUT sets `own = 1` and ORs in `own_fields` (a carried row's other fields keep their values), or for mechanisms sets `carried = 0`. Each one does `rev++` |

- `LookObjectRow = { objectId, position, rotation, scale, visible: boolean|null, customProps, own: boolean, ownFields: ('position'|'rotation'|'scale'|'visible'|'customProps')[] }`.
- `LookMechRow = { mechanismId, value, delaySec, durationSec, carried: boolean }`.
- **Validation:** objects and mechanisms must belong to the project; at most 2000 objects and 500 mechanisms; no `hoist_rig`; carried rows have no timing; the existing timing bounds apply. A look PUT stores values verbatim (no clamping) so undo is exact; the single-row PUT clamps as today.
- **Atomicity / `rev`:** the first statement is `UPDATE library_cues SET rev = rev + 1, updated_at = … WHERE id = ? AND rev = ?`. Every later statement adds `AND EXISTS (SELECT 1 FROM library_cues WHERE id = ? AND rev = ?+1)`. Writes use `json_each` chunks like `cueStatesBatch.mjs` (`WRITE_CHUNK = 50`). If the first statement changed nothing → 409.

### 4.2 Slots (existing routes, extended)

- **`GET songs/:s/cues`:** each slot gets `libraryCueId` and `libraryCue: { id, number, name }`.
  - Stages 3–7: `name` stays `cues.name`.
  - From Stage 8: `name` = the library cue name in Cue 庫 projects, and `slotName` = `cues.name`. Every consumer (director, workstation, share, AE markers, CSV, comments) then shows library names consistently.
- **`POST songs/:s/cues` with `libraryCueId`** (new form): `{ libraryCueId, videoTimeSec?, crossfadeSeconds? }` → creates the slot and runs `orderSlots`.
- **`PATCH songs/:s/cues/:c`:** new fields are `libraryCueId` (re-point within the project) and `videoTimeSec` (→ `orderSlots`, tie check). `name` keeps editing only `cues.name`.
- **`DELETE`** removes only the slot. LED switches that follow it cascade as today.
- **Compatibility in Cue 庫 projects (Stage 4), for the old UI and stale tabs:**

| Old endpoint | Behaviour in a Cue 庫 project |
|---|---|
| `GET cues/:c/states` | Resolve the slot's library cue (2.2) |
| `PUT cues/:c/states/:o` | Per-row write into the slot's library cue (4.1). It affects every song using that cue |
| `DELETE cues/:c/states/:o` | Delete the row (→ default, not 「沿用」) |
| `POST cues/:c/reset` | Delete all object and mechanism rows of the library cue |
| `PUT/DELETE cues/:c/mechanism-positions[/:m]` | Library rows; PUT → `carried = 0` |
| `GET songs/:s/mechanism-positions` | One row per slot (a library cue used twice appears twice, with different `cueId`). With `?cuelib=1`: `{ mode: 'library', positions: [{ cueId, libraryCueId, mechanismId, value, delaySec, durationSec, carried }] }`. Without it: only `carried = 0` rows, so stale frontends that still track get the right answer right after migration |
| `cue-object-states` list / clear / restore | Works on the distinct library cues used by the song. Rows carry `libraryCueId` (plus `cueId` = the first slot using it). Restore accepts either. List adds `shared: [{ libraryCueId, songs: [...] }]` |
| `POST cues` with legacy bodies | Creates a library cue (number = max + 1, name = body.name) plus a slot at the end (order max + 1, time NULL). `blank` → copy of the previous slot's look with every row carried (`own = 0`, mechanisms `carried = 1`, timings dropped), which mirrors today's "all inherited". `cloneFrom` → exact copy of the source slot's look. `snapshotStates` → own rows (`visible = 1`, as today) plus `snapshotMechanisms` as own rows. `fromTemplateId` → template rows as own rows plus named mechanism positions |
| `GET mechanisms` (`cueCount`), `DELETE mechanism` (`removedPositions`) | Count library rows |
| `POST mechanisms/:m/convert-cue-positions` | `planCueConversion` over library cues: each library cue is its own one-cue sequence; carried/own is preserved from the source object row |
| `POST cue-templates` (`fromCueId` = slot or `fromLibraryCueId`) | Payload = the library cue's full look (all rows) by mesh / mechanism name |
| `POST songs/:s/import-cues` | Same project → new slots that reference the source song's library cues (same times and transitions; `replace` removes existing slots first). Other project → copy the source looks (resolved, whichever mode the source is in) into this library (objects by mesh name, mechanisms by name, numbers after the max), then add slots |

### 4.3 Share links

- `songs/:s/cues`: master slots, plus `libraryCue: {number, name}` (Stage 8 name rule).
- `cues/:c/states`: via `slotStates`.
- `mechanism-positions`: the same `?cuelib=1` rule, master slots only.
- The share link never lists the library itself.

### 4.4 Copy / export / import

- `duplicateProject`, Cue 庫 project: copy `library_cues` (new ids, same numbers, names, notes; `based_on_id` remapped), their rows (object and mechanism ids remapped), and slots with remapped `library_cue_id`. Set `cue_library = 1`; the legacy tables of the copy stay empty. A legacy project copies as today.
- `exportProject`:
  - `schemaVersion 2` adds `libraryCues`, `libraryCueObjectStates`, `libraryCueMechanismPositions`; `cues` rows include `library_cue_id`; `project.cueLibrary`.
  - A legacy project still exports v1.
- `importProject`:
  - v2 → remap ids.
  - v1 → insert legacy rows, then bake in-worker with the same pure functions (`cueLibrary.mjs`, fed from the in-memory arrays ordered `order, array index`), and set the flag when `cue_library_new_projects = '1'`.
  - Old export files without these fields keep importing.

### 4.5 Activity log

- New target type `library_cue`; slot events stay `cue`.
- Payloads carry names and numbers at the time of the event.
- `lib/activityText.ts` (Stage 5):
  - 「新增 Cue 庫的 cue「12 副歌全開」」
  - 「從「12 副歌全開」另存成「12.5 副歌全開」」
  - 「更新 Cue 庫的「12 副歌全開」（3 首歌在用）」
  - 「把「12」改名成「…」」
  - 「把「12 …」的編號改成 14」
  - 「刪除 Cue 庫的「12 …」」
  - 「在歌曲「X」0:45 加上「12 …」」
  - 「把歌曲「X」1:23 的 cue 換成「13 …」」
  - 「把歌曲「X」1:23 的 cue 時間改成 1:30」
  - 「從歌曲「X」拿掉 1:23 的「12 …」」
  - 「把 N 個 cue 搬進 Cue 庫（M 個 Cue 庫的 cue）」

---

## 5. UI (製作; strings in Traditional Chinese; lucide line icons via `Icon`, never emoji)

Everything below appears only when `project.cueLibrary` is true. Legacy projects keep today's UI.

### 5.1 The console workflow: 「還沒存的改動」 bar (D7)

**What the bar shows.** It's a thin bar docked at the top of the right panel, always visible in Cue 庫 projects while a look is on stage.
- **No draft:** 「Cue 12「副歌全開」 · 3 首歌在用」 with the button **[另存成新的 cue]**. Pressing it with no changes is a plain copy.
- **With a draft:** 「還沒存的改動：2 個物件、1 個機關」 and the line 「你正在改 Cue 庫的「副歌全開」，會影響 3 首歌」.
  - When only this song uses the cue: 「（只有這首歌在用）」. When no song uses it: 「（沒有歌在用）」.
  - Buttons: **[另存成新的 cue]** (primary), **[更新 Cue 12]** (secondary, outline), **[放棄]** (text).

**What goes into the draft.** Every look edit:
- objects: drag / gizmo, the numeric fields, show / hide, the per-object reset in 物件狀態;
- mechanisms: tab sliders and values, timing in the mechanism tab and the mechanism timeline, the pattern panel (機關花樣);
- 「全部回到預設」 for the look;
- 「套用常用擺位」.

The stage renders the base look with the draft applied. Slot properties (time, transition) are not part of the look, so they save immediately.

**Dialogs.**
- **「另存成新的 cue」:**
  - 編號 — suggested by `suggestNumber(after = base number)`. Errors: 「這個編號已經有了」, 「編號要大於 0，小數最多 3 位」.
  - 名稱 — defaults to the base name.
  - 放在哪裡 — shown only inside a song:
    - ◉ 「換掉這首歌 1:23 的 cue（只有這首歌會變）」 (default)
    - ○ 「加到這首歌的 [1:45]」 (defaults to the video playhead, else 0:00)
    - ○ 「只存進 Cue 庫」
  - [另存] [取消]. The result is one batch (`POST library-cues` with `look` = base + draft and `place`). The new cue becomes the selected one and the draft clears.
- **「更新 Cue 12」:** writes `PUT look` with `ifRev`.
  - A confirm dialog appears when any song other than the current one uses the cue (in the Cue 庫 context: when any song uses it). Title 「更新 Cue 12「副歌全開」？」. Body 「這個 cue 被 3 首歌使用：S01、S04、S07。更新之後，這 3 首歌用到它的地方都會變。只想改這首歌的話，按「另存成新的 cue」。」
  - Buttons [更新 3 首歌] [改成另存新的 cue] [取消].
  - A stale `rev` → 「這個 cue 剛剛被別人改過」 with [重新載入] [另存成新的 cue].
- **Leaving a draft:** switching slot, library cue or song, or leaving the page with a draft open → dialog 「Cue 12 的改動還沒存」 with [另存成新的 cue] [更新 Cue 12] [放棄改動] [取消]. Closing the tab is guarded with `beforeunload`.

**Undo.**
- Draft edits are undoable inside the draft (`EditHistory` scope `draft:<libId>`).
- 更新 is one step in scope `lib:<libId>`: undo = `PUT look` of `previous` with `ifRev`, redo = put again. The step is shared by every song that uses the cue.
- 另存 is one step: undo = re-point / remove the slot, then delete the new library cue.

**Persistence.** The draft is kept in `sessionStorage` keyed by project + library cue as a convenience, wrapped in try/catch.

### 5.2 「Cue 庫」 tab (new `RightTab = 'library'`)

**The list.**
- Top: a search box 「找 cue（編號或名稱）」 and filter chips 「全部 / 沒有歌在用」.
- Rows: number badge, name, and a small 「3 首歌在用」 / 「沒有歌在用」. The row is selected when it's the cue on stage.
- J/K moves by number when this tab is active.
- Empty state: 「Cue 庫還是空的。先把舞台擺好，按「另存成新的 cue」。」

**Selecting a library cue.**
- The stage shows its look (mechanisms move with a 1 s transition, like clicking cues today).
- A header reads 「正在看 Cue 庫：Cue 12「副歌全開」」 with 「用在：S01 0:00、S04 1:23、S07 2:10」. Each usage is a link that jumps to that song and slot.
- There's no video or timeline in this context. Edits go to the draft (5.1).

**Row 「⋯」 menu.**
- 「另存成新的 cue（複製）」
- 「改名稱」, 「改編號」 (inline, validated)
- 「加到這首歌」 (when a song is selected: opens the add-slot dialog prefilled)
- 「存成常用擺位」
- 「全部回到預設」 (a draft op)
- 「刪除」 — disabled with tooltip 「3 首歌在用，先從這些歌拿掉才能刪」. When unused, it asks 「刪除 Cue 12「…」？這個沒辦法復原。」.

**Footer.** [另存成新的 cue] (from the current stage).

### 5.3 「這首歌的 cue」 (replaces the per-song `CueList` in Cue 庫 projects)

- **Rows** are sorted by order, which follows time: time `0:00` (or 「沒有時間」), number badge plus library name, `淡入 1 秒` / `直接切換`, and a small 「3 首歌在用」 when shared.
- **The add button** is **[從 Cue 庫加 cue]**. It opens the dialog 「加 cue」:
  - a searchable library list (number, name, usage);
  - 時間 — default: the video playhead when a video is open, else 0:00. Inline error 「這首歌 0:00 已經有 cue 了」. A checkbox 「不對應影片時間」;
  - 轉場 — default 1 秒;
  - [加進這首歌];
  - shortcuts at the top of the list: 「新的空白 cue」 and 「從目前畫面另存」, both through the 另存 dialog.
- **Row 「⋯」 menu:**
  - 「改時間」, 「改轉場」 (inline; time parsing reuses `CueMetaEditor`'s m:ss.s parsing);
  - 「換成別的 cue」 (library picker);
  - 「複製成新的 cue（只改這首歌）」 — 另存 of this look, then re-point this slot. This is the one-click variant;
  - 「在 Cue 庫裡看」;
  - 「存成常用擺位」;
  - 「拿掉（Cue 庫裡還在）」.
  - 上移 / 下移 appear only for untimed slots.
- **Remove confirm:** when an LED template switch follows the slot, it says 「1:23 有 LED 版型跟著這個 cue 換，拿掉之後那個換版型的點也會一起拿掉。」.
- **Mismatch notice:** when `timedOrderMismatch`, show 「這首歌的 cue 順序跟影片時間對不上；之後改時間或加 cue，會照時間重新排。」 with [現在照時間排].
- **Empty states:** 「這首歌還沒有 cue。從 Cue 庫加一個，整首歌就用那個畫面。」 / (library empty) 「Cue 庫還是空的：先把舞台擺好，按「另存成新的 cue」。」
- **Song 「⋯」 menu:** 「所有 cue 的物件回到預設位置」 stays. Its confirm adds 「其中 2 個 cue 也被別的歌使用（S04、S07），會一起回到預設。」 and keeps the one-step undo from `cueResetAll.ts`.

### 5.4 Editing the stage inside a song

Selecting a slot shows its library cue's look. Every edit goes into the draft. The bar (5.1) states whose look you're changing and how many songs it affects: 「你正在改 Cue 庫的『副歌全開』，會影響 3 首歌」. The mechanism timeline lets you edit timing only for the selected slot's moves; other bars show 「先選這個 cue 才能改」. The 物件狀態 tab's explanations:
- 「這個 cue 設成顯示 / 隱藏」 (own);
- 「沿用（搬進 Cue 庫時從前面的 cue 帶過來的）」 (carried);
- 「這個 cue 沒設定（預設位置）」;
- for default-hidden objects: 「這個 cue 沒設定顯示，預設隱藏」.

The per-object reset reads 「回到預設」, and it's a draft op.

---

## 6. Dependent features

| Feature | Change | Stage |
|---|---|---|
| Mechanism timing / timeline / patterns | Timing lives on library rows (own) and goes through the draft. `useMechanisms` resolves with `mode`. Timeline edits only the selected slot | 3 (read), 6 (draft) |
| Motion | Unchanged code. Carried = inherited semantics (2.2) | 3 |
| LED template switches 「跟著 Cue 走」 | Unchanged: `cue_id` = slot id, time = slot time. Re-pointing a slot keeps the switch. Remove confirm mentions it. Labels show the library name from Stage 8 | 8, 9 |
| Comments / review | Unchanged (slot id). The label shows the current slot's library name | 8 |
| Share link | `slotStates`, positions with `?cuelib=1`, `libraryCue` in cue list | 3, 9 |
| Director (`Preview.tsx`) / workstation (`Studio.tsx`) | No logic change: lists slots, states per slot, J/K by order. Number badge before names | 3 (`?cuelib=1`), 9 |
| AE markers (`aeTimelineScript.ts`, `LedTimelineDialog.tsx`, `ledTemplateTable.ts`) | Switch label = 「Cue 12 副歌全開」 (number + name) | 9 |
| CSV 機關總表 | `mechanismSheet` returns `mode` plus `libraryCue` per slot. New column 「Cue 編號」 after 「Cue」. New section 「Cue 庫」: one line per library cue × mechanism (編號, 名稱, 機關, 位置, 延遲, 走幾秒, 自己設 / 沿用, 用在哪些歌) for console programming | 3 (mode), 9 (columns) |
| Copy / export / import | 4.4 | 4 |
| Reset all cues | 4.2 compat + 5.3 confirm text. Per-look reset is the 「全部回到預設」 draft op | 4, 9 |
| Default hidden | Rule 2.2. `lib/defaultHidden.ts` hint becomes 「Cue 庫的 cue 沒設定顯示的話，這個物件不會出現；要它出現，就在那個 cue 裡把它設成顯示。」 | 9 |
| 常用擺位 | D9: apply into draft, save from a library cue (full look), 「從常用擺位另存成新的 cue」 replaces 「從常用擺位新增」 | 4 (server), 9 (UI) |
| Import cues from another song | 4.2 | 4 |
| Storyboard / diff / PDF | Unchanged logic (states per slot). PDF adds the number | 9 |
| Activity log | 4.5 | 5 |
| Undo | 5.1 scopes | 6 |
| Help page (`pages/Help.tsx`) | New section 「Cue 庫」 (另存、更新、編號、換掉 / 加進這首歌), and the default-hidden text | 9 |

---

## 7. Stages

Every stage ships to master safely. Legacy projects run today's code. Only switched (test) projects see Cue 庫 behaviour until Stage 10. Each stage passes `cd cf-worker && npm test` and `cd web && npm test`, and the new test files are added to `cf-worker/package.json` `test`.

| # | Stage | Contents | Done when | Owner sees |
|---|---|---|---|---|
| 1 | **Schema + pure core** | `0042_cue_library.sql`. `cf-worker/cueLibrary.mjs` (pure: `bakeSlotLook`, `lookKey`, `planProjectMigration`, `resolveLibraryObjectStates`, `resolveSlotMechanisms`, `suggestNumber`, `orderSlots`, `validateLook`). `cf-worker/mechanismTrack.mjs` (port of `track.ts`). Additive `sources` in `buildCueStates` | Fixtures cover every quirk in 1.2 and show bake → resolve == legacy. `web/src/lib/mechanisms/track.parity.test.ts` imports the `.mjs` and compares with `track.ts` on shared fixtures. The FK delete tests from 2.1 pass | Nothing |
| 2 | **Migration script** | `scripts/migrate-cue-library.mjs` + test (fixtures built with legacy routes on `freshDb`, dump → script → apply → verify; run twice → same SQL). Report format | A dry-run on a fresh production export (the coordinator runs it with the owner's OK) reports 0 differences | Nothing (the coordinator relays the report numbers) |
| 3 | **Read path** | `cueLibraryRoutes.mjs` mode helpers; `cueLibrary` on project GET / list; slot states (project + share); song positions with `?cuelib=1` and `mode`; `mechanismSheet` mode; `libraryCueId` / `libraryCue` in the cue list; `loadMechanisms` `cue_count`. Frontend: `mechanismApi` returns `mode`, and a single `resolvePositions(mode, …)` in `track.ts` is used by `useMechanisms` and `cueSheet`; send `?cuelib=1`. Switch a duplicated test project (3.5) | Route tests show legacy vs Cue 庫 outputs equal for every slot; the timeline parity test passes | The test project looks exactly like the original |
| 4 | **Compat writes + copy / export / import** | Everything in the 4.2 compat table, plus 4.4 and the 常用擺位 server side | Route tests for every row of the table; v1 import bakes; a duplicate of a Cue 庫 project equals its source | On the test project the old editor still works. Editing one cue no longer carries forward (intended) |
| 5 | **New library and slot APIs** | 4.1 and the new slot forms (4.2): `orderSlots`, tie check, usage, delete guard, `rev` concurrency, 另存 placement, `cueLibraryApi.ts` client, activity texts | Route tests: 另存 with each placement, re-point, time re-sort, 409s, look PUT atomicity and stale `rev`, permissions (director 403) | Nothing new |
| 6 | **Console editing: draft + 另存 / 更新 bar** (the heart of the owner's workflow) | `web/src/lib/lookDraft.ts` (pure: apply, summary, to-look, `resolveLook` with parity to the backend resolve), `LookDraftBar`, `SaveAsCueDialog`, `UpdateCueDialog`, routing all look writes (`ProjectEditor` object writes, `mechanismApi` value / timing / clear / bulk call sites, reset buttons, patterns, timeline) through the draft in Cue 庫 projects; undo scopes; leave guard | Vitest for the draft ops; a manual / CLI UX audit on the test project (memory rule: run the end-to-end UX review) | On the test project: edits go to 「還沒存的改動」; 另存 / 更新 / 放棄 work, with the impact warning |
| 7 | **「Cue 庫」 tab** | 5.2 (list by number, search, filter, preview, 另存 / 複製, rename, renumber with `suggestNumber`, usage links, delete guard, 全部回到預設, J/K by number) | UX audit | The library list. Building presets in the library first, then using them in songs, works end to end with Stage 8 |
| 8 | **「這首歌的 cue」** | 5.3: add dialog, re-point, time edit with re-sort, remove, untimed handling, mismatch notice, 「複製成新的 cue（只改這首歌）」. The API `name` switches to the library name (4.2) | UX audit, J/K check | The new per-song list: pick a library cue at a time |
| 9 | **Dependents polish** | Number badges on director / workstation / share; AE labels; CSV column and section; PDF; help page; default-hidden texts; 常用擺位 UI (apply into draft); reset-all confirm text; delete-song text | Tests for the CSV and AE strings | Consistent names and numbers everywhere |
| 10 | **Cutover** | Release-checklist section (3.5), the `cue_library_new_projects` switch, run the runbook | Verification 0 differences on production; spot checks | All projects use Cue 庫 |
| 11 | (later, optional) **Retire legacy** | After at least two weeks of stable operation: remove the legacy branches and the `?cuelib` fallback; keep the old tables until the owner agrees to drop them | — | Nothing |

Stage 3 is the largest backend stage. If it runs long, split it into 3a (server) and 3b (frontend `resolvePositions`). Stages 6–8 may ship in any order after 5. Recommended order: 6 → 7 → 8. The 另存 flow arrives first, inside the existing per-song list (另存 re-points the selected slot by default).

---

## 8. Risks

1. **No more carry-forward.** In a Cue 庫 project, changing cue 1 no longer flows into cue 2; each cue is its own look. This is inherent to D1–D3, and Stage 4 makes it visible on the test project. Mitigation: say it plainly in the help page and in the owner summary. A later 「一起改：其他有一樣設定的 cue」 tool is possible (open question 2).
2. **Accidental edits to shared looks.** Mitigation: the draft model, the impact dialog, one-step undo, and `rev` concurrency.
3. **Migration mismatch** from the quirks (whole-row tracking, ties, default-hidden "latest explicit", invalid JSON fallbacks, proposals). Mitigation: bake from the legacy resolvers' output (not a re-implementation), run the real code on SQLite, and gate on zero differences.
4. **Motion differences.** Mitigation: the `carried` flag reproduces own vs inherited; the parity test on `buildMechanismTimeline`.
5. **Dual-mode complexity.** Mitigation: one branching module; legacy code untouched; retire in Stage 11.
6. **Stale frontends after cutover.** Mitigation: same routes and shapes, the `?cuelib=1` capability, additive fields only.
7. **Edits during the cutover window.** Mitigation: a 15-minute no-edit window, post-apply verification against a fresh export, `--rebake` immediately if drift is found.
8. **D1 limits and partial file execution.** Mitigation: ≤ 50 rows per INSERT, idempotent per-project blocks, verify after apply, re-run on failure.
9. **Library bloat** (one cue per old cue). Mitigation: merging identical cues, the 「沒有歌在用」 filter, renumbering; a later 「合併相同的 cue」 helper.
10. **FK behaviour.** A used library cue can't be deleted (the app checks first); project hard-delete still works (tested in Stage 1).

## 9. Test plan

- **Pure (`cf-worker`, node --test):** bake/resolve equality fixtures:
  - whole-row null quirk;
  - order ties;
  - default-hidden latest-explicit;
  - snapshot `visible = 1`;
  - own row with all fields NULL;
  - proposals (objects track through them, mechanisms don't);
  - clamped stored values;
  - carried timing rejection;
  - `lookKey` merging rules;
  - `suggestNumber` table;
  - `orderSlots` with untimed slots and ties.
- **Parity (web vitest):** `track.ts` vs `mechanismTrack.mjs`; `lookDraft.resolveLook` vs `cueLibrary.mjs` resolve; `buildMechanismTimeline` on legacy-resolved vs library-resolved inputs; `suggestNumber` / `orderSlots` web vs worker.
- **Routes (`testing/d1-sqlite.mjs` + `worker.fetch`):**
  - the legacy project is unchanged (the existing suites stay green);
  - Cue 庫 project read equality;
  - every compat row of 4.2;
  - the new API including 409s, `rev`, and permissions (`member` read / `editor` write / share read-only);
  - copy / export / import v1 and v2;
  - import-cues across projects;
  - project hard delete.
- **Migration script:** fixtures → SQL → apply on a fresh SQLite with all migrations → verify; idempotent re-run; `--revert`; a run on a real production export (Stage 2 and Stage 10).
- **UX audit** (Stages 6–9) on the test project: the console flow (move things → 另存 → it appears in the song and the library), the shared-cue warning, undo after 更新, leaving with a draft, J/K in both lists, and the director / share pages unchanged.

## 10. Owner decisions (2026-10-22) — these OVERRIDE anything above that disagrees

1. **Snapshot only, no carry-forward (confirmed).** 用戶原話：「cue 庫設定的東西就是要按照我的 cue 庫走，沒有沿用這種東西。要沿用，就是新的 cue，一種造型就是一個 cue。」 Risk 8.1 is accepted as intended. Do NOT build a 「一起改」 tool.
2. **Cue numbers are free text the user types, not decimals.** This replaces D8, 2.4 and the `number REAL` column:
   - Column `label TEXT NOT NULL` (instead of `number REAL`), unique per project after trim + case-insensitive compare. Any non-empty text up to 16 characters: 「12」「3-1」「301」「2.5」「A」 are all fine. Errors: 「編號不能空白」「這個編號已經有了」「編號最多 16 個字」.
   - Sorting: natural sort (split into digit / non-digit runs, compare digit runs numerically): 1, 2, 2.5, 3, 3-1, 12, 301. Ties → creation order.
   - `suggestLabel(existing)` = (largest leading integer among labels) + 1, as text; "1" when empty. It is only a pre-filled suggestion; the user can type anything (3-1, 301, a new last number). No between-numbers logic, no 「中間沒有空的編號」 message.
   - In sentences: 「Cue 12「副歌全開」」 stays, using the label.
   - Migration: number library cues 1, 2, 3… in setlist order (song order, then cue order within each song).
3. **Songs reference library cues in any order** (e.g. Cue 17 at 0:00, then Cue 1). Slot order is by time, never by library label.
4. **Prompt when the stage was changed.** In a song, when the user switches to another cue, another song, or leaves the editor while 「還沒存的改動」 exists, ask: 「這個 cue 動到了，要另存成新的 cue 嗎？」 with 「另存成新的 cue」(opens the dialog with editable 編號 + 名稱, pre-filled with `suggestLabel` and the base name) / 「更新 Cue X」 (with the 「會影響 N 首歌」 line when shared) / 「放棄改動」 / 「取消」. The draft bar itself stays as designed in 5.1.
