// 機關分頁上面：「這個 cue 的機關位置」的一列（一個機關）
//   名稱 · 方向字 · 現在的值 · 來源（這個 cue 設定 / 沿用「…」/ 預設位置）
//   常用位置（點一下就存）、滑桿（拖的時候 3D 邊拖邊看、放手才存；離常用位置很近會吸過去，按住 Alt 不吸）、
//   數字欄位（Enter 或點別的地方就存）、回到沿用上一個 cue；超出行程的提醒、被下一個 cue 接手的說明（灰色）
//   v2：這個 cue 自己設的「延遲 N 秒、走 N 秒」（空白 = 跟著 cue；只有這個 cue 自己設了位置才有）
import { useEffect, useRef, useState } from 'react';
import { CornerDownRight, Info, Move3d, MoveHorizontal, MoveVertical, RotateCcw, RotateCw, Spline, TimerReset, TriangleAlert } from 'lucide-react';
import Icon from '../Icon';
import { directionWord, parseTimingSeconds, presetAt, snapToPreset, unitOf, valueDecimals, type Mechanism, type MechanismTiming, type MechVec3 } from '../../lib/mechanisms/model';
import { sheetTime } from '../../lib/mechanisms/cueSheet';
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
  front: MechVec3 | null;
  focused: boolean;
  disabled?: boolean;
  onFocus: () => void;
  onCommit: (value: number) => void;
  onPreview: (value: number | null) => void;
  onClear: () => void;
  /** v2：這個 cue 自己設的時間（沒設 = null）；showTiming = 這個 cue 自己設了位置、不是第一個 cue */
  timing?: MechanismTiming | null;
  showTiming?: boolean;
  /** 跟著 cue 時走幾秒（欄位空白時的提示） */
  cueSpan?: number | null;
  /** 「Cue 4「間奏」」（被接手的提醒） */
  cueLabel?: (cueId: string) => string;
  onTiming?: (patch: { delaySec?: number | null; durationSec?: number | null }) => void;
}

