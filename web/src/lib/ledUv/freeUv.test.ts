// 自動貼 UV 第 4 階段的運算：沿直線擠出的曲面（波浪、折角）、整圈 360 度的圓柱（接縫在背面、可以轉、拆頂點）、自由曲面（LSCM）
//   重點：方向不會反（用跟 GPU 一樣的獨立檢查）、一個 LED 點 ↔ 一個畫布像素（獨立算 3D 位置、找三角形、內插 UV，不靠被測的對應函數）、變形百分比
import { describe, expect, it } from 'vitest';
import { analyzeObject, assignVertices, DISTORTION_OK, DISTORTION_WARN, type ObjectGeom, type Piece, type PrimGeom } from './surfaces';
import { flatUvForPrim, type SplitPlan } from './place';
import { extLocal, extPoint, fitExtrusion } from './extrusion';
import { fitFreeform, freeLocal } from './freeform';
import { arcLocal, arcPoint } from './cylinder';
import { describeObject } from './objectInfo';
import { distortionLevel, UNSUPPORTED_TEXT } from './text';
import { arcPrim, conePrim, gridPrim, mirroredX, moved, uvReadingCheck, wavePrim } from './testing';
import { extrudePrim, saddlePrim, spherePrim, tubePrim } from './testShapes';
import { dot, type Vec3 } from './geometry';

const FRONT: Vec3 = [0, 0, 1];
const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const obj = (...prims: PrimGeom[]): ObjectGeom => ({ prims });
const D2R = Math.PI / 180;

const CANVAS = { width: 1400, height: 700 };
const PLACED = { x: 100, y: 50, w: 1000, h: 500, rotate: 0 as const, flipH: false, flipV: false };

/** 拆接縫以後的樣子：頂點多了、索引換了，UV 是新的（0~1） */
function withSplit(prim: PrimGeom, uv: Float32Array, split?: SplitPlan): PrimGeom {
  let pos = prim.pos;
  let index = prim.index;
  if (split) {
    const nv = prim.pos.length / 3;
    pos = new Float64Array((nv + split.origin.length) * 3);
    pos.set(prim.pos);
    split.origin.forEach((o, j) => { for (let k = 0; k < 3; k++) pos[(nv + j) * 3 + k] = prim.pos[o * 3 + k]; });
    index = split.index;
  }
  return { ...prim, pos, index, uv: Float64Array.from(uv) };
}

function layout(g: ObjectGeom, override: 'auto' | 'flat' | 'arc' | 'free' = 'auto', seamDeg = 0, placed = PLACED, canvas = CANVAS) {
  const a = analyzeObject(g, FRONT, override, seamDeg);
  expect(a.kind, `${a.unsupported}`).toBe('ok');
  const r = flatUvForPrim(g.prims[0], a.pieces, () => placed, canvas);
  return { a, piece: a.pieces[0], r, prim: withSplit(g.prims[0], r.uv, r.split) };
}

/** 3D 點 P 在哪個三角形裡（點在三角形的平面上）→ 內插 UV（畫布像素）；找不到 = null */
function uvPixelAt(prim: PrimGeom, p: Vec3, canvas = CANVAS): [number, number] | null {
  for (let t = 0; t + 2 < prim.index.length; t += 3) {
    const [i, j, k] = [prim.index[t], prim.index[t + 1], prim.index[t + 2]];
    const A: Vec3 = [prim.pos[i * 3], prim.pos[i * 3 + 1], prim.pos[i * 3 + 2]];
    const B: Vec3 = [prim.pos[j * 3], prim.pos[j * 3 + 1], prim.pos[j * 3 + 2]];
    const C: Vec3 = [prim.pos[k * 3], prim.pos[k * 3 + 1], prim.pos[k * 3 + 2]];
    const v0: Vec3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v1: Vec3 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]], v2: Vec3 = [p[0] - A[0], p[1] - A[1], p[2] - A[2]];
    const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-18) continue;
    const bv = (d11 * d20 - d01 * d21) / den, bw = (d00 * d21 - d01 * d20) / den, bu = 1 - bv - bw;
    const eps = 1e-9;
    if (bu < -eps || bv < -eps || bw < -eps) continue;
    // 點要在三角形的平面上
    const off = [p[0] - (A[0] * bu + B[0] * bv + C[0] * bw), p[1] - (A[1] * bu + B[1] * bv + C[1] * bw), p[2] - (A[2] * bu + B[2] * bv + C[2] * bw)];
    if (Math.hypot(off[0], off[1], off[2]) > 1e-6) continue;
    const u = prim.uv![i * 2] * bu + prim.uv![j * 2] * bv + prim.uv![k * 2] * bw;
    const v = prim.uv![i * 2 + 1] * bu + prim.uv![j * 2 + 1] * bv + prim.uv![k * 2 + 1] * bw;
    return [u * canvas.width, v * canvas.height];
  }
  return null;
}

