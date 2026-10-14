// 只讀 .glb / .gltf 的 JSON 部分（不解幾何）：知道這個模型用了哪些擴充，
// 載入時才知道要不要先準備 Draco / meshopt 解壓縮器，壓縮前也用來判斷「已經壓縮過」。

const GLB_MAGIC = 0x46546c67;      // 'glTF'
const CHUNK_JSON = 0x4e4f534a;     // 'JSON'

export interface GltfJsonInfo {
  container: 'glb' | 'gltf';
  // glTF JSON 本身（結構很大，只在這裡讀幾個欄位）
  json: Record<string, unknown>;
  extensionsUsed: string[];
  extensionsRequired: string[];
}

export const DRACO_EXTENSION = 'KHR_draco_mesh_compression';
export const MESHOPT_EXTENSION = 'EXT_meshopt_compression';
export const MESH_QUANTIZATION_EXTENSION = 'KHR_mesh_quantization';

function toBytes(buf: ArrayBuffer | ArrayBufferView): Uint8Array {
  return buf instanceof Uint8Array ? buf : ArrayBuffer.isView(buf)
    ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    : new Uint8Array(buf);
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 讀不出來（不是 glTF、檔案壞了）→ null */
export function readGltfJson(buf: ArrayBuffer | ArrayBufferView): GltfJsonInfo | null {
  const bytes = toBytes(buf);
  if (bytes.byteLength < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text: string;
  let container: GltfJsonInfo['container'];
  if (view.getUint32(0, true) === GLB_MAGIC) {
    const version = view.getUint32(4, true);
    if (version !== 2) return null;
    const chunkLength = view.getUint32(12, true);
    const chunkType = view.getUint32(16, true);
    if (chunkType !== CHUNK_JSON || 20 + chunkLength > bytes.byteLength) return null;
    text = new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength));
    container = 'glb';
  } else {
    // .gltf：純文字 JSON（第一個不是空白的字是 {）
    let i = 0;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09 || bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) i++;
    if (bytes[i] !== 0x7b) return null;
    text = new TextDecoder().decode(bytes);
    container = 'gltf';
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  return { container, json: j, extensionsUsed: strList(j.extensionsUsed), extensionsRequired: strList(j.extensionsRequired) };
}

/** 載入這個模型要先準備哪些解壓縮器 */
export function decodersNeeded(info: Pick<GltfJsonInfo, 'extensionsUsed'> | null): { draco: boolean; meshopt: boolean } {
  const used = new Set(info?.extensionsUsed ?? []);
  return { draco: used.has(DRACO_EXTENSION), meshopt: used.has(MESHOPT_EXTENSION) };
}

/** 已經壓縮過（Draco / meshopt / 量化過）→ 不用再壓 */
export function alreadyCompressed(info: Pick<GltfJsonInfo, 'extensionsUsed'> | null): boolean {
  const used = info?.extensionsUsed ?? [];
  return used.includes(DRACO_EXTENSION) || used.includes(MESHOPT_EXTENSION) || used.includes(MESH_QUANTIZATION_EXTENSION);
}
