// 還沒存的改動（草稿）：Cue 庫模式下，所有改畫面的動作都先放這裡，按「另存成新的 cue」或「更新」才寫進後台。
// 純函式，沒有網路、沒有畫面。規格：docs/superpowers/specs/2026-10-22-cue-library-design.md 5.1、5.4、第 10 節。
//
// 草稿記的是「這次動過的東西最後要變成什麼樣」：
//   物件：每個欄位（位置 / 角度 / 大小 / 顯示）的新值；null = 這個欄位回到預設；reset = 整個物件回到預設
//   機關：新的位置和時間；null = 這個機關回到預設（刪掉這一列）

import type { CueState, Euler, Vec3 } from './api';
import type { Look, LookMechRow, LookObjectRow, LookOwnField } from './cueLibraryApi';
import { resolveLibrarySongMechanisms, type ResolvedRow, type TrackMechanism } from './mechanisms/track';

export type ObjField = LookOwnField;
export interface DraftObject {
  /** 先把整個物件回到預設，再套下面的欄位 */
  reset?: boolean;
  position?: Vec3 | null;
  rotation?: Euler | null;
  scale?: Vec3 | null;
  visible?: boolean | null;
  customProps?: Record<string, unknown> | null;
}
export interface DraftMech { value: number; delaySec: number | null; durationSec: number | null }
export interface LookDraft {
  /** 這份草稿是改哪一個 Cue 庫的 cue */
  libId: string;
  objects: Record<string, DraftObject>;
  /** null = 這個機關回到預設 */
  mechanisms: Record<string, DraftMech | null>;
}

const FIELDS: ObjField[] = ['position', 'rotation', 'scale', 'visible', 'customProps'];

export function newDraft(libId: string): LookDraft { return { libId, objects: {}, mechanisms: {} }; }

/** 草稿裡有沒有任何動作（還沒跟原本的畫面比；要比用 summarizeDraft） */
export function draftHasOps(d: LookDraft | null | undefined): boolean {
  return !!d && (Object.keys(d.objects).length > 0 || Object.keys(d.mechanisms).length > 0);
}

/** 改一個物件的幾個欄位（null = 那個欄位回到預設） */
export function setObjectFields(d: LookDraft, objectId: string, patch: Omit<DraftObject, 'reset'>): LookDraft {
  const cur = d.objects[objectId] ?? {};
  return { ...d, objects: { ...d.objects, [objectId]: { ...cur, ...patch } } };
}

/** 整個物件回到預設（之前在草稿裡改的欄位也一起丟掉） */
export function resetObject(d: LookDraft, objectId: string): LookDraft {
  return { ...d, objects: { ...d.objects, [objectId]: { reset: true } } };
}

