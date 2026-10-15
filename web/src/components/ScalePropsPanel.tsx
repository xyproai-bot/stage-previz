// 3D 工具列「比例尺」的設定面板：要不要顯示人形 / 網格 / 樂手和器材、加樂手或器材、轉 / 刪掉選到的那一個。
// 只管畫面，拖動、選取的事在 StageScene（lib/stagePropsScene.ts）；沒有權限改的人（動畫師、分享連結）看不到加 / 轉 / 刪。

import { RotateCcw, RotateCw, Trash2, X } from 'lucide-react';
import Icon from './Icon';
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
  onClose: () => void;
  onTurnOff: () => void;
}

const GROUPS: StagePropGroup[] = ['person', 'gear'];

export default function ScalePropsPanel({
  figures, grid, props, onToggle, count, canEdit, selectedLabel, onAdd, onRotate, onDelete, onClose, onTurnOff,
}: Props) {
  const full = count >= STAGE_PROP_MAX;
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
