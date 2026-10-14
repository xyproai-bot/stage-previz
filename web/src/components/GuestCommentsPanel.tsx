// 分享連結的「留言」（製作有打開「允許看的人留言」才有）：
//   寫一次名字（記在這台電腦）→ 在影片時間上留言（區段、畫記、3D 視角、縮圖都會一起送）、回覆
//   看得到的：自己這條連結留的留言串 + 團隊在底下的回覆（後台決定，見 cf-worker/guestComments.mjs）
//   點一則 = 換到那一格、攝影機飛到當時的視角、疊上畫記（跟導演頁一樣）
// 留言串的畫面跟導演頁共用 CommentThreadList（訪客只有「回覆」）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, MessageSquareText, UserRound } from 'lucide-react';
import Icon from './Icon';
import CommentThreadList from './CommentThreadList';
import { CommentFilterBar, ReviewCompose, readFollow, saveFollow, type StatusFilter } from './ReviewCompose';
import type { ShareRef, SongComment } from '../lib/api';
import { buildThreads, filterAndSortThreads, scopeThreads } from '../lib/commentThreads';
import {
  GUEST_TEXT_MAX, listGuestComments, postGuestComment, readGuestName, saveGuestName, tidyGuestName,
  type GuestComment, type GuestError,
} from '../lib/review/guestApi';
import type { ReviewSession } from '../lib/review/useReviewSession';
import { useLiveRefresh } from '../lib/liveRefresh';
import { toast } from '../lib/toast';
import './GuestCommentsPanel.css';

/** 訪客的留言 → 留言串清單用的格式 */
export function guestToComment(g: GuestComment): SongComment {
  return { x: 0.5, y: 0.5, email: null, ...g } as SongComment;
}

interface Props {
  shareRef: ShareRef;
  accessToken: string | null;
  songId: string;
  session: ReviewSession;
  videoActive: boolean;
  playing: boolean;
  /** 正在看的那一版（留言綁這一版） */
  videoId: string | null;
  activeId: string | null;
  onOpen: (c: SongComment) => void;
  onStartDraw: () => void;
  composerRef: React.RefObject<HTMLTextAreaElement>;
  /** 小播放器「在 0:12 加留言」 */
  pendingTime: number | null;
  onConsumedPendingTime: () => void;
  /** 留言清單（時間軸上的點用） */
  onComments: (list: SongComment[]) => void;
  /** 通行證過期（401）→ 頁面重新換一張 */
  onAuthError: (e: unknown) => void;
  /** 製作把留言關掉了（403） */
  onDisabled: () => void;
}

