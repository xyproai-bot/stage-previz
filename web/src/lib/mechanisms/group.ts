// 一排機關（機關 v2 第 3 階段）：一次建立 N 個機關、編號順序、這一排的共用設定、清單怎麼排、一次寫很多個 cue 位置的內容檢查。
// 純判斷（不碰 DOM / three / React）：前端（建立的畫面）和後台（cf-worker/mechanisms.mjs 直接 import 這個 .ts）共用。
// 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 2、5 節 Stage 3）
//
// 一排裡的每個機關都是普通機關（自己的物件、行程、速度、控台編號、每個 cue 一列位置）；
// 「一排」只是把它們放在一起（名字、順序），花樣（patterns.ts）一次幫每個機關算好這個 cue 的位置和延遲。

import {
  MECH_LIMITS, MECH_MESSAGES, audienceRight, horizontalFront, mechanismToInput, normalizeMechanismInput, parseTimingSeconds,
  type GroupNumbering, type Mechanism, type MechanismField, type MechanismGroup, type MechanismGroupSettings, type MechanismInput,
  type MechanismSibling, type MechVec3,
} from './model.ts';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const dot = (a: MechVec3, b: MechVec3) => a.x * b.x + a.y * b.y + a.z * b.z;

// ─────────────────────────────────────────────
// 編號順序（「LED 升降 1…8」誰是 1）
// ─────────────────────────────────────────────

export const NUMBERING_OPTIONS: { key: GroupNumbering; label: string }[] = [
  { key: 'leftToRight', label: '從左到右' },
  { key: 'rightToLeft', label: '從右到左' },
  { key: 'frontToBack', label: '從前到後' },
  { key: 'selection', label: '照選取順序' },
];

export function isNumbering(v: unknown): v is GroupNumbering {
  return v === 'leftToRight' || v === 'rightToLeft' || v === 'frontToBack' || v === 'selection';
}

/**
 * 把選到的物件照編號順序排好：
 *   從左到右 / 從右到左：觀眾看過去的左右（沿著「觀眾的右手邊」）；
 *   從前到後：最靠近觀眾的是 1，往舞台後方數；
 *   照選取順序：照傳進來的順序。
 * centers：物件 id → 中心（場景座標）。位置一樣的、找不到位置的，照選取順序排在後面（穩定）。
 */
export function orderForNumbering(
  ids: string[], centers: Record<string, MechVec3 | undefined>, numbering: GroupNumbering, front: MechVec3 | null | undefined,
): string[] {
  if (numbering === 'selection') return [...ids];
  const f = horizontalFront(front);
  const right = audienceRight(f);
  const key = (id: string): number | null => {
    const c = centers[id];
    if (!c) return null;
    if (numbering === 'leftToRight') return dot(c, right);
    if (numbering === 'rightToLeft') return -dot(c, right);
    return -dot(c, f);   // 從前到後：往觀眾那頭（正面）越大越前面
  };
  const EPS = 1e-6;
  return ids
    .map((id, i) => ({ id, i, k: key(id) }))
    .sort((a, b) => {
      if (a.k === null || b.k === null) return a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1;
      return Math.abs(a.k - b.k) < EPS ? a.i - b.i : a.k - b.k;
    })
    .map(x => x.id);
}

/** 「LED 升降」第 3 個 → 「LED 升降 3」 */
export function memberName(prefix: string, index: number): string {
  return `${prefix.trim()} ${index + 1}`;
}

/** 名稱開頭最多幾個字（後面還要接空格和編號，機關名稱最多 40 字） */
export function maxPrefixLength(count: number): number {
  return MECH_LIMITS.nameMax - 1 - String(Math.max(1, count)).length;
}

// ─────────────────────────────────────────────
// 一次建立 N 個機關
// ─────────────────────────────────────────────

export type GroupField = MechanismField | 'numbering';

