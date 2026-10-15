// 版型底圖存在這台電腦的瀏覽器裡（IndexedDB），鍵 = 專案 + 版型代號（lib/ledTemplateBackdrop.ts 的 backdropKey）。
// 不上傳、不進後台；換一台電腦、清掉瀏覽器資料就沒有了（要重新載入）。
// 每一次讀寫都包 try/catch：無痕視窗、儲存空間滿了、瀏覽器不給存都不會讓編輯器壞掉，只是這次存不下來。

import { normalizeBackdropPrefs, type BackdropPrefs } from './ledTemplateBackdrop';

const DB_NAME = 'sp-led-template-backdrop';
const STORE = 'backdrops';
const VERSION = 1;

export interface StoredBackdrop {
  key: string;
  blob: Blob;
  name: string;
  prefs: BackdropPrefs;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); } catch { /* 下面開不起來就當沒有 */ }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch { /* 已經關了 */ } dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then((db) => {
    if (!db) dbPromise = null;   // 下次再試一次
    return db;
  });
  return dbPromise;
}

/** 開一個交易跑 fn；任何一步出錯 = 回傳 fallback */
async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | null, pick: (req: IDBRequest | null) => T, fallback: T): Promise<T> {
  try {
    const db = await openDb();
    if (!db) return fallback;
    return await new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(pick(req));
        tx.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  } catch {
    return fallback;
  }
}

function toStored(raw: unknown): StoredBackdrop | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || !(r.blob instanceof Blob) || r.blob.size <= 0) return null;
  return {
    key: r.key,
    blob: r.blob,
    name: typeof r.name === 'string' && r.name ? r.name : '底圖',
    prefs: normalizeBackdropPrefs(r.prefs),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

export async function loadBackdrop(key: string): Promise<StoredBackdrop | null> {
  return run<StoredBackdrop | null>('readonly', s => s.get(key), req => toStored(req?.result), null);
}

/** 存一張底圖（連同設定）；成功 = true */
export async function saveBackdrop(rec: StoredBackdrop): Promise<boolean> {
  return run<boolean>('readwrite', s => s.put(rec), () => true, false);
}

/** 只改設定（拉桿、開關）：讀出來改完寫回去；沒有這筆 = false */
export async function saveBackdropPrefs(key: string, prefs: BackdropPrefs): Promise<boolean> {
  const cur = await loadBackdrop(key);
  if (!cur) return false;
  return saveBackdrop({ ...cur, prefs, updatedAt: Date.now() });
}

export async function deleteBackdrop(key: string): Promise<boolean> {
  return run<boolean>('readwrite', s => s.delete(key), () => true, false);
}

/** 新版型存好、拿到真正的代號以後，把底圖搬過去；沒有這筆 = false */
export async function moveBackdrop(fromKey: string, toKey: string): Promise<boolean> {
  if (fromKey === toKey) return true;
  const cur = await loadBackdrop(fromKey);
  if (!cur) return false;
  const ok = await saveBackdrop({ ...cur, key: toKey, updatedAt: Date.now() });
  if (ok) await deleteBackdrop(fromKey);
  return ok;
}
