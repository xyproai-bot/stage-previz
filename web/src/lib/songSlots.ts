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
