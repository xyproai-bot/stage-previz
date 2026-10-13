// 還沒用的邀請連結（沒撤銷、沒過期、還有次數），每一條可以撤銷。用戶頁（所有專案）和邀請對話框（這個專案）共用。
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { Invite } from '../lib/api';
import { ROLE_LABEL } from '../lib/roleLabels';
import { inviteExpiryText, inviteUsesText } from '../lib/inviteMessage';
import { toast } from '../lib/toast';
import { Ban, LoaderCircle, RefreshCw } from 'lucide-react';
import Icon from './Icon';
import { confirmDialog } from './dialogs';
import './InviteDialog.css';

interface Props {
  /** 只看這個專案；不給 = 所有專案 */
  projectId?: string;
  /** 這個值一變就重新抓（剛建好一條新的） */
  reloadKey?: number;
  /** 每一條要不要寫是哪個專案（看所有專案時要） */
  showProject?: boolean;
  title?: string;
  /** 撤銷之後通知外面（例如用戶頁重新整理） */
  onChanged?: () => void;
}

export default function OpenInvitesList({ projectId, reloadKey = 0, showProject = !projectId, title = '還沒用的邀請連結', onChanged }: Props) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setInvites(projectId ? await api.listProjectInvites(projectId) : await api.listAllInvites());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh, reloadKey]);

  async function revoke(inv: Invite) {
    if (!(await confirmDialog({
      title: `撤銷「${inv.personName}」的邀請連結？`,
      message: '之前傳出去的這個連結會馬上不能用。',
      confirmLabel: '撤銷',
      destructive: true,
    }))) return;
    setBusyId(inv.id);
    try {
      await api.revokeInvite(inv.projectId, inv.id);
      toast.success('已撤銷，這個連結不能用了');
      await refresh();
      onChanged?.();
    } catch (e) {
      toast.error('撤銷失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="acct-invites" aria-label={title}>
      <h3 className="acct-invites__title">
        <span>{title}{invites && invites.length > 0 ? `（${invites.length}）` : ''}</span>
        <button type="button" className="acct-invites__revoke" onClick={() => void refresh()} title="重新整理" aria-label="重新整理">
          <Icon icon={RefreshCw} />
        </button>
      </h3>
      {error ? (
        <div className="acct-error">讀不到邀請清單：{error}</div>
      ) : invites === null ? (
        <p className="acct-invites__empty"><Icon icon={LoaderCircle} spin /> 載入中…</p>
      ) : invites.length === 0 ? (
        <p className="acct-invites__empty">目前沒有還沒用的邀請連結。</p>
      ) : (
        <ul>
          {invites.map(inv => (
            <li key={inv.id} data-invite-id={inv.id}>
              <div className="acct-invites__main">
                <span className="acct-invites__who">
                  {inv.personName}{inv.isNewPerson ? '（新的人）' : ''} · {ROLE_LABEL[inv.role]}
                </span>
                <span className="acct-invites__meta">
                  {showProject && inv.projectName ? `${inv.projectName} · ` : ''}
                  {inviteExpiryText(inv.expiresAt)} · {inviteUsesText(inv.useCount, inv.maxUses)}
                  {inv.createdByName ? ` · ${inv.createdByName} 建的` : ''}
                </span>
              </div>
              <button
                type="button"
                className="acct-invites__revoke"
                onClick={() => void revoke(inv)}
                disabled={busyId === inv.id}
                title="撤銷：這個連結馬上不能用"
              >
                <Icon icon={Ban} /> 撤銷
              </button>
            </li>
          ))}
        </ul>
      )}
      {invites && invites.length > 0 && (
        <p className="acct-field__hint">連結只在建立時顯示一次。要再傳給同一個人，請撤銷舊的、再建一個新的。</p>
      )}
    </section>
  );
}
