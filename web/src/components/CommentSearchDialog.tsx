import { useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import type { Song, SongComment } from '../lib/api';
import './CommentSearchDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  songs: Song[];
  onClose: () => void;
  /** 點某條留言 → 跳到該歌 + 對應留言（上層決定怎麼處理 routing） */
  onJump?: (songId: string, commentId: string) => void;
}

interface Hit {
  songId: string;
  songName: string;
  comment: SongComment;
}

/**
 * 跨歌曲搜尋專案內所有留言（client-side aggregate）。
 * 用 listSongComments 對每首歌拉一次，cache 在 Map，避免每次 query 重打。
 */
export default function CommentSearchDialog({ open, projectId, songs, onClose, onJump }: Props) {
  const [allComments, setAllComments] = useState<Map<string, SongComment[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'resolved'>('open');

  // 開啟時批次抓所有歌的留言
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setProgress({ done: 0, total: songs.length });
    const map = new Map<string, SongComment[]>();
    let cancelled = false;

    (async () => {
      // 控制併發 4 個（避免轟炸 worker）
      const queue = [...songs];
      const inflight: Promise<void>[] = [];
      const work = async () => {
        while (queue.length > 0) {
          if (cancelled) return;
          const s = queue.shift();
          if (!s) return;
          try {
            const list = await api.listSongComments(projectId, s.id);
            if (!cancelled) {
              map.set(s.id, list);
              setAllComments(new Map(map));
              setProgress(p => ({ ...p, done: p.done + 1 }));
            }
          } catch {
            if (!cancelled) setProgress(p => ({ ...p, done: p.done + 1 }));
          }
        }
      };
      for (let i = 0; i < 4; i++) inflight.push(work());
      await Promise.all(inflight);
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [open, projectId, songs]);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Hit[] = [];
    for (const s of songs) {
      const list = allComments.get(s.id) || [];
      for (const c of list) {
        if (filterStatus !== 'all' && (c.status ?? 'open') !== filterStatus) continue;
        if (q) {
          const blob = `${c.text} ${c.author}`.toLowerCase();
          if (!blob.includes(q)) continue;
        }
        out.push({ songId: s.id, songName: s.name, comment: c });
      }
    }
    out.sort((a, b) => b.comment.createdAt.localeCompare(a.comment.createdAt));
    return out;
  }, [allComments, songs, query, filterStatus]);

  // 鍵盤 Esc 關
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg cmt-search-dlg">
        <header className="dlg__header">
          <h2>🔍 搜尋專案留言</h2>
          <button className="dlg__close" onClick={onClose}>×</button>
        </header>
        <div className="cmt-search-dlg__filters">
          <input
            type="text"
            className="cmt-search-dlg__input"
            placeholder="輸入關鍵字（內文 / 作者）…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as 'all' | 'open' | 'resolved')}>
            <option value="open">未解決</option>
            <option value="resolved">已解決</option>
            <option value="all">全部</option>
          </select>
        </div>
        <div className="cmt-search-dlg__progress">
          {loading
            ? `🔄 抓留言中… ${progress.done}/${progress.total} 首歌`
            : `✓ 已掃 ${progress.done} 首歌，找到 ${hits.length} 則符合的留言`
          }
        </div>
        <div className="cmt-search-dlg__list">
          {hits.length === 0 ? (
            <div className="cmt-search-dlg__empty">
              {query.trim() ? `沒有符合「${query}」的留言` : '輸入關鍵字開始搜尋'}
            </div>
          ) : (
            <ul>
              {hits.map(h => (
                <li key={h.comment.id} className={'cmt-search-row cmt-search-row--' + h.comment.role}>
                  <button
                    className="cmt-search-row__btn"
                    onClick={() => onJump?.(h.songId, h.comment.id)}
                  >
                    <div className="cmt-search-row__head">
                      <span className="cmt-search-row__song">🎵 {h.songName}</span>
                      <span className="cmt-search-row__author">{h.comment.author}</span>
                      {h.comment.time > 0 && <span className="cmt-search-row__time">📍 {formatTimeMS(h.comment.time)}</span>}
                      {h.comment.status === 'resolved' && <span className="cmt-search-row__resolved">✓</span>}
                    </div>
                    <div className="cmt-search-row__text">
                      {highlight(h.comment.text, query)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q.trim()) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(ql, i);
    if (idx < 0) { out.push(text.slice(i)); break; }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  return <>{out}</>;
}

function formatTimeMS(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
