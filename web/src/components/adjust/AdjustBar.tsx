// 調整舞台：3D 下面的提示列
//   改了東西 → 黃色：「改了 N 個機關」＋ 放棄改動 / 另存成新 cue / 存回 Cue 庫
//   存完 → 綠色：「已存回 cue 30…」＋ 復原（後台回的上一版，20 秒內）
//   開始調之後這個 cue 又被別人改過 → 黃色那條多一行說明 + 重新載入

import { useSyncExternalStore } from 'react';
import { CircleCheck, CopyPlus, RefreshCw, Save, Undo2, X } from 'lucide-react';
import Icon from '../Icon';
import type { AdjustStore } from '../../lib/adjust/store';
import { barText } from '../../lib/adjust/panelText';
import { STAGE_SAVE_TEXT } from '../../lib/adjust/saveBack';
import type { StageSaveApi } from './useStageSave';
import './AdjustStage.css';

export default function AdjustBar({ store, save }: { store: AdjustStore; save: StageSaveApi }) {
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const n = Object.keys(st.draft).length;
  const notice = save.notice;
  if (!st.on) return null;
  if (n === 0) {
    if (!notice) return null;
    return (
      <div className="adjust-bar adjust-bar--saved" role="status">
        <span className="adjust-bar__text"><Icon icon={CircleCheck} /> <strong>{notice.text}</strong></span>
        {notice.undo && (
          <button type="button" onClick={notice.undo} disabled={save.busy}><Icon icon={Undo2} /> {STAGE_SAVE_TEXT.undo}</button>
        )}
        <button type="button" className="adjust-bar__x" onClick={save.dismissNotice} title={STAGE_SAVE_TEXT.close} aria-label={STAGE_SAVE_TEXT.close}><Icon icon={X} /></button>
      </div>
    );
  }
  const target = store.saveTarget();
  const cue = store.cue();
  const label = target.libraryLabel ? `cue ${target.libraryLabel}` : cue?.cueName ? `cue ${cue.cueName}` : '';
  const cueText = label ? (target.libraryLabel && cue?.cueName ? `（${label} ${cue.cueName}）` : `（${label}）`) : '';
  const canSaveBack = !!target.libraryCueId && target.baseRev !== null;
  const noSaveReason = !target.libraryCueId ? STAGE_SAVE_TEXT.noCue : target.baseRev === null ? STAGE_SAVE_TEXT.oldBackend : undefined;
  return (
    <div className="adjust-bar" role="status">
      <span className="adjust-bar__text">
        <strong>{barText(n)}</strong>{cueText}
        <br /><span className="adjust-bar__sub">{noSaveReason ?? STAGE_SAVE_TEXT.barSub}</span>
        {st.stale && (
          <>
            <br />
            <span className="adjust-bar__warn">{STAGE_SAVE_TEXT.stale}</span>{' '}
            <button type="button" className="adjust-bar__link" onClick={save.reload}><Icon icon={RefreshCw} /> {STAGE_SAVE_TEXT.reload}</button>
          </>
        )}
      </span>
      <button type="button" onClick={() => store.discardAll()} disabled={save.busy}><Icon icon={Undo2} /> {STAGE_SAVE_TEXT.discard}</button>
      <button type="button" onClick={save.saveAs} disabled={save.busy || !target.libraryCueId} title={target.libraryCueId ? '只改這首歌：存成一個新的 cue，這首歌的這個 cue 換成它' : STAGE_SAVE_TEXT.noCue}>
        <Icon icon={CopyPlus} /> {STAGE_SAVE_TEXT.saveAs}
      </button>
      <button type="button" className="adjust-bar__primary" onClick={save.saveBack} disabled={save.busy || !canSaveBack} title={noSaveReason ?? '存回 Cue 庫，用到這個 cue 的歌都會一起變'}>
        <Icon icon={Save} /> {STAGE_SAVE_TEXT.saveBack}
      </button>
    </div>
  );
}
