// 影片檔的指紋（看是不是同一個檔案）：瀏覽器交之前算一次，後台從 R2 也照同一個方法算（cf-worker/storage.mjs）。
// 前後台共用這個檔（wrangler 打包時會一起編進來），算出來一定一樣（videoFingerprint.test.ts、storage.test.mjs 用同一組資料對答案）。
//
// 方法 fp1：
//   取樣：檔案 24 MiB 以下 → 整個檔案；更大 → 開頭 8 MiB、正中間 8 MiB、最後 8 MiB
//   取樣切成每 1 MiB 一段，每段算 SHA-256；
//   指紋 = 'fp1:' + SHA-256（「fp1|<檔案大小>|」+ 每一段的 SHA-256 接起來）的 16 進位
// 為什麼一段一段算：後台（Cloudflare 免費方案）每次只能用很少的運算時間，一次算 24 MiB 會超過 →
// 每次算幾段、把算好的段存起來，下次接著算；瀏覽器也照一樣的方法，結果才對得上。
// 4 GB 的檔案也只讀 24 MiB，瀏覽器一兩秒就算完（整個檔案算一次要很久）。

export const FP_VERSION = 'fp1';
export const FP_SAMPLE_BYTES = 8 * 1024 * 1024;
export const FP_BLOCK_BYTES = 1024 * 1024;
export const FINGERPRINT_RE = /^fp1:[0-9a-f]{64}$/;

export interface FpBlock { offset: number; length: number }

/** 要讀哪幾段（照順序） */
export function fingerprintBlocks(size: number): FpBlock[] {
  const n = Math.max(0, Math.floor(Number(size) || 0));
  const ranges: Array<[number, number]> = n <= 3 * FP_SAMPLE_BYTES
    ? [[0, n]]
    : [
      [0, FP_SAMPLE_BYTES],
      [Math.floor(n / 2) - FP_SAMPLE_BYTES / 2, FP_SAMPLE_BYTES],
      [n - FP_SAMPLE_BYTES, FP_SAMPLE_BYTES],
    ];
  const out: FpBlock[] = [];
  for (const [start, len] of ranges) {
    for (let off = 0; off < len; off += FP_BLOCK_BYTES) {
      out.push({ offset: start + off, length: Math.min(FP_BLOCK_BYTES, len - off) });
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 一段的 SHA-256（16 進位） */
export async function hashBlock(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', view as unknown as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

/** 每一段的雜湊（16 進位，照順序）→ 指紋 */
export async function combineFingerprint(size: number, blockHashes: readonly string[]): Promise<string> {
  const head = new TextEncoder().encode(`${FP_VERSION}|${Math.floor(Number(size) || 0)}|`);
  const buf = new Uint8Array(head.length + blockHashes.length * 32);
  buf.set(head, 0);
  blockHashes.forEach((h, i) => buf.set(fromHex(h), head.length + i * 32));
  return `${FP_VERSION}:${await hashBlock(buf)}`;
}

/** 瀏覽器：一個檔案（File / Blob）的指紋 */
export async function fingerprintBlob(blob: Blob, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const hashes: string[] = [];
  for (const b of fingerprintBlocks(blob.size)) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    hashes.push(await hashBlock(await blob.slice(b.offset, b.offset + b.length).arrayBuffer()));
  }
  return combineFingerprint(blob.size, hashes);
}
