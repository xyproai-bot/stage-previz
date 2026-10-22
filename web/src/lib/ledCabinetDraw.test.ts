import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCabinets } from './ledCabinet';
import { buildLedLayout } from './ledMap';
import { drawTestPattern } from './ledMapDraw';
import { normalizeTemplateInput, parsePlan, type LedTemplatePlan, type ScreenDef } from './ledTemplate';
import { draftFromTemplate, draftToBody, draftToPlan, setItemsCabinet } from './ledTemplateDraft';
import type { LedTemplate } from './ledTemplateApi';
import { drawTemplatePattern } from './ledTemplateDraw';
import { layoutPattern } from './ledTemplatePattern';

const GRID = 'rgba(255,255,255,0.30)';

/** 假的 2D 畫布：記下「用格線顏色畫出來的線」的 x / y 位置（本地座標） */
function recorder() {
  const xs: number[] = [], ys: number[] = [];
  let pending: [number, number, number, number][] = [];
  const state: Record<string, unknown> = { strokeStyle: '' };
  let last: [number, number] = [0, 0];
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k === 'beginPath') return () => { pending = []; };
      if (k === 'moveTo') return (x: number, y: number) => { last = [x, y]; };
      if (k === 'lineTo') return (x: number, y: number) => { pending.push([last[0], last[1], x, y]); };
      if (k === 'stroke') return () => {
        if (t.strokeStyle !== GRID) return;
        for (const [x0, y0, x1, y1] of pending) { if (x0 === x1) xs.push(x0); else if (y0 === y1) ys.push(y0); }
      };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k in t) return t[k];
      return () => undefined;
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, xs, ys };
}

const def = (key: string, w: number, h: number): ScreenDef => ({
  key, objectId: key, name: key, manual: false, uv: null, src: { us: 0, ul: 1, vs: 0, vl: 1 }, nativeW: w, nativeH: h,
});
const plan = (cabinet?: { w: number; h: number }, own?: { w: number; h: number }, dest = { x: 0, y: 0, w: 1664, h: 2304 }): LedTemplatePlan => ({
  v: 1, id: 't', name: 't', canvas: { width: 2000, height: 2400 }, scalePct: 100,
  ...(cabinet ? { cabinet } : {}),
  screens: [{ key: 'o:a', objectId: 'a', uv: null, dest, rotate: 0, flipH: false, flipV: false, ...(own ? { cabinet: own } : {}) }],
});

describe('版型測試圖：網格一格 = 一片 LED 箱體', () => {
  it('預設 128 × 128：1664 × 2304 的螢幕 = 13 × 18 格（內部 12 + 17 條線），從左上角算起', () => {
    const r = recorder();
    const p = plan();
    drawTemplatePattern(r.ctx, p.canvas, layoutPattern(p, [def('o:a', 1664, 2304)]), 1);
    expect(r.xs).toHaveLength(12);
    expect(r.ys).toHaveLength(17);
    expect(r.xs[0]).toBe(128);
    expect(r.xs[11]).toBe(1536);
    expect(r.ys[16]).toBe(2176);
  });
  it('這塊自己設 256 × 128：6.5 × 18 格，最後半格看得出來', () => {
    const r = recorder();
    const p = plan(undefined, { w: 256, h: 128 });
    drawTemplatePattern(r.ctx, p.canvas, layoutPattern(p, [def('o:a', 1664, 2304)]), 1);
    expect(r.xs).toEqual([256, 512, 768, 1024, 1280, 1536]);   // 1536 到 1664 = 半格
    expect(r.ys).toHaveLength(17);
  });
  it('版型預設箱體：沒自己設的螢幕用它', () => {
    const r = recorder();
    const p = plan({ w: 256, h: 128 });
    drawTemplatePattern(r.ctx, p.canvas, layoutPattern(p, [def('o:a', 1664, 2304)]), 1);
    expect(r.xs).toHaveLength(6);
  });
  it('版型畫布 50%：格線還是在真實點數裡（13 × 18 格），矩陣再縮成一半', () => {
    const r = recorder();
    const p = plan(undefined, undefined, { x: 100, y: 50, w: 832, h: 1152 });
    const items = layoutPattern(p, [def('o:a', 1664, 2304)]);
    expect(items[0].matrix[0]).toBeCloseTo(0.5);   // 本地 128 點 = 版型 64 像素 = 一片箱體
    drawTemplatePattern(r.ctx, p.canvas, items, 1);
    expect(r.xs).toHaveLength(12);
    expect(r.xs[0]).toBe(128);
    expect(r.ys).toHaveLength(17);
  });
  it('整張畫布的測試圖（drawTestPattern）同樣一格一片箱體，從這塊 LED 的左上角開始，不是畫布原點', () => {
    vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} closePath() {} rect() {} });
    const canvas = { width: 3000, height: 2400 };
    // 一塊 LED：x 從 200 開始、1664 × 2304
    const tris = [200 / 3000, 0, 1864 / 3000, 0, 1864 / 3000, 2304 / 2400, 200 / 3000, 0, 1864 / 3000, 2304 / 2400, 200 / 3000, 2304 / 2400];
    const layout = buildLedLayout([{ id: 'o:a', name: 'A', tris }], canvas);
    const run = (lay: typeof layout) => {
      const r = recorder();
      drawTestPattern(r.ctx, lay, 1);
      return r;
    };
    const def128 = run(layout);
    expect(def128.xs).toHaveLength(12);
    expect(def128.xs[0]).toBe(200 + 128);
    expect(def128.ys).toHaveLength(17);
    const wide = run(applyCabinets(layout, { screens: [{ key: 'o:a', cabinet: { w: 256, h: 128 } }] }));
    expect(wide.xs).toEqual([456, 712, 968, 1224, 1480, 1736]);
  });
});

