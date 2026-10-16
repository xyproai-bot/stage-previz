// 自動貼 UV：worker 和測試共用的流程（讀模型 → 分析；排好版 → 寫 UV → 三關檢查）
// io 要先註冊好擴充和 Draco 的 encoder / decoder（worker 用 WebIO、測試用 NodeIO）。

import type { Document, PlatformIO } from '@gltf-transform/core';
import { SUPPORTED_EXTENSIONS } from '../modelCompress/compressCore';
import { DRACO_EXTENSION, MESHOPT_EXTENSION, MESH_QUANTIZATION_EXTENSION, readGltfJson } from '../modelCompress/glbJson';
import { verifyDocuments } from '../modelCompress/verifyDocument';
import type { CanvasSize } from '../ledMap';
import type { Vec3 } from './geometry';
import { readLedObjects, type SceneRead } from './docRead';
import { describeObject, type ObjectInfo } from './objectInfo';
import { objectUvs, type Plan } from './plan';
import type { PrimUv } from './place';
import { stageFrontOf, type SurfaceOverride } from './surfaces';
import { verifyOutputUv, verifyUvEdit, type OutputCheckReport } from './verifyUv';
import { applyUvs, prepareOutputCompression, type Uv1Status } from './writeUv';

/** 跟後台一樣：模型檔最大 100 MB */
export const MAX_MODEL_BYTES = 100 * 1024 * 1024;

export interface WantedObject { id: string; meshName: string }

export type PrecheckResult = { ok: true; draco: boolean } | { ok: false; reason: string };

/** 看 JSON 就知道能不能處理：只收 .glb；plain 或 Draco 都可以（輸出照原檔），其他壓縮 / 不認得的擴充 / 外部檔案不處理 */
export function precheckForUv(input: Uint8Array): PrecheckResult {
  const info = readGltfJson(input);
  if (!info) return { ok: false, reason: '讀不出這個檔案的內容（不是正常的 .glb）' };
  if (info.container !== 'glb') return { ok: false, reason: '.gltf 檔不支援自動貼 UV，請先存成 .glb' };
  const used = info.extensionsUsed;
  if (used.includes(MESHOPT_EXTENSION) || used.includes(MESH_QUANTIZATION_EXTENSION)) {
    return { ok: false, reason: '這個模型用了 meshopt / 量化壓縮，為了不弄壞資料，不支援自動貼 UV（請用 Draco 或不壓縮的 .glb）' };
  }
  const unknown = used.filter(e => !SUPPORTED_EXTENSIONS.has(e));
  if (unknown.length) return { ok: false, reason: `模型用了不認得的擴充（${unknown.join(', ')}），為了不弄丟資料，不處理` };
  const json = info.json as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].some(x => typeof x?.uri === 'string' && !x.uri.startsWith('data:'));
  if (external) return { ok: false, reason: '模型有放在外面的檔案（不是全部包在 .glb 裡），不處理' };
  return { ok: true, draco: used.includes(DRACO_EXTENSION) };
}

export interface AnalyzeOk {
  ok: true;
  /** 物件 id → 分析結果（only 有指定時只有那幾個）；模型裡找不到 = null */
  infos: Record<string, ObjectInfo | null>;
  front: Vec3;
  /** 場景外框對角線（文件單位）、網站載入時的自動縮放倍率 */
  diag: number;
  scaleFactor: number;
  draco: boolean;
  /** 給畫面顯示的提醒（例如 LED 材質有貼圖位移） */
  warnings: string[];
}
export type AnalyzeResult = AnalyzeOk | { ok: false; reason: string };

export type OpenResult = { ok: true; doc: Document; draco: boolean } | { ok: false; reason: string };

/** 讀進模型（之後的分析、3D 預覽都用這份文件，只讀不改） */
export async function openModelBytes(io: PlatformIO, input: Uint8Array): Promise<OpenResult> {
  const pre = precheckForUv(input);
  if (!pre.ok) return pre;
  try { return { ok: true, doc: await io.readBinary(input), draco: pre.draco }; } catch (e) { return { ok: false, reason: `讀模型時出錯：${e instanceof Error ? e.message : String(e)}` }; }
}

export interface AnalyzeOptions {
  /** 製作手動指定的類型（物件 id → 平面 / 弧面 / 自由曲面）；沒有 = 自動辨識 */
  overrides?: Readonly<Record<string, SurfaceOverride | undefined>>;
  /** 封閉圓柱的接縫位置（物件 id → 從背面往觀眾右手邊轉幾度）；沒有 = 0 */
  seams?: Readonly<Record<string, number | undefined>>;
  /** 只重新分析這幾個物件（舞台正面還是照全部物件算） */
  only?: readonly string[];
}

/** 分析每個 LED 物件（平面 / 弧面 / 原本的 UV 範圍）。doc 是 openModelBytes 讀進來的，這裡只讀 */
export function analyzeDoc(doc: Document, draco: boolean, objects: readonly WantedObject[], oldCanvas: CanvasSize, opts: AnalyzeOptions = {}): AnalyzeOk {
  const read = readLedObjects(doc, objects);
  const front = stageFrontOf([...read.objects.values()].map(o => o.geom));
  const only = opts.only ? new Set(opts.only) : null;
  const infos: Record<string, ObjectInfo | null> = {};
  for (const w of objects) {
    if (only && !only.has(w.id)) continue;
    const so = read.objects.get(w.id);
    infos[w.id] = so ? describeObject(so.geom, front, oldCanvas, opts.overrides?.[w.id] ?? 'auto', opts.seams?.[w.id] ?? 0) : null;
  }
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const so of read.objects.values()) {
    for (const r of so.refs) {
      const mat = r.prim.getMaterial();
      if (!mat || names.has(mat.getName())) continue;
      const infoList = [mat.getEmissiveTextureInfo(), mat.getBaseColorTextureInfo()];
      if (infoList.some(i => i && i.getExtension('KHR_texture_transform'))) {
        names.add(mat.getName());
        warnings.push(`LED 材質「${mat.getName()}」有貼圖位移（KHR_texture_transform）：畫面會跟著偏移，貼出來的位置會跟對位圖不一樣`);
      }
    }
  }
  return { ok: true, infos, front, diag: read.diag, scaleFactor: read.scaleFactor, draco, warnings };
}

