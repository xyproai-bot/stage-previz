// 登入碼怎麼來：自動產生 / 自己設定（新增用戶、重設登入碼、修改我的登入碼共用）。
// 規則和提醒在 lib/loginCodeForm.ts（有測試）；這裡只負責畫出來。
import { useId } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import Icon from './Icon';
import { loginCodeFormState, type LoginCodeChoice } from '../lib/loginCodeForm';
import { CUSTOM_CODE_MAX, CUSTOM_CODE_MIN } from '../lib/loginCodeRules';
import './InviteDialog.css';
import './MembersPanel.css';

interface Props {
  choice: LoginCodeChoice;
  onChange: (next: LoginCodeChoice) => void;
  /** 這組登入碼是誰的（用名字當登入碼時提醒） */
  name?: string | null;
  disabled?: boolean;
}

export default function LoginCodeChooser({ choice, onChange, name, disabled }: Props) {
  const groupName = useId();
  const state = loginCodeFormState(choice, { name });
  const typed = choice.value.trim() !== '';

  return (
    <div className="acct-field login-chooser">
      <span className="acct-field__label">登入碼</span>
      <div className="acct-choice" role="radiogroup" aria-label="登入碼怎麼來">
        <label className={'acct-choice__item' + (choice.mode === 'auto' ? ' is-active' : '')}>
          <input
            type="radio" name={groupName} checked={choice.mode === 'auto'} disabled={disabled}
            onChange={() => onChange({ ...choice, mode: 'auto' })}
          />
          <span>自動產生<small>系統產生一組 10 個字的登入碼</small></span>
        </label>
        <label className={'acct-choice__item' + (choice.mode === 'custom' ? ' is-active' : '')}>
          <input
            type="radio" name={groupName} checked={choice.mode === 'custom'} disabled={disabled}
            onChange={() => onChange({ ...choice, mode: 'custom' })}
          />
          <span>自己設定<small>自己決定，{CUSTOM_CODE_MIN}～{CUSTOM_CODE_MAX} 個字</small></span>
        </label>
      </div>
      {choice.mode === 'custom' && (
        <>
          <input
            type="text"
            aria-label="自己設定的登入碼"
            placeholder="例：stage-2026"
            value={choice.value}
            maxLength={64}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={disabled}
            autoFocus
            onChange={(e) => onChange({ ...choice, value: e.target.value })}
          />
          <span className="acct-field__hint">
            {CUSTOM_CODE_MIN}～{CUSTOM_CODE_MAX} 個字，英文字母、數字和連字號（-），不分大小寫。不能跟別人的一樣。
          </span>
          {state.error && <span className="acct-field__error" role="alert">{state.error}</span>}
          {!state.error && state.weakSummary && (
            <span className="acct-field__warn" data-testid="login-code-weak">
              <Icon icon={TriangleAlert} /> {state.weakSummary}
              {state.warnings.length > 0 ? `：${state.warnings.join('；')}` : ''}。可以照用，但建議換一組。
            </span>
          )}
          {state.canSubmit && typed && !state.weakSummary && (
            <span className="acct-field__ok"><Icon icon={Check} /> 這組可以用</span>
          )}
        </>
      )}
    </div>
  );
}
