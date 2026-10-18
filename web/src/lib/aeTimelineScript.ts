// LED 版型時間線的「一鍵建 AE 合成」（同一首歌中途換版型，lib/ledTemplateTimeline.ts）。
//
// 做法（刻意簡單、不容易壞）：一個合成，大小 = 時間線的畫布（每個版型一樣大）。
//   - 每一段（某個版型從幾秒到幾秒）有自己的一組導引圖層：該版型的模板圖 + 每塊螢幕一個外框，圖層名字前面寫 [版型名稱]。
//   - 每組圖層只在自己那一段的時間顯示：圖層的入點 = 這一段開始，出點 = 下一段開始（最後一段到合成結束）。
//     「在換版型的時間顯示 / 隱藏」就是圖層的入點出點，不是關鍵格，動畫師拖時間軸就看得到現在是哪個版型。
//   - 合成的時間軸在每個換版型的時間有一個標記：「從 Cue 4（1:23.0）起換成「版型 B」」（開頭也有一個：「開頭：版型「版型 A」」）。
//     標記放在合成上；AE 版本太舊放不上去就放在那一段第一個圖層上。
//   - 所有圖層都是導引圖層、鎖住：不會算圖出去。
// 同一個版型出現好幾段（A → B → A）：模板圖只存一份、只匯入一次，每一段各放一個圖層。
//
// 腳本本身（問長度、寫圖檔、放圖、畫外框）跟另外兩種 AE 腳本共用同一份 ES3 程式（aeCompScript.ts 的 RUNNER_COMMON）；
// 這裡只放時間線自己的東西。純函式，aeTimelineScript.test.ts 有測，還用假的 AE 跑過一次整支腳本。
// 中文一律寫成 \uXXXX（es3String），檔案開頭有 BOM。

import {
  RUNNER_COMMON, UI_TEXT, assembleScript, chunkBase64, commentSafe, unitOf, type AeMapImage,
} from './aeCompScript';
import { AE_DEFAULT_FPS, aeTemplateGuideFileName, normalizeAeFps, templatePanels, type AeTemplatePanel } from './aeTemplateScript';
import { safeName, type CanvasSize } from './ledMap';
import { formatPct, type ScreenDef } from './ledTemplate';
import { layoutPattern } from './ledTemplatePattern';
import { segmentWhere, switchSentence, type LedTimeline } from './ledTemplateTimeline';

export { AE_DEFAULT_FPS, segmentWhere };

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
  defaultDuration?: string;
  /** 每個版型的模板圖（key = 版型 id）；沒有 / null = 這個版型只放外框 */
  guides?: Readonly<Record<string, AeMapImage | null>>;
}

/** 合成名稱：示範專案 - 開場 版型時間線 4400x200 */
export function aeTimelineCompName(projectName: string, songName: string | undefined, canvas: CanvasSize): string {
  const project = commentSafe(projectName).trim().slice(0, 80) || '未命名專案';
  const song = songName ? ` ${commentSafe(songName).trim().slice(0, 60)}` : '';
  return `${project} -${song} 版型時間線 ${canvas.width}x${canvas.height}`;
}

/** 下載的腳本檔名：AE合成腳本-主舞臺-開場-版型時間線-4400x200.jsx */
export function aeTimelineScriptFileName(projectName: string, songName: string | undefined, canvas: CanvasSize): string {
  return `AE合成腳本-${safeName(projectName)}-${songName ? `${safeName(songName)}-` : ''}版型時間線-${canvas.width}x${canvas.height}.jsx`;
}

export interface AeTimelineSegmentData {
  key: string;
  /** 圖層名字前面的標籤：「[版型 A] 」 */
  tag: string;
  from: number;
  /** 下一段開始（最後一段 = null：到合成結束） */
  to: number | null;
  markerText: string;
  mapKey: string | null;
  mapLayerName: string;
  panels: AeTemplatePanel[];
}

/** 每一段要放的東西（純資料，腳本和測試都用它） */
export function timelineSegmentsData(input: Pick<AeTimelineScriptInput, 'timeline' | 'defs'>): AeTimelineSegmentData[] {
  const segs = input.timeline.segments;
  return segs.map((s, i) => {
    const items = layoutPattern(s.plan, input.defs);
    const name = commentSafe(s.plan.name);
    return {
      key: `${i}`,
      tag: `[${name}] `,
      from: s.fromSec,
      to: i + 1 < segs.length ? segs[i + 1].fromSec : null,
      markerText: i === 0 ? `開頭：版型「${name}」` : switchSentence(s.label ? commentSafe(s.label) : null, s.fromSec, name),
      mapKey: s.templateId,
      mapLayerName: `版型模板圖（${name}）`,
      panels: templatePanels(items),
    };
  });
}

