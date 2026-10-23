// 「重置攝影機」的視角：從觀眾那一側、稍微高一點，正對舞台，整個舞台剛好入鏡。
// 觀眾在哪一側 = LED 面朝的方向（LED 只畫正面，面一定朝觀眾）。

import * as THREE from 'three';
import { ledScreenMeshes } from './ledScreen';

const UP = new THREE.Vector3(0, 1, 0);

/** 這些 LED 螢幕三角面的朝向依面積加總（長度 = 面積 ×2，含 y）；LED 物件裡的框架、台體不算 */
function ledFacingSum(ledRoots: THREE.Object3D[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const root of ledRoots) {
    root.updateMatrixWorld(true);
    const screens = ledScreenMeshes(root);
    root.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !screens.has(mesh)) return;
      const pos = mesh.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      const index = mesh.geometry.getIndex();
      const m = mesh.matrixWorld;
      const flip = m.determinant() < 0 ? -1 : 1;  // 鏡像過的物件，面的方向會反
      const count = index ? index.count : pos.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const i0 = index ? index.getX(i) : i;
        const i1 = index ? index.getX(i + 1) : i + 1;
        const i2 = index ? index.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        sum.addScaledVector(ab.cross(ac), flip);  // 長度 = 面積 ×2 → 大面積的 LED 算比較多
      }
    });
  }
  return sum;
}

/** 舞台正面（水平、指向觀眾）：所有 LED 螢幕三角面的朝向依面積加總（LED 物件裡的框架、台體不算）。沒有 LED → +Z */
export function stageFrontDirection(ledRoots: THREE.Object3D[]): THREE.Vector3 {
  const sum = ledFacingSum(ledRoots);
  sum.y = 0;
  if (sum.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1);
  return sum.normalize();
}

/** 面向演出者那一側的 LED（例如場地懸吊的題詞）算「朝向跟舞台正面差不多相反」：水平朝向跟正面的夾角超過這個就排除 */
const FACING_PERFORMER_DOT = -0.35;

/**
 * 主舞台的 LED：排除「面向演出者」的 LED（題詞之類，從觀眾席看是背面，常常懸吊在舞台前方擋住視線）。
 * 看向點、入鏡範圍、舞台正面方向都只用這些。全部都被排除（不會發生）或只有一塊 → 原樣回傳
 */
export function mainLedRoots(ledRoots: THREE.Object3D[]): THREE.Object3D[] {
  if (ledRoots.length < 2) return ledRoots;
  const keep = (front: THREE.Vector3) => ledRoots.filter(r => {
    const n = ledFacingSum([r]);
    n.y = 0;
    if (n.lengthSq() < 1e-12) return true;  // 朝上 / 朝下的（地屏、天屏）沒有水平朝向，留著
    return n.normalize().dot(front) > FACING_PERFORMER_DOT;
  });
  const first = keep(stageFrontDirection(ledRoots));
  if (first.length === 0 || first.length === ledRoots.length) return ledRoots;
  // 用留下來的重算一次正面再篩（題詞面積大時第一次的正面可能偏）
  const second = keep(stageFrontDirection(first));
  return second.length > 0 ? second : first;
}

/** 要入鏡的點：每個 mesh 自己的外框 8 個角（比整個舞台一個大框貼身） */
export function collectFramePoints(roots: THREE.Object3D[]): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb || bb.isEmpty()) return;
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
        points.push(new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
      }
    });
  }
  return points;
}

/**
 * 鏡頭在 target + dir × 距離、看向 target：距離要多遠，points 才全部在畫面裡。
 * margin > 1 → 四周多留一點空
 */
export function fitDistance(
  points: THREE.Vector3[], target: THREE.Vector3, dir: THREE.Vector3,
  vfovDeg: number, aspect: number, margin = 1.06,
): number {
  const z = dir.clone().normalize();
  const x = new THREE.Vector3().crossVectors(UP, z);
  if (x.lengthSq() < 1e-12) x.set(1, 0, 0);  // 正上方往下看
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const tanV = Math.tan(THREE.MathUtils.degToRad(vfovDeg) / 2);
  const tanH = tanV * aspect;
  const rel = new THREE.Vector3();
  let dist = 0;
  for (const p of points) {
    rel.subVectors(p, target);
    const along = rel.dot(z);  // 往鏡頭那邊多近
    dist = Math.max(
      dist,
      along + (margin * Math.abs(rel.dot(x))) / tanH,
      along + (margin * Math.abs(rel.dot(y))) / tanV,
    );
  }
  return dist;
}

