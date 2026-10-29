// 一首歌的「音樂」那一行：檔名、長度、大小；製作和導演可以上傳 / 換音樂 / 移除（站內確認框），動畫師只看得到有沒有。
//   編輯頁的歌單每首歌一行、導演頁在影片版本列下面一行，共用這個。
//   上傳：先用瀏覽器量長度（打不開的檔案在這裡就擋掉）→ 一個請求傳完（有進度、可以取消）→ 成功後 onChange(新的音樂)。
//   後台的規則（格式、大小、誰能傳）見 docs/music-api.md；畫面只是先擋，後台會再檢查一次。
import { useEffect, useRef, useState } from 'react';
import { Music, Replace, Trash2, Upload, X } from 'lucide-react';
import Icon from './Icon';
import './SongMusicField.css';
import { toast } from '../lib/toast';
import type { SongMusic, SongMusicSummary } from '../lib/musicApi';
import { runMusicRemove, runMusicUpload } from '../lib/songMusicUpload';
import { MUSIC_ACCEPT, MUSIC_FORMATS_TEXT, MUSIC_MAX_BYTES, MUSIC_TEXT, formatMusicDuration, formatMusicSize, musicLine } from '../lib/songMusic';

interface Props {
  projectId: string;
  songId: string;
  music: SongMusicSummary | null;
  /** 製作和導演 = true；動畫師只能聽 */
  canEdit: boolean;
  /** 這首歌有影片（有影片就聽影片的聲音，音樂不會播） */
  hasVideo?: boolean;
  /** 上傳（含換）成功 → 新的音樂；移除成功 → null */
  onChange: (music: SongMusic | null) => void;
  /** 預覽別人的畫面（用其他身分看）：按鈕按下去不做事，只提醒 */
  guard?: <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => void;
  /** 'bar' = 導演頁：獨立的一條（跟影片版本列一樣有底色和底線）；不給 = 編輯頁歌單裡的小字一行 */
  variant?: 'bar';
}

type Phase = 'idle' | 'checking' | 'uploading' | 'removing';

export default function SongMusicField({ projectId, songId, music, canEdit, hasVideo = false, onChange, guard, variant }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const songRef = useRef(songId);
  songRef.current = songId;

  // 換歌：說明清掉。離開這個畫面（或換歌，導演頁一個欄位換著用）時上傳到一半的只能取消，要讓人知道
  const goneRef = useRef(false);
  useEffect(() => {
    goneRef.current = false;
    setError(null);
    setPhase('idle');   // 換歌：上一首沒做完的不要留在這一首的畫面上
    setProgress(0);
    return () => {
      goneRef.current = true;
      if (abortRef.current) {
        abortRef.current.abort();
        toast.warn('音樂上傳中斷了（離開了這個畫面），請再傳一次');
      }
    };
  }, [songId]);

  // 上傳到一半關頁面 / 重新整理 → 先問一聲（不然檔案白傳）
  useEffect(() => {
    if (phase !== 'uploading') return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [phase]);

  const busy = phase !== 'idle';
  const pick = () => inputRef.current?.click();

  async function handleFile(file: File) {
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const forSong = songId;
    const alive = () => songRef.current === forSong && !goneRef.current;
    setProgress(0);
    const out = await runMusicUpload({
      projectId, songId, file, existing: music, signal: ctrl.signal,
      onPhase: (p) => { if (alive()) setPhase(p); },
      onProgress: (loaded, total) => { if (alive()) setProgress(total > 0 ? loaded / total : 0); },
    });
    abortRef.current = null;
    if (!alive()) return;     // 換歌 / 離開畫面了：呼叫的人已經不在，不要再改畫面
    setPhase('idle');
    switch (out.kind) {
      case 'done':
        onChange(out.music);
        toast.success(out.replaced ? `已換成「${out.music.filename}」` : `已上傳音樂「${out.music.filename}」`);
        break;
      case 'cancelled': toast.info('已取消上傳'); break;
      case 'rejected': case 'unreadable': case 'failed': setError(out.text); break;
      case 'declined': break;
    }
  }

  async function handleRemove() {
    if (!music) return;
    setError(null);
    const forSong = songId;
    setPhase('removing');
    const out = await runMusicRemove({ projectId, songId, existing: music });
    if (songRef.current !== forSong || goneRef.current) return;
    setPhase('idle');
    if (out.kind === 'removed') { onChange(null); toast.success('已移除這首歌的音樂'); }
    else if (out.kind === 'failed') setError(out.text);
  }

  const run = (fn: () => void) => (guard ? guard(fn) : fn);
  const pct = Math.round(progress * 100);
  // 只能聽的人（動畫師）、這首歌又沒有音樂：沒有什麼好顯示的
  if (!music && !canEdit && phase === 'idle') return null;

  return (
    <div className={'song-music' + (variant === 'bar' ? ' song-music--bar' : '')} onClick={(e) => e.stopPropagation()}>
      <div className="song-music__row">
        <span className="song-music__label"><Icon icon={Music} size="xs" /> {MUSIC_TEXT.rowLabel}</span>
        {phase === 'uploading' || phase === 'checking' ? (
          <>
            <span className="song-music__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase === 'uploading' ? pct : undefined} aria-label="音樂上傳進度">
              <span className="song-music__progress-fill" style={{ width: phase === 'uploading' ? `${pct}%` : '0%' }} />
            </span>
            <span className="song-music__pct">{phase === 'uploading' ? `上傳中 ${pct}%` : '檢查檔案…'}</span>
            {phase === 'uploading' && (
              <button type="button" className="song-music__btn" onClick={() => abortRef.current?.abort()} title="取消上傳" aria-label="取消上傳"><Icon icon={X} size="xs" /> {MUSIC_TEXT.cancel}</button>
            )}
          </>
        ) : music ? (
          <>
            <span className="song-music__name" title={musicLine(music)}>{music.filename}</span>
            <span className="song-music__meta">{[formatMusicDuration(music.durationSec), music.sizeBytes ? formatMusicSize(music.sizeBytes) : ''].filter(Boolean).join(' · ')}</span>
            {canEdit && (
              <>
                <button type="button" className="song-music__btn" onClick={run(pick)} disabled={busy} title={`換成別的音樂檔（${MUSIC_FORMATS_TEXT}）`}><Icon icon={Replace} size="xs" /> {MUSIC_TEXT.replace}</button>
                <button type="button" className="song-music__btn song-music__btn--danger" onClick={run(() => { void handleRemove(); })} disabled={busy} title="把這首歌的音樂拿掉"><Icon icon={Trash2} size="xs" /> {MUSIC_TEXT.remove}</button>
              </>
            )}
          </>
        ) : (
          <>
            <span className="song-music__none">{MUSIC_TEXT.none}</span>
            <button type="button" className="song-music__btn song-music__btn--add" onClick={run(pick)} disabled={busy} title={`上傳這首歌的音樂（${MUSIC_FORMATS_TEXT}，最大 ${formatMusicSize(MUSIC_MAX_BYTES)}）。沒有影片的歌，機關時間軸和 3D 會跟著音樂走`}><Icon icon={Upload} size="xs" /> {MUSIC_TEXT.upload}</button>
          </>
        )}
      </div>
      {music && hasVideo && <div className="song-music__note">{MUSIC_TEXT.hasVideoNote}</div>}
      {error && <div className="song-music__error field-error small" role="alert">{error}</div>}
      {canEdit && (
        <input
          ref={inputRef}
          type="file"
          accept={MUSIC_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';   // 同一個檔案可以再選一次
            if (f) void handleFile(f);
          }}
        />
      )}
    </div>
  );
}
