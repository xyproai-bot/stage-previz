import { describe, it, expect } from 'vitest';
import { buildMechanismSheetCsv } from './cueSheet';
import type { Mechanism } from './model';

const mech = (over: Partial<Mechanism> & Pick<Mechanism, 'id' | 'name'>): Mechanism => ({
  kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 4, defaultValue: 0, maxSpeed: null,
  presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0, metadata: null, cueCount: 0, updatedAt: '', ...over,
});
const lift = mech({ id: 'lift', name: '升降台', consoleLabel: 'Axis 3', order: 0 });
const slide = mech({ id: 'slide', name: '滑軌', axis: { x: -1, y: 0, z: 0 }, consoleLabel: 'Axis 7', order: 1 });

const lc1 = { id: 'L1', label: '12', name: '副歌全開' };
const lc2 = { id: 'L2', label: '3-1', name: '安靜' };
const cue = (id: string, name: string, order: number, t: number, libraryCue: typeof lc1 | null) =>
  ({ id, name, order, videoTimeSec: t, crossfadeSeconds: 5, libraryCue });
const songA = { id: 'sa', name: '夜曲', code: 'S03', order: 0, cues: [cue('c1', '安靜', 0, 0, lc2), cue('c2', '副歌全開', 1, 30, lc1)] };
const songB = { id: 'sb', name: '尾聲', code: 'S04', order: 1, cues: [cue('d1', '副歌全開', 0, 0, lc1)] };
const P = (cueId: string, libraryCueId: string, mechanismId: string, value: number, extra: object = {}) =>
  ({ cueId, mechanismId, value, updatedAt: '', libraryCueId, ...extra });
const positions = [
  P('c1', 'L2', 'lift', 0, { carried: true }), P('c1', 'L2', 'slide', 0, { carried: true }),
  P('c2', 'L1', 'lift', 3.5, { delaySec: 2, durationSec: 10 }), P('c2', 'L1', 'slide', 0, { carried: true }),
  P('d1', 'L1', 'lift', 3.5, { delaySec: 2, durationSec: 10 }), P('d1', 'L1', 'slide', 0, { carried: true }),
];

describe('機關總表：Cue 庫專案', () => {
  const csv = buildMechanismSheetCsv({ mode: 'library', songs: [songA, songB], positions, mechanisms: [lift, slide], front: null });
  const lines = csv.replace(/^﻿/, '').split('\r\n');

  it('表頭在 Cue # 後面多「Cue 編號」，每行帶編號', () => {
    expect(lines[0].split(',').slice(0, 4)).toEqual(['歌曲 Song', 'Cue #', 'Cue 編號', 'Cue 名稱 Cue name']);
    expect(lines[1].startsWith('S03 夜曲,1,3-1,安靜,')).toBe(true);
    expect(lines.some(l => l.startsWith('S03 夜曲,2,12,副歌全開,'))).toBe(true);
    expect(lines.some(l => l.startsWith('S04 尾聲,1,12,副歌全開,'))).toBe(true);
  });

  it('多一段「Cue 庫」：編號照自然排序，每個 cue × 機關一行', () => {
    const at = lines.findIndex(l => l.startsWith('# Cue 庫'));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1].split(',').slice(0, 3)).toEqual(['Cue 編號', 'Cue 名稱 Cue name', '機關 Axis']);
    const rows = lines.slice(at + 2).filter(l => l && !l.startsWith('#'));
    expect(rows).toEqual([
      '3-1,安靜,升降台,Axis 3,0.000,m,,,沿用,S03 夜曲',
      '3-1,安靜,滑軌,Axis 7,0.000,m,,,沿用,S03 夜曲',
      '12,副歌全開,升降台,Axis 3,3.500,m,2.0,10.0,自己設,S03 夜曲、S04 尾聲',
      '12,副歌全開,滑軌,Axis 7,0.000,m,,,沿用,S03 夜曲、S04 尾聲',
    ]);
  });

  it('舊模式專案：欄位和段落都不變', () => {
    const legacy = buildMechanismSheetCsv({ mode: 'legacy', songs: [songA], positions: [], mechanisms: [lift], front: null });
    expect(legacy).not.toContain('Cue 編號');
    expect(legacy).not.toContain('# Cue 庫');
    const none = buildMechanismSheetCsv({ songs: [songA], positions: [], mechanisms: [lift], front: null });
    expect(none).toBe(legacy);
  });
});
