// 留言串清單（導演頁、動畫師工作站共用）：一則留言 + 底下的回覆（一層）。
//   每則有版本小標籤（V2；沒綁版本的舊留言寫「舊留言」）、影片時間（點了跳過去）、3D 位置、「需修改」的原因
//   動作：回覆、「已改好（V3）」/ 重新打開、修改、刪除 —— 誰能按看 lib/commentThreads.ts（跟後台一樣）
//   「這一版」篩選：之前版本帶過來的寫「V1 的留言」，已經改好的灰掉
// 篩選 / 排序由頁面算好（scopeThreads + filterAndSortThreads）傳進來。

import { useEffect, useRef, useState } from 'react';
import { Check, Clock, CornerDownRight, MapPin, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
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
import { roleLabel } from '../lib/roleLabels';
import { friendlyError } from '../lib/songReview';
import { toast } from '../lib/toast';
import { confirmDialog } from './dialogs';
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
  /** 點留言上的影片時間 → 影片跳過去 */
  onSeek?: (time: number) => void;
  /** 多選（導演頁的批次動作） */
  selection?: { ids: Set<string>; toggle: (id: string) => void };
  emptyText: string;
}

export default function CommentThreadList({
  projectId, song, user, projectRole, members, threads, scope, viewedVideoId, latest, onChange, onSeek, selection, emptyText,
}: Props) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // 切歌：收掉打到一半的回覆 / 修改
  useEffect(() => { setReplyTo(null); setReplyText(''); setEditingId(null); }, [song.id]);
  useEffect(() => { if (replyTo) requestAnimationFrame(() => replyRef.current?.focus()); }, [replyTo]);

  const who = { role: projectRole, userId: user?.id ?? null, song };
  const canPost = canPostComment(who);

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

  function sendReply(parentId: string) {
    const text = replyText.trim();
    if (!text) return;
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

  const renderComment = (c: SongComment, opts: { isReply: boolean; thread: ScopedThread }) => {
    const { isReply, thread } = opts;
    const editing = editingId === c.id;
    const chip = versionChip(c);
    const resolved = resolvedLabel(c);
    const mine = canModifyComment(c, user, projectRole);
    const canToggle = !isReply && user && (c.status === 'resolved' ? canReopenComment(c, who) : canResolveComment(c, who));
    return (
      <div id={`comment-${c.id}`} className={`rvc-comment rvc-comment--${c.role}${isReply ? ' rvc-comment--reply' : ''}`}>
        <div className="rvc-head">
          {!isReply && selection && (
            <input type="checkbox" className="rvc-check" checked={selection.ids.has(c.id)} onChange={() => selection.toggle(c.id)} title="多選" aria-label="多選這則留言" />
          )}
          {isReply && <Icon icon={CornerDownRight} size="xs" className="rvc-reply-mark" />}
          <span className="rvc-author">{c.author}</span>
          <span className="rvc-role">{roleLabel(c.role)}</span>
          {!isReply && (chip
            ? <span className={'rvc-chip' + (thread.carried ? ' rvc-chip--carried' : '')} title={thread.carried ? `${chip} 時留的` : `看 ${chip} 時留的`}>{chip}{thread.carried ? ' 的留言' : ''}</span>
            : scope === 'all' && <span className="rvc-chip rvc-chip--legacy" title="還沒有版本號碼時留的">舊留言</span>)}
          {c.kind === 'needs_changes' && <span className="rvc-kind">需修改</span>}
          {c.time > 0 && (
            onSeek
              ? <button type="button" className="rvc-attach" onClick={() => onSeek(c.time)} title="影片跳到這個時間"><Icon icon={Clock} size="xs" /> {formatClock(c.time)}</button>
              : <span className="rvc-attach" title="綁在影片時間"><Icon icon={Clock} size="xs" /> {formatClock(c.time)}</span>
          )}
          {c.anchor && c.anchor.type !== 'screen' && (
            <span className="rvc-attach rvc-attach--3d" title="3D 位置"><Icon icon={MapPin} size="xs" label="3D 位置" /></span>
          )}
          {resolved && !isReply && (
            <span className="rvc-resolved" title={c.resolvedBy ? `${c.resolvedBy} 標的（${formatRelativeTime(c.resolvedAt || '')}）` : undefined}>
              <Icon icon={Check} size="xs" /> {resolved}
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
        {!editing && user && (
          <div className="rvc-actions">
            {canPost && (
              <button type="button" className="rvc-act" onClick={() => { setReplyTo(thread.root.id === replyTo ? null : thread.root.id); setReplyText(isReply ? `@${c.author} ` : ''); }}>
                <Icon icon={CornerDownRight} size="xs" /> 回覆
              </button>
            )}
            {canToggle && (
              c.status === 'resolved'
                ? <button type="button" className="rvc-act" onClick={() => toggleResolved(c)} disabled={busy} title="還沒改好：重新打開"><Icon icon={RotateCcw} size="xs" /> 重新打開</button>
                : <button type="button" className="rvc-act rvc-act--fix" onClick={() => toggleResolved(c)} disabled={busy} title={latest ? `標成在 ${latest.label} 改好了` : '標成改好了'}>
                    <Icon icon={Check} size="xs" /> 已改好{latest ? `（${latest.label}）` : ''}
                  </button>
            )}
            {mine && (
              <>
                <button type="button" className="rvc-act" onClick={() => { setEditingId(c.id); setEditText(c.text); }} title="修改" aria-label="修改"><Icon icon={Pencil} size="xs" /></button>
                <button type="button" className="rvc-act rvc-act--danger" onClick={() => remove(c, isReply ? 0 : thread.replies.length)} title="刪除" aria-label="刪除"><Icon icon={Trash2} size="xs" /></button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <ul className="rvc-list">
      {threads.map(t => (
        <li key={t.root.id} className={'rvc-thread' + (t.greyed ? ' is-greyed' : '') + (selection?.ids.has(t.root.id) ? ' is-selected' : '')}>
          {renderComment(t.root, { isReply: false, thread: t })}
          {t.replies.length > 0 && (
            <ul className="rvc-replies">
              {t.replies.map(r => <li key={r.id}>{renderComment(r, { isReply: true, thread: t })}</li>)}
            </ul>
          )}
          {replyTo === t.root.id && (
            <div className="rvc-replybox">
              <textarea
                ref={replyRef}
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(t.root.id); }
                  if (e.key === 'Escape') setReplyTo(null);
                }}
                rows={2}
                placeholder="回覆（打 @ 加名字可以提及成員；Ctrl+Enter 送出）"
                aria-label="回覆"
              />
              <div className="rvc-row-end">
                <button type="button" className="rvc-btn" onClick={() => setReplyTo(null)} title="取消回覆" aria-label="取消回覆"><Icon icon={X} size="xs" /></button>
                <button type="button" className="rvc-btn rvc-btn--primary" onClick={() => sendReply(t.root.id)} disabled={busy || !replyText.trim()}>送出回覆</button>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
