// 自動貼 UV 第 2 階段：圓柱 / 弧面（擬合、凸凹方向、真正的弧長、變形百分比、手動指定、像素要對準）
import { describe, expect, it } from 'vitest';
import { arcLocal, arcPoint, fitCircle } from './cylinder';
import { analyzeObject, assignVertices, stageFrontOf, DISTORTION_OK, DISTORTION_WARN, type ObjectGeom, type Piece } from './surfaces';
import { describeObject } from './objectInfo';
import { canvasPoint, flatUvForPrim } from './place';
import { buildPlan, objectUvs, type PlanObjectIn } from './plan';
import { distortionLevel, distortionText, freeformText, UNSUPPORTED_TEXT } from './text';
import { resolveSize } from './size';
import { arcPrim, conePrim, gridPrim, mirroredX, moved, wavePrim } from './testing';
import { spherePrim } from './testShapes';
import { cross, dot, normalize, sub, type Vec3 } from './geometry';

const FRONT: Vec3 = [0, 0, 1];
const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const obj = (...prims: ObjectGeom['prims']): ObjectGeom => ({ prims });
const D2R = Math.PI / 180;

function arcPieceOf(g: ObjectGeom, front: Vec3 = FRONT, override: 'auto' | 'flat' | 'arc' = 'auto'): Piece {
  const a = analyzeObject(g, front, override);
  expect(a.kind, `unsupported: ${a.unsupported}`).toBe('ok');
  return a.pieces[0];
}

describe('fitCircle：圓擬合', () => {
  it('整圈、半圈、很短的一段弧都找得回圓心和半徑；有一點雜訊也行', () => {
    for (const [cx, cy, r, from, to] of [[3, -2, 5, 0, 360], [-10, 4, 7.5, 20, 200], [0, 0, 19, -30, -2], [100, 50, 2, 0, 90]] as const) {
      const xs: number[] = [], ys: number[] = [];
      for (let i = 0; i <= 40; i++) {
        const a = (from + ((to - from) * i) / 40) * D2R;
        xs.push(cx + r * Math.cos(a)); ys.push(cy + r * Math.sin(a));
      }
      const c = fitCircle(xs, ys)!;
      expect(c.cx).toBeCloseTo(cx, 6);
      expect(c.cy).toBeCloseTo(cy, 6);
      expect(c.r).toBeCloseTo(r, 6);
    }
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i <= 60; i++) {
      const a = (-40 + (80 * i) / 60) * D2R;
      xs.push(20 * Math.cos(a) + Math.sin(i * 12.9898) * 0.01); ys.push(20 * Math.sin(a) + Math.cos(i * 78.233) * 0.01);
    }
    expect(fitCircle(xs, ys)!.r).toBeCloseTo(20, 1);
    expect(fitCircle([1, 2], [1, 2])).toBeNull();
    expect(fitCircle([0, 1, 2, 3], [0, 0, 0, 0])).toBeNull();
  });
});

