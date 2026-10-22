// 編輯頁用：Cue 庫專案「還沒存的改動」（草稿）的狀態 + 原本的畫面（比對、存的時候用）。
// 純邏輯在 lookDraft.ts。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLibraryLook, type Look, type LookWithRev } from './cueLibraryApi';
import {
  emptyHistory, historyPush, historyRedo, historyUndo, newDraft, resetObject, setMechanism, setObjectFields, summarizeDraft,
  type DraftHistory, type DraftMech, type DraftObject, type LookDraft,
} from './lookDraft';

export function useLookDraft(o: { projectId: string | undefined; libId: string | null; enabled: boolean }) {
  const { projectId, libId, enabled } = o;
  const [hist, setHistState] = useState<DraftHistory>(emptyHistory());
  const histRef = useRef(hist);
  const commit = useCallback((h: DraftHistory) => { histRef.current = h; setHistState(h); }, []);
  const libIdRef = useRef(libId);
  libIdRef.current = libId;

  // 原本的畫面（跟草稿比、另存 / 更新時合起來）
  const [base, setBase] = useState<(LookWithRev & { libId: string }) | null>(null);
  const baseReq = useRef(0);
  const loadBase = useCallback(async (): Promise<(LookWithRev & { libId: string }) | null> => {
    const id = libIdRef.current;
    if (!enabled || !projectId || !id) { setBase(null); return null; }
    const req = ++baseReq.current;
    try {
      const l = await getLibraryLook(projectId, id);
      if (req !== baseReq.current) return null;
      const next = { ...l, libId: id };
      setBase(next);
      return next;
    } catch (e) {
      console.warn('load library look failed', e);
      return null;
    }
  }, [enabled, projectId]);
  useEffect(() => { setBase(null); void loadBase(); }, [loadBase, libId]);

  // 換到別的 Cue 庫的 cue（問過之後）→ 草稿不跟過去
  useEffect(() => {
    const p = histRef.current.present;
    if (p && p.libId !== libId) commit(emptyHistory());
  }, [libId, commit]);

  const draft: LookDraft | null = hist.present && hist.present.libId === libId ? hist.present : null;
  const edit = useCallback((fn: (d: LookDraft) => LookDraft) => {
    const id = libIdRef.current;
    if (!id) return;
    const cur = histRef.current.present && histRef.current.present.libId === id ? histRef.current.present : newDraft(id);
    commit(historyPush(histRef.current, fn(cur)));
  }, [commit]);

  const baseLook = useMemo<Look | null>(
    () => (base && base.libId === libId ? { objects: base.objects, mechanisms: base.mechanisms } : null), [base, libId]);
  const summary = useMemo(() => {
    if (!draft) return { objects: 0, mechanisms: 0 };
    return baseLook ? summarizeDraft(draft, baseLook) : { objects: Object.keys(draft.objects).length, mechanisms: Object.keys(draft.mechanisms).length };
  }, [draft, baseLook]);
  const hasChanges = summary.objects + summary.mechanisms > 0;

  return {
    draft,
    /** 同步讀最新的草稿（連續好幾個修改在同一個畫面更新裡時用） */
    getDraft: () => (histRef.current.present && histRef.current.present.libId === libIdRef.current ? histRef.current.present : null),
    summary, hasChanges,
    base: base && base.libId === libId ? base : null,
    loadBase,
    setObject: useCallback((objectId: string, patch: Omit<DraftObject, 'reset'>) => edit(d => setObjectFields(d, objectId, patch)), [edit]),
    resetObjectFields: useCallback((objectId: string) => edit(d => resetObject(d, objectId)), [edit]),
    setMechanisms: useCallback((entries: Record<string, DraftMech | null>) => edit(d => Object.entries(entries).reduce((acc, [id, e]) => setMechanism(acc, id, e), d)), [edit]),
    undoCount: hist.past.length,
    redoCount: hist.future.length,
    undo: useCallback(() => commit(historyUndo(histRef.current)), [commit]),
    redo: useCallback(() => commit(historyRedo(histRef.current)), [commit]),
    clear: useCallback(() => commit(emptyHistory()), [commit]),
  };
}

export type LookDraftState = ReturnType<typeof useLookDraft>;