/** 折線上離起點 s 的點（獨立於被測的程式碼：自己累積長度） */
function pointOnPolyline(pts: readonly Vec3[], s: number): Vec3 {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (s <= acc + l + 1e-12) {
      const t = l > 0 ? (s - acc) / l : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    acc += l;
  }
  return pts[pts.length - 1];
}
const polylineLength = (pts: readonly Vec3[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]), 0);

describe('擠出曲面：波浪、折角（廣義圓柱）照弧長拉直，不拉伸', () => {
  // wavePrim：x = (i/seg - 0.5)·width，z = amp·sin(i/seg·waves·2π)，沿 Y 擠出 height
  const W = 14, H = 3, AMP = 0.8, SEG = 48;
  const profile: Vec3[] = Array.from({ length: SEG + 1 }, (_, i) => [(i / SEG - 0.5) * W, 0, AMP * Math.sin((i / SEG) * 2 * 2 * Math.PI)]);
  const S = polylineLength(profile);

  it('寬 = 側面形狀的弧長（不是弦長 14 m），高 = 擠出的距離；擠出方向 = Y；變形 0 %', () => {
    const a = analyzeObject(obj(wavePrim(W, H, AMP, 2, SEG)), FRONT);
    expect(a.kind).toBe('ok');
    const p = a.pieces[0];
    expect(p.kind).toBe('ext');
    expect(p.widthU).toBeCloseTo(S, 9);
    expect(S).toBeGreaterThan(W * 1.1);   // 波浪的弧長明顯比弦長長
    expect(p.heightU).toBeCloseTo(H, 9);
    expect(Math.abs(p.ext!.axis[1])).toBeCloseTo(1, 9);
    expect(p.ext!.profileVertical).toBe(false);
    expect(p.distortion.max).toBeLessThan(1e-9);
    expect(distortionLevel(p.distortion)).toBe('ok');
    expect(p.facing).toBeGreaterThan(0.9);
  });

  it('每個頂點的 lx == 沿折線的累積長度 / 全長（弧長均勻，不是 x 座標均勻）；ly 從上到下', () => {
    const g = obj(wavePrim(W, H, AMP, 2, SEG));
    const a = analyzeObject(g, FRONT);
    const as = assignVertices(g.prims[0], a.pieces);
    // wavePrim 每個 i 有兩個頂點（y = 0、y = H）
    let cum = 0;
    for (let i = 0; i <= SEG; i++) {
      if (i > 0) cum += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][2] - profile[i - 1][2]);
      for (const [v, ly] of [[i * 2, 1], [i * 2 + 1, 0]] as const) {   // y = 0 在下面（ly = 1），y = H 在上面（ly = 0）
        expect(as.lx[v]).toBeCloseTo(cum / S, 9);
        expect(as.ly[v]).toBeCloseTo(ly, 9);
        expect(as.dist[v]).toBeLessThan(1e-6);
      }
    }
  });

  it('extPoint ↔ extLocal 來回一致；折線以外的點夾到端點', () => {
    const p = analyzeObject(obj(wavePrim(W, H, AMP, 2, SEG)), FRONT).pieces[0];
    for (const [lx, ly] of [[0, 0], [0.25, 0.5], [0.5, 1], [0.77, 0.123], [1, 1]]) {
      const w = extPoint(p.ext!, lx, ly);
      const r = extLocal(p.ext!, w[0], w[1], w[2]);
      expect(r.lx).toBeCloseTo(lx, 9);
      expect(r.ly).toBeCloseTo(ly, 9);
      expect(r.dist).toBeLessThan(1e-9);
    }
    const far = extLocal(p.ext!, 100, 0, 0);
    expect(far.lx).toBeCloseTo(1, 9);
    expect(far.dist).toBeGreaterThan(80);
  });

  it('不會左右 / 上下反：每個三角形獨立檢查（凸向觀眾、鏡像節點、斜著的牆、轉了 180 度背對觀眾也是站在法線那一側看）', () => {
    for (const g of [
      obj(wavePrim(W, H, AMP, 2, SEG)),
      obj(mirroredX(wavePrim(W, H, AMP, 2, SEG))),
      obj(moved(wavePrim(W, H, AMP, 2, SEG), X, 20, [0, 1, 0])),
      obj(moved(wavePrim(W, H, AMP, 2, SEG), Y, 180, [0, 0, 0])),
      obj(moved(wavePrim(W, H, AMP, 2, SEG), Y, 35, [3, 0, 0])),
    ]) {
      const { prim } = layout(g);
      const chk = uvReadingCheck(prim, CANVAS.width, CANVAS.height);
      expect(chk.checked).toBeGreaterThan(50);
      expect(chk.bad).toBe(0);
    }
  });

  it('一個 LED 點 ↔ 一個畫布像素：弧長 S 切成 W 點，第 i 點的中心（沿折線 (i+0.5)·S/W、高度 (j+0.5)·H/Hp）內插出來剛好是 排好的位置 + (i+0.5, j+0.5)', () => {
    const g = obj(wavePrim(W, H, AMP, 2, SEG));
    const { prim } = layout(g);
    const cols = PLACED.w, rows = PLACED.h;
    let checked = 0;
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [cols - 1, rows - 1], [Math.floor(cols / 2), 100], [cols - 2, 3], [137, rows - 1], [733, 250]]) {
      const base = pointOnPolyline(profile, ((i + 0.5) / cols) * S);
      const y = H - ((j + 0.5) / rows) * H;      // 畫面上方 = 世界朝上，j 從上往下
      const px = uvPixelAt(prim, [base[0], y, base[2]]);
      expect(px, `${i},${j}`).not.toBeNull();
      expect(px![0]).toBeCloseTo(PLACED.x + i + 0.5, 4);
      expect(px![1]).toBeCloseTo(PLACED.y + j + 0.5, 4);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it('折角（V 形、兩片各 6 m）：展開 = 12 m，不是投影的寬度；沿 X 擠出的垂直波浪（側面形狀在畫面上是上下）方向也對、寬高對調', () => {
    const fold = obj(gridPrim([-6, 0, 0], X, Y, 6, 3), gridPrim([0, 0, 0], [1, 0, -0.6], Y, 6, 3));
    const f = layout(fold);
    expect(f.piece.kind).toBe('ext');
    expect(f.piece.widthU).toBeCloseTo(12, 9);
    expect(f.piece.heightU).toBeCloseTo(3, 9);
    expect(uvReadingCheck(f.prim, CANVAS.width, CANVAS.height).bad).toBe(0);

    // 垂直的波浪：側面形狀在 YZ 平面（沿 Y 走、z 起伏），沿 X 擠出 6 m；法線朝 +Z 側
    const prof: [number, number][] = Array.from({ length: 25 }, (_, i) => [i * 0.25, 0.3 * Math.sin(i * 0.5)]);
    const mk = (flip: boolean) => obj(extrudePrim(prof, Y, Z, X, 6, 3, flip));
    const g = analyzeObject(mk(false), FRONT).pieces[0]?.facing > 0 ? mk(false) : mk(true);
    const v = layout(g);
    expect(v.piece.kind).toBe('ext');
    expect(v.piece.ext!.profileVertical).toBe(true);
    expect(v.piece.widthU).toBeCloseTo(6, 9);                                 // 擠出方向是畫面左右
    const plen = polylineLength(prof.map(([a, b]) => [0, a, b] as Vec3));
    expect(v.piece.heightU).toBeCloseTo(plen, 9);                            // 側面形狀是畫面上下
    const chk = uvReadingCheck(v.prim, CANVAS.width, CANVAS.height);
    expect(chk.checked).toBeGreaterThan(50);
    expect(chk.bad).toBe(0);
  });

  it('躺著的波浪（地屏）：畫面上方 = 舞台後方，右邊 = 觀眾席的右邊', () => {
    // 側面形狀在 XY 平面（x 走、y 起伏 5 cm），沿 Z 擠出 4 m：法線朝上
    const prof: [number, number][] = Array.from({ length: 41 }, (_, i) => [-6 + i * 0.3, 0.05 * Math.sin(i * 0.6)]);
    const mk = (flip: boolean) => obj(moved(extrudePrim(prof, X, Y, Z, 4, 2, flip), Y, 0, [0, 0, -2]));
    const up = (g: ObjectGeom) => analyzeObject(g, FRONT).pieces[0]?.frame.normal[1] ?? 0;
    const g = up(mk(false)) > 0 ? mk(false) : mk(true);
    const a = analyzeObject(g, FRONT);
    expect(a.kind).toBe('ok');
    const p = a.pieces[0];
    expect(p.kind).toBe('ext');
    expect(dot(p.frame.down, FRONT)).toBeGreaterThan(0.99);   // 畫面往下 = 朝觀眾，所以上方 = 舞台後方
    expect(p.frame.right[0]).toBeGreaterThan(0.99);           // 畫面往右 = +X（觀眾席看過去的右邊）
  });

  it('不是擠出的面（圓錐）不會被當成擠出：變形百分比不收太高的', () => {
    const cone = conePrim(6, 2, 120, 3, 36);
    const r = fitExtrusion({
      tri: Float64Array.from({ length: 0 }), triN: Float64Array.from({ length: 0 }), triArea: Float64Array.from({ length: 0 }), front: FRONT,
    });
    expect(r.ok).toBe(false);
    expect(analyzeObject(obj(cone), FRONT).pieces[0].kind).toBe('free');
  });
});

