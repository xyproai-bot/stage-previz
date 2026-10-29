// Cue 庫的純計算核心（不碰資料庫、不碰網路；後台、搬家腳本、匯入都用這一份）。
// 規格：docs/superpowers/specs/2026-10-22-cue-library-design.md（第 10 節是用戶的決定，蓋過前面）
//
// 一個 Cue 庫的 cue = 一個完整的畫面：
//   - 沒提到的物件在預設位置（預設隱藏的就是隱藏）、沒提到的機關在預設位置，沒有「沿用前面的 cue」。
//   - 搬家時把舊 cue「現在實際看到的畫面」整個烤成快照（bakeSlotLook），再解回來（resolve*）結果一模一樣。
//
// 列的格式（跟資料表欄位同名）：
//   物件列   { stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at }
//            position / rotation / scale / custom_props 是 JSON 字串或 null；visible 是 0 / 1 / null
//            own_fields 位元：1 位置、2 角度、4 大小、8 顯示、16 自訂
//   機關列   { mechanism_id, value, delay_sec, duration_sec, carried }

import { resolvedOf } from './mechanismTrack.mjs';

export const OWN_POSITION = 1, OWN_ROTATION = 2, OWN_SCALE = 4, OWN_VISIBLE = 8, OWN_CUSTOM = 16;
export const LABEL_MAX = 16;
export const CUE_NAME_MAX = 100;
export const MAX_LOOK_OBJECTS = 2000;
export const MAX_LOOK_MECHANISMS = 500;
export const SLOT_TIME_MAX = 36000;

const DEFAULT_POSITION = { x: 0, y: 0, z: 0 };
const DEFAULT_ROTATION = { pitch: 0, yaw: 0, roll: 0 };
const DEFAULT_SCALE = { x: 1, y: 1, z: 1 };

function parseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ───────────────────────── 烤成快照 ─────────────────────────

/**
 * 把一個舊 cue 現在實際看到的畫面烤成 Cue 庫的列。
 * @param {object} p
 * @param {object[]} p.states   buildCueStates(...) 對這個 cue 的輸出（含 sources）
 * @param {object[]} p.mechs    這個專案的機關 [{id, defaultValue, travelMin, travelMax, variant?}]（吊掛骨架不算）
 * @param {object}   p.resolved resolveSongMechanisms 對這個 cue 的那一列（mechanismId → {stored, source}）
 * @param {object}   [p.timings] ownTimingsByCue 對這個 cue 的那一列（mechanismId → {delaySec, durationSec}）
 * @returns {{objects: object[], mechanisms: object[]}}
 */
export function bakeSlotLook({ states, mechs, resolved, timings }) {
  const objects = [];
  for (const st of states || []) {
    const src = st.sources || {};
    if (!st.override && !st.tracked) {
      // 沒有任何列：所有欄位都應該是預設
      for (const f of ['position', 'rotation', 'scale', 'visible']) {
        if (src[f] && src[f] !== 'default') throw new Error(`物件 ${st.objectId} 沒有列但 ${f} 不是預設`);
      }
      continue;
    }
    const json = (f) => (src[f] === 'default' ? null : JSON.stringify(st.effective[f]));
    const row = {
      stage_object_id: st.objectId,
      position: json('position'), rotation: json('rotation'), scale: json('scale'),
      visible: src.visible === 'default' ? null : (st.effective.visible ? 1 : 0),
      custom_props: null, own: 0, own_fields: 0, updated_at: null,
    };
    if (st.override) {
      const o = st.override;
      row.own = 1;
      row.own_fields = (o.position != null ? OWN_POSITION : 0) | (o.rotation != null ? OWN_ROTATION : 0)
        | (o.scale != null ? OWN_SCALE : 0) | (o.visible != null ? OWN_VISIBLE : 0)
        | (o.customProps != null ? OWN_CUSTOM : 0);
      row.custom_props = o.customProps != null ? JSON.stringify(o.customProps) : null;
      row.updated_at = o.updatedAt ?? null;
    }
    objects.push(row);
  }

  const mechanisms = [];
  for (const m of mechs || []) {
    if (m.variant === 'hoist_rig') continue;
    const r = resolved?.[m.id];
    if (!r || r.source === 'default') continue;
    if (r.source === 'own') {
      const t = timings?.[m.id];
      mechanisms.push({ mechanism_id: m.id, value: r.stored, delay_sec: t?.delaySec ?? null, duration_sec: t?.durationSec ?? null, carried: 0 });
    } else {
      mechanisms.push({ mechanism_id: m.id, value: r.stored, delay_sec: null, duration_sec: null, carried: 1 });
    }
  }
  return { objects, mechanisms };
}

