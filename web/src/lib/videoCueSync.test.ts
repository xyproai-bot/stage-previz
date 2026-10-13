import { describe, it, expect } from 'vitest';
import type { CueState } from './api';
import { cueSeekTime, loadTimeline, timelineFrame, type FrameState } from './videoCueSync';

/** 一個 LED 在 x 的位置 */
function states(x: number, visible = true): CueState[] {
  return [{
    objectId: 'led1', meshName: 'LED_1', displayName: 'LED 1', category: 'led_panel', order: 0, locked: false,
    default: { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 } },
    override: null,
    effective: { position: { x, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 }, visible },
  } as CueState];
}

// cue A 在 0 秒（x = 0）；cue B 在 30 秒、轉場 20 秒（x = 10）
const cues = [
  { id: 'A', videoTimeSec: 0, crossfadeSeconds: 1 },
  { id: 'B', videoTimeSec: 30, crossfadeSeconds: 20 },
  { id: 'C', videoTimeSec: null, crossfadeSeconds: 1 },  // 沒設時間：手動點的
];
const byCue: Record<string, CueState[]> = { A: states(0), B: states(10), C: states(99) };
const statesFor = (id: string) => (byCue[id] ? Promise.resolve(byCue[id]) : null);

const playing = (time: number, over: Partial<FrameState> = {}): FrameState => ({
  active: true, ready: true, selectedCueId: 'A', time, ...over,
});

const xAt = (pose: ReturnType<typeof timelineFrame>) => pose?.get('led1')?.position.x;

describe('舞台跟著影片時間走', () => {
  it('cue 30 秒、轉場 20 秒 → 10 秒開始動，等速，30 秒到位', async () => {
    const tl = await loadTimeline(cues, statesFor);
    expect(tl?.windows.find(w => w.cueId === 'B')).toEqual({ cueId: 'B', start: 10, arrive: 30 });
    expect(xAt(timelineFrame(tl, playing(5)))).toBe(0);
    expect(xAt(timelineFrame(tl, playing(10)))).toBe(0);
    expect(xAt(timelineFrame(tl, playing(15)))).toBeCloseTo(2.5);
    expect(xAt(timelineFrame(tl, playing(20)))).toBeCloseTo(5);   // 一半時間 = 一半距離（等速）
    expect(xAt(timelineFrame(tl, playing(25)))).toBeCloseTo(7.5);
    expect(xAt(timelineFrame(tl, playing(30)))).toBe(10);
    expect(xAt(timelineFrame(tl, playing(45)))).toBe(10);
  });

  it('暫停 / 拉回時間軸：同一秒永遠同一個位置（看影片時間，不是時鐘）', async () => {
    const tl = await loadTimeline(cues, statesFor);
    expect(xAt(timelineFrame(tl, playing(20)))).toBeCloseTo(5);
    expect(xAt(timelineFrame(tl, playing(12)))).toBeCloseTo(1);
    expect(xAt(timelineFrame(tl, playing(20)))).toBeCloseTo(5);
  });

  it('沒在放影片 / 還沒讀好 / 手動點了沒設時間的 cue → 照平常（null）', async () => {
    const tl = await loadTimeline(cues, statesFor);
    expect(timelineFrame(tl, playing(20, { active: false }))).toBeNull();
    expect(timelineFrame(tl, playing(20, { ready: false }))).toBeNull();
    expect(timelineFrame(tl, playing(20, { selectedCueId: 'C' }))).toBeNull();
    expect(timelineFrame(null, playing(20))).toBeNull();
    // 還沒選 cue 也照影片時間
    expect(xAt(timelineFrame(tl, playing(20, { selectedCueId: null })))).toBeCloseTo(5);
  });

  it('沒有 cue 設影片時間 → 沒有時間軸', async () => {
    expect(await loadTimeline([{ id: 'X', videoTimeSec: null, crossfadeSeconds: 1 }], statesFor)).toBeNull();
  });

  it('某個 cue 的位置抓不到 → 走到那段時先不照時間軸擺（不會亂跳）', async () => {
    const tl = await loadTimeline(cues, (id) => (id === 'B' ? Promise.reject(new Error('offline')) : statesFor(id)));
    expect(xAt(timelineFrame(tl, playing(5)))).toBe(0);
    expect(timelineFrame(tl, playing(20))).toBeNull();
  });

  it('點 cue 跳到那個 cue 的時間；沒設時間 / 沒在放影片不跳', () => {
    expect(cueSeekTime({ videoTimeSec: 30 }, true)).toBe(30);
    expect(cueSeekTime({ videoTimeSec: null }, true)).toBeNull();
    expect(cueSeekTime({ videoTimeSec: 30 }, false)).toBeNull();
    expect(cueSeekTime(null, true)).toBeNull();
  });
});
