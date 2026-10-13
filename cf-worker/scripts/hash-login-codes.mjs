// 上線新版前端那天跑一次：把所有人的登入碼換成雜湊、清掉明文，之後登入碼只在建立 / 重設時顯示一次。
// 完整步驟（含備份、怎麼確認、怎麼退回）在 docs/release-checklist.md，照那份做。
//
// 用法（在 cf-worker/ 底下）：
//   1. 匯出目前的登入碼（這個檔有明文登入碼，用完要刪）：
//        npx wrangler d1 execute stage-previz-db --remote --json \
//          --command "SELECT id, name, access_code FROM users WHERE access_code IS NOT NULL" > login-codes.json
//   2. 產生 SQL（螢幕上只會印人數和名字，不會印登入碼）：
//        node scripts/hash-login-codes.mjs login-codes.json hash-login-codes.sql
//   3. 執行：
//        npx wrangler d1 execute stage-previz-db --remote --file hash-login-codes.sql
//   4. 確認都好了（docs/release-checklist.md 的「確認」）之後，刪掉 login-codes.json 和 hash-login-codes.sql
//
// 退回（萬一登入出問題）：用同一個 login-codes.json 產生退回的 SQL，把明文寫回去、存法改回明文：
//        node scripts/hash-login-codes.mjs --revert login-codes.json revert-login-codes.sql
//        npx wrangler d1 execute stage-previz-db --remote --file revert-login-codes.sql
//      （切換之後才被重設過的人寫不回去，退回後要再幫他按一次「重設」）
//
// 產生的 SQL：
//   - 每個人：UPDATE ... SET access_code_hash = <雜湊> WHERE id = <id> AND access_code = <匯出時的登入碼>
//     （匯出之後才被改過登入碼的人不會被改到 → 他第一次登入時後台自己會換成雜湊）
//   - app_settings.login_code_storage = 'hashed'（後台從這時開始：登入碼只顯示一次、不收自訂）
//   - 有雜湊的人把明文清掉
// 雜湊跟後台登入時算的是同一個（loginCodes.mjs 的 hashLoginCode），所以每個人原本的登入碼照樣能用。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hashLoginCode, normalizeLoginCode, isStrongLoginCode, LOGIN_CODE_STORAGE_KEY, LOGIN_CODE_STORAGE_HASHED } from '../loginCodes.mjs';

const sql = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** wrangler d1 execute --json 的輸出（[{ results: [...] }]）或直接一個陣列 → 使用者列 */
export function rowsFromExport(data) {
  if (Array.isArray(data) && data.length && Array.isArray(data[0]?.results)) return data.flatMap(d => d.results || []);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  throw new Error('看不懂這個檔案：要是 wrangler d1 execute --json 的輸出');
}

/**
 * @param {{id: string, name?: string, access_code: string|null}[]} rows
 * @returns {Promise<{sql: string, report: {converted: number, skippedEmpty: number, duplicates: string[], weak: string[]}}>}
 *   report 裡只有人數和名字，沒有登入碼
 */
export async function buildHashSql(rows) {
  const report = { converted: 0, skippedEmpty: 0, duplicates: [], weak: [] };
  // 整理後一樣的登入碼（例如大小寫不同）不能兩個人共用同一個雜湊 → 兩個都跳過，請製作幫他們重設
  const byCode = new Map();
  for (const r of rows) {
    const code = normalizeLoginCode(r.access_code);
    if (!r.id || !code) { report.skippedEmpty++; continue; }
    const list = byCode.get(code) || [];
    list.push(r);
    byCode.set(code, list);
  }
  const lines = [
    '-- 由 cf-worker/scripts/hash-login-codes.mjs 產生：登入碼換成雜湊（docs/release-checklist.md）',
    '-- 這個檔案有明文登入碼，執行完請刪掉',
  ];
  for (const [code, list] of byCode) {
    if (list.length > 1) {
      for (const r of list) report.duplicates.push(r.name || r.id);
      continue;
    }
    const r = list[0];
    const hash = await hashLoginCode(code);
    lines.push(`UPDATE users SET access_code_hash = ${sql(hash)} WHERE id = ${sql(r.id)} AND access_code = ${sql(r.access_code)};`);
    report.converted++;
    if (!isStrongLoginCode(code)) report.weak.push(r.name || r.id);
  }
  lines.push(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (${sql(LOGIN_CODE_STORAGE_KEY)}, ${sql(LOGIN_CODE_STORAGE_HASHED)}, datetime('now'))`,
    `  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    `UPDATE users SET access_code = NULL WHERE access_code_hash IS NOT NULL;`,
  );
  return { sql: lines.join('\n') + '\n', report };
}

/** 讀匯出檔：PowerShell 5.1 的「>」會存成 UTF-16，也要看得懂；去掉 BOM */
export function readExportText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * 退回：把匯出時的明文寫回去（只寫回「雜湊還是那一組」的人，切換之後被重設過的不動）、存法改回明文
 */
export async function buildRevertSql(rows) {
  const lines = [
    '-- 由 cf-worker/scripts/hash-login-codes.mjs --revert 產生：登入碼改回明文（docs/release-checklist.md）',
    '-- 這個檔案有明文登入碼，執行完請刪掉',
    `DELETE FROM app_settings WHERE key = ${sql(LOGIN_CODE_STORAGE_KEY)};`,
  ];
  let restored = 0;
  for (const r of rows) {
    const code = normalizeLoginCode(r.access_code);
    if (!r.id || !code) continue;
    const hash = await hashLoginCode(code);
    lines.push(`UPDATE users SET access_code = ${sql(r.access_code)}, access_code_hash = NULL WHERE id = ${sql(r.id)} AND access_code_hash = ${sql(hash)};`);
    restored++;
  }
  return { sql: lines.join('\n') + '\n', restored };
}

async function main() {
  const args = process.argv.slice(2);
  const revert = args[0] === '--revert';
  const [file, outFile] = revert ? args.slice(1) : args;
  if (!file || !outFile) {
    console.error('用法：node scripts/hash-login-codes.mjs [--revert] <login-codes.json> <輸出的 .sql>');
    process.exit(1);
  }
  const rows = rowsFromExport(JSON.parse(readExportText(fs.readFileSync(file))));
  if (revert) {
    const { sql: out, restored } = await buildRevertSql(rows);
    fs.writeFileSync(outFile, out, 'utf8');
    console.error(`已寫到 ${outFile}：最多寫回 ${restored} 人的明文登入碼，存法改回明文`);
    return;
  }
  const { sql: out, report } = await buildHashSql(rows);
  fs.writeFileSync(outFile, out, 'utf8');
  console.error(`已寫到 ${outFile}`);
  console.error(`會換成雜湊：${report.converted} 人`);
  if (report.skippedEmpty) console.error(`沒有登入碼（跳過）：${report.skippedEmpty} 人`);
  if (report.duplicates.length) {
    console.error(`登入碼跟別人重複，沒有換（請在用戶頁幫他們按「重設」）：${report.duplicates.join('、')}`);
  }
  if (report.weak.length) {
    console.error(`登入碼比較弱（少於 8 個字或是自訂的），照樣能用，建議之後幫他們按「重設」：${report.weak.join('、')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
