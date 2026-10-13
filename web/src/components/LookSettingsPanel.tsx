import { DEFAULT_LOOK_SETTINGS, LOOK_SETTING_RANGES, type LookSettings } from '../lib/stageLook/lookSettings';

interface Props {
  settings: LookSettings;
  onChange: (patch: Partial<LookSettings>) => void;
  onClose: () => void;
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

/** 現場模式設定（admin 才看得到；改了全專案共用） */
export default function LookSettingsPanel({ settings, onChange, onClose }: Props) {
  const reset = () => {
    const patch: Partial<LookSettings> = {};
    for (const r of ROWS) patch[r.key] = DEFAULT_LOOK_SETTINGS[r.key];
    onChange(patch);
  };
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
        <strong style={{ flex: 1 }}>🎚 現場設定</strong>
        <button className="btn btn--ghost btn--sm" onClick={reset} title="回到預設值">重設</button>
        <button className="btn btn--ghost btn--sm" onClick={onClose} title="關閉">×</button>
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
      <div style={{ opacity: 0.6, fontSize: 11 }}>改了會自動存，導演 / 動畫師看到的一樣</div>
    </div>
  );
}
