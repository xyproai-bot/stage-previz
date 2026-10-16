// 自動貼 UV 的 Web Worker：讀模型、分析、寫 UV、前三關檢查都在這裡跑，畫面不會卡。
// 只有製作按「自動貼 UV」時才會載入（Draco 編碼器 / 解碼器的 wasm 跟著這個檔案打包，從自己的網站下載）。
//
// 訊息：
//   收到 { id, kind: 'analyze', input, objects, oldCanvas }            input (ArrayBuffer) 轉移過來
//        { id, kind: 'build', input, objects, plan, oldCanvas }
//   回   { id, type: 'phase', phase }                                  build 每一步開始
//        { id, type: 'analyze', result, input }                        input 原封不動轉回去
//        { id, type: 'build', result, input }                          result.bytes 另外轉移

import { Logger, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import createEncoderModule from 'draco3dgltf/draco_encoder_gltf_nodejs.js';
import createDecoderModule from 'draco3dgltf/draco_decoder_gltf_nodejs.js';
import encoderWasmUrl from 'draco3dgltf/draco_encoder.wasm?url';
import decoderWasmUrl from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import type { CanvasSize } from '../ledMap';
import { analyzeModelBytes, buildModelBytes, type AnalyzeResult, type BuildPhase, type BuildResult, type WantedObject } from './pipeline';
import type { Plan } from './plan';

export type WorkerRequest =
  | { id: number; kind: 'analyze'; input: ArrayBuffer; objects: WantedObject[]; oldCanvas: CanvasSize }
  | { id: number; kind: 'build'; input: ArrayBuffer; objects: WantedObject[]; plan: Plan; oldCanvas: CanvasSize };

export type WorkerMessage =
  | { id: number; type: 'phase'; phase: BuildPhase }
  | { id: number; type: 'analyze'; result: AnalyzeResult; input: ArrayBuffer }
  | { id: number; type: 'build'; result: BuildResult; input: ArrayBuffer };

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

let ioPending: Promise<WebIO> | null = null;

function fetchBytes(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`下載工具失敗（HTTP ${r.status}）`);
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
  const req = e.data;
  const input = req.input;
  try {
    const io = await getIO();
    if (req.kind === 'analyze') {
      const result = await analyzeModelBytes(io, new Uint8Array(input), req.objects, req.oldCanvas);
      ctx.postMessage({ id: req.id, type: 'analyze', result, input }, [input]);
      return;
    }
    const result = await buildModelBytes(io, new Uint8Array(input), req.objects, req.plan, req.oldCanvas, (phase) => ctx.postMessage({ id: req.id, type: 'phase', phase }));
    const transfer: Transferable[] = [input];
    if (result.ok) {
      const b = result.bytes;
      const own = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice();
      result.bytes = own;
      transfer.push(own.buffer as ArrayBuffer);
    }
    ctx.postMessage({ id: req.id, type: 'build', result, input }, transfer);
  } catch (err) {
    const reason = `自動貼 UV 工具出錯：${err instanceof Error ? err.message : String(err)}`;
    if (req.kind === 'analyze') ctx.postMessage({ id: req.id, type: 'analyze', result: { ok: false, reason }, input }, [input]);
    else ctx.postMessage({ id: req.id, type: 'build', result: { ok: false, reason }, input }, [input]);
  }
};
