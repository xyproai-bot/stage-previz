// 設定一整組吊掛（新增 / 編輯）：整組一個名字、帶動的物件，加 2～4 個吊點。
// 每個吊點是一條鍊條（或吊索）：拉高幾公尺就是它的數字；各吊點拉到不一樣高，整片物件就會傾斜。
// 直接展開在機關分頁裡（不是跳出視窗 → 3D 畫面照樣可以轉、可以 Shift 點物件）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Cable, Layers, Plus, Search, Trash2, X } from 'lucide-react';
import Icon from '../Icon';
import { confirmDialog } from '../dialogs';
import type { StageObject } from '../../lib/api';
import { STAGE_CATEGORY } from '../stageCategories';
import { MECH_LIMITS, type Mechanism, type MechanismField, type MechVec3 } from '../../lib/mechanisms/model';
import type { StageBox } from '../../lib/mechanisms/flip';
import { HOIST_SPOTS, nextHoistSpot, spotFromBox, type HoistSpot } from '../../lib/mechanisms/hoist';
import { planHoistRig } from '../../lib/mechanisms/hoistRig';
import type { HoistPayload, MechanismPayload } from '../../lib/mechanisms/mechanismApi';
import { formatFieldNumber, metersToScene, parseNumberInput, sceneToMeters } from '../../lib/numberField';

export interface HoistFormProps {
  /** 編輯哪一組吊掛（整組）；null = 新增 */
  editing: Mechanism | null;
  /** 編輯：它原本的吊點（照吊點編號） */
  hoists: Mechanism[];
  mechanisms: Mechanism[];
  stageObjects: StageObject[];
  /** 3D 畫面選取的物件 */
  selectedObjectIds: string[];
  scaleCorrection: number;
  front: MechVec3;
  /** 這些物件在 cue 位置的外框（吊點從外框選角和邊緣中間）；找不到 → null */
  groupBox: (ids: string[]) => StageBox | null;
  busy: boolean;
  onSave: (payload: MechanismPayload, moveObjects: boolean) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
}

type HoistDraft = {
  /** React 的 key（吊點增減時不亂掉） */
  key: string;
  /** 原本就有的吊點 id；新增 = null */
  id: string | null;
  name: string;
  /** 'custom' = 自己填 X、Y、Z（公尺）；其他 = 照物件外框算 */
  spot: HoistSpot | 'custom';
  xyz: [string, string, string];
  travelMin: string;
  travelMax: string;
  defaultValue: string;
  maxSpeed: string;
  consoleLabel: string;
};

type Draft = { name: string; objectIds: string[]; hoists: HoistDraft[] };

const num = (s: string) => parseNumberInput(s);
const fmt = (v: number, d = 3) => formatFieldNumber(v, d);
let keySeq = 0;
const newKey = () => `h${++keySeq}`;

function blankHoist(spot: HoistSpot): HoistDraft {
  return { key: newKey(), id: null, name: '', spot, xyz: ['', '', ''], travelMin: '0', travelMax: '5', defaultValue: '0', maxSpeed: '', consoleLabel: '' };
}

function initialDraft(editing: Mechanism | null, hoists: Mechanism[], scale: number): Draft {
  if (!editing) return { name: '', objectIds: [], hoists: [blankHoist('leftMid'), blankHoist('rightMid')] };
  return {
    name: editing.name,
    objectIds: [...editing.objectIds],
    hoists: hoists.map(h => ({
      key: newKey(), id: h.id, name: h.name, spot: 'custom' as const,
      xyz: [fmt(sceneToMeters(h.attach?.x ?? 0, scale)), fmt(sceneToMeters(h.attach?.y ?? 0, scale)), fmt(sceneToMeters(h.attach?.z ?? 0, scale))],
      travelMin: fmt(h.travelMin), travelMax: fmt(h.travelMax), defaultValue: fmt(h.defaultValue),
      maxSpeed: h.maxSpeed === null ? '' : fmt(h.maxSpeed), consoleLabel: h.consoleLabel ?? '',
    })),
  };
}

