import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Cue } from '../api';
import MechanismTimeline from '../../components/mechanisms/MechanismTimeline';
import type { Mechanism, MechanismValues } from './model';
import { buildMechanismTimeline } from './motion';
import {
  STAGE_TIMELINE_TEXT, editHandlers, freeFrameValues, showTimeline, showTimelineButton, timelineEditing, timelineLength, timelineSource,
  type TimelineMech,
} from './stageTimeline';
import { useStageTimeline } from './useStageTimeline';

// ── 小資料：一個升降台，第 0 秒在 0、第 30 秒到 3 公尺（轉場 20 秒 → 第 10 秒開始動）──
const lift = {
  id: 'lift', name: '中央升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 3, defaultValue: 0,
  maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0, metadata: null, cueCount: 2, updatedAt: '',
} as Mechanism;
const motionCue = (id: string, order: number, videoTimeSec: number | null, crossfadeSeconds: number) => ({ id, order, videoTimeSec, crossfadeSeconds, status: 'master' as const });
const values: Record<string, MechanismValues> = { a: { lift: 0 }, b: { lift: 3 } };
const timeline = buildMechanismTimeline([lift], [motionCue('a', 0, 0, 0), motionCue('b', 1, 30, 20)], id => values[id])!;
const cues = [
  { ...motionCue('a', 0, 0, 0), name: '開場' },
  { ...motionCue('b', 1, 30, 20), name: '升起來' },
] as unknown as Cue[];

const mechOf = (extra: Partial<TimelineMech> = {}): TimelineMech => ({
  timeline, mechanisms: [lift], groups: [], focusedId: null, setFocusedId: () => {}, setPreviewTime: () => {}, previewTimeRef: { current: null },
  commitTiming: async () => {},
  ...extra,
});
const render = (props: Partial<Parameters<typeof MechanismTimeline>[0]> = {}) => renderToStaticMarkup(
  <MechanismTimeline mech={mechOf()} cues={cues} selectedCueId="b" onSelectCue={() => {}} onClose={() => {}} {...props} />,
);

describe('導演頁機關時間軸：什麼時候出現', () => {
  it('按鈕：有機關、在審片才有；沒有機關、調整舞台時沒有', () => {
    expect(showTimelineButton({ hasMechanisms: true, adjustOn: false })).toBe(true);
    expect(showTimelineButton({ hasMechanisms: false, adjustOn: false })).toBe(false);
    expect(showTimelineButton({ hasMechanisms: true, adjustOn: true })).toBe(false);
  });
  it('時間軸：按開了才有；調整舞台、全螢幕預演（給客戶看）、沒有機關都不能出現', () => {
    const base = { open: true, hasMechanisms: true, adjustOn: false, fullscreen: false };
    expect(showTimeline(base)).toBe(true);
    expect(showTimeline({ ...base, open: false })).toBe(false);
    expect(showTimeline({ ...base, adjustOn: true })).toBe(false);
    expect(showTimeline({ ...base, fullscreen: true })).toBe(false);
    expect(showTimeline({ ...base, hasMechanisms: false })).toBe(false);
  });
});

describe('導演頁機關時間軸：跟誰的時間走', () => {
  it('影片載好了 → 跟影片；沒有影片 / 還在載 → 時間軸自己播', () => {
    expect(timelineSource({ videoMode: true, videoReady: true })).toBe('video');
    expect(timelineSource({ videoMode: true, videoReady: false })).toBe('free');
    expect(timelineSource({ videoMode: false, videoReady: true })).toBe('free');
    expect(timelineSource({ videoMode: false, videoReady: false })).toBe('free');
  });
  it('自己播：有時間就照時間軸，沒有時間（沒在預覽 / 時間軸關了）→ null，3D 回到目前的 cue', () => {
    expect(freeFrameValues(null, timeline)).toBeNull();
    expect(freeFrameValues(30, null)).toBeNull();
    expect(freeFrameValues(0, timeline)).toEqual({ lift: 0 });
    expect(freeFrameValues(20, timeline)!.lift).toBeCloseTo(1.5, 9);
    expect(freeFrameValues(99, timeline)).toEqual({ lift: 3 });
  });
  it('時間尺的長度：編輯頁照舊；跟著影片時至少畫到影片那麼長', () => {
    expect(timelineLength({ endTime: 30, single: false })).toBe(34);
    expect(timelineLength({ endTime: 0, single: false })).toBe(10);
    expect(timelineLength({ endTime: 5, single: true })).toBe(6.5);
    expect(timelineLength({ endTime: 0, single: true })).toBe(4);
    expect(timelineLength({ endTime: 30, single: false, clockDuration: 200 })).toBe(200);
    expect(timelineLength({ endTime: 30, single: false, clockDuration: 12 })).toBe(34);
    expect(timelineLength({ endTime: 30, single: false, clockDuration: NaN })).toBe(34);
    expect(timelineLength({ endTime: 30, single: false, clockDuration: Infinity })).toBe(34);
  });
});

