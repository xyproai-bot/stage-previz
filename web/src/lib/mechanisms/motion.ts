// 機關怎麼動：速度檢查、跟著影片時間的位置、點 cue 時照機器速度走過去。
//
// 速度模型：等速（跟物件換 cue 一樣，沒有加減速）。
//   沒填最高速度的機關：照轉場秒數移動（跟物件一樣），不檢查。
//   有填：轉場太短 → 機器照最高速度走，晚一點才到位（預覽要讓問題先在這裡被看到，不是到現場才發現）。
//
//   checkSongMechanisms    — 每個 cue、每個機關：來不來得及（給管理頁的提醒、機關總表）
//   buildMechanismTimeline — 影片第 t 秒每個機關在哪（分享頁 / 導演頁 / 工作站播影片時，每幀問）；機關時間軸上的每一段
//   MechanismTweener       — 點 cue 換位置：照機器速度走過去（不靠時鐘以外的東西，測試可以自己給時間）
// 用跟物件同一套 cue 時段（cueWindows）：GO = max(到位 − 轉場, 上一個 cue 到位)。
//
// v2：每個 cue 每個機關自己的時間（設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md）
//   開始動 = GO + 延遲（沒設 = 0）；走幾秒 = 自己設的（沒設 = 跟著 cue：到位 − GO / 轉場）
//   只有「自己設了這個機關位置」的 cue 會叫機器出發；沿用的 cue 不會打斷還在走的上一段（機器繼續走它的）
//   自己設的 cue 出發時，上一段還沒走完 → 從半路接手；上一段還沒開始（延遲太久）→ 取消
//   時間不沿用：沒設的 cue 一律跟著 cue 的轉場。

import type { Mechanism, MechanismTiming, MechanismTimings, MechanismValues } from './model';
import type { ResolvedRow } from './track';
import { cueWindows, type TimelineCue } from '../cueTimeline';
import { cueTransitionSeconds } from '../cueTiming';

/** 差這麼一點點不算太快（秒） */
export const SPEED_TOLERANCE_S = 0.05;
const STILL_EPS = 1e-6;
const MOVE_EPS = 1e-9;
const NO_TIMING: MechanismTiming = { delaySec: null, durationSec: null };

export type MotionMechanism = Pick<Mechanism, 'id' | 'maxSpeed'>;
export interface MotionCue extends TimelineCue { order: number; status: string }

/**
 * 這個 cue 有沒有自己設這個機關的位置：有 → 回傳它的時間（沒設時間 = { null, null }）；沒有（沿用 / 預設）→ null。
 * 只有自己設的 cue 會叫機器出發。
 */
export type OwnMoveFor = (cueId: string, mechId: string) => MechanismTiming | null;

/** 走這段距離最少要幾秒（沒填最高速度 = 0，不限） */
export function requiredSeconds(distance: number, maxSpeed: number | null | undefined): number {
  if (!maxSpeed || !(maxSpeed > 0)) return 0;
  return Math.abs(distance) / maxSpeed;
}

/** 「照機器速度」要把轉場 / 走幾秒改成幾秒：往上取到 0.1 秒 */
export function fixSeconds(need: number): number {
  return Math.ceil(Math.round(need * 10 * 1e6) / 1e6) / 10;
}

/** resolveSongMechanisms 的結果 + 每個 cue 自己設的時間 → OwnMoveFor */
export function ownMoveFor(resolved: Map<string, ResolvedRow>, timings?: Map<string, MechanismTimings> | null): OwnMoveFor {
  return (cueId, mechId) => {
    if (resolved.get(cueId)?.[mechId]?.source !== 'own') return null;
    return timings?.get(cueId)?.[mechId] ?? NO_TIMING;
  };
}

// ─────────────────────────────────────────────
// 速度檢查
// ─────────────────────────────────────────────

export type MechCheckStatus = 'start' | 'still' | 'ok' | 'tooFast' | 'noSpeed';

