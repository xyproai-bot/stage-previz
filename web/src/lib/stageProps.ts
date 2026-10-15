// 比例尺的「樂手和器材」（鼓組、鋼琴、各種樂手…）：種類和尺寸、存檔格式、誰能改、擺放的算法。
//
// 這個檔案前端（StageScene、各頁面）和後端（cf-worker/worker.js 直接 import 這個 .ts）共用，
// 所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / three / React、不用 enum / namespace 這類要編譯的寫法。
// 3D 模型（用 three 的基本形狀組出來）在 stagePropModels.ts，畫面上怎麼擺在 stagePropsScene.ts。
//
// 存在專案上的格式（projects.stage_props，JSON 陣列，全專案所有人共用）：
//   [{ id, type, x, y, z, rotY }]
//   - x、y、z：公尺。座標系 = 3D 場景的原點（模型自己的原點），y 向上；
//     公尺 = 場景單位 × 測距校準倍率（scaleCorrection，專案設定）。所以校準之後尺寸還是真的公尺；
//     y 是腳底站的高度（舞台面或樂手台頂面），不是模型中心。
//   - rotY：度，繞著 y 軸轉（three.js 的 rotation.y：從上面往下看逆時針為正），範圍 (-180, 180]。
//     0 度 = 模型的「正面」朝向場景的 +Z；新加的東西會設成朝向觀眾（見 facingYaw）。
//
// 誰能改：製作、導演可以新增 / 移動 / 轉 / 刪除；動畫師和分享連結的訪客只能看（canEditStageProps，後台同一條規則）。

export const STAGE_PROP_TYPE_IDS = [
  'vocalist', 'backing', 'dancer', 'guitarist', 'bassist', 'keyboardist', 'drummer', 'percussionist',
  'dj', 'violinist', 'cellist', 'winds',
  'piano', 'micStand', 'monitor', 'riser',
] as const;

export type StagePropType = (typeof STAGE_PROP_TYPE_IDS)[number];
export type StagePropGroup = 'person' | 'gear';

export const STAGE_PROP_GROUP_LABEL: Record<StagePropGroup, string> = { person: '人物', gear: '器材' };

/** 公尺。w = 左右（x）、d = 前後（z）、h = 高（y） */
export interface StagePropSize { w: number; d: number; h: number }

export interface StagePropSpec {
  type: StagePropType;
  label: string;
  group: StagePropGroup;
  /** 模型外框的大小（模型組好後量出來，stageProps.test.ts 驗證） */
  size: StagePropSize;
  /** 有的話：size 量的是模型裡這個名字的零件（例：DJ 量的是桌子、鋼琴量的是琴身不含掀開的蓋子） */
  measuredPart?: string;
}

export const STAGE_PROP_SPECS: readonly StagePropSpec[] = [
  { type: 'vocalist', label: '主唱', group: 'person', size: { w: 0.65, d: 0.7, h: 1.7 } },
  { type: 'backing', label: '和聲', group: 'person', size: { w: 0.6, d: 0.35, h: 1.7 } },
  { type: 'dancer', label: '舞者', group: 'person', size: { w: 1.7, d: 0.7, h: 1.7 } },
  { type: 'guitarist', label: '吉他手', group: 'person', size: { w: 1, d: 0.5, h: 1.7 } },
  { type: 'bassist', label: '貝斯手', group: 'person', size: { w: 1.4, d: 0.5, h: 1.7 } },
  { type: 'keyboardist', label: '鍵盤手', group: 'person', size: { w: 1.3, d: 0.4, h: 0.97 }, measuredPart: 'keyboard' },
  { type: 'drummer', label: '鼓手', group: 'person', size: { w: 2, d: 1.8, h: 1.45 } },
  { type: 'percussionist', label: '打擊樂手', group: 'person', size: { w: 0.55, d: 0.6, h: 1.7 } },
  { type: 'dj', label: 'DJ', group: 'person', size: { w: 1.8, d: 0.8, h: 1 }, measuredPart: 'table' },
  { type: 'violinist', label: '小提琴手', group: 'person', size: { w: 0.55, d: 0.75, h: 1.7 } },
  { type: 'cellist', label: '大提琴手', group: 'person', size: { w: 0.65, d: 0.85, h: 1.5 } },
  { type: 'winds', label: '管樂手', group: 'person', size: { w: 0.55, d: 0.7, h: 1.7 } },
  { type: 'piano', label: '平台鋼琴', group: 'gear', size: { w: 1.5, d: 2.1, h: 1 }, measuredPart: 'body' },
  { type: 'micStand', label: '麥克風架', group: 'gear', size: { w: 0.4, d: 0.5, h: 1.6 } },
  { type: 'monitor', label: '地板監聽喇叭', group: 'gear', size: { w: 0.6, d: 0.45, h: 0.35 } },
  { type: 'riser', label: '樂手台', group: 'gear', size: { w: 2.4, d: 2.4, h: 0.4 } },
];

