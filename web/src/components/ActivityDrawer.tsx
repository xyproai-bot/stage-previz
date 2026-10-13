import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { ActivityEntry, ActivityAction } from '../lib/api';
import { parseServerTime } from '../lib/serverTime';
import { describeActivity } from '../lib/activityText';
import {
  Archive, ArrowUpDown, Copy, HistoryIcon, Pencil, Plus, RefreshCw, RotateCcw, Sprout, Target, Trash2, TriangleAlert, Upload, X,
  type LucideIcon,
} from 'lucide-react';
import Icon from './Icon';
import './ActivityDrawer.css';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
}

const ACTION_ICON: Record<ActivityAction, LucideIcon> = {
  create: Plus, update: Pencil, delete: Trash2, reorder: ArrowUpDown,
  reset: RotateCcw, activate: Target, archive: Archive, upload: Upload, bulk_create: Copy, seed: Sprout,
};

function formatTime(iso: string) {
  const d = new Date(parseServerTime(iso));  // 手動加 Z 的寫法 Safari 讀不懂（中間是空白不是 T）
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return '剛才';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return d.toLocaleDateString('zh-TW');
}

export default function ActivityDrawer({ open, projectId, onClose }: Props) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listActivity(projectId, 50);
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line */ }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 開啟時自動每 30s 刷一次（避免動到別的東西看不到）
  useEffect(() => {
    if (!open) return;
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [open, projectId]);

  return (
    <>
      {open && <div className="activity-backdrop" onClick={onClose} />}
      <aside className={'activity-drawer' + (open ? ' is-open' : '')} aria-hidden={!open}>
        <header className="activity-drawer__head">
          <div>
            <h3>最近活動</h3>
            <p className="muted small">操作紀錄不能修改或刪除，重要的操作都會記下來。</p>
          </div>
          <button className="activity-drawer__refresh" onClick={refresh} disabled={loading} title="重新整理" aria-label="重新整理"><Icon icon={RefreshCw} size="md" /></button>
          <button className="activity-drawer__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>

        <div className="activity-drawer__body">
          {loading && entries.length === 0 ? (
            <div className="activity-empty muted">載入中…</div>
          ) : error ? (
            <div className="activity-empty">
              <Icon icon={TriangleAlert} size="xl" className="activity-empty__icon" />
              <div>載入失敗</div>
              <small style={{ color: 'var(--warn)' }}>{error}</small>
              <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 8 }}>重試</button>
            </div>
          ) : entries.length === 0 ? (
            <div className="activity-empty muted">
              <Icon icon={HistoryIcon} size="xl" className="activity-empty__icon" />
              <div>還沒有活動紀錄</div>
              <small>改歌曲狀態、新增 cue 這些操作都會出現在這裡</small>
            </div>
          ) : (
            <ul className="activity-list">
              {entries.map((e) => (
                <li key={e.id} className="activity-item">
                  <div
                    className="activity-item__avatar"
                    style={{ background: e.userAvatar }}
                    title={e.userName}
                  >
                    {e.userName[0] || '?'}
                  </div>
                  <div className="activity-item__main">
                    <div className="activity-item__line">
                      <span className="activity-item__icon" aria-hidden="true"><Icon icon={ACTION_ICON[e.action] || Pencil} size="xs" /></span>
                      <strong>{e.userName}</strong>
                      <span className="activity-item__verb">{describeActivity(e)}</span>
                    </div>
                    <div className="activity-item__time">{formatTime(e.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
