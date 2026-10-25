// 用戶頭像的顏色：新增用戶、之後換顏色都從這幾個選。
//   後台 PATCH /api/users/:id { avatarColor }（只有全站製作），後台不限顏色，畫面只給這幾個。

export interface AvatarColor { value: string; name: string }

export const AVATAR_COLORS: readonly AvatarColor[] = [
  { value: '#10c78a', name: '綠' },
  { value: '#ffaa44', name: '橘' },
  { value: '#5294ff', name: '藍' },
  { value: '#c264ff', name: '紫' },
  { value: '#ff5470', name: '紅' },
  { value: '#ffd84a', name: '黃' },
];

export const DEFAULT_AVATAR_COLOR = AVATAR_COLORS[0].value;

/** 兩個顏色是不是同一個（大小寫、前後空白不算） */
export function sameAvatarColor(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** 這個顏色的名字（不在清單裡 = 「自訂」） */
export function avatarColorName(value: string | null | undefined): string {
  return AVATAR_COLORS.find(c => sameAvatarColor(c.value, value))?.name ?? '自訂';
}
