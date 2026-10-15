import { describe, it, expect } from 'vitest';
import {
  checkSongMechanisms, buildMechanismTimeline, MechanismTweener, timedOrderMismatch,
  cueGoTimes, formatSeconds, formatMechValue, moveSeconds, type MotionCue,
} from './motion';
import { resolveSongMechanisms } from './track';

// 2026-10-15：這是預覽工具，機關一律照設定的時間動，不管機器最高速度。
// 下面的機關刻意都填了很慢的最高速度（升降台 0.25 m/秒），用來證明它不影響任何結果。

describe('換 cue 時機關走幾秒', () => {
  it('transition：就是走幾秒（沒設 = 轉場秒數）；0 = 直接切換；instant：0', () => {
    expect(moveSeconds(5)).toBe(5);
    expect(moveSeconds(5, 'transition')).toBe(5);
    expect(moveSeconds(0, 'transition')).toBe(0);
    expect(moveSeconds(-3, 'transition')).toBe(0);
    expect(moveSeconds(5, 'instant')).toBe(0);
  });

  it('舊的 real（照機器速度）已經拿掉：跟 transition 一樣', () => {
    expect(moveSeconds(5, 'real')).toBe(5);
    expect(moveSeconds(0, 'real')).toBe(0);
  });

  it('機關不管最高速度：3.5 m 的升降台轉場 2 秒就是 2 秒到', () => {
    const m = [{ id: 'lift', maxSpeed: 0.25 }];
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0 }, 0, { animate: false, minSeconds: 0 });
    tw.retarget(m, { lift: 3.5 }, 0, { animate: true, minSeconds: 2 });
    expect(tw.valueAt('lift', 1000)).toBeCloseTo(1.75, 9);
    expect(tw.valueAt('lift', 2000)).toBe(3.5);   // 以前照機器速度要 14 秒
    tw.retarget(m, { lift: 0 }, 2000, { animate: true, minSeconds: 0 });
    expect(tw.valueAt('lift', 2000)).toBe(0);     // 轉場 0 = 直接切換（以前也要 14 秒）
    tw.retarget(m, { lift: 3.5 }, 3000, { animate: true, minSeconds: 0, motion: 'real' });
    expect(tw.valueAt('lift', 3000)).toBe(3.5);   // 舊的 'real' 也一樣照轉場
    tw.retarget(m, { lift: 1 }, 20000, { animate: true, minSeconds: 5, motion: 'instant' });
    expect(tw.valueAt('lift', 20000)).toBe(1);
  });
});

const cue = (id: string, order: number, videoTimeSec: number | null, crossfadeSeconds: number, status = 'master'): MotionCue =>
  ({ id, order, videoTimeSec, crossfadeSeconds, status });

// 設計文件第 9 節的範例（S03 夜曲）
const lift = { id: 'lift', defaultValue: 0, travelMin: 0, travelMax: 3.5, maxSpeed: 0.25 };
const rev = { id: 'rev', defaultValue: 0, travelMin: -180, travelMax: 180, maxSpeed: 6 };
const slide = { id: 'slide', defaultValue: 0, travelMin: 0, travelMax: 4, maxSpeed: 0.5 };
const mechs = [lift, rev, slide];
const sampleCues = [
  cue('c1', 0, 0, 0), cue('c2', 1, 30, 20), cue('c3', 2, 65, 5), cue('c4', 3, 72, 10), cue('c5', 4, null, 8),
];
const sampleOwnObj: Record<string, Record<string, number>> = {
  c1: { lift: 0, rev: 0, slide: 0 },
  c2: { lift: 3.5 },
  c3: { rev: 90, slide: 4 },
  c4: { lift: 0 },
  c5: { rev: 0, slide: 0 },
};
const sampleOwn = new Map(Object.entries(sampleOwnObj));

