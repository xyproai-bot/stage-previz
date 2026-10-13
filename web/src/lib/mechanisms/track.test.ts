import { describe, it, expect } from 'vitest';
import { resolveSongMechanisms, defaultRow, ownValuesByCue, valuesOf } from './track';

// 升降台 0 ~ 3.5 m、預設 0；轉台 -180 ~ 180°、預設 0
const lift = { id: 'lift', defaultValue: 0, travelMin: 0, travelMax: 3.5 };
const rev = { id: 'rev', defaultValue: 0, travelMin: -180, travelMax: 180 };
const mechs = [lift, rev];
const cue = (id: string, order: number, status = 'master') => ({ id, order, status });
const own = (o: Record<string, Record<string, number>>) => new Map(Object.entries(o));

describe('每個 cue 的機關位置（沿用規則，跟物件位置一樣）', () => {
  it('cue 自己設的優先；沒設 → 沿用前面最近設的；前面都沒設 → 預設位置', () => {
    const cues = [cue('c1', 0), cue('c2', 1), cue('c3', 2)];
    const r = resolveSongMechanisms(mechs, cues, own({ c2: { lift: 3.5 } }));
    expect(r.get('c1')!.lift).toMatchObject({ value: 0, source: 'default', fromCueId: null });
    expect(r.get('c2')!.lift).toMatchObject({ value: 3.5, source: 'own', fromCueId: 'c2' });
    expect(r.get('c3')!.lift).toMatchObject({ value: 3.5, source: 'inherited', fromCueId: 'c2' });
    expect(r.get('c3')!.rev).toMatchObject({ value: 0, source: 'default' });
  });

  it('前面好幾個 cue 都有設 → 用最近的那個（不管傳進來的順序）', () => {
    const cues = [cue('c4', 3), cue('c1', 0), cue('c3', 2), cue('c2', 1)];
    const r = resolveSongMechanisms(mechs, cues, own({ c1: { lift: 1 }, c3: { lift: 2 } }));
    expect(r.get('c4')!.lift).toMatchObject({ value: 2, fromCueId: 'c3', source: 'inherited' });
    expect(r.get('c2')!.lift).toMatchObject({ value: 1, fromCueId: 'c1' });
  });

  it('別的機關的值不會跑過來', () => {
    const r = resolveSongMechanisms(mechs, [cue('c1', 0), cue('c2', 1)], own({ c1: { rev: 90 } }));
    expect(r.get('c2')!.lift.source).toBe('default');
    expect(r.get('c2')!.rev).toMatchObject({ value: 90, source: 'inherited' });
  });

  it('提案不影響正式 cue；提案從前面最近的正式 cue 接著算', () => {
    const cues = [cue('c1', 0), cue('p1', 1, 'proposal'), cue('c2', 2), cue('c3', 3)];
    const r = resolveSongMechanisms(mechs, cues, own({ c1: { lift: 1 }, p1: { lift: 3, rev: 45 } }));
    expect(r.get('c2')!.lift).toMatchObject({ value: 1, fromCueId: 'c1' });
    expect(r.get('c3')!.rev.source).toBe('default');
    expect(r.get('p1')!.lift).toMatchObject({ value: 3, source: 'own' });
    expect(r.get('p1')!.rev).toMatchObject({ value: 45, source: 'own' });
    // 提案沒設的 → 前面最近的正式 cue
    const r2 = resolveSongMechanisms(mechs, cues, own({ c1: { lift: 1 } }));
    expect(r2.get('p1')!.lift).toMatchObject({ value: 1, source: 'inherited', fromCueId: 'c1' });
    expect(r2.get('p1')!.rev).toMatchObject({ value: 0, source: 'default' });
  });

  it('提案在第一個正式 cue 前面 → 從預設位置開始', () => {
    const r = resolveSongMechanisms(mechs, [cue('p0', 0, 'alternate'), cue('c1', 1)], own({ c1: { lift: 2 } }));
    expect(r.get('p0')!.lift.source).toBe('default');
  });

  it('行程後來改窄了：存的值不改，算出來的夾在行程內，標 clamped', () => {
    const narrow = [{ ...lift, travelMax: 2 }, rev];
    const r = resolveSongMechanisms(narrow, [cue('c1', 0), cue('c2', 1)], own({ c1: { lift: 3.5 }, c2: { rev: -200 } }));
    expect(r.get('c1')!.lift).toMatchObject({ value: 2, stored: 3.5, clamped: true });
    expect(r.get('c2')!.lift).toMatchObject({ value: 2, stored: 3.5, clamped: true, source: 'inherited' });
    expect(r.get('c2')!.rev).toMatchObject({ value: -180, stored: -200, clamped: true });
    expect(r.get('c1')!.rev.clamped).toBe(false);
  });

  it('順序一樣的照傳進來的順序', () => {
    const r = resolveSongMechanisms(mechs, [cue('a', 1), cue('b', 1), cue('c', 2)], own({ a: { lift: 1 }, b: { lift: 2 } }));
    expect(r.get('c')!.lift.value).toBe(2);
  });

  it('小工具：預設位置、API 格式 → 每個 cue 的值、只取值', () => {
    expect(valuesOf(defaultRow([{ ...lift, defaultValue: 1 }]))).toEqual({ lift: 1 });
    const m = ownValuesByCue([
      { cueId: 'c1', mechanismId: 'lift', value: 1 },
      { cueId: 'c1', mechanismId: 'rev', value: 90 },
      { cueId: 'c2', mechanismId: 'lift', value: 2 },
    ]);
    expect(m.get('c1')).toEqual({ lift: 1, rev: 90 });
    expect(valuesOf(null)).toEqual({});
  });
});
