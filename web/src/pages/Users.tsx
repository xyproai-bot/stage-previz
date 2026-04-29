import { useEffect, useState, useCallback } from 'react';
import AdminLayout from '../components/AdminLayout';
import * as api from '../lib/api';
import type { UserAdmin, UserRole } from '../lib/api';
import type { Project } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import './Users.css';

const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  animator: 'Animator',
  director: 'Director',
};

const PALETTE = ['#10c78a', '#ffaa44', '#5294ff', '#c264ff', '#ff5470', '#ffd84a'];

function formatTime(iso: string | null) {
  if (!iso) return '從未登入';
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return '剛才';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return d.toLocaleDateString('zh-TW');
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserAdmin[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAdmin | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, p] = await Promise.all([api.listUsers(), api.listProjects()]);
      setUsers(u);
      setAllProjects(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleRegenCode(u: UserAdmin) {
    if (!confirm(`重新產生「${u.name}」的號碼？\n\n舊號碼會失效，對方下次要用新的號碼。`)) return;
    try {
      const { accessCode } = await api.setAccessCode(u.id);
      const ok = await copyText(accessCode);
      alert(`✅ 新號碼：${accessCode}\n\n${ok ? '已複製到剪貼簿，' : ''}請傳給對方。`);
      await refresh();
    } catch (e) {
      alert('失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleSetCustomCode(u: UserAdmin) {
    const code = prompt(`為「${u.name}」設自訂號碼\n\n（4-32 字，英數字、Dash 都行；舊號碼會失效）`, '');
    if (!code) return;
    try {
      const { accessCode } = await api.setAccessCode(u.id, code);
      await copyText(accessCode);
      alert(`✅ 號碼設定為：${accessCode}\n\n已複製到剪貼簿，請傳給對方。`);
      await refresh();
    } catch (e) {
      alert('失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleCopyCode(u: UserAdmin) {
    if (!u.accessCode) { alert('此用戶還沒有號碼'); return; }
    const ok = await copyText(u.accessCode);
    alert(ok ? `✅ 已複製：${u.accessCode}` : `號碼是：${u.accessCode}（手動複製）`);
  }

  async function handleToggleActive(u: UserAdmin) {
    const verb = u.deactivated ? '重新啟用' : '停用';
    if (!confirm(`${verb}「${u.name}」？停用後對方無法登入，但既有資料保留。`)) return;
    try {
      await api.updateUserAdmin(u.id, { deactivated: !u.deactivated });
      await refresh();
    } catch (e) {
      alert('失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleChangeRole(u: UserAdmin, role: UserRole) {
    if (u.id === me?.id && role !== 'admin') {
      alert('不能把自己的權限降低 — 至少要保留一個 admin。');
      return;
    }
    try {
      await api.updateUserAdmin(u.id, { role });
      await refresh();
    } catch (e) {
      alert('失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleDelete(u: UserAdmin) {
    if (u.id === me?.id) { alert('不能刪除自己的帳號'); return; }
    if (!confirm(`永久刪除「${u.name}」？\n\n對方馬上無法登入。\n他建立的專案會保留，被指派的權限會清除。`)) return;
    try {
      await api.deleteUserAdmin(u.id);
      await refresh();
    } catch (e) {
      alert('刪除失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <AdminLayout>
      <header className="admin-topbar">
        <h1>用戶</h1>
        <div className="admin-topbar__actions">
          <button className="btn btn--primary" onClick={() => setDialogOpen(true)}>＋ 新增用戶</button>
        </div>
      </header>

      <div className="admin-content">
        <p className="muted small" style={{ marginTop: 0 }}>
          每個用戶用一組「號碼」登入。建好用戶後系統會自動產生號碼，你也可以改成自訂的（例：DAMING-2026）。
          號碼私訊給對方，他到 <code>/login</code> 輸入即可。每個用戶可指派多個專案，他登入後只看得到那些專案。
        </p>

        {loading ? (
          <div className="empty-card"><div className="empty-card__icon">⏳</div><p>載入中…</p></div>
        ) : error ? (
          <div className="empty-card">
            <div className="empty-card__icon">⚠️</div>
            <p>{error}</p>
            <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 12 }}>重試</button>
          </div>
        ) : (
          <div className="users-list">
            {users.map(u => (
              <article key={u.id} className={'user-row' + (u.deactivated ? ' is-deactivated' : '')}>
                <div className="avatar avatar--sm" style={{ background: u.avatarColor }}>{u.name[0]}</div>
                <div className="user-row__main">
                  <div className="user-row__head">
                    <strong>{u.name}</strong>
                    {u.id === me?.id && <span className="users-table__me">你</span>}
                    <select
                      value={u.role}
                      onChange={(e) => handleChangeRole(u, e.target.value as UserRole)}
                      disabled={u.deactivated}
                      className="user-row__role"
                    >
                      {(Object.keys(ROLE_LABEL) as UserRole[]).map(r => (
                        <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                      ))}
                    </select>
                    {u.deactivated
                      ? <span className="users-table__inactive">已停用</span>
                      : <span className="users-table__active">啟用中</span>}
                  </div>

                  <div className="user-row__code-row">
                    <code className="user-row__code">{u.accessCode || '— 還沒有號碼 —'}</code>
                    <button className="user-row__btn" onClick={() => handleCopyCode(u)} title="複製號碼">📋 複製</button>
                    <button className="user-row__btn" onClick={() => handleRegenCode(u)} title="重新產生">↻ 重產生</button>
                    <button className="user-row__btn" onClick={() => handleSetCustomCode(u)} title="自訂號碼">✎ 自訂</button>
                  </div>

                  <div className="user-row__projects">
                    <span className="muted small">可看的專案：</span>
                    {u.projects.length === 0 ? (
                      <span className="muted small">{u.role === 'admin' ? '（admin 看全部，不需指派）' : '無 — 點右側「指派專案」加上'}</span>
                    ) : (
                      u.projects.map(p => (
                        <span key={p.projectId} className="user-project-tag" title={ROLE_LABEL[p.role]}>
                          {p.projectName} · {ROLE_LABEL[p.role]}
                        </span>
                      ))
                    )}
                  </div>

                  <div className="user-row__meta">
                    <span className="muted small">上次登入：{formatTime(u.lastSeenAt)}</span>
                  </div>
                </div>

                <div className="user-row__actions">
                  <button onClick={() => setEditingUser(u)} title="指派專案">📁 指派</button>
                  <button onClick={() => handleToggleActive(u)} title={u.deactivated ? '重新啟用' : '停用'}>
                    {u.deactivated ? '✓ 啟用' : '⏸ 停用'}
                  </button>
                  <button onClick={() => handleDelete(u)} disabled={u.id === me?.id} title="刪除">🗑</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <NewUserDialog
        open={dialogOpen}
        allProjects={allProjects}
        onClose={() => setDialogOpen(false)}
        onCreated={async () => { setDialogOpen(false); await refresh(); }}
      />

      {editingUser && (
        <ProjectAssignDialog
          user={editingUser}
          allProjects={allProjects}
          onClose={() => setEditingUser(null)}
          onChanged={async () => { await refresh(); }}
        />
      )}
    </AdminLayout>
  );
}

function NewUserDialog({ open, allProjects, onClose, onCreated }: {
  open: boolean;
  allProjects: Project[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('animator');
  const [color, setColor] = useState(PALETTE[0]);
  const [code, setCode] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(''); setRole('animator'); setColor(PALETTE[0]);
      setCode(''); setProjectIds([]); setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { accessCode } = await api.createUserAdmin({
        name: name.trim(), role,
        accessCode: code.trim() || undefined,
        avatarColor: color,
        projectIds,
      });
      await copyText(accessCode);
      alert(`✅ 用戶「${name.trim()}」已建立。\n\n號碼：${accessCode}\n\n（已複製到剪貼簿，請私訊給對方）`);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleProject(pid: string) {
    setProjectIds(prev => prev.includes(pid) ? prev.filter(x => x !== pid) : [...prev, pid]);
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>新增用戶</h2>
          <button className="dialog__close" onClick={onClose}>×</button>
        </header>
        <form className="dialog__body" onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="u-name">名稱 *</label>
            <input id="u-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：陳大明" />
          </div>
          <div className="form-row">
            <label htmlFor="u-role">預設角色</label>
            <select id="u-role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
              <option value="animator">Animator（動畫師）</option>
              <option value="director">Director（導演）</option>
              <option value="admin">Admin（管理員 — 看全部 + 管用戶）</option>
            </select>
            <small className="form-hint">這是預設角色。指派到特定 project 時可以再 override 成其他角色。</small>
          </div>
          <div className="form-row">
            <label htmlFor="u-code">號碼（留空自動產生）</label>
            <input id="u-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="留空自動產生 8 位英數字" />
            <small className="form-hint">想自訂可填，例：DAMING-2026。建好後也可隨時改 / 重產生。</small>
          </div>
          {role !== 'admin' && (
            <div className="form-row">
              <label>指派到哪些專案（這個 user 只看得到勾選的）</label>
              <div className="user-project-picker">
                {allProjects.length === 0 ? (
                  <small className="muted">還沒有專案。先去「專案」頁建一個再回來指派。</small>
                ) : allProjects.map(p => (
                  <label key={p.id} className="user-project-picker__item">
                    <input
                      type="checkbox"
                      checked={projectIds.includes(p.id)}
                      onChange={() => toggleProject(p.id)}
                    />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
              <small className="form-hint">建好後也可從用戶旁的「📁 指派」隨時改。</small>
            </div>
          )}
          <div className="form-row">
            <label>頭像顏色</label>
            <div className="palette">
              {PALETTE.map(c => (
                <button
                  type="button" key={c}
                  className={'palette__swatch' + (color === c ? ' is-active' : '')}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          {error && <div className="login-error">{error}</div>}
          <footer className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="btn btn--primary" disabled={submitting || !name}>
              {submitting ? '建立中…' : '建立並產生號碼'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function ProjectAssignDialog({ user, allProjects, onClose, onChanged }: {
  user: UserAdmin;
  allProjects: Project[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle(pid: string, currentRole: UserRole | null) {
    setBusy(true);
    try {
      if (currentRole) {
        await api.removeUserFromProject(user.id, pid);
      } else {
        await api.addUserToProject(user.id, pid, user.role);
      }
      await onChanged();
    } catch (e) {
      alert('失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(pid: string, newRole: UserRole) {
    setBusy(true);
    try {
      await api.addUserToProject(user.id, pid, newRole);
      await onChanged();
    } catch (e) {
      alert('失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  // 取最新 user.projects
  const assignedById: Record<string, UserRole> = {};
  for (const m of user.projects) assignedById[m.projectId] = m.role;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>指派專案 — {user.name}</h2>
          <button className="dialog__close" onClick={onClose}>×</button>
        </header>
        <div className="dialog__body">
          {allProjects.length === 0 ? (
            <p className="muted">還沒有專案。</p>
          ) : (
            <ul className="user-project-picker">
              {allProjects.map(p => {
                const role = assignedById[p.id] || null;
                return (
                  <li key={p.id} className="user-project-picker__item user-project-picker__row">
                    <input
                      type="checkbox"
                      checked={!!role}
                      disabled={busy}
                      onChange={() => toggle(p.id, role)}
                    />
                    <span style={{ flex: 1 }}>{p.name}</span>
                    {role && (
                      <select
                        value={role}
                        onChange={(e) => changeRole(p.id, e.target.value as UserRole)}
                        disabled={busy}
                      >
                        <option value="animator">Animator</option>
                        <option value="director">Director</option>
                        <option value="admin">Admin</option>
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="dialog__footer">
            <button className="btn btn--primary" onClick={onClose}>完成</button>
          </footer>
        </div>
      </div>
    </div>
  );
}
