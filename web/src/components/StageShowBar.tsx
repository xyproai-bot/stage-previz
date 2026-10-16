// 全螢幕預演的小條：滑鼠一動或手指一點出現 2.5 秒——播放 / 暫停、時間、歌名、「離開（Esc）」。
// 半透明、貼著畫面下緣，不擋住舞台。怎麼進出、什麼時候出現：lib/useStageFullscreen.ts；規則：lib/stageShow.ts。

import { Minimize, Pause, Play } from 'lucide-react';
import Icon from './Icon';
import { showClockText, showTransportUsable, type StageShowInfo } from '../lib/stageShow';
import './StageShow.css';

interface Props {
  visible: boolean;
  info?: StageShowInfo;
  /** info 沒有歌名時的備用（現在的 cue 名字 / 專案名） */
  fallbackTitle?: string;
  onExit: () => void;
}

export default function StageShowBar({ visible, info, fallbackTitle, onExit }: Props) {
  const transport = info?.transport;
  const usable = showTransportUsable(transport) ? transport : null;
  const title = info?.title || fallbackTitle || '';
  return (
    <div className={'stage-show-bar' + (visible ? ' is-visible' : '')} role="toolbar" aria-label="全螢幕預演" aria-hidden={!visible}>
      {usable && (
        <button
          type="button"
          className="stage-show-bar__btn"
          onClick={usable.onTogglePlay}
          title={usable.playing ? '暫停（空白鍵）' : '播放（空白鍵）'}
          aria-label={usable.playing ? '暫停' : '播放'}
          tabIndex={visible ? 0 : -1}
        >
          <Icon icon={usable.playing ? Pause : Play} size="md" />
        </button>
      )}
      {usable && <span className="stage-show-bar__time">{showClockText(usable.time, usable.duration)}</span>}
      {title && <span className="stage-show-bar__title">{title}</span>}
      <button type="button" className="stage-show-bar__exit" onClick={onExit} tabIndex={visible ? 0 : -1}>
        <Icon icon={Minimize} size="md" /> 離開（Esc）
      </button>
    </div>
  );
}