describe('弧面辨識：半徑、角度、凸或凹、攤平後的大小', () => {
  it('小半圓（180 度、凸）：不管網格切得多粗，半徑、角度、弧長都對；寬 = 真正的弧長（不是弦長）', () => {
    for (const seg of [6, 12, 32, 128]) {
      const p = arcPieceOf(obj(arcPrim(4, 180, 3, seg)));
      expect(p.kind).toBe('arc');
      expect(p.arc!.radius).toBeCloseTo(4, 6);
      expect(p.arc!.span / D2R).toBeCloseTo(180, 5);
      expect(p.arc!.convex).toBe(true);
      expect(p.widthU).toBeCloseTo(Math.PI * 4, 6);  // 弧長 12.566，不是弦長 8
      expect(p.heightU).toBeCloseTo(3, 6);
      expect(p.facing).toBeGreaterThan(0.99);
    }
  });

  it('凹的弧面（圓心在觀眾這邊）：法線朝內，辨識成凹；半徑 / 角度也對', () => {
    const p = arcPieceOf(obj(arcPrim(8, 60, 3, 24, 150, true)));
    expect(p.arc!.convex).toBe(false);
    expect(p.arc!.radius).toBeCloseTo(8, 6);
    expect(p.arc!.span / D2R).toBeCloseTo(60, 5);
    expect(p.widthU).toBeCloseTo((8 * 60 * Math.PI) / 180, 6);
    expect(p.facing).toBeGreaterThan(0.99);  // 凹面對著觀眾
  });

  it('只有一小段弧（20 度）、很大的半徑，還有 270 度的大弧', () => {
    const small = arcPieceOf(obj(arcPrim(30, 20, 4, 16)));
    expect(small.kind).toBe('arc');
    expect(small.arc!.radius).toBeCloseTo(30, 5);
    expect(small.widthU).toBeCloseTo((30 * 20 * Math.PI) / 180, 6);
    const big = arcPieceOf(obj(arcPrim(3, 270, 2, 54)), [0, 0, 1]);
    expect(big.arc!.span / D2R).toBeCloseTo(270, 5);
    expect(big.widthU).toBeCloseTo((3 * 270 * Math.PI) / 180, 6);
  });

  it('隨便轉、隨便放的圓柱：半徑 / 角度 / 大小不變（傾斜的軸也行）', () => {
    for (const [axis, deg] of [[Y, 37], [X, 90], [normalize([1, 1, 0.3]) as Vec3, 123], [Z, 200]] as const) {
      const g = obj(moved(arcPrim(6, 100, 5, 40), axis, deg, [11, -3, 7]));
      const a = analyzeObject(g, FRONT);
      expect(a.kind, `${a.unsupported}`).toBe('ok');
      const p = a.pieces[0];
      expect(p.arc!.radius).toBeCloseTo(6, 5);
      expect(p.arc!.span / D2R).toBeCloseTo(100, 4);
      expect(p.widthU * p.heightU).toBeCloseTo(((6 * 100 * Math.PI) / 180) * 5, 4);
    }
  });

  it('整圈 360 度的圓柱（第 4 階段）：收，弧長 = 一整圈；圓錐、波浪不是圓柱 → 改走擠出 / 自由曲面（freeUv.test.ts）', () => {
    for (const seg of [32, 64, 128]) {
      const closed = analyzeObject(obj(arcPrim(3, 360, 2, seg)), FRONT);
      expect(closed.kind, `seg ${seg}`).toBe('ok');
      const p = closed.pieces[0];
      expect(p.kind).toBe('arc');
      expect(p.arc!.closed).toBe(true);
      expect(p.widthU).toBeCloseTo(2 * Math.PI * 3, 6);
      expect(p.heightU).toBeCloseTo(2, 6);
    }
    expect(UNSUPPORTED_TEXT.closed).toContain('不是正圓');
    expect(analyzeObject(obj(conePrim(5, 3, 90, 3)), FRONT).pieces[0].kind).toBe('free');
    expect(analyzeObject(obj(wavePrim(14, 3, 0.8, 2)), FRONT).pieces[0].kind).toBe('ext');
  });
});

