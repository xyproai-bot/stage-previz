// 「重置攝影機」的視角：從觀眾那一側、稍微高一點，正對舞台，整個舞台剛好入鏡。
// 觀眾在哪一側 = LED 面朝的方向（LED 只畫正面，面一定朝觀眾）。

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/** 舞台正面（水平、指向觀眾）：所有 LED 三角面的朝向依面積加總。沒有 LED → +Z */
export function stageFrontDirection(ledRoots: THREE.Object3D[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const root of ledRoots) {
    root.updateMatrixWorld(true);
    root.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
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
  sum.y = 0;
  if (sum.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1);
  return sum.normalize();
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
  const ledPoints = collectFramePoints(ledRoots);
  const points = ledPoints.length > 0 ? ledPoints : collectFramePoints(roots);
  const target = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  const front = stageFrontDirection(ledRoots);
  const e = THREE.MathUtils.degToRad(elevationDeg);
  const dir = front.multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e)).normalize();
  const dist = points.length > 0 ? fitDistance(points, target, dir, vfovDeg, aspect) : 10;
  return { position: target.clone().addScaledVector(dir, dist), target };
}
