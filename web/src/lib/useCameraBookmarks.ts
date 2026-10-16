// 專案共用的視角書籤：讀、改、存，還有「這台電腦原本存的視角要不要放到專案裡」那一問。
//
// 用法（每個顯示 StageScene 的頁面）：
//   const camBm = useCameraBookmarks(projectId, canEditCameraBookmarks(projectRole));
//   <StageScene cameraBookmarks={camBm.bookmarks} onCameraBookmarksChange={camBm.onChange} />
//
// 全專案共用，存在 project 上（lib/cameraBookmarks.ts 寫了格式）；製作、導演可以改，其他人只能看（沒有 onChange）。
// 改一次存一次（新增 / 改名 / 刪除 / 換順序都是按一下的事，不用等），一份一份照順序送，後面的不會被前面慢的蓋掉；
// 存失敗跳提示，畫面上的修改留著，下一次修改會重新存。
// 專案上的清單沒讀成功之前不給改（不然會把沒看到的清單整份蓋掉）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { toast } from './toast';
import { confirmDialog } from '../components/dialogs/dialogStore';
import {
  localBookmarksKey, localOfferKey, mergeLocalIntoProject, normalizeCameraBookmarks, parseLocalBookmarks, planLocalOffer,
  type CameraBookmark,
} from './cameraBookmarks';

const NO_BOOKMARKS: CameraBookmark[] = [];

export interface CameraBookmarksState {
  bookmarks: CameraBookmark[];
  /** 有權限改、而且專案上的清單讀成功了才有；沒有 = 只能看 */
  onChange?: (next: CameraBookmark[]) => void;
  /** 專案上的清單讀完了沒（讀失敗也算完） */
  loaded: boolean;
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 寫不進去（無痕模式）就算了，下次還會問一次 */ }
}

export function useCameraBookmarks(projectId: string | undefined, canEdit: boolean): CameraBookmarksState {
  const [list, setList] = useState<CameraBookmark[]>(NO_BOOKMARKS);
  const [loaded, setLoaded] = useState(false);
  const [readOk, setReadOk] = useState(false);
  const listRef = useRef<CameraBookmark[]>(NO_BOOKMARKS);
  const touchedRef = useRef(false);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    listRef.current = NO_BOOKMARKS;
    touchedRef.current = false;
    setList(NO_BOOKMARKS);
    setLoaded(false);
    setReadOk(false);
    api.getProjectCameraBookmarks(projectId).then((items) => {
      if (cancelled) return;
      if (!touchedRef.current) { listRef.current = items; setList(items); }
      setReadOk(true);
    }).catch(() => { /* 讀不到就當沒有（舊版後台沒有這個功能） */ }).finally(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  const update = useCallback((next: CameraBookmark[]) => {
    if (!projectId || !canEdit) return;
    const clean = normalizeCameraBookmarks(next);
    listRef.current = clean;
    touchedRef.current = true;
    setList(clean);
    const pid = projectId;
    chainRef.current = chainRef.current
      .then(() => api.saveProjectCameraBookmarks(pid, clean))
      .catch((e) => {
        console.warn('[cameraBookmarks] save failed', e);
        const why = e instanceof Error && e.message ? `：${e.message}` : '';
        toast.error(`視角沒有存到專案上${why}。畫面上的先留著，再動一下就會重新存`);
      });
  }, [projectId, canEdit]);

  // 這台電腦原本存的視角（舊版存在瀏覽器裡，只有自己看得到）：有的話問一次要不要放到專案裡；不會自己刪掉那一份
  const askedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !readOk || !canEdit || askedForRef.current === projectId) return;
    askedForRef.current = projectId;
    const plan = planLocalOffer({
      canEdit,
      projectLoaded: readOk,
      answered: readStorage(localOfferKey(projectId)) !== null,
      local: parseLocalBookmarks(readStorage(localBookmarksKey(projectId))),
      project: listRef.current,
    });
    if (!plan) return;
    void confirmDialog({
      title: plan.question,
      message: '放上去之後，導演、動畫師和看分享連結的人都看得到。這台電腦上原本存的不會被刪掉。',
      confirmLabel: '放上去',
      cancelLabel: '不用',
    }).then((yes) => {
      writeStorage(localOfferKey(projectId), yes ? 'put' : 'skip');
      if (!yes) return;
      const { list: merged, added } = mergeLocalIntoProject(listRef.current, plan.items);
      if (added === 0) { toast.warn('專案上的視角已經滿了，沒有放上去'); return; }
      update(merged);
      toast.success(`已把 ${added} 個視角放到專案裡`);
    });
  }, [projectId, readOk, canEdit, update]);

  return useMemo(() => ({
    bookmarks: list,
    onChange: canEdit && readOk ? update : undefined,
    loaded,
  }), [list, canEdit, readOk, update, loaded]);
}
