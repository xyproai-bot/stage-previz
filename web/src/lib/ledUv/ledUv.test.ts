// 自動貼 UV 的純函式：平面判斷與方向、點數換算、照舞台排版、排好位置 → UV（像素要對準）、舊版面
import { describe, expect, it } from 'vitest';
import { buildLedLayout } from '../ledMap';
import { applyLocalTransform, localTransform, mapUvToTemplate, nativeSize, spanFromUv, uvToLocal, ROTATIONS, type Placement, type Rotation } from '../ledTemplate';
import { analyzeObject, assignVertices, stageFrontOf, audienceRight, type ObjectGeom } from './surfaces';
import { describeObject, bestOrientation } from './objectInfo';
import { resolveSize } from './size';
import { layoutProblems, packStageShaped, type PackItem } from './pack';
import { canvasPoint, flatUvForPrim } from './place';
import { buildLegacy, buildPlan, objectUvs, pieceScreensOf, type PlanObjectIn } from './plan';
import { uvRegion } from './region';
import { arcPrim, gridPrim, mirroredX, moved, slabPrim, wavePrim } from './testing';
import { UNSUPPORTED_TEXT } from './text';
import { dot, type Vec3 } from './geometry';

const FRONT: Vec3 = [0, 0, 1];
const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const CANVAS = { width: 8800, height: 2024 };

const obj = (...prims: ObjectGeom['prims']): ObjectGeom => ({ prims });

describe('stageFrontOf', () => {
  it('LED 朝哪邊，舞台正面就朝哪邊；鏡像過的節點不會反', () => {
    expect(stageFrontOf([obj(gridPrim([-5, 0, 0], X, Y, 10, 4))])).toEqual([0, 0, 1]);
    const f = stageFrontOf([obj(moved(gridPrim([-5, 0, 0], X, Y, 10, 4), Y, 90, [0, 0, 0]))]);
    expect(f[0]).toBeCloseTo(1, 6);
    expect(stageFrontOf([obj(mirroredX(gridPrim([-5, 0, 0], X, Y, 10, 4)))])[2]).toBeCloseTo(1, 6);
    expect(stageFrontOf([])).toEqual([0, 0, 1]);
  });
});

