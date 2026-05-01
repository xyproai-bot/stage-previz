// 全域「自動儲存」狀態
//
// 寫入操作（cue state 拖、cue rename 等）→ 觸發 saving() → 完成後 saved()
// Topbar 顯示 indicator：「儲存中…」/「已儲存」/「儲存失敗」
//
// 用 inflight counter（多個同時呼叫不會 overlap），idle 1s 後變「已儲存」

import { useEffect, useState } from 'react';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; count: number }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

type Listener = (s: SaveState) => void;

class SaveStatusStore {
  state: SaveState = { kind: 'idle' };
  private listeners = new Set<Listener>();
  private savedTimer: number | null = null;

  saving() {
    const count = this.state.kind === 'saving' ? this.state.count + 1 : 1;
    this.set({ kind: 'saving', count });
  }

  done() {
    if (this.state.kind !== 'saving') {
      // 防禦：如果 done 被呼叫太多次（race），保持 idle
      this.set({ kind: 'saved', at: Date.now() });
    } else {
      const next = this.state.count - 1;
      if (next <= 0) this.set({ kind: 'saved', at: Date.now() });
      else this.set({ kind: 'saving', count: next });
    }
  }

  fail(msg: string) {
    this.set({ kind: 'error', message: msg });
  }

  /** 包一個 promise，自動 saving / done / fail */
  async wrap<T>(p: Promise<T>): Promise<T> {
    this.saving();
    try {
      const r = await p;
      this.done();
      return r;
    } catch (e) {
      // 還是要扣 count，避免 stuck
      this.done();
      this.fail(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  private set(next: SaveState) {
    this.state = next;
    for (const l of this.listeners) l(next);
    if (this.savedTimer !== null) {
      clearTimeout(this.savedTimer);
      this.savedTimer = null;
    }
    // 「已儲存」3 秒後變 idle
    if (next.kind === 'saved') {
      this.savedTimer = window.setTimeout(() => {
        if (this.state.kind === 'saved') this.set({ kind: 'idle' });
      }, 3000);
    }
  }
}

export const saveStatus = new SaveStatusStore();

export function useSaveStatus(): SaveState {
  const [s, setS] = useState<SaveState>(saveStatus.state);
  useEffect(() => saveStatus.subscribe(setS), []);
  return s;
}
