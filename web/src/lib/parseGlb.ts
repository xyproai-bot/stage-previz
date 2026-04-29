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
  sceneSizeMeters: number;       // 整個 scene 的 bbox 對角線
  unitGuess: 'normal' | 'too_big' | 'too_small'; // 提示用
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

  scene.children.forEach((child) => {
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

    meshes.push({
      meshName: name,
      displayName: prettifyName(name, prefix),
      category,
      matchedPrefix: prefix,
      defaultPosition: { x: round(child.position.x), y: round(child.position.y), z: round(child.position.z) },
      defaultRotation: {
        pitch: round(THREE.MathUtils.radToDeg(child.rotation.x)),
        yaw:   round(THREE.MathUtils.radToDeg(child.rotation.y)),
        roll:  round(THREE.MathUtils.radToDeg(child.rotation.z)),
      },
      defaultScale: { x: round(child.scale.x), y: round(child.scale.y), z: round(child.scale.z) },
      childCount,
      sizeMeters,
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

  return { meshes, warnings, sceneSizeMeters, unitGuess };
}

function countDescendants(node: THREE.Object3D): number {
  let n = 0;
  node.traverse(() => { n++; });
  return n - 1; // 不算自己
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
