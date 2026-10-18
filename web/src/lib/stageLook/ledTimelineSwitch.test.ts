// 中途換版型的「換」：用真的 uniform 和真的畫面時鐘模擬 30 fps 的影片，檢查
//   換版型的那一格剛好換（不早不晚、沒有一格兩邊都不是的狀態）、來回拉時間軸每一格都對、只有取色座標動、顏色相關的 uniform 一個字不碰
import { describe, expect, it } from 'vitest';
import { createLedSurfaceUniforms } from './ledSurface';
import { createSegmentSwitcher, type SegmentObject } from './ledTimelineSwitch';
import { createFrameClock, type FrameCallbackMeta, type VideoLike } from '../ledFrameClock';
import { buildObjectUniforms, type LedTemplatePlan, type Placement, type SrcSpan } from '../ledTemplate';
import { buildTimeline, segmentIndexAt, type TimelineSwitch } from '../ledTemplateTimeline';

const FULL: SrcSpan = { us: 0, ul: 1, vs: 0, vl: 1 };
const plc = (dest: { x: number; y: number; w: number; h: number }, over: Partial<Placement> = {}): Placement => ({
  key: 'o:oa', objectId: 'oa', uv: null, dest, rotate: 0, flipH: false, flipV: false, ...over,
});
const plan = (id: string, p: Placement, originalUv?: string[]): LedTemplatePlan => ({
  v: 1, id, name: id, canvas: { width: 400, height: 100 }, scalePct: 100, screens: [p], ...(originalUv ? { originalUv } : {}),
});
const A = plan('A', plc({ x: 0, y: 0, w: 400, h: 50 }));
const B = plan('B', plc({ x: 0, y: 50, w: 200, h: 50 }, { rotate: 90, flipH: true }));
const sw = (id: string, templateId: string, atSec: number): TimelineSwitch => ({ id, cueId: null, atSec, templateId });
const TL = buildTimeline(A, [sw('1', 'B', 83)], new Map([['A', A], ['B', B]]))!;

function fakeMaterial() {
  const u = createLedSurfaceUniforms();
  return { userData: { ledSurface: u }, u } as unknown as { userData: { ledSurface: ReturnType<typeof createLedSurfaceUniforms> }; u: ReturnType<typeof createLedSurfaceUniforms> };
}

/** 假 <video>：播放時每一格回報 mediaTime，拉時間軸時 currentTime 先跳走、seeked 才算新的一格 */
class FakeVideo implements VideoLike {
  currentTime = 0;
  private ls = new Map<string, Set<() => void>>();
  private cb: ((now: number, m: FrameCallbackMeta) => void) | null = null;
  requestVideoFrameCallback = (cb: (now: number, m: FrameCallbackMeta) => void) => { this.cb = cb; return 1; };
  cancelVideoFrameCallback = () => { this.cb = null; };
  addEventListener(t: string, l: () => void) { if (!this.ls.has(t)) this.ls.set(t, new Set()); this.ls.get(t)!.add(l); }
  removeEventListener(t: string, l: () => void) { this.ls.get(t)?.delete(l); }
  play(frameTime: number) { this.currentTime = frameTime; const cb = this.cb; this.cb = null; cb?.(0, { mediaTime: frameTime }); }
  seekTo(t: number) { this.currentTime = t; }
  seeked() { this.ls.get('seeked')?.forEach(l => l()); }
}

function setup(timeline = TL, originalUvMaterials: Set<unknown> | null = null) {
  const video = new FakeVideo();
  const clock = createFrameClock(video);
  const m1 = fakeMaterial();
  const m2 = fakeMaterial();
  const per = timeline.segments.map(s => ({ plan: s.plan, data: buildObjectUniforms(s.plan, 'oa', () => FULL), remap: () => null }));
  const obj: SegmentObject = {
    id: 'oa', materials: [m1, m2] as never, per, originalUvMaterials: originalUvMaterials as never,
  };
  const remaps: number[] = [];
  const startIndex = segmentIndexAt(timeline, clock.time());
  const sw2 = createSegmentSwitcher({
    objects: [obj], startIndex, pick: () => segmentIndexAt(timeline, clock.time()),
    setRemap: (_id, r) => { remaps.push(per.findIndex(p => p.remap === r)); },
  });
  // 一開始就是起始那一段
  sw2.apply(startIndex);
  return { video, clock, m1, m2, per, sw: sw2, remaps };
}

const dstOf = (m: { u: ReturnType<typeof createLedSurfaceUniforms> }) => Array.from(m.u.uLedTplDst.value.slice(0, 4));
const matOf = (m: { u: ReturnType<typeof createLedSurfaceUniforms> }) => Array.from(m.u.uLedTplMat.value.slice(0, 4));

