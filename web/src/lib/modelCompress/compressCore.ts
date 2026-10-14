// 壓縮一個 .glb + 第一關比對（gltf-transform）。不管在哪裡跑：瀏覽器的 worker（compress.worker.ts）、測試（node）。
//
//   1. 先看 JSON：不是 .glb、已經壓縮過、用了不認得的擴充、有外部檔案 → 不壓（上傳原檔）
//   2. 讀進來 → 加 Draco（只壓形狀，settings.ts）→ 寫出新的 .glb
//   3. 原檔、壓縮檔各讀一次 → verifyDocument 逐項比對；有任何不一樣 → 不用壓縮檔
//
// io 要先註冊好擴充和 Draco 的 encoder / decoder（呼叫的人準備：worker 用 WebIO、測試用 NodeIO）。

import type { PlatformIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { alreadyCompressed, readGltfJson } from './glbJson';
import { DRACO_ENCODER_OPTIONS, MIN_SIZE_RATIO } from './settings';
import { verifyDocuments, type DocumentVerifyReport } from './verifyDocument';

export type CompressPhase = 'read' | 'encode' | 'verify';

export interface CompressCoreResult {
  /** compressed = 壓好也比對過；skipped = 不需要 / 不適合壓；failed = 壓了但沒過比對或出錯 */
  status: 'compressed' | 'skipped' | 'failed';
  /** 沒用壓縮檔的原因（白話） */
  reason?: string;
  output?: Uint8Array;
  beforeBytes: number;
  afterBytes: number;
  report?: DocumentVerifyReport;
  /** 每一步花多久（毫秒） */
  timings: Partial<Record<CompressPhase, number>>;
}

/** gltf-transform 認得、讀寫不會弄丟的擴充 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(ALL_EXTENSIONS.map(E => E.EXTENSION_NAME));

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 看 JSON 就知道不用壓的情況；可以壓 → null */
export function precheckGlb(input: Uint8Array): string | null {
  const info = readGltfJson(input);
  if (!info) return '讀不出這個檔案的內容（不是正常的 .glb）';
  if (info.container !== 'glb') return '.gltf 檔不壓縮（只有 .glb 會壓縮）';
  if (alreadyCompressed(info)) return '這個模型已經壓縮過了';
  const unknown = info.extensionsUsed.filter(e => !SUPPORTED_EXTENSIONS.has(e));
  if (unknown.length) return `模型用了不認得的擴充（${unknown.join(', ')}），為了不弄丟資料，不壓縮`;
  const json = info.json as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].some(x => typeof x?.uri === 'string' && !x.uri.startsWith('data:'));
  if (external) return '模型有放在外面的檔案（不是全部包在 .glb 裡），不壓縮';
  return null;
}

export async function compressGlb(input: Uint8Array, io: PlatformIO, onPhase?: (p: CompressPhase) => void): Promise<CompressCoreResult> {
  const timings: CompressCoreResult['timings'] = {};
  const before = input.byteLength;
  const skip = (reason: string): CompressCoreResult => ({ status: 'skipped', reason, beforeBytes: before, afterBytes: before, timings });

  const pre = precheckGlb(input);
  if (pre) return skip(pre);

  let output: Uint8Array;
  try {
    onPhase?.('read');
    let t = now();
    const doc = await io.readBinary(input);
    timings.read = now() - t;
    const eligible = doc.getRoot().listMeshes().flatMap(m => m.listPrimitives())
      .filter(p => p.getMode() === 4 && !!p.getIndices() && !!p.getAttribute('POSITION')).length;
    if (eligible === 0) return skip('模型裡沒有能壓縮的三角形');

    onPhase?.('encode');
    t = now();
    doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ ...DRACO_ENCODER_OPTIONS });
    output = await io.writeBinary(doc);
    timings.encode = now() - t;
  } catch (e) {
    return { status: 'failed', reason: `壓縮時出錯：${e instanceof Error ? e.message : String(e)}`, beforeBytes: before, afterBytes: before, timings };
  }

  if (output.byteLength > before * MIN_SIZE_RATIO) {
    return { ...skip(`壓縮後沒有變小多少（${before} → ${output.byteLength} bytes）`), afterBytes: output.byteLength };
  }

  try {
    onPhase?.('verify');
    const t = now();
    // 原檔重讀一次（上面那份已經加了 Draco 設定）；兩份都經過 gltf-transform → 比的是「資料」本身
    const orig = await io.readBinary(input);
    const dec = await io.readBinary(output);
    const report = verifyDocuments(orig, dec);
    timings.verify = now() - t;
    if (!report.ok) {
      return { status: 'failed', reason: `壓縮後比對不一樣：${report.issues.slice(0, 3).join('；')}`, report, beforeBytes: before, afterBytes: output.byteLength, timings };
    }
    return { status: 'compressed', output, report, beforeBytes: before, afterBytes: output.byteLength, timings };
  } catch (e) {
    return { status: 'failed', reason: `比對時出錯：${e instanceof Error ? e.message : String(e)}`, beforeBytes: before, afterBytes: output.byteLength, timings };
  }
}