describe('analyzeObject：平面與座標方向', () => {
  it('牆：朝觀眾的 LED，右邊是 +X、上方是世界朝上；量到的寬高對', () => {
    const a = analyzeObject(obj(gridPrim([-6, 1, 0], X, Y, 12, 4)), FRONT);
    expect(a.kind).toBe('ok');
    expect(a.pieces).toHaveLength(1);
    const p = a.pieces[0];
    expect(p.widthU).toBeCloseTo(12, 6);
    expect(p.heightU).toBeCloseTo(4, 6);
    expect(p.frame.right[0]).toBeCloseTo(1, 6);
    expect(p.frame.down[1]).toBeCloseTo(-1, 6);
    expect(p.facing).toBeCloseTo(1, 6);
  });

  it('向後傾的牆：上方是世界朝上投影到平面（沿著斜面往上），不是任意方向', () => {
    const tilt = moved(gridPrim([-6, 0, 0], X, Y, 12, 4), X, -20, [0, 1, 0]);
    const a = analyzeObject(obj(tilt), FRONT);
    expect(a.kind).toBe('ok');
    const down = a.pieces[0].frame.down;
    expect(down[1]).toBeLessThan(-0.9);
    expect(Math.abs(dot(down, a.pieces[0].frame.right))).toBeLessThan(1e-9);
    // 寬度不變，高度 = 斜邊
    expect(a.pieces[0].heightU).toBeCloseTo(4, 6);
  });

  it('繞 Y 轉 90 度的牆（舞台側邊）：還是上方朝上；右邊跟著轉', () => {
    const side = moved(gridPrim([-3, 0, 0], X, Y, 6, 3), Y, 90, [0, 0, 0]);
    const f = stageFrontOf([obj(side)]);
    const a = analyzeObject(obj(side), f);
    expect(a.kind).toBe('ok');
    expect(a.pieces[0].frame.down[1]).toBeCloseTo(-1, 6);
    // 螢幕本來的 +X 邊現在朝 -Z；站在法線（+X）那一側看，右邊 = 上 × 法線
    expect(a.pieces[0].frame.right[2]).toBeCloseTo(-1, 6);
  });

  it('地屏（朝上躺著）：畫面上方 = 舞台後方；右邊 = 觀眾席看過去的右邊', () => {
    // 躺在 y=0，法線 +Y：用 Z 軸和 X 軸排出 +Y 法線 → ax = Z? Z × X = +Y
    const floor = gridPrim([-5, 0, -4], Z, X, 8, 10);
    const a = analyzeObject(obj(floor), FRONT);
    expect(a.kind).toBe('ok');
    const f = a.pieces[0].frame;
    expect(f.normal[1]).toBeCloseTo(1, 6);
    // 上方 = 舞台後方 = -Z → down = +Z
    expect(f.down[2]).toBeCloseTo(1, 6);
    // 右邊 = +X（觀眾席面向 -Z，右手邊是 +X）
    expect(f.right[0]).toBeCloseTo(1, 6);
    expect(audienceRight(FRONT)[0]).toBeCloseTo(1, 6);
  });

  it('鏡像過的節點（負的縮放）：用繞向乘回正負，座標方向跟沒鏡像時一樣', () => {
    const m = analyzeObject(obj(mirroredX(gridPrim([-6, 0, 0], X, Y, 12, 4))), FRONT);
    expect(m.kind).toBe('ok');
    expect(m.pieces[0].frame.normal[2]).toBeCloseTo(1, 6);
    // 鏡像以後世界裡的 x 反過來，但從 +Z 看過去，畫面右邊還是 +X
    expect(m.pieces[0].frame.right[0]).toBeCloseTo(1, 6);
  });

  it('有厚度的板子：取朝觀眾的那一面，側邊和背面不會變成別片', () => {
    const a = analyzeObject(obj(slabPrim([0, 2, 0], X, Y, 8, 4, 0.2)), FRONT);
    expect(a.kind).toBe('ok');
    expect(a.pieces).toHaveLength(1);
    expect(a.pieces[0].facing).toBeGreaterThan(0.99);
    expect(a.pieces[0].widthU).toBeCloseTo(8, 6);
    // 背對觀眾的板子：兩面一樣大，取朝觀眾那面（法線朝 +Z 的那面）
    const flipped = analyzeObject(obj(moved(slabPrim([0, 2, 0], X, Y, 8, 4, 0.2), Y, 180, [0, 0, 0])), FRONT);
    expect(flipped.kind).toBe('ok');
    expect(flipped.pieces[0].facing).toBeGreaterThan(0.99);
  });

  it('有一點雜訊的平面還是平面；圓柱的弧面第 2 階段支援；波浪、折角不支援，說明白', () => {
    const noisy = gridPrim([-6, 0, 0], X, Y, 12, 4, 12);
    for (let i = 2; i < noisy.pos.length; i += 3) noisy.pos[i] += (((i * 7919) % 13) / 13 - 0.5) * 0.004;
    expect(analyzeObject(obj(noisy), FRONT).kind).toBe('ok');
    const arc = analyzeObject(obj(arcPrim(5, 180, 3)), FRONT);
    expect(arc.kind).toBe('ok');
    expect(arc.pieces[0].kind).toBe('arc');
    const wave = analyzeObject(obj(wavePrim(14, 3, 0.8, 2)), FRONT);
    expect(wave.kind).toBe('unsupported');
    expect(wave.unsupported).toBe('arc');
    expect(UNSUPPORTED_TEXT.arc).toContain('不是標準的圓柱');
    const fold = analyzeObject(obj(
      gridPrim([-6, 0, 0], X, Y, 6, 3),
      gridPrim([0, 0, 0], normalizeV([1, 0, -0.6]), Y, 6, 3),
    ), FRONT);
    expect(fold.kind).toBe('unsupported');
    expect(fold.unsupported).toBe('fold');
  });

  it('分開的幾片：各自是一片，由左到右排；碎片（螺絲）不算一片；超過 8 片不處理', () => {
    const two = analyzeObject(obj(gridPrim([2, 0, 0], X, Y, 4, 3), gridPrim([-8, 0, 0], X, Y, 4, 3)), FRONT);
    expect(two.pieces).toHaveLength(2);
    expect(two.pieces[0].center[0]).toBeLessThan(two.pieces[1].center[0]);
    const withBolt = analyzeObject(obj(gridPrim([-6, 0, 0], X, Y, 12, 4), gridPrim([8, 0, 0], X, Y, 0.1, 0.1, 1)), FRONT);
    expect(withBolt.pieces).toHaveLength(1);
    const nine = analyzeObject(obj(...Array.from({ length: 9 }, (_, i) => gridPrim([i * 5, 0, 0], X, Y, 4, 3))), FRONT);
    expect(nine.kind).toBe('unsupported');
    expect(nine.unsupported).toBe('toomany');
  });

  it('外框 primitive（不是螢幕）不算一片，只有材質是 LED 的才是螢幕', () => {
    const led = gridPrim([-6, 0, 0], X, Y, 12, 4);
    const frame = gridPrim([-6.5, -0.5, 0.05], X, Y, 13, 5, 2, { screen: false });
    const a = analyzeObject(obj(led, frame), FRONT);
    expect(a.pieces).toHaveLength(1);
    expect(a.pieces[0].widthU).toBeCloseTo(12, 6);
  });
});