/** 設一個機關的位置和時間；null = 回到預設 */
export function setMechanism(d: LookDraft, mechId: string, entry: DraftMech | null): LookDraft {
  return { ...d, mechanisms: { ...d.mechanisms, [mechId]: entry } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function applyObjectOp(base: LookObjectRow | null, objectId: string, op: DraftObject): LookObjectRow | null {
  let row: LookObjectRow | null = op.reset ? null : (base ? { ...base, ownFields: [...base.ownFields] } : null);
  for (const f of FIELDS) {
    const v = op[f];
    if (v === undefined) continue;
    if (v === null) {
      if (!row) continue;
      (row as unknown as Record<string, unknown>)[f] = null;
      row.ownFields = row.ownFields.filter(x => x !== f);
    } else {
      if (!row) row = { objectId, position: null, rotation: null, scale: null, visible: null, customProps: null, own: true, ownFields: [] };
      (row as unknown as Record<string, unknown>)[f] = v;
      if (!row.ownFields.includes(f)) row.ownFields.push(f);
      row.own = true;
    }
  }
  if (!row) return null;
  // 全部欄位都空了 = 沒有這一列
  if (FIELDS.every(f => row![f] == null)) return null;
  return row;
}

/**
 * 把常用擺位的內容套進草稿：目前這個 cue 的畫面整個換成擺位裡的（擺位沒提到的物件 / 機關回到預設）。
 * 之前草稿裡的動作會被換掉（可以用復原拿回來）。tpl 是後台依這個專案的物件 / 機關 id 轉好的畫面。
 */
export function applyLookToDraft(libId: string, base: Look, tpl: Look): LookDraft {
  const objects: Record<string, DraftObject> = {};
  const inTpl = new Set<string>();
  for (const r of tpl.objects) {
    inTpl.add(r.objectId);
    const op: DraftObject = { reset: true };
    for (const f of ['position', 'rotation', 'scale', 'visible'] as const) {
      if (r[f] != null) (op as Record<string, unknown>)[f] = r[f];
    }
    objects[r.objectId] = op;
  }
  for (const r of base.objects) if (!inTpl.has(r.objectId)) objects[r.objectId] = { reset: true };
  const mechanisms: Record<string, DraftMech | null> = {};
  const mInTpl = new Set<string>();
  for (const m of tpl.mechanisms) {
    mInTpl.add(m.mechanismId);
    mechanisms[m.mechanismId] = { value: m.value, delaySec: m.delaySec, durationSec: m.durationSec };
  }
  for (const m of base.mechanisms) if (!mInTpl.has(m.mechanismId)) mechanisms[m.mechanismId] = null;
  return { libId, objects, mechanisms };
}

/** 原本的畫面 + 草稿 → 要寫進後台的畫面 */
export function applyDraftToLook(base: Look, d: LookDraft): Look {
  const objects: LookObjectRow[] = [];
  const seen = new Set<string>();
  for (const r of base.objects) {
    seen.add(r.objectId);
    const op = d.objects[r.objectId];
    if (!op) { objects.push(r); continue; }
    const next = applyObjectOp(r, r.objectId, op);
    if (next) objects.push(next);
  }
  for (const [id, op] of Object.entries(d.objects)) {
    if (seen.has(id)) continue;
    const next = applyObjectOp(null, id, op);
    if (next) objects.push(next);
  }
  const mechanisms: LookMechRow[] = [];
  const seenM = new Set<string>();
  for (const r of base.mechanisms) {
    seenM.add(r.mechanismId);
    if (!(r.mechanismId in d.mechanisms)) { mechanisms.push(r); continue; }
    const op = d.mechanisms[r.mechanismId];
    if (op) mechanisms.push({ mechanismId: r.mechanismId, value: op.value, delaySec: op.delaySec, durationSec: op.durationSec, carried: false });
  }
  for (const [id, op] of Object.entries(d.mechanisms)) {
    if (seenM.has(id) || !op) continue;
    mechanisms.push({ mechanismId: id, value: op.value, delaySec: op.delaySec, durationSec: op.durationSec, carried: false });
  }
  return { objects, mechanisms };
}

/** 「還沒存的改動：N 個物件、M 個機關」：跟原本的畫面一樣的動作不算（拖回原位 = 沒改） */
export function summarizeDraft(d: LookDraft | null | undefined, base: Look): { objects: number; mechanisms: number } {
  if (!d) return { objects: 0, mechanisms: 0 };
  const after = applyDraftToLook(base, d);
  const a = new Map(base.objects.map(r => [r.objectId, r]));
  const b = new Map(after.objects.map(r => [r.objectId, r]));
  let objects = 0;
  for (const id of Object.keys(d.objects)) if (!same(a.get(id) ?? null, b.get(id) ?? null)) objects++;
  const ma = new Map(base.mechanisms.map(r => [r.mechanismId, r]));
  const mb = new Map(after.mechanisms.map(r => [r.mechanismId, r]));
  let mechanisms = 0;
  for (const id of Object.keys(d.mechanisms)) if (!same(ma.get(id) ?? null, mb.get(id) ?? null)) mechanisms++;
  return { objects, mechanisms };
}

// ───────── 解出畫面（跟後台 cf-worker/cueLibrary.mjs 的 resolveLibraryObjectStates 一樣）─────────

type Source = 'default' | 'own' | 'carried';
export interface ObjectDefaults {
  objectId: string;
  defaultPosition: Vec3; defaultRotation: Euler; defaultScale: Vec3;
  defaultHidden: boolean;
}
export interface ResolvedObject {
  objectId: string;
  default: { position: Vec3; rotation: Euler; scale: Vec3 };
  defaultHidden: boolean;
  override: { position: Vec3 | null; rotation: Euler | null; scale: Vec3 | null; visible: boolean | null; customProps: Record<string, unknown> | null } | null;
  tracked: boolean;
  effective: { position: Vec3; rotation: Euler; scale: Vec3; visible: boolean };
  sources: { position: Source; rotation: Source; scale: Source; visible: Source };
}

export function resolveLook(objects: ObjectDefaults[], look: Look): ResolvedObject[] {
  const byObj = new Map(look.objects.map(r => [r.objectId, r]));
  return objects.map(o => {
    const r = byObj.get(o.objectId);
    const bits = r && r.own ? new Set<ObjField>(r.ownFields) : new Set<ObjField>();
    const src = (isSet: boolean, f: ObjField): Source => (!isSet ? 'default' : bits.has(f) ? 'own' : 'carried');
    return {
      objectId: o.objectId,
      default: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale },
      defaultHidden: o.defaultHidden,
      override: r && r.own ? {
        position: bits.has('position') ? r.position : null,
        rotation: bits.has('rotation') ? r.rotation : null,
        scale: bits.has('scale') ? r.scale : null,
        visible: bits.has('visible') && r.visible != null ? !!r.visible : null,
        customProps: bits.has('customProps') ? r.customProps : null,
      } : null,
      tracked: !!r && !r.own,
      effective: {
        position: r?.position ?? o.defaultPosition,
        rotation: r?.rotation ?? o.defaultRotation,
        scale: r?.scale ?? o.defaultScale,
        visible: r && r.visible != null ? !!r.visible : !o.defaultHidden,
      },
      sources: {
        position: src(r?.position != null, 'position'),
        rotation: src(r?.rotation != null, 'rotation'),
        scale: src(r?.scale != null, 'scale'),
        visible: src(r?.visible != null, 'visible'),
      },
    };
  });
}

/** 機關：一個 cue 的畫面解成每個機關的位置（跟後台 resolveSlotMechanisms 一樣） */
export function resolveLookMechanisms(mechs: TrackMechanism[], look: Look, slotId = 'slot'): ResolvedRow {
  const positions = look.mechanisms.map(m => ({ cueId: slotId, mechanismId: m.mechanismId, value: m.value, carried: m.carried }));
  return resolveLibrarySongMechanisms(mechs, [{ id: slotId, order: 0, status: 'master' }], positions).get(slotId) ?? {};
}

// ───────── 畫面上顯示用：原本的物件狀態 + 草稿 ─────────

export function applyDraftToStates(states: CueState[], d: LookDraft | null | undefined): CueState[] {
  if (!d || Object.keys(d.objects).length === 0) return states;
  return states.map(s => {
    const op = d.objects[s.objectId];
    if (!op) return s;
    const defVisible = !s.defaultHidden;
    let ov: NonNullable<CueState['override']> | null = op.reset ? null : (s.override ? { ...s.override } : null);
    const eff = { ...s.effective };
    if (op.reset) {
      eff.position = s.default.position; eff.rotation = s.default.rotation; eff.scale = s.default.scale; eff.visible = defVisible;
    }
    for (const f of FIELDS) {
      const v = op[f];
      if (v === undefined) continue;
      if (!ov) ov = { position: null, rotation: null, scale: null, visible: null, customProps: null, updatedAt: '' };
      (ov as unknown as Record<string, unknown>)[f] = v;
      if (f === 'customProps') continue;
      const fallback = f === 'visible' ? defVisible : s.default[f as 'position' | 'rotation' | 'scale'];
      (eff as unknown as Record<string, unknown>)[f] = v === null ? fallback : v;
    }
    if (ov && FIELDS.every(f => ov![f] == null)) ov = null;
    return { ...s, override: ov, effective: eff };
  });
}

// ───────── 草稿的復原 / 重做（整份草稿存成一步一步的樣子）─────────

export interface DraftHistory { present: LookDraft | null; past: (LookDraft | null)[]; future: (LookDraft | null)[] }
export const emptyHistory = (): DraftHistory => ({ present: null, past: [], future: [] });
const HISTORY_LIMIT = 100;

export function historyPush(h: DraftHistory, next: LookDraft | null): DraftHistory {
  return { present: next, past: [...h.past, h.present].slice(-HISTORY_LIMIT), future: [] };
}
export function historyUndo(h: DraftHistory): DraftHistory {
  if (h.past.length === 0) return h;
  return { present: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.present, ...h.future] };
}
export function historyRedo(h: DraftHistory): DraftHistory {
  if (h.future.length === 0) return h;
  return { present: h.future[0], past: [...h.past, h.present], future: h.future.slice(1) };
}

// ───────── 編號（跟後台 suggestLabel / validateLabel 一樣）─────────

export const LABEL_MAX = 16;
export function suggestLabel(existing: string[]): string {
  let max = 0;
  for (const l of existing || []) {
    const m = /^\s*(\d+)/.exec(String(l ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1);
}
/** 回 null = 可以用；不然回要顯示的中文錯誤 */
export function labelError(input: string, existing: string[]): string | null {
  const label = String(input ?? '').trim();
  if (!label) return '編號不能空白';
  if ([...label].length > LABEL_MAX) return `編號最多 ${LABEL_MAX} 個字`;
  const key = label.toLowerCase();
  if (existing.some(e => String(e ?? '').trim().toLowerCase() === key)) return '這個編號已經有了';
  return null;
}
