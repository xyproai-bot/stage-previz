// 「下載 AE 合成腳本（.jsx）」：畫一張小一點的 LED 對位圖夾在腳本裡 → 組出整支腳本 → 下載。
// 腳本怎麼組在 aeCompScript.ts（純函式）；對位圖怎麼畫在 ledMapDraw.ts。

import { AE_MAX_COMP_SIDE, blobToBase64, buildAeCompScript, type AeMapImage } from './aeCompScript';
import { ledMapFileName, type LedLayout, type LedMapMeta } from './ledMap';
import { downloadBlob, renderAlignmentMapPng } from './ledMapDraw';

/** 夾在腳本裡的對位圖最長一邊（再大腳本會很大，AE 解開也慢；外框和名字是向量，不受影響） */
export const AE_MAP_MAX_SIDE = 4096;

export class AeCanvasTooBigError extends Error {}

/** 下載 .jsx；回傳有沒有夾到對位圖 */
export async function downloadAeCompScript(layout: LedLayout, meta: LedMapMeta): Promise<{ withMap: boolean; fileName: string }> {
  const { width, height } = layout.canvas;
  if (width > AE_MAX_COMP_SIDE || height > AE_MAX_COMP_SIDE) {
    throw new AeCanvasTooBigError(`LED 畫布 ${width} × ${height} 超過 AE 合成的上限 ${AE_MAX_COMP_SIDE} px`);
  }
  let map: AeMapImage | null = null;
  try {
    // 名字不畫在圖上：腳本會另外放名字的文字圖層（清楚、可以改）
    const png = await renderAlignmentMapPng(layout, meta, { maxSide: AE_MAP_MAX_SIDE, labels: false });
    // 檔名跟「下載對位圖（PNG）」的不一樣：腳本存到同一個資料夾時，不會蓋掉使用者自己下載的那張
    const fileName = ledMapFileName('png', meta).replace(/^LED對位圖/, 'LED對位參考');
    map = { fileName, width: png.width, height: png.height, base64: await blobToBase64(png.blob) };
  } catch (e) {
    console.warn('[aeCompScript] 對位圖沒畫出來，腳本只放外框和名字', e);
  }
  const js = buildAeCompScript({ layout, projectName: meta.projectName, date: meta.date, canvasSource: meta.canvasSource, map });
  const fileName = ledMapFileName('jsx', meta);
  downloadBlob(new Blob([js], { type: 'application/javascript;charset=utf-8' }), fileName);
  return { withMap: !!map, fileName };
}
