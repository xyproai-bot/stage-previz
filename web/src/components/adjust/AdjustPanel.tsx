// 調整舞台：導演頁右邊的面板
//   沒選東西 → 清單（一排 / 吊掛 / 單一機關；改過的標黃色）
//   選了物件 → 它的每個機關一段：整組選、常用位置、滑桿 + 數字、讀數（自轉方向、弧形往前多少）、回到存的值
//   最下面：放棄全部改動

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import { Link2, List, RotateCcw, Undo2 } from 'lucide-react';
import Icon from '../Icon';
import type { Mechanism, MechVec3 } from '../../lib/mechanisms/model';
import { valueDecimals } from '../../lib/mechanisms/model';
import type { AdjustControl, AdjustStore } from '../../lib/adjust/store';
import { membersOfGroup, type ScopeKey } from '../../lib/adjust/scope';
import { ADJUST_TEXT, groupLabel, hoistHint, kindLabel, rangeText, scopeLabel, togetherHint } from '../../lib/adjust/panelText';
import { arcReadout, arcReadoutText, spinFromPrevText } from '../../lib/adjust/readouts';
import type { AdjustScene } from './handles';
import './AdjustStage.css';

export interface AdjustPanelProps {
  store: AdjustStore;
  /** 3D 疊層（物件在 cue 位置的中心：弧形讀數用） */
  sceneRef: MutableRefObject<AdjustScene | null>;
  /** 物件的名字（3D 物件名稱） */
  objectName: (objectId: string) => string;
  /** 舞台正面（指向觀眾） */
  front: () => MechVec3;
  /** 1 個場景單位 = 幾公尺（測距校準倍率） */
  sceneToMeters: number;
}

/** 按住 Alt：滑桿也不對齊 */
function useAltKey(): MutableRefObject<boolean> {
  const ref = useRef(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { ref.current = e.altKey; };
    const off = () => { ref.current = false; };
    window.addEventListener('keydown', on);
    window.addEventListener('keyup', on);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('keydown', on); window.removeEventListener('keyup', on); window.removeEventListener('blur', off); };
  }, []);
  return ref;
}

export default function AdjustPanel(p: AdjustPanelProps) {
  const { store } = p;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  if (!state.on) return null;
  return (
    <div className="adjust-panel">
      {state.selection ? <SelectedView {...p} /> : <ListView store={store} />}
      {store.changedCount() > 0 && (
        <div className="adjust-panel__foot">
          <button type="button" className="adjust-chip" onClick={() => store.discardAll()}><Icon icon={Undo2} /> {ADJUST_TEXT.discardAll}</button>
        </div>
      )}
      <div className="adjust-panel__hint">{ADJUST_TEXT.unsavedHint}</div>
    </div>
  );
}

// ───────── 清單 ─────────

type ListItem =
  | { type: 'single'; mech: Mechanism }
  | { type: 'group'; groupId: string; members: Mechanism[] }
  | { type: 'rig'; rig: Mechanism; hoists: Mechanism[] };

function listItems(store: AdjustStore): ListItem[] {
  const defs = store.mechanisms();
  const out: ListItem[] = [];
  const doneGroups = new Set<string>();
  const rigIds = new Set(defs.filter(m => m.variant === 'hoist_rig').map(m => m.id));
  for (const m of defs) {
    if (m.variant === 'hoist_rig') {
      if (store.objectFor(m.id)) out.push({ type: 'rig', rig: m, hoists: defs.filter(h => h.variant === 'hoist' && h.rigId === m.id).sort((a, b) => (a.rigIndex ?? 0) - (b.rigIndex ?? 0)) });
      continue;
    }
    if (m.variant === 'hoist' && m.rigId && rigIds.has(m.rigId)) continue;
    if (!store.objectFor(m.id)) continue;   // 沒有帶任何物件的機關：3D 上點不到，不列
    if (m.groupId) {
      if (doneGroups.has(m.groupId)) continue;
      doneGroups.add(m.groupId);
      const members = membersOfGroup(defs, m.groupId).filter(x => store.objectFor(x.id));
      if (members.length > 1) { out.push({ type: 'group', groupId: m.groupId, members }); continue; }
    }
    out.push({ type: 'single', mech: m });
  }
  return out;
}

