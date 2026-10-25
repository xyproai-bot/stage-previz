// Show 頁的「改說明」：建立 Show 時可以寫說明（最多 300 字），之後也要能改。
//   後台 PATCH /api/shows/:id（name / description），只有製作。
import { promptDialog } from '../components/dialogs/dialogStore';
import { updateShow } from './api';
import { friendlyError } from './songReview';
import { textEditResult } from './textEdit';
import { toast } from './toast';

/** 說明最多幾個字（後台也是 300） */
export const SHOW_DESC_MAX = 300;

/** 問新的說明 → 存。有存到回 true（呼叫的人接著重新讀 Show）；取消 / 沒改 / 失敗回 false */
export async function editShowDescription(show: { id: string; name: string; description: string }): Promise<boolean> {
  const answer = await promptDialog({
    title: `「${show.name}」的說明`,
    label: '說明（顯示在這個 Show 的頁面上，可以留空）',
    defaultValue: show.description || '',
    confirmLabel: '儲存',
    required: false,
    maxLength: SHOW_DESC_MAX,
    hint: '清空就是拿掉說明',
  });
  const r = textEditResult(show.description, answer, SHOW_DESC_MAX);
  if (r.kind !== 'save') return false;
  try {
    await updateShow(show.id, { description: r.value });
    toast.success(r.value ? '已改好說明' : '已拿掉說明');
    return true;
  } catch (e) {
    toast.error('說明沒有存到：' + friendlyError(e));
    return false;
  }
}
