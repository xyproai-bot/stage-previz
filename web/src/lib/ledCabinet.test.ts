import { describe, expect, it } from 'vitest';
import { applyCabinets, cabinetsEqual, DEFAULT_CABINET, gridCells, gridPositions, parseCabinet, resolveCabinet } from './ledCabinet';

describe('LED 箱體網格', () => {
  it('預設一格 128 × 128：1664 × 2304 = 13 × 18 格', () => {
    expect(DEFAULT_CABINET).toEqual({ w: 128, h: 128 });
    expect(gridCells({ w: 1664, h: 2304 }, DEFAULT_CABINET)).toEqual({ cols: 13, rows: 18 });
    expect(gridPositions(1664, 128)).toHaveLength(12);   // 內部 12 條線 = 13 格
    expect(gridPositions(2304, 128)).toHaveLength(17);
    expect(gridPositions(1664, 128)[0]).toBe(128);
  });
  it('自訂 256 × 128：6.5 × 18 格，最後半格照實畫出來', () => {
    expect(gridCells({ w: 1664, h: 2304 }, { w: 256, h: 128 })).toEqual({ cols: 6.5, rows: 18 });
    expect(gridPositions(1664, 256)).toEqual([256, 512, 768, 1024, 1280, 1536]);   // 1536 ~ 1664 是半格
  });
  it('剛好整除時最外緣不再多畫一條', () => {
    expect(gridPositions(256, 128)).toEqual([128]);
    expect(gridPositions(100, 128)).toEqual([]);
  });
  it('版型比例不是 1:1：格線在真實點數裡，換算到版型畫布像素還是一片箱體', () => {
    // 螢幕真實 1664 寬，版型 50% = 832 像素寬：矩陣縮放 0.5，一格 128 點 = 64 版型像素
    const k = 832 / 1664;
    expect(gridPositions(1664, 128).map(x => x * k).slice(0, 3)).toEqual([64, 128, 192]);
    expect(gridCells({ w: 1664, h: 2304 }, { w: 128, h: 128 })).toEqual({ cols: 13, rows: 18 });
  });
  it('沒設定 = 預設；設了就用自己的，其次是版型預設', () => {
    expect(resolveCabinet(undefined)).toEqual({ w: 128, h: 128 });
    expect(resolveCabinet(null, { w: 256, h: 128 })).toEqual({ w: 256, h: 128 });
    expect(resolveCabinet({ w: 128, h: 256 }, { w: 256, h: 128 })).toEqual({ w: 128, h: 256 });
  });
  it('舊資料沒有這欄 = 預設；亂填的擋掉', () => {
    expect(parseCabinet(undefined)).toBeNull();
    expect(parseCabinet(null)).toBeNull();
    expect(parseCabinet({ w: 256, h: 128 })).toEqual({ w: 256, h: 128 });
    expect(parseCabinet({ w: 0, h: 128 })).toBeUndefined();
    expect(parseCabinet({ w: 12.5, h: 128 })).toBeUndefined();
    expect(parseCabinet({ w: 99999, h: 128 })).toBeUndefined();
    expect(parseCabinet('256x128')).toBeUndefined();
    expect(cabinetsEqual(null, undefined)).toBe(true);
    expect(cabinetsEqual({ w: 1, h: 2 }, null)).toBe(false);
  });
  it('版型的設定填進每塊 LED：自己設的 > 版型預設 > 不動', () => {
    const layout = { panels: [{ id: 'o:a~L' }, { id: 'o:a~R' }, { id: 'b' }, { id: 'c' }] };
    expect(applyCabinets(layout, { screens: [{ key: 'o:a~L' }] })).toBe(layout);   // 什麼都沒設 = 原樣
    const out = applyCabinets(layout, { cabinet: { w: 256, h: 128 }, screens: [{ key: 'o:a~L', cabinet: { w: 128, h: 256 } }, { key: 'o:b' }] });
    expect(out.panels.map(p => (p as { cabinet?: unknown }).cabinet)).toEqual([
      { w: 128, h: 256 }, { w: 256, h: 128 }, { w: 256, h: 128 }, { w: 256, h: 128 },
    ]);
    const only = applyCabinets(layout, { screens: [{ key: 'o:b', cabinet: { w: 64, h: 64 } }] });
    expect((only.panels[2] as { cabinet?: unknown }).cabinet).toEqual({ w: 64, h: 64 });   // 舊代號 o:<物件 id>
    expect((only.panels[0] as { cabinet?: unknown }).cabinet).toBeUndefined();
  });
});
