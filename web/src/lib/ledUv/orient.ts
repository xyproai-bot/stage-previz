// 自動貼 UV：轉 90° / 翻轉的組合與反轉（純函式）
//
// 一塊螢幕在畫布上的擺法 = 版型編輯器同一套：先轉（順時針 0 / 90 / 180 / 270）、再翻（左右、上下），共 8 種。
// 螢幕上的位置 (0~1) → 長方形裡的位置 (0~1) 是 localTransform 給的 2×2 矩陣 + 位移；8 種合起來是一個群，
// 所以「轉完再轉」「反過來轉回去」都還是這 8 種之一，這裡用矩陣算再找回是哪一種，不靠查表（查表容易抄錯）。
//   用在：
//   - 整組一起轉 / 翻（組裡每一塊的擺法 = 整組的動作 ∘ 自己原本的擺法）
//   - 舊版面：新排法轉過 / 翻過以後，舊影片貼回去的方向 = 原本的方向 ∘ 新排法的反方向

import { ROTATIONS, localTransform, type LocalTransform, type Rotation } from '../ledTemplate';

export interface Orientation { rotate: Rotation; flipH: boolean; flipV: boolean }

export const IDENTITY_ORIENTATION: Orientation = { rotate: 0, flipH: false, flipV: false };

/**
 * 一塊螢幕只有 8 種不一樣的擺法（轉 × 翻共 16 種寫法，其中一半是重複的：轉 180° 再左右翻 = 上下翻）。
 * 算出來的結果一律用這一份裡最簡單的寫法：先是 4 種純轉動，再是左右翻、上下翻，最後是兩種斜著翻（轉 90° / 270° 再左右翻）。
 */
export const ALL_ORIENTATIONS: readonly Orientation[] = [
  ...ROTATIONS.map(rotate => ({ rotate, flipH: false, flipV: false })),
  { rotate: 0, flipH: true, flipV: false },
  { rotate: 0, flipH: false, flipV: true },
  { rotate: 90, flipH: true, flipV: false },
  { rotate: 270, flipH: true, flipV: false },
];

export const transformOf = (o: Orientation): LocalTransform => localTransform(o.rotate, o.flipH, o.flipV);

/** outer ∘ inner：先做 inner、再做 outer（兩個都是「單位正方形 → 單位正方形」） */
export function composeTransforms(outer: LocalTransform, inner: LocalTransform): LocalTransform {
  const [a, b, c, d] = outer.a, [e, f, g, h] = inner.a;
  return {
    a: [a * e + b * g, a * f + b * h, c * e + d * g, c * f + d * h],
    b: [a * inner.b[0] + b * inner.b[1] + outer.b[0], c * inner.b[0] + d * inner.b[1] + outer.b[1]],
  };
}

export function invertTransform(t: LocalTransform): LocalTransform {
  const [a, b, c, d] = t.a;
  const det = a * d - b * c;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return { a: [ia, ib, ic, id], b: [-(ia * t.b[0] + ib * t.b[1]), -(ic * t.b[0] + id * t.b[1])] };
}

const sameTransform = (p: LocalTransform, q: LocalTransform): boolean =>
  p.a.every((v, i) => Math.abs(v - q.a[i]) < 1e-9) && p.b.every((v, i) => Math.abs(v - q.b[i]) < 1e-9);

/** 矩陣 → 是 8 種擺法的哪一種（正方形轉出來一定對得上；對不上 = null） */
export function orientationOf(t: LocalTransform): Orientation | null {
  for (const o of ALL_ORIENTATIONS) if (sameTransform(transformOf(o), t)) return o;
  return null;
}

/** outer ∘ inner：先 inner、再 outer（畫面上先看到 inner 的樣子，再整個做 outer 這個動作） */
export function composeOrientation(outer: Orientation, inner: Orientation): Orientation {
  return orientationOf(composeTransforms(transformOf(outer), transformOf(inner))) ?? IDENTITY_ORIENTATION;
}

export function invertOrientation(o: Orientation): Orientation {
  return orientationOf(invertTransform(transformOf(o))) ?? IDENTITY_ORIENTATION;
}

export const isIdentity = (o: Orientation): boolean => o.rotate === 0 && !o.flipH && !o.flipV;

/** 90 / 270 度：寬高對調 */
export const swapsAxes = (o: Pick<Orientation, 'rotate'>): boolean => o.rotate === 90 || o.rotate === 270;
