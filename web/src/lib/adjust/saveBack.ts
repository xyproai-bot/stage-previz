// 調整舞台第 3 段：存起來要用的純計算和畫面上的字（集中在這裡，才測得到：白話、沒有英文叫人的字、沒有 emoji）
//   - 存回 Cue 庫要送「整份機關位置」：現在存的每一列（值、延遲、走幾秒、carried）+ 導演改過的值
//   - 「這些歌會一起變：S05、S12、S17」
//   - 轉場秒數怎麼打、怎麼說（Cue 庫的 / 這首歌自己設的）

import type { CueMechanismPosition, MechanismValues } from '../mechanisms/model';
import type { StageMechRow, StageSong } from './stageApi';
import type { LibraryCueUsage } from '../cueLibraryApi';

/**
 * 這個 Cue 庫的 cue 現在存的機關位置列。位置清單是「每個 slot 一份」，用到同一個 Cue 庫的 cue 的 slot 內容一樣 → 去重。
 * 沒有任何一列 = 這個 cue 的機關都在預設位置。
 */
export function libraryRowsOf(rows: readonly CueMechanismPosition[], lcId: string): StageMechRow[] {
  const byMech = new Map<string, StageMechRow>();
  for (const r of rows) {
    if (r.libraryCueId !== lcId || byMech.has(r.mechanismId)) continue;
    const carried = r.carried === true;
    byMech.set(r.mechanismId, {
      mechanismId: r.mechanismId, value: r.value,
      delaySec: carried ? null : r.delaySec ?? null, durationSec: carried ? null : r.durationSec ?? null, carried,
    });
  }
  return [...byMech.values()];
}

/**
 * 存回要送的整份：現在存的列，改過的機關換成草稿的值（延遲、走幾秒、carried 原樣）；
 * 原本沒有列的機關（在預設位置）被導演調了 → 新增一列（跟著這個 cue，沒有自己的時間）
 */
export function buildStageRows(current: readonly StageMechRow[], draft: MechanismValues): StageMechRow[] {
  const byMech = new Map(current.map(r => [r.mechanismId, { ...r }]));
  for (const id of Object.keys(draft)) {
    const v = draft[id];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const cur = byMech.get(id);
    if (cur) cur.value = v;
    else byMech.set(id, { mechanismId: id, value: v, delaySec: null, durationSec: null, carried: false });
  }
  return [...byMech.values()];
}

/** 用到這個 cue 的歌（每首歌一筆，照 usage 的順序 = 歌單順序） */
export function usageSongs(usage: Pick<LibraryCueUsage, 'slots'>): StageSong[] {
  const seen = new Set<string>();
  const out: StageSong[] = [];
  for (const s of usage.slots) {
    if (seen.has(s.songId)) continue;
    seen.add(s.songId);
    out.push({ id: s.songId, name: s.songName, code: s.songCode });
  }
  return out;
}

/** 「S05、S12、S17」（沒有代號用歌名）；超過 max 首寫「…等 N 首」 */
export function songsText(songs: readonly Pick<StageSong, 'name' | 'code'>[], max = 12): string {
  const tags = songs.map(s => s.code || s.name || '一首歌');
  return tags.length <= max ? tags.join('、') : `${tags.slice(0, max).join('、')} 等 ${tags.length} 首`;
}

/** 轉場秒數：2 → 2、2.5 → 2.5、2.555 → 2.56 */
export function secText(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 打的轉場秒數（0 到 3600，可以有小數；後面寫「秒」也行） */
export function parseSeconds(input: string): { ok: true; value: number } | { ok: false; error: string } {
  const s = input.trim().replace(/秒$/u, '').trim();
  if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: '請打 0 到 3600 之間的秒數（例如 2 或 1.5）' };
  const n = Number(s);
  if (!Number.isFinite(n) || n > 3600) return { ok: false, error: '請打 0 到 3600 之間的秒數（例如 2 或 1.5）' };
  return { ok: true, value: Math.round(n * 1000) / 1000 };
}

export const defaultSaveAsName = (name: string): string => `${name}（導演改）`;
export const defaultCopyName = (name: string): string => `${name}（複製）`;

