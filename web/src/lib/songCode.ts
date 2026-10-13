// 歌曲代號（S01…）：管理頁改代號前先在畫面上檢查一次（規則跟 cf-worker/videos.mjs 的 normalizeSongCodeInput 一樣，
// 後台還會再檢查、也會擋「被別首歌用掉」）。
//   英文字母、數字、中間可以有「-」，1～12 字，存成大寫；S1 和 S01 算同一個。

export const SONG_CODE_MAX = 12;

/** Drive 資料夾怎麼對歌（設定視窗、說明頁共用這一句） */
export const DRIVE_MATCH_RULE = '檔名開頭寫歌曲代號（例如 S03_xxx.mp4）就會自動對到那首歌';
const SONG_CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/;

/** 打的字 → 要存的代號（大寫），或一句中文說哪裡不對 */
export function normalizeSongCode(raw: string): { code: string } | { error: string } {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!code) return { error: '代號不能是空的' };
  if (code.length > SONG_CODE_MAX) return { error: `代號最多 ${SONG_CODE_MAX} 個字` };
  if (!SONG_CODE_RE.test(code)) return { error: '代號只能用英文字母、數字和中間的「-」（例：S01、ENC-1）' };
  return { code };
}

/** 比對用：S1 = S01 = S001 */
export function songCodeKey(code: string): string {
  return String(code || '').trim().toUpperCase().replace(/\d+/g, (d) => String(parseInt(d, 10)));
}

/** 這個代號被這個專案的哪首歌用掉了（自己那首不算）；沒有 → null */
export function songCodeTakenBy<S extends { id: string; code?: string | null }>(code: string, songs: S[], exceptSongId: string): S | null {
  const k = songCodeKey(code);
  return songs.find(s => s.id !== exceptSongId && !!s.code && songCodeKey(s.code) === k) ?? null;
}

/** 歌名前面加代號（S03 主題曲）；沒有代號就只有歌名 */
export function songTitle(song: { name: string; code?: string | null }): string {
  return song.code ? `${song.code} ${song.name}` : song.name;
}
