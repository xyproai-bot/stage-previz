// 設定登入碼的對話框：
//   target = { id, name }  全站製作幫別人重設（舊的登入碼馬上不能用）
//   target = 'self'        修改我自己的登入碼（有登入碼的人要先輸入現在的）
// 兩種都可以選「自動產生」或「自己設定」；設好之後把結果交給外面（用 LoginCodeDialog 只顯示一次）。
import { useState } from 'react';
import { KeyRound, LoaderCircle, X } from 'lucide-react';
import * as api from '../lib/api';
import { EMPTY_CHOICE, loginCodeFormState, type LoginCodeChoice } from '../lib/loginCodeForm';
import { useEscapeClose } from '../lib/useEscapeClose';
import Icon from './Icon';
import LoginCodeChooser from './LoginCodeChooser';
import './NewProjectDialog.css';
import './InviteDialog.css';

export interface LoginCodeSetResult {
  code: string;
  shownOnce: boolean;
  /** 自己設定的（顯示時照打的樣子，不用 5 個字一組分開） */
  custom: boolean;
}

interface Props {
  target: { id: string; name: string } | 'self';
  /** 對方現在有沒有登入碼（沒有 = 第一次產生） */
  hasCode?: boolean;
  /** 修改自己的時候，名字用來提醒「用名字當登入碼」 */
  selfName?: string;
  onClose: () => void;
  onDone: (result: LoginCodeSetResult) => void;
}

export default function LoginCodeSetDialog({ target, hasCode = true, selfName, onClose, onDone }: Props) {
  useEscapeClose(true, onClose);
  const isSelf = target === 'self';
  const name = isSelf ? (selfName ?? '') : target.name;
  const [choice, setChoice] = useState<LoginCodeChoice>(EMPTY_CHOICE);
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = loginCodeFormState(choice, { name });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!state.canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = isSelf
        ? await api.changeMyLoginCode({ currentCode: current.trim() || undefined, newCode: state.payload })
        : await api.setAccessCode(target.id, state.payload);
      onDone({ code: r.accessCode, shownOnce: !!r.shownOnce, custom: state.payload !== undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const title = isSelf ? '修改我的登入碼' : (hasCode ? `重設「${name}」的登入碼` : `幫「${name}」產生登入碼`);
  const submitLabel = isSelf
    ? '修改登入碼'
    : choice.mode === 'custom' ? '設定這組登入碼' : (hasCode ? '重設登入碼' : '產生登入碼');

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog acct-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2><Icon icon={KeyRound} size="md" /> {title}</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <form className="dialog__body" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p className="acct-field__hint" style={{ margin: 0 }}>
            {isSelf
              ? '改好之後，舊的登入碼馬上不能用，你在其他裝置上的登入會登出（這一台留著）。'
              : hasCode
                ? '舊的登入碼會馬上不能用，對方在其他裝置上的登入也會登出。'
                : '對方是用邀請連結進來的，還沒有登入碼；有了登入碼，換手機或電腦也能登入。'}
          </p>

          {isSelf && (
            <div className="acct-field">
              <label htmlFor="mycode-current">現在的登入碼</label>
              <input
                id="mycode-current" type="text" value={current} autoComplete="off" autoCapitalize="off" spellCheck={false}
                placeholder="輸入你現在用的登入碼" disabled={busy}
                onChange={(e) => setCurrent(e.target.value)}
              />
              <span className="acct-field__hint">用邀請連結進來、還沒有登入碼的人，這格可以留空。</span>
            </div>
          )}

          <LoginCodeChooser choice={choice} onChange={setChoice} name={name} disabled={busy} />

          {error && <div className="acct-error" role="alert">{error}</div>}
          <footer className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="btn btn--primary" disabled={!state.canSubmit || busy}>
              {busy ? <><Icon icon={LoaderCircle} spin /> 處理中…</> : submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
