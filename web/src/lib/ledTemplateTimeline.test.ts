// 中途換版型的純邏輯：時間的寫法、換版型的點 → 時間線、邊界那一格、檢查（畫布大小一樣等）、影片快照的存與讀
import { describe, expect, it } from 'vitest';
import type { LedTemplatePlan } from './ledTemplate';
import {
  MAX_SWITCHES, SWITCH_EPS, buildTimeline, canvasMismatch, checkTimeline, formatSwitchTime, nextSwitchAfter, normalizeTimelineInput,
  parseSwitches, parseSwitchTime, parseTimeline, planAt, segmentIndexAt, serializeTimeline, switchSentence, switchTime, timelineSummary,
  unresolvedSwitchText, type CueTimes, type TimelineSwitch, type TimelineTemplateInfo,
} from './ledTemplateTimeline';

const CANVAS = { width: 4400, height: 200 };
const plan = (id: string, name = id, canvas = CANVAS): LedTemplatePlan => ({
  v: 1, id, name, canvas, scalePct: 50,
  screens: [{ key: 'o:oa', objectId: 'oa', uv: null, dest: { x: 0, y: 0, w: 100, h: 100 }, rotate: 0, flipH: false, flipV: false }],
});
const A = plan('A', '版型 A');
const B = plan('B', '版型 B');
const C = plan('C', '版型 C');
const PLANS = new Map([['A', A], ['B', B], ['C', C]]);
const sw = (id: string, templateId: string, o: Partial<TimelineSwitch> = {}): TimelineSwitch => ({ id, cueId: null, atSec: null, templateId, ...o });
const cues = (o: Record<string, [string, number | null]>): CueTimes => new Map(Object.entries(o).map(([id, [name, timeSec]]) => [id, { name, timeSec }]));

describe('時間的寫法', () => {
  it('formatSwitchTime：m:ss.s，一小時以上 h:mm:ss.s', () => {
    expect(formatSwitchTime(83)).toBe('1:23.0');
    expect(formatSwitchTime(5.5)).toBe('0:05.5');
    expect(formatSwitchTime(0)).toBe('0:00.0');
    expect(formatSwitchTime(3723.04)).toBe('1:02:03.0');
    expect(formatSwitchTime(-4)).toBe('0:00.0');
  });
  it('parseSwitchTime：秒、分:秒、時:分:秒、全形冒號；看不懂 = null', () => {
    expect(parseSwitchTime('83')).toBe(83);
    expect(parseSwitchTime('83.5')).toBe(83.5);
    expect(parseSwitchTime('1:23')).toBe(83);
    expect(parseSwitchTime('1：23.5')).toBe(83.5);
    expect(parseSwitchTime('1:02:03')).toBe(3723);
    expect(parseSwitchTime('')).toBeNull();
    expect(parseSwitchTime('abc')).toBeNull();
    expect(parseSwitchTime('1:75')).toBeNull();
    expect(parseSwitchTime('-5')).toBeNull();
    expect(parseSwitchTime('1:2:3:4')).toBeNull();
    expect(parseSwitchTime('99999')).toBeNull();
  });
});

