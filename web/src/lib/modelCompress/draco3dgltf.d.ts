// draco3dgltf（Google 官方的 glTF 用 Draco 編碼 / 解碼器）沒有附型別

interface Draco3dModuleOptions {
  /** 直接給 wasm 的內容（瀏覽器 worker 用，不讓它自己去猜路徑） */
  wasmBinary?: ArrayBuffer;
  locateFile?: (path: string) => string;
}

declare module 'draco3dgltf' {
  export function createEncoderModule(opts?: Draco3dModuleOptions): Promise<unknown>;
  export function createDecoderModule(opts?: Draco3dModuleOptions): Promise<unknown>;
  const draco3d: { createEncoderModule: typeof createEncoderModule; createDecoderModule: typeof createDecoderModule };
  export default draco3d;
}

declare module 'draco3dgltf/draco_encoder_gltf_nodejs.js' {
  const createEncoderModule: (opts?: Draco3dModuleOptions) => Promise<unknown>;
  export default createEncoderModule;
}

declare module 'draco3dgltf/draco_decoder_gltf_nodejs.js' {
  const createDecoderModule: (opts?: Draco3dModuleOptions) => Promise<unknown>;
  export default createDecoderModule;
}