/** 正面全景：觀眾那一側、往上抬 elevationDeg 度，整個舞台入鏡
 *  有 LED 就以 LED 為準框（暗場裡看得到的就是 LED；地板 / 結構常常很大但看不見，會讓畫面退太遠） */
export function computeFrontView(
  roots: THREE.Object3D[], ledRoots: THREE.Object3D[],
  vfovDeg: number, aspect: number, elevationDeg = 3,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const mainRoots = mainLedRoots(ledRoots);
  const ledPoints = collectFramePoints(mainRoots);
  const points = ledPoints.length > 0 ? ledPoints : collectFramePoints(roots);
  const target = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  const front = stageFrontDirection(mainRoots);
  const e = THREE.MathUtils.degToRad(elevationDeg);
  const dir = front.clone().multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e)).normalize();
  const dist = points.length > 0 ? fitDistance(points, target, dir, vfovDeg, aspect) : 10;
  return { position: target.clone().addScaledVector(dir, dist), target };
}

export type CameraPreset = 'front' | 'foh' | 'stands' | 'vip';

export interface CameraPresetDef {
  id: CameraPreset;
  label: string;
  hint: string;
}

export const CAMERA_PRESETS: readonly CameraPresetDef[] = [
  { id: 'front', label: '正面全景', hint: '整個舞台剛好入鏡' },
  { id: 'foh', label: '控台', hint: '控台（FOH）位置的平視角度' },
  { id: 'stands', label: '二樓看台', hint: '高角度俯瞰舞台與地屏' },
  { id: 'vip', label: '特區搖滾區', hint: '舞台前排近距離仰角' },
];

/** 控台人坐 / 站在控台後的眼睛高度（離觀眾席地面） */
export const FOH_EYE_HEIGHT = 1.7;
const FOH_DIST_MULT = 1.4;

/** 鏡頭到主 LED 的幾個點，有沒有被 occluders（例如懸吊的題詞）擋住；回傳被擋住的點數 */
export function countBlockedSamples(
  eye: THREE.Vector3, mainRoots: THREE.Object3D[], occluders: THREE.Object3D[],
): number {
  const ray = new THREE.Raycaster();
  let blocked = 0;
  const bb = new THREE.Box3();
  const p = new THREE.Vector3(), dir = new THREE.Vector3();
  const fracs = [0.15, 0.5, 0.85];
  for (const root of mainRoots) {
    const others: THREE.Object3D[] = occluders.filter(r => r !== root);
    if (others.length === 0) continue;
    bb.setFromObject(root);
    if (bb.isEmpty()) continue;
    for (const fx of fracs) for (const fy of fracs) for (const fz of fracs) {
      p.set(
        bb.min.x + (bb.max.x - bb.min.x) * fx,
        bb.min.y + (bb.max.y - bb.min.y) * fy,
        bb.min.z + (bb.max.z - bb.min.z) * fz,
      );
      dir.subVectors(p, eye);
      const len = dir.length();
      if (len < 1e-6) continue;
      ray.set(eye, dir.divideScalar(len));
      ray.far = len;
      let hit = false;
      for (const o of others) {
        // 從背面看過去也要算擋住（題詞面向演出者，鏡頭看到的是它的背面）
        const sides: [THREE.Material, THREE.Side][] = [];
        o.traverse(c => {
          const m = c as THREE.Mesh;
          if (!m.isMesh) return;
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            if (mat) { sides.push([mat, mat.side]); mat.side = THREE.DoubleSide; }
          }
        });
        const hits = ray.intersectObject(o, true);
        for (const [mat, side] of sides) mat.side = side;
        // 只算真的在「點」前面的（點在別的 LED 自己表面上時不算）
        if (hits.some(h => h.distance < len - 0.05)) { hit = true; break; }
      }
      if (hit) blocked++;
    }
  }
  return blocked;
}

/**
 * 控台視角：鏡頭在觀眾席地面 + 1.7m 的高度、舞台正前方的中間，看向主舞台 LED 的中心。
 * 地面 = 整個模型最低的地方。距離 = 主 LED 剛好入鏡 × 1.4。
 * 算完從鏡頭往主 LED 射幾條線，被別的 LED（懸吊物）擋住就往下、往後微調，最多 8 次；還是擋住就用擋得最少的那組。
 */
