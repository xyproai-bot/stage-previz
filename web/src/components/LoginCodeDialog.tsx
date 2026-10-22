// 剛建立 / 重設的登入碼：顯示一次 + 複製 + 可以直接貼到 LINE / 微信的訊息
import { useMemo } from 'react';
import { buildLoginCodeMessage, formatLoginCodeForDisplay } from '../lib/inviteMessage';
import { loginPageUrl } from '../lib/siteUrl';
import { copyToClipboard } from '../lib/clipboard';
import { toast } from '../lib/toast';
import { Copy, KeyRound, X } from 'lucide-react';
import Icon from './Icon';
import './NewProjectDialog.css';
import './InviteDialog.css';

interface Props {
  open: boolean;
  name: string;
  code: string;
  /** 後台已經改成「只顯示一次」（雜湊存法） */
  shownOnce: boolean;
  /** 重設（舊的登入碼已經不能用）；false = 新建的用戶 */
  isReset: boolean;
  /** 自己改自己的登入碼：標題寫「我的新登入碼」，不用給對方的訊息 */
  self?: boolean;
  /** 自己設定的登入碼：顯示時照打的樣子（系統產生的 10 個字才每 5 個字空一格） */
  custom?: boolean;
  onClose: () => void;
}

export default function LoginCodeDialog({ open, name, code, shownOnce, isReset, self = false, custom = false, onClose }: Props) {
  const message = useMemo(() => buildLoginCodeMessage({ name, code, loginUrl: loginPageUrl() }), [name, code]);
  if (!open) return null;

  async function copy(text: string, what: string) {
    const ok = await copyToClipboard(text);
    if (ok) toast.success(`已複製${what}`);
    else toast.error('瀏覽器不讓我們複製，請自己選起來複製');
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog acct-dialog" role="dialog" aria-modal="true" aria-label={self ? '我的新登入碼' : `${name} 的登入碼`} onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2><Icon icon={KeyRound} size="md" /> {self ? '我的新登入碼' : `${name} 的登入碼`}</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          <div className="acct-code" data-testid="login-code">{custom ? code : formatLoginCodeForDisplay(code)}</div>
          <div className="acct-result__row">
            <button type="button" className="btn btn--ghost acct-btn" onClick={() => void copy(code, '登入碼')}>
              <Icon icon={Copy} /> 複製登入碼
            </button>
          </div>
          {!self && (
            <div className="acct-field">
              <span className="acct-field__label">可以直接貼到 LINE / 微信的訊息</span>
              <div className="acct-result">
                <textarea readOnly value={message} aria-label="要傳給對方的訊息" onFocus={(e) => e.currentTarget.select()} />
                <div className="acct-result__row">
                  <button type="button" className="btn btn--primary acct-btn" onClick={() => void copy(message, '訊息')} autoFocus>
                    <Icon icon={Copy} /> 複製訊息
                  </button>
                </div>
              </div>
            </div>
          )}
          <p className="acct-result__note" data-testid="login-code-note">
            {isReset ? '舊的登入碼已經不能用了。' : ''}
            {shownOnce
              ? (self
                ? '登入碼只會顯示這一次，關掉之後系統不會再顯示；請現在記下來或複製起來。忘記了要請製作幫你重設。'
                : '登入碼只會顯示這一次，關掉之後系統不會再顯示；請現在複製起來。忘記了可以再按「重設」。')
              : self ? '請現在記下來或複製起來。' : '請現在複製傳給對方。'}
          </p>
          <footer className="dialog__footer">
            <button type="button" className="btn btn--primary" onClick={onClose}>完成</button>
          </footer>
        </div>
      </div>
    </div>
  );
}