/** 被後面的 cue 接手（這一段沒走完 / 還沒開始） */
export interface MoveCut {
  byCueId: string;
  /** 影片第幾秒被接手 */
  at: number;
  /** 被接手時走到哪 */
  reached: number;
  /** false = 延遲還沒到就被接手（根本沒動） */
  started: boolean;
}

export interface MechCheck {
  status: MechCheckStatus;
  /** 上一個 cue（影片時間的上一個；沒設影片時間 = 清單的上一個）；第一個 cue = null */
  prevCueId: string | null;
  from: number | null;
  to: number;
  distance: number;
  /** 機器最少要幾秒（沒填最高速度 = null） */
  need: number | null;
  /** 這段能用幾秒（= 走幾秒：自己設的，或跟著 cue） */
  available: number | null;
  /** 跟著 cue 時能用幾秒（到位 − GO / 轉場；第一個 cue = null） */
  span: number | null;
  /** 「照機器速度」把這個 cue 的轉場改成幾秒；改轉場沒用（跟上一個 cue 隔太近 / 這個機關自己設了走幾秒）= null */
  fix: number | null;
  /** 「只改這個機關」：這個 cue 這個機關的走幾秒改成幾秒（太快才有） */
  durationFix: number | null;
  /** 'gap' = 跟上一個 cue 的影片時間隔太近，改轉場沒用 */
  reason: 'gap' | null;
  /** 跟上一個 cue 的影片時間隔幾秒（有影片時間才有） */
  gap: number | null;
  /** 播影片時實際會晚幾秒到位（上一段還沒走完 / 太快）；準時 = null */
  lateBy: number | null;
  /** 延遲幾秒（沒設 = 0） */
  delay: number;
  /** 這個 cue 自己設了延遲（> 0）/ 走幾秒 */
  explicitDelay: boolean;
  explicitDuration: boolean;
  /** 影片第幾秒開始動（= GO + 延遲；沒影片時間 = null） */
  startAt: number | null;
  /** 照設定第幾秒到位（= 開始動 + 走幾秒；沒影片時間 = null） */
  endAt: number | null;
  /** 這一段照設定還在走就被後面的 cue 接手；沒有 = null */
  cut: MoveCut | null;
}

export interface CueCheck {
  cueId: string;
  items: Record<string, MechCheck>;
  /** 這個 cue 的「照機器速度」轉場秒數（跟著轉場的機關裡最大的；沒有能修的 = null） */
  fix: number | null;
  /** 有幾個機關來不及（太快 / 會晚到 / 沒走完就被接手） */
  problems: number;
}

export interface SongCheck {
  cues: Map<string, CueCheck>;
  /** 有問題的 cue（照清單順序） */
  problemCueIds: string[];
  /** cue 的清單順序跟影片時間對不上 */
  orderMismatch: boolean;
}

export function sortMasters<C extends MotionCue>(cues: C[]): C[] {
  return cues
    .map((c, i) => ({ c, i }))
    .filter(x => x.c.status === 'master')
    .sort((a, b) => (a.c.order - b.c.order) || (a.i - b.i))
    .map(x => x.c);
}

/** 有影片時間的 cue：照影片時間的順序跟照清單的順序一不一樣 */
export function timedOrderMismatch(cues: MotionCue[]): boolean {
  const masters = sortMasters(cues);
  const listOrder = masters.filter(c => c.videoTimeSec != null).map(c => c.id);
  const timeOrder = cueWindows(masters).map(w => w.cueId);
  return listOrder.some((id, i) => id !== timeOrder[i]);
}

/**
 * 每個正式 cue、每個有填最高速度的機關：從上一個 cue 走過來來不來得及。
 * @param resolved  resolveSongMechanisms 的結果（夾在行程內的值）
 * @param timings   cueId → 這個 cue 自己設的時間（沒給 = 都跟著轉場）
 */
