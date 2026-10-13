// 找舞台地板：世界座標裡面積最大的「朝上水平面」高度 → 地板倒影的反射平面
// 有材質勾了「鏡面地板」時，用 meshFilter 只看那些材質的 mesh

import * as THREE from 'three';

export function detectFloorPlane(
  roots: THREE.Object3D[],
  opts: { minUpDot?: number; binSize?: number; meshFilter?: (mesh: THREE.Mesh) => boolean } = {},
): { y: number; area: number } | null {
  const minUpDot = opts.minUpDot ?? 0.95;
  const tris: { y: number; area: number }[] = [];
  const box = new THREE.Box3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || !mesh.visible) return;
      if (opts.meshFilter && !opts.meshFilter(mesh)) return;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const mw = mesh.matrixWorld;
      // 鏡像（負 scale）時三角形繞序反過來，正面法線要反向
      const flip = mw.determinant() < 0;
      const index = geo.getIndex();
      const count = index ? index.count : pos.count;
      const at = (i: number) => (index ? index.getX(i) : i);
      for (let i = 0; i + 2 < count; i += 3) {
        a.fromBufferAttribute(pos, at(i)).applyMatrix4(mw);
        b.fromBufferAttribute(pos, at(i + 1)).applyMatrix4(mw);
        c.fromBufferAttribute(pos, at(i + 2)).applyMatrix4(mw);
        box.expandByPoint(a); box.expandByPoint(b); box.expandByPoint(c);
        n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
        const area = n.length() / 2;
        if (area < 1e-12) continue;
        n.normalize();
        if (flip) n.negate();
        if (n.y < minUpDot) continue;
        tris.push({ y: (a.y + b.y + c.y) / 3, area });
      }
    });
  }
  if (tris.length === 0) return null;
  // 依高度分組（容許一點誤差），面積最大的那一組就是地板
  const size = box.getSize(new THREE.Vector3()).length();
  const binSize = opts.binSize ?? Math.max(size / 400, 1e-6);
  const bins = new Map<number, { area: number; ySum: number }>();
  for (const t of tris) {
    const k = Math.round(t.y / binSize);
    const bin = bins.get(k) || { area: 0, ySum: 0 };
    bin.area += t.area;
    bin.ySum += t.y * t.area;
    bins.set(k, bin);
  }
  let best: { area: number; ySum: number } | null = null;
  for (const bin of bins.values()) if (!best || bin.area > best.area) best = bin;
  return best ? { y: best.ySum / best.area, area: best.area } : null;
}
