// 模型壓縮的 Web Worker：壓縮、第一關比對都在這裡跑，畫面不會卡。
// 只有製作上傳模型 / 按「壓縮這個模型」時才會載入（Draco 編碼器、解碼器的 wasm 跟著這個檔案打包，從自己的網站下載）。
//
// 訊息：
//   收到 { id, input: ArrayBuffer }（input 轉移過來）
//   回   { id, type: 'phase', phase }                         每一步開始
//        { id, type: 'result', result, input }                完成（input 原封不動轉回去，給第二關比對用）

import { Logger, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import createEncoderModule from 'draco3dgltf/draco_encoder_gltf_nodejs.js';
import createDecoderModule from 'draco3dgltf/draco_decoder_gltf_nodejs.js';
import encoderWasmUrl from 'draco3dgltf/draco_encoder.wasm?url';
import decoderWasmUrl from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import { compressGlb, type CompressCoreResult, type CompressPhase } from './compressCore';

export interface WorkerRequest { id: number; input: ArrayBuffer }
export type WorkerMessage =
  | { id: number; type: 'phase'; phase: CompressPhase }
  | { id: number; type: 'result'; result: CompressCoreResult; input: ArrayBuffer };

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

let ioPending: Promise<WebIO> | null = null;

function fetchBytes(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`下載壓縮工具失敗（HTTP ${r.status}）`);
    return r.arrayBuffer();
  });
}

function getIO(): Promise<WebIO> {
  if (!ioPending) {
    ioPending = (async () => {
      const [encWasm, decWasm] = await Promise.all([fetchBytes(encoderWasmUrl), fetchBytes(decoderWasmUrl)]);
      const [encoder, decoder] = await Promise.all([
        createEncoderModule({ wasmBinary: encWasm }),
        createDecoderModule({ wasmBinary: decWasm }),
      ]);
      return new WebIO()
        .setLogger(new Logger(Logger.Verbosity.WARN))
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({ 'draco3d.encoder': encoder, 'draco3d.decoder': decoder });
    })();
    ioPending.catch(() => { ioPending = null; });
  }
  return ioPending;
}

ctx.onmessage = async (e) => {
  const { id, input } = e.data;
  let result: CompressCoreResult;
  try {
    const io = await getIO();
    // compressGlb 不會改 input；做完才把 input 轉回去（不用多複製一份大檔）
    result = await compressGlb(new Uint8Array(input), io, (phase) => ctx.postMessage({ id, type: 'phase', phase }));
  } catch (err) {
    result = {
      status: 'failed',
      reason: `壓縮工具出錯：${err instanceof Error ? err.message : String(err)}`,
      beforeBytes: input.byteLength,
      afterBytes: input.byteLength,
      timings: {},
    };
  }
  const transfer: Transferable[] = [input];
  if (result.output) {
    // 壓縮檔自己一個 ArrayBuffer 才能轉移
    const out = result.output.byteOffset === 0 && result.output.byteLength === result.output.buffer.byteLength
      ? result.output : result.output.slice();
    result = { ...result, output: out };
    transfer.push(out.buffer as ArrayBuffer);
  }
  ctx.postMessage({ id, type: 'result', result, input }, transfer);
};
