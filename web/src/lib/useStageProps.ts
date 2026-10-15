// 專案共用的「樂手和器材」（比例尺）：讀、改、存。
//
// 用法（每個顯示 StageScene 的頁面）：
//   const band = useStageProps(projectId, canEditStageProps(projectRole));
//   <StageScene stageProps={band.stageProps} onStagePropsChange={band.onStagePropsChange} />
//
// 全專案共用，存在 project 上（lib/stageProps.ts 寫了格式）；製作、導演可以改，其他人只能看（沒有 onStagePropsChange）。
// 改了馬上反映在畫面上，停手 SAVE_DELAY_MS 才合併成一次存；存失敗跳提示，畫面上的修改留著，下一次修改會重新存。
// 離開頁面 / 關分頁前把沒存的送出去。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { toast } from './toast';
import { normalizeStageProps, type StagePropItem } from './stageProps';

const SAVE_DELAY_MS = 600;
const NO_PROPS: StagePropItem[] = [];

export interface StagePropsState {
  stageProps: StagePropItem[];
  /** 有權限改才有；沒有 = 只能看 */
  onStagePropsChange?: (next: StagePropItem[]) => void;
  /** 專案上的清單讀完了沒（讀失敗也算完） */
  loaded: boolean;
}

export function useStageProps(projectId: string | undefined, canEdit: boolean): StagePropsState {
  const [props, setProps] = useState<StagePropItem[]>(NO_PROPS);
  const [loaded, setLoaded] = useState(false);
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
    setProps(NO_PROPS);
    setLoaded(false);
    api.getProjectStageProps(projectId).then((list) => {
      if (cancelled || touchedRef.current) return;
      propsRef.current = list;
      setProps(list);
    }).catch(() => { /* 讀不到就當沒有（舊版後台沒有這個功能） */ }).finally(() => {
      if (!cancelled) setLoaded(true);
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

  const update = useCallback((next: StagePropItem[]) => {
    if (!projectId || !canEdit) return;
    const clean = normalizeStageProps(next);
    propsRef.current = clean;
    touchedRef.current = true;
    setProps(clean);
    const prev = pendingRef.current;
    if (prev) clearTimeout(prev.timer);
    pendingRef.current = { projectId, timer: window.setTimeout(() => flush(), SAVE_DELAY_MS) };
  }, [projectId, canEdit, flush]);

  return useMemo(() => ({
    stageProps: props,
    onStagePropsChange: canEdit ? update : undefined,
    loaded,
  }), [props, canEdit, update, loaded]);
}