// ───────────────────────── 解回來 ─────────────────────────

/**
 * Cue 庫的 cue 的物件狀態（跟 buildCueStates 同樣的輸出，沒有「沿用前面的 cue」）。
 * @param {object[]} objectRows 跟 buildCueStates 一樣的物件列（state_* 用不到），順序就是回傳順序
 * @param {object[]} libRows    這個 Cue 庫的 cue 的物件列
 * sources：own = 這個 cue 自己設的、carried = 搬家時帶過來的值、default = 沒設
 */
export function resolveLibraryObjectStates(objectRows, libRows) {
  const byObj = new Map();
  for (const r of libRows || []) byObj.set(r.stage_object_id, r);
  return (objectRows || []).map(row => {
    const def = {
      position: parseJson(row.default_position, DEFAULT_POSITION),
      rotation: parseJson(row.default_rotation, DEFAULT_ROTATION),
      scale: parseJson(row.default_scale, DEFAULT_SCALE),
    };
    const r = byObj.get(row.object_id);
    const own = !!r && Number(r.own) === 1;
    const bits = own ? Number(r.own_fields) : 0;
    const defaultHidden = !!row.default_hidden;
    const field = (col, fallback) => (r && r[col] != null ? parseJson(r[col], fallback) : fallback);
    const sourceOf = (isSet, bit) => (!isSet ? 'default' : (bits & bit) ? 'own' : 'carried');
    return {
      objectId: row.object_id,
      meshName: row.mesh_name,
      displayName: row.display_name || row.mesh_name,
      category: row.category,
      order: row.object_order,
      locked: !!row.object_locked,
      default: def,
      defaultHidden,
      override: own ? {
        position: (bits & OWN_POSITION) ? parseJson(r.position, null) : null,
        rotation: (bits & OWN_ROTATION) ? parseJson(r.rotation, null) : null,
        scale: (bits & OWN_SCALE) ? parseJson(r.scale, null) : null,
        visible: (bits & OWN_VISIBLE) && r.visible != null ? !!r.visible : null,
        customProps: (bits & OWN_CUSTOM) ? parseJson(r.custom_props, null) : null,
        updatedAt: r.updated_at,
      } : null,
      tracked: !!r && !own,
      effective: {
        position: field('position', def.position),
        rotation: field('rotation', def.rotation),
        scale: field('scale', def.scale),
        visible: r && r.visible != null ? !!r.visible : !defaultHidden,
      },
      sources: {
        position: sourceOf(r && r.position != null, OWN_POSITION),
        rotation: sourceOf(r && r.rotation != null, OWN_ROTATION),
        scale: sourceOf(r && r.scale != null, OWN_SCALE),
        visible: sourceOf(r && r.visible != null, OWN_VISIBLE),
      },
    };
  });
}

/**
 * 某首歌的一個 cue（slot）的機關位置，格式跟 resolveSongMechanisms 的一列一樣。
 * @param {object[]} mechs  [{id, defaultValue, travelMin, travelMax}]
 * @param {object[]} rows   這個 Cue 庫的 cue 的機關列
 * @param {string}   slotId 這首歌的 cue id（自己設的機關 fromCueId 填這個）
 * @returns {{row: object, timings: object}} row = mechanismId → {value, stored, source, fromCueId, clamped}；
 *          timings = 只放自己設的、有設時間的（跟 ownTimingsByCue 一樣）
 */