describe('每個 cue 每個機關的時間表（範例 S03 夜曲）', () => {
  const resolved = resolveSongMechanisms(mechs, sampleCues, sampleOwn);
  const check = checkSongMechanisms(mechs, sampleCues, resolved);

  it('第一個 cue = 起始位置', () => {
    expect(check.cues.get('c1')!.items.lift.status).toBe('start');
  });
  it('要動的 = move，GO 出發、到位時間準時到；位置一樣 = still', () => {
    const c2 = check.cues.get('c2')!;
    expect(c2.items.lift).toMatchObject({ status: 'move', from: 0, to: 3.5, available: 20, startAt: 10, endAt: 30, cut: null });
    expect(c2.items.rev.status).toBe('still');
  });
  it('轉場很短（以前叫太快）也照轉場走，不提醒', () => {
    const c3 = check.cues.get('c3')!;
    expect(c3.items.rev).toMatchObject({ status: 'move', available: 5, startAt: 60, endAt: 65 });
    expect(c3.items.slide).toMatchObject({ status: 'move', available: 5, startAt: 60, endAt: 65 });
    // 整個檢查結果沒有任何速度欄位
    const keys = Object.keys(c3.items.rev);
    for (const gone of ['need', 'fix', 'durationFix', 'reason', 'lateBy']) expect(keys).not.toContain(gone);
    expect(Object.keys(c3)).toEqual(['cueId', 'items']);
    expect(Object.keys(check).sort()).toEqual(['cues', 'orderMismatch']);
  });
  it('跟上一個 cue 隔得近：照 cue 的時段走（GO 不會早於上一個 cue 到位）', () => {
    const c4 = check.cues.get('c4')!;
    expect(c4.items.lift).toMatchObject({ status: 'move', prevCueId: 'c3', from: 3.5, to: 0, available: 7, gap: 7, startAt: 65, endAt: 72 });
  });
  it('沒影片時間的 cue：上一個 = 清單的上一個、走的秒數 = 轉場', () => {
    const c5 = check.cues.get('c5')!;
    expect(c5.items.rev).toMatchObject({ status: 'move', prevCueId: 'c4', from: 90, to: 0, available: 8, startAt: null, endAt: null });
    expect(c5.items.slide).toMatchObject({ status: 'move', available: 8 });
    expect(c5.items.lift.status).toBe('still');
  });
  it('沒填最高速度的機關跟有填的一模一樣', () => {
    const noSpeed = [{ ...lift, maxSpeed: null }];
    const cs = [cue('a', 0, null, 1), cue('b', 1, null, 1)];
    const r = resolveSongMechanisms(noSpeed, cs, new Map([['b', { lift: 3 }]]));
    const withSpeed = checkSongMechanisms([lift], cs, resolveSongMechanisms([lift], cs, new Map([['b', { lift: 3 }]])));
    expect(checkSongMechanisms(noSpeed, cs, r).cues.get('b')!.items.lift).toEqual(withSpeed.cues.get('b')!.items.lift);
    expect(withSpeed.cues.get('b')!.items.lift.status).toBe('move');
  });
  it('cue 順序跟影片時間對不上', () => {
    expect(check.orderMismatch).toBe(false);
    expect(timedOrderMismatch([cue('a', 0, 10, 1), cue('b', 1, 5, 1)])).toBe(true);
    expect(timedOrderMismatch([cue('a', 0, 5, 1), cue('x', 1, null, 1), cue('b', 2, 10, 1)])).toBe(false);
  });
  it('GO 時間 = 到位 − 可用秒數', () => {
    const go = cueGoTimes(sampleCues);
    expect(go.get('c2')).toEqual({ go: 10, arrive: 30 });
    expect(go.get('c4')).toEqual({ go: 65, arrive: 72 });
    expect(go.has('c5')).toBe(false);
  });
});

