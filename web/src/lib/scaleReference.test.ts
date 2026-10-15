import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  canStandOnCategory, deckFootprint, defaultFigureSpots, figureSpotsFromExtent, findDeckLevel, frontAxes, gridCenter,
  pickFigureSpots, pickStandingY, type FaceSet,
} from './scaleReference';
import { buildWalkMesh, disposeWalkMesh, extractUpFaces, hitNormalY, standingYAt, surfaceSignature } from './scaleReferenceScene';

const box = (minX: number, maxX: number, minZ: number, maxZ: number, minY = 0, maxY = 5) =>
  ({ min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } });

/** 水平的長方形（朝上）= 兩個三角形 */
function faceSet(rects: Array<[x0: number, x1: number, z0: number, z1: number, y: number]>): FaceSet {
  const verts: number[] = [], areas: number[] = [];
  for (const [x0, x1, z0, z1, y] of rects) {
    verts.push(x0, y, z0, x0, y, z1, x1, y, z1);
    verts.push(x0, y, z0, x1, y, z1, x1, y, z0);
    const half = ((x1 - x0) * (z1 - z0)) / 2;
    areas.push(half, half);
  }
  return { count: areas.length, verts, areas };
}

describe('pickFigureSpots：站在舞台正面那一側', () => {
  it('正面朝 +Z：左 / 中 / 右三個，靠前緣但往內縮，左右對稱', () => {
    const spots = pickFigureSpots(box(-10, 10, -6, 6), { x: 0, z: 1 }, 1);
    expect(spots.map(s => s.slot)).toEqual(['left', 'center', 'right']);
    const [l, c, r] = spots;
    // 觀眾在 +Z 面向舞台，他的右手邊是 +X
    expect(l.x).toBeLessThan(c.x);
    expect(c.x).toBeLessThan(r.x);
    expect(c.x).toBeCloseTo(0, 6);
    expect(l.x).toBeCloseTo(-r.x, 6);
    // 前緣 z = 6：離前緣 0.5 ~ 1.5 m 之間
    for (const s of spots) {
      expect(s.z).toBeLessThan(6 - 0.5 + 1e-9);
      expect(s.z).toBeGreaterThan(6 - 1.5 - 1e-9);
      expect(s.x).toBeGreaterThanOrEqual(-10);
      expect(s.x).toBeLessThanOrEqual(10);
    }
    expect(l.z).toBeCloseTo(c.z, 6);
  });

  it('正面朝 -Z：站在 -Z 那一側，觀眾的右手邊變成 -X', () => {
    const [l, c, r] = pickFigureSpots(box(-10, 10, -6, 6), { x: 0, z: -1 }, 1);
    for (const s of [l, c, r]) expect(s.z).toBeLessThan(-4);
    expect(l.x).toBeGreaterThan(c.x);
    expect(c.x).toBeGreaterThan(r.x);
  });

  it('正面朝 +X（斜的也行）：站在 +X 那一側，沿著 Z 排開', () => {
    const [l, c, r] = pickFigureSpots(box(-8, 8, -12, 12), { x: 3, z: 0 }, 1);
    for (const s of [l, c, r]) expect(s.x).toBeGreaterThan(5);
    // 觀眾在 +X 面向 -X，右手邊是 -Z
    expect(l.z).toBeGreaterThan(c.z);
    expect(c.z).toBeGreaterThan(r.z);
    const diag = pickFigureSpots(box(-8, 8, -8, 8), { x: 1, z: 1 }, 1);
    for (const s of diag) expect(s.x + s.z).toBeGreaterThan(8);  // 靠 +X +Z 的角那一側
  });

  it('前後左右的距離跟著 unitsPerMeter 走（校準後）', () => {
    const a = pickFigureSpots(box(-10, 10, -6, 6), { x: 0, z: 1 }, 1);
    const b = pickFigureSpots(box(-1000, 1000, -600, 600), { x: 0, z: 1 }, 100);
    // 舞台大 100 倍、1 m = 100 單位：離前緣仍然是 0.5 ~ 1.5 m
    expect(600 - b[1].z).toBeGreaterThanOrEqual(0.5 * 100 - 1e-6);
    expect(600 - b[1].z).toBeLessThanOrEqual(1.5 * 100 + 1e-6);
    expect(a[2].x - a[1].x).toBeLessThanOrEqual(8 + 1e-9);
    expect(b[2].x - b[1].x).toBeLessThanOrEqual(8 * 100 + 1e-6);
  });

  it('很小的舞台：三個人還是在外框裡面', () => {
    const spots = pickFigureSpots(box(-0.5, 0.5, -0.3, 0.3), { x: 0, z: 1 }, 1);
    for (const s of spots) {
      expect(s.x).toBeGreaterThanOrEqual(-0.5 - 1e-9);
      expect(s.x).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(s.z).toBeGreaterThanOrEqual(-0.3 - 1e-9);
      expect(s.z).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });

  it('正面方向是 0（沒有 LED）→ 當成 +Z；沒偏中心的舞台以外框中心為準', () => {
    const spots = pickFigureSpots(box(20, 40, -6, 6), { x: 0, z: 0 }, 1);
    expect(spots[1].x).toBeCloseTo(30, 6);
    expect(spots[1].z).toBeGreaterThan(4);
    const axes = frontAxes({ x: 0, z: 0 });
    expect([axes.fx, axes.fz, axes.rx]).toEqual([0, 1, 1]);
  });

  it('沒有任何舞台物件的預設位置：左右各 3 m、離原點 1 m', () => {
    const d = defaultFigureSpots(2);
    expect(d.map(s => s.slot)).toEqual(['left', 'center', 'right']);
    expect(d[0]).toMatchObject({ x: -6, z: 2 });
    expect(d[2]).toMatchObject({ x: 6, z: 2 });
  });
});

describe('findDeckLevel：哪一層是舞台面（面積最大的朝上的面）', () => {
  it('舞台地板最大 → 是它，不是最高的桁架 / 屋頂頂面，也不是最低的地面小台階', () => {
    const f = faceSet([
      [-10, 10, -5, 5, 1.2],     // 舞台地板 200 m²
      [-10, 10, 5, 7, 9],        // 桁架頂面 40 m²（比較高）
      [-1, 1, 5, 6, 0],          // 前面地上的台階 2 m²
      [-2, 2, 5, 7, 0.6],        // 台階 8 m²
    ]);
    expect(findDeckLevel(f, 1)).toBeCloseTo(1.2, 6);
  });

  it('高度差一點點的幾塊（地板 2.09、地屏 2.12）算同一層，回傳面積加權平均', () => {
    const f = faceSet([[-10, 10, -5, 5, 2.09], [-10, 10, 5, 7, 2.12], [-4, 4, -9, -5, 6.5]]);
    const level = findDeckLevel(f, 1)!;
    expect(level).toBeGreaterThan(2.09);
    expect(level).toBeLessThan(2.12);
  });

  it('剛好落在兩格交界的地板（1.04 / 1.06）也合在一起看，贏過一塊比較小的整層', () => {
    const f = faceSet([[0, 6, 0, 10, 1.04], [6, 12, 0, 10, 1.06], [0, 10, 12, 20, 3]]);  // 60 + 60 vs 80
    expect(findDeckLevel(f, 1)).toBeCloseTo(1.05, 2);
  });

  it('沒有朝上的面 → null；單位跟著 unitsPerMeter（1 m = 100 單位）', () => {
    expect(findDeckLevel({ count: 0, verts: [], areas: [] }, 1)).toBeNull();
    const f = faceSet([[-1000, 1000, -500, 500, 120], [-1000, 1000, 500, 700, 900]]);
    expect(findDeckLevel(f, 100)).toBeCloseTo(120, 6);
  });
});

describe('deckFootprint：舞台面的前後左右範圍', () => {
  const front = { x: 0, z: 1 };
  it('舞台面那一層的範圍；別的高度的面（桁架、台階）不算', () => {
    const f = faceSet([
      [-10, 10, -5, 5, 1.2],
      [-30, 30, 20, 25, 9],       // 遠處高高的桁架
      [-3, 3, 5, 8, 0.4],         // 前面地上的台階
    ]);
    const fp = deckFootprint(f, 1.2, front, 1)!;
    expect(fp.level).toBe(1.2);
    expect(fp.extent.uMax).toBeCloseTo(5, 1);
    expect(fp.extent.uMin).toBeCloseTo(-5, 1);
    expect(fp.extent.vMin).toBeCloseTo(-10, 1);
    expect(fp.extent.vMax).toBeCloseTo(10, 1);
    expect(fp.center.x).toBeCloseTo(0, 1);
    expect(fp.center.z).toBeCloseTo(0, 1);
    expect(fp.centroid.x).toBeCloseTo(0, 1);
  });

  it('伸出去一小條的走道不會把前緣拉過去（面積加權 2% ～ 98%）', () => {
    const f = faceSet([[-10, 10, -5, 5, 1.2], [-0.25, 0.25, 5, 11, 1.2]]);  // 走道 3 m²（舞台 200 m²）
    const fp = deckFootprint(f, 1.2, front, 1)!;
    expect(fp.extent.uMax).toBeLessThan(5.6);
  });

  it('舞台偏在一邊、正面朝 -Z：前緣在 -Z 那側，站位落在舞台面上', () => {
    const f = faceSet([[20, 40, 10, 30, 2]]);
    const fp = deckFootprint(f, 2, { x: 0, z: -1 }, 1)!;
    expect(fp.center.x).toBeCloseTo(30, 0);
    expect(fp.center.z).toBeCloseTo(20, 0);
    const spots = figureSpotsFromExtent(fp.extent, { x: 0, z: -1 }, 1);
    for (const s of spots) {
      expect(s.z).toBeGreaterThan(10);
      expect(s.z).toBeLessThan(12);   // 前緣是 z = 10，往內 0.5 ~ 1.5 m
      expect(s.x).toBeGreaterThan(20);
      expect(s.x).toBeLessThan(40);
    }
  });

  it('沒有那一層的面 → null', () => {
    expect(deckFootprint(faceSet([[0, 1, 0, 1, 5]]), 1, front, 1)).toBeNull();
  });
});

describe('pickStandingY：站在哪個面上', () => {
  it('幾乎水平朝上的面裡取最高的', () => {
    expect(pickStandingY([
      { y: 0, normalY: 1 }, { y: 1.2, normalY: 0.99 }, { y: 0.6, normalY: 1 },
    ], -5)).toBeCloseTo(1.2);
  });
  it('牆、太斜的面、朝下的面不算（比水平的面還高也不算）', () => {
    expect(pickStandingY([
      { y: 1.2, normalY: 1 }, { y: 3, normalY: 0.3 }, { y: 4, normalY: 0 }, { y: 5, normalY: -1 }, { y: 2, normalY: 0.7 },
    ], -5)).toBeCloseTo(1.2);
  });
  it('一個都沒有 → 用外框最低點', () => {
    expect(pickStandingY([], 0.4)).toBe(0.4);
    expect(pickStandingY([{ y: 2, normalY: 0.1 }], 0.4)).toBe(0.4);
  });
});

describe('gridCenter / 類型', () => {
  it('網格中心 = 舞台正中間，高度 = 中間人形站的地面', () => {
    expect(gridCenter({ x: 10, z: 2 }, 1.2)).toEqual({ x: 10, y: 1.2, z: 2 });
  });
  it('LED、走位點、表演者不當地面，其他可以', () => {
    expect(canStandOnCategory('led_panel')).toBe(false);
    expect(canStandOnCategory('walk_point')).toBe(false);
    expect(canStandOnCategory('performer')).toBe(false);
    for (const c of ['mechanism', 'fixture', 'other', undefined]) expect(canStandOnCategory(c)).toBe(true);
  });
});

describe('真的 3D 物件：抓朝上的面、往下打光線', () => {
  const mesh = (geo: THREE.BufferGeometry, at: [number, number, number], set?: (m: THREE.Mesh) => void) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
    m.position.set(...at);
    set?.(m);
    m.updateMatrixWorld(true);
    return m;
  };

  it('extractUpFaces：一個方塊只有頂面（面積 = 長 × 寬），牆、底面不算', () => {
    const deck = mesh(new THREE.BoxGeometry(20, 1.2, 10), [0, 0.6, 0]);
    const f = extractUpFaces([deck]);
    expect(f.count).toBe(2);
    let area = 0;
    for (let i = 0; i < f.count; i++) area += f.areas[i];
    expect(area).toBeCloseTo(200, 3);
    for (let i = 0; i < f.count; i++) expect(f.verts[9 * i + 1]).toBeCloseTo(1.2, 5);
  });

  it('extractUpFaces：斜 60 度的面不算、緩坡算；鏡像（縮放有負號）的物件頂面照樣朝上', () => {
    const steep = mesh(new THREE.PlaneGeometry(4, 4), [0, 1, 0], m => m.rotateX(-Math.PI / 2 + Math.PI / 3));
    expect(extractUpFaces([steep]).count).toBe(0);
    const gentle = mesh(new THREE.PlaneGeometry(4, 4), [0, 1, 0], m => m.rotateX(-Math.PI / 2 + 0.2));
    expect(extractUpFaces([gentle]).count).toBe(2);
    const mirrored = mesh(new THREE.BoxGeometry(20, 1, 10), [0, 0.5, 0], m => { m.scale.set(-1, 1, 1); });
    const f = extractUpFaces([mirrored]);
    expect(f.count).toBe(2);
    const walk = buildWalkMesh(f)!;
    // 只打正面：繞向要朝上，從上面往下一定打得到、從下面往上打不到
    expect(standingYAt([walk], 3, 0, 10, -1)).toBeCloseTo(1, 6);
    const fromBelow = new THREE.Raycaster(new THREE.Vector3(3, -5, 0), new THREE.Vector3(0, 1, 0)).intersectObject(walk);
    expect(fromBelow.length).toBe(0);
    disposeWalkMesh(walk);
  });

  it('buildWalkMesh：比 maxY 高的面（桁架、屋頂）丟掉，往下打光線站舞台', () => {
    const deck = mesh(new THREE.BoxGeometry(20, 1, 10), [0, 0.5, 0]);
    const roof = mesh(new THREE.BoxGeometry(20, 0.4, 10), [0, 9, 0]);   // 頂面 9.2
    const faces = extractUpFaces([deck, roof]);
    const all = buildWalkMesh(faces)!;
    expect(standingYAt([all], 0, 0, 20, 0)).toBeCloseTo(9.2, 5);
    const capped = buildWalkMesh(faces, 1 + 3.5)!;
    expect(standingYAt([capped], 0, 0, 20, 0)).toBeCloseTo(1, 5);
    expect(buildWalkMesh(faces, -1)).toBeNull();
    disposeWalkMesh(all); disposeWalkMesh(capped);
  });

  it('找出舞台面 → 站位 → 往下打光線：舞台抬高 2.1 m、上面有屋頂和一排小桁架，三個人都站在 2.1 m', () => {
    const deck = mesh(new THREE.BoxGeometry(40, 2.1, 12), [0, 1.05, 0]);
    const roofTruss = mesh(new THREE.BoxGeometry(40, 0.3, 1), [0, 19.5, 5.5]);   // 前緣上方的桁架
    const faces = extractUpFaces([deck, roofTruss]);
    const level = findDeckLevel(faces, 1)!;
    expect(level).toBeCloseTo(2.1, 3);
    const fp = deckFootprint(faces, level, { x: 0, z: 1 }, 1)!;
    const walk = buildWalkMesh(faces, level + 3.5)!;
    const spots = figureSpotsFromExtent(fp.extent, { x: 0, z: 1 }, 1);
    for (const s of spots) {
      expect(standingYAt([walk], s.x, s.z, level + 1, Number.NaN)).toBeCloseTo(2.1, 3);
      expect(s.z).toBeGreaterThan(4);   // 靠前緣（z = 6）
      expect(s.z).toBeLessThan(6);
    }
    disposeWalkMesh(walk);
  });

  it('surfaceSignature：物件移動 / 隱藏後簽名會變，沒動就一樣', () => {
    const a = mesh(new THREE.BoxGeometry(1, 1, 1), [0, 0, 0]);
    const s0 = surfaceSignature([a]);
    expect(surfaceSignature([a])).toBe(s0);
    a.position.y = 2; a.updateMatrixWorld(true);
    const s1 = surfaceSignature([a]);
    expect(s1).not.toBe(s0);
    a.visible = false;
    expect(surfaceSignature([a])).not.toBe(s1);
  });
});

