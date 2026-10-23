// 「Cue 庫」分頁的清單邏輯：自然排序、搜尋、篩選、刪除被擋的文字。規格 5.2、第 10 節。
// 排序跟後台 cf-worker/cueLibrary.mjs 的 compareLabels 一樣（1, 2, 2.5, 3, 3-1, 12, 301）。

import type { LibraryCue, LibraryCueUsage } from './cueLibraryApi';

function runs(s: string): string[] {
  return String(s ?? '').trim().toLowerCase().match(/\d+|\D+/g) || [];
}

export function compareLabels(a: string, b: string): number {
  const ra = runs(a), rb = runs(b);
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const x = ra[i], y = rb[i];
    const dx = /^\d/.test(x), dy = /^\d/.test(y);
    if (dx && dy) {
      const nx = Number(x), ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    } else if (dx !== dy) {
      return dx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ra.length === rb.length ? 0 : ra.length < rb.length ? -1 : 1;
}

/** 照編號排；編號一樣（後台不准重複，不會發生）就照建立順序 */
export function sortLibraryCues<T extends { label: string; createdAt: string }>(list: T[]): T[] {
  return list.map((c, i) => ({ c, i }))
    .sort((p, q) => compareLabels(p.c.label, q.c.label) || (p.c.createdAt < q.c.createdAt ? -1 : p.c.createdAt > q.c.createdAt ? 1 : p.i - q.i))
    .map(x => x.c);
}

export type LibraryFilter = 'all' | 'unused';

/** 搜尋（編號或名稱，不分大小寫、只要包含）+ 篩選（全部 / 沒有歌在用），結果照編號排 */
export function filterLibraryCues(list: LibraryCue[], query: string, filter: LibraryFilter): LibraryCue[] {
  const q = query.trim().toLowerCase();
  return sortLibraryCues(list.filter(c => {
    if (filter === 'unused' && c.usage.slotCount > 0) return false;
    if (!q) return true;
    return c.label.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
  }));
}

/** 清單每列的小字 */
export function usageLabel(usage: LibraryCueUsage): string {
  return usage.songCount > 0 ? `用在 ${usage.songCount} 首歌` : '沒有歌在用';
}

/** 在用的歌（每首歌只列一次，寫代號，沒有代號寫歌名） */
export function usageSongList(usage: LibraryCueUsage): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of usage.slots) {
    if (seen.has(s.songId)) continue;
    seen.add(s.songId);
    out.push(s.songCode || s.songName);
  }
  return out;
}

/**
 * 「用在：S01 0:00」那一個連結的字：歌單上現在的代號 / 名字為準
 * （在歌單上改了代號，Cue 庫讀到的資料還是舊的，不照歌單會寫成舊代號）；歌單裡找不到才用後台給的
 */
export function usageSlotText(
  slot: { songId: string; songName: string; songCode: string | null; videoTimeSec: number | null },
  songInfo?: ((songId: string) => { code?: string | null; name: string } | null) | null,
): string {
  const live = songInfo?.(slot.songId) ?? null;
  const code = live ? live.code ?? null : slot.songCode;
  const name = live ? live.name : slot.songName;
  return `${code || name}${slot.videoTimeSec !== null ? ` ${fmtTime(slot.videoTimeSec)}` : ''}`;
}

/** 刪不掉時的說明 */
export function deleteBlockedText(usage: LibraryCueUsage): string {
  return `${usage.songCount} 首歌在用（${usageSongList(usage).join('、')}），先從這些歌拿掉才能刪`;
}

/** 前一個 / 後一個（J / K）；目前沒選到就從頭 / 尾開始。沒有可選的回 null */
export function stepLibraryCue(list: { id: string }[], currentId: string | null, dir: 1 | -1): string | null {
  if (list.length === 0) return null;
  const i = list.findIndex(c => c.id === currentId);
  if (i < 0) return list[dir === 1 ? 0 : list.length - 1].id;
  return list[Math.max(0, Math.min(list.length - 1, i + dir))].id;
}

/** 秒數 → 0:00 */
export function fmtTime(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
