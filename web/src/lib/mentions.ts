// 留言裡的 @提及：「@」後面接一位專案成員的顯示名稱。
//
// 以前用 /@名字\b/ 判斷：\b 只認英文字母，中文名字（@小明）永遠對不到。
// 現在直接拿專案成員名單比對：@ 後面的字開頭是哪位成員的名字就算提到他。
//   - 名字有長有短（小明 / 小明明）→ 先比長的，@小明明 只算小明明
//   - 中文名字後面直接接字也算（@小明請改）；英文名字後面不能再接英文字母或數字（@hao 不會被 @haoran 誤判）
//   - 英文不分大小寫；名字裡有空白也可以（@Audit Anim）
//   - email（a@b.com）不算：@ 前面緊貼英文字母或數字就跳過

export interface MentionMember { id: string; name: string }
export interface Mention { userId: string; name: string }

const ASCII_WORD_RE = /[A-Za-z0-9_]/;
const BEFORE_AT_BLOCK_RE = /[A-Za-z0-9_.+-]/;

export function extractMentions(text: string, members: readonly MentionMember[] | null | undefined): Mention[] {
  if (!text || !members || members.length === 0) return [];
  const candidates = members
    .filter(m => m && typeof m.id === 'string' && m.id && typeof m.name === 'string' && m.name.trim())
    .map(m => ({ id: m.id, name: m.name, lower: m.name.toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);

  const found = new Map<string, Mention>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    if (i > 0 && BEFORE_AT_BLOCK_RE.test(text[i - 1])) continue;
    let matchedLen = 0;
    for (const m of candidates) {
      if (matchedLen && m.name.length < matchedLen) break;  // 已經對到更長的名字
      const piece = text.slice(i + 1, i + 1 + m.name.length);
      if (piece.length !== m.name.length || piece.toLowerCase() !== m.lower) continue;
      const next = text[i + 1 + m.name.length] ?? '';
      const last = m.name[m.name.length - 1];
      if (ASCII_WORD_RE.test(last) && next && ASCII_WORD_RE.test(next)) continue;
      matchedLen = m.name.length;
      if (!found.has(m.id)) found.set(m.id, { userId: m.id, name: m.name });
    }
  }
  return Array.from(found.values());
}
