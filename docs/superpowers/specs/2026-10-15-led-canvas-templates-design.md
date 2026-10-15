# LED 畫布版型 (LED canvas templates) — design

Date: 2026-10-15. Approved by the owner on 2026-10-15 (see `HANDOFF.md`, 「已核准、排隊中：LED 畫布版型」). Like a disguise / d3 feed map.
This document covers the whole feature and says which part ships when. **Part 1a (this document's "built now" items) is implemented on `feat/live-stage-look`, migration 0034.** **Part 1b (visual editor, section 6a below) is implemented on the same branch, no backend change.** Parts 2, 3 are designed here, built later.

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
| **1b editor** | Visual drag-and-drop editor (section 6a); 3D live test pattern with screen names while editing; **download template PNG**; **duplicate template**; manual split by drawing rectangles on the full canvas. | built (no backend change) |
| **2 AE live / coordinate sheet** | NDI live (AE → helper → browser) honours the song template (the helper sends the template canvas; the shader remap applies to the NDI texture); export a **coordinate CSV** (screen, native rect, template rect, rotation, flip) for LED engineers / d3. | later |
| **3 switch mid-song** | A song may change template at a cue. Needs a per-cue template choice and a time-based plan switch in the player. | later |

### 6a. Part 1b: the visual editor (built)

Shown only to 製作 (`RequireAdmin` page + `user.role === 'admin'`). On a phone (<= 640 px) the 「版型」 button opens a notice 「請用電腦編輯版型」 instead. iPad landscape (1180) works; below 900 px the panel overlays the page.

**Where.** 編輯專案 → top bar 「版型」 opens a docked panel **under** the page body (`LedTemplatesDialog.tsx`, a flex child of `.editor`, `clamp(380px, 52dvh, 640px)`), so the 3D view shrinks instead of being covered and stays visible while editing. Header: template picker, 「新增版型」, 「複製版型」, 「下載模板圖」, 「刪除版型」, 「儲存」, close. Left: name / canvas size / scale / 「畫布剛好包住螢幕」 + a switch 「版型畫布」 / 「整張畫布（切螢幕）」 and the canvas. Right: the screen list (every screen, 「加入版型」 / 「拿掉」, 「實際 W×H → 這個版型 w×h」) and, for the selected screen, numeric fields (left, top, width, height, rotation, flips, 「標準大小」) that are two-way bound to the canvas.

**Template canvas** (`LedTemplateCanvas.tsx`, maths in `lib/ledTemplateEdit.ts`):
- Each placed screen is a labelled rectangle (name + 「實際 W×H → 這個版型 w×h」, a small arrow for the screen's up direction, tags for rotation / flips / stretched). Drag to move (3 px slop), four corner handles to resize (Shift keeps the aspect ratio), arrow keys nudge 1 px (Shift 10), Delete removes, Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) undo / redo (100 steps; a drag is one step; fast nudges and typing in one field coalesce).
- Snap: positions are always whole pixels. Edges snap to the canvas edges and to every other screen's edges within 8 screen px (`SNAP_SCREEN_PX / zoom` in canvas px). Alt turns the edge snapping off (still whole pixels); guide lines show what it snapped to.
- Overlap or outside the canvas = red outline (+ a red tag and the warning list under the canvas); the 1a `checkPlacements` warnings (stretch) stay. Nothing is forbidden.
- 「轉 90°」 turns the selection clockwise and swaps width / height around the centre; 「左右翻轉」 / 「上下翻轉」 toggle the flips (turn first, then flip, same as the shader).
- Zoom and pan: wheel zooms around the cursor, Shift + wheel / drag on empty space / middle button pans, two fingers pinch + pan on touch, buttons + 「符合畫面」 (fit).
- 「加入版型」 places the screen at native size × template scale in the first free spot (top-to-bottom, left-to-right; if nothing fits, below everything, shown red).

**Splitting** (`LedSplitCanvas.tsx`): on the full canvas the owner drags a rectangle (snaps to other screens' edges, Alt = no snap); a form appears (which LED object — guessed from the biggest overlap —, a name, numeric left / top / width / height) and 「切開」 calls the 1a `POST /led-screens` with the UV box. Existing objects are light frames (dashed once split), splits are solid; 「刪掉」 in the screen list calls the 1a delete.

**Live test pattern.** While the panel is open the dock publishes `{ plan, defs }` (throttled to every 0.1 s) to `ProjectEditor`, which draws a canvas (`lib/useLedPatternCanvas.ts`, `lib/ledTemplateDraw.ts` `drawTemplatePattern`, at most 4096 px per side / 6 M px) and hands it to `StageScene` as `ledPreviewCanvas` + `ledPreviewVersion` together with the draft plan as `ledTemplate`. `StageScene` wraps the canvas in a `CanvasTexture` that takes the same slot as the video texture (`ledMediaTextureRef`), so the 3D uses the exact same template mapping path (`buildObjectUniforms` -> `uLedTplOn`); the preview texture wins over test pattern / per-object image / video while the panel is open. It never goes through the video colour path (`needsVideoSrgbDecode` only looks at `VideoTexture`; the video / image branch of the effect is untouched). Each screen is filled with its own colour (`panelHue(index)`), and drawn in **its own orientation** (matrix `localMatrix` = local native pixels -> template pixels), so a rotated or flipped screen is sideways / mirrored in the template image and upright on the stage: name, 「實際 W×H」, 「版型 w×h」, an up arrow, a 1-LED-pixel grid (every 100 / 50 / 10 native px) and a white triangle in the top-left corner (a mirrored screen shows it elsewhere). A wrong placement or rotation is obvious on the stage. Screens not in the template stay black.

**Reference layers on the template canvas** (`lib/ledTemplateContent.ts`, `lib/ledTemplateContentDraw.ts`, `lib/ledTemplateBackdrop*.ts`, `components/LedTemplateLayers.tsx`). Both are editing aids only: nothing is saved to the template, nothing reaches the backend, the LED shader and the video colour path are untouched.
- **對位圖內容 (default on).** Each screen box shows its region of the full-canvas test pattern (`drawTestPattern`, the same picture the 3D LEDs show without a video: name, x y w h, 100 px grid, colour bars, corner marks). The full map is rendered once (`useLedFullMap`, at most 4096 px per side / 8 M px) and kept; a drag / zoom / pan only blits crops of it onto one `<canvas>` under the DOM boxes. The crop and transform are `contentPieces(span, fullCanvas, placement)`: the screen's span on the full canvas (up to 4 pieces when it wraps over the UV seam) and the matrix `full-canvas px -> local (uvToLocal) -> A·l + b (localTransform) -> dest rect`, i.e. exactly `mapUvToTemplate`. Tests prove it for all 4 rotations x 4 flip combinations (point-by-point against `mapUvToTemplate`, plus a software raster round trip where each LED pixel reads back its own value) and for spans that wrap one or both seams. The layout (which panel is where) is rebuilt from the per-object spans the editor already gets from the 3D view (`layoutFromSpans`), so `StageScene` is not touched; non-rectangular LEDs are drawn as their bounding rectangle. If the scene never provides spans (no model) the whole canvas is one pattern, like the 3D placeholder. Box labels (name, size, arrow) get a semi-transparent backing while the content is on.
- **底圖 (reference image).** 「載入底圖…」 takes a local PNG / JPG / WebP (<= 80 MB, <= 16384 px per side). It is drawn behind everything, clipped to the template canvas, with an opacity slider (default 50%) and a show / hide toggle. If its pixel size differs from the template canvas the bar asks 「照畫布大小拉伸」 (default) or 「照原尺寸放左上」. Stored only in this browser (IndexedDB database `sp-led-template-backdrop`, key `projectId:templateId`, blob + file name + fit / opacity / visible; every access is wrapped in try/catch and falls back to memory only). A brand-new unsaved template uses the key `projectId:__new__` and the image is moved to the real id after the first save; deleting a template removes its image. The UI says 「底圖只存在這台電腦，不會上傳」.

**Template PNG** (`renderTemplateGuidePng`, 「下載模板圖」): template canvas size, dark background, 100 / 500 px grid, per screen: tinted rectangle, name, 「w×h 像素」, position, 「上方朝右」 etc., and an arrow along the screen's up direction (text always upright), plus a legend box. File name `LED版型圖-專案-版型-WxH.png`. Uses a normal canvas with `exportScales` fallbacks; if the browser cannot allocate the full size the PNG is scaled down, the file name gets `-縮小N%` and a toast says how to scale the layer back in AE; if even the smallest fails, an error toast.

**Duplicate** (「複製版型」): asks for a name in the in-page prompt (default 「名稱 複本」, unique, case-insensitive), then creates the copy from what is on screen (unsaved edits included) and selects it.

Pure logic with tests: `lib/ledTemplateEdit.ts` (+ `.test.ts`), `lib/ledTemplateDraft.ts` (+ `.test.ts`), `lib/ledTemplatePattern.ts` (+ `.test.ts`), `lib/ledTemplateContent.ts` (+ `.test.ts`), `lib/ledTemplateBackdrop.ts` (+ `.test.ts`). No backend change.

## 7. Tests

- `cf-worker/ledTemplates.test.mjs`: 0034 on old data (backfill, old INSERTs still work, CHECKs), CRUD + validation, 製作-only writes / member reads / director 403, 全部 read-only, songs' selector, version snapshot frozen when the template is edited later, share video carries `template`, delete refused while in use, duplicate project copies.
- `web/src/lib/ledTemplate.test.ts`: rotate/flip table (all 8 orientations), wrap-aware source span, uncovered fragment → black, scale detection (exact / 50% / 1 px rounding / aspect mismatch), screen list (auto vs manual), template checks (overlap, outside canvas, stretch), Chinese messages.
- Shader: `ledSurface.test.ts` keeps proving the old path; a new test compares the GLSL remap against `mapUvToTemplate` through a JS port of the same expressions; `web/scripts/led-color-accuracy.mjs` before / after must be identical for the 全部 template.
- Guard tests (emoji, native dialogs, English role words) cover the new UI files.
