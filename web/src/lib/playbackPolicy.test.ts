import { describe, expect, it } from 'vitest';
import { commentOpenPlan, playsAfterLoad } from './playbackPolicy';

describe('載好一支影片之後要不要開始播', () => {
  it('進歌、換歌、換版本、通知點進來、頁面剛打開、交的影片好了、本地檔案：都不會自己播', () => {
    expect(playsAfterLoad({})).toBe(false);
    // 換之前在播也一樣（換歌時上一首在播）
    expect(playsAfterLoad({ wasPlaying: true })).toBe(false);
    expect(playsAfterLoad({ sameSecond: false, wasPlaying: true })).toBe(false);
  });

  it('換網址接著同一秒（比較 A/B、有新版 · 切換、網址過期）：播放 / 暫停照舊', () => {
    expect(playsAfterLoad({ sameSecond: true, wasPlaying: true })).toBe(true);
    expect(playsAfterLoad({ sameSecond: true, wasPlaying: false })).toBe(false);
    expect(playsAfterLoad({ sameSecond: true })).toBe(false);
  });

  it('明講要不要播的照講的（點了區段留言 → 播；明講不要 → 換之前在播也停住）', () => {
    expect(playsAfterLoad({ autoplay: true })).toBe(true);
    expect(playsAfterLoad({ autoplay: false, sameSecond: true, wasPlaying: true })).toBe(false);
    expect(playsAfterLoad({ autoplay: true, sameSecond: true, wasPlaying: false })).toBe(true);
  });
});

describe('點一則留言', () => {
  it('一般留言：跳到那一秒、停住，不會開始播', () => {
    expect(commentOpenPlan({ time: 12, timeEnd: null }, null)).toEqual({ at: 12, hasTime: true, loop: null, play: false });
  });

  it('沒有時間的留言（0 秒、沒有區段）：不跳、不播', () => {
    expect(commentOpenPlan({ time: 0 }, null)).toEqual({ at: 0, hasTime: false, loop: null, play: false });
  });

  it('區段留言、沒有畫記：從區段開頭循環那一段（自己點的才會打開留言）', () => {
    expect(commentOpenPlan({ time: 12, timeEnd: 18 }, null)).toEqual({ at: 12, hasTime: true, loop: { start: 12, end: 18 }, play: true });
    // 從 0 秒開始的區段也算有時間
    expect(commentOpenPlan({ time: 0, timeEnd: 4 }, null).hasTime).toBe(true);
  });

  it('有畫記：停在畫的那一格給你看，不播（區段照樣記著，按播放再循環）', () => {
    expect(commentOpenPlan({ time: 3 }, { t: 5 })).toEqual({ at: 5, hasTime: true, loop: null, play: false });
    expect(commentOpenPlan({ time: 12, timeEnd: 18 }, { t: 15 })).toEqual({ at: 15, hasTime: true, loop: { start: 12, end: 18 }, play: false });
  });

  it('畫的那一格離區段太遠 → 停在區段開頭；畫記沒有記時間 → 留言的時間', () => {
    expect(commentOpenPlan({ time: 12, timeEnd: 18 }, { t: 40 }).at).toBe(12);
    expect(commentOpenPlan({ time: 12, timeEnd: 18 }, { t: 18.4 }).at).toBe(18.4);
    expect(commentOpenPlan({ time: 7 }, {})).toEqual({ at: 7, hasTime: true, loop: null, play: false });
  });

  it('區段的結束不在開始後面 → 當一般留言', () => {
    expect(commentOpenPlan({ time: 9, timeEnd: 9 }, null)).toEqual({ at: 9, hasTime: true, loop: null, play: false });
  });
});
