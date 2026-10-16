# 自動貼 UV (auto UV + pixel map for LED screens) — design

Date: 2026-10-16. Status: **stage 1 built** (flat panels, three resolution inputs, stage-shaped layout, new model version, 「舊版面」 protection; see 0.2); stages 2-4 not started. The owner approved building the feature and answered the open questions (0.1).
UI strings are quoted exactly as they should ship: Traditional Chinese, no emoji (icons via `Icon` + lucide), in-page dialogs only, no English role words (the guard tests in `web/src/test/` apply).

## 0. Problem, goal, decisions

Today the slowest part of every job: after the client's 3D stage model arrives, the owner UV-unwraps every LED surface in C4D by hand and draws the LED pixel map (對位圖) by hand. Goal: in the web app (編輯專案, 製作 only) he picks LED objects, gives each a resolution (pixel pitch / W×H pixels / cabinets), the system unwraps them, packs them on a canvas, he rearranges them in the same kind of canvas editor he already uses for LED templates, and one button writes the UVs into a **new model version** and sets the project's full canvas. 對位圖, 「全部」 template, AE comp script and coordinate table then regenerate by themselves because they are all computed from the model's UVs.

| # | Decision | Why |
|---|---|---|
| 1 | All processing is **client-side in a Web Worker** (same place as `modelCompress/compress.worker.ts`). The server only receives the finished `.glb`. | No new heavy backend. Nothing is written until the final confirm. |
| 2 | UVs are written with **gltf-transform on the original file bytes**, **not** three.js `GLTFExporter`. | `GLTFExporter` would re-serialise the runtime scene that `StageScene` has already changed (children detached, auto-scale baked into node transforms, cloned LED materials, `extras`/extensions dropped). gltf-transform touches only what we tell it to, and the repo already has the gate that proves nothing else moved (`verifyDocuments`, `verifyModelIdentity`). |
| 3 | Write **TEXCOORD_0** (three `uv`), the only channel every LED consumer reads (`ledSurface.ts` `vEmissiveMapUv`, `ledEmitters.ts`, `ledMapScene.ts collectUvTriangles`). TEXCOORD_1 is never touched. The old UV is **not** kept in the file; the previous model version is the backup. | One channel, nothing else in the app to change. |
| 4 | Result is a **new model version** through the existing `PUT /api/projects/:id/model` (new immutable key `models/<pid>/<ts>-<rand>.glb`, becomes active). Rollback = existing 「模型版本」 dialog. | Versioning already exists. |
| 5 | The layout (where every screen sits on the canvas) **is** the full canvas. Layout editor = the LED template editor reused (section 5). | Owner knows d3-feed-map style editing. |
| 6 | **Model scale is read, never written.** Node transforms, positions, names, materials are byte-for-byte unchanged (gate: `verifyDocuments` + `verifyModelIdentity`). | memory note `project_model_scale_locked`: cue positions are stored in scaled scene units. |
| 7 | **No colour path is touched** (no shader, no material, no texture code). | `feedback_led_color_fidelity`. `web/scripts/led-color-accuracy.mjs` before/after must be identical. |

### 0.1 Owner's answers to the open questions (2026-10-16) — these override section 13

| # | Question | Decision |
|---|---|---|
| 1 | LED spec input | All three are enterable, chosen **per screen**: pixel pitch (P3.9), total resolution (W×H), cabinet pixels × cabinet count. |
| 2 | Initial auto-layout | 「照舞台的樣子排」: screens are placed by their stage position (left on the left, upper on top); a bigger canvas is fine. |
| 3 | Old videos (no template) | Automatically create a 「舊版面」 template that maps the OLD full-canvas layout onto the new UVs so existing videos keep displaying without re-rendering. Pulled into **stage 1** (was stage 4), see 0.2. |
| 4 | Floor LEDs | The picture's "up" points to the back of the stage (away from the audience). Wall screens: up = world up. |
| 5 | Several separate pieces in one object | Each piece is its own screen, laid out separately (default, no prompt). |

### 0.2 Stage 1 as built (2026-10-16) — differences from the original draft below