export function checkSongMechanisms(
  mechs: Pick<Mechanism, 'id' | 'maxSpeed' | 'defaultValue'>[],
  cues: MotionCue[],
  resolved: Map<string, ResolvedRow>,
  timings?: Map<string, MechanismTimings> | null,
): SongCheck {
  const masters = sortMasters(cues);
  const windows = cueWindows(masters);
  const winIndex = new Map(windows.map((w, i) => [w.cueId, i]));
  const valueOf = (cueId: string, m: { id: string; defaultValue: number }) => resolved.get(cueId)?.[m.id]?.value ?? m.defaultValue;
  const own = ownMoveFor(resolved, timings);

  // 影片時間軸實際跑一次：上一段還沒走完時會晚多少、哪一段被接手
  const timeline = buildMechanismTimeline(mechs, masters, cueId => {
    const row = resolved.get(cueId);
    const out: MechanismValues = {};
    for (const m of mechs) out[m.id] = row?.[m.id]?.value ?? m.defaultValue;
    return out;
  }, own);

  const out = new Map<string, CueCheck>();
  const problemCueIds: string[] = [];
  masters.forEach((cue, listIdx) => {
    const wi = winIndex.get(cue.id);
    const timed = wi !== undefined;
    let prevCueId: string | null = null;
    let span: number | null = null;   // 跟著 cue 時能用幾秒
    let gap: number | null = null;
    let go: number | null = null;
    if (timed) {
      if (wi! > 0) {
        const w = windows[wi!], pw = windows[wi! - 1];
        prevCueId = pw.cueId;
        span = w.arrive - w.start;
        gap = w.arrive - pw.arrive;
        go = w.start;
      }
    } else if (listIdx > 0) {
      prevCueId = masters[listIdx - 1].id;
      span = cueTransitionSeconds(cue);
    }

    const items: Record<string, MechCheck> = {};
    let fix: number | null = null;
    let problems = 0;
    for (const m of mechs) {
      const to = valueOf(cue.id, m);
      const t = prevCueId ? own(cue.id, m.id) : null;
      const explicitDuration = !!t && t.durationSec != null;
      const explicitDelay = !!t && t.delaySec != null && t.delaySec > 0;
      const delay = t?.delaySec ?? 0;
      const available = span === null ? null : explicitDuration ? t!.durationSec! : span;
      const startAt = go === null ? null : go + delay;
      const base: MechCheck = {
        status: 'start', prevCueId, from: null, to, distance: 0, need: null, available, span,
        fix: null, durationFix: null, reason: null, gap, lateBy: null,
        delay, explicitDelay, explicitDuration,
        startAt, endAt: startAt === null || available === null ? null : startAt + available, cut: null,
      };
      if (!prevCueId) { items[m.id] = base; continue; }
      const from = valueOf(prevCueId, m);
      const distance = Math.abs(to - from);
      const late = timed ? timeline?.lateBy(cue.id, m.id) ?? null : null;
      const lateBy = late !== null && late > SPEED_TOLERANCE_S ? late : null;
      const mv = timed ? timeline?.moveFor(cue.id, m.id) ?? null : null;
      // 被接手：只算「照設定還在走」的（v1 那種太快晚到被接手，太快 / 會晚到已經說了）
      const cut = mv?.cut && mv.plannedEnd > mv.cut.at + SPEED_TOLERANCE_S ? mv.cut : null;
      if (distance < STILL_EPS) {
        items[m.id] = { ...base, status: 'still', from, distance: 0, lateBy };
        if (lateBy) problems++;
        continue;
      }
      if (!m.maxSpeed) {
        items[m.id] = { ...base, status: 'noSpeed', from, distance, cut };
        if (cut) problems++;
        continue;
      }
      const need = requiredSeconds(distance, m.maxSpeed);
      if (need <= (available ?? 0) + SPEED_TOLERANCE_S) {
        items[m.id] = { ...base, status: 'ok', from, distance, need, lateBy, cut };
        if (lateBy || cut) problems++;
        continue;
      }
      const gapLimited = !explicitDuration && timed && gap !== null && gap < need;
      const f = explicitDuration || gapLimited ? null : fixSeconds(need);
      items[m.id] = {
        ...base, status: 'tooFast', from, distance, need, fix: f, durationFix: fixSeconds(need),
        reason: gapLimited ? 'gap' : null, lateBy, cut,
      };
      problems++;
      if (f !== null) fix = fix === null ? f : Math.max(fix, f);
    }
    out.set(cue.id, { cueId: cue.id, items, fix, problems });
    if (problems > 0) problemCueIds.push(cue.id);
  });
  return { cues: out, problemCueIds, orderMismatch: timedOrderMismatch(masters) };
}

