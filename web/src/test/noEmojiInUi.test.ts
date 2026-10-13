// 守門測試：畫面上的文字不能有 emoji / 象形符號（改用 components/Icon.tsx 的線條圖示）。
//
// 怎麼掃：把每個 .tsx / .ts 原始碼用 TypeScript 解析，只看「會出現在畫面上的文字」——
// 字串、樣板字串、JSX 文字。註解不在語法樹的這些節點裡，等於先把註解拿掉再掃。
// *.test.ts / *.test.tsx 不掃（測試名稱不是畫面）。index.html 去掉 <!-- --> 註解後也一起掃。
//
// 允許的：一般箭頭 U+2190–2193（說明文字「設定 → 分享」、鍵盤提示「上下鍵 選擇」）、
// 乘號、間隔號、刪節號、圈數字（U+2460 起）、Cmd / Shift / Enter 等按鍵符號（U+2318、U+21E7、U+23CE）。
// （這個檔案自己也不放 emoji，範例一律用 \u 跳脫寫法。）
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import indexHtml from '../../index.html?raw';

const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/*.d.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * 不准出現在畫面文字的字元：
 * - Extended_Pictographic：所有 emoji / 象形圖（警告三角、沙漏、播放、暫停、斜箭頭、鉛筆、勾選框、齒輪、雲…）
 * - U+FE0F（emoji 樣式選擇字元）、U+20E3（鍵帽）、國旗字母、膚色
 * - 雜項符號 U+2600–26FF、裝飾符號 U+2700–27BF（打勾、叉叉、鉛筆、星星、方框、漢堡選單…）
 * - 幾何圖形 U+25A0–25FF（當圖示用的實心 / 空心圓點、小三角形、方塊）
 * - 被拿來當按鈕圖示的弧形箭頭 / 電源：U+21B6 U+21B7 U+21BA U+21BB U+27F2 U+27F3 U+2934 U+2935，
 *   U+23E9–23FA 播放控制，U+23FB–23FE 電源符號
 */
const FORBIDDEN =
  /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{21B6}\u{21B7}\u{21BA}\u{21BB}\u{27F2}\u{27F3}\u{2934}\u{2935}\u{23E9}-\u{23FA}\u{23FB}-\u{23FE}]/u;

/**
 * 刻意允許的檔案（每一個都要寫原因）。目前沒有。
 * 例：key = '../lib/xxx.ts'，value = 為什麼這裡的符號不是畫面上的圖示。
 */
const ALLOW_FILES: Record<string, string> = {};

interface Hit { file: string; line: number; text: string }

function uiTextHits(file: string, src: string): Hit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      text = node.text;
    }
    if (text !== null && FORBIDDEN.test(text)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ file, line: line + 1, text: text.trim().slice(0, 80) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('畫面文字不能有 emoji / 象形符號', () => {
  it('有掃到原始碼（防止 glob 寫錯變成什麼都沒掃）', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(f => f.endsWith('/components/StageScene.tsx'))).toBe(true);
    expect(files.some(f => f.endsWith('/pages/Help.tsx'))).toBe(true);
  });

  it('偵測規則本身有效：字串 / JSX 文字 / 樣板字串會抓到，註解和一般箭頭不算', () => {
    const film = String.fromCodePoint(0x1f3ac);
    const warn = '⚠️';
    const sample = [
      `// 註解裡的 ${film} 不算`,
      `/* 也不算 ${warn} */`,
      `const a = '${film} 動畫稿';`,
      'const b = <span>▾ 選單</span>;',
      'const c = `完成 ✓ ${1}`;',
      "const d = '設定 → 分享';",
      "const e = '\\u{1F3AC} 跳脫寫法也算';",
    ].join('\n');
    const hits = uiTextHits('sample.tsx', sample);
    expect(hits.map(h => h.line)).toEqual([3, 4, 5, 7]);
  });

  it('src 底下的 .ts / .tsx 都沒有', () => {
    const hits = Object.entries(sources)
      .filter(([file]) => !(file in ALLOW_FILES))
      .flatMap(([file, src]) => uiTextHits(file, src));
    expect(hits.map(h => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });

  it('index.html 沒有', () => {
    const withoutComments = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
    const lines = withoutComments.split('\n').filter(l => FORBIDDEN.test(l));
    expect(lines).toEqual([]);
  });

  it('允許清單每一條都要寫原因', () => {
    for (const [file, reason] of Object.entries(ALLOW_FILES)) {
      expect(reason.trim().length, file).toBeGreaterThan(10);
    }
  });
});