export const STAGE_SAVE_TEXT = {
  saveBack: '存回 Cue 庫',
  saveAs: '另存成新 cue',
  discard: '放棄改動',
  undo: '復原',
  reload: '重新載入',
  close: '關掉這則提示',
  barSub: '「存回 Cue 庫」會改到用這個 cue 的每一首歌；「另存成新 cue」只改這首歌。',
  stale: '這個 cue 在你調的時候被別人改過了，直接存回會被擋下來。',
  noCue: '這個 cue 還沒有指到 Cue 庫，沒辦法存（請製作先處理）。',
  oldBackend: '後台還沒更新，這一版先不能存（可以先預覽）。',
  saveBackTitle: (label: string) => `存回 cue ${label}？`,
  saveBackConfirm: '存回',
  usageFailed: '讀不到哪些歌在用這個 cue，先不存（網路有問題？）。',
  unchanged: '跟存的一樣，沒有東西要存。',
  reloadFailed: '已經存好了，但畫面還沒更新到最新，過幾秒會自動更新。',
  saveAsTitle: '另存成新 cue',
  saveAsLabel: '新 cue 的名稱',
  saveAsConfirm: '另存',
  conflictMessage: '你調的還沒有存進去。重新載入會看到最新的樣子（你調的會放棄）；也可以先把你調的另存成新 cue，原本的 cue 不會被動到。',
  conflictKeep: '先不要',
  reloaded: '已重新載入，這個 cue 現在是最新的樣子。',
  copy: '複製',
  rename: '改名',
  seconds: '轉場秒數',
  copyTitle: (label: string) => `複製 cue ${label}`,
  copyLabel: '新 cue 的名稱',
  copyConfirm: '複製',
  renameTitle: (label: string) => `改 cue ${label} 的名字`,
  renameLabel: '名稱',
  renameHint: '只改名字，編號不會變。用到這個 cue 的歌都會看到新名字。',
  renameConfirm: '改名',
  secondsLabel: '轉場秒數',
  secondsConfirm: '改秒數',
  noSelectedCue: '先選一個 cue',
} as const;

/** 存回前的確認說明 */
export function saveBackMessage(songs: readonly Pick<StageSong, 'name' | 'code'>[], changed: number): string {
  const tail = `改了 ${changed} 個機關的位置；物件的位置和顯示都不會動。`;
  return songs.length === 0
    ? `這個 cue 現在沒有歌在用。${tail}`
    : `這些歌會一起變：${songsText(songs)}。\n${tail}`;
}

/** 存完的提示 */
export function savedText(label: string, changed: number, songs: readonly Pick<StageSong, 'name' | 'code'>[]): string {
  const together = songs.length > 0 ? `，${songsText(songs)} 會一起變` : '';
  return `已存回 cue ${label}（改了 ${changed} 個機關${together}）`;
}
export const undoneText = (label: string): string => `已復原 cue ${label}`;
export const savedAsText = (newLabel: string): string => `已另存成 cue ${newLabel}，這首歌改用它`;
export const copiedText = (newLabel: string): string => `已複製成 cue ${newLabel}（放進 Cue 庫了，還沒放進任何一首歌）`;
export const renamedText = (label: string, name: string): string => `cue ${label} 改名成「${name}」`;

/** 另存的輸入框下面的小字 */
export function saveAsHint(label: string): string {
  return `只有這首歌的這個 cue 會換成新的，其他歌照舊用 cue ${label}。編號會自動給（例如 ${label}-1）。`;
}
/** 複製的輸入框下面的小字 */
export function copyHint(label: string, hasDraft: boolean): string {
  return `複製出來的 cue 放進 Cue 庫（編號自動給，例如 ${label}-1），不會放進任何一首歌。`
    + (hasDraft ? '複製的是已經存好的樣子，你現在調的還沒存的不會一起複製。' : '');
}

/** 轉場秒數：這首歌自己設了 → 改這首歌自己的；沒有 → 改 Cue 庫的（用到的歌一起變） */
export function secondsHint(o: { own: boolean; label: string; ownSeconds: number; librarySeconds: number | null; songs: readonly Pick<StageSong, 'name' | 'code'>[] }): string {
  if (o.own) {
    return `這首歌自己設了 ${secText(o.ownSeconds)} 秒，改的是這首歌自己的；Cue 庫的${o.librarySeconds != null ? ` ${secText(o.librarySeconds)} 秒` : '秒數'}和別的歌不會變。`;
  }
  return o.songs.length > 0
    ? `改的是 cue ${o.label} 的轉場（Cue 庫的），這些歌會一起變：${songsText(o.songs)}。`
    : `改的是 cue ${o.label} 的轉場（Cue 庫的）。`;
}
export function secondsTitle(own: boolean, label: string): string {
  return own ? `改這首歌的轉場秒數（cue ${label}）` : `改 cue ${label} 的轉場秒數`;
}
export const secondsDoneText = (own: boolean, label: string, sec: number): string =>
  own ? `這首歌的 cue ${label} 轉場改成 ${secText(sec)} 秒` : `cue ${label} 的轉場改成 ${secText(sec)} 秒（用到的歌一起變）`;
