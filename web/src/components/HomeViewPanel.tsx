import { useEffect, useState } from 'react';
import { HOME_FOV_RANGE, type HomeView } from '../lib/homeView';
import { X } from 'lucide-react';
import Icon from './Icon';

interface Props {
  /** 目前 🎥 會回到的畫面（自訂的，或自動算的正面全景） */
  view: HomeView;
  isCustom: boolean;
  /** 場景單位 → 公尺（測距校準倍率） */
  scale: number;
  onCaptureCurrent: () => void;
  onChange: (view: HomeView) => void;
  onUseAuto: () => void;
  onClose: () => void;
}

/** 數字欄：打字時先留著自己的文字（打到一半的 "-"、"1." 不會被改掉），是合法數字才送出 */
function NumField({ value, onCommit, step, title }: { value: number; onCommit: (n: number) => void; step: number; title: string }) {
  const [text, setText] = useState(value.toFixed(2));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(value.toFixed(2)); }, [value, editing]);
  return (
    <input
      type="number"
      step={step}
      value={text}
      title={title}
      onFocus={() => setEditing(true)}
      onBlur={() => { setEditing(false); setText(value.toFixed(2)); }}
      onChange={e => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) onCommit(n);
      }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="home-view-num"
    />
  );
}

const AXES = ['X', 'Y', 'Z'] as const;

/** 🎥 重置視角設定（只有 admin 看得到；所有人按 🎥 都會回到這裡） */
export default function HomeViewPanel({ view, isCustom, scale, onCaptureCurrent, onChange, onUseAuto, onClose }: Props) {
  const toM = (n: number) => n * scale;
  const fromM = (n: number) => n / scale;
  const setVec = (which: 'position' | 'target', axis: number, meters: number) => {
    const v = [...view[which]] as [number, number, number];
    v[axis] = fromM(meters);
    onChange({ ...view, [which]: v });
  };
  const row = (label: string, which: 'position' | 'target', hint: string) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ marginBottom: 3 }}>{label} <span className="muted small">（公尺）</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {AXES.map((ax, i) => (
          <label key={ax} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span className="muted small">{ax}</span>
            <NumField value={toM(view[which][i])} step={0.1} title={`${hint} ${ax}`} onCommit={n => setVec(which, i, n)} />
          </label>
        ))}
      </div>
    </div>
  );
  return (
    <div className="bm-popover" onClick={e => e.stopPropagation()} data-ui-element>
      <div className="bm-popover__head">
        <span>重置攝影機的畫面</span>
        <button className="dlg__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
      </div>
      <div style={{ padding: '8px 10px' }}>
        <div className="muted small" style={{ marginBottom: 8 }}>
          所有人按「重置攝影機」都會回到這個畫面 · 目前：{isCustom ? '自訂' : '自動（正面全景）'}
        </div>
        <button className="btn btn--primary btn--sm" style={{ width: '100%', marginBottom: 10 }} onClick={onCaptureCurrent}>
          用現在的畫面
        </button>
        {row('攝影機位置', 'position', '攝影機位置')}
        {row('看向', 'target', '看向的點')}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span>鏡頭視角</span>
          <span className="muted small">（度，越小越像長鏡頭）</span>
          <span style={{ flex: 1 }} />
          <span style={{ width: 70 }}>
            <NumField
              value={view.fov}
              step={1}
              title="上下的視角（度）"
              onCommit={n => onChange({ ...view, fov: Math.min(HOME_FOV_RANGE[1], Math.max(HOME_FOV_RANGE[0], n)) })}
            />
          </span>
        </label>
        {isCustom && (
          <button className="btn btn--ghost btn--sm" style={{ width: '100%' }} onClick={onUseAuto}>
            回到自動（正面全景）
          </button>
        )}
      </div>
    </div>
  );
}
