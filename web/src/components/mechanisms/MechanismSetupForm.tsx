// 設定一個機關（新增 / 編輯）：直接展開在機關分頁裡（不是跳出視窗 → 3D 畫面照樣可以轉、可以 Shift 點物件）
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark, Crosshair, Gauge, Layers, MoveVertical, Plus, RotateCw, Ruler, Search, Trash2, Wand2,
} from 'lucide-react';
import Icon from '../Icon';
import { confirmDialog } from '../dialogs';
import type { StageObject } from '../../lib/api';
import { STAGE_CATEGORY } from '../stageCategories';
import {
  LINEAR_DIRECTIONS, MECH_LIMITS, ROTARY_AXES, blankMechanismInput, linearDirectionVector, matchLinearDirection,
  matchRotaryAxis, mechanismToInput, normalizeMechanismInput, rotaryAxisVector, standardPresets, unitOf, speedUnitOf,
  type LinearDirection, type Mechanism, type MechanismField, type MechanismInput, type MechVec3, type RotaryAxisKind,
} from '../../lib/mechanisms/model';
import { formatFieldNumber, metersToScene, parseNumberInput, sceneToMeters } from '../../lib/numberField';

export interface SetupFormProps {
  /** 編輯哪個機關；null = 新增 */
  editing: Mechanism | null;
  mechanisms: Mechanism[];
  stageObjects: StageObject[];
  /** 3D 畫面選取的物件 */
  selectedObjectIds: string[];
  scaleCorrection: number;
  front: MechVec3;
  groupCenter: (ids: string[]) => MechVec3 | null;
  busy: boolean;
  onSave: (input: MechanismInput, moveObjects: boolean) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  /** 把現有 cue 的位置轉成機關位置（只有編輯、還沒有 cue 設過位置、有帶物件的時候） */
  onConvert?: () => void;
}

type Draft = {
  name: string;
  kind: 'linear' | 'rotary';
  dir: LinearDirection;
  rotAxis: RotaryAxisKind;
  rotPositiveFirst: boolean;
  /** 已經存的方向剛好不是任何一個選項時保留原本的（沒有動方向選項就不改） */
  keepAxis: MechVec3 | null;
  pivotM: [string, string, string];
  pivotTouched: boolean;
  objectIds: string[];
  parentId: string;
  travelMin: string;
  travelMax: string;
  defaultValue: string;
  maxSpeed: string;
  presets: { name: string; value: string }[];
  consoleLabel: string;
};

const num = (s: string) => parseNumberInput(s);
const fmt = (v: number, d = 3) => formatFieldNumber(v, d);

function initialDraft(m: Mechanism | null, front: MechVec3, scale: number): Draft {
  const base: MechanismInput = m ? mechanismToInput(m) : blankMechanismInput();
  const lin = matchLinearDirection(base.axis, front);
  const rot = matchRotaryAxis(base.axis, front);
  const exact = base.kind === 'linear' ? lin.exact : rot.exact;
  const p = base.pivot ?? { x: 0, y: 0, z: 0 };
  return {
    name: base.name,
    kind: base.kind,
    dir: lin.dir,
    rotAxis: rot.kind,
    rotPositiveFirst: rot.positiveFirst,
    keepAxis: m && !exact ? base.axis : null,
    pivotM: [fmt(sceneToMeters(p.x, scale)), fmt(sceneToMeters(p.y, scale)), fmt(sceneToMeters(p.z, scale))],
    pivotTouched: !!m,
    objectIds: [...base.objectIds],
    parentId: base.parentId ?? '',
    travelMin: fmt(base.travelMin),
    travelMax: fmt(base.travelMax),
    defaultValue: fmt(base.defaultValue),
    maxSpeed: base.maxSpeed === null ? '' : fmt(base.maxSpeed),
    presets: base.presets.map(x => ({ name: x.name, value: fmt(x.value) })),
    consoleLabel: base.consoleLabel ?? '',
  };
}

