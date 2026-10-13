import { describe, it, expect } from 'vitest';
import { DEFAULT_LOOK_SETTINGS, LOOK_SETTING_RANGES, normalizeLookSettings } from './lookSettings';

describe('normalizeLookSettings', () => {
  it('沒有資料時回傳預設值', () => {
    expect(normalizeLookSettings(undefined)).toEqual(DEFAULT_LOOK_SETTINGS);
    expect(normalizeLookSettings(null)).toEqual(DEFAULT_LOOK_SETTINGS);
    expect(normalizeLookSettings('壞資料')).toEqual(DEFAULT_LOOK_SETTINGS);
  });

  it('只蓋掉有給的欄位', () => {
    const s = normalizeLookSettings({ exposure: 1.5 });
    expect(s.exposure).toBe(1.5);
    expect(s.houseLight).toBe(DEFAULT_LOOK_SETTINGS.houseLight);
  });

  it('超出範圍會夾回範圍內', () => {
    const s = normalizeLookSettings({ houseLight: 9, exposure: -1, ledLightStrength: 99 });
    expect(s.houseLight).toBe(LOOK_SETTING_RANGES.houseLight[1]);
    expect(s.exposure).toBe(LOOK_SETTING_RANGES.exposure[0]);
    expect(s.ledLightStrength).toBe(LOOK_SETTING_RANGES.ledLightStrength[1]);
  });

  it('非數字的欄位用預設值', () => {
    const s = normalizeLookSettings({ bloomStrength: 'abc', ledViewFalloff: NaN });
    expect(s.bloomStrength).toBe(DEFAULT_LOOK_SETTINGS.bloomStrength);
    expect(s.ledViewFalloff).toBe(DEFAULT_LOOK_SETTINGS.ledViewFalloff);
  });

  it('數字字串也收', () => {
    expect(normalizeLookSettings({ exposure: '2' }).exposure).toBe(2);
  });
});
