// 用戶自己的名字和頭像顏色的規則（前後台共用：後台 cf-worker 直接 import 這個檔案）。
//
//   名字：前後空白去掉、最多 80 個字、不能是空的。新增用戶、全站製作改別人的名字、用戶自己改名字，用的都是這一條。
//   頭像顏色：#rrggbb 的格式。畫面只給 avatarColors.ts 那 6 個，後台只擋格式不對的（全站製作以前存的顏色也要能讀）。
//
// 「改自己」只收這兩個欄位（PATCH /api/auth/me）：角色、email、登入碼、停用…其他欄位一律不收、不理。

export const USER_NAME_MAX = 80;

/** 名字整理成要存的樣子：前後空白去掉、最多 80 個字（切在中間留下的空白也去掉） */
export function cleanUserName(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, USER_NAME_MAX).trim();
}

/** 名字哪裡不對（中文說明）；沒問題 → null。畫面的輸入框和後台共用 */
export function userNameProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return '名字要是文字';
  if (!cleanUserName(raw)) return '名字不能是空的';
  return null;
}

const AVATAR_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 頭像顏色整理成要存的樣子（小寫的 #rrggbb）；格式不對 → null */
export function cleanAvatarColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return AVATAR_COLOR_RE.test(s) ? s.toLowerCase() : null;
}

/** 「改自己」可以改的欄位 */
export const MY_PROFILE_FIELDS = ['name', 'avatarColor'] as const;

export type MyProfilePlan =
  | { ok: true; name?: string; avatarColor?: string }
  | { ok: false; error: string };

/**
 * 「改自己」收到的內容 → 要改什麼。只看 name 和 avatarColor，其他欄位（role、email、deactivated…）直接略過；
 * 有給卻不合格的欄位 → 整個不改（回說明）；兩個都沒給 → 不改（回說明）。
 */
export function planMyProfileUpdate(body: unknown): MyProfilePlan {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '沒有要改的東西' };
  const b = body as Record<string, unknown>;
  const out: { name?: string; avatarColor?: string } = {};
  if ('name' in b) {
    const problem = userNameProblem(b.name);
    if (problem) return { ok: false, error: problem };
    out.name = cleanUserName(b.name);
  }
  if ('avatarColor' in b) {
    const color = cleanAvatarColor(b.avatarColor);
    if (!color) return { ok: false, error: '頭像顏色的格式不對' };
    out.avatarColor = color;
  }
  if (out.name === undefined && out.avatarColor === undefined) return { ok: false, error: '沒有要改的東西' };
  return { ok: true, ...out };
}
