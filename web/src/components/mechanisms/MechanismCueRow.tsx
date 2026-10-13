// 機關分頁上面：「這個 cue 的機關位置」的一列（一個機關）
//   名稱 · 方向字 · 現在的值 · 來源（這個 cue 設定 / 沿用「…」/ 預設位置）
//   常用位置（點一下就存）、滑桿（拖的時候 3D 邊拖邊看、放手才存；離常用位置很近會吸過去，按住 Alt 不吸）、
//   數字欄位（Enter 或點別的地方就存）、回到沿用上一個 cue；來不及到位 / 超出行程的提醒
import { useEffect, useRef, useState } from 'react';
import { CornerDownRight, Gauge, Move3d, MoveHorizontal, MoveVertical, RotateCcw, RotateCw, TriangleAlert } from 'lucide-react';
import Icon from '../Icon';
import { directionWord, presetAt, snapToPreset, unitOf, valueDecimals, type Mechanism, type MechVec3 } from '../../lib/mechanisms/model';
import type { Resolved } from '../../lib/mechanisms/track';
import { formatMechValue, formatSeconds, type MechCheck } from '../../lib/mechanisms/motion';
import { formatFieldNumber, parseNumberInput } from '../../lib/numberField';

interface Props {
  mech: Mechanism;
  resolved: Resolved;
  /** 沒選 cue：改的是預設位置 */
  editingDefault: boolean;
  /** cue id → 名稱（「沿用「主歌」」） */
  cueName: (cueId: string) => string;
  check?: MechCheck;
  /** 這個 cue 的「照機器速度」秒數（所有機關最大的） */
  cueFix: number | null;
  front: MechVec3 | null;
  focused: boolean;
  disabled?: boolean;
  onFocus: () => void;
  onCommit: (value: number) => void;
  onPreview: (value: number | null) => void;
  onClear: () => void;
  onFix: (seconds: number) => void;
}