/** 機關總表 / 畫面用：cue 的 GO 時間（= 到位 − 可用秒數）和到位時間；沒影片時間 = null */
export function cueGoTimes(cues: MotionCue[]): Map<string, { go: number; arrive: number }> {
  const out = new Map<string, { go: number; arrive: number }>();
  for (const w of cueWindows(sortMasters(cues))) out.set(w.cueId, { go: w.start, arrive: w.arrive });
  return out;
}

// ─────────────────────────────────────────────
// 跟著影片時間（每個機關先算好一段一段的移動，每幀二分搜尋）
// ─────────────────────────────────────────────

interface Track {
  id: string;
  /** 第一個有影片時間的 cue 的位置（之前都停在這裡） */
  initial: number;
  /** [t0, t1, v0, v1] × n（照 t0 排好、不重疊） */
  seg: number[];
}

/** 時間軸上的一段移動（機關時間軸畫的一條；資料變了才重算，每幀不用） */
export interface TimelineMove {
  cueId: string;
  mechId: string;
  /** 這個 cue 自己設了這個機關（false = 沿用的 cue，機器卻不在那裡 → cue 順序跟影片時間對不上才會有） */
  own: boolean;
  /** cue 的 GO、到位（影片時間） */
  go: number;
  arrive: number;
  delay: number;
  /** 照設定：開始動、走幾秒、到位 */
  start: number;
  duration: number;
  plannedEnd: number;
  /** 照最高速度實際到位（太快 → 比 plannedEnd 晚；被接手前算的） */
  end: number;
  from: number;
  to: number;
  explicitDelay: boolean;
  explicitDuration: boolean;
  /** 機器最少要幾秒（沒填最高速度 = 0） */
  need: number;
  cut: MoveCut | null;
}

type WindowLite = { cueId: string; start: number; arrive: number };

export class MechanismTimeline {
  readonly tracks: Track[];
  /** 每一段移動 */
  readonly moves: TimelineMove[];
  /** 有影片時間的 cue：GO、到位（照影片時間排） */
  readonly windows: WindowLite[];
  /** cueId → mechId → 實際到位時間 − 應該到位時間 */
  private late: Map<string, Record<string, number>>;
  private moveIndex: Map<string, TimelineMove>;
  private out: MechanismValues = {};

  constructor(tracks: Track[], late: Map<string, Record<string, number>>, moves: TimelineMove[] = [], windows: WindowLite[] = []) {
    this.tracks = tracks;
    this.late = late;
    this.moves = moves;
    this.windows = windows;
    this.moveIndex = new Map(moves.map(m => [`${m.cueId}\u0000${m.mechId}`, m]));
  }

  /** 影片第 t 秒每個機關在哪（回傳同一個物件，每次覆蓋 → 每幀不配置記憶體） */
  valuesAt(t: number): MechanismValues {
    const out = this.out;
    for (const tr of this.tracks) out[tr.id] = trackValueAt(tr, t);
    return out;
  }

  valueAt(mechId: string, t: number): number | null {
    const tr = this.tracks.find(x => x.id === mechId);
    return tr ? trackValueAt(tr, t) : null;
  }