function normalizeV(v: Vec3): Vec3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

describe('resolveSize：三種輸入', () => {
  const measured = { w: 12, h: 4 };
  it('點距：P3.9 → 12 m / 3.9 mm', () => {
    const r = resolveSize({ mode: 'pitch', pitchMm: 3.9 }, measured);
    expect(r).toMatchObject({ ok: true, w: 3077, h: 1026 });
    expect(r.line).toBe('P3.9 → 3077 × 1026 點（12.00 × 4.00 m）');
  });
  it('總點數：照填的，量到多大都不管', () => {
    const r = resolveSize({ mode: 'pixels', pixels: { w: 3072, h: 1024 } }, measured);
    expect(r).toMatchObject({ ok: true, w: 3072, h: 1024 });
    expect(resolveSize({ mode: 'pixels', pixels: { w: 3072, h: 1024 } }, { w: 99, h: 0.1 }).warnings.length).toBeGreaterThan(0);
  });
  it('箱體：每箱 128×128 點、500×500 mm，量到 12×4 m → 24×8 箱，一定是整數箱', () => {
    const c = resolveSize({ mode: 'cabinets', cabinet: { mmW: 500, mmH: 500, pxW: 128, pxH: 128 } }, measured);
    expect(c).toMatchObject({ ok: true, w: 24 * 128, h: 8 * 128 });
    const fixed = resolveSize({ mode: 'cabinets', cabinet: { mmW: 500, mmH: 500, pxW: 128, pxH: 128, cols: 6, rows: 2 } }, measured);
    expect(fixed).toMatchObject({ ok: true, w: 768, h: 256 });
    expect(fixed.warnings.some(w => w.includes('6 × 2'))).toBe(true);
  });
  it('四捨五入、最小 1、壞值、太大都有說法', () => {
    expect(resolveSize({ mode: 'pitch', pitchMm: 3.9 }, { w: 0.0001, h: 0.0001 })).toMatchObject({ ok: true, w: 1, h: 1 });
    expect(resolveSize({ mode: 'pitch', pitchMm: 0 }, measured).ok).toBe(false);
    expect(resolveSize({ mode: 'pixels', pixels: { w: 0, h: 5 } }, measured).ok).toBe(false);
    expect(resolveSize({ mode: 'pixels', pixels: { w: 40000, h: 5 } }, measured).error).toMatch(/32768/);
    expect(resolveSize({ mode: 'pitch', pitchMm: 3.9 }, { w: 0, h: 4 }).ok).toBe(false);
  });
});

function item(key: string, w: number, h: number, x: number, y: number, extra: Partial<PackItem> = {}): PackItem {
  return { key, name: key, w, h, x, y, d: 0, yRange: [y - 1, y + 1], dRange: [0, 0], floor: false, ...extra };
}

