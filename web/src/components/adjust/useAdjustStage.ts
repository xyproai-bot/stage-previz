// 導演頁用的調整舞台 hook：建草稿倉庫、把機關定義 / 這個 cue / 上一個 cue / 轉場秒數同步進去，
// 給「有改沒存就先問」的 guard、beforeunload，和 StageScene 要的 override。
// 導演頁只訂「開了沒、改了幾個、正在調哪個機關」：拖把手時整個頁面不會跟著重畫。

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type MutableRefObject } from 'react';
import type { Mechanism, MechanismTimings, MechanismValues } from '../../lib/mechanisms/model';
import { AdjustStore } from '../../lib/adjust/store';
import { ADJUST_TEXT } from '../../lib/adjust/panelText';
import { confirmDialog } from '../dialogs';
import { toast } from '../../lib/toast';
import type { StageAdjustHost } from '../StageScene';

export interface UseAdjustStageOptions {
  /** 切換鈕出不出現（showAdjustSwitch）；false → 開著的話關掉 */
  enabled: boolean;
  mechanisms: Mechanism[] | null;
  cueId: string | null;
  cueName: string;
  /** 這個 cue 存的機關值 */
  saved: MechanismValues;
  /** 上一個 cue；這是第一個 → null（從預設位置） */
  prevCue: { id: string; name: string } | null;
  valuesForCue: (cueId: string) => MechanismValues | null;
  timingsForCue: (cueId: string) => MechanismTimings;
  /** 這個 cue 的轉場秒數 */
  seconds: number;
  hostRef: MutableRefObject<StageAdjustHost | null>;
  /** 這個 cue 指到的 Cue 庫的 cue、編號、拿到存的值的時候的版本（存回用；後台沒給版本 → null，存不了） */
  libraryCueId?: string | null;
  libraryLabel?: string | null;
  rev?: number | null;
}

const NO_TIMINGS: MechanismTimings = {};

export function useAdjustStage(o: UseAdjustStageOptions) {
  const store = useMemo(() => new AdjustStore(), []);
  const { enabled, mechanisms, cueId, cueName, saved, prevCue, valuesForCue, timingsForCue, seconds, hostRef } = o;
  const libraryCueId = o.libraryCueId ?? null, libraryLabel = o.libraryLabel ?? null, rev = o.rev ?? null;

  useEffect(() => { store.setDefs(mechanisms); }, [store, mechanisms]);

  const prevValues = useMemo<MechanismValues>(() => {
    const fromPrev = prevCue ? valuesForCue(prevCue.id) : null;
    if (fromPrev) return fromPrev;
    const d: MechanismValues = {};
    for (const m of mechanisms ?? []) d[m.id] = m.defaultValue;
    return d;
  }, [prevCue, valuesForCue, mechanisms]);
  const timings = cueId ? timingsForCue(cueId) : NO_TIMINGS;
  useEffect(() => {
    const r = store.setCue({ cueId, cueName, saved, prevName: prevCue?.name ?? null, prevValues, seconds, timings, libraryCueId, libraryLabel, rev });
    // 沒經過「放棄嗎？」就換了 cue（影片在播、自動更新、通知點進來）→ 講一聲
    if (r.dropped > 0) toast.warn(ADJUST_TEXT.dropped(r.dropped));
  }, [store, cueId, cueName, saved, prevCue?.name, prevValues, seconds, timings, libraryCueId, libraryLabel, rev]);

  useEffect(() => {
    if (!enabled && store.getState().on) store.exit();
  }, [enabled, store]);
  // 離開導演頁（這首歌的畫面拆掉）→ 關掉
  useEffect(() => () => store.exit(), [store]);

  const on = useSyncExternalStore(store.subscribe, () => store.getState().on);
  const changed = useSyncExternalStore(store.subscribe, () => store.changedCount());
  const active = useSyncExternalStore(store.subscribe, () => store.getState().active);

  // 有改沒存 → 關頁面 / 重新整理先問（瀏覽器自己的提示）
  const dirty = on && changed > 0;
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ADJUST_TEXT.unload;
      return e.returnValue;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /** 有改的話先問「放棄這些改動？」；放棄 / 沒改 → true */
  const askingRef = useRef(false);
  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    const n = store.getState().on ? store.changedCount() : 0;
    if (n === 0) return true;
    if (askingRef.current) return false;
    askingRef.current = true;
    try {
      const ok = await confirmDialog({
        title: ADJUST_TEXT.confirmTitle, message: ADJUST_TEXT.confirmMessage(n), confirmLabel: ADJUST_TEXT.confirmLabel, destructive: true,
      });
      if (ok) store.discardAll();
      return ok;
    } finally {
      askingRef.current = false;
    }
  }, [store]);

  /** 包一個動作：有改的話先問，放棄了才做 */
  const guard = useCallback(<A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    if (!store.getState().on || store.changedCount() === 0) { fn(...args); return; }
    void confirmDiscard().then(ok => { if (ok) fn(...args); });
  }, [store, confirmDiscard]);

  const enter = useCallback(() => { store.enter(hostRef.current?.shownValues() ?? {}); }, [store, hostRef]);
  const exit = useCallback(() => { void confirmDiscard().then(ok => { if (ok) store.exit(); }); }, [store, confirmDiscard]);

  return { store, on, changed, active, enter, exit, guard, confirmDiscard, override: store.override };
}

export type AdjustStageApi = ReturnType<typeof useAdjustStage>;
