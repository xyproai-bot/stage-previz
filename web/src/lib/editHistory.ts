// 復原 / 重做（Ctrl+Z / Ctrl+Shift+Z、Ctrl+Y）
//
// 每個 cue 各有一份紀錄（scope = historyScope(cueId)）：換到別的 cue 再按 Ctrl+Z，
// 只會復原這個 cue 的修改，不會跑去改到上一個 cue（以前全部共用一份，會改到看不到的 cue）。
// 換回原本的 cue，那個 cue 的紀錄還在，可以繼續復原。
// 沒選 cue 時改的是物件預設位置，算另一份（'defaults'）。

export interface HistoryStep {
  /** 回到改之前 */
  undo: () => Promise<void>;
  /** 再做一次 */
  redo: () => Promise<void>;
}

export type HistoryResult = 'done' | 'empty' | 'busy';

export const DEFAULT_HISTORY_LIMIT = 50;

/** 紀錄要記在哪一份：選了 cue → 那個 cue；沒選 → 物件預設位置 */
export function historyScope(cueId: string | null | undefined): string {
  return cueId ? `cue:${cueId}` : 'defaults';
}

interface ScopeStacks {
  done: HistoryStep[];
  undone: HistoryStep[];
  /** 每次有新的修改 +1：復原 / 重做做到一半又有新修改 → 那一步不放回去（順序會亂） */
  rev: number;
}

export class EditHistory {
  private scopes = new Map<string, ScopeStacks>();
  private running = false;

  constructor(readonly limit = DEFAULT_HISTORY_LIMIT) {}

  private stacks(scope: string): ScopeStacks {
    let s = this.scopes.get(scope);
    if (!s) {
      s = { done: [], undone: [], rev: 0 };
      this.scopes.set(scope, s);
    }
    return s;
  }

  /** 記一筆新的修改：這一份的「重做」清空（跟一般軟體一樣），超過上限丟掉最舊的 */
  push(scope: string, step: HistoryStep): void {
    const s = this.stacks(scope);
    s.done.push(step);
    if (s.done.length > this.limit) s.done.splice(0, s.done.length - this.limit);
    s.undone = [];
    s.rev++;
  }

  counts(scope: string): { undo: number; redo: number } {
    const s = this.scopes.get(scope);
    return { undo: s?.done.length ?? 0, redo: s?.undone.length ?? 0 };
  }

  /** 正在復原 / 重做中 */
  get busy(): boolean { return this.running; }

  undo(scope: string): Promise<HistoryResult> { return this.run(scope, 'undo'); }
  redo(scope: string): Promise<HistoryResult> { return this.run(scope, 'redo'); }

  /** 清掉某一份（例：那個 cue 被刪掉了） */
  clear(scope: string): void {
    this.scopes.delete(scope);
  }

  private async run(scope: string, kind: 'undo' | 'redo'): Promise<HistoryResult> {
    if (this.running) return 'busy';
    const s = this.scopes.get(scope);
    if (!s) return 'empty';
    const from = kind === 'undo' ? s.done : s.undone;
    const to = kind === 'undo' ? s.undone : s.done;
    const step = from.pop();
    if (!step) return 'empty';
    const rev = s.rev;
    this.running = true;
    try {
      await step[kind]();
      if (s.rev === rev) to.push(step);
      return 'done';
    } catch (e) {
      // 失敗 → 放回原處，可以再按一次
      if (s.rev === rev) from.push(step);
      throw e;
    } finally {
      this.running = false;
    }
  }
}
