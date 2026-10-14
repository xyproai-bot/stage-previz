// 比對兩份「形狀」是不是一樣（壓縮前 A、壓縮解開後 B），純計算、不碰 three / gltf-transform。
//
// Draco 解開後頂點的順序會變、完全一樣的頂點會合併、兩個角一樣的三角形（沒有面積）會被拿掉，
// 所以不能一個一個照順序比。做法：
//   1. A 的頂點分群：所有資料（位置、UV、法線…）都在誤差內的頂點算同一群（完全一樣的重複頂點也是）
//   2. B 的每個頂點都要在 A 裡找到一個誤差內的頂點 → 拿那一群的編號（找不到 = 不一樣）
//   3. 兩邊的三角形都換成「群編號」，兩個角同一群、或兩個角位置一樣的跳過（沒有面積、畫不出來），
//      其他的比「同一組三角形、同樣的繞向」：每個三角形算一個雜湊加總（順序無關、繞向有關）
// 找鄰近頂點用格子：格子邊長 = 位置誤差 × 2，每個頂點只要看 8 格。

export type AttrKind = 'position' | 'normal' | 'float' | 'exact';

export interface MatchAttr {
  name: string;
  kind: AttrKind;
  itemSize: number;
  /** 容許誤差（exact 不用） */
  tol: number;
  a: ArrayLike<number>;
  b: ArrayLike<number>;
}

export interface MatchInput {
  /** 第一個要是位置 */
  attrs: MatchAttr[];
  countA: number;
  countB: number;
  indexA: ArrayLike<number> | null;
  indexB: ArrayLike<number> | null;
  /** 三角形（TRIANGLES）才比三角形；點、線只比頂點 */
  triangles: boolean;
  /** 頂點互相比較的總次數上限倍數（見 settings.MATCH_WORK_FACTOR） */
  workFactor?: number;
}

