// 「這首歌的 cue」（Cue 庫專案）的純邏輯：照時間排、同時間擋、順序跟時間對不上的提示、列上的字。規格 5.3、2.3、第 10 節。
// orderSlots 跟後台 cf-worker/cueLibrary.mjs 的 orderSlots 是同一個規則（有時間的照時間；沒有時間的跟在前一個後面；同時間維持原順序）。

export interface SlotLike {
  id: string;
  order: number;
  videoTimeSec: number | null;
}

/** 照時間重新排，order 重寫成 0..n-1 */
export function orderSlots<T extends SlotLike>(slots: T[]): T[] {
  const cur = slots.map((s, i) => ({ s, i })).sort((a, b) => (Number(a.s.order) - Number(b.s.order)) || (a.i - b.i));
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

/** 目前的清單順序跟時間順序不一致（要顯示提示、讓製作按「現在照時間排」） */
export function slotsOutOfOrder(slots: SlotLike[]): boolean {
  const cur = [...slots].sort((a, b) => a.order - b.order).map(s => s.id);
  const want = orderSlots(slots).map(s => s.id);
  return cur.some((id, i) => id !== want[i]);
}

/** 照時間排好之後的 cue id（給 reorder 用） */
export function sortedSlotIds(slots: SlotLike[]): string[] {
  return orderSlots(slots).map(s => s.id);
}

/** 這首歌裡這個時間已經有 cue 了嗎（後台的規則：差不到 0.0005 秒算同一個時間）。exceptId = 正在改的那個 cue 自己 */
export function timeTaken(slots: SlotLike[], sec: number | null, exceptId?: string): boolean {
  if (sec === null || !Number.isFinite(sec)) return false;
  return slots.some(s => s.id !== exceptId && s.videoTimeSec !== null && Math.abs(s.videoTimeSec - sec) < 0.0005);
}

/** 秒數 → 0:00 或 1:23.5（有小數才顯示小數） */
export function fmtSlotTime(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '沒有時間';
  const total = Math.max(0, Math.round(sec * 1000) / 1000);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const whole = Math.floor(s);
  const frac = Math.round((s - whole) * 1000);
  const fracText = frac === 0 ? '' : '.' + String(frac).padStart(3, '0').replace(/0+$/, '');
  return `${m}:${String(whole).padStart(2, '0')}${fracText}`;
}

/** 欄位 / 後台「同時間」的提示 */
export function timeTakenText(sec: number): string {
  return `這首歌 ${fmtSlotTime(sec)} 已經有 cue 了`;
}

/** 這個 cue 後面有沒有 LED 版型的切換點跟著（拿掉前要提醒） */
export function ledSwitchFollows(switches: { cueId: string | null }[], cueId: string): boolean {
  return switches.some(s => s.cueId === cueId);
}

export const OUT_OF_ORDER_TEXT = '這首歌的 cue 順序跟影片時間對不上；之後改時間或加 cue，會照時間重新排。';
export const EMPTY_SONG_TEXT = '這首歌還沒有 cue。從 Cue 庫加一個，整首歌就用那個畫面。';
export const EMPTY_LIBRARY_TEXT = 'Cue 庫還是空的：先把舞台擺好，按「另存成新的 cue」。';

// ───────────────────────── 拖拉改順序 ─────────────────────────
// 規則（後台 cf-worker/cueLibrary.mjs 的 rearrangeSlots 是同一個）：
// - 有時間的 cue 只在「有時間的位置」之間換；沒時間的 cue 只在「沒時間的位置」之間換。
// - 有時間的 cue：照拖完的順序，把原本那些時間（由小到大）依序重新分配，順序和時間永遠對得上。
// - 轉場秒數等其他東西跟著 cue 走。

const isTimed = (s: SlotLike): boolean => typeof s.videoTimeSec === 'number' && Number.isFinite(s.videoTimeSec);

export interface Rearranged { ids: string[]; times: Record<string, number | null> }

/** 拖完的新順序 → 最後的順序 + 每個 cue 的新時間；順序不是這首歌全部的 cue 就回 null */
export function rearrangeSlots(slots: SlotLike[], orderedIds: string[]): Rearranged | null {
  const cur = [...slots].sort((a, b) => Number(a.order) - Number(b.order));
  if (orderedIds.length !== cur.length || new Set(orderedIds).size !== cur.length) return null;
  const byId = new Map(cur.map(s => [s.id, s]));
  if (orderedIds.some(id => !byId.has(id))) return null;
  const seq = orderedIds.map(id => byId.get(id)!);
  const timedSeq = seq.filter(isTimed);
  const plainSeq = seq.filter(s => !isTimed(s));
  const times = cur.filter(isTimed).map(s => s.videoTimeSec as number).sort((a, b) => a - b);
  const ids: string[] = [];
  const out: Record<string, number | null> = {};
  let ti = 0, pi = 0;
  for (const slot of cur) {
    if (isTimed(slot)) { const s = timedSeq[ti]; out[s.id] = times[ti]; ids.push(s.id); ti++; }
    else { const s = plainSeq[pi++]; out[s.id] = null; ids.push(s.id); }
  }
  return { ids, times: out };
}

/** 這個 cue 可以拖到那個 cue 的位置嗎（有時間的只能換到有時間的位置，沒時間的只能換到沒時間的位置） */
export function canDragOnto(slots: SlotLike[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const a = slots.find(s => s.id === fromId), b = slots.find(s => s.id === toId);
  return !!a && !!b && isTimed(a) === isTimed(b);
}

/** 把 fromId 拖到 toId 的位置（中間經過的 cue 順延）；不能拖就回 null。回傳新的順序 + 新時間 */
export function dragReorder(slots: SlotLike[], fromId: string, toId: string): Rearranged | null {
  if (!canDragOnto(slots, fromId, toId)) return null;
  const ids = [...slots].sort((a, b) => Number(a.order) - Number(b.order)).map(s => s.id);
  const from = ids.indexOf(fromId), to = ids.indexOf(toId);
  ids.splice(from, 1);
  ids.splice(to, 0, fromId);
  return rearrangeSlots(slots, ids);
}

/** 上下鍵：往上或往下找最近一個「同一種」（都有時間或都沒時間）的 cue 換過去；找不到 null */
export function stepTarget(slots: SlotLike[], id: string, dir: -1 | 1): string | null {
  const list = [...slots].sort((a, b) => Number(a.order) - Number(b.order));
  const i = list.findIndex(s => s.id === id);
  if (i < 0) return null;
  for (let j = i + dir; j >= 0 && j < list.length; j += dir) if (isTimed(list[j]) === isTimed(list[i])) return list[j].id;
  return null;
}

/** 清單下面那一句說明（有時間和沒時間混在一起才多講規則） */
export function dragHintText(slots: SlotLike[]): string {
  if (slots.length < 2) return '';
  const timed = slots.filter(isTimed).length;
  const base = '按住左邊的把手上下拖，可以換順序';
  if (timed === 0) return base + '。';
  if (timed === slots.length) return base + '：被拖過的 cue 會重新分配這幾個時間，順序永遠照時間。';
  return base + '：有時間的 cue 只能拖到有時間的位置（時間重新分配，順序永遠照時間），沒時間的只能拖到沒時間的位置。';
}
