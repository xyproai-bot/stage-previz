// LED 版型的下載（瀏覽器這一側：畫圖、組檔案、下載）：模板圖 PNG、AE 合成腳本（.jsx）、座標表（CSV / JSON）。
// 檔案裡寫什麼：aeTemplateScript.ts / ledTemplateTable.ts（純函式，有單元測試）；這裡只負責畫 PNG、包成檔案、按下載。
// 編輯器（LedTemplatesDialog）和 3D 工具列的「⋯」選單（StageScene）共用。

import { AE_MAX_COMP_SIDE, blobToBase64, type AeMapImage } from './aeCompScript';
import { AE_MAP_MAX_SIDE, AeCanvasTooBigError } from './aeCompScriptDownload';
import { aeTemplateGuideFileName, aeTemplateScriptFileName, buildAeTemplateScript } from './aeTemplateScript';
import type { CanvasSize } from './ledMap';
import { downloadBlob } from './ledMapDraw';
import type { LedTemplatePlan, ManualScreen, ScreenDef } from './ledTemplate';
import type { LedDownloadKind } from './ledMapMenuText';
import { renderTemplateGuidePng, renderTilePng, type GuideContent, type TemplateGuidePng } from './ledTemplateDraw';
import { buildAeTilesScript, layoutFromDefs, TILES_DIR, tilesOf, tilesToCsv, tilesZipFileName } from './ledTemplateTiles';
import { buildZip, type ZipEntry } from './zipStore';
import type { LedLayout } from './ledMap';
import { splitLayoutByScreens } from './ledTemplateContent';
import { applyCabinets } from './ledCabinet';
import { guideFileName } from './ledTemplatePattern';
import { templateTableFileName, templateTableToCsv, templateTableToJson, timelineTableFileName, timelineTableToCsv, timelineTableToJson } from './ledTemplateTable';
import { buildAeTimelineScript, timelineTilePath, timelineTilePlans, timelineTilesToCsv, timelineZipFileName } from './aeTimelineScript';
import { timelineCanvas, type LedTimeline } from './ledTemplateTimeline';

export interface TemplateDownloadMeta {
  /** 整張畫布的測試圖排法（編輯器有 3D 的物件範圍時給；沒給就用螢幕清單的範圍排） */
  layout?: LedLayout | null;
  projectName: string;
  /** yyyy-mm-dd */
  date: string;
  /** 專案的 LED 畫布（整張畫布） */
  fullCanvas: CanvasSize;
}

/** 模板圖 PNG（版型畫布的原尺寸；瀏覽器畫不了就縮小，檔名會加「-縮小N%」） */
export async function renderTemplateGuideFile(plan: LedTemplatePlan, defs: readonly ScreenDef[], projectName: string, content: GuideContent | null = null): Promise<{ png: TemplateGuidePng; fileName: string }> {
  const png = await renderTemplateGuidePng(plan, defs, { content });
  let fileName = guideFileName(projectName, plan);
  if (png.scale < 1) fileName = fileName.replace(/\.png$/, `-縮小${Math.round(png.scale * 100)}%.png`);
  return { png, fileName };
}

/** 每塊螢幕畫網站上那張測試圖要的東西（整張畫布不知道大小 = null，畫舊的簡單方塊） */
export function guideContentFor(defs: readonly ScreenDef[], meta: Pick<TemplateDownloadMeta, 'fullCanvas' | 'layout'>, plan?: Pick<LedTemplatePlan, 'cabinet' | 'screens'> | null): GuideContent | null {
  const full = meta.fullCanvas;
  const base = meta.layout ?? (full && full.width > 0 && full.height > 0 ? layoutFromDefs(defs, full) : null);
  if (!base) return null;
  // 一個物件裡好幾塊 LED：每塊各自一格測試圖（名稱、座標、外框顏色都是自己的）
  // 網格一格 = 一片 LED 箱體（版型設的大小；沒設 = 128 × 128）
  const layout = applyCabinets(splitLayoutByScreens(base, defs), plan);
  const byKey = new Map(defs.map(d => [d.key, d.src]));
  return { layout, spanOf: k => byKey.get(k) ?? null };
}

/**
 * 「每塊 LED 一張圖」的 zip：每塊一張 PNG（大小 = 這塊在版型畫布上的像素大小）放在 tiles 資料夾，
 * 加座標表 CSV 和 AE 腳本（每塊 LED 一個合成 + 一個整張畫布大小的總合成）。
 */