export function resolveSlotMechanisms(mechs, rows, slotId) {
  const byMech = new Map();
  for (const r of rows || []) byMech.set(r.mechanism_id, r);
  const row = {}, timings = {};
  for (const m of mechs || []) {
    const p = byMech.get(m.id);
    if (!p) { row[m.id] = resolvedOf(m, m.defaultValue, 'default', null); continue; }
    if (Number(p.carried) === 1) { row[m.id] = resolvedOf(m, p.value, 'inherited', null); continue; }
    row[m.id] = resolvedOf(m, p.value, 'own', slotId);
    const delaySec = p.delay_sec ?? null, durationSec = p.duration_sec ?? null;
    if (delaySec !== null || durationSec !== null) timings[m.id] = { delaySec, durationSec };
  }
  return { row, timings };
}

// ───────────────────────── 合併 / 搬家計畫 ─────────────────────────

function canon(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v; } }
  return stable(v);
}
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * 兩個 cue 「一模一樣」的判斷用字串：名稱（去頭尾空白）+ 物件列（依物件 id 排）+ 機關列（依機關 id 排）。
 * 不含 updated_at。
 */
export function lookKey({ name, objects, mechanisms }) {
  const cmp = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const objs = (objects || []).map(o => [o.stage_object_id, canon(o.position), canon(o.rotation), canon(o.scale),
    o.visible == null ? null : Number(o.visible), canon(o.custom_props), Number(o.own), Number(o.own_fields)]).sort(cmp);
  const mechs = (mechanisms || []).map(m => [m.mechanism_id, m.value, m.delay_sec ?? null, m.duration_sec ?? null, Number(m.carried)]).sort(cmp);
  return JSON.stringify([String(name ?? '').trim(), objs, mechs]);
}

// 同步 sha256（只拿來產生固定的 id，不是安全用途；後台 / 腳本 / 測試都能用，不靠 node:crypto）
const K256 = (() => {
  const k = []; let n = 2;
  while (k.length < 64) {
    let prime = true;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) { prime = false; break; }
    if (prime) k.push(Math.floor((Math.cbrt(n) % 1) * 2 ** 32) >>> 0);
    n++;
  }
  return k;
})();
export function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const h = [];
  { let n = 2; while (h.length < 8) { let p = true; for (let i = 2; i * i <= n; i++) if (n % i === 0) { p = false; break; } if (p) h.push(Math.floor((Math.sqrt(n) % 1) * 2 ** 32) >>> 0); n++; } }
  const len = bytes.length, total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total); buf.set(bytes); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((len * 8) / 2 ** 32)); dv.setUint32(total - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('');
}

/**
 * 一個專案搬進 Cue 庫的計畫。
 * @param {object} p
 * @param {string} p.projectId
 * @param {{id:string, name:string, code?:string|null, order:number}[]} p.songs
 * @param {{id:string, songId:string, name:string, order:number, createdAt?:string, look:{objects:object[], mechanisms:object[]}}[]} p.slots
 * @returns {{libraryCues: object[], slotToLibrary: Record<string,string>, merged: {name:string, slotIds:string[]}[]}}
 *   libraryCues[i] = { id, label, name, migratedFrom: slotIds, objects, mechanisms }
 *   編號照歌單順序（歌的順序、再來每首歌裡 cue 的順序）第一次出現的順序編 1、2、3…
 *   「一模一樣」= 畫面一樣而且 cue 名稱一樣；合併後名稱用共同的 cue 名稱，沒合併的叫「<歌代號> <cue 名>」
 */
