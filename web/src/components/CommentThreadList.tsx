// 留言串清單（導演頁、動畫師工作站、分享連結的訪客共用）：一則留言 + 底下的回覆（一層）。
//   每則有版本小標籤（V2；沒綁版本的舊留言寫「舊留言」）、影片時間 / 區段（0:12–0:18）、3D 視角、畫記、縮圖、「需修改」的原因
//   點一則（不是按鈕的地方）= 打開：換到那一版、跳到那一格、攝影機飛到當時的視角、疊上畫記、區段循環（lib/review/useReviewSession.ts）
//   播放時離播放頭最近的那則亮起來（activeId），「跟著播放」開著會自己捲過去（只捲清單，不會把整頁捲走）
//   動作：回覆、「已改好（V3）」/ 重新打開、修改、刪除 —— 誰能按看 lib/commentThreads.ts（跟後台一樣）
//   訪客（guestReply）：只能回覆，沒有已改好 / 修改 / 刪除
// 篩選 / 排序由頁面算好（scopeThreads + filterAndSortThreads）傳進來。

import { useEffect, useRef, useState } from 'react';
import { Brackets, Check, Clock, CornerDownRight, MapPin, Pencil, PenLine, RotateCcw, Trash2, Video, X } from 'lucide-react';
import Icon from './Icon';
import * as api from '../lib/api';
import type { Song, SongComment } from '../lib/api';
import type { ProjectRole } from '../lib/mockData';
import {
  canPostComment, canReopenComment, canResolveComment, resolvedLabel, versionChip, type CommentScope, type ScopedThread,
} from '../lib/commentThreads';
import { canModifyComment } from '../lib/songReview';
import { extractMentions } from '../lib/mentions';
import { formatRelativeTime } from '../lib/serverTime';
import { formatClock } from '../lib/localVideo';
import { formatRange } from '../lib/review/timecode';
import { roleLabel } from '../lib/roleLabels';
import { friendlyError } from '../lib/songReview';
import { toast } from '../lib/toast';
import { confirmDialog } from './dialogs';
import { useViewAs } from '../lib/viewAsContext';
import './CommentThreadList.css';

interface Props {
  projectId: string;
  song: Pick<Song, 'id' | 'animatorUserId'>;
  user: { id: string; name: string; role?: string } | null;
  projectRole: ProjectRole | null;
  members: { id: string; name: string }[];
  /** 已經依「這一版 / 全部」、狀態、排序整理好的串 */
  threads: ScopedThread[];
  scope: CommentScope;
  /** 正在看的那一版（回覆時綁這一版） */
  viewedVideoId: string | null;
  /** 最新可以播的一版（「已改好（V3）」記這一版） */
  latest: { id: string; label: string } | null;
  onChange: (list: SongComment[]) => void;
  /** 點留言上的影片時間 → 影片跳過去（沒有 onOpen 時） */
  onSeek?: (time: number) => void;
  /** 點一則留言 = 打開（換版本、跳時間、飛視角、畫記、區段循環） */
  onOpen?: (c: SongComment) => void;
  /** 打開的那則 */
  selectedId?: string | null;
  /** 播放時離播放頭最近的那則（亮起來） */
  activeId?: string | null;
  /** 「跟著播放」：activeId 換了就捲過去（播放中才捲） */
  autoScroll?: boolean;
  /** 多選（導演頁的批次動作） */
  selection?: { ids: Set<string>; toggle: (id: string) => void };
  /** 分享連結的訪客：只能回覆（送出交給頁面） */
  guestReply?: { onSend: (parentId: string, text: string) => Promise<boolean> };
  emptyText: string;
}

/** 捲動最近的可以捲的那一層（清單），不會把整個頁面捲走 */
function scrollIntoContainer(el: HTMLElement) {
  let p = el.parentElement;
  while (p) {
    const st = getComputedStyle(p);
    if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 2) break;
    p = p.parentElement;
  }
  if (!p) return;
  const er = el.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  if (er.top < pr.top + 8) p.scrollBy({ top: er.top - pr.top - 8, behavior: 'smooth' });
  else if (er.bottom > pr.bottom - 8) p.scrollBy({ top: er.bottom - pr.bottom + 8, behavior: 'smooth' });
}