export interface BatchContext {
  /** 這個專案現有的機關（名稱重複、裝在哪個機關上要查） */
  siblings?: MechanismSibling[];
  projectObjectIds?: Set<string> | null;
  /** 這個專案現有的「一排」名稱 */
  groupNames?: string[];
}

export type BatchPlan =
  | { ok: true; value: { groupName: string; settings: MechanismGroupSettings; members: MechanismInput[] } }
  | { ok: false; error: string; field: GroupField };

/**
 * POST …/mechanisms/batch 的內容：
 *   base        每個機關共用的設定（方向、行程、最高速度、常用位置、預設位置、裝在哪個機關上、metadata…）；不能是對開
 *   objectIds   一個物件一個機關，照這個順序編 1、2、3…（前端已經照「編號順序」排好）
 *   namePrefix  名稱開頭：「LED 升降」→「LED 升降 1」「LED 升降 2」…
 *   groupName   這一排的名字（沒給 = 名稱開頭）
 *   numbering   建立時選的編號順序（只是記下來，編輯時看得到）
 *   overrides   { [物件 id]: { axis?, pivot? } }：沿著邊緣翻的轉軸要照每個物件自己的外框算，所以每個物件可以有自己的轉軸
 * 每個機關都用跟單獨新增一樣的規則檢查（第一個錯誤就停）。
 */
