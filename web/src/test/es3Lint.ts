// 測試用：檢查一支 After Effects 腳本（.jsx）是不是 ExtendScript 看得懂的寫法（ES3 加一點點 ES5）。
// 用 TypeScript 的解析器把腳本讀成語法樹（語法有錯會報），再逐個節點找 ES3 沒有的東西：
// let / const / 箭頭函式 / 樣板字串 / class / 解構 / 展開 / for...of / 預設參數 / 沒有名字的 catch / 結尾逗號 /
// ES5 以後才有的陣列、字串、物件方法（forEach、indexOf、trim、Object.keys…）和 JSON、Promise 等。
import ts from 'typescript';

/** ExtendScript 沒有的方法（點在後面的名字） */
const BAD_METHODS = new Set([
  'forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'indexOf', 'lastIndexOf', 'includes',
  'trim', 'trimStart', 'trimEnd', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'repeat', 'find', 'findIndex',
  'keys', 'values', 'entries', 'assign', 'isArray', 'bind', 'flat', 'flatMap', 'fill', 'from',
]);
/** ExtendScript 沒有的全域物件 */
const BAD_GLOBALS = new Set(['JSON', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Reflect', 'Proxy', 'BigInt', 'Intl']);

export function es3Violations(source: string): string[] {
  const text = source.replace(/^﻿/, '');
  const sf = ts.createSourceFile('script.jsx', text, ts.ScriptTarget.ES3, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of diags) out.push(`語法錯誤：${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  const at = (n: ts.Node) => `第 ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} 行`;
  const visit = (n: ts.Node) => {
    if (ts.isArrowFunction(n)) out.push(`${at(n)}：箭頭函式`);
    else if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTaggedTemplateExpression(n)) out.push(`${at(n)}：樣板字串`);
    else if (ts.isClassLike(n)) out.push(`${at(n)}：class`);
    else if (ts.isVariableDeclarationList(n) && (n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) out.push(`${at(n)}：let / const`);
    else if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) out.push(`${at(n)}：展開`);
    else if (ts.isForOfStatement(n)) out.push(`${at(n)}：for...of`);
    else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) out.push(`${at(n)}：解構`);
    else if (ts.isGetAccessor(n) || ts.isSetAccessor(n)) out.push(`${at(n)}：getter / setter`);
    else if (ts.isShorthandPropertyAssignment(n)) out.push(`${at(n)}：縮寫屬性`);
    else if (ts.isComputedPropertyName(n)) out.push(`${at(n)}：計算屬性名`);
    else if (ts.isMethodDeclaration(n)) out.push(`${at(n)}：方法縮寫`);
    else if (ts.isParameter(n) && (n.initializer || n.dotDotDotToken)) out.push(`${at(n)}：預設參數 / 其餘參數`);
    else if (ts.isCatchClause(n) && !n.variableDeclaration) out.push(`${at(n)}：catch 沒有名字`);
    else if (ts.isArrayLiteralExpression(n) && n.elements.hasTrailingComma) out.push(`${at(n)}：結尾逗號`);
    else if (ts.isObjectLiteralExpression(n) && n.properties.hasTrailingComma) out.push(`${at(n)}：結尾逗號`);
    else if (ts.isPropertyAccessExpression(n)) {
      if (n.questionDotToken) out.push(`${at(n)}：?.`);
      if (BAD_METHODS.has(n.name.text) && ts.isCallExpression(n.parent) && n.parent.expression === n) out.push(`${at(n)}：.${n.name.text}()`);
    } else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      out.push(`${at(n)}：${n.operatorToken.getText(sf)}`);
    } else if (ts.isIdentifier(n) && BAD_GLOBALS.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      out.push(`${at(n)}：${n.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
