// 把一個 LED 物件（可能是平面、L 形、曲面）切成幾塊「發光面」，每塊之後對應一盞 RectAreaLight。
// 做法：三角形依法線分群（夾角 < maxAngleDeg 算同一面），每群算面積加權中心 / 法線 / 寬高 / UV 範圍。
// 全部用 root 物件的 local 座標 → 物件之後怎麼移動（cue / 機關 / crossfade）都只要套 matrixWorld。

import * as THREE from 'three';

export interface UvRect { u0: number; v0: number; u1: number; v1: number }

export interface LedEmitter {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  /** 發光面「高」的方向（寬 = heightAxis × normal） */
  heightAxis: THREE.Vector3;
  width: number;
  height: number;
  area: number;
  /** 這塊在 LED 貼圖上的範圍（套過 fract；跨邊界時 u1 / v1 會 > 1）；沒 UV = null */
  uv: UvRect | null;
}

export interface EmitterOptions {
  maxAngleDeg?: number;
  maxPerObject?: number;
}

interface Tri {
  verts: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  uvs: [THREE.Vector2, THREE.Vector2, THREE.Vector2] | null;
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
  area: number;
}

interface Cluster { nSum: THREE.Vector3; n: THREE.Vector3; area: number; tris: Tri[] }

const MIN_TRI_AREA = 1e-12;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

export function buildLedEmitters(root: THREE.Object3D, opts: EmitterOptions = {}): LedEmitter[] {
  const cosThreshold = Math.cos(THREE.MathUtils.degToRad(opts.maxAngleDeg ?? 35));
  const maxPerObject = Math.max(1, opts.maxPerObject ?? 4);
  const tris = collectTriangles(root);
  if (tris.length === 0) return [];
  const clusters = clusterByNormal(tris, cosThreshold);
  mergeSmallest(clusters, maxPerObject);
  return clusters.map(toEmitter).filter((e): e is LedEmitter => e !== null);
}

function collectTriangles(root: THREE.Object3D): Tri[] {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  const tris: Tri[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const uv = geo.getAttribute('uv');
    m.multiplyMatrices(toRoot, mesh.matrixWorld);
    // 鏡像（負 scale）時三角形繞序反過來，正面法線要反向
    const flip = m.determinant() < 0;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const at = (i: number) => (index ? index.getX(i) : i);
    for (let i = 0; i + 2 < count; i += 3) {
      const ids = [at(i), at(i + 1), at(i + 2)];
      const verts = ids.map(k => new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(m)) as Tri['verts'];
      const e1 = new THREE.Vector3().subVectors(verts[1], verts[0]);
      const e2 = new THREE.Vector3().subVectors(verts[2], verts[0]);
      const cross = new THREE.Vector3().crossVectors(e1, e2);
      const area = cross.length() / 2;
      if (area < MIN_TRI_AREA) continue;
      const normal = cross.normalize();
      if (flip) normal.negate();
      const centroid = new THREE.Vector3().add(verts[0]).add(verts[1]).add(verts[2]).divideScalar(3);
      const uvs = uv ? (ids.map(k => new THREE.Vector2().fromBufferAttribute(uv as THREE.BufferAttribute, k)) as Tri['uvs']) : null;
      tris.push({ verts, uvs, normal, centroid, area });
    }
  });
  return tris;
}

function clusterByNormal(tris: Tri[], cosThreshold: number): Cluster[] {
  const sorted = [...tris].sort((a, b) => b.area - a.area);
  const clusters: Cluster[] = [];
  for (const t of sorted) {
    let best: Cluster | null = null;
    let bestDot = cosThreshold;
    for (const c of clusters) {
      const d = c.n.dot(t.normal);
      if (d >= bestDot) { bestDot = d; best = c; }
    }
    if (!best) {
      best = { nSum: new THREE.Vector3(), n: t.normal.clone(), area: 0, tris: [] };
      clusters.push(best);
    }
    best.tris.push(t);
    best.area += t.area;
    best.nSum.addScaledVector(t.normal, t.area);
    if (best.nSum.lengthSq() > 0) best.n.copy(best.nSum).normalize();
  }
  return clusters;
}

function mergeSmallest(clusters: Cluster[], max: number) {
  while (clusters.length > max) {
    clusters.sort((a, b) => b.area - a.area);
    const small = clusters.pop()!;
    let target = clusters[0];
    let bestDot = -Infinity;
    for (const c of clusters) {
      const d = c.n.dot(small.n);
      if (d > bestDot) { bestDot = d; target = c; }
    }
    target.tris.push(...small.tris);
    target.area += small.area;
    target.nSum.add(small.nSum);
    if (target.nSum.lengthSq() > 0) target.n.copy(target.nSum).normalize();
  }
}

function toEmitter(c: Cluster): LedEmitter | null {
  const normal = c.n.clone();
  const up = Math.abs(normal.dot(WORLD_UP)) > 0.9 ? WORLD_Z : WORLD_UP;
  const heightAxis = up.clone().addScaledVector(normal, -up.dot(normal)).normalize();
  const widthAxis = new THREE.Vector3().crossVectors(heightAxis, normal).normalize();

  const c0 = new THREE.Vector3();
  for (const t of c.tris) c0.addScaledVector(t.centroid, t.area);
  c0.divideScalar(c.area);

  let minW = Infinity, maxW = -Infinity, minH = Infinity, maxH = -Infinity;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  let hasUv = true;
  const d = new THREE.Vector3();
  for (const t of c.tris) {
    for (const p of t.verts) {
      d.subVectors(p, c0);
      const w = d.dot(widthAxis), h = d.dot(heightAxis);
      if (w < minW) minW = w;
      if (w > maxW) maxW = w;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    if (!t.uvs) { hasUv = false; continue; }
    for (const q of t.uvs) {
      if (q.x < uMin) uMin = q.x;
      if (q.x > uMax) uMax = q.x;
      if (q.y < vMin) vMin = q.y;
      if (q.y > vMax) vMax = q.y;
    }
  }
  const width = maxW - minW;
  const height = maxH - minH;
  if (!(width > 0) || !(height > 0)) return null;
  const center = c0.clone()
    .addScaledVector(widthAxis, (minW + maxW) / 2)
    .addScaledVector(heightAxis, (minH + maxH) / 2);

  let uv: UvRect | null = null;
  if (hasUv && Number.isFinite(uMin)) {
    const su = Math.floor(uMin), sv = Math.floor(vMin);
    uv = { u0: uMin - su, u1: uMax - su, v0: vMin - sv, v1: vMax - sv };
  }
  return { center, normal, heightAxis, width, height, area: c.area, uv };
}
