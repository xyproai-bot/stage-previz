// 每個 cue 的機關位置（沿用規則，跟物件位置 cf-worker/cueStates.mjs 同一套）：
//   1. 這個 cue 自己有設 → 用自己的
//   2. 沒設 → 用同一首歌、順序在前面、最近一個「正式 cue」設的（沿用）
//   3. 前面都沒設 → 機關的預設位置
// 只有正式 cue（master）會往後傳：分享連結只拿得到正式 cue，提案算進來的話分享頁會跟管理頁不一樣。
// 提案 / 備案：從它前面最近的正式 cue 開始，再套自己設的。
// 行程改窄了：存的值不改，算出來的值夾在行程內（clamped = true，畫面上會說）。
// 管理頁、導演頁、工作站、分享頁、機關總表都用這一個函式 → 大家看到的一樣。

import type { CueMechanismPosition, Mechanism, MechanismValues } from './model';

export type ResolvedSource = 'own' | 'inherited' | 'default';

export interface Resolved {
  /** 播放 / 畫面 / 總表用的值（夾在行程內） */
  value: number;
  /** 存的值（沒夾過） */
  stored: number;
  source: ResolvedSource;
  /** 自己設的 = 這個 cue；沿用 = 設定的那個 cue；預設 = null */
  fromCueId: string | null;
  /** 存的值超出行程，被夾到邊界了 */
  clamped: boolean;
}

/** mechanismId → Resolved */
export type ResolvedRow = Record<string, Resolved>;

export type TrackMechanism = Pick<Mechanism, 'id' | 'defaultValue' | 'travelMin' | 'travelMax'>;
export interface TrackCue { id: string; order: number; status: string }

function resolvedOf(m: TrackMechanism, stored: number, source: ResolvedSource, fromCueId: string | null): Resolved {
  const value = stored < m.travelMin ? m.travelMin : stored > m.travelMax ? m.travelMax : stored;
  return { value, stored, source, fromCueId, clamped: value !== stored };
}

/** 沒選 cue（或還沒有 cue）時：每個機關都在預設位置 */
export function defaultRow(mechs: TrackMechanism[]): ResolvedRow {
  const row: ResolvedRow = {};
  for (const m of mechs) row[m.id] = resolvedOf(m, m.defaultValue, 'default', null);
  return row;
}

/** API 回的每個 cue 自己設的位置 → cueId → { mechanismId: value } */
export function ownValuesByCue(positions: Pick<CueMechanismPosition, 'cueId' | 'mechanismId' | 'value'>[]): Map<string, MechanismValues> {
  const out = new Map<string, MechanismValues>();
  for (const p of positions) {
    let row = out.get(p.cueId);
    if (!row) { row = {}; out.set(p.cueId, row); }
    row[p.mechanismId] = p.value;
  }
  return out;
}

/**
 * 一首歌每個 cue 的機關位置。
 * @param mechs  這個專案的機關
 * @param cues   這首歌的 cue（正式 + 提案都可以給；順序看 order，一樣的照傳進來的順序）
 * @param own    cueId → 這個 cue 自己設的值
 */
export function resolveSongMechanisms(
  mechs: TrackMechanism[], cues: TrackCue[], own: Map<string, MechanismValues>,
): Map<string, ResolvedRow> {
  const out = new Map<string, ResolvedRow>();
  const indexed = cues.map((c, i) => ({ c, i }));
  const byOrder = (a: { c: TrackCue; i: number }, b: { c: TrackCue; i: number }) => (a.c.order - b.c.order) || (a.i - b.i);
  const masters = indexed.filter(x => x.c.status === 'master').sort(byOrder);

  const last = new Map<string, { value: number; cueId: string }>();
  // 每個正式 cue 算完之後的樣子（提案從前面最近的正式 cue 接著算）
  const masterRows: { order: number; row: ResolvedRow }[] = [];
  for (const { c } of masters) {
    const mine = own.get(c.id) || {};
    const row: ResolvedRow = {};
    for (const m of mechs) {
      const o = mine[m.id];
      if (o != null && Number.isFinite(o)) {
        row[m.id] = resolvedOf(m, o, 'own', c.id);
        last.set(m.id, { value: o, cueId: c.id });
      } else {
        const l = last.get(m.id);
        row[m.id] = l ? resolvedOf(m, l.value, 'inherited', l.cueId) : resolvedOf(m, m.defaultValue, 'default', null);
      }
    }
    out.set(c.id, row);
    masterRows.push({ order: c.order, row });
  }

  for (const { c } of indexed) {
    if (c.status === 'master') continue;
    let base: ResolvedRow | null = null;
    for (const r of masterRows) { if (r.order < c.order) base = r.row; else break; }
    const mine = own.get(c.id) || {};
    const row: ResolvedRow = {};
    for (const m of mechs) {
      const o = mine[m.id];
      if (o != null && Number.isFinite(o)) { row[m.id] = resolvedOf(m, o, 'own', c.id); continue; }
      const b = base?.[m.id];
      if (!b || b.source === 'default') row[m.id] = resolvedOf(m, m.defaultValue, 'default', null);
      else row[m.id] = resolvedOf(m, b.stored, 'inherited', b.fromCueId);
    }
    out.set(c.id, row);
  }
  return out;
}

/** ResolvedRow → 只要值（給 3D 畫面） */
export function valuesOf(row: ResolvedRow | null | undefined): MechanismValues {
  const out: MechanismValues = {};
  if (!row) return out;
  for (const id in row) out[id] = row[id].value;
  return out;
}