export interface MatchResult {
  ok: boolean;
  reason?: string;
  /** 有面積的三角形數（換成群編號後三個角不同群的） */
  trianglesA: number;
  trianglesB: number;
  /** 被跳過的（兩個角同一群） */
  degenerateA: number;
  degenerateB: number;
  /** 每種資料實際最大誤差 / 容許誤差（< 1 才算過；exact 一律 0） */
  errorRatio: Record<string, number>;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hashCell(ix: number, iy: number, iz: number): number {
  return fmix32(Math.imul(ix | 0, 0x9e3779b1) ^ Math.imul(iy | 0, 0x85ebca77) ^ Math.imul(iz | 0, 0xc2b2ae3d));
}

class TriangleSet {
  count = 0;
  degenerate = 0;
  s1 = 0;
  s2 = 0;
  s3 = 0;
  add(a: number, b: number, c: number) {
    if (a === b || b === c || a === c) { this.degenerate++; return; }
    // 轉到最小的在前面（繞向不變）
    let x = a, y = b, z = c;
    if (b < a && b < c) { x = b; y = c; z = a; } else if (c < a && c < b) { x = c; y = a; z = b; }
    const h1 = fmix32(Math.imul(x, 0x9e3779b1) ^ fmix32(Math.imul(y, 0x7feb352d) ^ fmix32(z ^ 0x68e31da4)));
    const h2 = fmix32((x + 0x632be5ab) ^ fmix32(Math.imul(y, 0x846ca68b) ^ fmix32(Math.imul(z, 0x2c1b3c6d) + 0x297a2d39)));
    this.s1 = (this.s1 + h1) >>> 0;
    this.s2 = (this.s2 + h2) >>> 0;
    this.s3 = (this.s3 + Math.imul(h1, h2 | 1)) >>> 0;
    this.count++;
  }
  same(o: TriangleSet) {
    return this.count === o.count && this.s1 === o.s1 && this.s2 === o.s2 && this.s3 === o.s3;
  }
}

export function matchGeometry(input: MatchInput): MatchResult {
  const { attrs, countA, countB } = input;
  const errorRatio: Record<string, number> = {};
  for (const at of attrs) errorRatio[at.name] = 0;
  const fail = (reason: string): MatchResult => ({ ok: false, reason, trianglesA: 0, trianglesB: 0, degenerateA: 0, degenerateB: 0, errorRatio });

  const pos = attrs[0];
  if (!pos || pos.kind !== 'position' || pos.itemSize !== 3) return fail('沒有位置資料');
  for (const at of attrs) {
    if (at.a.length < countA * at.itemSize || at.b.length < countB * at.itemSize) return fail(`${at.name} 資料長度不對`);
  }
  const PA = pos.a, PB = pos.b;
  const tolP = pos.tol;
  if (!(tolP > 0)) return fail('位置誤差設定不對');
  const cell = tolP * 2;

  // 格子原點：A 的最小值（座標換成格子編號時數字小一點）
  let mx = Infinity, my = Infinity, mz = Infinity;
  for (let i = 0; i < countA; i++) {
    const x = PA[i * 3], y = PA[i * 3 + 1], z = PA[i * 3 + 2];
    if (x < mx) mx = x;
    if (y < my) my = y;
    if (z < mz) mz = z;
  }
  if (!Number.isFinite(mx + my + mz)) {
    if (countA === 0 && countB === 0) return { ok: true, trianglesA: 0, trianglesB: 0, degenerateA: 0, degenerateB: 0, errorRatio };
    return fail('原檔的位置有不是數字的值');
  }

  // A 的頂點放進格子（雜湊桶，CSR 排法）
  let size = 16;
  while (size < countA * 2) size *= 2;
  const mask = size - 1;
  const start = new Int32Array(size + 1);
  const bucketOf = new Int32Array(countA);
  for (let i = 0; i < countA; i++) {
    const b = hashCell(Math.floor((PA[i * 3] - mx) / cell), Math.floor((PA[i * 3 + 1] - my) / cell), Math.floor((PA[i * 3 + 2] - mz) / cell)) & mask;
    bucketOf[i] = b;
    start[b + 1]++;
  }
  for (let b = 0; b < size; b++) start[b + 1] += start[b];
  const fillAt = start.slice(0, size);
  const entries = new Int32Array(countA);
  for (let i = 0; i < countA; i++) entries[fillAt[bucketOf[i]]++] = i;

  const workLimit = (input.workFactor ?? 64) * (countA + countB) + 1_000_000;
  let work = 0;

  /** A 的第 i 個頂點和 src（A 或 B）的第 j 個頂點：所有資料都在誤差內？record = 記錄最大誤差 */
  function close(i: number, fromB: boolean, j: number, record: boolean): boolean {
    for (const at of attrs) {
      const a = at.a, b = fromB ? at.b : at.a, s = at.itemSize;
      const oa = i * s, ob = j * s;
      if (at.kind === 'exact') {
        for (let c = 0; c < s; c++) if (a[oa + c] !== b[ob + c]) return false;
        continue;
      }
      let maxD = 0;
      if (at.kind === 'normal') {
        let la = 0, lb = 0;
        for (let c = 0; c < s; c++) { la += a[oa + c] * a[oa + c]; lb += b[ob + c] * b[ob + c]; }
        la = Math.sqrt(la); lb = Math.sqrt(lb);
        // 原檔法線長度是 0（匯出軟體沒算）→ 畫面上本來就沒有方向，不比
        if (la < 1e-6) continue;
        if (!(lb >= 1e-6)) return false;
        for (let c = 0; c < s; c++) {
          const d = Math.abs(a[oa + c] / la - b[ob + c] / lb);
          if (!(d <= at.tol)) return false;
          if (d > maxD) maxD = d;
        }
      } else {
        for (let c = 0; c < s; c++) {
          const d = Math.abs(a[oa + c] - b[ob + c]);
          if (!(d <= at.tol)) return false;
          if (d > maxD) maxD = d;
        }
      }
      if (record && at.tol > 0) {
        const r = maxD / at.tol;
        if (r > errorRatio[at.name]) errorRatio[at.name] = r;
      }
    }
    return true;
  }

  /** 位置 (x,y,z) 附近（誤差內）的格子裡的 A 頂點，visit 回傳 true 就停 */
  function nearA(x: number, y: number, z: number, visit: (k: number) => boolean): boolean {
    const x0 = Math.floor((x - tolP - mx) / cell), x1 = Math.floor((x + tolP - mx) / cell);
    const y0 = Math.floor((y - tolP - my) / cell), y1 = Math.floor((y + tolP - my) / cell);
    const z0 = Math.floor((z - tolP - mz) / cell), z1 = Math.floor((z + tolP - mz) / cell);
    if (!Number.isFinite(x0 + x1 + y0 + y1 + z0 + z1)) return false;
    let seen0 = -1, seen1 = -1, seen2 = -1, seen3 = -1;
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
      const b = hashCell(ix, iy, iz) & mask;
      // 同一個桶不要掃兩次（不同格子撞到同一個桶）
      if (b === seen0 || b === seen1 || b === seen2 || b === seen3) continue;
      seen3 = seen2; seen2 = seen1; seen1 = seen0; seen0 = b;
      for (let e = start[b]; e < start[b + 1]; e++) {
        work++;
        if (visit(entries[e])) return true;
      }
    }
    return false;
  }