describe('switchTime：Cue 的點跟著 Cue 的時間走', () => {
  it('Cue 的點：畫面上最新的 Cue 時間優先，沒有就用後台一起給的；Cue 沒時間 / 不見了 = null', () => {
    const s = sw('1', 'B', { cueId: 'c4', atSec: 83, cueTimeSec: 83 });
    expect(switchTime(s)).toBe(83);
    expect(switchTime(s, cues({ c4: ['Cue 4', 90] }))).toBe(90);
    expect(switchTime(s, cues({ c4: ['Cue 4', null] }))).toBeNull();
    expect(switchTime({ ...s, cueTimeSec: null })).toBeNull();
    // Cue 不在清單裡（還沒載入）：退回後台給的
    expect(switchTime(s, cues({ other: ['x', 5] }))).toBe(83);
  });
  it('純時間的點', () => {
    expect(switchTime(sw('1', 'B', { atSec: 20.5 }))).toBe(20.5);
    expect(switchTime(sw('1', 'B', { atSec: null }))).toBeNull();
    expect(switchTime(sw('1', 'B', { atSec: -1 }))).toBeNull();
  });
  it('parseSwitches：壞資料略過，舊的後台沒有欄位 = 空', () => {
    expect(parseSwitches(undefined)).toEqual([]);
    expect(parseSwitches('x')).toEqual([]);
    const ok = parseSwitches([
      { id: 'a', cueId: 'c1', cueName: 'Cue 1', cueTimeSec: 5, atSec: 5, templateId: 'B' },
      { id: 'b', cueId: null, atSec: 7, templateId: 'C' },
      { id: 3 }, null, { id: 'c' },
    ]);
    expect(ok.map(x => [x.id, x.cueId, x.cueName, x.cueTimeSec, x.atSec, x.templateId])).toEqual([
      ['a', 'c1', 'Cue 1', 5, 5, 'B'], ['b', null, null, null, 7, 'C'],
    ]);
  });
});

describe('buildTimeline', () => {
  it('開頭 + 兩個點 → 三段，照時間排，Cue 的名字當段落的說明', () => {
    const tl = buildTimeline(A, [sw('2', 'C', { atSec: 130 }), sw('1', 'B', { cueId: 'c4', cueTimeSec: 83, cueName: 'Cue 4' })], PLANS)!;
    expect(tl.segments.map(s => [s.fromSec, s.templateId, s.label])).toEqual([[0, 'A', null], [83, 'B', 'Cue 4'], [130, 'C', null]]);
    expect(timelineSummary(tl)).toBe('版型 A → 版型 B（Cue 4 · 1:23.0） → 版型 C（2:10.0）');
  });
  it('沒有開頭版型（整張畫布）/ 沒有點 / 算不出時間 / 版型找不到 → null（就是單一版型）', () => {
    expect(buildTimeline(null, [sw('1', 'B', { atSec: 5 })], PLANS)).toBeNull();
    expect(buildTimeline(A, [], PLANS)).toBeNull();
    expect(buildTimeline(A, [sw('1', 'B', { cueId: 'c', cueTimeSec: null })], PLANS)).toBeNull();
    expect(buildTimeline(A, [sw('1', 'Z', { atSec: 5 })], PLANS)).toBeNull();
  });
  it('算不出時間的點略過，其他照常', () => {
    const tl = buildTimeline(A, [sw('1', 'B', { cueId: 'c', cueTimeSec: null }), sw('2', 'C', { atSec: 9 })], PLANS)!;
    expect(tl.segments.map(s => s.templateId)).toEqual(['A', 'C']);
  });
  it('Cue 的時間用畫面上最新的', () => {
    const s = [sw('1', 'B', { cueId: 'c4', cueTimeSec: 83, cueName: 'Cue 4' })];
    expect(buildTimeline(A, s, PLANS, cues({ c4: ['第四個 Cue', 95] }))!.segments[1]).toMatchObject({ fromSec: 95, label: '第四個 Cue' });
  });
  it('同一個時間兩個點：排後面的算；換成跟上一段一樣的版型併成一段；0 秒的點就是改開頭', () => {
    const same = buildTimeline(A, [sw('1', 'B', { atSec: 10 }), sw('2', 'C', { atSec: 10 })], PLANS)!;
    expect(same.segments.map(s => [s.fromSec, s.templateId])).toEqual([[0, 'A'], [10, 'C']]);
    expect(buildTimeline(A, [sw('1', 'A', { atSec: 10 })], PLANS)).toBeNull();
    const merged = buildTimeline(A, [sw('1', 'B', { atSec: 10 }), sw('2', 'B', { atSec: 20 }), sw('3', 'A', { atSec: 30 })], PLANS)!;
    expect(merged.segments.map(s => [s.fromSec, s.templateId])).toEqual([[0, 'A'], [10, 'B'], [30, 'A']]);
    const zero = buildTimeline(A, [sw('1', 'B', { atSec: 0 }), sw('2', 'C', { atSec: 5 })], PLANS)!;
    expect(zero.segments.map(s => [s.fromSec, s.templateId])).toEqual([[0, 'B'], [5, 'C']]);
  });
});

