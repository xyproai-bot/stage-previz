// 自動貼 UV：從 gltf-transform 的文件讀出每個 LED 物件的三角形（世界座標）
//
// 物件怎麼對到模型裡的節點，要跟網站載入模型時一模一樣（不然會貼到別的物件上）：
//   1. 節點名稱照 three 的 GLTFLoader 處理（空白變底線、拿掉 [ ] . : /，重複的加 _1、_2…）
//   2. 在樹裡找「命名規則（LED_ / STAGE_ / …）最多的那一層」（parseGlb.ts 的 findBestScope），那一層的孩子就是物件
//   3. 同名的物件取第一個（parseGlb 重複名稱的第二個會跳過）
// 這個檔案不能 import three（會在 worker 裡跑）；跟 parseGlb 重複的幾行由測試比對（docRead.test.ts）。

import { getBounds, type Document, type Mesh, type Node, type Primitive } from '@gltf-transform/core';
import { determinant3, transformPoint, type Vec3 } from './geometry';
import type { ObjectGeom, PrimGeom } from './surfaces';

/** parseGlb.ts 的 PREFIX_RULES（有沒有符合命名規則） */
const PREFIX_RE = /^(LED|STAGE|MECH|ARTIST|PROP|LIGHT|WALK)[_-]/i;
const RESERVED_RE = /[[\].:/]/g;
const LED_MATERIAL_RE = /LED/i;

/** parseGlb.ts 的 computeScaleFactor（模型單位 → 場景單位的自動縮放） */
export function autoScaleFactor(sizeMeters: number): number {
  if (sizeMeters > 100) return 0.01;
  if (sizeMeters < 0.5 && sizeMeters > 0) return 100;
  return 1;
}

/** three 的 PropertyBinding.sanitizeNodeName */
export function sanitizeNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(RESERVED_RE, '');
}

interface TreeNode { node: Node | null; name: string; children: TreeNode[] }