describe('packStageShaped：照舞台的樣子排', () => {
  it('左邊的在左、上面的在上、同一排置中；不重疊、不超出畫布', () => {
    const items = [
      item('右', 200, 100, 5, 5), item('左', 200, 100, -5, 5), item('中', 300, 100, 0, 5),
      item('上', 400, 60, 0, 12, { yRange: [11, 13] }),
      item('下', 500, 80, 0, 0, { yRange: [-1, 1] }),
    ];
    const r = packStageShaped(items);
    const p = (k: string) => r.placed.get(k)!;
    expect(p('左').x).toBeLessThan(p('中').x);
    expect(p('中').x).toBeLessThan(p('右').x);
    expect(p('上').y).toBeLessThan(p('左').y);
    expect(p('左').y).toBeLessThan(p('下').y);
    expect(layoutProblems(r)).toEqual([]);
    expect(r.canvas.width % 8).toBe(0);
    expect(r.canvas.height % 8).toBe(0);
    expect(r.rows).toBe(3);
  });

  it('地屏排在牆的下面，離觀眾越遠越上面', () => {
    const items = [
      item('牆', 400, 200, 0, 5, { yRange: [3, 7] }),
      item('近地屏', 300, 80, 0, 0, { floor: true, d: 8, dRange: [7, 9], yRange: [0, 0] }),
      item('遠地屏', 300, 80, 0, 0, { floor: true, d: -2, dRange: [-3, -1], yRange: [0, 0] }),
    ];
    const r = packStageShaped(items);
    const y = (k: string) => r.placed.get(k)!.y;
    expect(y('牆')).toBeLessThan(y('遠地屏'));
    expect(y('遠地屏')).toBeLessThan(y('近地屏'));
  });

  it('同樣的輸入永遠一樣的結果（跟輸入順序無關）；間隔和進位', () => {
    const a = [item('a', 100, 50, -1, 1), item('b', 100, 50, 1, 1), item('c', 100, 50, 0, 5, { yRange: [4, 6] })];
    const r1 = packStageShaped(a, { gutter: 4, roundTo: 16 });
    const r2 = packStageShaped([...a].reverse(), { gutter: 4, roundTo: 16 });
    expect([...r1.placed.entries()]).toEqual([...r2.placed.entries()].sort((x, y) => [...r1.placed.keys()].indexOf(x[0]) - [...r1.placed.keys()].indexOf(y[0])));
    expect(r1.canvas.width % 16).toBe(0);
    expect(r1.placed.get('b')!.x - (r1.placed.get('a')!.x + 100)).toBe(4);
    expect(packStageShaped([]).canvas).toEqual({ width: 0, height: 0 });
  });

  it('隨機大小與位置：永遠不重疊、不超出畫布', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let round = 0; round < 40; round++) {
      const items: PackItem[] = [];
      for (let i = 0; i < 1 + Math.floor(rnd() * 14); i++) {
        const y = rnd() * 10;
        items.push(item('i' + i, 1 + Math.floor(rnd() * 500), 1 + Math.floor(rnd() * 300), rnd() * 20 - 10, y, { yRange: [y - rnd(), y + rnd()], floor: rnd() < 0.2, d: rnd() * 10, dRange: [0, 1] }));
      }
      const r = packStageShaped(items, { gutter: Math.floor(rnd() * 5) });
      expect(layoutProblems(r)).toEqual([]);
    }
  });
});

