// web/src/lib/tutorial/animatorTour.test.ts
import { describe, expect, it } from 'vitest';
import {
  ANIMATOR_TOUR_SEEN_KEY, animatorTourSteps, markTourSeen, producerContactText, readTourSeen, shouldAutoStartTour,
} from './animatorTour';

const ctx = { ledHasPicture: false, producerNames: ['王小明'] };

describe('帶著做的步驟', () => {
  it('十步，順序固定', () => {
    expect(animatorTourSteps(ctx).map(s => s.id)).toEqual([
      'welcome', 'songs', 'stage', 'test-pattern', 'local-file', 'cues', 'add-video', 'ae-live', 'record', 'help',
    ]);
  });

  it('第一步和亮的地方', () => {
    const steps = animatorTourSteps(ctx);
    expect(steps[0].target).toBeNull();
    expect(steps[0].body).toContain('不用改');
    expect(steps.find(s => s.id === 'local-file')!.target).toBe('source-file');
    expect(steps.find(s => s.id === 'local-file')!.waitFor).toBe('local-file');
    expect(steps.find(s => s.id === 'local-file')!.done?.title).toBe('成功了');
    expect(steps.find(s => s.id === 'stage')!.waitFor).toBe('stage-drag');
  });

  it('LED 沒畫面 → 說「現在」看到的是測試圖；有畫面 → 說沒放東西的時候才會看到', () => {
    const none = animatorTourSteps(ctx).find(s => s.id === 'test-pattern')!;
    const some = animatorTourSteps({ ...ctx, ledHasPicture: true }).find(s => s.id === 'test-pattern')!;
    expect(none.body).toContain('現在');
    expect(some.body).toContain('沒放東西的時候');
  });

  it('最後一步寫出這個專案的製作', () => {
    expect(animatorTourSteps(ctx).at(-1)!.body).toContain('王小明');
    expect(animatorTourSteps({ ...ctx, producerNames: [] }).at(-1)!.body).toContain('邀請你進來的製作');
  });

  it('每一步都有標題和內容，沒有英文角色字', () => {
    for (const s of animatorTourSteps(ctx)) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.title + s.body).not.toMatch(/admin|animator|director|producer/i);
    }
  });

  it('錄成影片、使用說明找不到時有提示', () => {
    const steps = animatorTourSteps(ctx);
    expect(steps.find(s => s.id === 'record')!.missingHint).toBeTruthy();
    expect(steps.find(s => s.id === 'help')!.missingHint).toContain('⋯');
  });

  it('窄畫面收起來的歌單、沒有 cue、不是自己負責的歌，找不到時也有提示', () => {
    const steps = animatorTourSteps(ctx);
    for (const id of ['songs', 'cues', 'add-video'] as const) {
      expect(steps.find(s => s.id === id)!.missingHint, id).toBeTruthy();
    }
  });
});

describe('producerContactText', () => {
  it('沒有 → 邀請你進來的製作', () => {
    expect(producerContactText([])).toBe('邀請你進來的製作');
    expect(producerContactText(['  '])).toBe('邀請你進來的製作');
  });
  it('一到三個 → 列名字', () => {
    expect(producerContactText(['王小明'])).toBe('這個專案的製作 王小明');
    expect(producerContactText(['甲', '乙'])).toBe('這個專案的製作 甲、乙');
  });
  it('超過三個 → 前三個加「等人」', () => {
    expect(producerContactText(['甲', '乙', '丙', '丁'])).toBe('這個專案的製作 甲、乙、丙 等人');
  });
});

describe('什麼時候自動出現', () => {
  it('只有動畫師、不是「用動畫師的畫面看」、沒看過', () => {
    expect(shouldAutoStartTour({ projectRole: 'animator', viewAsActive: false, seen: false })).toBe(true);
    expect(shouldAutoStartTour({ projectRole: 'animator', viewAsActive: false, seen: true })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: 'animator', viewAsActive: true, seen: false })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: 'admin', viewAsActive: false, seen: false })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: 'director', viewAsActive: false, seen: false })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: null, viewAsActive: false, seen: false })).toBe(false);
  });
});

describe('記得看過', () => {
  it('寫了就讀得到', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    expect(readTourSeen(st)).toBe(false);
    markTourSeen(st);
    expect(m.get(ANIMATOR_TOUR_SEEN_KEY)).toBe('1');
    expect(readTourSeen(st)).toBe(true);
  });
  it('瀏覽器不給存（無痕、擋掉）→ 當作看過，不要每次都跳；寫入失敗也不會壞', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readTourSeen(bad)).toBe(true);
    expect(readTourSeen(null)).toBe(true);
    expect(() => markTourSeen(bad)).not.toThrow();
    expect(() => markTourSeen(null)).not.toThrow();
  });
});