export function planBatch(raw: unknown, ctx: BatchContext = {}): BatchPlan {
  const r: Record<string, unknown> = isObj(raw) ? raw : {};
  const fail = (field: GroupField, error: string): BatchPlan => ({ ok: false, error, field });

  const ids: string[] = [];
  if (Array.isArray(r.objectIds)) {
    const seen = new Set<string>();
    for (const id of r.objectIds) {
      if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length < 2) return fail('objectIds', MECH_MESSAGES.groupMin);
  if (ids.length > MECH_LIMITS.groupMembersMax) return fail('objectIds', MECH_MESSAGES.groupMax);
  if (ctx.projectObjectIds && ids.some(id => !ctx.projectObjectIds!.has(id))) return fail('objectIds', MECH_MESSAGES.objectsForeign);

  const prefix = String(r.namePrefix ?? '').trim();
  if (!prefix) return fail('namePrefix', MECH_MESSAGES.nameEmpty);
  const maxPrefix = maxPrefixLength(ids.length);
  if (prefix.length > maxPrefix) return fail('namePrefix', MECH_MESSAGES.groupPrefixLong(maxPrefix));

  const groupName = String(r.groupName ?? '').trim() || prefix;
  if (groupName.length > MECH_LIMITS.groupNameMax) return fail('groupName', MECH_MESSAGES.groupNameLong);
  if ((ctx.groupNames || []).some(n => n.trim() === groupName)) return fail('groupName', MECH_MESSAGES.groupNameTaken(groupName));

  const base: Record<string, unknown> = isObj(r.base) ? r.base : {};
  if (base.variant !== undefined && base.variant !== null) return fail('variant', MECH_MESSAGES.groupSplit);
  const overrides: Record<string, unknown> = isObj(r.overrides) ? r.overrides : {};

  const sibs: MechanismSibling[] = [...(ctx.siblings || [])];
  const members: MechanismInput[] = [];
  for (let i = 0; i < ids.length; i++) {
    const ov = isObj(overrides[ids[i]]) ? overrides[ids[i]] as Record<string, unknown> : {};
    const input: Record<string, unknown> = {
      ...base, name: memberName(prefix, i), objectIds: [ids[i]], variant: null, mirror: null, objectSides: {}, consoleLabel: null,
    };
    if (ov.axis !== undefined) input.axis = ov.axis;
    if (ov.pivot !== undefined) input.pivot = ov.pivot;
    const n = normalizeMechanismInput(input, { siblings: sibs, projectObjectIds: ctx.projectObjectIds });
    if (!n.ok) return fail(n.field, n.error);
    members.push(n.value);
    sibs.push({ id: `__new_${i}`, name: n.value.name, parentId: null, variant: null });
  }
  const settings: MechanismGroupSettings = { namePrefix: prefix };
  if (isNumbering(r.numbering)) settings.numbering = r.numbering;
  return { ok: true, value: { groupName, settings, members } };
}

// ─────────────────────────────────────────────
// 這一排的共用設定（改一次、每個成員都改）
// ─────────────────────────────────────────────

/** 共用設定能改的欄位（其他欄位每個機關各自改：物件、方向、控台編號、名稱） */
export const GROUP_SHARED_KEYS = ['travelMin', 'travelMax', 'defaultValue', 'maxSpeed', 'presets'] as const;

export interface GroupPatchContext {
  /** 這個專案現有的機關（裝在哪個機關上的檢查要用） */
  siblings?: MechanismSibling[];
  /** 這個專案其他「一排」的名稱（改名不能跟它們重複） */
  otherGroupNames?: string[];
}

export type GroupPatchPlan =
  | { ok: true; value: { name: string | null; shared: boolean; members: { id: string; input: MechanismInput }[] } }
  | { ok: false; error: string; field: GroupField };

/**
 * PATCH …/mechanism-groups/:g 的內容：name（這一排的名字）和共用設定（行程、預設位置、最高速度、常用位置）。
 * 共用設定每個成員都用單獨修改的規則再檢查一次（行程超出的 cue 位置不會被改掉，只是播放時夾在行程內）。
 */
export function planGroupPatch(raw: unknown, members: Mechanism[], ctx: GroupPatchContext = {}): GroupPatchPlan {
  const r: Record<string, unknown> = isObj(raw) ? raw : {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined;
  let name: string | null = null;
  if (has('name')) {
    name = String(r.name ?? '').trim();
    if (!name) return { ok: false, error: MECH_MESSAGES.groupNameEmpty, field: 'groupName' };
    if (name.length > MECH_LIMITS.groupNameMax) return { ok: false, error: MECH_MESSAGES.groupNameLong, field: 'groupName' };
    if ((ctx.otherGroupNames || []).some(n => n.trim() === name)) return { ok: false, error: MECH_MESSAGES.groupNameTaken(name), field: 'groupName' };
  }
  const patch: Record<string, unknown> = {};
  for (const k of GROUP_SHARED_KEYS) if (has(k)) patch[k] = r[k];
  const shared = Object.keys(patch).length > 0;
  const out: { id: string; input: MechanismInput }[] = [];
  if (shared) {
    for (const m of members) {
      const n = normalizeMechanismInput(patch, { existing: mechanismToInput(m), selfId: m.id, siblings: ctx.siblings || [] });
      if (!n.ok) return { ok: false, error: n.error, field: n.field };
      out.push({ id: m.id, input: n.value });
    }
  }
  return { ok: true, value: { name, shared, members: out } };
}

// ─────────────────────────────────────────────
// 清單怎麼排（機關分頁的設定清單、機關時間軸）
// ─────────────────────────────────────────────

/** 一排的成員（照 groupIndex 排，一樣的照機關原本的順序） */
export function groupMembers(mechanisms: Mechanism[], groupId: string): Mechanism[] {
  return mechanisms
    .map((m, i) => ({ m, i }))
    .filter(x => x.m.groupId === groupId)
    .sort((a, b) => ((a.m.groupIndex ?? 1e9) - (b.m.groupIndex ?? 1e9)) || (a.i - b.i))
    .map(x => x.m);
}

export type LayoutItem =
  | { type: 'single'; mech: Mechanism }
  | { type: 'group'; group: MechanismGroup; members: Mechanism[] };

/**
 * 機關清單 → 要畫的順序：一排排在它第一個成員的位置，後面接它所有的成員；
 * 舊後台（沒有 groups）、成員指到不存在的一排 → 當一個一個普通機關。
 */
export function layoutMechanisms(mechanisms: Mechanism[], groups: MechanismGroup[]): LayoutItem[] {
  const byId = new Map(groups.map(g => [g.id, g]));
  const done = new Set<string>();
  const out: LayoutItem[] = [];
  for (const m of mechanisms) {
    const g = m.groupId ? byId.get(m.groupId) : undefined;
    if (!g) { out.push({ type: 'single', mech: m }); continue; }
    if (done.has(g.id)) continue;
    done.add(g.id);
    out.push({ type: 'group', group: g, members: groupMembers(mechanisms, g.id) });
  }
  return out;
}

/** 清單 → 機關 id 的順序（一排的成員連在一起，照 groupIndex） */
export function flattenLayout(items: LayoutItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.type === 'single') out.push(it.mech.id);
    else for (const m of it.members) out.push(m.id);
  }
  return out;
}

