// 「所有 cue 的物件回到預設位置」（Cue 分頁的「⋯」）：把這首歌所有 cue 自己設過的物件位置 / 角度 / 大小 / 顯示 / 自訂內容全部清掉，
// 每個物件在每個 cue 都回到預設。只清物件的設定：cue 的名稱、時間、轉場、機關時間軸上的位置都不動。
//
// 清掉的內容整份留著，復原（Ctrl+Z）一次全部寫回去 = 復原紀錄裡的「一步」。
// 這一步放進這首歌每個 cue 的復原紀錄（換到哪個 cue 都能復原）；從哪個 cue 復原 / 重做，其他 cue 的紀錄就清掉
// （它們記的「改之前」是這次批次之前 / 之後的樣子，留著再復原會把剛寫回去的東西弄掉）。
// 後台：一次看 / 一次清 / 一次寫回（cf-worker/cueStatesBatch.mjs），一個交易，不是逐一呼叫上百次。

import { historyScope, type HistoryStep } from './editHistory';

/** 要清的內容（後台給的原樣；寫回去也是這個格式） */
export interface OverrideRow { cueId: string; objectId: string }

export interface ResetAllSummary {
  /** 這首歌共幾個 cue（含提案） */
  totalCues: number;
  /** 其中幾個 cue 有調整過物件 */
  cuesWithOverrides: number;
  /** 共幾筆物件設定（一個 cue 的一個物件算一筆） */
  overrides: number;
  /** 涉及幾個不同的物件 */
  objects: number;
}

export function summarizeOverrides(totalCues: number, rows: readonly OverrideRow[]): ResetAllSummary {
  return {
    totalCues,
    cuesWithOverrides: new Set(rows.map(r => r.cueId)).size,
    overrides: rows.length,
    objects: new Set(rows.map(r => r.objectId)).size,
  };
}

export const RESET_ALL_MENU_LABEL = '所有 cue 的物件回到預設位置';
export const RESET_ALL_NOTHING = '這首歌所有 cue 的物件本來就都在預設位置，沒有東西要清。';

/** 確認視窗：寫清楚影響幾個 cue、幾筆設定，什麼不會動，怎麼復原 */
export function resetAllDialog(s: ResetAllSummary): { title: string; message: string; confirmLabel: string; destructive: true } {
  return {
    title: '把這首歌所有 cue 的物件回到預設位置？',
    message: [
      `這首歌共 ${s.totalCues} 個 cue，其中 ${s.cuesWithOverrides} 個 cue 調整過物件：共 ${s.overrides} 筆物件設定（${s.objects} 個物件）會被清掉。清掉以後，每個 cue 裡所有物件都回到預設的位置、角度、大小和顯示（設成「預設隱藏」的物件會是隱藏的）。`,
      'cue 的名稱、時間、轉場，還有機關時間軸上的位置都不會動，只清物件的設定。',
      '清掉以後可以按復原（Ctrl+Z）一次全部還原；重新整理頁面以後就不能復原了。',
    ].join('\n'),
    confirmLabel: '全部回到預設',
    destructive: true,
  };
}

/** 復原紀錄要放進哪幾份：現在這一份 + 這首歌每個 cue 各一份（不重複） */
export function resetAllHistoryScopes(currentScope: string, cueIds: readonly string[]): string[] {
  return [...new Set([currentScope, ...cueIds.map(id => historyScope(id))])];
}

/** 復原紀錄（EditHistory 的一部分，方便測試） */
export interface HistoryLike {
  push(scope: string, step: HistoryStep): void;
  clear(scope: string): void;
}

export interface ResetAllOptions<R extends OverrideRow> {
  /** 後台：清掉這首歌所有 cue 的物件設定，回傳被清掉的內容 */
  clear: () => Promise<{ states: R[] }>;
  /** 後台：把清掉的內容寫回去 */
  restore: (states: R[]) => Promise<unknown>;
  history: HistoryLike;
  /** resetAllHistoryScopes 的結果 */
  scopes: readonly string[];
}

/** 清掉，並把「復原 / 重做」記成一步。回傳清掉幾筆（0 = 本來就沒有，沒有記復原） */
export async function runResetAll<R extends OverrideRow>(o: ResetAllOptions<R>): Promise<number> {
  let snapshot = (await o.clear()).states;
  if (snapshot.length === 0) return 0;
  const dropOthers = (scope: string) => { for (const s of o.scopes) if (s !== scope) o.history.clear(s); };
  const step: HistoryStep = {
    undo: async (scope) => {
      await o.restore(snapshot);
      dropOthers(scope);
    },
    redo: async (scope) => {
      const r = await o.clear();
      if (r.states.length > 0) snapshot = r.states;   // 重做時現在的樣子才是下次復原要寫回去的
      dropOthers(scope);
    },
  };
  for (const s of o.scopes) o.history.push(s, step);
  return snapshot.length;
}
