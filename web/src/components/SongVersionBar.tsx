import { useRef } from 'react';
import { CircleAlert, Copy, Film, History, LoaderCircle, Plus, Trash2, TriangleAlert } from 'lucide-react';
import Icon from './Icon';
import VideoJobRow from './VideoJobRow';
import PendingVideoRow from './PendingVideoRow';
import HelpLink from './HelpLink';
import { HELP_ANCHORS } from '../lib/helpLinks';
import { playCheckNotes } from '../lib/videoCheck';
import { usePlayChecks } from '../lib/versionPlayCheck';
import type { CanvasSize } from '../lib/ledMap';
import { formatDateTime, formatRelativeTime } from '../lib/serverTime';
import { VIDEO_ACCEPT, type SongVideo } from '../lib/videoApi';
import { trackedVideoIds, type StalledView } from '../lib/stalledUploads';
import type { VideoJob } from '../lib/videoJobs';
import type { VersionItem } from '../lib/songVersions';
import { useViewAs } from '../lib/viewAsContext';
import { versionTemplateLabel } from '../lib/ledTemplate';
import { timelineVersionLabel } from '../lib/ledTemplateTimeline';
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
  /** 專案的 LED 畫布大小：貼連結的版本第一次播之後，跟它比（還沒設定 = 不比） */
  ledCanvas?: CanvasSize | null;
  /** 有給才出現「最近刪除」（製作：30 天內可以救回來） */
  onShowDeleted?: () => void;
  /** 現在登入的人（自己交的那一版跟別版重複 → 提醒他） */
  userId?: string | null;
}

/** 「跟 V2 重複」（別首歌：「跟 S03 夜曲 的 V2 重複」） */
export function duplicateLabel(d: NonNullable<SongVideo['duplicateOf']>): string {
  return `跟 ${d.sameSong ? '' : `${[d.songCode, d.songName].filter(Boolean).join(' ')} 的 `}${d.label} 重複`;
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
    (it.timeline
      ? timelineVersionLabel(it.timeline, { width: it.video?.width ?? null, height: it.video?.height ?? null })
      : versionTemplateLabel(it.template, { width: it.video?.width ?? null, height: it.video?.height ?? null })) ?? '',
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
  stalled, onResumePending, onRetryFinish, ledCanvas, onShowDeleted, userId,
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
  // 這台電腦播過的結果：播不了 → 版本上標出來；貼連結的版本（交之前沒檢查過）另外列解析度、位元率、畫布的提醒
  const playChecks = usePlayChecks();
  const notesOf = (it: VersionItem) => playCheckNotes(it.kind === 'version' ? playChecks[it.id] : null, {
    sizeBytes: it.video?.sizeBytes ?? null,
    ledCanvas,
    includeWarnings: !!it.video && it.video.source !== 'upload',
  });
  const selectedNotes = selected ? notesOf(selected) : null;

  return (
    <div className="vbar-wrap">
      <div className="vbar">
        <span className="vbar__title"><Icon icon={Film} size="sm" /> 影片</span>

        {items.length > 0 ? (
          <>
            <div className="vbar__chips" role="radiogroup" aria-label="影片版本">
              {items.map(it => {
                const cannotPlay = notesOf(it).error;
                return (
                  <button
                    key={it.key}
                    type="button"
                    role="radio"
                    aria-checked={it.key === selectedKey}
                    className={'vbar__chip' + (it.key === selectedKey ? ' is-active' : '') + (it.kind === 'drive' ? ' is-drive' : '') + (cannotPlay ? ' has-issue' : '')}
                    onClick={() => onSelect(it.key)}
                    title={versionTooltip(it) + (cannotPlay ? `\n${cannotPlay}` : '')}
                  >
                    <span className="vbar__chip-label">
                      {cannotPlay && <Icon icon={TriangleAlert} size="xs" label="這台電腦播不了" />}
                      {it.video?.duplicateOf && <Icon icon={Copy} size="xs" label={duplicateLabel(it.video.duplicateOf)} />}
                      {it.label}
                    </span>
                    {versionByline(it) && <span className="vbar__chip-by">{versionByline(it)}</span>}
                  </button>
                );
              })}
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
        {onShowDeleted && (
          <button type="button" className="vbar__btn" onClick={onShowDeleted} title="刪掉的版本留 30 天，這段時間可以救回來">
            <Icon icon={History} size="sm" /> 最近刪除
          </button>
        )}
        {onAdd && (
          <button type="button" className="btn btn--sm btn--primary vbar__add" onClick={onAdd} {...ro()}>
            <Icon icon={Plus} size="sm" /> 加影片
          </button>
        )}
      </div>

      {selected && selectedNotes && (selectedNotes.error || selectedNotes.warnings.length > 0) && (
        <div className={'vbar__check' + (selectedNotes.error ? ' is-error' : '')} role={selectedNotes.error ? 'alert' : 'status'}>
          <Icon icon={selectedNotes.error ? CircleAlert : TriangleAlert} size="sm" />
          <div className="vbar__check-text">
            {selectedNotes.error
              ? <span>{selected.label}：{selectedNotes.error}</span>
              : <>
                <span>{selected.label} 是{selected.video?.source === 'drive' ? ' Drive 同步進來' : '貼連結交'}的（交之前沒辦法檢查），播放時發現：</span>
                {selectedNotes.warnings.map(w => <span key={w}>{w}</span>)}
              </>}
          </div>
          <HelpLink anchor={HELP_ANCHORS.animAeExport} />
        </div>
      )}

      {selected?.video?.duplicateOf && (
        <div className="vbar__check" role="status">
          <Icon icon={Copy} size="sm" />
          <div className="vbar__check-text">
            <span>
              {selected.label} {duplicateLabel(selected.video.duplicateOf)}：檔案一模一樣。
              {userId && selected.video.createdBy?.id === userId ? ` 這一版是你交的，不需要的話可以刪掉 ${selected.label}。` : ''}
            </span>
          </div>
        </div>
      )}

      {(shownJobs.length > 0 || others.length > 0) && (
        <div className="vbar__jobs">
          {shownJobs.map(j => <VideoJobRow key={j.id} job={j} compact />)}
          {others.map(v => (
            <PendingVideoRow
              key={v.id}
              v={v}
              can={canModifyPending?.(v) ?? false}
              view={v.status === 'uploading' ? stalled?.get(v.id) : undefined}
              onRetry={onRetryPending}
              onRetryFinish={onRetryFinish}
              onResume={onResumePending ? (pv) => { resumeRef.current = pv; fileRef.current?.click(); } : undefined}
              onRemove={onRemovePending}
            />
          ))}
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
