// 後台（cf-worker/mechanismTrack.mjs）跟前端（track.ts）算「每個 cue 的機關在哪」必須一模一樣：
// 搬進 Cue 庫時後台用 .mjs 烤快照，前端用 track.ts 顯示，兩邊不一樣整個畫面就會跑掉。
// 同一批測資（含規格 1.2 節所有特殊情況 + 隨機組合）兩邊都算，比較全部結果。
import { describe, expect, it } from 'vitest';
import { defaultRow, ownTimingsByCue, ownValuesByCue, resolveSongMechanisms, valuesOf } from './track';
import type { TrackCue, TrackMechanism } from './track';
// @ts-expect-error 後台的 .mjs 沒有型別
import * as server from '../../../../cf-worker/mechanismTrack.mjs';

const MECHS: TrackMechanism[] = [
  { id: 'm1', defaultValue: 0, travelMin: 0, travelMax: 5 },
  { id: 'm2', defaultValue: 10, travelMin: 0, travelMax: 90 },
  { id: 'm3', defaultValue: 1, travelMin: -2, travelMax: 3 },
];
type Pos = { cueId: string; mechanismId: string; value: number; delaySec: number | null; durationSec: number | null };

const FIXTURES: { name: string; cues: TrackCue[]; positions: Pos[] }[] = [
  { name: '沒有 cue', cues: [], positions: [] },
  {
    name: '正式 cue 沿用 + 超出行程',
    cues: [{ id: 'a', order: 0, status: 'master' }, { id: 'b', order: 1, status: 'master' }, { id: 'c', order: 2, status: 'master' }],
    positions: [
      { cueId: 'a', mechanismId: 'm1', value: 2, delaySec: null, durationSec: null },
      { cueId: 'b', mechanismId: 'm1', value: 100, delaySec: 1, durationSec: 2 },
      { cueId: 'b', mechanismId: 'm3', value: -9, delaySec: null, durationSec: 3 },
    ],
  },
  {
    name: '同順序 + 提案 / 備案不往後傳',
    cues: [
      { id: 'a', order: 0, status: 'master' }, { id: 'a2', order: 0, status: 'master' }, { id: 'p', order: 1, status: 'proposal' },
      { id: 'b', order: 2, status: 'master' }, { id: 'alt', order: 3, status: 'alternate' }, { id: 'p0', order: 0, status: 'proposal' },
    ],
    positions: [
      { cueId: 'a', mechanismId: 'm2', value: 30, delaySec: 0.5, durationSec: null },
      { cueId: 'a2', mechanismId: 'm2', value: 40, delaySec: null, durationSec: null },
      { cueId: 'p', mechanismId: 'm1', value: 4, delaySec: 2, durationSec: 2 },
      { cueId: 'p0', mechanismId: 'm3', value: 1, delaySec: null, durationSec: null },
      { cueId: 'alt', mechanismId: 'm2', value: 5, delaySec: null, durationSec: 1 },
    ],
  },
  {
    name: '傳進來的順序跟 order 不一樣',
    cues: [{ id: 'z', order: 5, status: 'master' }, { id: 'y', order: 1, status: 'master' }, { id: 'x', order: 3, status: 'proposal' }],
    positions: [
      { cueId: 'y', mechanismId: 'm1', value: 1, delaySec: null, durationSec: null },
      { cueId: 'z', mechanismId: 'm1', value: 3, delaySec: null, durationSec: null },
    ],
  },
];

// 固定種子的隨機測資
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function randomFixture(seed: number) {
  const r = rng(seed);
  const statuses = ['master', 'master', 'master', 'proposal', 'alternate'];
  const cues: TrackCue[] = Array.from({ length: 2 + Math.floor(r() * 8) }, (_, i) => ({ id: 'c' + i, order: Math.floor(r() * 5), status: statuses[Math.floor(r() * statuses.length)] }));
  const positions: Pos[] = [];
  for (const c of cues) {
    for (const m of MECHS) {
      if (r() < 0.4) {
        positions.push({
          cueId: c.id, mechanismId: m.id, value: Math.round((r() * 120 - 10) * 10) / 10,
          delaySec: r() < 0.3 ? Math.round(r() * 5 * 10) / 10 : null, durationSec: r() < 0.3 ? Math.round(r() * 5 * 10) / 10 : null,
        });
      }
    }
  }
  return { cues, positions };
}

describe('track.ts 跟 cf-worker/mechanismTrack.mjs 結果一樣', () => {
  const all = [...FIXTURES, ...Array.from({ length: 50 }, (_, i) => ({ name: '隨機 ' + i, ...randomFixture(i + 1) }))];
  for (const f of all) {
    it(f.name, () => {
      const web = resolveSongMechanisms(MECHS, f.cues, ownValuesByCue(f.positions));
      const srv = server.resolveSongMechanisms(MECHS, f.cues, server.ownValuesByCue(f.positions));
      expect([...srv.entries()]).toEqual([...web.entries()]);
      expect([...server.ownTimingsByCue(f.positions).entries()]).toEqual([...ownTimingsByCue(f.positions).entries()]);
      for (const [id, row] of web) expect(server.valuesOf(srv.get(id))).toEqual(valuesOf(row));
    });
  }
  it('預設列 / 沒有資料', () => {
    expect(server.defaultRow(MECHS)).toEqual(defaultRow(MECHS));
    expect(server.valuesOf(null)).toEqual(valuesOf(null));
  });
});
