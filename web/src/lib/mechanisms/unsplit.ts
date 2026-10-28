// 把「對開」機關拆成兩個各自動的機關（設計：docs/superpowers/specs/2026-10-29-director-stage-control-design.md 3.4）。
//
// 對開 = 一個機關、一個位置，A 邊照機關本來的方向 / 轉軸動，B 邊用 mirror 的方向 / 轉軸中心動（pose.ts 的 compileRig：B 邊零件同一個 id）。
// 拆開之後：
//   A 邊留在原機關（id 不變）：不再是對開（沒有 mirror、物件不分邊），名字預設「原名 A」；
//   B 邊變成一個新機關：方向 / 轉軸中心 = 原本 mirror 的，控台編號 = mirror 的，行程 / 預設位置 / 常用位置 / 最高速度 / 裝在哪個機關上照抄，
//     帶原本在 B 邊的物件，名字預設「原名 B」。
//   每個 cue 存的位置（後台 mechanisms.mjs 的 unsplitMechanism）原樣抄一份給 B → 兩個機關用同一個數字，畫面跟拆之前一模一樣
//   （unsplit.test.ts 用 pose.ts 對照拆之前 / 拆之後每個物件的畫面位置和角度）。
//
// 這個檔案前端（拆開的確認框）和後台（cf-worker/mechanisms.mjs 直接 import 這個 .ts）共用：
// 只放純判斷，不 import 別的檔案（除了 model.ts）、不碰 DOM / three / React，不用要編譯的 TS 寫法。

import {
  MECH_LIMITS, MECH_MESSAGES, normalizeMechanismInput,
  type Mechanism, type MechanismField, type MechanismInput, type MechanismSibling,
} from './model.ts';

export const UNSPLIT_MESSAGES = {
  notSplit: '這個機關不是對開',
  nameText: '機關名稱要是文字',
} as const;

export type UnsplitField = 'nameA' | 'nameB' | 'variant' | MechanismField;

export interface UnsplitPlanValue {
  nameA: string;
  nameB: string;
  /** B 邊要新建的機關（檢查過的樣子；一般機關，沒有 mirror、物件不分邊） */
  b: MechanismInput;
  /** 留在 A 的物件 / 改掛到 B 的物件（照原本 objectIds 的順序） */
  aObjectIds: string[];
  bObjectIds: string[];
}

export type UnsplitPlan =
  | { ok: true; value: UnsplitPlanValue }
  | { ok: false; error: string; field: UnsplitField };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (error: string, field: UnsplitField): UnsplitPlan => ({ ok: false, error, field });

/** 預設名字：「原名 A」「原名 B」；原名太長就把原名縮短，整個名字不超過 40 字 */
export function defaultUnsplitNames(name: string): { a: string; b: string } {
  const base = String(name ?? '').trim().slice(0, MECH_LIMITS.nameMax - 2).trimEnd();
  const join = (side: string) => (base ? `${base} ${side}` : side);
  return { a: join('A'), b: join('B') };
}

/** metadata 照抄，但翻轉的設定（setup）不抄：B 邊的轉軸是 mirror 的，不能被「照外框重新算」 */
function metadataForB(metadata: Mechanism['metadata']): Record<string, unknown> | null {
  const rest: Record<string, unknown> = { ...(metadata ?? {}) };
  delete rest.setup;
  return Object.keys(rest).length ? rest : null;
}

/**
 * 規劃怎麼拆：檢查是不是對開、兩個名字（body 的 nameA / nameB，沒給 = 預設）、算出 B 邊的定義和兩邊的物件。
 * @param mech      要拆的機關（API 格式）
 * @param body      { nameA?, nameB? }
 * @param siblings  這個專案所有的機關（檢查名字有沒有跟別的機關重複）
 */
