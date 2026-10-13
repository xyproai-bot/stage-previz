import { describe, it, expect } from 'vitest';
import { readRealSpeedPref, writeRealSpeedPref, REAL_SPEED_PREF_KEY } from './useMechanisms';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}

describe('「照機器速度播放」記在這台電腦', () => {
  it('預設關；開了記住、關了拿掉', () => {
    const s = memoryStorage();
    expect(readRealSpeedPref(s)).toBe(false);
    writeRealSpeedPref(s, true);
    expect(s.map.get(REAL_SPEED_PREF_KEY)).toBe('1');
    expect(readRealSpeedPref(s)).toBe(true);
    writeRealSpeedPref(s, false);
    expect(s.map.has(REAL_SPEED_PREF_KEY)).toBe(false);
    expect(readRealSpeedPref(s)).toBe(false);
  });
  it('不能存（無痕模式 / 擋掉）→ 當作關，不會壞', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(readRealSpeedPref(broken)).toBe(false);
    expect(() => writeRealSpeedPref(broken, true)).not.toThrow();
    expect(readRealSpeedPref(null)).toBe(false);
  });
});
