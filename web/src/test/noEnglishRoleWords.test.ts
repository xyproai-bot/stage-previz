// 守門測試：畫面上的文字不能用英文叫人（user / admin / director / animator），要寫中文：
// 用戶 / 這個人、製作、導演、動畫師。
//
// 怎麼掃：每個 .ts / .tsx 用 TypeScript 解析，只看「會出現在畫面上的文字」：
//   - JSX 文字（<span>…</span> 裡的字）
//   - JSX 的 title / aria-label / placeholder / alt / label 屬性
//   - 有中文字的字串、樣板字串（程式裡的 'admin'、'director' 這種代號沒有中文，不算）
// 不算的：註解、console.log 之類的除錯訊息、網址和路徑（/admin/users、https://…）、HTML 標籤（<span class="…">）。
// *.test.ts(x) 和 src/test/ 底下不掃。
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../test/**', '!../**/*.d.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 不准出現的英文字（整個字才算：Username、administrator 不會被抓） */
const FORBIDDEN = /\b(users?|admins?|directors?|animators?)\b/i;
const CJK = /[㐀-鿿豈-﫿]/;
const VISIBLE_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label']);

/**
 * 刻意允許的句子（專有名詞，例如別的軟體的選單名稱）：key = 檔案，value = 允許的字串片段 + 原因。目前沒有。
 * 例：'../pages/Help.tsx': { text: 'Google Admin', reason: 'Google 的產品名稱，畫面要跟對方網站一樣' }
 */
const ALLOW: Record<string, { text: string; reason: string }[]> = {};

interface Hit { file: string; line: number; text: string }

/** 拿掉網址、路徑、HTML 標籤（這些不是給人讀的字） */
function readableText(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|[\s(（「『])\/[\w\-./:?=&%]*/g, '$1 ');
}

function isInsideConsoleCall(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const callee = p.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console') return true;
    }
    if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

export function englishRoleWordHits(file: string, src: string): Hit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    let visible = false;
    if (ts.isJsxText(node)) {
      text = node.text;
      visible = true;
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      text = node.text;
      const parent = node.parent;
      const isVisibleAttr = !!parent && ts.isJsxAttribute(parent) && VISIBLE_ATTRS.has(parent.name.getText(sf));
      visible = isVisibleAttr || CJK.test(text);
    }
    if (text !== null && visible && !isInsideConsoleCall(node)) {
      const readable = readableText(text);
      const allowed = (ALLOW[file] ?? []).some(a => readable.includes(a.text));
      if (!allowed && FORBIDDEN.test(readable)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ file, line: line + 1, text: text.trim().replace(/\s+/g, ' ').slice(0, 80) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('畫面文字不能用英文叫人（user / admin / director / animator）', () => {
  it('有掃到原始碼（防止 glob 寫錯變成什麼都沒掃）', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(f => f.endsWith('/pages/Users.tsx'))).toBe(true);
    expect(files.some(f => f.endsWith('/components/InviteDialog.tsx'))).toBe(true);
    expect(files.some(f => f.includes('.test.'))).toBe(false);
  });

  it('偵測規則本身有效：畫面上的字會抓到，程式代號、註解、網址、除錯訊息不算', () => {
    const sample = [
      '// 註解裡的 user 不算',
      "const a = '這個 user 只看得到勾選的';",
      'const b = <span>Admin 設定</span>;',
      'const c = <input placeholder="director name" />;',
      "const d = role === 'admin' ? 'director' : 'animator';",
      "const e = '請到 /admin/users 頁面看';",
      "const f = '網址 https://example.com/users/1 打開';",
      'const g = `第 ${n} 個 Animators`;',
      "console.log('[users] 載入失敗');",
      'const h = <div className="user-row" data-role="admin">名字</div>;',
      "const i = 'Username 和 administrator 不算整個字';",
      "const j = <span title=\"給 Users 看\">x</span>;",
    ].join('\n');
    expect(englishRoleWordHits('sample.tsx', sample).map(h => h.line)).toEqual([2, 3, 4, 8, 12]);
  });

  it('src 底下的 .ts / .tsx 都沒有', () => {
    const hits = Object.entries(sources).flatMap(([file, src]) => englishRoleWordHits(file, src));
    expect(hits.map(h => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });

  it('允許清單每一條都要寫原因，而且那個檔案還在', () => {
    for (const [file, items] of Object.entries(ALLOW)) {
      expect(file in sources, `${file} 不存在了，請把這一條拿掉`).toBe(true);
      for (const { text, reason } of items) {
        expect(text.trim().length, file).toBeGreaterThan(0);
        expect(reason.trim().length, `${file}: ${text}`).toBeGreaterThan(10);
      }
    }
  });
});
