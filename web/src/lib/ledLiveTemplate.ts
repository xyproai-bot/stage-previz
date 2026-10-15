// 「AE 即時 / 本地檔案」也跟著這首歌選的 LED 版型（純函式，沒有畫面、不碰網路）：
//   chooseLedTemplate — 現在 LED 上這張畫面該用哪一份版型排法（給 StageScene 的 ledTemplate）
//   songTemplatePlan  — 這首歌選的版型（從專案的版型清單找；「全部」/ 沒選 / 清單裡沒有 = null）
//   ledTemplateChip   — 「LED 版型：版型 1（1920×1080）」那顆狀態標籤的字
//   liveSourceHint    — AE 畫面 / 本地檔案的大小跟版型對不上時，一句溫和的提示
//
// 規則（每個來源只認自己的那一份，不互相借）：
//   編輯版型的測試圖（版型面板開著）  → 蓋過所有東西
//   歌曲影片版本                      → 那一版自己的快照（版型之後改了也不變），沒有快照 = 整張畫布
//   AE 即時、本地檔案（「現場」來源） → 這首歌「現在」選的版型；「暫時用整張畫布看」開著 = 整張畫布
// LED 顏色、像素格的真實點數都不在這裡動（StageScene 依有沒有版型取同一套路徑）。

import { compareVideoToTemplate, type LedTemplatePlan } from './ledTemplate';
import type { CanvasSize } from './ledMap';
import type { LedTemplate, LedTemplateList } from './ledTemplateApi';

/** LED 畫面放什麼（跟 components/LedSourceSwitch 的 LedSource 一樣；這裡不 import 元件） */
export type LedSourceKind = 'version' | 'ndi' | 'file';

/** AE 即時、本地檔案：沒有「做的時候用的版型」，跟著這首歌現在選的 */
export function isLiveSource(source: LedSourceKind | null | undefined): boolean {
  return source === 'ndi' || source === 'file';
}

/** 這首歌選的版型；沒選 / 選「全部」/ 版型已經刪了（清單裡找不到）/ 清單還沒讀到 = null */
export function songTemplatePlan(list: LedTemplateList | null | undefined, templateId: string | null | undefined): LedTemplate | null {
  if (!list || !templateId) return null;
  return list.templates.find(t => t.id === templateId && t.kind === 'custom') ?? null;
}

export type LedTemplateOrigin =
  /** 版型面板開著：版型的測試圖 */
  | 'preview'
  /** 歌曲影片版本自己的快照 */
  | 'version'
  /** AE 即時 / 本地檔案：這首歌選的版型 */
  | 'song'
  /** 暫時用整張畫布看（這首歌其實有選版型） */
  | 'override'
  /** 沒有版型，整張畫布 */
  | 'none';

export interface LedTemplateChoice {
  /** 給 StageScene 的 ledTemplate；null = 整張畫布 */
  plan: LedTemplatePlan | null;
  origin: LedTemplateOrigin;
}

export interface ChooseInput {
  /** 現在 LED 放的是什麼；null = 什麼都沒選（分享連結：這首歌沒有影片） */
  source: LedSourceKind | null;
  /** 編輯版型時的測試圖用的版型（版型面板關著 = null） */
  previewPlan?: LedTemplatePlan | null;
  /** 正在放的那一版影片的版型快照（沒有 = 整張畫布） */
  versionPlan?: LedTemplatePlan | null;
  /** 這首歌選的版型（songTemplatePlan 的結果） */
  songPlan?: LedTemplatePlan | null;
  /** 「暫時用整張畫布看」（只對 AE 即時 / 本地檔案有用，不存） */
  fullView?: boolean;
}

export function chooseLedTemplate(i: ChooseInput): LedTemplateChoice {
  if (i.previewPlan) return { plan: i.previewPlan, origin: 'preview' };
  if (i.source === 'version') return i.versionPlan ? { plan: i.versionPlan, origin: 'version' } : { plan: null, origin: 'none' };
  if (isLiveSource(i.source) && i.songPlan) {
    return i.fullView ? { plan: null, origin: 'override' } : { plan: i.songPlan, origin: 'song' };
  }
  return { plan: null, origin: 'none' };
}

// ───────────────────────── 狀態標籤 ─────────────────────────

export interface LedTemplateChipInfo {
  /** 「LED 版型：版型 1（1920×1080）」/「LED 版型：全部」 */
  text: string;
  /** 滑鼠停上去的說明 */
  title: string;
  /** 有沒有「暫時用整張畫布看」可以按（AE 即時 / 本地檔案，而且這首歌有選版型） */
  canToggle: boolean;
  /** 現在正暫時用整張畫布看 */
  fullView: boolean;
}

const sizeText = (c: CanvasSize) => `${c.width}×${c.height}`;

/**
 * 狀態標籤；專案沒有任何自己排的版型、這個畫面也沒用版型 → null（不佔位子，跟沒有版型功能的專案一樣）。
 * list = null（舊的後台 / 還沒讀到）→ null
 */
