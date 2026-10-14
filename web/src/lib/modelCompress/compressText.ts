// 模型壓縮畫面上用的字和型別（很小，畫面直接 import；真正壓縮的程式在 compressClient.ts，用到才載入）

import type { CompressPhase } from './compressCore';

export type ModelCompressPhase = 'start' | CompressPhase | 'verifyScene';

/** 每一步畫面上顯示的字 */
export const COMPRESS_PHASE_TEXT: Record<ModelCompressPhase, string> = {
  start: '準備壓縮工具…',
  read: '讀取模型…',
  encode: '壓縮形狀…',
  verify: '檢查壓縮前後是不是一樣…',
  verifyScene: '用 3D 畫面的讀法再檢查一次…',
};

export interface ModelCompressOutcome {
  /** compressed = 用壓縮檔；skipped = 不需要壓；failed = 壓了但沒過檢查 / 出錯（用原檔） */
  status: 'compressed' | 'skipped' | 'failed';
  reason?: string;
  /** 要上傳的檔案（壓縮檔或原檔） */
  blob: Blob;
  beforeBytes: number;
  afterBytes: number;
  /** 毫秒 */
  timings: Record<string, number>;
  issues?: string[];
}

/** 檔案大小 → 「48 MB」「9.2 MB」「850 KB」 */
export function formatModelSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 「48 MB → 9 MB」 */
export function sizeChangeText(o: Pick<ModelCompressOutcome, 'beforeBytes' | 'afterBytes'>): string {
  return `${formatModelSize(o.beforeBytes)} → ${formatModelSize(o.afterBytes)}`;
}

/** 用到才載入壓縮程式（壓縮 worker、比對程式不放進一打開網站就下載的 chunk） */
export async function compressModelForUpload(
  file: Blob,
  opts: { onPhase?: (p: ModelCompressPhase) => void; signal?: AbortSignal } = {},
): Promise<ModelCompressOutcome> {
  const m = await import('./compressClient');
  return m.compressModelForUpload(file, opts);
}
