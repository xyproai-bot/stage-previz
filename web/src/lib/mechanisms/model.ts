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
/**
 * 機關的變體：沒有 = 一般機關；'split' = 對開（兩邊往反方向動，一個位置）；
 * 吊掛（v2 第 4 階段）：'hoist_rig' = 整組吊掛（帶動物件，自己沒有位置）、'hoist' = 它的一個吊點（直線往上，有自己的位置，沒有物件）
 */
export type MechanismVariant = 'split' | 'hoist_rig' | 'hoist';
/** 對開的哪一邊（A 邊 = 機關本來的方向；B 邊 = 鏡像） */
export type MechanismSide = 'a' | 'b';
export interface MechanismPreset { name: string; value: number }
/** 這個檔案不能 import，所以自己定一個 {x,y,z}（跟 api.ts 的 Vec3 一樣） */
export interface MechVec3 { x: number; y: number; z: number }

/**
 * 對開的 B 邊：同一個位置，往鏡像的方向動。
 * axis / pivot 跟機關本來的一樣是場景座標；直線 pivot = null；consoleLabel = B 邊在控台上的軸名
 */
export interface MechanismMirror {
  axis: MechVec3;
  pivot: MechVec3 | null;
  consoleLabel: string | null;
}

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
  /** 最高速度（公尺/秒、度/秒）。舊資料 / 舊版前端留著的欄位：畫面不再設定、預覽不看它（2026-10-15），機關一律照設定的時間動 */
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
  /**
   * 之後放加減速、碰撞外框等。翻轉（沿著邊緣翻）記在 metadata.setup = { hinge, positive }，
   * 編輯時才看得到原本選的是哪個邊、哪個方向（轉軸 / 轉軸中心已經算好存在 axis / pivot）
   */
  metadata: Record<string, unknown> | null;
  /** 幾個 cue 有自己設定的位置（刪除確認、設定清單用） */
  cueCount: number;
  updatedAt: string;
  /** v2（0030）：null / 沒有 = 一般機關；舊後台沒有這三欄 → 讀成一般機關 */
  variant?: MechanismVariant | null;
  /** 只有對開：B 邊的方向 / 轉軸 / 控台編號 */
  mirror?: MechanismMirror | null;
  /** 只有對開：每個帶的物件在哪一邊（沒寫 = A 邊） */
  objectSides?: Record<string, MechanismSide>;
  /** v2 第 3 階段（0031）：屬於哪一排（沒有 = 不在任何一排裡；舊後台沒有這兩欄 → 讀成沒有） */
  groupId?: string | null;
  /** 這一排裡的第幾個（0 起算；花樣「依序」「波浪」照這個順序） */
  groupIndex?: number | null;
  /** v2 第 4 階段（0032）：只有吊點（variant = 'hoist'）：屬於哪一組吊掛、第幾個吊點（0 起算）、吊點在物件上的位置（場景單位，cue 位置的座標） */
  rigId?: string | null;
  rigIndex?: number | null;
  attach?: MechVec3 | null;
}

/** 一排機關一次建立時選的選項（編輯時看得到原本選的） */
export type GroupNumbering = 'leftToRight' | 'rightToLeft' | 'frontToBack' | 'selection';
export interface MechanismGroupSettings { namePrefix?: string; numbering?: GroupNumbering }
/** 一排機關（0031）：名字、順序；成員是 mechanisms.groupId 指到這一排的機關 */
export interface MechanismGroup {
  id: string;
  name: string;
  order: number;
  settings: MechanismGroupSettings | null;
  updatedAt: string;
}

/** mechanismId → 位置 */
export type MechanismValues = Record<string, number>;

/**
 * 一個 cue 自己設的機關位置（沒有 = 沿用前面的 cue）。
 * delaySec / durationSec（v2，0027）：這個 cue 這個機關「GO 之後延遲幾秒開始動、走幾秒」；
 * null / 沒有 = 跟著 cue（延遲 0、走 = 轉場）。不會沿用到下一個 cue（時間是這一段移動自己的）。
 */
export interface CueMechanismPosition {
  cueId: string;
  mechanismId: string;
  value: number;
  delaySec?: number | null;
  durationSec?: number | null;
  updatedAt: string;
}

