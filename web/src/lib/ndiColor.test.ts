import { describe, expect, it, vi } from 'vitest';
import {
  AE_RAW_MEASURED, DEFAULT_AE_RAW_LUT, GREY_PATCHES, NDI_COLOR_STORAGE_KEY,
  applyColorLut, clearCalibration, curveError, fitCurve, identityLut, isIdentityLut, linearRawCorrection,
  loadCalibration, pickNdiColorCurve, saveCalibration, subscribeCalibration,
  type CurveSample, type NdiColorCalibration,
} from './ndiColor';

/** owner 量的：灰階色卡經過 0.1.12 小程序（16–235 拉伸）後截圖看到的值 */
const OWNER_SCREENSHOT: [number, number][] = [
  [0, 0], [8, 7], [16, 15], [24, 23], [32, 32], [48, 50], [64, 65], [128, 140], [192, 207],
  [216, 235], [228, 247], [235, 255], [242, 255], [250, 255], [255, 255],
];

/** 0.1.12 小程序的拉伸（一模一樣的整數算法） */
const oldStretch = (b: number) => Math.min(255, Math.floor((Math.min(219, Math.max(0, b - 16)) * 255 + 110) / 219));

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}

describe('預設曲線（量到的那條反過來算）', () => {
  it('倒推的原始值經過舊的拉伸 = owner 截圖看到的值（±1，截圖和 JPEG 的誤差）', () => {
    for (const s of AE_RAW_MEASURED) {
      const shot = OWNER_SCREENSHOT.find(([v]) => v === s.input);
      if (!shot || s.input === 255) continue;
      expect(Math.abs(oldStretch(Math.round(s.measured)) - shot[1]), `patch ${s.input}`).toBeLessThanOrEqual(1);
    }
  });

  it('量到的資料套預設曲線 → 每格都在原值 ±3 以內', () => {
    for (const s of AE_RAW_MEASURED) {
      const got = DEFAULT_AE_RAW_LUT[Math.round(s.measured)];
      expect(Math.abs(got - s.input), `patch ${s.input} → ${got}`).toBeLessThanOrEqual(3);
    }
    expect(curveError(DEFAULT_AE_RAW_LUT, AE_RAW_MEASURED).max).toBeLessThanOrEqual(1);
  });

  it('黑還是黑、白還是白；16 以下全部是黑；只會往上', () => {
    expect(DEFAULT_AE_RAW_LUT[16]).toBe(0);
    expect(DEFAULT_AE_RAW_LUT[0]).toBe(0);
    expect(DEFAULT_AE_RAW_LUT[255]).toBe(255);
    for (let i = 1; i < 256; i++) expect(DEFAULT_AE_RAW_LUT[i]).toBeGreaterThanOrEqual(DEFAULT_AE_RAW_LUT[i - 1]);
    // 以前硬拉會把 235 以上全部截成 255、128 變 140；現在 128 還是 128
    expect(DEFAULT_AE_RAW_LUT[136]).toBe(128);
    expect(DEFAULT_AE_RAW_LUT[228]).toBe(228);
  });

  it('直線近似 (b − 16)·255/239 在 64 那格差 4 階（所以預設用量到的曲線）', () => {
    const at64 = AE_RAW_MEASURED.find(s => s.input === 64)!;
    expect(Math.abs(linearRawCorrection(at64.measured) - 64)).toBeGreaterThan(3);
    expect(linearRawCorrection(16)).toBe(0);
    expect(linearRawCorrection(255)).toBe(255);
  });
});

describe('fitCurve：從量測點擬合', () => {
  /** 一條假的「收到的值」：黑抬到 16、中間有點彎 */
  const chain = (v: number) => 16 + 239 * Math.pow(v / 255, 1.08);

  it('有雜訊的量測（每格三次、±1.5 階）→ 每一格都校回 ±3 以內、曲線只會往上', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const samples: CurveSample[] = [];
    for (const v of GREY_PATCHES) for (let k = 0; k < 3; k++) samples.push({ input: v, measured: chain(v) + (rand() - 0.5) * 3 });
    const lut = fitCurve(samples)!;
    expect(lut).not.toBeNull();
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    for (const v of GREY_PATCHES) expect(Math.abs(lut[Math.round(chain(v))] - v), `patch ${v}`).toBeLessThanOrEqual(3);
    // 色卡中間的值也差不多（內插）
    for (const v of [40, 100, 160, 200]) expect(Math.abs(lut[Math.round(chain(v))] - v), `value ${v}`).toBeLessThanOrEqual(4);
  });

  it('倒退的量測（雜訊）→ 合併取平均，還是只會往上', () => {
    const lut = fitCurve([
      { input: 0, measured: 10 }, { input: 64, measured: 80 }, { input: 96, measured: 78 }, { input: 255, measured: 250 },
    ])!;
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    expect(lut[79]).toBeGreaterThanOrEqual(70);
    expect(lut[79]).toBeLessThanOrEqual(90);
  });

  it('白被截掉（好幾格都收到 255）→ 255 還是 255；黑被截掉 → 0 還是 0', () => {
    const lut = fitCurve([
      { input: 0, measured: 0 }, { input: 8, measured: 0 }, { input: 128, measured: 140 },
      { input: 235, measured: 255 }, { input: 242, measured: 255 }, { input: 255, measured: 255 },
    ])!;
    expect(lut[255]).toBe(255);
    expect(lut[0]).toBe(0);
  });

  it('量測點不夠 → null', () => {
    expect(fitCurve([])).toBeNull();
    expect(fitCurve([{ input: 0, measured: 10 }])).toBeNull();
    expect(fitCurve([{ input: 0, measured: 10 }, { input: 255, measured: 10.2 }])).toBeNull();
  });

  it('本來就對的（收到 = 原值）→ 幾乎不變', () => {
    const lut = fitCurve(GREY_PATCHES.map(v => ({ input: v, measured: v })))!;
    for (let i = 0; i < 256; i++) expect(Math.abs(lut[i] - i)).toBeLessThanOrEqual(1);
    expect(isIdentityLut(identityLut())).toBe(true);
  });
});

