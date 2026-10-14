import { useRef } from 'react';
import { CircleAlert, Film, LoaderCircle, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import Icon from './Icon';
import VideoJobRow from './VideoJobRow';
import { formatDateTime, formatRelativeTime } from '../lib/serverTime';
import { VIDEO_ACCEPT, videoProgressPercent, videoStatusLabel, type SongVideo } from '../lib/videoApi';
import { pendingUploadText, trackedVideoIds, type StalledView } from '../lib/stalledUploads';
import type { VideoJob } from '../lib/videoJobs';
import type { VersionItem } from '../lib/songVersions';
import { useViewAs } from '../lib/viewAsContext';
import './SongVersionBar.css';

interface Props {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  items: VersionItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** 後台說還沒好的（上傳中 / 複製中 / 失敗） */
  pending: SongVideo[];
  /** 這個分頁正在交的（上傳 / 貼連結） */
  jobs: readonly VideoJob[];
  onRetryLoad?: () => void;
  /** 有給才出現「＋加影片」 */
  onAdd?: () => void;
  canDelete?: (item: VersionItem) => boolean;
  onDelete?: (item: VersionItem) => void;
  /** 還沒好的那一版能不能動（重試 / 拿掉） */
  canModifyPending?: (v: SongVideo) => boolean;
  onRetryPending?: (v: SongVideo) => void;
  onRemovePending?: (v: SongVideo) => void;
  /** 沒有影片時的話 */
  emptyText?: string;
  /** 右邊多放的東西 */
  extra?: React.ReactNode;
  /** 看的時候有人交了新版（lib/newVersionHint.ts）→ 版本旁邊「有新版 V3 · 切換」 */
  newVersion?: { label: string; onSwitch: () => void } | null;
  /** 不是這個分頁在傳的「上傳中」那幾版現在的情況（lib/stalledUploads.ts） */
  stalled?: ReadonlyMap<string, StalledView>;
  /** 「繼續上傳（選同一個檔案）」選好檔案了 */
  onResumePending?: (v: SongVideo, file: File) => void;
  /** 整理成一個檔案沒成功 →「再試一次」 */
  onRetryFinish?: (v: SongVideo) => void;
}

/** 誰交的 · 什麼時候（伺服器時間 → 本地時間） */
export function versionByline(it: Pick<VersionItem, 'by' | 'at'>): string {
  const when = it.at ? formatRelativeTime(it.at) : '';
  return [it.by, when].filter(Boolean).join(' · ');
}

function versionTooltip(it: VersionItem): string {
  const lines = [
    `${it.label}${it.title ? `：${it.title}` : ''}`,
    [it.by ? `${it.by}交的` : '', it.at ? formatDateTime(it.at) : ''].filter(Boolean).join(' · '),
    it.note ? `說明：${it.note}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 一首歌的影片版本列：V3、V2、V1…（新的在前，每個寫誰交的、什麼時候），選的那版的說明，＋加影片。
 * 下面列出正在交的（上傳 / 複製進度）。
 */
export default function SongVersionBar({
  status, error, items, selectedKey, onSelect, pending, jobs, onRetryLoad, onAdd,
  canDelete, onDelete, canModifyPending, onRetryPending, onRemovePending, emptyText, extra, newVersion,
  stalled, onResumePending, onRetryFinish,
}: Props) {
  // 預覽模式（製作用其他身分看）：交影片、刪除、重試…照樣出現但按不下去
  const { ro } = useViewAs();
  // 「繼續上傳（選同一個檔案）」：一個藏起來的選檔案，記得是哪一版要接著傳
  const fileRef = useRef<HTMLInputElement>(null);
  const resumeRef = useRef<SongVideo | null>(null);
  const selected = items.find(it => it.key === selectedKey) ?? null;
  // 這個分頁正在交的那幾版不要重複列（後台清單也看得到）
  const tracked = trackedVideoIds(jobs);
  const others = pending.filter(v => !tracked.has(v.id));
  const shownJobs = jobs.filter(j => j.phase !== 'canceled');

  return (
    <div className="vbar-wrap">
      <div className="vbar">
        <span className="vbar__title"><Icon icon={Film} size="sm" /> 影片</span>

        {items.length > 0 ? (
          <>
            <div className="vbar__chips" role="radiogroup" aria-label="影片版本">
              {items.map(it => (
                <button
                  key={it.key}
                  type="button"
                  role="radio"
                  aria-checked={it.key === selectedKey}
                  className={'vbar__chip' + (it.key === selectedKey ? ' is-active' : '') + (it.kind === 'drive' ? ' is-drive' : '')}
                  onClick={() => onSelect(it.key)}
                  title={versionTooltip(it)}
                >
                  <span className="vbar__chip-label">{it.label}</span>
                  {versionByline(it) && <span className="vbar__chip-by">{versionByline(it)}</span>}
                </button>
              ))}
            </div>
            {newVersion && (
              <span className="vbar__new" role="status">
                <Icon icon={Film} size="xs" /> 有新版 {newVersion.label}
                <button
                  type="button"
                  className="vbar__new-btn"
                  onClick={newVersion.onSwitch}
                  title={`換到 ${newVersion.label}，停在同一秒`}
                >切換</button>
              </span>
            )}
            {selected && (
              <div className="vbar__info" title={versionTooltip(selected)}>
                {selected.note
                  ? <span className="vbar__note">「{selected.note}」</span>
                  : <span className="vbar__muted">{selected.kind === 'drive' ? `舊的 Drive 影片 · ${selected.title}` : selected.title}</span>}
              </div>
            )}
            {selected && onDelete && canDelete?.(selected) && (
              <button type="button" className="vbar__btn" onClick={() => onDelete(selected)} {...ro(`刪掉 ${selected.label}`)}>
                <Icon icon={Trash2} size="sm" /> 刪除 {selected.label}
              </button>
            )}
          </>
        ) : status === 'loading' ? (
          <span className="vbar__muted"><Icon icon={LoaderCircle} spin size="sm" /> 讀取影片中…</span>
        ) : status === 'error' ? (
          <span className="vbar__error">
            <Icon icon={CircleAlert} size="sm" /> {error}
            {onRetryLoad && <button type="button" className="vbar__btn" onClick={onRetryLoad}>重試</button>}
          </span>
        ) : (
          <span className="vbar__muted">{emptyText ?? '這首歌還沒有影片'}</span>
        )}

        <span className="vbar__grow" />
        {extra}
        {onAdd && (
          <button type="button" className="btn btn--sm btn--primary vbar__add" onClick={onAdd} {...ro()}>
            <Icon icon={Plus} size="sm" /> 加影片
          </button>
        )}
      </div>

      {(shownJobs.length > 0 || others.length > 0) && (
        <div className="vbar__jobs">
          {shownJobs.map(j => <VideoJobRow key={j.id} job={j} compact />)}
          {others.map(v => {
            const pct = videoProgressPercent(v);
            const can = canModifyPending?.(v) ?? false;
            const view = v.status === 'uploading' ? stalled?.get(v.id) : undefined;
            const up = v.status === 'uploading' ? pendingUploadText(pct, view, can) : null;
            const finishing = view?.kind === 'finishing' || (view?.kind === 'finish' && can);
            return (
              <div key={v.id} className={`vjob vjob--compact vjob--${v.status === 'failed' || up?.error ? 'failed' : 'copying'}`}>
                <div className="vjob__top">
                  <span className="vjob__name" title={v.title || v.originalUrl || ''}>{v.title || v.originalUrl || '影片'}</span>
                  <span className="vjob__grow" />
                  {can && v.status === 'failed' && v.source !== 'upload' && onRetryPending && (
                    <button type="button" className="vjob__btn" onClick={() => onRetryPending(v)} {...ro()}>
                      <Icon icon={RotateCcw} size="sm" /> 重試
                    </button>
                  )}
                  {can && view?.kind === 'finishFailed' && onRetryFinish && (
                    <button type="button" className="vjob__btn" onClick={() => onRetryFinish(v)} {...ro()}>
                      <Icon icon={RotateCcw} size="sm" /> 再試一次
                    </button>
                  )}
                  {can && view?.kind === 'resume' && onResumePending && (
                    <button
                      type="button"
                      className="vjob__btn"
                      onClick={() => { resumeRef.current = v; fileRef.current?.click(); }}
                      {...ro('選當初傳的那個檔案，會從停下來的地方接著傳')}
                    >
                      <Icon icon={Upload} size="sm" /> 繼續上傳（選同一個檔案）
                    </button>
                  )}
                  {can && onRemovePending && !finishing && (
                    <button type="button" className="vjob__btn" onClick={() => onRemovePending(v)} {...ro()}>
                      {v.status === 'failed' ? '拿掉' : v.status === 'uploading' ? '取消這次上傳' : '取消'}
                    </button>
                  )}
                </div>
                {v.status !== 'failed' && (
                  <div className={'vjob__bar' + (pct == null || finishing ? ' is-indeterminate' : '')}>
                    <span style={pct != null && !finishing ? { width: `${pct}%` } : undefined} />
                  </div>
                )}
                <div className={'vjob__status' + (v.status === 'failed' || up?.error ? ' is-error' : '')}>
                  {v.status === 'failed'
                    ? (v.error || '失敗了')
                    : up
                    ? up.text
                    : `${videoStatusLabel(v)}${pct != null ? ` ${pct}%` : '…'}`}
                </div>
              </div>
            );
          })}
          {onResumePending && (
            <input
              ref={fileRef}
              type="file"
              accept={VIDEO_ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                const v = resumeRef.current;
                e.target.value = '';
                resumeRef.current = null;
                if (f && v) onResumePending(v, f);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