export default function MechanismSetupForm({
  editing, mechanisms, stageObjects, selectedObjectIds, scaleCorrection, front, groupCenter, busy, onSave, onCancel, onDelete, onConvert,
}: SetupFormProps) {
  const [d, setD] = useState<Draft>(() => initialDraft(editing, front, scaleCorrection));
  const [search, setSearch] = useState('');
  const [errors, setErrors] = useState<Partial<Record<MechanismField, string>>>({});
  const [moveConfirmed, setMoveConfirmed] = useState<Set<string>>(new Set());
  const set = (patch: Partial<Draft>) => setD(prev => ({ ...prev, ...patch }));
  const unit = unitOf(d.kind);
  // 打開時捲到看得到的地方（編輯清單下面的機關時，表單在畫面外）
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, []);

  // 物件已經直接放在別的機關（不算自己）
  const ownerOf = useMemo(() => {
    const m = new Map<string, Mechanism>();
    for (const mech of mechanisms) if (mech.id !== editing?.id) for (const id of mech.objectIds) m.set(id, mech);
    return m;
  }, [mechanisms, editing]);

  // 可以裝上去的機關：不是自己、不是裝在自己底下的
  const parentOptions = useMemo(() => {
    if (!editing) return mechanisms;
    const below = new Set<string>([editing.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of mechanisms) if (m.parentId && below.has(m.parentId) && !below.has(m.id)) { below.add(m.id); grew = true; }
    }
    return mechanisms.filter(m => !below.has(m.id));
  }, [mechanisms, editing]);

  const name = d.name.trim() || '這個機關';
  const toggleObject = async (id: string, on: boolean) => {
    if (on && ownerOf.has(id) && !moveConfirmed.has(id)) {
      const owner = ownerOf.get(id)!;
      const obj = stageObjects.find(o => o.id === id);
      const ok = await confirmDialog({
        title: `要把它移到「${name}」嗎？`,
        message: `「${obj?.displayName || id}」已經在「${owner.name}」裡，一個物件只能直接放在一個機關。`,
        confirmLabel: '移過來',
      });
      if (!ok) return;
      setMoveConfirmed(s => new Set(s).add(id));
    }
    setD(prev => {
      const ids = on ? [...new Set([...prev.objectIds, id])] : prev.objectIds.filter(x => x !== id);
      return { ...prev, objectIds: ids, ...(prev.kind === 'rotary' && !prev.pivotTouched ? pivotFrom(ids) : {}) };
    });
  };
  const pivotFrom = (ids: string[]): Partial<Draft> => {
    const c = ids.length ? groupCenter(ids) : null;
    if (!c) return {};
    return { pivotM: [fmt(sceneToMeters(c.x, scaleCorrection)), fmt(sceneToMeters(c.y, scaleCorrection)), fmt(sceneToMeters(c.z, scaleCorrection))] };
  };
  const useSelection = async () => {
    const ids = selectedObjectIds.filter(id => stageObjects.some(o => o.id === id));
    const moving = ids.filter(id => ownerOf.has(id) && !moveConfirmed.has(id) && !d.objectIds.includes(id));
    if (moving.length) {
      const names = moving.map(id => `「${stageObjects.find(o => o.id === id)?.displayName || id}」（在「${ownerOf.get(id)!.name}」）`).join('、');
      const ok = await confirmDialog({
        title: `要把它們移到「${name}」嗎？`,
        message: `${names} 已經在別的機關裡，一個物件只能直接放在一個機關。`,
        confirmLabel: '移過來',
      });
      if (!ok) return;
      setMoveConfirmed(s => { const n = new Set(s); moving.forEach(id => n.add(id)); return n; });
    }
    setD(prev => {
      const all = [...new Set([...prev.objectIds, ...ids])];
      return { ...prev, objectIds: all, ...(prev.kind === 'rotary' && !prev.pivotTouched ? pivotFrom(all) : {}) };
    });
  };

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = stageObjects
      .filter(o => !q || o.displayName.toLowerCase().includes(q) || o.meshName.toLowerCase().includes(q))
      .sort((a, b) => a.order - b.order);
    const by = new Map<string, StageObject[]>();
    for (const o of list) { const l = by.get(o.category) || []; l.push(o); by.set(o.category, l); }
    return [...by.entries()];
  }, [stageObjects, search]);

  function buildInput(): unknown {
    const axis = d.kind === 'linear'
      ? (d.keepAxis && d.kind === editing?.kind ? d.keepAxis : linearDirectionVector(d.dir, front))
      : (d.keepAxis && d.kind === editing?.kind ? d.keepAxis : rotaryAxisVector(d.rotAxis, d.rotPositiveFirst, front));
    const pm = d.pivotM.map(num);
    const pivot = d.kind === 'rotary'
      ? (pm.every(v => v !== null) ? { x: metersToScene(pm[0]!, scaleCorrection), y: metersToScene(pm[1]!, scaleCorrection), z: metersToScene(pm[2]!, scaleCorrection) } : { x: 'x', y: 0, z: 0 })
      : null;
    const n = (s: string) => (s.trim() === '' ? NaN : num(s) ?? NaN);
    return {
      name: d.name,
      kind: d.kind,
      axis,
      pivot,
      travelMin: n(d.travelMin),
      travelMax: n(d.travelMax),
      defaultValue: d.defaultValue.trim() === '' ? 0 : n(d.defaultValue),
      maxSpeed: d.maxSpeed.trim() === '' ? null : (num(d.maxSpeed) ?? 'x'),
      presets: d.presets.map(p => ({ name: p.name, value: n(p.value) })),
      parentId: d.parentId || null,
      objectIds: d.objectIds,
      consoleLabel: d.consoleLabel,
      metadata: editing?.metadata ?? null,
    };
  }

  async function save() {
    const r = normalizeMechanismInput(buildInput(), {
      selfId: editing?.id ?? null,
      siblings: mechanisms.map(m => ({ id: m.id, name: m.name, parentId: m.parentId })),
      projectObjectIds: new Set(stageObjects.map(o => o.id)),
    });
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({});
    const moving = r.value.objectIds.some(id => ownerOf.has(id));
    await onSave(r.value, moving);
  }

  const err = (f: MechanismField) => errors[f] ? <div className="field-error small" role="alert">{errors[f]}</div> : null;
  const tMin = num(d.travelMin), tMax = num(d.travelMax);
  const rotAxis = ROTARY_AXES.find(a => a.key === d.rotAxis)!;

  return (
    <form ref={formRef} className="mech-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="mech-form__row">
        <label htmlFor="mech-name">名稱</label>
        <input id="mech-name" type="text" value={d.name} maxLength={MECH_LIMITS.nameMax} placeholder="例：中央升降台" autoFocus={!editing}
          onChange={e => set({ name: e.target.value })} />
        {err('name')}
      </div>

      <div className="mech-form__row">
        <span className="mech-form__label">動作</span>
        <div className="mech-seg" role="radiogroup" aria-label="動作">
          <button type="button" role="radio" aria-checked={d.kind === 'linear'} className={d.kind === 'linear' ? 'is-active' : ''}
            onClick={() => set({ kind: 'linear', keepAxis: null })}><Icon icon={MoveVertical} /> 直線移動</button>
          <button type="button" role="radio" aria-checked={d.kind === 'rotary'} className={d.kind === 'rotary' ? 'is-active' : ''}
            onClick={() => set({ kind: 'rotary', keepAxis: null, ...(d.pivotTouched ? {} : pivotFrom(d.objectIds)), ...(d.kind === 'linear' && tMin === 0 && tMax === 1 ? { travelMin: '-180', travelMax: '180' } : {}) })}><Icon icon={RotateCw} /> 旋轉</button>
        </div>
      </div>

      {d.kind === 'linear' ? (
        <div className="mech-form__row">
          <label htmlFor="mech-dir">數字變大時往</label>
          <select id="mech-dir" value={d.dir} onChange={e => set({ dir: e.target.value as LinearDirection, keepAxis: null })}>
            {LINEAR_DIRECTIONS.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          <small className="muted">左右是觀眾看過去的左右</small>
          {err('axis')}
        </div>
      ) : (
        <>
          <div className="mech-form__row">
            <label htmlFor="mech-axis">轉軸</label>
            <div className="mech-form__pair">
              <select id="mech-axis" value={d.rotAxis} onChange={e => set({ rotAxis: e.target.value as RotaryAxisKind, keepAxis: null })}>
                {ROTARY_AXES.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
              <select aria-label="正的角度" value={d.rotPositiveFirst ? '1' : '0'} onChange={e => set({ rotPositiveFirst: e.target.value === '1', keepAxis: null })}>
                <option value="1">正的角度：{rotAxis.positive[0]}</option>
                <option value="0">正的角度：{rotAxis.positive[1]}</option>
              </select>
            </div>
            {err('axis')}
          </div>
          <div className="mech-form__row">
            <span className="mech-form__label">轉軸中心</span>
            <div className="mech-form__pair">
              {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                <label key={ax} className="num-field">
                  <span className="num-field__axis">{ax}</span>
                  <input type="text" inputMode="decimal" aria-label={`轉軸中心 ${ax}（m）`} value={d.pivotM[i]}
                    onChange={e => { const p = [...d.pivotM] as Draft['pivotM']; p[i] = e.target.value; set({ pivotM: p, pivotTouched: true }); }} />
                  <span className="num-field__unit" aria-hidden="true">m</span>
                </label>
              ))}
              <button type="button" className="btn btn--ghost btn--sm" disabled={d.objectIds.length === 0}
                title={d.objectIds.length === 0 ? '先選要帶的物件' : '轉軸中心放在選的物件的正中間'}
                onClick={() => setD(prev => ({ ...prev, ...pivotFrom(prev.objectIds), pivotTouched: true }))}><Icon icon={Crosshair} /> 用物件中心</button>
            </div>
            {err('pivot')}
          </div>
        </>
      )}

      <div className="mech-form__row">
        <span className="mech-form__label">帶動的物件{d.objectIds.length > 0 && <span className="muted">（{d.objectIds.length} 個）</span>}</span>
        <div className="mech-form__pair">
          <label className="mech-search">
            <Icon icon={Search} size="xs" />
            <input type="search" value={search} placeholder="找物件" aria-label="找物件" onChange={e => setSearch(e.target.value)} />
          </label>
          <button type="button" className="btn btn--ghost btn--sm" disabled={selectedObjectIds.length === 0} onClick={() => void useSelection()}
            title="在 3D 畫面按住 Shift 點物件可以選好幾個"><Icon icon={Layers} /> 用 3D 畫面選取的物件（{selectedObjectIds.length} 個）</button>
        </div>
        <div className="mech-objects">
          {grouped.length === 0 && <div className="muted small">找不到物件</div>}
          {grouped.map(([cat, objs]) => {
            const info = STAGE_CATEGORY[cat as keyof typeof STAGE_CATEGORY];
            return (
              <div key={cat} className="mech-objects__group">
                <div className="mech-objects__cat">{info && <Icon icon={info.icon} size="xs" />} {info?.label ?? cat}</div>
                {objs.map(o => {
                  const owner = ownerOf.get(o.id);
                  const checked = d.objectIds.includes(o.id);
                  return (
                    <label key={o.id} className="mech-objects__item">
                      <input type="checkbox" checked={checked} onChange={e => void toggleObject(o.id, e.target.checked)} />
                      <span>{o.displayName}</span>
                      {owner && !checked && <span className="muted small">已在「{owner.name}」</span>}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
        {err('objectIds')}
      </div>

      <div className="mech-form__row">
        <label htmlFor="mech-parent">跟著另一個機關動（選填）</label>
        <select id="mech-parent" value={d.parentId} onChange={e => set({ parentId: e.target.value })}>
          <option value="">不用</option>
          {parentOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <small className="muted">例：裝在轉台上的升降台，選「旋轉舞台」</small>
        {err('parentId')}
      </div>

      <div className="mech-form__row">
        <span className="mech-form__label"><Icon icon={Ruler} /> 行程</span>
        <div className="mech-form__pair">
          <label className="num-field"><span className="num-field__axis">最低</span>
            <input type="text" inputMode="decimal" aria-label={`行程最低（${unit}）`} value={d.travelMin} onChange={e => set({ travelMin: e.target.value })} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
          <label className="num-field"><span className="num-field__axis">最高</span>
            <input type="text" inputMode="decimal" aria-label={`行程最高（${unit}）`} value={d.travelMax} onChange={e => set({ travelMax: e.target.value })} />
            <span className="num-field__unit" aria-hidden="true">{unit}</span></label>
        </div>
        {err('travel')}
      </div>

      <div className="mech-form__row">
        <label htmlFor="mech-default">預設位置</label>
        <label className="num-field">
          <input id="mech-default" type="text" inputMode="decimal" value={d.defaultValue} onChange={e => set({ defaultValue: e.target.value })} />
          <span className="num-field__unit" aria-hidden="true">{unit}</span>
        </label>
        <small className="muted">沒有 cue 設定時停在這裡</small>
      </div>

      <div className="mech-form__row">
        <label htmlFor="mech-speed"><Icon icon={Gauge} /> 最高速度</label>
        <label className="num-field">
          <input id="mech-speed" type="text" inputMode="decimal" placeholder="選填" value={d.maxSpeed} onChange={e => set({ maxSpeed: e.target.value })} />
          <span className="num-field__unit" aria-hidden="true">{speedUnitOf(d.kind)}</span>
        </label>
        <small className="muted">填了才會檢查轉場夠不夠；沒填就照轉場秒數移動</small>
        {err('maxSpeed')}
      </div>

      <div className="mech-form__row">
        <span className="mech-form__label"><Icon icon={Bookmark} /> 常用位置</span>
        {d.presets.map((p, i) => (
          <div key={i} className="mech-form__pair">
            <input type="text" className="mech-form__preset-name" value={p.name} maxLength={MECH_LIMITS.presetNameMax} aria-label={`常用位置 ${i + 1} 的名稱`}
              placeholder="例：全開" onChange={e => { const ps = [...d.presets]; ps[i] = { ...p, name: e.target.value }; set({ presets: ps }); }} />
            <label className="num-field">
              <input type="text" inputMode="decimal" value={p.value} aria-label={`常用位置 ${i + 1} 的位置（${unit}）`}
                onChange={e => { const ps = [...d.presets]; ps[i] = { ...p, value: e.target.value }; set({ presets: ps }); }} />
              <span className="num-field__unit" aria-hidden="true">{unit}</span>
            </label>
            <button type="button" className="mech-icon-btn" title="刪掉這個常用位置" aria-label="刪掉這個常用位置"
              onClick={() => set({ presets: d.presets.filter((_, j) => j !== i) })}><Icon icon={Trash2} /></button>
          </div>
        ))}
        <div className="mech-form__pair">
          <button type="button" className="btn btn--ghost btn--sm" disabled={tMin === null || tMax === null || !(tMax > tMin) || d.presets.length >= MECH_LIMITS.presetsMax}
            onClick={() => {
              const cur = d.presets.map(p => ({ name: p.name.trim(), value: num(p.value) ?? 0 }));
              set({ presets: standardPresets(tMin!, tMax!, cur).map(p => ({ name: p.name, value: fmt(p.value) })) });
            }}><Icon icon={Bookmark} /> 加入 收起 / 半開 / 全開</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={d.presets.length >= MECH_LIMITS.presetsMax}
            onClick={() => set({ presets: [...d.presets, { name: '', value: d.defaultValue || '0' }] })}><Icon icon={Plus} /> 新增常用位置</button>
        </div>
        {err('presets')}
      </div>

      <div className="mech-form__row">
        <label htmlFor="mech-console">控台編號（選填）</label>
        <input id="mech-console" type="text" value={d.consoleLabel} maxLength={MECH_LIMITS.consoleLabelMax} onChange={e => set({ consoleLabel: e.target.value })} />
        <small className="muted">自動化控台上這個軸的名字，例：Axis 12。匯出機關總表時一起列出</small>
      </div>

      {errors.kind && err('kind')}

      <div className="mech-form__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>儲存</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>取消</button>
        <span className="grow" />
        {onDelete && <button type="button" className="btn btn--ghost btn--sm mech-danger" onClick={onDelete} disabled={busy}><Icon icon={Trash2} /> 刪除機關</button>}
      </div>
      {onConvert && (
        <div className="mech-form__convert">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onConvert} disabled={busy}><Icon icon={Wand2} /> 把現有 cue 的位置轉成機關位置</button>
          <small className="muted">這些物件以前是一個 cue 一個 cue 手動擺高度 / 角度的話，按這個把它們變成機關的位置（畫面看起來不會變），之後就能檢查速度、匯出總表</small>
        </div>
      )}
    </form>
  );
}