function ListView({ store }: { store: AdjustStore }) {
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const items = useMemo(() => listItems(store), [store, st.draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const chip = (m: Mechanism, label: string = m.name) => (
    <button
      key={m.id}
      type="button"
      className={'adjust-chip' + (store.isChanged(m.id) ? ' is-changed' : '')}
      onClick={() => store.selectMechanism(m.id)}
      title={store.isChanged(m.id) ? `${m.name}（這個 cue 改過）` : m.name}
    >{label}</button>
  );
  return (
    <>
      <div>
        <div className="adjust-panel__title">{ADJUST_TEXT.listTitle}</div>
        <div className="adjust-panel__sub">{ADJUST_TEXT.listHint}</div>
      </div>
      {items.length === 0 && <div className="adjust-panel__empty">{ADJUST_TEXT.noMechanisms}</div>}
      <div>
        {items.map(it => {
          if (it.type === 'single') {
            return <div key={it.mech.id} className="adjust-list__item"><div className="adjust-row">{chip(it.mech)}</div></div>;
          }
          if (it.type === 'rig') {
            const changed = it.hoists.some(h => store.isChanged(h.id));
            return (
              <div key={it.rig.id} className="adjust-list__item">
                <div className="adjust-list__name">{changed && <span className="adjust-dot" aria-hidden="true" />}{it.rig.name}<span className="adjust-ctl__kind">吊掛</span></div>
                <div className="adjust-row">
                  <button type="button" className={'adjust-chip' + (changed ? ' is-changed' : '')} onClick={() => store.selectMechanism(it.rig.id)}>選這組吊掛</button>
                </div>
              </div>
            );
          }
          const name = groupLabel(it.members.map(m => m.name));
          const changed = it.members.some(m => store.isChanged(m.id));
          return (
            <div key={it.groupId} className="adjust-list__item">
              <div className="adjust-list__name">{changed && <span className="adjust-dot" aria-hidden="true" />}{name}<span className="adjust-ctl__kind">一排 {it.members.length} 個</span></div>
              <div className="adjust-row">
                {it.members.map(m => chip(m))}
                <button
                  type="button"
                  className="adjust-chip"
                  onClick={() => { if (store.selectMechanism(it.members[0].id)) store.setScope(it.groupId, 'all'); }}
                >整排一起</button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ───────── 選到的物件 ─────────

function SelectedView({ store, sceneRef, objectName, front, sceneToMeters }: AdjustPanelProps) {
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const sel = st.selection!;
  const controls = store.controls();
  const alt = useAltKey();
  return (
    <>
      <div className="adjust-panel__head">
        <div style={{ minWidth: 0 }}>
          <div className="adjust-panel__title">{objectName(sel.objectId)}</div>
          <div className="adjust-panel__sub">拖 3D 上的綠色把手，或用下面的按鈕、滑桿調整。</div>
        </div>
        <button type="button" className="adjust-chip" onClick={() => store.select(null)} title="回到機關清單"><Icon icon={List} /> {ADJUST_TEXT.backToList}</button>
      </div>
      {controls.map(c => (c.type === 'mech'
        ? <MechControl key={c.id} store={store} def={c.def} alt={alt} sceneRef={sceneRef} front={front} sceneToMeters={sceneToMeters} />
        : <RigControl key={c.rigId} store={store} ctl={c} alt={alt} />))}
    </>
  );
}

function RigControl({ store, ctl, alt }: { store: AdjustStore; ctl: Extract<AdjustControl, { type: 'rig' }>; alt: MutableRefObject<boolean> }) {
  useSyncExternalStore(store.subscribe, store.getState);
  const linked = store.isLinked(ctl.rigId);
  const changed = ctl.hoists.filter(h => store.isChanged(h.id)).map(h => h.id);
  return (
    <div className="adjust-ctl">
      <div className="adjust-ctl__head">
        <div className={'adjust-ctl__name' + (changed.length ? ' is-changed' : '')}>{ctl.def?.name ?? '吊掛'}<span className="adjust-ctl__kind">吊掛</span></div>
        {changed.length > 0 && <button type="button" className="adjust-link-btn" onClick={() => store.revert(changed)}><Icon icon={RotateCcw} /> {ADJUST_TEXT.revert}</button>}
      </div>
      <div className="adjust-row">
        <button type="button" className={'adjust-chip' + (linked ? ' is-on' : '')} aria-pressed={linked} onClick={() => store.setLinked(ctl.rigId, !linked)}>
          <Icon icon={Link2} /> {ADJUST_TEXT.linked}
        </button>
      </div>
      <div className="adjust-ctl__readout">{hoistHint(linked)}</div>
      {ctl.hoists.map(h => <ValueRow key={h.id} store={store} def={h} alt={alt} label={h.name} />)}
    </div>
  );
}

function MechControl({ store, def, alt, sceneRef, front, sceneToMeters }: {
  store: AdjustStore; def: Mechanism; alt: MutableRefObject<boolean>;
  sceneRef: MutableRefObject<AdjustScene | null>; front: () => MechVec3; sceneToMeters: number;
}) {
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const ids = store.driveIds(def.id);
  const changed = ids.filter(id => store.isChanged(id));
  const v = store.value(def.id);
  // 整組選（一排機關）
  const members = def.groupId ? membersOfGroup(store.mechanisms(), def.groupId) : [];
  const halves = def.groupId && members.length > 1 ? store.halvesOf(def.groupId) : null;
  const scope: ScopeKey = (def.groupId && st.scope[def.groupId]) || 'one';
  const scopes: { key: ScopeKey; n: number }[] = members.length > 1 ? [
    { key: 'one', n: 1 }, { key: 'all', n: members.length },
    ...(halves && halves.left.length && halves.right.length ? [{ key: 'left' as const, n: halves.left.length }, { key: 'right' as const, n: halves.right.length }] : []),
  ] : [];
  // 讀數
  const readout: string[] = [];
  if (def.kind === 'rotary' && Math.abs(def.axis.y) > 0.7) {
    const cue = store.cue();
    const prev = store.prevValue(def.id);
    readout.push(spinFromPrevText({ prevName: cue?.prevName ?? null, prev, cur: v, axisY: def.axis.y }));
    if (Math.abs(v - prev) >= 90) readout.push(ADJUST_TEXT.playHint);
  } else if (def.variant === 'arc' && def.pivot && def.arcRadius && def.arcRadius > 0) {
    const obj = store.objectFor(def.id);
    const c = obj ? sceneRef.current?.baseCenter(obj) : null;
    if (c) readout.push(arcReadoutText(arcReadout({ pivot: def.pivot, axis: def.axis, radiusM: def.arcRadius, center: c, front: front(), sceneToMeters, value: v })));
  }
  return (
    <div className="adjust-ctl">
      <div className="adjust-ctl__head">
        <div className={'adjust-ctl__name' + (changed.length ? ' is-changed' : '')}>{def.name}<span className="adjust-ctl__kind">{kindLabel(def)}</span></div>
        {changed.length > 0 && <button type="button" className="adjust-link-btn" onClick={() => store.revert(changed)}><Icon icon={RotateCcw} /> {ADJUST_TEXT.revert}</button>}
      </div>
      {scopes.length > 0 && (
        <div className="adjust-row" role="group" aria-label="一次動哪些">
          {scopes.map(s => (
            <button
              key={s.key}
              type="button"
              className={'adjust-chip' + (scope === s.key ? ' is-on' : '')}
              aria-pressed={scope === s.key}
              onClick={() => def.groupId && store.setScope(def.groupId, s.key)}
              title={s.key === 'left' || s.key === 'right' ? '照物件位置分（觀眾看過去的左右）' : undefined}
            >{scopeLabel(s.key, s.n)}</button>
          ))}
        </div>
      )}
      <ValueRow store={store} def={def} alt={alt} />
      {ids.length > 1 && <div className="adjust-ctl__readout">{togetherHint(ids.length)}</div>}
      {readout.map(t => <div key={t} className="adjust-ctl__readout">{t}</div>)}
    </div>
  );
}

/** 常用位置 + 滑桿 + 數字（一個機關；一起動的照整組 / 左右一起） */
function ValueRow({ store, def, alt, label }: { store: AdjustStore; def: Mechanism; alt: MutableRefObject<boolean>; label?: string }) {
  useSyncExternalStore(store.subscribe, store.getState);
  const v = store.value(def.id);
  const ids = store.driveIds(def.id);
  const dec = valueDecimals(def.kind);
  const shown = Number(v.toFixed(dec));
  const [text, setText] = useState<string | null>(null);
  const unit = def.kind === 'rotary' ? '°' : 'm';
  const commitText = () => {
    if (text === null) return;
    const n = Number(text.trim());
    setText(null);
    if (text.trim() !== '' && Number.isFinite(n)) store.setValue(def.id, n);
  };
  const atPreset = (pv: number) => ids.every(id => Math.abs(store.value(id) - pv) < 1e-6);
  return (
    <>
      {label && <div className="adjust-ctl__label">{label}{store.isChanged(def.id) ? '（改過）' : ''}</div>}
      {def.presets.length > 0 && (
        <div className="adjust-row" role="group" aria-label="常用位置">
          {def.presets.map(pr => (
            <button
              key={pr.name}
              type="button"
              className={'adjust-chip' + (atPreset(pr.value) ? ' is-on' : '')}
              onClick={() => store.applyPreset(def.id, pr.value)}
              title={`${pr.name}：${Number(pr.value.toFixed(dec))}${unit}`}
            >{pr.name}</button>
          ))}
        </div>
      )}
      <div className="adjust-slider">
        <input
          type="range"
          min={def.travelMin}
          max={def.travelMax}
          step="any"
          value={v}
          aria-label={`${label ?? def.name}的位置`}
          onPointerDown={() => store.beginDrag(def.id)}
          onChange={(e) => store.dragTo(def.id, Number(e.target.value), alt.current)}
          onPointerUp={() => store.endDrag()}
          onKeyUp={() => store.endDrag()}
          onBlur={() => store.endDrag()}
        />
        <label className="adjust-num">
          <input
            type="text"
            inputMode="decimal"
            value={text ?? String(shown)}
            aria-label={`${label ?? def.name}（${unit === '°' ? '度' : '公尺'}）`}
            onFocus={() => setText(String(shown))}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => { if (e.key === 'Enter') { commitText(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); } }}
          />
          <span>{unit}</span>
        </label>
      </div>
      <div className="adjust-ctl__range">{rangeText(def)}</div>
    </>
  );
}