describe('換版型的那一格', () => {
  it('兩段的取色資料真的不一樣（不然下面的測試什麼都測不到）', () => {
    const a = buildObjectUniforms(A, 'oa', () => FULL);
    const b = buildObjectUniforms(B, 'oa', () => FULL);
    expect(Array.from(a.dst.slice(0, 4))).not.toEqual(Array.from(b.dst.slice(0, 4)));
    expect(Array.from(a.mat.slice(0, 4))).not.toEqual(Array.from(b.mat.slice(0, 4)));
  });

  it('30 fps 播過 83.0 秒：第 2489 格（82.967）是版型 A、第 2490 格（83.000）剛好換成版型 B，每一格畫的跟 uniform 對得上', () => {
    const t = setup();
    const dstA = Array.from(t.per[0].data!.dst.slice(0, 4));
    const dstB = Array.from(t.per[1].data!.dst.slice(0, 4));
    const seen: [number, number][] = [];
    for (let f = 2485; f <= 2495; f++) {
      const frameTime = f / 30;
      t.video.play(frameTime);          // requestVideoFrameCallback（在 rAF 前）
      t.sw.sync();                      // StageScene 的 tick
      const expectSeg = frameTime + 1e-9 >= 83 ? 1 : 0;
      seen.push([f, t.sw.applied]);
      expect(t.sw.applied).toBe(expectSeg);
      expect(dstOf(t.m1)).toEqual(expectSeg ? dstB : dstA);
      expect(dstOf(t.m2)).toEqual(expectSeg ? dstB : dstA);
    }
    expect(seen.find(([, s]) => s === 1)![0]).toBe(2490);
  });

  it('currentTime 比畫面早一格也不會提早換（用畫面時鐘，不用播放時鐘）', () => {
    const t = setup();
    t.video.play(2489 / 30);
    t.video.currentTime = 2490 / 30;    // 播放時鐘已經跑到下一格了
    t.sw.sync();
    expect(t.sw.applied).toBe(0);
    t.video.play(2490 / 30);
    t.sw.sync();
    expect(t.sw.applied).toBe(1);
  });

  it('來回拉時間軸：每次 seeked 之後那一格用的就是那個時間的版型；拉到一半（畫面還是舊的）不換', () => {
    const t = setup();
    const targets = [10, 100, 83, 82.9667, 83.0333, 0, 83, 200, 82.99];
    for (const target of targets) {
      t.video.seekTo(target);           // 拉的瞬間 currentTime 先跳走
      t.sw.sync();                      // 這時候畫面還是舊的那一格 → 不能換
      t.video.seeked();                 // 新的一格好了
      t.sw.sync();
      const want = segmentIndexAt(TL, target);
      expect(t.sw.applied).toBe(want);
      expect(dstOf(t.m1)).toEqual(Array.from(t.per[want].data!.dst.slice(0, 4)));
    }
  });

  it('沒有換的那一幀什麼都不做（sync 回 false、uniform 的陣列內容不變）', () => {
    const t = setup();
    t.video.play(1);
    expect(t.sw.sync()).toBe(false);
    const snapshot = JSON.stringify([dstOf(t.m1), matOf(t.m1)]);
    t.video.play(1.0333);
    expect(t.sw.sync()).toBe(false);
    expect(JSON.stringify([dstOf(t.m1), matOf(t.m1)])).toBe(snapshot);
    t.video.play(83);
    expect(t.sw.sync()).toBe(true);
    expect(t.sw.sync()).toBe(false);
  });

  it('只動取色座標：顏色相關的 uniform（亮度、tint、色卡）一個字不碰；燈光取色的位置換算一起換', () => {
    const t = setup();
    const keys = Object.keys(t.m1.u).filter(k => !/^uLedTpl|^uLedUvSet$/.test(k));
    const before = JSON.stringify(keys.map(k => (t.m1.u as never as Record<string, { value: unknown }>)[k].value));
    t.video.play(90);
    t.sw.sync();
    t.video.play(10);
    t.sw.sync();
    expect(JSON.stringify(keys.map(k => (t.m1.u as never as Record<string, { value: unknown }>)[k].value))).toBe(before);
    expect(t.remaps.slice(-2)).toEqual([1, 0]);   // 換到 B、再換回 A
    expect(t.m1.u.uLedTplOn.value).toBe(1);
  });

  it('三段：A → B → A；中間版型的取色資料各自存好，來回切不會累積誤差', () => {
    const tl3 = buildTimeline(A, [sw('1', 'B', 20), sw('2', 'A', 40)], new Map([['A', A], ['B', B]]))!;
    const t = setup(tl3);
    const stamp = (seg: number) => JSON.stringify([Array.from(t.per[seg].data!.dst), Array.from(t.per[seg].data!.mat)]);
    for (const [time, seg] of [[5, 0], [25, 1], [45, 2], [25, 1], [5, 0], [45, 2]] as const) {
      t.video.seekTo(time); t.video.seeked(); t.sw.sync();
      expect(t.sw.applied).toBe(seg);
      expect(JSON.stringify([Array.from(t.m1.u.uLedTplDst.value.slice(0, t.per[seg].data!.dst.length)), Array.from(t.m1.u.uLedTplMat.value.slice(0, t.per[seg].data!.mat.length))])).toBe(stamp(seg));
    }
  });
});

describe('舊影片的保護（原本的 UV）跟著段落走', () => {
  it('這一段的快照列了這個物件、而且材質有 uv1 → 用 uv1、不用版型；下一段沒列 → 回到版型取色', () => {
    const mWith = fakeMaterial();
    const mWithout = fakeMaterial();
    const aOrig = plan('A', plc({ x: 0, y: 0, w: 400, h: 50 }), ['oa']);
    const tl = buildTimeline(aOrig, [sw('1', 'B', 10)], new Map([['A', aOrig], ['B', B]]))!;
    const per = tl.segments.map(s => ({ plan: s.plan, data: buildObjectUniforms(s.plan, 'oa', () => FULL), remap: () => null }));
    const obj: SegmentObject = { id: 'oa', materials: [mWith, mWithout] as never, per, originalUvMaterials: new Set([mWith]) as never };
    const s = createSegmentSwitcher({ objects: [obj], startIndex: 0, pick: () => 1, setRemap: () => {} });
    s.apply(0);
    expect(mWith.u.uLedUvSet.value).toBe(1);
    expect(mWith.u.uLedTplOn.value).toBe(0);
    expect(mWithout.u.uLedUvSet.value).toBe(0);
    expect(mWithout.u.uLedTplOn.value).toBe(1);
    expect(s.sync()).toBe(true);
    expect(mWith.u.uLedUvSet.value).toBe(0);
    expect(mWith.u.uLedTplOn.value).toBe(1);
  });
});