describe('方向：站在法線那一側（觀眾席）看，左右、上下都對，凸、凹、鏡像都不會反', () => {
  /** 從觀眾席（+Z）看過去：lx 越大越靠右（世界 +X）、ly 越大越靠下（世界 -Y） */
  function readsLeftToRight(p: Piece) {
    const xs = [0, 0.25, 0.5, 0.75, 1].map(lx => arcPoint(p.arc!, lx, 0.5)[0]);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    const y0 = arcPoint(p.arc!, 0.5, 0)[1], y1 = arcPoint(p.arc!, 0.5, 1)[1];
    expect(y0).toBeGreaterThan(y1);
  }

  it('凸的小半圓：畫面由左到右 = 世界 -X → +X（跟平面的牆一樣），上方朝上', () => {
    readsLeftToRight(arcPieceOf(obj(arcPrim(4, 180, 3, 24))));
  });

  it('凹的弧面：一樣是觀眾看過去的左到右（內側面對觀眾，內容不會鏡像）', () => {
    readsLeftToRight(arcPieceOf(obj(arcPrim(8, 60, 3, 24, 150, true))));
  });

  it('鏡像過的節點（負的縮放，三角形繞向反）：左右還是對的', () => {
    readsLeftToRight(arcPieceOf(obj(mirroredX(arcPrim(4, 180, 3, 24)))));
    readsLeftToRight(arcPieceOf(obj(mirroredX(arcPrim(8, 60, 3, 24, 150, true)))));
  });

  it('旋轉 180 度背對觀眾的弧面：LED 只畫正面，方向仍是站在法線那一側看；不再提醒「背對觀眾」', () => {
    const a = analyzeObject(obj(moved(arcPrim(4, 90, 3, 24), Y, 180, [0, 0, 0])), FRONT);
    expect(a.kind).toBe('ok');
    expect(a.warnings.some(w => w.includes('背對觀眾'))).toBe(false);
    // 站在法線（-Z 側）看過去，右邊 = -X
    const xs = [0, 0.5, 1].map(lx => arcPoint(a.pieces[0].arc!, lx, 0.5)[0]);
    expect(xs[2]).toBeLessThan(xs[0]);
  });

  it('軸橫躺的弧牆（像斜坡 / 四分之一圓管）：弧的方向是畫面的上下，上 = 世界朝上，右邊沿著軸', () => {
    // arcPrim 的軸是 Y；繞 Z 轉 90 度後軸 = -X，弧在 y-z 平面
    const g = obj(moved(arcPrim(4, 90, 6, 24), Z, 90, [0, 0, 0]));
    const p = arcPieceOf(g);
    expect(p.arc!.arcVertical).toBe(true);
    const top = arcPoint(p.arc!, 0.5, 0), bottom = arcPoint(p.arc!, 0.5, 1);
    expect(top[1]).toBeGreaterThan(bottom[1]);
    const left = arcPoint(p.arc!, 0, 0.5), right = arcPoint(p.arc!, 1, 0.5);
    expect(right[0]).toBeGreaterThan(left[0]);
  });

  it('躺在地上的弧面（法線朝上，軸橫躺）：畫面上方 = 舞台後方；弧的方向是左右', () => {
    // 繞 X 轉 -90 度：弧的中間法線 +Z → +Y，軸 Y → -Z
    const g = obj(moved(arcPrim(5, 60, 8, 24), X, -90, [0, 0, 0]));
    const p = arcPieceOf(g);
    expect(p.arc!.arcVertical).toBe(false);
    expect(dot(p.frame.normal, Y)).toBeGreaterThan(0.99);
    const top = arcPoint(p.arc!, 0.5, 0), bottom = arcPoint(p.arc!, 0.5, 1);
    expect(top[2]).toBeLessThan(bottom[2]);  // 上 = 後方 = -Z
    const left = arcPoint(p.arc!, 0, 0.5), right = arcPoint(p.arc!, 1, 0.5);
    expect(right[0]).toBeGreaterThan(left[0]);
  });

  it('arcLocal 跟 arcPoint 互為反運算（弧上任何一點回得來）', () => {
    const p = arcPieceOf(obj(moved(arcPrim(5, 130, 4, 30), Y, 25, [3, 1, -2])));
    for (const [lx, ly] of [[0, 0], [1, 1], [0.3, 0.8], [0.77, 0.12], [0.5, 0.5]]) {
      const w = arcPoint(p.arc!, lx, ly);
      const r = arcLocal(p.arc!, w[0], w[1], w[2]);
      expect(r.lx).toBeCloseTo(lx, 9);
      expect(r.ly).toBeCloseTo(ly, 9);
      expect(r.dist).toBeLessThan(1e-9);
    }
  });
});