export function planProjectMigration({ projectId, songs, slots }) {
  const songIdx = new Map();
  (songs || []).forEach((s, i) => songIdx.set(s.id, { s, i }));
  const sorted = (slots || []).map((slot, i) => ({ slot, i }))
    .sort((a, b) => {
      const sa = songIdx.get(a.slot.songId), sb = songIdx.get(b.slot.songId);
      const oa = sa ? Number(sa.s.order) : Infinity, ob = sb ? Number(sb.s.order) : Infinity;
      if (oa !== ob) return oa < ob ? -1 : 1;
      if ((sa?.i ?? 0) !== (sb?.i ?? 0)) return (sa?.i ?? 0) - (sb?.i ?? 0);
      if (Number(a.slot.order) !== Number(b.slot.order)) return Number(a.slot.order) - Number(b.slot.order);
      const ca = a.slot.createdAt ?? '', cb = b.slot.createdAt ?? '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.i - b.i;
    })
    .map(x => x.slot);

  const groups = new Map();
  for (const slot of sorted) {
    const key = lookKey({ name: slot.name, objects: slot.look.objects, mechanisms: slot.look.mechanisms });
    let g = groups.get(key);
    if (!g) { g = { slots: [] }; groups.set(key, g); }
    g.slots.push(slot);
  }

  const libraryCues = [], slotToLibrary = {}, merged = [];
  let n = 0;
  for (const g of groups.values()) {
    const first = g.slots[0];
    const cueName = String(first.name ?? '').trim();
    let name;
    if (g.slots.length > 1) {
      name = cueName;
      merged.push({ name: cueName, slotIds: g.slots.map(s => s.id) });
    } else {
      const song = songIdx.get(first.songId)?.s;
      const code = song ? (String(song.code ?? '').trim() || String(song.name ?? '').slice(0, 12)) : '';
      name = `${code} ${cueName}`.trim();
    }
    name = [...name].slice(0, CUE_NAME_MAX).join('');
    const id = 'lc_' + sha256Hex(`${projectId}:${first.id}`).slice(0, 20);
    n += 1;
    libraryCues.push({
      id, label: String(n), name,
      migratedFrom: g.slots.map(s => s.id),
      objects: first.look.objects.map(o => ({ ...o })),
      mechanisms: first.look.mechanisms.map(m => ({ ...m })),
    });
    for (const s of g.slots) slotToLibrary[s.id] = id;
  }
  return { libraryCues, slotToLibrary, merged };
}

// ───────────────────────── 編號（自由文字） ─────────────────────────

