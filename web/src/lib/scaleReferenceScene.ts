// 比例尺輔助：從真的 3D 物件抓出「朝上的面」、往下 / 沿著滑鼠打光線，找出人形該站的高度
// （算哪一層是舞台面、站哪裡在 scaleReference.ts，這裡只負責碰 three 的物件）

import * as THREE from 'three';
import { STAND_MIN_NORMAL_Y, pickStandingY, type DownHit, type FaceSet } from './scaleReference';

const DOWN = new THREE.Vector3(0, -1, 0);
const _n = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();
const _origin = new THREE.Vector3();

/** 打到的那個面在世界裡的法線 y（朝上 = 1）。用法線矩陣換算，所以旋轉、不等比縮放、鏡像（縮放有負號）過的物件都算得對 */
export function hitNormalY(hit: THREE.Intersection): number {
  if (!hit.face) return 1;
  _normalMatrix.getNormalMatrix(hit.object.matrixWorld);
  _n.copy(hit.face.normal).applyMatrix3(_normalMatrix).normalize();
  return _n.y;
}

/**
 * 在水平位置 (x, z)、從高度 topY 往下打光線，回傳人形該站的高度：
 * 打到的面裡「幾乎水平朝上」最高的那個；都沒有 → fallbackY。
 * meshes 是要當地面的 mesh（呼叫的人先濾掉 LED、人形）；它們的世界矩陣要是新的。
 */
export function standingYAt(
  meshes: readonly THREE.Object3D[], x: number, z: number, topY: number, fallbackY: number,
  raycaster: THREE.Raycaster = new THREE.Raycaster(),
): number {
  if (meshes.length === 0) return fallbackY;
  raycaster.set(_origin.set(x, topY, z), DOWN);
  const hits = raycaster.intersectObjects(meshes as THREE.Object3D[], false);
  const down: DownHit[] = hits.map(h => ({ y: h.point.y, normalY: hitNormalY(h) }));
  return pickStandingY(down, fallbackY);
}

/**
 * 這些 mesh 現在在哪裡的簽名：位置 / 轉動 / 縮放 / 看不看得到變了，簽名就不一樣。
 * 抓朝上的面要把幾百萬個三角形過一遍（約 0.1 秒），用簽名判斷舞台有沒有動過（機關、換 cue），沒動就沿用上次的。
 */
export function surfaceSignature(meshes: readonly THREE.Object3D[]): string {
  let h = 17;
  for (const m of meshes) {
    const e = m.matrixWorld.elements;
    for (let i = 0; i < 16; i++) h = (Math.imul(h, 31) + Math.round(e[i] * 1000)) | 0;
    h = (Math.imul(h, 31) + (m.visible ? 1 : 2)) | 0;
  }
  return `${meshes.length}:${h}`;
}

/**
 * 把這些 mesh 裡「朝上」（世界法線 y 超過 STAND_MIN_NORMAL_Y）的三角形全部抓出來（世界座標）。
 * 鏡像過的 mesh（縮放有負號）三角形的繞向會反，換回來。meshes 的世界矩陣要是新的。
 */
export function extractUpFaces(meshes: readonly THREE.Mesh[], minNormalY = STAND_MIN_NORMAL_Y): FaceSet {
  const verts: number[] = [];
  const areas: number[] = [];
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo?.getAttribute('position');
    if (!pos) continue;
    const index = geo.getIndex();
    const e = mesh.matrixWorld.elements;
    const flip = mesh.matrixWorld.determinant() < 0;
    const read = (i: number, out: number[]) => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      out[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    };
    const n = index ? index.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      read(index ? index.getX(i) : i, a);
      read(index ? index.getX(i + 1) : i + 1, b);
      read(index ? index.getX(i + 2) : i + 2, c);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = (uz * vx - ux * vz) * (flip ? -1 : 1), nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12 || ny / len <= minNormalY) continue;
      // 鏡像的 mesh 把兩個頂點對調，三角形的繞向才會朝上（只打 FrontSide 的搜尋用）
      if (flip) verts.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      else verts.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      areas.push(len / 2);
    }
  }
  return { count: areas.length, verts: Float32Array.from(verts), areas: Float32Array.from(areas) };
}

/**
 * 把朝上的面做成一個只有它們的 mesh（高度超過 maxY 的丟掉：桁架、屋頂的頂面）：
 * 人形站哪 / 沿著滑鼠滑，都對它打光線 —— 比對整個模型（常常 200 萬個三角形）打快很多，牆也不會擋到。
 * 只畫正面（朝上那一面）：鏡頭在地板下面往上看時，光線會穿過地板，不會打到背面。
 * 沒有任何朝上的面 → null。這個 mesh 不放進場景，用完要 disposeWalkMesh。
 */
export function buildWalkMesh(faces: FaceSet, maxY = Infinity): THREE.Mesh | null {
  const v = faces.verts;
  const out: number[] = [];
  for (let i = 0; i < faces.count; i++) {
    const o = 9 * i;
    if ((v[o + 1] + v[o + 4] + v[o + 7]) / 3 > maxY) continue;
    for (let k = 0; k < 9; k++) out.push(v[o + k]);
  }
  if (out.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function disposeWalkMesh(mesh: THREE.Mesh | null) {
  if (!mesh) return;
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
}
