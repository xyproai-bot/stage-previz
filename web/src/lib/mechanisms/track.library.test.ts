// 同一份資料：舊模式（自己設的 + 往前沿用）和 Cue 庫模式（每個 cue 一份快照）解出來的機關時間軸要一樣。
// 做法：用舊算法算出每個 cue 的樣子，烤成 Cue 庫的列（沿用來的 = carried、預設 = 沒有列），再用 library 路徑解回來比。
import { describe, expect, it } from 'vitest';
import type { CueMechanismPosition } from './model';
import { ownTimingsByCue, ownValuesByCue, resolvePositions, resolveSongMechanisms, type TrackCue, type TrackMechanism } from './track';

const mechs: TrackMechanism[] = [
  { id: 'a', defaultValue: 0, travelMin: 0, travelMax: 10 },
  { id: 'b', defaultValue: 5, travelMin: 0, travelMax: 8 },
  { id: 'c', defaultValue: 1, travelMin: -2, travelMax: 4 },
];

function pos(cueId: string, mechanismId: string, value: number, t?: [number | null, number | null]): CueMechanismPosition {
  return { cueId, mechanismId, value, delaySec: t?.[0] ?? null, durationSec: t?.[1] ?? null, updatedAt: '' };
}

/** 舊資料 → 烤成 Cue 庫的列（跟搬家程式同一個意思） */
function bake(cues: TrackCue[], legacy: CueMechanismPosition[]): CueMechanismPosition[] {
  const resolved = resolveSongMechanisms(mechs, cues, ownValuesByCue(legacy));
  const times = ownTimingsByCue(legacy);
  const out: CueMechanismPosition[] = [];
  for (const c of cues) for (const m of mechs) {
    const r = resolved.get(c.id)![m.id];
    if (r.source === 'default') continue;
    if (r.source === 'inherited') { out.push({ ...pos(c.id, m.id, r.stored), carried: true }); continue; }
    const t = times.get(c.id)?.[m.id];
    out.push(pos(c.id, m.id, r.stored, [t?.delaySec ?? null, t?.durationSec ?? null]));
  }
  return out;
}

function expectSame(cues: TrackCue[], legacy: CueMechanismPosition[]) {
  const a = resolvePositions('legacy', mechs, cues, legacy);
  const b = resolvePositions('library', mechs, cues, bake(cues, legacy));
  for (const c of cues) for (const m of mechs) {
    const x = a.resolved.get(c.id)![m.id], y = b.resolved.get(c.id)![m.id];
    expect({ value: y.value, stored: y.stored, source: y.source, clamped: y.clamped })
      .toEqual({ value: x.value, stored: x.stored, source: x.source, clamped: x.clamped });
  }
  expect([...b.timings]).toEqual([...a.timings]);
}

const M = (id: string, order: number): TrackCue => ({ id, order, status: 'master' });

describe('legacy 和 library 解出來一樣', () => {
  it('自己設、往後沿用、前面沒設用預設', () => {
    const cues = [M('c1', 1), M('c2', 2), M('c3', 3)];
    expectSame(cues, [pos('c1', 'a', 4), pos('c3', 'a', 9, [0.5, 2]), pos('c2', 'b', 7)]);
  });
  it('提案從前面最近的正式 cue 接著算', () => {
    const cues = [M('c1', 1), { id: 'p', order: 2, status: 'proposal' }, M('c3', 3)];
    expectSame(cues, [pos('c1', 'a', 3), pos('p', 'b', 2), pos('c3', 'c', 4)]);
  });
  it('行程改窄了：值夾住、存的值不變', () => {
    const cues = [M('c1', 1), M('c2', 2)];
    expectSame(cues, [pos('c1', 'a', 99), pos('c2', 'c', -50)]);
  });
  it('一個都沒設', () => { expectSame([M('c1', 1)], []); });
  it('library 不往前沿用：沒列就是預設', () => {
    const r = resolvePositions('library', mechs, [M('c1', 1), M('c2', 2)], [pos('c1', 'a', 6)]);
    expect(r.resolved.get('c2')!.a).toMatchObject({ value: 0, source: 'default' });
  });
  it('隨機組合', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 200; n++) {
      const cues: TrackCue[] = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => ({ id: `c${i}`, order: i + 1, status: rnd() < 0.25 ? 'proposal' : 'master' }));
      const legacy: CueMechanismPosition[] = [];
      for (const c of cues) for (const m of mechs) if (rnd() < 0.4)
        legacy.push(pos(c.id, m.id, Math.round(rnd() * 12 - 2), rnd() < 0.3 ? [Math.round(rnd() * 3), null] : undefined));
      expectSame(cues, legacy);
    }
  });
});
