// 吊掛（機關 v2 第 4 階段）：新增 / 修改一整組吊掛的內容檢查。純判斷（不碰 DOM / three / React）：
// 前端（吊掛的表單）和後台（cf-worker/mechanisms.mjs 直接 import 這個 .ts）共用。
// 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 1、2、5 節 Stage 4）
//
// 一組吊掛 = 一個「整組」（variant = 'hoist_rig'，帶物件、自己沒有位置）+ 2～4 個「吊點」（variant = 'hoist'，往上的直線機關）。
// POST /mechanisms  body: { variant: 'hoist_rig', name, objectIds, parentId?, metadata?, hoists: [{ name?, attach, travelMin?, travelMax?, maxSpeed?, consoleLabel?, defaultValue?, presets? }], moveObjects? }
// PATCH /mechanisms/:rig body: 同上（都可以不送）；hoists 有送 = 整個換成這份清單：有 id 的改那個吊點、沒有 id 的新增、原本有卻沒列出來的刪掉（連同它在每個 cue 的位置）

import {
  MECH_LIMITS, MECH_MESSAGES, mechanismToInput, normalizeMechanismInput,
  type Mechanism, type MechanismField, type MechanismInput, type MechanismSibling,
} from './model.ts';
import { hoistGeometryProblem } from './hoist.ts';

/** 同一次新增整組吊掛時，吊點先指到這個還不存在的整組（後台建好整組之後換成真的 id） */
export const PENDING_RIG_ID = 'rig_new';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface HoistRigContext {
  /** 這個專案現有的機關（名稱重複、裝在哪個機關上要查） */
  siblings?: MechanismSibling[];
  projectObjectIds?: Set<string> | null;
  /** 修改：原本的整組和它的吊點 */
  existing?: { rig: Mechanism; hoists: Mechanism[] } | null;
}

export interface HoistPlanItem {
  /** 原本就有的吊點 id；新增 = null */
  id: string | null;
  input: MechanismInput;
}

export type HoistRigPlan =
  | {
    ok: true;
    value: {
      rig: MechanismInput;
      /** 這次要寫的吊點（照吊點編號）；hoists 沒送 = 空，吊點都不動 */
      hoists: HoistPlanItem[];
      /** 要刪掉的吊點 */
      removeIds: string[];
      /** 有送 hoists（吊點有可能新增 / 刪 / 改） */
      hoistsTouched: boolean;
    };
  }
  | { ok: false; error: string; field: MechanismField };

/** 吊點能改的欄位（其他欄位吊點固定：往上的直線、沒有物件） */
const HOIST_KEYS = ['name', 'attach', 'travelMin', 'travelMax', 'maxSpeed', 'consoleLabel', 'defaultValue', 'presets'] as const;
/** 整組能改的欄位 */
const RIG_KEYS = ['name', 'objectIds', 'parentId', 'metadata'] as const;

export function planHoistRig(raw: unknown, ctx: HoistRigContext = {}): HoistRigPlan {
  const r: Record<string, unknown> = isObj(raw) ? raw : {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined;
  const ex = ctx.existing ?? null;
  const fail = (field: MechanismField, error: string): HoistRigPlan => ({ ok: false, error, field });
  const exIds = new Set(ex ? [ex.rig.id, ...ex.hoists.map(h => h.id)] : []);
  // 整組和它的吊點之外的機關（名稱不能跟它們重複）
  const others: MechanismSibling[] = (ctx.siblings || []).filter(s => !exIds.has(s.id));

  // 整組
  const rigRaw: Record<string, unknown> = { variant: 'hoist_rig' };
  for (const k of RIG_KEYS) if (has(k)) rigRaw[k] = r[k];
  const rn = normalizeMechanismInput(rigRaw, {
    existing: ex ? mechanismToInput(ex.rig) : null, selfId: ex?.rig.id ?? null, siblings: others, projectObjectIds: ctx.projectObjectIds,
  });
  if (!rn.ok) return { ok: false, error: rn.error, field: rn.field };
  const rig = rn.value;
  if (rig.objectIds.length === 0) return fail('objectIds', MECH_MESSAGES.hoistObjects);

  // 吊點
  if (!has('hoists')) {
    if (ex) return { ok: true, value: { rig, hoists: [], removeIds: [], hoistsTouched: false } };
    return fail('hoists', MECH_MESSAGES.hoistCount);
  }
  const list = r.hoists;
  if (!Array.isArray(list) || list.length < MECH_LIMITS.hoistsMin || list.length > MECH_LIMITS.hoistsMax) return fail('hoists', MECH_MESSAGES.hoistCount);

  const rigId = ex ? ex.rig.id : PENDING_RIG_ID;
  const sibs: MechanismSibling[] = [...others, { id: rigId, name: rig.name, parentId: rig.parentId, variant: 'hoist_rig' }];
  const exById = new Map((ex?.hoists ?? []).map(h => [h.id, h]));
  const used = new Set<string>();
  const items: HoistPlanItem[] = [];
  for (let i = 0; i < list.length; i++) {
    const it = isObj(list[i]) ? list[i] as Record<string, unknown> : {};
    const id = typeof it.id === 'string' && it.id ? it.id : null;
    if (id && (!exById.has(id) || used.has(id))) return fail('hoists', MECH_MESSAGES.hoistForeign);
    if (id) used.add(id);
    const old = id ? exById.get(id)! : null;
    const input: Record<string, unknown> = { variant: 'hoist', rigId, rigIndex: i };
    for (const k of HOIST_KEYS) if (it[k] !== undefined) input[k] = it[k];
    const nameRaw = String(input.name ?? '').trim();
    input.name = nameRaw || old?.name || `${rig.name} 吊點 ${i + 1}`;
    if (!old) {
      // 新的吊點：行程預設 0 ~ 5 m（要拉高的距離）
      if (input.travelMin === undefined) input.travelMin = 0;
      if (input.travelMax === undefined) input.travelMax = 5;
    }
    const n = normalizeMechanismInput(input, {
      existing: old ? mechanismToInput(old) : null, selfId: id, siblings: sibs, projectObjectIds: ctx.projectObjectIds, pendingRigId: ex ? null : PENDING_RIG_ID,
    });
    if (!n.ok) return { ok: false, error: n.error, field: n.field === 'name' || n.field === 'travel' || n.field === 'attach' ? n.field : 'hoists' };
    sibs.push({ id: id ?? `__new_h${i}`, name: n.value.name, parentId: null, variant: 'hoist', rigId });
    items.push({ id, input: n.value });
  }
  const problem = hoistGeometryProblem(items.map(x => x.input.attach!));
  if (problem === 'same') return fail('attach', MECH_MESSAGES.hoistSame);
  if (problem === 'line') return fail('attach', MECH_MESSAGES.hoistLine);
  const removeIds = (ex?.hoists ?? []).filter(h => !used.has(h.id)).map(h => h.id);
  return { ok: true, value: { rig, hoists: items, removeIds, hoistsTouched: true } };
}
