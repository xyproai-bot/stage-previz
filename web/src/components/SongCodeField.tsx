import { useEffect, useRef, useState } from 'react';
import { normalizeSongCode, songCodeTakenBy } from '../lib/songCode';
import { friendlyError } from '../lib/songReview';
import { updateSongCode, type VideoApiError } from '../lib/videoApi';
import './SongCodeField.css';

interface Props {
  projectId: string;
  song: { id: string; name: string; code: string | null };
  /** 同一個專案的歌（先在畫面上檢查有沒有撞代號） */
  songs: { id: string; name: string; code: string | null }[];
  /** 存好了（新的代號） */
  onSaved: (code: string) => void;
}

const HINT = '歌曲代號：Drive 檔名開頭寫這個（例如 S03_xxx.mp4）就會自動對到這首歌。點一下可以改';

/** 管理頁歌單上的歌曲代號（S01…）：點一下就能改，Enter 存、Esc 取消；格式不對 / 被別首歌用掉用白話說 */
export default function SongCodeField({ projectId, song, songs, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(song.code ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setText(song.code ?? ''); }, [song.code, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const cancel = () => { setEditing(false); setError(null); setText(song.code ?? ''); };

  const save = async () => {
    if (saving) return;
    const n = normalizeSongCode(text);
    if ('error' in n) { setError(n.error); return; }
    if (n.code === song.code) { cancel(); return; }
    const taken = songCodeTakenBy(n.code, songs, song.id);
    if (taken) { setError(`「${n.code}」已經是「${taken.name}」的代號了，請換一個`); return; }
    setSaving(true);
    try {
      await updateSongCode(projectId, song.id, n.code);
      setEditing(false);
      setError(null);
      onSaved(n.code);
    } catch (e) {
      const err = e as VideoApiError;
      // 409 被別首歌用掉、400 格式不對：後台的說明是中文，直接顯示
      setError(err.status === 409 && !/[一-鿿]/.test(err.message || '')
        ? `「${n.code}」已經被別首歌用了，請換一個`
        : friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={'song-code-field' + (song.code ? '' : ' is-empty')}
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title={HINT}
        aria-label={`歌曲代號 ${song.code ?? '（還沒有）'}，點一下可以改`}
      >
        {song.code ?? '代號'}
      </button>
    );
  }

  return (
    <span className="song-code-field__edit" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className={'song-code-field__input' + (error ? ' is-error' : '')}
        value={text}
        maxLength={12}
        disabled={saving}
        onChange={(e) => { setText(e.target.value.toUpperCase()); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        onBlur={() => { if (!error) void save(); }}
        aria-label="歌曲代號"
        aria-invalid={!!error}
        placeholder="S01"
      />
      {error && <span className="song-code-field__error" role="alert">{error}</span>}
    </span>
  );
}
