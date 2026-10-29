// 調整舞台第 3 段：存起來的流程接到畫面（存回 Cue 庫 / 另存成新 cue / 復原 / 複製 / 改名 / 轉場秒數）。
// 流程本身在 lib/adjust/stageFlows.ts（先問清楚 → 呼叫後台 → 重新讀 → 提示，有測試）；這裡管：
//   一次只做一件事（busy）、下面綠色提示列的內容（notice：20 秒後自己收、開始調新的 / 換 cue / 離開調整舞台就收）、
//   「用其他身分看」的預覽模式擋住寫入（guard；擋寫入的請求本來也會擋）。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Cue } from '../../lib/api';
import type { CueMechanismPosition } from '../../lib/mechanisms/model';
import type { AdjustStore } from '../../lib/adjust/store';
import { getLibraryCueUsage } from '../../lib/cueLibraryApi';
import { copyStageCue, patchStageCue, saveStageAs, saveStagePositions, setSlotStageCrossfade } from '../../lib/adjust/stageApi';
import { createStageFlows, type StageFlowApi, type StageFlowUi } from '../../lib/adjust/stageFlows';
import { STAGE_SAVE_TEXT } from '../../lib/adjust/saveBack';
import { friendlyError } from '../../lib/songReview';
import { chooseDialog, confirmDialog, promptDialog } from '../dialogs';
import { toast } from '../../lib/toast';

export interface StageSaveNotice {
  id: number;
  text: string;
  /** 有 = 可以復原（用後台回的上一版再存一次） */
  undo?: () => void;
}

export interface UseStageSaveOptions {
  store: AdjustStore;
  projectId: string;
  song: { id: string; name: string; code?: string | null };
  /** 現在選的 cue（這首歌的 slot）；沒有 → null */
  cue: Cue | null;
  /** 這首歌讀到的機關位置列（每個 slot 一份） */
  positionRows: readonly CueMechanismPosition[];
  /** 重新讀位置（true = 讀到了） */
  reloadPositions: () => Promise<boolean>;
  /** 重新讀這首歌的 cue（改名 / 另存 / 改秒數之後名字、編號、秒數才會更新） */
  reloadCues: () => Promise<void>;
  /** 預覽（用其他身分看）時擋住寫入 */
  guard: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
}

const NOTICE_MS = 20_000;

const REAL_API: StageFlowApi = { saveStagePositions, saveStageAs, copyStageCue, patchStageCue, setSlotStageCrossfade, getLibraryCueUsage };

export function useStageSave(o: UseStageSaveOptions) {
  const { store } = o;
  const latest = useRef(o);
  latest.current = o;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<StageSaveNotice | null>(null);
  const noticeSeq = useRef(0);

  // 提示：20 秒後自己收掉；開始調新的東西、換 cue、離開調整舞台就收掉
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(n => (n && n.id === notice.id ? null : n)), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  const on = useSyncExternalStore(store.subscribe, () => store.getState().on);
  const hasDraft = useSyncExternalStore(store.subscribe, () => store.changedCount() > 0);
  useEffect(() => { if (!on || hasDraft) setNotice(null); }, [on, hasDraft]);
  const cueId = o.cue?.id ?? null;
  useEffect(() => { setNotice(null); }, [cueId]);

  /** 一次只做一件事；做完（不管成功失敗）才放開。流程裡沒接住的錯誤用白話跳出來 */
  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await fn(); } catch (e) { toast.error(friendlyError(e)); } finally { busyRef.current = false; setBusy(false); }
  }, []);

  const flows = useMemo(() => {
    const ui: StageFlowUi = {
      confirm: confirmDialog, prompt: promptDialog, choose: chooseDialog,
      toast: { success: t => { toast.success(t); }, info: t => { toast.info(t); }, warn: t => { toast.warn(t); }, error: t => { toast.error(t); } },
      // 「復原」按鈕：一樣一次只做一件事、預覽模式擋住
      notice: (text, undo) => setNotice(text === null ? null : {
        id: ++noticeSeq.current, text,
        undo: undo ? () => { latest.current.guard(() => { void run(undo); })(); } : undefined,
      }),
    };
    return createStageFlows(() => ({ ...latest.current, api: REAL_API, ui }));
  }, [run]);

  const { guard } = o;
  const api = useMemo(() => ({
    saveBack: guard(() => { void run(flows.saveBack); }),
    saveAs: guard(() => { void run(flows.saveAs); }),
    copy: guard(() => { void run(flows.copy); }),
    rename: guard(() => { void run(flows.rename); }),
    seconds: guard(() => { void run(flows.seconds); }),
  }), [guard, run, flows]);

  /** 重新載入（被別人改過之後）：放棄草稿，讀最新的 */
  const reload = useCallback(() => {
    latest.current.store.discardAll();
    void latest.current.reloadPositions().then(ok => { if (ok) toast.info(STAGE_SAVE_TEXT.reloaded); });
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return { busy, notice, dismissNotice, reload, ...api };
}

export type StageSaveApi = ReturnType<typeof useStageSave>;