const SPEC_BY_TYPE: ReadonlyMap<string, StagePropSpec> = new Map(STAGE_PROP_SPECS.map(s => [s.type, s]));

export function isStagePropType(v: unknown): v is StagePropType {
  return typeof v === 'string' && SPEC_BY_TYPE.has(v);
}

export function stagePropSpec(type: StagePropType): StagePropSpec {
  return SPEC_BY_TYPE.get(type) as StagePropSpec;
}

/** 樂手台：其他東西可以站在它上面（頂面高度 = 它的高） */
export const RISER_TYPE: StagePropType = 'riser';

// ─────────────────────────────────────────────
// 存檔格式
// ─────────────────────────────────────────────

export interface StagePropItem {
  id: string;
  type: StagePropType;
  x: number;
  y: number;
  z: number;
  rotY: number;
}

/** 一個專案最多擺幾個（太多畫面會卡、存檔也會太大） */
export const STAGE_PROP_MAX = 60;
/** 座標的合理範圍（公尺）：再遠的一定是壞資料 */
export const STAGE_PROP_XZ_LIMIT = 5000;
export const STAGE_PROP_Y_MIN = -100;
export const STAGE_PROP_Y_MAX = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 角度換成 (-180, 180]，取到 0.1 度 */
export function normalizeRotY(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  d = Math.round(d * 10) / 10;
  return d === 0 ? 0 : d;  // 不要出現 -0
}

/** 一筆資料整理成合法的樣子；有任何一欄不對 → null */
export function sanitizeStagePropItem(raw: unknown): StagePropItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  if (!isStagePropType(o.type)) return null;
  // 一定要是數字本身（null、字串、true 都不收；Number(null) 會變成 0，不能放過）
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const rot = o.rotY === undefined ? 0 : o.rotY;
  if (!finite(o.x) || !finite(o.y) || !finite(o.z) || !finite(rot)) return null;
  const x = o.x, y = o.y, z = o.z;
  if (Math.abs(x) > STAGE_PROP_XZ_LIMIT || Math.abs(z) > STAGE_PROP_XZ_LIMIT) return null;
  if (y < STAGE_PROP_Y_MIN || y > STAGE_PROP_Y_MAX) return null;
  return { id: o.id, type: o.type, x: round3(x), y: round3(y), z: round3(z), rotY: normalizeRotY(rot) };
}

/**
 * 讀進來的資料（資料庫 / 後台給的 / 舊資料）整理成清單：陣列或 JSON 字串都收；
 * 不合法的那筆、重複的 id 丟掉，最多留 STAGE_PROP_MAX 個。整個壞掉 → 空清單
 */
export function normalizeStageProps(raw: unknown): StagePropItem[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: StagePropItem[] = [];
  const seen = new Set<string>();
  for (const r of arr) {
    const it = sanitizeStagePropItem(r);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
    if (out.length >= STAGE_PROP_MAX) break;
  }
  return out;
}

export type StagePropsCheck =
  | { ok: true; props: StagePropItem[] }
  | { ok: false; error: string };

