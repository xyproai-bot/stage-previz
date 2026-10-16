// 視角書籤（專案共用）：存格式、誰能改、整理清單的小算法、舊的「這台電腦的視角」搬到專案上的規則。
//
// 這個檔案前端（StageScene、各頁面）和後端（cf-worker/worker.js 直接 import 這個 .ts）共用，
// 所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / three / React、不用 enum / namespace 這類要編譯的寫法。
//
// 存在專案上的格式（projects.camera_bookmarks，JSON 陣列，全專案所有人共用，順序就是畫面上的順序）：
//   [{ id, name, position: [x, y, z], target: [x, y, z], fov }]
//   - position：攝影機的位置、target：看向的點，單位是「3D 場景單位」（模型自己的座標，不乘測距校準倍率，
//     跟「重置攝影機」的 home_view 同一種）；fov：上下視角（度）
//   - name：1～40 個字
// 誰能改（新增 / 改名 / 刪除 / 換順序）：製作、導演（canEditCameraBookmarks，後台同一條規則）；
//   動畫師和分享連結的訪客只能看、可以點了飛過去，不能改。
//
// 舊版把視角存在這台電腦的 localStorage（sp_camera_bookmarks:<專案 id>，格式 { id, name, pos, target, fov }），
// 只有自己看得到。新版不再寫那裡；有的話問一次「要不要放到專案裡」（planLocalOffer），不會自己刪掉那份。

export type Vec3 = [number, number, number];

export interface CameraBookmark {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  /** 上下視角（度） */
  fov: number;
}

/** 一個專案最多存幾個視角（太多清單會長到找不到、存檔也會太大） */
export const CAMERA_BOOKMARK_MAX = 40;
export const CAMERA_BOOKMARK_NAME_MAX = 40;
/** 座標的合理範圍（場景單位）：再遠的一定是壞資料（模型用毫米畫的也放得下） */
export const CAMERA_BOOKMARK_COORD_LIMIT = 1_000_000;
export const CAMERA_BOOKMARK_FOV_RANGE: [number, number] = [5, 150];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function vec3(raw: unknown): Vec3 | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  // 一定要是數字本身（null、字串、true 都不收；Number(null) 會變成 0，不能放過）
  if (!raw.every(finite)) return null;
  if (raw.some(n => Math.abs(n) > CAMERA_BOOKMARK_COORD_LIMIT)) return null;
  return [round3(raw[0]), round3(raw[1]), round3(raw[2])];
}

/** 一筆資料整理成合法的樣子；有任何一欄不對 → null */
export function sanitizeCameraBookmark(raw: unknown): CameraBookmark | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  if (typeof o.name !== 'string') return null;
  const name = o.name.trim();
  if (!name || name.length > CAMERA_BOOKMARK_NAME_MAX) return null;
  const position = vec3(o.position);
  const target = vec3(o.target);
  if (!position || !target) return null;
  if (position.every((n, i) => Math.abs(n - target[i]) < 1e-6)) return null;  // 看向自己 → 沒有方向
  if (!finite(o.fov)) return null;
  const [min, max] = CAMERA_BOOKMARK_FOV_RANGE;
  if (o.fov < min || o.fov > max) return null;
  return { id: o.id, name, position, target, fov: round3(o.fov) };
}

/**
 * 讀進來的資料（資料庫 / 後台給的 / 舊資料）整理成清單：陣列或 JSON 字串都收；
 * 不合法的那筆、重複的 id 丟掉，最多留 CAMERA_BOOKMARK_MAX 個。整個壞掉 → 空清單
 */
export function normalizeCameraBookmarks(raw: unknown): CameraBookmark[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: CameraBookmark[] = [];
  const seen = new Set<string>();
  for (const r of arr) {
    const it = sanitizeCameraBookmark(r);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
    if (out.length >= CAMERA_BOOKMARK_MAX) break;
  }
  return out;
}

export type CameraBookmarksCheck =
  | { ok: true; bookmarks: CameraBookmark[] }
  | { ok: false; error: string };

