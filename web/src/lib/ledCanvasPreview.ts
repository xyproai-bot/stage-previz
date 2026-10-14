// 新專案精靈「LED 畫布大小」那一步的小預覽：從剛上傳的模型讀每塊 LED 的 UV，
// 跟 3D 工具列「LED 對位圖」同一套算法（ledMap.ts / ledMapScene.ts / ledMapDraw.ts）畫成一張小圖。
// 這個檔案用到 three.js，精靈只在「有模型、檔案不大」時才動態載入它（專案總覽平常不用下載 three.js）。
// 模型用網站共用的讀法（lib/modelLoader.ts）：壓縮過的（Draco / meshopt）也讀得出來。
// 讀不出來（模型壞了…）就丟錯誤，畫面上只顯示畫布比例。

import { loadModel } from './modelLoader';
import { findBestScope } from './parseGlb';
import type { LedPanelInput } from './ledMap';
import { ledPanelInputs, type LedSceneObject } from './ledMapScene';

export interface LedObjectRef {
  id: string;
  name: string;
  order: number;
  meshName: string;
}

/** 下載模型 → 找到每塊 LED（用 mesh 名稱對，跟編輯頁一樣先找命名規則對到最多的那一層）→ 每塊的三角形 UV */
export async function loadLedPanelInputs(url: string, leds: readonly LedObjectRef[], signal?: AbortSignal): Promise<LedPanelInput[]> {
  const gltf = await loadModel(url, { signal });
  const scope = findBestScope(gltf.scene);
  const byName = new Map(scope.children.map(c => [(c.name || '').trim(), c]));
  const objs: LedSceneObject[] = [];
  for (const l of leds) {
    const root = byName.get(l.meshName);
    if (root) objs.push({ id: l.id, name: l.name, order: l.order, root });
  }
  return ledPanelInputs(objs);
}
