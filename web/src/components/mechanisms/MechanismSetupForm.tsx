// 設定一個機關（新增 / 編輯）：直接展開在機關分頁裡（不是跳出視窗 → 3D 畫面照樣可以轉、可以 Shift 點物件）
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight, Bookmark, Crosshair, Layers, MoveRight, MoveVertical, Plus, RotateCw, Ruler, Search, Spline, Split, Trash2, Wand2,
} from 'lucide-react';
import Icon from '../Icon';
import { confirmDialog } from '../dialogs';
import type { StageObject } from '../../lib/api';
import { STAGE_CATEGORY } from '../stageCategories';
import {
  LINEAR_DIRECTIONS, MECH_LIMITS, MECH_MESSAGES, ROTARY_AXES, blankMechanismInput, linearDirectionVector, matchLinearDirection,
  matchRotaryAxis, mechanismToInput, mirrorForSplit, normalizeMechanismInput, rotaryAxisVector, standardPresets, unitOf,
  type LinearDirection, type Mechanism, type MechanismField, type MechanismInput, type MechanismSide, type MechVec3, type RotaryAxisKind,
} from '../../lib/mechanisms/model';
import { FLIP_HINGES, flipSetupOf, hingeFromBox, withFlipSetup, type FlipHinge, type StageBox } from '../../lib/mechanisms/flip';
import { autoSplitSides, countSides } from '../../lib/mechanisms/split';
import { arcRadiusFor } from '../../lib/mechanisms/arc';
import { arcCenterChoices, arcMoveWord, resolveArcAxis } from '../../lib/mechanisms/arcForm';
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
  /** 這些物件在 cue 位置的外框（翻轉從外框算轉軸）；找不到 → null */
  groupBox: (ids: string[]) => StageBox | null;
  busy: boolean;
  onSave: (input: MechanismInput, moveObjects: boolean) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  /** 把現有 cue 的位置轉成機關位置（只有編輯、還沒有 cue 設過位置、有帶物件的時候） */
  onConvert?: () => void;
  /** 對開拆成兩個各自動的機關（只有編輯一個已經存好的對開機關時） */
  onUnsplit?: () => void;
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
  presets: { name: string; value: string }[];
  consoleLabel: string;
  /** 對開（兩邊往反方向）：開 / 關、每個物件在哪一邊（沒寫 = A 邊）、B 邊的控台編號 */
  split: boolean;
  sides: Record<string, MechanismSide>;
  consoleLabelB: string;
  /** 旋轉怎麼翻：'custom' = 自己設轉軸（轉台）；其他 = 沿著物件的哪一個邊緣翻（轉軸從外框算） */
  hinge: FlipHinge | 'custom';
  /** 翻轉選了「正的角度」的第一個選項 */
  flipFirst: boolean;
  /** 沿弧形軌道（直線機關的另一種移動方式）：圓心用上面的轉軸中心欄位（pivotM），半徑是公尺 */
  arc: boolean;
  arcRadius: string;
  /** 轉軸正負：手動按過「反過來」或編輯已經存好的弧形才照 arcDown；其他時候照切換時原本直線的方向（arcWant）自動挑 */
  arcTouched: boolean;
  arcDown: boolean;
  arcWant: MechVec3;
  /** 已經存的弧形轉軸不是垂直 → 原樣留著 */
  arcKeepAxis: MechVec3 | null;
};

const num = (s: string) => parseNumberInput(s);
const fmt = (v: number, d = 3) => formatFieldNumber(v, d);