  /** 這個 cue 這個機關實際晚幾秒到位（沒動 / 準時 = 0；沒這個 cue = null） */
  lateBy(cueId: string, mechId: string): number | null {
    const r = this.late.get(cueId);
    if (!r) return null;
    return r[mechId] ?? 0;
  }

  /** 這個 cue 叫這個機關出發的那一段（沒動 = null） */
  moveFor(cueId: string, mechId: string): TimelineMove | null {
    return this.moveIndex.get(`${cueId}\u0000${mechId}`) ?? null;
  }

  /** 最後一段走完的時間（時間軸要畫多長） */
  get endTime(): number {
    let t = this.windows.length ? this.windows[this.windows.length - 1].arrive : 0;
    for (const m of this.moves) t = Math.max(t, m.cut ? m.cut.at : m.end, m.plannedEnd);
    return t;
  }
}

function trackValueAt(tr: Track, t: number): number {
  const s = tr.seg;
  const n = s.length / 4;
  // 最後一段 t0 ≤ t 的
  let lo = 0, hi = n - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid * 4] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (k < 0) return tr.initial;
  const t0 = s[k * 4], t1 = s[k * 4 + 1], v0 = s[k * 4 + 2], v1 = s[k * 4 + 3];
  if (t >= t1) return v1;
  return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
}

/**
 * 有影片時間的 cue → 每個機關一段一段的移動：
 *   第一個 cue 之前停在第一個 cue 的位置
 *   自己設了位置的 cue：GO + 延遲 出發（從機器那時候實際在的位置，可能還在走上一段）
 *     走的時間 = max(走幾秒, 距離 ÷ 最高速度) → 太快就晚一點到；走幾秒沒設 = 到位 − GO（跟 v1 一樣）
 *     上一段還沒走完 → 從那裡接著走；上一段還沒開始 → 取消
 *   沿用的 cue：機器已經在 / 正在往這個位置走 → 不打斷；不是（cue 順序跟影片時間對不上）→ 跟 v1 一樣在 GO 接手
 * @param ownFor  沒給 = 每個 cue 都當自己設了、都跟著轉場（v1 的算法；舊的呼叫 / 測試）
 * 回傳 null = 沒有 cue 設影片時間
 */
