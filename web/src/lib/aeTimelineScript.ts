// LED 版型時間線（同一首歌中途換版型）的下載：一個 zip，做法跟單一版型的 zip（ledTemplateTiles.ts）一樣「每塊 LED 一個合成 + 總合成」。
//
// zip 裡：
//   tiles/<版型名稱>/<每塊 LED>.png   每個版型一個資料夾，每塊一張圖（網站同款測試圖）
//   座標表.csv                          每個版型一段
//   AE建合成腳本.jsx                    見下
//
// AE 腳本：
//   - 每個版型的每塊 LED 一個合成（名稱前面加 [版型名稱]），裡面的「測試圖」是一般圖層、鎖住（不是導引圖層）。
//   - 一個整張畫布大小的總合成：每一段（某個版型從幾秒到幾秒）把那個版型的每塊 LED 合成擺在正確位置，
//     圖層的入點 = 這一段開始，出點 = 下一段開始（最後一段到合成結束）。「只在那一段出現」是圖層入點出點，不是關鍵格。
//   - 總合成的時間軸在每個換版型的時間有一個標記：「從 Cue 4（1:23.0）起換成「版型 B」」（開頭：「開頭：版型「版型 A」」）。
//   - 同一個版型出現好幾段（A → B → A）：每塊 LED 的合成只建一次，每一段各放一個圖層。
// 純函式，aeTimelineScript.test.ts 有測，還用假的 AE 跑過一次整支腳本。中文一律寫成 \uXXXX（es3String），檔案開頭有 BOM。

import { assembleScript, commentSafe } from './aeCompScript';
import { AE_DEFAULT_FPS, normalizeAeFps } from './aeTemplateScript';
import { csvCell, safeName, type CanvasSize } from './ledMap';
import { formatPct, type ScreenDef } from './ledTemplate';
import { TILES_DIR, tileFileNames, tilesOf, type TileInfo } from './ledTemplateTiles';
import { segmentWhere, switchSentence, timelineCanvas, type LedTimeline } from './ledTemplateTimeline';

export { AE_DEFAULT_FPS, segmentWhere };

export interface TimelineTilePlan {
  /** 版型 id */
  id: string;
  name: string;
  /** zip 裡 tiles 底下的資料夾名（不重複） */
  dir: string;
  tiles: TileInfo[];
  /** 這個版型用在第幾段（從 1 算） */
  segmentNumbers: number[];
}

/** 時間線裡每個版型各一份（同一個版型出現好幾段只算一次，照第一次出現的順序），含每塊 LED 的位置和檔名 */
export function timelineTilePlans(timeline: LedTimeline, defs: readonly ScreenDef[]): TimelineTilePlan[] {
  const out: TimelineTilePlan[] = [];
  timeline.segments.forEach((s, i) => {
    const found = out.find(p => p.id === s.templateId);
    if (found) { found.segmentNumbers.push(i + 1); return; }
    out.push({ id: s.templateId, name: s.plan.name, dir: '', tiles: tilesOf(s.plan, defs).tiles, segmentNumbers: [i + 1] });
  });
  const dirs = tileFileNames(out.map(p => p.name));
  out.forEach((p, i) => { p.dir = dirs[i].replace(/\.png$/, ''); });
  return out;
}

/** zip 裡一塊圖的路徑 */
export function timelineTilePath(p: Pick<TimelineTilePlan, 'dir'>, t: Pick<TileInfo, 'fileName'>): string {
  return `${TILES_DIR}/${p.dir}/${t.fileName}`;
}

