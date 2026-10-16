// 自動貼 UV：畫面上的白話文字（集中放，測試可以檢查措辭）

import type { UnsupportedKind } from './surfaces';

export const UNSUPPORTED_TEXT: Record<UnsupportedKind, string> = {
  arc: '這塊是弧面，第 2 階段才支援',
  fold: '這塊有折角，第 2 階段之後才支援',
  other: '這塊不是單一平面，第 2 階段之後才支援',
  toomany: '這個物件分成超過 8 片，第 2 階段之後才支援',
  empty: '這個物件沒有可以貼的面',
};

export const SPLITS_TEXT = '這塊已經手動切成幾塊螢幕，第 3 階段才支援';
export const NO_UV_TEXT = '這個物件原本沒有 UV，也不是平面，沒辦法保留';
export const MISSING_TEXT = '模型裡找不到這個物件（物件名稱跟模型不一樣）';
export const KEEP_TEXT = '保留原本的 UV，只搬到新位置（大小、方向、每個點的對應都不變）';

export const MODE_TEXT = {
  auto: '自動貼',
  keep: '保留原本 UV',
  none: '不處理',
  missing: '找不到',
} as const;

export const BLOCKED_TEXT = {
  noSelection: '還沒有選任何要自動貼的螢幕',
  size: (name: string, why: string) => `「${name}」：${why}`,
  canvasTooBig: (w: number, h: number) => `排出來的畫布是 ${w} × ${h}，一邊超過 32768（畫布的上限），請改小點數或少選幾塊`,
  wrapKeep: (name: string) => `「${name}」原本的畫面橫跨畫布邊緣，又已經手動切成幾塊，第 3 階段才支援`,
} as const;
