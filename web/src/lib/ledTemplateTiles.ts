// LED 版型的「每塊 LED 一張圖」：下載 zip（每塊一張 PNG + 座標表 CSV + AE 腳本）用的純函式部分
//   - 每塊的圖大小 = 那塊在版型畫布上的像素大小；內容 = 整張模板圖裡那一塊（旋轉、翻轉都已經畫進去，跟畫布上看到的一樣）
//   - AE 腳本：每塊一個合成（參考圖層設成導引圖層，不輸出）+ 一個整張版型畫布大小的總合成（每塊的合成擺在正確位置）= 最後輸出給 LED 的畫面
// 畫圖在 ledTemplateTilesDraw.ts；這裡不碰 canvas，ledTemplateTiles.test.ts 有測。

import { assembleScript, commentSafe } from './aeCompScript';
import { aeTemplateCompName, normalizeAeFps } from './aeTemplateScript';
import { buildLedLayout, csvCell, safeName, type CanvasSize, type LedLayout } from './ledMap';
import type { LedTemplatePlan, ScreenDef } from './ledTemplate';
import { spanTriangles } from './ledTemplateContent';
import { layoutPattern, type PatternItem } from './ledTemplatePattern';

export interface TileInfo {
  key: string;
  name: string;
  /** zip 裡的檔名（不含資料夾），不重複 */
  fileName: string;
  x: number; y: number; w: number; h: number;
  rotate: number;
  flipH: boolean;
  flipV: boolean;
  /** 螢幕的上方指哪裡 */
  upText: string;
}