export default function MechanismCueRow({
  mech, resolved, editingDefault, cueName, check, front, focused, disabled, onFocus, onCommit, onPreview, onClear,
  timing = null, showTiming = false, cueSpan = null, cueLabel = (id) => cueName(id), onTiming,
}: Props) {
  const unit = unitOf(mech.kind);
  const dec = valueDecimals(mech.kind);
  const value = editingDefault ? mech.defaultValue : resolved.value;
  const [drag, setDrag] = useState<number | null>(null);   // 拖滑桿 / 按方向鍵中的值（還沒存）
  const [draft, setDraft] = useState<string | null>(null); // 數字欄位打到一半
  const [fieldMsg, setFieldMsg] = useState<string | null>(null);
  const [delayDraft, setDelayDraft] = useState<string | null>(null);
  const [durDraft, setDurDraft] = useState<string | null>(null);
  const altRef = useRef(false);
  const dragRef = useRef<number | null>(null);
  dragRef.current = drag;
  const shown = drag ?? value;
  const active = presetAt(mech.presets, shown);
  const own = !editingDefault && resolved.source === 'own';
  const step = mech.kind === 'rotary' ? 0.5 : 0.01;

  // 拖到一半換 cue / 機關被改 → 放掉預覽
  useEffect(() => { setDrag(null); setDraft(null); setDelayDraft(null); setDurDraft(null); }, [mech.id, resolved.fromCueId, editingDefault]);

  // 延遲 / 走幾秒：空白 = 跟著 cue；Enter 或點別的地方就存
  const commitTimingField = (which: 'delaySec' | 'durationSec', text: string | null) => {
    if (text === null) return;
    if (which === 'delaySec') setDelayDraft(null); else setDurDraft(null);
    const r = parseTimingSeconds(text);
    if (!r.ok) { setFieldMsg('秒數要是 0 到 3600，已還原'); return; }
    setFieldMsg(null);
    const cur = timing?.[which] ?? null;
    if (r.value === cur) return;
    onTiming?.({ [which]: r.value });
  };

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
  const kindIcon = mech.kind === 'rotary' ? RotateCw : mech.variant === 'arc' ? Spline : word === '上下' ? MoveVertical : word === '左右' ? MoveHorizontal : Move3d;
  const fmt = (v: number) => formatMechValue(v, mech.kind);
  // 提醒（橘色）：存的位置超出行程。說明（灰色）：被下一個 cue 接手，預覽時機關在這裡停下來
  const warnings: { key: string; text: string }[] = [];
  const notes: { key: string; text: string }[] = [];
  if (check?.cut && !editingDefault) {
    const who = `${cueLabel(check.cut.byCueId)} ${sheetTime(check.cut.at)}`;
    notes.push({
      key: 'cut',
      text: check.cut.started
        ? `還沒走完，${who} 就接手了：預覽時只走到 ${fmt(check.cut.reached)}`
        : `還沒開始動，${who} 就接手了：預覽時這一段不會動`,
    });
  }
  if (!editingDefault && resolved.clamped) {
    warnings.push({ key: 'range', text: `存的是 ${fmt(resolved.stored)}，超出行程（${fmt(mech.travelMin)} ~ ${fmt(mech.travelMax)}），播放時停在 ${fmt(resolved.value)}` });
  }

  return (
    <li className={'mech-row' + (focused ? ' is-focused' : '') + (own ? ' is-own' : '')} onFocusCapture={onFocus} onPointerDownCapture={onFocus}>
      <div className="mech-row__head">
        <span className="mech-row__icon" aria-hidden="true"><Icon icon={kindIcon} /></span>
        <span className="mech-row__name" title={mech.consoleLabel ? `控台：${mech.consoleLabel}` : undefined}>{mech.name}</span>
        <span className="mech-row__word">{word}{mech.variant === 'split' ? ' · 對開' : ''}</span>
        <span className="mech-row__value">{fmt(shown)}</span>
        {source}
      </div>

      {mech.variant === 'split' && (
        <div className="mech-row__split" role="note">
          {mech.kind === 'linear' ? `每邊 ${fmt(shown)}（中間開 ${fmt(shown * 2)}）` : `每邊轉 ${fmt(shown)}（A 邊、B 邊往相反的方向轉）`}
        </div>
      )}

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

      {showTiming && !editingDefault && (
        <div className="mech-row__timing">
          <label className="mech-row__tfield">
            <span className="mech-row__tlabel">延遲</span>
            <span className="num-field">
              <input
                type="text"
                inputMode="decimal"
                value={delayDraft ?? (timing?.delaySec != null ? formatSeconds(timing.delaySec) : '')}
                placeholder="0"
                disabled={disabled}
                aria-label={`「${mech.name}」延遲幾秒開始動`}
                onChange={(e) => setDelayDraft(e.target.value)}
                onBlur={() => commitTimingField('delaySec', delayDraft)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') setDelayDraft(null); }}
              />
              <span className="num-field__unit" aria-hidden="true">秒</span>
            </span>
          </label>
          <label className="mech-row__tfield">
            <span className="mech-row__tlabel">走</span>
            <span className="num-field">
              <input
                type="text"
                inputMode="decimal"
                value={durDraft ?? (timing?.durationSec != null ? formatSeconds(timing.durationSec) : '')}
                placeholder={cueSpan !== null ? formatSeconds(cueSpan) : ''}
                disabled={disabled}
                aria-label={`「${mech.name}」走幾秒`}
                onChange={(e) => setDurDraft(e.target.value)}
                onBlur={() => commitTimingField('durationSec', durDraft)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') setDurDraft(null); }}
              />
              <span className="num-field__unit" aria-hidden="true">秒</span>
            </span>
          </label>
          <button
            type="button"
            className="mech-icon-btn"
            disabled={disabled || (timing?.delaySec == null && timing?.durationSec == null)}
            onClick={() => onTiming?.({ delaySec: null, durationSec: null })}
            title="延遲和走幾秒改回跟著 cue"
            aria-label="延遲和走幾秒改回跟著 cue"
          ><Icon icon={TimerReset} /></button>
          {check && check.available !== null && (
            <small className="muted mech-row__tsum">
              {check.startAt !== null
                ? `${sheetTime(check.startAt)} 開始動，${sheetTime(check.startAt + check.available)} 到位`
                : `GO 後 ${formatSeconds(check.delay)} 秒開始動，走 ${formatSeconds(check.available)} 秒`}
              {!check.explicitDuration && '（走幾秒跟著轉場）'}
            </small>
          )}
        </div>
      )}

      {warnings.map(w => (
        <div key={w.key} className="mech-warn" role="status">
          <Icon icon={TriangleAlert} size="sm" className="mech-warn__icon" />
          <span>{w.text}</span>
        </div>
      ))}
      {notes.map(n => (
        <div key={n.key} className="mech-note" role="status">
          <Icon icon={Info} size="sm" className="mech-note__icon" />
          <span>{n.text}</span>
        </div>
      ))}
    </li>
  );
}