export default function MechanismCueRow({
  mech, resolved, editingDefault, cueName, check, cueFix, front, focused, disabled, onFocus, onCommit, onPreview, onClear, onFix,
}: Props) {
  const unit = unitOf(mech.kind);
  const dec = valueDecimals(mech.kind);
  const value = editingDefault ? mech.defaultValue : resolved.value;
  const [drag, setDrag] = useState<number | null>(null);   // 拖滑桿 / 按方向鍵中的值（還沒存）
  const [draft, setDraft] = useState<string | null>(null); // 數字欄位打到一半
  const [fieldMsg, setFieldMsg] = useState<string | null>(null);
  const altRef = useRef(false);
  const dragRef = useRef<number | null>(null);
  dragRef.current = drag;
  const shown = drag ?? value;
  const active = presetAt(mech.presets, shown);
  const own = !editingDefault && resolved.source === 'own';
  const step = mech.kind === 'rotary' ? 0.5 : 0.01;

  // 拖到一半換 cue / 機關被改 → 放掉預覽
  useEffect(() => { setDrag(null); setDraft(null); }, [mech.id, resolved.fromCueId, editingDefault]);

  const finishDrag = () => {
    const v = dragRef.current;
    if (v === null) return;
    setDrag(null);
    onCommit(v);
  };
  // 滑鼠 / 手指放開（在滑桿外面放開也算）
  useEffect(() => {
    if (drag === null) return;
    const up = () => finishDrag();
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [drag === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const clamp = (v: number) => Math.min(mech.travelMax, Math.max(mech.travelMin, v));
  const setLive = (v: number) => { setDrag(v); onPreview(v); };

  const commitField = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    const n = parseNumberInput(text);
    if (n === null) { setFieldMsg('位置要是數字，已還原'); return; }
    setFieldMsg(null);
    const v = clamp(n);
    if (Math.abs(v - value) < 10 ** -dec / 2) return;
    onCommit(v);
  };

  const source = editingDefault
    ? <span className="mech-row__source">預設位置</span>
    : resolved.source === 'own'
      ? <span className="mech-row__source is-own">這個 cue 設定</span>
      : resolved.source === 'inherited' && resolved.fromCueId
        ? <span className="mech-row__source is-inherited"><Icon icon={CornerDownRight} size="xs" /> 沿用「{cueName(resolved.fromCueId)}」</span>
        : <span className="mech-row__source is-inherited">預設位置</span>;

  const word = directionWord(mech, front);
  const kindIcon = mech.kind === 'rotary' ? RotateCw : word === '上下' ? MoveVertical : word === '左右' ? MoveHorizontal : Move3d;
  const fmt = (v: number) => formatMechValue(v, mech.kind);
  const speed = mech.maxSpeed !== null ? fmt(mech.maxSpeed) : '';

  const warnings: { key: string; text: string; fix?: boolean }[] = [];
  if (check && !editingDefault) {
    if (check.status === 'tooFast' && check.reason === 'gap') {
      warnings.push({ key: 'gap', text: `跟上一個 cue 只隔 ${formatSeconds(check.gap ?? 0)} 秒，機器需要 ${formatSeconds(check.need ?? 0)} 秒：把這個 cue 的影片時間往後挪，或減少行程` });
    } else if (check.status === 'tooFast') {
      warnings.push({
        key: 'fast', fix: true,
        text: `轉場 ${formatSeconds(check.available ?? 0)} 秒太快：這段要${mech.kind === 'rotary' ? '轉' : '走'} ${fmt(check.distance)}（最高 ${speed}/秒），需要 ${formatSeconds(check.need ?? 0)} 秒`,
      });
    } else if (check.lateBy !== null) {
      warnings.push({ key: 'late', text: `上一段還沒走完，會晚 ${formatSeconds(check.lateBy)} 秒到位` });
    }
  }
  if (!editingDefault && resolved.clamped) {
    warnings.push({ key: 'range', text: `存的是 ${fmt(resolved.stored)}，超出行程（${fmt(mech.travelMin)} ~ ${fmt(mech.travelMax)}），播放時停在 ${fmt(resolved.value)}` });
  }

  return (
    <li className={'mech-row' + (focused ? ' is-focused' : '') + (own ? ' is-own' : '')} onFocusCapture={onFocus} onPointerDownCapture={onFocus}>
      <div className="mech-row__head">
        <span className="mech-row__icon" aria-hidden="true"><Icon icon={kindIcon} /></span>
        <span className="mech-row__name" title={mech.consoleLabel ? `控台：${mech.consoleLabel}` : undefined}>{mech.name}</span>
        <span className="mech-row__word">{word}</span>
        <span className="mech-row__value">{fmt(shown)}</span>
        {source}
      </div>

      {mech.presets.length > 0 && (
        <div className="mech-row__presets" role="group" aria-label={`「${mech.name}」的常用位置`}>
          {mech.presets.map(p => (
            <button
              key={p.name}
              type="button"
              className={'mech-chip' + (active?.name === p.name ? ' is-active' : '')}
              aria-pressed={active?.name === p.name}
              disabled={disabled}
              title={`${p.name}：${fmt(p.value)}`}
              onClick={() => onCommit(p.value)}
            >{p.name}</button>
          ))}
        </div>
      )}

      <div className="mech-row__controls">
        <span className="mech-row__bound">{formatFieldNumber(mech.travelMin, dec)}{unit === '°' ? '°' : ' m'}</span>
        <input
          type="range"
          className="mech-row__slider"
          min={mech.travelMin}
          max={mech.travelMax}
          step={step}
          value={shown}
          disabled={disabled}
          aria-label={`「${mech.name}」的位置`}
          onPointerDown={(e) => { altRef.current = e.altKey; }}
          onPointerMove={(e) => { altRef.current = e.altKey; }}
          onChange={(e) => {
            const raw = Number(e.target.value);
            setLive(altRef.current ? raw : snapToPreset(raw, mech));
          }}
          onKeyDown={(e) => {
            const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
            if (!dir) return;
            e.preventDefault();
            setLive(clamp((dragRef.current ?? value) + dir * step * (e.shiftKey ? 10 : 1)));
          }}
          onKeyUp={(e) => { if (e.key.startsWith('Arrow')) finishDrag(); }}
          onBlur={finishDrag}
        />
        <span className="mech-row__bound">{formatFieldNumber(mech.travelMax, dec)}{unit === '°' ? '°' : ' m'}</span>
        <label className="num-field mech-row__field">
          <input
            type="text"
            inputMode="decimal"
            value={draft ?? formatFieldNumber(shown, dec)}
            disabled={disabled}
            aria-label={`「${mech.name}」的位置（${unit}）`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitField}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') { setDraft(null); setFieldMsg(null); }
            }}
          />
          <span className="num-field__unit" aria-hidden="true">{unit}</span>
        </label>
        {!editingDefault && (
          <button
            type="button"
            className="mech-icon-btn"
            onClick={onClear}
            disabled={disabled || !own}
            title="回到沿用上一個 cue"
            aria-label="回到沿用上一個 cue"
          ><Icon icon={RotateCcw} /></button>
        )}
      </div>
      {fieldMsg && <div className="field-error small" role="alert">{fieldMsg}</div>}

      {warnings.map(w => (
        <div key={w.key} className="mech-warn" role="status">
          <Icon icon={TriangleAlert} size="sm" className="mech-warn__icon" />
          <span>{w.text}</span>
          {w.fix && cueFix !== null && (
            <button
              type="button"
              className="btn btn--ghost btn--sm mech-warn__fix"
              disabled={disabled}
              title={`把這個 cue 的轉場改成 ${formatSeconds(cueFix)} 秒；這個 cue 的其他物件也會用 ${formatSeconds(cueFix)} 秒移動`}
              onClick={() => onFix(cueFix)}
            ><Icon icon={Gauge} /> 照機器速度（{formatSeconds(cueFix)} 秒）</button>
          )}
        </div>
      ))}
    </li>
  );
}
