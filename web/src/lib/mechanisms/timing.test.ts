// v2 第 1 階段：每個 cue 每個機關的「延遲 / 走幾秒」（設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md）
import { describe, it, expect } from 'vitest';
import { buildMechanismTimeline, checkSongMechanisms, MechanismTweener, ownMoveFor, type MotionCue } from './motion';
import { ownTimingsByCue, resolveSongMechanisms } from './track';
import { parseCuePositionBody, parseTimingSeconds, type CueMechanismPosition, type Mechanism } from './model';
import { buildMechanismSheetCsv } from './cueSheet';

const cue = (id: string, order: number, videoTimeSec: number | null, crossfadeSeconds: number): MotionCue =>
  ({ id, order, videoTimeSec, crossfadeSeconds, status: 'master' });
const lift = { id: 'lift', defaultValue: 0, travelMin: 0, travelMax: 3.5, maxSpeed: 0.25 };
const free = { id: 'free', defaultValue: 0, travelMin: 0, travelMax: 10, maxSpeed: null };
const P = (cueId: string, mechanismId: string, value: number, delaySec: number | null = null, durationSec: number | null = null): CueMechanismPosition =>
  ({ cueId, mechanismId, value, delaySec, durationSec, updatedAt: '' });

/** 位置清單 → 時間軸（跟頁面一樣：沿用規則 + 自己設的時間） */
type M = { id: string; defaultValue: number; travelMin: number; travelMax: number; maxSpeed: number | null };
function timelineOf(mechs: M[], cues: MotionCue[], positions: CueMechanismPosition[]) {
  const own = new Map<string, Record<string, number>>();
  for (const p of positions) own.set(p.cueId, { ...(own.get(p.cueId) || {}), [p.mechanismId]: p.value });
  const resolved = resolveSongMechanisms(mechs, cues, own);
  const timings = ownTimingsByCue(positions);
  const tl = buildMechanismTimeline(mechs, cues, id => {
    const r = resolved.get(id);
    return r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value])) : null;
  }, ownMoveFor(resolved, timings))!;
  return { tl, check: checkSongMechanisms(mechs, cues, resolved, timings) };
}

