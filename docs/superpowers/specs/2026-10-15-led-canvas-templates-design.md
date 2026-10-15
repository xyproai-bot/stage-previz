# LED 畫布版型 (LED canvas templates) — design

Date: 2026-10-15. Approved by the owner on 2026-10-15 (see `HANDOFF.md`, 「已核准、排隊中：LED 畫布版型」). Like a disguise / d3 feed map.
This document covers the whole feature and says which part ships when. **Part 1a (this document's "built now" items) is implemented on `feat/live-stage-look`, migration 0034.** Part 1b (visual editor) and parts 2, 3 are designed here, built later.

UI strings are quoted exactly as they ship. Traditional Chinese, no emoji (icons via `Icon` + lucide), in-page dialogs only, no English role words (guard tests in `web/src/test/`).

## 0. Problem and decisions

A show with many LED surfaces is delivered as one huge canvas (e.g. 10496 × 5120). The animator often only needs to make one strip (e.g. the centre ground strip) but must still render the whole canvas. A template says "this song only needs these screens, packed into this smaller canvas", and the 3D preview puts the pictures back on the right surfaces.

| # | Decision | Why |
|---|---|---|
| 1 | The **全部 template** (today's full canvas, = `projects.led_canvas`) defines every screen's true native pixel count. It is auto-created for every project and cannot be edited or deleted. | Old videos and old projects keep playing exactly as now. |
| 2 | A screen's source region is always **in the full canvas** (UV space). A template only says where each chosen screen is **placed in the template canvas** (pixels), with optional 90° rotation and flip. | One mapping model; works for any video size. |
| 3 | Screens not in the template show **black**. | Matches an LED wall that receives no signal. |
| 4 | Each song picks one template (`songs.template_id`). Each video version records the template it was made for **and a snapshot of its layout** (`song_videos.template_id`, `template_snapshot`). | 「版型改了，舊影片照舊貼對」: editing a template never moves old videos. The snapshot also means playback and share links need no extra request. |
| 5 | The LED pixel grid always uses the **native** pixel counts (full canvas), never the video size. | A half-size video upscaled onto the wall must still show the real LED dots. |
| 6 | No table is rebuilt or dropped. Migration 0034 only adds tables, columns and indexes. | Standing rule. |
| 7 | Colour is never touched. With the 全部 template (or no template) the shader takes the old path, bit for bit. | LED colour fidelity is a hard requirement (`feedback_led_color_fidelity`). |

## 1. Data model (migration 0034)

```sql
CREATE TABLE led_templates (
  id TEXT PRIMARY KEY,                        -- 'lt_' + random
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                         -- unique per project (case-insensitive)
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('full','custom')),
  canvas_w INTEGER, canvas_h INTEGER,         -- template canvas in pixels (= the video AE should render); NULL for 'full' (follows projects.led_canvas)
  scale_pct REAL NOT NULL DEFAULT 100,        -- 100 / 50 / custom (1~400). native -> template size factor, see section 3
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT, updated_at TEXT
);                                            -- one 'full' row per project (partial unique index)
CREATE TABLE led_screens (                    -- manual splits only: one mesh holding several screens
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,                    -- stage_objects.id (no FK: orphans are ignored)
  name TEXT NOT NULL, u0 REAL, v0 REAL, u1 REAL, v1 REAL,   -- full-canvas UV fractions, 0 <= u0 < u1 <= 1
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT
);
CREATE TABLE led_template_screens (           -- a screen's placement in one template
  template_id TEXT NOT NULL REFERENCES led_templates(id) ON DELETE CASCADE,
  screen_key TEXT NOT NULL,                   -- 'o:<stage object id>' (auto) | 's:<led_screens.id>' (manual)
  dest_x INTEGER NOT NULL, dest_y INTEGER NOT NULL, dest_w INTEGER NOT NULL, dest_h INTEGER NOT NULL,   -- template canvas pixels
  rotate INTEGER NOT NULL DEFAULT 0 CHECK (rotate IN (0,90,180,270)),
  flip_h INTEGER NOT NULL DEFAULT 0, flip_v INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, screen_key)
);
ALTER TABLE songs ADD COLUMN template_id TEXT REFERENCES led_templates(id) ON DELETE SET NULL;  -- NULL = 全部
ALTER TABLE song_videos ADD COLUMN template_id TEXT;        -- no FK on purpose: the snapshot below is self-contained
ALTER TABLE song_videos ADD COLUMN template_snapshot TEXT;  -- JSON plan (section 4), NULL = full canvas (all old versions)
```
Backfill: one 'full' row for every existing project; also created lazily on first read/create so a project made by an older backend still gets one. Deleting a template that songs use is refused (409, which songs); versions never block it (their snapshot is self-contained).

**Plan JSON** (the snapshot, and what the renderer consumes):
```json
{ "v": 1, "id": "lt_x", "name": "中間底幕", "canvas": {"width":4400,"height":1012}, "scalePct": 50,
  "screens": [ { "key":"o:so_1", "objectId":"so_1", "uv":null,
                 "dest":{"x":0,"y":0,"w":4400,"h":200}, "rotate":0, "flipH":false, "flipV":false } ] }
```
`uv` is `[u0,v0,u1,v1]` for a manual screen (`s:` key), `null` for an auto screen (computed from the model).

## 2. Screens (what can be placed)

- **Auto screen** = every LED object (`category === 'led_panel'` stage object that is a GLB mesh root, found with `ledModelRoots` / `computeLedLayout`). Its source region is the **UV bounding box in the full canvas**, computed with the existing wrap-aware `layoutPanel` (`lib/ledMap.ts`; the LED textures use RepeatWrapping and many C4D exports have `v` in [-0.8,-0.45], so spans are `{start in [0,1), length <= 1}` and may straddle the 0/1 seam). Pixel size = span × full canvas, rounded like `spanToPixels`.
- **Manual screen** = a rectangle drawn on the full canvas and tied to one object (`led_screens`), for a mesh that holds several screens. When an object has at least one manual screen, its whole-object auto screen is no longer offered; UV area outside every manual rectangle of that object is black in any template.
- Stand-in LED boxes (no model UV) use the whole canvas as their region.
- The list shown to the user: name = the object's display name (or the manual screen's name), 「實際 W×H」 native size, and in a template 「→ 這個版型 w×h」.

## 3. Mapping math

Everything is in the video texture's UV space: origin top-left, `v` down, `flipY=false` (same as every LED texture today).

For a screen with source spans `(us, ul, vs, vl)` (start/length) and placement `(x,y,w,h, rot, fh, fv)` in a template canvas `(CW, CH)`, and a mesh fragment with UV `(u,v)`:
1. wrap: `du = mod(u - us, 1)`, `dv = mod(v - vs, 1)`; the fragment belongs to the screen iff `du <= ul + ε` and `dv <= vl + ε` (ε = 1e-5). `lx = clamp(du/ul,0,1)`, `ly = clamp(dv/vl,0,1)`.
2. rotate clockwise as seen on the template canvas: 0: `(lx,ly)`; 90: `(1-ly, lx)`; 180: `(1-lx, 1-ly)`; 270: `(ly, 1-lx)`. Then flip in the destination: `fh`: `x' = 1-x`; `fv`: `y' = 1-y`.
3. sample at `((x + x'·w) / CW, (y + y'·h) / CH)`, pulled in by half a template pixel so bilinear filtering does not read the neighbouring placement.
4. If no placed screen of that object contains the fragment: emissive colour = 0 (black). Screens that are not in the template have no entry → black.

`w×h` is the final bounding rectangle (already swapped for 90/270). Scale: `scalePct` is the factor from native pixels to this template's pixels (50 → every screen is half size); it only drives defaults and the 「實際 W×H → w×h」 label and the over/under-stretch hint. The canvas size is what AE must render. Placements are free (the owner drags them; a placement whose size is not `native × scale` is just stretched, and the editor marks it).

Everything is a pure function (`web/src/lib/ledTemplate.ts`: `placementToUniform`, `mapUvToTemplate`, `compareVideoToTemplate`, `buildScreenList`, `checkTemplate`) with vitest tests. The shader (`lib/stageLook/ledTemplate.ts` GLSL string, spliced into `ledSurface.ts`) is the same math. Up to 8 screens per mesh in a uniform array; one auto screen per object is the common case.

**Pixel grid / colour:** the grid code keeps reading the original mesh UV with `uLedTexels` = native counts (full canvas). Only the colour sample UV is remapped, and only when `uLedTplOn = 1` (a non-full template is active for the media texture). With `uLedTplOn = 0` the old `texture2D(emissiveMap, vEmissiveMapUv)` line runs unchanged. The test pattern, per-object images and AE live (NDI) textures are full-canvas content and are never remapped in 1a. The ambient LED light colours (live mode) sample through the same mapping.

**Upload check (`compareVideoToTemplate(video, canvas)`):** exact size → ok, no message. Same aspect and one uniform factor `k` (|vw − cw·k| and |vh − ch·k| within 1 px) → accepted, labelled with the percentage (「影片是版型的 50%（2200×506），會自動放大貼回，LED 像素格照真實點數畫」, no warning). Aspect differs → warning 「影片 A×B 跟版型「名稱」的 C×D 比例不一樣：畫面會變形，請用 C×D 輸出」. The label is also shown on the version row (「版型「名稱」· 影片是版型的 50%」). For the 全部 template the existing 「比較糊 / 比較大 / 變形」 wording is kept.

## 4. API (`docs/led-templates-api.md` has the full list)

All under `/api/projects/:id`. Read = project member; write = 製作 (`editor`).

| Route | Notes |
|---|---|
| `GET /led-templates` | `{ fullCanvas, templates: [plan + id/kind/sort/songCount], screens: [manual splits] }`. The 全部 template is always first. Share links do not need it (their videos carry `template`). |
| `POST /led-templates` | `{ name, canvas, scalePct, screens[] }`. Needs the project's LED canvas to be set. |
| `PATCH /led-templates/:tid` | any of `name`, `canvas`, `scalePct`, `screens` (replaces the whole placement list). 全部 is read-only. |
| `DELETE /led-templates/:tid` | 409 if songs use it. |
| `POST/PATCH/DELETE /led-screens[/:sid]` | manual splits. |
| `PATCH /songs/:sid` `{ template_id }` | 製作; template must belong to the project; `null` or the 全部 id = full canvas. `GET /songs` returns `templateId`. |
| `POST /songs/:sid/videos/uploads` | optional `templateId`; default = the song's template now (the 1a frontend does not send it). Link / Drive versions take the song's template at creation. Version JSON gets `templateId` and `template` (plan or `null`); share video JSON gets `template`. |

Validation: name 1–40 chars unique per project; canvas 16–32768 each; scalePct 1–400; placements inside the canvas, integers, one per screen; rotate in {0,90,180,270}. Overlap / out-of-canvas are **allowed by the API** (the editor draws them red; owner rule: warn, do not forbid).

## 5. Compatibility

Production `master` (old frontend) is older than this branch.
- Additive only: the old frontend never sends `template_id` / `templateId` and ignores the new JSON fields. Its uploads get the song's template on the server.
- An old frontend plays any version as a full-canvas video. If the owner assigns a custom template while the old frontend is still live, those versions will look wrong there. So: roll the new frontend out to production before using custom templates. The 全部 template changes nothing for anyone.
- Old versions (`template_snapshot` NULL) and songs (`template_id` NULL) behave as 全部.
- Old backend + new frontend: `GET /led-templates` 404s; the frontend treats that as "no templates" (selector hidden).
- Duplicating a project copies templates, splits and each song's choice; export / import carries them (`ledTemplates`); old export files import without them.

## 6. Parts

| Part | Content | Status |
|---|---|---|
| **1a core** | This spec; migration 0034; API + permissions + share/version fields; pure logic + tests; shader remap (colour unchanged); numeric template form (name, canvas, scale, per-screen x/y/w/h/rotation/flip, manual splits by pixel rectangle) in the 「LED 版型」 dialog (`LedTemplatesDialog.tsx`, opened from the 編輯專案 top bar button 「版型」); per-song selector 「LED 版型」 on the 歌單 (shown once a custom template exists); upload resolution check; version label. Screen UV spans for the form come from the 3D view (`StageSceneQuery.ledSpans()`). | built |
| **1b editor** | Visual drag-and-drop editor on the full canvas (drag, resize, rotate 90°, flip, type numbers, snap to pixel grid and neighbouring edges, red frame for overlap / out of canvas, draw manual splits); 3D live test pattern with screen names while editing; **download template PNG** (name + pixels, for AE); **duplicate template**. | later |
| **2 AE live / coordinate sheet** | NDI live (AE → helper → browser) honours the song template (the helper sends the template canvas; the shader remap applies to the NDI texture); export a **coordinate CSV** (screen, native rect, template rect, rotation, flip) for LED engineers / d3. | later |
| **3 switch mid-song** | A song may change template at a cue. Needs a per-cue template choice and a time-based plan switch in the player. | later |

## 7. Tests

- `cf-worker/ledTemplates.test.mjs`: 0034 on old data (backfill, old INSERTs still work, CHECKs), CRUD + validation, 製作-only writes / member reads / director 403, 全部 read-only, songs' selector, version snapshot frozen when the template is edited later, share video carries `template`, delete refused while in use, duplicate project copies.
- `web/src/lib/ledTemplate.test.ts`: rotate/flip table (all 8 orientations), wrap-aware source span, uncovered fragment → black, scale detection (exact / 50% / 1 px rounding / aspect mismatch), screen list (auto vs manual), template checks (overlap, outside canvas, stretch), Chinese messages.
- Shader: `ledSurface.test.ts` keeps proving the old path; a new test compares the GLSL remap against `mapUvToTemplate` through a JS port of the same expressions; `web/scripts/led-color-accuracy.mjs` before / after must be identical for the 全部 template.
- Guard tests (emoji, native dialogs, English role words) cover the new UI files.
