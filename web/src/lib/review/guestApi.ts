// 分享連結的訪客留言（製作有打開「允許看的人留言」才有）：前端呼叫 + 名字記在這台電腦。
// 後台：cf-worker/guestComments.mjs（docs/comments-api.md「訪客留言」）。

import { apiBase, commentExtrasBody, shareAccessHeaders, shareApiPath, shareError, type CommentExtras, type ShareRef, type SongComment } from '../api';

const NAME_KEY = 'sp_guest_name';
export const GUEST_NAME_MAX = 30;
export const GUEST_TEXT_MAX = 1000;

/** 上次寫的名字（沒寫過 / 讀不到 = ''） */
export function readGuestName(): string {
  try { return (localStorage.getItem(NAME_KEY) || '').slice(0, GUEST_NAME_MAX); } catch { return ''; }
}
export function saveGuestName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name.trim().slice(0, GUEST_NAME_MAX)); } catch { /* 只是下次要再寫一次 */ }
}

/** 名字整理（跟後台一樣：一行、拿掉角括號和引號） */
export function tidyGuestName(raw: string): string {
  return raw.replace(/<[^>]*>/g, '').replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, GUEST_NAME_MAX);
}

/** 訪客看到的留言（後台不給 email、帳號 id、@ 誰） */
export type GuestComment = Pick<SongComment, 'id' | 'time' | 'text' | 'author' | 'role' | 'status' | 'createdAt'>
  & Partial<Pick<SongComment, 'timeEnd' | 'view' | 'cueId' | 'annotation' | 'thumbUrl' | 'parentId' | 'videoVersion' | 'resolvedVersion'>>;

export type GuestError = Error & { status?: number; requiresPassword?: boolean; commentsDisabled?: boolean };

async function guestError(r: Response): Promise<GuestError> {
  const body = await r.clone().json().catch(() => ({} as { commentsDisabled?: boolean }));
  const e = await shareError(r) as GuestError;
  e.commentsDisabled = !!(body as { commentsDisabled?: boolean }).commentsDisabled;
  return e;
}

export async function listGuestComments(ref: ShareRef, songId: string, access?: string): Promise<GuestComment[]> {
  const r = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${encodeURIComponent(songId)}/comments`, { headers: shareAccessHeaders(access) });
  if (!r.ok) throw await guestError(r);
  const data = await r.json() as { comments?: GuestComment[] };
  return Array.isArray(data.comments) ? data.comments : [];
}

export async function postGuestComment(
  ref: ShareRef, songId: string, access: string | undefined,
  input: { guestName: string; text: string; time?: number; parentId?: string | null; videoId?: string | null } & CommentExtras,
): Promise<GuestComment[]> {
  const comment: Record<string, unknown> = {
    id: 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    text: input.text,
    time: input.time ?? 0,
    ...commentExtrasBody(input),
  };
  if (input.parentId) comment.parentId = input.parentId;
  if (input.videoId) comment.videoId = input.videoId;
  const r = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${encodeURIComponent(songId)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...shareAccessHeaders(access) },
    body: JSON.stringify({ guestName: input.guestName, comment }),
  });
  if (!r.ok) throw await guestError(r);
  const data = await r.json() as { comments?: GuestComment[] };
  return Array.isArray(data.comments) ? data.comments : [];
}
