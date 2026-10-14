// 一次建立 N 個機關（一排）：用 3D 畫面選取的物件，一個物件一個機關，編號、名稱、方向、行程一次設好。
// 直接展開在機關分頁裡（不是跳出視窗 → 3D 畫面照樣能轉、能 Shift 點物件）。
// 每個機關建好都是普通機關（自己的物件、行程、速度、控台編號），之後可以一個一個再改。
import { useMemo, useState } from 'react';
import { Layers, MoveVertical, RotateCw, Rows3 } from 'lucide-react';
import Icon from '../Icon';
import type { StageObject } from '../../lib/api';
import {
  LINEAR_DIRECTIONS, MECH_LIMITS, linearDirectionVector, rotaryAxisVector, standardPresets, unitOf, speedUnitOf,
  type GroupNumbering, type LinearDirection, type Mechanism, type MechanismGroup, type MechVec3,
} from '../../lib/mechanisms/model';
import { FLIP_HINGES, hingeFromBox, withFlipSetup, type FlipHinge, type StageBox } from '../../lib/mechanisms/flip';
import { NUMBERING_OPTIONS, maxPrefixLength, memberName, orderForNumbering, planBatch } from '../../lib/mechanisms/group';
import type { BatchPayload } from '../../lib/mechanisms/mechanismApi';
import { parseNumberInput } from '../../lib/numberField';

export interface BatchFormProps {
  mechanisms: Mechanism[];
  groups: MechanismGroup[];
  stageObjects: StageObject[];
  /** 3D 畫面選取的物件（順序 = 選的順序） */
  selectedObjectIds: string[];
  front: MechVec3;
  groupCenter: (ids: string[]) => MechVec3 | null;
  groupBox: (ids: string[]) => StageBox | null;
  busy: boolean;
  onSave: (payload: BatchPayload) => Promise<void>;
  onCancel: () => void;
}

type Draft = {
  prefix: string;
  numbering: GroupNumbering;
  kind: 'linear' | 'rotary';
  dir: LinearDirection;
  /** 旋轉：'center' = 每個繞著自己的中心水平轉；其他 = 每個沿著自己的哪一個邊緣翻 */
  hinge: FlipHinge | 'center';
  flipFirst: boolean;
  travelMin: string;
  travelMax: string;
  defaultValue: string;
  maxSpeed: string;
  presets: boolean;
};

const num = (s: string) => parseNumberInput(s);