export function buildMechanismTimeline(
  mechs: MotionMechanism[],
  cues: TimelineCue[],
  valuesFor: (cueId: string) => MechanismValues | null | undefined,
  ownFor?: OwnMoveFor | null,
): MechanismTimeline | null {
  const windows = cueWindows(cues);
  if (windows.length === 0) return null;
  const late = new Map<string, Record<string, number>>();
  for (const w of windows) late.set(w.cueId, {});
  const allMoves: TimelineMove[] = [];
  const tracks: Track[] = mechs.map(m => {
    const first = valuesFor(windows[0].cueId)?.[m.id];
    const tr: Track = { id: m.id, initial: first ?? 0, seg: [] };
    const segMove: TimelineMove[] = [];   // 每一段是哪一次移動

    /** s 秒有一個 cue 接手：還沒開始的段取消、走到一半的停在那裡 */
    const takeOver = (s: number, byCueId: string) => {
      let n = tr.seg.length / 4;
      while (n > 0 && tr.seg[(n - 1) * 4] >= s) {
        const mv = segMove[n - 1];
        mv.cut = { byCueId, at: s, reached: mv.from, started: false };
        tr.seg.length -= 4;
        segMove.length -= 1;
        n--;
      }
      if (n > 0 && tr.seg[(n - 1) * 4 + 1] > s) {
        const p = trackValueAt(tr, s);
        tr.seg[(n - 1) * 4 + 1] = s;
        tr.seg[(n - 1) * 4 + 3] = p;
        segMove[n - 1].cut = { byCueId, at: s, reached: p, started: true };
      }
    };

    for (let i = 1; i < windows.length; i++) {
      const w = windows[i];
      const target = valuesFor(w.cueId)?.[m.id];
      if (target === undefined || target === null) continue;
      const timing = ownFor ? ownFor(w.cueId, m.id) : NO_TIMING;
      if (timing === null) {
        // 沿用：前面排好的移動最後會停在這個 cue 的位置 → 不打斷（延遲還沒到的也照樣會出發）
        const n = tr.seg.length / 4;
        const endValue = n > 0 ? tr.seg[(n - 1) * 4 + 3] : tr.initial;
        if (Math.abs(endValue - target) < MOVE_EPS) {
          // 那一段照設定應該在這個 cue 到位前走完、卻還在走（太快）→ 這個 cue 會晚到（跟 v1 一樣報在這個 cue）
          if (n > 0) {
            const t1 = tr.seg[(n - 1) * 4 + 1];
            if (segMove[n - 1].plannedEnd <= w.arrive + MOVE_EPS && t1 > w.arrive) late.get(w.cueId)![m.id] = t1 - w.arrive;
          }
          continue;
        }
      }
      const own = timing !== null;
      const delay = own ? Math.max(0, timing.delaySec ?? 0) : 0;
      const s = w.start + delay;
      const planned = own && timing.durationSec != null ? Math.max(0, timing.durationSec) : w.arrive - w.start;
      takeOver(s, w.cueId);
      const p = trackValueAt(tr, s);
      const d = Math.abs(target - p);
      if (d < MOVE_EPS) continue;
      const need = requiredSeconds(d, m.maxSpeed);
      const dur = Math.max(planned, need);
      tr.seg.push(s, s + dur, p, target);
      const mv: TimelineMove = {
        cueId: w.cueId, mechId: m.id, own, go: w.start, arrive: w.arrive, delay,
        start: s, duration: planned, plannedEnd: s + planned, end: s + dur, from: p, to: target,
        explicitDelay: own && timing.delaySec != null && timing.delaySec > 0,
        explicitDuration: own && timing.durationSec != null,
        need, cut: null,
      };
      segMove.push(mv);
      allMoves.push(mv);
      late.get(w.cueId)![m.id] = dur - planned;
    }
    return tr;
  });
  return new MechanismTimeline(tracks, late, allMoves, windows);
}

// ─────────────────────────────────────────────
// 點 cue：照機器速度走過去
// ─────────────────────────────────────────────

interface TweenState { from: number; to: number; t0: number; dur: number }

/**
 * 換 cue 時機關怎麼走：
 *   'real'       照機器速度（花 max(走幾秒, 距離 ÷ 最高速度) 秒；導演頁、分享頁、工作站、管理頁開「照機器速度播放」時）
 *   'transition' 照走幾秒（沒設 = 轉場秒數；跟物件一起到；管理頁預設，編輯時不用等機器）；0 = 直接切換
 *   'instant'    直接到位（分鏡縮圖）
 * 延遲：'real' 和 'transition' 都會先等延遲再出發；'instant' 不等。
 */
export type MechanismMotion = 'real' | 'transition' | 'instant';

export interface RetargetOptions {
  /** 換了 cue = true（照下面的動法走過去）；同一個 cue 裡改值 = false（直接跳） */
  animate: boolean;
  /** 新 cue 的轉場秒數（沒設走幾秒的機關照這個秒數走；有填最高速度的至少這麼久） */
  minSeconds: number;
  /** 預設 'real'；'transition' = 不管最高速度，照走幾秒；'instant' = 跟 animate: false 一樣 */
  motion?: MechanismMotion;
  /** 新 cue 自己設的時間（mechId → 延遲 / 走幾秒）；沒有的機關跟著轉場 */
  timings?: MechanismTimings | null;
}

/** 換 cue 時這個機關要走幾秒 */
export function moveSeconds(distance: number, maxSpeed: number | null | undefined, minSeconds: number, motion: MechanismMotion = 'real'): number {
  if (motion === 'instant') return 0;
  const t = Math.max(0, minSeconds);
  return motion === 'transition' ? t : Math.max(t, requiredSeconds(distance, maxSpeed));
}

