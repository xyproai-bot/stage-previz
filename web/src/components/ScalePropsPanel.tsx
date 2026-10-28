// 3D 工具列「比例尺」的設定面板：要不要顯示人形 / 網格 / 樂手和器材、加樂手或器材、轉 / 刪掉選到的那一個、復原、一次清掉。
// 只管畫面，拖動、選取的事在 StageScene（lib/stagePropsScene.ts），復原紀錄在 lib/useStageProps.ts（規則在 lib/stagePropsHistory.ts）；
// 沒有權限改的人（動畫師、分享連結）看不到加 / 轉 / 刪 / 復原 / 清掉。

import { useEffect, useRef } from 'react';
import { Eraser, RotateCcw, RotateCw, Trash2, Undo2, X } from 'lucide-react';
import Icon from './Icon';
import { confirmDialog } from './dialogs/dialogStore';
import { CLEAR_SCOPES, CLEAR_SCOPE_HINT, CLEAR_SCOPE_LABEL, clearQuestion, isStagePropsUndoKey, type ClearScope } from '../lib/stagePropsHistory';
import {
  STAGE_PROP_GROUP_LABEL, STAGE_PROP_MAX, STAGE_PROP_SPECS, type StagePropGroup, type StagePropType,
} from '../lib/stageProps';
import './ScalePropsPanel.css';

export type ScalePart = 'figures' | 'grid' | 'props';

interface Props {
  figures: boolean;
  grid: boolean;
  props: boolean;
  onToggle: (part: ScalePart, on: boolean) => void;
  /** 專案上擺了幾個 */
  count: number;
  /** 能不能加 / 轉 / 刪（製作、導演） */
  canEdit: boolean;
  /** 選到的那一個的名字；沒選 = null */
  selectedLabel: string | null;
  onAdd: (type: StagePropType) => void;
  onRotate: (deg: number) => void;
  onDelete: () => void;
  /** 還能復原幾步（0 = 「復原」灰掉）；沒給 onUndo = 沒有復原和清掉 */
  undoDepth?: number;
  onUndo?: () => void;
  /** 清掉（全部 / 只清樂手 / 只清器材）；按了面板會先問一聲 */
  onClear?: (scope: ClearScope) => void;
  /** 各範圍現在有幾個（0 的那顆灰掉） */
  counts?: Record<ClearScope, number>;
  onClose: () => void;
  onTurnOff: () => void;
}

const GROUPS: StagePropGroup[] = ['person', 'gear'];

