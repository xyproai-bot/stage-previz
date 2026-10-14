// 測試（node）用：
//   - createNodeIO()：gltf-transform 的 NodeIO，註冊好所有擴充 + Draco 編碼 / 解碼器（跟瀏覽器 worker 同一份 draco3dgltf）
//   - installNodeModelDecoders()：讓 lib/modelLoader.ts 在 node 裡也能載入 Draco / meshopt 模型
//     （瀏覽器用 DRACOLoader + Web Worker；node 沒有 worker → 同一條執行緒解，解法照抄 DRACOLoader 的 worker）

import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { setModelDecoderProviders, type DracoDecoderLike } from '../../modelLoader';

/* eslint-disable @typescript-eslint/no-explicit-any */
type DracoModule = any;

let encoderModule: Promise<DracoModule> | null = null;
let decoderModule: Promise<DracoModule> | null = null;
const getEncoder = () => (encoderModule ??= draco3d.createEncoderModule());
const getDecoder = () => (decoderModule ??= draco3d.createDecoderModule());

export async function createNodeIO(): Promise<NodeIO> {
  const [encoder, decoder] = await Promise.all([getEncoder(), getDecoder()]);
  await MeshoptDecoder.ready;
  return new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.ERROR))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.encoder': encoder, 'draco3d.decoder': decoder, 'meshopt.decoder': MeshoptDecoder });
}

const TYPED: Record<string, any> = {
  Float32Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array,
};

function dataType(draco: DracoModule, T: any): number {
  switch (T) {
    case Float32Array: return draco.DT_FLOAT32;
    case Int8Array: return draco.DT_INT8;
    case Int16Array: return draco.DT_INT16;
    case Int32Array: return draco.DT_INT32;
    case Uint8Array: return draco.DT_UINT8;
    case Uint16Array: return draco.DT_UINT16;
    case Uint32Array: return draco.DT_UINT32;
    default: throw new Error('unknown attribute type');
  }
}

/** 跟 DRACOLoader 一樣的介面（GLTFLoader 只叫 decodeDracoFile），在同一條執行緒解 */
class InProcessDracoLoader {
  constructor(private draco: DracoModule) {}

  preload() { return this; }
  dispose() { return this; }

  decodeDracoFile(buffer: ArrayBuffer, callback: (g: BufferGeometry) => void, attributeIDs: Record<string, number>, attributeTypes: Record<string, string>, _colorSpace?: string, onError?: (e: unknown) => void) {
    try {
      callback(this.decode(buffer, attributeIDs, attributeTypes));
    } catch (e) {
      if (onError) onError(e); else throw e;
    }
    return Promise.resolve();
  }

  private decode(buffer: ArrayBuffer, attributeIDs: Record<string, number>, attributeTypes: Record<string, string>): BufferGeometry {
    const draco = this.draco;
    const decoder = new draco.Decoder();
    const array = new Int8Array(buffer);
    const mesh = new draco.Mesh();
    try {
      if (decoder.GetEncodedGeometryType(array) !== draco.TRIANGULAR_MESH) throw new Error('not a draco mesh');
      const status = decoder.DecodeArrayToMesh(array, array.byteLength, mesh);
      if (!status.ok() || mesh.ptr === 0) throw new Error('draco decode failed: ' + status.error_msg());
      const geometry = new BufferGeometry();
      for (const name in attributeIDs) {
        const T = TYPED[attributeTypes[name]];
        const attribute = decoder.GetAttributeByUniqueId(mesh, attributeIDs[name]);
        const numComponents = attribute.num_components();
        const numValues = mesh.num_points() * numComponents;
        const byteLength = numValues * T.BYTES_PER_ELEMENT;
        const ptr = draco._malloc(byteLength);
        decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, dataType(draco, T), byteLength, ptr);
        const values = new T(draco.HEAPF32.buffer, ptr, numValues).slice();
        draco._free(ptr);
        geometry.setAttribute(name, new BufferAttribute(values, numComponents));
      }
      const numIndices = mesh.num_faces() * 3;
      const ptr = draco._malloc(numIndices * 4);
      decoder.GetTrianglesUInt32Array(mesh, numIndices * 4, ptr);
      const index = new Uint32Array(draco.HEAPF32.buffer, ptr, numIndices).slice();
      draco._free(ptr);
      geometry.setIndex(new BufferAttribute(index, 1));
      return geometry;
    } finally {
      draco.destroy(mesh);
      draco.destroy(decoder);
    }
  }
}

let installed = false;

/** 假的 createImageBitmap：只讀 PNG 的寬高（node 沒有圖片解碼；比對只需要貼圖的設定和尺寸） */
async function fakeCreateImageBitmap(blob: Blob): Promise<{ width: number; height: number; close(): void }> {
  const b = new Uint8Array(await blob.arrayBuffer());
  const isPng = b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: isPng ? dv.getUint32(16) : 1, height: isPng ? dv.getUint32(20) : 1, close() {} };
}

/** 讓 modelLoader 在 node 裡用同一條執行緒的 Draco 解碼器；GLTFLoader 讀貼圖要的 self、createImageBitmap 也補上 */
export async function installNodeModelDecoders(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (!g.self) g.self = globalThis;  // GLTFLoader 讀貼圖時用 self.URL
  if (!g.createImageBitmap) g.createImageBitmap = fakeCreateImageBitmap;
  if (installed) return;
  const draco = await getDecoder();
  const loader = new InProcessDracoLoader(draco) as unknown as DracoDecoderLike;
  setModelDecoderProviders({
    draco: async () => loader,
    meshopt: async () => { await MeshoptDecoder.ready; return MeshoptDecoder; },
  });
  installed = true;
}
