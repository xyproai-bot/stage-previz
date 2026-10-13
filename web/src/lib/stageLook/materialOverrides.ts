// 舞台材質（依 C4D 材質名稱）：
//   原值（GLB 匯出的樣子）→ 名稱覆寫（材質面板，全專案共用）→ 單一物件 materialProps（舊功能，最優先）
// 範圍要跟 cf-worker/worker.js 的 MATERIAL_RANGES 一致

import * as THREE from 'three';

export interface MaterialOverride {
  color?: string;
  roughness?: number;
  metalness?: number;
  envIntensity?: number;
  opacity?: number;
  mirrorFloor?: boolean;
}

export type MaterialOverrides = Record<string, MaterialOverride>;

export const MATERIAL_RANGES = {
  roughness: [0, 1],
  metalness: [0, 1],
  envIntensity: [0, 5],
  opacity: [0, 1],
} as const;

const NUM_KEYS = Object.keys(MATERIAL_RANGES) as (keyof typeof MATERIAL_RANGES)[];

export function normalizeMaterialOverrides(raw: unknown): MaterialOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: MaterialOverrides = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>).slice(0, 300)) {
    if (name.length > 100 || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const src = v as Record<string, unknown>;
    const o: MaterialOverride = {};
    for (const k of NUM_KEYS) {
      if (!(k in src)) continue;
      const n = Number(src[k]);
      if (!Number.isFinite(n)) continue;
      const [min, max] = MATERIAL_RANGES[k];
      o[k] = Math.min(max, Math.max(min, n));
    }
    if (typeof src.color === 'string' && /^#[0-9a-f]{6}$/i.test(src.color)) o.color = src.color.toLowerCase();
    if (src.mirrorFloor === true) o.mirrorFloor = true;
    if (Object.keys(o).length > 0) out[name] = o;
  }
  return out;
}

export interface MaterialOriginal {
  color: string;
  roughness: number;
  metalness: number;
  envIntensity: number;
  opacity: number;
  transparent: boolean;
}

/** 第一次碰到材質時記下 GLB 原值（之後不再覆蓋），存在 material.userData.original */
export function captureOriginal(m: THREE.MeshStandardMaterial): MaterialOriginal {
  const existing = m.userData.original as MaterialOriginal | undefined;
  if (existing) return existing;
  const original: MaterialOriginal = {
    color: m.color.getHexString(),
    roughness: m.roughness,
    metalness: m.metalness,
    envIntensity: m.envMapIntensity,
    opacity: m.opacity,
    transparent: m.transparent,
  };
  m.userData.original = original;
  return original;
}

export function applyMaterialSettings(
  m: THREE.MeshStandardMaterial,
  override?: MaterialOverride,
  perObject?: { color?: string; roughness?: number; metalness?: number; opacity?: number },
) {
  const o = captureOriginal(m);
  const pick = <T,>(per: T | undefined, ov: T | undefined, orig: T): T => (per !== undefined ? per : ov !== undefined ? ov : orig);
  m.color.set(pick(perObject?.color, override?.color, '#' + o.color));
  m.roughness = pick(perObject?.roughness, override?.roughness, o.roughness);
  m.metalness = pick(perObject?.metalness, override?.metalness, o.metalness);
  m.envMapIntensity = pick(undefined, override?.envIntensity, o.envIntensity);
  const opacity = pick(perObject?.opacity, override?.opacity, o.opacity);
  m.opacity = opacity;
  const transparent = opacity < 1 || (override?.opacity === undefined && perObject?.opacity === undefined && o.transparent);
  if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
}

/** 材質面板用：模型裡的一種材質（依名稱）、用到幾個物件、C4D 原值 */
export interface ModelMaterialInfo {
  name: string;
  count: number;
  original: MaterialOriginal;
}

export function hasMirrorFloor(o: MaterialOverrides): boolean {
  return Object.values(o).some(v => v.mirrorFloor);
}
