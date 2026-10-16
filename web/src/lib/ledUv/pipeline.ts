// 自動貼 UV：worker 和測試共用的流程（讀模型 → 分析；排好版 → 寫 UV → 三關檢查）
// io 要先註冊好擴充和 Draco 的 encoder / decoder（worker 用 WebIO、測試用 NodeIO）。

import type { PlatformIO } from '@gltf-transform/core';
import { SUPPORTED_EXTENSIONS } from '../modelCompress/compressCore';
import { DRACO_EXTENSION, MESHOPT_EXTENSION, MESH_QUANTIZATION_EXTENSION, readGltfJson } from '../modelCompress/glbJson';
import { verifyDocuments } from '../modelCompress/verifyDocument';
import type { CanvasSize } from '../ledMap';
import type { Vec3 } from './geometry';
import { readLedObjects } from './docRead';
import { describeObject, type ObjectInfo } from './objectInfo';
import { objectUvs, type Plan } from './plan';
import { stageFrontOf } from './surfaces';
import { verifyOutputUv, verifyUvEdit, type OutputCheckReport } from './verifyUv';
import { applyUvs, prepareOutputCompression } from './writeUv';

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

export async function analyzeModelBytes(io: PlatformIO, input: Uint8Array, objects: readonly WantedObject[], oldCanvas: CanvasSize): Promise<AnalyzeResult> {
  const pre = precheckForUv(input);
  if (!pre.ok) return pre;
  let doc;
  try { doc = await io.readBinary(input); } catch (e) { return { ok: false, reason: `讀模型時出錯：${e instanceof Error ? e.message : String(e)}` }; }
  const read = readLedObjects(doc, objects);
  const front = stageFrontOf([...read.objects.values()].map(o => o.geom));
  const infos: Record<string, ObjectInfo | null> = {};
  for (const w of objects) {
    const so = read.objects.get(w.id);
    infos[w.id] = so ? describeObject(so.geom, front, oldCanvas) : null;
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
  return { ok: true, infos, front, diag: read.diag, scaleFactor: read.scaleFactor, draco: pre.draco, warnings };
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
    const front = stageFrontOf([...read.objects.values()].map(o => o.geom));

    onPhase?.('compute');
    const infos: Record<string, ObjectInfo | null> = {};
    const uvs = new Map<string, (Float32Array | null)[]>();
    for (const o of plan.objects) {
      if (o.mode !== 'auto' && o.mode !== 'keep') continue;
      const so = read.objects.get(o.id);
      if (!so) return { ok: false, reason: `模型裡找不到物件「${o.name}」` };
      const info = describeObject(so.geom, front, oldCanvas);
      infos[o.id] = info;
      if (o.mode === 'auto' && (info.kind !== 'flat' || info.pieces.length !== o.pieces.length)) {
        return { ok: false, reason: `「${o.name}」的分析結果跟排版時不一樣（模型是不是換過了？請重新分析）` };
      }
      uvs.set(o.id, objectUvs(so.geom, o, info, plan.canvas));
    }

    onPhase?.('write');
    const stats = applyUvs(edit, read.objects, uvs);
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
    return { ok: true, bytes, beforeBytes: input.byteLength, afterBytes: bytes.byteLength, primitives: stats.primitives, clonedMeshes: stats.clonedMeshes, draco: pre.draco, output };
  } catch (e) {
    return { ok: false, reason: `處理模型時出錯：${e instanceof Error ? e.message : String(e)}` };
  }
}