describe('整圈 360 度的圓柱：接縫在背對觀眾的那一側，可以轉，接縫上的頂點拆成兩個', () => {
  const R = 3, HEIGHT = 2;
  const ringAngles = (startDeg: number, seg: number) => Array.from({ length: seg }, (_, i) => startDeg + (i * 360) / seg);

  it('預設接縫在背面（舞台後方 -Z）：貼到最近的一排頂點；畫面正中間在正面；弧長 = 2πR', () => {
    for (const startDeg of [0, 7, 20]) {
      const { piece } = layout(obj(tubePrim(R, HEIGHT, 24, 2, startDeg)));
      const arc = piece.arc!;
      expect(arc.closed).toBe(true);
      expect(piece.widthU).toBeCloseTo(2 * Math.PI * R, 9);
      expect(piece.heightU).toBeCloseTo(HEIGHT, 9);
      expect(Math.abs(arc.seamDeg)).toBeLessThanOrEqual(7.5 + 1e-6);   // 15 度一格，最多差半格
      const seam = arcPoint(arc, 0, 0.5);
      expect(seam[2]).toBeLessThan(-R * Math.cos(7.6 * D2R) + 1e-6);   // 在 -Z 那一側
      const mid = arcPoint(arc, 0.5, 0.5);
      expect(mid[2]).toBeGreaterThan(R * Math.cos(7.6 * D2R) - 1e-6);  // 畫面中間在觀眾這一側
      // 接縫真的落在一排頂點的角度上（tubePrim 的約定：x = sin a、z = cos a）
      const a = (Math.atan2(seam[0], seam[2]) * 180) / Math.PI;
      const dist = Math.min(...ringAngles(startDeg, 24).map(r => Math.abs((((a - r) % 360) + 540) % 360 - 180 - 180 + 360) % 360));
      expect(Math.min(dist, 360 - dist)).toBeLessThan(1e-6);
    }
  });

  it('接縫往觀眾的右手邊（+X）轉 90 度：接縫跑到右側；往左轉 -90：左側；轉的角度貼到最近的一排頂點', () => {
    const right = layout(obj(tubePrim(R, HEIGHT, 24, 2, 0)), 'auto', 90).piece.arc!;
    expect(right.seamDeg).toBeCloseTo(90, 6);
    const pr = arcPoint(right, 0, 0.5);
    expect(pr[0]).toBeCloseTo(R, 6);
    expect(Math.abs(pr[2])).toBeLessThan(1e-6);
    const left = layout(obj(tubePrim(R, HEIGHT, 24, 2, 0)), 'auto', -90).piece.arc!;
    expect(left.seamDeg).toBeCloseTo(-90, 6);
    expect(arcPoint(left, 0, 0.5)[0]).toBeCloseTo(-R, 6);
    const snapped = layout(obj(tubePrim(R, HEIGHT, 24, 2, 0)), 'auto', 20).piece.arc!;   // 20 度 → 貼到 15 度那排
    expect(snapped.seamDeg).toBeCloseTo(15, 6);
    // 畫面還是左右不反：中間永遠對著觀眾那一側的正對面（接縫的對面）
    expect(arcPoint(right, 0.5, 0.5)[0]).toBeCloseTo(-R, 6);
  });

  it('拆接縫：接縫上每一排頂點多一個複本（位置一樣、UV 差一整圈）；沒有任何三角形的 UV 跨過整張圖；UV 都在長方形裡', () => {
    const ROWS = 3, SEG = 24;
    const g = obj(tubePrim(R, HEIGHT, SEG, ROWS, 0));
    const { r, prim, piece } = layout(g);
    expect(piece.arc!.closed).toBe(true);
    expect(r.split).toBeDefined();
    expect(r.split!.origin.length).toBe(ROWS + 1);                      // 接縫上共 ROWS + 1 個頂點
    expect(r.uv.length / 2).toBe(SEG * (ROWS + 1) + ROWS + 1);
    const nv = g.prims[0].pos.length / 3;
    r.split!.origin.forEach((o, j) => {
      for (let k = 0; k < 3; k++) expect(prim.pos[(nv + j) * 3 + k]).toBe(g.prims[0].pos[o * 3 + k]);   // 位置一模一樣
      expect(Math.abs(r.uv[(nv + j) * 2] - r.uv[o * 2]) * CANVAS.width).toBeCloseTo(PLACED.w, 3);       // UV 差一整個寬度
    });
    // 沒有三角形橫跨整張圖
    for (let t = 0; t + 2 < prim.index.length; t += 3) {
      const us = [0, 1, 2].map(k => r.uv[prim.index[t + k] * 2] * CANVAS.width);
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(PLACED.w / 2);
    }
    for (let v = 0; v < r.uv.length; v += 2) {
      expect(r.uv[v] * CANVAS.width).toBeGreaterThanOrEqual(PLACED.x - 1e-3);
      expect(r.uv[v] * CANVAS.width).toBeLessThanOrEqual(PLACED.x + PLACED.w + 1e-3);
    }
    // 沒拆的三角形索引不變
    let same = 0;
    for (let c = 0; c < g.prims[0].index.length; c++) if (prim.index[c] === g.prims[0].index[c]) same++;
    expect(same).toBeGreaterThan(g.prims[0].index.length - 3 * 2 * ROWS - 1);
    expect(piece.distortion.max).toBeLessThan(1e-9);
  });

  it('不會左右 / 上下反：凸、凹、接縫轉到別處、鏡像節點，每個三角形都對', () => {
    for (const [g, seam] of [
      [obj(tubePrim(R, HEIGHT, 24, 2, 0)), 0],
      [obj(tubePrim(R, HEIGHT, 24, 2, 0, true)), 0],
      [obj(tubePrim(R, HEIGHT, 24, 2, 0)), 90],
      [obj(tubePrim(R, HEIGHT, 24, 2, 0, true)), -60],
      [obj(mirroredX(tubePrim(R, HEIGHT, 24, 2, 0))), 0],
      [obj(moved(tubePrim(R, HEIGHT, 36, 3, 11), Y, 40, [2, 0, -1])), 30],
    ] as const) {
      const { prim } = layout(g, 'auto', seam);
      const chk = uvReadingCheck(prim, CANVAS.width, CANVAS.height);
      expect(chk.checked).toBeGreaterThan(40);
      expect(chk.bad).toBe(0);
    }
  });

  it('一個 LED 點 ↔ 一個畫布像素（獨立算角度、找三角形）：凸的往觀眾右手邊 = 角度增加；凹的（觀眾在圓柱裡面看）相反；跨過接縫的兩側分別落在長方形的兩端', () => {
    const SEG = 36;
    for (const concave of [false, true]) {
      const g = obj(tubePrim(R, HEIGHT, SEG, 3, 0, concave));
      const { prim, piece } = layout(g);
      const seamAngle = ((Math.atan2(arcPoint(piece.arc!, 0, 0.5)[0], arcPoint(piece.arc!, 0, 0.5)[2]) * 180) / Math.PI + 360) % 360;
      expect(Math.abs(seamAngle - 180)).toBeLessThan(5.1);      // 接縫在背面（180 度 = -Z）附近
      let checked = 0;
      for (const i of [0, 1, 5, 211, 500, 777, 998, 999]) {
        const f = (i + 0.5) / PLACED.w;                                       // 沿一圈的比例（從接縫算起）
        const a = ((seamAngle + (concave ? -1 : 1) * f * 360) % 360 + 360) % 360;   // 凸：往右 = 角度增加；凹：往右 = 角度減少
        const P: Vec3 = [R * Math.sin(a * D2R), 1.0, R * Math.cos(a * D2R)];
        // 圓柱面是折面（24 格），算點要落在三角形的平面上：沿兩條邊用折線的方式找（取相鄰兩排頂點的弦上，同樣用弧長比例）
        const step = 360 / SEG;
        const a0 = Math.floor(a / step) * step, a1 = a0 + step;
        const t = (a - a0) / step;
        const P0: Vec3 = [R * Math.sin(a0 * D2R), 1.0, R * Math.cos(a0 * D2R)], P1: Vec3 = [R * Math.sin(a1 * D2R), 1.0, R * Math.cos(a1 * D2R)];
        const onChord: Vec3 = [P0[0] + (P1[0] - P0[0]) * t, 1.0, P0[2] + (P1[2] - P0[2]) * t];
        void P;
        const px = uvPixelAt(prim, onChord);
        expect(px, `i=${i}`).not.toBeNull();
        // 弦上的比例 t 對應的是角度均勻，不是弧長均勻；格子是弦：UV 在一格內是線性的 → 預測值 = 這一格兩端 UV 的線性內插
        // 凸：角度增加 = 往右，比例 f = (a - 接縫) / 360；凹：f = (接縫 - a) / 360。接縫那一排頂點在三角形的哪一邊要看三角形在接縫的哪一側，所以從不在接縫上的那一端算起
        const fOf = (ang: number) => ((((concave ? seamAngle - ang : ang - seamAngle) % 360) + 360) % 360) / 360;
        const fa0 = concave ? fOf(a1) + step / 360 : fOf(a0);
        const fa1 = concave ? fOf(a1) : fa0 + step / 360;
        const expected = PLACED.x + (fa0 + (fa1 - fa0) * t) * PLACED.w;
        expect(px![0]).toBeCloseTo(expected, 3);
        expect(px![1]).toBeCloseTo(PLACED.y + (1 - 1.0 / HEIGHT) * PLACED.h, 3);   // 高度 1 m（一半）→ 畫面正中間
        checked++;
      }
      expect(checked).toBe(8);
    }
  });

  it('整圈但不是正圓（橢圓柱）→ 說明白，不亂貼', () => {
    const oval = tubePrim(3, 2, 24, 2, 0);
    for (let i = 0; i < oval.pos.length; i += 3) oval.pos[i] *= 1.6;
    const a = analyzeObject(obj(oval), FRONT);
    expect(a.kind).toBe('unsupported');
    expect(UNSUPPORTED_TEXT[a.unsupported!]).toBeTruthy();
  });

  it('describeObject 帶著接縫位置走（worker 重新分析、套用都用同一個設定）', () => {
    const g = obj(tubePrim(R, HEIGHT, 24, 2, 0));
    const old = { width: 8800, height: 2024 };
    expect(describeObject(g, FRONT, old).pieces[0].arc!.seamDeg).toBeCloseTo(0, 6);
    expect(describeObject(g, FRONT, old, 'auto', 45).pieces[0].arc!.seamDeg).toBeCloseTo(45, 6);
    expect(arcLocal(describeObject(g, FRONT, old, 'auto', 45).pieces[0].arc!, 0, 0, 0).seam).toBeUndefined();
  });
});