/**
 * 清單上的一項（一個機關或一整排）往上 / 下移一格 → 新的機關 id 順序；已經在最上 / 最下 → null。
 * 一排整塊一起移，不會被拆散。
 */
export function moveLayoutItem(items: LayoutItem[], index: number, dir: -1 | 1): string[] | null {
  const j = index + dir;
  if (index < 0 || index >= items.length || j < 0 || j >= items.length) return null;
  const next = [...items];
  [next[index], next[j]] = [next[j], next[index]];
  return flattenLayout(next);
}

/** 這一排在這個 cue 的位置範圍（下限、上限；給「這個 cue」那一列的摘要用） */
export function valueRange(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

// ─────────────────────────────────────────────
// 一次寫很多個 cue 位置（花樣）
// ─────────────────────────────────────────────

/** 一列：機關 id、位置（null = 回到沿用，刪掉這個 cue 自己的那一列）、延遲 / 走幾秒（沒放 = 不改；null = 跟著 cue） */
export interface BulkPositionItem {
  mechanismId: string;
  value: number | null;
  delaySec?: number | null;
  durationSec?: number | null;
}

export type BulkParse =
  | { ok: true; items: BulkPositionItem[] }
  | { ok: false; error: string; field: 'items' | 'value' | 'delaySec' | 'durationSec' };

/** PUT …/cues/:c/mechanism-positions 的內容 { items: [...] }：1~200 列、同一個機關只能一列 */
export function parseBulkPositions(raw: unknown): BulkParse {
  const r: Record<string, unknown> = isObj(raw) ? raw : {};
  if (!Array.isArray(r.items) || r.items.length === 0) return { ok: false, error: MECH_MESSAGES.bulkItem, field: 'items' };
  if (r.items.length > MECH_LIMITS.bulkPositionsMax) return { ok: false, error: MECH_MESSAGES.bulkItems, field: 'items' };
  const seen = new Set<string>();
  const items: BulkPositionItem[] = [];
  for (const it of r.items) {
    if (!isObj(it) || typeof it.mechanismId !== 'string' || !ID_RE.test(it.mechanismId)) return { ok: false, error: MECH_MESSAGES.bulkItem, field: 'items' };
    if (seen.has(it.mechanismId)) return { ok: false, error: MECH_MESSAGES.bulkDuplicate, field: 'items' };
    seen.add(it.mechanismId);
    const out: BulkPositionItem = { mechanismId: it.mechanismId, value: null };
    if (it.value !== null) {
      const v = typeof it.value === 'number' ? it.value : typeof it.value === 'string' && it.value.trim() !== '' ? Number(it.value) : NaN;
      if (!Number.isFinite(v)) return { ok: false, error: MECH_MESSAGES.value, field: 'value' };
      out.value = v;
    }
    if (it.delaySec !== undefined) {
      const d = parseTimingSeconds(it.delaySec);
      if (!d.ok) return { ok: false, error: MECH_MESSAGES.delay, field: 'delaySec' };
      out.delaySec = d.value;
    }
    if (it.durationSec !== undefined) {
      const d = parseTimingSeconds(it.durationSec);
      if (!d.ok) return { ok: false, error: MECH_MESSAGES.duration, field: 'durationSec' };
      out.durationSec = d.value;
    }
    items.push(out);
  }
  return { ok: true, items };
}
