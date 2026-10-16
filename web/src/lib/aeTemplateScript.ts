// LED 版型的「一鍵建 AE 合成」：下載一個 After Effects 腳本（.jsx），在 AE 用「File > Scripts > Run Script File…」跑，
// 自動建好「版型畫布大小」的合成（正方形像素），每塊螢幕一個外框（形狀圖層，導引圖層、鎖住），
// 並把「下載模板圖」那張版型模板圖放在最下面當參考（導引圖層、鎖住 → 不會算圖出去）。
//
// 腳本本身（問長度、寫圖檔、放圖、畫外框）跟整張畫布的 AE 合成腳本共用同一份 ES3 程式（aeCompScript.ts 的 RUNNER_COMMON）；
// 這裡只放版型自己的東西：合成名稱、每塊螢幕的外框、說明文字、檔名。純函式，aeTemplateScript.test.ts 有測，還用假的 AE 跑過一次整支腳本。
// 中文一律寫成 \uXXXX（es3String），檔案開頭有 BOM，AE 在 Windows / Mac 都不會亂碼。

import {
  RUNNER_COMMON, RUNNER_TEMPLATE, UI_TEXT, aeLabelColor, assembleScript, chunkBase64, commentSafe, hslToRgb01, rectPath, unitOf,
  type AeMapImage, type PanelPath,
} from './aeCompScript';
import { safeName, type CanvasSize } from './ledMap';
import { formatPct, type LedTemplatePlan, type ScreenDef } from './ledTemplate';
import { layoutPattern, type PatternItem } from './ledTemplatePattern';

/** 專案沒有影格速率可以用的時候的預設（跟整張畫布的 AE 合成腳本一樣） */
export const AE_DEFAULT_FPS = 30;

export type TemplatePlanLike = Pick<LedTemplatePlan, 'name' | 'canvas' | 'scalePct' | 'screens'>;

export interface AeTemplateScriptInput {
  plan: TemplatePlanLike;
  /** 螢幕清單（名字、真實點數）；版型裡找不到對應螢幕的略過 */
  defs: readonly ScreenDef[];
  projectName: string;
  /** yyyy-mm-dd */
  date: string;
  /** 專案的影格速率；不知道 / 不合理 = 30 */
  fps?: number;
  /** 問合成長度時的預設（分:秒） */
  defaultDuration?: string;
  /** 夾帶的版型模板圖（null = 不放） */
  guide?: AeMapImage | null;
}

/** 合成名稱：示範專案 - 版型 1 1920x1080 */
export function aeTemplateCompName(projectName: string, templateName: string, canvas: CanvasSize): string {
  const project = commentSafe(projectName).trim().slice(0, 80) || '未命名專案';
  const template = commentSafe(templateName).trim() || '版型';
  return `${project} - ${template} ${canvas.width}x${canvas.height}`;
}

/** 影格速率：AE 合成的範圍是 1 ~ 99；不合理就 30 */
export function normalizeAeFps(fps: number | null | undefined): number {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 1 || fps > 99) return AE_DEFAULT_FPS;
  return Math.round(fps * 1000) / 1000;
}

/** 腳本存下來的模板圖檔名：跟「下載模板圖」的檔名不一樣，存在同一個資料夾時不會蓋掉使用者自己下載的那張 */
export function aeTemplateGuideFileName(projectName: string, templateName: string, canvas: CanvasSize): string {
  return `LED版型參考-${safeName(projectName)}-${safeName(templateName)}-${canvas.width}x${canvas.height}.png`;
}

/** 下載的腳本檔名：AE合成腳本-主舞臺-版型 1-1920x1080.jsx */
export function aeTemplateScriptFileName(projectName: string, templateName: string, canvas: CanvasSize): string {
  return `AE合成腳本-${safeName(projectName)}-${safeName(templateName)}-${canvas.width}x${canvas.height}.jsx`;
}

export interface AeTemplatePanel {
  name: string;
  /** AE 的顏色 [r, g, b]（0~1），跟模板圖、3D 測試圖上這塊螢幕的顏色一樣 */
  color: [number, number, number];
  /** AE 圖層的標籤顏色（1~16） */
  label: number;
  /** 圖層的註解：位置、大小、上方朝哪裡、轉動、翻轉、實際點數 */
  comment: string;
  paths: PanelPath[];
}

