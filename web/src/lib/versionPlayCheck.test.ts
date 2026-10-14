import { beforeEach, describe, expect, it } from 'vitest';
import { getPlayCheck, recordPlayCheck, resetPlayChecksForTest, versionIdFromKey } from './versionPlayCheck';

describe('版本在這台電腦播的結果', () => {
  beforeEach(() => resetPlayChecksForTest());

  it('versionIdFromKey：只認影片版本（v:）', () => {
    expect(versionIdFromKey('v:sv_1')).toBe('sv_1');
    expect(versionIdFromKey('d:abc')).toBeNull();
    expect(versionIdFromKey('local:3')).toBeNull();
    expect(versionIdFromKey('v:')).toBeNull();
    expect(versionIdFromKey(null)).toBeNull();
  });

  it('記下來、讀得回來；後來播得了會蓋掉播不了', () => {
    expect(getPlayCheck('sv_1')).toBeNull();
    recordPlayCheck('sv_1', { status: 'cannotPlay', reason: 'noVideo', at: 1 });
    expect(getPlayCheck('sv_1')).toEqual({ status: 'cannotPlay', reason: 'noVideo', at: 1 });
    recordPlayCheck('sv_1', { status: 'ok', width: 1920, height: 1080, durationSec: 60, at: 2 });
    expect(getPlayCheck('sv_1')).toMatchObject({ status: 'ok', width: 1920 });
  });

  it('最多記 300 版，舊的先丟', () => {
    for (let i = 0; i < 305; i++) recordPlayCheck(`sv_${i}`, { status: 'ok', width: 1, height: 1, durationSec: null, at: i });
    expect(getPlayCheck('sv_0')).toBeNull();
    expect(getPlayCheck('sv_4')).toBeNull();
    expect(getPlayCheck('sv_5')).not.toBeNull();
    expect(getPlayCheck('sv_304')).not.toBeNull();
  });
});