describe('延遲 / 走幾秒', () => {
  // a 0 秒；b 30 秒到位、轉場 20 → GO 10 秒；c 40 秒、轉場 5 → GO 35；d 60 秒、轉場 10 → GO 50
  const cues = [cue('a', 0, 0, 0), cue('b', 1, 30, 20), cue('c', 2, 40, 5), cue('d', 3, 60, 10)];

  it('GO 後 2 秒開始、走 8 秒：12 秒開始動，20 秒到位', () => {
    const { tl, check } = timelineOf([free], cues, [P('a', 'free', 0), P('b', 'free', 4, 2, 8)]);
    expect(tl.valueAt('free', 11.99)).toBe(0);
    expect(tl.valueAt('free', 12)).toBe(0);
    expect(tl.valueAt('free', 16)).toBeCloseTo(2, 9);
    expect(tl.valueAt('free', 20)).toBe(4);
    const mv = tl.moveFor('b', 'free')!;
    expect(mv).toMatchObject({ start: 12, duration: 8, end: 20, explicitDelay: true, explicitDuration: true });
    expect(check.cues.get('b')!.items.free).toMatchObject({ status: 'move', delay: 2, available: 8, startAt: 12, endAt: 20 });
  });

  it('沒設 = 跟著 cue（v1）：GO 出發、到位時間到；時間不沿用到下一個 cue', () => {
    const { tl, check } = timelineOf([free], cues, [P('b', 'free', 4, 2, 8), P('c', 'free', 1)]);
    // c 自己設了位置、沒設時間 → 35 秒出發、40 秒到（跟著轉場 5 秒），不會沿用 b 的延遲 2 / 走 8
    expect(tl.moveFor('c', 'free')).toMatchObject({ start: 35, duration: 5, end: 40, explicitDelay: false, explicitDuration: false });
    expect(check.cues.get('c')!.items.free).toMatchObject({ delay: 0, available: 5, explicitDuration: false });
  });

  it('沿用的 cue 不會打斷還在走的上一段（b 走到 c 的 GO 之後）', () => {
    const { tl, check } = timelineOf([free], cues, [P('b', 'free', 4, 2, 30)]);
    // b 12 秒出發、走 30 秒 → 42 秒到；c、d 沿用 → 機器照樣走它的
    expect(tl.valueAt('free', 37)).toBeCloseTo(4 * 25 / 30, 9);
    expect(tl.valueAt('free', 42)).toBe(4);
    expect(check.cues.get('c')!.items.free.status).toBe('still');
    expect(check.cues.get('c')!.items.free.cut).toBeNull();   // 故意走比較久，沿用的 cue 不會打斷它
  });

  it('走幾秒設得很短：照設的走，不管機器最高速度（升降台 0.25 m/秒，8 秒也走 3.5 m）', () => {
    const { tl, check } = timelineOf([lift], cues, [P('b', 'lift', 3.5, 2, 8)]);
    const c = check.cues.get('b')!;
    expect(c.items.lift).toMatchObject({ status: 'move', available: 8, delay: 2, startAt: 12, endAt: 20, explicitDuration: true, cut: null });
    expect(tl.valueAt('lift', 12)).toBe(0);
    expect(tl.valueAt('lift', 16)).toBeCloseTo(1.75, 9);
    expect(tl.valueAt('lift', 20)).toBe(3.5);
    expect(tl.moveFor('b', 'lift')).toMatchObject({ start: 12, duration: 8, end: 20 });
  });

  it('跟著轉場很短：GO 出發、到位時間準時到', () => {
    const { tl, check } = timelineOf([lift], [cue('a', 0, 0, 0), cue('b', 1, 30, 5)], [P('b', 'lift', 3.5)]);
    expect(check.cues.get('b')!.items.lift).toMatchObject({ status: 'move', available: 5, startAt: 25, endAt: 30, explicitDuration: false });
    expect(tl.valueAt('lift', 27.5)).toBeCloseTo(1.75, 9);
    expect(tl.valueAt('lift', 30)).toBe(3.5);
  });

  it('下一個自己設了的 cue 在這段走完前出發 → 從半路接手、這一段標「被接手」', () => {
    const { tl, check } = timelineOf([lift], cues, [P('b', 'lift', 3.5, 0, 14), P('c', 'lift', 2, 0, 30), P('d', 'lift', 0)]);
    // c 35 秒出發、照設定 65 秒到；d 50 秒出發 → c 在 50 秒被接手，停在 3.5 − 1.5 × 15/30 = 2.75
    expect(tl.moveFor('c', 'lift')!.cut).toEqual({ byCueId: 'd', at: 50, reached: 2.75, started: true });
    expect(check.cues.get('c')!.items.lift.cut).toMatchObject({ byCueId: 'd', reached: 2.75 });
    expect(tl.valueAt('lift', 50)).toBeCloseTo(2.75, 9);
    // d 從 2.75 出發、照 cue 的轉場 10 秒走完：60 秒準時到 0
    expect(tl.valueAt('lift', 55)).toBeCloseTo(1.375, 9);
    expect(tl.valueAt('lift', 60)).toBe(0);
  });

  it('延遲太久：還沒開始動就被下一個 cue 接手 → 取消', () => {
    const { tl, check } = timelineOf([free], cues, [P('b', 'free', 4, 30, 2), P('c', 'free', 1)]);
    // b 40 秒才要出發；c 35 秒就出發 → b 那一段取消
    expect(tl.moveFor('b', 'free')!.cut).toEqual({ byCueId: 'c', at: 35, reached: 0, started: false });
    expect(tl.valueAt('free', 41)).toBe(1);
    expect(check.cues.get('b')!.items.free.cut?.started).toBe(false);
  });

  it('前後亂拉：同一秒一定同一個位置', () => {
    const { tl } = timelineOf([lift, free], cues, [P('b', 'lift', 3.5, 2, 8), P('b', 'free', 5, 1, 40), P('c', 'lift', 1, 3, 2), P('d', 'free', 0, 4)]);
    const times = Array.from({ length: 150 }, (_, i) => i * 0.47);
    const forward = times.map(t => ({ ...tl.valuesAt(t) }));
    const shuffled = times.map((t, i) => ({ t, i })).sort(() => Math.random() - 0.5);
    for (const { t, i } of shuffled) expect(tl.valuesAt(t)).toEqual(forward[i]);
  });
});