export default function ScalePropsPanel({
  figures, grid, props, onToggle, count, canEdit, selectedLabel, onAdd, onRotate, onDelete, undoDepth = 0, onUndo, onClear, counts, onClose, onTurnOff,
}: Props) {
  const full = count >= STAGE_PROP_MAX;
  const canUndo = canEdit && !!onUndo;

  // 面板開著時 Ctrl+Z / Cmd+Z = 復原（在打字的地方不算；沒有可以復原的就不攔，照樣交給頁面原本的 Ctrl+Z）。
  // 用 capture 搶在頁面其他的 Ctrl+Z（編輯頁的 cue 復原）前面，這時候按的是樂手和器材
  const undoRef = useRef({ depth: undoDepth, undo: onUndo });
  undoRef.current = { depth: undoDepth, undo: onUndo };
  useEffect(() => {
    if (!canUndo) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isStagePropsUndoKey(e)) return;
      const u = undoRef.current;
      if (u.depth <= 0 || !u.undo) return;
      if (document.querySelector('.sp-dialog-backdrop')) return;  // 站內對話框開著，Ctrl+Z 是對話框的事
      e.preventDefault();
      e.stopPropagation();
      u.undo();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [canUndo]);

  async function askClear(scope: ClearScope) {
    const n = counts?.[scope] ?? 0;
    if (!onClear || n <= 0) return;
    if (!(await confirmDialog({ ...clearQuestion(scope, n), destructive: true }))) return;
    onClear(scope);
  }
  return (
    <div className="sp-popover" role="dialog" aria-label="比例尺設定" onClick={e => e.stopPropagation()}>
      <div className="sp-popover__head">
        <span>比例尺</span>
        <button type="button" className="dlg__close" onClick={onClose} title="收起面板" aria-label="收起面板"><Icon icon={X} size="md" /></button>
      </div>
      <div className="sp-popover__body">
        <label className="sp-check">
          <input type="checkbox" checked={figures} onChange={e => onToggle('figures', e.target.checked)} />
          <span>人形</span>
          <small>三個 1.7 m 的人，可以拖</small>
        </label>
        <label className="sp-check">
          <input type="checkbox" checked={grid} onChange={e => onToggle('grid', e.target.checked)} />
          <span>網格</span>
          <small>每格 1 m</small>
        </label>
        {(canEdit || count > 0) && (
          <label className="sp-check">
            <input type="checkbox" checked={props} onChange={e => onToggle('props', e.target.checked)} />
            <span>樂手和器材</span>
            <small>{count > 0 ? `${count} 個` : '還沒擺'}</small>
          </label>
        )}

        {canUndo && (
          <div className="sp-undo">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onUndo}
              disabled={undoDepth <= 0}
              title={undoDepth > 0 ? `復原上一步（Ctrl+Z）：加、刪、移動、轉、清掉都算，還能退 ${undoDepth} 步` : '沒有可以復原的（只記這次打開頁面以後做的）'}
            >
              <Icon icon={Undo2} /> 復原
            </button>
            <small>{undoDepth > 0 ? `還能退 ${undoDepth} 步` : '這次打開後還沒動過'}</small>
          </div>
        )}

        {canEdit && selectedLabel && (
          <div className="sp-selected">
            <div className="sp-selected__name">已選：<strong>{selectedLabel}</strong></div>
            <div className="sp-row">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRotate(-15)} title="往左轉 15 度（從畫面上看）">
                <Icon icon={RotateCcw} /> 轉 15°
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRotate(15)} title="往右轉 15 度（從畫面上看）">
                <Icon icon={RotateCw} /> 轉 15°
              </button>
              <button type="button" className="btn btn--ghost btn--sm sp-del" onClick={onDelete} title="從專案拿掉這個">
                <Icon icon={Trash2} /> 刪除
              </button>
            </div>
            <p className="sp-hint">在畫面上拖可以移到別處（可以站上樂手台）；拖腳下圈圈上的圓點可以自由轉，按住 Shift 每 15° 一格。</p>
          </div>
        )}

        {canEdit && (
          <div className="sp-add">
            <div className="sp-add__title">加樂手／器材</div>
            {GROUPS.map(g => (
              <div key={g} className="sp-add__group">
                <div className="sp-add__label">{STAGE_PROP_GROUP_LABEL[g]}</div>
                <div className="sp-chips">
                  {STAGE_PROP_SPECS.filter(s => s.group === g).map(s => (
                    <button
                      key={s.type}
                      type="button"
                      className="btn btn--ghost btn--sm sp-chip"
                      disabled={full}
                      onClick={() => onAdd(s.type)}
                      title={full ? `最多擺 ${STAGE_PROP_MAX} 個` : `加一個${s.label}（約 ${s.size.w} × ${s.size.d} × ${s.size.h} m），放在舞台前緣中間、面向觀眾`}
                    >{s.label}</button>
                  ))}
                </div>
              </div>
            ))}
            <p className="sp-hint">擺的位置所有人都看得到（製作、導演可以改，動畫師和分享連結只能看）。</p>
            {onClear && counts && (
              <div className="sp-clear">
                <div className="sp-add__title">一次清掉</div>
                <div className="sp-clear__row">
                  {CLEAR_SCOPES.map(sc => (
                    <button
                      key={sc}
                      type="button"
                      className="btn btn--ghost btn--sm sp-del sp-clear__btn"
                      disabled={counts[sc] <= 0}
                      onClick={() => { void askClear(sc); }}
                      title={counts[sc] > 0 ? `${CLEAR_SCOPE_HINT[sc]}（${counts[sc]} 個）` : '沒有可以清的'}
                    >
                      <Icon icon={sc === 'all' ? Trash2 : Eraser} /> {CLEAR_SCOPE_LABEL[sc]}
                      <small>{counts[sc]}</small>
                    </button>
                  ))}
                </div>
                <p className="sp-hint">按了會先問一聲；清錯了按上面的「復原」拿回來。三個預設人形不算（那是「人形」的勾）。</p>
              </div>
            )}
          </div>
        )}
        {!canEdit && count > 0 && <p className="sp-hint">樂手和器材由製作或導演擺放，這裡只能看。</p>}
      </div>
      <div className="sp-popover__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onTurnOff}>關閉比例尺</button>
      </div>
    </div>
  );
}