describe('箱體設定的存法：只新增欄位，舊資料沒有 = 預設', () => {
  const base = { v: 1, id: 't', name: '版型', canvas: { width: 100, height: 100 }, scalePct: 100, screens: [{ key: 'o:a', objectId: 'a', dest: { x: 0, y: 0, w: 10, h: 10 } }] };
  it('舊資料沒有這欄：解出來沒有 cabinet，畫出來是 128 × 128', () => {
    const p = parsePlan(base)!;
    expect(p.cabinet).toBeUndefined();
    expect(p.screens[0].cabinet).toBeUndefined();
    expect(layoutPattern(p, [def('o:a', 1664, 2304)])[0].cabinet).toEqual({ w: 128, h: 128 });
  });
  it('有設的會留著；亂填的丟掉（當沒設）', () => {
    const p = parsePlan({ ...base, cabinet: { w: 256, h: 128 }, screens: [{ ...base.screens[0], cabinet: { w: 128, h: 256 } }] })!;
    expect(p.cabinet).toEqual({ w: 256, h: 128 });
    expect(p.screens[0].cabinet).toEqual({ w: 128, h: 256 });
    const bad = parsePlan({ ...base, cabinet: { w: -5, h: 'x' } })!;
    expect(bad.cabinet).toBeUndefined();
  });
  it('存檔內容檢查：接受合法的、擋掉亂填的、不填 = 沒這欄', () => {
    const screens = [{ key: 'o:a', dest: { x: 0, y: 0, w: 10, h: 10 }, rotate: 0, flipH: false, flipV: false }];
    const body = { name: 'x', canvas: { width: 100, height: 100 }, scalePct: 100, screens };
    const ok = normalizeTemplateInput({ ...body, cabinet: { w: 256, h: 128 }, screens: [{ ...screens[0], cabinet: { w: 128, h: 256 } }] }, { partial: false });
    expect(ok.ok && ok.value.cabinet).toEqual({ w: 256, h: 128 });
    expect(ok.ok && ok.value.screens?.[0].cabinet).toEqual({ w: 128, h: 256 });
    const none = normalizeTemplateInput(body, { partial: false });
    expect(none.ok && 'cabinet' in none.value).toBe(false);
    expect(normalizeTemplateInput({ ...body, cabinet: { w: 3, h: 128 } }, { partial: false }).ok).toBe(false);
    expect(normalizeTemplateInput({ ...body, screens: [{ ...screens[0], cabinet: 'big' }] }, { partial: false }).ok).toBe(false);
    const clear = normalizeTemplateInput({ cabinet: null }, { partial: true });
    expect(clear.ok && clear.value.cabinet).toBeNull();
  });
  it('草稿：一次設好幾塊 = 一個新草稿；設回 null 就是回到版型預設；存檔帶得出去', () => {
    const tpl = { ...parsePlan({ ...base, screens: [base.screens[0], { key: 'o:b', objectId: 'b', dest: { x: 0, y: 0, w: 10, h: 10 } }] })!, id: 't', kind: 'custom', sortOrder: 0, songCount: 0 } as LedTemplate;
    const d0 = draftFromTemplate(tpl);
    const d1 = setItemsCabinet(d0, ['o:a', 'o:b'], { w: 256, h: 128 });
    expect(d1).not.toBe(d0);
    expect(d1.items.every(i => i.cabinet?.w === 256)).toBe(true);
    expect(setItemsCabinet(d1, ['o:a'], { w: 256, h: 128 })).toBe(d1);   // 沒變 = 同一個草稿
    const d2 = setItemsCabinet(d1, ['o:a'], null);
    expect(d2.items[0].cabinet).toBeUndefined();
    expect(d2.items[1].cabinet).toEqual({ w: 256, h: 128 });
    const body = draftToBody({ ...d2, cabinet: { w: 128, h: 256 } }, new Set(['o:a', 'o:b']));
    expect(body.cabinet).toEqual({ w: 128, h: 256 });
    expect(body.screens[1].cabinet).toEqual({ w: 256, h: 128 });
    expect(draftToBody(d0, new Set(['o:a'])).cabinet).toBeNull();
    expect(draftToPlan({ ...d2, cabinet: { w: 128, h: 256 } }, []).cabinet).toEqual({ w: 128, h: 256 });
  });
});

afterEach(() => { vi.unstubAllGlobals(); });