describe('standingYAt：真的 3D 物件往下打光線', () => {
  const mesh = (geo: THREE.BufferGeometry, at: [number, number, number], set?: (m: THREE.Mesh) => void) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
    m.position.set(...at);
    set?.(m);
    m.updateMatrixWorld(true);
    return m;
  };

  it('站在舞台面上（不是原點的地板）：舞台抬高 1.2 m 就站在 1.2 m', () => {
    const deck = mesh(new THREE.BoxGeometry(20, 1.2, 10), [0, 0.6, 0]);
    expect(standingYAt([deck], 3, 1, 20, 0)).toBeCloseTo(1.2, 6);
  });

  it('疊在一起的面取最高的水平面（舞台上再加一層升降台）', () => {
    const deck = mesh(new THREE.BoxGeometry(20, 1, 10), [0, 0.5, 0]);
    const lift = mesh(new THREE.BoxGeometry(4, 1, 4), [0, 1.5, 0]);  // 頂在 y = 2
    expect(standingYAt([deck, lift], 0, 0, 20, 0)).toBeCloseTo(2, 6);
    expect(standingYAt([deck, lift], 8, 0, 20, 0)).toBeCloseTo(1, 6);  // 升降台旁邊還是站在舞台上
  });

  it('光線沒打到東西 → 外框最低點；沒有物件也是', () => {
    const deck = mesh(new THREE.BoxGeometry(2, 1, 2), [0, 0.5, 0]);
    expect(standingYAt([deck], 50, 50, 20, -0.25)).toBe(-0.25);
    expect(standingYAt([], 0, 0, 20, 0.7)).toBe(0.7);
  });

  it('只有斜得太陡的面 → 外框最低點；緩坡可以站', () => {
    const ramp = mesh(new THREE.PlaneGeometry(4, 4), [0, 1, 0], m => m.rotateX(-Math.PI / 2 + Math.PI / 3));
    expect(standingYAt([ramp], 0, 0, 20, 0.2)).toBe(0.2);
    const gentle = mesh(new THREE.PlaneGeometry(4, 4), [0, 1, 0], m => m.rotateX(-Math.PI / 2 + 0.2));
    expect(standingYAt([gentle], 0, 0, 20, 0.2)).toBeGreaterThan(0.9);
  });

  it('從高度 topY 往下打：topY 以上的面（屋頂）打不到', () => {
    const deck = mesh(new THREE.BoxGeometry(20, 1, 10), [0, 0.5, 0]);
    const roof = mesh(new THREE.BoxGeometry(20, 0.4, 10), [0, 9, 0]);
    expect(standingYAt([deck, roof], 0, 0, 20, 0)).toBeCloseTo(9.2, 6);   // 從整個模型上方開始打 = 取最高的水平面
    expect(standingYAt([deck, roof], 0, 0, 5, 0)).toBeCloseTo(1, 6);      // 從舞台面上方開始打 → 站舞台
  });

  it('鏡像過的物件（縮放有負號）、被壓扁的物件，頂面還是朝上', () => {
    const deck = mesh(new THREE.BoxGeometry(20, 1, 10), [0, 0.5, 0], m => { m.scale.set(-1, 1, 1); });
    const hit = new THREE.Raycaster(new THREE.Vector3(2, 10, 0), new THREE.Vector3(0, -1, 0)).intersectObject(deck)[0];
    expect(hitNormalY(hit)).toBeGreaterThan(0.99);
    expect(standingYAt([deck], 2, 0, 10, -1)).toBeCloseTo(1, 6);
  });
});
