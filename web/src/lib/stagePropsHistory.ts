// 比例尺「樂手和器材」的復原、全部清掉：純函式（stagePropsHistory.test.ts 有測）。
//
// 復原：只記這台瀏覽器這次打開頁面後做的（加、刪、移動、轉、清掉），最多 STAGE_PROPS_UNDO_MAX 步，每一步存「做之前的整份清單」。
//   存在 lib/useStageProps.ts（所有頁面共用一份）；退回去的結果照原本的方式存回專案（所有人都看得到）。
// 清掉：全部 / 只清人物 / 只清器材（分類照 lib/stageProps.ts 的 group，也就是比例尺面板的「人物」「器材」兩組）。
//   樂手台算器材；清掉樂手台時，站在上面的人留在原地（跟單獨刪掉一個樂手台一樣）。
// 存檔格式和誰能改在 lib/stageProps.ts（後台也用，這裡不動它）。

import { isTextEntryTarget } from './keyTarget';
import { stagePropSpec, type StagePropGroup, type StagePropItem } from './stageProps';

/** 最多能退回幾步 */
export const STAGE_PROPS_UNDO_MAX = 50;

/** 兩份清單一模一樣嗎（順序、每個欄位都算） */
export function sameStageProps(a: readonly StagePropItem[], b: readonly StagePropItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((it, i) => {
    const o = b[i];
    return it.id === o.id && it.type === o.type && it.x === o.x && it.y === o.y && it.z === o.z && it.rotY === o.rotY;
  });
}

/** 做一步之前，把「做之前的清單」放進復原紀錄；超過 50 步丟掉最舊的。回傳新的紀錄（不改原本的） */
export function pushUndo(stack: readonly StagePropItem[][], before: readonly StagePropItem[]): StagePropItem[][] {
  const next = [...stack, before.slice()];
  return next.length > STAGE_PROPS_UNDO_MAX ? next.slice(next.length - STAGE_PROPS_UNDO_MAX) : next;
}

/** 退一步：回傳剩下的紀錄和退回去的那份清單；沒有可以退的 → null */
export function popUndo(stack: readonly StagePropItem[][]): { stack: StagePropItem[][]; restored: StagePropItem[] } | null {
  if (stack.length === 0) return null;
  return { stack: stack.slice(0, -1), restored: stack[stack.length - 1].slice() };
}

// ─── 清掉 ───

/** 清哪些：全部 / 人物（樂手）/ 器材 */
export type ClearScope = 'all' | StagePropGroup;

export const CLEAR_SCOPES: readonly ClearScope[] = ['all', 'person', 'gear'];

function inScope(it: StagePropItem, scope: ClearScope): boolean {
  return scope === 'all' || stagePropSpec(it.type).group === scope;
}

/** 這個範圍裡有幾個 */
export function countInScope(items: readonly StagePropItem[], scope: ClearScope): number {
  let n = 0;
  for (const it of items) if (inScope(it, scope)) n++;
  return n;
}

/** 清掉這個範圍的（回傳新清單，不改原本的）；其他的照原樣留著 */
export function clearStageProps(items: readonly StagePropItem[], scope: ClearScope): StagePropItem[] {
  return items.filter(it => !inScope(it, scope));
}

export const CLEAR_SCOPE_LABEL: Record<ClearScope, string> = {
  all: '清掉全部',
  person: '只清樂手',
  gear: '只清器材',
};

export const CLEAR_SCOPE_HINT: Record<ClearScope, string> = {
  all: '清掉所有加的樂手和器材（三個預設人形不算）',
  person: '只清人物（主唱、鼓手、吉他手…），器材留著',
  gear: '只清器材（鋼琴、麥克風架、監聽喇叭、樂手台），人物留著',
};

export interface ClearQuestion { title: string; message: string; confirmLabel: string }

/** 清掉之前問一句的內容（站內確認框用） */
export function clearQuestion(scope: ClearScope, n: number): ClearQuestion {
  const what = scope === 'all' ? '樂手和器材' : scope === 'person' ? '樂手' : '器材';
  const keep = scope === 'person' ? '器材會留著。' : scope === 'gear' ? '樂手會留著。' : '';
  return {
    title: `清掉 ${n} 個${what}？`,
    message: `${keep}三個預設的人形不受影響。清掉的位置所有人都會看不到；清錯了可以按「復原」拿回來。`,
    confirmLabel: '清掉',
  };
}

// ─── Ctrl+Z / Cmd+Z ───

export interface UndoKeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
}

/**
 * 這個按鍵是「復原樂手和器材」嗎：Ctrl+Z 或 Cmd+Z（不能同時按 Shift = 重做、不能按 Alt），而且不是在打字的地方。
 * 勾選框、按鈕上照樣算（面板裡大多是這些）。
 */
export function isStagePropsUndoKey(e: UndoKeyLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  if (e.key !== 'z' && e.key !== 'Z') return false;
  return !isTextEntryTarget(e.target ?? null);
}

// ─── 清單 + 復原紀錄一起走（lib/useStageProps.ts 用）───

export interface PropsHistoryState {
  /** 現在的清單 */
  items: StagePropItem[];
  /** 復原紀錄（最後一個 = 最近一步做之前的清單） */
  undo: StagePropItem[][];
}

/**
 * 使用者把清單改成 next（加、刪、移動、轉、清掉都是這個）：
 * 內容沒變 → 不算一步；record = false（專案上的清單還沒讀回來就改了，退回去會退成「空的」）→ 改了但不記。其他記一步。
 */
export function applyEdit(state: PropsHistoryState, next: StagePropItem[], record: boolean): PropsHistoryState {
  if (!record || sameStageProps(state.items, next)) return { items: next, undo: state.undo };
  return { items: next, undo: pushUndo(state.undo, state.items) };
}

/** 退一步；沒有可以退的 → null */
export function applyUndo(state: PropsHistoryState): PropsHistoryState | null {
  const r = popUndo(state.undo);
  return r ? { items: r.restored, undo: r.stack } : null;
}