describe('點 cue：先等延遲再走', () => {
  const m = [{ id: 'lift', maxSpeed: 0.25 }, { id: 'free', maxSpeed: null }];
  it('照設定走：等 2 秒、走 8 秒；舊的 real 一樣；直接到位：不等', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0, free: 0 }, 0, { animate: false, minSeconds: 0 });
    tw.retarget(m, { lift: 3.5, free: 4 }, 0, {
      animate: true, minSeconds: 5, motion: 'transition', timings: { lift: { delaySec: 2, durationSec: 8 } },
    });
    expect(tw.valueAt('lift', 1999)).toBe(0);
    expect(tw.valueAt('lift', 6000)).toBeCloseTo(1.75, 9);
    expect(tw.valueAt('lift', 10000)).toBe(3.5);
    expect(tw.valueAt('free', 2500)).toBeCloseTo(2, 9);   // 沒設時間 → 跟著轉場 5 秒
    expect(tw.isMoving(1000)).toBe(true);

    tw.retarget(m, { lift: 0, free: 4 }, 20000, { animate: true, minSeconds: 0, motion: 'real', timings: { lift: { delaySec: 1, durationSec: 2 } } });
    expect(tw.valueAt('lift', 21000)).toBe(3.5);              // 等 1 秒
    expect(tw.valueAt('lift', 22000)).toBeCloseTo(1.75, 9);   // 走 2 秒（不管最高速度 0.25 m/秒）
    expect(tw.valueAt('lift', 23000)).toBe(0);

    tw.retarget(m, { lift: 2, free: 4 }, 40000, { animate: true, minSeconds: 0, motion: 'instant', timings: { lift: { delaySec: 5, durationSec: 5 } } });
    expect(tw.valueAt('lift', 40000)).toBe(2);
  });
  it('走 0 秒 = 延遲到了直接切過去', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { free: 0 }, 0, { animate: false, minSeconds: 0 });
    tw.retarget(m, { free: 3 }, 0, { animate: true, minSeconds: 4, motion: 'transition', timings: { free: { delaySec: 1, durationSec: 0 } } });
    expect(tw.valueAt('free', 999)).toBe(0);
    expect(tw.valueAt('free', 1000)).toBe(3);
  });
});

