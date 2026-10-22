// 登入碼輸入框（新增用戶、重設登入碼、修改我的登入碼）要用的純判斷：
// 選「自動產生」還是「自己設定」，自己設定時能不能送出、要擋什麼、要提醒什麼。
// 規則本身在 loginCodeRules.ts（前後台共用）；後台才查得到的「不能跟別人重複」不在這裡，送出後由後台回覆。
import { WEAK_CODE_SUMMARY, checkCustomCode } from './loginCodeRules';

export type LoginCodeMode = 'auto' | 'custom';

export interface LoginCodeChoice {
  mode: LoginCodeMode;
  /** 使用者輸入的（自己設定時才用） */
  value: string;
}

export interface LoginCodeFormState {
  /** 能不能送出 */
  canSubmit: boolean;
  /** 要送給後台的登入碼；自動產生 = undefined（不送，後台產生） */
  payload: string | undefined;
  /** 擋住的原因（沒打字時不顯示，免得一打開就一片紅） */
  error: string | null;
  /** 提醒（不擋，可以照樣送出） */
  warnings: string[];
  /** 有提醒時的總結 */
  weakSummary: string | null;
}

export const EMPTY_CHOICE: LoginCodeChoice = { mode: 'auto', value: '' };

/**
 * @param choice 目前的選擇
 * @param opts.name 這組登入碼是誰的（提醒「用名字」用）
 */
export function loginCodeFormState(choice: LoginCodeChoice, opts: { name?: string | null } = {}): LoginCodeFormState {
  if (choice.mode === 'auto') {
    return { canSubmit: true, payload: undefined, error: null, warnings: [], weakSummary: null };
  }
  const typed = choice.value.trim() !== '';
  const r = checkCustomCode(choice.value, { name: opts.name });
  if (!r.ok) {
    return { canSubmit: false, payload: undefined, error: typed ? r.error : null, warnings: [], weakSummary: null };
  }
  return {
    canSubmit: true,
    payload: r.code,
    error: null,
    warnings: r.warnings,
    weakSummary: r.warnings.length > 0 ? WEAK_CODE_SUMMARY : null,
  };
}
