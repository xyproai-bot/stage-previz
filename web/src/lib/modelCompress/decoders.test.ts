import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DRACO_DECODER_PATH } from '../modelLoader';
import { alreadyCompressed, decodersNeeded, readGltfJson } from './glbJson';
import { formatModelSize, sizeChangeText } from './compressClient';

function glbWithJson(json: unknown): Uint8Array {
  let body = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (body.length % 4)) % 4;
  if (pad) { const p = new Uint8Array(body.length + pad).fill(0x20); p.set(body); body = p; }
  const out = new Uint8Array(20 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, body.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  return out;
}

describe('Draco 解壓縮器放在自己的網站（public/draco）', () => {
  it('跟 three 附的是同一份（three 升級時要一起換）', () => {
    for (const f of ['draco_decoder.wasm', 'draco_wasm_wrapper.js']) {
      const pub = readFileSync(new URL(`../../../public/draco/${f}`, import.meta.url));
      const lib = readFileSync(new URL(`../../../node_modules/three/examples/jsm/libs/draco/gltf/${f}`, import.meta.url));
      expect(pub.length, f).toBe(lib.length);
      expect(pub.every((b, i) => b === lib[i]), f).toBe(true);
    }
  });

  it('路徑在自己的網站底下（不是外面的 CDN）', () => {
    expect(DRACO_DECODER_PATH).toMatch(/^\/.*draco\/$/);
  });
});

describe('glbJson：只看 JSON 判斷要不要解壓縮器', () => {
  it('Draco / meshopt / 沒壓縮', () => {
    expect(decodersNeeded(readGltfJson(glbWithJson({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }))))
      .toEqual({ draco: true, meshopt: false });
    expect(decodersNeeded(readGltfJson(glbWithJson({ asset: { version: '2.0' }, extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'] }))))
      .toEqual({ draco: false, meshopt: true });
    expect(decodersNeeded(readGltfJson(glbWithJson({ asset: { version: '2.0' } })))).toEqual({ draco: false, meshopt: false });
  });

  it('.gltf 文字檔也讀得出來；壞檔回 null', () => {
    const info = readGltfJson(new TextEncoder().encode('  {"asset":{"version":"2.0"},"extensionsUsed":["KHR_draco_mesh_compression"]}'));
    expect(info?.container).toBe('gltf');
    expect(alreadyCompressed(info)).toBe(true);
    expect(readGltfJson(new Uint8Array(100))).toBeNull();
    const truncated = glbWithJson({ asset: { version: '2.0' } }).slice(0, 24);
    expect(readGltfJson(truncated)).toBeNull();
  });
});

describe('大小的寫法', () => {
  it('48 MB → 9.2 MB', () => {
    expect(formatModelSize(48 * 1024 * 1024)).toBe('48 MB');
    expect(formatModelSize(9.2 * 1024 * 1024)).toBe('9.2 MB');
    expect(formatModelSize(3 * 1024 * 1024)).toBe('3 MB');
    expect(formatModelSize(850 * 1024)).toBe('850 KB');
    expect(sizeChangeText({ beforeBytes: 48 * 1024 * 1024, afterBytes: 9 * 1024 * 1024 })).toBe('48 MB → 9 MB');
  });
});