const isInteractive = (t: EventTarget | null) =>
  !!(t as HTMLElement | null)?.closest?.('button, a, input, textarea, select, label');

export default function CommentThreadList({
  projectId, song, user, projectRole, members, threads, scope, viewedVideoId, latest, onChange, onSeek,
  onOpen, selectedId = null, activeId = null, autoScroll = false, selection, guestReply, emptyText,
}: Props) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // 預覽模式（製作用其他身分看）：回覆、已改好、修改、刪除照樣出現但按不下去
  const { ro } = useViewAs();

  // 切歌：收掉打到一半的回覆 / 修改
  useEffect(() => { setReplyTo(null); setReplyText(''); setEditingId(null); }, [song.id]);
  useEffect(() => { if (replyTo) requestAnimationFrame(() => replyRef.current?.focus()); }, [replyTo]);

  // 跟著播放：亮起來的那則換了 → 捲過去
  useEffect(() => {
    if (!autoScroll || !activeId) return;
    const el = document.getElementById(`comment-${activeId}`);
    if (el) scrollIntoContainer(el);
  }, [activeId, autoScroll]);

  const who = { role: projectRole, userId: user?.id ?? null, song };
  const canPost = guestReply ? true : canPostComment(who);

  async function run<T>(fn: () => Promise<SongComment[]>, failMsg: string, after?: () => void): Promise<T | void> {
    setBusy(true);
    try {
      onChange(await fn());
      after?.();
    } catch (e) {
      toast.error(failMsg + friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(parentId: string) {
    const text = replyText.trim();
    if (!text) return;
    if (guestReply) {
      setBusy(true);
      try {
        if (await guestReply.onSend(parentId, text)) { setReplyText(''); setReplyTo(null); }
      } finally { setBusy(false); }
      return;
    }
    void run(() => api.postSongComment(projectId, song.id, {
      text, parentId, videoId: viewedVideoId, mentions: extractMentions(text, members),
    }), '回覆沒送出：', () => { setReplyText(''); setReplyTo(null); });
  }

  function toggleResolved(c: SongComment) {
    if (c.status === 'resolved') {
      void run(() => api.patchSongComment(projectId, song.id, c.id, { status: 'open' }), '沒有重新打開：');
    } else {
      void run(() => api.patchSongComment(projectId, song.id, c.id, { status: 'resolved', resolvedVideoId: latest?.id ?? null }), '沒有標成已改好：');
    }
  }

  function saveEdit(id: string) {
    const text = editText.trim();
    if (!text) return;
    void run(() => api.patchSongComment(projectId, song.id, id, { text }), '修改失敗：', () => setEditingId(null));
  }

  async function remove(c: SongComment, replies: number) {
    if (!(await confirmDialog({
      title: '刪除這則留言？',
      message: replies > 0 ? `底下的 ${replies} 則回覆會一起刪掉。刪了就救不回來。` : '刪了就救不回來。',
      confirmLabel: '刪除',
      destructive: true,
    }))) return;
    void run(() => api.deleteSongComment(projectId, song.id, c.id), '刪除失敗：');
  }

  if (threads.length === 0) return <div className="rvc-empty">{emptyText}</div>;

  const openable = (c: SongComment) => !!onOpen && (c.time > 0 || c.timeEnd != null || !!c.view || !!c.annotation);

  const renderComment = (c: SongComment, opts: { isReply: boolean; thread: ScopedThread }) => {
    const { isReply, thread } = opts;
    const editing = editingId === c.id;
    const chip = versionChip(c);
    const resolved = resolvedLabel(c);
    const mine = !guestReply && canModifyComment(c, user, projectRole);
    const canToggle = !guestReply && !isReply && user && (c.status === 'resolved' ? canReopenComment(c, who) : canResolveComment(c, who));
    const range = c.timeEnd != null && c.timeEnd > c.time;
    const timeLabel = range ? formatRange(c.time, c.timeEnd) : formatClock(c.time);
    const thumb = !isReply ? api.commentThumbSrc(c) : null;
    const canOpen = openable(c);
    const roleText = c.role === 'guest' ? '訪客' : roleLabel(c.role);
    return (
      <div
        id={`comment-${c.id}`}
        className={`rvc-comment rvc-comment--${c.role}${isReply ? ' rvc-comment--reply' : ''}${canOpen ? ' is-openable' : ''}`}
        onClick={canOpen ? (e) => { if (!isInteractive(e.target) && !editing) onOpen!(c); } : undefined}
        title={canOpen ? '點一下：跳到這一格、攝影機飛到留言時的視角' : undefined}
      >
        <div className="rvc-main">
          <div className="rvc-body">
            <div className="rvc-head">
              {!isReply && selection && (
                <input type="checkbox" className="rvc-check" checked={selection.ids.has(c.id)} onChange={() => selection.toggle(c.id)} title="多選" aria-label="多選這則留言" />
              )}
              {isReply && <Icon icon={CornerDownRight} size="xs" className="rvc-reply-mark" />}
              <span className="rvc-author">{c.author}</span>
              <span className={'rvc-role' + (c.role === 'guest' ? ' rvc-role--guest' : '')}>{roleText}</span>
              {!isReply && (chip
                ? <span className={'rvc-chip' + (thread.carried ? ' rvc-chip--carried' : '')} title={thread.carried ? `${chip} 時留的` : `看 ${chip} 時留的`}>{chip}{thread.carried ? ' 的留言' : ''}</span>
                : scope === 'all' && <span className="rvc-chip rvc-chip--legacy" title="還沒有版本號碼時留的">舊留言</span>)}
              {c.kind === 'needs_changes' && <span className="rvc-kind">需修改</span>}
              {(c.time > 0 || range) && (
                onOpen || onSeek
                  ? <button type="button" className="rvc-attach" onClick={() => (onOpen ? onOpen(c) : onSeek!(c.time))} title={range ? '跳到這一段（會一直循環）' : '影片跳到這個時間'}>
                      <Icon icon={range ? Brackets : Clock} size="xs" /> {timeLabel}
                    </button>
                  : <span className="rvc-attach" title="綁在影片時間"><Icon icon={range ? Brackets : Clock} size="xs" /> {timeLabel}</span>
              )}
              {c.view && <span className="rvc-attach rvc-attach--view" title="記住了留言時的 3D 視角"><Icon icon={Video} size="xs" label="3D 視角" /></span>}
              {c.annotation && c.annotation.shapes?.length > 0 && (
                <span className="rvc-attach rvc-attach--ann" title={`畫記 ${c.annotation.shapes.length} 筆`}><Icon icon={PenLine} size="xs" label="畫記" /></span>
              )}
              {c.anchor && c.anchor.type !== 'screen' && (
                <span className="rvc-attach rvc-attach--3d" title="3D 位置"><Icon icon={MapPin} size="xs" label="3D 位置" /></span>
              )}
              {resolved && !isReply && (
                <span className="rvc-resolved" title={c.resolvedBy ? `${c.resolvedBy} 標的（${formatRelativeTime(c.resolvedAt || '')}）` : undefined}>
                  <Icon icon={Check} size="xs" /> {guestReply ? resolved.replace('已改好', '已解決') : resolved}
                </span>
              )}
              <span className="rvc-time">{formatRelativeTime(c.createdAt)}</span>
            </div>
            {editing ? (
              <div className="rvc-editbox">
                <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3} autoFocus aria-label="修改留言" />
                <div className="rvc-row-end">
                  <button type="button" className="rvc-btn" onClick={() => setEditingId(null)}>取消</button>
                  <button type="button" className="rvc-btn rvc-btn--primary" onClick={() => saveEdit(c.id)} disabled={busy || !editText.trim()}>儲存</button>
                </div>
              </div>
            ) : (
              // 需修改的原因：後台存成「需修改：…」（舊版畫面看得懂），這裡已經有「需修改」標籤 → 不重複
              <div className="rvc-text">{c.kind === 'needs_changes' ? c.text.replace(/^需修改：/, '') : c.text}</div>
            )}
          </div>
          {thumb && (
            <button type="button" className="rvc-thumb" onClick={() => onOpen?.(c)} disabled={!onOpen} title="留言時的畫面（點一下打開）" aria-label="留言時的畫面">
              <img src={thumb} alt="" loading="lazy" />
            </button>
          )}
        </div>
        {!editing && (user || guestReply) && (
          <div className="rvc-actions">
            {canPost && (
              <button type="button" className="rvc-act" onClick={() => { setReplyTo(thread.root.id === replyTo ? null : thread.root.id); setReplyText(isReply ? `@${c.author} ` : ''); }} {...ro()}>
                <Icon icon={CornerDownRight} size="xs" /> 回覆
              </button>
            )}
            {canToggle && (
              c.status === 'resolved'
                ? <button type="button" className="rvc-act" onClick={() => toggleResolved(c)} disabled={busy} {...ro('還沒改好：重新打開')}><Icon icon={RotateCcw} size="xs" /> 重新打開</button>
                : <button type="button" className="rvc-act rvc-act--fix" onClick={() => toggleResolved(c)} disabled={busy} {...ro(latest ? `標成在 ${latest.label} 改好了` : '標成改好了')}>
                    <Icon icon={Check} size="xs" /> 已改好{latest ? `（${latest.label}）` : ''}
                  </button>
            )}
            {mine && (
              <>
                <button type="button" className="rvc-act" onClick={() => { setEditingId(c.id); setEditText(c.text); }} aria-label="修改" {...ro('修改')}><Icon icon={Pencil} size="xs" /></button>
                <button type="button" className="rvc-act rvc-act--danger" onClick={() => remove(c, isReply ? 0 : thread.replies.length)} aria-label="刪除" {...ro('刪除')}><Icon icon={Trash2} size="xs" /></button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <ul className="rvc-list">
      {threads.map(t => {
        const ids = [t.root.id, ...t.replies.map(r => r.id)];
        const isActive = !!activeId && ids.includes(activeId);
        const isOpen = !!selectedId && ids.includes(selectedId);
        const guestThread = t.root.role === 'guest' && !guestReply;
        return (
          <li
            key={t.root.id}
            className={'rvc-thread' + (t.greyed ? ' is-greyed' : '') + (selection?.ids.has(t.root.id) ? ' is-selected' : '')
              + (isActive ? ' is-playhead' : '') + (isOpen ? ' is-open' : '')}
          >
            {renderComment(t.root, { isReply: false, thread: t })}
            {t.replies.length > 0 && (
              <ul className="rvc-replies">
                {t.replies.map(r => <li key={r.id}>{renderComment(r, { isReply: true, thread: t })}</li>)}
              </ul>
            )}
            {replyTo === t.root.id && (
              <div className="rvc-replybox">
                {guestThread && <div className="rvc-replybox__note">這是分享連結的訪客留的，你的回覆訪客也看得到</div>}
                <textarea
                  ref={replyRef}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendReply(t.root.id); }
                    if (e.key === 'Escape') setReplyTo(null);
                  }}
                  rows={2}
                  placeholder={guestReply ? '回覆（Ctrl+Enter 送出）' : '回覆（打 @ 加名字可以提及成員；Ctrl+Enter 送出）'}
                  aria-label="回覆"
                />
                <div className="rvc-row-end">
                  <button type="button" className="rvc-btn" onClick={() => setReplyTo(null)} title="取消回覆" aria-label="取消回覆"><Icon icon={X} size="xs" /></button>
                  <button type="button" className="rvc-btn rvc-btn--primary" onClick={() => void sendReply(t.root.id)} disabled={busy || !replyText.trim()}>送出回覆</button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