/** 這個 cue 這個機關的時間（null = 跟著 cue） */
export interface MechanismTiming { delaySec: number | null; durationSec: number | null }
/** mechanismId → 這個 cue 自己設的時間（只有這個 cue 自己有設位置的機關才有） */
export type MechanismTimings = Record<string, MechanismTiming>;

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
  variant: MechanismVariant | null;
  mirror: MechanismMirror | null;
  objectSides: Record<string, MechanismSide>;
  /** 只有吊點（variant = 'hoist'）；其他一律 null */
  rigId?: string | null;
  rigIndex?: number | null;
  attach?: MechVec3 | null;
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
  /** 每個 cue 的延遲 / 走幾秒：0 ~ 3600 秒（存到 0.001 秒） */
  timingMaxSec: 3600,
  /** 一排機關：一次最多建立幾個、一次花樣最多寫幾列（一次寫入的上限也是 200） */
  groupMembersMax: 64,
  groupNameMax: 40,
  bulkPositionsMax: 200,
  /** 吊掛：一組最少 / 最多幾個吊點 */
  hoistsMin: 2,
  hoistsMax: 4,
} as const;

/** 給畫面用：單位 */
export function unitOf(kind: MechanismKind): 'm' | '°' {
  return kind === 'rotary' ? '°' : 'm';
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
  | 'groupName' | 'namePrefix' | 'name' | 'kind' | 'variant' | 'axis' | 'pivot' | 'mirror' | 'travel' | 'maxSpeed' | 'presets' | 'objectIds' | 'parentId'
  | 'attach' | 'rigId' | 'hoists';

export const MECH_MESSAGES = {
  nameEmpty: '機關名稱不能空白',
  nameTaken: (name: string) => `這個專案已經有叫「${name}」的機關`,
  kind: '機關類型不正確',
  axis: '方向不正確',
  pivot: '轉軸中心要是數字',
  travelOrder: '行程的最高要比最低大',
  travelNumber: '行程要填數字',
  maxSpeed: '最高速度要是正的數字，或留空',
  presetsMax: '常用位置最多 12 個',
  presetDuplicate: (name: string) => `常用位置的名稱重複了：「${name}」`,
  objectsMax: '一個機關最多帶 200 個物件',
  objectsForeign: '有物件不在這個專案裡',
  parentCycle: '不能選自己，或裝在自己上面的機關',
  parentDepth: '機關一層套一層最多 4 層',
  parentMissing: '找不到要裝上去的機關',
  value: '位置要是數字',
  delay: '延遲要是 0 到 3600 秒，或留空跟著 cue',
  duration: '走幾秒要是 0 到 3600 秒，或留空跟著轉場',
  timingNeedsValue: '這個 cue 還沒有設定這個機關的位置，要一起送位置',
  variant: '機關的變化類型不正確',
  mirror: '對開的 B 邊方向不正確',
  mirrorPivot: '對開的 B 邊轉軸中心要是數字',
  splitAsParent: '對開的機關不能當別的機關的上層',
  splitHasChildren: '有機關裝在它上面，不能改成對開',
  splitConvert: '對開的機關不能轉換 cue 位置（兩邊的物件動法不一樣）',
  // 一排機關（0031）
  groupNameEmpty: '這一排的名字不能空白',
  groupNameTaken: (name: string) => `這個專案已經有叫「${name}」的一排機關`,
  groupNameLong: '這一排的名字最多 40 個字',
  groupPrefixLong: (max: number) => `名稱開頭太長了（最多 ${max} 個字，後面還要接編號）`,
  groupMin: '一排至少要 2 個機關，請多選幾個物件',
  groupMax: '一次最多建立 64 個機關',
  groupSplit: '一次建立的機關不能是對開，請一個一個設定',
  bulkItems: '一次最多設定 200 個機關的位置',
  bulkItem: '每一列都要有機關和位置',
  bulkDuplicate: '同一個機關在這一次只能出現一次',
  bulkForeign: '有機關不在這個專案裡',
  groupEmpty: '這一排已經沒有機關了',
  // 吊掛（0032）
  hoistAsParent: '吊掛的機關不能當別的機關的上層',
  hoistHasChildren: '有機關裝在它上面，不能改成吊掛',
  hoistConvert: '吊掛的機關不能轉換 cue 位置',
  hoistVariantLocked: '吊掛要用「新增吊掛」建立，不能把一般機關改成吊掛，也不能把吊掛改回一般機關',
  hoistRigValue: '這是整組吊掛，沒有自己的位置，請設定它的每個吊點',
  hoistDeleteOne: '吊掛至少要有 2 個吊點，要減少吊點請編輯整組吊掛；要整組刪掉請刪除吊掛',
  hoistCount: '吊掛要有 2 到 4 個吊點',
  hoistAttach: '吊點的位置要填 X、Y、Z 三個數字',
  hoistRig: '找不到這個吊點屬於哪一組吊掛',
  hoistRigIndex: '吊點的編號不正確',
  hoistSame: '兩個吊點不能在同一個位置，請把它們分開',
  hoistLine: '三個以上的吊點不能排成一直線，請把其中一個移開',
  hoistForeign: '有吊點不是這一組吊掛的',
  hoistObjects: '吊掛要先選好帶動的物件',
} as const;

/** 專案裡其他機關（檢查名稱重複、裝在哪個機關上） */
export interface MechanismSibling { id: string; name: string; parentId: string | null; variant?: MechanismVariant | null; rigId?: string | null }

export interface NormalizeContext {
  /** 修改：原本的機關（沒送的欄位用原本的） */
  existing?: MechanismInput | null;
  /** 修改：自己的 id（名稱重複、繞圈檢查要排除自己） */
  selfId?: string | null;
  /** 這個專案的所有機關（含自己也沒關係，會用 selfId 排除） */
  siblings?: MechanismSibling[];
  /** 這個專案的所有物件 id（有給才檢查「物件在不在這個專案」） */
  projectObjectIds?: Set<string> | null;
  /** 吊點：這組吊掛是同一次新增的，id 還不存在（不檢查「找得到這組吊掛」） */
  pendingRigId?: string | null;
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
    variant: m.variant === 'split' || m.variant === 'hoist_rig' || m.variant === 'hoist' ? m.variant : null,
    rigId: m.variant === 'hoist' ? (m.rigId ?? null) : null,
    rigIndex: m.variant === 'hoist' ? (m.rigIndex ?? null) : null,
    attach: m.variant === 'hoist' && m.attach ? { ...m.attach } : null,
    mirror: m.variant === 'split' && m.mirror
      ? { axis: { ...m.mirror.axis }, pivot: m.mirror.pivot ? { ...m.mirror.pivot } : null, consoleLabel: m.mirror.consoleLabel }
      : null,
    objectSides: m.variant === 'split' ? { ...(m.objectSides ?? {}) } : {},
  };
}

