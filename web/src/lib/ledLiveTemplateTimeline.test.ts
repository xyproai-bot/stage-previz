// 中途換版型（時間線）怎麼進到「LED 上現在用哪一份」和「LED 版型：…」標籤（lib/ledLiveTemplate.ts）
import { describe, expect, it } from 'vitest';
import type { LedTemplatePlan } from './ledTemplate';
import type { LedTemplate, LedTemplateList } from './ledTemplateApi';
import { chooseLedTemplate, ledTemplateChip, songTimelineOf } from './ledLiveTemplate';
import { buildTimeline, type TimelineSwitch } from './ledTemplateTimeline';

const FULL = { width: 8800, height: 2024 };
const plan = (name: string, canvas: { width: number; height: number }, id: string | null = name): LedTemplatePlan => ({
  v: 1, id, name, canvas, scalePct: 100, screens: [],
});
const tpl = (name: string, canvas: { width: number; height: number }, kind: 'full' | 'custom' = 'custom'): LedTemplate => ({
  ...plan(name, canvas), id: name, kind, sortOrder: 0, songCount: 0, canvas,
});
const A = tpl('甲', { width: 4400, height: 200 });
const B = tpl('乙', { width: 4400, height: 200 });
const L: LedTemplateList = { fullCanvas: FULL, templates: [tpl('全部', FULL, 'full'), A, B], screens: [] };
const sw = (id: string, templateId: string, o: Partial<TimelineSwitch>): TimelineSwitch => ({ id, cueId: null, atSec: null, templateId, ...o });
const switches = [sw('1', '乙', { cueId: 'c4', cueTimeSec: 83, cueName: 'Cue 4' })];

describe('songTimelineOf', () => {
  it('開頭 + 換版型的點 → 時間線；沒有點 / 開頭不是自己排的版型 / 清單還沒讀到 = null', () => {
    const tl = songTimelineOf(L, '甲', switches)!;
    expect(tl.segments.map(x => [x.fromSec, x.plan.name, x.label])).toEqual([[0, '甲', null], [83, '乙', 'Cue 4']]);
    expect(songTimelineOf(L, '甲', [])).toBeNull();
    expect(songTimelineOf(L, null, switches)).toBeNull();
    expect(songTimelineOf(L, '全部', switches)).toBeNull();
    expect(songTimelineOf(null, '甲', switches)).toBeNull();
  });
  it('畫面上最新的 Cue 時間優先', () => {
    const live = songTimelineOf(L, '甲', switches, new Map([['c4', { name: 'Cue 4', timeSec: 95 }]]))!;
    expect(live.segments[1].fromSec).toBe(95);
  });
});

describe('chooseLedTemplate：時間線', () => {
  const tl = songTimelineOf(L, '甲', switches)!;
  it('影片版本：用那一版自己的時間線（plan = 開頭的版型）；沒有時間線的版本跟以前一樣', () => {
    const versionTl = buildTimeline(A, [sw('1', '乙', { atSec: 10 })], new Map([['乙', B]]))!;
    expect(chooseLedTemplate({ source: 'version', versionPlan: A, versionTimeline: versionTl, songPlan: B })).toEqual({ plan: A, origin: 'version', timeline: versionTl });
    expect(chooseLedTemplate({ source: 'version', versionPlan: A, songPlan: B })).toEqual({ plan: A, origin: 'version' });
    // 那一版沒有快照 → 整張畫布，就算這首歌現在有時間線
    expect(chooseLedTemplate({ source: 'version', versionPlan: null, songPlan: A, songTimeline: tl })).toEqual({ plan: null, origin: 'none' });
  });
  it('AE 即時、本地檔案：用這首歌現在的時間線；暫時用整張畫布看 = 沒有時間線；版型面板開著蓋過一切', () => {
    expect(chooseLedTemplate({ source: 'ndi', songPlan: A, songTimeline: tl })).toEqual({ plan: A, origin: 'song', timeline: tl });
    expect(chooseLedTemplate({ source: 'file', songPlan: A, songTimeline: tl, fullView: true })).toEqual({ plan: null, origin: 'override' });
    expect(chooseLedTemplate({ source: 'ndi', previewPlan: B, songPlan: A, songTimeline: tl })).toEqual({ plan: B, origin: 'preview' });
    // 這首歌沒選版型時，時間線不會冒出來
    expect(chooseLedTemplate({ source: 'ndi', songPlan: null, songTimeline: tl })).toEqual({ plan: null, origin: 'none' });
  });
});

describe('ledTemplateChip：時間線', () => {
  const tl = songTimelineOf(L, '甲', switches)!;
  const choice = chooseLedTemplate({ source: 'ndi', songPlan: A, songTimeline: tl });
  const at = (timeSec: number, extra = {}) => ledTemplateChip(choice, { source: 'ndi', songPlan: A, list: L, timeSec, clocked: true, ...extra })!;

  it('寫現在是哪個版型和下一次換版型的時間；播到換版型的時間換成下一段、最後一段寫「最後一段」', () => {
    expect(at(10).text).toBe('LED 版型：甲（4400×200） · 1:23.0 換成「乙」');
    expect(at(82.96).text).toBe('LED 版型：甲（4400×200） · 1:23.0 換成「乙」');
    expect(at(83).text).toBe('LED 版型：乙（4400×200） · 最後一段');
    expect(at(10).timeline).toMatchObject({ activeIndex: 0, clocked: true, picked: null });
    expect(at(10).timeline!.segments.map(x => x.text)).toEqual(['開頭 · 甲', 'Cue 4 · 1:23.0 · 乙']);
    expect(at(10).title).toContain('Cue 4 · 1:23.0 起換成「乙」');
  });
  it('沒有播放時間的畫面（AE 即時）：手動選的那一段優先於時間；有播放時間的畫面不受手動選的影響', () => {
    const pick = ledTemplateChip(choice, { source: 'ndi', songPlan: A, list: L, timeSec: 0, clocked: false, pickedSegment: 1 })!;
    expect(pick.text).toBe('LED 版型：乙（4400×200） · 最後一段');
    expect(pick.timeline).toMatchObject({ activeIndex: 1, picked: 1, clocked: false });
    expect(at(0, { pickedSegment: 1 }).timeline).toMatchObject({ activeIndex: 0, picked: null, clocked: true });
  });
  it('影片版本的標籤：寫「這一版上傳時的版型時間線」，不能暫時用整張畫布看', () => {
    const vchoice = chooseLedTemplate({ source: 'version', versionPlan: A, versionTimeline: tl });
    const c = ledTemplateChip(vchoice, { source: 'version', songPlan: A, list: L, timeSec: 100, clocked: true })!;
    expect(c.text).toBe('LED 版型：乙（4400×200） · 最後一段');
    expect(c.title).toContain('上傳時');
    expect(c.canToggle).toBe(false);
  });
  it('沒有時間線的標籤跟以前完全一樣（沒有 timeline 欄位）', () => {
    const c = ledTemplateChip(chooseLedTemplate({ source: 'ndi', songPlan: A }), { source: 'ndi', songPlan: A, list: L, timeSec: 99, clocked: false })!;
    expect(c.text).toBe('LED 版型：甲（4400×200）');
    expect(c.timeline).toBeUndefined();
  });
});