export default function MechanismHoistForm({
  editing, hoists, mechanisms, stageObjects, selectedObjectIds, scaleCorrection, front, groupBox, busy, onSave, onCancel, onDelete,
}: HoistFormProps) {
  const [d, setD] = useState<Draft>(() => initialDraft(editing, hoists, scaleCorrection));
  const [search, setSearch] = useState('');
  const [error, setError] = useState<{ field: MechanismField | 'hoistsAll'; text: string } | null>(null);
  const [moveConfirmed, setMoveConfirmed] = useState<Set<string>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, []);

  const objName = (id: string) => stageObjects.find(o => o.id === id)?.displayName || id;
  const rigName = d.name.trim() || '這組吊掛';
  const setHoist = (key: string, patch: Partial<HoistDraft>) => setD(prev => ({ ...prev, hoists: prev.hoists.map(h => (h.key === key ? { ...h, ...patch } : h)) }));

  // 物件已經直接放在別的機關（不算自己）
  const ownerOf = useMemo(() => {
    const m = new Map<string, Mechanism>();
    for (const mech of mechanisms) if (mech.id !== editing?.id) for (const id of mech.objectIds) m.set(id, mech);
    return m;
  }, [mechanisms, editing]);

  const addObjects = async (ids: string[]) => {
    const fresh = ids.filter(id => !d.objectIds.includes(id));
    const moving = fresh.filter(id => ownerOf.has(id) && !moveConfirmed.has(id));
    if (moving.length) {
      const names = moving.map(id => `「${objName(id)}」（在「${ownerOf.get(id)!.name}」）`).join('、');
      const ok = await confirmDialog({
        title: `要把它們移到「${rigName}」嗎？`,
        message: `${names} 已經在別的機關裡，一個物件只能直接放在一個機關。`,
        confirmLabel: '移過來',
      });
      if (!ok) return;
      setMoveConfirmed(s => { const n = new Set(s); moving.forEach(id => n.add(id)); return n; });
    }
    setD(prev => ({ ...prev, objectIds: [...new Set([...prev.objectIds, ...ids])] }));
  };
  const useSelection = () => void addObjects(selectedObjectIds.filter(id => stageObjects.some(o => o.id === id)));

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = stageObjects
      .filter(o => !q || o.displayName.toLowerCase().includes(q) || o.meshName.toLowerCase().includes(q))
      .sort((a, b) => a.order - b.order);
    const by = new Map<string, StageObject[]>();
    for (const o of list) { const l = by.get(o.category) || []; l.push(o); by.set(o.category, l); }
    return [...by.entries()];
  }, [stageObjects, search]);

  // 物件的外框（吊點的角和邊緣中間從這裡算）：3D 畫面還沒讀好 / 還沒選物件 → null
  const box = useMemo(() => (d.objectIds.length ? groupBox(d.objectIds) : null), [d.objectIds, groupBox]);
  const spotXyz = (spot: HoistSpot): [string, string, string] | null => {
    if (!box) return null;
    const p = spotFromBox(box, spot, front);
    return [fmt(sceneToMeters(p.x, scaleCorrection)), fmt(sceneToMeters(p.y, scaleCorrection)), fmt(sceneToMeters(p.z, scaleCorrection))];
  };

  const addHoist = () => setD(prev => {
    if (prev.hoists.length >= MECH_LIMITS.hoistsMax) return prev;
    const used = prev.hoists.map(h => h.spot).filter((s): s is HoistSpot => s !== 'custom');
    return { ...prev, hoists: [...prev.hoists, blankHoist(nextHoistSpot(used))] };
  });
  const removeHoist = (key: string) => setD(prev => (prev.hoists.length <= MECH_LIMITS.hoistsMin ? prev : { ...prev, hoists: prev.hoists.filter(h => h.key !== key) }));

  async function save() {
    const hoistPayload: HoistPayload[] = [];
    for (const [i, h] of d.hoists.entries()) {
      let attach: MechVec3 | null = null;
      if (h.spot === 'custom') {
        const v = h.xyz.map(num);
        if (v.every(x => x !== null)) attach = { x: metersToScene(v[0]!, scaleCorrection), y: metersToScene(v[1]!, scaleCorrection), z: metersToScene(v[2]!, scaleCorrection) };
        else { setError({ field: 'hoistsAll', text: `吊點 ${i + 1} 的位置要填 X、Y、Z 三個數字` }); return; }
      } else if (box) {
        attach = spotFromBox(box, h.spot, front);
      } else {
        setError({ field: 'hoistsAll', text: '先選好「帶動的物件」，吊點的角和邊緣中間才算得出位置（也可以改成自己填 X、Y、Z）' });
        return;
      }
      const n = (s: string) => (s.trim() === '' ? NaN : num(s) ?? NaN);
      hoistPayload.push({
        ...(h.id ? { id: h.id } : {}),
        name: h.name,
        attach,
        travelMin: n(h.travelMin),
        travelMax: n(h.travelMax),
        defaultValue: h.defaultValue.trim() === '' ? 0 : n(h.defaultValue),
        maxSpeed: h.maxSpeed.trim() === '' ? null : n(h.maxSpeed),
        consoleLabel: h.consoleLabel,
      });
    }
    const payload: MechanismPayload = { ...(editing ? {} : { variant: 'hoist_rig' as const }), name: d.name, objectIds: d.objectIds, hoists: hoistPayload };
    // 先用跟後台同一套規則檢查（錯了在這裡就說，不用送出去才知道）
    const plan = planHoistRig(payload, {
      siblings: mechanisms.map(m => ({ id: m.id, name: m.name, parentId: m.parentId, variant: m.variant ?? null, rigId: m.rigId ?? null })),
      projectObjectIds: new Set(stageObjects.map(o => o.id)),
      existing: editing ? { rig: editing, hoists } : null,
    });
    if (!plan.ok) { setError({ field: plan.field, text: plan.error }); return; }
    setError(null);
    await onSave(payload, d.objectIds.some(id => ownerOf.has(id)));
  }

  const err = (...fields: (MechanismField | 'hoistsAll')[]) => (error && fields.includes(error.field)
    ? <div className="field-error small" role="alert">{error.text}</div> : null);

  return (
    <form ref={formRef} className="mech-form" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="設定吊掛">
      <div className="mech-form__row">
        <label htmlFor="hoist-name"><Icon icon={Cable} /> 名稱</label>
        <input id="hoist-name" type="text" value={d.name} maxLength={MECH_LIMITS.nameMax} placeholder="例：舞台前吊板" autoFocus={!editing}
          onChange={e => setD(prev => ({ ...prev, name: e.target.value }))} />
        <small className="muted">每個吊點是一條鍊條（或吊索），數字 = 它被拉高幾公尺。各吊點拉到一樣高，整片平著升降；高度不一樣，整片就會傾斜</small>
        {err('name')}
      </div>

      <div className="mech-form__row">
        <span className="mech-form__label">帶動的物件{d.objectIds.length > 0 && <span className="muted">（{d.objectIds.length} 個）</span>}</span>
        <div className="mech-form__pair">
          <button type="button" className="btn btn--ghost btn--sm" disabled={selectedObjectIds.length === 0} onClick={useSelection}
            title="在 3D 畫面按住 Shift 點物件可以選好幾個"><Icon icon={Layers} /> 用 3D 畫面選取的物件（{selectedObjectIds.length} 個）</button>
        </div>
        {d.objectIds.length > 0 && (
          <ul className="mech-hoist__objs">
            {d.objectIds.map(id => (
              <li key={id}>
                <span className="mech-hoist__objname">{objName(id)}</span>
                <button type="button" className="mech-icon-btn" title="拿掉" aria-label={`把「${objName(id)}」拿掉`}
                  onClick={() => setD(prev => ({ ...prev, objectIds: prev.objectIds.filter(x => x !== id) }))}><Icon icon={X} /></button>
              </li>
            ))}
          </ul>
        )}
        <details className="mech-advanced">
          <summary>從清單選物件</summary>
          <label className="mech-search">
            <Icon icon={Search} size="xs" />
            <input type="search" value={search} placeholder="找物件" aria-label="找物件" onChange={e => setSearch(e.target.value)} />
          </label>
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
                        <input type="checkbox" checked={checked}
                          onChange={e => (e.target.checked ? void addObjects([o.id]) : setD(prev => ({ ...prev, objectIds: prev.objectIds.filter(x => x !== o.id) })))} />
                        <span>{o.displayName}</span>
                        {owner && !checked && <span className="muted small">已在「{owner.name}」</span>}
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </details>
        {d.objectIds.length === 0 && <small className="muted">先選好要吊的物件，吊點的位置才能用角和邊緣中間來選</small>}
        {err('objectIds')}
      </div>

      <div className="mech-form__row">
        <span className="mech-form__label">吊點（{d.hoists.length} 個，最少 {MECH_LIMITS.hoistsMin} 個、最多 {MECH_LIMITS.hoistsMax} 個）</span>
        {d.hoists.map((h, i) => {
          const auto = h.spot !== 'custom' ? spotXyz(h.spot) : null;
          return (
            <fieldset key={h.key} className="mech-hoist">
              <legend>吊點 {i + 1}</legend>
              <div className="mech-form__pair">
                <input type="text" value={h.name} maxLength={MECH_LIMITS.nameMax} aria-label={`吊點 ${i + 1} 的名稱`} placeholder={`${rigName} 吊點 ${i + 1}`}
                  onChange={e => setHoist(h.key, { name: e.target.value })} />
                <button type="button" className="mech-icon-btn" disabled={d.hoists.length <= MECH_LIMITS.hoistsMin}
                  title={d.hoists.length <= MECH_LIMITS.hoistsMin ? '吊掛最少要 2 個吊點' : '拿掉這個吊點'} aria-label={`拿掉吊點 ${i + 1}`}
                  onClick={() => removeHoist(h.key)}><Icon icon={Trash2} /></button>
              </div>
              <div className="mech-form__row">
                <label htmlFor={`hoist-spot-${h.key}`}>吊點在物件上的位置</label>
                <select id={`hoist-spot-${h.key}`} value={h.spot} onChange={e => {
                  const spot = e.target.value as HoistSpot | 'custom';
                  const xyz = spot === 'custom' ? (auto ?? h.xyz) : h.xyz;
                  setHoist(h.key, { spot, xyz });
                }}>
                  {HOIST_SPOTS.map(s => <option key={s.key} value={s.key}>{s.label}（物件最上面）</option>)}
                  <option value="custom">自己填 X、Y、Z</option>
                </select>
                {h.spot === 'custom' ? (
                  <div className="mech-form__pair">
                    {(['X', 'Y', 'Z'] as const).map((ax, k) => (
                      <label key={ax} className="num-field">
                        <span className="num-field__axis">{ax}</span>
                        <input type="text" inputMode="decimal" aria-label={`吊點 ${i + 1} 的位置 ${ax}（m）`} value={h.xyz[k]}
                          onChange={e => { const xyz = [...h.xyz] as HoistDraft['xyz']; xyz[k] = e.target.value; setHoist(h.key, { xyz }); }} />
                        <span className="num-field__unit" aria-hidden="true">m</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <small className="muted">{auto
                    ? `X ${auto[0]} m、Y ${auto[1]} m、Z ${auto[2]} m（照物件外框算，左右是觀眾看過去的）`
                    : '選好「帶動的物件」就會算出位置'}</small>
                )}
              </div>
              <div className="mech-form__pair">
                <label className="num-field"><span className="num-field__axis">最低</span>
                  <input type="text" inputMode="decimal" aria-label={`吊點 ${i + 1} 行程最低（m）`} value={h.travelMin} onChange={e => setHoist(h.key, { travelMin: e.target.value })} />
                  <span className="num-field__unit" aria-hidden="true">m</span></label>
                <label className="num-field"><span className="num-field__axis">最高</span>
                  <input type="text" inputMode="decimal" aria-label={`吊點 ${i + 1} 行程最高（m）`} value={h.travelMax} onChange={e => setHoist(h.key, { travelMax: e.target.value })} />
                  <span className="num-field__unit" aria-hidden="true">m</span></label>
                <label className="num-field"><span className="num-field__axis">預設</span>
                  <input type="text" inputMode="decimal" aria-label={`吊點 ${i + 1} 預設位置（m）`} value={h.defaultValue} onChange={e => setHoist(h.key, { defaultValue: e.target.value })} />
                  <span className="num-field__unit" aria-hidden="true">m</span></label>
              </div>
              <div className="mech-form__pair">
                <label className="num-field"><span className="num-field__axis">最高速度</span>
                  <input type="text" inputMode="decimal" placeholder="選填" aria-label={`吊點 ${i + 1} 最高速度（m/秒）`} value={h.maxSpeed} onChange={e => setHoist(h.key, { maxSpeed: e.target.value })} />
                  <span className="num-field__unit" aria-hidden="true">m/秒</span></label>
                <input type="text" value={h.consoleLabel} maxLength={MECH_LIMITS.consoleLabelMax} placeholder="控台編號（選填）" aria-label={`吊點 ${i + 1} 的控台編號`}
                  onChange={e => setHoist(h.key, { consoleLabel: e.target.value })} />
              </div>
            </fieldset>
          );
        })}
        <div className="mech-form__pair">
          <button type="button" className="btn btn--ghost btn--sm" disabled={d.hoists.length >= MECH_LIMITS.hoistsMax} onClick={addHoist}><Icon icon={Plus} /> 新增吊點</button>
        </div>
        <small className="muted">2 個吊點：整片沿著兩點的連線傾斜；3 個：傾斜到通過三個點的平面；4 個：四個點要在同一個平面上，不然硬的東西會被扭到（會提醒）</small>
        {err('hoists', 'attach', 'travel', 'maxSpeed', 'rigId', 'hoistsAll')}
      </div>

      <div className="mech-form__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>儲存</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>取消</button>
        <span className="grow" />
        {onDelete && <button type="button" className="btn btn--ghost btn--sm mech-danger" onClick={onDelete} disabled={busy}><Icon icon={Trash2} /> 刪除吊掛</button>}
      </div>
    </form>
  );
}
