import { useEffect, useState, useCallback, useRef } from 'react';
import AdminLayout from '../components/AdminLayout';
import * as api from '../lib/api';
import type { UserAdmin, UserRole } from '../lib/api';
import { parseServerTime } from '../lib/serverTime';
import type { Project } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/roleLabels';
import { formatLoginCodeForDisplay, loginCodeDisplay, LOGIN_CODE_HIDDEN_TEXT } from '../lib/inviteMessage';
import { copyToClipboard } from '../lib/clipboard';
import { toast } from '../lib/toast';
import { confirmDialog } from '../components/dialogs';
import Icon from '../components/Icon';
import InviteDialog from '../components/InviteDialog';
import OpenInvitesList from '../components/OpenInvitesList';
import LoginCodeDialog from '../components/LoginCodeDialog';
import { Check, Copy, FolderPlus, KeyRound, Link, LoaderCircle, RefreshCw, Trash2, TriangleAlert, UserCheck, UserPlus, UserX, X } from 'lucide-react';
import './Users.css';
import { useEscapeClose } from '../lib/useEscapeClose';

const PALETTE = ['#10c78a', '#ffaa44', '#5294ff', '#c264ff', '#ff5470', '#ffd84a'];

function formatTime(iso: string | null) {
  if (!iso) return '從未登入';
  const d = new Date(parseServerTime(iso));  // 手動加 Z 的寫法 Safari 讀不懂（中間是空白不是 T）
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

/** 剛建立 / 重設的登入碼（只顯示這一次） */
interface ShownCode { name: string; code: string; shownOnce: boolean; isReset: boolean }

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserAdmin[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // 「指派專案」對話框只記是誰（id），人的資料每次都從最新的清單拿：
  // 以前記的是打開當下的那一份，存好後清單更新了、對話框還是舊的，勾選框和角色會跳回去
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const editingUser = editingUserId ? users.find(u => u.id === editingUserId) ?? null : null;
  const [shownCode, setShownCode] = useState<ShownCode | null>(null);
  // 邀請連結對話框：null = 關著；userId = 先選好的人（某個人旁邊的「邀請連結」）
  const [invite, setInvite] = useState<{ userId?: string } | null>(null);
  const [invitesReload, setInvitesReload] = useState(0);

  // 重新抓清單。quiet = 背景更新（清單不換成「載入中…」，失敗跳通知、清單留著）。
  // 同時有好幾次在抓時只用最後一次的結果；回傳的 Promise 等到最新的那次放上畫面才結束
  const loadSeq = useRef(0);
  const loadRun = useRef<Promise<void>>(Promise.resolve());
  const refresh = useCallback((opts?: { quiet?: boolean }): Promise<void> => {
    const seq = ++loadSeq.current;
    const run = (async () => {
      if (!opts?.quiet) { setLoading(true); setError(null); }
      try {
        const [u, p] = await Promise.all([api.listUsers(), api.listProjects()]);
        if (seq !== loadSeq.current) return;
        setUsers(u);
        setAllProjects(p);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (opts?.quiet) toast.error('沒有拿到最新的用戶清單：' + msg);
        else setError(msg);
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    })();
    loadRun.current = run;
    return run.then(async () => {
      let latest: Promise<void>;
      do { latest = loadRun.current; await latest; } while (latest !== loadRun.current);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // 重設登入碼（還沒有的人 = 產生一組）：新的只顯示這一次，舊的馬上不能用
  async function handleResetCode(u: UserAdmin) {
    const hasCode = loginCodeDisplay(u).kind !== 'none';
    const ok = await confirmDialog(hasCode
      ? {
        title: `重設「${u.name}」的登入碼？`,
        message: '舊的登入碼會馬上不能用，對方下次要用新的。',
        confirmLabel: '重設登入碼',
        destructive: true,
      }
      : { title: `幫「${u.name}」產生一組登入碼？`, confirmLabel: '產生登入碼' });
    if (!ok) return;
    try {
      const { accessCode, shownOnce } = await api.setAccessCode(u.id);
      setShownCode({ name: u.name, code: accessCode, shownOnce: !!shownOnce, isReset: hasCode });
      await refresh();
    } catch (e) {
      toast.error('重設失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleCopyCode(code: string) {
    const ok = await copyToClipboard(code);
    if (ok) toast.success('已複製登入碼');
    else toast.error('瀏覽器不讓我們複製，請自己選起來複製');
  }

  async function handleToggleActive(u: UserAdmin) {
    const verb = u.deactivated ? '重新啟用' : '停用';
    if (!(await confirmDialog({
      title: `${verb}「${u.name}」？`,
      message: u.deactivated ? '重新啟用後，對方就能再登入。' : '停用後對方就不能登入，資料都會留著；之後可以再重新啟用。',
      confirmLabel: verb,
      destructive: !u.deactivated,
    }))) return;
    try {
      await api.updateUserAdmin(u.id, { deactivated: !u.deactivated });
      await refresh();
    } catch (e) {
      toast.error(`沒有${verb}成功：` + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleChangeRole(u: UserAdmin, role: UserRole) {
    if (u.id === me?.id && role !== 'admin') {
      toast.warn('不能把自己改成別的角色：至少要留一個製作。');
      return;
    }
    try {
      await api.updateUserAdmin(u.id, { role });
      await refresh();
    } catch (e) {
      toast.error('角色沒有改成：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleDelete(u: UserAdmin) {
    if (u.id === me?.id) { toast.warn('不能刪除自己的帳號'); return; }
    if (!(await confirmDialog({
      title: `永久刪除「${u.name}」？`,
      message: '對方馬上就不能登入。他建立的專案會留著，加進專案的權限會清掉。刪了就救不回來。',
      confirmLabel: '永久刪除',
      destructive: true,
    }))) return;
    try {
      await api.deleteUserAdmin(u.id);
      await refresh();
    } catch (e) {
      toast.error('刪除失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <AdminLayout>
      <header className="admin-topbar">
        <h1>用戶</h1>
        <div className="admin-topbar__actions">
          <button className="btn btn--ghost acct-btn" onClick={() => setInvite({})}><Icon icon={Link} /> 邀請連結</button>
          <button className="btn btn--primary acct-btn" onClick={() => setDialogOpen(true)}><Icon icon={UserPlus} /> 新增用戶</button>
        </div>
      </header>

      <div className="admin-content">
        <p className="muted small" style={{ marginTop: 0 }}>
          最簡單的方式是傳「邀請連結」：選專案和角色，把訊息貼到 LINE / 微信，對方點開就直接進專案（不用記登入碼，新的人也會自動建帳號）。
          也可以用「登入碼」：新增用戶時系統會產生一組，對方到 <code>/login</code> 輸入就能登入。每個人只看得到被加入的專案。
        </p>

        {loading ? (
          <div className="empty-card"><div className="empty-card__icon"><Icon icon={LoaderCircle} size="xl" spin /></div><p>載入中…</p></div>
        ) : error ? (
          <div className="empty-card">
            <div className="empty-card__icon"><Icon icon={TriangleAlert} size="xl" /></div>
            <p>{error}</p>
            <button className="btn btn--ghost" onClick={() => refresh()} style={{ marginTop: 12 }}>重試</button>
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

                  <LoginCodeRow user={u} onCopy={handleCopyCode} onReset={() => handleResetCode(u)} />

                  <div className="user-row__projects">
                    <span className="muted small">可看的專案：</span>
                    {u.projects.length === 0 ? (
                      <span className="muted small">{u.role === 'admin' ? '（製作看得到全部，不用指派）' : '無 — 點右側「指派」加上'}</span>
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
                  <button onClick={() => setEditingUserId(u.id)} title="指派專案"><Icon icon={FolderPlus} /> 指派</button>
                  {u.role !== 'admin' && !u.deactivated && (
                    <button onClick={() => setInvite({ userId: u.id })} title="傳一個邀請連結給他（例如換了手機、忘記登入碼）">
                      <Icon icon={Link} /> 邀請連結
                    </button>
                  )}
                  <button onClick={() => handleToggleActive(u)} title={u.deactivated ? '重新啟用' : '停用'}>
                    {u.deactivated ? <><Icon icon={UserCheck} /> 啟用</> : <><Icon icon={UserX} /> 停用</>}
                  </button>
                  <button onClick={() => handleDelete(u)} disabled={u.id === me?.id} title="刪除" aria-label="刪除"><Icon icon={Trash2} /></button>
                </div>
              </article>
            ))}
          </div>
        )}

        {!loading && !error && (
          <div className="users-invites">
            <OpenInvitesList reloadKey={invitesReload} showProject onChanged={refresh} />
          </div>
        )}
      </div>

      <NewUserDialog
        open={dialogOpen}
        allProjects={allProjects}
        onClose={() => setDialogOpen(false)}
        onCreated={async (shown) => { setDialogOpen(false); setShownCode(shown); await refresh(); }}
      />

      {shownCode && (
        <LoginCodeDialog
          open
          name={shownCode.name}
          code={shownCode.code}
          shownOnce={shownCode.shownOnce}
          isReset={shownCode.isReset}
          onClose={() => setShownCode(null)}
        />
      )}

      <InviteDialog
        open={!!invite}
        presetUserId={invite?.userId}
        onClose={() => setInvite(null)}
        onChanged={() => { setInvitesReload(k => k + 1); void refresh(); }}
      />

      {editingUser && (
        <ProjectAssignDialog
          key={editingUser.id}
          user={editingUser}
          allProjects={allProjects}
          onClose={() => setEditingUserId(null)}
          onChanged={() => refresh({ quiet: true })}
        />
      )}
    </AdminLayout>
  );
}

function NewUserDialog({ open, allProjects, onClose, onCreated }: {
  open: boolean;
  allProjects: Project[];
  onClose: () => void;
  onCreated: (shown: ShownCode) => void;
}) {
  useEscapeClose(open, onClose);
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('animator');
  const [color, setColor] = useState(PALETTE[0]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(''); setRole('animator'); setColor(PALETTE[0]);
      setProjectIds([]); setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // 登入碼一律系統產生（10 個字，沒有 0 / O / 1 / I 這種容易看錯的字）
      const { accessCode, shownOnce } = await api.createUserAdmin({
        name: name.trim(), role,
        avatarColor: color,
        projectIds,
      });
      onCreated({ name: name.trim(), code: accessCode, shownOnce: !!shownOnce, isReset: false });
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
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <form className="dialog__body" onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="u-name">名稱 *</label>
            <input id="u-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：陳大明" />
          </div>
          <div className="form-row">
            <label htmlFor="u-role">預設角色</label>
            <select id="u-role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
              <option value="animator">{ROLE_LABEL.animator}</option>
              <option value="director">{ROLE_LABEL.director}</option>
              <option value="admin">{ROLE_LABEL.admin}（看得到全部專案、可以管用戶）</option>
            </select>
            <small className="form-hint">這是預設角色。指派到某個專案時，可以在那個專案改成別的角色。</small>
          </div>
          {role !== 'admin' && (
            <div className="form-row">
              <label>指派到哪些專案（這個人只看得到勾選的專案）</label>
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
              <small className="form-hint">建好後也可以從用戶旁邊的「指派」隨時改。</small>
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
              {submitting ? '建立中…' : '建立並產生登入碼'}
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
  /** 存好後重新抓清單；等到最新的清單放上畫面才結束 */
  onChanged: () => Promise<void>;
}) {
  useEscapeClose(true, onClose);
  // 按下去馬上照新的樣子顯示（還在存、或存好了還沒拿到新清單）：專案 id → 角色，null = 移出
  const [pending, setPending] = useState<Record<string, UserRole | null>>({});
  // 正在存的專案（那一列先不能再按，免得連按兩下打架）
  const [saving, setSaving] = useState<string[]>([]);
  const [savedOnce, setSavedOnce] = useState(false);

  // 後台的狀態（user 每次都是最新清單裡的那一份）
  const serverRole: Record<string, UserRole> = {};
  for (const m of user.projects) serverRole[m.projectId] = m.role;
  const roleOf = (pid: string): UserRole | null => (pid in pending ? pending[pid] : serverRole[pid] ?? null);

  async function save(pid: string, next: UserRole | null) {
    const before = roleOf(pid);
    if (before === next) return;
    setPending(p => ({ ...p, [pid]: next }));
    setSaving(s => [...s, pid]);
    try {
      if (next === null) await api.removeUserFromProject(user.id, pid);
      else await api.addUserToProject(user.id, pid, next);
      await onChanged();
      setSavedOnce(true);
    } catch (e) {
      // 沒存成：拿掉剛剛的改動 = 回到後台的樣子
      setSavedOnce(false);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error((next === null ? '沒有移出專案：' : before === null ? '沒有加進專案：' : '專案角色沒有改成：') + msg);
    } finally {
      setPending(p => { const n = { ...p }; delete n[pid]; return n; });
      setSaving(s => s.filter(x => x !== pid));
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>指派專案 — {user.name}</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          {allProjects.length === 0 ? (
            <p className="muted">還沒有專案。</p>
          ) : (
            <ul className="user-project-picker">
              {allProjects.map(p => {
                const role = roleOf(p.id);
                const busy = saving.includes(p.id);
                return (
                  <li key={p.id} className="user-project-picker__item user-project-picker__row" data-project-id={p.id}>
                    <input
                      type="checkbox"
                      checked={!!role}
                      disabled={busy}
                      aria-label={p.name}
                      onChange={() => save(p.id, role ? null : user.role)}
                    />
                    <span style={{ flex: 1 }}>{p.name}</span>
                    {role && (
                      <select
                        value={role}
                        onChange={(e) => save(p.id, e.target.value as UserRole)}
                        disabled={busy}
                        aria-label={`在「${p.name}」的角色`}
                      >
                        <option value="animator">{ROLE_LABEL.animator}</option>
                        <option value="director">{ROLE_LABEL.director}</option>
                        <option value="admin">{ROLE_LABEL.admin}</option>
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="dialog__footer">
            <span className="muted small user-assign__status" role="status" aria-live="polite">
              {saving.length > 0
                ? <><Icon icon={LoaderCircle} spin /> 儲存中…</>
                : savedOnce ? <><Icon icon={Check} /> 已儲存</> : null}
            </span>
            <button className="btn btn--primary" onClick={onClose}>完成</button>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** 用戶清單上的登入碼：後台還是明文 → 照以前顯示；改成只顯示一次之後 → 只說「忘記了請按重設」 */
function LoginCodeRow({ user, onCopy, onReset }: { user: UserAdmin; onCopy: (code: string) => void; onReset: () => void }) {
  const d = loginCodeDisplay(user);
  return (
    <div className="user-row__code-row" data-testid="login-code-row">
      {d.kind === 'plain' && (
        <>
          <code className="user-row__code">{formatLoginCodeForDisplay(d.code)}</code>
          <button className="user-row__btn" onClick={() => onCopy(d.code)} title="複製登入碼"><Icon icon={Copy} /> 複製</button>
          <button className="user-row__btn" onClick={onReset} title="重設：產生新的登入碼，舊的馬上不能用"><Icon icon={RefreshCw} /> 重設</button>
        </>
      )}
      {d.kind === 'hidden' && (
        <>
          <span className="muted small user-row__code-hidden"><Icon icon={KeyRound} /> {LOGIN_CODE_HIDDEN_TEXT}</span>
          <button className="user-row__btn" onClick={onReset} title="重設：產生新的登入碼，舊的馬上不能用"><Icon icon={RefreshCw} /> 重設</button>
        </>
      )}
      {d.kind === 'none' && (
        <>
          <span className="muted small user-row__code-hidden"><Icon icon={KeyRound} /> 還沒有登入碼（用邀請連結進來的）</span>
          <button className="user-row__btn" onClick={onReset} title="產生一組登入碼"><Icon icon={KeyRound} /> 產生登入碼</button>
        </>
      )}
    </div>
  );
}