/** 座標表 CSV：每個版型一段（標題、欄位名、每塊 LED 一列），前面有 BOM */
export function timelineTilesToCsv(timeline: LedTimeline, plans: readonly TimelineTilePlan[]): string {
  const rows: (string | number)[][] = [];
  for (const p of plans) {
    const wheres = p.segmentNumbers.map(n => `第 ${n} 段 · ${segmentWhere(timeline.segments[n - 1].label, timeline.segments[n - 1].fromSec)}`);
    if (rows.length) rows.push([]);
    rows.push([`版型「${p.name}」`, `用在：${wheres.join('、')}`]);
    rows.push(['名稱', 'x', 'y', 'w', 'h', '旋轉', '左右翻', '上下翻', '檔名']);
    for (const t of p.tiles) rows.push([t.name, t.x, t.y, t.w, t.h, t.rotate, t.flipH ? '是' : '否', t.flipV ? '是' : '否', timelineTilePath(p, t)]);
  }
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 合成名稱：示範專案 - 開場 版型時間線 4400x200 */
export function aeTimelineCompName(projectName: string, songName: string | undefined, canvas: CanvasSize): string {
  const project = commentSafe(projectName).trim().slice(0, 80) || '未命名專案';
  const song = songName ? ` ${commentSafe(songName).trim().slice(0, 60)}` : '';
  return `${project} -${song} 版型時間線 ${canvas.width}x${canvas.height}`;
}

/** 下載的 zip 檔名：LED每塊圖-主舞臺-開場-版型時間線-4400x200.zip */
export function timelineZipFileName(projectName: string, songName: string | undefined, canvas: CanvasSize): string {
  return `LED每塊圖-${safeName(projectName)}-${songName ? `${safeName(songName)}-` : ''}版型時間線-${canvas.width}x${canvas.height}.zip`;
}

export interface AeTimelineSegmentData {
  /** 第幾個版型（plans 的位置） */
  plan: number;
  from: number;
  /** 下一段開始（最後一段 = null：到合成結束） */
  to: number | null;
  markerText: string;
}

/** 每一段放什麼（純資料，腳本和測試都用它） */
export function timelineSegmentsData(timeline: LedTimeline, plans: readonly TimelineTilePlan[]): AeTimelineSegmentData[] {
  const segs = timeline.segments;
  return segs.map((s, i) => {
    const name = commentSafe(s.plan.name);
    return {
      plan: Math.max(0, plans.findIndex(p => p.id === s.templateId)),
      from: s.fromSec,
      to: i + 1 < segs.length ? segs[i + 1].fromSec : null,
      markerText: i === 0 ? `開頭：版型「${name}」` : switchSentence(s.label ? commentSafe(s.label) : null, s.fromSec, name),
    };
  });
}

const UI = {
  noFolder: '找不到每塊 LED 的圖（tiles 資料夾）。\n請把 zip 完整解壓縮，再選解壓縮出來的資料夾（有 tiles 資料夾的那一層）。',
  pick: '選解壓縮出來的資料夾',
  askLen: '合成長度（秒，或 分:秒）',
  missing: '這些圖找不到，沒有建：\n',
  undo: 'Stage Previz 建 LED 版型時間線合成',
  skipped: '\n注意：有 {4} 段比合成的長度還晚才開始，沒有放（合成要夠長才看得到）。',
  done: '建好了。\n\n總合成「{0}」（{1} × {2}）：每一段版型的每塊 LED 合成，只在那一段的時間出現，換版型的時間在時間軸上有標記。輸出這個就是給 LED 的畫面。\n每塊 LED 的合成共 {3} 個：每個合成裡的「測試圖」是一般圖層，做動畫時關掉或刪掉。{4}',
};

const RUNNER = String.raw`
var scriptFile = new File($.fileName);
var root = scriptFile.parent;
var tilesDir = new Folder(root.fsName + "/" + DATA.tilesDir);
if (!tilesDir.exists) {
  var pick = Folder.selectDialog(DATA.ui.pick);
  if (pick) { root = pick; tilesDir = new Folder(root.fsName + "/" + DATA.tilesDir); }
}
if (!tilesDir.exists) { alert(DATA.ui.noFolder); return; }
if (!app.project) app.newProject();
function parseLen(text) {
  var p = String(text).split(":");
  var v = 0;
  for (var k = 0; k < p.length; k++) v = v * 60 + parseFloat(p[k]);
  return v;
}
var secs = parseLen(prompt(DATA.ui.askLen, String(DATA.defaultSecs)));
if (!(secs > 0)) secs = DATA.defaultSecs;
app.beginUndoGroup(DATA.ui.undo);
var missing = [];
var folder = app.project.items.addFolder(DATA.folderName);
var main = app.project.items.addComp(DATA.mainName, DATA.width, DATA.height, 1, secs, DATA.fps);
main.parentFolder = folder;
main.comment = DATA.comment;
var comps = [];
var made = 0;
for (var p = 0; p < DATA.plans.length; p++) {
  var plan = DATA.plans[p];
  comps[p] = [];
  for (var i = 0; i < plan.tiles.length; i++) {
    var t = plan.tiles[i];
    var f = new File(tilesDir.fsName + "/" + t.file);
    if (!f.exists) { missing.push(t.file); comps[p][i] = null; continue; }
    var footage = app.project.importFile(new ImportOptions(f));
    footage.parentFolder = folder;
    var comp = app.project.items.addComp(plan.tag + t.name, t.w, t.h, 1, secs, DATA.fps);
    comp.parentFolder = folder;
    comp.comment = t.comment;
    var ref = comp.layers.add(footage);
    ref.name = DATA.refLayerName;
    if (footage.width !== t.w || footage.height !== t.h) {
      ref.property("Scale").setValue([t.w / footage.width * 100, t.h / footage.height * 100]);
    }
    ref.locked = true;
    comps[p][i] = comp;
    made++;
  }
}
function addMarker(t, text, layer) {
  try { main.markerProperty.setValueAtTime(t, new MarkerValue(text)); return true; } catch (e0) {}
  try { if (layer) { layer.property("ADBE Marker").setValueAtTime(t, new MarkerValue(text)); return true; } } catch (e1) {}
  return false;
}
var skipped = 0;
for (var s = 0; s < DATA.segments.length; s++) {
  var seg = DATA.segments[s];
  if (seg.from >= secs) { skipped++; continue; }
  var sp = DATA.plans[seg.plan];
  var first = null;
  for (var j = 0; j < sp.tiles.length; j++) {
    var c = comps[seg.plan][j];
    if (!c) continue;
    var st = sp.tiles[j];
    var layer = main.layers.add(c);
    layer.name = sp.tag + st.name;
    layer.property("Position").setValue([st.x + st.w / 2, st.y + st.h / 2]);
    layer.comment = st.comment;
    if (seg.from > 0) layer.inPoint = seg.from;
    if (seg.to !== null && seg.to < secs) layer.outPoint = seg.to;
    if (!first) first = layer;
  }
  addMarker(seg.from, seg.markerText, first);
}
app.endUndoGroup();
try { main.openInViewer(); } catch (e) {}
var msg = DATA.ui.done.replace("{0}", DATA.mainName).replace("{1}", DATA.width).replace("{2}", DATA.height).replace("{3}", String(made)).replace("{4}", skipped > 0 ? DATA.ui.skipped.replace("{4}", String(skipped)) : "");
if (missing.length) msg += "\\n\\n" + DATA.ui.missing + missing.join("\\n");
alert(msg);
`;

export interface AeTimelineScriptInput {
  timeline: LedTimeline;
  /** 螢幕清單（名字、真實點數）；版型裡找不到對應螢幕的略過 */
  defs: readonly ScreenDef[];
  projectName: string;
  /** 這首歌的名字（合成名稱用）；可以沒有 */
  songName?: string;
  /** yyyy-mm-dd */
  date: string;
  fps?: number;
}

/** 整支 .jsx（開頭有 BOM）：每個版型的每塊 LED 一個合成 + 一個整張畫布大小的總合成（每一段只放那個版型的合成） */
export function buildAeTimelineScript(input: AeTimelineScriptInput): string {
  const { timeline, projectName, date } = input;
  const c = timelineCanvas(timeline);
  const project = projectName || '未命名專案';
  const plans = timelineTilePlans(timeline, input.defs);
  const segments = timelineSegmentsData(timeline, plans);
  const summary = timeline.segments.map((s, i) => `${i + 1}. ${segmentWhere(s.label, s.fromSec)} 用「${s.plan.name}」`).join('；');
  const last = timeline.segments[timeline.segments.length - 1].fromSec;
  const data = {
    tilesDir: TILES_DIR,
    folderName: 'Stage Previz LED 版型時間線',
    mainName: aeTimelineCompName(projectName, input.songName, c),
    width: c.width, height: c.height,
    fps: normalizeAeFps(input.fps),
    defaultSecs: Math.max(180, Math.ceil(last + 30)),
    comment: `Stage Previz LED 版型時間線 · 專案：${commentSafe(project)}${input.songName ? ` · 歌：${commentSafe(input.songName)}` : ''} · 畫布 ${c.width} × ${c.height}（比例 ${formatPct(timeline.segments[0].plan.scalePct)}）· ${commentSafe(summary)} · ${date}`,
    refLayerName: '測試圖',
    plans: plans.map(p => ({
      name: commentSafe(p.name),
      tag: `[${commentSafe(p.name)}] `,
      tiles: p.tiles.map(t => ({
        name: commentSafe(t.name), file: `${p.dir}/${t.fileName}`, x: t.x, y: t.y, w: t.w, h: t.h,
        comment: `位置 ${t.x}, ${t.y} · ${t.w}×${t.h} 像素 · 上方${t.upText} · 轉 ${t.rotate}°${t.flipH ? ' · 左右翻' : ''}${t.flipV ? ' · 上下翻' : ''}`,
      })),
    })),
    segments,
    ui: UI,
  };
  const header = [
    '// Stage Previz：AE 一鍵建 LED 版型時間線（同一首歌中途換版型；每個版型的每塊 LED 一個合成）',
    `// 專案：${commentSafe(project)}${input.songName ? `　歌：${commentSafe(input.songName)}` : ''}　畫布：${c.width} × ${c.height}　${plans.length} 個版型、${segments.length} 段　${date}`,
    `// ${commentSafe(summary)}`,
    '// 用法：先把 zip 解壓縮，After Effects → File > Scripts > Run Script File…（檔案 > 指令碼 > 執行指令碼檔案）選這個檔案',
    '//@target aftereffects',
  ];
  return assembleScript(header, data, RUNNER);
}
