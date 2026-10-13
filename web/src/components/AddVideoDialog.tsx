import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Link2, LoaderCircle, MonitorPlay, Upload, X } from 'lucide-react';
import Icon from './Icon';
import VideoJobRow from './VideoJobRow';
import { VIDEO_ACCEPT, videoMimeForFile, type VideoApiError } from '../lib/videoApi';
import { isJobActive, useVideoJobDone, videoJobs, type VideoJob } from '../lib/videoJobs';
import { detectVideoLink, videoLinkHint } from '../lib/videoLink';
import { songTitle } from '../lib/songCode';
import { friendlyError } from '../lib/songReview';
import './AddVideoDialog.css';

type Way = 'upload' | 'link' | 'local';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  song: { id: string; name: string; code?: string | null };
  /** 這首歌的工作（上傳中 / 複製中…） */
  jobs: readonly VideoJob[];
  /** 能不能交新版（不能的話只剩本地檔案） */
  canUpload: boolean;
  /** 有給才有「本地檔案」：只在這台電腦放到 LED 上，不上傳 */
  onLocalFiles?: (files: File[]) => void;
}

/**
 * 「＋加影片」：三種方法
 *   上傳檔案 —— 拖進來或選檔案，分段上傳（可以續傳），好了變成新的 V 號碼
 *   貼連結   —— Google Drive 單檔 / Dropbox / OneDrive / 直接網址，後台複製一份
 *   本地檔案 —— 只在這台電腦放到 LED 上，不上傳、別人看不到
 * 上傳中可以關掉這個視窗、切到別首歌，上傳會繼續；好了會自動選到新的一版開始播。
 */
