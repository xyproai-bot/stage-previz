// 建立邀請連結：選專案（用戶頁）→ 選人（新的人 / 已經有帳號的人）→ 角色（製作 / 導演 / 動畫師）→ 有效期限
// 建好之後顯示可以直接貼到 LINE / 微信的訊息 + 複製；下面是還沒用的邀請連結（可以撤銷）。
//   InviteDialog  對話框（用戶頁）
//   InvitePanel   對話框裡面那一塊（專案的「成員」面板、新專案精靈的「邀請人」直接放在頁面裡）
//
// 專案頁（有 projectId）：「已經有帳號的人」用名字搜尋（專案的製作拿不到全部用戶清單）；
// 用戶頁（沒有 projectId，只有全站製作）：讀整份用戶清單，可以選專案。
// 角色「製作」= 這個專案的製作（只在這個專案有效）：連結一律只能用一次、最長 7 天（後台也這樣擋）。
import { useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import type { InviteRole, MemberCandidate, UserAdmin, UserRole } from '../lib/api';
import type { Project } from '../lib/mockData';
import { ROLE_LABEL } from '../lib/roleLabels';
import {
  buildInviteMessage, clampInviteDays, inviteDayChoices, inviteMustBeSingleUse, INVITE_ROLE_CHOICES,
} from '../lib/inviteMessage';
import { inviteUrl } from '../lib/siteUrl';
import { copyToClipboard } from '../lib/clipboard';
import { toast } from '../lib/toast';
import { Check, Copy, Link, LoaderCircle, UserPlus, X } from 'lucide-react';
import Icon from './Icon';
import OpenInvitesList from './OpenInvitesList';
import UserSearchPicker from './UserSearchPicker';
import HelpLink from './HelpLink';
import { HELP_ANCHORS } from '../lib/helpLinks';
import './NewProjectDialog.css';
import './InviteDialog.css';
import './MembersPanel.css';

interface PanelProps {
  /** 固定在這個專案（專案頁）；不給 = 可以選專案（用戶頁） */
  projectId?: string;
  projectName?: string;
  /** 先選好的人（用戶頁某個人旁邊的「邀請連結」） */
  presetUserId?: string;
  /** 建好 / 撤銷之後通知外面 */
  onChanged?: () => void;
  /** 建好一條（新專案精靈用來記「這一步做好了」） */
  onCreated?: (created: { personName: string; role: InviteRole }) => void;
  /** 一開始選哪個角色（預設導演） */
  defaultRole?: InviteRole;
}

interface Props extends Omit<PanelProps, 'onCreated' | 'defaultRole'> {
  open: boolean;
  onClose: () => void;
}

interface Created {
  url: string;
  message: string;
  personName: string;
  projectName: string;
}

/** 要邀請的「已經有帳號的人」（不管是從搜尋選的，還是從整份清單選的） */
interface Person {
  id: string;
  name: string;
  /** 在這個專案現在的角色（還不是成員 = null） */
  projectRole: UserRole | null;
  /** 帳號的預設角色 */
  accountRole: UserRole;
}

const isInviteRole = (r: string | undefined): r is InviteRole => r === 'admin' || r === 'animator' || r === 'director';

export default function InviteDialog({ open, onClose, projectId, projectName, presetUserId, onChanged }: Props) {
  if (!open) return null;
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog acct-dialog" role="dialog" aria-modal="true" aria-label="邀請連結" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2><Icon icon={UserPlus} size="md" /> 邀請連結{projectName ? ` — ${projectName}` : ''}</h2>
          <HelpLink anchor={HELP_ANCHORS.prodInvite} />
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          {/* 每次打開都是新的一份（重新讀用戶、清掉上次的結果） */}
          <InvitePanel projectId={projectId} projectName={projectName} presetUserId={presetUserId} onChanged={onChanged} />
          <footer className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose}>完成</button>
          </footer>
        </div>
      </div>
    </div>
  );
}

