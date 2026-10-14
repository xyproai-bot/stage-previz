// 導演頁歌曲頁的決定列：現在的狀態、決定的是哪一版、「通過 V2」「需修改 V2」。
// 導演和製作永遠看得到（放在版本列正上方）；還沒送審也可以直接決定，沒有影片時按不下去。
// 規則在 lib/songReview.ts decisionBarState（跟後台 access.mjs songStatusDecision 一樣）。

import { Check, PenLine } from 'lucide-react';
import Icon, { StatusDot } from './Icon';
import HelpLink from './HelpLink';
import { HELP_ANCHORS } from '../lib/helpLinks';
import { SONG_STATUS_LABEL, type DecisionBarState, type SongStatus } from '../lib/songReview';
import { useViewAs } from '../lib/viewAsContext';
import './DecisionBar.css';

interface Props {
  status: SongStatus;
  state: DecisionBarState;
  /** 決定的是哪一版（'V2'；沒有影片 = null） */
  judgedLabel: string | null;
  onDecide: (to: SongStatus) => void;
}

export default function DecisionBar({ status, state, judgedLabel, onDecide }: Props) {
  const va = useViewAs();
  return (
    <div className="decision-bar" role="group" aria-label="決定這首歌">
      <span className="decision-bar__status">
        <StatusDot status={status} />
        <span>{SONG_STATUS_LABEL[status]}</span>
      </span>
      <span className={'decision-bar__ver' + (judgedLabel ? '' : ' is-empty')}>
        {judgedLabel ? <>決定的是 <strong>{judgedLabel}</strong></> : '還沒有影片'}
      </span>
      {state.hint && <span className="decision-bar__hint">{state.hint}</span>}
      <span className="decision-bar__grow" />
      {state.buttons.length > 0 && (
        <span className="decision-bar__btns">
          {state.buttons.map(b => {
            const approve = b.to === 'approved';
            const props = b.disabledReason
              ? { disabled: true, title: b.disabledReason }
              : va.ro(`${b.label}${judgedLabel ? `（記在 ${judgedLabel}）` : ''}`);
            return (
              <button
                key={b.kind}
                type="button"
                className={'btn btn--sm decision-bar__btn ' + (approve ? 'btn--primary' : 'decision-bar__btn--changes')}
                onClick={() => onDecide(b.to)}
                {...props}
              >
                <Icon icon={approve ? Check : PenLine} />
                {b.text}
              </button>
            );
          })}
        </span>
      )}
      <HelpLink anchor={HELP_ANCHORS.dirDecide} />
    </div>
  );
}
