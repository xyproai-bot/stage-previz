// 編輯頁歌單上點「影片 V3」打開：這首歌的所有影片版本（新的在前）。
//   每一版：V 號碼、誰交的、什麼時候、說明、狀態（可以播 / 這台電腦播不了；還沒好的：上傳中 / 複製中 N% / 失敗）
//   動作：到導演頁播放（新分頁，直接選到這一版）、刪除（號碼不會再用，跟導演頁 / 工作站的版本列同一句確認）
//   還沒好的：重試 / 繼續上傳 / 取消（跟版本列共用 PendingVideoRow）；這個分頁正在交的用 VideoJobRow
//   ＋ 加影片：開「加影片」視窗，蓋在這個視窗上面（covered 時 Esc 先關上面那個）
// 權限跟後台一樣（lib/songVersions.ts canModifyVideo）；編輯頁只有製作進得來，製作每一版都能刪。
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Copy, ExternalLink, Film, History, LoaderCircle, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { DeletedVersionsList } from './DeletedVersions';
import Icon from './Icon';
import VideoJobRow from './VideoJobRow';
import PendingVideoRow from './PendingVideoRow';
import HelpLink from './HelpLink';
import { confirmDialog, splitQuestion } from './dialogs';
import { toast } from '../lib/toast';
import { useAuth } from '../lib/auth';
import type { Song } from '../lib/api';
import { HELP_ANCHORS } from '../lib/helpLinks';
import { songPageHref } from '../lib/notifications';
import { formatDateTime, formatRelativeTime } from '../lib/serverTime';
import { songTitle } from '../lib/songCode';
import { friendlyError } from '../lib/songReview';
import { canModifyVideo, deleteVersionMessage, removePendingQuestion, type VersionItem } from '../lib/songVersions';
import { songVideoFetcher, useSongVersions } from '../lib/useSongVersions';
import { resumeFileProblem, trackedVideoIds, useStalledUploads } from '../lib/stalledUploads';
import { deleteSongVideo, retrySongVideo, VIDEO_ACCEPT, type SongVideo } from '../lib/videoApi';
import { videoJobs, type VideoJob } from '../lib/videoJobs';
import { usePlayChecks } from '../lib/versionPlayCheck';
import { CANNOT_PLAY_TEXT } from '../lib/videoCheck';
import { useEscapeClose } from '../lib/useEscapeClose';
import { versionTemplateLabel } from '../lib/ledTemplate';
import { timelineVersionLabel } from '../lib/ledTemplateTimeline';
import './NewProjectDialog.css';
import './SongVideosDialog.css';
import './DeletedVersions.css';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  song: Pick<Song, 'id' | 'name' | 'code' | 'animatorUserId' | 'latestVideoId'>;
  /** 這首歌在這個分頁正在交的（上傳 / 貼連結） */
  jobs: readonly VideoJob[];
  /** 「＋ 加影片」 */
  onAdd: () => void;
  /** 上面還蓋著「加影片」視窗：Esc 先關那個 */
  covered?: boolean;
  /** 刪了一版 / 上傳完成 → 歌單重新讀（「影片 V3」跟著變） */
  onChanged: () => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function SongVideosDialog({ open, onClose, projectId, song, jobs, onAdd, covered = false, onChanged }: Props) {
  const { user } = useAuth();
  const label = songTitle(song);
  const fetcher = useMemo(() => songVideoFetcher(projectId), [projectId]);
  // 複製中 / 上傳中的時候每 5 秒更新進度；歌單上的最新版本換了（交好了、別人刪了）就重新讀
  const versions = useSongVersions({ songId: open ? song.id : null, fetcher, storageKey: null, reloadKey: song.latestVideoId });
  const playChecks = usePlayChecks();
  const [busyId, setBusyId] = useState<string | null>(null);
  // 最近刪除（30 天內可以救回來）：刪了一版就重新讀
  const [deletedRev, setDeletedRev] = useState(0);
  const [deletedCount, setDeletedCount] = useState<number | null>(null);
  const isProducer = user?.role === 'admin';

  const perm = { accountRole: user?.role ?? null, projectRole: null, userId: user?.id ?? null, song };
  const canDelete = (it: VersionItem) => canModifyVideo({ ...perm, item: { ...it, source: it.video?.source ?? null } });
  const canModifyPending = (v: SongVideo) => canModifyVideo({ ...perm, item: { kind: 'version', byId: v.createdBy?.id ?? null, source: v.source } });

  // 這個分頁自己在交的有自己的進度列（VideoJobRow），後台清單裡同一版不要再列一次
  const shownJobs = jobs.filter(j => j.phase !== 'canceled');
  const trackedIds = useMemo(() => trackedVideoIds(jobs), [jobs]);
  const others = versions.pending.filter(v => !trackedIds.has(v.id));
  const stalled = useStalledUploads({
    projectId,
    songId: open ? song.id : null,
    pending: versions.pending,
    trackedIds,
    canModify: canModifyPending,
    onFinished: (video) => {
      if (video) toast.success(`「${video.title || label}」上傳完成，變成 ${video.label || '新的一版'}`);
      void versions.reload();
      onChanged();
    },
  });

  // 打開時焦點放進視窗；關掉時回到原本的按鈕（「影片 V3」）
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => { if (prev && document.contains(prev)) prev.focus(); };
  }, [open]);
  // 上面的「加影片」關掉了 → 焦點回到這個視窗
  const wasCovered = useRef(covered);
  useEffect(() => {
    if (wasCovered.current && !covered && open) panelRef.current?.focus();
    wasCovered.current = covered;
  }, [covered, open]);
  // 焦點不在視窗裡（點了空白處）時按 Esc 也會關；焦點在視窗裡由下面 onKeyDown 處理
  useEscapeClose(open && !covered, onClose);

  // 「繼續上傳（選同一個檔案）」
  const fileRef = useRef<HTMLInputElement>(null);
  const resumeRef = useRef<SongVideo | null>(null);

  if (!open) return null;

  async function handleDelete(it: VersionItem) {
    if (!(await confirmDialog({ ...splitQuestion(deleteVersionMessage(it)), confirmLabel: `刪除 ${it.label || '這一版'}`, destructive: true }))) return;
    setBusyId(it.id);
    try {
      await deleteSongVideo(projectId, song.id, it.id);
      toast.success(`已刪除 ${it.label}（30 天內可以在「最近刪除」救回來）`);
      setDeletedRev(n => n + 1);
      await versions.reload();
      onChanged();
      panelRef.current?.focus();
    } catch (e) {
      toast.error('刪除失敗：' + friendlyError(e));
    } finally {
      setBusyId(null);
    }
  }
  async function handleRetry(v: SongVideo) {
    try { await retrySongVideo(projectId, song.id, v.id); await versions.reload(); }
    catch (e) { toast.error('重試失敗：' + friendlyError(e)); }
  }
  async function handleRemove(v: SongVideo) {
    const name = v.title || '這一版';
    if (!(await confirmDialog(removePendingQuestion(v, name)))) return;
    try { await deleteSongVideo(projectId, song.id, v.id); await versions.reload(); }
    catch (e) { toast.error('沒有成功：' + friendlyError(e)); }
  }
  function handleResumeFile(v: SongVideo, file: File) {
    const problem = resumeFileProblem(v, file);
    if (problem) { toast.warn(problem); return; }
    videoJobs.startUpload({ projectId, songId: song.id, songLabel: label, file, note: v.note || undefined, resumeVideoId: v.id });
  }

  // 鍵盤：Esc 關掉；Tab 在視窗裡繞；其他鍵不讓編輯頁的快捷鍵（J / K 換歌、Ctrl+Z）收到
  function onKeyDown(e: React.KeyboardEvent) {
    // 上面蓋著「加影片」：鍵盤交給那個視窗（Esc 先關它）
    if (covered) return;
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      const panel = panelRef.current;
      const list = panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null) : [];
      if (list.length > 0) {
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }
    }
    e.stopPropagation();
  }

  const items = versions.items;
  const hasPending = shownJobs.length > 0 || others.length > 0;

  return (
    <div className="songvid-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className="songvid"
        role="dialog"
        aria-modal="true"
        aria-labelledby="songvid-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="songvid__head">
          <div className="songvid__titles">
            <h2 id="songvid-title">影片版本 · <span className="songvid__song">{label}</span></h2>
            <p className="songvid__sub">新的在前。刪掉的版本號碼不會再用，下一版會接著往上加。</p>
          </div>
          <HelpLink anchor={HELP_ANCHORS.prodVideos} />
          <button type="button" className="songvid__close" onClick={onClose} title="關閉" aria-label="關閉">
            <Icon icon={X} size="md" />
          </button>
        </header>

        <div className="songvid__body">
          {hasPending && (
            <section className="songvid__pending" aria-label="還沒好的影片（上傳中、複製中、失敗）">
              {shownJobs.map(j => <VideoJobRow key={j.id} job={j} compact />)}
              {others.map(v => (
                <PendingVideoRow
                  key={v.id}
                  v={v}
                  detailed
                  can={canModifyPending(v)}
                  view={v.status === 'uploading' ? stalled.views.get(v.id) : undefined}
                  onRetry={handleRetry}
                  onRetryFinish={stalled.retryFinish}
                  onResume={(pv) => { resumeRef.current = pv; fileRef.current?.click(); }}
                  onRemove={handleRemove}
                />
              ))}
            </section>
          )}

          {items.length > 0 ? (
            <ul className="songvid__list" aria-label={`${label} 的影片版本`}>
              {items.map(it => {
                const cannotPlay = playChecks[it.id]?.status === 'cannotPlay';
                const by = it.by ? `${it.by} 交的` : '';
                const when = it.at ? formatDateTime(it.at) : '';
                return (
                  <li key={it.key} className={'songvid-row' + (cannotPlay ? ' has-issue' : '')}>
                    <div className="songvid-row__num">{it.label}</div>
                    <div className="songvid-row__main">
                      <div className="songvid-row__status">
                        {cannotPlay
                          ? <span className="songvid-tag is-error" title={CANNOT_PLAY_TEXT}><Icon icon={TriangleAlert} size="xs" /> 播不了</span>
                          : <span className="songvid-tag is-ok">可以播</span>}
                        {it.video?.isLatest && <span className="songvid-tag is-latest">最新</span>}
                        {it.video?.duplicateOf && (
                          <span className="songvid-tag is-dup" title="檔案跟那一版一模一樣（佔兩份空間）">
                            <Icon icon={Copy} size="xs" /> 跟 {it.video.duplicateOf.sameSong ? '' : `${[it.video.duplicateOf.songCode, it.video.duplicateOf.songName].filter(Boolean).join(' ')} 的 `}{it.video.duplicateOf.label} 重複
                          </span>
                        )}
                        <span className="songvid-row__by" title={it.at ? formatRelativeTime(it.at) : undefined}>
                          {[by, when].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      {it.note
                        ? <div className="songvid-row__note">「{it.note}」</div>
                        : <div className="songvid-row__note is-empty">（沒有寫說明）</div>}
                      {it.title && <div className="songvid-row__file" title={it.title}>{it.title}</div>}
                      {it.template && (
                        <div className="songvid-row__file" title={it.timeline ? '這一版上傳時整條版型時間線（中途換版型）；換版型的時間在上傳那一刻就定了，之後 Cue 或版型改了，這一版照舊貼對' : '這一版做的時候用的 LED 版型；版型之後改了，這一版照舊貼對'}>
                          {it.timeline
                            ? timelineVersionLabel(it.timeline, { width: it.video?.width ?? null, height: it.video?.height ?? null })
                            : versionTemplateLabel(it.template, { width: it.video?.width ?? null, height: it.video?.height ?? null })}
                        </div>
                      )}
                      {cannotPlay && <div className="songvid-row__issue">在這台電腦播的時候發現：{CANNOT_PLAY_TEXT}</div>}
                      {it.video?.duplicateOf && it.video.createdBy?.id && it.video.createdBy.id === user?.id && (
                        <div className="songvid-row__dup">你交的 {it.label} 跟 {it.video.duplicateOf.label} 是同一個檔案。不需要的話可以刪掉 {it.label}（30 天內救得回來）。</div>
                      )}
                    </div>
                    <div className="songvid-row__actions">
                      <a
                        className="songvid-btn"
                        href={songPageHref('preview', projectId, { songId: song.id, videoId: it.id })}
                        target="_blank"
                        rel="noopener"
                        title={`在新分頁打開導演頁，播 ${it.label}`}
                      >
                        <Icon icon={ExternalLink} size="sm" /> 到導演頁播放
                      </a>
                      {canDelete(it) && (
                        <button
                          type="button"
                          className="songvid-btn songvid-btn--danger"
                          onClick={() => void handleDelete(it)}
                          disabled={busyId === it.id}
                        >
                          {busyId === it.id
                            ? <><Icon icon={LoaderCircle} spin size="sm" /> 刪除中…</>
                            : <><Icon icon={Trash2} size="sm" /> 刪除 {it.label}</>}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : versions.status === 'loading' ? (
            <div className="songvid__empty" role="status"><Icon icon={LoaderCircle} spin /> 讀取影片版本中…</div>
          ) : versions.status === 'error' ? (
            <div className="songvid__empty is-error" role="alert">
              <span><Icon icon={CircleAlert} /> {versions.error}</span>
              <button type="button" className="songvid-btn" onClick={() => void versions.reload()}>重試</button>
            </div>
          ) : (
            <div className="songvid__empty">
              <Icon icon={Film} size="xl" className="songvid__empty-icon" />
              <div>這首歌現在沒有可以播的影片</div>
              <small>按下面的「加影片」交一版{hasPending ? '，或等上面那一版好了' : ''}</small>
            </div>
          )}

          {isProducer && (
            <details className="songvid__deleted">
              <summary><Icon icon={History} size="sm" /> 最近刪除{deletedCount ? `（${deletedCount}）` : ''} · 30 天內可以救回來</summary>
              <DeletedVersionsList
                projectId={projectId}
                songId={song.id}
                reloadKey={deletedRev}
                onCount={setDeletedCount}
                onRestored={() => { void versions.reload(); onChanged(); }}
              />
            </details>
          )}
        </div>

        <footer className="songvid__foot">
          <button type="button" className="btn btn--primary songvid__add" onClick={onAdd} title={`幫「${label}」加影片（上傳檔案或貼連結，好了變成下一個版本）`}>
            <Icon icon={Plus} /> 加影片
          </button>
          <span className="songvid__count">{items.length > 0 ? `共 ${items.length} 版` : ''}</span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>關閉</button>
        </footer>

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
            if (f && v) handleResumeFile(v, f);
          }}
        />
      </div>
    </div>
  );
}
