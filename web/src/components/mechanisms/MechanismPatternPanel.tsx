// 「套用花樣」：一排機關在這個 cue 一次設好位置和延遲（一起 / 依序 / 波浪 / 漸層）。
// 展開在這一排的標題底下（不是跳出視窗 → 3D 畫面照樣能轉）；改數字的時候 3D 畫面邊改邊看（還沒存），
// 下面一列一列寫著每個機關的位置和延遲，按「套用到這個 cue」才存；存的是一列一列普通的 cue 位置，之後每一個都還能單獨改。
import { useEffect, useMemo, useState } from 'react';
import { TriangleAlert, Waves } from 'lucide-react';
import Icon from '../Icon';
import { unitOf, valueDecimals, type Mechanism, type MechanismGroup } from '../../lib/mechanisms/model';
import {
  PATTERN_KINDS, SEQUENCE_ORDERS, applyPattern, defaultPattern, validatePattern,
  type PatternKind, type PatternParams, type SequenceOrder,
} from '../../lib/mechanisms/patterns';
import { formatMechValue, formatSeconds } from '../../lib/mechanisms/motion';
import type { EditorMechanisms } from '../../lib/mechanisms/useMechanisms';
import { toast } from '../../lib/toast';
import { formatFieldNumber, parseNumberInput } from '../../lib/numberField';

interface Props {
  group: MechanismGroup;
  /** 這一排的成員（照順序） */
  members: Mechanism[];
  mech: EditorMechanisms;
  cueId: string;
  /** 「Cue 3「間奏」」 */
  cueLabel: string;
  /** 這個 cue 前面沒有 cue：機關直接站在這個位置，不會走過來 → 不設延遲 */
  isFirstCue: boolean;
  disabled?: boolean;
  onClose: () => void;
}

type Fields = Record<'value' | 'delay' | 'interval' | 'center' | 'amplitude' | 'period' | 'phaseDeg' | 'from' | 'to', string>;

const toFields = (p: PatternParams, dec: number): Fields => ({
  value: formatFieldNumber(p.value, dec), delay: formatFieldNumber(p.delay, 3), interval: formatFieldNumber(p.interval, 3),
  center: formatFieldNumber(p.center, dec), amplitude: formatFieldNumber(p.amplitude, dec), period: formatFieldNumber(p.period, 2),
  phaseDeg: formatFieldNumber(p.phaseDeg, 1), from: formatFieldNumber(p.from, dec), to: formatFieldNumber(p.to, dec),
});