export default function AddVideoDialog({ open, onClose, projectId, song, jobs, canUpload, onLocalFiles }: Props) {
  const [way, setWay] = useState<Way>(canUpload ? 'upload' : 'local');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const label = songTitle(song);

  // 打開時回到第一個方法、清掉上次的錯誤
  useEffect(() => {
    if (!open) return;
    setWay(canUpload ? 'upload' : 'local');
    setLinkError(null);
    setFileError(null);
    setDragOver(false);
  }, [open, song.id, canUpload]);

  // Esc 關掉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 這首歌交的影片好了、沒有別的還在做 → 關掉視窗（頁面會選到新的一版開始播）
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const onDone = useCallback((job: VideoJob) => {
    if (!open || job.songId !== song.id || job.projectId !== projectId) return;
    if (jobsRef.current.some(j => j.id !== job.id && isJobActive(j))) return;
    onClose();
  }, [open, song.id, projectId, onClose]);
  useVideoJobDone(onDone);

  const startUpload = (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setFileError(null);
    const file = list[0];
    if (!videoMimeForFile(file)) {
      setFileError(`「${file.name}」不是 MP4 / MOV / WebM 影片。其他格式請先轉成 H.264 MP4 再上傳`);
      return;
    }
    videoJobs.startUpload({ projectId, songId: song.id, songLabel: label, file, note });
    setNote('');
    if (list.length > 1) setFileError(`一次交一個檔案：先上傳「${file.name}」，其他的請再拖一次`);
  };

  const submitLink = async () => {
    const u = url.trim();
    if (!u) { setLinkError('請貼上影片連結'); return; }
    setSubmitting(true);
    setLinkError(null);
    try {
      await videoJobs.addLink({ projectId, songId: song.id, songLabel: label, url: u, note });
      setUrl('');
      setNote('');
    } catch (e) {
      // 後台的說明是中文、可以直接顯示（看不懂的連結、資料夾、沒權限、太大…）
      setLinkError(friendlyError(e as VideoApiError));
    } finally {
      setSubmitting(false);
    }
  };

  const pickLocal = (files: FileList | null) => {
    if (!files || files.length === 0 || !onLocalFiles) return;
    onLocalFiles(Array.from(files));
    onClose();
  };

  if (!open) return null;

  const linkKind = detectVideoLink(url);
  const ways: { key: Way; label: string; icon: typeof Upload; show: boolean }[] = [
    { key: 'upload', label: '上傳檔案', icon: Upload, show: canUpload },
    { key: 'link', label: '貼連結', icon: Link2, show: canUpload },
    { key: 'local', label: '本地檔案', icon: MonitorPlay, show: !!onLocalFiles },
  ];

  return (
    <div className="addvid-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={'addvid' + (dragOver ? ' is-dragover' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="addvid-title"
        onDragOver={(e) => {
          if (way !== 'upload' && way !== 'local') return;
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(false);
          if (way === 'local') pickLocal(e.dataTransfer.files);
          else if (way === 'upload') startUpload(e.dataTransfer.files);
        }}
      >
        <header className="addvid__head">
          <h2 id="addvid-title">加影片 · <span className="addvid__song">{label}</span></h2>
          <button type="button" className="addvid__close" onClick={onClose} title="關閉" aria-label="關閉">
            <Icon icon={X} size="md" />
          </button>
        </header>

        <div className="addvid__ways" role="tablist" aria-label="加影片的方法">
          {ways.filter(w => w.show).map(w => (
            <button
              key={w.key}
              type="button"
              role="tab"
              aria-selected={way === w.key}
              className={'addvid__way' + (way === w.key ? ' is-active' : '')}
              onClick={() => setWay(w.key)}
            >
              <Icon icon={w.icon} size="md" /> {w.label}
            </button>
          ))}
        </div>

        <div className="addvid__body">
          {way !== 'local' && (
            <label className="addvid__field">
              <span>說明（選填，一行）</span>
              <input
                type="text"
                value={note}
                maxLength={200}
                onChange={e => setNote(e.target.value)}
                placeholder="例：修了第二段的轉場"
              />
            </label>
          )}

          {way === 'upload' && (
            <>
              <div
                className="addvid__drop"
                role="button"
                tabIndex={0}
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
              >
                <Icon icon={Upload} size="xl" />
                <strong>把影片拖到這裡，或點這裡選檔案</strong>
                <span>MP4 / MOV / WebM，最大 4 GB。好了會變成這首歌的下一個版本（V1、V2…）</span>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept={VIDEO_ACCEPT}
                hidden
                onChange={(e) => { startUpload(e.target.files); e.target.value = ''; }}
              />
              {fileError && <div className="addvid__error" role="alert">{fileError}</div>}
            </>
          )}

          {way === 'link' && (
            <form className="addvid__link" onSubmit={(e) => { e.preventDefault(); void submitLink(); }}>
              <label className="addvid__field">
                <span>影片連結</span>
                <input
                  type="url"
                  inputMode="url"
                  value={url}
                  onChange={e => { setUrl(e.target.value); setLinkError(null); }}
                  placeholder="https://drive.google.com/file/d/…"
                  autoFocus
                />
              </label>
              <div className={'addvid__hint' + (linkKind === 'invalid' ? ' is-warn' : '')}>{videoLinkHint(linkKind)}</div>
              {linkError && <div className="addvid__error" role="alert">{linkError}</div>}
              <div className="addvid__actions">
                <button type="submit" className="btn btn--primary" disabled={submitting || !url.trim()}>
                  {submitting ? <><Icon icon={LoaderCircle} spin /> 檢查連結中…</> : <><Icon icon={Link2} /> 加入</>}
                </button>
              </div>
              <div className="addvid__hint">後台會複製一份到我們的伺服器，好了變成下一個版本。大檔要幾分鐘，可以先關掉這個視窗。</div>
            </form>
          )}

          {way === 'local' && onLocalFiles && (
            <>
              <div
                className="addvid__drop"
                role="button"
                tabIndex={0}
                onClick={() => localRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); localRef.current?.click(); } }}
              >
                <Icon icon={FolderOpen} size="xl" />
                <strong>選這台電腦裡的影片或圖片，直接放到 LED 上</strong>
                <span>不會上傳、別人看不到；關掉頁面就沒了。要給導演看請用「上傳檔案」。</span>
              </div>
              <input
                ref={localRef}
                type="file"
                accept="video/*,image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(e) => { pickLocal(e.target.files); e.target.value = ''; }}
              />
            </>
          )}

          {jobs.length > 0 && (
            <section className="addvid__jobs" aria-label="這首歌正在交的影片">
              {jobs.map(j => <VideoJobRow key={j.id} job={j} />)}
              {jobs.some(j => j.kind === 'upload' && isJobActive(j)) ? (
                <div className="addvid__hint">可以關掉這個視窗、切到別首歌，上傳會繼續。關掉整個分頁的話上傳會中斷（下次選同一個檔案會接著傳）。</div>
              ) : jobs.some(isJobActive) ? (
                <div className="addvid__hint">複製是在伺服器上做的，關掉這個視窗或分頁也會繼續；好了會變成這首歌的下一個版本。</div>
              ) : null}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