/** 後台存檔前的檢查：比 normalizeStageProps 嚴格，有一筆不對就整份拒絕（不要偷偷丟資料） */
export function checkStagePropsForSave(raw: unknown): StagePropsCheck {
  if (!Array.isArray(raw)) return { ok: false, error: '樂手和器材的資料不對（要是一個清單）' };
  if (raw.length > STAGE_PROP_MAX) return { ok: false, error: `最多擺 ${STAGE_PROP_MAX} 個樂手和器材` };
  const out: StagePropItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const it = sanitizeStagePropItem(raw[i]);
    if (!it) return { ok: false, error: `第 ${i + 1} 個樂手或器材的資料不對` };
    if (seen.has(it.id)) return { ok: false, error: `第 ${i + 1} 個樂手或器材的代號重複了` };
    seen.add(it.id);
    out.push(it);
  }
  return { ok: true, props: out };
}

/** 存進資料庫的字串（固定欄位順序，座標取到公釐） */
export function serializeStageProps(items: readonly StagePropItem[]): string {
  return JSON.stringify(normalizeStageProps(items.map(i => ({ id: i.id, type: i.type, x: i.x, y: i.y, z: i.z, rotY: i.rotY }))));
}

/** 資料庫裡的字串讀回清單（壞資料 / 空 / null → 空清單） */
export function parseStoredStageProps(text: string | null | undefined): StagePropItem[] {
  return normalizeStageProps(text ?? '[]');
}

// ─────────────────────────────────────────────
// 權限
// ─────────────────────────────────────────────

/** 專案角色：製作 admin、導演 director、動畫師 animator；沒有角色（不是成員 / 分享連結訪客）= null */
export type StagePropRole = 'admin' | 'director' | 'animator' | null | undefined;

/** 誰能新增 / 移動 / 轉 / 刪除樂手和器材：製作、導演。動畫師和分享連結的訪客只能看 */
export function canEditStageProps(role: StagePropRole): boolean {
  return role === 'admin' || role === 'director';
}

export const STAGE_PROPS_DENIED_MESSAGE = '只有製作或導演可以擺樂手和器材';

// ─────────────────────────────────────────────
// 擺放
// ─────────────────────────────────────────────

/** 新增一個的代號 */
export function newStagePropId(rand: () => number = Math.random): string {
  let s = '';
  while (s.length < 8) s += Math.floor(rand() * 36).toString(36);
  return 'sp_' + s;
}

/** 讓模型的正面（+Z）朝向 front（水平方向，舞台正面朝觀眾的方向）要轉幾度 */
export function facingYaw(front: { x: number; z: number }): number {
  if (Math.hypot(front.x, front.z) < 1e-9) return 0;
  return normalizeRotY((Math.atan2(front.x, front.z) * 180) / Math.PI);
}

const SPOT_STEP_M = 1.2;
const SPOT_CLEAR_M = 0.9;

/**
 * 新增時擺哪裡：base 是舞台前緣正中間（公尺），已經有東西擋著就往左右一格一格找（右、左、再右…），
 * 找到 0.9 公尺內沒有別人的位置。right = 觀眾看過去往右的水平方向。
 */
export function freeSpot(
  items: readonly StagePropItem[], base: { x: number; z: number }, right: { x: number; z: number },
): { x: number; z: number } {
  const len = Math.hypot(right.x, right.z) || 1;
  const rx = right.x / len, rz = right.z / len;
  for (let k = 0; k < 2 * STAGE_PROP_MAX + 2; k++) {
    const n = k === 0 ? 0 : (k % 2 === 1 ? (k + 1) / 2 : -k / 2);
    const x = base.x + rx * n * SPOT_STEP_M, z = base.z + rz * n * SPOT_STEP_M;
    if (!items.some(it => Math.hypot(it.x - x, it.z - z) < SPOT_CLEAR_M)) return { x, z };
  }
  return { ...base };
}

// ── 樂手台：站在上面的東西跟著樂手台動 ──

/** 站上去的容許誤差：腳離樂手台頂面幾公尺內、離邊緣幾公尺內都算站在上面 */
const ON_RISER_Y_TOL = 0.15;
const ON_RISER_EDGE_TOL = 0.05;

/** 這個點（x、z）在樂手台的範圍內嗎（樂手台中心 + 轉角 rotY，大小 w × d；tol = 往外多算幾公尺） */
function insideRiser(r: StagePropItem, x: number, z: number, tol = ON_RISER_EDGE_TOL): boolean {
  const { w, d } = stagePropSpec('riser').size;
  const th = (r.rotY * Math.PI) / 180;
  const dx = x - r.x, dz = z - r.z;
  const lx = dx * Math.cos(th) - dz * Math.sin(th);
  const lz = dx * Math.sin(th) + dz * Math.cos(th);
  return Math.abs(lx) <= w / 2 + tol && Math.abs(lz) <= d / 2 + tol;
}

