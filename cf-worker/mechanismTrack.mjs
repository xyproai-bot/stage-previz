// web/src/lib/mechanisms/track.ts 的 JS 版（一行一行對照移植，純計算，不碰資料庫）。
// 搬進 Cue 庫時要用跟前端一模一樣的算法算出「每個 cue 的機關在哪」，所以這份必須跟 track.ts 結果一致
// （web/src/lib/mechanisms/track.parity.test.ts 用同一批測資比對）。改 track.ts 就要一起改這裡。
//
// 規則：只有正式 cue（master）會往後傳；提案從前面最近的正式 cue 開始再套自己設的；
// 存的值不改，算出來的值夾在行程內（clamped）。

function resolvedOf(m, stored, source, fromCueId) {
  const value = stored < m.travelMin ? m.travelMin : stored > m.travelMax ? m.travelMax : stored;
  return { value, stored, source, fromCueId, clamped: value !== stored };
}

/** 沒選 cue（或還沒有 cue）時：每個機關都在預設位置 */
export function defaultRow(mechs) {
  const row = {};
  for (const m of mechs) row[m.id] = resolvedOf(m, m.defaultValue, 'default', null);
  return row;
}

/** 每個 cue 自己設的位置 [{cueId, mechanismId, value}] → Map cueId → { mechanismId: value } */
export function ownValuesByCue(positions) {
  const out = new Map();
  for (const p of positions) {
    let row = out.get(p.cueId);
    if (!row) { row = {}; out.set(p.cueId, row); }
    row[p.mechanismId] = p.value;
  }
  return out;
}

/** 位置 [{cueId, mechanismId, delaySec, durationSec}] → Map cueId → { mechanismId: {delaySec, durationSec} }（只放有設時間的；時間不沿用） */
export function ownTimingsByCue(positions) {
  const out = new Map();
  for (const p of positions) {
    const delaySec = p.delaySec ?? null, durationSec = p.durationSec ?? null;
    if (delaySec === null && durationSec === null) continue;
    let row = out.get(p.cueId);
    if (!row) { row = {}; out.set(p.cueId, row); }
    row[p.mechanismId] = { delaySec, durationSec };
  }
  return out;
}

/**
 * 一首歌每個 cue 的機關位置。
 * @param mechs  [{id, defaultValue, travelMin, travelMax}]
 * @param cues   [{id, order, status}]（順序看 order，一樣的照傳進來的順序）
 * @param own    Map cueId → { mechanismId: value }
 * @returns Map cueId → { mechanismId: {value, stored, source, fromCueId, clamped} }
 */
export function resolveSongMechanisms(mechs, cues, own) {
  const out = new Map();
  const indexed = cues.map((c, i) => ({ c, i }));
  const byOrder = (a, b) => (a.c.order - b.c.order) || (a.i - b.i);
  const masters = indexed.filter(x => x.c.status === 'master').sort(byOrder);

  const last = new Map();
  const masterRows = [];
  for (const { c } of masters) {
    const mine = own.get(c.id) || {};
    const row = {};
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
    let base = null;
    for (const r of masterRows) { if (r.order < c.order) base = r.row; else break; }
    const mine = own.get(c.id) || {};
    const row = {};
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

/** 算好的一列 → 只要值 */
export function valuesOf(row) {
  const out = {};
  if (!row) return out;
  for (const id in row) out[id] = row[id].value;
  return out;
}

export { resolvedOf };
