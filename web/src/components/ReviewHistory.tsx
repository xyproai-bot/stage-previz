// 一首歌的審片紀錄：「V2 需修改 · 導演 王小明 · 10/14 15:20：第二段太亮」「V3 已通過 …」（新的在前）
// 歌單上的「最近一次」換了（別人剛按了通過 / 需修改）→ 自動重抓。

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import Icon, { StatusDot } from './Icon';
import { listSongReviews, type SongReview } from '../lib/reviewApi';
import { reviewLine } from '../lib/reviewHistory';
import { friendlyError } from '../lib/songReview';
import './ReviewHistory.css';

interface Props {
  projectId: string;
  songId: string;
  /** 變了就重抓（用歌單上最近一次的時間） */
  reloadKey?: string | null;
  /** 點紀錄 → 捲到原因那則留言 */
  onOpenComment?: (commentId: string) => void;
  /** 一開始要不要展開 */
  defaultOpen?: boolean;
}

export default function ReviewHistory({ projectId, songId, reloadKey, onOpenComment, defaultOpen = true }: Props) {
  const [reviews, setReviews] = useState<SongReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => { setReviews(null); setError(null); }, [songId]);
  useEffect(() => {
    let cancelled = false;
    listSongReviews(projectId, songId)
      .then(r => { if (!cancelled) { setReviews(r); setError(null); } })
      .catch(e => { if (!cancelled) setError(friendlyError(e)); });
    return () => { cancelled = true; };
  }, [projectId, songId, reloadKey]);

  const count = reviews?.length ?? 0;
  if (reviews && count === 0 && !error) {
    return <div className="review-history review-history--empty">還沒有審片紀錄（導演按「通過」或「需修改」後會記在這裡）</div>;
  }

  return (
    <section className="review-history">
      <button type="button" className="review-history__toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
        審片紀錄{reviews ? `（${count}）` : ''}
      </button>
      {open && (
        error ? <div className="review-history__msg">審片紀錄讀不到：{error}</div>
        : !reviews ? <div className="review-history__msg"><Icon icon={LoaderCircle} spin size="sm" /> 讀取中…</div>
        : (
          <ul className="review-history__list">
            {reviews.map(r => (
              <li key={r.id} className={`review-history__row review-history__row--${r.status}`}>
                <StatusDot status={r.status} />
                <span className="review-history__text">
                  <span className="review-history__line">{reviewLine(r)}{r.reason ? '：' : ''}</span>
                  {r.reason && (
                    r.commentId && onOpenComment
                      ? <button type="button" className="review-history__reason" onClick={() => onOpenComment(r.commentId!)} title="到這則留言">{r.reason}</button>
                      : <span className="review-history__reason">{r.reason}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
