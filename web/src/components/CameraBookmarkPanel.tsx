// 3D 工具列「視角」的面板：常用看台視角（每個人都有）+ 專案共用的視角書籤。
// 每個人都可以點了飛過去；製作、導演（有給 onChange）還可以存目前視角、改名、換順序、刪除。
// 只管畫面和清單怎麼改（lib/cameraBookmarks.ts 的純函式），鏡頭怎麼飛的事在 StageScene。

import { ChevronDown, ChevronUp, Pencil, X } from 'lucide-react';
import Icon from './Icon';
import { confirmDialog, promptDialog } from './dialogs/dialogStore';
import { toast } from '../lib/toast';
import type { CameraPreset, CameraPresetDef } from '../lib/stageCamera';
import {
  addCameraBookmark, CAMERA_BOOKMARK_MAX, CAMERA_BOOKMARK_NAME_MAX, cleanBookmarkName, defaultBookmarkName, moveCameraBookmark,
  newCameraBookmarkId, removeCameraBookmark, renameCameraBookmark, type CameraBookmark, type Vec3,
} from '../lib/cameraBookmarks';
import './CameraBookmarkPanel.css';

export interface CurrentCameraView { position: Vec3; target: Vec3; fov: number }

interface Props {
  presets: readonly CameraPresetDef[];
  bookmarks: readonly CameraBookmark[];
  onFlyPreset: (id: CameraPreset) => void;
  onFlyBookmark: (bm: CameraBookmark) => void;
  /** 現在鏡頭的位置（存視角用） */
  getCurrentView: () => CurrentCameraView | null;
  /** 有給 = 可以存 / 改名 / 換順序 / 刪除（製作、導演）；沒給 = 只能點了飛過去 */
  onChange?: (next: CameraBookmark[]) => void;
  onClose: () => void;
}

export default function CameraBookmarkPanel({ presets, bookmarks, onFlyPreset, onFlyBookmark, getCurrentView, onChange, onClose }: Props) {
  const canEdit = !!onChange;

  async function saveCurrent() {
    if (!onChange) return;
    const view = getCurrentView();
    if (!view) return;
    if (bookmarks.length >= CAMERA_BOOKMARK_MAX) {
      toast.warn(`最多存 ${CAMERA_BOOKMARK_MAX} 個視角，先刪掉不用的`);
      return;
    }
    const name = cleanBookmarkName(await promptDialog({
      title: '存目前的視角', label: '視角名稱', defaultValue: defaultBookmarkName(bookmarks), confirmLabel: '儲存', maxLength: CAMERA_BOOKMARK_NAME_MAX,
      hint: '專案裡的導演、動畫師和看分享連結的人都會看到',
    }));
    if (!name) return;
    const next = addCameraBookmark(bookmarks, { id: newCameraBookmarkId(), name, ...view });
    if (!next) { toast.error('這個視角存不起來（鏡頭位置不對）'); return; }
    onChange(next);
  }

  async function rename(bm: CameraBookmark) {
    if (!onChange) return;
    const name = cleanBookmarkName(await promptDialog({
      title: '改視角名稱', label: '視角名稱', defaultValue: bm.name, confirmLabel: '改名', maxLength: CAMERA_BOOKMARK_NAME_MAX,
    }));
    if (!name || name === bm.name) return;
    onChange(renameCameraBookmark(bookmarks, bm.id, name));
  }

  async function remove(bm: CameraBookmark) {
    if (!onChange) return;
    const yes = await confirmDialog({
      title: `刪除視角「${bm.name}」？`,
      message: '專案裡所有人都會看不到它。',
      confirmLabel: '刪除',
      destructive: true,
    });
    if (yes) onChange(removeCameraBookmark(bookmarks, bm.id));
  }

  return (
    <div className="bm-popover" role="dialog" aria-label="視角" onClick={e => e.stopPropagation()}>
      <div className="bm-popover__head">
        <span>視角</span>
        <button type="button" className="dlg__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
      </div>
      <div style={{ padding: '8px 10px 4px' }}>
        <div className="muted small" style={{ marginBottom: 6 }}>常用看台視角</div>
        <div className="bm-presets">
          {presets.map(p => (
            <button key={p.id} type="button" className="btn btn--ghost btn--sm" onClick={() => onFlyPreset(p.id)} title={p.hint}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="muted small" style={{ marginBottom: 6 }}>專案的視角{bookmarks.length > 0 ? `（${bookmarks.length}）` : ''}</div>
      </div>
      {canEdit && (
        <button type="button" className="btn btn--primary btn--sm bm-popover__save" onClick={() => { void saveCurrent(); }}>
          + 儲存目前視角
        </button>
      )}
      {bookmarks.length === 0 ? (
        <div className="bm-popover__empty">
          {canEdit ? '還沒存任何視角：把畫面轉到想要的角度，再按上面的「儲存目前視角」' : '這個專案還沒有存視角（製作或導演可以存）'}
        </div>
      ) : (
        <ul className="bm-popover__list">
          {bookmarks.map((bm, i) => (
            <li key={bm.id}>
              <button type="button" className="bm-row" onClick={() => onFlyBookmark(bm)}>
                <span className="bm-row__name">{bm.name}</span>
              </button>
              {canEdit && (
                <span className="bm-row__acts">
                  <button type="button" className="bm-row__act" onClick={() => onChange(moveCameraBookmark(bookmarks, bm.id, -1))} disabled={i === 0} title="往前排" aria-label={`把「${bm.name}」往前排`}><Icon icon={ChevronUp} /></button>
                  <button type="button" className="bm-row__act" onClick={() => onChange(moveCameraBookmark(bookmarks, bm.id, 1))} disabled={i === bookmarks.length - 1} title="往後排" aria-label={`把「${bm.name}」往後排`}><Icon icon={ChevronDown} /></button>
                  <button type="button" className="bm-row__act" onClick={() => { void rename(bm); }} title="改名" aria-label={`改「${bm.name}」的名稱`}><Icon icon={Pencil} /></button>
                  <button type="button" className="bm-row__act bm-row__act--del" onClick={() => { void remove(bm); }} title="刪除這個視角" aria-label={`刪除視角「${bm.name}」`}><Icon icon={X} /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
