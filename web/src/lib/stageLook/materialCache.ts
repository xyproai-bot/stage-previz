// admin 調的材質，先在這台電腦留一份（localStorage，依專案分開）：
// 後台還沒存成功的時候（例如還沒部署新後台），重新整理也不會不見；
// 專案上有存好的材質就以專案的為準。

import { normalizeMaterialOverrides, type MaterialOverrides } from './materialOverrides';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (projectId: string) => `sp-materials:${projectId}`;

export function readMaterialCache(storage: StorageLike, projectId: string): MaterialOverrides | null {
  try {
    const raw = storage.getItem(key(projectId));
    if (!raw) return null;
    const value = normalizeMaterialOverrides(JSON.parse(raw));
    return Object.keys(value).length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeMaterialCache(storage: StorageLike, projectId: string, value: MaterialOverrides) {
  try {
    const clean = normalizeMaterialOverrides(value);
    if (Object.keys(clean).length > 0) storage.setItem(key(projectId), JSON.stringify(clean));
    else storage.removeItem(key(projectId));
  } catch { /* 無痕模式 / 空間滿 → 這次不存 */ }
}

/** 專案上有 → 用專案的；沒有但這台電腦有 → 用這台電腦的（fromCache = true，之後要補存回專案） */
export function chooseMaterials(
  server: MaterialOverrides, local: MaterialOverrides | null,
): { value: MaterialOverrides; fromCache: boolean } {
  if (Object.keys(server).length > 0) return { value: server, fromCache: false };
  if (local && Object.keys(local).length > 0) return { value: local, fromCache: true };
  return { value: {}, fromCache: false };
}
