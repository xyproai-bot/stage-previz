// Cue 庫專案：各頁面的 cue 都帶 Cue 庫編號。舊模式專案沒有 libraryCue → 一律照原本的樣子（沒有編號）。
// 編號是用戶自己打的文字（「12」「3-1」「301」），照原樣顯示。

export interface HasLibraryCue { name: string; libraryCue?: { label: string; name: string } | null }

/** 編號文字；舊模式專案 / 沒指到 Cue 庫 = null */
export function cueNumLabel(c: Pick<HasLibraryCue, 'libraryCue'>): string | null {
  const l = c.libraryCue?.label?.trim();
  return l ? l : null;
}

/** 「Cue 12 副歌全開」（AE 標記、版型換點的句子）；沒有編號 = 原本的名字 */
export function cueNumName(c: HasLibraryCue): string {
  const l = cueNumLabel(c);
  return l ? `Cue ${l} ${c.libraryCue?.name || c.name}`.trim() : c.name;
}

/** 「Cue 12「副歌全開」」（句子裡）；沒有編號 = 原本的名字 */
export function cueNumQuoted(c: HasLibraryCue): string {
  const l = cueNumLabel(c);
  return l ? `Cue ${l}「${c.libraryCue?.name || c.name}」` : c.name;
}

/** 這首歌裡有幾個 Cue 庫的 cue 也被別的歌使用（整首歌「所有 cue 回到預設」的確認文字用） */
export function sharedLibraryCueCount(
  songId: string,
  cues: readonly { libraryCueId?: string | null }[],
  library: readonly { id: string; usage: { slots: readonly { songId: string }[] } }[],
): number {
  const ids = new Set(cues.map(c => c.libraryCueId).filter((x): x is string => !!x));
  let n = 0;
  for (const id of ids) {
    const lc = library.find(l => l.id === id);
    if (lc && lc.usage.slots.some(s => s.songId !== songId)) n++;
  }
  return n;
}

/** 刪歌的確認文字：Cue 庫專案多說一句 Cue 庫的 cue 不會被刪掉 */
export function deleteSongMessage(libraryMode: boolean): string {
  return libraryMode
    ? '這首歌的 cue 清單會一起刪掉，刪了就救不回來。這首歌用到的 Cue 庫的 cue 不會被刪掉。'
    : '它的所有 cue 會一起刪掉，刪了就救不回來。';
}