describe('segmentIndexAt：換版型的那一格', () => {
  const tl = buildTimeline(A, [sw('1', 'B', { atSec: 83 }), sw('2', 'C', { atSec: 130 })], PLANS)!;
  it('剛好在換版型的時間 = 新的那一段；前一格（30 fps 差 33 毫秒）還是舊的', () => {
    expect(segmentIndexAt(tl, 0)).toBe(0);
    expect(segmentIndexAt(tl, 82.9667)).toBe(0);
    expect(segmentIndexAt(tl, 83)).toBe(1);
    expect(segmentIndexAt(tl, 83.0333)).toBe(1);
    expect(segmentIndexAt(tl, 129.9667)).toBe(1);
    expect(segmentIndexAt(tl, 130)).toBe(2);
    expect(segmentIndexAt(tl, 99999)).toBe(2);
  });
  it('浮點誤差 2 毫秒內算進新的一段；60 fps 的前一格（16.7 毫秒）還是舊的', () => {
    expect(segmentIndexAt(tl, 83 - SWITCH_EPS / 2)).toBe(1);
    expect(segmentIndexAt(tl, 83 - 0.0167)).toBe(0);
    expect(segmentIndexAt(tl, 2490 / 30)).toBe(1);        // 30 fps 的第 2490 格 = 83.0
    expect(segmentIndexAt(tl, 2489 / 30)).toBe(0);
  });
  it('來回拉時間軸：結果只看時間，跟上一次是多少無關', () => {
    const order = [0, 100, 83, 82.99, 140, 5, 130, 129.99, 83.001, 0];
    expect(order.map(t => segmentIndexAt(tl, t))).toEqual([0, 1, 1, 0, 2, 0, 2, 1, 1, 0]);
  });
  it('負的、NaN = 第一段', () => {
    expect(segmentIndexAt(tl, -5)).toBe(0);
    expect(segmentIndexAt(tl, Number.NaN)).toBe(0);
  });
  it('planAt / nextSwitchAfter', () => {
    expect(planAt(tl, 10).id).toBe('A');
    expect(planAt(tl, 90).id).toBe('B');
    expect(nextSwitchAfter(tl, 10)).toMatchObject({ index: 1, segment: { fromSec: 83 } });
    expect(nextSwitchAfter(tl, 100)).toMatchObject({ index: 2 });
    expect(nextSwitchAfter(tl, 200)).toBeNull();
  });
});

describe('說明文字', () => {
  it('switchSentence：從 Cue 4（1:23.0）起換成「版型 B」', () => {
    expect(switchSentence('Cue 4', 83, '版型 B')).toBe('從 Cue 4（1:23.0）起換成「版型 B」');
    expect(switchSentence(null, 83.5, '版型 B')).toBe('從 1:23.5 起換成「版型 B」');
  });
  it('unresolvedSwitchText', () => {
    expect(unresolvedSwitchText('Cue 4', '版型 B')).toMatch(/Cue 4 還沒有影片時間/);
    expect(unresolvedSwitchText(null, '版型 B')).toMatch(/時間不對/);
  });
});