export async function downloadTemplateTilesZip(
  plan: LedTemplatePlan, defs: readonly ScreenDef[], meta: TemplateDownloadMeta, onProgress?: (done: number, total: number) => void,
): Promise<{ fileName: string; count: number; shrunk: boolean }> {
  const content = guideContentFor(defs, meta, plan);
  if (!content) throw new Error('還沒填這個專案的 LED 畫布大小');
  const { tiles, items } = tilesOf(plan, defs);
  const entries: ZipEntry[] = [];
  let shrunk = false;
  for (let i = 0; i < items.length; i++) {
    const span = content.spanOf(items[i].key);
    if (!span) continue;
    const png = await renderTilePng(items[i], span, content.layout);
    if (png.scale < 1) shrunk = true;
    entries.push({ path: `${TILES_DIR}/${tiles[i].fileName}`, data: new Uint8Array(await png.blob.arrayBuffer()) });
    onProgress?.(i + 1, items.length);
  }
  const enc = new TextEncoder();
  const script = buildAeTilesScript({ plan, tiles, projectName: meta.projectName, date: meta.date });
  entries.unshift(
    { path: 'AE建合成腳本.jsx', data: enc.encode(script) },
    { path: '座標表.csv', data: enc.encode(tilesToCsv(tiles)) },
  );
  const fileName = tilesZipFileName(meta.projectName, plan);
  downloadBlob(buildZip(entries), fileName);
  return { fileName, count: tiles.length, shrunk };
}

/** 模板圖縮小了，要告訴使用者怎麼在 AE 裡放大回來 */
export function guideShrinkWarning(png: Pick<TemplateGuidePng, 'scale' | 'width' | 'height'>, canvas: CanvasSize): string {
  return `這台電腦的瀏覽器畫不出 ${canvas.width}×${canvas.height} 的原尺寸，圖縮成 ${png.width}×${png.height}（${Math.round(png.scale * 100)}%）：在 AE 裡把這個圖層放大成 ${Math.round(100 / png.scale)}% 就能對上。要原尺寸請換一台記憶體大一點的電腦。`;
}

/** 下載 AE 合成腳本（.jsx）；模板圖夾在腳本裡（小一點的版本，畫不出來就只放外框）；回傳有沒有夾到圖 */
export async function downloadTemplateAeScript(
  plan: LedTemplatePlan, defs: readonly ScreenDef[], meta: Pick<TemplateDownloadMeta, 'projectName' | 'date'>,
): Promise<{ withGuide: boolean; fileName: string }> {
  const { width, height } = plan.canvas;
  if (width > AE_MAX_COMP_SIDE || height > AE_MAX_COMP_SIDE) {
    throw new AeCanvasTooBigError(`版型畫布 ${width} × ${height} 超過 AE 合成的上限 ${AE_MAX_COMP_SIDE} px`);
  }
  let guide: AeMapImage | null = null;
  try {
    const png = await renderTemplateGuidePng(plan, defs, { maxSide: AE_MAP_MAX_SIDE });
    guide = {
      fileName: aeTemplateGuideFileName(meta.projectName, plan.name, plan.canvas),
      width: png.width, height: png.height, base64: await blobToBase64(png.blob),
    };
  } catch (e) {
    console.warn('[aeTemplateScript] 模板圖沒畫出來，腳本只放外框', e);
  }
  const js = buildAeTemplateScript({ plan, defs, projectName: meta.projectName, date: meta.date, guide });
  const fileName = aeTemplateScriptFileName(meta.projectName, plan.name, plan.canvas);
  downloadBlob(new Blob([js], { type: 'application/javascript;charset=utf-8' }), fileName);
  return { withGuide: !!guide, fileName };
}

/**
 * 這首歌選的版型（3D 工具列「⋯」的下載跟著它）：版型排法 + 專案手動切的螢幕（算螢幕清單用）。
 * 這首歌有中途換版型（timeline）時，plan 是開頭的版型，下載整條時間線（每個版型一份）
 */
export interface LedSongTemplate { plan: LedTemplatePlan; manuals: readonly ManualScreen[]; timeline?: LedTimeline | null; songName?: string }

/** 下載完要跳的小提示 */
export interface LedDownloadNotice { level: 'success' | 'warn' | 'error'; text: string; duration?: number }

/**
 * 3D 工具列「⋯」→ LED 對位圖：這首歌用了版型時，四個下載（對位圖 PNG / AE 合成腳本 / 位置表 CSV / JSON）照版型出。
 * defs = 3D 畫面現在的螢幕清單（buildScreenList）；出了什麼事都不丟錯，回傳要跳的提示。
 */
