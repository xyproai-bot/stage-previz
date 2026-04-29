import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { ActivityEntry, ActivityAction, ActivityTargetType } from '../lib/api';
import './ActivityDrawer.css';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
}

const SONG_STATUS_LABEL: Record<string, string> = {
  todo: '未開始', in_review: '審查中', approved: '已通過', needs_changes: '需修改',
};

const TARGET_LABEL: Record<ActivityTargetType, string> = {
  project: '專案', song: '歌曲', cue: 'cue', cue_state: '物件位置', stage_object: '物件', model: '模型',
};

const ACTION_VERB: Record<ActivityAction, string> = {
  create: '新增', update: '更新', delete: '刪除', reorder: '重新排序',
  reset: '重置', activate: '切換', archive: '封存', upload: '上傳', bulk_create: '批次建立', seed: '塞入範例',
};

const ACTION_ICON: Record<ActivityAction, string> = {
  create: '➕', update: '✎', delete: '🗑', reorder: '↕',
  reset: '↺', activate: '🎯', archive: '📦', upload: '⬆', bulk_create: '📋', seed: '🌱',
};

function formatTime(iso: string) {
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
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

/** 把 entry 轉成自然語句 */
function describe(e: ActivityEntry): string {
  const target = TARGET_LABEL[e.targetType] || e.targetType;
  const verb = ACTION_VERB[e.action] || e.action;
  const p = e.payload || {} as Record<string, unknown>;
  const name = (p as { name?: string }).name;

  // 特殊：song status 變化
  if (e.targetType === 'song' && e.action === 'update') {
    const sFrom = (p as { statusFrom?: string }).statusFrom;
    const sTo = (p as { statusTo?: string }).statusTo;
    if (sTo && sFrom && sTo !== sFrom) {
      return `把歌曲「${name}」從「${SONG_STATUS_LABEL[sFrom] || sFrom}」改成「${SONG_STATUS_LABEL[sTo] || sTo}」`;
    }
  }
  // 特殊：model activate
  if (e.targetType === 'model' && e.action === 'activate') {
    const toKey = (p as { toKey?: string }).toKey;
    return `切換到模型版本 ${toKey?.split('/').pop() || ''}`;
  }
  // 特殊：reorder
  if (e.action === 'reorder') {
    const count = (p as { count?: number }).count;
    return `重新排序 ${count ?? ''} 個${target}`;
  }
  // 特殊：bulk_create / seed
  if (e.action === 'bulk_create') {
    const inserted = (p as { inserted?: number }).inserted;
    return `從模型批次建立 ${inserted ?? ''} 個物件`;
  }
  if (e.action === 'seed') {
    const inserted = (p as { inserted?: number }).inserted;
    return `塞入 ${inserted ?? ''} 個範例物件`;
  }
  // 特殊：cue_state reset
  if (e.targetType === 'cue_state' && e.action === 'reset') {
    const cueName = (p as { cueName?: string }).cueName;
    const objectName = (p as { objectName?: string }).objectName;
    return `把「${cueName}」cue 中的「${objectName}」重置回 default 位置`;
  }

  // 一般：「新增 / 更新 / 刪除 歌曲「XXX」」
  if (name) return `${verb}${target}「${name}」`;
  return `${verb}${target}`;
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
            <p className="muted small">audit log — 不可改、不可刪。重要操作都會記錄。</p>
          </div>
          <button className="activity-drawer__refresh" onClick={refresh} disabled={loading} title="重新整理">⟳</button>
          <button className="activity-drawer__close" onClick={onClose} aria-label="關閉">×</button>
        </header>

        <div className="activity-drawer__body">
          {loading && entries.length === 0 ? (
            <div className="activity-empty muted">載入中…</div>
          ) : error ? (
            <div className="activity-empty">
              <div style={{ fontSize: 32 }}>⚠️</div>
              <div>載入失敗</div>
              <small style={{ color: 'var(--warn)' }}>{error}</small>
              <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 8 }}>重試</button>
            </div>
          ) : entries.length === 0 ? (
            <div className="activity-empty muted">
              <div style={{ fontSize: 32 }}>🕒</div>
              <div>還沒有活動紀錄</div>
              <small>動點什麼吧 — 改個 status、新增 cue 都會出現在這</small>
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
                      <span className="activity-item__icon" aria-hidden="true">{ACTION_ICON[e.action] || '·'}</span>
                      <strong>{e.userName}</strong>
                      <span className="activity-item__verb">{describe(e)}</span>
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
