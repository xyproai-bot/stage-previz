// 機關（升降台、轉台、滑軌…會動的舞台機械）的資料格式、檢查規則、方向選項、舊滑桿換算。
// 設計：docs/superpowers/specs/2026-10-14-mechanism-system-design.md（第 4 節）
//
// 這個檔案前端和後端（cf-worker/mechanisms.mjs 直接 import 這個 .ts）共用，
// 所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / React / three、
// 不用 enum / namespace / 建構子參數屬性這類要編譯的寫法（Node 24 直接跑 .ts）。
//
// 一個機關的「位置」是一個數字，從物件在 cue 裡原本的位置算起：
//   直線移動 → 公尺（0 = cue 放的位置，數字變大往「方向」走）
//   旋轉     → 度（0 = cue 放的角度，照「轉軸」右手定則轉）
// 模型的縮放永遠不動；公尺 → 場景單位用專案的測距校準倍率換算。

export type MechanismKind = 'linear' | 'rotary';
export interface MechanismPreset { name: string; value: number }
/** 這個檔案不能 import，所以自己定一個 {x,y,z}（跟 api.ts 的 Vec3 一樣） */
export interface MechVec3 { x: number; y: number; z: number }

export interface Mechanism {
  id: string;
  name: string;
  kind: MechanismKind;
  /** 單位向量，場景座標（Y 朝上）：直線 = 數字變大往哪；旋轉 = 轉軸 */
  axis: MechVec3;
  /** 旋轉中心（場景單位，跟 cue 位置同一種單位）；直線 = null */
  pivot: MechVec3 | null;
  /** 行程（直線：公尺；旋轉：度） */
  travelMin: number;
  travelMax: number;
  /** 沒有 cue 設定時的位置 */
  defaultValue: number;
  /** 最高速度（公尺/秒、度/秒）；null = 不檢查速度，照轉場秒數移動 */
  maxSpeed: number | null;
  /** 常用位置（照數字排好） */
  presets: MechanismPreset[];
  /** 裝在哪個機關上（跟著那個機關一起動） */
  parentId: string | null;
  /** 帶哪些物件（一個物件只能直接放在一個機關） */
  objectIds: string[];
  /** 自動化控台上的軸名（匯出機關總表用） */
  consoleLabel: string | null;
  order: number;
  /** 之後放加減速、碰撞外框等；現在 null */
  metadata: Record<string, unknown> | null;
  /** 幾個 cue 有自己設定的位置（刪除確認、設定清單用） */
  cueCount: number;
  updatedAt: string;
}

/** mechanismId → 位置 */
export type MechanismValues = Record<string, number>;

export interface CueMechanismPosition { cueId: string; mechanismId: string; value: number; updatedAt: string }

/** 新增 / 修改機關時送的內容（檢查完的樣子） */
export interface MechanismInput {
  name: string;
  kind: MechanismKind;
  axis: MechVec3;
  pivot: MechVec3 | null;
  travelMin: number;
  travelMax: number;
  defaultValue: number;
  maxSpeed: number | null;
  presets: MechanismPreset[];
  parentId: string | null;
  objectIds: string[];
  consoleLabel: string | null;
  metadata: Record<string, unknown> | null;
}

export const MECH_LIMITS = {
  nameMax: 40,
  presetNameMax: 20,
  presetsMax: 12,
  objectsMax: 200,
  /** 機關一層套一層最多幾層（自己也算一層） */
  depthMax: 4,
  consoleLabelMax: 40,
  /** 行程上下限：直線 ±1000 公尺；旋轉 ±36000 度（可以轉很多圈） */
  linearTravelAbs: 1000,
  rotaryTravelAbs: 36000,
  /** 最高速度上限：直線 100 公尺/秒；旋轉 3600 度/秒 */
  linearSpeedMax: 100,
  rotarySpeedMax: 3600,
  pivotAbs: 1e5,
} as const;

