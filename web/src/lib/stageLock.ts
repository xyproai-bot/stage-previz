// 編輯頁：裝在機關上的物件不能直接用移動 / 旋轉箭頭或數字去動
// （機關的位置有上下限，直接拖物件會拉到舞台做不到的地方；要動只能用機關的滑桿 / 數字，那邊會卡在上下限）。
// 這裡只放純判斷：哪個物件裝在哪個機關上、畫面上要寫哪一句話。
//
// 注意：這個檔案放在 lib/ 底下、不要放進 lib/mechanisms/（那個資料夾後台也會 import）。

/** 判斷只需要這兩欄（Mechanism 本來就有；測試也比較好寫） */
export interface MountingMechanism {
  name: string;
  /** 帶哪些物件（吊掛 hoist_rig 也是從這裡看；吊點本身沒有物件） */
  objectIds: readonly string[];
}

/** objectId → 它裝在哪個機關（名字） */
export type MountMap = ReadonlyMap<string, string>;

/** 沒有任何機關時共用的空表（不要每次都新配一個） */
export const NO_MOUNTS: MountMap = new Map<string, string>();

/**
 * 每個「裝在機關上」的物件 → 機關名字。
 * 吊掛整組（hoist_rig）、一排裡的每個成員，都是看各自機關的 objectIds。
 * 一個物件同時在兩個機關（資料不該這樣）→ 用排在前面的那個。
 */
export function objectMountMap(mechanisms: readonly MountingMechanism[] | null | undefined): MountMap {
  if (!mechanisms || mechanisms.length === 0) return NO_MOUNTS;
  const map = new Map<string, string>();
  for (const m of mechanisms) {
    for (const id of m.objectIds ?? []) {
      if (!map.has(id)) map.set(id, m.name || '機關');
    }
  }
  return map.size === 0 ? NO_MOUNTS : map;
}

/** 這個物件裝在哪個機關上（回傳機關名字）；沒裝在任何機關上 = null */
export function mechanismNameOfObject(objectId: string, mechanisms: readonly MountingMechanism[] | null | undefined): string | null {
  return objectMountMap(mechanisms).get(objectId) ?? null;
}

/** 選到的物件裡，裝在機關上的那些機關名字（照選的順序、同一個機關只列一次）；一個都沒有 = [] */
export function mountedNames(selectedIds: readonly string[], mounts: MountMap): string[] {
  const names: string[] = [];
  for (const id of selectedIds) {
    const n = mounts.get(id);
    if (n !== undefined && !names.includes(n)) names.push(n);
  }
  return names;
}

/** 列名字最多列幾個，其餘寫「等 N 個機關」 */
const MAX_NAMES_SHOWN = 3;

/**
 * 畫面上那一句話。names = mountedNames(...) 的結果；沒有裝在機關上的 → null（不用寫）。
 * selectedCount > 1 = 多選：只要有一個裝在機關上，整組都不能直接動。
 */
export function stageLockMessage(names: readonly string[], selectedCount: number): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_NAMES_SHOWN).map(n => `「${n}」`).join('');
  const label = names.length > MAX_NAMES_SHOWN ? `${shown}等 ${names.length} 個機關` : shown;
  if (selectedCount <= 1) {
    return `這個物件裝在${label}上，只能用機關的滑桿動（不會超過上下限）`;
  }
  return `選到的物件裡有裝在${label}上的，整組都不能直接移動或旋轉，只能用機關的滑桿動（不會超過上下限）`;
}

/**
 * 3D 畫面上這一次選取要不要擋掉移動 / 旋轉箭頭：
 * 選到的物件裡有一個裝在機關上 → 整組都擋；機關清單還在讀（mechanismsLoading）→ 先擋（讀到之前分不出來）。
 * 只管「機關」這一個原因；唯讀、使用者自己關掉把手，是 StageScene 另外看的。
 */
export function gizmoBlockedByMechanism(selectedIds: readonly string[], mounts: MountMap, mechanismsLoading: boolean): boolean {
  if (mechanismsLoading) return true;
  return mountedNames(selectedIds, mounts).length > 0;
}
