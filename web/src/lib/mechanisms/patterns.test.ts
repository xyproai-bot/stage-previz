// 一排機關的花樣：一起 / 依序 / 波浪 / 漸層的算式（設計文件第 3 節 Patterns）
import { describe, expect, it } from 'vitest';
import {
  PATTERN_KINDS, applyPattern, defaultPattern, sequenceRank, validatePattern,
  type PatternMember, type PatternParams,
} from './patterns';

const members = (n: number, min = 0, max = 3): PatternMember[] => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, travelMin: min, travelMax: max }));
const params = (patch: Partial<PatternParams>): PatternParams => ({ ...defaultPattern(members(8)), ...patch });
const values = (r: ReturnType<typeof applyPattern>) => r.items.map(i => i.value);
const delays = (r: ReturnType<typeof applyPattern>) => r.items.map(i => i.delaySec);

describe('一起', () => {
  it('每個機關同一個位置、同一個延遲；延遲 0 寫成 null（跟著 cue）', () => {
    const r = applyPattern(members(4), params({ kind: 'together', value: 2, delay: 0 }));
    expect(values(r)).toEqual([2, 2, 2, 2]);
    expect(delays(r)).toEqual([null, null, null, null]);
    expect(r.clamped).toBe(0);
    const d = applyPattern(members(3), params({ kind: 'together', value: 1.5, delay: 2 }));
    expect(delays(d)).toEqual([2, 2, 2]);
    expect(d.items.map(i => i.mechanismId)).toEqual(['m1', 'm2', 'm3']);
  });
  it('超出自己的行程 → 夾在行程裡，算夾了幾個', () => {
    const r = applyPattern([{ id: 'a', travelMin: 0, travelMax: 3 }, { id: 'b', travelMin: 0, travelMax: 1 }], params({ kind: 'together', value: 2 }));
    expect(values(r)).toEqual([2, 1]);
    expect(r.clamped).toBe(1);
  });
});

describe('依序', () => {
  it('從第 1 個到最後一個：延遲 = 起始 + 第幾個 × 間隔，位置都一樣', () => {
    const r = applyPattern(members(5), params({ kind: 'sequence', value: 3, interval: 0.5, delay: 1, order: 'forward' }));
    expect(values(r)).toEqual([3, 3, 3, 3, 3]);
    expect(delays(r)).toEqual([1, 1.5, 2, 2.5, 3]);
  });
  it('從最後一個到第 1 個', () => {
    const r = applyPattern(members(4), params({ kind: 'sequence', value: 1, interval: 1, delay: 0, order: 'backward' }));
    expect(delays(r)).toEqual([3, 2, 1, null]);
  });
  it('從中間往兩邊（奇數、偶數個）', () => {
    expect([...Array(7).keys()].map(i => sequenceRank(i, 7, 'centerOut'))).toEqual([3, 2, 1, 0, 1, 2, 3]);
    expect([...Array(8).keys()].map(i => sequenceRank(i, 8, 'centerOut'))).toEqual([3, 2, 1, 0, 0, 1, 2, 3]);
    const r = applyPattern(members(8), params({ kind: 'sequence', value: 1, interval: 0.25, delay: 0, order: 'centerOut' }));
    expect(delays(r)).toEqual([0.75, 0.5, 0.25, null, null, 0.25, 0.5, 0.75]);
  });
  it('從兩邊往中間', () => {
    expect([...Array(7).keys()].map(i => sequenceRank(i, 7, 'edgesIn'))).toEqual([0, 1, 2, 3, 2, 1, 0]);
    expect([...Array(8).keys()].map(i => sequenceRank(i, 8, 'edgesIn'))).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
  });
  it('只有一個機關也算得出來', () => {
    for (const order of ['forward', 'backward', 'centerOut', 'edgesIn'] as const) expect(sequenceRank(0, 1, order)).toBe(0);
  });
});

