// 參考圖片上傳 / 拿掉還沒送出的（後台：cf-worker/commentAttachments.mjs、guestComments.mjs；docs/comments-api.md「參考圖片」）
//   團隊：POST /api/comment-attachments?session=…；訪客：POST <分享>/songs/:s/comment-attachments
//   用 XMLHttpRequest 傳（才看得到傳了幾 %）；送出留言時把 id 帶在 attachmentIds

import {
  apiBase, getSessionToken, shareAccessHeaders, shareApiPath, songCommentSession,
  type CommentAttachment, type ShareRef,
} from '../api';
import { GUEST_MAX_ATTACHMENTS, MEMBER_MAX_ATTACHMENTS } from './attachmentRules';
import type { PreparedImage } from './imagePrepBrowser';

export interface AttachmentUploader {
  /** 一則最多幾張（團隊 4、訪客 2） */
  max: number;
  upload(img: PreparedImage, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<CommentAttachment>;
  /** 拿掉還沒送出的（失敗不要緊：後台一天後會自己清） */
  discard(id: string): Promise<void>;
}

export type UploadError = Error & { status?: number; aborted?: boolean };

function xhrUpload(
  url: string, headers: Record<string, string>, withCredentials: boolean,
  img: PreparedImage, onProgress: (f: number) => void, signal: AbortSignal,
): Promise<CommentAttachment> {
  const form = new FormData();
  form.append('file', img.blob, `image.${img.type.split('/')[1] || 'png'}`);
  if (img.thumb) form.append('thumb', img.thumb, 'thumb');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = withCredentials;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total)); };
    const fail = (message: string, status?: number, aborted = false) => {
      const err: UploadError = new Error(message);
      err.status = status;
      err.aborted = aborted;
      reject(err);
    };
    xhr.onload = () => {
      let data: { attachment?: CommentAttachment; error?: string } = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* 不是 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.attachment) { resolve(data.attachment); return; }
      fail(data.error || `圖片沒傳上去（HTTP ${xhr.status}）`, xhr.status);
    };
    xhr.onerror = () => fail('網路斷了，圖片沒傳上去');
    xhr.onabort = () => fail('取消了', undefined, true);
    if (signal.aborted) { fail('取消了', undefined, true); return; }
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

function bearer(): Record<string, string> {
  const t = getSessionToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 團隊成員（導演頁、工作站） */
export function memberUploader(projectId: string, songId: string): AttachmentUploader {
  const base = `${apiBase()}/api/comment-attachments?session=${encodeURIComponent(songCommentSession(projectId, songId))}`;
  return {
    max: MEMBER_MAX_ATTACHMENTS,
    upload: (img, onProgress, signal) => xhrUpload(base, bearer(), true, img, onProgress, signal),
    discard: async (id) => {
      await fetch(`${base}&id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include', headers: bearer() }).catch(() => {});
    },
  };
}

/** 分享連結的訪客 */
export function guestUploader(ref: ShareRef, songId: string, access?: string | null): AttachmentUploader {
  const base = `${apiBase()}${shareApiPath(ref)}/songs/${encodeURIComponent(songId)}/comment-attachments`;
  const headers = shareAccessHeaders(access ?? undefined);
  return {
    max: GUEST_MAX_ATTACHMENTS,
    upload: (img, onProgress, signal) => xhrUpload(base, headers, false, img, onProgress, signal),
    discard: async (id) => {
      await fetch(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE', headers }).catch(() => {});
    },
  };
}
