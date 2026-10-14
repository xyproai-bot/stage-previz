// 測試共用：「這兩個 .glb 對網站來說是同一個模型」——每個壓縮相關的測試都拿這個檢查。
// 兩關都跑（跟上傳時一樣）：
//   1. verifyDocuments：gltf-transform 讀出來逐項比（節點 TRS 一模一樣、材質貼圖一模一樣、頂點 / 三角形逐點比）
//   2. verifyModelIdentity：用網站的 GLTFLoader + Draco 載入，比節點名稱、世界矩陣、外框、自動縮放、
//      物件預設位置、StageScene 烤進縮放後的位置、LED 對位圖
// 有任何一項不一樣就丟錯（訊息列出哪裡不一樣）。

import type { NodeIO } from '@gltf-transform/core';
import { verifyDocuments, type DocumentVerifyReport } from '../verifyDocument';
import { verifyModelIdentity, type SceneVerifyReport } from '../verifyScene';
import { createNodeIO, installNodeModelDecoders } from './nodeDecoders';

export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export interface SameModelReport { doc: DocumentVerifyReport; scene: SceneVerifyReport }

/** 兩關都跑，回傳結果（不丟錯） */
export async function compareModels(original: Uint8Array, compressed: Uint8Array, io?: NodeIO): Promise<SameModelReport> {
  await installNodeModelDecoders();
  const nodeIO = io ?? await createNodeIO();
  const doc = verifyDocuments(await nodeIO.readBinary(original), await nodeIO.readBinary(compressed));
  const scene = await verifyModelIdentity(toArrayBuffer(original), toArrayBuffer(compressed));
  return { doc, scene };
}

/** 兩關都要過，不然丟錯 */
export async function assertSameModel(original: Uint8Array, compressed: Uint8Array, io?: NodeIO): Promise<SameModelReport> {
  const r = await compareModels(original, compressed, io);
  const problems = [...r.doc.issues.map(i => `[資料] ${i}`), ...r.scene.issues.map(i => `[3D 載入] ${i}`)];
  if (problems.length) throw new Error(`壓縮前後不一樣：\n  ${problems.join('\n  ')}`);
  return r;
}
