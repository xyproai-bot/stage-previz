// 上傳前把模型壓小（畫面這邊用的入口）
//
//   compressModelForUpload(file)（畫面從 compressText.ts 叫，用到才載入這個檔）
//     1. 已經壓縮過 / 不是 .glb → 直接用原檔
//     2. 丟給 worker 壓縮 + 第一關比對（compress.worker.ts → compressCore.ts）
//     3. 第二關：用網站載入模型的方法（GLTFLoader + Draco）把兩份都載入，比網站會用到的每一項（verifyScene.ts）
//     4. 兩關都過 → 上傳壓縮檔；任何一關沒過 / 出錯 → 上傳原檔，原因寫在 console 和畫面上
//
// 上傳用同一個 PUT /api/projects/:id/model：檔名、快取（一年）跟原檔一模一樣，後台不用改。

import type { CompressCoreResult, CompressPhase } from './compressCore';
import type { WorkerMessage, WorkerRequest } from './compress.worker';
import { alreadyCompressed, readGltfJson } from './glbJson';
import { verifyModelIdentity } from './verifyScene';
import { sizeChangeText, type ModelCompressOutcome, type ModelCompressPhase } from './compressText';

export { COMPRESS_PHASE_TEXT, formatModelSize, sizeChangeText } from './compressText';
export type { ModelCompressOutcome, ModelCompressPhase } from './compressText';

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

let nextId = 1;

function runWorker(input: ArrayBuffer, onPhase: (p: CompressPhase) => void, signal?: AbortSignal): Promise<{ result: CompressCoreResult; input: ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./compress.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    const id = nextId++;
    const done = () => { worker.terminate(); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { done(); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'phase') onPhase(m.phase);
      else { done(); resolve({ result: m.result, input: m.input }); }
    };
    worker.onerror = (e) => { done(); reject(new Error(e.message || '壓縮工具沒辦法啟動')); };
    const req: WorkerRequest = { id, input };
    worker.postMessage(req, [input]);
  });
}

export async function compressModelForUpload(
  file: Blob,
  opts: { onPhase?: (p: ModelCompressPhase) => void; signal?: AbortSignal } = {},
): Promise<ModelCompressOutcome> {
  const { onPhase, signal } = opts;
  const before = file.size;
  const timings: Record<string, number> = {};
  const keep = (status: 'skipped' | 'failed', reason: string, extra: Partial<ModelCompressOutcome> = {}): ModelCompressOutcome => {
    const o: ModelCompressOutcome = { status, reason, blob: file, beforeBytes: before, afterBytes: before, timings, ...extra, };
    o.afterBytes = o.blob.size;
    if (status === 'failed') console.warn(`[模型壓縮] 沒有用壓縮檔，上傳原檔：${reason}`, extra.issues ?? '');
    else console.info(`[模型壓縮] 不壓縮：${reason}`);
    return o;
  };

  onPhase?.('start');
  let original = await file.arrayBuffer();
  const info = readGltfJson(original);
  if (!info) return keep('skipped', '讀不出這個檔案的內容（不是正常的 .glb）');
  if (info.container !== 'glb') return keep('skipped', '.gltf 檔不壓縮（只有 .glb 會壓縮）');
  if (alreadyCompressed(info)) return keep('skipped', '這個模型已經壓縮過了');
  if (signal?.aborted) throw abortError();

  let worked: { result: CompressCoreResult; input: ArrayBuffer };
  try {
    worked = await runWorker(original, (p) => onPhase?.(p), signal);
  } catch (e) {
    if (signal?.aborted) throw abortError();
    return keep('failed', `壓縮工具出錯：${e instanceof Error ? e.message : String(e)}`);
  }
  original = worked.input;
  const r = worked.result;
  Object.assign(timings, r.timings);
  if (r.status !== 'compressed' || !r.output) {
    return keep(r.status === 'skipped' ? 'skipped' : 'failed', r.reason || '沒有壓縮', { issues: r.report?.issues });
  }
  if (signal?.aborted) throw abortError();

  onPhase?.('verifyScene');
  const t = performance.now();
  try {
    const out = r.output;
    const compressed = (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
      ? out.buffer : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)) as ArrayBuffer;
    // 先做好要上傳的檔（Blob 會複製一份），再拿 compressed 去比對
    const blob = new Blob([compressed], { type: 'model/gltf-binary' });
    const scene = await verifyModelIdentity(original, compressed);
    timings.verifyScene = performance.now() - t;
    if (!scene.ok) return keep('failed', `3D 畫面讀出來不一樣：${scene.issues.slice(0, 3).join('；')}`, { issues: scene.issues });
    const outcome: ModelCompressOutcome = { status: 'compressed', blob, beforeBytes: before, afterBytes: blob.size, timings };
    console.info(`[模型壓縮] ${sizeChangeText(outcome)}（兩關比對都過）`, {
      timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])),
      maxErrorRatio: r.report?.stats.maxErrorRatio,
      triangles: r.report?.stats.trianglesOriginal,
      degenerateDropped: r.report?.stats.degenerateDropped,
    });
    return outcome;
  } catch (e) {
    if (signal?.aborted) throw abortError();
    return keep('failed', `檢查時出錯：${e instanceof Error ? e.message : String(e)}`);
  }
}