describe('跟著影片時間', () => {
  const values = (o: Record<string, Record<string, number>>) => (id: string) => o[id];

  it('準時到位：開始動 → 等速 → 到位', () => {
    const tl = buildMechanismTimeline([lift], [cue('a', 0, 0, 0), cue('b', 1, 30, 20)], values({ a: { lift: 0 }, b: { lift: 3.5 } }))!;
    expect(tl.valueAt('lift', -5)).toBe(0);    // 第一個 cue 之前
    expect(tl.valueAt('lift', 10)).toBe(0);
    expect(tl.valueAt('lift', 20)).toBeCloseTo(1.75, 9);
    expect(tl.valueAt('lift', 30)).toBe(3.5);
    expect(tl.valueAt('lift', 99)).toBe(3.5);   // 最後一個 cue 之後
  });

  it('轉場很短也準時到：不會因為機器最高速度變慢或晚到', () => {
    const tl = buildMechanismTimeline([lift], [cue('a', 0, 0, 0), cue('b', 1, 30, 5)], values({ a: { lift: 0 }, b: { lift: 3.5 } }))!;
    // 25 秒開始、30 秒到位（0.25 m/秒的升降台以前要 39 秒才到）
    expect(tl.valueAt('lift', 25)).toBe(0);
    expect(tl.valueAt('lift', 27.5)).toBeCloseTo(1.75, 9);
    expect(tl.valueAt('lift', 30)).toBe(3.5);
    expect(tl.moveFor('b', 'lift')).toMatchObject({ start: 25, duration: 5, end: 30 });
    expect('lateBy' in tl).toBe(false);
  });

  it('機關的時間軸每一段只有時間資訊，沒有速度資訊', () => {
    const tl = buildMechanismTimeline([lift], [cue('a', 0, 0, 0), cue('b', 1, 30, 5)], values({ a: { lift: 0 }, b: { lift: 3.5 } }))!;
    const keys = Object.keys(tl.moveFor('b', 'lift')!);
    for (const gone of ['need', 'plannedEnd']) expect(keys).not.toContain(gone);
  });

  it('一段走完之後下一個 cue 才出發：各走各的時間', () => {
    const cs = [cue('a', 0, 0, 0), cue('b', 1, 30, 20), cue('c', 2, 40, 5)];
    const tl = buildMechanismTimeline([lift], cs, values({ a: { lift: 0 }, b: { lift: 3.5 }, c: { lift: 0 } }))!;
    // b：10 秒開始、30 秒到；c：35 秒開始時 b 已經到了（3.5）→ 往 0 走 5 秒
    expect(tl.valueAt('lift', 35)).toBe(3.5);
    expect(tl.valueAt('lift', 37.5)).toBeCloseTo(1.75, 9);
    expect(tl.valueAt('lift', 40)).toBe(0);
  });

  it('直接切換（轉場 0）：有沒有填最高速度都是那一秒跳過去', () => {
    const noSpeed = { ...lift, maxSpeed: null };
    const cs = [cue('a', 0, 0, 0), cue('b', 1, 10, 0)];
    const v = values({ a: { lift: 0 }, b: { lift: 2 } });
    for (const m of [noSpeed, lift]) {
      const t = buildMechanismTimeline([m], cs, v)!;
      expect(t.valueAt('lift', 9.99)).toBe(0);
      expect(t.valueAt('lift', 10)).toBe(2);
    }
  });

  it('時間軸前後亂拉：同一秒一定同一個位置', () => {
    const cs = [cue('a', 0, 0, 0), cue('b', 1, 30, 5), cue('c', 2, 40, 5), cue('d', 3, 70, 30)];
    const tl = buildMechanismTimeline(mechs, cs, values({
      a: { lift: 0, rev: 0, slide: 0 }, b: { lift: 3.5, rev: 90, slide: 4 }, c: { lift: 0, rev: -90, slide: 1 }, d: { lift: 2, rev: 0, slide: 0 },
    }))!;
    const times = Array.from({ length: 200 }, (_, i) => i * 0.43);
    const forward = times.map(t => ({ ...tl.valuesAt(t) }));
    const shuffled = times.map((t, i) => ({ t, i })).sort(() => Math.random() - 0.5);
    for (const { t, i } of shuffled) expect(tl.valuesAt(t)).toEqual(forward[i]);
  });

  it('沒有 cue 設影片時間 → null', () => {
    expect(buildMechanismTimeline([lift], [cue('a', 0, null, 1)], () => ({ lift: 1 }))).toBeNull();
  });
});

