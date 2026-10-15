// 分享連結的「留言」（製作有打開「允許看的人留言」才有）：
//   寫一次名字（記在這台電腦）→ 在影片時間上留言（區段、畫記、3D 視角、縮圖都會一起送）、回覆
//   看得到的：自己這條連結留的留言串 + 團隊在底下的回覆（後台決定，見 cf-worker/guestComments.mjs）
//   點一則 = 換到那一格、攝影機飛到當時的視角、疊上畫記（跟導演頁一樣）
// 留言串的畫面跟導演頁共用 CommentThreadList（訪客只有「回覆」）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { isTouchDevice, type ReviewSession } from '../lib/review/useReviewSession';
import { isPhoneLayout } from '../lib/viewportVars';
import { useLiveRefresh } from '../lib/liveRefresh';
import { toast } from '../lib/toast';
import { AttachButton, AttachmentDropZone, AttachmentTray } from './CommentAttachments';
import { guestUploader } from '../lib/review/attachmentsApi';
import { draftBlocksSend, useAttachmentDraft } from '../lib/review/useAttachmentDraft';
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
  /** 影片現在的時間（沒選時間時，留言綁在這裡） */
  currentTime: number;
  /** 通行證過期（401）→ 頁面重新換一張 */
  onAuthError: (e: unknown) => void;
  /** 製作把留言關掉了（403） */
  onDisabled: () => void;
  /** 數字變大 = 頁面要這個面板打開（手機的面板預設收起來；畫好記號回到留言框時用） */
  openNonce?: number;
}

export default function GuestCommentsPanel({
  shareRef, accessToken, songId, session, videoActive, playing, videoId, activeId, onOpen, onStartDraw, composerRef,
  pendingTime, onConsumedPendingTime, onComments, currentTime, onAuthError, onDisabled, openNonce = 0,
}: Props) {
  const touch = isTouchDevice();
  const [list, setList] = useState<SongComment[] | null>(null);
  const [name, setName] = useState(readGuestName);
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [text, setText] = useState('');
  // 參考圖片（訪客一則最多 2 張；換歌時還沒送出的拿掉）
  const uploader = useMemo(() => guestUploader(shareRef, songId, accessToken), [shareRef, songId, accessToken]);
  const draft = useAttachmentDraft(uploader, songId);
  const [posting, setPosting] = useState(false);
  const [attachTime, setAttachTime] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [follow, setFollowState] = useState(readFollow);
  const setFollow = (on: boolean) => { setFollowState(on); saveFollow(on); };
  // 手機 / iPad：可以收起來，舞台大一點。手機（窄螢幕）是從底下拉上來的面板，一開始收起來，舞台一進來就看得到
  const [collapsed, setCollapsed] = useState(() => isPhoneLayout());

  // 頁面傳進來的 callback 每次 render 都是新的 → 用 ref 接（不然讀留言的 effect 會一直重跑、打到一半的字被清掉）
  const cbRef = useRef({ onComments, onAuthError, onDisabled });
  cbRef.current = { onComments, onAuthError, onDisabled };

  const apply = useCallback((rows: GuestComment[]) => {
    const next = rows.map(guestToComment);
    setList(next);
    cbRef.current.onComments(next);
  }, []);

  const handleError = useCallback((e: unknown, quiet = false) => {
    const err = e as GuestError;
    if (err.status === 401) { cbRef.current.onAuthError(e); return; }
    if (err.status === 403 && err.commentsDisabled) { cbRef.current.onDisabled(); return; }
    if (!quiet) toast.error(err.message || '留言沒有送出');
  }, []);

  const load = useCallback(async (quiet: boolean) => {
    try { apply(await listGuestComments(shareRef, songId, accessToken ?? undefined)); }
    catch (e) { handleError(e, quiet); }
  }, [shareRef, songId, accessToken, apply, handleError]);

  // 換歌：清掉打到一半的、重新讀（通行證換新的時候只重新讀，不清掉打到一半的字）
  useEffect(() => {
    setList(null);
    setText('');
    setAttachTime(null);
  }, [songId]);
  useEffect(() => { void load(true); }, [load]);
  // 團隊回覆了 → 25 秒內看得到
  useLiveRefresh(() => load(true));

  useEffect(() => {
    if (pendingTime === null) return;
    setAttachTime(pendingTime);
    setCollapsed(false);
    onConsumedPendingTime();
  }, [pendingTime, onConsumedPendingTime]);
  // 開始畫記：iPad 把面板打開（邊畫邊寫說明）；手機要看著舞台畫，面板先收起來，畫好才拉上來（頁面送 openNonce）
  useEffect(() => { if (session.draft.active && !isPhoneLayout()) setCollapsed(false); }, [session.draft.active]);
  useEffect(() => { if (openNonce > 0) setCollapsed(false); }, [openNonce]);
  // 手機：點一則留言 → 面板收下去，才看得到跳過去的那一格、3D 視角和畫記
  const openThread = useCallback((c: SongComment) => {
    if (isPhoneLayout()) setCollapsed(true);
    onOpen(c);
  }, [onOpen]);
  const startDraw = useCallback(() => {
    if (isPhoneLayout()) setCollapsed(true);
    onStartDraw();
  }, [onStartDraw]);

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
    if (!t && !draft.ids.length) return;
    if (draftBlocksSend(draft)) return;
    if (!name) { setEditingName(true); toast.warn('先寫你的名字（只要寫一次）'); return; }
    setPosting(true);
    try {
      const extras = session.collect(videoActive ? attachTime : null);
      apply(await postGuestComment(shareRef, songId, accessToken ?? undefined, { guestName: name, text: t, videoId, attachmentIds: draft.ids, ...extras }));
      draft.clear(false);
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

  async function reply(parentId: string, t: string, attachmentIds: string[]): Promise<boolean> {
    if (!name) { setEditingName(true); toast.warn('先寫你的名字（只要寫一次）'); return false; }
    try {
      apply(await postGuestComment(shareRef, songId, accessToken ?? undefined, { guestName: name, text: t, parentId, videoId, attachmentIds }));
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
              currentTime={currentTime}
              onStartDraw={startDraw}
            />
            <AttachmentDropZone draft={draft}>
              <textarea
                ref={composerRef}
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, GUEST_TEXT_MAX))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
                rows={3}
                placeholder={session.draft.active
                  ? '說明一下畫的是什麼（例：這塊 LED 再亮一點）'
                  : `留言給製作團隊${videoActive ? '（會綁在上面寫的時間）' : ''}；可以貼上參考圖片或影片連結${touch ? '' : '；Ctrl+Enter 送出'}`}
                aria-label="留言"
              />
            </AttachmentDropZone>
            <AttachmentTray draft={draft} />
            <div className="share-comments__actions">
              <AttachButton draft={draft} />
              <span className="share-comments__count">{text.length > GUEST_TEXT_MAX - 100 ? `${text.length}/${GUEST_TEXT_MAX}` : ''}</span>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void send()}
                // 手機、iPad：按「送出」不要讓輸入框失去焦點（鍵盤一收、版面一動，這一下就點歪了）
                onMouseDown={touch ? (e) => e.preventDefault() : undefined}
                disabled={posting || draft.busy || (!text.trim() && !draft.ids.length)}
              >
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
              onOpen={openThread}
              selectedId={session.selectedId}
              activeId={activeId}
              autoScroll={follow && playing}
              guestReply={{ onSend: reply, uploader }}
              emptyText={threads.length === 0 ? '還沒有留言。停在影片的某一秒寫下你的意見，團隊會在這裡回覆。' : '沒有符合的留言'}
            />
          )}
        </div>
      )}
    </aside>
  );
}