/** 預填的建議編號：現有編號裡最大的開頭整數 + 1（文字）；沒有就是 "1" */
export function suggestLabel(existing) {
  let max = 0;
  for (const l of existing || []) {
    const m = /^\s*(\d+)/.exec(String(l ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1);
}

/**
 * 另存 / 複製時自動給的編號：原編號後面加 -1、-2…，挑第一個沒人用的（30 → 30-1 已有 → 30-2）。
 * 原編號本身已經是「30-1」這種 → 從「30」往下找（30-1 是自己、30-2…），不會變成 30-1-1。
 * 太長（超過 16 個字）放不下 → 退回建議編號（最大的開頭整數 + 1）。
 */
export function nextVariantLabel(baseLabel, existing = []) {
  const taken = new Set((existing || []).map(l => String(l ?? '').trim().toLowerCase()));
  const base = String(baseLabel ?? '').trim();
  const root = base.replace(/-\d+$/, '') || base;
  for (let n = 1; n < 1000; n++) {
    const cand = `${root}-${n}`;
    if ([...cand].length > LABEL_MAX) break;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return suggestLabel(existing);
}

function runs(s) {
  return String(s ?? '').trim().toLowerCase().match(/\d+|\D+/g) || [];
}

/** 自然排序：1, 2, 2.5, 3, 3-1, 12, 301（數字段比數字大小，文字段比字面；一樣就回 0，讓呼叫的人用建立順序） */
export function compareLabels(a, b) {
  const ra = runs(a), rb = runs(b);
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const x = ra[i], y = rb[i];
    const dx = /^\d/.test(x), dy = /^\d/.test(y);
    if (dx && dy) {
      const nx = Number(x), ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;  // 01 vs 1：位數少的先
    } else if (dx !== dy) {
      return dx ? -1 : 1;  // 數字段排在文字段前面
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ra.length === rb.length ? 0 : ra.length < rb.length ? -1 : 1;
}

/**
 * 檢查要存的編號。
 * @param {string} input
 * @param {string[]} existing 同專案其他 cue 的編號（改自己的編號時不要放自己的）
 * @returns {{ok:true, label:string}|{ok:false, error:string}}
 */
export function validateLabel(input, existing = []) {
  const label = String(input ?? '').trim();
  if (!label) return { ok: false, error: '編號不能空白' };
  if ([...label].length > LABEL_MAX) return { ok: false, error: `編號最多 ${LABEL_MAX} 個字` };
  const key = label.toLowerCase();
  if ((existing || []).some(e => String(e ?? '').trim().toLowerCase() === key)) return { ok: false, error: '這個編號已經有了' };
  return { ok: true, label };
}

// ───────────────────────── 這首歌的 cue 順序 ─────────────────────────

/**
 * 加 cue / 改時間之後重排：有時間的照時間排；沒有時間的跟在前一個 cue 後面（最前面沒時間的排最前）；
 * 一樣的照原本順序。
 * @param {{id:string, order:number, videoTimeSec:number|null}[]} slots 這首歌目前的 cue（順序看 order，一樣的照傳進來的順序）
 * @returns {{id:string, order:number, videoTimeSec:number|null}[]} 重排好、order = 0..n-1
 */
export function orderSlots(slots) {
  const cur = (slots || []).map((s, i) => ({ s, i })).sort((a, b) => (Number(a.s.order) - Number(b.s.order)) || (a.i - b.i));
  let prev = -1;
  const keyed = cur.map(({ s }, pos) => {
    const t = s.videoTimeSec;
    const key = t != null && Number.isFinite(Number(t)) ? Number(t) : prev;
    prev = key;
    return { s, key, pos };
  });
  keyed.sort((a, b) => (a.key - b.key) || (a.pos - b.pos));
  return keyed.map((k, i) => ({ ...k.s, order: i }));
}

/**
 * 拖拉改順序：orderedIds = 拖完的新順序（整首歌所有 cue）。規則（前端 web/src/lib/songSlots.ts 的 rearrangeSlots 同一個）：
 * - 有時間的 cue 只在有時間的位置之間換；沒時間的只在沒時間的位置之間換（兩種位置各自維持原本的格子）。
 * - 有時間的 cue：照拖完的相對順序，把原本那些時間（由小到大）依序重新分配 → 順序和時間永遠對得上。
 * - 轉場秒數等等都跟著 cue 走，這裡只動順序和時間。
 * @param {{id:string, order:number, videoTimeSec:number|null}[]} slots 目前的 cue（照 order 排）
 * @param {string[]} orderedIds 新順序
 * @returns {{ok:true, ids:string[], times:Record<string, number|null>}|{ok:false, error:string}}
 */
export function rearrangeSlots(slots, orderedIds) {
  const cur = [...(slots || [])].sort((a, b) => Number(a.order) - Number(b.order));
  if (!Array.isArray(orderedIds) || orderedIds.length !== cur.length || new Set(orderedIds).size !== cur.length) return { ok: false, error: '順序要包含這首歌所有的 cue，不能重複' };
  const byId = new Map(cur.map(s => [s.id, s]));
  if (orderedIds.some(id => !byId.has(id))) return { ok: false, error: '順序裡有不是這首歌的 cue' };
  const timed = (s) => typeof s.videoTimeSec === 'number' && Number.isFinite(s.videoTimeSec);
  const timedSeq = orderedIds.map(id => byId.get(id)).filter(timed);
  const plainSeq = orderedIds.map(id => byId.get(id)).filter(s => !timed(s));
  const times = cur.filter(timed).map(s => s.videoTimeSec).sort((a, b) => a - b);
  const ids = [];
  const out = {};
  let ti = 0, pi = 0;
  for (const slot of cur) {
    if (timed(slot)) { const s = timedSeq[ti]; out[s.id] = times[ti]; ids.push(s.id); ti++; }
    else { const s = plainSeq[pi++]; out[s.id] = null; ids.push(s.id); }
  }
  return { ok: true, ids, times: out };
}

// ───────────────────────── 檢查一個畫面 ─────────────────────────

const inRange = (v) => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 3600);

/**
 * 檢查整個畫面（列的格式見檔案開頭）。
 * @param {{objects:object[], mechanisms:object[]}} look
 * @param {{objectIds:Set<string>, mechanisms:Map<string,{variant?:string|null}>}} ctx 這個專案的物件 id、機關
 * @returns {{ok:true}|{ok:false, error:string}}
 */
export function validateLook(look, ctx) {
  const objects = look?.objects, mechanisms = look?.mechanisms;
  if (!Array.isArray(objects) || !Array.isArray(mechanisms)) return { ok: false, error: '畫面格式不對' };
  if (objects.length > MAX_LOOK_OBJECTS) return { ok: false, error: `一個 cue 最多 ${MAX_LOOK_OBJECTS} 個物件` };
  if (mechanisms.length > MAX_LOOK_MECHANISMS) return { ok: false, error: `一個 cue 最多 ${MAX_LOOK_MECHANISMS} 個機關` };
  const seenO = new Set();
  for (const o of objects) {
    if (!o || !ctx.objectIds.has(o.stage_object_id)) return { ok: false, error: '有物件不在這個專案裡' };
    if (seenO.has(o.stage_object_id)) return { ok: false, error: '同一個物件出現兩次' };
    seenO.add(o.stage_object_id);
    if (o.visible != null && o.visible !== 0 && o.visible !== 1) return { ok: false, error: '顯示 / 隱藏的值不對' };
    const own = Number(o.own), bits = Number(o.own_fields ?? 0);
    if (own !== 0 && own !== 1) return { ok: false, error: '物件的「自己設的」標記不對' };
    if (!Number.isInteger(bits) || bits < 0 || bits > 31) return { ok: false, error: '物件的「自己設的欄位」不對' };
    if (own === 0 && bits !== 0) return { ok: false, error: '沿用的物件不能有「自己設的欄位」' };
    for (const f of ['position', 'rotation', 'scale', 'custom_props']) {
      if (o[f] != null) {
        if (typeof o[f] !== 'string') return { ok: false, error: '物件的位置 / 角度 / 大小格式不對' };
        try { JSON.parse(o[f]); } catch { return { ok: false, error: '物件的位置 / 角度 / 大小格式不對' }; }
      }
    }
  }
  const seenM = new Set();
  for (const m of mechanisms) {
    const meta = m && ctx.mechanisms.get(m.mechanism_id);
    if (!meta) return { ok: false, error: '有機關不在這個專案裡' };
    if (meta.variant === 'hoist_rig') return { ok: false, error: '吊掛骨架沒有位置，不能放進 cue' };
    if (seenM.has(m.mechanism_id)) return { ok: false, error: '同一個機關出現兩次' };
    seenM.add(m.mechanism_id);
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) return { ok: false, error: '機關位置不是數字' };
    const carried = Number(m.carried);
    if (carried !== 0 && carried !== 1) return { ok: false, error: '機關的「沿用」標記不對' };
    if (!inRange(m.delay_sec ?? null) || !inRange(m.duration_sec ?? null)) return { ok: false, error: '機關的延遲 / 走幾秒要在 0 到 3600 秒之間' };
    if (carried === 1 && (m.delay_sec != null || m.duration_sec != null)) return { ok: false, error: '沿用的機關不能有時間' };
  }
  return { ok: true };
}