function computeFohView(
  roots: THREE.Object3D[], ledRoots: THREE.Object3D[], mainRoots: THREE.Object3D[],
  vfovDeg: number, aspect: number,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const ledPoints = collectFramePoints(mainRoots);
  const points = ledPoints.length > 0 ? ledPoints : collectFramePoints(roots);
  const target = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  const front = stageFrontDirection(mainRoots);
  if (points.length === 0) return { position: target.clone().addScaledVector(front, 10), target };

  // 地面 = 非 LED 物件的最低處（升降 LED 降下去的洞不算地面）；全都是 LED 就用全部
  const occluders = ledRoots.filter(r => !mainRoots.includes(r));
  const groundRoots = roots.filter(r => !ledRoots.includes(r));
  const allPoints = collectFramePoints(groundRoots.length > 0 ? groundRoots : roots);
  let groundY = allPoints.length > 0 ? Math.min(...allPoints.map(q => q.y)) : Number.POSITIVE_INFINITY;
  if (!isFinite(groundY)) groundY = Math.min(...points.map(q => q.y));  // 沒地板資料 → 用 LED 最低處當地面

  const build = (eyeY: number, horizMult: number) => {
    // 距離會跟著鏡頭仰角變，疊代幾次收斂
    let horiz = 0;
    let dir = front.clone();
    for (let i = 0; i < 4; i++) {
      const d = fitDistance(points, target, dir, vfovDeg, aspect) * FOH_DIST_MULT * horizMult;
      horiz = d * Math.max(0.2, Math.abs(dir.dot(front)));
      dir = front.clone().multiplyScalar(horiz).add(new THREE.Vector3(0, eyeY - target.y, 0)).normalize();
    }
    const position = target.clone().addScaledVector(front, horiz);
    position.y = eyeY;
    return position;
  };

  let eyeY = groundY + FOH_EYE_HEIGHT;
  let horizMult = 1;
  if (occluders.length === 0) return { position: build(eyeY, horizMult), target };
  let best = build(eyeY, horizMult);
  let bestBlocked = countBlockedSamples(best, mainRoots, occluders);
  for (let i = 0; i < 8 && bestBlocked > 0; i++) {
    eyeY = Math.max(groundY + 0.8, eyeY - 0.25);
    horizMult *= 1.06;
    const pos = build(eyeY, horizMult);
    const n = countBlockedSamples(pos, mainRoots, occluders);
    if (n < bestBlocked) { best = pos; bestBlocked = n; }
  }
  return { position: best, target };
}

/** 常用看台預設角度：依舞台正面方向、中心與 LED 框計算攝影機位置與看向點 */
export function computePresetView(
  preset: CameraPreset,
  roots: THREE.Object3D[], ledRoots: THREE.Object3D[],
  vfovDeg: number, aspect: number,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  if (preset === 'front') {
    return computeFrontView(roots, ledRoots, vfovDeg, aspect, 3);
  }
  const mainRoots = mainLedRoots(ledRoots);
  if (preset === 'foh') return computeFohView(roots, ledRoots, mainRoots, vfovDeg, aspect);
  const ledPoints = collectFramePoints(mainRoots);
  const points = ledPoints.length > 0 ? ledPoints : collectFramePoints(roots);
  const target = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  const front = stageFrontDirection(mainRoots);

  let elevationDeg = 3;
  let distMult = 1.0;
  let targetOffsetY = 0;

  switch (preset) {
    case 'stands':
      elevationDeg = 26;
      distMult = 1.2;
      break;
    case 'vip':
      elevationDeg = 1;
      distMult = 0.55;
      targetOffsetY = 0.2;
      break;
  }

  const e = THREE.MathUtils.degToRad(elevationDeg);
  const dir = front.clone().multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e)).normalize();
  const baseDist = points.length > 0 ? fitDistance(points, target, dir, vfovDeg, aspect) : 10;
  const dist = baseDist * distMult;

  const actualTarget = target.clone();
  if (targetOffsetY !== 0) {
    actualTarget.y += targetOffsetY;
  }
  return { position: actualTarget.clone().addScaledVector(dir, dist), target: actualTarget };
}