/** 後台存檔前的檢查：比 normalizeCameraBookmarks 嚴格，有一筆不對就整份拒絕（不要偷偷丟資料） */
export function checkCameraBookmarksForSave(raw: unknown): CameraBookmarksCheck {
  if (!Array.isArray(raw)) return { ok: false, error: '視角的資料不對（要是一個清單）' };
  if (raw.length > CAMERA_BOOKMARK_MAX) return { ok: false, error: `最多存 ${CAMERA_BOOKMARK_MAX} 個視角` };
  const out: CameraBookmark[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const it = sanitizeCameraBookmark(raw[i]);
    if (!it) return { ok: false, error: `第 ${i + 1} 個視角的資料不對` };
    if (seen.has(it.id)) return { ok: false, error: `第 ${i + 1} 個視角的代號重複了` };
    seen.add(it.id);
    out.push(it);
  }
  return { ok: true, bookmarks: out };
}

/** 存進資料庫的字串（固定欄位順序，座標取到千分位） */
export function serializeCameraBookmarks(items: readonly CameraBookmark[]): string {
  return JSON.stringify(normalizeCameraBookmarks(
    items.map(i => ({ id: i.id, name: i.name, position: i.position, target: i.target, fov: i.fov })),
  ));
}

/** 資料庫裡的字串讀回清單（壞資料 / 空 / null → 空清單） */
export function parseStoredCameraBookmarks(text: string | null | undefined): CameraBookmark[] {
  return normalizeCameraBookmarks(text ?? '[]');
}

// ─────────────────────────────────────────────
// 權限
// ─────────────────────────────────────────────

/** 專案角色：製作 admin、導演 director、動畫師 animator；沒有角色（不是成員 / 分享連結訪客）= null */
export type CameraBookmarkRole = 'admin' | 'director' | 'animator' | null | undefined;

/** 誰能新增 / 改名 / 刪除 / 換順序：製作、導演。動畫師和分享連結的訪客只能看（點了飛過去） */
export function canEditCameraBookmarks(role: CameraBookmarkRole): boolean {
  return role === 'admin' || role === 'director';
}

export const CAMERA_BOOKMARKS_DENIED_MESSAGE = '只有製作或導演可以存視角';

// ─────────────────────────────────────────────
// 清單的小操作（回傳新清單，不改原本的）
// ─────────────────────────────────────────────

/** 新增一個的代號 */
export function newCameraBookmarkId(rand: () => number = Math.random): string {
  let s = '';
  while (s.length < 8) s += Math.floor(rand() * 36).toString(36);
  return 'cb_' + s;
}

/** 存目前視角時預設的名字：「視角 N」，N 從清單長度 + 1 起，已經有同名的就往後找 */
export function defaultBookmarkName(list: readonly CameraBookmark[]): string {
  const names = new Set(list.map(b => b.name));
  let n = list.length + 1;
  while (names.has(`視角 ${n}`)) n++;
  return `視角 ${n}`;
}

/** 名字整理成可以存的樣子（去頭尾空白、最多 40 字）；空的 → null */
export function cleanBookmarkName(name: string | null | undefined): string | null {
  const t = (name ?? '').trim().slice(0, CAMERA_BOOKMARK_NAME_MAX);
  return t || null;
}

/** 加在最後面；滿了 → null（呼叫的人跳提示） */
export function addCameraBookmark(list: readonly CameraBookmark[], bm: CameraBookmark): CameraBookmark[] | null {
  if (list.length >= CAMERA_BOOKMARK_MAX) return null;
  const clean = sanitizeCameraBookmark(bm);
  if (!clean || list.some(b => b.id === clean.id)) return null;
  return [...list, clean];
}

export function renameCameraBookmark(list: readonly CameraBookmark[], id: string, name: string): CameraBookmark[] {
  const clean = cleanBookmarkName(name);
  if (!clean) return [...list];
  return list.map(b => (b.id === id ? { ...b, name: clean } : b));
}

export function removeCameraBookmark(list: readonly CameraBookmark[], id: string): CameraBookmark[] {
  return list.filter(b => b.id !== id);
}

