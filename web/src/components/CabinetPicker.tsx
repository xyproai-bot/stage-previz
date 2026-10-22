import { useState } from 'react';
import NumField from './NumField';
import { CABINET_RANGE, DEFAULT_CABINET, type Cabinet } from '../lib/ledCabinet';

/**
 * LED 箱體大小（測試圖網格一格）：常用的 128×128 / 256×128 / 128×256 直接選，其他的自己填寬 × 高（像素）。
 * inheritLabel 有給 = 多一個「跟版型」選項（value = null）；沒給 = null 就是預設 128×128（版型層級用）。
 */
interface Props {
  value: Cabinet | null;
  onChange: (c: Cabinet | null) => void;
  label: string;
  inheritLabel?: string;
  /** 選到好幾塊、大小不一樣的時候：下拉顯示這個提示字 */
  mixed?: boolean;
}

const PRESETS: Cabinet[] = [{ w: 128, h: 128 }, { w: 256, h: 128 }, { w: 128, h: 256 }];
const keyOf = (c: Cabinet) => `${c.w}x${c.h}`;

export default function CabinetPicker({ value, onChange, label, inheritLabel, mixed }: Props) {
  const [custom, setCustom] = useState(false);
  const shown = value ?? (inheritLabel ? null : DEFAULT_CABINET);
  const isPreset = shown ? PRESETS.some(p => keyOf(p) === keyOf(shown)) : false;
  const selectValue = mixed ? 'mixed' : custom || (shown && !isPreset) ? 'custom' : shown ? keyOf(shown) : 'inherit';
  const edit = shown ?? DEFAULT_CABINET;
  const [lo, hi] = CABINET_RANGE;

  const onSelect = (v: string) => {
    if (v === 'mixed') return;
    if (v === 'inherit') { setCustom(false); onChange(null); return; }
    if (v === 'custom') { setCustom(true); onChange({ ...edit }); return; }
    setCustom(false);
    const p = PRESETS.find(x => keyOf(x) === v);
    if (!p) return;
    // 版型層級：選 128×128 = 回到預設（存 null，跟沒設一樣）
    onChange(!inheritLabel && keyOf(p) === keyOf(DEFAULT_CABINET) ? null : { ...p });
  };

  return (
    <span className="ledtpl-pair" role="group" aria-label={label}>
      <select value={selectValue} onChange={(e) => onSelect(e.target.value)} title="測試圖的網格一格 = 一片 LED 箱體。預設 128×128 像素（0.5m × 0.5m），所有箱體的邊都會落在格線上">
        {mixed && <option value="mixed">各不相同</option>}
        {inheritLabel && <option value="inherit">{inheritLabel}</option>}
        <option value="128x128">128 × 128{inheritLabel ? '' : '（預設）'}</option>
        <option value="256x128">256 × 128（1m × 0.5m）</option>
        <option value="128x256">128 × 256（0.5m × 1m）</option>
        <option value="custom">自訂…</option>
      </select>
      {selectValue === 'custom' && (
        <>
          <NumField value={edit.w} min={lo} max={hi} label={`${label} 寬（像素）`} onChange={(n) => onChange({ w: n, h: edit.h })} />
          <span>×</span>
          <NumField value={edit.h} min={lo} max={hi} label={`${label} 高（像素）`} onChange={(n) => onChange({ w: edit.w, h: n })} />
        </>
      )}
    </span>
  );
}