describe('排好位置 → UV：像素要對準', () => {
  const geom = obj(gridPrim([-6, 1, 0], X, Y, 12, 4, 6));
  const info = describeObject(geom, FRONT, CANVAS);
  const placed = { x: 1000, y: 300, w: 3077, h: 1026, rotate: 0 as Rotation, flipH: false, flipV: false };

  it('四個角剛好落在整數像素；所有頂點都在長方形裡；左上角 = 世界裡的左上角', () => {
    const r = flatUvForPrim(geom.prims[0], info.pieces, () => placed, CANVAS);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let v = 0; v < r.uv.length; v += 2) {
      const px = r.uv[v] * CANVAS.width, py = r.uv[v + 1] * CANVAS.height;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    expect(minX).toBeCloseTo(1000, 2);
    expect(maxX).toBeCloseTo(1000 + 3077, 2);
    expect(minY).toBeCloseTo(300, 2);
    expect(maxY).toBeCloseTo(300 + 1026, 2);
    // 世界左上角 (x=-6, y=5) → 畫布左上角
    const p = geom.prims[0];
    const topLeft = [...Array(p.pos.length / 3).keys()].find(i => Math.abs(p.pos[i * 3] + 6) < 1e-9 && Math.abs(p.pos[i * 3 + 1] - 5) < 1e-9)!;
    expect(r.uv[topLeft * 2] * CANVAS.width).toBeCloseTo(1000, 2);
    expect(r.uv[topLeft * 2 + 1] * CANVAS.height).toBeCloseTo(300, 2);
    expect(r.clamped).toBe(0);
  });

  it('用 ledMap 的對位圖算法量回來：外框就是排好的長方形（整數）', () => {
    const r = flatUvForPrim(geom.prims[0], info.pieces, () => placed, CANVAS);
    const tris: number[] = [];
    const idx = geom.prims[0].index;
    for (let t = 0; t < idx.length; t++) tris.push(r.uv[idx[t] * 2], r.uv[idx[t] * 2 + 1]);
    const layout = buildLedLayout([{ id: 'a', name: 'a', tris }], CANVAS);
    expect(layout.panels[0].rect).toEqual({ x: 1000, y: 300, w: 3077, h: 1026 });
    expect(layout.panels[0].wrapsX).toBe(false);
    expect(layout.panels[0].coverage).toBeGreaterThan(0.999);
  });

  const BIG = { width: 8800, height: 8000 };
  it('8 種方向：UV 跟版型的 mapUvToTemplate 互為反運算（螢幕的每個點回得來）', () => {
    for (const rotate of ROTATIONS) {
      for (const flipH of [false, true]) {
        for (const flipV of [false, true]) {
          const w = rotate === 90 || rotate === 270 ? 1026 : 3077, h = rotate === 90 || rotate === 270 ? 3077 : 1026;
          const pl = { x: 500, y: 200, w, h, rotate, flipH, flipV };
          const r = flatUvForPrim(geom.prims[0], info.pieces, () => pl, BIG);
          // 把新 UV 當成「整張畫布 UV」，經過一個「畫布 = 同樣大小、放在原位」的版型，要回到螢幕本地座標
          const span = spanFromUv([pl.x / BIG.width, pl.y / BIG.height, (pl.x + pl.w) / BIG.width, (pl.y + pl.h) / BIG.height]);
          const a = assignVertices(geom.prims[0], info.pieces);
          const t = localTransform(rotate, flipH, flipV);
          for (let v = 0; v < a.lx.length; v += 3) {
            const loc = uvToLocal(span, r.uv[v * 2], r.uv[v * 2 + 1])!;
            const [ex, ey] = applyLocalTransform(t, a.lx[v], a.ly[v]);
            expect(loc[0]).toBeCloseTo(ex, 5);
            expect(loc[1]).toBeCloseTo(ey, 5);
          }
          // canvasPoint 和 UV 一致
          const [px, py] = canvasPoint(pl, a.lx[0], a.ly[0]);
          expect(r.uv[0] * BIG.width).toBeCloseTo(px, 3);
          expect(r.uv[1] * BIG.height).toBeCloseTo(py, 3);
        }
      }
    }
  });

  it('一個 LED 點 ↔ 一個畫布像素：沿螢幕每隔一個點走，畫布上剛好每隔一個像素（沒有跳過、重複）', () => {
    // 3077 點寬：第 i 個點的中心在 (i + 0.5) / 3077 處 → 畫布 x = 1000 + i + 0.5
    const cols = 3077;
    for (const i of [0, 1, 1500, 3076]) {
      const lx = (i + 0.5) / cols;
      const [px] = canvasPoint(placed, lx, 0.5);
      expect(px).toBeCloseTo(1000 + i + 0.5, 6);
      // 對位圖的像素 = floor(px) → 剛好是 1000 + i
      expect(Math.floor(px)).toBe(1000 + i);
    }
  });

  it('隨機的平面（任意旋轉、位置、大小）：量回來的外框永遠剛好等於排好的長方形', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 30; i++) {
      const wall = moved(gridPrim([-2 - rnd() * 5, 0, 0], X, Y, 4 + rnd() * 10, 2 + rnd() * 6, 5), Y, rnd() * 360 - 180, [rnd() * 20 - 10, rnd() * 5, rnd() * 20 - 10]);
      const g = obj(wall);
      const f = stageFrontOf([g]);
      const inf = describeObject(g, f, CANVAS);
      if (inf.kind !== 'ok') continue;
      const w = 50 + Math.floor(rnd() * 3000), h = 20 + Math.floor(rnd() * 1000);
      const pl = { x: Math.floor(rnd() * 4000), y: Math.floor(rnd() * 800), w, h, rotate: 0 as Rotation, flipH: false, flipV: false };
      const r = flatUvForPrim(wall, inf.pieces, () => pl, CANVAS);
      const tris: number[] = [];
      for (const ix of wall.index) tris.push(r.uv[ix * 2], r.uv[ix * 2 + 1]);
      const layout = buildLedLayout([{ id: 'a', name: 'a', tris }], CANVAS);
      expect(layout.panels[0].rect).toEqual({ x: pl.x, y: pl.y, w, h });
    }
  });
});

