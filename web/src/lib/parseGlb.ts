// 解析 GLB 檔，列出 top-level 可動物件 + 用命名規則自動分類
//
// 命名規則：
//   LED_<NN>_<desc>      → led_panel
//   STAGE_<NN>_<desc>    → mechanism
//   ARTIST_<NN>_<desc>   → performer
//   PROP_<NN>_<desc>     → fixture
//   LIGHT_<NN>_<desc>    → fixture
//   WALK_<NN>_<desc>     → walk_point
//   其他                 → other（admin 手動指派）

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import type { StageObjectCategory, Vec3, Euler } from './api';

export interface ParsedMesh {
  meshName: string;
  displayName: string;
  category: StageObjectCategory;
  matchedPrefix: string | null;
  defaultPosition: Vec3;
  defaultRotation: Euler;
  defaultScale: Vec3;
  childCount: number;
  sizeMeters: number; // bbox 對角線長度（以 GLB 單位算）
}

export interface ParseResult {
  meshes: ParsedMesh[];
  warnings: string[];
  sceneSizeMeters: number;
  unitGuess: 'normal' | 'too_big' | 'too_small';
  scaleFactor: number;  // 自動套到每個 mesh 的 default_position/scale 的倍數（StageScene 也會用同邏輯）
}

export function computeScaleFactor(sizeMeters: number): number {
  if (sizeMeters > 100) return 0.01;
  if (sizeMeters < 0.5 && sizeMeters > 0) return 100;
  return 1;
}

const PREFIX_RULES: Array<[RegExp, StageObjectCategory, string]> = [
  [/^LED[_-]/i,    'led_panel',  'LED'],
  [/^STAGE[_-]/i,  'mechanism',  'STAGE'],
  [/^MECH[_-]/i,   'mechanism',  'MECH'],
  [/^ARTIST[_-]/i, 'performer',  'ARTIST'],
  [/^PROP[_-]/i,   'fixture',    'PROP'],
  [/^LIGHT[_-]/i,  'fixture',    'LIGHT'],
  [/^WALK[_-]/i,   'walk_point', 'WALK'],
];

export function classifyMeshName(name: string): { category: StageObjectCategory; prefix: string | null } {
  for (const [re, cat, prefix] of PREFIX_RULES) {
    if (re.test(name)) return { category: cat, prefix };
  }
  return { category: 'other', prefix: null };
}

// 把 mesh name 美化成顯示名稱：移除前綴，把 _ 換成空格
//   LED_01_主牆_中  →  01 主牆 中
export function prettifyName(name: string, prefix: string | null): string {
  if (!prefix) return name;
  const re = new RegExp(`^${prefix}[_-]`, 'i');
  const stripped = name.replace(re, '');
  return stripped.replace(/[_-]/g, ' ');
}

export async function parseGlbFile(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(buf, '', resolve, reject);
  });

  const warnings: string[] = [];
  const scene = gltf.scene as THREE.Group;
  const meshes: ParsedMesh[] = [];
  const seen = new Set<string>();

  // 算整個 scene 的 bbox
  const sceneBox = new THREE.Box3().setFromObject(scene);
  const sceneSize = sceneBox.getSize(new THREE.Vector3());
  const sceneSizeMeters = round(sceneSize.length());
  const scaleFactor = computeScaleFactor(sceneSizeMeters);

  // 找出最佳 scope：哪一層的 children 命名規則匹配最多
  // 例：root 只有 1 個 wrapper "舞臺" → 解開 → 看 wrapper.children 是不是 LED_xx 等
  const bestScope = findBestScope(scene);
  scene.updateMatrixWorld(true);  // 確保 matrixWorld 是新的

  bestScope.children.forEach((child) => {
    const name = (child.name || '').trim();
    if (!name) {
      warnings.push('發現一個無命名的 top-level 節點，已跳過');
      return;
    }
    if (seen.has(name)) {
      warnings.push(`重複名稱「${name}」，第二個實例已跳過`);
      return;
    }
    seen.add(name);

    const { category, prefix } = classifyMeshName(name);
    const childCount = countDescendants(child);
    const box = new THREE.Box3().setFromObject(child);
    const sz = box.getSize(new THREE.Vector3());
    const sizeMeters = round(sz.length());

    // 用 world transform 才對（child.position 是相對 parent 的 local；scope 在深層時不能直接用）
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    const ws = new THREE.Vector3();
    child.matrixWorld.decompose(wp, wq, ws);
    const we = new THREE.Euler().setFromQuaternion(wq);

    meshes.push({
      meshName: name,
      displayName: prettifyName(name, prefix),
      category,
      matchedPrefix: prefix,
      defaultPosition: {
        x: round(wp.x * scaleFactor),
        y: round(wp.y * scaleFactor),
        z: round(wp.z * scaleFactor),
      },
      defaultRotation: {
        pitch: round(THREE.MathUtils.radToDeg(we.x)),
        yaw:   round(THREE.MathUtils.radToDeg(we.y)),
        roll:  round(THREE.MathUtils.radToDeg(we.z)),
      },
      defaultScale: {
        x: round(ws.x * scaleFactor),
        y: round(ws.y * scaleFactor),
        z: round(ws.z * scaleFactor),
      },
      childCount,
      sizeMeters: round(sizeMeters * scaleFactor),
    });
  });

  if (meshes.length === 0) {
    warnings.push('找不到任何 top-level 節點 — 確認模型有匯出 group / mesh');
  }

  // 尺寸推測（GLB 標準 = 1 unit = 1 公尺，正常 stage 對角約 5-50 公尺）
  let unitGuess: 'normal' | 'too_big' | 'too_small' = 'normal';
  if (sceneSizeMeters > 100) {
    unitGuess = 'too_big';
    warnings.push(`⚠️ 整個場景對角約 ${sceneSizeMeters.toFixed(1)} 公尺 — 看起來太大（單位可能是 cm / mm）。建議匯出時把單位改 1 unit = 1 公尺。`);
  } else if (sceneSizeMeters < 0.5 && meshes.length > 0) {
    unitGuess = 'too_small';
    warnings.push(`⚠️ 整個場景對角約 ${sceneSizeMeters.toFixed(2)} 公尺 — 看起來太小（單位可能是英呎或英吋）。`);
  }

  return { meshes, warnings, sceneSizeMeters, unitGuess, scaleFactor };
}

function countDescendants(node: THREE.Object3D): number {
  let n = 0;
  node.traverse(() => { n++; });
  return n - 1; // 不算自己
}

/**
 * 找最佳 scope：走整棵樹，看哪個 node 的 children 命名規則匹配最多
 * - 如果有任何 node 的 children 至少 1 個匹配 → 用該 node 當 scope
 * - 都沒匹配 → 解開連續單一 wrapper（root.children.length===1 → 下一層）直到分岔
 */
export function findBestScope(root: THREE.Object3D): THREE.Object3D {
  function countMatching(node: THREE.Object3D): number {
    let c = 0;
    for (const child of node.children) {
      const name = (child.name || '').trim();
      if (PREFIX_RULES.some(([re]) => re.test(name))) c++;
    }
    return c;
  }

  let bestNode: THREE.Object3D = root;
  let bestCount = countMatching(root);
  root.traverse((node) => {
    const c = countMatching(node);
    if (c > bestCount) {
      bestCount = c;
      bestNode = node;
    }
  });

  // fallback：完全沒命名規則匹配時（例如 Sketchfab 模型），解開單一 wrapper
  if (bestCount === 0) {
    let n: THREE.Object3D = root;
    while (n.children.length === 1) {
      n = n.children[0];
    }
    bestNode = n;
  }
  return bestNode;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