describe('波浪', () => {
  it('位置 = 中間值 + 振幅 × sin(2π·i/週期 + 相位)；延遲 = i × 間隔', () => {
    const r = applyPattern(members(8), params({ kind: 'wave', center: 1.5, amplitude: 1, period: 8, phaseDeg: 0, interval: 0.2, delay: 0 }));
    const want = [...Array(8).keys()].map(i => Math.round((1.5 + Math.sin((2 * Math.PI * i) / 8)) * 10000) / 10000);
    expect(values(r)).toEqual(want);
    expect(values(r)[0]).toBe(1.5);
    expect(values(r)[2]).toBe(2.5);          // 四分之一週期 = 波峰
    expect(values(r)[6]).toBe(0.5);          // 四分之三週期 = 波谷
    expect(delays(r)).toEqual([null, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4]);
    expect(r.clamped).toBe(0);
  });
  it('相位 90 度 = 整個波往前挪四分之一週期', () => {
    const r = applyPattern(members(4), params({ kind: 'wave', center: 1.5, amplitude: 1, period: 4, phaseDeg: 90, interval: 0 }));
    expect(values(r)).toEqual([2.5, 1.5, 0.5, 1.5]);
  });
  it('振幅太大 → 夾在行程邊界', () => {
    const r = applyPattern(members(4), params({ kind: 'wave', center: 1.5, amplitude: 3, period: 4, phaseDeg: 0, interval: 0 }));
    expect(values(r)).toEqual([1.5, 3, 1.5, 0]);
    expect(r.clamped).toBe(2);
  });
  it('起始延遲加在每一個上面', () => {
    const r = applyPattern(members(3), params({ kind: 'wave', center: 1, amplitude: 0.5, period: 3, interval: 1, delay: 2 }));
    expect(delays(r)).toEqual([2, 3, 4]);
  });
});

describe('漸層', () => {
  it('第 1 個是 A、最後一個是 B，中間平均分', () => {
    const r = applyPattern(members(5), params({ kind: 'gradient', from: 0, to: 3, delay: 0 }));
    expect(values(r)).toEqual([0, 0.75, 1.5, 2.25, 3]);
    expect(delays(r)).toEqual([null, null, null, null, null]);
  });
  it('B 比 A 小也可以（反過來）；只有一個機關 = A', () => {
    expect(values(applyPattern(members(3), params({ kind: 'gradient', from: 3, to: 0 })))).toEqual([3, 1.5, 0]);
    expect(values(applyPattern(members(1), params({ kind: 'gradient', from: 2, to: 0 })))).toEqual([2]);
  });
  it('旋轉的機關（度）也一樣算', () => {
    const r = applyPattern(members(3, -90, 90), params({ kind: 'gradient', from: -45, to: 45 }));
    expect(values(r)).toEqual([-45, 0, 45]);
  });
});

describe('檢查和預設值', () => {
  it('每一格要是數字、延遲和間隔有範圍、週期要大於 0、整排加起來不能超過 3600 秒', () => {
    expect(validatePattern(params({}), 8)).toBeNull();
    expect(validatePattern(params({ value: NaN }), 8)).toBe('每一格都要填數字');
    expect(validatePattern(params({ delay: -1 }), 8)).toBe('延遲要是 0 到 3600 秒');
    expect(validatePattern(params({ interval: 601 }), 8)).toBe('間隔要是 0 到 600 秒');
    expect(validatePattern(params({ kind: 'wave', period: 0 }), 8)).toBe('週期要大於 0');
    expect(validatePattern(params({ kind: 'sequence', delay: 3000, interval: 600 }), 3)).toBe('最後一個的延遲超過 3600 秒了，請縮短間隔');
    // 一起 / 漸層不看間隔
    expect(validatePattern(params({ kind: 'together', delay: 3000, interval: 600 }), 8)).toBeNull();
  });
  it('預設值用第一個機關的行程：波浪剛好填滿行程、不會被夾', () => {
    const p = defaultPattern(members(6, 0, 3));
    expect(p).toMatchObject({ kind: 'together', value: 3, center: 1.5, amplitude: 1.5, period: 6, from: 0, to: 3 });
    expect(applyPattern(members(6, 0, 3), { ...p, kind: 'wave' }).clamped).toBe(0);
    expect(defaultPattern([]).period).toBe(2);
  });
  it('四種花樣的名稱', () => {
    expect(PATTERN_KINDS.map(k => k.label)).toEqual(['一起', '依序', '波浪', '漸層']);
  });
  it('算出來的是一列一列普通的位置：沒有走幾秒（不動它），延遲最多到 3600', () => {
    const r = applyPattern(members(3), params({ kind: 'sequence', value: 1, interval: 600, delay: 3000, order: 'forward' }));
    expect(delays(r)).toEqual([3000, 3600, 3600]);
    expect(Object.keys(r.items[0]).sort()).toEqual(['delaySec', 'mechanismId', 'value']);
  });
});
