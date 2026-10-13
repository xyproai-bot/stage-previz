// 邀請連結：/invite/<邀請碼>
//   1. 先看這條邀請是給誰、哪個專案（不會用掉）
//   2. 對方按「進入」→ 登入（新的人這時建帳號）、加進專案 → 直接進專案（動畫師 → 工作站、導演 → 審片頁）
// 為什麼要按一下才用掉：LINE / 微信 / iMessage 傳連結時會先偷偷打開網址做預覽，
// 如果一打開就用掉，只能用一次的邀請會被預覽用掉，對方點開時已經不能用。
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { InviteError, InvitePeek } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/roleLabels';
import { parseServerTime } from '../lib/serverTime';
import { CircleAlert, LoaderCircle, LogIn, RefreshCw } from 'lucide-react';
import Icon from '../components/Icon';
import './Login.css';
import './InvitePage.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; invite: InvitePeek }
  | { kind: 'entering'; invite: InvitePeek }
  | { kind: 'problem'; message: string }
  | { kind: 'offline' };

function expiryDate(iso: string): string {
  const d = new Date(parseServerTime(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 後台沒給說明（網路斷了以外的怪錯誤）時的說法 */
const FALLBACK_PROBLEM = '這個邀請連結不能用了。請跟製作要一個新的連結。';

export default function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', invite: await api.peekInvite(token) });
    } catch (e) {
      const err = e as InviteError;
      if (err.status) setState({ kind: 'problem', message: err.message || FALLBACK_PROBLEM });
      else setState({ kind: 'offline' });
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function enter() {
    if (state.kind !== 'ready') return;
    setState({ kind: 'entering', invite: state.invite });
    try {
      const r = await api.redeemInvite(token);
      await refresh();  // 換成這個人登入（跟一般登入一樣記在這台裝置）
      navigate(r.landingPath, { replace: true });
    } catch (e) {
      const err = e as InviteError;
      if (err.status) setState({ kind: 'problem', message: err.message || FALLBACK_PROBLEM });
      else setState({ kind: 'offline' });
    }
  }

  return (
    <div className="login-page">
      <div className="login-card invite-card">
        <div className="login-card__brand">
          <span className="login-card__brand-mark" />
          <span>STAGE <strong>PREVIZ</strong></span>
        </div>

        {state.kind === 'loading' && (
          <p className="muted invite-card__status" role="status"><Icon icon={LoaderCircle} spin /> 正在打開邀請…</p>
        )}

        {(state.kind === 'ready' || state.kind === 'entering') && (
          <>
            <h1>{state.invite.personName ? `${state.invite.personName}你好` : '你好'}</h1>
            <p className="invite-card__lead">
              製作邀請你進入「<strong>{state.invite.projectName}</strong>」，你的身分是<strong>{ROLE_LABEL[state.invite.role]}</strong>。
            </p>
            {user && state.invite.personName && user.name !== state.invite.personName && (
              <p className="invite-card__note">
                這台裝置現在是用「{user.name}」登入的，按「進入」之後會換成{state.invite.personName}。
              </p>
            )}
            <button
              type="button"
              className="btn btn--primary invite-card__enter"
              onClick={() => void enter()}
              disabled={state.kind === 'entering'}
              autoFocus
            >
              {state.kind === 'entering'
                ? <><Icon icon={LoaderCircle} spin /> 進入中…</>
                : <><Icon icon={LogIn} /> 進入專案</>}
            </button>
            <p className="muted small invite-card__hint">
              這個連結 {expiryDate(state.invite.expiresAt)} 前有效。進去之後，這台裝置會記得你，下次直接打開網站就可以。
            </p>
          </>
        )}

        {state.kind === 'problem' && (
          <>
            <h1 className="invite-card__problem-title"><Icon icon={CircleAlert} size="lg" /> 這個連結不能用了</h1>
            <p className="invite-card__lead" data-testid="invite-problem">{state.message}</p>
            <p className="muted small invite-card__hint">
              已經有登入碼的話，也可以到 <RouterLink to="/login">登入頁</RouterLink> 用登入碼登入。
            </p>
          </>
        )}

        {state.kind === 'offline' && (
          <>
            <h1 className="invite-card__problem-title"><Icon icon={CircleAlert} size="lg" /> 連不上</h1>
            <p className="invite-card__lead">現在連不到伺服器，請確認網路之後再試一次。</p>
            <button type="button" className="btn btn--primary invite-card__enter" onClick={() => void load()}>
              <Icon icon={RefreshCw} /> 再試一次
            </button>
          </>
        )}
      </div>
    </div>
  );
}