export async function analyzeModelBytes(io: PlatformIO, input: Uint8Array, objects: readonly WantedObject[], oldCanvas: CanvasSize, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const o = await openModelBytes(io, input);
  if (!o.ok) return o;
  return analyzeDoc(o.doc, o.draco, objects, oldCanvas, opts);
}

/** 照排好的方案算每個被處理的物件的新 UV（寫檔和 3D 預覽共用）；模型跟排版時不一樣 = 失敗 */
export function computePlanUvs(
  read: SceneRead, plan: Plan, oldCanvas: CanvasSize,
): { ok: true; infos: Record<string, ObjectInfo | null>; uvs: Map<string, (PrimUv | null)[]> } | { ok: false; reason: string } {
  const front = stageFrontOf([...read.objects.values()].map(o => o.geom));
  const infos: Record<string, ObjectInfo | null> = {};
  const uvs = new Map<string, (PrimUv | null)[]>();
  for (const o of plan.objects) {
    if (o.mode !== 'auto' && o.mode !== 'keep') continue;
    const so = read.objects.get(o.id);
    if (!so) return { ok: false, reason: `模型裡找不到物件「${o.name}」` };
    const info = describeObject(so.geom, front, oldCanvas, o.override ?? 'auto', o.seamDeg ?? 0);
    infos[o.id] = info;
    if (o.mode === 'auto' && (info.kind !== 'ok' || info.pieces.length !== o.pieces.length)) {
      return { ok: false, reason: `「${o.name}」的分析結果跟排版時不一樣（模型是不是換過了？請重新分析）` };
    }
    uvs.set(o.id, objectUvs(so.geom, o, info, plan.canvas));
  }
  return { ok: true, infos, uvs };
}

export type BuildPhase = 'read' | 'compute' | 'write' | 'encode' | 'verify';

export interface BuildOk {
  ok: true;
  bytes: Uint8Array;
  beforeBytes: number;
  afterBytes: number;
  primitives: number;
  clonedMeshes: number;
  draco: boolean;
  output: OutputCheckReport;
  /** 物件 id → 原本的 UV 存進 TEXCOORD_1 的結果（fresh = 舊影片可以精確保護） */
  uv1: Record<string, Uv1Status>;
  splitPrimitives: number;
}
export type BuildResult = BuildOk | { ok: false; reason: string; issues?: string[] };

/** 依排好的方案把 UV 寫進模型；三關檢查有任何一項沒過就回傳失敗（不會有輸出檔） */
export async function buildModelBytes(
  io: PlatformIO, input: Uint8Array, objects: readonly WantedObject[], plan: Plan, oldCanvas: CanvasSize,
  onPhase?: (p: BuildPhase) => void,
): Promise<BuildResult> {
  const pre = precheckForUv(input);
  if (!pre.ok) return pre;
  try {
    onPhase?.('read');
    const orig = await io.readBinary(input);
    const edit = await io.readBinary(input);
    const read = readLedObjects(edit, objects);

    onPhase?.('compute');
    const computed = computePlanUvs(read, plan, oldCanvas);
    if (!computed.ok) return computed;
    const { infos, uvs } = computed;

    onPhase?.('write');
    const stats = applyUvs(edit, read.objects, uvs, { keepOriginalUv: true });
    const nodes = edit.getRoot().listNodes();
    const changed = new Set(stats.changed.map(c => `${nodes.indexOf(c.node)}:${c.primIndex}`));
    const editIssues = verifyUvEdit(orig, edit, changed);
    if (editIssues.length) return { ok: false, reason: `改完的模型跟原檔除了 UV 以外還有不一樣：${editIssues[0]}`, issues: editIssues };

    onPhase?.('encode');
    prepareOutputCompression(edit, pre.draco);
    const bytes = await io.writeBinary(edit);
    if (bytes.byteLength > MAX_MODEL_BYTES) return { ok: false, reason: `輸出的模型有 ${(bytes.byteLength / 1048576).toFixed(1)} MB，超過上限 100 MB` };

    onPhase?.('verify');
    const out = await io.readBinary(bytes);
    const docReport = verifyDocuments(edit, out);
    if (!docReport.ok) return { ok: false, reason: `寫出再讀回來的模型有不一樣：${docReport.issues[0]}`, issues: docReport.issues };
    const output = verifyOutputUv(out, objects, plan, infos);
    if (!output.ok) return { ok: false, reason: `貼出來的位置檢查沒過：${output.issues[0]}`, issues: output.issues };
    return { ok: true, bytes, beforeBytes: input.byteLength, afterBytes: bytes.byteLength, primitives: stats.primitives, clonedMeshes: stats.clonedMeshes, draco: pre.draco, output, uv1: stats.uv1, splitPrimitives: stats.splitPrimitives };
  } catch (e) {
    return { ok: false, reason: `處理模型時出錯：${e instanceof Error ? e.message : String(e)}` };
  }
}