describe('不會左右反：用跟 GPU 一樣的方式獨立檢查（不靠 arcPoint）', () => {
  /** 每個三角形：站在「看得到的那一面」（繞向法線乘鏡像的正負）、頭朝世界朝上看過去，u 往畫面右邊增加、v 往下增加 */
  function notMirrored(g: ObjectGeom, override: 'auto' | 'flat' | 'arc' = 'auto') {
    const a = analyzeObject(g, FRONT, override);
    expect(a.kind, `${a.unsupported}`).toBe('ok');
    const prim = g.prims[0];
    const placed = { x: 0, y: 0, w: 1000, h: 500, rotate: 0 as const, flipH: false, flipV: false };
    const { uv } = flatUvForPrim(prim, a.pieces, () => placed, { width: 1000, height: 500 });
    let n = 0;
    for (let t = 0; t + 2 < prim.index.length; t += 3) {
      const [i, j, k] = [prim.index[t], prim.index[t + 1], prim.index[t + 2]];
      const P = (v: number): Vec3 => [prim.pos[v * 3], prim.pos[v * 3 + 1], prim.pos[v * 3 + 2]];
      const e1 = sub(P(j), P(i)), e2 = sub(P(k), P(i));
      const nrm = cross(e1, e2).map(x => x * prim.sign) as Vec3;
      const nn = normalize(nrm);
      const du1 = (uv[j * 2] - uv[i * 2]) * 1000, du2 = (uv[k * 2] - uv[i * 2]) * 1000;
      const dv1 = (uv[j * 2 + 1] - uv[i * 2 + 1]) * 500, dv2 = (uv[k * 2 + 1] - uv[i * 2 + 1]) * 500;
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) < 1e-12) continue;
      const dPdu = [0, 1, 2].map(q => (e1[q] * dv2 - e2[q] * dv1) / det) as Vec3;
      const dPdv = [0, 1, 2].map(q => (e2[q] * du1 - e1[q] * du2) / det) as Vec3;
      const right = cross([-nn[0], -nn[1], -nn[2]], [0, 1, 0]);
      if (Math.hypot(...right) < 1e-6) continue;  // 躺在地上看不出「畫面右邊」
      expect(dot(dPdu, right)).toBeGreaterThan(0);
      expect(dPdv[1]).toBeLessThan(1e-9);
      n++;
    }
    return n;
  }
  it('凸、凹、鏡像的凸、鏡像的凹、背對觀眾的弧面、壓成平面的弧面：每個三角形都是正的', () => {
    expect(notMirrored(obj(arcPrim(4, 180, 3, 24)))).toBeGreaterThan(20);
    expect(notMirrored(obj(arcPrim(8, 60, 3, 24, 150, true)))).toBeGreaterThan(20);
    expect(notMirrored(obj(mirroredX(arcPrim(4, 120, 3, 24))))).toBeGreaterThan(20);
    expect(notMirrored(obj(mirroredX(arcPrim(8, 60, 3, 24, 150, true))))).toBeGreaterThan(20);
    expect(notMirrored(obj(moved(arcPrim(5, 100, 3, 24), Y, 160, [0, 0, 0])))).toBeGreaterThan(20);
    expect(notMirrored(obj(arcPrim(5, 100, 3, 24)), 'flat')).toBeGreaterThan(20);
    expect(notMirrored(obj(moved(arcPrim(4, 90, 6, 24), Z, 90, [0, 0, 0])))).toBeGreaterThan(20);
  });
});

describe('變形百分比', () => {
  it('標準圓柱：粗網格也是 0 %（LED 實際是光滑的圓柱，不拿弦長冤枉它）', () => {
    for (const seg of [6, 12, 32]) {
      const p = arcPieceOf(obj(arcPrim(4, 180, 3, seg)));
      expect(p.distortion.max, `seg ${seg}`).toBeLessThan(DISTORTION_OK);
      expect(distortionLevel(p.distortion)).toBe('ok');
    }
  });

  it('平面：0 %；壓成平面的弧面（手動指定「平面」）：變形很多，標紅', () => {
    const flat = arcPieceOf(obj(gridPrim([-6, 0, 0], X, Y, 12, 4, 6)));
    expect(flat.distortion.max).toBeLessThan(1e-9);
    const forced = analyzeObject(obj(arcPrim(5, 120, 3, 24)), FRONT, 'flat');
    expect(forced.kind).toBe('ok');
    expect(forced.pieces[0].kind).toBe('flat');
    expect(forced.pieces[0].forced).toBe(true);
    expect(forced.pieces[0].distortion.max).toBeGreaterThan(DISTORTION_WARN);
    expect(distortionLevel(forced.pieces[0].distortion)).toBe('bad');
    expect(distortionText(forced.pieces[0].distortion)).toContain('會變形');
  });

  it('什麼都攤不平（整顆球）：照實估「硬貼會變形多少」，超過門檻標紅；圓錐、波浪不用硬貼，攤平後 0 變形', () => {
    const ball = analyzeObject(obj(spherePrim(3, 12)), FRONT);
    expect(ball.kind).toBe('unsupported');
    expect(ball.freeform!.distortion.max).toBeGreaterThan(DISTORTION_WARN);
    expect(distortionLevel(ball.freeform!.distortion)).toBe('bad');
    expect(freeformText(ball.freeform!)).toContain('硬把它');
    const cone = analyzeObject(obj(conePrim(6, 2, 120, 3, 36)), FRONT);
    expect(cone.kind).toBe('ok');
    expect(distortionLevel(cone.pieces[0].distortion)).toBe('ok');
    const wave = analyzeObject(obj(wavePrim(14, 3, 1.5, 2)), FRONT);
    expect(distortionLevel(wave.pieces[0].distortion)).toBe('ok');
  });

  it('門檻：<= 0.5 % 綠、<= 5 % 黃（輕微拉伸）、超過紅；文字寫百分比', () => {
    expect(distortionLevel({ max: 0.004, mean: 0 })).toBe('ok');
    expect(distortionLevel({ max: 0.03, mean: 0 })).toBe('warn');
    expect(distortionLevel({ max: 0.2, mean: 0.1 })).toBe('bad');
    expect(distortionText({ max: 0.03, mean: 0.01 })).toContain('輕微拉伸 3.0%');
    expect(distortionText({ max: 0, mean: 0 })).toContain('沒有變形');
  });
});

