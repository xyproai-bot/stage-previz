import { LayoutPanelLeft, TriangleAlert } from 'lucide-react';
import Icon from './Icon';
import type { LedTemplateChipInfo, LiveSizeHint } from '../lib/ledLiveTemplate';
import './LedTemplateChip.css';

interface ChipProps {
  chip: LedTemplateChipInfo;
  /** 有給才有「暫時用整張畫布看」（AE 即時 / 本地檔案；只有這個畫面，不存） */
  onToggleFullView?: () => void;
}

/** 「LED 版型：版型 1（1920×1080）」＋（AE 即時 / 本地檔案才有）「暫時用整張畫布看」 */
export default function LedTemplateChip({ chip, onToggleFullView }: ChipProps) {
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