/** 名字 → 檔名（不能用在檔名的字換成 _；重名加 -2、-3，大小寫不分） */
export function tileFileNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map(n => {
    const base = (safeName(n).replace(/^\.+/, '').replace(/[. ]+$/, '') || '螢幕').slice(0, 80);
    let name = base, i = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${i++}`;
    used.add(name.toLowerCase());
    return `${name}.png`;
  });
}

export function tilesOf(plan: Pick<LedTemplatePlan, 'screens'>, defs: readonly ScreenDef[]): { tiles: TileInfo[]; items: PatternItem[] } {
  const items = layoutPattern(plan, defs);
  const files = tileFileNames(items.map(i => i.name));
  const tiles = items.map((it, i) => ({
    key: it.key, name: it.name, fileName: files[i],
    x: it.dest.x, y: it.dest.y, w: it.dest.w, h: it.dest.h,
    rotate: it.rotate as number, flipH: it.flipH, flipV: it.flipV, upText: it.upText as string,
  }));
  return { tiles, items };
}

/** 沒有 3D 的物件範圍時，用螢幕清單的範圍排一份整張畫布的測試圖排法（每塊螢幕一塊） */
export function layoutFromDefs(defs: readonly ScreenDef[], canvas: CanvasSize): LedLayout {
  return buildLedLayout(defs.map(d => ({ id: d.key, name: d.name, tris: spanTriangles(d.src) })), canvas);
}

/** 座標表 CSV：名稱、x、y、w、h、旋轉、左右翻、上下翻、檔名（Excel 打得開：BOM + CRLF） */
export function tilesToCsv(tiles: readonly TileInfo[]): string {
  const rows: (string | number)[][] = [['名稱', 'x', 'y', 'w', 'h', '旋轉', '左右翻', '上下翻', '檔名']];
  for (const t of tiles) rows.push([t.name, t.x, t.y, t.w, t.h, t.rotate, t.flipH ? '是' : '否', t.flipV ? '是' : '否', t.fileName]);
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const TILES_DIR = 'tiles';

const UI = {
  noFolder: '找不到每塊 LED 的圖（tiles 資料夾）。\n請把 zip 完整解壓縮，再選解壓縮出來的資料夾（有 tiles 資料夾的那一層）。',
  pick: '選解壓縮出來的資料夾',
  askLen: '合成長度（秒）',
  missing: '這些圖找不到，沒有建：\n',
  undo: 'Stage Previz 建 LED 版型合成',
  done: '建好了。\n\n總合成「{0}」（{1} × {2}）：每塊 LED 的合成已經擺在正確位置，輸出這個就是給 LED 的畫面。\n每塊 LED 的合成共 {3} 個：把動畫素材放進去（參考圖層是導引圖層，不會輸出）。',
};

const RUNNER = `
var scriptFile = new File($.fileName);
var root = scriptFile.parent;
var tilesDir = new Folder(root.fsName + "/" + DATA.tilesDir);
if (!tilesDir.exists) {
  var pick = Folder.selectDialog(DATA.ui.pick);
  if (pick) { root = pick; tilesDir = new Folder(root.fsName + "/" + DATA.tilesDir); }
}
if (!tilesDir.exists) { alert(DATA.ui.noFolder); return; }
if (!app.project) app.newProject();
var secs = parseFloat(prompt(DATA.ui.askLen, "10"));
if (!(secs > 0)) secs = 10;
app.beginUndoGroup(DATA.ui.undo);
var missing = [];
var folder = app.project.items.addFolder(DATA.folderName);
var main = app.project.items.addComp(DATA.mainName, DATA.width, DATA.height, 1, secs, DATA.fps);
main.parentFolder = folder;
main.comment = DATA.comment;
for (var i = 0; i < DATA.tiles.length; i++) {
  var t = DATA.tiles[i];
  var f = new File(tilesDir.fsName + "/" + t.file);
  if (!f.exists) { missing.push(t.file); continue; }
  var io = new ImportOptions(f);
  var footage = app.project.importFile(io);
  footage.parentFolder = folder;
  var comp = app.project.items.addComp(t.name, t.w, t.h, 1, secs, DATA.fps);
  comp.parentFolder = folder;
  comp.comment = t.comment;
  var ref = comp.layers.add(footage);
  ref.name = DATA.refLayerName;
  if (footage.width !== t.w || footage.height !== t.h) {
    ref.property("Scale").setValue([t.w / footage.width * 100, t.h / footage.height * 100]);
  }
  ref.guideLayer = true;
  ref.locked = true;
  var layer = main.layers.add(comp);
  layer.name = t.name;
  layer.property("Position").setValue([t.x + t.w / 2, t.y + t.h / 2]);
  layer.comment = t.comment;
}
app.endUndoGroup();
try { main.openInViewer(); } catch (e) {}
var msg = DATA.ui.done.replace("{0}", DATA.mainName).replace("{1}", DATA.width).replace("{2}", DATA.height).replace("{3}", String(DATA.tiles.length - missing.length));
if (missing.length) msg += "\\n\\n" + DATA.ui.missing + missing.join("\\n");
alert(msg);
`;

export interface AeTilesScriptInput {
  plan: Pick<LedTemplatePlan, 'name' | 'canvas'>;
  tiles: readonly TileInfo[];
  projectName: string;
  date: string;
  fps?: number;
}

/** 每塊 LED 一個合成 + 一個整張畫布大小的總合成的 AE 腳本（圖檔從腳本旁邊的 tiles 資料夾讀） */
export function buildAeTilesScript(input: AeTilesScriptInput): string {
  const { plan, tiles, projectName } = input;
  const c = plan.canvas;
  const data = {
    tilesDir: TILES_DIR,
    folderName: 'Stage Previz LED 版型',
    mainName: aeTemplateCompName(projectName, plan.name, c) + ' 輸出',
    width: c.width, height: c.height,
    fps: normalizeAeFps(input.fps),
    comment: `Stage Previz LED 版型 · 專案：${commentSafe(projectName || '未命名專案')} · 版型：${commentSafe(plan.name)} · ${input.date}`,
    refLayerName: '參考圖（導引圖層，不輸出）',
    tiles: tiles.map(t => ({
      name: commentSafe(t.name), file: t.fileName, x: t.x, y: t.y, w: t.w, h: t.h,
      comment: `位置 ${t.x}, ${t.y} · ${t.w}×${t.h} 像素 · 上方${t.upText} · 轉 ${t.rotate}°${t.flipH ? ' · 左右翻' : ''}${t.flipV ? ' · 上下翻' : ''}`,
    })),
    ui: UI,
  };
  const header = [
    '// Stage Previz：AE 一鍵建 LED 版型合成（每塊 LED 一個合成）',
    `// 版型：${commentSafe(plan.name)}　畫布：${c.width} × ${c.height}　LED ${tiles.length} 塊　${input.date}`,
    '// 用法：先把 zip 解壓縮，After Effects → File > Scripts > Run Script File…（檔案 > 指令碼 > 執行指令碼檔案）選這個檔案',
    '//@target aftereffects',
  ];
  return assembleScript(header, data, RUNNER);
}

export function tilesZipFileName(projectName: string, plan: Pick<LedTemplatePlan, 'name' | 'canvas'>): string {
  return `LED每塊圖-${safeName(projectName)}-${safeName(plan.name)}-${plan.canvas.width}x${plan.canvas.height}.zip`;
}
