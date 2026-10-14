// 一排機關的動作花樣：一起 / 依序 / 波浪 / 漸層。純算式（不碰 DOM / three / React），有單元測試。
// 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 3 節「Patterns」）
//
// applyPattern(一排的成員（照順序）, 花樣) → 每個機關在這個 cue 的位置和延遲。
//   一起：每個機關都是同一個位置 V、同一個延遲
//   依序：位置都是 V；延遲 = 起始 + 第幾個開始動 × 間隔（順序：1 到 N / N 到 1 / 從中間往兩邊 / 從兩邊往中間）
//   波浪：第 i 個的位置 = 中間值 + 振幅 × sin(2π·i/週期 + 相位)；延遲 = 起始 + i × 間隔
//   漸層：第 i 個的位置 = A + (B − A)·i/(N−1)；延遲全部一樣
// 每個位置夾在自己的行程裡（clamped = 有幾個被夾）。走幾秒不動它（item 裡沒有 durationSec）。
// 算出來的是一列一列普通的 cue 位置，之後每一個都還能單獨改。

import { MECH_LIMITS, clampValue } from './model.ts';

export type PatternKind = 'together' | 'sequence' | 'wave' | 'gradient';
export type SequenceOrder = 'forward' | 'backward' | 'centerOut' | 'edgesIn';

export const PATTERN_KINDS: { key: PatternKind; label: string; hint: string }[] = [
  { key: 'together', label: '一起', hint: '每一個都去同一個位置，同時開始動' },
  { key: 'sequence', label: '依序', hint: '位置一樣，一個接著一個開始動（可以從中間往兩邊）' },
  { key: 'wave', label: '波浪', hint: '高低像波浪起伏，一個接著一個開始動' },
  { key: 'gradient', label: '漸層', hint: '從第一個到最後一個，位置平均地從 A 變到 B' },
];

export const SEQUENCE_ORDERS: { key: SequenceOrder; label: string }[] = [
  { key: 'forward', label: '從第 1 個到最後一個' },
  { key: 'backward', label: '從最後一個到第 1 個' },
  { key: 'centerOut', label: '從中間往兩邊' },
  { key: 'edgesIn', label: '從兩邊往中間' },
];

export interface PatternParams {
  kind: PatternKind;
  /** 一起 / 依序：每個機關的位置 */
  value: number;
  /** 起始延遲（秒）：一起 / 漸層 = 全部同一個；依序 / 波浪 = 第一個開始動的延遲 */
  delay: number;
  /** 依序 / 波浪：相鄰兩個開始動的時間差（秒） */
  interval: number;
  order: SequenceOrder;
  /** 波浪：中間值、振幅、週期（幾個機關一個來回）、相位（度） */
  center: number;
  amplitude: number;
  period: number;
  phaseDeg: number;
  /** 漸層：第一個的位置 A、最後一個的位置 B */
  from: number;
  to: number;
}

export interface PatternMember { id: string; travelMin: number; travelMax: number }
export interface PatternItem { mechanismId: string; value: number; delaySec: number | null }

/** 間隔最多幾秒（再大沒有意義：一整排加起來也不能超過 3600 秒） */
export const PATTERN_INTERVAL_MAX = 600;

const r4 = (v: number) => { const o = Math.round(v * 10000) / 10000; return Object.is(o, -0) ? 0 : o; };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 第 i 個（0 起算，共 n 個）是第幾個開始動（0 = 最先） */
export function sequenceRank(i: number, n: number, order: SequenceOrder): number {
  if (order === 'forward') return i;
  if (order === 'backward') return n - 1 - i;
  const c = (n - 1) / 2;
  const fromCenter = Math.floor(Math.abs(i - c) + 1e-9);
  if (order === 'centerOut') return fromCenter;
  return Math.floor(c + 1e-9) - fromCenter;
}

/** 一排成員開始的預設值（打開「套用花樣」時用）：位置用第一個成員的行程 */
export function defaultPattern(members: PatternMember[]): PatternParams {
  const first = members[0];
  const lo = first ? first.travelMin : 0, hi = first ? first.travelMax : 1;
  return {
    kind: 'together', value: hi, delay: 0, interval: 0.5, order: 'forward',
    center: r4((lo + hi) / 2), amplitude: r4((hi - lo) / 2), period: Math.max(2, members.length || 2), phaseDeg: 0,
    from: lo, to: hi,
  };
}

/** 填的數字合不合理（null = 可以）；畫面在預覽旁邊顯示 */
export function validatePattern(p: PatternParams, count: number): string | null {
  const nums = [p.value, p.delay, p.interval, p.center, p.amplitude, p.period, p.phaseDeg, p.from, p.to];
  if (nums.some(n => !Number.isFinite(n))) return '每一格都要填數字';
  if (p.delay < 0 || p.delay > MECH_LIMITS.timingMaxSec) return '延遲要是 0 到 3600 秒';
  if (p.interval < 0 || p.interval > PATTERN_INTERVAL_MAX) return `間隔要是 0 到 ${PATTERN_INTERVAL_MAX} 秒`;
  if (p.kind === 'wave' && !(p.period > 0)) return '週期要大於 0';
  const steps = p.kind === 'sequence' || p.kind === 'wave' ? Math.max(0, count - 1) : 0;
  if (p.delay + steps * p.interval > MECH_LIMITS.timingMaxSec) return '最後一個的延遲超過 3600 秒了，請縮短間隔';
  return null;
}

/**
 * 算每個機關在這個 cue 的位置和延遲。
 * members 要照一排的順序（groupIndex）排好；回傳的 items 順序一樣。
 * delaySec：0 秒寫成 null（= 跟著 cue，跟沒設一樣；也會把以前設過的延遲清掉）。
 */
export function applyPattern(members: PatternMember[], p: PatternParams): { items: PatternItem[]; clamped: number } {
  const n = members.length;
  const items: PatternItem[] = [];
  let clamped = 0;
  for (let i = 0; i < n; i++) {
    const m = members[i];
    let value: number;
    let delay = p.delay;
    switch (p.kind) {
      case 'together':
        value = p.value;
        break;
      case 'sequence':
        value = p.value;
        delay = p.delay + sequenceRank(i, n, p.order) * p.interval;
        break;
      case 'wave':
        value = p.center + p.amplitude * Math.sin((2 * Math.PI * i) / p.period + (p.phaseDeg * Math.PI) / 180);
        delay = p.delay + i * p.interval;
        break;
      default:
        value = p.from + (p.to - p.from) * (n > 1 ? i / (n - 1) : 0);
        break;
    }
    const v = clampValue(value, m.travelMin, m.travelMax);
    if (Math.abs(v - value) > 1e-9) clamped++;
    const d = r3(Math.min(MECH_LIMITS.timingMaxSec, Math.max(0, delay)));
    items.push({ mechanismId: m.id, value: r4(v), delaySec: d > 0 ? d : null });
  }
  return { items, clamped };
}