export async function downloadSongTemplateFile(
  kind: LedDownloadKind, plan: LedTemplatePlan, defs: readonly ScreenDef[], meta: TemplateDownloadMeta,
): Promise<LedDownloadNotice> {
  const keys = new Set(defs.map(d => d.key));
  const shown = { ...plan, screens: plan.screens.filter(p => keys.has(p.key)) };
  if (shown.screens.length === 0) {
    return { level: 'error', text: `版型「${plan.name}」裡還沒有螢幕，或模型裡找不到它們（要等模型載好）` };
  }
  try {
    if (kind === 'png') {
      const { png, fileName } = await renderTemplateGuideFile(shown, defs, meta.projectName, guideContentFor(defs, meta, shown));
      downloadBlob(png.blob, fileName);
      return png.scale < 1
        ? { level: 'warn', text: guideShrinkWarning(png, shown.canvas), duration: 8000 }
        : { level: 'success', text: `版型「${plan.name}」的模板圖下載好了（${png.width}×${png.height}）` };
    }
    if (kind === 'jsx') {
      const r = await downloadTemplateTilesZip(shown, defs, meta);
      return {
        level: r.shrunk ? 'warn' : 'success', duration: 9000,
        text: `版型「${plan.name}」每塊 LED 的圖（${r.count} 塊）和 AE 腳本下載好了：解壓縮後，在 AE 按「File > Scripts > Run Script File…」選裡面的 AE建合成腳本.jsx`,
      };
    }
    downloadTemplateTable(kind, shown, defs, meta);
    return { level: 'success', text: `版型「${plan.name}」的座標表下載好了（${kind === 'csv' ? 'CSV，Excel 打得開' : 'JSON'}）` };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { level: 'error', text: (e instanceof AeCanvasTooBigError ? '' : '沒有下載成功：') + reason };
  }
}

/** 下載座標表（CSV 前面有 BOM，Excel 看得到中文） */
export function downloadTemplateTable(kind: 'csv' | 'json', plan: LedTemplatePlan, defs: readonly ScreenDef[], meta: TemplateDownloadMeta): string {
  const fileName = templateTableFileName(kind, meta.projectName, plan);
  const text = kind === 'csv' ? templateTableToCsv(plan, defs, meta) : templateTableToJson(plan, defs, meta);
  downloadBlob(new Blob([text], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }), fileName);
  return fileName;
}

// ───────────────────────── 版型時間線（同一首歌中途換版型）─────────────────────────

/** 每一段只留模型裡找得到的螢幕 */
function shownTimeline(tl: LedTimeline, defs: readonly ScreenDef[]): LedTimeline {
  const keys = new Set(defs.map(d => d.key));
  return { v: 1, segments: tl.segments.map(s => ({ ...s, plan: { ...s.plan, screens: s.plan.screens.filter(p => keys.has(p.key)) } })) };
}

/** 時間線裡每個版型各一份（同一個版型出現好幾段只算一次，照第一次出現的順序） */
function distinctPlans(tl: LedTimeline): { id: string; plan: LedTemplatePlan }[] {
  const out: { id: string; plan: LedTemplatePlan }[] = [];
  for (const s of tl.segments) if (!out.some(x => x.id === s.templateId)) out.push({ id: s.templateId, plan: s.plan });
  return out;
}

/** 下載時間線座標表（CSV 前面有 BOM，Excel 看得到中文） */
export function downloadTimelineTable(kind: 'csv' | 'json', tl: LedTimeline, defs: readonly ScreenDef[], meta: TemplateDownloadMeta & { songName?: string }): string {
  const fileName = timelineTableFileName(kind, meta.projectName, meta.songName, timelineCanvas(tl));
  const text = kind === 'csv' ? timelineTableToCsv(tl, defs, meta) : timelineTableToJson(tl, defs, meta);
  downloadBlob(new Blob([text], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }), fileName);
  return fileName;
}

/**
 * 下載版型時間線的 zip：tiles 資料夾裡每個版型一個資料夾（每塊 LED 一張 PNG）、座標表（每個版型一段）、
 * AE 腳本（每個版型的每塊 LED 一個合成 + 一個整張畫布大小的總合成，每一段只放那個版型的合成，換版型的時間有標記）
 */