- **Migration is `0036_model_uv_layouts.sql`** (0035 was taken by camera bookmarks). Table columns: `led_canvas, recipe, note, legacy_template_id, legacy_plan, stamped_videos` (the last three are the legacy protection state, below).
- **Two-step apply instead of `PUT /model?ledCanvas=…`**: `PUT /model?hold=1` stores the new `.glb` in R2 without activating it (old frontends never send `hold`, so `PUT /model` behaves exactly as before); the browser downloads it back, compares SHA-256, then `POST /led-uv/apply` swaps everything in **one D1 batch** (new `model_r2_key`, new `led_canvas`, 「舊版面」 template + placements, snapshots on the old videos, new manual screens, version rows). Any failure leaves the project untouched; an uploaded-but-unused version is deleted by the browser (or shows as an ordinary old version). `ifActive` still guards against two people applying at once (409).
- **Unselected / unsupported LEDs are not left alone.** The whole canvas is regenerated, so a LED keeping its old UV would land on top of the new layout. Such objects (unselected, curved, already hand-split, no usable stage-1 plane) are **kept**: their old UV is translated by a whole number of pixels to a new spot (shape, size, orientation, sampling unchanged) and take part in the stage-shaped layout as fixed-size items. Objects with no UV at all and no plane are untouched. Hand-split screens (`led_screens`) of a kept object are shifted with it (`screenUpdates` in the apply call).
- **Flat pieces** = welded connected components of the screen triangles (a primitive whose material name contains `LED`, otherwise every triangle). Flat if RMS <= 0.3 % of the long edge and >= 99.5 % of the area within 3° of the mean normal. A thick slab (two parallel big faces of similar area) uses the face towards the audience. Components under 0.5 % of the screen area (bolts, text) follow the nearest piece; more than 8 pieces -> not supported in stage 1. Every vertex (screen or not: frames, back, sides) gets its UV from its **position** (nearest piece, clamped into the piece rectangle), so there is no vertex splitting and the object's UV bounding box is exactly the planned rectangle.
- **Multiple pieces in one object** (owner decision 5): each piece is laid out separately and the apply call creates one manual screen (`led_screens` row) per piece, so templates and the 對位圖 keep treating them as separate screens.
- **「舊版面」 mechanism (the safest one consistent with the snapshot design).** `template_snapshot = NULL` means "made for the full canvas as it was". At apply time the server creates a template 「舊版面」 (canvas = the full canvas before the apply, one placement per screen at its **old pixel rectangle**, rotated / flipped by the orientation found by comparing old and new local coordinates over every vertex, so the old picture reproduces the old appearance; its source box is the object's new UV box as usual) and writes **that frozen plan into the snapshot of every video version that has none** (self-contained, like any other snapshot). Versions uploaded after the apply keep `NULL` = the new canvas. `songs.template_id` is **not** touched: it is also the default for newly uploaded versions, so pointing songs at 「舊版面」 would mislabel new work; the template exists in the song's 「LED 版型」 list for the occasional old local file. The ids of the stamped versions are stored on the version row; switching the active model back to the version before the apply **un-stamps** them (the old UV already matches the old pictures) and switching forward **re-stamps** them. Pieces whose old rectangle crossed the canvas edge cannot be a single rectangle: they are listed as not protected. Second apply -> 「舊版面 2」 etc.
- **Metres per model unit** is computed from the document (auto scale from the scene diagonal, the same rule as `parseGlb`, times the project's 測距校準) instead of a new `StageSceneQuery` method, so `StageScene.tsx` is not touched. Model scale is read only.
- **Not in stage 1**: 3D preview swap (`ledUvPreview`), arcs, manual arrange editor (the layout tab is read-only with a gutter option), recipe reload (`PUT …/layout`; the recipe is stored with the version), freeform, closed 360° shells.
- **Tests**: `web/src/lib/ledUv/*.test.ts` (pure maths, real `.glb` with Draco, pixel-exactness three ways: analytic corners, layout rect via the app's loader, one LED dot ↔ one canvas pixel), `cf-worker/uvLayouts.test.mjs`.

## 1. What exists (facts this design builds on)

| Area | Fact | File |
|---|---|---|
| LED objects | `stage_objects.category === 'led_panel'`; `meshName` = the GLB top-level node name under `findBestScope`. `parseGlb` skips duplicate names. | `web/src/lib/parseGlb.ts`, `StageScene.tsx` `ledModelRoots` |
| LED UV use | One shared full-canvas texture, `RepeatWrapping`, `flipY=false`, origin top-left. Per-object bounding span from UV triangles. | `web/src/lib/ledMap.ts` (`layoutPanel`, `axisSpan`, `spanToPixels`), `ledMapScene.ts`, `StageScene.tsx` `ledObjectSpan` / `ledSpans()` |
| Full canvas | `projects.led_canvas` (JSON `{width,height}`, 16..32768). Changed by `PATCH /api/projects/:id`. It is also the 「全部」 template. | `web/src/lib/ledCanvas.ts`, `cf-worker/worker.js` `sanitizeLedCanvas` |
| Templates | Screen source regions come from the **model's UV bounding box** (`uv: null` in plan = auto screen); only manual splits (`led_screens`) store UV boxes. Editor works on a `Draft` (`items[].dest/rotate/flipH/flipV`) with snap/undo/zoom. | `docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md`, `web/src/lib/ledTemplate*.ts`, `ledTemplateDraft.ts`, `ledTemplateEdit.ts`, `components/LedTemplatesDialog.tsx`, `LedTemplateCanvas.tsx` |
| Per-object LED material | Every LED object gets its own material copy (name kept). Not touched here. | `web/src/lib/stageLook/ledOwnMaterial.ts` |
| Outputs | 對位圖 PNG from `LedLayout` built from UV triangles; AE comp script and CSV/JSON from the same layout. | `web/src/lib/ledMapDraw.ts` (`renderAlignmentMapPng`), `aeCompScript.ts` (`buildAeCompScript`), `ledMap.ts` (`layoutToCsv`, `layoutToJson`), `ledMapMenuText.ts` |
| Model I/O | `loadModel/parseModel` (Draco/meshopt decoders from `web/public/draco/`), compress worker with gltf-transform `WebIO` + Draco enc/dec, settings `DRACO_ENCODER_OPTIONS` (24-bit position/UV, `quantizationVolume:'mesh'`), gates `verifyDocument.ts` / `verifyScene.ts`, test helper `testing/assertSameModel.ts`, fixture `testing/stageFixture.ts` (nested nodes, non-uniform scale, mirrored nodes, two UV sets, `KHR_texture_transform`, instanced mesh, >65535-vertex floor LED, wrapped negative-v UVs). | `web/src/lib/modelCompress/*`, `modelLoader.ts` |
| Model versions | `PUT /model` writes a new key and flips `projects.model_r2_key`; `GET /model/versions`, `POST /model/versions/activate`, `DELETE /model/versions/:file`; role `editor` (= project 製作). Max 100 MB. UI: `ModelVersionsDialog.tsx` (also has 「壓縮這個模型」: download -> worker -> `api.uploadModel`, the exact precedent for this flow). | `cf-worker/worker.js` `handleModel`, `access.mjs`, `modelKeys.mjs`, `web/src/lib/api.ts` |
| Scale | glTF world units -> scene units: `computeScaleFactor(diag)` baked into node transforms by `StageScene`; scene units -> metres: `x * scaleCorrection` (`projects.scale_correction`, the 測距校準; `unitsPerMeter = 1/scaleCorrection`). So **metres = glTF world distance * autoScale * scaleCorrection**. | `parseGlb.ts`, `StageScene.tsx` (~1438, ~2616), `scaleReference.ts` |
| Latest migration | `0034_led_templates.sql`. | `cf-worker/migrations/` |

## 2. Pipeline

```
active model bytes ──> worker: gltf-transform read (Draco decoded)
   │ A. find LED objects (names from stage_objects) + emitting triangles, world space
   │ B. classify each surface: flat / arc / unfold / project  (+ overrides)         [section 3]
   │ C. measure physical size (m) -> pixels (pitch | W×H | cabinets)                [section 4]
   │ D. auto-pack -> Draft; owner edits in the template-style canvas                [section 5]
   │ E. placement -> UV for every vertex; write TEXCOORD_0; Draco re-encode         [section 6]
   │ F. verify (file level), upload as new version (+ canvas atomically)            [section 6, 8]
   └─ G. reload through parseModel; verify again (layout rects == plan); on failure activate the previous version automatically
```
Steps A-C run once when the panel opens (progress shown, cancellable). D is pure main-thread maths on the numbers from A-C. E-F run again from the original bytes (never from a half-edited document).

## 3. Unwrap per LED object

**Surface = emitting triangles of one LED object**, in world space. Emitting triangles: primitives whose material name contains `LED` (case-insensitive); if the object has none, all triangles whose winding normal faces the audience side (`stageFrontDirection`, `web/src/lib/stageCamera.ts`). World normal = cross product of the world-space edges, **times the sign of the node's world-matrix determinant** (glTF winding rule; the fixture has mirrored nodes). Other triangles of the same primitive get the same mapping function (flat: they collapse to a line, harmless) so the primitive stays one attribute.

**Connected pieces.** Triangles are welded **by position** (tolerance 1e-4 of the object size), not by index: hard-edge exports duplicate vertices, so index connectivity would shred a wall. One object can hold several pieces (cabinets modelled as separate quads, a left and a right wing, a folded V).

**Classification (per piece, automatic; every result shown with its reason and an override).** Cheap tests in this order, first match wins:

| Class | Test | Mapping | Distortion |
|---|---|---|---|
| 平面 (flat) | RMS distance to the best-fit plane <= 0.3 % of the longer extent or <= 3 mm, **and** normals within 3° of the mean | Orthographic projection onto the plane. `n` = mean normal; `up` = world Y projected onto the plane if `abs(n·Y) < 0.9` (walls, ramps); otherwise (floor/ceiling LED) picture-top = away from the audience (`-stageFront`). `right = up × n` (viewer standing on the normal side). Local `lx,ly` = metres along `right`/`-up` from the piece's bounding corner. | 0 |
| 弧面 (arc, cylinder) | Axis = eigenvector of the area-weighted normal covariance with the smallest eigenvalue (< 0.02 of the largest); circle fit (Kåsa, then Gauss-Newton) of vertices projected perpendicular to the axis, residual RMS <= 0.5 % of radius, radius stable along the axis (no cone) | `lx = R * (θ - θmin)` (arc length in metres, direction chosen so that `right = up × n` holds on the viewing side), `ly` = distance along the axis (axis sign: world up if `abs(axis·Y) > 0.7`, else audience-right rule). Cut angle at the largest empty angular gap; a closed 360° shell without a gap needs vertex splitting -> stage 4. Covers the owner's 小半圓 (~180°). | ~0 (chord vs arc < 0.05 % at 32 segments per half circle) |
| 展開 (developable unfold) | Not flat/arc, but triangle-by-triangle unfolding across shared edges (BFS from the biggest triangle, isometric) stays within 1 % area error and has no overlap | Folded planes (L, V, stairs), cones, gentle S-curves. | measured |
| 投影 (project) | Everything else | Orthographic projection along the mean normal (what you would see from the audience), with a red warning | measured, usually large |
| 保留原本 UV | Owner override only | Existing UV is normalised to its bounding box and treated as local coordinates; only position/rotation/flip on the canvas change. | 0 (copies the old shape) |

**Quality gate is metric-based, not label-based.** For every piece the worker computes per-triangle stretch = (pixel area of its UV triangle) / (physical area in pixel units); report max and area-weighted mean deviation. Badge: green <= 0.5 %, yellow <= 5 % (「輕微拉伸」), red > 5 % (「這塊會變形，建議在 C4D 手動展開，這塊選『保留原本 UV』」). A wrong classification therefore cannot hide.

**Multi-piece objects.** Template machinery assumes one object = one rectangular source box (`buildScreenList`, `ledObjectSpan`), so:
1. Pieces that are coplanar (normal diff < 2°, plane offset < 5 mm) are merged into **one flat piece** (content continues across cabinet seams, cabinet gaps count as dead pixels unless 「補上縫隙」 is ticked).
2. Remaining pieces of one object become a **group block**: unwrapped separately and laid out left-to-right (as the audience sees them), touching, in one rectangle. The block moves as one item in the editor, so the object's UV bounding box contains only its own pieces and templates/對位圖 keep working unchanged.
3. Stage 3: 「分開排」 releases the pieces; the system then creates one manual screen per piece through the existing `POST /led-screens` (so the template list stays valid).

**Instanced and shared geometry.** A mesh referenced by several nodes (the fixture has "two nodes, one shape") gets one clone per LED node: new `Mesh` + `Primitive` that reuse the same POSITION/NORMAL/indices accessors and own a new TEXCOORD_0 accessor. Existing accessors are never mutated (an accessor shared with a non-LED primitive stays intact). A vertex used by triangles of two different pieces, or a cylinder seam, is split (appended to every attribute; index type widens automatically).

**Manual splits that already exist** (`led_screens`, UV boxes in the old canvas): if the object stays one flat piece, each split is re-expressed as the same fractions of the object's new rectangle; otherwise it is dropped and listed in the apply summary.

## 4. Physical size -> pixels

Per surface the user picks one input mode (bulk-apply to selected rows; remembered in the recipe):

| Mode (UI) | Input | Pixels |
|---|---|---|
| 「點距（mm）」 | pitch, e.g. 3.9 (list P1.5 ... P10 + free entry) | `round(size_mm / pitch)` per axis |
| 「總點數（寬 × 高）」 | W×H pixels from the client's spec | exact; no physical size needed |
| 「箱體（每箱點數 × 箱數）」 | cabinet mm (w×h), cabinet px (w×h), count c×r (default `round(measured/cabinet mm)`) | `c * cabinetPx_w`, `r * cabinetPx_h` (always whole cabinets) |

- Measured size = the surface's `right`/`up` extent in metres = glTF world distance * `autoScale` * `scaleCorrection`. The panel shows it **before** anything else: 「模型量到 12.00 × 4.00 m（按目前測距校準 ×0.62）」. The scale numbers come from the live scene through a new `StageSceneQuery.metersPerModelUnit()` (so the maths is identical to the on-screen ruler, not re-derived), with `computeScaleFactor` on the document bounds as fallback.
- Sanity rules (yellow, not blocking): a screen wider than 80 m or narrower than 0.2 m (probably uncalibrated) -> 「尺寸看起來不對，先到 3D 畫面做測距校準，或改用『總點數』」; pixel aspect vs physical aspect differs by > 1 % -> 「這塊的點不是正方形，畫面會被拉寬／拉長 N %」; cabinet mode and measured differ by > 3 % -> 「模型比 6×2 個箱體大／小 N %」.
- Result line per row, always visible: 「P3.9 → 3077 × 1026 點（12.00 × 4.00 m）」. Total line: 「共 12 塊 · 1,420 萬點 · 自動排版畫布 9216 × 3072」. Canvas side > 32768 (`LED_CANVAS_RANGE`) is blocked; > 30000 warns (`AE_MAX_COMP_SIDE`).
- The scale is not stored anywhere new. Pixel counts become fixed numbers in the recipe; later recalibration does not change them.

## 5. Layout

**Data model.** The layout is a `Draft` as in `ledTemplateDraft.ts`: one item per surface/group with `dest {x,y,w,h}`, `rotate`, `flipH`, `flipV`; `w×h` is the final bounding rectangle (swapped for 90/270); the surface's native pixel size is fixed by section 4. Mapping local -> canvas is exactly `localTransform/applyLocalTransform` (`ledTemplate.ts`, spec section 3):
`(lx,ly)` -> rotate (0: `(lx,ly)`, 90: `(1-ly,lx)`, 180: `(1-lx,1-ly)`, 270: `(ly,1-lx)`) -> flip -> `pos = dest.xy + (x',y') * dest.wh` -> `uv = pos / canvas`.
So an auto-UV layout is the template mapping run in the other direction; the existing maths and its tests (all 8 orientations) are reused, not rewritten.

**Initial auto-pack** (`ledUv/pack.ts`, pure): MaxRects (best short side), items sorted by height then width, optional gutter `0..64 px` (default 0), canvas width either typed (default: the smallest area found by trying candidate widths) and height = packed height; both rounded **up** to a multiple of 8 (adjustable 1/2/4/8/16; HEVC likes even sizes). Rotation by 90° is allowed only if 「允許轉 90° 省空間」 is ticked (default off: animators prefer upright pictures). Deterministic order (object `order`, then name) so the same input always gives the same layout.

**Manual arranging = the template editor in "layout mode"** (`LedTemplateCanvas.tsx`, `LedTemplatesDialog.tsx` pattern: panel docked under the page body so the 3D view stays visible; reuse `ledTemplateEdit.ts` snap/history/zoom, `ledTemplateDraft.ts`, `ledTemplateContent*.ts` for the content layer). Differences, all small switches:
- No corner resize handles (a screen's pixel size is a result of section 4, changing it there keeps physics honest); drag, arrow-key nudge, 「轉 90°」, 「左右翻轉」, 「上下翻轉」, Ctrl+Z, snap, zoom/pan all as is.
- Canvas size: 「畫布剛好包住螢幕」 (default) or a fixed size; overflow/overlap are red, as in templates (warn, do not forbid).
- The content layer shows the **proposed 對位圖 itself** (`drawAlignmentMap` on a layout built from the proposed UV triangles), so the canvas is what the animator will receive.
- Item label: name, 「3077 × 1026 點」, type badge, stretch badge.
- Stage 3 only; stage 1 shows the same canvas read-only plus 「重新排版」 with the pack options.

**Relation to existing templates.** A custom template stores *destination* rectangles in its own canvas and derives the *source* box from the model's current UV. After applying: object ids (node names) are unchanged, so every placement keeps working; screens whose native pixel size changed show the existing stretch tags (`checkPlacements`), and the apply summary says how many template screens are now stretched (「版型「中間底幕」裡有 2 塊螢幕大小變了，會被拉伸」). Templates are never edited automatically. Orientation changes (old UV was sideways) rotate the picture inside such a template; the summary does not hide this, it says 「請重新檢查版型」.

**Relation to existing videos** (the real risk):
- A version rendered for a **custom template** keeps working (its snapshot has destination rectangles; the source box follows the new UV) unless size/orientation changed.
- A version/local file/AE-live picture made for the **old full canvas** (`template_snapshot` NULL) will be mapped by the new UVs and look wrong; the whole canvas size changes. Mitigations: (1) the apply dialog counts them (`GET .../led-uv/impact`) and states it in plain words; (2) the old model version stays and 「換回上一版」 restores both the model and the old canvas (section 8); (3) **stage 4, optional**: 「保護舊影片」 creates a template 「舊版面（2026-10-16 套用前）」 with canvas = old full canvas, placements = each screen's old pixel rectangle (from `ledSpans()` before the change), and attaches it to the `song_videos` rows whose snapshot is NULL (`POST .../led-uv/protect-videos`). The existing shader already maps "new UV region -> template rectangle", so old pictures land on the right screens without any shader change; screens that were not rectangles or wrapped over the seam are listed as not protected.

## 6. Writing UVs (`ledUv/writeUv.ts`, runs in the worker)

1. Read the **original bytes** with `WebIO` (Draco decoder registered, as `compress.worker.ts getIO`). Resolve LED nodes by name with the same best-scope rule as the app (`findBestScope` logic ported to the Document), first match wins, same as `parseGlb`.
2. Un-instance and split vertices where section 3 says so. For every emitting primitive create a **new** TEXCOORD_0 accessor (float32 VEC2) from the placement maths; dispose the orphaned old UV accessor only if nothing else uses it.
3. UV precision: computed in float64, stored float32; error `<= 6e-8 * canvas` px (0.0006 px at 10496).
4. Do not touch: nodes, TRS, names, `extras`, materials (so the 「LED」 names stay), textures, TEXCOORD_1, extensions. If the LED material carries `KHR_texture_transform` (fixture has one) the panel warns (the transform would shift the picture); it is not removed automatically.
5. Re-compress **like the source**: Draco in -> Draco out using `compressCore.ts` logic (`createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ ...DRACO_ENCODER_OPTIONS })`, options always set explicitly, never inherited from whatever the read-back extension carries); plain in -> plain out; `.gltf`/external files/unknown extensions -> refuse with the same reasons as `precheckGlb`. TEXCOORD at 24 bits over a [0,1] range is accurate to `1/2^25 * canvas` px. Output > 100 MB -> refuse (`MAX_MODEL_SIZE`).
6. **Gate 1 (file)**: `verifyDocuments(original, output)` with one declared exemption (TEXCOORD_0 of the LED primitives, which is compared instead against the planned UVs at 0.01 px); everything else must be identical. **Gate 2 (app)**: `verifyModelIdentity` (node names, world matrices, bbox, auto-scale, default positions, baked StageScene positions) must pass; its LED-layout comparison is replaced for the changed objects by "layout rect == planned `dest`" (integers). Any failure -> nothing is uploaded, the dialog says which object and what differed.
7. Upload with `api.uploadModel` plus the new query (section 8). **Gate 3 (after upload)**: reload the new key through `parseModel`, rebuild `buildLedLayout(ledPanelInputs(...))`, compare every panel rect with the plan; on mismatch call `activateModelVersion(previousKey)` automatically and show 「新模型檢查沒過，已自動換回上一版」.

## 7. Outputs (all regenerate, no output code is rewritten)

| Output | How it follows the new layout |
|---|---|
| 對位圖 PNG | `renderAlignmentMapPng(layout, meta)`; layout = `buildLedLayout` of the new UVs (the dialog previews it from the proposed UVs with the same function, so preview and result cannot differ). Optional small addition to the legend: pitch and real size per screen (`LedMapMeta` extra lines). |
| 「全部」 template | = `projects.led_canvas`; written together with the model (section 8). |
| AE comp script | `buildAeCompScript` with the new canvas and layout (one outline per screen, up arrows, comment text); 「下載 AE 合成腳本」 in 「⋯」 -> LED 對位圖 unchanged. |
| Coordinate table | `layoutToCsv` / `layoutToJson`; the template table `ledTemplateTable.ts` for custom templates. After applying, the success toast offers 「下載對位圖」 and 「下載 AE 合成腳本」 directly. |
| 3D test pattern / pixel grid | `drawTestPattern` and `uLedTexels` follow `led_canvas`, so the 3D LED dot grid now equals the real pitch. |
| Share links / director / workstation | Read `model_r2_key` and `led_canvas` as before; nothing to change. |

## 8. Backend changes (small, additive, 製作 only)

Permissions: everything below is role `editor` (project 製作, `cf-worker/access.mjs`); directors/animators/guests get 403; reads of versions stay `member`.

**Migration `0035_model_uv_layouts.sql`** (next free number after 0034; additive only):
```sql
CREATE TABLE model_uv_layouts (            -- one row per model version that has a known canvas
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model_key  TEXT NOT NULL,                -- R2 key of the version
  led_canvas TEXT,                         -- JSON {width,height}; NULL = project had no canvas then
  recipe     TEXT,                         -- JSON recipe (below), NULL for the baseline row
  note       TEXT,                         -- e.g. '自動貼 UV · 12 塊螢幕 · 9216×3072'
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (project_id, model_key)
);
```
Why a table: the canvas must travel with the model version. Rolling back to the old model while keeping the new canvas would break the pixel grid, 對位圖 and every video. R2 custom metadata (2 KB) cannot hold the recipe.

**Routes**
- `PUT /api/projects/:id/model` accepts optional `?note=` (<= 80 chars), `?ledCanvas=WxH` (validated by `sanitizeLedCanvas`) and `?ifActive=<key>` (409 if the active key changed since analysis, protects against two people applying at once). With `ledCanvas`: the same `UPDATE projects SET model_r2_key=?, led_canvas=?` and inserts rows in one D1 batch: the **baseline row** for the previous active key (its current `led_canvas`, only if no row exists yet) and the **new row**. Without the params the endpoint behaves exactly as today (old frontends unaffected).
- `PUT /api/projects/:id/model/versions/:file/layout` body = recipe JSON (<= 256 KB, validated shape): sets `recipe` (retryable; if it fails the model is still correct, only 「重新編輯」 is unavailable).
- `POST .../model/versions/activate`: if a row exists for the key, also restore `projects.led_canvas` from it and return `{ ledCanvas }`; the frontend refreshes the project view settings. `DELETE .../versions/:file` deletes the row. `GET .../model/versions` adds `note`, `ledCanvas`, `hasLayout` per version (shown under the time in `ModelVersionsDialog`).
- `GET /api/projects/:id/led-uv/impact` -> `{ videoVersions, songsWithVideos, templates, templateScreens, manualSplits, shareLinks }` (counts only; one SQL each). Stage 4: `POST .../led-uv/protect-videos {templateId}`.
- Activity log: `logActivity(... 'upload','model', key, { note, ledCanvas })`.

**Recipe** (`recipe`, also what 「重新編輯」 loads): `{ v:1, canvas:{width,height}, gutter, snap, metersPerModelUnit, surfaces:[{ key:'o:<objectId>', objectName, kind:'flat|arc|unfold|project|keep', size:{mode:'pitch|pixels|cabinets', pitchMm?, pixels:{w,h}, cabinet?:{mm:[w,h], px:[w,h], count:[c,r]}}, measuredM:{w,h}, place:{x,y,w,h,rotate,flipH,flipV}, pieces?:[...] }] }`. The model file stays the source of truth for UVs; the recipe is only the editing state, so a stale/missing recipe never breaks playback.

The shared model library (`assets/models/...`) is never modified: saving always writes a project copy `models/<pid>/...` (the active key may be an asset key; other projects using the asset are unaffected).

## 9. UI

- Entry: 編輯專案 top bar button 「自動貼 UV」 next to 「版型」, 製作 only (page already `RequireAdmin`). Phone (<= 640 px): notice 「請用電腦做自動貼 UV」. Docked panel under the page body (same layout as `LedTemplatesDialog`), 3D view stays above.
- Four tabs: 「1 選螢幕」 (all `led_panel` objects: checkbox, name, type badge 「平面／弧面／展開／投影（會變形）／保留原本 UV」 with reason tooltip and a type dropdown 「自動」 + the five), 「2 解析度」 (mode, inputs, result line, warnings, bulk 「套用到已選」), 「3 排版」 (canvas, options 「畫布寬度」 「間隔」 「允許轉 90° 省空間」 「重新排版」, stage 3 editor), 「4 套用」.
- Before applying the system shows: old -> new canvas (「整張畫布會從 10496 × 5120 變成 9216 × 3072」), the stretch/distortion list, the impact counts (「沒有選版型的舊影片共 N 個版本，會貼歪」), templates with changed screens, and the statement 「舊的模型版本會保留，隨時可以在『模型版本』換回去」. Primary button 「套用並存成新模型版本」; progress text per step (讀取模型 / 計算 / 寫入 / 壓縮 / 上傳 / 檢查).
- 3D preview (stage 2): while the panel is open, `StageScene` gets a prop `ledUvPreview` that swaps the `uv` attribute of the LED meshes (original attribute kept for restore, `ledSpanCacheRef` cleared, test pattern redrawn by the existing `ledObjectsKey`/`modelVersion` effect). The test pattern draws each screen's name, size and an up arrow, so a wrong orientation is visible on the stage. Mapping between worker output and three meshes is by DFS order plus a vertex-count/first-vertex check; on mismatch the preview is disabled (apply does not depend on it).
- Re-open later: 「重新編輯上次的自動貼 UV」 loads the active version's recipe (hidden when `hasLayout` is false).

## 10. Stages (each independently useful, sized for one agent)

| Stage | Content | Backend | Done when |
|---|---|---|---|
| **1 Flat + resolution + auto-pack + new version** | `web/src/lib/ledUv/`: `surfaces.ts` (find LED nodes, emitting triangles, welded pieces, coplanar merge), `unwrapFlat.ts` (orientation rules), `size.ts` (3 input modes, sanity), `pack.ts`, `place.ts` (placement -> UV, reusing `ledTemplate.ts` transforms), `writeUv.ts` (un-instance, split, accessors, Draco), `recipe.ts`, `verify.ts`; worker `ledUv.worker.ts`; read-only layout preview + result table; apply dialog with impact numbers; gates 1-3. | migration 0035, `PUT /model` params, activate restores canvas, versions fields, `led-uv/impact`, recipe route | A stage with only flat LEDs goes from "no UVs" to correct 對位圖 / AE script / 3D in one click; rollback restores model + canvas. |
| **2 Arcs + 3D preview + classification UI** | `unwrapCylinder.ts` (axis/circle fit, arc length, orientation), distortion metric + badges, type override dropdown, `ledUvPreview` in `StageScene`, test pattern with names. | none | The owner's 小半圓 unwrap at true arc length; distortion shows 0 %; preview before apply. |
| **3 Manual arrange + multi-piece** | Layout mode of `LedTemplateCanvas`/dialog (section 5), group blocks, 「分開排」 creating `led_screens`, conversion of old manual splits, 「重新編輯」 from recipe. | none (uses existing `POST /led-screens`) | He drags, rotates, flips, undoes; re-open restores the arrangement. (Can be swapped with stage 2 if arranging matters more.) |
| **4 Freeform + legacy protection** | `unwrapUnfold.ts`, `unwrapProject.ts`, 「保留原本 UV」, closed 360° shells (vertex splitting), 「保護舊影片」 legacy template. | `protect-videos` | Any model can be processed; old full-canvas videos can be kept playing. |

## 11. Risks

| Risk | Mitigation |
|---|---|
| Old full-canvas videos mis-map after apply. | Impact count, plain warning, rollback restores model + canvas, stage 4 legacy template, custom-template videos mostly survive. |
| Wrong physical size (uncalibrated model) gives wrong pixel counts. | Measured size shown first with the calibration factor; sanity warnings; 「總點數」 mode ignores scale entirely; scale is never modified. |
| File changes beyond UV (the app's hard rule). | gltf-transform on original bytes, `verifyDocuments` (TRS, names, materials, textures byte-identical) + `verifyModelIdentity`, fixture with nested/non-uniform/mirrored nodes. |
| Instanced or shared accessors overwritten. | Never mutate existing accessors; clone per node; test with the fixture's shared shape. |
| Mirrored nodes (negative determinant) or inward normals give a mirrored picture. | Determinant rule in the normal; 「左右翻轉」 in the editor; a warning when the surface normal faces away from the stage front. |
| Draco/float rounding breaks pixel exactness. | 24-bit UV quantization = `canvas/2^25` px; gate at 0.01 px; fail closed (no upload). |
| `KHR_texture_transform`, second UV set. | TEXCOORD_1 untouched; transform detected and warned. |
| Big models: memory/time in the browser. | Same worker and limits as 「壓縮這個模型」; only LED nodes processed; progress and cancel; refuse > 100 MB. |
| Auto-classification wrong. | Metric-based quality gate; manual type override; 「保留原本 UV」 escape hatch. |
| Two admins apply at once / stale analysis. | `ifActive` check -> 409 with 「模型已經被別人換過了，請重新分析」. |
| Canvas/video limits (texture size, decoder size, AE 30000). | Existing `testPatternSize`/`exportScales`; block > 32768, warn > 30000. |
| Bilinear bleed between abutting screens. | Optional gutter; default 0 matches today's hand-made canvases. |
| Preview mesh mapping mismatch. | Preview-only; disabled on mismatch; gate 3 after upload is the real check. |

## 12. Test plan

**Unit (vitest, pure, fixtures from `modelCompress/testing/stageFixture.ts` plus new generated LEDs)**: orientation rules (wall, tilted wall, floor, ceiling, rotated about Y, mirrored node), flat/arc/unfold classification on generated meshes (plane, 180° half-cylinder at 32 and 128 segments, 270° arc, cone, V fold, noisy plane), arc-length accuracy, cabinet/pitch/pixel arithmetic and rounding, pack determinism and no-overlap property test, placement -> UV for all 8 orientations (identical to `mapUvToTemplate` inverse), vertex splitting, un-instancing, `KHR_texture_transform` detection, Chinese message wording and the guard tests (no emoji, no native dialogs, no English role words).

**Pixel-exactness against the 對位圖 (the acceptance test, three levels):**
1. *Analytic*: for every surface and every vertex, `uv * canvas` equals the placement transform of its local coordinate within **0.01 px**; the four rectangle corners are integers within 0.01 px.
2. *Layout*: after a real write -> Draco encode -> decode (`NodeIO`) -> `parseModel` -> `buildLedLayout`, every panel `rect` equals the planned `dest` (exact integers, `spanToPixels` rounding), `wrapsX/Y` false, `coverage` ~1 for flat/arc. Then `renderAlignmentMapPng` from the planned UVs and from the reloaded model must be **byte-identical** (same drawing function, same rects).
3. *Pixel bijection (software raster, same technique as `ledTemplateContent.test.ts`)*: for each LED dot `(i,j)` of a flat or arc surface, take its physical centre ((i+0.5)·pitch along the surface), find the triangle/UV it falls on, convert to a canvas pixel: it must be exactly `dest.xy + transform(i,j)` for all four rotations and flips, i.e. one LED dot <-> one canvas pixel, no skipped or doubled columns (arc: equal arc-length slices).

**Safety tests**: `assertSameModel`-style check that nodes/materials/textures/names/extras are untouched (including the 「LED」 material name); `led-color-accuracy.mjs` before/after identical (no colour code changed); Draco-in/plain-in/refuse cases; > 65535-vertex floor LED; apply -> rollback restores model + `led_canvas`; `ifActive` 409; old frontend `PUT /model` without params unchanged.

**Backend (`cf-worker/*.test.mjs` pattern)**: migration 0035 on old data, params validation, atomic canvas+key update, baseline row, activate restores canvas, delete cleans row, 製作-only (director/animator/member 403), recipe size/shape limits, impact counts.

**Browser smoke (local worker + real `stage.glb`, no external browser needed beyond the existing harness)**: analyse, set a pitch, auto-pack, apply, reload: LED test pattern shows the names upright, 對位圖 downloads, AE script and CSV regenerate with the new canvas, 「模型版本」 -> 換回上一版 restores the old picture and canvas; phone width shows the notice.

## 13. Open questions for the owner (plain Chinese) — answered on 2026-10-16, see 0.1

1. **你拿到的 LED 規格通常是哪一種？**
   (A) 點距（例如 P3.9）　(B) 整面總解析度（例如 3072 × 1024）　(C) 箱體大小 + 幾箱（例如每箱 128 × 128 點，橫 6 直 2）　(D) 三種都會用，都要能輸入。
2. **一開始的排法要怎麼排？**
   (A) 排得整齊、畫布越小越好　(B) 照舞台的樣子排（左邊的螢幕在左、上面的在上），畫布大一點沒關係　(C) 我自己指定畫布大小（例如寬 8800），系統只在裡面排。
3. **套用之後，舊影片怎麼辦？**（沒選版型的舊影片，畫面會貼歪，因為整張畫布變了）
   (A) 自動建一個「舊版面」版型讓舊影片照舊貼對（推薦，之後再做）　(B) 不管，舊影片重新輸出就好　(C) 每次套用前問我。
4. **躺在地上的 LED（地屏）畫面的「上方」要朝哪？**
   (A) 朝舞台後方（站在觀眾席往舞台看，上方就是離觀眾最遠的那邊）　(B) 朝舞台右邊　(C) 跟 C4D 原本的方向一樣。牆上的 LED 一律上方朝上，不用選。
5. **一個物件裡有好幾片分開的螢幕（例如一個物件包了左右兩片）時：**
   (A) 每片各自當一塊螢幕，分開排　(B) 當成一塊，排成一排，畫面左右連起來　(C) 每次問我。
