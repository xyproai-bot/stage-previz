// 跑法：cd cf-worker && npm test
// 上線那天的「登入碼換成雜湊」：在記憶體裡的 SQLite 跑一遍產生的 SQL（跟 D1 一樣是 SQLite），
// 確認每個人原本的登入碼照樣查得到自己、明文清掉、存法切成 hashed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHashSql, buildRevertSql, rowsFromExport, readExportText } from './hash-login-codes.mjs';
import { hashLoginCode, generateLoginCode } from '../loginCodes.mjs';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 舊版 Node 沒有 → 跳過要 SQLite 的測試 */ }

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'migrations');

/** 把 migrations 全部跑一遍（跟 D1 上的表一模一樣） */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  return db;
}

test('匯出檔：wrangler --json 格式、直接陣列、PowerShell 存成 UTF-16 都看得懂', () => {
  const rows = [{ id: 'u_1', name: 'A', access_code: 'X' }];
  assert.deepEqual(rowsFromExport([{ results: rows, success: true }]), rows);
  assert.deepEqual(rowsFromExport(rows), rows);
  const json = JSON.stringify([{ results: rows }]);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
  assert.deepEqual(rowsFromExport(JSON.parse(readExportText(utf16))), rows);
  const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')]);
  assert.deepEqual(rowsFromExport(JSON.parse(readExportText(bom8))), rows);
  assert.throws(() => rowsFromExport({ nope: 1 }));
});

test('產生的 SQL：人數、重複的跳過、弱的列出來（報告裡沒有登入碼）', async () => {
  const strong = generateLoginCode();
  const { sql, report } = await buildHashSql([
    { id: 'u_a', name: '阿明', access_code: strong },
    { id: 'u_b', name: '小華', access_code: 'PHANG-001' },
    { id: 'u_c', name: '甲', access_code: 'dup1' },
    { id: 'u_d', name: '乙', access_code: 'DUP1' },
    { id: 'u_e', name: '空', access_code: '' },
  ]);
  assert.equal(report.converted, 2);
  assert.deepEqual(report.duplicates.sort(), ['乙', '甲'].sort());
  assert.deepEqual(report.weak, ['小華']);
  assert.equal(report.skippedEmpty, 1);
  assert.equal(JSON.stringify(report).includes(strong), false);
  assert.match(sql, /login_code_storage/);
  assert.equal(sql.includes("WHERE id = 'u_c'"), false);
});

test('在 SQLite 跑一遍：每個人原本的登入碼照樣能用、明文清掉、存法 = hashed', { skip: !DatabaseSync }, async () => {
  const db = freshDb();
  const people = [
    { id: 'u_phang', name: 'Phang', code: 'PHANG-001', seeded: true },  // 0001 / 0007 migration 就有的人（舊的自訂號碼）
    { id: 'u_a', name: "O'Neil", code: generateLoginCode() }, // 名字有單引號
    { id: 'u_b', name: '王小明', code: 'ABCD2345' },          // 舊的 8 碼
    { id: 'u_c', name: '沒有碼', code: null },                // 用邀請連結進來的
  ];
  const ins = db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, 'animator', ?)`);
  for (const p of people.filter(p => !p.seeded)) ins.run(p.id, `${p.id}@auto.local`, p.name, p.code);
  assert.equal(db.prepare(`SELECT access_code FROM users WHERE id = 'u_phang'`).get().access_code, 'PHANG-001');

  const exported = db.prepare(`SELECT id, name, access_code FROM users WHERE access_code IS NOT NULL`).all();
  const { sql } = await buildHashSql(exported);
  db.exec(sql);

  // 跟後台雜湊存法的登入一樣查：WHERE access_code_hash = ? OR access_code = ?
  const login = db.prepare(`SELECT id FROM users WHERE access_code_hash = ? OR access_code = ? LIMIT 1`);
  for (const p of people.filter(p => p.code)) {
    const hit = login.get(await hashLoginCode(p.code), p.code);
    assert.equal(hit?.id, p.id, p.name);
    // 小寫、有空白也一樣（跟登入頁一樣整理）
    const hit2 = login.get(await hashLoginCode(` ${p.code.toLowerCase()} `), p.code.toLowerCase());
    assert.equal(hit2?.id, p.id, p.name + '（小寫）');
  }
  assert.equal(login.get(await hashLoginCode('WRONG-CODE'), 'WRONG-CODE'), undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE access_code IS NOT NULL`).get().n, 0);
  assert.equal(db.prepare(`SELECT value FROM app_settings WHERE key = 'login_code_storage'`).get().value, 'hashed');
  // 再跑一次也沒關係（明文已經清掉 → 什麼都不會改）
  db.exec(sql);
  assert.equal(login.get(await hashLoginCode('PHANG-001'), 'PHANG-001')?.id, 'u_phang');
});

test('匯出之後才被改過登入碼的人：不會被蓋掉，新的明文留著（他登入時後台自己換）', { skip: !DatabaseSync }, async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_x', 'x@auto.local', 'X', 'director', 'OLDCODE234')`).run();
  const exported = db.prepare(`SELECT id, name, access_code FROM users`).all();
  db.prepare(`UPDATE users SET access_code = 'NEWCODE234' WHERE id = 'u_x'`).run();
  db.exec((await buildHashSql(exported)).sql);
  const row = db.prepare(`SELECT access_code, access_code_hash FROM users WHERE id = 'u_x'`).get();
  assert.equal(row.access_code, 'NEWCODE234');
  assert.equal(row.access_code_hash, null);
});

test('退回：明文寫回去、存法改回明文；切換之後被重設過的人不動', { skip: !DatabaseSync }, async () => {
  const db = freshDb();
  const ins = db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, 'animator', ?)`);
  ins.run('u_a', 'a@auto.local', 'A', 'AAAA2345BB');
  ins.run('u_b', 'b@auto.local', 'B', 'BBBB2345CC');
  const exported = db.prepare(`SELECT id, name, access_code FROM users WHERE access_code IS NOT NULL`).all();
  db.exec((await buildHashSql(exported)).sql);
  // 切換之後 B 被重設了（只存雜湊）
  db.prepare(`UPDATE users SET access_code_hash = ? WHERE id = 'u_b'`).run(await hashLoginCode('NEWB2345XY'));
  db.exec((await buildRevertSql(exported)).sql);
  assert.equal(db.prepare(`SELECT access_code FROM users WHERE id = 'u_a'`).get().access_code, 'AAAA2345BB');
  assert.equal(db.prepare(`SELECT access_code_hash FROM users WHERE id = 'u_a'`).get().access_code_hash, null);
  assert.equal(db.prepare(`SELECT access_code FROM users WHERE id = 'u_b'`).get().access_code, null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM app_settings`).get().n, 0);
  assert.equal(db.prepare(`SELECT access_code FROM users WHERE id = 'u_phang'`).get().access_code, 'PHANG-001');
});