/**
 * 拖到 (x, z)、腳的高度算出來是 y（公尺）：這個點如果在某個樂手台的範圍內、而且高度不高過它的頂面
 * （滑鼠指到樂手台的側面、光線穿過去打到底下的地板時就是這樣），就站到那個樂手台的頂面上，回傳頂面高度。
 * 在好幾個範圍內取最高的；不在任何樂手台上 → null。skip = 正在拖的和站在它上面的（不算）
 */
export function riserTopAt(
  items: readonly StagePropItem[], skip: ReadonlySet<string>, x: number, z: number, y: number,
): number | null {
  let best: number | null = null;
  const h = stagePropSpec('riser').size.h;
  for (const r of items) {
    if (r.type !== RISER_TYPE || skip.has(r.id)) continue;
    const top = r.y + h;
    if (y > top + ON_RISER_Y_TOL || !insideRiser(r, x, z, 0)) continue;
    if (best === null || top > best) best = top;
  }
  return best;
}

/** 站在這個樂手台上面的東西的代號（樂手台疊樂手台也算，不含它自己） */
export function propsStandingOn(items: readonly StagePropItem[], riserId: string): string[] {
  const root = items.find(i => i.id === riserId);
  if (!root || root.type !== RISER_TYPE) return [];
  const found = new Set<string>();
  const queue: StagePropItem[] = [root];
  const topOf = (r: StagePropItem) => r.y + stagePropSpec('riser').size.h;
  while (queue.length > 0) {
    const r = queue.shift() as StagePropItem;
    for (const it of items) {
      if (it.id === root.id || found.has(it.id)) continue;
      if (Math.abs(it.y - topOf(r)) > ON_RISER_Y_TOL) continue;
      if (!insideRiser(r, it.x, it.z)) continue;
      found.add(it.id);
      if (it.type === RISER_TYPE) queue.push(it);
    }
  }
  return [...found];
}

/**
 * 把一個東西移到 to（位置 + 轉角）。是樂手台的話，站在上面的東西一起移、一起轉（整體轉動，相對位置不變）。
 * 回傳新的清單（不改原本的）。找不到這個代號 → 原樣回傳。
 */
export function moveStagePropWith(
  items: readonly StagePropItem[], id: string, to: { x: number; y: number; z: number; rotY: number },
): StagePropItem[] {
  const from = items.find(i => i.id === id);
  if (!from) return items.slice();
  const carried = new Set(propsStandingOn(items, id));
  const dRot = to.rotY - from.rotY;
  const ph = (dRot * Math.PI) / 180;
  const cos = Math.cos(ph), sin = Math.sin(ph);
  return items.map((it) => {
    if (it.id === id) return { ...it, x: round3(to.x), y: round3(to.y), z: round3(to.z), rotY: normalizeRotY(to.rotY) };
    if (!carried.has(it.id)) return it;
    const rx = it.x - from.x, rz = it.z - from.z;
    // three.js 的 rotation.y：(x, z) → (x cos + z sin, -x sin + z cos)
    return {
      ...it,
      x: round3(to.x + rx * cos + rz * sin),
      y: round3(it.y + (to.y - from.y)),
      z: round3(to.z - rx * sin + rz * cos),
      rotY: normalizeRotY(it.rotY + dRot),
    };
  });
}

/** 轉 deg 度（正 = 逆時針，從上面看） */
export function rotateStagePropBy(items: readonly StagePropItem[], id: string, deg: number): StagePropItem[] {
  const it = items.find(i => i.id === id);
  if (!it) return items.slice();
  return moveStagePropWith(items, id, { x: it.x, y: it.y, z: it.z, rotY: it.rotY + deg });
}

/** 刪掉一個（站在樂手台上的東西留在原地） */
export function removeStageProp(items: readonly StagePropItem[], id: string): StagePropItem[] {
  return items.filter(i => i.id !== id);
}