const TIMELINE_UI = {
  ...UI_TEXT,
  tooBig: 'LED 版型畫布 {0} × {1} 超過 AE 合成的上限 30000 px，沒辦法建。請找製作確認版型的畫布大小',
  undo: 'Stage Previz 建 LED 版型時間線合成',
  done: '建好了：\n\n合成「{0}」\n{1} × {2}、{3} fps、長度 {4}\n\n版型時間線 {5} 段：每一段的螢幕外框和模板圖是自己的導引圖層（鎖住，不會算圖出去），只在那一段的時間顯示。換版型的時間在時間軸上有標記。{6}\n版型模板圖：{7}\n\n素材直接放進這個合成就好，導引圖層不會被輸出。',
  skipped: '\n注意：有 {0} 段比合成的長度還晚才開始，沒有放（合成要夠長才看得到）。',
  mapDone: '每個版型一張，放在最下面（導引圖層、鎖住，不會算圖出去）。圖檔存在：{0}',
  mapNone: '這次沒有放（外框已經夠用）',
  folderName: 'Stage Previz LED 版型',
};

/** 時間線專用的 ES3 程式（接在 RUNNER_COMMON 後面）；沒有 let / const / 箭頭函式 / 樣板字串 / forEach / indexOf / JSON */
export const RUNNER_TIMELINE = String.raw`
function findMap(key) {
  for (var i = 0; i < DATA.maps.length; i++) if (DATA.maps[i].key === key) return DATA.maps[i];
  return null;
}
var mapState = { items: {}, note: null, file: null };
function addSegmentMap(comp, folder, seg) {
  var map = findMap(seg.mapKey);
  if (!map) return null;
  var item = mapState.items[map.key];
  if (item === undefined) {
    item = null;
    if (!canWriteFiles()) {
      mapState.note = UI.mapNoWrite;
    } else {
      var f = writeMapFile(map);
      if (!f) {
        mapState.note = UI.mapWriteFailed;
      } else {
        item = app.project.importFile(new ImportOptions(f));
        item.parentFolder = folder;
        mapState.file = f.fsName;
      }
    }
    mapState.items[map.key] = item;
  }
  if (!item) return null;
  var layer = comp.layers.add(item);
  layer.name = seg.mapLayerName;
  var tr = layer.property("ADBE Transform Group");
  tr.property("ADBE Scale").setValue([DATA.width / map.width * 100, DATA.height / map.height * 100]);
  tr.property("ADBE Position").setValue([DATA.width / 2, DATA.height / 2]);
  lockGuide(layer);
  return layer;
}
function setSpan(layer, from, to) {
  try { if (from > 0) layer.inPoint = from; } catch (e0) {}
  try { if (to !== null) layer.outPoint = to; } catch (e1) {}
}
function addMarker(comp, layer, t, text) {
  try { comp.markerProperty.setValueAtTime(t, new MarkerValue(text)); return true; } catch (e0) {}
  try { layer.property("ADBE Marker").setValueAtTime(t, new MarkerValue(text)); return true; } catch (e1) {}
  return false;
}
function run() {
  if (DATA.width > 30000 || DATA.height > 30000) { alert(fmt(UI.tooBig, DATA.width, DATA.height), UI.title); return; }
  var dur = askDuration(fmt(UI.askDuration, DATA.width, DATA.height, DATA.fps), DATA.defaultDuration);
  if (dur < 0) return;
  if (!app.project) app.newProject();
  var made = { segments: 0, skipped: 0, markers: 0 };
  var failed = null, folder = null, comp = null;
  var firstLayer = [];
  app.beginUndoGroup(UI.undo);
  try {
    folder = app.project.items.addFolder(DATA.folderName);
    comp = app.project.items.addComp(DATA.compName, DATA.width, DATA.height, 1, dur, DATA.fps);
    try { comp.pixelAspect = 1; } catch (e6) {}
    comp.parentFolder = folder;
    try { comp.comment = DATA.comment; } catch (e0) {}
    var s, seg, layer;
    // guide images first (they end up at the bottom): one layer per segment, shown only during that segment
    for (s = 0; s < DATA.segments.length; s++) {
      seg = DATA.segments[s];
      if (seg.from >= dur) continue;
      try {
        layer = addSegmentMap(comp, folder, seg);
        if (layer) { setSpan(layer, seg.from, seg.to !== null && seg.to < dur ? seg.to : null); if (!firstLayer[s]) firstLayer[s] = layer; }
      } catch (e1) { if (!mapState.note) mapState.note = UI.mapWriteFailed + " (" + e1.toString() + ")"; }
    }
    // one outline per screen per segment
    for (s = DATA.segments.length - 1; s >= 0; s--) {
      seg = DATA.segments[s];
      if (seg.from >= dur) { made.skipped++; continue; }
      for (var i = seg.panels.length - 1; i >= 0; i--) {
        layer = addPanel(comp, seg.panels[i]);
        layer.name = seg.tag + seg.panels[i].name;
        setSpan(layer, seg.from, seg.to !== null && seg.to < dur ? seg.to : null);
        firstLayer[s] = layer;
      }
      made.segments++;
    }
    // a marker on the timeline at every switch
    for (s = 0; s < DATA.segments.length; s++) {
      seg = DATA.segments[s];
      if (seg.from >= dur) continue;
      if (addMarker(comp, firstLayer[s], seg.from, seg.markerText)) made.markers++;
    }
    for (var n = 1; n <= comp.numLayers; n++) { try { comp.layer(n).selected = false; } catch (e5) {} }
    try { comp.openInViewer(); } catch (e2) {}
  } catch (e) {
    failed = e;
  }
  app.endUndoGroup();
  if (failed) {
    try { if (comp) comp.remove(); } catch (e3) {}
    try { if (folder) folder.remove(); } catch (e4) {}
    alert(fmt(UI.failed, failed.toString() + (failed.line ? " (line " + failed.line + ")" : "")), UI.title);
    return;
  }
  var mapText = mapState.file ? fmt(UI.mapDone, mapState.file) : (mapState.note ? mapState.note : UI.mapNone);
  alert(fmt(UI.done, DATA.compName, DATA.width, DATA.height, DATA.fps, clockText(dur), made.segments, made.skipped > 0 ? fmt(UI.skipped, made.skipped) : "", mapText), UI.title);
}
run();
`;