  // 1. A 分群（union-find）
  const parent = new Int32Array(countA);
  for (let i = 0; i < countA; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let i = 0; i < countA; i++) {
    nearA(PA[i * 3], PA[i * 3 + 1], PA[i * 3 + 2], (k) => {
      if (k < i && close(i, false, k, false)) {
        const ri = find(i), rk = find(k);
        if (ri !== rk) parent[ri] = rk;
      }
      return false;
    });
    if (work > workLimit) return fail('太多頂點疊在一起，沒辦法逐點比對');
  }
  const classA = new Int32Array(countA);
  for (let i = 0; i < countA; i++) classA[i] = find(i);

  // 2. B 的每個頂點都要對到 A
  const classB = new Int32Array(countB);
  for (let j = 0; j < countB; j++) {
    let found = -1;
    nearA(PB[j * 3], PB[j * 3 + 1], PB[j * 3 + 2], (k) => {
      if (close(k, true, j, true)) { found = k; return true; }
      return false;
    });
    if (work > workLimit) return fail('太多頂點疊在一起，沒辦法逐點比對');
    if (found < 0) {
      const p = [PB[j * 3], PB[j * 3 + 1], PB[j * 3 + 2]].map(v => +v.toPrecision(7)).join(', ');
      return fail(`壓縮後第 ${j} 個頂點（${p}）在原檔找不到一樣的`);
    }
    classB[j] = classA[found];
  }

  if (!input.triangles) {
    // 點、線：反過來也要每個 A 頂點都對得到 B（用 B 的群編號集合檢查）
    const hit = new Uint8Array(countA);
    for (let j = 0; j < countB; j++) hit[classB[j]] = 1;
    for (let i = 0; i < countA; i++) if (!hit[classA[i]]) return fail(`原檔第 ${i} 個頂點在壓縮後不見了`);
    return { ok: true, trianglesA: 0, trianglesB: 0, degenerateA: 0, degenerateB: 0, errorRatio };
  }

  // 3. 三角形（群編號 + 繞向）
  //    兩個角的位置一樣（誤差內）的三角形沒有面積、畫不出任何東西 → 兩邊都跳過
  //    （Draco 會拿掉這種三角形；LED 對位圖會用到它們的 UV，那部分第二關 verifyScene 會直接比 LED 位置）
  const triA = new TriangleSet(), triB = new TriangleSet();
  const samePos = (P: ArrayLike<number>, i: number, j: number) =>
    Math.abs(P[i * 3] - P[j * 3]) <= tolP && Math.abs(P[i * 3 + 1] - P[j * 3 + 1]) <= tolP && Math.abs(P[i * 3 + 2] - P[j * 3 + 2]) <= tolP;
  const addAll = (set: TriangleSet, cls: Int32Array, P: ArrayLike<number>, index: ArrayLike<number> | null, count: number): string | null => {
    const n = index ? index.length : count;
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = index ? index[t] : t, i1 = index ? index[t + 1] : t + 1, i2 = index ? index[t + 2] : t + 2;
      if (!(i0 < count && i1 < count && i2 < count)) return `三角形的頂點編號超出範圍（${i0}, ${i1}, ${i2}）`;
      if (samePos(P, i0, i1) || samePos(P, i1, i2) || samePos(P, i0, i2)) { set.degenerate++; continue; }
      set.add(cls[i0], cls[i1], cls[i2]);
    }
    return null;
  };
  const errA = addAll(triA, classA, PA, input.indexA, countA);
  if (errA) return fail('原檔' + errA);
  const errB = addAll(triB, classB, PB, input.indexB, countB);
  if (errB) return fail('壓縮後' + errB);
  const res: MatchResult = {
    ok: triA.same(triB),
    trianglesA: triA.count, trianglesB: triB.count,
    degenerateA: triA.degenerate, degenerateB: triB.degenerate,
    errorRatio,
  };
  if (!res.ok) {
    res.reason = triA.count !== triB.count
      ? `三角形數量不一樣（原檔 ${triA.count}、壓縮後 ${triB.count}）`
      : '三角形的組合或面的方向不一樣';
  }
  return res;
}

/** 一組數字（每 itemSize 個一筆）每一軸的範圍、絕對值最大 */
export function attributeExtent(arr: ArrayLike<number>, itemSize: number, count: number): { range: number; maxAbs: number } {
  let range = 0, maxAbs = 0;
  for (let c = 0; c < itemSize; c++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < count; i++) {
      const v = arr[i * itemSize + c];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi >= lo) {
      range = Math.max(range, hi - lo);
      maxAbs = Math.max(maxAbs, Math.abs(lo), Math.abs(hi));
    }
  }
  return { range, maxAbs };
}