/** 給畫面用：單位 */
export function unitOf(kind: MechanismKind): 'm' | '°' {
  return kind === 'rotary' ? '°' : 'm';
}
export function speedUnitOf(kind: MechanismKind): string {
  return kind === 'rotary' ? '°/秒' : 'm/秒';
}
/** 數字顯示幾位小數：公尺最多 3 位（毫米）、度 1 位 */
export function valueDecimals(kind: MechanismKind): number {
  return kind === 'rotary' ? 1 : 3;
}

export function clampValue(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return Math.min(Math.max(0, min), max);
  return v < min ? min : v > max ? max : v;
}

const EPS = 1e-9;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

function vec3(v: unknown): MechVec3 | null {
  if (!isObj(v)) return null;
  const x = num(v.x), y = num(v.y), z = num(v.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function normalize(v: MechVec3): MechVec3 | null {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!(len > 1e-6)) return null;
  const r = (n: number) => { const o = n / len; return Math.abs(o) < 1e-12 ? 0 : o; };
  return { x: r(v.x), y: r(v.y), z: r(v.z) };
}

// ─────────────────────────────────────────────
// 檢查（管理頁先擋、後台最後再檢查一次）
// ─────────────────────────────────────────────

export type MechanismField =
  | 'name' | 'kind' | 'axis' | 'pivot' | 'travel' | 'maxSpeed' | 'presets' | 'objectIds' | 'parentId';

export const MECH_MESSAGES = {
  nameEmpty: '機關名稱不能空白',
  nameTaken: (name: string) => `這個專案已經有叫「${name}」的機關`,
  kind: '機關類型不正確',
  axis: '方向不正確',
  pivot: '轉軸中心要是數字',
  travelOrder: '行程的最高要比最低大',
  travelNumber: '行程要填數字',
  maxSpeed: '最高速度要是正的數字，或留空不檢查',
  presetsMax: '常用位置最多 12 個',
  presetDuplicate: (name: string) => `常用位置的名稱重複了：「${name}」`,
  objectsMax: '一個機關最多帶 200 個物件',
  objectsForeign: '有物件不在這個專案裡',
  parentCycle: '不能選自己，或裝在自己上面的機關',
  parentDepth: '機關一層套一層最多 4 層',
  parentMissing: '找不到要裝上去的機關',
  value: '位置要是數字',
} as const;

/** 專案裡其他機關（檢查名稱重複、裝在哪個機關上） */
export interface MechanismSibling { id: string; name: string; parentId: string | null }

export interface NormalizeContext {
  /** 修改：原本的機關（沒送的欄位用原本的） */
  existing?: MechanismInput | null;
  /** 修改：自己的 id（名稱重複、繞圈檢查要排除自己） */
  selfId?: string | null;
  /** 這個專案的所有機關（含自己也沒關係，會用 selfId 排除） */
  siblings?: MechanismSibling[];
  /** 這個專案的所有物件 id（有給才檢查「物件在不在這個專案」） */
  projectObjectIds?: Set<string> | null;
}

export type NormalizeResult =
  | { ok: true; value: MechanismInput }
  | { ok: false; error: string; field: MechanismField; errors: Partial<Record<MechanismField, string>> };

/** 機關的樣子（從 API 讀回來的 / 新增時的預設）→ MechanismInput */
export function mechanismToInput(m: Pick<Mechanism, keyof MechanismInput>): MechanismInput {
  return {
    name: m.name, kind: m.kind, axis: { ...m.axis }, pivot: m.pivot ? { ...m.pivot } : null,
    travelMin: m.travelMin, travelMax: m.travelMax, defaultValue: m.defaultValue, maxSpeed: m.maxSpeed,
    presets: m.presets.map(p => ({ ...p })), parentId: m.parentId, objectIds: [...m.objectIds],
    consoleLabel: m.consoleLabel, metadata: m.metadata,
  };
}

/** 新機關的預設值（直線、往上、0 ~ 1 m） */
export function blankMechanismInput(): MechanismInput {
  return {
    name: '', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null,
    travelMin: 0, travelMax: 1, defaultValue: 0, maxSpeed: null, presets: [], parentId: null,
    objectIds: [], consoleLabel: null, metadata: null,
  };
}

/**
 * 檢查 + 整理一個機關的設定。修改時只送要改的欄位（其他用 ctx.existing），整個再檢查一次。
 * 回傳第一個錯誤（error / field）和每個欄位的錯誤（errors，畫面在欄位旁邊顯示）。
 */
export function normalizeMechanismInput(raw: unknown, ctx: NormalizeContext = {}): NormalizeResult {
  const r: Record<string, unknown> = isObj(raw) ? raw : {};
  const base = ctx.existing ?? blankMechanismInput();
  const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined;
  const errors: Partial<Record<MechanismField, string>> = {};
  const fail = (f: MechanismField, m: string) => { if (!errors[f]) errors[f] = m; };

  // 名稱
  const name = (has('name') ? String(r.name ?? '') : base.name).trim().slice(0, MECH_LIMITS.nameMax);
  if (!name) fail('name', MECH_MESSAGES.nameEmpty);
  else if ((ctx.siblings || []).some(s => s.id !== ctx.selfId && s.name.trim() === name)) {
    fail('name', MECH_MESSAGES.nameTaken(name));
  }

  // 類型
  const kindRaw = has('kind') ? r.kind : base.kind;
  const kind: MechanismKind = kindRaw === 'rotary' ? 'rotary' : 'linear';
  if (kindRaw !== 'linear' && kindRaw !== 'rotary') fail('kind', MECH_MESSAGES.kind);

  // 方向 / 轉軸
  const axisRaw = has('axis') ? vec3(r.axis) : base.axis;
  const axis = axisRaw ? normalize(axisRaw) : null;
  if (!axis) fail('axis', MECH_MESSAGES.axis);

  // 轉軸中心（旋轉才有；直線一律 null）
  let pivot: MechVec3 | null = null;
  if (kind === 'rotary') {
    const p = has('pivot') ? r.pivot : base.pivot;
    if (p === null || p === undefined) pivot = { x: 0, y: 0, z: 0 };
    else {
      pivot = vec3(p);
      if (!pivot || [pivot.x, pivot.y, pivot.z].some(c => Math.abs(c) > MECH_LIMITS.pivotAbs)) {
        fail('pivot', MECH_MESSAGES.pivot);
        pivot = null;
      }
    }
  }

  // 行程（超過上下限就收到上下限）
  const limit = kind === 'rotary' ? MECH_LIMITS.rotaryTravelAbs : MECH_LIMITS.linearTravelAbs;
  const tMinRaw = num(has('travelMin') ? r.travelMin : base.travelMin);
  const tMaxRaw = num(has('travelMax') ? r.travelMax : base.travelMax);
  let travelMin = 0, travelMax = 1;
  if (!Number.isFinite(tMinRaw) || !Number.isFinite(tMaxRaw)) fail('travel', MECH_MESSAGES.travelNumber);
  else {
    travelMin = Math.max(-limit, Math.min(limit, tMinRaw));
    travelMax = Math.max(-limit, Math.min(limit, tMaxRaw));
    if (!(travelMax > travelMin)) fail('travel', MECH_MESSAGES.travelOrder);
  }
  const travelOk = !errors.travel;
  const clamp = (v: number) => (travelOk ? clampValue(v, travelMin, travelMax) : v);

  // 預設位置（夾在行程內）
  const dRaw = num(has('defaultValue') ? r.defaultValue : base.defaultValue);
  const defaultValue = clamp(Number.isFinite(dRaw) ? dRaw : 0);

  // 最高速度
  let maxSpeed: number | null = null;
  const sRaw = has('maxSpeed') ? r.maxSpeed : base.maxSpeed;
  if (sRaw !== null && sRaw !== undefined && sRaw !== '') {
    const s = num(sRaw);
    const sMax = kind === 'rotary' ? MECH_LIMITS.rotarySpeedMax : MECH_LIMITS.linearSpeedMax;
    if (!Number.isFinite(s) || !(s > 0) || s > sMax) fail('maxSpeed', MECH_MESSAGES.maxSpeed);
    else maxSpeed = s;
  }

  // 常用位置：沒名稱 / 不是數字的那一列略過；名稱最多 20 字、不能重複；數字夾在行程內；照數字排
  const presetsRaw = has('presets') ? r.presets : base.presets;
  const presets: MechanismPreset[] = [];
  if (Array.isArray(presetsRaw)) {
    const seen = new Set<string>();
    for (const p of presetsRaw) {
      if (!isObj(p)) continue;
      const pname = String(p.name ?? '').trim().slice(0, MECH_LIMITS.presetNameMax);
      const pv = num(p.value);
      if (!pname || !Number.isFinite(pv)) continue;
      if (seen.has(pname)) { fail('presets', MECH_MESSAGES.presetDuplicate(pname)); continue; }
      seen.add(pname);
      presets.push({ name: pname, value: clamp(pv) });
    }
    if (presets.length > MECH_LIMITS.presetsMax) fail('presets', MECH_MESSAGES.presetsMax);
  }
  presets.sort((a, b) => a.value - b.value);

  // 帶哪些物件
  const objRaw = has('objectIds') ? r.objectIds : base.objectIds;
  const objectIds: string[] = [];
  if (Array.isArray(objRaw)) {
    const seen = new Set<string>();
    for (const id of objRaw) {
      if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      objectIds.push(id);
    }
  }
  if (objectIds.length > MECH_LIMITS.objectsMax) fail('objectIds', MECH_MESSAGES.objectsMax);
  else if (ctx.projectObjectIds && objectIds.some(id => !ctx.projectObjectIds!.has(id))) {
    fail('objectIds', MECH_MESSAGES.objectsForeign);
  }

  // 裝在哪個機關上
  const parRaw = has('parentId') ? r.parentId : base.parentId;
  const parentId = typeof parRaw === 'string' && parRaw ? parRaw : null;
  if (parentId) {
    const siblings = ctx.siblings || [];
    const check = parentCheck(ctx.selfId ?? null, parentId, siblings);
    if (check === 'missing') fail('parentId', MECH_MESSAGES.parentMissing);
    else if (check === 'cycle') fail('parentId', MECH_MESSAGES.parentCycle);
    else if (check === 'depth') fail('parentId', MECH_MESSAGES.parentDepth);
  }

  const clRaw = has('consoleLabel') ? r.consoleLabel : base.consoleLabel;
  const consoleLabel = typeof clRaw === 'string' && clRaw.trim() ? clRaw.trim().slice(0, MECH_LIMITS.consoleLabelMax) : null;

  const mdRaw = has('metadata') ? r.metadata : base.metadata;
  const metadata = isObj(mdRaw) ? mdRaw : null;

  const order: MechanismField[] = ['name', 'kind', 'axis', 'pivot', 'travel', 'maxSpeed', 'presets', 'objectIds', 'parentId'];
  const first = order.find(f => errors[f]);
  if (first) return { ok: false, error: errors[first]!, field: first, errors };
  return {
    ok: true,
    value: {
      name, kind, axis: axis!, pivot, travelMin, travelMax, defaultValue, maxSpeed, presets, parentId,
      objectIds, consoleLabel, metadata,
    },
  };
}

/**
 * 把 selfId 裝到 parentId 上可不可以：
 *   'missing' 找不到；'cycle' 選自己或裝在自己下面的機關上（會繞圈）；'depth' 超過 4 層；null = 可以
 * 深度 = 上面幾層 + 自己 + 下面最深幾層
 */
export function parentCheck(
  selfId: string | null, parentId: string, siblings: MechanismSibling[],
): 'missing' | 'cycle' | 'depth' | null {
  if (selfId && parentId === selfId) return 'cycle';
  const byId = new Map(siblings.map(s => [s.id, s]));
  if (!byId.has(parentId)) return 'missing';
  // 往上走：碰到自己 = 繞圈
  let above = 0;
  const seen = new Set<string>();
  for (let cur: string | null = parentId; cur; cur = byId.get(cur)?.parentId ?? null) {
    if (cur === selfId) return 'cycle';
    if (seen.has(cur)) return 'cycle';  // 資料本來就繞圈
    seen.add(cur);
    above++;
    if (above > MECH_LIMITS.depthMax) break;
  }
  // 往下：自己底下最深幾層（自己算 1）
  const below = selfId ? subtreeHeight(selfId, siblings) : 1;
  return above + below > MECH_LIMITS.depthMax ? 'depth' : null;
}

function subtreeHeight(rootId: string, siblings: MechanismSibling[]): number {
  const children = new Map<string, string[]>();
  for (const s of siblings) {
    if (!s.parentId || s.parentId === s.id) continue;
    const list = children.get(s.parentId) || [];
    list.push(s.id);
    children.set(s.parentId, list);
  }
  const seen = new Set<string>();
  const h = (id: string): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let best = 0;
    for (const c of children.get(id) || []) best = Math.max(best, h(c));
    return 1 + best;
  };
  return h(rootId);
}