describe('要用哪條曲線（新舊小程序都要對）', () => {
  const cal = (over: Partial<NdiColorCalibration> = {}): NdiColorCalibration => ({
    version: 1, createdAt: '2026-10-14T08:00:00.000Z', pipeline: 'raw', afterEffects: true, source: 'ME (Adobe After Effects)',
    r: Array.from({ length: 256 }, (_, i) => Math.min(255, i + 1)), g: Array.from({ length: 256 }, (_, i) => i), b: Array.from({ length: 256 }, (_, i) => i),
    before: { max: 18, mean: 7 }, after: { max: 1, mean: 0.4 }, ...over,
  });

  it('舊版小程序（沒有 colorPipeline）→ 照以前，不另外校正', () => {
    const c = pickNdiColorCurve(null, true, cal());
    expect(c.kind).toBe('none');
    expect(isIdentityLut(c.lut.r)).toBe(true);
  });

  it('小程序設定成 limited_to_full → 不另外校正', () => {
    expect(pickNdiColorCurve('limited_to_full', true, null).kind).toBe('none');
  });

  it('新版（raw）+ AE → 預設曲線；不是 AE 的來源 → 不校正', () => {
    const c = pickNdiColorCurve('raw', true, null);
    expect(c.kind).toBe('default');
    expect(applyColorLut(c.lut, 16, 136, 255)).toEqual([0, 128, 255]);
    expect(pickNdiColorCurve('raw', false, null).kind).toBe('none');
  });

  it('這台電腦校正過 → 用校正的（同一種來源才用）', () => {
    expect(pickNdiColorCurve('raw', true, cal()).kind).toBe('calibrated');
    expect(pickNdiColorCurve('raw', true, cal()).lut.r[10]).toBe(11);
    expect(pickNdiColorCurve('raw', true, cal({ afterEffects: false })).kind).toBe('default');
    expect(pickNdiColorCurve('raw', false, cal({ afterEffects: false })).kind).toBe('calibrated');
  });
});

describe('存在這台電腦（localStorage）', () => {
  const sample: NdiColorCalibration = {
    version: 1, createdAt: '2026-10-14T08:00:00.000Z', pipeline: 'raw', afterEffects: true, source: null,
    r: Array.from(DEFAULT_AE_RAW_LUT), g: Array.from(DEFAULT_AE_RAW_LUT), b: Array.from(DEFAULT_AE_RAW_LUT),
    before: { max: 4, mean: 1.2 }, after: { max: 1, mean: 0.3 },
  };

  it('存了讀得回來；回到預設 = 清掉；存 / 清都會通知', () => {
    const s = memoryStorage();
    const fn = vi.fn();
    const off = subscribeCalibration(fn);
    expect(saveCalibration(sample, s)).toBe(true);
    expect(loadCalibration(s)).toEqual(sample);
    clearCalibration(s);
    expect(loadCalibration(s)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it('壞掉的資料 / 瀏覽器不准 → 當成沒有', () => {
    const s = memoryStorage();
    s.map.set(NDI_COLOR_STORAGE_KEY, '{not json');
    expect(loadCalibration(s)).toBeNull();
    s.map.set(NDI_COLOR_STORAGE_KEY, JSON.stringify({ ...sample, r: [1, 2, 3] }));
    expect(loadCalibration(s)).toBeNull();
    s.map.set(NDI_COLOR_STORAGE_KEY, JSON.stringify({ ...sample, version: 2 }));
    expect(loadCalibration(s)).toBeNull();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(loadCalibration(broken)).toBeNull();
    expect(saveCalibration(sample, broken)).toBe(false);
    expect(() => clearCalibration(broken)).not.toThrow();
    expect(loadCalibration(null)).toBeNull();
  });
});