describe('buildPlan：選哪些、保留哪些、舊版面', () => {
  // 三個物件：兩塊平面（一塊舊 UV 是正的、一塊舊 UV 轉了 90 度）、一塊弧面（保留）
  const wallA = gridPrim([-6, 1, 0], X, Y, 12, 4, 4);             // 舊 UV 預設：s → u、1-t → v（畫面正的）
  const wallB = gridPrim([-6, 8, 0], X, Y, 6, 3, 4, { oldUv: (s, t) => [t, s] }); // 舊 UV 轉了：v 跟著 x
  const arc = wavePrim(12, 3, 0.6, 2);  // 波浪：不是平面也不是圓柱 → 保留
  const OLD = { width: 8800, height: 2024 };
  // 舊 UV 都擺在畫布不同的地方
  function relocate(p: ReturnType<typeof gridPrim>, u0: number, v0: number, du: number, dv: number) {
    const uv = Float64Array.from(p.uv!);
    for (let i = 0; i < uv.length; i += 2) { uv[i] = u0 + uv[i] * du; uv[i + 1] = v0 + uv[i + 1] * dv; }
    return { ...p, uv };
  }
  const geoms: Record<string, ObjectGeom> = {
    a: obj(relocate(wallA, 0.1, 0.1, 0.3, 0.2)),
    b: obj(relocate(wallB, 0.5, 0.4, 0.1, 0.3)),
    c: obj(relocate(arc, 0.7, 0.6, 0.2, 0.2)),
  };
  const front = stageFrontOf([geoms.a, geoms.b]);
  const infos = Object.fromEntries(Object.entries(geoms).map(([k, g]) => [k, describeObject(g, front, OLD)]));
  const input = (id: string, order: number, selected: boolean, size?: { mode: 'pitch'; pitchMm: number }): PlanObjectIn =>
    ({ id, name: '物件' + id, order, info: infos[id], selected, sizes: size ? { 0: size } : {}, manuals: [] });
  const ctx = { front, metersPerUnit: 1, oldCanvas: OLD };

  it('原本的方向找得出來：舊 UV 正的 = 不轉；轉了 90 度的 = 轉回來', () => {
    expect(infos.a.oldPieces[0]!.rel).toEqual({ rotate: 0, flipH: false, flipV: false });
    expect(infos.a.oldPieces[0]!.err).toBeLessThan(1e-6);
    const relB = infos.b.oldPieces[0]!;
    expect(relB.err).toBeLessThan(1e-6);
    expect(relB.rel.rotate === 0 && !relB.rel.flipH && !relB.rel.flipV).toBe(false);
    expect(bestOrientation([[0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 1, 1]]).err).toBeLessThan(1e-9);
  });

  it('沒填點數 → 擋住；填了以後排出畫布；弧面和沒勾的保留、搬到新位置', () => {
    const none = buildPlan([input('a', 0, true), input('b', 1, true), input('c', 2, false)], ctx);
    expect(none.blockers.some(b => b.includes('還沒填點數'))).toBe(true);
    const plan = buildPlan([
      input('a', 0, true, { mode: 'pitch', pitchMm: 10 }),
      input('b', 1, true, { mode: 'pitch', pitchMm: 10 }),
      input('c', 2, true),
    ], ctx);
    expect(plan.blockers).toEqual([]);
    const byId = Object.fromEntries(plan.objects.map(o => [o.id, o]));
    expect(byId.a.mode).toBe('auto');
    expect(byId.b.mode).toBe('auto');
    expect(byId.c.mode).toBe('keep');
    expect(byId.c.reason).toBe(UNSUPPORTED_TEXT.arc);
    // a: 12 m / 10 mm = 1200 點；b: 6 m → 600
    expect(byId.a.pieces[0].placed).toMatchObject({ w: 1200, h: 400 });
    expect(byId.b.pieces[0].placed).toMatchObject({ w: 600, h: 300 });
    expect(layoutProblems(plan.pack)).toEqual([]);
    // 照舞台排：b 在 a 上面（y 高）
    expect(byId.b.pieces[0].placed!.y).toBeLessThan(byId.a.pieces[0].placed!.y);
  });

  it('保留的物件：UV 整數像素平移，形狀、大小、取樣的像素不變', () => {
    const plan = buildPlan([input('a', 0, true, { mode: 'pitch', pitchMm: 10 }), input('c', 2, false)], ctx);
    const c = plan.objects.find(o => o.id === 'c')!;
    const uv = objectUvs(geoms.c, c, infos.c, plan.canvas)[0]!;
    const region = infos.c.oldRegion!;
    const after = uvRegion(Array.from(geoms.c.prims[0].index, ix => [uv[ix * 2], uv[ix * 2 + 1]]).flat(), plan.canvas)!;
    expect(after.rect.w).toBe(region.rect.w);
    expect(after.rect.h).toBe(region.rect.h);
    expect(after.rect.x).toBe(c.keep!.placed.x);
    expect(after.rect.y).toBe(c.keep!.placed.y);
    // 每個頂點：新畫布像素 - 舊畫布像素 = 固定的整數
    const dx = c.keep!.map.shiftX, dy = c.keep!.map.shiftY;
    const p = geoms.c.prims[0];
    for (let i = 0; i < uv.length / 2; i += 5) {
      const ku = Math.floor(p.uv![i * 2] - region.span.us + 1e-5), kv = Math.floor(p.uv![i * 2 + 1] - region.span.vs + 1e-5);
      expect(uv[i * 2] * plan.canvas.width).toBeCloseTo((p.uv![i * 2] - ku) * OLD.width + dx, 3);
      expect(uv[i * 2 + 1] * plan.canvas.height).toBeCloseTo((p.uv![i * 2 + 1] - kv) * OLD.height + dy, 3);
    }
  });

  it('舊版面：每塊螢幕放在原本的像素位置；舊影片的畫面經過它貼回新的 UV，跟以前一模一樣', () => {
    const inputs = [input('a', 0, true, { mode: 'pitch', pitchMm: 10 }), input('b', 1, true, { mode: 'pitch', pitchMm: 10 }), input('c', 2, false)];
    const plan = buildPlan(inputs, ctx);
    const legacy = buildLegacy(plan, inputs, OLD);
    expect(legacy.canvas).toEqual(OLD);
    expect(legacy.unprotected).toEqual([]);
    expect(legacy.approximate).toEqual([]);
    expect(legacy.screens.map(s => s.key).sort()).toEqual(['o:a', 'o:b', 'o:c']);
    // 驗證：任選新 UV 上的點，用舊版面的版型數學算出它在舊畫布上的位置，要等於「原本 UV 的位置」
    for (const id of ['a', 'b', 'c']) {
      const g = geoms[id];
      const o = plan.objects.find(x => x.id === id)!;
      const newUv = objectUvs(g, o, infos[id], plan.canvas);
      const scr = legacy.screens.find(s => s.key === `o:${id}`)!;
      // 版型的來源範圍 = 現在模型的 UV 外框（新的位置）
      const nr = uvRegion(g.prims.flatMap((p, pi) => Array.from(p.index, ix => [newUv[pi]![ix * 2], newUv[pi]![ix * 2 + 1]]).flat()), plan.canvas)!;
      const pl: Placement = { key: scr.key, objectId: id, uv: null, dest: scr.dest, rotate: scr.rotate, flipH: scr.flipH, flipV: scr.flipV };
      const prim = g.prims[0];
      let checked = 0;
      for (let v = 0; v < prim.pos.length / 3; v += 3) {
        const m = mapUvToTemplate(pl, nr.span, OLD, newUv[0]![v * 2], newUv[0]![v * 2 + 1]);
        if (!m) continue;
        const oldU = prim.uv![v * 2] - Math.floor(prim.uv![v * 2] - infos[id].oldRegion!.span.us + 1e-5);
        const oldV = prim.uv![v * 2 + 1] - Math.floor(prim.uv![v * 2 + 1] - infos[id].oldRegion!.span.vs + 1e-5);
        // mapUvToTemplate 往裡縮半個像素（雙線性過濾），所以容許 1 個像素
        expect(Math.abs(m[0] * OLD.width - oldU * OLD.width)).toBeLessThan(1.01);
        expect(Math.abs(m[1] * OLD.height - oldV * OLD.height)).toBeLessThan(1.01);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
      // 螢幕的原本大小（nativeSize）跟舊版面的長方形一樣
      expect(nativeSize(infos[id].oldRegion!.span, OLD)).toEqual({ w: scr.dest.w, h: scr.dest.h });
    }
  });

  it('一個物件有好幾片：每片各自一個螢幕、舊版面用新切出來的螢幕代號', () => {
    const g = obj(
      relocate(gridPrim([-10, 1, 0], X, Y, 4, 3, 2), 0.1, 0.1, 0.1, 0.2),
      relocate(gridPrim([6, 1, 0], X, Y, 4, 3, 2), 0.5, 0.1, 0.1, 0.2),
    );
    const inf = describeObject(g, FRONT, OLD);
    expect(inf.pieces).toHaveLength(2);
    const inp: PlanObjectIn = { id: 'm', name: '雙翼', order: 0, info: inf, selected: true, sizes: { 0: { mode: 'pixels', pixels: { w: 400, h: 300 } }, 1: { mode: 'pixels', pixels: { w: 400, h: 300 } } }, manuals: [] };
    const plan = buildPlan([inp], { front: FRONT, metersPerUnit: 1, oldCanvas: OLD });
    expect(plan.blockers).toEqual([]);
    const screens = pieceScreensOf(plan);
    expect(screens.map(s => s.name)).toEqual(['雙翼 1', '雙翼 2']);
    expect(screens[0].uv[0]).toBeLessThan(screens[1].uv[0]);
    const legacy = buildLegacy(plan, [inp], OLD);
    expect(legacy.screens.map(s => s.key)).toEqual(['s:@m#0', 's:@m#1']);
    expect(legacy.screens[0].dest).toEqual(inf.oldPieces[0]!.region.rect);
  });

  it('已經手動切過的物件不自動貼：保留，切出來的螢幕範圍跟著平移', () => {
    const inp: PlanObjectIn = { ...input('a', 0, true), manuals: [{ id: 'ls1', name: '左半', uv: [0.1, 0.1, 0.25, 0.3] }] };
    const other = input('b', 1, true, { mode: 'pitch', pitchMm: 10 });
    const plan = buildPlan([inp, other], ctx);
    const a = plan.objects.find(o => o.id === 'a')!;
    expect(a.mode).toBe('keep');
    expect(a.reason).toContain('手動切');
    const upd = a.keep!.manualUpdates[0];
    const u0px = upd.uv[0] * plan.canvas.width;
    expect(u0px).toBeCloseTo(0.1 * 8800 + a.keep!.map.shiftX, 3);
    const legacy = buildLegacy(plan, [inp, other], OLD);
    expect(legacy.screens.some(s => s.key === 's:ls1')).toBe(true);
  });
});
