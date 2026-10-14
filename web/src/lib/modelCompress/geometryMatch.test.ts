import { describe, expect, it } from 'vitest';
import { matchGeometry, type MatchAttr } from './geometryMatch';

// 一個正方形（兩個三角形）+ UV
const POS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const UV = [0, -1, 1, -1, 1, 0, 0, 0];
const IDX = [0, 1, 2, 0, 2, 3];

function input(posB: number[], uvB: number[], idxB: number[] | null, opts: { tol?: number; triangles?: boolean } = {}) {
  const tol = opts.tol ?? 1e-6;
  const attrs: MatchAttr[] = [
    { name: 'POSITION', kind: 'position', itemSize: 3, tol, a: POS, b: posB },
    { name: 'TEXCOORD_0', kind: 'float', itemSize: 2, tol, a: UV, b: uvB },
  ];
  return { attrs, countA: 4, countB: posB.length / 3, indexA: IDX, indexB: idxB, triangles: opts.triangles ?? true };
}

describe('matchGeometry（壓縮前後的形狀逐點比對）', () => {
  it('完全一樣 → 過', () => {
    const r = matchGeometry(input(POS, UV, IDX));
    expect(r.ok).toBe(true);
    expect(r.trianglesA).toBe(2);
    expect(r.trianglesB).toBe(2);
  });

  it('頂點、三角形順序打亂、三角形的角轉一圈（繞向不變）→ 過', () => {
    // 新順序：3,2,1,0
    const order = [3, 2, 1, 0];
    const posB = order.flatMap(i => POS.slice(i * 3, i * 3 + 3));
    const uvB = order.flatMap(i => UV.slice(i * 2, i * 2 + 2));
    const remap = (i: number) => order.indexOf(i);
    // 原本 (0,1,2)(0,2,3) → 兩個三角形對調、各自轉一個角：(2,3,0)(1,2,0)
    const idxB = [remap(2), remap(3), remap(0), remap(1), remap(2), remap(0)];
    expect(matchGeometry(input(posB, uvB, idxB)).ok).toBe(true);
  });

  it('誤差在容許內 → 過；超過 → 不過', () => {
    const near = POS.slice(); near[3] += 5e-7;
    expect(matchGeometry(input(near, UV, IDX)).ok).toBe(true);
    const far = POS.slice(); far[3] += 5e-6;
    expect(matchGeometry(input(far, UV, IDX)).ok).toBe(false);
    const uvFar = UV.slice(); uvFar[1] += 1e-5;   // 負的 v 改了一點點
    expect(matchGeometry(input(POS, uvFar, IDX)).ok).toBe(false);
  });

  it('面的方向反了 → 不過', () => {
    const r = matchGeometry(input(POS, UV, [0, 2, 1, 0, 2, 3]));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('方向');
  });

  it('少一個三角形 → 不過', () => {
    expect(matchGeometry(input(POS, UV, [0, 1, 2])).ok).toBe(false);
  });

  it('重複頂點被合併、沒有面積的三角形被拿掉（Draco 會這樣）→ 過', () => {
    // A：多一個跟 0 完全一樣的頂點 4，和兩個沒有面積的三角形
    const posA = [...POS, 0, 0, 0];
    const uvA = [...UV, 0, -1];
    const attrs: MatchAttr[] = [
      { name: 'POSITION', kind: 'position', itemSize: 3, tol: 1e-6, a: posA, b: POS },
      { name: 'TEXCOORD_0', kind: 'float', itemSize: 2, tol: 1e-6, a: uvA, b: UV },
    ];
    const r = matchGeometry({ attrs, countA: 5, countB: 4, indexA: [0, 1, 2, 4, 2, 3, 1, 1, 2, 0, 4, 3], indexB: IDX, triangles: true });
    expect(r.ok).toBe(true);
    expect(r.degenerateA).toBe(2);
    expect(r.degenerateB).toBe(0);
  });

  it('同位置但 UV 不同（UV 接縫）不會被當成同一個頂點', () => {
    const posA = [...POS, 1, 0, 0];      // 4 跟 1 同位置
    const uvA = [...UV, 0.5, 0.5];       // UV 不一樣
    const attrs: MatchAttr[] = [
      { name: 'POSITION', kind: 'position', itemSize: 3, tol: 1e-6, a: posA, b: posA },
      { name: 'TEXCOORD_0', kind: 'float', itemSize: 2, tol: 1e-6, a: uvA, b: uvA },
    ];
    // B 把三角形改用 4 取代 1 → UV 不同 → 不過
    const r = matchGeometry({ attrs, countA: 5, countB: 5, indexA: [0, 1, 2, 0, 2, 3], indexB: [0, 4, 2, 0, 2, 3], triangles: true });
    expect(r.ok).toBe(false);
  });

  it('法線比方向（長度不同沒關係），方向差太多 → 不過', () => {
    const nA = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const nB = [0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2];
    const mk = (b: number[]) => ({
      attrs: [
        { name: 'POSITION', kind: 'position' as const, itemSize: 3, tol: 1e-6, a: POS, b: POS },
        { name: 'NORMAL', kind: 'normal' as const, itemSize: 3, tol: 2e-3, a: nA, b },
      ],
      countA: 4, countB: 4, indexA: IDX, indexB: IDX, triangles: true,
    });
    expect(matchGeometry(mk(nB)).ok).toBe(true);
    expect(matchGeometry(mk([0, 0.1, 1, ...nA.slice(3)])).ok).toBe(false);
  });

  it('壓縮後出現不是數字的值 → 不過', () => {
    const bad = POS.slice(); bad[0] = NaN;
    expect(matchGeometry(input(bad, UV, IDX)).ok).toBe(false);
  });
});
