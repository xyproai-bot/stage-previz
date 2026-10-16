// AE 一鍵建合成：下載一個 After Effects 腳本（.jsx），在 AE 用「File > Scripts > Run Script File…」（檔案 > 指令碼 > 執行指令碼檔案）跑，
// 自動建好 LED 畫布大小的合成，每塊 LED 一個外框（形狀圖層）+ 名字標籤（文字圖層），可以再夾帶 LED 對位圖。
// 全部是導引圖層、鎖住 → 不會算圖出去。
//
// 這裡都是純函式（aeCompScript.test.ts 有測，還用假的 AE 跑過一次整支腳本）：
//   es3String / es3Literal — 把資料寫成 ExtendScript（ES3）看得懂的樣子；中文一律寫成 \uXXXX
//   panelPaths — 每塊 LED 的外框（畫布像素）：長方形就四個角，不是長方形照實際形狀，跨畫布邊緣的兩邊都畫
//   panelLabels — 名字標籤寫什麼、放哪裡、多大
//   buildAeCompScript — 整支腳本（資料 + 固定的 ES3 程式）
//
// ExtendScript 是很舊的 JavaScript（ES3）：不能用 let / const / 箭頭函式 / 樣板字串，陣列沒有 forEach / indexOf，沒有 JSON。
// 下面 RUNNER 那一段要照這個寫。檔案開頭有 BOM，AE 在 Windows / Mac 都會當 UTF-8 讀；字串本身也都跳脫成 \uXXXX，雙重保險。

import {
  canvasSourceText, groupSameRect, largestPiece, wrapOffsets,
  type CanvasSize, type LedLayout, type LedMapMeta, type LedPanelLayout, type PixelRect,
} from './ledMap';

/** AE 合成最大的寬 / 高 */
export const AE_MAX_COMP_SIDE = 30000;
/** 一塊 LED 的外框最多幾個點（太細的曲面就用外框長方形，AE 才不會卡） */
const MAX_OUTLINE_POINTS = 4000;

export type Pt = [number, number];
export interface PanelPath { v: Pt[]; c: boolean }

// ─── 寫成 ES3 ───

