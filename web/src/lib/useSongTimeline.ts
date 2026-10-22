// 這首歌現在的版型時間線（頁面用）：開頭 = 歌選的版型，換版型的點 = 後台的 templateSwitches，Cue 的時間用畫面上最新的。
// 結果用 useMemo 包好：換版型的時間、版型都沒變就是同一個物件（StageScene 看到新物件才會重算每一段的取色資料）。
import { useMemo } from 'react';
import type { Cue } from './api';
import type { LedTemplateList } from './ledTemplateApi';
import { cueNumName } from './cueBadge';
import { songTimelineOf } from './ledLiveTemplate';
import { parseSwitches, switchTime, type CueTimes, type LedTimeline, type TimelineSwitch } from './ledTemplateTimeline';

/** 這首歌的 Cue（只算正式的）→ 換版型的點要的 Cue 時間 */
export function cueTimesOf(cues: readonly Cue[] | null | undefined): CueTimes | undefined {
  if (!cues) return undefined;
  return new Map(cues.filter(c => c.status === 'master').map(c => [c.id, { name: cueNumName(c), timeSec: c.videoTimeSec }]));
}

export interface SongTimelineState {
  switches: TimelineSwitch[];
  timeline: LedTimeline | null;
  cueTimes: CueTimes | undefined;
}

/**
 * list = 專案的版型清單；startId = 歌選的版型；rawSwitches = 歌的 templateSwitches（GET songs 給的）；
 * cues = 這首歌的 Cue（畫面有就用它的最新時間；null = 用後台一起給的）
 */
export function useSongTimeline(
  list: LedTemplateList | null | undefined,
  startId: string | null | undefined,
  rawSwitches: unknown,
  cues: readonly Cue[] | null | undefined,
): SongTimelineState {
  const switches = useMemo(() => parseSwitches(rawSwitches), [rawSwitches]);
  const cueTimes = useMemo(() => cueTimesOf(cues), [cues]);
  // 內容的指紋：Cue 清單重讀（新陣列）但時間沒變時，時間線不換物件
  const key = switches.length === 0 ? '' : switches.map(s => `${s.id}:${s.templateId}:${switchTime(s, cueTimes) ?? 'x'}:${s.cueId ? (cueTimes?.get(s.cueId)?.name ?? s.cueName ?? '') : ''}`).join('|');
  const timeline = useMemo(() => songTimelineOf(list, startId, switches, cueTimes), [list, startId, key]);
  return { switches, timeline, cueTimes };
}