/** 每個 cue 存的位置：要是數字（後台再夾進行程） */
export function parseCueValue(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const v = num(raw);
  return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, error: MECH_MESSAGES.value };
}

// ─────────────────────────────────────────────
// 方向選項（設定機關時用的白話選項 ↔ 場景座標的單位向量）
// ─────────────────────────────────────────────

/** 數字變大時往哪（直線）。左右 = 觀眾看過去的左右 */
export type LinearDirection = 'up' | 'down' | 'toAudience' | 'upstage' | 'left' | 'right';
export const LINEAR_DIRECTIONS: { key: LinearDirection; label: string }[] = [
  { key: 'up', label: '往上' },
  { key: 'down', label: '往下' },
  { key: 'toAudience', label: '往觀眾' },
  { key: 'upstage', label: '往舞台後方' },
  { key: 'left', label: '往左' },
  { key: 'right', label: '往右' },
];

/** 旋轉的轉軸 */
export type RotaryAxisKind = 'yaw' | 'pitch' | 'roll';
export const ROTARY_AXES: { key: RotaryAxisKind; label: string; positive: [string, string] }[] = [
  { key: 'yaw', label: '水平轉（像轉台）', positive: ['從上面看順時針', '從上面看逆時針'] },
  { key: 'pitch', label: '前後翻', positive: ['往觀眾倒', '往後倒'] },
  { key: 'roll', label: '左右翻', positive: ['往左倒', '往右倒'] },
];