function initialDraft(m: Mechanism | null, front: MechVec3, scale: number): Draft {
  const base: MechanismInput = m ? mechanismToInput(m) : blankMechanismInput();
  const lin = matchLinearDirection(base.axis, front);
  const rot = matchRotaryAxis(base.axis, front);
  const exact = base.kind === 'linear' ? lin.exact : rot.exact;
  const p = base.pivot ?? { x: 0, y: 0, z: 0 };
  const flip = base.kind === 'rotary' ? flipSetupOf(base.metadata) : null;
  const isArc = base.variant === 'arc' && base.kind === 'linear';
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
    presets: base.presets.map(x => ({ name: x.name, value: fmt(x.value) })),
    consoleLabel: base.consoleLabel ?? '',
    split: base.variant === 'split',
    sides: { ...base.objectSides },
    consoleLabelB: base.mirror?.consoleLabel ?? '',
    hinge: flip ? flip.hinge : 'custom',
    flipFirst: flip ? flip.positive !== 'second' : true,
    arc: isArc,
    arcRadius: isArc && base.arcRadius ? fmt(base.arcRadius) : '',
    arcTouched: isArc,
    arcDown: isArc && base.axis.y < 0,
    arcWant: linearDirectionVector(lin.dir, front),
    arcKeepAxis: isArc && Math.abs(base.axis.y) < 1 - 1e-6 ? base.axis : null,
  };
}

