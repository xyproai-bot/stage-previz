// 導演頁的機關時間軸接線：把 useStageMechanisms 看得到的機關 / 分組 / 時間表，包成機關時間軸畫面要的樣子（TimelineMech），
// 再補上「時間軸自己播」時 3D 每幀要問的機關位置。
//   - 沒有 commitTiming → 時間軸只能看（改不了）
//   - 「現在預覽到第幾秒」只存在 ref 裡（跟編輯頁一樣，每幀不重畫 React）；時間軸關掉 / 拆掉時畫面自己把它清成 null
//   - freeActive = 時間軸開著、而且沒有影片可以跟 → 3D 機關跟著時間軸；其他時候不碰 3D（有影片就照影片，沒開就照目前的 cue）

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Mechanism, MechanismGroup } from './model';
import type { MechanismTimeline as Timeline } from './motion';
import type { MechanismSceneProps } from './useMechanisms';
import { freeFrameValues, type TimelineMech } from './stageTimeline';

const EMPTY_MECHS: Mechanism[] = [];
const NO_SCENE_PROPS: Pick<MechanismSceneProps, 'mechanismAtFrame' | 'mechanismFrameAlways'> = {};

export function useStageTimeline(o: {
  mechanisms: Mechanism[] | null;
  groups: MechanismGroup[];
  timeline: Timeline | null;
  freeActive: boolean;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const previewTimeRef = useRef<number | null>(null);
  const setPreviewTime = useCallback((t: number | null) => { previewTimeRef.current = t; }, []);
  const timelineRef = useRef(o.timeline);
  timelineRef.current = o.timeline;
  const atFrame = useCallback(() => freeFrameValues(previewTimeRef.current, timelineRef.current), []);

  const timelineMech = useMemo<TimelineMech>(() => ({
    timeline: o.timeline, mechanisms: o.mechanisms ?? EMPTY_MECHS, groups: o.groups,
    focusedId, setFocusedId, setPreviewTime, previewTimeRef,
  }), [o.timeline, o.mechanisms, o.groups, focusedId, setPreviewTime]);

  /** 時間軸自己播時才有：每幀都問 atFrame（沒在預覽 → 回 null → 照目前的 cue 走）；其他時候是空的，不蓋掉 mech.sceneProps */
  const sceneProps = useMemo(
    () => (o.freeActive ? { mechanismAtFrame: atFrame, mechanismFrameAlways: true } : NO_SCENE_PROPS),
    [o.freeActive, atFrame],
  );
  return { timelineMech, sceneProps };
}
