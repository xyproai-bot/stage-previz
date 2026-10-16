// 自動貼 UV（畫面這邊用的入口；用到才載入這個檔，worker、three 都不放進一打開網站就下載的 chunk）
//
//   openUvSession：開一個一直開著的 worker，讀進現在的模型一次 → 分析每個 LED 物件（平面 / 弧面 / 原本的 UV 範圍），
//     之後換類型重新分析、3D 預覽的新 UV 都用同一份，不用每次重讀模型。關掉面板就 close。
//   buildLedModel：worker 依排好的方案寫 UV、前三關檢查 → 主執行緒用網站載入模型的方法再檢查一次（第 4 關）
//   任何一關沒過 → 回傳失敗（不上傳）

import type { CanvasSize } from '../ledMap';
import type { WorkerMessage, WorkerRequest } from './ledUv.worker';
import type { AnalyzeResult, BuildPhase, BuildResult, WantedObject } from './pipeline';
import type { Plan } from './plan';
import type { UvPreviewResult } from './previewUv';
import type { SurfaceOverride } from './surfaces';
import { verifyUvScene } from './verifyScene';

export type { AnalyzeOk, AnalyzeResult, BuildPhase, WantedObject } from './pipeline';
export type { UvPreview, UvPreviewResult, PrimPreview } from './previewUv';

export const BUILD_PHASE_TEXT: Record<BuildPhase | 'verifyScene', string> = {
  read: '讀取模型…',
  compute: '計算每個頂點的 UV…',
  write: '寫進模型…',
  encode: '壓縮、輸出…',
  verify: '檢查寫出來的模型…',
  verifyScene: '用 3D 畫面的讀法再檢查一次…',
};

let nextId = 1;

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/** WorkerRequest 拿掉 id（對聯集每一種分別拿掉） */
type RequestBody = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

function newWorker(): Worker {
  return new Worker(new URL('./ledUv.worker.ts', import.meta.url), { type: 'module' });
}

/** 一次性的 worker：送一個請求、等結果、關掉 */
function runWorker<T extends WorkerMessage>(
  req: RequestBody, want: T['type'], onPhase: ((p: BuildPhase) => void) | undefined, signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = newWorker();
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
      if (m.type === 'phase') onPhase?.(m.phase);
      else if (m.type === want) { done(); resolve(m as T); }
    };
    worker.onerror = (e) => { done(); reject(new Error(e.message || '自動貼 UV 工具沒辦法啟動')); };
    const input = (req as { input?: ArrayBuffer }).input;
    worker.postMessage({ ...req, id } as WorkerRequest, input ? [input] : []);
  });
}

export interface AnalyzeInput {
  objects: WantedObject[];
  oldCanvas: CanvasSize;
  /** 製作手動指定的類型（物件 id → 平面 / 弧面） */
  overrides?: Record<string, SurfaceOverride | undefined>;
  /** 只重新分析這幾個物件 */
  only?: string[];
}

export interface UvSession {
  /** 讀進這份模型（buffer 會被複製一份給 worker）並分析 */
  analyze(buffer: ArrayBuffer, input: AnalyzeInput, signal?: AbortSignal): Promise<AnalyzeResult>;
  /** 用已經讀進來的模型重新分析（換類型時只重算那個物件） */
  reanalyze(input: AnalyzeInput, signal?: AbortSignal): Promise<AnalyzeResult>;
  /** 照排好的方案算 3D 預覽用的新 UV */
  preview(objects: WantedObject[], plan: Plan, oldCanvas: CanvasSize, signal?: AbortSignal): Promise<UvPreviewResult>;
  close(): void;
}

export function openUvSession(): UvSession {
  let worker: Worker | null = null;
  const pending = new Map<number, { want: WorkerMessage['type']; resolve: (m: WorkerMessage) => void; reject: (e: Error) => void }>();
  const failAll = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); };
  const ensure = (): Worker => {
    if (worker) return worker;
    const w = newWorker();
    w.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (p && m.type === p.want) { pending.delete(m.id); p.resolve(m); }
    };
    w.onerror = (e) => failAll(new Error(e.message || '自動貼 UV 工具沒辦法啟動'));
    worker = w;
    return w;
  };
  const call = <T extends WorkerMessage>(req: RequestBody, want: T['type'], signal: AbortSignal | undefined, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      let w: Worker;
      try { w = ensure(); } catch (e) { reject(e); return; }
      const id = nextId++;
      const onAbort = () => { pending.delete(id); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        want,
        resolve: (m) => { signal?.removeEventListener('abort', onAbort); resolve(m as T); },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
      });
      w.postMessage({ ...req, id } as WorkerRequest, transfer);
    });
  return {
    async analyze(buffer, input, signal) {
      const copy = buffer.slice(0);
      const m = await call<Extract<WorkerMessage, { type: 'analyze' }>>({ kind: 'analyze', input: copy, ...input }, 'analyze', signal, [copy]);
      return m.result;
    },
    async reanalyze(input, signal) {
      const m = await call<Extract<WorkerMessage, { type: 'analyze' }>>({ kind: 'analyze', ...input }, 'analyze', signal);
      return m.result;
    },
    async preview(objects, plan, oldCanvas, signal) {
      const lean = { ...plan, pack: undefined } as unknown as Plan;
      const m = await call<Extract<WorkerMessage, { type: 'preview' }>>({ kind: 'preview', objects, plan: lean, oldCanvas }, 'preview', signal);
      return m.result;
    },
    close() {
      failAll(abortError());
      worker?.terminate();
      worker = null;
    },
  };
}

export type BuildOutcome =
  | { ok: true; blob: Blob; beforeBytes: number; afterBytes: number; primitives: number; clonedMeshes: number; draco: boolean; maxPixelError: number }
  | { ok: false; reason: string; issues?: string[] };

export async function buildLedModel(
  buffer: ArrayBuffer, objects: WantedObject[], plan: Plan, oldCanvas: CanvasSize,
  opts: { onPhase?: (p: BuildPhase | 'verifyScene') => void; signal?: AbortSignal } = {},
): Promise<BuildOutcome> {
  const { onPhase, signal } = opts;
  // worker 會把 buffer 轉移走，第 4 關要比對的原檔另外留一份
  const original = buffer.slice(0);
  const lean = { ...plan, pack: undefined } as unknown as Plan;
  const m = await runWorker<Extract<WorkerMessage, { type: 'build' }>>({ kind: 'build', input: buffer, objects, plan: lean, oldCanvas }, 'build', onPhase, signal);
  const r: BuildResult = m.result;
  if (!r.ok) return { ok: false, reason: r.reason, issues: r.issues };
  if (signal?.aborted) throw abortError();
  onPhase?.('verifyScene');
  const out = r.bytes;
  const outBuf = (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)) as ArrayBuffer;
  const blob = new Blob([outBuf], { type: 'model/gltf-binary' });
  try {
    const scene = await verifyUvScene(original, outBuf, plan, objects);
    if (!scene.ok) return { ok: false, reason: `3D 畫面讀出來不一樣：${scene.issues.slice(0, 3).join('；')}`, issues: scene.issues };
  } catch (e) {
    return { ok: false, reason: `檢查時出錯：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, blob, beforeBytes: r.beforeBytes, afterBytes: r.afterBytes, primitives: r.primitives, clonedMeshes: r.clonedMeshes, draco: r.draco, maxPixelError: r.output.maxPixelError };
}
