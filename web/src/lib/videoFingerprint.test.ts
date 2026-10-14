import { describe, it, expect } from 'vitest';
import { fingerprintBlob, fingerprintBlocks, FINGERPRINT_RE, FP_BLOCK_BYTES } from './videoFingerprint';
import { duplicateWarning, formatTwd, formatUsd, infrequentSavingUsd, monthlyCostUsd, type DuplicateMatch } from './storageApi';

const MiB = 1 << 20;
// 跟 cf-worker/storage.test.mjs 同一組資料、同一個答案（後台從 R2 一段一段算的結果要跟瀏覽器一樣）
function testBytes(size: number): Uint8Array {
  const b = new Uint8Array(size);
  let x = 2463534242;
  for (let i = 0; i < size; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; }
  return b;
}
const FP_BIG = 'fp1:0eba3f34c0a696a67eaee57fcc6ec5a9d588d73a1360818b05409f53d0a44278';
const FP_SMALL = 'fp1:6d520ba3076a376aa9faabe059323656cef34114f735d1972bfe0f0ea2343705';

describe('影片指紋（瀏覽器）', () => {
  it('跟後台算的一樣（同一組資料）', async () => {
    expect(await fingerprintBlob(new Blob([testBytes(25 * MiB + 12345) as BlobPart]))).toBe(FP_BIG);
    expect(await fingerprintBlob(new Blob([testBytes(3 * MiB + 7) as BlobPart]))).toBe(FP_SMALL);
    expect(FINGERPRINT_RE.test(FP_BIG)).toBe(true);
  });

  it('大檔只讀頭、中、尾各 8 MiB；24 MiB 以下讀整個檔案', () => {
    const big = fingerprintBlocks(4 * 1024 * MiB);
    expect(big).toHaveLength(24);
    expect(big.reduce((a, b) => a + b.length, 0)).toBe(24 * MiB);
    expect(big[0].offset).toBe(0);
    expect(big[8].offset).toBe(2 * 1024 * MiB - 4 * MiB);
    expect(big[23].offset + big[23].length).toBe(4 * 1024 * MiB);
    const small = fingerprintBlocks(2 * MiB + 1);
    expect(small.map(b => b.length)).toEqual([FP_BLOCK_BYTES, FP_BLOCK_BYTES, 1]);
  });

  it('差一個 byte 指紋就不一樣', async () => {
    const a = testBytes(3 * MiB + 7);
    const b = new Uint8Array(a);
    b[MiB + 3] ^= 1;
    expect(await fingerprintBlob(new Blob([b as BlobPart]))).not.toBe(FP_SMALL);
  });
});

describe('空間費用（估計）', () => {
  const GB = 1024 ** 3;
  it('標準存放前 10 GB 免費（整個帳號）、長期存放便宜三成', () => {
    expect(monthlyCostUsd({ standardBytes: 30 * GB, iaBytes: 0 }, true)).toBeCloseTo(0.3);
    expect(monthlyCostUsd({ standardBytes: 30 * GB, iaBytes: 0 })).toBeCloseTo(0.45);
    expect(monthlyCostUsd({ standardBytes: 0, iaBytes: 30 * GB })).toBeCloseTo(0.3);
    expect(formatUsd(0.45)).toBe('US$0.45');
    expect(formatTwd(0.45)).toBe('NT$14');
    expect(formatTwd(0.01)).toBe('不到 NT$1');
  });
  it('帳號還在免費額度裡，搬到長期存放反而比較貴', () => {
    expect(infrequentSavingUsd(2 * GB, 5 * GB)).toBeLessThan(0);
    expect(infrequentSavingUsd(20 * GB, 100 * GB)).toBeCloseTo(0.1);
  });
  it('重複的提醒：同一首歌 / 別首歌', () => {
    const m: DuplicateMatch = {
      videoId: 'v', songId: 's', songCode: 'S03', songName: '夜曲', sameSong: true, version: 2, label: 'V2', sizeBytes: 1,
      createdBy: { id: 'u', name: '小明' }, createdAt: '2026-10-14T03:00:00.000Z', deleted: false, deletedAt: null, daysLeft: null,
    };
    expect(duplicateWarning(m)).toBe('這個檔案跟「S03 夜曲」的 V2 一模一樣（小明 10/14 交的）');
    expect(duplicateWarning({ ...m, sameSong: false })).toBe('這個檔案跟「S03 夜曲」的 V2 一模一樣（小明 10/14 交的），上傳到別首歌了，要不要確認一下？');
  });
});
