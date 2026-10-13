import { useState } from 'react';
import { MATERIAL_RANGES, type MaterialOverride, type MaterialOverrides, type ModelMaterialInfo } from '../lib/stageLook/materialOverrides';

interface Props {
  materials: ModelMaterialInfo[];
  overrides: MaterialOverrides;
  onChange: (name: string, patch: Partial<MaterialOverride> | null) => void;
  onClose: () => void;
}

type NumKey = 'roughness' | 'metalness' | 'envIntensity' | 'opacity';

const SLIDERS: { key: NumKey; label: string; hint: string; origKey: NumKey }[] = [
  { key: 'roughness', label: '亮面 ↔ 霧面', hint: '左邊亮面（會反光、倒影清楚），右邊霧面', origKey: 'roughness' },
  { key: 'metalness', label: '金屬感', hint: '越高越像金屬（顏色會變成反光的顏色）', origKey: 'metalness' },
  { key: 'envIntensity', label: '反射強度', hint: '反射 LED 光的強弱', origKey: 'envIntensity' },
  { key: 'opacity', label: '不透明度', hint: '1 = 完全不透明', origKey: 'opacity' },
];

/** 依 C4D 材質名稱調整舞台材質（admin 才看得到；改了全專案共用） */
export default function MaterialPanel({ materials, overrides, onChange, onClose }: Props) {
  const [openName, setOpenName] = useState<string | null>(null);
  const sorted = [...materials].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return (
    <div
      data-ui-element
      style={{
        position: 'absolute', top: 64, right: 12, zIndex: 45, width: 300, maxHeight: '70%', overflowY: 'auto',
        background: 'rgba(20, 20, 24, 0.94)', backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: 12,
        color: '#eee', fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>🎨 材質（依 C4D 材質名稱）</strong>
        <button className="btn btn--ghost btn--sm" onClick={onClose} title="關閉">×</button>
      </div>
      {sorted.length === 0 && <div style={{ opacity: 0.6 }}>模型裡沒有可調整的材質</div>}
      {sorted.map(mat => {
        const ov = overrides[mat.name] || {};
        const changed = Object.keys(ov).length > 0;
        const open = openName === mat.name;
        const color = ov.color || '#' + mat.original.color;
        return (
          <div key={mat.name} style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '6px 0' }}>
            <button
              onClick={() => setOpenName(open ? null : mat.name)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none',
                border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textAlign: 'left',
              }}
            >
              <span style={{ width: 14, height: 14, borderRadius: 3, background: color, border: '1px solid rgba(255,255,255,0.3)' }} />
              <span style={{ flex: 1 }}>
                {mat.name || '（沒有名稱）'}
                {ov.mirrorFloor && ' 🪞'}
                {changed && <span style={{ color: '#10c78a' }}> ●</span>}
              </span>
              <span style={{ opacity: 0.5 }}>{mat.count} 個物件 {open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <div style={{ padding: '8px 0 4px 22px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ flex: 1 }}>顏色</span>
                  <input type="color" value={color} onChange={e => onChange(mat.name, { color: e.target.value })} />
                </label>
                {SLIDERS.map(s => {
                  const [min, max] = MATERIAL_RANGES[s.key];
                  const value = ov[s.key] ?? mat.original[s.origKey];
                  return (
                    <label key={s.key} style={{ display: 'block', marginBottom: 8 }} title={s.hint}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{s.label}</span>
                        <span style={{ opacity: 0.7 }}>{value.toFixed(2)}</span>
                      </div>
                      <input
                        type="range" min={min} max={max} step={0.01} value={value}
                        onChange={e => onChange(mat.name, { [s.key]: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </label>
                  );
                })}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
                  title="勾了之後，地板倒影只會出現在勾選的材質上（都沒勾 = 系統自動找最大的地面）">
                  <input type="checkbox" checked={!!ov.mirrorFloor} onChange={e => onChange(mat.name, { mirrorFloor: e.target.checked })} />
                  <span>鏡面地板（會映出倒影）</span>
                </label>
                {changed && (
                  <button className="btn btn--ghost btn--sm" onClick={() => onChange(mat.name, null)}>回到 C4D 原本</button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ opacity: 0.6, fontSize: 11, marginTop: 8 }}>改了會自動存（這台電腦也會留一份），導演 / 動畫師看到的一樣</div>
    </div>
  );
}
