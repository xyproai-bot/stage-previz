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

**Pixel grid / colour:** the grid code keeps reading the original mesh UV with `uLedTexels` = native counts (full canvas). Only the colour sample UV is remapped, and only when `uLedTplOn = 1` (a non-full template is active for the media texture). With `uLedTplOn = 0` the old `texture2D(emissiveMap, vEmissiveMapUv)` line runs unchanged. The test pattern and per-object images are full-canvas content and are never remapped. (In 1a the AE live (NDI) texture was also never remapped; since part 2a, section 6b, it follows the song's template like a local file.) The ambient LED light colours (live mode) sample through the same mapping.

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
| **2a live sources** | NDI live (AE → helper → browser) and local files honour the song's current template (section 6b). The shader is unchanged: the same remap now applies to the NDI texture. | built (no backend change) |
| **2b coordinate sheet** | Export a **coordinate CSV** (screen, native rect, template rect, rotation, flip) for LED engineers / d3. | later |
| **3 switch mid-song** | A song may change template at a cue or a time (section 6d). One video file, its pixel layout switches at the given times. Migration 0039, no change to the colour path. | built |

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

### 6b. Part 2a: AE live and local files follow the song's template (built)

Reported by the owner: song S02 was set to 「版型 1」, but the LEDs still mapped his local 1920×1080 file as the whole canvas (「怎麼沒有更新？」). Before this part only an uploaded version used a template (its snapshot); a local file and AE live were always the full canvas.

**Which plan applies** (pure, `web/src/lib/ledLiveTemplate.ts` `chooseLedTemplate`, one answer per LED source):

| Situation | Plan given to `StageScene.ledTemplate` |
|---|---|
| Editor with the 版型 panel open (the test-pattern preview) | the panel's plan, over everything (also over 「暫時用整張畫布看」) |
| Uploaded version | that version's own snapshot, as before; a version without a snapshot is the full canvas even if the song picked a template later |
| AE live, local file (video or image) | the song's **current** template, looked up by `songs.template_id` in the project template list (`useLedTemplates`). 「全部」, no template, a deleted template and a list that is not loaded yet are all the full canvas |
| 「暫時用整張畫布看」 on | the full canvas, for AE live / local files only (session state of the page, never saved; it resets when the song changes) |

Pages: the editor (AE live only, it has no source switch), the animator workstation (version / AE live / local file). The director page only plays versions, so it is unchanged. The share page does have AE live and local files, but its public data has neither the song's template id nor the template list (a guest cannot call `/led-templates`), so it stays full canvas until the share bundle carries the song's template plan (that needs a backend change, not done here).

**StageScene:** the remap condition changed from 「the texture is the media texture」 to 「the media texture or the NDI texture」; the test pattern and per-object images still never remap. The shader is not touched. A new callback `onNdiFrameSize` reports the received AE frame size (only on the first frame and when the size changes), used by the check below.

**Pixel grid density:** the grid always uses the full canvas' native counts (`projectCanvas`), the same as the media texture. For AE live with a template the received frame is the *template* canvas (e.g. 1920×1080 against a 8800×2024 wall), so the old rule in `ndiLedTexels` (frame shape == project canvas shape, else frame × helper downscale) would have given a wrong density; with a template active the native counts are used directly. With no template the code path is the old one, bit for bit (`led-color-accuracy.mjs` before / after identical).

**Colour:** unchanged. AE live's colour curve (`ndiColor` / `uLedColorLut`) is applied after the remapped sample in the same shader line, so it follows the template with no change. With no template the old sample runs.

**Status chip** 「LED 版型：版型 1（1920×1080）」 / 「LED 版型：全部」 (`components/LedTemplateChip.tsx`, label from `ledTemplateChip`): in the workstation it sits in the LED source row next to the help link; in the editor it is a slim bar 「AE 即時」 above the 3D view. It only appears when the project has at least one custom template or the picture uses one. For AE live / local files it carries the toggle 「暫時用整張畫布看」 (shown as 「LED 版型：全部（暫時）」 while on).

**Size check for live sources** (`liveSourceHint`; reuses the 1a rule `compareVideoToTemplate`): exact size or a uniform scale of the template canvas is fine (no message). If the file / frame is the size of the full canvas instead, a gentle hint: 「這個檔案是整張畫布的大小，但這首歌用的是「版型 1」…」 (offers 「暫時用整張畫布看」); if it matches another template's size, it asks whether the song picked the wrong template; if the shape fits nothing, it says the picture will be stretched. AE frames are compared loosely (aspect within 3%, like `ndiLedTexels`) because Half / Third and the helper's downscale do not round to 1 px. Only shown while a template is actually applied (not for the full canvas, a version, the temporary full view or the 版型 panel preview).

### 6c. AE composition script and coordinate table per template (built)

Everything is client-side; no backend change.

- **Template editor header**: next to 「下載模板圖」 there are 「下載 AE 合成腳本」 and 「下載座標表」 (small menu: CSV / JSON). They export what is on screen (including unsaved edits), like 「下載模板圖」.
- **AE script** (`lib/aeTemplateScript.ts`; it shares the ES3 runner pieces with `lib/aeCompScript.ts`: `RUNNER_COMMON` = duration prompt, base64 image file writer, guide-layer helpers, outline shape builder; the full-canvas script is `RUNNER_COMMON + RUNNER_COMP`, the template script `RUNNER_COMMON + RUNNER_TEMPLATE`). Running it in AE creates a comp of the template canvas size (square pixels, 30 fps unless a frame rate is passed, duration asked like the full-canvas script with default 3:00) named `<project> - <template> WxH`, in a folder `Stage Previz LED 版型`, with one locked guide-layer rectangle per screen (layer comment = position, size, up direction, rotation, flips, native size) and the template guide PNG (same drawing as 「下載模板圖」, embedded as base64 and written next to the .jsx, capped at 4096 px on the long side and scaled back up by the script) as the bottom locked guide layer. Chinese strings are written as `\uXXXX` and the file starts with a BOM. There is no project frame-rate field yet, so the download passes none (30).
- **Coordinate table** (`lib/ledTemplateTable.ts`): CSV (BOM, CRLF) and JSON. One row per screen: 名稱, 版型 x / y / w / h, 轉向 (0 / 90 / 180 / 270, clockwise), 左右翻, 上下翻, 實際點數 W×H, 比例 % (橫 / 直 when stretched), the screen's rect on the full canvas (x y w h), 備註 (被拉伸 / 超出版型畫布 / 和別塊重疊 / crosses the full-canvas seam). The first line has the template name, canvas size, scale, project, full-canvas size and date; the second line explains the coordinates.
- **3D toolbar 「⋯」 → LED 對位圖**: when the current song uses a custom template (pages that load the template list: the editor and the workstation, prop `ledSongTemplate`), the four downloads exist twice: 「…（版型 1）」 first (template guide PNG, template AE script, coordinate table CSV / JSON), then 「…（整張畫布）」 (the old ones). Without a custom template the section is unchanged (`lib/ledMapMenuText.ts` has the labels). The director page and share links do not load the template list, so they keep only the full-canvas downloads.

### 6d. Part 3: switch template mid-song (built, migration 0039)

Why: LED shapes change during a song (mechanisms open, screens fly in), so one video file may use template A for the first part and template B after a cue or a time. It is still ONE video file; its pixel layout changes at the switch.

**Data.** The song keeps `songs.template_id` as the *start* template (so the old 「LED 版型」 select and old frontends keep working). New table `song_template_switches (id, song_id, cue_id, at_sec, template_id, sort_order)` holds up to 12 switch points. A point is a **cue** (follows `cues.video_time_sec`; if the cue time is edited the point moves; deleting the cue deletes the point through the FK) or a **plain time**. `song_videos.template_timeline` (JSON) is the snapshot taken at upload; `template_snapshot` still holds the start plan, so an old frontend plays the start layout and a version without a timeline behaves exactly as before.

**Canvas size rule: identical, not 「等比例」.** All templates of one song's timeline must have exactly the same canvas size. Reason: one file, one size, one AE comp; the coordinate table of every template is then in the same comp's pixels. (The 1a upload check still accepts a uniformly scaled video; that is about compression, not about two templates differing.) Enforced by `checkTimeline` / `canvasMismatch` (`lib/ledTemplateTimeline.ts`, shared by the worker and the UI) with a Chinese message that names both templates and sizes; the select greys out templates of another size; editing one template's canvas that is part of a timeline is refused (409 `inTimeline`); the old select refuses a start template of another size or 「全部」 while switches exist. Timelines are made of self-made templates only (全部 has no layout to switch).

**Timeline JSON** (snapshot): `{ v:1, plans:{<templateId>: plan}, segments:[{ fromSec, templateId, label }] }` (one plan per template even if it appears in several segments; `label` = the cue name at upload). Cue times are frozen at upload, so moving a cue later never moves old videos.

**Boundary rule** (`segmentIndexAt`): a frame belongs to the new segment when its time >= switch time - 2 ms. 30 fps and a cue at 83.0 s: frame 2490 (83.000 s) is B, frame 2489 (82.967 s) is A. The time of a frame is its `requestVideoFrameCallback` `mediaTime` (what the compositor shows and what the texture upload reads in the same animation frame), `currentTime` only where that API is missing; `seeked` supplies it after a scrub (`lib/ledFrameClock.ts`).

**Rendering** (`StageScene` prop `ledTimeline`, `lib/stageLook/ledTimelineSwitch.ts`). The material effect precomputes the uniform data of every segment for every LED object; `tick()` calls `sync()` before rendering: if the frame's segment differs from the applied one it copies the precomputed numbers into the uniforms (`uLedTplSrc/Dst/Mat/Off`, `uLedUvSet`) and swaps the ambient-light remap. No recompile, no React round trip, so the new layout and the new video frame appear in the same rendered frame. The colour line of the shader is untouched (`led-color-accuracy.mjs` before and after identical). Sources without a clock (AE live, a local image) use the page's time: the selected cue's video time, or a segment picked in the chip (「看哪一段」, this view only, not saved). Priority is the same as `ledLiveTemplate.ts`: panel preview > version timeline / version plan > the song's current timeline (live sources) > full canvas.

**UI.** Song list: the 「LED 版型」 select is the start; below it the lines 「從 Cue 4（1:23.0）起換成「版型 B」」 and the button 「中途換版型…」 open `LedTimelineDialog` (start template, rows of cue-or-time + target template, live validation, preview sentences). 製作 edits, everyone reads. The 「LED 版型：…」 chip shows the active template and the next switch (「· 1:23.0 換成「版型 B」」). Version rows show 「版型時間線：版型 A → 版型 B（Cue 4 · 1:23.0）」.

**Downloads** (3D toolbar 「⋯」 when the song has a timeline): AE comp script (`lib/aeTimelineScript.ts`) builds one comp of the common canvas size; each segment gets its own locked guide layers (template PNG + one outline per screen, names prefixed `[版型 A]`) whose in/out points are the segment's start/end, so they are shown and hidden at the switch times (no keyframes); a comp marker sits at every switch (falls back to a layer marker on old AE); the same PNG is imported once even if the template appears twice. The PNG download gives one PNG per template. The coordinate table (`timelineTableToCsv/Json`) has one section per template (titled with the segment numbers and times).

**Compatibility.** Additive migration; an old frontend ignores `templateSwitches` / `templateTimeline`; a version without `template_timeline` and a song without switches behave as before. Project duplicate / export / import carry the switches (song, cue and template ids remapped; a cue that cannot be mapped becomes a plain time).

## 7. Tests

- `cf-worker/ledTemplates.test.mjs`: 0034 on old data (backfill, old INSERTs still work, CHECKs), CRUD + validation, 製作-only writes / member reads / director 403, 全部 read-only, songs' selector, version snapshot frozen when the template is edited later, share video carries `template`, delete refused while in use, duplicate project copies.
- `web/src/lib/ledTemplate.test.ts`: rotate/flip table (all 8 orientations), wrap-aware source span, uncovered fragment → black, scale detection (exact / 50% / 1 px rounding / aspect mismatch), screen list (auto vs manual), template checks (overlap, outside canvas, stretch), Chinese messages.
- Shader: `ledSurface.test.ts` keeps proving the old path; a new test compares the GLSL remap against `mapUvToTemplate` through a JS port of the same expressions; `web/scripts/led-color-accuracy.mjs` before / after must be identical for the 全部 template.
- `web/src/lib/ledLiveTemplate.test.ts`: which plan each source uses (version snapshot vs the song's current template vs the preview), 「暫時用整張畫布看」, chip text, size check (exact / scaled / full canvas / other template / stretch, loose AE rule).
- `web/src/lib/aeTemplateScript.test.ts`: comp name / size / square pixels / fps / duration, guide layer at the bottom (locked, guide, normal blend, scaled to the comp), one outline per screen, Chinese + quote + line-break names, the whole .jsx run in a fake AE (`src/test/fakeAeHost.ts`) and parsed by an ES3 lint on the syntax tree (`src/test/es3Lint.ts`; it also covers the full-canvas script). `ledTemplateTable.test.ts`: columns, BOM, CRLF, quoting, rotation / flip / scale / full-canvas rect, notes, JSON, file names; menu labels.
- Guard tests (emoji, native dialogs, English role words) cover the new UI files.
- Part 3: `cf-worker/ledTemplateTimeline.test.mjs` (migration 0039 on old data, PUT permissions and validation, cue edit / delete, template delete and canvas edit guards, old select guard, version snapshot frozen, share video, duplicate / export / import); `web/src/lib/ledTemplateTimeline.test.ts` (time parsing, buildTimeline, boundary frames at 30 / 60 fps and scrubbing order, canvas-size rule, snapshot round trip), `ledFrameClock.test.ts` (rVFC mediaTime vs currentTime, seeked, source change, fallback), `stageLook/ledTimelineSwitch.test.ts` (simulated 30 fps playback across 83.0 s, scrub both ways, only the sampling coordinates change, original-UV protection per segment), `ledLiveTemplateTimeline.test.ts` (which plan / timeline each source gets, chip text), `aeTimelineScript.test.ts` (in/out points, markers, one import per template, ES3 lint, run in the fake AE), `ledTemplateTimelineTable.test.ts`. Browser check (temporary harness, not committed): real StageScene + a 4 s video whose layout changes at 2.0 s; frame-by-frame, scrubbing both ways and real playback across the cue gave no wrongly mapped frame.