const UP: MechVec3 = { x: 0, y: 1, z: 0 };
const neg = (v: MechVec3): MechVec3 => ({ x: -v.x || 0, y: -v.y || 0, z: -v.z || 0 });
const cross = (a: MechVec3, b: MechVec3): MechVec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
const dot = (a: MechVec3, b: MechVec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** 舞台正面（水平、指向觀眾）整理成水平單位向量；不能用就當 +Z */
export function horizontalFront(front: MechVec3 | null | undefined): MechVec3 {
  const f = front ? normalize({ x: front.x, y: 0, z: front.z }) : null;
  return f ?? { x: 0, y: 0, z: 1 };
}

/** 觀眾看過去的右手邊 = 上 × 正面 */
export function audienceRight(front: MechVec3): MechVec3 {
  return normalize(cross(UP, horizontalFront(front))) ?? { x: 1, y: 0, z: 0 };
}

export function linearDirectionVector(dir: LinearDirection, front: MechVec3): MechVec3 {
  const f = horizontalFront(front);
  switch (dir) {
    case 'up': return { ...UP };
    case 'down': return neg(UP);
    case 'toAudience': return f;
    case 'upstage': return neg(f);
    case 'right': return audienceRight(f);
    case 'left': return neg(audienceRight(f));
  }
}

/**
 * 旋轉的轉軸向量（右手定則決定正的角度）：
 *   水平轉：從上面看逆時針 = +Y（右手定則），順時針 = −Y
 *   前後翻：往觀眾倒 = 觀眾的右手邊（上緣往觀眾走）
 *   左右翻：往右倒 = −正面（上緣往觀眾的右邊走）
 * positiveFirst = 選了 positive[0]（順時針 / 往觀眾倒 / 往左倒）
 */
export function rotaryAxisVector(kind: RotaryAxisKind, positiveFirst: boolean, front: MechVec3): MechVec3 {
  const f = horizontalFront(front);
  let a: MechVec3;
  if (kind === 'yaw') a = positiveFirst ? neg(UP) : { ...UP };
  else if (kind === 'pitch') a = positiveFirst ? audienceRight(f) : neg(audienceRight(f));
  else a = positiveFirst ? f : neg(f);  // 往左倒 = +正面
  return a;
}

/** 已經存的方向 → 最接近的白話選項（編輯時用）；exact = 跟選項完全一樣 */
export function matchLinearDirection(axis: MechVec3, front: MechVec3): { dir: LinearDirection; exact: boolean } {
  let best: LinearDirection = 'up', bestDot = -Infinity;
  for (const { key } of LINEAR_DIRECTIONS) {
    const d = dot(axis, linearDirectionVector(key, front));
    if (d > bestDot) { bestDot = d; best = key; }
  }
  return { dir: best, exact: bestDot > 1 - 1e-6 };
}

export function matchRotaryAxis(axis: MechVec3, front: MechVec3): { kind: RotaryAxisKind; positiveFirst: boolean; exact: boolean } {
  let best = { kind: 'yaw' as RotaryAxisKind, positiveFirst: false }, bestDot = -Infinity;
  for (const { key } of ROTARY_AXES) {
    for (const pf of [true, false]) {
      const d = dot(axis, rotaryAxisVector(key, pf, front));
      if (d > bestDot) { bestDot = d; best = { kind: key, positiveFirst: pf }; }
    }
  }
  return { ...best, exact: bestDot > 1 - 1e-6 };
}

/** 清單上的方向字：「上下」「左右」「前後」「轉台」「前後翻」「左右翻」 */
export function directionWord(m: Pick<Mechanism, 'kind' | 'axis'>, front?: MechVec3 | null): string {
  const f = horizontalFront(front);
  const right = audienceRight(f);
  const a = m.axis;
  const comps = [Math.abs(a.y), Math.abs(dot(a, f)), Math.abs(dot(a, right))];
  const i = comps.indexOf(Math.max(...comps));
  if (m.kind === 'rotary') return i === 0 ? '轉台' : i === 2 ? '前後翻' : '左右翻';
  return i === 0 ? '上下' : i === 1 ? '前後' : '左右';
}

// ─────────────────────────────────────────────
// 常用位置
// ─────────────────────────────────────────────

/** 「加入 收起 / 半開 / 全開」：最低 / 中間 / 最高（已經有同名的就不重複加） */
export function standardPresets(travelMin: number, travelMax: number, existing: MechanismPreset[] = []): MechanismPreset[] {
  const add: MechanismPreset[] = [
    { name: '收起', value: travelMin },
    { name: '半開', value: (travelMin + travelMax) / 2 },
    { name: '全開', value: travelMax },
  ];
  const names = new Set(existing.map(p => p.name));
  return [...existing, ...add.filter(p => !names.has(p.name))]
    .slice(0, MECH_LIMITS.presetsMax)
    .sort((a, b) => a.value - b.value);
}

/** 這個值剛好是哪個常用位置（差不到 1e-6）；都不是 → null */
export function presetAt(presets: MechanismPreset[], value: number): MechanismPreset | null {
  return presets.find(p => Math.abs(p.value - value) < 1e-6) ?? null;
}

/** 拖滑桿時：離常用位置不到行程的 1% → 吸過去 */
export function snapToPreset(value: number, m: Pick<Mechanism, 'presets' | 'travelMin' | 'travelMax'>, fraction = 0.01): number {
  const tol = (m.travelMax - m.travelMin) * fraction;
  let best: number | null = null, bestD = Infinity;
  for (const p of m.presets) {
    const d = Math.abs(p.value - value);
    if (d <= tol + EPS && d < bestD) { best = p.value; bestD = d; }
  }
  return best ?? value;
}

// ─────────────────────────────────────────────
// 舊的「全專案機關滑桿」（projects.mechanism_offsets）→ 機關
// 跟 cf-worker/migrations/0023_mechanisms.sql 的轉換結果一模一樣（mechanisms.test.mjs 有比對）
// ─────────────────────────────────────────────

export type LegacyOffsets = Record<string, { x?: unknown; y?: unknown } | null | undefined>;

export interface LegacyObject {
  id: string;
  category: string;
  order: number;
  /** 顯示名稱（空白 → 用 mesh 名稱） */
  displayName?: string | null;
  meshName: string;
}

/** 轉出來的一個機關（跟 mechanisms 表的欄位一樣，加上帶哪些物件） */
export interface LegacyMechanismRow {
  id: string;
  name: string;
  kind: 'linear';
  axis: MechVec3;
  pivot: null;
  travelMin: number;
  travelMax: number;
  defaultValue: number;
  maxSpeed: null;
  presets: MechanismPreset[];
  parentId: string | null;
  order: number;
  legacyObjectId: string;
  legacyAxis: 'x' | 'y';
  objectIds: string[];
}

export const LEGACY_RANGE = 10;
export const legacyMechanismId = (objectId: string, axis: 'x' | 'y') => (axis === 'x' ? 'mlx_' : 'mly_') + objectId;

const legacyNum = (v: unknown): number => {
  const n = typeof v === 'boolean' ? Number(v) : num(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 每片 LED（只看 LED 面板、0 不轉）：
 *   只有左右 → 「<名稱> 左右」帶這片 LED；只有上下 → 「<名稱> 上下」帶這片 LED；
 *   兩個都有 → 「上下」帶 LED、「上下」裝在「左右」上（兩個位移加起來 = 以前的位置）
 * 預設位置 = 舊位移；行程 = -10 ~ 10 公尺（舊值超過就放寬）；不填速度
 */
export function legacyOffsetsToMechanisms(offsets: LegacyOffsets | null | undefined, objects: LegacyObject[]): LegacyMechanismRow[] {
  if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return [];
  const out: LegacyMechanismRow[] = [];
  const byId = new Map(objects.map(o => [o.id, o]));
  for (const [objectId, v] of Object.entries(offsets)) {
    const o = byId.get(objectId);
    if (!o || o.category !== 'led_panel' || !v || typeof v !== 'object') continue;
    const x = legacyNum(v.x), y = legacyNum(v.y);
    if (x === 0 && y === 0) continue;
    const label = (o.displayName ?? '').trim() || o.meshName;
    const row = (axis: 'x' | 'y', value: number, parentId: string | null): LegacyMechanismRow => ({
      id: legacyMechanismId(objectId, axis),
      name: `${label} ${axis === 'x' ? '左右' : '上下'}`,
      kind: 'linear',
      axis: axis === 'x' ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 },
      pivot: null,
      travelMin: Math.min(-LEGACY_RANGE, value),
      travelMax: Math.max(LEGACY_RANGE, value),
      defaultValue: value,
      maxSpeed: null,
      presets: [],
      parentId,
      order: o.order * 2 + (axis === 'y' ? 1 : 0),
      legacyObjectId: objectId,
      legacyAxis: axis,
      objectIds: [],
    });
    const mx = x !== 0 ? row('x', x, null) : null;
    const my = y !== 0 ? row('y', y, mx ? mx.id : null) : null;
    (my ?? mx)!.objectIds = [objectId];
    if (mx) out.push(mx);
    if (my) out.push(my);
  }
  return out;
}

/** 轉出來的 → 畫面用的 Mechanism（StageScene 收到舊的 mechanismOffsets 時用） */
export function legacyRowToMechanism(row: LegacyMechanismRow): Mechanism {
  return {
    id: row.id, name: row.name, kind: row.kind, axis: row.axis, pivot: null,
    travelMin: row.travelMin, travelMax: row.travelMax, defaultValue: row.defaultValue, maxSpeed: null,
    presets: [], parentId: row.parentId, objectIds: row.objectIds, consoleLabel: null, order: row.order,
    metadata: null, cueCount: 0, updatedAt: '',
  };
}