describe('自由曲面：LSCM（保角攤平），變形百分比照實算', () => {
  it('圓錐（可以攤平）：0 變形，寬 / 高是展開後的大小；方向不反（斜放也是）', () => {
    for (const g of [
      obj(conePrim(5, 3, 90, 3)),
      obj(mirroredX(conePrim(5, 3, 90, 3))),
      obj(moved(conePrim(5, 3, 90, 3), X, 25, [0, 0, 0])),
      obj(moved(conePrim(6, 2, 120, 3, 36), Y, 30, [1, 0, 0])),
    ]) {
      const { piece, prim } = layout(g);
      expect(piece.kind).toBe('free');
      expect(piece.distortion.max).toBeLessThan(1e-6);
      expect(distortionLevel(piece.distortion)).toBe('ok');
      expect(piece.free!.flippedRatio).toBe(0);
      const chk = uvReadingCheck(prim, CANVAS.width, CANVAS.height);
      expect(chk.checked).toBeGreaterThan(50);
      expect(chk.bad).toBe(0);
    }
    // 圓錐展開成扇形：母線長 sqrt(2² + 3²)，高度方向等於母線長
    const c = layout(obj(conePrim(5, 3, 90, 3))).piece;
    const slant = Math.hypot(5 - 3, 3);
    expect(c.free!.vlx.length).toBeGreaterThan(10);
    expect(Math.max(c.widthU, c.heightU)).toBeGreaterThan(slant);
  });

  it('馬鞍面（不能攤平）：有變形，照實算，不是 0 也不是整片紅；每個頂點 lx / ly 在 0~1', () => {
    const { piece, prim } = layout(obj(saddlePrim(10, 4, 0.04, 12)));
    expect(piece.kind).toBe('free');
    expect(piece.distortion.max).toBeGreaterThan(DISTORTION_OK);
    expect(piece.distortion.mean).toBeLessThan(DISTORTION_WARN);
    expect(piece.free!.vlx.every(v => v >= -1e-9 && v <= 1 + 1e-9)).toBe(true);
    expect(piece.free!.vly.every(v => v >= -1e-9 && v <= 1 + 1e-9)).toBe(true);
    expect(uvReadingCheck(prim, CANVAS.width, CANVAS.height).bad).toBe(0);
  });

  it('freeLocal：網格頂點回到自己的位置；離網格的點取最近的；大網格用格子找也一樣', () => {
    const g = saddlePrim(10, 4, 0.04, 40);          // 3200 個三角形
    const a = analyzeObject(obj(g), FRONT, 'free');
    expect(a.kind).toBe('ok');
    const m = a.pieces[0].free!;
    expect(m.vpos.length / 3).toBe((40 + 1) * (40 + 1));
    for (let c = 0; c < m.vpos.length / 3; c += 17) {
      const r = freeLocal(m, m.vpos[c * 3], m.vpos[c * 3 + 1], m.vpos[c * 3 + 2]);
      expect(r.dist).toBeLessThan(1e-9);
      expect(r.lx).toBeCloseTo(m.vlx[c], 9);
      expect(r.ly).toBeCloseTo(m.vly[c], 9);
    }
    // 兩個頂點中間的點 = 兩個頂點的平均（重心座標內插）
    const mid = freeLocal(m, (m.vpos[0] + m.vpos[3]) / 2, (m.vpos[1] + m.vpos[4]) / 2, (m.vpos[2] + m.vpos[5]) / 2);
    expect(mid.lx).toBeCloseTo((m.vlx[0] + m.vlx[1]) / 2, 9);
    expect(mid.ly).toBeCloseTo((m.vly[0] + m.vly[1]) / 2, 9);
    // 曲面上方 2 m 的點：最近的點在斜坡上，距離比 2 m 短一點點
    const above = freeLocal(m, g.pos[0], g.pos[1], g.pos[2] + 2);
    expect(above.dist).toBeLessThan(2 + 1e-9);
    expect(above.dist).toBeGreaterThan(1.9);
    expect(above.lx).toBeGreaterThanOrEqual(0);
    expect(above.lx).toBeLessThan(0.05);
  });

  it('平面硬指定「自由曲面」：攤出來還是一模一樣的長方形、0 變形、方向對', () => {
    const { piece, prim } = layout(obj(gridPrim([-6, 0, 0], X, Y, 12, 4, 6)), 'free');
    expect(piece.kind).toBe('free');
    expect(piece.widthU).toBeCloseTo(12, 6);
    expect(piece.heightU).toBeCloseTo(4, 6);
    expect(piece.distortion.max).toBeLessThan(1e-6);
    expect(uvReadingCheck(prim, CANVAS.width, CANVAS.height).bad).toBe(0);
  });

  it('攤不平的：整顆球、有洞的曲面、繞向不一致 → 說明白（不亂貼），並估硬貼會變形多少', () => {
    const ball = analyzeObject(obj(spherePrim(3, 12)), FRONT);
    expect(ball.unsupported).toBe('freefail');
    expect(ball.freeform).toBeDefined();
    const holey = saddlePrim(10, 4, 0.04, 8);
    const idx = Array.from(holey.index);
    idx.splice(2 * 3 * (4 * 8 + 4), 12);       // 中間挖掉 4 個三角形
    const withHole = analyzeObject(obj({ ...holey, index: Uint32Array.from(idx) }), FRONT);
    expect(withHole.kind).toBe('unsupported');
    expect(withHole.unsupported).toBe('freefail');
    const mixed = saddlePrim(10, 4, 0.04, 8);
    for (const t of [20, 21, 22]) { const a = mixed.index[t * 3 + 1]; mixed.index[t * 3 + 1] = mixed.index[t * 3 + 2]; mixed.index[t * 3 + 2] = a; }
    expect(analyzeObject(obj(mixed), FRONT).unsupported).toBe('freefail');
    const r = fitFreeform({ vpos: new Float64Array(9), tri: Int32Array.from([0, 1, 2]), front: FRONT });
    expect(r.ok).toBe(false);
  });
});

describe('原本不支援的 override 與分類順序', () => {
  it('順序：平面 → 弧面（含整圈）→ 擠出 → 自由曲面；指定「自由曲面」跳過平面和弧面', () => {
    const kinds = (g: ObjectGeom, o: 'auto' | 'free' = 'auto'): string => analyzeObject(g, FRONT, o).pieces[0].kind;
    expect(kinds(obj(gridPrim([-6, 0, 0], X, Y, 12, 4, 6)))).toBe('flat');
    expect(kinds(obj(arcPrim(5, 90, 3, 24)))).toBe('arc');
    expect(kinds(obj(arcPrim(5, 90, 3, 24)), 'free')).toBe('ext');       // 圓弧也是擠出的面
    expect(kinds(obj(tubePrim(3, 2, 24, 2)))).toBe('arc');
    expect(kinds(obj(wavePrim(14, 3, 0.8, 2)))).toBe('ext');
    expect(kinds(obj(conePrim(5, 3, 90, 3)))).toBe('free');
    const forced = analyzeObject(obj(wavePrim(14, 3, 0.8, 2)), FRONT, 'free').pieces[0] as Piece;
    expect(forced.forced).toBe(true);
  });
});