describe('畫布大小要一樣', () => {
  const info = (id: string, w: number, h: number, kind: 'full' | 'custom' = 'custom'): TimelineTemplateInfo => ({ id, name: `版型 ${id}`, kind, canvas: { width: w, height: h } });
  it('一樣大 → null；不一樣 → 中文說明，講出兩個版型各是多大', () => {
    expect(canvasMismatch([info('A', 4400, 200), info('B', 4400, 200)])).toBeNull();
    const msg = canvasMismatch([info('A', 4400, 200), info('B', 2200, 100)])!;
    expect(msg).toContain('版型 A');
    expect(msg).toContain('4400×200');
    expect(msg).toContain('版型 B');
    expect(msg).toContain('2200×100');
    expect(msg).toMatch(/一樣大/);
  });
  it('等比例（一半大小）也不行：影片只有一個大小', () => {
    expect(canvasMismatch([info('A', 4400, 200), info('B', 2200, 100)])).not.toBeNull();
  });
  it('不到兩個 / 沒有畫布 → null', () => {
    expect(canvasMismatch([])).toBeNull();
    expect(canvasMismatch([info('A', 100, 100)])).toBeNull();
    expect(canvasMismatch([{ id: 'F', name: '全部', kind: 'full', canvas: null }, info('A', 100, 100)])).toBeNull();
  });
});

describe('normalizeTimelineInput', () => {
  it('收下 Cue 的點和時間的點；時間可以是字串；開頭可以沒有', () => {
    const r = normalizeTimelineInput({ start: 'lt_a', switches: [{ cueId: 'c1', templateId: 'lt_b' }, { atSec: '1:23.5', templateId: 'lt_c' }, { atSec: 9, templateId: 'lt_b' }] });
    expect(r).toEqual({ ok: true, value: { start: 'lt_a', switches: [{ cueId: 'c1', templateId: 'lt_b' }, { atSec: 83.5, templateId: 'lt_c' }, { atSec: 9, templateId: 'lt_b' }] } });
    expect(normalizeTimelineInput({ start: null })).toEqual({ ok: true, value: { start: null, switches: [] } });
    expect(normalizeTimelineInput({})).toEqual({ ok: true, value: { start: null, switches: [] } });
  });
  it('壞格式都有中文說明', () => {
    const bad = (b: unknown) => { const r = normalizeTimelineInput(b); expect(r.ok).toBe(false); return r.ok ? '' : r.error; };
    expect(bad(null)).toBeTruthy();
    expect(bad({ start: 5 })).toMatch(/開頭/);
    expect(bad({ switches: 'x' })).toMatch(/陣列/);
    expect(bad({ switches: [null] })).toMatch(/第 1 個/);
    expect(bad({ switches: [{ cueId: 'c', atSec: 5, templateId: 'a' }] })).toMatch(/二選一/);
    expect(bad({ switches: [{ templateId: 'a' }] })).toMatch(/二選一/);
    expect(bad({ switches: [{ atSec: -1, templateId: 'a' }] })).toMatch(/時間/);
    expect(bad({ switches: [{ atSec: 5 }] })).toMatch(/選一個版型/);
    expect(bad({ switches: Array.from({ length: MAX_SWITCHES + 1 }, () => ({ atSec: 5, templateId: 'a' })) })).toMatch(/最多/);
  });
});

