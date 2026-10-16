// 自動貼 UV：畫面上的白話文字（集中放，測試可以檢查措辭）

import { DISTORTION_OK, DISTORTION_WARN, type DistortionStat, type SurfaceOverride, type UnsupportedKind } from './surfaces';

export const UNSUPPORTED_TEXT: Record<UnsupportedKind, string> = {
  arc: '這塊是彎的，但不是標準的圓柱（弧形不規則），自由曲面第 4 階段才支援，先保留原本的 UV',
  fold: '這塊有折角（不是平面也不是圓柱），第 4 階段才支援，先保留原本的 UV',
  other: '這塊不是平面也不是圓柱，自由曲面第 4 階段才支援，先保留原本的 UV',
  toomany: '這個物件分成超過 8 片，第 4 階段之後才支援',
  empty: '這個物件沒有可以貼的面',
  closed: '這塊是整圈 360 度的圓柱，接縫要拆頂點，第 4 階段才支援，先保留原本的 UV',
  arcfail: '這塊沒辦法當弧面貼（太平、不是圓柱，或整圈 360 度），請改回「自動」或選「平面」',
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

/** 類型下拉選單 */
export const OVERRIDE_LABEL: Record<SurfaceOverride, string> = {
  auto: '自動辨識',
  flat: '平面',
  arc: '弧面',
};
export const OVERRIDE_HINT = '辨識錯了可以手動指定：選「平面」會把整塊壓成一個平面（弧面會變形），選「弧面」會當成圓柱的一段攤平';

export const BLOCKED_TEXT = {
  noSelection: '還沒有選任何要自動貼的螢幕',
  size: (name: string, why: string) => `「${name}」：${why}`,
  canvasTooBig: (w: number, h: number) => `排出來的畫布是 ${w} × ${h}，一邊超過 32768（畫布的上限），請改小點數或少選幾塊`,
  wrapKeep: (name: string) => `「${name}」原本的畫面橫跨畫布邊緣，又已經手動切成幾塊，第 3 階段才支援`,
} as const;

const pct = (v: number): string => {
  const p = v * 100;
  if (p === 0) return '0';
  if (p < 0.05) return '< 0.1';
  return p < 10 ? p.toFixed(1) : p.toFixed(0);
};

export type DistortionLevel = 'ok' | 'warn' | 'bad';

/** 變形程度：以最大的那個三角形為準（看得到的最糟情況） */
export function distortionLevel(d: DistortionStat): DistortionLevel {
  const v = d.max;
  return v <= DISTORTION_OK ? 'ok' : v <= DISTORTION_WARN ? 'warn' : 'bad';
}

/** 一行字：變形百分比 + 白話說明 */
export function distortionText(d: DistortionStat): string {
  const lv = distortionLevel(d);
  const nums = `最大 ${pct(d.max)}%、平均 ${pct(d.mean)}%`;
  if (lv === 'ok') return `變形 ${pct(d.max)}%（${nums}）：沒有拉伸`;
  if (lv === 'warn') return `輕微拉伸 ${pct(d.max)}%（${nums}）`;
  return `會變形 ${pct(d.max)}%（${nums}）：這塊建議在 C4D 手動展開，或選「保留原本 UV」`;
}

/** 不能貼的曲面：硬貼會變形多少 */
export function freeformText(f: { distortion: DistortionStat; via: 'flat' | 'arc' }): string {
  const how = f.via === 'arc' ? '當成圓柱' : '壓成平面';
  return `硬把它${how}貼，最大會變形 ${pct(f.distortion.max)}%（平均 ${pct(f.distortion.mean)}%）`;
}

/** 弧面的白話：凸 / 凹、角度 */
export function arcText(convex: boolean, spanDeg: number): string {
  return `弧面 · ${convex ? '凸（外面看）' : '凹（裡面看）'} · ${Math.round(spanDeg)}°`;
}