/** 一塊螢幕在 AE 圖層註解裡寫什麼 */
export function panelComment(it: PatternItem): string {
  const parts = [
    `位置 ${it.dest.x}, ${it.dest.y}`,
    `${it.destText} 像素`,
    `上方${it.upText}`,
    `轉 ${it.rotate}°`,
  ];
  if (it.flipH) parts.push('左右翻');
  if (it.flipV) parts.push('上下翻');
  parts.push(`實際 ${it.nativeText}`);
  return parts.join(' · ');
}

/** 每塊螢幕一個外框（版型畫布像素，就是 dest 長方形）；順序照版型裡的放法 */
export function templatePanels(items: readonly PatternItem[]): AeTemplatePanel[] {
  return items.map(it => ({
    name: commentSafe(it.name),
    color: hslToRgb01(it.hue, 0.72, 0.58),
    label: aeLabelColor(it.index),
    comment: panelComment(it),
    paths: [rectPath(it.dest)],
  }));
}

/** 這支腳本的說明文字（跟整張畫布的腳本同一套，換成版型的說法） */
const TEMPLATE_UI = {
  ...UI_TEXT,
  tooBig: 'LED 版型畫布 {0} × {1} 超過 AE 合成的上限 30000 px，沒辦法建。請找製作確認版型的畫布大小',
  undo: 'Stage Previz 建 LED 版型合成',
  done: '建好了：\n\n合成「{0}」\n{1} × {2}、{3} fps、長度 {4}\n\n版型「{6}」的螢幕外框 {5} 塊：都是導引圖層、鎖住了，不會算圖出去。\n版型模板圖：{7}\n\n素材直接放進這個合成就好，導引圖層不會被輸出。',
  mapDone: '放好了，在最下面（導引圖層、鎖住，不會算圖出去；不要的話把眼睛關掉）。圖檔存在：{0}',
  mapNone: '這次沒有放（外框已經夠用）',
  mapLayerName: '版型模板圖（參考）',
  folderName: 'Stage Previz LED 版型',
};

/** 整支 .jsx（開頭有 BOM）：資料 + 固定的 ES3 程式，包在一個函式裡 */
export function buildAeTemplateScript(input: AeTemplateScriptInput): string {
  const { plan, projectName, date } = input;
  const c = plan.canvas;
  const fps = normalizeAeFps(input.fps);
  const items = layoutPattern(plan, input.defs);
  const project = projectName || '未命名專案';
  const u = unitOf(c);
  const data = {
    compName: aeTemplateCompName(projectName, plan.name, c),
    templateName: commentSafe(plan.name),
    width: c.width,
    height: c.height,
    fps,
    defaultDuration: input.defaultDuration ?? '3:00',
    folderName: TEMPLATE_UI.folderName,
    comment: `Stage Previz LED 版型 · 專案：${commentSafe(project)} · 版型：${commentSafe(plan.name)} · 畫布 ${c.width} × ${c.height}（比例 ${formatPct(plan.scalePct)}）· ${date}`,
    strokeWidth: Math.max(2, Math.round(2 * u)),
    fillOpacity: 15,
    mapOpacity: 100,
    mapBlend: 'normal',
    panels: templatePanels(items),
    map: input.guide ? { fileName: input.guide.fileName, width: input.guide.width, height: input.guide.height, b64: chunkBase64(input.guide.base64) } : null,
    ui: TEMPLATE_UI,
  };
  const header = [
    '// Stage Previz：AE 一鍵建 LED 版型合成',
    `// 專案：${commentSafe(project)}　版型：${commentSafe(plan.name)}　畫布：${c.width} × ${c.height}（比例 ${formatPct(plan.scalePct)}）　螢幕 ${items.length} 塊　${date}`,
    '// 用法：After Effects → File > Scripts > Run Script File…（檔案 > 指令碼 > 執行指令碼檔案）選這個檔案',
    `// 會建一個 ${c.width} × ${c.height}、${fps} fps、正方形像素的合成，每塊螢幕一個外框，版型模板圖放最下面（導引圖層、鎖住，不會算圖出去）`,
    '// AE 2020 以後的版本，Windows / Mac 都可以',
    '//@target aftereffects',
  ];
  return assembleScript(header, data, RUNNER_COMMON + RUNNER_TEMPLATE);
}
