// 自動貼 UV：向量、矩陣、特徵向量（純函式，不碰 three / gltf-transform）

export type Vec3 = [number, number, number];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export const WORLD_UP: Vec3 = [0, 1, 0];

/** 4×4 矩陣（跟 glTF / three 一樣是 16 個數字，一欄一欄排）套在一個點上 */
export function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** 4×4 矩陣左上 3×3 的行列式（負的 = 鏡像過，三角形的繞向會反） */
export function determinant3(m: ArrayLike<number>): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6])
    - m[4] * (m[1] * m[10] - m[9] * m[2])
    + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/**
 * 3×3 對稱矩陣的特徵值、特徵向量（Jacobi 法）。
 * m：[xx, xy, xz, yy, yz, zz]；回傳依特徵值由小到大排，vectors[i] 是 values[i] 的單位向量
 */
export function eigenSym3(m: readonly number[]): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    const diag = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]);
    if (off <= 1e-15 * Math.max(diag, 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const values = order.map(i => a[i][i]) as Vec3;
  const vectors = order.map(i => normalize([v[0][i], v[1][i], v[2][i]])) as [Vec3, Vec3, Vec3];
  return { values, vectors };
}

/** 兩個單位向量的夾角（度） */
export function angleDeg(a: Vec3, b: Vec3): number {
  const d = Math.min(1, Math.max(-1, dot(a, b)));
  return (Math.acos(d) * 180) / Math.PI;
}
