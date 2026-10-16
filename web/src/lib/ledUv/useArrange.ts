// 自動貼 UV 第 3 階段：排版的編輯狀態（React hook）。數字怎麼算在 arrange.ts（有單元測試），這裡只管「草稿 + 復原重做 + 拖曳一次記一步」。
//
// 沒動過 = 照舞台自動排的樣子（會跟著點數、勾的螢幕、螢幕間隔即時變）；動過一次以後才有自己的草稿，
// 草稿每次都會對齊目前的螢幕清單（點數改了、螢幕勾多了少了），見 reconcileDoc。

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Draft } from '../ledTemplateDraft';
import { commit, newHistory, redo as redoHistory, settle, transient, undo as undoHistory, type History } from '../ledTemplateEdit';
import {
  arrangementFromDoc, arrangementFromPack, docFromArrangement, patchDoc, reconcileArrangement, reconcileDoc,
  type ArrangeDoc, type ArrangeNative, type Arrangement,
} from './arrange';
import type { PackResult } from './pack';

export type PatchHow = 'live' | { tag?: string };

export interface ArrangeState {
  /** 現在的草稿（沒動過 = 自動排的樣子） */
  doc: ArrangeDoc;
  /** 製作動過了（沒動過 = false，方案照自動排） */
  edited: boolean;
  /** 現在的排法（沒動過 = null）：交給 buildPlan */
  arrangement: Arrangement | null;
  canUndo: boolean;
  canRedo: boolean;
  /** 套用一個修改（Draft → Draft 的純函式，跟版型編輯器共用的那些）；live = 拖曳中（不記步），否則記一步（同 tag 連續的合成一步） */
  apply: (fn: (d: Draft) => Draft, how: PatchHow) => void;
  /** 直接換一個草稿（全部靠左上、自動排一次、連在一起…）：記一步 */
  applyDoc: (fn: (d: ArrangeDoc) => ArrangeDoc, how?: PatchHow) => void;
  onGesture: (phase: 'start' | 'end') => void;
  undo: () => void;
  redo: () => void;
  /** 讀回存起來的排法（null = 回到自動排）；不留復原紀錄 */
  restore: (arr: Arrangement | null) => void;
}

export function useArrangeState(natives: readonly ArrangeNative[], pack: Pick<PackResult, 'placed' | 'canvas'>): ArrangeState {
  const [hist, setHist] = useState<History<ArrangeDoc> | null>(null);
  const baseDoc = useMemo(() => docFromArrangement(arrangementFromPack(natives, pack), natives), [natives, pack]);
  const doc = useMemo(() => (hist ? reconcileDoc(hist.present, natives, pack) : baseDoc), [hist, natives, pack, baseDoc]);

  // 回呼一直用最新的（不然拖曳到一半螢幕清單換了會拿到舊的）
  const live = useRef({ natives, pack, baseDoc, doc });
  live.current = { natives, pack, baseDoc, doc };
  const gestureBase = useRef<ArrangeDoc | null>(null);

  const applyDoc = useCallback((fn: (d: ArrangeDoc) => ArrangeDoc, how: PatchHow = {}) => {
    setHist((h) => {
      const { natives: ns, pack: pk, baseDoc: base } = live.current;
      const cur = h ? reconcileDoc(h.present, ns, pk) : base;
      const next = fn(cur);
      if (next === cur) return h;
      const start = h ? (cur === h.present ? h : { ...h, present: cur }) : newHistory(cur);
      return how === 'live' ? transient(start, next) : commit(start, next, { tag: how.tag });
    });
  }, []);

  const apply = useCallback((fn: (d: Draft) => Draft, how: PatchHow) => {
    applyDoc(d => patchDoc(d, fn, live.current.natives), how);
  }, [applyDoc]);

  const onGesture = useCallback((phase: 'start' | 'end') => {
    if (phase === 'start') { gestureBase.current = live.current.doc; return; }
    const base = gestureBase.current;
    gestureBase.current = null;
    setHist(h => (h && base && h.present !== base ? settle(h, base) : h));
  }, []);

  const undo = useCallback(() => setHist(h => (h ? undoHistory(h) : h)), []);
  const redo = useCallback(() => setHist(h => (h ? redoHistory(h) : h)), []);
  const restore = useCallback((arr: Arrangement | null) => {
    if (!arr) { setHist(null); return; }
    const { natives: ns, pack: pk } = live.current;
    setHist(newHistory(docFromArrangement(reconcileArrangement(arr, ns, pk), ns)));
  }, []);

  const arrangement = useMemo(() => (hist ? arrangementFromDoc(doc) : null), [hist, doc]);
  return {
    doc, edited: hist !== null, arrangement,
    canUndo: !!hist && hist.past.length > 0, canRedo: !!hist && hist.future.length > 0,
    apply, applyDoc, onGesture, undo, redo, restore,
  };
}
