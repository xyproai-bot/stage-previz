// IndexedDB cache for VideoTimeline 縮圖
//
// 為何 IndexedDB 不用 localStorage：
//   - localStorage 限 5MB；24 張縮圖 ~24 * 8KB = 192KB / video，多 video 後會爆
//   - IndexedDB 限 ~50MB+，且能存 Blob 不需 base64
//
// Key 格式：{songId}:{driveFileId}:{idx}/{count}/{w}x{h}
// （加版本參數確保 schema 變更時自動 invalidate）

const DB_NAME = 'stage-previz-thumbs';
const STORE = 'thumbs';
const DB_VERSION = 1;

interface ThumbRecord {
  key: string;
  blob: Blob;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export function thumbKey(srcKey: string, idx: number, count: number, w: number, h: number): string {
  return `${srcKey}|${idx}/${count}|${w}x${h}`;
}

export async function getThumb(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as ThumbRecord | undefined)?.blob || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putThumb(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, blob, createdAt: Date.now() } satisfies ThumbRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* swallow — cache is best-effort */
  }
}

/** 清理超過 N 天的舊 thumbs（手動觸發即可，非必要） */
export async function pruneOldThumbs(maxAgeDays = 30): Promise<number> {
  try {
    const db = await openDb();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return await new Promise<number>((resolve, reject) => {
      let count = 0;
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('createdAt');
      idx.openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cur) { cur.delete(); count++; cur.continue(); }
      };
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}
