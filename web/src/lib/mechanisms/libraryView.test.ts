import { describe, expect, it } from 'vitest';
import { buildLibraryView, LIB_START_ID } from './libraryView';
import { resolveLibrarySongMechanisms } from './track';
import { ownTimingsByCue } from './track';
import type { Look } from '../cueLibraryApi';
import { applyDraftToLook, newDraft, setMechanism } from '../lookDraft';
import { usageSlotText } from '../cueLibraryList';

const mechs = [
  { id: 'm1', defaultValue: 0, travelMin: 0, travelMax: 5, kind: 'linear' as const },
  { id: 'm2', defaultValue: 0, travelMin: 0, travelMax: 5, kind: 'linear' as const },
];
const CUE = 'slot1';

function view(rows: { mechanismId: string; value: number; delaySec: number | null; durationSec: number | null }[], cf = 2) {
  const positions = rows.map(r => ({ cueId: CUE, ...r, updatedAt: '', carried: false }));
  const resolved = resolveLibrarySongMechanisms(mechs as never, [{ id: CUE } as never], positions);
  return buildLibraryView(mechs as never, resolved, ownTimingsByCue(positions), CUE, '開場', cf);
}

describe('Cue 庫裡看一個 cue 的機關時間表', () => {
  it('從預設位置走到這個 cue；0 秒 = 開始轉場，延遲 / 走幾秒照 cue 存的', () => {
    const v = view([
      { mechanismId: 'm1', value: 2, delaySec: 0.5, durationSec: 3 },
      { mechanismId: 'm2', value: 1, delaySec: null, durationSec: null },
    ]);
    const tl = v.timeline!;
    const m1 = tl.moveFor(CUE, 'm1')!;
    expect([m1.from, m1.to, m1.start, m1.duration, m1.end]).toEqual([0, 2, 0.5, 3, 3.5]);
    const m2 = tl.moveFor(CUE, 'm2')!;
    expect([m2.start, m2.duration]).toEqual([0, 2]);        // 沒設 → 跟著轉場秒數
    expect(tl.endTime).toBe(3.5);                           // 到最後一個機關停下
    expect(v.check.cues.get(CUE)!.items.m1.prevCueId).toBe(LIB_START_ID);
  });

  it('改延遲 → 時間表跟著變（拖色塊 / 打欄位）', () => {
    const a = view([{ mechanismId: 'm1', value: 2, delaySec: 0, durationSec: null }]);
    const b = view([{ mechanismId: 'm1', value: 2, delaySec: 1.5, durationSec: null }]);
    expect(a.timeline!.moveFor(CUE, 'm1')!.start).toBe(0);
    expect(b.timeline!.moveFor(CUE, 'm1')!.start).toBe(1.5);
  });

  it('沒有機關動 → 沒有色塊', () => {
    expect(view([]).timeline!.moves).toHaveLength(0);
  });
});

describe('Cue 庫裡改機關延遲 → 草稿 → 覆蓋', () => {
  const base: Look = { objects: [], mechanisms: [{ mechanismId: 'm1', value: 2, delaySec: null, durationSec: null, carried: false }] };
  it('草稿記下新的延遲，覆蓋後 cue 的機關列變了（位置不動）', () => {
    const d = setMechanism(newDraft('L'), 'm1', { value: 2, delaySec: 1.2, durationSec: 4 });
    const after = applyDraftToLook(base, d);
    expect(after.mechanisms).toEqual([{ mechanismId: 'm1', value: 2, delaySec: 1.2, durationSec: 4, carried: false }]);
    expect(base.mechanisms[0].delaySec).toBeNull();          // 沒按覆蓋前原本的不動
  });
});

describe('用在：歌的編號', () => {
  const slot = { songId: 's1', songName: '測試', songCode: 'S00', videoTimeSec: 0 };
  it('歌單上現在的代號為準（後台資料是舊的 S00，歌單已經改成 S01）', () => {
    expect(usageSlotText(slot, () => ({ code: 'S01', name: '測試' }))).toBe('S01 0:00');
  });
  it('歌單裡找不到才用後台給的；沒代號寫歌名', () => {
    expect(usageSlotText(slot, () => null)).toBe('S00 0:00');
    expect(usageSlotText(slot)).toBe('S00 0:00');
    expect(usageSlotText(slot, () => ({ code: null, name: '新名字' }))).toBe('新名字 0:00');
  });
});