export function InvitePanel({ projectId, projectName, presetUserId, onChanged, onCreated, defaultRole = 'director' }: PanelProps) {
  const projectMode = !!projectId;
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<UserAdmin[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickedProjectId, setPickedProjectId] = useState(projectId || '');
  const [personMode, setPersonMode] = useState<'new' | 'existing'>(presetUserId ? 'existing' : 'new');
  const [name, setName] = useState('');
  const [userId, setUserId] = useState(presetUserId || '');
  const [pickedCandidate, setPickedCandidate] = useState<MemberCandidate | null>(null);
  const [sameNameCandidate, setSameNameCandidate] = useState<MemberCandidate | null>(null);
  const [role, setRole] = useState<InviteRole>(defaultRole);
  const [days, setDays] = useState(7);
  const [singleUse, setSingleUse] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<'message' | 'link' | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 用戶頁：讀整份用戶和專案清單（只有全站製作拿得到）
  useEffect(() => {
    if (projectMode) return;
    setLoadError(null);
    let cancelled = false;
    Promise.all([api.listUsers(), api.listProjects()])
      .then(([u, p]) => {
        if (cancelled) return;
        setUsers(u);
        setProjects(p);
      })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [projectMode]);

  const targetProjectId = projectId || pickedProjectId;
  const targetProjectName = projectName || projects.find(p => p.id === targetProjectId)?.name || '';

  // 可以邀請的「已經有帳號的人」（用戶頁）：啟用中、不是製作（製作用登入碼）
  const invitable = useMemo(() => users.filter(u => !u.deactivated && u.role !== 'admin'), [users]);
  const pickedUser = invitable.find(u => u.id === userId) || null;

  const person: Person | null = projectMode
    ? (pickedCandidate && { id: pickedCandidate.id, name: pickedCandidate.name, projectRole: pickedCandidate.projectRole, accountRole: pickedCandidate.role })
    : (pickedUser && {
      id: pickedUser.id,
      name: pickedUser.name,
      projectRole: pickedUser.projects.find(m => m.projectId === targetProjectId)?.role ?? null,
      accountRole: pickedUser.role,
    });

  // 選了某個人 → 角色先帶他在這個專案（或帳號）原本的角色
  useEffect(() => {
    if (personMode !== 'existing' || !person) return;
    const r = person.projectRole ?? person.accountRole;
    if (isInviteRole(r)) setRole(r);
  }, [personMode, person?.id, person?.projectRole, person?.accountRole]);  // eslint-disable-line react-hooks/exhaustive-deps

  // 選了製作 → 有效天數不能超過 7 天
  useEffect(() => { setDays(d => clampInviteDays(role, d)); }, [role]);

  // 專案頁：新的人如果跟現有的用戶同名，提醒一下（用名字搜尋，不讀整份用戶清單）
  useEffect(() => {
    setSameNameCandidate(null);
    const text = name.trim();
    if (!projectMode || personMode !== 'new' || !text) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchMemberCandidates(projectId!, text)
        .then(list => { if (!cancelled) setSameNameCandidate(list.find(u => u.name.trim() === text) || null); })
        .catch(() => { /* 查不到就不提醒 */ });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [name, personMode, projectMode, projectId]);

  const sameNameUser = personMode === 'new' && name.trim()
    ? (projectMode ? sameNameCandidate : users.find(u => !u.deactivated && u.name.trim() === name.trim()) || null)
    : null;

  const forcedSingleUse = inviteMustBeSingleUse(role);
  const canSubmit = !!targetProjectId && (personMode === 'new' ? !!name.trim() : !!person) && !creating;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setCreating(true);
    try {
      const { invite, token } = await api.createInvite(targetProjectId, {
        role,
        ...(personMode === 'existing' && person ? { userId: person.id } : { name: name.trim() }),
        expiresInDays: days,
        singleUse: forcedSingleUse ? true : singleUse,
      });
      const url = inviteUrl(token);
      const pName = invite.projectName || targetProjectName;
      setCreated({
        url,
        personName: invite.personName,
        projectName: pName,
        message: buildInviteMessage({ personName: invite.personName, projectName: pName, url, days, maxUses: invite.maxUses }),
      });
      setCopied(null);
      setReloadKey(k => k + 1);
      onCreated?.({ personName: invite.personName, role });
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function copy(text: string, what: 'message' | 'link') {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(what);
      toast.success(what === 'message' ? '已複製訊息，貼到 LINE / 微信就可以' : '已複製連結');
    } else {
      toast.error('瀏覽器不讓我們複製，請自己選起來複製');
    }
  }

  function inviteAnother() {
    setCreated(null);
    setCopied(null);
    setName('');
    setError(null);
    setPickedCandidate(null);
    if (!presetUserId) { setPersonMode('new'); setUserId(''); }
  }

  return (
    <div className="invite-panel">
      {loadError && <div className="acct-error">讀不到用戶清單：{loadError}</div>}

      {created ? (
        <div className="acct-result" data-testid="invite-result">
          <div className="acct-result__title"><Icon icon={Check} /> 給「{created.personName}」的邀請連結建好了</div>
          <textarea readOnly value={created.message} aria-label="要傳給對方的訊息" onFocus={(e) => e.currentTarget.select()} />
          <div className="acct-result__row">
            <button type="button" className="btn btn--primary acct-btn" onClick={() => void copy(created.message, 'message')} autoFocus>
              <Icon icon={copied === 'message' ? Check : Copy} /> {copied === 'message' ? '已複製訊息' : '複製訊息'}
            </button>
            <button type="button" className="btn btn--ghost acct-btn" onClick={() => void copy(created.url, 'link')}>
              <Icon icon={copied === 'link' ? Check : Link} /> {copied === 'link' ? '已複製連結' : '只複製連結'}
            </button>
          </div>
          <div className="acct-result__link" data-testid="invite-url">{created.url}</div>
          <p className="acct-result__note">
            這個連結只會顯示這一次。對方點開、按「進入」，就會直接進到「{created.projectName}」，這台裝置之後也會記得他。
          </p>
          <div className="acct-result__row">
            <button type="button" className="btn btn--ghost acct-btn" onClick={inviteAnother}>
              <Icon icon={UserPlus} /> 再邀請一個人
            </button>
          </div>
        </div>
      ) : (
        <form className="acct-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!projectMode && (
            <div className="acct-field">
              <label htmlFor="inv-project">邀請到哪個專案</label>
              <select id="inv-project" value={pickedProjectId} onChange={(e) => setPickedProjectId(e.target.value)} required>
                <option value="">請選專案</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div className="acct-field">
            <span className="acct-field__label">邀請誰</span>
            <div className="acct-choice" role="radiogroup" aria-label="邀請誰">
              <label className={'acct-choice__item' + (personMode === 'new' ? ' is-active' : '')}>
                <input type="radio" name="inv-person" checked={personMode === 'new'} onChange={() => setPersonMode('new')} />
                <span>新的人<small>還沒有帳號，打開連結時幫他建好</small></span>
              </label>
              <label className={'acct-choice__item' + (personMode === 'existing' ? ' is-active' : '')}>
                <input type="radio" name="inv-person" checked={personMode === 'existing'} onChange={() => setPersonMode('existing')} />
                <span>已經有帳號的人<small>例如換了手機、忘記登入碼</small></span>
              </label>
            </div>
            {personMode === 'new' ? (
              <>
                <input
                  type="text" id="inv-name" aria-label="對方的名字" maxLength={80} value={name}
                  onChange={(e) => setName(e.target.value)} placeholder="對方的名字，例：王小明" autoFocus
                />
                {sameNameUser && (
                  <span className="acct-field__warn">
                    已經有一位叫「{sameNameUser.name}」的用戶。是同一個人的話，請選「已經有帳號的人」，不然會多一個帳號。
                  </span>
                )}
              </>
            ) : projectMode ? (
              <>
                <UserSearchPicker
                  projectId={projectId!}
                  placeholder="輸入名字找人"
                  renderAction={(u) => (
                    <button
                      type="button"
                      className={'btn acct-btn ' + (pickedCandidate?.id === u.id ? 'btn--primary' : 'btn--ghost')}
                      onClick={() => setPickedCandidate(u)}
                    >
                      {pickedCandidate?.id === u.id ? '已選他' : '選他'}
                    </button>
                  )}
                />
                {pickedCandidate && (
                  <span className="acct-field__hint" data-testid="invite-picked">已選：{pickedCandidate.name}</span>
                )}
              </>
            ) : (
              <>
                <select id="inv-user" aria-label="選擇用戶" value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">請選一個人</option>
                  {invitable.map(u => <option key={u.id} value={u.id}>{u.name}（{ROLE_LABEL[u.role]}）</option>)}
                </select>
                {invitable.length === 0 && <span className="acct-field__hint">還沒有可以邀請的用戶（製作帳號請用登入碼登入）。</span>}
              </>
            )}
            {personMode === 'existing' && person && person.projectRole && person.projectRole !== role && (
              <span className="acct-field__warn">
                他在這個專案現在是「{ROLE_LABEL[person.projectRole]}」，用了這個連結會改成「{ROLE_LABEL[role]}」。
              </span>
            )}
          </div>

          <div className="acct-field">
            <span className="acct-field__label">在這個專案的角色</span>
            <div className="acct-choice acct-choice--3" role="radiogroup" aria-label="角色">
              {INVITE_ROLE_CHOICES.map(o => (
                <label key={o.role} className={'acct-choice__item' + (role === o.role ? ' is-active' : '')}>
                  <input type="radio" name="inv-role" checked={role === o.role} onChange={() => setRole(o.role as InviteRole)} />
                  <span>{o.label}<small>{o.hint}</small></span>
                </label>
              ))}
            </div>
          </div>

          <div className="acct-field">
            <span className="acct-field__label">有效期限</span>
            <div className="acct-inline">
              <select aria-label="幾天內有效" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {inviteDayChoices(role).map(d => <option key={d} value={d}>{d} 天內有效</option>)}
              </select>
              <label className="acct-check">
                <input
                  type="checkbox" checked={forcedSingleUse ? true : singleUse} disabled={forcedSingleUse}
                  onChange={(e) => setSingleUse(e.target.checked)}
                />
                只能用一次
              </label>
            </div>
            <span className="acct-field__hint">
              {forcedSingleUse
                ? '製作的連結一律只能用一次、最長 7 天（連結如果外流，只有第一個打開的人進得去）。'
                : singleUse
                  ? '對方用過之後這個連結就不能再用（別人拿到也進不去）。'
                  : '有效期限內最多可以用 10 次（例如手機和電腦都要開），每次都是同一個人。'}
            </span>
          </div>

          {error && <div className="acct-error">{error}</div>}
          <div className="acct-result__row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn--primary acct-btn" disabled={!canSubmit}>
              {creating ? <><Icon icon={LoaderCircle} spin /> 建立中…</> : <><Icon icon={Link} /> 建立邀請連結</>}
            </button>
          </div>
        </form>
      )}

      <OpenInvitesList
        projectId={targetProjectId || undefined}
        showProject={!targetProjectId}
        reloadKey={reloadKey}
        title={targetProjectId ? '這個專案還沒用的邀請連結' : '還沒用的邀請連結'}
        onChanged={onChanged}
      />
    </div>
  );
}