describe('導演頁機關時間軸：只能看（拖不動、鍵盤改不了）', () => {
  it('只能看 → 拖整條、拖右邊、鍵盤都關掉；編輯頁都開著', () => {
    expect(timelineEditing(true)).toEqual({ drag: false, resize: false, keyboard: false });
    expect(timelineEditing(false)).toEqual({ drag: true, resize: true, keyboard: true });
  });
  it('只能看 → 色塊上一個「改」的事件都不掛；編輯頁照舊全掛', () => {
    const h = { onPointerDown: () => {}, onPointerMove: () => {}, onPointerUp: () => {}, onPointerCancel: () => {}, onKeyDown: () => {}, onKeyUp: () => {} };
    expect(Object.keys(editHandlers(true, h))).toEqual([]);
    expect(Object.keys(editHandlers(false, h)).sort()).toEqual(Object.keys(h).sort());
  });

  it('編輯頁（沒給 readOnly）：跟以前一樣——有右邊的把手、說明寫拖、有停止預覽', () => {
    const html = render();
    expect(html).toContain('mech-tl__handle');
    expect(html).toContain('拖整條改延遲、拖右邊改走幾秒（按住 Alt 不吸附）');
    expect(html).toContain('aria-label="停止預覽"');
    expect(html).not.toContain('mech-tl--readonly');
    expect(html).not.toContain(STAGE_TIMELINE_TEXT.barTip);
  });
  it('導演頁（readOnly）：沒有把手、不叫人拖、色塊是只能點的；播放 / 縮放 / 收起來都在', () => {
    const html = render({ readOnly: true });
    expect(html).toContain('mech-tl--readonly');
    expect(html).toContain('mech-tl__move');
    expect(html).not.toContain('mech-tl__handle');
    expect(html).not.toContain('拖整條改延遲');
    expect(html).not.toContain('展開這一排可以拖');
    expect(html).toContain(STAGE_TIMELINE_TEXT.readOnlyHint);
    expect(html).toContain(STAGE_TIMELINE_TEXT.barTip);
    for (const label of ['播放', '停止預覽', '縮小', '放大', '整首放進來', '收起機關時間軸']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('點一下 / 拖：3D 畫面的機關跟著這個時間');
  });
  it('導演頁這首歌沒有任何正式 cue（時間軸是空的）：寫給導演看的說明（不叫人去編輯頁的分頁）；沒設時間的 cue 會暫排，不會落到這裡', () => {
    const html = render({ readOnly: true, mech: mechOf({ timeline: null }) });
    expect(html).toContain(STAGE_TIMELINE_TEXT.noCueTimes);
    expect(html).not.toContain('先在右邊');
  });
  it('跟著影片：播放鍵是影片的播放鍵、沒有停止預覽（影片有自己的）、時間尺的提示寫影片會跳過去', () => {
    const clock = { now: () => 0, playing: false, toggle: () => {}, seek: () => {}, duration: 200 };
    const paused = render({ readOnly: true, clock });
    expect(paused).toContain(STAGE_TIMELINE_TEXT.readOnlyHintVideo);
    expect(paused).toContain(STAGE_TIMELINE_TEXT.playVideoTitle);
    expect(paused).toContain(STAGE_TIMELINE_TEXT.rulerTipVideo);
    expect(paused).not.toContain('aria-label="停止預覽"');
    const playing = render({ readOnly: true, clock: { ...clock, playing: true } });
    expect(playing).toContain(STAGE_TIMELINE_TEXT.pauseVideoTitle);
    expect(playing).toContain('aria-label="暫停"');
  });
});

describe('useStageTimeline：導演頁的接線', () => {
  type Hook = ReturnType<typeof useStageTimeline>;
  const probe = (freeActive: boolean): Hook => {
    let out: Hook | null = null;
    function Probe() {
      out = useStageTimeline({ mechanisms: [lift], groups: [], timeline, freeActive });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return out!;
  };

  it('給時間軸的資料沒有 commitTiming（改不了）', () => {
    const r = probe(true);
    expect('commitTiming' in r.timelineMech).toBe(false);
    expect(r.timelineMech.mechanisms).toHaveLength(1);
  });
  it('時間軸沒開 / 有影片可以跟：不碰 3D（不給 mechanismAtFrame，也不要每幀問）', () => {
    expect(Object.keys(probe(false).sceneProps)).toEqual([]);
  });
  it('時間軸自己播：3D 每幀問時間軸；預覽到第幾秒就是第幾秒，關掉（時間清成 null）就回到目前的 cue', () => {
    const r = probe(true);
    const sp = r.sceneProps as { mechanismAtFrame: () => MechanismValues | null; mechanismFrameAlways: boolean };
    expect(sp.mechanismFrameAlways).toBe(true);
    expect(sp.mechanismAtFrame()).toBeNull();
    r.timelineMech.setPreviewTime(30);
    expect(sp.mechanismAtFrame()).toEqual({ lift: 3 });
    r.timelineMech.setPreviewTime(null);
    expect(sp.mechanismAtFrame()).toBeNull();
  });
});

describe('導演頁機關時間軸的字', () => {
  it('沒有英文叫人的字、沒有 emoji、沒有機器速度提醒', () => {
    const all = Object.values(STAGE_TIMELINE_TEXT).join('\n');
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(all).not.toMatch(/最高速度|機器速度|太快|來不及|晚到|需要秒數|可用秒數/);
  });
});
