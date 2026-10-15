// 版型編輯器的「底圖」：載入一張本機圖片墊在版型畫布最底下，記在這台電腦的瀏覽器裡（IndexedDB），鍵 = 專案 + 版型。
// 開關、不透明度、「拉伸 / 原尺寸」也記在一起。存不下來（無痕視窗、空間滿了）= 這次開著的時候照常能用，下次沒有。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  backdropKey, checkBackdropFile, checkBackdropPixels, clampOpacity, DEFAULT_BACKDROP_PREFS,
  type BackdropFit, type BackdropPrefs,
} from './ledTemplateBackdrop';
import { deleteBackdrop, loadBackdrop, moveBackdrop, saveBackdrop, saveBackdropPrefs } from './ledTemplateBackdropStore';

export interface BackdropImage {
  image: HTMLImageElement;
  width: number;
  height: number;
  name: string;
}

export interface TemplateBackdrop {
  /** 讀取中 */
  loading: boolean;
  /** 有底圖 = 解開的圖片；沒有 = null */
  picture: BackdropImage | null;
  prefs: BackdropPrefs;
  /** 這張圖沒存進瀏覽器（只有這次開著的時候看得到） */
  memoryOnly: boolean;
  /** 載入一個檔案；回傳要告訴使用者的錯誤（成功 = null） */
  load: (file: File) => Promise<string | null>;
  remove: () => void;
  setFit: (fit: BackdropFit) => void;
  setOpacity: (opacity: number) => void;
  setVisible: (visible: boolean) => void;
  /** 新版型存好、拿到代號了：底圖跟著搬過去，畫面不閃 */
  adopt: (projectId: string, fromTemplateId: string | null, toTemplateId: string) => Promise<void>;
  /** 版型刪掉了：連這台電腦存的底圖一起清掉 */
  purge: (projectId: string, templateId: string) => Promise<void>;
}

const PREFS_SAVE_DELAY_MS = 350;

function decode(blob: Blob): Promise<{ image: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('這張圖打不開（檔案壞了，或不是圖片）')); };
    image.src = url;
  });
}

/** templateId = 正在編輯的版型代號（還沒存 = null）；沒有在編輯（面板關著）= undefined */
export function useTemplateBackdrop(projectId: string, templateId: string | null | undefined): TemplateBackdrop {
  const key = templateId === undefined ? '' : backdropKey(projectId, templateId);
  const [picture, setPicture] = useState<BackdropImage | null>(null);
  const [prefs, setPrefs] = useState<BackdropPrefs>(DEFAULT_BACKDROP_PREFS);
  const [loading, setLoading] = useState(false);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const urlRef = useRef<string | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const hasPicture = useRef(false);
  hasPicture.current = !!picture;
  /** adopt 的時候：key 換成這個就保留畫面上的圖，不用再讀一次 */
  const adoptKey = useRef<string | null>(null);
  const saveTimer = useRef(0);
  const pendingPrefsKey = useRef('');

  const release = () => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
  };

  const flushPrefs = useCallback(() => {
    if (!saveTimer.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    const k = pendingPrefsKey.current;
    if (k) void saveBackdropPrefs(k, prefsRef.current);
  }, []);

  // 換版型 / 關面板：先把還沒存的設定存掉，再讀這個版型的底圖
  useEffect(() => {
    if (adoptKey.current === key) { adoptKey.current = null; return; }
    let cancelled = false;
    setPicture(null);
    setPrefs(DEFAULT_BACKDROP_PREFS);
    setMemoryOnly(false);
    release();
    if (!key) { setLoading(false); return; }
    setLoading(true);
    (async () => {
      const rec = await loadBackdrop(key);
      if (cancelled) return;
      if (!rec) { setLoading(false); return; }
      try {
        const d = await decode(rec.blob);
        if (cancelled) { URL.revokeObjectURL(d.url); return; }
        urlRef.current = d.url;
        setPicture({ image: d.image, width: d.image.naturalWidth, height: d.image.naturalHeight, name: rec.name });
        setPrefs(rec.prefs);
      } catch (e) {
        console.warn('[ledTemplateBackdrop] 讀不出存的底圖:', e);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; flushPrefs(); };
  }, [key, flushPrefs]);

  useEffect(() => () => { flushPrefs(); release(); }, [flushPrefs]);

  const changePrefs = useCallback((patch: Partial<BackdropPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefs(next);
    if (!hasPicture.current || !keyRef.current) return;
    pendingPrefsKey.current = keyRef.current;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = 0;
      void saveBackdropPrefs(pendingPrefsKey.current, prefsRef.current);
    }, PREFS_SAVE_DELAY_MS);
  }, []);

  const load = useCallback(async (file: File): Promise<string | null> => {
    const bad = checkBackdropFile(file);
    if (bad) return bad;
    const k = keyRef.current;
    if (!k) return '先選一個版型，或新增一個版型';
    let d: { image: HTMLImageElement; url: string };
    try {
      d = await decode(file);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    const size = { width: d.image.naturalWidth, height: d.image.naturalHeight };
    const tooBig = checkBackdropPixels(size);
    if (tooBig) { URL.revokeObjectURL(d.url); return tooBig; }
    if (keyRef.current !== k) { URL.revokeObjectURL(d.url); return null; }   // 解開的時候換版型了
    release();
    urlRef.current = d.url;
    setPicture({ image: d.image, width: size.width, height: size.height, name: file.name });
    // 換一張新的：開關和不透明度沿用，擺法重新問（大小不一樣才會問）
    const next: BackdropPrefs = { ...prefsRef.current, fit: DEFAULT_BACKDROP_PREFS.fit, visible: true };
    prefsRef.current = next;
    setPrefs(next);
    const ok = await saveBackdrop({ key: k, blob: file, name: file.name, prefs: next, updatedAt: Date.now() });
    if (keyRef.current === k) setMemoryOnly(!ok);
    return null;
  }, []);

  const remove = useCallback(() => {
    const k = keyRef.current;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    release();
    setPicture(null);
    setMemoryOnly(false);
    setPrefs(p => ({ ...DEFAULT_BACKDROP_PREFS, opacity: p.opacity }));
    if (k) void deleteBackdrop(k);
  }, []);

  const adopt = useCallback(async (pid: string, fromId: string | null, toId: string) => {
    const from = backdropKey(pid, fromId), to = backdropKey(pid, toId);
    if (from === keyRef.current && hasPicture.current) {
      adoptKey.current = to;
      // 呼叫的人馬上會把版型換成新的代號；萬一沒換，不要留著一個過期的記號
      window.setTimeout(() => { if (adoptKey.current === to) adoptKey.current = null; }, 3000);
    }
    await moveBackdrop(from, to);   // 存不進瀏覽器（只在記憶體裡）就沒搬成：畫面上先留著，下次進來就沒有了
  }, []);

  const purge = useCallback(async (pid: string, tid: string) => {
    await deleteBackdrop(backdropKey(pid, tid));
  }, []);

  return {
    loading, picture, prefs, memoryOnly, load, remove, adopt, purge,
    setFit: useCallback((fit: BackdropFit) => changePrefs({ fit }), [changePrefs]),
    setOpacity: useCallback((o: number) => changePrefs({ opacity: clampOpacity(o) }), [changePrefs]),
    setVisible: useCallback((visible: boolean) => changePrefs({ visible }), [changePrefs]),
  };
}