export default function MechanismPatternPanel({ group, members, mech, cueId, cueLabel, isFirstCue, disabled, onClose }: Props) {
  const kind = members[0]?.kind ?? 'linear';
  const unit = unitOf(kind);
  const dec = valueDecimals(kind);
  const [pattern, setPattern] = useState<PatternKind>('together');
  const [order, setOrder] = useState<SequenceOrder>('forward');
  const [fields, setFields] = useState<Fields>(() => toFields(defaultPattern(members), dec));
  const [saving, setSaving] = useState(false);

  const params = useMemo<PatternParams>(() => {
    const f = (s: string) => parseNumberInput(s) ?? NaN;
    return {
      kind: pattern, order, value: f(fields.value), delay: f(fields.delay), interval: f(fields.interval), center: f(fields.center),
      amplitude: f(fields.amplitude), period: f(fields.period), phaseDeg: f(fields.phaseDeg), from: f(fields.from), to: f(fields.to),
    };
  }, [pattern, order, fields]);
  const membersKey = members.map(m => `${m.id}:${m.travelMin}:${m.travelMax}`).join('|');
  const error = validatePattern(params, members.length);
  const result = useMemo(
    () => (error ? null : applyPattern(members.map(m => ({ id: m.id, travelMin: m.travelMin, travelMax: m.travelMax })), params)),
    [membersKey, params, error], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // 3D 畫面邊改邊看（還沒存）；關掉就放掉預覽
  useEffect(() => {
    if (!result) return;
    mech.previewValues(Object.fromEntries(result.items.map(i => [i.mechanismId, i.value])));
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { mech.previewValues(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => setFields(f => ({ ...f, [k]: e.target.value }));
  const num = (k: keyof Fields, label: string, suffix: string, aria = label) => (
    <label className="num-field">
      <span className="num-field__axis">{label}</span>
      <input type="text" inputMode="decimal" value={fields[k]} onChange={set(k)} aria-label={aria} />
      <span className="num-field__unit" aria-hidden="true">{suffix}</span>
    </label>
  );
  const kindInfo = PATTERN_KINDS.find(k => k.key === pattern)!;

  async function apply() {
    if (!result) return;
    setSaving(true);
    try {
      const ok = await mech.applyPositions(cueId, result.items.map(i => ({
        mechanismId: i.mechanismId, value: i.value, ...(isFirstCue ? {} : { delaySec: i.delaySec }),
      })));
      if (ok) {
        toast.success(`已把「${kindInfo.label}」套用到「${group.name}」的 ${members.length} 個機關`);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }

  const byId = new Map(members.map(m => [m.id, m]));
  return (
    <section className="mech-pat" aria-label={`「${group.name}」套用花樣`}>
      <div className="mech-pat__head">
        <strong><Icon icon={Waves} /> 套用花樣到 {cueLabel}</strong>
        <small className="muted">改數字的時候 3D 畫面會跟著動；按「套用到這個 cue」才會存</small>
      </div>

      <div className="mech-seg" role="radiogroup" aria-label="花樣">
        {PATTERN_KINDS.map(k => (
          <button key={k.key} type="button" role="radio" aria-checked={pattern === k.key} className={pattern === k.key ? 'is-active' : ''}
            onClick={() => setPattern(k.key)}>{k.label}</button>
        ))}
      </div>
      <small className="muted">{kindInfo.hint}</small>

      <div className="mech-form__pair mech-pat__fields">
        {pattern === 'together' && <>{num('value', '位置', unit, `位置（${unit}）`)}{num('delay', '延遲', '秒', '延遲（秒）')}</>}
        {pattern === 'sequence' && (
          <>
            {num('value', '位置', unit, `位置（${unit}）`)}
            {num('interval', '間隔', '秒', '每一個晚幾秒開始動')}
            {num('delay', '起始延遲', '秒', '起始延遲（秒）')}
            <select aria-label="順序" value={order} onChange={e => setOrder(e.target.value as SequenceOrder)}>
              {SEQUENCE_ORDERS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </>
        )}
        {pattern === 'wave' && (
          <>
            {num('center', '中間值', unit, `中間值（${unit}）`)}
            {num('amplitude', '振幅', unit, `振幅（${unit}）`)}
            {num('period', '週期', '個', '週期（幾個機關一個來回）')}
            {num('phaseDeg', '相位', '度', '相位（度）')}
            {num('interval', '間隔', '秒', '每一個晚幾秒開始動')}
            {num('delay', '起始延遲', '秒', '起始延遲（秒）')}
          </>
        )}
        {pattern === 'gradient' && (
          <>
            {num('from', '從 A', unit, `第一個的位置 A（${unit}）`)}
            {num('to', '到 B', unit, `最後一個的位置 B（${unit}）`)}
            {num('delay', '延遲', '秒', '延遲（秒）')}
          </>
        )}
      </div>

      {error && <div className="field-error small" role="alert">{error}</div>}
      {isFirstCue && (
        <small className="muted">這是第一個 cue：機關直接站在這個位置、不會走過來，所以只設位置，不設延遲</small>
      )}
      {result && result.clamped > 0 && (
        <div className="mech-warn" role="status">
          <Icon icon={TriangleAlert} size="sm" className="mech-warn__icon" />
          <span>有 {result.clamped} 個機關算出來的位置超出行程，會停在行程的邊界</span>
        </div>
      )}

      {result && (
        <ol className="mech-pat__list" aria-label="每個機關套用後的樣子">
          {result.items.map((it, i) => {
            const m = byId.get(it.mechanismId)!;
            const pct = Math.max(0, Math.min(100, ((it.value - m.travelMin) / (m.travelMax - m.travelMin)) * 100));
            return (
              <li key={it.mechanismId} className="mech-pat__item">
                <span className="mech-pat__no">{i + 1}</span>
                <span className="mech-pat__name" title={m.name}>{m.name}</span>
                <span className="mech-pat__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                <span className="mech-pat__val">{formatMechValue(it.value, m.kind)}</span>
                <span className="mech-pat__delay muted">{isFirstCue ? '' : it.delaySec === null ? '沒有延遲' : `延遲 ${formatSeconds(it.delaySec)} 秒`}</span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mech-form__actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={!result || saving || disabled} onClick={() => void apply()}>套用到這個 cue</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} disabled={saving}>取消</button>
      </div>
    </section>
  );
}