export default function GuestCommentsPanel({
  shareRef, accessToken, songId, session, videoActive, playing, videoId, activeId, onOpen, onStartDraw, composerRef,
  pendingTime, onConsumedPendingTime, onComments, onAuthError, onDisabled,
}: Props) {
  const [list, setList] = useState<SongComment[] | null>(null);
  const [name, setName] = useState(readGuestName);
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [attachTime, setAttachTime] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [follow, setFollowState] = useState(readFollow);
  const setFollow = (on: boolean) => { setFollowState(on); saveFollow(on); };
  // 手機 / iPad：可以收起來，舞台大一點
  const [collapsed, setCollapsed] = useState(false);

  const apply = useCallback((rows: GuestComment[]) => {
    const next = rows.map(guestToComment);
    setList(next);
    onComments(next);
  }, [onComments]);

  const handleError = useCallback((e: unknown, quiet = false) => {
    const err = e as GuestError;
    if (err.status === 401) { onAuthError(e); return; }
    if (err.status === 403 && err.commentsDisabled) { onDisabled(); return; }
    if (!quiet) toast.error(err.message || '留言沒有送出');
  }, [onAuthError, onDisabled]);

  const load = useCallback(async (quiet: boolean) => {
    try { apply(await listGuestComments(shareRef, songId, accessToken ?? undefined)); }
    catch (e) { handleError(e, quiet); }
  }, [shareRef, songId, accessToken, apply, handleError]);

  useEffect(() => {
    setList(null);
    setText('');
    setAttachTime(null);
    void load(true);
  }, [load]);
  // 團隊回覆了 → 25 秒內看得到
  useLiveRefresh(() => load(true));

  useEffect(() => {
    if (pendingTime === null) return;
    setAttachTime(pendingTime);
    setCollapsed(false);
    onConsumedPendingTime();
  }, [pendingTime, onConsumedPendingTime]);
  useEffect(() => { if (session.draft.active) setCollapsed(false); }, [session.draft.active]);

  function saveName() {
    const n = tidyGuestName(nameDraft);
    if (!n) { toast.warn('請寫你的名字（團隊會看到這個名字）'); return; }
    saveGuestName(n);
    setName(n);
    setEditingName(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function send() {
    const t = text.trim();
    if (!t) return;
    if (!name) { setEditingName(true); toast.warn('先寫你的名字（只要寫一次）'); return; }
    setPosting(true);
    try {
      const extras = session.collect(videoActive ? attachTime : null);
      apply(await postGuestComment(shareRef, songId, accessToken ?? undefined, { guestName: name, text: t, videoId, ...extras }));
      setText('');
      setAttachTime(null);
      session.afterSend();
      toast.success('留言送出了，製作團隊會看到');
    } catch (e) {
      handleError(e);
    } finally {
      setPosting(false);
    }
  }

  async function reply(parentId: string, t: string): Promise<boolean> {
    if (!name) { setEditingName(true); toast.warn('先寫你的名字（只要寫一次）'); return false; }
    try {
      apply(await postGuestComment(shareRef, songId, accessToken ?? undefined, { guestName: name, text: t, parentId, videoId }));
      return true;
    } catch (e) {
      handleError(e);
      return false;
    }
  }

  const threads = useMemo(() => buildThreads(list ?? []), [list]);
  const scoped = useMemo(() => scopeThreads(threads, 'all', null), [threads]);
  const visible = filterAndSortThreads(scoped, { status, sort: 'time-asc' });
  const counts = {
    open: scoped.filter(t => t.root.status !== 'resolved').length,
    resolved: scoped.filter(t => t.root.status === 'resolved').length,
    all: scoped.length,
  };
  const needName = !name || editingName;

  return (
    <aside className={'share-comments' + (collapsed ? ' is-collapsed' : '')} aria-label="留言">
      <button
        type="button"
        className="share-comments__head"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? '打開留言' : '收起留言'}
      >
        <Icon icon={MessageSquareText} size="sm" />
        <span className="share-comments__title">留言{list ? `（${threads.length}）` : ''}</span>
        <span className="share-comments__sub">製作團隊會看到</span>
        <Icon icon={collapsed ? ChevronUp : ChevronDown} size="sm" className="share-comments__chev" />
      </button>

      {!collapsed && (
        <div className="share-comments__body">
          {needName ? (
            <form className="share-comments__name" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
              <label htmlFor="guest-name">你的名字（只要寫一次，團隊會看到）</label>
              <div className="share-comments__name-row">
                <input
                  id="guest-name"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={30}
                  placeholder="例：王小明（經紀公司）"
                  autoComplete="name"
                />
                <button type="submit" className="btn btn--primary btn--sm" disabled={!nameDraft.trim()}>好</button>
                {name && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditingName(false)}>取消</button>}
              </div>
            </form>
          ) : (
            <div className="share-comments__who">
              <Icon icon={UserRound} size="xs" /> 用「<strong>{name}</strong>」留言
              <button type="button" className="link-btn" onClick={() => { setNameDraft(name); setEditingName(true); }}>改名字</button>
            </div>
          )}

          <div className="share-comments__compose">
            <ReviewCompose
              session={session}
              videoActive={videoActive}
              attachTime={videoActive ? attachTime : null}
              onClearTime={() => setAttachTime(null)}
              onStartDraw={onStartDraw}
            />
            <textarea
              ref={composerRef}
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, GUEST_TEXT_MAX))}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
              rows={3}
              placeholder={session.draft.active
                ? '說明一下畫的是什麼（例：這塊 LED 再亮一點）'
                : videoActive ? '在影片停到的地方留言給製作團隊（Ctrl+Enter 送出）' : '留言給製作團隊（Ctrl+Enter 送出）'}
              aria-label="留言"
            />
            <div className="share-comments__actions">
              <span className="share-comments__count">{text.length > GUEST_TEXT_MAX - 100 ? `${text.length}/${GUEST_TEXT_MAX}` : ''}</span>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void send()} disabled={posting || !text.trim()}>
                {posting ? '送出中…' : '送出'}
              </button>
            </div>
          </div>

          <CommentFilterBar status={status} onStatus={setStatus} counts={counts} follow={follow} onFollow={setFollow} />

          {list === null ? (
            <div className="share-comments__empty">載入中…</div>
          ) : (
            <CommentThreadList
              projectId=""
              song={{ id: songId, animatorUserId: null }}
              user={null}
              projectRole={null}
              members={[]}
              threads={visible}
              scope="all"
              viewedVideoId={videoId}
              latest={null}
              onChange={() => {}}
              onOpen={onOpen}
              selectedId={session.selectedId}
              activeId={activeId}
              autoScroll={follow && playing}
              guestReply={{ onSend: reply }}
              emptyText={threads.length === 0 ? '還沒有留言。停在影片的某一秒寫下你的意見，團隊會在這裡回覆。' : '沒有符合的留言'}
            />
          )}
        </div>
      )}
    </aside>
  );
}