describe('手動指定：平面 / 弧面', () => {
  it('指定「弧面」但其實是平的、整圈、波浪 → 做不到，說明白（不會亂貼）', () => {
    const flat = analyzeObject(obj(gridPrim([-6, 0, 0], X, Y, 12, 4, 6)), FRONT, 'arc');
    expect(flat.kind).toBe('unsupported');
    expect(flat.unsupported).toBe('arcfail');
    expect(UNSUPPORTED_TEXT.arcfail).toContain('改回「自動」');
    expect(analyzeObject(obj(arcPrim(3, 360, 2, 64)), FRONT, 'arc').pieces[0].arc!.closed).toBe(true);   // 整圈現在收了
    // 球硬要當圓柱也做得出來（整圈），但變形一定是紅的
    expect(distortionLevel(analyzeObject(obj(spherePrim(3, 12)), FRONT, 'arc').pieces[0].distortion)).toBe('bad');
  });

  it('指定「弧面」：不太圓的弧也貼（變形多少照實告訴製作）', () => {
    // 圓錐的一段：自動辨識是自由曲面（可以攤平，0 變形）；手動指定弧面就當圓柱攤平，圓柱貼不準 → 有變形
    const cone = conePrim(5, 4.5, 90, 3, 24);
    expect(analyzeObject(obj(cone), FRONT).pieces[0].kind).toBe('free');
    const forced = analyzeObject(obj(cone), FRONT, 'arc');
    expect(forced.kind).toBe('ok');
    expect(forced.pieces[0].kind).toBe('arc');
    expect(forced.pieces[0].forced).toBe(true);
    expect(forced.pieces[0].distortion.max).toBeGreaterThan(0.001); // 有變形（照實算；小於 1% 時畫面寫「沒有變形」）
  });

  it('describeObject 帶著指定走：同一個物件，自動 = 弧面、指定平面 = 平面', () => {
    const g = obj(arcPrim(5, 90, 3, 24));
    const old = { width: 8800, height: 2024 };
    expect(describeObject(g, FRONT, old).pieces[0].kind).toBe('arc');
    expect(describeObject(g, FRONT, old, 'flat').pieces[0].kind).toBe('flat');
    expect(describeObject(g, FRONT, old, 'flat').override).toBe('flat');
  });
});

describe('尺寸：弧長 × 高', () => {
  it('點距用弧長算：180 度、半徑 4 m 的小半圓，P20（20 mm）→ 628 × 150 點', () => {
    const p = arcPieceOf(obj(arcPrim(4, 180, 3, 24)));
    const r = resolveSize({ mode: 'pitch', pitchMm: 20 }, { w: p.widthU, h: p.heightU });
    expect(r.ok && r.w).toBe(Math.round((Math.PI * 4 * 1000) / 20));
    expect(r.ok && r.h).toBe(150);
  });

  it('跟著測距校準（每個文件單位幾公尺）換算；總點數、箱體也一樣能用', () => {
    const p = arcPieceOf(obj(arcPrim(4, 180, 3, 24)));
    const k = 0.5;  // 校準：1 個文件單位 = 0.5 m
    const m = { w: p.widthU * k, h: p.heightU * k };
    const pitch = resolveSize({ mode: 'pitch', pitchMm: 10 }, m);
    expect(pitch.ok && pitch.w).toBe(Math.round((Math.PI * 4 * k * 1000) / 10));
    expect(resolveSize({ mode: 'pixels', pixels: { w: 640, h: 150 } }, m)).toMatchObject({ ok: true, w: 640, h: 150 });
    const cab = resolveSize({ mode: 'cabinets', cabinet: { mmW: 500, mmH: 500, pxW: 128, pxH: 128 } }, m);
    expect(cab.ok && cab.w).toBe(Math.round((Math.PI * 4 * k * 1000) / 500) * 128);
  });
});

