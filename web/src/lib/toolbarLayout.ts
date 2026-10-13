// 3D 工具列放不下時怎麼收（純函式，StageToolbar 用量好的寬度呼叫）
//
// 永遠只有一排。依序試：
//   1. 全部帶字
//   2. 從最不常用的開始拿掉字（只剩圖示），常用的字留到最後；一定要看得到的（重置攝影機、移動 / 旋轉、快速 / 現場）最後才拿
//   3. 全部只剩圖示
//   4. 還是放不下 → 從最不常用的開始收進「更多」選單（⋯），直到放得下
// priority 0 = 一定要看得到，永遠不收；數字越大越早收。同樣大的，排在後面的先收。
// 伸縮的項目（當前 cue 的名字）：先縮到最小寬度，輪到它被收時就藏起來（選單最上面會寫）；剩下的空間都給它。

export interface ToolbarPlanItem {
  id: string;
  /** 同一組的放在一起；兩組中間有分隔線 */
  group: string;
  /** 0 = 一定要看得到；越大越早收 */
  priority: number;
  /** 帶字時的寬度（px） */
  labeled: number;
  /** 只剩圖示時的寬度（px）；沒有圖示版的跟 labeled 一樣 */
  compact: number;
  /** 前面不畫分隔線（例：狀態那一組） */
  noSepBefore?: boolean;
  /** 伸縮的項目：最小寬度（帶字 / 只剩圖示時），最大 = labeled */
  flexMin?: number;
  flexCompactMin?: number;
}

export interface ToolbarPlanOptions {
  /** 工具列內容可以用的寬度（已經扣掉工具列的內距、邊框） */
  available: number;
  /** 兩個項目之間的間距 */
  gap: number;
  /** 一條分隔線（含左右留白，不含 gap） */
  separator: number;
  /** 「更多」按鈕的寬度 */
  more: number;
  /** 選單裡本來就有東西（LED 對位圖）→ 「更多」一直都在 */
  alwaysMore: boolean;
}

export interface ToolbarPlan {
  /** priority ≤ 這個數字的帶字（Infinity = 全部帶字；-1 = 全部只剩圖示） */
  labelUpTo: number;
  /** 排在工具列上的（照原本順序） */
  visible: string[];
  /** 收進「更多」的（照原本順序） */
  overflow: string[];
  showMore: boolean;
  /** 伸縮項目分到的寬度 */
  flexWidth: Record<string, number>;
  /** 連只剩一定要看得到的都放不下（工具列會比可用寬度寬一點） */
  overfull: boolean;
}

const isFlex = (it: ToolbarPlanItem) => it.flexMin !== undefined;

/** 這個項目在 labelUpTo 下帶不帶字 */
export const isLabeled = (priority: number, labelUpTo: number) => priority <= labelUpTo;

function itemWidth(it: ToolbarPlanItem, labelUpTo: number): number {
  const labeled = isLabeled(it.priority, labelUpTo);
  if (isFlex(it)) {
    const min = labeled ? it.flexMin! : (it.flexCompactMin ?? it.flexMin!);
    return Math.min(min, it.labeled);
  }
  return labeled ? it.labeled : it.compact;
}

/** 一排要多寬（伸縮項目用最小寬度算） */
export function rowWidth(items: readonly ToolbarPlanItem[], labelUpTo: number, showMore: boolean, opts: Pick<ToolbarPlanOptions, 'gap' | 'separator' | 'more'>): number {
  let w = 0;
  let n = 0;
  let prev: ToolbarPlanItem | null = null;
  for (const it of items) {
    if (n > 0) w += opts.gap;
    if (prev && prev.group !== it.group && !it.noSepBefore) w += opts.separator + opts.gap;
    w += itemWidth(it, labelUpTo);
    prev = it;
    n++;
  }
  if (showMore) w += (n > 0 ? opts.gap : 0) + opts.more;
  return w;
}

function finish(items: readonly ToolbarPlanItem[], visible: ToolbarPlanItem[], labelUpTo: number, showMore: boolean, opts: ToolbarPlanOptions): ToolbarPlan {
  const used = rowWidth(visible, labelUpTo, showMore, opts);
  const flexWidth: Record<string, number> = {};
  let spare = Math.max(0, opts.available - used);
  for (const it of visible) {
    if (!isFlex(it)) continue;
    const min = itemWidth(it, labelUpTo);
    const give = Math.max(0, Math.min(it.labeled - min, spare));
    // 無條件進位：量到的寬度有小數，捨去會差不到 1px 就把名字切成「…」
    flexWidth[it.id] = Math.ceil(min + give);
    spare -= give;
  }
  const shown = new Set(visible.map(v => v.id));
  return {
    labelUpTo,
    visible: visible.map(v => v.id),
    overflow: items.filter(it => !shown.has(it.id)).map(it => it.id),
    showMore,
    flexWidth,
    overfull: used > opts.available + 0.5,
  };
}

/** 要試的「帶字到哪」：全部 → 一個一個 priority 往下拿掉字 → 全部只剩圖示 */
export function labelSteps(items: readonly ToolbarPlanItem[]): number[] {
  const ps = [...new Set(items.map(i => i.priority))].sort((a, b) => b - a);
  return [Infinity, ...ps.slice(1), -1];
}

export function planToolbar(items: readonly ToolbarPlanItem[], opts: ToolbarPlanOptions): ToolbarPlan {
  const fits = (list: readonly ToolbarPlanItem[], labelUpTo: number, more: boolean) =>
    rowWidth(list, labelUpTo, more, opts) <= opts.available + 0.5;

  // 1～3：全部放得下（只是字變少）
  for (const t of labelSteps(items)) {
    if (fits(items, t, opts.alwaysMore)) return finish(items, [...items], t, opts.alwaysMore, opts);
  }

  // 4：只剩圖示，從最不常用的開始收
  const visible = [...items];
  for (;;) {
    if (fits(visible, -1, true)) break;
    let pick = -1;
    for (let i = 0; i < visible.length; i++) {
      const p = visible[i].priority;
      if (p <= 0) continue;
      if (pick < 0 || p >= visible[pick].priority) pick = i;
    }
    if (pick < 0) break;  // 只剩一定要看得到的
    visible.splice(pick, 1);
  }
  return finish(items, visible, -1, true, opts);
}