describe('點 cue：照走幾秒走過去', () => {
  const m = [{ id: 'lift', maxSpeed: 0.25 }, { id: 'free', maxSpeed: null }];

  it('第一次直接放在目標；換 cue 花轉場秒數，有沒有填最高速度都一樣', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0, free: 0 }, 0, { animate: true, minSeconds: 1 });
    expect(tw.valuesAt(0)).toEqual({ lift: 0, free: 0 });
    tw.retarget(m, { lift: 3.5, free: 2 }, 1000, { animate: true, minSeconds: 5 });
    expect(tw.valueAt('lift', 3500)).toBeCloseTo(1.75, 9);
    expect(tw.valueAt('free', 3500)).toBeCloseTo(1, 9);
    expect(tw.valueAt('lift', 6000)).toBe(3.5);
    expect(tw.valueAt('free', 6000)).toBe(2);
    expect(tw.isMoving(5000)).toBe(true);
    expect(tw.isMoving(6001)).toBe(false);
  });

  it('走到一半換目標：從現在的位置接著走', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0 }, 0, { animate: true, minSeconds: 0 });
    tw.retarget(m, { lift: 3.5 }, 0, { animate: true, minSeconds: 7 });
    expect(tw.valueAt('lift', 2000)).toBeCloseTo(1, 9);
    tw.retarget(m, { lift: 0 }, 2000, { animate: true, minSeconds: 2 });
    expect(tw.valueAt('lift', 2000)).toBeCloseTo(1, 9);
    expect(tw.valueAt('lift', 3000)).toBeCloseTo(0.5, 9);
    expect(tw.valueAt('lift', 4000)).toBe(0);
  });

  it('同一個 cue 裡改值 → 直接跳；別的機關照樣繼續走', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0, free: 0 }, 0, { animate: true, minSeconds: 0 });
    tw.retarget(m, { lift: 3.5, free: 0 }, 0, { animate: true, minSeconds: 7 });
    tw.retarget(m, { lift: 3.5, free: 5 }, 2000, { animate: false, minSeconds: 0 });
    expect(tw.valueAt('free', 2000)).toBe(5);
    expect(tw.valueAt('lift', 2000)).toBeCloseTo(1, 9);  // 沒有被跳到終點
  });

  it('直接到位模式 / 放到指定位置後接著走', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0 }, 0, { animate: false, minSeconds: 0 });
    tw.retarget(m, { lift: 2 }, 0, { animate: false, minSeconds: 5 });
    expect(tw.valueAt('lift', 0)).toBe(2);
    tw.setCurrent({ lift: 1 }, 100);
    expect(tw.valueAt('lift', 100)).toBe(1);
    tw.retarget(m, { lift: 2 }, 100, { animate: true, minSeconds: 2 });
    expect(tw.valueAt('lift', 1100)).toBeCloseTo(1.5, 9);
  });

  it('機關被刪掉 / 沒有目標 → 不再回報', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 1, free: 1 }, 0, { animate: false, minSeconds: 0 });
    tw.retarget([m[0]], { lift: 1 }, 0, { animate: false, minSeconds: 0 });
    expect(tw.valuesAt(0)).toEqual({ lift: 1 });
  });
});

describe('畫面上的數字', () => {
  it('秒數 / 距離', () => {
    expect(formatSeconds(14)).toBe('14');
    expect(formatSeconds(7.46)).toBe('7.5');
    expect(formatMechValue(3.5, 'linear')).toBe('3.5 m');
    expect(formatMechValue(1.23456, 'linear')).toBe('1.235 m');
    expect(formatMechValue(90, 'rotary')).toBe('90°');
    expect(formatMechValue(-0.01, 'rotary', false)).toBe('0');
  });
});