describe('送出去的內容檢查（前後台共用）', () => {
  it('秒數：空白 / null = 跟著 cue；0 ~ 3600；存到 0.001 秒', () => {
    expect(parseTimingSeconds('')).toEqual({ ok: true, value: null });
    expect(parseTimingSeconds(null)).toEqual({ ok: true, value: null });
    expect(parseTimingSeconds('2.5')).toEqual({ ok: true, value: 2.5 });
    expect(parseTimingSeconds(1.23456)).toEqual({ ok: true, value: 1.235 });
    expect(parseTimingSeconds(-1).ok).toBe(false);
    expect(parseTimingSeconds(3601).ok).toBe(false);
    expect(parseTimingSeconds('abc').ok).toBe(false);
  });
  it('PUT：舊版只送位置 → 時間不動；只送時間也可以；錯的給中文', () => {
    expect(parseCuePositionBody({ value: 2 })).toEqual({ ok: true, value: 2 });
    expect(parseCuePositionBody({ delaySec: 2 })).toEqual({ ok: true, delaySec: 2 });
    expect(parseCuePositionBody({ value: 1, durationSec: null })).toEqual({ ok: true, value: 1, durationSec: null });
    expect(parseCuePositionBody({})).toMatchObject({ ok: false, error: '位置要是數字', field: 'value' });
    expect(parseCuePositionBody({ delaySec: -2 })).toMatchObject({ ok: false, error: '延遲要是 0 到 3600 秒，或留空跟著 cue', field: 'delaySec' });
    expect(parseCuePositionBody({ durationSec: 'x' })).toMatchObject({ ok: false, field: 'durationSec' });
  });
  it('只放有設時間的', () => {
    const t = ownTimingsByCue([P('b', 'lift', 1, 2, null), P('b', 'free', 1), P('c', 'lift', 1, null, 4)]);
    expect(Object.fromEntries(t)).toEqual({ b: { lift: { delaySec: 2, durationSec: null } }, c: { lift: { delaySec: null, durationSec: 4 } } });
  });
});

describe('機關總表：延遲 / 開始時間 / 走幾秒', () => {
  const mech: Mechanism = {
    id: 'lift', name: '中央升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 3.5,
    defaultValue: 0, maxSpeed: 0.25, presets: [], parentId: null, objectIds: [], consoleLabel: 'Axis 3', order: 0,
    metadata: null, cueCount: 3, updatedAt: '',
  };
  const song = {
    id: 's1', name: '開場', code: 'S01', order: 0,
    cues: [
      { id: 'a', name: '暗場', order: 0, videoTimeSec: 0, crossfadeSeconds: 0 },
      { id: 'b', name: '升起', order: 1, videoTimeSec: 30, crossfadeSeconds: 20 },
      { id: 'c', name: '半降', order: 2, videoTimeSec: 40, crossfadeSeconds: 5 },
      { id: 'd', name: '收起', order: 3, videoTimeSec: 60, crossfadeSeconds: 10 },
    ],
  };
  it('標準答案（設計文件第 6 節的範例）', () => {
    const csv = buildMechanismSheetCsv({
      songs: [song], mechanisms: [mech], front: { x: 0, y: 0, z: 1 },
      positions: [P('b', 'lift', 3.5, 2, 8), P('c', 'lift', 2, null, 30), P('d', 'lift', 0)],
    });
    expect(csv.replace(/^\ufeff/, '').split('\r\n').slice(0, 5)).toEqual([
      '歌曲 Song,Cue #,Cue 名稱 Cue name,GO 時間 GO,到位時間 Arrive,轉場(秒) Move s,機關 Axis,控台編號 Console,起點 From,目標 Target,單位 Unit,常用位置 Preset,行程 Distance,延遲(秒) Delay s,開始時間 Start,走幾秒 Axis s,備註 Note',
      'S01 開場,1,暗場,0:00.0,0:00.0,0,中央升降台,Axis 3,,0.000,m,,,,,,起始位置',
      'S01 開場,2,升起,0:10.0,0:30.0,20,中央升降台,Axis 3,0.000,3.500,m,,3.500,2.0,0:12.0,8.0,',
      'S01 開場,3,半降,0:35.0,0:40.0,5,中央升降台,Axis 3,3.500,2.000,m,,1.500,0.0,0:35.0,30.0,被 Cue 4 接手，只走到 2.750',
      'S01 開場,4,收起,0:50.0,1:00.0,10,中央升降台,Axis 3,2.000,0.000,m,,2.000,0.0,0:50.0,10.0,',
    ]);
    // 沒有速度欄位、沒有「太快」「來不及」「晚」這類字
    expect(csv).not.toMatch(/速度|Speed|Max|太快|來不及|會晚|Need|需要/);
  });
});
