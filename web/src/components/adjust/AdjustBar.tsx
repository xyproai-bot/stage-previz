// 調整舞台：改了東西以後 3D 下面的黃色提示列（「改了 N 個機關」+ 放棄 + 存回 Cue 庫（下一版開放，按不下去））

import { useSyncExternalStore } from 'react';
import { Save, Undo2 } from 'lucide-react';
import Icon from '../Icon';
import type { AdjustStore } from '../../lib/adjust/store';
import { ADJUST_TEXT, barText } from '../../lib/adjust/panelText';
import './AdjustStage.css';

export default function AdjustBar({ store }: { store: AdjustStore }) {
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const n = Object.keys(st.draft).length;
  if (!st.on || n === 0) return null;
  const cue = store.cue();
  return (
    <div className="adjust-bar" role="status">
      <span className="adjust-bar__text">
        <strong>{barText(n)}</strong>{cue?.cueName ? `（cue ${cue.cueName}）` : ''}
        <br /><span className="adjust-bar__sub">{ADJUST_TEXT.barSub}</span>
      </span>
      <button type="button" onClick={() => store.discardAll()}><Icon icon={Undo2} /> {ADJUST_TEXT.discard}</button>
      <button type="button" disabled title="下一版開放"><Icon icon={Save} /> {ADJUST_TEXT.saveDisabled}</button>
    </div>
  );
}
