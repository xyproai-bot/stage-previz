// 編輯一排機關：名字，和整排共用的設定（行程、預設位置、常用位置）。改一次，這一排每個機關都跟著改。
// 每個機關自己的名字、物件、方向、控台編號，還是在各自的「編輯」裡改。
import { useState } from 'react';
import { Layers, Trash2, Unlink } from 'lucide-react';
import Icon from '../Icon';
import { MECH_LIMITS, standardPresets, unitOf, type Mechanism, type MechanismGroup } from '../../lib/mechanisms/model';
import type { GroupPatch } from '../../lib/mechanisms/mechanismApi';
import { formatFieldNumber, parseNumberInput } from '../../lib/numberField';

interface Props {
  group: MechanismGroup;
  members: Mechanism[];
  busy: boolean;
  onSave: (patch: GroupPatch) => Promise<void>;
  onCancel: () => void;
  onDissolve: () => void;
  onDelete: () => void;
}

const fmt = (v: number) => formatFieldNumber(v, 3);

export default function MechanismGroupForm({ group, members, busy, onSave, onCancel, onDissolve, onDelete }: Props) {
  const first = members[0];
  const kind = first?.kind ?? 'linear';
  const unit = unitOf(kind);
  const same = (pick: (m: Mechanism) => number | null) => members.every(m => pick(m) === (first ? pick(first) : null));
  const mixed = !same(m => m.travelMin) || !same(m => m.travelMax) || !same(m => m.defaultValue);
  const [name, setName] = useState(group.name);
  const [travelMin, setTravelMin] = useState(first ? fmt(first.travelMin) : '0');
  const [travelMax, setTravelMax] = useState(first ? fmt(first.travelMax) : '1');
  const [defaultValue, setDefaultValue] = useState(first ? fmt(first.defaultValue) : '0');
  const [presets, setPresets] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const tMin = parseNumberInput(travelMin), tMax = parseNumberInput(travelMax);
    if (tMin === null || tMax === null) { setError('行程要填數字'); return; }
    if (!(tMax > tMin)) { setError('行程的最高要比最低大'); return; }
    const dv = defaultValue.trim() === '' ? 0 : parseNumberInput(defaultValue);
    if (dv === null) { setError('預設位置要是數字'); return; }
    if (!name.trim()) { setError('這一排的名字不能空白'); return; }
    setError(null);
    const patch: GroupPatch = { name: name.trim(), travelMin: tMin, travelMax: tMax, defaultValue: dv };
    if (presets) patch.presets = standardPresets(tMin, tMax);
    await onSave(patch);
  }

  return (
    <form className="mech-form" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={`編輯「${group.name}」這一排`}>
      <div className="mech-form__row">
        <label htmlFor="mech-group-name">這一排的名字</label>
        <input id="mech-group-name" type="text" value={name} maxLength={MECH_LIMITS.groupNameMax} autoFocus onChange={e => setName(e.target.value)} />
        <small className="muted">只是這一排的標題；裡面每個機關的名字不會跟著改</small>
      </div>

      <div className="mech-form__row">
        <span className="mech-form__label"><Icon icon={Layers} /> 整排共用的設定（{members.length} 個機關）</span>
        {mixed && <small className="muted">現在這幾個機關的設定不太一樣；儲存之後會全部改成下面這一組</small>}
        <div className="mech-form__pair">
          <label className="num-field"><span className="num-field__axis">最低</span>
            <input type="text" inputMode="decimal" aria-label={`行程最低（${unit}）`} value={travelMin} onChange={e => setTravelMin(e.target.value)} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
          <label className="num-field"><span className="num-field__axis">最高</span>
            <input type="text" inputMode="decimal" aria-label={`行程最高（${unit}）`} value={travelMax} onChange={e => setTravelMax(e.target.value)} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
        </div>
        <div className="mech-form__pair">
          <label className="num-field"><span className="num-field__axis">預設位置</span>
            <input type="text" inputMode="decimal" aria-label={`預設位置（${unit}）`} value={defaultValue} onChange={e => setDefaultValue(e.target.value)} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
        </div>
        <label className="mech-toggle">
          <input type="checkbox" checked={presets} onChange={e => setPresets(e.target.checked)} />
          <span>常用位置重設成 收起 / 半開 / 全開（會取代每個機關原本的常用位置）</span>
        </label>
        <small className="muted">已經存在 cue 裡的位置不會被改，只是行程變窄的話，超出的位置播放時會停在邊界</small>
      </div>

      {error && <div className="field-error small" role="alert">{error}</div>}
      <div className="mech-form__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>儲存</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>取消</button>
        <span className="grow" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDissolve} disabled={busy}
          title="機關都留著，變成一個一個普通機關"><Icon icon={Unlink} /> 只解散這一排</button>
        <button type="button" className="btn btn--ghost btn--sm mech-danger" onClick={onDelete} disabled={busy}><Icon icon={Trash2} /> 刪除這一排</button>
      </div>
    </form>
  );
}
