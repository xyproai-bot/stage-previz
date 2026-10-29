// 暫排：正式 cue 還沒設「對應影片時間」時，先在畫面上排一個時間，讓它設好的機關延遲 / 走幾秒看得到、播得出來。
//
// 只算在畫面上，絕對不寫回資料庫：cue 的「對應影片時間」欄位照樣是空的；製作設了時間就照設的。
// 機關時間軸（編輯頁、導演頁）、機關跟著影片動、物件跟著影片切 cue（videoCueSync，分享頁 / 導演頁 / 工作站）
// 全部拿同一份暫排時間，所以時間軸畫出來的位置 = 3D 實際動的時間，物件和機關不會各走各的。
//
// 規則（planProvisionalTimes）：照正式 cue 的清單順序（sortMasters）一個一個走，沒設時間的 cue N：
//   1. GO = 它前面的機關全部停下來的那一刻
//        = max(前一個 cue 的到位, 時間軸上它前面最後一條色塊的尾巴)
//      （「前面最後一條色塊」= 前面每個 cue 的每個機關的 GO + 延遲 + 走幾秒 的最大值；
//        還沒開始就被接手的不算、走一半被接手的算到接手那一刻；沒有機關就只看前一個 cue 的到位）
//   2. 到位 = GO + 自己的轉場秒數（影片時間，就是 cue 的 videoTimeSec 該有的值）
//   3. 第一個正式 cue 沒設時間 → 當 0 秒
//   4. 後面有真的時間的 cue 不能被超過：排出來的到位時間不能晚於「它後面（清單順序）所有有真時間的 cue」裡最早的那個；
//      排不下就壓在那個時間（兩個 cue 同一秒，清單排前面的先）。連續好幾個排不下的就全部壓在那一秒。
//   5. 有真時間的 cue 一律照設的，不動。提案 / 備案（不是正式 cue）不暫排。
// 只靠清單順序和機關資料，跟時間軸最後畫的結果沒有循環：每一個暫排的 cue 只看排在它前面的 cue。

import type { MechanismValues } from './mechanisms/model';
import { buildMechanismTimeline, sortMasters, type MechanismTimeline, type MotionCue, type MotionMechanism, type OwnMoveFor } from './mechanisms/motion';
import { sheetTime } from './mechanisms/cueSheet';
import { cueTransitionSeconds } from './cueTiming';
import type { TimelineCue } from './cueTimeline';

/** cueId → 暫排的「到位」影片時間（秒）；只有沒設時間的正式 cue 在裡面 */
export type ProvisionalTimes = Map<string, number>;

/** 算機關什麼時候停下來要用的資料；不給 = 專案沒有機關，只看轉場 */
export interface ProvisionalMechanisms {
  mechs: MotionMechanism[];
  /** 某個 cue 每個機關的位置（沿用規則算好的） */
  valuesFor: (cueId: string) => MechanismValues | null | undefined;
  /** 某個 cue 有沒有自己設這個機關（含延遲 / 走幾秒）；不給 = 每個 cue 都當自己設了、都跟著轉場 */
  ownFor?: OwnMoveFor | null;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** 時間軸上最後一條色塊結束的那一刻（還沒開始就被接手的不算、走一半被接手的算到接手那一刻）；沒有色塊 = -Infinity */
function lastStop(tl: MechanismTimeline | null): number {
  if (!tl) return -Infinity;
  let t = -Infinity;
  for (const m of tl.moves) {
    if (m.cut && !m.cut.started) continue;
    t = Math.max(t, m.cut ? m.cut.at : m.end);
  }
  return t;
}

/** 沒設影片時間的正式 cue → 暫排的到位時間。沒有要暫排的 cue = 空的 Map */
export function planProvisionalTimes(cues: MotionCue[], mech?: ProvisionalMechanisms | null): ProvisionalTimes {
  const out: ProvisionalTimes = new Map();
  const masters = sortMasters(cues);
  if (!masters.some(c => c.videoTimeSec == null)) return out;

  // ceiling[i] = 清單裡排在 i 後面、有真時間的 cue 最早的那個時間（沒有 = 不設上限）
  const ceiling: number[] = new Array(masters.length);
  let low = Infinity;
  for (let i = masters.length - 1; i >= 0; i--) {
    ceiling[i] = low;
    const t = masters[i].videoTimeSec;
    if (t != null && Number.isFinite(t)) low = Math.min(low, t);
  }

  const useMech = !!mech && mech.mechs.length > 0;
  const placed: MotionCue[] = [];   // 到目前為止排好時間的正式 cue（有真時間的 + 暫排的）
  masters.forEach((c, i) => {
    if (c.videoTimeSec != null) { placed.push(c); return; }
    let arrive = 0;   // 第一個正式 cue 沒設時間 → 0 秒
    if (i > 0) {
      let go = placed[i - 1].videoTimeSec as number;
      if (useMech) go = Math.max(go, lastStop(buildMechanismTimeline(mech!.mechs, placed, mech!.valuesFor, mech!.ownFor)));
      arrive = go + cueTransitionSeconds(c);
    }
    arrive = round3(Math.max(0, Math.min(arrive, ceiling[i])));
    out.set(c.id, arrive);
    placed.push({ ...c, videoTimeSec: arrive });
  });
  return out;
}

/**
 * 把暫排的時間填進 cue 清單（回傳新的清單，原本的 cue 不動）；沒有暫排的 cue → 原封不動回傳同一個陣列（引用不變）。
 * 只能拿去算時間軸 / 跟著影片切 cue，不能拿去存或顯示成「對應影片時間」。
 */
export function withProvisionalTimes<C extends TimelineCue>(cues: C[], times: ProvisionalTimes): C[] {
  if (times.size === 0) return cues;
  return cues.map(c => (times.has(c.id) ? { ...c, videoTimeSec: times.get(c.id) as number } : c));
}

/** cue 列上的提示：暫排的 cue 加「（暫排 0:12.0）」；沒暫排 = 只有名字 */
export function provisionalCueTitle(name: string, time: number | null | undefined): string {
  return time == null ? name : `${name}（暫排 ${sheetTime(time)}）`;
}
