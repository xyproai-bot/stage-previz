// 守門測試：不能再用瀏覽器內建的 alert() / confirm() / prompt()（醜、擋住整個分頁、手機上很難按、不能改字）。
// 一律改用 components/dialogs：confirmDialog / promptDialog / chooseDialog（站內對話框）、toast（不用回答的通知）。
//
// 怎麼掃：每個 .ts / .tsx 用 TypeScript 解析，找
//   - 直接叫 alert( / confirm( / prompt(（而且這個檔案裡沒有自己定義同名的東西，例如 const confirm = useConfirm()）
//   - window. / globalThis. / self. 後面接 alert / confirm / prompt（叫或拿來用都算）
// 註解、字串裡的字不算。*.test.ts(x) 和 src/test/ 底下不掃。
// beforeunload（關分頁前問一聲）是瀏覽器規定的，不在這裡管。
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../test/**', '!../**/*.d.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const NATIVE = new Set(['alert', 'confirm', 'prompt']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'top', 'parent']);

/**
 * 暫時允許的檔案：key = 檔案，value = 最多幾個 + 原因。數量只能變少。
 * StageScene.tsx 的「存視角」名稱還在用 window.prompt：這個檔案同時有另一件工作（機關）在改，
 * 避免兩邊打架先不動；那邊改完要換成 promptDialog，然後把這一條拿掉。
 */
const ALLOW_FILES: Record<string, { max: number; reason: string }> = {
  '../components/StageScene.tsx': {
    max: 1,
    reason: '3D 工具列「存視角」的名稱輸入；StageScene 同時有機關的工作在改，之後換成 promptDialog 再拿掉這一條',
  },
};

interface Hit { file: string; line: number; text: string }

/** 這個檔案自己有沒有定義叫 name 的東西（變數、函式、參數、import） */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (n: ts.BindingName) => {
    if (ts.isIdentifier(n)) names.add(n.text);
    else for (const el of n.elements) if (!ts.isOmittedExpression(el)) addBinding(el.name);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    else if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBinding(node.name);
    else if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      if (node.name) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

export function nativeDialogHits(file: string, src: string): Hit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const local = declaredNames(sf);
  const hits: Hit[] = [];
  const hit = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({ file, line: line + 1, text: node.getText(sf).slice(0, 80) });
  };
  const visit = (node: ts.Node) => {
    // alert(...) / confirm(...) / prompt(...)：直接叫全域的
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && NATIVE.has(node.expression.text) && !local.has(node.expression.text)) {
      hit(node);
    }
    // window.confirm / globalThis.alert / self.prompt（叫或拿來用都算）
    if (ts.isPropertyAccessExpression(node) && NATIVE.has(node.name.text)
      && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)) {
      hit(node);
    }
    // window['confirm']
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)
      && ts.isStringLiteralLike(node.argumentExpression) && NATIVE.has(node.argumentExpression.text)) {
      hit(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('不能用瀏覽器內建的 alert / confirm / prompt', () => {
  it('有掃到原始碼（防止 glob 寫錯變成什麼都沒掃）', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some(f => f.endsWith('/pages/ProjectEditor.tsx'))).toBe(true);
    expect(files.some(f => f.endsWith('/components/dialogs/DialogHost.tsx'))).toBe(true);
    expect(files.some(f => f.includes('.test.'))).toBe(false);
  });

  it('偵測規則本身有效：全域的會抓到，自己定義的、別的物件的方法、註解、字串不算', () => {
    const sample = [
      '// 註解裡的 confirm("x") 不算',
      'if (!confirm("刪除？")) return;',
      'window.alert("x");',
      'const name = globalThis.prompt("名稱");',
      "const ok = window['confirm']('y');",
      'const s = "alert(1)";',
      'await dialogs.confirm({ title: "x" });',
      'const f = window.confirm;',
      'self.alert("z");',
    ].join('\n');
    expect(nativeDialogHits('sample.tsx', sample).map(h => h.line)).toEqual([2, 3, 4, 5, 8, 9]);

    const localConfirm = [
      'const confirm = useConfirm();',
      'await confirm({ title: "刪除？", confirmLabel: "刪除" });',
      'function prompt(x: string) { return x; }',
      'prompt("ok");',
    ].join('\n');
    expect(nativeDialogHits('sample2.tsx', localConfirm)).toEqual([]);
  });

  it('src 底下的 .ts / .tsx 都沒有（允許清單裡的只能更少）', () => {
    const bad: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      const hits = nativeDialogHits(file, src);
      const allow = ALLOW_FILES[file];
      if (allow && hits.length <= allow.max) continue;
      for (const h of hits) bad.push(`${h.file}:${h.line}  ${h.text}`);
    }
    expect(bad).toEqual([]);
  });

  it('允許清單每一條都要寫原因，而且那個檔案還在', () => {
    for (const [file, { max, reason }] of Object.entries(ALLOW_FILES)) {
      expect(reason.trim().length, file).toBeGreaterThan(10);
      expect(max, file).toBeGreaterThan(0);
      expect(file in sources, `${file} 不存在了，請把這一條拿掉`).toBe(true);
    }
  });
});
