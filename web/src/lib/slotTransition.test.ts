import { describe, expect, it } from 'vitest';
import { slotTransitionText } from './cueTiming';

describe('歌裡的 cue 的轉場文字（Cue 庫給預設，歌可以另外設）', () => {
  it('用 Cue 庫的', () => {
    expect(slotTransitionText({ crossfadeSeconds: 1, crossfadeOwn: false, libraryCrossfadeSeconds: 1 })).toBe('轉場 1 秒 · 用 Cue 庫的');
  });
  it('這首歌另外設（跟 Cue 庫不一樣、或剛好一樣都寫另外設）', () => {
    expect(slotTransitionText({ crossfadeSeconds: 2, crossfadeOwn: true, libraryCrossfadeSeconds: 1 })).toBe('轉場 2 秒 · 這首歌另外設');
    expect(slotTransitionText({ crossfadeSeconds: 1, crossfadeOwn: true, libraryCrossfadeSeconds: 1 })).toBe('轉場 1 秒 · 這首歌另外設');
  });
  it('0 秒 = 直接切換，一樣寫來源', () => {
    expect(slotTransitionText({ crossfadeSeconds: 0, crossfadeOwn: false, libraryCrossfadeSeconds: 0 })).toBe('直接切換 · 用 Cue 庫的');
  });
  it('舊模式的 cue（後台沒給來源）照舊，不加字', () => {
    expect(slotTransitionText({ crossfadeSeconds: 1 })).toBe('轉場 1 秒');
    expect(slotTransitionText({ crossfadeSeconds: 0 })).toBe('直接切換');
  });
});