describe('排好位置 → UV：弧長均勻（一個 LED 點 ↔ 一個畫布像素），像素要對準', () => {
  const canvas = { width: 1920, height: 1080 };

  for (const [label, prim] of [
    ['凸（小半圓 180 度）', () => arcPrim(4, 180, 3, 24)],
    ['凹（60 度）', () => arcPrim(8, 60, 3, 24, 150, true)],
    ['鏡像的凸弧', () => mirroredX(arcPrim(4, 120, 3, 24))],
  ] as const) {
    it(`${label}：沿弧每隔一個點走，畫布上剛好每隔一個像素，沒有跳過、重複；角度均勻（弧長均勻）`, () => {
      const g = obj(prim());
      const p = arcPieceOf(g);
      const cols = Math.round((p.widthU * 1000) / 20), rows = Math.round((p.heightU * 1000) / 20);
      const placed = { x: 100, y: 40, w: cols, h: rows, rotate: 0 as const, flipH: false, flipV: false };
      let prevTheta = NaN;
      for (let i = 0; i < cols; i += 1) {
        const lx = (i + 0.5) / cols;
        const world = arcPoint(p.arc!, lx, 0.5);
        const [px, py] = canvasPoint(placed, lx, 0.5);
        expect(Math.floor(px)).toBe(placed.x + i);
        expect(Math.floor(py)).toBe(placed.y + Math.floor(rows / 2));
        // 離軸的距離 = 半徑；相鄰兩個點中心的角度差 = 弧的總角度 / 點數（均勻）
        const d = [world[0] - p.arc!.center[0], world[1] - p.arc!.center[1], world[2] - p.arc!.center[2]];
        const h = dot(d as Vec3, p.arc!.axis);
        const rad = Math.hypot(d[0] - h * p.arc!.axis[0], d[1] - h * p.arc!.axis[1], d[2] - h * p.arc!.axis[2]);
        expect(rad).toBeCloseTo(p.arc!.radius, 8);
        const theta = Math.atan2(dot(d as Vec3, p.arc!.e2), dot(d as Vec3, p.arc!.e1));
        if (i > 0) {
          let dt = Math.abs(theta - prevTheta);
          if (dt > Math.PI) dt = 2 * Math.PI - dt;
          expect(dt).toBeCloseTo(p.arc!.span / cols, 9);
        }
        prevTheta = theta;
      }
    });

    it(`${label}：頂點 UV = 排好的長方形裡的弧長位置，四個角剛好是整數像素`, () => {
      const g = obj(prim());
      const a = analyzeObject(g, FRONT);
      const p = a.pieces[0];
      const placed = { x: 200, y: 100, w: Math.round((p.widthU * 1000) / 25), h: Math.round((p.heightU * 1000) / 25), rotate: 0 as const, flipH: false, flipV: false };
      const res = flatUvForPrim(g.prims[0], a.pieces, () => placed, canvas);
      expect(res.clamped).toBe(0);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let v = 0; v < res.uv.length; v += 2) {
        minU = Math.min(minU, res.uv[v]); maxU = Math.max(maxU, res.uv[v]);
        minV = Math.min(minV, res.uv[v + 1]); maxV = Math.max(maxV, res.uv[v + 1]);
      }
      expect(minU * canvas.width).toBeCloseTo(placed.x, 3);
      expect(maxU * canvas.width).toBeCloseTo(placed.x + placed.w, 3);
      expect(minV * canvas.height).toBeCloseTo(placed.y, 3);
      expect(maxV * canvas.height).toBeCloseTo(placed.y + placed.h, 3);
      // 每個頂點的 u 跟它在弧上的角度成正比
      const as = assignVertices(g.prims[0], a.pieces);
      for (let v = 0; v < as.piece.length; v += 7) {
        expect(res.uv[v * 2] * canvas.width).toBeCloseTo(placed.x + as.lx[v] * placed.w, 3);
      }
    });
  }

  it('網格切得粗：每個面上的 UV 也是均勻的（頂點 UV 隨角度均勻增加）', () => {
    const g = obj(arcPrim(4, 180, 3, 6));
    const a = analyzeObject(g, FRONT);
    const placed = { x: 0, y: 0, w: 600, h: 100, rotate: 0 as const, flipH: false, flipV: false };
    const res = flatUvForPrim(g.prims[0], a.pieces, () => placed, { width: 600, height: 100 });
    const us = Array.from({ length: g.prims[0].pos.length / 3 }, (_, v) => res.uv[v * 2] * 600).sort((x, y) => x - y);
    const uniq = [...new Set(us.map(u => Math.round(u * 1e6) / 1e6))];
    expect(uniq).toHaveLength(7);
    for (let i = 1; i < uniq.length; i++) expect(uniq[i] - uniq[i - 1]).toBeCloseTo(100, 4);
  });
});

