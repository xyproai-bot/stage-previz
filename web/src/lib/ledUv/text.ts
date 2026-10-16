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

export const SPLITS_TEXT = '這塊已經手動切成幾塊螢幕，目前還不能自動貼，先保留原本的 UV（可以搬位置）';
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
  wrapKeep: (name: string) => `「${name}」原本的畫面橫跨畫布邊緣，又已經手動切成幾塊，目前還不支援`,
  outside: (names: string[]) => `有 ${names.length} 塊螢幕超出畫布（${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}）：把畫布加大，或把它們移進畫布裡`,
} as const;

export const WARN_TEXT = {
  overlap: (n: number, a: string, b: string) => `有 ${n} 組螢幕互相重疊（例如「${a}」和「${b}」）：重疊的地方兩塊會顯示同一段畫面`,
} as const;

/** 第 3 步「排版」畫面上的字 */
export const ARRANGE_TEXT = {
  empty: '還沒有可以排的螢幕：先在「1 選螢幕」勾要自動貼的螢幕，再到「2 解析度」把點數填好。',
  canvasGroup: '畫布大小',
  canvasAuto: '剛好包住螢幕',
  canvasAutoHint: '畫布的寬高自動剛好包住全部螢幕（進位到 8 的倍數）。直接在旁邊的欄位打數字，就會變成「自己填大小」。',
  canvasCustom: '自己填大小',
  canvasCustomHint: '畫布寬 × 高照你填的（例如寬 8800）。螢幕超出畫布會標紅，而且不能套用。',
  topLeft: '全部靠左上',
  topLeftHint: '整組一起平移，讓最左、最上的螢幕貼著畫布的左上角。螢幕之間的相對位置不變，貼好的還是貼著。',
  alreadyTopLeft: '已經貼著畫布的左上角了',
  autoOnce: '自動排一次',
  autoOnceHint: '全部螢幕照舞台的樣子重排一次（位置、轉動、翻轉會重來；畫布大小的設定和「連在一起」的組不變）。排錯了可以按復原。',
  alreadyAuto: '已經是自動排的樣子了',
  gutterHint: '自動排版時螢幕之間空幾個點（預設 0）。只影響沒動過的排法和「自動排一次」。',
  join: '連在一起',
  joinHint: '把選到的螢幕綁成一組：之後點一塊就選到整組，一起移動、一起轉 90°、一起翻轉（像一張圖）。至少選 2 塊。',
  split: '拆開',
  splitHint: '把選到的螢幕所在的組拆開，各自獨立。',
  sizeLocked: '螢幕的大小是 LED 規格決定的（點距 / 總點數 / 箱體），這裡只能搬、轉 90°、翻轉，不能改大小。',
  fixedHint: '保留原本 UV 的螢幕：它的 UV 只是整片搬到新位置，所以只能搬位置，不能轉、不能翻。',
  canvasHint: '空白處拖曳框選（Shift / Ctrl 加選，Ctrl+A 全選）· 拖曳螢幕移動，選了好幾塊（或連在一起的）就一起動 · 方向鍵微調 1 像素（Shift 10 像素）· 靠近別塊螢幕的邊或畫布的邊會吸附，邊對邊貼在一起很容易（Alt 不吸附）· 螢幕的大小是 LED 規格決定的，不能縮放 · 滾輪縮放 · 按住空白鍵拖曳、滑鼠中鍵拖曳或雙指平移',
  outside: (names: string[]) => `有 ${names.length} 塊螢幕超出畫布（${names.slice(0, 4).join('、')}${names.length > 4 ? '…' : ''}）：把畫布加大，或把它們拖進畫布裡，否則不能套用`,
  overlap: (pairs: string[], n: number) => `有 ${n} 組螢幕互相重疊（${pairs.join('；')}${n > pairs.length ? '…' : ''}）：重疊的地方兩塊會顯示同一段畫面`,
  multiHint: '畫布上方的「轉 90°」「左右翻轉」「上下翻轉」：連在一起的整組一起轉 / 翻，其餘的各自在原地轉 / 翻。',
  pickHint: '點畫布上的螢幕（或右邊清單裡的名字）來選它，就能在這裡改位置、轉動、翻轉。按住 Shift 或 Ctrl 可以加選，在畫布空白處拖曳可以框選好幾塊。',
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
