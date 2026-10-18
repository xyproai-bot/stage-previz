import { LayoutPanelLeft, TriangleAlert } from 'lucide-react';
import Icon from './Icon';
import type { LedTemplateChipInfo, LiveSizeHint } from '../lib/ledLiveTemplate';
import './LedTemplateChip.css';

interface ChipProps {
  chip: LedTemplateChipInfo;
  /** 有給才有「暫時用整張畫布看」（AE 即時 / 本地檔案；只有這個畫面，不存） */
  onToggleFullView?: () => void;
  /**
   * 有給才有「看哪一段」（中途換版型，而且這個畫面沒有播放時間：AE 即時、本地圖片）：
   * null = 跟著選到的 Cue 的影片時間；數字 = 自己選第幾段（從 0 起算）
   */
  onPickSegment?: (index: number | null) => void;
}

/** 「LED 版型：版型 1（1920×1080）」＋（AE 即時 / 本地檔案才有）「暫時用整張畫布看」 */
export default function LedTemplateChip({ chip, onToggleFullView, onPickSegment }: ChipProps) {
  return (
    <span className="tpl-chip">
      <span className={'tpl-chip__tag' + (chip.fullView ? ' is-temp' : '')} title={chip.title}>
        <Icon icon={LayoutPanelLeft} size="xs" /> {chip.text}
      </span>
      {chip.canToggle && onToggleFullView && (
        <button
          type="button"
          className={'tpl-chip__toggle' + (chip.fullView ? ' is-on' : '')}
          aria-pressed={chip.fullView}
          title={chip.fullView ? '回到這首歌選的版型' : '暫時把畫面當成整張畫布放到 LED 上看（只有這個畫面，不會存）'}
          onClick={onToggleFullView}
        >
          暫時用整張畫布看
        </button>
      )}
      {chip.timeline && !chip.timeline.clocked && onPickSegment && !chip.fullView && (
        <label className="tpl-chip__seg" title="AE 即時、本地圖片沒有播放時間：預設跟著選到的 Cue 的影片時間決定是哪一段，也可以自己選要看哪一段（只有這個畫面，不會存）">
          <span>看哪一段</span>
          <select
            value={chip.timeline.picked ?? ''}
            onChange={(e) => onPickSegment(e.target.value === '' ? null : Number(e.target.value))}
            aria-label="看版型時間線的哪一段"
          >
            <option value="">跟著選到的 Cue</option>
            {chip.timeline.segments.map(sg => <option key={sg.index} value={sg.index}>{sg.text}</option>)}
          </select>
        </label>
      )}
    </span>
  );
}

/** 畫面大小跟版型對不上時的一句溫和提示 */
export function LedTemplateHint({ hint }: { hint: LiveSizeHint | null }) {
  if (!hint) return null;
  return (
    <div className={'tpl-hint tpl-hint--' + hint.level} role="status">
      <Icon icon={TriangleAlert} size="sm" />
      <span>{hint.text}</span>
    </div>
  );
}