export function ledTemplateChip(
  choice: LedTemplateChoice,
  opts: { source: LedSourceKind | null; songPlan: LedTemplatePlan | null; list: LedTemplateList | null | undefined },
): LedTemplateChipInfo | null {
  if (!opts.list) return null;
  const hasCustom = opts.list.templates.some(t => t.kind === 'custom');
  if (!hasCustom && !choice.plan) return null;
  const canToggle = isLiveSource(opts.source) && !!opts.songPlan && choice.origin !== 'preview';
  const fullView = choice.origin === 'override';
  const { plan } = choice;
  if (plan) {
    const text = `LED 版型：${plan.name}（${sizeText(plan.canvas)}）`;
    const title = choice.origin === 'preview'
      ? '正在編輯版型：LED 顯示的是版型的測試圖'
      : choice.origin === 'version'
        ? '這一版影片做的時候用的版型（存的是當時的排法，版型之後改了也不變）'
        : 'AE 即時、本地檔案照這首歌選的版型放到 LED 上：每塊螢幕只取版型畫布上它的那一塊';
    return { text, title, canToggle, fullView };
  }
  if (fullView && opts.songPlan) {
    return {
      text: 'LED 版型：全部（暫時）',
      title: `這首歌用的是「${opts.songPlan.name}」，現在暫時用整張畫布看（只有這個畫面，沒有存；再按一次回到版型）`,
      canToggle, fullView,
    };
  }
  return { text: 'LED 版型：全部', title: '沒有用版型：LED 上的畫面當成整張畫布', canToggle, fullView };
}

// ───────────────────────── 畫面大小 vs 版型 ─────────────────────────

export interface LiveSizeHint {
  level: 'info' | 'warn';
  kind: 'full' | 'other' | 'stretch';
  text: string;
}

/** AE 收到的畫面常縮過（Half / Third、小程序縮小），四捨五入不一定差 1 個像素內 → 寬高比差 3% 以內就算等比例 */
const LOOSE_RATIO = 0.03;

/** 這個大小是不是版型畫布的「剛好一樣大」或「等比例縮放」；loose = AE 即時用比較寬鬆的比對 */
export function fitsCanvas(frame: CanvasSize, canvas: CanvasSize, loose = false): boolean {
  if (frame.width <= 0 || frame.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return false;
  if (compareVideoToTemplate(frame, canvas).kind !== 'stretch') return true;
  if (!loose) return false;
  return Math.abs((frame.width / frame.height) / (canvas.width / canvas.height) - 1) <= LOOSE_RATIO;
}

export interface HintInput {
  choice: LedTemplateChoice;
  /** 檔案 / AE 現在的畫面大小；還不知道（沒載好、AE 還沒送畫面）= null */
  frame: CanvasSize | null;
  /** 'ndi' 的畫面叫「畫面」、比對寬鬆；'file' 叫「檔案」 */
  source: LedSourceKind | null;
  /** 專案的 LED 畫布（= 「全部」）；還沒填 = null */
  fullCanvas: CanvasSize | null;
  /** 專案裡其他自己排的版型（找「大小像哪一個」用） */
  templates: readonly { id: string | null; name: string; canvas: CanvasSize }[];
}

/**
 * 只有 AE 即時 / 本地檔案正在照這首歌的版型放（origin = song）才會提示：
 *   大小是版型畫布的 1 倍或等比例縮放 → 沒事（null）
 *   剛好是整張畫布的大小 → 「這個檔案是整張畫布的大小，但這首歌用的是「版型 1」…」
 *   像專案裡另一個版型的大小 → 提醒是不是選錯版型
 *   比例都不像 → 說會變形
 */
export function liveSourceHint(i: HintInput): LiveSizeHint | null {
  const { choice, frame } = i;
  if (choice.origin !== 'song' || !choice.plan || !frame || !isLiveSource(i.source)) return null;
  const loose = i.source === 'ndi';
  const plan = choice.plan;
  if (fitsCanvas(frame, plan.canvas, loose)) return null;
  const what = i.source === 'ndi' ? '畫面' : '檔案';
  const f = sizeText(frame);
  const t = sizeText(plan.canvas);
  const tail = `請改用 ${t} 的合成輸出`;
  if (i.fullCanvas && fitsCanvas(frame, i.fullCanvas, loose)) {
    return {
      level: 'warn', kind: 'full',
      text: `這個${what}是整張畫布的大小（${f}），但這首歌用的是「${plan.name}」（${t}）：LED 會把它當成版型的畫面來切，位置會對不上。${tail}，或按「暫時用整張畫布看」`,
    };
  }
  const other = i.templates.find(x => x.id !== plan.id && fitsCanvas(frame, x.canvas, loose));
  if (other) {
    return {
      level: 'warn', kind: 'other',
      text: `這個${what}的大小（${f}）像版型「${other.name}」（${sizeText(other.canvas)}），但這首歌用的是「${plan.name}」（${t}）。確認這首歌選對版型了嗎？${tail}`,
    };
  }
  const fit = compareVideoToTemplate(frame, plan.canvas);
  const how = fit.kind === 'stretch' ? fit.how : '左右拉寬';   // 走到這裡一定是 stretch（上面 fitsCanvas 過了就不會到）
  return {
    level: 'warn', kind: 'stretch',
    text: `這個${what}是 ${f}，版型「${plan.name}」是 ${t}，比例不一樣：畫面會被${how}（變形）。${tail}`,
  };
}