/** GLTFLoader 取名字的順序：場景名 → 最上層節點 → 一層一層往下（節點名字之後，同一個節點的 mesh 名字） */
function buildTree(doc: Document): TreeNode {
  const used: Record<string, number> = {};
  const unique = (original: string): string => {
    const s = sanitizeNodeName(original || '');
    if (s in used) return `${s}_${++used[s]}`;
    used[s] = 0;
    return s;
  };
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  const top: TreeNode = { node: null, name: scene?.getName() ? unique(scene.getName()) : '', children: [] };
  if (!scene) return top;
  const meshes = root.listMeshes();
  const meshDone = new Set<Mesh>();
  const make = (n: Node, reserveName: boolean): TreeNode => ({ node: n, name: n.getName() ? (reserveName ? unique(n.getName()) : '') : '', children: [] });
  const level: TreeNode[] = scene.listChildren().map(n => make(n, true));
  top.children = level;
  let queue = level;
  while (queue.length) {
    const next: TreeNode[] = [];
    for (const t of queue) {
      const mesh = t.node!.getMesh();
      if (mesh && !meshDone.has(mesh)) {
        meshDone.add(mesh);
        const prims = Math.max(1, mesh.listPrimitives().length);
        for (let i = 0; i < prims; i++) unique(mesh.getName() || `mesh_${meshes.indexOf(mesh)}`);
      }
      for (const c of t.node!.listChildren()) {
        const child = make(c, true);
        t.children.push(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return top;
}

/** parseGlb.ts 的 findBestScope */
function findBestScope(root: TreeNode): TreeNode {
  const count = (t: TreeNode) => t.children.filter(c => PREFIX_RE.test((c.name || '').trim())).length;
  let best = root, bestCount = count(root);
  const walk = (t: TreeNode) => {
    const c = count(t);
    if (c > bestCount) { bestCount = c; best = t; }
    t.children.forEach(walk);
  };
  root.children.forEach(walk);
  if (bestCount === 0) {
    let n = root;
    while (n.children.length === 1) n = n.children[0];
    best = n;
  }
  return best;
}

export interface PrimRef { node: Node; mesh: Mesh; prim: Primitive }

export interface SceneObject {
  id: string;
  meshName: string;
  geom: ObjectGeom;
  /** geom.prims[i] 在文件裡的位置 */
  refs: PrimRef[];
}

export interface SceneRead {
  objects: Map<string, SceneObject>;
  /** 模型裡找不到的物件 id */
  missing: string[];
  /** 整個場景外框的對角線（文件單位）、自動縮放倍率（網站載入時算的那個） */
  diag: number;
  scaleFactor: number;
}

function toVec(acc: ReturnType<Primitive['getAttribute']>, itemSize: number): Float64Array | null {
  if (!acc) return null;
  const n = acc.getCount();
  const out = new Float64Array(n * itemSize);
  const arr = acc.getArray();
  if (arr instanceof Float32Array && acc.getElementSize() === itemSize) {
    out.set(arr);
    return out;
  }
  const tmp = new Array(acc.getElementSize()).fill(0);
  for (let i = 0; i < n; i++) {
    acc.getElement(i, tmp);
    for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = tmp[k] ?? 0;
  }
  return out;
}

function readPrim(node: Node, prim: Primitive, screenByMaterial: boolean): PrimGeom | null {
  if (prim.getMode() !== 4) return null;
  const posAcc = prim.getAttribute('POSITION');
  if (!posAcc) return null;
  const local = toVec(posAcc, 3);
  if (!local) return null;
  const m = node.getWorldMatrix();
  const nv = local.length / 3;
  const pos = new Float64Array(nv * 3);
  const tmp: Vec3 = [0, 0, 0];
  for (let i = 0; i < nv; i++) {
    transformPoint(m, local[i * 3], local[i * 3 + 1], local[i * 3 + 2], tmp);
    pos[i * 3] = tmp[0]; pos[i * 3 + 1] = tmp[1]; pos[i * 3 + 2] = tmp[2];
  }
  const idx = prim.getIndices();
  let index: Uint32Array;
  if (idx) index = Uint32Array.from(idx.getArray()!);
  else { index = new Uint32Array(nv - (nv % 3)); for (let i = 0; i < index.length; i++) index[i] = i; }
  const uv = toVec(prim.getAttribute('TEXCOORD_0'), 2);
  const matName = prim.getMaterial()?.getName() ?? '';
  return {
    pos, index, uv,
    screen: screenByMaterial ? LED_MATERIAL_RE.test(matName) : true,
    sign: determinant3(m) < 0 ? -1 : 1,
  };
}

/** 讀出 ids（物件 id → 網站上的物件名稱 meshName）對應的物件。doc 讀進來就不要改，這裡只讀 */
export function readLedObjects(doc: Document, wanted: readonly { id: string; meshName: string }[]): SceneRead {
  const tree = buildTree(doc);
  const scope = findBestScope(tree);
  const byName = new Map<string, TreeNode>();
  for (const c of scope.children) {
    const name = (c.name || '').trim();
    if (name && !byName.has(name)) byName.set(name, c);
  }
  const objects = new Map<string, SceneObject>();
  const missing: string[] = [];
  for (const w of wanted) {
    const top = byName.get(w.meshName.trim());
    if (!top || !top.node) { missing.push(w.id); continue; }
    const nodes: Node[] = [];
    const walk = (t: TreeNode) => { if (t.node) nodes.push(t.node); t.children.forEach(walk); };
    walk(top);
    // 有 LED 材質的 primitive 才是螢幕；整個物件都沒有 → 全部都是
    let anyLedMaterial = false;
    for (const n of nodes) for (const p of n.getMesh()?.listPrimitives() ?? []) if (LED_MATERIAL_RE.test(p.getMaterial()?.getName() ?? '')) anyLedMaterial = true;
    const prims: PrimGeom[] = [], refs: PrimRef[] = [];
    for (const n of nodes) {
      const mesh = n.getMesh();
      if (!mesh) continue;
      for (const p of mesh.listPrimitives()) {
        const g = readPrim(n, p, anyLedMaterial);
        if (!g) continue;
        prims.push(g);
        refs.push({ node: n, mesh, prim: p });
      }
    }
    objects.set(w.id, { id: w.id, meshName: w.meshName, geom: { prims }, refs });
  }
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  let diag = 0;
  if (scene) {
    const b = getBounds(scene);
    diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  }
  return { objects, missing, diag, scaleFactor: autoScaleFactor(diag) };
}