export default function MechanismSetupForm({
  editing, mechanisms, stageObjects, selectedObjectIds, scaleCorrection, front, groupCenter, groupBox, busy, onSave, onCancel, onDelete, onConvert, onUnsplit,
}: SetupFormProps) {
  const [d, setD] = useState<Draft>(() => initialDraft(editing, front, scaleCorrection));
  // 進階（轉軸 / 轉軸中心）：自己設轉軸時展開；沿著邊緣翻時收起來（照外框自動算）
  const [advOpen, setAdvOpen] = useState(() => d.hinge === 'custom');
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
    // 對開、吊掛（整組和吊點）的機關不能當別的機關的上層；沿弧形軌道的可以（它只是一個會轉的上層）
    const all = mechanisms.filter(m => !m.variant || m.variant === 'arc');
    if (!editing) return all;
    const below = new Set<string>([editing.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of mechanisms) if (m.parentId && below.has(m.parentId) && !below.has(m.id)) { below.add(m.id); grew = true; }
    }
    return all.filter(m => !below.has(m.id));
  }, [mechanisms, editing]);
  // 已經有機關裝在它上面 → 不能改成對開
  const hasKids = !!editing && mechanisms.some(m => m.parentId === editing.id);

  // 沿弧形軌道：圓心（場景單位）、帶的物件中心、現在的轉軸、「值變大往哪邊走」
  const arcOn = d.arc && d.kind === 'linear';
  const centerChoices = useMemo(() => arcCenterChoices(mechanisms, editing?.id ?? null), [mechanisms, editing]);
  const pmNow = d.pivotM.map(num);
  const arcPivotNow: MechVec3 | null = arcOn && d.pivotTouched && pmNow.every(v => v !== null)
    ? { x: metersToScene(pmNow[0]!, scaleCorrection), y: metersToScene(pmNow[1]!, scaleCorrection), z: metersToScene(pmNow[2]!, scaleCorrection) } : null;
  const arcCenter = arcOn && d.objectIds.length ? groupCenter(d.objectIds) : null;
  const arcAxisNow = resolveArcAxis({ keepAxis: d.arcKeepAxis, touched: d.arcTouched, down: d.arcDown, want: d.arcWant }, arcPivotNow, arcCenter);
  const arcWord = arcOn ? arcMoveWord(arcPivotNow, arcAxisNow, arcCenter, front) : null;
  const centerKey = arcOn
    ? centerChoices.find(c => [c.pivot.x, c.pivot.y, c.pivot.z].every((v, i) => fmt(sceneToMeters(v, scaleCorrection)) === d.pivotM[i].trim()))?.key ?? ''
    : '';
  const switchArc = (on: boolean) => setD(prev => {
    if (!on) return { ...prev, arc: false };
    // 切到弧形：轉軸正負照原本直線的方向自動挑（想往右走就挑讓數字變大往右的那一邊）
    const want = prev.keepAxis && prev.kind === editing?.kind ? prev.keepAxis : linearDirectionVector(prev.dir, front);
    return { ...prev, arc: true, arcWant: want, arcTouched: false, arcDown: false, arcKeepAxis: null, split: false };
  });
  const pickArcCenter = (key: string) => {
    const c = centerChoices.find(x => x.key === key);
    if (!c) return;
    set({
      pivotM: [fmt(sceneToMeters(c.pivot.x, scaleCorrection)), fmt(sceneToMeters(c.pivot.y, scaleCorrection)), fmt(sceneToMeters(c.pivot.z, scaleCorrection))],
      pivotTouched: true,
    });
  };
  const flipArc = () => setD(prev => (prev.arcKeepAxis
    ? { ...prev, arcKeepAxis: { x: -prev.arcKeepAxis.x || 0, y: -prev.arcKeepAxis.y || 0, z: -prev.arcKeepAxis.z || 0 } }
    : { ...prev, arcTouched: true, arcDown: !(arcAxisNow.y < 0) }));
  /** 「照物件現在的位置算」：物件中心到圓心的水平距離（公尺） */
  const calcArcRadius = () => {
    if (!arcPivotNow || !arcCenter) return;
    const r = arcRadiusFor(arcPivotNow, arcAxisNow, arcCenter, scaleCorrection);
    if (!(r >= 0.001)) { setErrors(e => ({ ...e, arcRadius: '物件就在圓心上，算不出半徑，請換一個圓心或自己填' })); return; }
    setErrors(e => ({ ...e, arcRadius: undefined }));
    set({ arcRadius: fmt(r) });
  };

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
    // 對開：轉軸中心用 A 邊物件的中心（B 邊自動鏡像過去）
    const mine = d.split ? ids.filter(id => (d.sides[id] ?? 'a') === 'a') : ids;
    const c = (mine.length ? mine : ids).length ? groupCenter(mine.length ? mine : ids) : null;
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

  const sideOf = (id: string): MechanismSide => (d.sides[id] === 'b' ? 'b' : 'a');
  const idsOn = (side: MechanismSide) => d.objectIds.filter(id => sideOf(id) === side);

  /** 翻轉：轉軸從 A 邊（沒對開 = 全部）物件的外框算；找不到外框就沿用原本存的（編輯時） */
  function hingeGeometry(): { axis: MechVec3; pivot: MechVec3 } | null {
    if (d.kind !== 'rotary' || d.hinge === 'custom') return null;
    const ids = d.split ? idsOn('a') : d.objectIds;
    const box = ids.length ? groupBox(ids) : null;
    if (box) return hingeFromBox(box, d.hinge, front, d.flipFirst);
    return null;
  }

  function buildInput(): unknown {
    const hingeGeo = hingeGeometry();
    const keep = editing && editing.kind === 'rotary' && d.hinge !== 'custom' && !hingeGeo ? editing : null;   // 外框找不到：沿用原本存的
    const axis = arcOn ? arcAxisNow : keep ? keep.axis : hingeGeo ? hingeGeo.axis : d.kind === 'linear'
      ? (d.keepAxis && d.kind === editing?.kind ? d.keepAxis : linearDirectionVector(d.dir, front))
      : (d.keepAxis && d.kind === editing?.kind ? d.keepAxis : rotaryAxisVector(d.rotAxis, d.rotPositiveFirst, front));
    const pm = d.pivotM.map(num);
    const pivot = d.kind === 'rotary' || arcOn
      ? (keep ? keep.pivot : hingeGeo ? hingeGeo.pivot
        : pm.every(v => v !== null) ? { x: metersToScene(pm[0]!, scaleCorrection), y: metersToScene(pm[1]!, scaleCorrection), z: metersToScene(pm[2]!, scaleCorrection) } : { x: 'x', y: 0, z: 0 })
      : null;
    const n = (s: string) => (s.trim() === '' ? NaN : num(s) ?? NaN);
    // 對開：B 邊 = A 邊的鏡像（直線 = 反方向；旋轉 = 鏡射到另一邊的轉軸中心），控台編號各自的
    let mirror: unknown = null;
    if (d.split) {
      const a = idsOn('a'), b = idsOn('b');
      const m = mirrorForSplit(d.kind, axis as MechVec3, (pivot as MechVec3 | null), a.length ? groupCenter(a) : null, b.length ? groupCenter(b) : null);
      mirror = { axis: m.axis, pivot: m.pivot, consoleLabel: d.consoleLabelB.trim() || null };
    }
    const setup = d.kind === 'rotary' && d.hinge !== 'custom' ? { hinge: d.hinge, positive: d.flipFirst ? 'first' as const : 'second' as const } : null;
    return {
      name: d.name,
      kind: d.kind,
      axis,
      pivot,
      travelMin: n(d.travelMin),
      travelMax: n(d.travelMax),
      defaultValue: d.defaultValue.trim() === '' ? 0 : n(d.defaultValue),
      // 最高速度已經不在畫面上設定（預覽不看它）；編輯舊的機關時照原本存的送回去，不會被清掉
      maxSpeed: editing?.maxSpeed ?? null,
      presets: d.presets.map(p => ({ name: p.name, value: n(p.value) })),
      parentId: d.parentId || null,
      objectIds: d.objectIds,
      consoleLabel: d.consoleLabel,
      metadata: withFlipSetup(editing?.metadata, setup),
      variant: d.split ? 'split' : arcOn ? 'arc' : null,
      arcRadius: arcOn ? n(d.arcRadius) : null,
      mirror,
      objectSides: d.split ? Object.fromEntries(d.objectIds.map(id => [id, sideOf(id)])) : {},
    };
  }

  async function save() {
    // 沿著邊緣翻：要有物件的外框才算得出轉軸（編輯時外框暫時找不到會沿用原本存的）
    if (d.kind === 'rotary' && d.hinge !== 'custom' && !hingeGeometry() && !(editing && editing.kind === 'rotary')) {
      setErrors({ objectIds: '沿著邊緣翻要先選好「帶動的物件」，轉軸會照它們的外框自動算' });
      return;
    }
    // 沿弧形軌道：圓心不能偷偷用預設的原點，一定要挑一個機關的圓心或自己填
    if (arcOn && !d.pivotTouched) {
      setErrors({ pivot: MECH_MESSAGES.arcPivot });
      return;
    }
    const r = normalizeMechanismInput(buildInput(), {
      selfId: editing?.id ?? null,
      siblings: mechanisms.map(m => ({ id: m.id, name: m.name, parentId: m.parentId, variant: m.variant ?? null })),
      projectObjectIds: new Set(stageObjects.map(o => o.id)),
    });
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({});
    const moving = r.value.objectIds.some(id => ownerOf.has(id));
    await onSave(r.value, moving);
  }

  // 對開
  const objName = (id: string) => stageObjects.find(o => o.id === id)?.displayName || id;
  const autoSplit = (ids = d.objectIds, kind = d.kind) => {
    const centers: Record<string, MechVec3 | undefined> = {};
    for (const id of ids) centers[id] = groupCenter([id]) ?? undefined;
    const axisA = kind === 'linear' ? (d.keepAxis && editing?.kind === 'linear' ? d.keepAxis : linearDirectionVector(d.dir, front)) : { x: 0, y: 1, z: 0 };
    return autoSplitSides(ids, centers, kind, axisA, front);
  };
  const toggleSplit = (on: boolean) => setD(prev => (on
    ? { ...prev, split: true, sides: { ...autoSplit(prev.objectIds, prev.kind), ...(prev.objectIds.length < 2 ? prev.sides : {}) } }
    : { ...prev, split: false }));
  const sideCount = countSides(d.objectIds, d.sides);
  // 翻轉：現在選的邊緣算出來的轉軸中心（只用來顯示）
  const hingeNow = hingeGeometry();

  const err = (f: MechanismField) => errors[f] ? <div className="field-error small" role="alert">{errors[f]}</div> : null;
  const tMin = num(d.travelMin), tMax = num(d.travelMax);
  const rotAxis = ROTARY_AXES.find(a => a.key === d.rotAxis)!;
  const split = d.split;

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
            onClick={() => set({ kind: 'linear', keepAxis: null, hinge: 'custom' })}><Icon icon={MoveVertical} /> 直線移動</button>
          <button type="button" role="radio" aria-checked={d.kind === 'rotary'} className={d.kind === 'rotary' ? 'is-active' : ''}
            onClick={() => set({ kind: 'rotary', keepAxis: null, arc: false, ...(d.pivotTouched ? {} : pivotFrom(d.objectIds)), ...(d.kind === 'linear' && tMin === 0 && tMax === 1 ? { travelMin: '-180', travelMax: '180' } : {}) })}><Icon icon={RotateCw} /> 旋轉</button>
        </div>
      </div>

      {d.kind === 'linear' && (
        <div className="mech-form__row">
          <span className="mech-form__label">移動方式</span>
          <div className="mech-seg" role="radiogroup" aria-label="移動方式">
            <button type="button" role="radio" aria-checked={!arcOn} className={!arcOn ? 'is-active' : ''}
              onClick={() => switchArc(false)}><Icon icon={MoveRight} /> 直線</button>
            <button type="button" role="radio" aria-checked={arcOn} className={arcOn ? 'is-active' : ''} disabled={d.split}
              title={d.split ? '對開的機關不能同時沿弧形軌道，先取消勾選「對開」' : '繞著一個圓心沿圓弧走，面向跟著轉'}
              onClick={() => switchArc(true)}><Icon icon={Spline} /> 沿弧形軌道</button>
          </div>
          <small className="muted">{arcOn
            ? '沿著圓弧走，越往外越靠近圓心那一側；走的時候會跟著轉角度。數字還是沿軌道走幾公尺'
            : '直線 = 往一個方向走。例：旋轉 LED 要沿著天上的弧形軌道橫移，選「沿弧形軌道」'}</small>
        </div>
      )}

      <div className="mech-form__row">
        <label className="mech-toggle" title={arcOn ? '沿弧形軌道的機關不能同時對開' : hasKids ? '有機關裝在它上面，不能改成對開' : '兩邊用同一個數字，往反方向動'}>
          <input type="checkbox" checked={d.split} disabled={hasKids || arcOn} onChange={e => toggleSplit(e.target.checked)} />
          <Icon icon={ArrowLeftRight} size="sm" />
          <span>對開（兩邊往反方向）</span>
        </label>
        <small className="muted">{arcOn
          ? '沿弧形軌道的機關不能同時對開（要改的話先把「移動方式」換回直線）'
          : hasKids
            ? '有機關裝在它上面，不能改成對開'
            : '例：左右兩排 LED 往兩邊打開。A 邊照下面的方向動，B 邊自動往鏡像的方向動，兩邊用同一個數字'}</small>
        {err('variant')}
      </div>

      {arcOn ? (
        <>
          <div className="mech-form__row">
            <label htmlFor="mech-arc-center">圓心</label>
            <select id="mech-arc-center" value={centerKey} onChange={e => pickArcCenter(e.target.value)}>
              <option value="">自己填（下面的 X、Y、Z）</option>
              {centerChoices.map(c => <option key={c.key} value={c.key}>跟「{c.label}」同一個圓心</option>)}
            </select>
            <div className="mech-form__pair">
              {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                <label key={ax} className="num-field">
                  <span className="num-field__axis">{ax}</span>
                  <input type="text" inputMode="decimal" aria-label={`圓心 ${ax}（m）`} value={d.pivotM[i]}
                    onChange={e => { const p = [...d.pivotM] as Draft['pivotM']; p[i] = e.target.value; set({ pivotM: p, pivotTouched: true }); }} />
                  <span className="num-field__unit" aria-hidden="true">m</span>
                </label>
              ))}
            </div>
            <small className="muted">{centerChoices.length > 0
              ? '物件繞著這一點走。想跟某個旋轉機關（例：側面 LED）走同一個圓，就選它的轉軸中心'
              : '物件繞著這一點走（這個專案還沒有旋轉 / 對開的機關可以挑，請自己填 X、Y、Z）'}</small>
            {err('pivot')}
          </div>
          <div className="mech-form__row">
            <span className="mech-form__label">轉軸</span>
            <div className="mech-form__pair">
              <span className="small">垂直的轉軸；{arcWord ? <>數字變大時 <strong>{arcWord}</strong> 走</> : '選好帶動的物件和圓心後，這裡會說數字變大時往哪邊走'}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={flipArc} title="讓數字變大時往相反的方向走"><Icon icon={ArrowLeftRight} /> 反過來</button>
            </div>
            {arcCenter && arcPivotNow && arcWord === null && <div className="field-error small" role="status">物件就在圓心上，沒辦法繞著圓走，請換一個圓心</div>}
            {err('axis')}
          </div>
          <div className="mech-form__row">
            <label htmlFor="mech-arc-radius">軌道半徑</label>
            <div className="mech-form__pair">
              <label className="num-field">
                <input id="mech-arc-radius" type="text" inputMode="decimal" value={d.arcRadius} onChange={e => set({ arcRadius: e.target.value })} />
                <span className="num-field__unit" aria-hidden="true">m</span>
              </label>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!arcPivotNow || !arcCenter}
                title={!arcCenter ? '先選要帶的物件' : !arcPivotNow ? '先填好圓心' : '用帶動的物件現在的中心到圓心的水平距離'}
                onClick={calcArcRadius}><Icon icon={Crosshair} /> 照物件現在的位置算</button>
            </div>
            <small className="muted">物件到圓心的水平距離（公尺）。行程、預設位置、每個 cue 的數字都是沿著弧線走幾公尺</small>
            {err('arcRadius')}
          </div>
        </>
      ) : d.kind === 'linear' ? (
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
            <label htmlFor="mech-hinge">怎麼轉</label>
            <div className="mech-form__pair">
              <select id="mech-hinge" value={d.hinge} onChange={e => {
                const hinge = e.target.value as FlipHinge | 'custom';
                set({ hinge, keepAxis: null });
                setAdvOpen(hinge === 'custom');
              }}>
                <option value="custom">轉台，或自己設定轉軸（進階）</option>
                {FLIP_HINGES.map(h => <option key={h.key} value={h.key}>{h.label}</option>)}
              </select>
              {d.hinge !== 'custom' && (() => {
                const info = FLIP_HINGES.find(h => h.key === d.hinge)!;
                return (
                  <select aria-label="正的角度" value={d.flipFirst ? '1' : '0'} onChange={e => set({ flipFirst: e.target.value === '1' })}>
                    <option value="1">正的角度：{info.positive[0]}</option>
                    <option value="0">正的角度：{info.positive[1]}</option>
                  </select>
                );
              })()}
            </div>
            <small className="muted">{d.hinge === 'custom'
              ? '像轉台那樣繞著一個點轉；轉軸和轉軸中心在下面「進階」設定'
              : '轉軸會照「帶動的物件」的外框自動放在選的邊緣，不用自己量'}</small>
            {err('axis')}
          </div>
          <details className="mech-advanced" open={advOpen} onToggle={e => setAdvOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>進階</summary>
            {d.hinge !== 'custom' && (
              <div className="mech-form__row">
                <span className="mech-form__label">轉軸中心（自動）</span>
                <small className="muted">{hingeNow
                  ? `X ${fmt(sceneToMeters(hingeNow.pivot.x, scaleCorrection))} m、Y ${fmt(sceneToMeters(hingeNow.pivot.y, scaleCorrection))} m、Z ${fmt(sceneToMeters(hingeNow.pivot.z, scaleCorrection))} m；要自己設定的話，把上面「怎麼轉」改成「轉台，或自己設定轉軸」`
                  : '選好「帶動的物件」就會自動算出來；要自己設定的話，把上面「怎麼轉」改成「轉台，或自己設定轉軸」'}</small>
              </div>
            )}
            <fieldset className="mech-fieldset" disabled={d.hinge !== 'custom'}>
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
                    title={d.objectIds.length === 0 ? '先選要帶的物件' : d.split ? '轉軸中心放在 A 邊物件的正中間' : '轉軸中心放在選的物件的正中間'}
                    onClick={() => setD(prev => ({ ...prev, ...pivotFrom(prev.objectIds), pivotTouched: true }))}><Icon icon={Crosshair} /> 用物件中心</button>
                </div>
                {err('pivot')}
              </div>
            </fieldset>
          </details>
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

      {d.split && (
        <div className="mech-form__row mech-sides">
          <div className="mech-form__pair">
            <span className="mech-form__label">哪些在 A 邊、哪些在 B 邊</span>
            <button type="button" className="btn btn--ghost btn--sm" disabled={d.objectIds.length < 2}
              title="找出物件散得最開的方向，從中間切成兩邊"
              onClick={() => setD(prev => ({ ...prev, sides: autoSplit(prev.objectIds, prev.kind) }))}><Icon icon={Wand2} /> 照位置自動分兩邊</button>
          </div>
          {d.objectIds.length === 0 ? <small className="muted">先在上面選好要帶動的物件，再分 A 邊、B 邊</small> : (
            <div className="mech-sides__cols">
              {(['a', 'b'] as const).map(side => (
                <div key={side} className="mech-sides__col">
                  <div className="mech-sides__title">{side === 'a' ? 'A 邊' : 'B 邊'}<span className="muted">（{sideCount[side]} 個）</span></div>
                  {idsOn(side).map(id => {
                    const other = side === 'a' ? 'B 邊' : 'A 邊';
                    return (
                      <div key={id} className="mech-sides__item">
                        <span className="mech-sides__name">{objName(id)}</span>
                        <button type="button" className="mech-icon-btn" title={`移到${other}`} aria-label={`把「${objName(id)}」移到${other}`}
                          onClick={() => set({ sides: { ...d.sides, [id]: side === 'a' ? 'b' : 'a' } })}><Icon icon={ArrowLeftRight} /></button>
                      </div>
                    );
                  })}
                  {sideCount[side] === 0 && <div className="muted small">還沒有物件</div>}
                </div>
              ))}
            </div>
          )}
          <small className="muted">A 邊照上面的方向動；B 邊自動往鏡像的方向動（直線 = 反方向，旋轉 = 轉軸鏡射到另一邊），兩邊用同一個數字</small>
          {d.objectIds.length > 0 && (sideCount.a === 0 || sideCount.b === 0) && (
            <div className="field-error small" role="status">兩邊都要有物件，只有一邊的話跟一般機關一樣</div>
          )}
          {err('mirror')}
        </div>
      )}

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
        {arcOn && <small className="muted">行程是沿著弧線走的距離（公尺），不是角度</small>}
        {split && <small className="muted">行程是每一邊走的{d.kind === 'rotary' ? '角度' : '距離'}{d.kind === 'linear' && tMax !== null && tMax > 0 ? `（每邊最多 ${fmt(tMax)} m，中間最多開 ${fmt(tMax * 2)} m）` : ''}</small>}
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
        <label htmlFor="mech-console">{d.split ? '控台編號（A 邊）' : '控台編號（選填）'}</label>
        <input id="mech-console" type="text" value={d.consoleLabel} maxLength={MECH_LIMITS.consoleLabelMax} onChange={e => set({ consoleLabel: e.target.value })} />
        {d.split && (
          <>
            <label htmlFor="mech-console-b">控台編號（B 邊）</label>
            <input id="mech-console-b" type="text" value={d.consoleLabelB} maxLength={MECH_LIMITS.consoleLabelMax} onChange={e => set({ consoleLabelB: e.target.value })} />
          </>
        )}
        <small className="muted">{d.split
          ? '自動化控台上兩邊各自的軸名，例：Axis 7、Axis 8（選填）。匯出機關總表時兩邊各寫一行'
          : '自動化控台上這個軸的名字，例：Axis 12。匯出機關總表時一起列出'}</small>
      </div>

      {errors.kind && err('kind')}

      <div className="mech-form__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>儲存</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>取消</button>
        <span className="grow" />
        {onDelete && <button type="button" className="btn btn--ghost btn--sm mech-danger" onClick={onDelete} disabled={busy}><Icon icon={Trash2} /> 刪除機關</button>}
      </div>
      {onUnsplit && (
        <div className="mech-form__convert">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onUnsplit} disabled={busy}><Icon icon={Split} /> 拆成兩個各自動的機關</button>
          <small className="muted">A 邊、B 邊變成兩個機關，之後可以各自設位置（例：四片門各自獨立動）。每個 cue 現在的位置會原樣抄過去，畫面不會變；拆完不能一鍵合回去</small>
        </div>
      )}
      {onConvert && (
        <div className="mech-form__convert">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onConvert} disabled={busy}><Icon icon={Wand2} /> 把現有 cue 的位置轉成機關位置</button>
          <small className="muted">這些物件以前是一個 cue 一個 cue 手動擺高度 / 角度的話，按這個把它們變成機關的位置（畫面看起來不會變），之後就能檢查速度、匯出總表</small>
        </div>
      )}
    </form>
  );
}