export default function MechanismBatchForm({
  mechanisms, groups, stageObjects, selectedObjectIds, front, groupCenter, groupBox, busy, onSave, onCancel,
}: BatchFormProps) {
  const [d, setD] = useState<Draft>({
    prefix: '', numbering: 'leftToRight', kind: 'linear', dir: 'up', hinge: 'top', flipFirst: true,
    travelMin: '0', travelMax: '1', defaultValue: '0', maxSpeed: '', presets: true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD(prev => ({ ...prev, ...patch }));
  const unit = unitOf(d.kind);

  const ids = useMemo(() => selectedObjectIds.filter(id => stageObjects.some(o => o.id === id)), [selectedObjectIds, stageObjects]);
  const objName = (id: string) => stageObjects.find(o => o.id === id)?.displayName || id;
  // 每個物件的中心（編號順序要用）；3D 畫面還沒讀好就找不到 → 排在最後
  const ordered = useMemo(() => {
    const centers: Record<string, MechVec3 | undefined> = {};
    for (const id of ids) centers[id] = groupCenter([id]) ?? undefined;
    return orderForNumbering(ids, centers, d.numbering, front);
  }, [ids, d.numbering, front, groupCenter]);

  const prefix = d.prefix.trim();
  const n = ordered.length;
  const sample = prefix && n >= 2 ? `${memberName(prefix, 0)}、${memberName(prefix, 1)}${n > 3 ? ' … ' : '、'}${memberName(prefix, n - 1)}` : '';

  function build(): BatchPayload | string {
    const tMin = num(d.travelMin), tMax = num(d.travelMax);
    if (tMin === null || tMax === null) return '行程要填數字';
    const dv = d.defaultValue.trim() === '' ? 0 : num(d.defaultValue);
    if (dv === null) return '預設位置要是數字';
    const speed = d.maxSpeed.trim() === '' ? null : num(d.maxSpeed);
    if (d.maxSpeed.trim() !== '' && speed === null) return '最高速度要是正的數字，或留空不檢查';
    const base: BatchPayload['base'] = {
      kind: d.kind, travelMin: tMin, travelMax: tMax, defaultValue: dv, maxSpeed: speed,
      presets: d.presets && tMax > tMin ? standardPresets(tMin, tMax) : [],
    };
    const overrides: NonNullable<BatchPayload['overrides']> = {};
    if (d.kind === 'linear') {
      base.axis = linearDirectionVector(d.dir, front);
    } else if (d.hinge === 'center') {
      base.axis = rotaryAxisVector('yaw', d.flipFirst, front);
      for (const id of ordered) {
        const c = groupCenter([id]);
        if (!c) return `找不到「${objName(id)}」的位置，沒辦法算出轉軸中心`;
        overrides[id] = { pivot: c };
      }
    } else {
      base.metadata = withFlipSetup(null, { hinge: d.hinge, positive: d.flipFirst ? 'first' : 'second' });
      for (const id of ordered) {
        const box = groupBox([id]);
        if (!box) return `找不到「${objName(id)}」的外框，沒辦法算出轉軸`;
        overrides[id] = hingeFromBox(box, d.hinge, front, d.flipFirst);
      }
    }
    return {
      base, objectIds: ordered, namePrefix: prefix, groupName: prefix, numbering: d.numbering,
      ...(Object.keys(overrides).length ? { overrides } : {}),
    };
  }

  async function save() {
    const payload = build();
    if (typeof payload === 'string') { setError(payload); return; }
    // 先用跟後台同一套規則檢查（錯了在這裡就說，不用送出去才知道）
    const plan = planBatch(payload, {
      siblings: mechanisms.map(m => ({ id: m.id, name: m.name, parentId: m.parentId, variant: m.variant ?? null })),
      projectObjectIds: new Set(stageObjects.map(o => o.id)),
      groupNames: groups.map(g => g.name),
    });
    if (!plan.ok) { setError(plan.error); return; }
    setError(null);
    await onSave(payload);
  }

  const hingeInfo = d.hinge === 'center' ? null : FLIP_HINGES.find(h => h.key === d.hinge)!;

  return (
    <form className="mech-form" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="一次建立多個機關">
      <div className="mech-form__row">
        <span className="mech-form__label"><Icon icon={Layers} /> 用 3D 畫面選取的物件，各建立一個機關（{n} 個）</span>
        {n < 2
          ? <small className="muted">先在 3D 畫面按住 Shift 點好幾個物件（至少 2 個），再回到這裡</small>
          : <small className="muted">{ordered.slice(0, 6).map((id, i) => `${i + 1} ${objName(id)}`).join('、')}{n > 6 ? `…（共 ${n} 個）` : ''}</small>}
      </div>

      <div className="mech-form__row">
        <label htmlFor="mech-batch-prefix">名稱開頭</label>
        <input id="mech-batch-prefix" type="text" value={d.prefix} maxLength={n >= 2 ? maxPrefixLength(n) : MECH_LIMITS.nameMax}
          placeholder="例：LED 升降" autoFocus onChange={e => set({ prefix: e.target.value })} />
        <small className="muted">{sample ? `會建立：${sample}（這一排也叫「${prefix}」）` : '後面會自動接上編號：例如「LED 升降」→「LED 升降 1」「LED 升降 2」…'}</small>
      </div>

      <div className="mech-form__row">
        <label htmlFor="mech-batch-numbering">編號順序</label>
        <select id="mech-batch-numbering" value={d.numbering} onChange={e => set({ numbering: e.target.value as GroupNumbering })}>
          {NUMBERING_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <small className="muted">左右是觀眾看過去的左右；「一起 / 依序 / 波浪」的先後就照這個編號</small>
      </div>

      <div className="mech-form__row">
        <span className="mech-form__label">動作</span>
        <div className="mech-seg" role="radiogroup" aria-label="動作">
          <button type="button" role="radio" aria-checked={d.kind === 'linear'} className={d.kind === 'linear' ? 'is-active' : ''}
            onClick={() => set({ kind: 'linear', travelMin: '0', travelMax: '1' })}><Icon icon={MoveVertical} /> 直線移動</button>
          <button type="button" role="radio" aria-checked={d.kind === 'rotary'} className={d.kind === 'rotary' ? 'is-active' : ''}
            onClick={() => set({ kind: 'rotary', travelMin: '0', travelMax: '90' })}><Icon icon={RotateCw} /> 旋轉</button>
        </div>
      </div>

      {d.kind === 'linear' ? (
        <div className="mech-form__row">
          <label htmlFor="mech-batch-dir">數字變大時往</label>
          <select id="mech-batch-dir" value={d.dir} onChange={e => set({ dir: e.target.value as LinearDirection })}>
            {LINEAR_DIRECTIONS.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </div>
      ) : (
        <div className="mech-form__row">
          <label htmlFor="mech-batch-hinge">怎麼轉</label>
          <div className="mech-form__pair">
            <select id="mech-batch-hinge" value={d.hinge} onChange={e => {
              const hinge = e.target.value as FlipHinge | 'center';
              set({ hinge, ...(hinge === 'center' ? { travelMin: '-180', travelMax: '180' } : d.hinge === 'center' ? { travelMin: '0', travelMax: '90' } : {}) });
            }}>
              <option value="center">每個繞著自己的中心水平轉</option>
              {FLIP_HINGES.map(h => <option key={h.key} value={h.key}>{h.label}</option>)}
            </select>
            {hingeInfo && (
              <select aria-label="正的角度" value={d.flipFirst ? '1' : '0'} onChange={e => set({ flipFirst: e.target.value === '1' })}>
                <option value="1">正的角度：{hingeInfo.positive[0]}</option>
                <option value="0">正的角度：{hingeInfo.positive[1]}</option>
              </select>
            )}
          </div>
          <small className="muted">轉軸會照每個物件自己的外框，自動放在它自己的那個邊緣，不用一個一個量</small>
        </div>
      )}

      <div className="mech-form__row">
        <span className="mech-form__label">行程（每個機關）</span>
        <div className="mech-form__pair">
          <label className="num-field"><span className="num-field__axis">最低</span>
            <input type="text" inputMode="decimal" aria-label={`行程最低（${unit}）`} value={d.travelMin} onChange={e => set({ travelMin: e.target.value })} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
          <label className="num-field"><span className="num-field__axis">最高</span>
            <input type="text" inputMode="decimal" aria-label={`行程最高（${unit}）`} value={d.travelMax} onChange={e => set({ travelMax: e.target.value })} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
        </div>
      </div>

      <div className="mech-form__row">
        <div className="mech-form__pair">
          <label className="num-field"><span className="num-field__axis">預設位置</span>
            <input type="text" inputMode="decimal" aria-label={`預設位置（${unit}）`} value={d.defaultValue} onChange={e => set({ defaultValue: e.target.value })} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
          <label className="num-field"><span className="num-field__axis">最高速度</span>
            <input type="text" inputMode="decimal" aria-label="最高速度（選填）" placeholder="選填" value={d.maxSpeed} onChange={e => set({ maxSpeed: e.target.value })} />
            <span className="num-field__unit" aria-hidden="true">{speedUnitOf(d.kind)}</span></label>
        </div>
        <label className="mech-speed-toggle">
          <input type="checkbox" checked={d.presets} onChange={e => set({ presets: e.target.checked })} />
          <span>每個機關都加上 收起 / 半開 / 全開 的常用位置</span>
        </label>
        <small className="muted">控台編號、哪個物件、名字，建好之後在每個機關的「編輯」裡一個一個改；行程、速度想一起改，用這一排的「編輯這一排」</small>
      </div>

      {error && <div className="field-error small" role="alert">{error}</div>}
      <div className="mech-form__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || n < 2}><Icon icon={Rows3} /> {n >= 2 ? `建立 ${n} 個機關` : '建立機關'}</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>取消</button>
      </div>
    </form>
  );
}

