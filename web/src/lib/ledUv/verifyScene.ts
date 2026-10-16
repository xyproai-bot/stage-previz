// 自動貼 UV：寫完以後的第 4 關（主執行緒，用網站真正載入模型的方法 GLTFLoader + Draco）
//   原檔和輸出檔各載入一次，比網站會用到的每一項（節點名稱 / 世界矩陣 / 外框 / 自動縮放 / 物件預設位置 / 烤進縮放後的位置…）；
//   被處理的 LED 物件的對位圖位置不比（它們就是要變的），改成：輸出檔載入後量到的外框 == 排好的長方形（整數像素，一點都不差）。
//   沒被處理的 LED（沒選、找不到）的位置要跟原檔一樣。

import { parseModel } from '../modelLoader';
import { findBestScope } from '../parseGlb';
import { collectUvTriangles } from '../ledMapScene';
import { compareSnapshots, disposeGltf, snapshotScene } from '../modelCompress/verifyScene';
import type { PixelRect } from '../ledMap';
import { expectedRect } from './verifyUv';
import { uvRegion } from './region';
import type { Plan } from './plan';

export interface UvSceneReport { ok: boolean; issues: string[]; rects: Record<string, PixelRect | null> }

const yieldToUi = () => new Promise<void>(r => setTimeout(r, 0));

export async function verifyUvScene(
  original: ArrayBuffer, output: ArrayBuffer, plan: Plan, objects: readonly { id: string; meshName: string }[],
): Promise<UvSceneReport> {
  const changedIds = new Set(plan.objects.filter(o => o.mode === 'auto' || o.mode === 'keep').map(o => o.id));
  const nameOf = new Map(objects.map(o => [o.id, o.meshName.trim()]));
  const changedNames = new Set([...changedIds].map(id => nameOf.get(id) ?? ''));

  const ga = await parseModel(original);
  const a = await snapshotScene(ga);
  disposeGltf(ga);
  await yieldToUi();
  const gb = await parseModel(output);
  const b = await snapshotScene(gb);
  a.led = a.led.filter(x => !changedNames.has(x.name));
  b.led = b.led.filter(x => !changedNames.has(x.name));
  // 原本沒有 UV 的 LED（現在有了）：頂點資料種類多一個 uv 是應該的
  const stripUv = (snap: typeof a) => {
    for (const n of snap.nodes) {
      if (!n.geometry || !n.path.split('/').some(seg => changedNames.has(seg.replace(/#\d+$/, '')))) continue;
      n.geometry = { ...n.geometry, attributes: n.geometry.attributes.filter(x => !x.startsWith('uv:')) };
    }
  };
  stripUv(a);
  stripUv(b);
  const issues = compareSnapshots(a, b);

  const rects: Record<string, PixelRect | null> = {};
  const scope = findBestScope(gb.scene);
  for (const o of plan.objects) {
    if (o.mode !== 'auto' && o.mode !== 'keep') continue;
    const child = scope.children.find(c => (c.name || '').trim() === (nameOf.get(o.id) ?? '\u0000'));
    if (!child) { issues.push(`輸出檔載入後找不到物件「${o.name}」`); rects[o.id] = null; continue; }
    const region = uvRegion(collectUvTriangles(child), plan.canvas);
    rects[o.id] = region?.rect ?? null;
    const want = expectedRect(o, plan.canvas);
    if (!region || !want) { issues.push(`「${o.name}」載入後量不到 UV 範圍`); continue; }
    const r = region.rect, w = want.rect;
    if (r.x !== w.x || r.y !== w.y || r.w !== w.w || r.h !== w.h) {
      issues.push(`「${o.name}」載入後在對位圖上的位置不對（要 ${w.x},${w.y} ${w.w}×${w.h}，實際 ${r.x},${r.y} ${r.w}×${r.h}）`);
    }
    await yieldToUi();
  }
  disposeGltf(gb);
  return { ok: issues.length === 0, issues, rects };
}
