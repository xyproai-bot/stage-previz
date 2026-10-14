// 留言框上面那一排（導演頁、動畫師工作站、分享連結共用）：這則留言會帶什麼
//   時間：掛在 0:12 / 區段 0:12–0:18（I / O、拖時間軸）/ 畫記的那一格
//   畫記：「畫記」按鈕（暫停在這一格、在 3D 畫面上畫）；畫了 → 「畫記 3 筆」
//   沒特別選時間 → 綁在影片現在的時間（「在 0:12」，按 × 不綁）
//   視角：送出時一定會記住現在的 3D 視角（大家點這則留言時攝影機會飛過來）——只是說明，不是按鈕
// 還有「未解決 / 已解決 / 全部」和「跟著播放」（CommentFilterBar）。

import { Brackets, Clock, Download, PenLine, Pencil, Video, X } from 'lucide-react';
import Icon from './Icon';
import type { ReviewSession } from '../lib/review/useReviewSession';
import { formatClockShort, formatRange } from '../lib/review/timecode';
import './ReviewCompose.css';

interface ComposeProps {
  session: ReviewSession;
  /** 歌曲影片正在 LED 上放（沒有影片 → 沒有時間、區段） */
  videoActive: boolean;
  attachTime: number | null;
  onClearTime: () => void;
  /** 影片現在的時間（沒選時間時，留言綁在這裡） */
  currentTime: number;
  /** 沒給 = 沒有畫記按鈕 */
  onStartDraw?: () => void;
}

export function ReviewCompose({ session, videoActive, attachTime, onClearTime, currentTime, onStartDraw }: ComposeProps) {
  const { draft, range } = session;
  const timeChip = range && videoActive ? (
    <span className="rv-chip rv-chip--range" title="這則留言蓋住這一段（按 I / O 或拖時間軸上面那一條可以改）">
      <Icon icon={Brackets} size="xs" /> 區段 <strong>{formatRange(range.start, range.end)}</strong>
      <button type="button" className="rv-chip__x" onClick={session.clearMarks} title="不要區段" aria-label="不要區段"><Icon icon={X} size="xs" /></button>
    </span>
  ) : draft.active && draft.time != null ? (
    <span className="rv-chip" title="畫記的那一格"><Icon icon={Clock} size="xs" /> 在 <strong>{formatClockShort(draft.time)}</strong></span>
  ) : attachTime != null ? (
    <span className="rv-chip">
      <Icon icon={Clock} size="xs" /> 掛在 <strong>{formatClockShort(attachTime)}</strong>
      <button type="button" className="rv-chip__x" onClick={onClearTime} title="取消綁時間" aria-label="取消綁時間"><Icon icon={X} size="xs" /></button>
    </span>
  ) : videoActive && session.bindNow ? (
    <span className="rv-chip" title="沒有選時間的話，留言綁在影片現在停的這一秒">
      <Icon icon={Clock} size="xs" /> 在 <strong>{formatClockShort(currentTime)}</strong>
      <button type="button" className="rv-chip__x" onClick={() => session.setBindNow(false)} title="不綁時間（整首歌的意見）" aria-label="不綁時間"><Icon icon={X} size="xs" /></button>
    </span>
  ) : videoActive ? (
    <button type="button" className="rv-chip rv-chip--btn" onClick={() => session.setBindNow(true)} title="綁在影片現在的時間">
      <Icon icon={Clock} size="xs" /> 不綁時間
    </button>
  ) : null;

  return (
    <div className="rv-compose" aria-label="這則留言會帶的東西">
      {timeChip}
      {draft.active ? (
        <span className="rv-chip rv-chip--ann">
          <Icon icon={PenLine} size="xs" /> {draft.shapes.length > 0 ? `畫記 ${draft.shapes.length} 筆` : '正在畫記'}
          <button type="button" className="rv-chip__x" onClick={draft.cancel} title="不要畫記" aria-label="不要畫記"><Icon icon={X} size="xs" /></button>
        </span>
      ) : onStartDraw ? (
        <button type="button" className="rv-chip rv-chip--btn" onClick={onStartDraw} title="暫停在這一格，在 3D 畫面上畫箭頭、圈起來">
          <Icon icon={Pencil} size="xs" /> 畫記
        </button>
      ) : null}
      <span className="rv-note" title="送出時會記住現在的 3D 視角；大家點這則留言時，攝影機會飛到這裡">
        <Icon icon={Video} size="xs" /> 會記住現在的視角
      </span>
    </div>
  );
}

export type StatusFilter = 'open' | 'resolved' | 'all';

interface FilterProps {
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  /** 各狀態有幾則（這一版 / 全部篩過之後） */
  counts?: { open: number; resolved: number; all: number };
  follow: boolean;
  onFollow: (on: boolean) => void;
  /** 「匯出留言」 */
  onExport?: () => void;
}

export function CommentFilterBar({ status, onStatus, counts, follow, onFollow, onExport }: FilterProps) {
  const btn = (s: StatusFilter, label: string, title: string) => (
    <button
      type="button" role="tab" aria-selected={status === s}
      className={'comment-scope__btn' + (status === s ? ' is-active' : '')}
      onClick={() => onStatus(s)}
      title={title}
    >{label}{counts ? ` ${counts[s]}` : ''}</button>
  );
  return (
    <div className="comment-filterbar">
      <div className="comment-scope" role="tablist" aria-label="未解決 / 已解決">
        {btn('open', '未解決', '還沒改好的留言')}
        {btn('resolved', '已解決', '已經標「已改好」的留言')}
        {btn('all', '全部', '不管改好了沒')}
      </div>
      <label className="comment-follow" title="播放時，清單自己捲到離播放頭最近的那則留言">
        <input type="checkbox" checked={follow} onChange={e => onFollow(e.target.checked)} /> 跟著播放
      </label>
      {onExport && (
        <button type="button" className="link-btn rv-export-btn" onClick={onExport} title="列印 / 存成 PDF，或下載 CSV">
          <Icon icon={Download} size="xs" /> 匯出留言
        </button>
      )}
    </div>
  );
}

const FOLLOW_KEY = 'sp_comment_follow';
export function readFollow(): boolean {
  try { return localStorage.getItem(FOLLOW_KEY) !== '0'; } catch { return true; }
}
export function saveFollow(on: boolean): void {
  try { localStorage.setItem(FOLLOW_KEY, on ? '1' : '0'); } catch { /* 只是下次不記得 */ }
}