/** 往前（-1）或往後（+1）挪一格；已經在頭 / 尾就不動 */
export function moveCameraBookmark(list: readonly CameraBookmark[], id: string, dir: -1 | 1): CameraBookmark[] {
  const i = list.findIndex(b => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// ─────────────────────────────────────────────
// 舊的「這台電腦的視角」搬到專案上
// ─────────────────────────────────────────────

export const LOCAL_BOOKMARKS_KEY_PREFIX = 'sp_camera_bookmarks:';
/** 這台電腦的這個專案：已經回答過「要不要放到專案裡」就記下來，不再問 */
export const LOCAL_OFFER_KEY_PREFIX = 'sp_camera_bookmarks_offer:';

export const localBookmarksKey = (projectId: string) => LOCAL_BOOKMARKS_KEY_PREFIX + projectId;
export const localOfferKey = (projectId: string) => LOCAL_OFFER_KEY_PREFIX + projectId;

/** 舊格式 { id, name, pos, target, fov } 讀成新格式；壞掉的那筆丟掉。代號壞了 / 重複就換一個新的 */
export function parseLocalBookmarks(raw: string | null | undefined, rand: () => number = Math.random): CameraBookmark[] {
  if (!raw) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: CameraBookmark[] = [];
  const used = new Set<string>();
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const [fmin, fmax] = CAMERA_BOOKMARK_FOV_RANGE;
    const fov = finite(o.fov) ? Math.min(fmax, Math.max(fmin, o.fov)) : NaN;
    let id = typeof o.id === 'string' && ID_RE.test(o.id) && !used.has(o.id) ? o.id : '';
    while (!id || used.has(id)) id = newCameraBookmarkId(rand);
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, CAMERA_BOOKMARK_NAME_MAX) : '';
    const bm = sanitizeCameraBookmark({ id, name, position: o.pos ?? o.position, target: o.target, fov });
    if (!bm) continue;
    used.add(bm.id);
    out.push(bm);
    if (out.length >= CAMERA_BOOKMARK_MAX) break;
  }
  return out;
}

/** 兩個視角是不是同一個（名字、位置、看向的點都一樣）：已經放到專案上的不要再放一次 */
export function sameBookmark(a: CameraBookmark, b: CameraBookmark): boolean {
  const near = (u: Vec3, v: Vec3) => u.every((n, i) => Math.abs(n - v[i]) < 1e-3);
  return a.name === b.name && near(a.position, b.position) && near(a.target, b.target);
}

export interface LocalOffer {
  /** 要放上去的（這台電腦有、專案上還沒有的） */
  items: CameraBookmark[];
  /** 問使用者的那句話 */
  question: string;
}

/**
 * 要不要問「這台電腦存了 N 個視角，要放到專案裡讓大家都看得到嗎？」：
 *   - 沒有權限存（動畫師、訪客）→ 不問
 *   - 專案上的清單還沒讀到 → 不問（讀到了才知道有哪些重複）
 *   - 已經回答過 → 不問
 *   - 這台電腦沒有、或全都已經在專案上 → 不問
 */
export function planLocalOffer(opts: {
  canEdit: boolean;
  projectLoaded: boolean;
  answered: boolean;
  local: readonly CameraBookmark[];
  project: readonly CameraBookmark[];
}): LocalOffer | null {
  if (!opts.canEdit || !opts.projectLoaded || opts.answered) return null;
  const items = opts.local.filter(l => !opts.project.some(p => sameBookmark(p, l)));
  if (items.length === 0) return null;
  return { items, question: `這台電腦存了 ${items.length} 個視角，要放到專案裡讓大家都看得到嗎？` };
}

/** 放上去：接在專案清單後面，代號撞到的換新的，超過上限的不放。回傳新清單和實際放了幾個 */
export function mergeLocalIntoProject(
  project: readonly CameraBookmark[], local: readonly CameraBookmark[], rand: () => number = Math.random,
): { list: CameraBookmark[]; added: number } {
  const list = [...project];
  const used = new Set(list.map(b => b.id));
  let added = 0;
  for (const l of local) {
    if (list.length >= CAMERA_BOOKMARK_MAX) break;
    if (list.some(p => sameBookmark(p, l))) continue;
    let id = l.id;
    while (used.has(id)) id = newCameraBookmarkId(rand);
    used.add(id);
    list.push({ ...l, id });
    added++;
  }
  return { list, added };
}