/** 整支 .jsx（開頭有 BOM） */
export function buildAeTimelineScript(input: AeTimelineScriptInput): string {
  const { timeline, projectName, date } = input;
  const c = timeline.segments[0].plan.canvas;
  const fps = normalizeAeFps(input.fps);
  const project = projectName || '未命名專案';
  const u = unitOf(c);
  const segments = timelineSegmentsData(input);
  // 每個版型一張模板圖（出現好幾段也只存一份）
  const maps: { key: string; fileName: string; width: number; height: number; b64: string[] }[] = [];
  for (const s of timeline.segments) {
    const g = input.guides?.[s.templateId];
    if (!g || maps.some(m => m.key === s.templateId)) continue;
    maps.push({ key: s.templateId, fileName: g.fileName || aeTemplateGuideFileName(projectName, s.plan.name, s.plan.canvas), width: g.width, height: g.height, b64: chunkBase64(g.base64) });
  }
  const compName = aeTimelineCompName(projectName, input.songName, c);
  const summary = segments.map((_s, i) => `${i + 1}. ${segmentWhere(timeline.segments[i].label, timeline.segments[i].fromSec)} 用「${timeline.segments[i].plan.name}」`).join('；');
  const data = {
    compName,
    width: c.width,
    height: c.height,
    fps,
    defaultDuration: input.defaultDuration ?? '3:00',
    folderName: TIMELINE_UI.folderName,
    comment: `Stage Previz LED 版型時間線 · 專案：${commentSafe(project)}${input.songName ? ` · 歌：${commentSafe(input.songName)}` : ''} · 畫布 ${c.width} × ${c.height}（比例 ${formatPct(timeline.segments[0].plan.scalePct)}）· ${commentSafe(summary)} · ${date}`,
    strokeWidth: Math.max(2, Math.round(2 * u)),
    fillOpacity: 15,
    mapOpacity: 100,
    mapBlend: 'normal',
    segments,
    maps,
    ui: TIMELINE_UI,
  };
  const header = [
    '// Stage Previz：AE 一鍵建 LED 版型時間線合成（同一首歌中途換版型）',
    `// 專案：${commentSafe(project)}${input.songName ? `　歌：${commentSafe(input.songName)}` : ''}　畫布：${c.width} × ${c.height}　${segments.length} 段　${date}`,
    `// ${commentSafe(summary)}`,
    '// 用法：After Effects → File > Scripts > Run Script File…（檔案 > 指令碼 > 執行指令碼檔案）選這個檔案',
    `// 會建一個 ${c.width} × ${c.height}、${fps} fps、正方形像素的合成：每一段版型各有一組導引圖層（模板圖 + 螢幕外框），只在那一段的時間顯示，換版型的時間在時間軸上有標記`,
    '// AE 2020 以後的版本，Windows / Mac 都可以',
    '//@target aftereffects',
  ];
  return assembleScript(header, data, RUNNER_COMMON + RUNNER_TIMELINE);
}
