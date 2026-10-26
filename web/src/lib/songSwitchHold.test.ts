// 換歌時畫面直接跳到新歌的 cue：讀取中停在上一首、讀到那次直接跳、之後同一首歌換 cue 照常走轉場、讀太久就不等
import { describe, expect, it } from 'vitest';
import { initialSongSwitch, SONG_SWITCH_MAX_HOLD_MS, stepSongSwitch } from './songSwitchHold';

describe('stepSongSwitch', () => {
  it('沒換歌：不停、不跳（同一首歌換 cue 照常走轉場）', () => {
    const r = stepSongSwitch(initialSongSwitch('a'), 'a', true, 100);
    expect(r).toMatchObject({ hold: false, snap: false });
  });

  it('換歌、新歌還沒讀到：停在上一首；讀到那次：直接跳', () => {
    let s = initialSongSwitch('a');
    let r = stepSongSwitch(s, 'b', false, 100);
    expect(r).toMatchObject({ hold: true, snap: true });
    s = r.state;
    r = stepSongSwitch(s, 'b', false, 500);
    expect(r).toMatchObject({ hold: true, snap: true });
    r = stepSongSwitch(r.state, 'b', true, 600);
    expect(r).toMatchObject({ hold: false, snap: true });
  });

  it('套上以後（pending 清掉）：回到正常', () => {
    const r = stepSongSwitch({ pendingSongId: null, lastSongId: 'b', since: 100 }, 'b', true, 700);
    expect(r).toMatchObject({ hold: false, snap: false });
  });

  it('讀太久（例如讀失敗）：不再停在上一首，但還是直接跳', () => {
    const r1 = stepSongSwitch(initialSongSwitch('a'), 'b', false, 100);
    const r2 = stepSongSwitch(r1.state, 'b', false, 100 + SONG_SWITCH_MAX_HOLD_MS);
    expect(r2).toMatchObject({ hold: false, snap: true });
  });

  it('等的時候又換一首：從新的那首重新等', () => {
    const r1 = stepSongSwitch(initialSongSwitch('a'), 'b', false, 100);
    const r2 = stepSongSwitch(r1.state, 'c', false, 3000);
    expect(r2.state).toMatchObject({ pendingSongId: 'c', since: 3000 });
    expect(r2.hold).toBe(true);
  });

  it('第一次打開（還沒選歌 → 選到第一首）也是直接跳', () => {
    const r = stepSongSwitch(initialSongSwitch(null), 's1', false, 50);
    expect(r).toMatchObject({ hold: true, snap: true });
  });
});