describe('buildPlan：弧面也能排、量到的大小是弧長', () => {
  it('弧面跟平面一起排：弧長 × 高當寬高；有指定平面的就用平面', () => {
    const old = { width: 8800, height: 2024 };
    const wall = obj(gridPrim([-6, 1, 0], X, Y, 12, 4, 4));
    const arc = obj(arcPrim(4, 180, 3, 24));
    const front = stageFrontOf([wall, arc]);
    const mk = (id: string, geom: ObjectGeom, order: number, override?: 'flat'): PlanObjectIn => ({
      id, name: '物件' + id, order, info: describeObject(geom, front, old, override ?? 'auto'),
      selected: true, sizes: { 0: { mode: 'pitch', pitchMm: 20 } }, manuals: [], override,
    });
    const plan = buildPlan([mk('w', wall, 0), mk('a', arc, 1)], { front, metersPerUnit: 1, oldCanvas: old });
    expect(plan.blockers).toEqual([]);
    const a = plan.objects.find(o => o.id === 'a')!;
    expect(a.mode).toBe('auto');
    expect(a.pieces[0].surface).toBe('arc');
    expect(a.pieces[0].convex).toBe(true);
    expect(a.pieces[0].spanDeg).toBeCloseTo(180, 4);
    expect(a.pieces[0].measured.w).toBeCloseTo(Math.PI * 4, 6);
    expect(a.pieces[0].placed!.w).toBe(628);
    expect(a.pieces[0].placed!.h).toBe(150);
    const forced = buildPlan([mk('a', arc, 1, 'flat')], { front, metersPerUnit: 1, oldCanvas: old });
    expect(forced.objects[0].override).toBe('flat');
    expect(forced.objects[0].pieces[0].surface).toBe('flat');
    expect(forced.objects[0].pieces[0].placed!.w).toBeLessThan(628);
  });

  it('objectUvs 對弧面算出每個頂點的 UV（不用拆頂點）；位置在長方形裡', () => {
    const old = { width: 8800, height: 2024 };
    const arc = obj(arcPrim(4, 180, 3, 24));
    const front = stageFrontOf([arc]);
    const info = describeObject(arc, front, old);
    const plan = buildPlan([{ id: 'a', name: 'a', order: 0, info, selected: true, sizes: { 0: { mode: 'pixels', pixels: { w: 600, h: 100 } } }, manuals: [] }], { front, metersPerUnit: 1, oldCanvas: old });
    const uv = objectUvs(arc, plan.objects[0], info, plan.canvas)[0]!.uv;
    expect(uv.length).toBe((arc.prims[0].pos.length / 3) * 2);
    const placed = plan.objects[0].pieces[0].placed!;
    for (let v = 0; v < uv.length; v += 2) {
      expect(uv[v] * plan.canvas.width).toBeGreaterThanOrEqual(placed.x - 1e-3);
      expect(uv[v] * plan.canvas.width).toBeLessThanOrEqual(placed.x + placed.w + 1e-3);
    }
  });
});
