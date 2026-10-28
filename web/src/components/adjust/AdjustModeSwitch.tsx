// 導演頁上方的「審片 / 調整舞台」切換

import { MessageSquareText, SlidersHorizontal } from 'lucide-react';
import Icon from '../Icon';
import { ADJUST_TEXT } from '../../lib/adjust/panelText';
import './AdjustStage.css';

export default function AdjustModeSwitch({ on, onReview, onAdjust }: { on: boolean; onReview: () => void; onAdjust: () => void }) {
  return (
    <span className="adjust-switch" role="group" aria-label="審片或調整舞台">
      <button type="button" aria-pressed={!on} onClick={() => { if (on) onReview(); }} title="看影片、留言、通過 / 需修改">
        <Icon icon={MessageSquareText} /> {ADJUST_TEXT.modeReview}
      </button>
      <button type="button" aria-pressed={on} onClick={() => { if (!on) onAdjust(); }} title={ADJUST_TEXT.modeHint}>
        <Icon icon={SlidersHorizontal} /> {ADJUST_TEXT.modeAdjust}
      </button>
    </span>
  );
}
