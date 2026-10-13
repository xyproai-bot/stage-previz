import { describe, it, expect } from 'vitest';
import {
  requiredSeconds, fixSeconds, checkSongMechanisms, buildMechanismTimeline, MechanismTweener, timedOrderMismatch,
  cueGoTimes, formatSeconds, formatMechValue, type MotionCue,
} from './motion';
import { resolveSongMechanisms } from './track';

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

describe('需要幾秒 / 照機器速度要改成幾秒', () => {
  it('需要秒數 = 距離 ÷ 最高速度；沒填速度 = 0', () => {
    expect(requiredSeconds(3.5, 0.25)).toBe(14);
    expect(requiredSeconds(-90, 6)).toBe(15);
    expect(requiredSeconds(3, null)).toBe(0);
  });
  it('往上取到 0.1 秒（浮點誤差不會多 0.1）', () => {
    expect(fixSeconds(14)).toBe(14);
    expect(fixSeconds(14.01)).toBe(14.1);
    expect(fixSeconds(0.3 / 0.1)).toBe(3);
    expect(fixSeconds(1.4 / 0.1)).toBe(14);
  });
});

describe('速度檢查（範例 S03 夜曲）', () => {
  const resolved = resolveSongMechanisms(mechs, sampleCues, sampleOwn);
  const check = checkSongMechanisms(mechs, sampleCues, resolved);

  it('第一個 cue = 起始位置', () => {
    expect(check.cues.get('c1')!.items.lift.status).toBe('start');
  });
  it('來得及 = OK；不動 = 不動', () => {
    const c2 = check.cues.get('c2')!;
    expect(c2.items.lift).toMatchObject({ status: 'ok', from: 0, to: 3.5, need: 14, available: 20 });
    expect(c2.items.rev.status).toBe('still');
    expect(c2.fix).toBeNull();
  });
  it('太快、可以修：fix = 需要的秒數；cue 的 fix = 所有機關最大的', () => {
    const c3 = check.cues.get('c3')!;
    expect(c3.items.rev).toMatchObject({ status: 'tooFast', need: 15, available: 5, fix: 15, reason: null });
    expect(c3.items.slide).toMatchObject({ status: 'tooFast', need: 8, fix: 8 });
    expect(c3.fix).toBe(15);
    expect(c3.problems).toBe(2);
  });
  it('跟上一個 cue 隔太近：改轉場沒用 → fix = null、reason = gap', () => {
    const c4 = check.cues.get('c4')!;
    expect(c4.items.lift).toMatchObject({ status: 'tooFast', need: 14, available: 7, fix: null, reason: 'gap', gap: 7 });
    expect(c4.fix).toBeNull();
  });
  it('沒影片時間的 cue：上一個 = 清單的上一個、可用 = 轉場', () => {
    const c5 = check.cues.get('c5')!;
    expect(c5.items.rev).toMatchObject({ status: 'tooFast', prevCueId: 'c4', from: 90, to: 0, available: 8, fix: 15 });
    expect(c5.items.slide).toMatchObject({ status: 'ok', available: 8, need: 8 });
    expect(c5.items.lift.status).toBe('still');
  });
  it('有問題的 cue 清單', () => {
    expect(check.problemCueIds).toEqual(['c3', 'c4', 'c5']);
    expect(check.orderMismatch).toBe(false);
  });
  it('沒填最高速度 → 不檢查（照轉場走）', () => {
    const noSpeed = [{ ...lift, maxSpeed: null }];
    const cs = [cue('a', 0, null, 1), cue('b', 1, null, 1)];
    const r = resolveSongMechanisms(noSpeed, cs, new Map([['b', { lift: 3 }]]));
    const c = checkSongMechanisms(noSpeed, cs, r);
    expect(c.cues.get('b')!.items.lift.status).toBe('noSpeed');
    expect(c.problemCueIds).toEqual([]);
  });
  it('差 0.05 秒以內不算太快', () => {
    const cs = [cue('a', 0, null, 0), cue('b', 1, null, 13.96)];
    const r = resolveSongMechanisms([lift], cs, new Map([['b', { lift: 3.5 }]]));
    expect(checkSongMechanisms([lift], cs, r).cues.get('b')!.items.lift.status).toBe('ok');
  });
  it('上一段沒走完、但下一個 cue 的時間夠走完剩下的 → 不算晚', () => {
    // a(0s) → b(10s, 轉場 10) 升到 3.5（要 14 秒、太快）→ c(16s, 轉場 6) 不動：
    // c 10 秒開始時在 2.5 m，剩 1 m 要 4 秒 < 6 秒 → 16 秒準時到
    const cs = [cue('a', 0, 0, 0), cue('b', 1, 10, 10), cue('c', 2, 16, 6)];
    const r = resolveSongMechanisms([lift], cs, new Map([['b', { lift: 3.5 }]]));
    const c = checkSongMechanisms([lift], cs, r);
    expect(c.cues.get('b')!.items.lift.status).toBe('tooFast');
    expect(c.cues.get('c')!.items.lift).toMatchObject({ status: 'still', lateBy: null });
  });
  it('上一段還沒走完、這一段本來來得及 → 標出會晚幾秒', () => {
    // b: 30 秒到、轉場 5 → 25 秒開始，要 14 秒 → 39 秒才到；c: 40 秒到、轉場 1（39 秒開始、升降台回 0 要 14 秒）
    // 用另一個情境：c 也到 3.5 → 不動，但 b 在 c 開始時（35 秒）還沒走完
    const cs = [cue('a', 0, 0, 0), cue('b', 1, 30, 5), cue('c', 2, 36, 1)];
    const r = resolveSongMechanisms([lift], cs, new Map([['b', { lift: 3.5 }]]));
    const c = checkSongMechanisms([lift], cs, r);
    // b 25 秒開始 → 39 秒到；c 35 秒開始時在 2.5 m，還差 1 m 要 4 秒 → 39 秒到，比 36 秒晚 3 秒
    expect(c.cues.get('c')!.items.lift).toMatchObject({ status: 'still' });
    expect(c.cues.get('c')!.items.lift.lateBy).toBeCloseTo(3, 6);
    expect(c.problemCueIds).toEqual(['b', 'c']);
  });
  it('cue 順序跟影片時間對不上', () => {
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

  it('太快：照最高速度走，晚到', () => {
    const tl = buildMechanismTimeline([lift], [cue('a', 0, 0, 0), cue('b', 1, 30, 5)], values({ a: { lift: 0 }, b: { lift: 3.5 } }))!;
    // 25 秒開始，0.25 m/秒 → 39 秒才到
    expect(tl.valueAt('lift', 30)).toBeCloseTo(1.25, 9);
    expect(tl.valueAt('lift', 39)).toBe(3.5);
    expect(tl.lateBy('b', 'lift')).toBeCloseTo(9, 9);
  });

  it('晚到的被下一個 cue 接手：從半路接著走', () => {
    const cs = [cue('a', 0, 0, 0), cue('b', 1, 30, 5), cue('c', 2, 40, 5)];
    const tl = buildMechanismTimeline([lift], cs, values({ a: { lift: 0 }, b: { lift: 3.5 }, c: { lift: 0 } }))!;
    // b: 25 秒開始；c: 35 秒開始時在 2.5 m → 往 0 走，要 10 秒 → 45 秒到
    expect(tl.valueAt('lift', 35)).toBeCloseTo(2.5, 9);
    expect(tl.valueAt('lift', 36)).toBeCloseTo(2.25, 9);
    expect(tl.valueAt('lift', 45)).toBe(0);
    expect(tl.lateBy('c', 'lift')).toBeCloseTo(5, 9);
  });

  it('直接切換（轉場 0）：沒填速度 → 那一秒跳過去；有填速度 → 照速度走', () => {
    const noSpeed = { ...lift, maxSpeed: null };
    const cs = [cue('a', 0, 0, 0), cue('b', 1, 10, 0)];
    const v = values({ a: { lift: 0 }, b: { lift: 2 } });
    const t1 = buildMechanismTimeline([noSpeed], cs, v)!;
    expect(t1.valueAt('lift', 9.99)).toBe(0);
    expect(t1.valueAt('lift', 10)).toBe(2);
    const t2 = buildMechanismTimeline([lift], cs, v)!;
    expect(t2.valueAt('lift', 10)).toBe(0);
    expect(t2.valueAt('lift', 14)).toBeCloseTo(1, 9);
    expect(t2.valueAt('lift', 18)).toBe(2);
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

describe('點 cue：照機器速度走過去', () => {
  const m = [{ id: 'lift', maxSpeed: 0.25 }, { id: 'free', maxSpeed: null }];

  it('第一次直接放在目標；換 cue 花 max(轉場, 距離 ÷ 速度) 秒', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0, free: 0 }, 0, { animate: true, minSeconds: 1 });
    expect(tw.valuesAt(0)).toEqual({ lift: 0, free: 0 });
    tw.retarget(m, { lift: 3.5, free: 2 }, 1000, { animate: true, minSeconds: 5 });
    // lift 要 14 秒（> 5）；free 沒速度 → 5 秒
    expect(tw.valueAt('lift', 8000)).toBeCloseTo(1.75, 9);
    expect(tw.valueAt('free', 3500)).toBeCloseTo(1, 9);
    expect(tw.valueAt('free', 6000)).toBe(2);
    expect(tw.valueAt('lift', 15000)).toBe(3.5);
    expect(tw.isMoving(14000)).toBe(true);
    expect(tw.isMoving(15001)).toBe(false);
  });

  it('走到一半換目標：從現在的位置接著走', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0 }, 0, { animate: true, minSeconds: 0 });
    tw.retarget(m, { lift: 3.5 }, 0, { animate: true, minSeconds: 0 });
    expect(tw.valueAt('lift', 4000)).toBeCloseTo(1, 9);
    tw.retarget(m, { lift: 0 }, 4000, { animate: true, minSeconds: 0 });
    expect(tw.valueAt('lift', 4000)).toBeCloseTo(1, 9);
    expect(tw.valueAt('lift', 6000)).toBeCloseTo(0.5, 9);
    expect(tw.valueAt('lift', 8000)).toBe(0);
  });

  it('同一個 cue 裡改值 → 直接跳；別的機關照樣繼續走', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0, free: 0 }, 0, { animate: true, minSeconds: 0 });
    tw.retarget(m, { lift: 3.5, free: 0 }, 0, { animate: true, minSeconds: 0 });
    tw.retarget(m, { lift: 3.5, free: 5 }, 2000, { animate: false, minSeconds: 0 });
    expect(tw.valueAt('free', 2000)).toBe(5);
    expect(tw.valueAt('lift', 2000)).toBeCloseTo(0.5, 9);  // 沒有被跳到終點
  });

  it('直接到位模式 / 放到指定位置後接著走', () => {
    const tw = new MechanismTweener();
    tw.retarget(m, { lift: 0 }, 0, { animate: false, minSeconds: 0 });
    tw.retarget(m, { lift: 2 }, 0, { animate: false, minSeconds: 5 });
    expect(tw.valueAt('lift', 0)).toBe(2);
    tw.setCurrent({ lift: 1 }, 100);
    expect(tw.valueAt('lift', 100)).toBe(1);
    tw.retarget(m, { lift: 2 }, 100, { animate: true, minSeconds: 0 });
    expect(tw.valueAt('lift', 2100)).toBeCloseTo(1.5, 9);
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
