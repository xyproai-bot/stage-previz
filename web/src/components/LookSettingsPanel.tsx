import { LOOK_SETTING_RANGES, type LookSettings } from '../lib/stageLook/lookSettings';
import { Check, X } from 'lucide-react';
import Icon from './Icon';

interface Props {
  settings: LookSettings;
  onChange: (patch: Partial<LookSettings>) => void;
  onClose: () => void;
  /** 跟專案預設不一樣嗎 */
  customized: boolean;
  /** 清掉自己的調整，回到專案預設 */
  onReset: () => void;
  /** admin 才有：把目前的設定變成所有人的預設 */
  onSaveAsDefault?: () => void;
}

const ROWS: { key: keyof LookSettings; label: string; hint: string; step: number }[] = [
  { key: 'houseLight', label: '現場底光', hint: '舞台結構看得多清楚（0 = 只有 LED）', step: 0.01 },
  { key: 'exposure', label: '曝光', hint: '整體亮暗，像相機', step: 0.05 },
  { key: 'ledLightStrength', label: 'LED 照明', hint: 'LED 照到舞台的強度', step: 0.05 },
  { key: 'bloomStrength', label: '光暈', hint: '亮的 LED 周圍暈開多少', step: 0.05 },
  { key: 'ledViewFalloff', label: 'LED 側看變暗', hint: '從側邊看 LED 會暗多少（真的 LED 牆側看會變暗）', step: 0.05 },
  { key: 'floorReflection', label: '地板倒影', hint: '亮面地板映出 LED 的強度（0 = 關）', step: 0.05 },
  { key: 'reflectionSharpness', label: '倒影清晰度', hint: '倒影清楚還是模糊', step: 0.05 },
];

/** 現場模式設定：每個人自己調、存在自己電腦；admin 可以把自己的設定變成所有人的預設 */
export default function LookSettingsPanel({ settings, onChange, onClose, customized, onReset, onSaveAsDefault }: Props) {
  return (
    <div
      data-ui-element
      style={{
        position: 'absolute', top: 64, right: 12, zIndex: 45, width: 260,
        background: 'rgba(20, 20, 24, 0.92)', backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: 12,
        color: '#eee', fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>現場設定</strong>
        <button className="btn btn--ghost btn--sm" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} /></button>
      </div>
      {ROWS.map(r => {
        const [min, max] = LOOK_SETTING_RANGES[r.key];
        return (
          <label key={r.key} style={{ display: 'block', marginBottom: 10 }} title={r.hint}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{r.label}</span>
              <span style={{ opacity: 0.7 }}>{settings[r.key].toFixed(2)}</span>
            </div>
            <input
              type="range" min={min} max={max} step={r.step}
              value={settings[r.key]}
              onChange={e => onChange({ [r.key]: parseFloat(e.target.value) })}
              style={{ width: '100%' }}
            />
          </label>
        );
      })}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        <button
          className="btn btn--ghost btn--sm"
          onClick={onReset}
          disabled={!customized}
          title="清掉你自己的調整，回到專案預設"
        >
          {customized ? '回到專案預設' : '目前就是專案預設'}
        </button>
        {onSaveAsDefault && (
          <button
            className="btn btn--sm"
            onClick={onSaveAsDefault}
            disabled={!customized}
            title="把你現在的設定變成所有人打開時的預設（每個人還是可以自己再調）"
          >
            {customized ? '設為所有人的預設' : <><Icon icon={Check} /> 所有人的預設就是這組</>}
          </button>
        )}
      </div>
      <div style={{ opacity: 0.6, fontSize: 11 }}>你調的只存在這台電腦，重新整理也會留著；不會影響別人</div>
    </div>
  );
}
