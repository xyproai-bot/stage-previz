// 守門測試：機關的畫面上不能再出現「機器最高速度」的設定或提醒。
// 2026-10-15 製作決定：這是預覽工具，現場機器的最高速度不是我們的事，機關一律照使用者設的時間動
// （設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md 最後面的「2026-10-15 拿掉速度提醒」）。
//
// 怎麼掃：用 TypeScript 解析，只看字串、樣板字串和 JSX 文字（程式碼註解、欄位名稱 maxSpeed 不算：後台欄位還在、
// 舊資料和舊版前端還會用）。範圍 = 機關的畫面（components/mechanisms）、機關總表、說明（使用說明、快速說明）。
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const sources = import.meta.glob(
  [
    '../components/mechanisms/*.tsx',
    '../lib/mechanisms/cueSheet.ts',
    '../lib/mechanisms/hoist.ts',
    '../lib/mechanisms/motion.ts',
    '../lib/mechanisms/useMechanisms.ts',
    '../pages/Help.tsx',
    '../components/HelpModal.tsx',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/** 機關畫面 / 總表：這些字一個都不能出現 */
const STRICT = /最高速度|照機器速度|機器速度|照最高速度|太快|來不及|晚到|會晚|晚一點到|需要秒數|可用秒數/;
/** 說明頁：整頁很長，別的地方有「小播放器速度」「太快」這類跟機關無關的字，所以只管跟機關速度有關的 */
const HELP = /最高速度|照機器速度|機器速度|照最高速度|來不及|晚到|晚一點到|需要秒數/;

/** 原始碼裡所有「會顯示給人看的字」：字串、樣板字串、JSX 文字 */
export function visibleTexts(file: string, src: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const add = (node: ts.Node, text: string) => {
    if (!text.trim()) return;
    out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('機關畫面和說明沒有速度提醒', () => {
  it('掃得到檔案（路徑沒打錯）', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(10);
  });

  it('機關畫面、機關總表：沒有最高速度、太快、來不及、照機器速度這些字', () => {
    const hits: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      if (file.endsWith('Help.tsx') || file.endsWith('HelpModal.tsx')) continue;
      for (const t of visibleTexts(file, src)) if (STRICT.test(t.text)) hits.push(`${file}:${t.line} ${t.text.slice(0, 40)}`);
    }
    expect(hits).toEqual([]);
  });

  it('使用說明：沒有機關最高速度、來不及、照機器速度這些字', () => {
    const hits: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      if (!file.endsWith('Help.tsx') && !file.endsWith('HelpModal.tsx')) continue;
      for (const t of visibleTexts(file, src)) if (HELP.test(t.text)) hits.push(`${file}:${t.line} ${t.text.slice(0, 40)}`);
    }
    expect(hits).toEqual([]);
  });

  it('掃描本身有效：這幾句會被抓到', () => {
    const bad = visibleTexts('x.tsx', "const a = '太快'; const b = <p>最高速度（選填）</p>; const c = `照機器速度（${1} 秒）`;");
    expect(bad.filter(t => STRICT.test(t.text)).length).toBe(3);
    // 註解和欄位名稱不算
    expect(visibleTexts('y.ts', '// 最高速度 太快\nconst maxSpeed = 1;').length).toBe(0);
  });
});