/** 字串 → ES3 的 "..."：ASCII 以外、控制字元、引號、反斜線都跳脫（\uXXXX） */
export function es3String(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function es3Number(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** 資料 → ES3 的寫法（數字、字串、true / false / null、陣列、物件；物件的 key 也加引號） */
export function es3Literal(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return es3Number(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return es3String(v);
  if (Array.isArray(v)) return '[' + v.map(es3Literal).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${es3String(k)}:${es3Literal(x)}`).join(',') + '}';
  }
  return 'null';
}

/** 換行（含 U+2028 / U+2029，這兩個在 JS 也算換行） */
const LINE_BREAKS = new RegExp('[\r\n' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g');

/** 註解裡放使用者打的字：不能換行（不然會跑出註解變成程式） */
export function commentSafe(s: string): string {
  return s.replace(LINE_BREAKS, ' ');
}

// ─── 顏色 ───

/** hsl（度、0~1、0~1）→ AE 的顏色 [r, g, b]（0~1） */
export function hslToRgb01(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return [r3(f(0)), r3(f(8)), r3(f(4))];
}

// ─── 外框 ───

export const rectPath = (r: PixelRect): PanelPath => ({ v: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], c: true });

/** 拿掉在一直線上的點（外框是三角形的邊串起來的，直的那一段中間會有很多點） */
export function simplifyPath(pts: Pt[], closed: boolean, eps = 0.05): Pt[] {
  if (pts.length <= (closed ? 3 : 2)) return pts;
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { out.push(pts[i]); continue; }
    const p = pts[(i - 1 + n) % n], q = pts[i], r = pts[(i + 1) % n];
    const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const len = Math.hypot(r[0] - p[0], r[1] - p[1]) || 1;
    if (Math.abs(cross) / len > eps) out.push(q);
  }
  return out.length >= (closed ? 3 : 2) ? out : pts;
}

/** 外圍的邊（每 4 個數字一條：u0 v0 u1 v1，UV 單位）串成一圈一圈（畫布像素） */
export function edgeLoops(edges: ArrayLike<number>, canvas: CanvasSize): PanelPath[] {
  const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const pts = new Map<string, Pt>();
  const segs: [string, string][] = [];
  const at = new Map<string, number[]>();
  for (let i = 0; i + 3 < edges.length; i += 4) {
    const a: Pt = [edges[i] * canvas.width, edges[i + 1] * canvas.height];
    const b: Pt = [edges[i + 2] * canvas.width, edges[i + 3] * canvas.height];
    const ka = key(a[0], a[1]), kb = key(b[0], b[1]);
    if (ka === kb) continue;
    pts.set(ka, a); pts.set(kb, b);
    const idx = segs.push([ka, kb]) - 1;
    for (const k of [ka, kb]) { const l = at.get(k); if (l) l.push(idx); else at.set(k, [idx]); }
  }
  const used = new Uint8Array(segs.length);
  const loops: PanelPath[] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [start, second] = segs[s];
    const chain = [start, second];
    // 往前接：每到一個點就找還沒用過、接在這個點上的邊
    const walk = (from: string, push: (k: string) => void, stopAt: string | null) => {
      let cur = from;
      while (cur !== stopAt) {
        const next = (at.get(cur) || []).find(i => !used[i]);
        if (next === undefined) break;
        used[next] = 1;
        const [a, b] = segs[next];
        cur = a === cur ? b : a;
        push(cur);
      }
      return cur;
    };
    const end = walk(second, k => chain.push(k), start);
    const closed = end === start;
    if (closed) chain.pop();
    // 沒有接成一圈（模型的邊有缺）→ 從起點往回接，整條線才不會斷成兩段
    else walk(start, k => chain.unshift(k), null);
    const path = chain.map(k => pts.get(k)!).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pt);
    loops.push({ v: simplifyPath(path, closed), c: closed });
  }
  return loops;
}

/** 一塊 LED 的外框（畫布像素）：長方形 → 四個角；不是長方形 → 實際形狀（點太多就用外框）；跨畫布邊緣 → 兩邊都畫 */
export function panelPaths(p: LedPanelLayout, canvas: CanvasSize): PanelPath[] {
  let base: PanelPath[] = [rectPath(p.rect)];
  if (p.coverage < 0.98 && p.edges.length >= 12) {
    const loops = edgeLoops(p.edges, canvas);
    const total = loops.reduce((s, l) => s + l.v.length, 0);
    if (loops.length > 0 && total <= MAX_OUTLINE_POINTS) base = loops;
  }
  const out: PanelPath[] = [];
  for (const [dx, dy] of wrapOffsets(p, canvas)) {
    for (const path of base) out.push({ v: path.v.map(([x, y]) => [x + dx, y + dy] as Pt), c: path.c });
  }
  return out;
}

// ─── 名字標籤 ───

export interface PanelLabel {
  /** AE 文字（換行用 \r） */
  text: string;
  layerName: string;
  /** 文字的左下（第一行的基線） */
  pos: Pt;
  size: number;
  /** AE 圖層的標籤顏色（1~16，跟那塊 LED 的外框一樣） */
  label: number;
}

/** 字的大小跟著畫布（4K 畫布 = 1） */
export function unitOf(canvas: CanvasSize): number {
  return Math.min(4, Math.max(0.5, Math.max(canvas.width, canvas.height) / 3840));
}

/** 第幾塊 LED → AE 的標籤顏色（1~16 輪流） */
export function aeLabelColor(index: number): number {
  return (index % 16) + 1;
}

function namesText(names: string[]): string {
  return names.length <= 3 ? names.join(' / ') : `${names.slice(0, 3).join(' / ')} 等 ${names.length} 塊`;
}

/** 位置一樣的 LED 共用一個標籤；放在 LED 左上角裡面（跨邊緣的放在畫布裡最大的那一段） */
export function panelLabels(layout: LedLayout): PanelLabel[] {
  const c = layout.canvas;
  const u = unitOf(c);
  const indexOf = new Map(layout.panels.map((p, i) => [p, i]));
  return groupSameRect(layout.panels).map(g => {
    const p = g.panels[0];
    const r = p.rect;
    const area = largestPiece(p, c);
    const names = namesText(g.panels.map(x => x.name));
    const lines = [names, `${r.w} × ${r.h} px`, `x ${r.x}  y ${r.y}`];
    if (p.wrapsX || p.wrapsY) lines.push(p.wrapsX && p.wrapsY ? '跨畫布邊緣（左右、上下）' : p.wrapsX ? '跨畫布左右邊緣' : '跨畫布上下邊緣');
    if (p.coverage < 0.98) lines.push('不是長方形');
    const size = Math.round(Math.max(10, Math.min(40 * u, area.h / (lines.length * 1.6), area.w / 14)));
    const pad = Math.round(Math.max(4, size * 0.4));
    return {
      text: lines.join('\r'),
      layerName: `${names} 標籤`,
      pos: [area.x + pad, area.y + pad + size],
      size,
      label: aeLabelColor(indexOf.get(p) ?? 0),
    };
  });
}

// ─── 整支腳本 ───

export interface AeMapImage {
  /** 存到 AE 那台電腦時的檔名 */
  fileName: string;
  width: number;
  height: number;
  /** PNG 的 base64 */
  base64: string;
}

export interface AeScriptInput {
  layout: LedLayout;
  projectName: string;
  /** yyyy-mm-dd */
  date: string;
  canvasSource: LedMapMeta['canvasSource'];
  fps?: number;
  /** 問合成長度時的預設（分:秒） */
  defaultDuration?: string;
  /** 夾帶的 LED 對位圖（null = 不放） */
  map?: AeMapImage | null;
}

/** 合成名稱：Stage Previz – 示範專案 – 3840x2160 */
export function aeCompName(projectName: string, canvas: CanvasSize): string {
  const name = commentSafe(projectName).trim() || '未命名專案';
  return `Stage Previz – ${name} – ${canvas.width}x${canvas.height}`;
}

/** 每 8192 個字一段（base64 的 4 的倍數）：AE 一段一段解開、寫進檔案 */
export function chunkBase64(b64: string, size = 8192): string[] {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += size) out.push(b64.slice(i, i + size));
  return out;
}

export const UI_TEXT = {
  title: 'Stage Previz',
  askDuration: '要建 {0} × {1}、{2} fps 的合成。\n合成多長？（分:秒，例：3:00）',
  badDuration: '看不懂這個長度。請寫成「分:秒」，例：3:00（1 秒到 3 小時）',
  tooBig: 'LED 畫布 {0} × {1} 超過 AE 合成的上限 30000 px，沒辦法建。請找製作確認畫布大小',
  undo: 'Stage Previz 建 LED 合成',
  done: '建好了：\n\n合成「{0}」\n{1} × {2}、{3} fps、長度 {4}\n\nLED 外框 {5} 塊、名字標籤 {6} 個：都是導引圖層、鎖住了，不會算圖出去。\nLED 對位圖：{7}\n\n把你的素材放在這些導引圖層下面就好（導引圖層留在最上面，才看得到外框）。',
  mapDone: '放好了，在外框下面（濾色、不透明度 60%，不要的話把眼睛關掉）。圖檔存在：{0}',
  mapNone: '這次沒有放（外框和名字已經夠用）',
  mapNoWrite: '沒有放：AE 現在不允許腳本存檔。要放的話：Edit > Preferences > Scripting & Expressions（Mac：After Effects > Settings > Scripting & Expressions），勾「Allow Scripts to Write Files and Access Network」（允許指令碼寫入檔案和存取網路），再跑一次',
  mapWriteFailed: '沒有放：圖檔存不進去',
  failed: '建到一半出錯了，建到一半的合成已經拿掉：\n{0}\n\n請把這個訊息截圖給製作',
  mapLayerName: 'LED 對位圖（參考）',
  folderName: 'Stage Previz LED 對位',
};

/** 中文字型（AE 的 PostScript 名稱）：Windows 微軟正黑體、Mac 蘋方；都沒有就用 AE 預設的 */
const FONTS = {
  win: ['MicrosoftJhengHeiRegular', 'MicrosoftJhengHeiUIRegular', 'NotoSansTC-Regular', 'SourceHanSansTC-Regular'],
  mac: ['PingFangTC-Regular', 'NotoSansTC-Regular', 'SourceHanSansTC-Regular', 'HiraginoSans-W3'],
};

/**
 * 固定的 ES3 程式（DATA 在前面）。改這裡要記得：沒有 let / const / 箭頭函式 / 樣板字串 / forEach / indexOf / JSON。
 * 分三段：RUNNER_COMMON（兩種腳本共用的小工具：問長度、寫對位圖檔、放圖、畫外框）、
 * RUNNER_COMP（整張畫布的合成：外框 + 名字標籤）、RUNNER_TEMPLATE（版型的合成：外框 + 模板圖，aeTemplateScript.ts 用）。
 * 新的圖層一律加在最上面 → 先放對位圖，再放外框，最後放名字。
 */
export const RUNNER_COMMON = String.raw`
var UI = DATA.ui;
function fmt(s) {
  var args = arguments;
  return String(s).replace(/\{(\d+)\}/g, function (m, i) {
    var v = args[parseInt(i, 10) + 1];
    return v === undefined ? m : String(v);
  });
}
function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }
function parseDuration(text) {
  var t = trim(text).split(String.fromCharCode(65306)).join(":");
  if (t === "") return -1;
  var parts = t.split(":");
  if (parts.length > 3) return -1;
  var total = 0;
  for (var i = 0; i < parts.length; i++) {
    if (!/^\d+(\.\d+)?$/.test(parts[i])) return -1;
    var v = parseFloat(parts[i]);
    if (i > 0 && v >= 60) return -1;
    total = total * 60 + v;
  }
  return total;
}
function clockText(sec) {
  var s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  return h > 0 ? h + ":" + pad(m) + ":" + pad(r) : m + ":" + pad(r);
}
function askDuration(ask, def) {
  var msg = ask, dur = -1;
  while (dur < 0) {
    var ans = prompt(msg, def, UI.title);
    if (ans === null || ans === undefined) return -1;
    dur = parseDuration(ans);
    if (dur < 1 || dur > 10800) { dur = -1; msg = UI.badDuration + "\n\n" + ask; def = ans; }
  }
  return dur;
}
function canWriteFiles() {
  try { return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1; } catch (e) { return true; }
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var LUT = {};
for (var bi = 0; bi < 64; bi++) LUT[B64.charAt(bi)] = bi;
function decodeChunk(s) {
  var out = [];
  for (var p = 0; p + 3 < s.length; p += 4) {
    var c2 = s.charAt(p + 2), c3 = s.charAt(p + 3);
    var x = (LUT[s.charAt(p)] << 18) | (LUT[s.charAt(p + 1)] << 12) | ((c2 === "=" ? 0 : LUT[c2]) << 6) | (c3 === "=" ? 0 : LUT[c3]);
    if (c2 === "=") out.push(String.fromCharCode((x >> 16) & 255));
    else if (c3 === "=") out.push(String.fromCharCode((x >> 16) & 255, (x >> 8) & 255));
    else out.push(String.fromCharCode((x >> 16) & 255, (x >> 8) & 255, x & 255));
  }
  return out.join("");
}
function writeMapFile() {
  var dirs = [];
  try { dirs.push(new File($.fileName).parent); } catch (e0) {}
  try { dirs.push(Folder.myDocuments); } catch (e1) {}
  try { dirs.push(Folder.temp); } catch (e2) {}
  for (var d = 0; d < dirs.length; d++) {
    try {
      if (!dirs[d] || !dirs[d].exists) continue;
      var f = new File(dirs[d].fsName + "/" + DATA.map.fileName);
      f.encoding = "BINARY";
      if (!f.open("w")) continue;
      for (var k = 0; k < DATA.map.b64.length; k++) f.write(decodeChunk(DATA.map.b64[k]));
      f.close();
      if (f.exists && f.length > 0) return f;
    } catch (e3) {}
  }
  return null;
}
function lockGuide(layer) {
  layer.guideLayer = true;
  layer.locked = true;
}
function addMap(comp, folder) {
  if (!canWriteFiles()) return UI.mapNoWrite;
  var f = writeMapFile();
  if (!f) return UI.mapWriteFailed;
  var item = app.project.importFile(new ImportOptions(f));
  item.parentFolder = folder;
  var layer = comp.layers.add(item);
  layer.name = UI.mapLayerName;
  var tr = layer.property("ADBE Transform Group");
  tr.property("ADBE Scale").setValue([DATA.width / DATA.map.width * 100, DATA.height / DATA.map.height * 100]);
  tr.property("ADBE Position").setValue([DATA.width / 2, DATA.height / 2]);
  tr.property("ADBE Opacity").setValue(DATA.mapOpacity);
  try { if (DATA.mapBlend !== "normal") layer.blendingMode = BlendingMode.SCREEN; } catch (e) {}
  lockGuide(layer);
  return fmt(UI.mapDone, f.fsName);
}
function addPanel(comp, p) {
  var layer = comp.layers.addShape();
  layer.name = p.name;
  try { layer.label = p.label; } catch (e0) {}
  if (p.comment) { try { layer.comment = p.comment; } catch (e2) {} }
  var tr = layer.property("ADBE Transform Group");
  tr.property("ADBE Anchor Point").setValue([0, 0]);
  tr.property("ADBE Position").setValue([0, 0]);
  var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  group.name = p.name;
  var vectors = group.property("ADBE Vectors Group");
  for (var k = 0; k < p.paths.length; k++) {
    var shape = new Shape();
    shape.vertices = p.paths[k].v;
    shape.closed = p.paths[k].c;
    vectors.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape").setValue(shape);
  }
  var stroke = vectors.addProperty("ADBE Vector Graphic - Stroke");
  stroke.property("ADBE Vector Stroke Color").setValue(p.color);
  stroke.property("ADBE Vector Stroke Width").setValue(DATA.strokeWidth);
  var fill = vectors.addProperty("ADBE Vector Graphic - Fill");
  fill.property("ADBE Vector Fill Color").setValue(p.color);
  fill.property("ADBE Vector Fill Opacity").setValue(DATA.fillOpacity);
  try { fill.property("ADBE Vector Fill Rule").setValue(2); } catch (e1) {}
  lockGuide(layer);
}
`;

/** 整張畫布的合成：外框 + 名字標籤 + 對位圖 */
export const RUNNER_COMP = String.raw`
function pickFont() {
  var isWin = false;
  try { isWin = /windows/i.test($.os); } catch (e0) {}
  var names = isWin ? DATA.fonts.win : DATA.fonts.mac;
  var hasFontApi = false;
  try { hasFontApi = !!(app.fonts && app.fonts.getFontsByPostScriptName); } catch (e1) {}
  if (!hasFontApi) return names[0];
  for (var i = 0; i < names.length; i++) {
    try {
      var found = app.fonts.getFontsByPostScriptName(names[i]);
      if (found && found.length > 0) return names[i];
    } catch (e2) {}
  }
  return null;
}
function addLabel(comp, lb, font) {
  var layer = comp.layers.addText(lb.text);
  layer.name = lb.layerName;
  try { layer.label = lb.label; } catch (e3) {}
  var src = layer.property("ADBE Text Properties").property("ADBE Text Document");
  var doc = src.value;
  try { doc.resetCharStyle(); } catch (e0) {}
  doc.fontSize = lb.size;
  if (font) { try { doc.font = font; } catch (e1) {} }
  doc.applyFill = true;
  doc.fillColor = [1, 1, 1];
  doc.applyStroke = true;
  doc.strokeColor = [0, 0, 0];
  doc.strokeWidth = Math.max(1, Math.round(lb.size * 0.06));
  doc.strokeOverFill = false;
  try { doc.justification = ParagraphJustification.LEFT_JUSTIFY; } catch (e2) {}
  src.setValue(doc);
  layer.property("ADBE Transform Group").property("ADBE Position").setValue(lb.pos);
  lockGuide(layer);
}
function run() {
  if (DATA.width > 30000 || DATA.height > 30000) { alert(fmt(UI.tooBig, DATA.width, DATA.height), UI.title); return; }
  var dur = askDuration(fmt(UI.askDuration, DATA.width, DATA.height, DATA.fps), DATA.defaultDuration);
  if (dur < 0) return;
  if (!app.project) app.newProject();
  var made = { panels: 0, labels: 0, map: UI.mapNone };
  var failed = null, folder = null, comp = null;
  app.beginUndoGroup(UI.undo);
  try {
    folder = app.project.items.addFolder(DATA.folderName);
    comp = app.project.items.addComp(DATA.compName, DATA.width, DATA.height, 1, dur, DATA.fps);
    comp.parentFolder = folder;
    try { comp.comment = DATA.comment; } catch (e0) {}
    if (DATA.map) {
      try { made.map = addMap(comp, folder); } catch (e1) { made.map = UI.mapWriteFailed + " (" + e1.toString() + ")"; }
    }
    for (var i = DATA.panels.length - 1; i >= 0; i--) { addPanel(comp, DATA.panels[i]); made.panels++; }
    var font = pickFont();
    for (var j = DATA.labels.length - 1; j >= 0; j--) { addLabel(comp, DATA.labels[j], font); made.labels++; }
    for (var s = 1; s <= comp.numLayers; s++) { try { comp.layer(s).selected = false; } catch (e5) {} }
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
  alert(fmt(UI.done, DATA.compName, DATA.width, DATA.height, DATA.fps, clockText(dur), made.panels, made.labels, made.map), UI.title);
}
run();
`;

/** 整張畫布的合成（完整的 ES3 程式；測試、說明都用這個名字） */
export const RUNNER = RUNNER_COMMON + RUNNER_COMP;

/** 版型的合成：版型畫布大小、每塊螢幕一個外框、模板圖放最下面（aeTemplateScript.ts 用） */
export const RUNNER_TEMPLATE = String.raw`
function run() {
  if (DATA.width > 30000 || DATA.height > 30000) { alert(fmt(UI.tooBig, DATA.width, DATA.height), UI.title); return; }
  var dur = askDuration(fmt(UI.askDuration, DATA.width, DATA.height, DATA.fps), DATA.defaultDuration);
  if (dur < 0) return;
  if (!app.project) app.newProject();
  var made = { panels: 0, map: UI.mapNone };
  var failed = null, folder = null, comp = null;
  app.beginUndoGroup(UI.undo);
  try {
    folder = app.project.items.addFolder(DATA.folderName);
    comp = app.project.items.addComp(DATA.compName, DATA.width, DATA.height, 1, dur, DATA.fps);
    try { comp.pixelAspect = 1; } catch (e6) {}
    comp.parentFolder = folder;
    try { comp.comment = DATA.comment; } catch (e0) {}
    if (DATA.map) {
      try { made.map = addMap(comp, folder); } catch (e1) { made.map = UI.mapWriteFailed + " (" + e1.toString() + ")"; }
    }
    for (var i = DATA.panels.length - 1; i >= 0; i--) { addPanel(comp, DATA.panels[i]); made.panels++; }
    for (var s = 1; s <= comp.numLayers; s++) { try { comp.layer(s).selected = false; } catch (e5) {} }
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
  alert(fmt(UI.done, DATA.compName, DATA.width, DATA.height, DATA.fps, clockText(dur), made.panels, DATA.templateName, made.map), UI.title);
}
run();
`;

export const BOM = String.fromCharCode(0xfeff);

/** 整支 .jsx（開頭有 BOM）：資料 + RUNNER，包在一個函式裡（不會留東西在 AE 的全域） */
export function buildAeCompScript(input: AeScriptInput): string {
  const { layout, projectName, date, canvasSource } = input;
  const c = layout.canvas;
  const fps = input.fps ?? 30;
  const u = unitOf(c);
  const compName = aeCompName(projectName, c);
  const panels = layout.panels.map((p, i) => ({
    name: p.name,
    color: hslToRgb01(p.hue, 0.72, 0.58),
    label: aeLabelColor(i),
    paths: panelPaths(p, c),
  }));
  const data = {
    compName,
    width: c.width,
    height: c.height,
    fps,
    defaultDuration: input.defaultDuration ?? '3:00',
    folderName: UI_TEXT.folderName,
    comment: `Stage Previz LED 對位 · 專案：${projectName || '未命名專案'} · 畫布 ${c.width} × ${c.height}（${canvasSourceText(canvasSource)}）· ${date}`,
    strokeWidth: Math.max(2, Math.round(2 * u)),
    fillOpacity: 15,
    mapOpacity: 60,
    panels,
    labels: panelLabels(layout),
    map: input.map ? { fileName: input.map.fileName, width: input.map.width, height: input.map.height, b64: chunkBase64(input.map.base64) } : null,
    fonts: FONTS,
    ui: UI_TEXT,
  };
  const header = [
    '// Stage Previz：AE 一鍵建合成',
    `// 專案：${commentSafe(projectName || '未命名專案')}　畫布：${c.width} × ${c.height}　LED ${layout.panels.length} 塊　${date}`,
    '// 用法：After Effects → File > Scripts > Run Script File…（檔案 > 指令碼 > 執行指令碼檔案）選這個檔案',
    `// 會建一個 ${c.width} × ${c.height}、${fps} fps 的合成，每塊 LED 一個外框和名字（導引圖層、鎖住，不會算圖出去）`,
    '// AE 2020 以後的版本，Windows / Mac 都可以',
    '//@target aftereffects',
  ];
  return assembleScript(header, data, RUNNER);
}

/** 整支 .jsx：BOM + 說明註解（每行已經是 // 開頭）+ 包在函式裡的「資料 + 固定程式」（版型的腳本也用這個） */
export function assembleScript(headerLines: readonly string[], data: unknown, runner: string): string {
  return BOM + headerLines.join('\n') + '\n(function () {\nvar DATA = ' + es3Literal(data) + ';\n' + runner + '})();\n';
}

/** base64（瀏覽器的 Blob → AE 腳本裡的字） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}
