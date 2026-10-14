// 讀 3D 模型（.glb / .gltf）的唯一入口：舞台畫面、分享頁、分鏡、LED 對位圖、上傳解析都走這裡。
//
// 壓縮過的模型（Draco / meshopt）要先有解壓縮器：
//   - 先讀檔案開頭的 JSON（modelCompress/glbJson.ts），有用到才載入（沒壓縮的模型一個位元組都不多抓）
//   - Draco 解壓縮器放在自己的網站 /draco/（public/draco，跟 three 附的同一份；不用外面的 CDN，大陸也連得到）
//   - meshopt 解壓縮器是 three 附的小檔，打包成獨立的小 chunk，用到才載入
//
// 解出來的東西跟沒壓縮的一模一樣（節點名稱、位置、旋轉、縮放都沒動），StageScene / parseGlb 後面的程式不用知道有沒有壓縮。

import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LoaderUtils } from 'three';
import { decodersNeeded, readGltfJson } from './modelCompress/glbJson';

/** GLTFLoader 要的 Draco 解壓縮器（DRACOLoader，或測試時的替身） */
export type DracoDecoderLike = Parameters<GLTFLoader['setDRACOLoader']>[0];
/** GLTFLoader 要的 meshopt 解壓縮器 */
export type MeshoptDecoderLike = Parameters<GLTFLoader['setMeshoptDecoder']>[0];

/** Draco 解壓縮器檔案的位置（public/draco） */
export const DRACO_DECODER_PATH = `${import.meta.env.BASE_URL || '/'}draco/`;

interface DecoderProviders {
  draco: () => Promise<DracoDecoderLike>;
  meshopt: () => Promise<MeshoptDecoderLike>;
}

let dracoPending: Promise<DracoDecoderLike> | null = null;
let meshoptPending: Promise<MeshoptDecoderLike> | null = null;

const defaultProviders: DecoderProviders = {
  draco: () => {
    if (!dracoPending) {
      dracoPending = import('three/examples/jsm/loaders/DRACOLoader.js').then(({ DRACOLoader }) => {
        const loader = new DRACOLoader();
        loader.setDecoderPath(DRACO_DECODER_PATH);
        loader.setDecoderConfig({ type: 'wasm' });
        loader.preload();
        return loader;
      });
      dracoPending.catch(() => { dracoPending = null; });  // 載不到（斷線）→ 下次再試
    }
    return dracoPending;
  },
  meshopt: () => {
    if (!meshoptPending) {
      meshoptPending = import('three/examples/jsm/libs/meshopt_decoder.module.js').then(async ({ MeshoptDecoder }) => {
        await MeshoptDecoder.ready;
        return MeshoptDecoder;
      });
      meshoptPending.catch(() => { meshoptPending = null; });
    }
    return meshoptPending;
  },
};

let providers: DecoderProviders = defaultProviders;

/** 換掉解壓縮器（只給測試用：node 裡沒有 Web Worker，Draco 改在同一條執行緒解） */
export function setModelDecoderProviders(p: Partial<DecoderProviders> | null): void {
  providers = p ? { ...defaultProviders, ...p } : defaultProviders;
}

/** 依這個模型用到的擴充，準備好 GLTFLoader（要的解壓縮器才載入） */
export async function createModelLoader(data: ArrayBuffer): Promise<GLTFLoader> {
  const loader = new GLTFLoader();
  const need = decodersNeeded(readGltfJson(data));
  const [draco, meshopt] = await Promise.all([
    need.draco ? providers.draco() : null,
    need.meshopt ? providers.meshopt() : null,
  ]);
  if (draco) loader.setDRACOLoader(draco);
  if (meshopt) loader.setMeshoptDecoder(meshopt);
  return loader;
}

/** 解析已經在記憶體裡的模型（上傳前檢查、壓縮後比對） */
export async function parseModel(data: ArrayBuffer, path = ''): Promise<GLTF> {
  const loader = await createModelLoader(data);
  return new Promise<GLTF>((resolve, reject) => {
    loader.parse(data, path, resolve, reject);
  });
}

/** 下載 + 解析模型（舞台畫面用）；signal 中止 → 拋 AbortError */
export async function loadModel(url: string, opts: { signal?: AbortSignal } = {}): Promise<GLTF> {
  const resp = await fetch(url, { credentials: 'same-origin', signal: opts.signal });
  if (!resp.ok) throw new Error(`模型下載失敗（HTTP ${resp.status}）`);
  const data = await resp.arrayBuffer();
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return parseModel(data, LoaderUtils.extractUrlBase(url));
}
