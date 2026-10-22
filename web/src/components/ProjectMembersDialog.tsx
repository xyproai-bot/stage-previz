// 專案的「成員」面板：這個專案有誰、什麼角色（製作 / 導演 / 動畫師）、加人、改角色、移出專案、邀請連結。
// 全站製作和「這個專案的製作」都能用；專案的製作只管得到這個專案（後台 members.mjs 擋）。
// 規則和說明文字在 lib/projectMembers.ts（說明每一項都有測試去對後台的權限）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, LoaderCircle, RefreshCw, UserMinus, Users, X } from 'lucide-react';
import * as api from '../lib/api';
import type { MemberCandidate, ProjectMemberRow, UserRole } from '../lib/api';
import {
  MEMBER_LOCK_TEXT, MEMBER_ROLE_HINT, MEMBER_ROLE_NAME, MEMBER_ROLE_ORDER, PROJECT_ADMIN_SCOPE_TEXT,
  groupMembersByRole, groupTitle, memberRowLock,
} from '../lib/projectMembers';
import { formatLastLogin } from '../lib/lastSeen';
import { useEscapeClose } from '../lib/useEscapeClose';
import { toast } from '../lib/toast';
import { confirmDialog } from './dialogs';
import Icon from './Icon';
import UserSearchPicker from './UserSearchPicker';
import { InvitePanel } from './InviteDialog';
import './NewProjectDialog.css';
import './InviteDialog.css';
import './MembersPanel.css';

