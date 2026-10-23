// Cue 庫裡看一個 cue 的機關：它不屬於哪一首歌，前一個 cue 不固定。
// 所以拿「預設位置」當起點、這個 cue 當唯一的終點，排成兩個 cue 的小時間表：
//   起點（預設位置）在 0 秒；這個 cue 在 0 秒開始轉場（GO）、轉場秒數後到位。
//   機關的延遲 / 走幾秒照 cue 自己存的；時間軸只畫 0 秒到最後一個機關停下。

import { buildMechanismTimeline, checkSongMechanisms, ownMoveFor, type MotionCue, type MechanismTimeline, type SongCheck } from './motion';
import { defaultRow, valuesOf, type ResolvedRow, type TrackMechanism } from './track';
import type { MechanismTimings } from './model';
import { cueTransitionSeconds } from '../cueTiming';

export const LIB_START_ID = '__library_start__';

type CueLike = MotionCue & { name?: string };

/** [預設位置的起點, 這個 cue]（這個 cue 在 0 秒 GO，轉場秒數後到位） */
export function libraryViewCues(cueId: string, name: string, crossfadeSeconds: number): CueLike[] {
  const sec = cueTransitionSeconds({ crossfadeSeconds });
  return [
    { id: LIB_START_ID, order: 0, status: 'master', name: '預設位置', videoTimeSec: 0, crossfadeSeconds: 0 },
    { id: cueId, order: 1, status: 'master', name, videoTimeSec: sec, crossfadeSeconds: sec },
  ];
}

export interface LibraryView {
  cues: CueLike[];
  check: SongCheck;
  timeline: MechanismTimeline | null;
}

export function buildLibraryView(
  axes: TrackMechanism[], resolved: Map<string, ResolvedRow>, timings: Map<string, MechanismTimings>,
  cueId: string, name: string, crossfadeSeconds: number,
): LibraryView {
  const cues = libraryViewCues(cueId, name, crossfadeSeconds);
  const rows = new Map(resolved);
  rows.set(LIB_START_ID, defaultRow(axes));
  if (!rows.has(cueId)) rows.set(cueId, defaultRow(axes));
  return {
    cues,
    check: checkSongMechanisms(axes, cues, rows, timings),
    timeline: buildMechanismTimeline(axes, cues, id => {
      const r = rows.get(id);
      return r ? valuesOf(r) : null;
    }, ownMoveFor(rows, timings)),
  };
}