/** 新機關的預設值（直線、往上、0 ~ 1 m） */
export function blankMechanismInput(): MechanismInput {
  return {
    name: '', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null,
    travelMin: 0, travelMax: 1, defaultValue: 0, maxSpeed: null, presets: [], parentId: null,
    objectIds: [], consoleLabel: null, metadata: null, variant: null, mirror: null, objectSides: {},
    rigId: null, rigIndex: null, attach: null,
  };
}

/** 有自己位置的機關（吊掛的整組 'hoist_rig' 沒有位置：不排進 cue 的位置、速度檢查、時間軸、總表） */
export function valueAxes<T extends { variant?: MechanismVariant | null }>(mechs: T[]): T[] {
  return mechs.some(m => m.variant === 'hoist_rig') ? mechs.filter(m => m.variant !== 'hoist_rig') : mechs;
}

/**
 * 檢查 + 整理一個機關的設定。修改時只送要改的欄位（其他用 ctx.existing），整個再檢查一次。
 * 回傳第一個錯誤（error / field）和每個欄位的錯誤（errors，畫面在欄位旁邊顯示）。
 */
export function normalizeMechanismInput(raw: unknown, ctx: NormalizeContext = {}): NormalizeResult {
  const r: Record<string, unknown> = isObj(raw) ? { ...raw } : {};
  const base = ctx.existing ?? blankMechanismInput();
  const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined;
  const errors: Partial<Record<MechanismField, string>> = {};
  const fail = (f: MechanismField, m: string) => { if (!errors[f]) errors[f] = m; };

  // 變化類型：對開 / 吊掛（整組）/ 吊點
  const varRaw = has('variant') ? r.variant : base.variant;
  const variant: MechanismVariant | null = varRaw === 'split' || varRaw === 'hoist_rig' || varRaw === 'hoist' ? varRaw : null;
  if (varRaw !== null && varRaw !== undefined && variant === null) fail('variant', MECH_MESSAGES.variant);
  // 吊掛的整組和吊點一定是「往上的直線」；整組自己沒有行程 / 位置 / 速度（只帶物件）；吊點沒有物件、不裝在別的機關上
  const isRig = variant === 'hoist_rig', isHoist = variant === 'hoist';
  if (isRig || isHoist) {
    r.kind = 'linear'; r.axis = { x: 0, y: 1, z: 0 }; r.pivot = null; r.mirror = null; r.objectSides = {};
    if (isRig) { r.travelMin = 0; r.travelMax = 1; r.defaultValue = 0; r.maxSpeed = null; r.presets = []; r.consoleLabel = null; }
    if (isHoist) { r.objectIds = []; r.parentId = null; }
  }

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

  // 對開的 B 邊：直線沒給就是反方向；旋轉要給轉軸和轉軸中心（表單用 mirrorForSplit 算）
  let mirror: MechanismMirror | null = null;
  if (variant === 'split') {
    const mr = has('mirror') ? r.mirror : base.mirror;
    const mo = isObj(mr) ? mr : null;
    const mAxis = mo ? (vec3(mo.axis) ? normalize(vec3(mo.axis)!) : null) : (kind === 'linear' && axis ? { x: -axis.x || 0, y: -axis.y || 0, z: -axis.z || 0 } : null);
    if (!mAxis) fail('mirror', MECH_MESSAGES.mirror);
    let mPivot: MechVec3 | null = null;
    if (kind === 'rotary') {
      mPivot = mo ? vec3(mo.pivot) : null;
      if (!mPivot || [mPivot.x, mPivot.y, mPivot.z].some(c => Math.abs(c) > MECH_LIMITS.pivotAbs)) {
        fail('mirror', MECH_MESSAGES.mirrorPivot);
        mPivot = null;
      }
    }
    const mcl = mo && typeof mo.consoleLabel === 'string' && mo.consoleLabel.trim() ? mo.consoleLabel.trim().slice(0, MECH_LIMITS.consoleLabelMax) : null;
    if (mAxis) mirror = { axis: mAxis, pivot: mPivot, consoleLabel: mcl };
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

  // 對開：每個物件在哪一邊（沒寫 = A 邊；不是帶的物件就略過）。不是對開 → 沒有邊
  const sidesRaw = has('objectSides') ? r.objectSides : base.objectSides;
  const objectSides: Record<string, MechanismSide> = {};
  if (variant === 'split') {
    for (const id of objectIds) objectSides[id] = isObj(sidesRaw) && sidesRaw[id] === 'b' ? 'b' : 'a';
  }

  // 裝在哪個機關上（對開的機關不能當別人的上層，也不能裝了別人之後才改成對開）
  const parRaw = has('parentId') ? r.parentId : base.parentId;
  const parentId = typeof parRaw === 'string' && parRaw ? parRaw : null;
  if (parentId) {
    const siblings = ctx.siblings || [];
    const check = parentCheck(ctx.selfId ?? null, parentId, siblings);
    if (check === 'missing') fail('parentId', MECH_MESSAGES.parentMissing);
    else if (check === 'cycle') fail('parentId', MECH_MESSAGES.parentCycle);
    else if (check === 'depth') fail('parentId', MECH_MESSAGES.parentDepth);
    else if (siblings.find(s => s.id === parentId)?.variant === 'split') fail('parentId', MECH_MESSAGES.splitAsParent);
    else if (siblings.find(s => s.id === parentId)?.variant) fail('parentId', MECH_MESSAGES.hoistAsParent);
  }
  if (variant === 'split' && ctx.selfId && (ctx.siblings || []).some(s => s.parentId === ctx.selfId)) {
    fail('variant', MECH_MESSAGES.splitHasChildren);
  }
  if (isRig && ctx.selfId && (ctx.siblings || []).some(s => s.parentId === ctx.selfId)) {
    fail('variant', MECH_MESSAGES.hoistHasChildren);
  }

  // 吊點：屬於哪一組吊掛、第幾個、在物件上的位置（場景單位）
  let rigId: string | null = null, rigIndex: number | null = null, attach: MechVec3 | null = null;
  if (isHoist) {
    const rr = has('rigId') ? r.rigId : base.rigId;
    rigId = typeof rr === 'string' && ID_RE.test(rr) ? rr : null;
    if (!rigId) fail('rigId', MECH_MESSAGES.hoistRig);
    else if (rigId !== ctx.pendingRigId) {
      const rig = (ctx.siblings || []).find(s => s.id === rigId);
      if (!rig || rig.variant !== 'hoist_rig') fail('rigId', MECH_MESSAGES.hoistRig);
    }
    const ri = num(has('rigIndex') ? r.rigIndex : base.rigIndex);
    if (Number.isInteger(ri) && ri >= 0 && ri < MECH_LIMITS.hoistsMax) rigIndex = ri;
    else fail('rigId', MECH_MESSAGES.hoistRigIndex);
    const av = has('attach') ? vec3(r.attach) : (base.attach ? vec3(base.attach) : null);
    if (!av || [av.x, av.y, av.z].some(c => Math.abs(c) > MECH_LIMITS.pivotAbs)) fail('attach', MECH_MESSAGES.hoistAttach);
    else attach = av;
  }

  const clRaw = has('consoleLabel') ? r.consoleLabel : base.consoleLabel;
  const consoleLabel = typeof clRaw === 'string' && clRaw.trim() ? clRaw.trim().slice(0, MECH_LIMITS.consoleLabelMax) : null;

  const mdRaw = has('metadata') ? r.metadata : base.metadata;
  const metadata = isObj(mdRaw) ? mdRaw : null;

  const order: MechanismField[] = ['name', 'kind', 'variant', 'axis', 'pivot', 'mirror', 'travel', 'maxSpeed', 'presets', 'objectIds', 'parentId', 'rigId', 'attach'];
  const first = order.find(f => errors[f]);
  if (first) return { ok: false, error: errors[first]!, field: first, errors };
  return {
    ok: true,
    value: {
      name, kind, axis: axis!, pivot, travelMin, travelMax, defaultValue, maxSpeed, presets, parentId,
      objectIds, consoleLabel, metadata, variant, mirror, objectSides, rigId, rigIndex, attach,
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

/** 延遲 / 走幾秒的一格：null / 空白 = 跟著 cue；0 ~ 3600 秒（存到 0.001 秒）；其他 = 不合法 */
export function parseTimingSeconds(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, value: null };
  const v = num(raw);
  if (!Number.isFinite(v) || v < 0 || v > MECH_LIMITS.timingMaxSec) return { ok: false };
  const r = Math.round(v * 1000) / 1000;
  return { ok: true, value: Object.is(r, -0) ? 0 : r };
}

export type CuePositionField = 'value' | 'delaySec' | 'durationSec';

/**
 * PUT …/cues/:c/mechanisms/:m 的內容：
 *   value       有送 → 改位置（後台夾進行程）；沒送 → 只改時間（這個 cue 要已經有自己的位置）
 *   delaySec    沒送 = 不改；null = 跟著 cue（0）；數字 = GO 之後幾秒開始動
 *   durationSec 沒送 = 不改；null = 跟著轉場；數字 = 走幾秒（0 = 直接切換）
 * 舊版前端只送 { value } → 時間不會被動到。
 */
export function parseCuePositionBody(raw: unknown):
  | { ok: true; value?: number; delaySec?: number | null; durationSec?: number | null }
  | { ok: false; error: string; field: CuePositionField } {
  const r: Record<string, unknown> = isObj(raw) ? raw : {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined;
  const out: { ok: true; value?: number; delaySec?: number | null; durationSec?: number | null } = { ok: true };
  if (has('delaySec')) {
    const d = parseTimingSeconds(r.delaySec);
    if (!d.ok) return { ok: false, error: MECH_MESSAGES.delay, field: 'delaySec' };
    out.delaySec = d.value;
  }
  if (has('durationSec')) {
    const d = parseTimingSeconds(r.durationSec);
    if (!d.ok) return { ok: false, error: MECH_MESSAGES.duration, field: 'durationSec' };
    out.durationSec = d.value;
  }
  if (has('value') || (!has('delaySec') && !has('durationSec'))) {
    const v = parseCueValue(r.value);
    if (!v.ok) return { ok: false, error: v.error, field: 'value' };
    out.value = v.value;
  }
  return out;
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

// ─────────────────────────────────────────────
// 對開（兩邊往反方向）：B 邊的方向 / 轉軸
// ─────────────────────────────────────────────

/** 向量 v 對著法向量 n 的平面鏡射：v − 2(v·n)n */
export function reflectAcross(v: MechVec3, n: MechVec3): MechVec3 {
  const d = 2 * dot(v, n);
  return { x: v.x - d * n.x || 0, y: v.y - d * n.y || 0, z: v.z - d * n.z || 0 };
}

/**
 * 對開的 B 邊要怎麼動（鏡像）：
 *   直線：B 的方向 = −A 的方向（兩邊往反方向）
 *   旋轉：n = A 邊中心 → B 邊中心的方向（鏡面的法向量）；
 *         B 的轉軸 = −reflect(A 的轉軸, n)（鏡射會把轉動方向反過來，所以要多一個負號）；
 *         B 的轉軸中心 = B 邊中心 + reflect(A 的轉軸中心 − A 邊中心, n)
 *   兩邊中心重疊（算不出鏡面）→ 轉軸反過來、轉軸中心跟 A 邊一樣
 * 左右對稱時 n 就是 normalize(B 轉軸中心 − A 轉軸中心)，跟設計文件寫的一樣。
 * 位置都是場景單位。
 */
export function mirrorForSplit(
  kind: MechanismKind, axisA: MechVec3, pivotA: MechVec3 | null, centerA: MechVec3 | null, centerB: MechVec3 | null,
): { axis: MechVec3; pivot: MechVec3 | null } {
  const flip = neg(axisA);
  if (kind === 'linear') return { axis: flip, pivot: null };
  const pa = pivotA ?? { x: 0, y: 0, z: 0 };
  const n = centerA && centerB ? normalize({ x: centerB.x - centerA.x, y: centerB.y - centerA.y, z: centerB.z - centerA.z }) : null;
  if (!n || !centerA || !centerB) return { axis: flip, pivot: { ...pa } };
  const ra = reflectAcross(axisA, n);
  const off = reflectAcross({ x: pa.x - centerA.x, y: pa.y - centerA.y, z: pa.z - centerA.z }, n);
  return {
    axis: { x: -ra.x || 0, y: -ra.y || 0, z: -ra.z || 0 },
    pivot: { x: centerB.x + off.x, y: centerB.y + off.y, z: centerB.z + off.z },
  };
}

/** 對開在清單 / 總表上的兩邊名稱：「升降門（A 邊）」「升降門（B 邊）」 */
export function splitSideName(name: string, side: MechanismSide): string {
  return `${name}（${side === 'a' ? 'A' : 'B'} 邊）`;
}

/** 對開某一邊的控台編號（B 邊用 mirror.consoleLabel；A 邊用機關本來的） */
export function splitConsoleLabel(m: Pick<Mechanism, 'consoleLabel' | 'mirror'>, side: MechanismSide): string | null {
  return side === 'a' ? m.consoleLabel : (m.mirror?.consoleLabel ?? null);
}

/** 對開某一邊的方向 / 轉軸中心（A 邊 = 機關本來的；B 邊 = 鏡像） */
export function splitSideGeometry(m: Pick<Mechanism, 'axis' | 'pivot' | 'mirror'>, side: MechanismSide): { axis: MechVec3; pivot: MechVec3 | null } {
  return side === 'a' || !m.mirror ? { axis: m.axis, pivot: m.pivot } : { axis: m.mirror.axis, pivot: m.mirror.pivot };
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
// 跟 cf-worker/migrations/0023_mechanisms.sql 的轉換結果一模一樣（mechanisms.test.mjs 拿它比對 migration）。
// 舊滑桿已經拿掉（後台不收 mechanism_offsets），這裡只留下來說明 0023 怎麼轉、給測試用。
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
