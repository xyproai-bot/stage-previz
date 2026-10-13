import { useState } from 'react';
import type { StageObject } from '../lib/api';
import { ChevronDown, ChevronRight, Cog, MoveHorizontal, MoveVertical, RotateCcw } from 'lucide-react';
import Icon from './Icon';

interface Props {
  stageObjects: StageObject[];
  offsets: Record<string, { x: number; y: number }>;
  onChange: (objectId: string, axis: 'x' | 'y', value: number) => void;
  onResetAll: () => void;
  /** 滑桿範圍 ±N 公尺，預設 10 */
  range?: number;
}

/**
 * 機關面板：給每片 LED panel 兩個滑桿（X / Y，公尺），即時加總到位置上。
 * 不寫回 cue 資料，純運行階段視覺 offset。
 * 放在管理頁左欄歌曲清單的下面（跟著欄位排，不再浮在畫面上蓋住歌曲清單）；
 * 最高 40% 視窗高，滑桿多就在面板裡捲動，也可以按標題收起來。
 */
export default function MechanismPanel({ stageObjects, offsets, onChange, onResetAll, range = 10 }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const leds = stageObjects.filter(o => o.category === 'led_panel').sort((a, b) => a.order - b.order);
  if (leds.length === 0) return null;

  const step = 0.05;
  const min = -range;
  const max = range;

  const fmt = (v: number) => `${v >= 0 ? ' ' : ''}${v.toFixed(2)} m`;

  return (
    <div
      data-ui-element
      style={{
        flexShrink: 0,
        margin: '0 12px 12px',
        background: 'rgba(20, 20, 24, 0.85)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        padding: collapsed ? '8px 10px' : '10px 12px',
        color: '#eee',
        fontSize: 12,
        maxHeight: '40vh',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: collapsed ? 0 : 8 }}>
        <button
          onClick={() => setCollapsed(c => !c)}
          style={{
            background: 'transparent', border: 'none', color: '#eee', cursor: 'pointer',
            fontSize: 13, fontWeight: 600, padding: 0,
          }}
          title={collapsed ? '展開機關面板' : '收起機關面板'}
        >
          <Icon icon={Cog} /> 機關 <Icon icon={collapsed ? ChevronRight : ChevronDown} />
        </button>
        {!collapsed && (
          <button
            onClick={onResetAll}
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#ccc', cursor: 'pointer',
              borderRadius: 6, padding: '3px 8px', fontSize: 11,
            }}
            title="所有 LED 的 X/Y offset 都歸零"
          >
            全部重置
          </button>
        )}
      </div>

      {!collapsed && leds.map(led => {
        const off = offsets[led.id] || { x: 0, y: 0 };
        return (
          <div key={led.id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{
              fontSize: 11, opacity: 0.7, marginBottom: 4,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {led.displayName || led.meshName}
            </div>

            {(['x', 'y'] as const).map(axis => {
              const val = off[axis];
              const isZero = Math.abs(val) < 0.001;
              return (
                <div key={axis} style={{ marginBottom: 4 }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 11, marginBottom: 2,
                  }}>
                    <span style={{ opacity: 0.8 }} title={axis === 'x' ? '左右' : '上下'}>
                      <Icon icon={axis === 'x' ? MoveHorizontal : MoveVertical} label={axis === 'x' ? '左右' : '上下'} />
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'monospace', minWidth: 60, textAlign: 'right' }}>
                        {fmt(val)}
                      </span>
                      <button
                        onClick={() => onChange(led.id, axis, 0)}
                        disabled={isZero}
                        style={{
                          background: 'transparent', border: 'none',
                          color: isZero ? '#444' : '#888', cursor: isZero ? 'default' : 'pointer',
                          padding: 0, fontSize: 11, width: 16,
                        }}
                        title="這個軸歸零"
                        aria-label="這個軸歸零"
                      ><Icon icon={RotateCcw} size="xs" /></button>
                    </span>
                  </div>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={val}
                    onChange={e => onChange(led.id, axis, parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: '#888' }}
                  />
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: 9, opacity: 0.4, fontFamily: 'monospace',
                  }}>
                    <span>{min}m</span>
                    <span>{max}m</span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