export function planUnsplit(mech: Mechanism, body: unknown, siblings: MechanismSibling[]): UnsplitPlan {
  if (mech.variant !== 'split' || !mech.mirror) return fail(UNSPLIT_MESSAGES.notSplit, 'variant');
  const raw = isObj(body) ? body : {};
  const defaults = defaultUnsplitNames(mech.name);

  const nameOf = (v: unknown, fallback: string, field: 'nameA' | 'nameB'): { ok: true; name: string } | { ok: false; plan: UnsplitPlan } => {
    if (v === undefined || v === null) return { ok: true, name: fallback };
    if (typeof v !== 'string') return { ok: false, plan: fail(UNSPLIT_MESSAGES.nameText, field) };
    const name = v.trim().slice(0, MECH_LIMITS.nameMax);
    return name ? { ok: true, name } : { ok: false, plan: fail(MECH_MESSAGES.nameEmpty, field) };
  };
  const a = nameOf(raw.nameA, defaults.a, 'nameA');
  if (!a.ok) return a.plan;
  const b = nameOf(raw.nameB, defaults.b, 'nameB');
  if (!b.ok) return b.plan;
  const nameA = a.name, nameB = b.name;
  if (siblings.some(s => s.id !== mech.id && s.name.trim() === nameA)) return fail(MECH_MESSAGES.nameTaken(nameA), 'nameA');

  const sides = mech.objectSides ?? {};
  const bObjectIds = mech.objectIds.filter(id => sides[id] === 'b');
  const aObjectIds = mech.objectIds.filter(id => sides[id] !== 'b');

  // B 邊用「新增一個機關」同一套規則檢查（名字跟別的機關 / 跟 A 的新名字不能重複、上層層數…）
  const n = normalizeMechanismInput({
    name: nameB,
    kind: mech.kind,
    axis: mech.mirror.axis,
    pivot: mech.kind === 'rotary' ? mech.mirror.pivot : null,
    travelMin: mech.travelMin,
    travelMax: mech.travelMax,
    defaultValue: mech.defaultValue,
    maxSpeed: mech.maxSpeed,
    presets: mech.presets,
    parentId: mech.parentId,
    objectIds: bObjectIds,
    consoleLabel: mech.mirror.consoleLabel,
    metadata: metadataForB(mech.metadata),
    variant: null,
    mirror: null,
    objectSides: {},
  }, {
    siblings: siblings.map(s => (s.id === mech.id ? { ...s, name: nameA, variant: null } : s)),
    selfId: null,
  });
  if (!n.ok) return fail(n.error, n.field === 'name' ? 'nameB' : n.field);
  return { ok: true, value: { nameA, nameB, b: n.value, aObjectIds, bObjectIds } };
}

/**
 * 拆完之後的兩個機關（API 格式；測試拿它跟拆之前比畫面、前端預覽用）。
 * 後台寫進資料庫的內容跟這個一樣（cf-worker/mechanisms.mjs）；順序 / 一排裡的位置、有幾個 cue 設了位置由後台算（這裡只是估計）。
 */
export function unsplitMechanisms(mech: Mechanism, plan: UnsplitPlanValue, bId: string): { a: Mechanism; b: Mechanism } {
  const a: Mechanism = {
    ...mech, name: plan.nameA, variant: null, mirror: null, objectSides: {}, objectIds: plan.aObjectIds,
  };
  const b: Mechanism = {
    ...mech,
    id: bId, name: plan.nameB, kind: plan.b.kind, axis: { ...plan.b.axis }, pivot: plan.b.pivot ? { ...plan.b.pivot } : null,
    travelMin: plan.b.travelMin, travelMax: plan.b.travelMax, defaultValue: plan.b.defaultValue, maxSpeed: plan.b.maxSpeed,
    presets: plan.b.presets.map(p => ({ ...p })), parentId: plan.b.parentId, objectIds: plan.bObjectIds,
    consoleLabel: plan.b.consoleLabel, metadata: plan.b.metadata,
    variant: null, mirror: null, objectSides: {}, order: mech.order + 1, groupIndex: null,
  };
  return { a, b };
}