interface Props {
  open: boolean;
  projectId: string;
  projectName?: string;
  onClose: () => void;
  /** 成員有變（加人、改角色、移出、邀請）之後通知外面重新讀 */
  onChanged?: () => void;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ProjectMembersDialog({ open, projectId, projectName, onClose, onChanged }: Props) {
  if (!open) return null;
  return <MembersDialogBody projectId={projectId} projectName={projectName} onClose={onClose} onChanged={onChanged} />;
}

function MembersDialogBody({ projectId, projectName, onClose, onChanged }: Omit<Props, 'open'>) {
  useEscapeClose(true, onClose);
  const [members, setMembers] = useState<ProjectMemberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 找人的結果要重新標「已在專案」
  const [searchKey, setSearchKey] = useState(0);
  // 找到的人要用什麼角色加進來（沒選過 = 他帳號的角色，製作帳號以外只有導演 / 動畫師）
  const [addRole, setAddRole] = useState<Record<string, UserRole>>({});

  const refresh = useCallback(async () => {
    try {
      setMembers(await api.listProjectMembers(projectId));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const groups = useMemo(() => groupMembersByRole(members ?? []), [members]);

  async function afterChange() {
    await refresh();
    setSearchKey(k => k + 1);
    onChanged?.();
  }

  async function changeRole(m: ProjectMemberRow, role: UserRole) {
    if (role === m.role) return;
    if (role === 'admin' && !(await confirmDialog({
      title: `讓「${m.name}」成為這個專案的製作？`,
      message: '他可以編輯這個專案的內容和管理成員（只限這個專案，看不到別的專案）。',
      confirmLabel: '設成製作',
    }))) return;
    setBusyId(m.id);
    try {
      await api.setProjectMember(projectId, m.id, role);
      toast.success(`「${m.name}」現在是${MEMBER_ROLE_NAME[role]}`);
      await afterChange();
    } catch (e) {
      toast.error('角色沒有改成：' + errMsg(e));
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(m: ProjectMemberRow) {
    if (!(await confirmDialog({
      title: `把「${m.name}」移出這個專案？`,
      message: '他之後就看不到這個專案了；他的帳號和別的專案不受影響，之後可以再加回來。',
      confirmLabel: '移出專案',
      destructive: true,
    }))) return;
    setBusyId(m.id);
    try {
      await api.removeProjectMember(projectId, m.id);
      toast.success(`已把「${m.name}」移出專案`);
      await afterChange();
    } catch (e) {
      toast.error('沒有移出成功：' + errMsg(e));
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function addMember(u: MemberCandidate) {
    const role = addRole[u.id] ?? (u.role === 'director' ? 'director' : 'animator');
    setBusyId(u.id);
    try {
      await api.setProjectMember(projectId, u.id, role);
      toast.success(`已把「${u.name}」加進專案（${MEMBER_ROLE_NAME[role]}）`);
      await afterChange();
    } catch (e) {
      toast.error('沒有加進專案：' + errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog acct-dialog members-dialog" role="dialog" aria-modal="true" aria-label="成員" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2><Icon icon={Users} size="md" /> 成員{projectName ? ` — ${projectName}` : ''}</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <p className="members-scope" data-testid="members-scope"><Icon icon={Info} /> {PROJECT_ADMIN_SCOPE_TEXT}</p>

          <section className="members-section" aria-label="這個專案的成員">
            <h3 className="members-section__title">
              <span>這個專案的成員{members ? `（${members.length}）` : ''}</span>
              <button type="button" className="acct-invites__revoke" onClick={() => void refresh()} title="重新整理" aria-label="重新整理">
                <Icon icon={RefreshCw} />
              </button>
            </h3>
            {error ? (
              <div className="acct-error">讀不到成員：{error}</div>
            ) : members === null ? (
              <p className="user-search__empty"><Icon icon={LoaderCircle} spin /> 載入中…</p>
            ) : members.length === 0 ? (
              <p className="user-search__empty">這個專案還沒有成員。從下面加入現有用戶，或建立邀請連結。</p>
            ) : (
              groups.map(g => (
                <div key={g.role} className="members-group" data-role={g.role}>
                  <h4 className="members-group__title">{groupTitle(g.label, g.members.length)}</h4>
                  <ul className="members-list">
                    {g.members.map(m => {
                      const lock = memberRowLock(m);
                      const busy = busyId === m.id;
                      return (
                        <li key={m.id} className="members-row" data-user-id={m.id}>
                          <span className="avatar avatar--sm" style={{ background: m.avatarColor }}>{m.name[0]}</span>
                          <span className="members-row__who">
                            <span className="members-row__name">
                              {m.name}
                              {m.isMe && <span className="members-row__tag">你</span>}
                              {m.globalAdmin && <span className="members-row__tag">全站製作</span>}
                              {m.deactivated && <span className="members-row__tag">已停用</span>}
                            </span>
                            <span className="members-row__meta">上次登入：{formatLastLogin(m.lastSeenAt)}</span>
                          </span>
                          {lock ? (
                            <span className="members-row__locked" title={MEMBER_LOCK_TEXT[lock]}>{MEMBER_ROLE_NAME[m.role]}</span>
                          ) : (
                            <select
                              value={m.role}
                              disabled={busy}
                              aria-label={`${m.name} 在這個專案的角色`}
                              onChange={(e) => void changeRole(m, e.target.value as UserRole)}
                            >
                              {MEMBER_ROLE_ORDER.map(r => <option key={r} value={r}>{MEMBER_ROLE_NAME[r]}</option>)}
                            </select>
                          )}
                          <button
                            type="button"
                            className="members-row__remove"
                            disabled={!!lock || busy}
                            onClick={() => void removeMember(m)}
                            title={lock ? MEMBER_LOCK_TEXT[lock] : '移出這個專案'}
                            aria-label={`把 ${m.name} 移出這個專案`}
                          >
                            <Icon icon={UserMinus} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </section>

          <section className="members-section" aria-label="加入現有用戶">
            <h3 className="members-section__title"><span>加入現有用戶</span></h3>
            <UserSearchPicker
              projectId={projectId}
              refreshKey={searchKey}
              placeholder="輸入名字找人，例：王小明"
              renderAction={(u) => {
                const already = !!u.projectRole;
                const role = addRole[u.id] ?? (u.role === 'director' ? 'director' : 'animator');
                return (
                  <>
                    {!already && (
                      <select
                        value={role}
                        aria-label={`${u.name} 加進來的角色`}
                        title={MEMBER_ROLE_HINT[role]}
                        onChange={(e) => setAddRole(prev => ({ ...prev, [u.id]: e.target.value as UserRole }))}
                      >
                        {MEMBER_ROLE_ORDER.map(r => <option key={r} value={r}>{MEMBER_ROLE_NAME[r]}</option>)}
                      </select>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost acct-btn"
                      disabled={already || busyId === u.id}
                      onClick={() => void addMember(u)}
                    >
                      {already ? '已在專案' : busyId === u.id ? '加入中…' : '加入'}
                    </button>
                  </>
                );
              }}
            />
            <span className="acct-field__hint">沒有帳號的人，用下面的邀請連結（對方打開就會自己建好帳號）。</span>
          </section>

          <section className="members-section" aria-label="邀請連結">
            <h3 className="members-section__title"><span>邀請連結</span></h3>
            <InvitePanel
              projectId={projectId}
              projectName={projectName}
              defaultRole="animator"
              onChanged={() => { void refresh(); onChanged?.(); }}
            />
          </section>

          <footer className="dialog__footer">
            <button type="button" className="btn btn--primary" onClick={onClose}>完成</button>
          </footer>
        </div>
      </div>
    </div>
  );
}
