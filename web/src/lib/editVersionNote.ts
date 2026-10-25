// 影片版本「改說明」：導演頁 / 動畫師工作站的版本列、編輯頁的「影片版本」視窗共用。
//   後台 PATCH /api/projects/:id/songs/:songId/videos/:videoId（title / note / width / height / durationSec），
//   權限由後台把關（製作、交這一版的人；導演只有自己貼連結交的那一版）；畫面上跟「刪除」同一個條件才出現按鈕。
import { promptDialog } from '../components/dialogs/dialogStore';
import { toast } from './toast';
import { friendlyError } from './songReview';
import { textEditResult } from './textEdit';
import { patchSongVideo } from './videoApi';
import type { VersionItem } from './songVersions';

/** 說明最多幾個字（交影片時的輸入框也是 200；後台上限 500） */
export const VERSION_NOTE_MAX = 200;

/**
 * 問新的說明 → 存。有存到回 true（呼叫的人接著重新讀版本清單）；取消 / 沒改 / 失敗回 false。
 */
export async function editVersionNote(
  projectId: string,
  songId: string,
  item: Pick<VersionItem, 'id' | 'label' | 'note'>,
): Promise<boolean> {
  const answer = await promptDialog({
    title: `改 ${item.label} 的說明`,
    label: '說明（一行，選填）',
    defaultValue: item.note,
    placeholder: '例：修了第二段的轉場',
    hint: '清空就是拿掉說明',
    confirmLabel: '儲存',
    required: false,
    maxLength: VERSION_NOTE_MAX,
  });
  const r = textEditResult(item.note, answer, VERSION_NOTE_MAX);
  if (r.kind !== 'save') return false;
  try {
    await patchSongVideo(projectId, songId, item.id, { note: r.value });
    toast.success(r.value ? `已改好 ${item.label} 的說明` : `已拿掉 ${item.label} 的說明`);
    return true;
  } catch (e) {
    toast.error('說明沒有存到：' + friendlyError(e));
    return false;
  }
}
