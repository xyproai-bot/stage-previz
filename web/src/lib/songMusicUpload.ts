// 上傳 / 換 / 移除音樂的流程（SongMusicField 用）：一步一步做，每一步可能停在哪裡都回成一個結果，畫面只負責顯示。
//   上傳：先擋格式 / 大小 → 換音樂的話問一次（舊的會刪掉）→ 用瀏覽器量長度（打不開就擋掉）→ 一個請求傳完（有進度、可取消）
//   移除：問一次 → 刪掉（別人已經移除了也算移除好了）
// 流程裡用到的對話框、量長度、上傳都可以換成假的（deps），songMusicUpload.test.ts 就是這樣測的。
import { confirmDialog } from '../components/dialogs';
import { deleteSongMusic, musicErrorText, uploadSongMusic, type SongMusic, type SongMusicSummary } from './musicApi';
import { MUSIC_FORMATS_TEXT, musicFileProblem, readAudioDuration } from './songMusic';

export type UploadOutcome =
  | { kind: 'rejected'; text: string }          // 這個檔案不能傳（格式不對、太大、空的）
  | { kind: 'declined' }                        // 換音樂時按了「取消」
  | { kind: 'unreadable'; text: string }        // 瀏覽器打不開這個檔案
  | { kind: 'cancelled' }                       // 傳到一半按了「取消」
  | { kind: 'failed'; text: string }            // 後台或網路出錯
  | { kind: 'done'; music: SongMusic; replaced: boolean };

export type RemoveOutcome =
  | { kind: 'declined' }
  | { kind: 'removed' }
  | { kind: 'failed'; text: string };

type Confirm = (o: { title: string; message: string; confirmLabel: string; destructive: boolean }) => Promise<boolean>;

export interface UploadDeps {
  confirm: Confirm;
  readDuration: (file: Blob) => Promise<number | null>;
  upload: typeof uploadSongMusic;
  remove: typeof deleteSongMusic;
}

const realDeps: UploadDeps = {
  confirm: (o) => confirmDialog(o),
  readDuration: (f) => readAudioDuration(f),
  upload: uploadSongMusic,
  remove: deleteSongMusic,
};

export const REPLACE_NOTE = 'cue 設好的時間不會變。';

export async function runMusicUpload(o: {
  projectId: string;
  songId: string;
  file: File;
  /** 這首歌現在的音樂（有 = 換音樂） */
  existing: SongMusicSummary | null;
  signal?: AbortSignal;
  /** 進到哪一步：檢查檔案 → 上傳 */
  onPhase?: (p: 'checking' | 'uploading') => void;
  onProgress?: (loaded: number, total: number) => void;
  deps?: Partial<UploadDeps>;
}): Promise<UploadOutcome> {
  const d = { ...realDeps, ...o.deps };
  const { file, existing } = o;
  const problem = musicFileProblem(file);
  if (problem) return { kind: 'rejected', text: problem };
  if (existing) {
    const ok = await d.confirm({
      title: `把這首歌的音樂換成「${file.name}」？`,
      message: `現在的「${existing.filename}」會從這首歌拿掉，檔案也會刪掉，救不回來。${REPLACE_NOTE}`,
      confirmLabel: '換掉',
      destructive: true,
    });
    if (!ok) return { kind: 'declined' };
  }
  o.onPhase?.('checking');
  const duration = await d.readDuration(file);
  if (duration == null) {
    return {
      kind: 'unreadable',
      text: `瀏覽器打不開「${file.name}」（檔案可能壞了，或這個瀏覽器不支援它的編碼）。請換一個檔案，或轉成 MP3 / WAV 再傳（收 ${MUSIC_FORMATS_TEXT}）`,
    };
  }
  if (o.signal?.aborted) return { kind: 'cancelled' };
  o.onPhase?.('uploading');
  try {
    const music = await d.upload(o.projectId, o.songId, file, { durationSec: duration, signal: o.signal, onProgress: o.onProgress });
    return { kind: 'done', music, replaced: !!existing };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'cancelled' };
    return { kind: 'failed', text: musicErrorText(e) };
  }
}

export async function runMusicRemove(o: {
  projectId: string;
  songId: string;
  existing: SongMusicSummary;
  deps?: Partial<UploadDeps>;
}): Promise<RemoveOutcome> {
  const d = { ...realDeps, ...o.deps };
  const ok = await d.confirm({
    title: '移除這首歌的音樂？',
    message: `「${o.existing.filename}」會從這首歌拿掉，檔案也會刪掉，救不回來。${REPLACE_NOTE}`,
    confirmLabel: '移除',
    destructive: true,
  });
  if (!ok) return { kind: 'declined' };
  try {
    await d.remove(o.projectId, o.songId);
    return { kind: 'removed' };
  } catch (e) {
    // 已經被別人移除了：結果就是你要的
    if ((e as { status?: number } | null)?.status === 404) return { kind: 'removed' };
    return { kind: 'failed', text: musicErrorText(e) };
  }
}