describe('checkTimeline', () => {
  const T = (id: string, name: string, w = 4400, h = 200, kind: 'full' | 'custom' = 'custom'): [string, TimelineTemplateInfo] => [id, { id, name, kind, canvas: { width: w, height: h } }];
  const templates = new Map([T('A', '版型 A'), T('B', '版型 B'), T('C', '版型 C', 2200, 100), T('F', '全部', 8800, 2024, 'full')]);
  const cs = cues({ c1: ['Cue 1', 5], c4: ['Cue 4', 83], cn: ['Cue 沒時間', null] });
  const run = (start: string | null, switches: Parameters<typeof checkTimeline>[0]['switches']) => checkTimeline({ start, switches, templates, cues: cs });
  const err = (r: ReturnType<typeof run>) => (r.ok ? '' : r.error);

  it('合法的時間線', () => {
    expect(run('A', [{ cueId: 'c4', templateId: 'B' }, { atSec: 130, templateId: 'A' }])).toEqual({ ok: true });
    expect(run('A', [])).toEqual({ ok: true });
    expect(run(null, [])).toEqual({ ok: true });
  });
  it('開頭 / 目標版型要存在、要是自己排的版型', () => {
    expect(err(run('Z', []))).toMatch(/找不到開頭/);
    expect(err(run(null, [{ atSec: 5, templateId: 'A' }]))).toMatch(/自己排的版型/);
    expect(err(run('F', [{ atSec: 5, templateId: 'A' }]))).toMatch(/自己排的版型/);
    expect(err(run('A', [{ atSec: 5, templateId: 'F' }]))).toMatch(/整張畫布/);
    expect(err(run('A', [{ atSec: 5, templateId: 'Z' }]))).toMatch(/找不到那個版型/);
  });
  it('畫布大小不一樣 → 說明裡有大小', () => {
    expect(err(run('A', [{ atSec: 5, templateId: 'C' }]))).toMatch(/4400×200.*2200×100/);
  });
  it('Cue：要存在、要有影片時間；時間要大於 0；同一個時間只能換一次', () => {
    expect(err(run('A', [{ cueId: 'zz', templateId: 'B' }]))).toMatch(/找不到這個 Cue/);
    expect(err(run('A', [{ cueId: 'cn', templateId: 'B' }]))).toMatch(/Cue 沒時間 還沒有影片時間/);
    expect(err(run('A', [{ atSec: 0, templateId: 'B' }]))).toMatch(/0 秒/);
    expect(err(run('A', [{ cueId: 'c4', templateId: 'B' }, { atSec: 83, templateId: 'A' }]))).toMatch(/同一個時間/);
    expect(err(run('A', [{ cueId: 'c4', templateId: 'B' }, { atSec: 83.001, templateId: 'A' }]))).toMatch(/同一個時間/);
    expect(run('A', [{ cueId: 'c4', templateId: 'B' }, { atSec: 83.5, templateId: 'A' }])).toEqual({ ok: true });
  });
});

describe('影片版本的快照', () => {
  const tl = buildTimeline(A, [sw('1', 'B', { cueId: 'c4', cueTimeSec: 83, cueName: 'Cue 4' }), sw('2', 'A', { atSec: 130 })], PLANS)!;
  it('存成 JSON 再讀回來一模一樣；每個版型的排法只存一份', () => {
    const text = serializeTimeline(tl);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed.plans).sort()).toEqual(['A', 'B']);
    expect(parsed.segments).toEqual([
      { fromSec: 0, templateId: 'A', label: null }, { fromSec: 83, templateId: 'B', label: 'Cue 4' }, { fromSec: 130, templateId: 'A', label: null },
    ]);
    const back = parseTimeline(text)!;
    expect(back.segments.map(s => [s.fromSec, s.templateId, s.label, s.plan.name])).toEqual([
      [0, 'A', null, '版型 A'], [83, 'B', 'Cue 4', '版型 B'], [130, 'A', null, '版型 A'],
    ]);
    expect(back.segments[0].plan.screens[0].key).toBe('o:oa');
    expect(parseTimeline(JSON.parse(text))).not.toBeNull();   // 物件也行（API 給的是物件）
  });
  it('壞資料 / 舊格式 / 只有一段 → null（當單一版型）', () => {
    expect(parseTimeline(null)).toBeNull();
    expect(parseTimeline('not json')).toBeNull();
    expect(parseTimeline({})).toBeNull();
    expect(parseTimeline({ v: 1, plans: {}, segments: [{ fromSec: 0, templateId: 'A' }, { fromSec: 5, templateId: 'B' }] })).toBeNull();   // 版型不在 plans 裡
    const p = JSON.parse(serializeTimeline(tl));
    expect(parseTimeline({ ...p, segments: [p.segments[0]] })).toBeNull();                                     // 只有一段
    expect(parseTimeline({ ...p, segments: [{ ...p.segments[1] }, p.segments[2]] })).toBeNull();                // 第一段不是 0 秒
    expect(parseTimeline({ ...p, segments: [p.segments[0], p.segments[2], p.segments[1]] })).toBeNull();        // 時間沒有遞增
    expect(parseTimeline({ ...p, segments: [p.segments[0], { fromSec: 'x', templateId: 'B' }] })).toBeNull();
  });
});
