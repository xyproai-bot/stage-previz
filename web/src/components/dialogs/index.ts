// 站內對話框 + 小提示（取代瀏覽器的 alert / confirm / prompt；web/src/test/noNativeDialogs.test.ts 會擋）
//
//   confirmDialog / useConfirm   問一句「要不要」；會刪掉東西的用 destructive（紅色按鈕，按鈕寫「刪除」不寫「確定」）
//   promptDialog / usePrompt     請對方打一段字（名稱、標籤…）
//   chooseDialog                 兩三個選項選一個
//   toast                        不用回答的通知（成功、失敗原因、提醒），右下角自己消失
//
// 畫面：DialogHost（App 最外層放一次）。
import { useMemo } from 'react';
import { chooseDialog, confirmDialog, promptDialog } from './dialogStore';

export { confirmDialog, promptDialog, chooseDialog, splitQuestion } from './dialogStore';
export type { ConfirmOptions, PromptOptions, ChooseOptions, Choice } from './dialogStore';
export { toast } from '../../lib/toast';
export { default as DialogHost } from './DialogHost';

/** 元件裡用：const confirm = useConfirm(); if (!(await confirm({ ... }))) return; */
export function useConfirm(): typeof confirmDialog {
  return confirmDialog;
}

/** 元件裡用：const ask = usePrompt(); const name = await ask({ ... }); */
export function usePrompt(): typeof promptDialog {
  return promptDialog;
}

/** 三個一起拿 */
export function useDialogs() {
  return useMemo(() => ({ confirm: confirmDialog, prompt: promptDialog, choose: chooseDialog }), []);
}