export async function downloadTimelineTilesZip(
  tl: LedTimeline, defs: readonly ScreenDef[], meta: TemplateDownloadMeta & { songName?: string }, onProgress?: (done: number, total: number) => void,
): Promise<{ fileName: string; count: number; plans: number; shrunk: boolean }> {
  const canvas = timelineCanvas(tl);
  if (canvas.width > AE_MAX_COMP_SIDE || canvas.height > AE_MAX_COMP_SIDE) {
    throw new AeCanvasTooBigError(`版型畫布 ${canvas.width} × ${canvas.height} 超過 AE 合成的上限 ${AE_MAX_COMP_SIDE} px`);
  }
  const plans = timelineTilePlans(tl, defs);
  const entries: ZipEntry[] = [];
  let shrunk = false, done = 0;
  const total = plans.reduce((n, p) => n + p.tiles.length, 0);
  for (const p of plans) {
    const plan = tl.segments.find(s => s.templateId === p.id)!.plan;
    const content = guideContentFor(defs, meta, plan);
    if (!content) throw new Error('還沒填這個專案的 LED 畫布大小');
    const { items } = tilesOf(plan, defs);
    for (let i = 0; i < items.length; i++) {
      const span = content.spanOf(items[i].key);
      if (span) {
        const png = await renderTilePng(items[i], span, content.layout);
        if (png.scale < 1) shrunk = true;
        entries.push({ path: timelineTilePath(p, p.tiles[i]), data: new Uint8Array(await png.blob.arrayBuffer()) });
      }
      onProgress?.(++done, total);
    }
  }
  const enc = new TextEncoder();
  const script = buildAeTimelineScript({ timeline: tl, defs, projectName: meta.projectName, songName: meta.songName, date: meta.date });
  entries.unshift(
    { path: 'AE建合成腳本.jsx', data: enc.encode(script) },
    { path: '座標表.csv', data: enc.encode(timelineTilesToCsv(tl, plans)) },
  );
  const fileName = timelineZipFileName(meta.projectName, meta.songName, canvas);
  downloadBlob(buildZip(entries), fileName);
  return { fileName, count: total, plans: plans.length, shrunk };
}

/**
 * 3D 工具列「⋯」→ LED 對位圖：這首歌有中途換版型時，四個下載照整條時間線出
 *   模板圖 = 每個版型各一張（一次下載好幾個檔案）、AE 合成腳本 = zip（每個版型一個資料夾的每塊 LED 圖 + 座標表 + 腳本）、座標表 = 每個版型一個區段
 */
export async function downloadSongTimelineFile(
  kind: LedDownloadKind, timeline: LedTimeline, defs: readonly ScreenDef[], meta: TemplateDownloadMeta & { songName?: string },
): Promise<LedDownloadNotice> {
  const shown = shownTimeline(timeline, defs);
  if (shown.segments.every(s => s.plan.screens.length === 0)) {
    return { level: 'error', text: '這首歌的版型時間線裡還沒有螢幕，或模型裡找不到它們（要等模型載好）' };
  }
  try {
    if (kind === 'png') {
      const plans = distinctPlans(shown);
      let shrunk: string | null = null;
      for (let i = 0; i < plans.length; i++) {
        const { png, fileName } = await renderTemplateGuideFile(plans[i].plan, defs, meta.projectName, guideContentFor(defs, meta, plans[i].plan));
        downloadBlob(png.blob, fileName);
        if (png.scale < 1 && !shrunk) shrunk = guideShrinkWarning(png, plans[i].plan.canvas);
        if (i + 1 < plans.length) await new Promise(r => setTimeout(r, 400));   // 連續下載幾個檔案，瀏覽器才不會當成一個
      }
      return shrunk
        ? { level: 'warn', text: shrunk, duration: 8000 }
        : { level: 'success', text: `版型時間線的模板圖下載好了（${plans.length} 個版型，每個一張）；瀏覽器問「下載多個檔案」請按允許` };
    }
    if (kind === 'jsx') {
      // 整條時間線只有一個版型：跟單一版型的 zip 一樣
      const only = distinctPlans(shown);
      if (only.length === 1) {
        const r = await downloadTemplateTilesZip(only[0].plan, defs, meta);
        return {
          level: r.shrunk ? 'warn' : 'success', duration: 9000,
          text: `版型「${only[0].plan.name}」每塊 LED 的圖（${r.count} 塊）和 AE 腳本下載好了：解壓縮後，在 AE 按「File > Scripts > Run Script File…」選裡面的 AE建合成腳本.jsx`,
        };
      }
      const r = await downloadTimelineTilesZip(shown, defs, meta);
      return {
        level: r.shrunk ? 'warn' : 'success', duration: 9000,
        text: `版型時間線每塊 LED 的圖（${r.plans} 個版型、共 ${r.count} 塊）和 AE 腳本下載好了：解壓縮後，在 AE 按「File > Scripts > Run Script File…」選裡面的 AE建合成腳本.jsx`,
      };
    }
    downloadTimelineTable(kind, shown, defs, meta);
    return { level: 'success', text: `版型時間線的座標表下載好了（${kind === 'csv' ? 'CSV，Excel 打得開' : 'JSON'}）` };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { level: 'error', text: (e instanceof AeCanvasTooBigError ? '' : '沒有下載成功：') + reason };
  }
}