export class MechanismTweener {
  private states = new Map<string, TweenState>();
  private out: MechanismValues = {};

  /** 現在每個機關在哪（回傳同一個物件；沒動過的機關不在裡面 → 用預設位置） */
  valuesAt(nowMs: number): MechanismValues {
    const out = this.out;
    for (const k in out) if (!this.states.has(k)) delete out[k];
    for (const [id, s] of this.states) out[id] = valueOf(s, nowMs);
    return out;
  }

  valueAt(id: string, nowMs: number): number | null {
    const s = this.states.get(id);
    return s ? valueOf(s, nowMs) : null;
  }

  isMoving(nowMs: number): boolean {
    for (const s of this.states.values()) {
      if (nowMs < s.t0 && s.from !== s.to) return true;   // 還在等延遲
      if (s.dur > 0 && nowMs < s.t0 + s.dur) return true;
    }
    return false;
  }

  /** 直接放到這些位置（例：影片時間軸停掉時，從畫面上最後的位置接著走） */
  setCurrent(values: MechanismValues, nowMs: number) {
    for (const id in values) {
      const v = values[id];
      if (Number.isFinite(v)) this.states.set(id, { from: v, to: v, t0: nowMs, dur: 0 });
    }
  }

  /**
   * 換目標：目標沒變的機關不動（繼續走它原本的）；
   * 換 cue → 從現在的位置走過去：先等延遲，再花 max(走幾秒, 距離 ÷ 最高速度) 秒；同一個 cue 裡改值 → 直接跳。
   * 第一次看到的機關直接放在目標。
   */
  retarget(mechs: MotionMechanism[], targets: MechanismValues, nowMs: number, opts: RetargetOptions) {
    const live = new Set<string>();
    for (const m of mechs) {
      live.add(m.id);
      const to = targets[m.id];
      if (to === undefined || to === null || !Number.isFinite(to)) { this.states.delete(m.id); continue; }
      const cur = this.states.get(m.id);
      if (!cur) { this.states.set(m.id, { from: to, to, t0: nowMs, dur: 0 }); continue; }
      if (cur.to === to) continue;
      const from = valueOf(cur, nowMs);
      if (!opts.animate || from === to || opts.motion === 'instant') { this.states.set(m.id, { from: to, to, t0: nowMs, dur: 0 }); continue; }
      const t = opts.timings?.[m.id];
      const delayMs = Math.max(0, t?.delaySec ?? 0) * 1000;
      const base = t && t.durationSec != null ? t.durationSec : opts.minSeconds;
      const dur = moveSeconds(to - from, m.maxSpeed, base, opts.motion) * 1000;
      this.states.set(m.id, { from, to, t0: nowMs + delayMs, dur: dur > 0 ? dur : 0 });
    }
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);
  }
}

function valueOf(s: TweenState, nowMs: number): number {
  if (nowMs < s.t0) return s.from;   // 還在等延遲（直接跳的 from = to）
  if (!(s.dur > 0) || nowMs >= s.t0 + s.dur) return s.to;
  return s.from + (s.to - s.from) * ((nowMs - s.t0) / s.dur);
}

// ─────────────────────────────────────────────
// 給畫面的字（秒數 / 距離）
// ─────────────────────────────────────────────

/** 秒數：最多 1 位小數，整數不帶 .0（「14」「7.5」） */
export function formatSeconds(s: number): string {
  const r = Math.round(s * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
}

/** 機關的值：公尺最多 3 位、度最多 1 位，不補零（「3.5 m」「90°」） */
export function formatMechValue(v: number, kind: 'linear' | 'rotary', withUnit = true): string {
  const d = kind === 'rotary' ? 1 : 3;
  const f = 10 ** d;
  let r = Math.round(v * f) / f;
  if (Object.is(r, -0)) r = 0;
  if (!withUnit) return String(r);
  return kind === 'rotary' ? `${r}°` : `${r} m`;
}
