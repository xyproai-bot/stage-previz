// 自動貼 UV 的 Web Worker：讀模型、分析、寫 UV、前三關檢查都在這裡跑，畫面不會卡。
// 只有製作按「自動貼 UV」時才會載入（Draco 編碼器 / 解碼器的 wasm 跟著這個檔案打包，從自己的網站下載）。
//
// 訊息：
//   收到 { id, kind: 'analyze', input?, objects, oldCanvas, overrides?, only? }   帶 input = 讀進新的模型（之後的分析、預覽都用這份，不用再讀）
//        { id, kind: 'preview', objects, plan, oldCanvas }                        3D 預覽用的新 UV（用 analyze 讀進來的模型）
//        { id, kind: 'build', input, objects, plan, oldCanvas }                   寫檔：每次都從原檔重新讀，不碰預覽用的那份
//   回   { id, type: 'phase', phase }                                  build 每一步開始
//        { id, type: 'analyze', result }
//        { id, type: 'preview', result }                               UV 的 buffer 轉移
//        { id, type: 'build', result, input }                          input 原封不動轉回去、result.bytes 另外轉移

import { Logger, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import createEncoderModule from 'draco3dgltf/draco_encoder_gltf_nodejs.js';
import createDecoderModule from 'draco3dgltf/draco_decoder_gltf_nodejs.js';
import encoderWasmUrl from 'draco3dgltf/draco_encoder.wasm?url';
import decoderWasmUrl from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import type { CanvasSize } from '../ledMap';
import type { Document } from '@gltf-transform/core';
import { analyzeDoc, buildModelBytes, openModelBytes, type AnalyzeOptions, type AnalyzeResult, type BuildPhase, type BuildResult, type WantedObject } from './pipeline';
import { buildUvPreview, type UvPreviewResult } from './previewUv';
import type { Plan } from './plan';
import type { SurfaceOverride } from './surfaces';

export type WorkerRequest =
  | { id: number; kind: 'analyze'; input?: ArrayBuffer; objects: WantedObject[]; oldCanvas: CanvasSize; overrides?: Record<string, SurfaceOverride | undefined>; only?: string[] }
  | { id: number; kind: 'preview'; objects: WantedObject[]; plan: Plan; oldCanvas: CanvasSize }
  | { id: number; kind: 'build'; input: ArrayBuffer; objects: WantedObject[]; plan: Plan; oldCanvas: CanvasSize };

export type WorkerMessage =
  | { id: number; type: 'phase'; phase: BuildPhase }
  | { id: number; type: 'analyze'; result: AnalyzeResult }
  | { id: number; type: 'preview'; result: UvPreviewResult }
  | { id: number; type: 'build'; result: BuildResult; input: ArrayBuffer };

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

let ioPending: Promise<WebIO> | null = null;
/** 分析時讀進來的模型（只讀）：換一個物件的類型、3D 預覽都用它，不用每次重讀 */
let session: { doc: Document; draco: boolean } | null = null;

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
  try {
    if (req.kind === 'analyze') {
      if (req.input) {
        const io = await getIO();
        session = null;
        const opened = await openModelBytes(io, new Uint8Array(req.input));
        if (!opened.ok) { ctx.postMessage({ id: req.id, type: 'analyze', result: opened }); return; }
        session = { doc: opened.doc, draco: opened.draco };
      }
      if (!session) { ctx.postMessage({ id: req.id, type: 'analyze', result: { ok: false, reason: '還沒讀進模型' } }); return; }
      const opts: AnalyzeOptions = { overrides: req.overrides, only: req.only };
      ctx.postMessage({ id: req.id, type: 'analyze', result: analyzeDoc(session.doc, session.draco, req.objects, req.oldCanvas, opts) });
      return;
    }
    if (req.kind === 'preview') {
      if (!session) { ctx.postMessage({ id: req.id, type: 'preview', result: { ok: false, reason: '還沒讀進模型' } }); return; }
      const result = buildUvPreview(session.doc, req.objects, req.plan, req.oldCanvas);
      const transfer: Transferable[] = [];
      if (result.ok) {
        for (const list of Object.values(result.preview.objects)) for (const p of list) if (p.uv) transfer.push(p.uv.buffer as ArrayBuffer);
      }
      ctx.postMessage({ id: req.id, type: 'preview', result }, transfer);
      return;
    }
    const input = req.input;
    const io = await getIO();
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
    if (req.kind === 'analyze') ctx.postMessage({ id: req.id, type: 'analyze', result: { ok: false, reason } });
    else if (req.kind === 'preview') ctx.postMessage({ id: req.id, type: 'preview', result: { ok: false, reason } });
    else ctx.postMessage({ id: req.id, type: 'build', result: { ok: false, reason }, input: req.input }, [req.input]);
  }
};
