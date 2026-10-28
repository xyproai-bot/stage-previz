// 專案共用的「樂手和器材」（比例尺）：讀、改、存。
//
// 用法（每個顯示 StageScene 的頁面）：
//   const band = useStageProps(projectId, canEditStageProps(projectRole));
//   <StageScene stageProps={band.stageProps} onStagePropsChange={band.onStagePropsChange} />
//
// 全專案共用，存在 project 上（lib/stageProps.ts 寫了格式）；製作、導演可以改，其他人只能看（沒有 onStagePropsChange）。
// 改了馬上反映在畫面上，停手 SAVE_DELAY_MS 才合併成一次存；存失敗跳提示，畫面上的修改留著，下一次修改會重新存。
// 離開頁面 / 關分頁前把沒存的送出去。
//
// 復原（history）：只記這台瀏覽器、這次打開頁面後做的每一步（加、刪、移動、轉、清掉），最多 50 步，可以連按；
// 退回去的結果照原本的方式存回專案。換專案 / 重新整理就清空。「清掉」（全部 / 只清樂手 / 只清器材）也是一步，可以復原。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { toast } from './toast';
import { normalizeStageProps, type StagePropItem } from './stageProps';
import { applyEdit, applyUndo, clearStageProps, type ClearScope } from './stagePropsHistory';

const SAVE_DELAY_MS = 600;
const NO_PROPS: StagePropItem[] = [];

/** 比例尺面板的「復原」和「清掉」 */
export interface StagePropsHistory {
  /** 還能退回幾步（0 = 沒有可以復原的） */
  undoDepth: number;
  /** 退回上一步 */
  undo: () => void;
  /** 清掉（全部 / 只清樂手 / 只清器材）；是一步，可以復原 */
  clear: (scope: ClearScope) => void;
}

export interface StagePropsState {
  stageProps: StagePropItem[];
  /** 有權限改才有；沒有 = 只能看 */
  onStagePropsChange?: (next: StagePropItem[]) => void;
  /** 復原 / 清掉；跟 onStagePropsChange 一樣，有權限改才有 */
  history?: StagePropsHistory;
  /** 專案上的清單讀完了沒（讀失敗也算完） */
  loaded: boolean;
}

export function useStageProps(projectId: string | undefined, canEdit: boolean): StagePropsState {
  const [props, setProps] = useState<StagePropItem[]>(NO_PROPS);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  // 復原紀錄：每一步存「做之前的整份清單」，最多 50 步
  const undoRef = useRef<StagePropItem[][]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const propsRef = useRef<StagePropItem[]>(NO_PROPS);
  // 讀完之前使用者就已經改過 → 讀回來的舊資料不能蓋掉他剛改的
  const touchedRef = useRef(false);
  const pendingRef = useRef<{ timer: number; projectId: string } | null>(null);
  // 一份一份照順序存，後面的不會被前面慢的蓋掉
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const flush = useCallback((keepalive = false) => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    const snapshot = propsRef.current;
    const send = () => api.saveProjectStageProps(p.projectId, snapshot, { keepalive }).catch((e) => {
      console.warn('[stageProps] save failed', e);
      const why = e instanceof Error && e.message ? `：${e.message}` : '';
      toast.error(`樂手和器材沒有存到專案上${why}。畫面上的位置先留著，再動一下就會重新存`);
    });
    chainRef.current = keepalive ? Promise.resolve(send()) : chainRef.current.then(send);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    propsRef.current = NO_PROPS;
    touchedRef.current = false;
    loadedRef.current = false;
    undoRef.current = [];
    setUndoDepth(0);
    setProps(NO_PROPS);
    setLoaded(false);
    api.getProjectStageProps(projectId).then((list) => {
      if (cancelled || touchedRef.current) return;
      propsRef.current = list;
      setProps(list);
    }).catch(() => { /* 讀不到就當沒有（舊版後台沒有這個功能） */ }).finally(() => {
      if (!cancelled) { loadedRef.current = true; setLoaded(true); }
    });
    return () => {
      cancelled = true;
      flush();
    };
  }, [projectId, flush]);

  useEffect(() => {
    const onUnload = () => flush(true);
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, [flush]);

  // 畫面上換成這份清單，停手 SAVE_DELAY_MS 後存回專案（改、復原都走這裡）
  const commit = useCallback((clean: StagePropItem[]) => {
    if (!projectId) return;
    propsRef.current = clean;
    touchedRef.current = true;
    setProps(clean);
    const prev = pendingRef.current;
    if (prev) clearTimeout(prev.timer);
    pendingRef.current = { projectId, timer: window.setTimeout(() => flush(), SAVE_DELAY_MS) };
  }, [projectId, flush]);

  const update = useCallback((next: StagePropItem[]) => {
    if (!projectId || !canEdit) return;
    // 沒變的不算一步；清單還沒讀回來就改的（上面的 touchedRef）也不記，不然退回去會退成「空的」
    const r = applyEdit({ items: propsRef.current, undo: undoRef.current }, normalizeStageProps(next), loadedRef.current);
    undoRef.current = r.undo;
    setUndoDepth(r.undo.length);
    commit(r.items);
  }, [projectId, canEdit, commit]);

  const undo = useCallback(() => {
    if (!projectId || !canEdit) return;
    const r = applyUndo({ items: propsRef.current, undo: undoRef.current });
    if (!r) return;
    undoRef.current = r.undo;
    setUndoDepth(r.undo.length);
    commit(normalizeStageProps(r.items));
  }, [projectId, canEdit, commit]);

  const clear = useCallback((scope: ClearScope) => {
    update(clearStageProps(propsRef.current, scope));
  }, [update]);

  return useMemo(() => ({
    stageProps: props,
    onStagePropsChange: canEdit ? update : undefined,
    history: canEdit ? { undoDepth, undo, clear } : undefined,
    loaded,
  }), [props, canEdit, update, undoDepth, undo, clear, loaded]);
}
