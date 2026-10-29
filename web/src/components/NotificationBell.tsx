// 站內通知的小鈴鐺（導演頁、動畫師工作站、管理頁的上方列）：
//   未讀數字；點開看清單（最新的在前，依今天 / 昨天 / 更早分組），點一則 → 到那首歌、那一版、那則留言；「全部標為已讀」
//   每 25 秒 + 切回分頁時更新（一個請求拿清單和未讀數）；手機上打開是整個畫面高的面板
// 只有登入的人有（分享連結的訪客沒有）。文字、連結的規則在 lib/notifications.ts。
// 製作用「其他身分看」（預覽模式）時：鈴鐺照樣在原位，但不讀、不打開 —— 裡面是製作自己的通知，不是導演 / 動畫師的，
// 混在預覽畫面裡會看錯；點了說一聲。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign, Bell, BellOff, CheckCheck, CircleCheck, CornerDownRight, Film, Link2, MessageSquareText, RotateCcw, SlidersHorizontal, UserPlus, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Icon from './Icon';
import EmptyState from './EmptyState';
import { useAuth } from '../lib/auth';
import { useViewAs } from '../lib/viewAsContext';
import { useLiveRefresh } from '../lib/liveRefresh';
import { listNotifications, markNotificationsRead, type AppNotification, type NotificationKind } from '../lib/reviewApi';
import {
  badgeText, groupNotifications, notificationDetail, notificationHref, notificationTitle, sameNotifications,
} from '../lib/notifications';
import { formatRelativeTime } from '../lib/serverTime';
import { friendlyError } from '../lib/songReview';
import { toast } from '../lib/toast';
import './NotificationBell.css';

const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  mention: AtSign,
  reply: CornerDownRight,
  needs_changes: RotateCcw,
  approved: CircleCheck,
  new_version: Film,
  assigned: UserPlus,
  guest_comment: MessageSquareText,
  director_video: Link2,
  director_stage: SlidersHorizontal,
};

interface Props {
  /** 面板往哪邊開：上方列 = 往下、靠右；管理頁側欄（在左下角）= 往上、靠左 */
  placement?: 'down-right' | 'up-left';
  className?: string;
}

const PREVIEW_BELL_TIP = '預覽時不顯示通知（小鈴鐺裡是你自己的通知，回到編輯再看）';

export default function NotificationBell(props: Props) {
  const va = useViewAs();
  if (va.active) {
    return (
      <div className={`notif${props.className ? ` ${props.className}` : ''}`}>
        <button
          type="button"
          className="notif__bell notif__bell--preview"
          onClick={() => toast.info(PREVIEW_BELL_TIP)}
          title={PREVIEW_BELL_TIP}
          aria-label={PREVIEW_BELL_TIP}
          aria-disabled
          data-viewas-ro=""
        >
          <Icon icon={BellOff} size="md" />
        </button>
      </div>
    );
  }
  return <NotificationBellInner {...props} />;
}

function NotificationBellInner({ placement = 'down-right', className }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<AppNotification[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await listNotifications(30);
      if (!sameNotifications(itemsRef.current, r.items)) {
        itemsRef.current = r.items;
        setItems(r.items);
      }
      setUnread(r.unreadCount);
      setStatus('ready');
    } catch {
      setStatus(s => (s === 'ready' ? 'ready' : 'error'));  // 讀過一次就留著舊的，等下一輪
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    setStatus('loading');
    void load();
  }, [user, load]);
  // 每 25 秒 + 切回分頁（跟頁面其他自動更新同一個節奏）
  useLiveRefresh(load, { enabled: !!user });

  // 打開時馬上更新一次；點外面 / Esc 關掉
  useEffect(() => {
    if (!open) return;
    void load();
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, load]);

  if (!user) return null;

  const markLocal = (pred: (n: AppNotification) => boolean) => {
    const next = itemsRef.current.map(n => (pred(n) ? { ...n, read: true } : n));
    itemsRef.current = next;
    setItems(next);
  };

  async function openItem(n: AppNotification) {
    setOpen(false);
    if (!n.read) {
      markLocal(x => x.id === n.id);
      setUnread(u => Math.max(0, u - 1));
      markNotificationsRead({ ids: [n.id] }).then(setUnread).catch(() => { /* 下一輪再對 */ });
    }
    navigate(notificationHref(n));
  }

  async function markAll() {
    const before = itemsRef.current;
    markLocal(() => true);
    setUnread(0);
    try {
      setUnread(await markNotificationsRead({ all: true }));
    } catch (e) {
      itemsRef.current = before;
      setItems(before);
      void load();
      toast.error('沒有標成已讀：' + friendlyError(e));
    }
  }

  const badge = badgeText(unread);
  const groups = groupNotifications(items);
  const label = unread > 0 ? `通知（${unread} 則未讀）` : '通知';

  return (
    <div className={`notif${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className={'notif__bell' + (open ? ' is-open' : '')}
        onClick={() => setOpen(o => !o)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon icon={Bell} size="md" />
        {badge && <span className="notif__badge" aria-hidden="true">{badge}</span>}
      </button>

      {open && (
        <div className={`notif__panel notif__panel--${placement}`} role="dialog" aria-label="通知">
          <div className="notif__head">
            <span className="notif__title">通知</span>
            <button type="button" className="notif__mark-all" onClick={markAll} disabled={unread === 0}>
              <Icon icon={CheckCheck} size="sm" /> 全部標為已讀
            </button>
            <button type="button" className="notif__close" onClick={() => setOpen(false)} title="關閉" aria-label="關閉">
              <Icon icon={X} size="md" />
            </button>
          </div>
          <div className="notif__body">
            {status === 'error' && items.length === 0 ? (
              <div className="notif__empty">
                通知讀不到（可能是網路不穩）
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setStatus('loading'); void load(); }}>重試</button>
              </div>
            ) : status !== 'ready' && items.length === 0 ? (
              <div className="notif__empty">讀取中…</div>
            ) : items.length === 0 ? (
              <EmptyState icon={BellOff} title="還沒有通知" size="compact">
                有人 @ 你、你的歌被退或通過、有新版等你審、歌指派給你、分享連結的訪客留言時，會出現在這裡。
              </EmptyState>
            ) : (
              groups.map(g => (
                <section key={g.label} className="notif__group">
                  <div className="notif__group-label">{g.label}</div>
                  <ul className="notif__list">
                    {g.items.map(n => {
                      const detail = notificationDetail(n);
                      return (
                        <li key={n.id}>
                          <button
                            type="button"
                            className={`notif__item notif__item--${n.kind}` + (n.read ? '' : ' is-unread')}
                            onClick={() => openItem(n)}
                          >
                            <span className="notif__icon"><Icon icon={KIND_ICON[n.kind] || Bell} size="sm" /></span>
                            <span className="notif__text">
                              <span className="notif__line">{notificationTitle(n)}</span>
                              {detail && <span className="notif__detail">{detail}</span>}
                              <span className="notif__meta">{n.projectName} · {formatRelativeTime(n.createdAt)}</span>
                            </span>
                            {!n.read && <><span className="notif__dot" aria-hidden="true" /><span className="notif__sr">（未讀）</span></>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
