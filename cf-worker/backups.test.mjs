// 跑法：cd cf-worker && npm test
// 每天自動備份：什麼時候做、留哪些、SQL 格式、分好幾輪做、做完可以還原到新的資料庫
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import {
  backupDay, backupLocalHour, backupKey, parseBackupKey, parseBackupFileName, planBackupPrune, backupDue,
  sqlLiteral, insertStatement, quoteIdent, referencedTables, orderTablesByDependency,
  runBackupStep, listBackups, loadOpsState, saveOpsState, backupStatusView,
  BACKUP_STATE_KEY, BACKUP_PARTS_PREFIX,
} from './backups.mjs';

const HOUR = 3600_000, DAY = 86400_000;
// 2026-10-14 05:00 台灣時間 = 2026-10-13 21:00 UTC
const T_0500 = Date.parse('2026-10-13T21:00:00Z');

test('日期和時間用台灣時間', () => {
  assert.equal(backupDay(Date.parse('2026-10-13T15:59:00Z')), '2026-10-13');
  assert.equal(backupDay(Date.parse('2026-10-13T16:00:00Z')), '2026-10-14');
  assert.equal(backupLocalHour(T_0500), 5);
  assert.equal(backupKey('2026-10-14'), 'backups/d1/2026-10-14.sql.gz');
  assert.equal(parseBackupKey('backups/d1/2026-10-14.sql.gz'), '2026-10-14');
  assert.equal(parseBackupKey('backups/d1-parts/2026-10-14/1-00000.sql.gz'), null);
  assert.equal(parseBackupKey('backups/d1/notes.txt'), null);
  assert.equal(parseBackupFileName('2026-10-14.sql.gz'), '2026-10-14');
  assert.equal(parseBackupFileName('../2026-10-14.sql.gz'), null);
});

test('留最近 30 天 + 12 個月（每個月最早那一份）', () => {
  // 2025-01-01 ~ 2026-10-14 每天一份
  const days = [];
  for (let t = Date.parse('2025-01-01T00:00:00Z'); t <= Date.parse('2026-10-14T00:00:00Z'); t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
  const plan = planBackupPrune(days);
  // 每日：2026-09-15 ~ 2026-10-14
  for (let i = 0; i < 30; i++) assert.ok(plan.keep.includes(new Date(Date.parse('2026-10-14T00:00:00Z') - i * DAY).toISOString().slice(0, 10)));
  assert.ok(!plan.keep.includes('2026-09-14'));
  // 每月：2025-11 ~ 2026-10 的 1 號（12 個月）
  const monthly = [...plan.monthly].sort();
  assert.deepEqual(monthly, ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01',
    '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
  assert.ok(!plan.keep.includes('2025-10-01'));
  assert.equal(plan.keep.length + plan.remove.length, days.length);
  assert.equal(plan.keep.length, 30 + 11);  // 2026-10-01 同時是每日和每月
  // 中間漏了幾天：照份數算，不是照日期
  const sparse = ['2026-10-14', '2026-10-10', '2026-08-03', '2026-08-20', '2026-07-31'];
  const p2 = planBackupPrune(sparse, { keepDaily: 2, keepMonthly: 2 });
  assert.deepEqual(p2.keep.sort(), ['2026-08-03', '2026-10-10', '2026-10-14']);
  assert.deepEqual(p2.remove.sort(), ['2026-07-31', '2026-08-20']);
});

test('什麼時候做：每天 04:00 以後、第一次馬上做、做過了不重做、有人在做就等', () => {
  assert.equal(backupDue({}, T_0500).due, true);                                   // 從來沒做過
  assert.equal(backupDue({}, T_0500 - 3 * HOUR).due, true);                        // 02:00，沒做過 → 馬上做
  const doneToday = { last: { day: '2026-10-14', finishedAt: T_0500 - HOUR } };
  assert.deepEqual(backupDue(doneToday, T_0500 + HOUR), { due: false, reason: 'done' });
  const doneYesterday = { last: { day: '2026-10-13', finishedAt: T_0500 - DAY } };
  assert.equal(backupDue(doneYesterday, T_0500).due, true);                        // 05:00 → 做今天的
  const doneLateYesterday = { last: { day: '2026-10-13', finishedAt: T_0500 - 6 * HOUR } };
  assert.deepEqual(backupDue(doneLateYesterday, T_0500 - 3 * HOUR), { due: false, reason: 'waiting' });  // 02:00、昨天 23:00 剛做過
  assert.deepEqual(backupDue({ job: { leaseUntil: T_0500 + 60_000, startedAt: T_0500 } }, T_0500), { due: false, reason: 'busy' });
  assert.equal(backupDue({ job: { leaseUntil: 0, startedAt: T_0500 } }, T_0500 + 5 * 60_000).resume, true);
  assert.equal(backupDue({ job: { leaseUntil: 0, startedAt: T_0500 } }, T_0500 + 7 * HOUR).restart, true);
  assert.deepEqual(backupDue({ failedDay: '2026-10-14', last: { day: '2026-10-13', finishedAt: T_0500 - DAY } }, T_0500), { due: false, reason: 'failed_today' });
});

test('SQL 字面值', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral(42), '42');
  assert.equal(sqlLiteral(-1.5), '-1.5');
  assert.equal(sqlLiteral(NaN), 'NULL');
  assert.equal(sqlLiteral(Infinity), '9e999');
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral('換行\n也可以'), "'換行\n也可以'");
  assert.equal(sqlLiteral('a\u0000b'), "CAST(X'610062' AS TEXT)");
  assert.equal(sqlLiteral(new Uint8Array([0, 255, 16])), "X'00ff10'");
  assert.equal(sqlLiteral([1, 2]), "X'0102'");
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
  assert.equal(insertStatement('t', { __sp_rowid: 3, a: 1, b: 'x' }), `INSERT INTO "t" ("a","b") VALUES (1,'x');\n`);
});

test('被參照的表排前面', () => {
  const tables = [
    { name: 'cues', sql: 'CREATE TABLE cues (id TEXT, song_id TEXT REFERENCES songs(id), base_cue_id TEXT REFERENCES cues(id))' },
    { name: 'projects', sql: 'CREATE TABLE projects (id TEXT)' },
    { name: 'songs', sql: 'CREATE TABLE songs (id TEXT, project_id TEXT, FOREIGN KEY (project_id) REFERENCES "projects"(id))' },
  ];
  assert.deepEqual([...referencedTables(tables[0].sql)].sort(), ['cues', 'songs']);
  assert.deepEqual(orderTablesByDependency(tables).map(t => t.name), ['projects', 'songs', 'cues']);
});

async function seededDb() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u1', 'u1@x.test', '製作 O''Neil', 'admin', 'CODE-1')`),
    db.prepare(`INSERT INTO projects (id, name, description) VALUES ('p1', '金馬', '第一行\n第二行')`),
  ]);
  const stmts = [];
  for (let i = 0; i < 37; i++) {
    stmts.push(db.prepare(`INSERT INTO songs (id, project_id, name, "order", status) VALUES (?, 'p1', ?, ?, 'todo')`).bind(`s${i}`, `歌 ${i}`, i));
  }
  await db.batch(stmts);
  const logs = [];
  for (let i = 0; i < 25; i++) logs.push(db.prepare(`INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)`).bind(`ip${i}`, 1000 + i));
  await db.batch(logs);
  return db;
}

function restore(gz) {
  const sql = gunzipSync(Buffer.from(gz)).toString('utf8');
  const target = new DatabaseSync(':memory:');
  target.exec('PRAGMA foreign_keys = ON;');
  target.exec('BEGIN');
  target.exec(sql);
  target.exec('COMMIT');
  return { target, sql };
}

function tableRows(raw, table) {
  return raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(r => ({ ...r }));
}

test('一輪做完：存成 backups/d1/日期.sql.gz，可以還原成一模一樣的資料', async () => {
  const db = await seededDb();
  const r2 = memoryR2();
  const env = { DB: db, MODELS: r2 };
  const res = await runBackupStep(env, { now: T_0500 });
  assert.equal(res.action, 'done');
  assert.equal(res.key, 'backups/d1/2026-10-14.sql.gz');
  assert.equal(res.parts, 1);
  assert.deepEqual(r2.keys().filter(k => k.startsWith('backups/')), ['backups/d1/2026-10-14.sql.gz']);

  const { target, sql } = restore(r2.bytes(res.key));
  assert.match(sql, /^-- Stage Previz 資料庫備份/);
  assert.match(sql, /PRAGMA defer_foreign_keys = TRUE;/);
  assert.match(sql, /CREATE INDEX/);
  // 備份的不包含 sqlite_ 開頭的表
  assert.doesNotMatch(sql, /INSERT INTO "sqlite_/);
  for (const t of ['users', 'projects', 'songs', 'login_attempts', 'client_errors']) {
    assert.deepEqual(tableRows(target, t), tableRows(db.raw, t), t);
  }
  assert.equal(tableRows(target, 'users').find(u => u.id === 'u1').name, "製作 O'Neil");
  assert.equal(tableRows(target, 'projects').find(p => p.id === 'p1').description, '第一行\n第二行');
  // 還原後的 schema 一樣（索引也在）
  const idx = (raw) => raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).all().map(r => r.name);
  assert.deepEqual(idx(target), idx(db.raw));

  // 做過了：今天不會再做
  const again = await runBackupStep(env, { now: T_0500 + 10 * 60_000 });
  assert.deepEqual(again, { action: 'idle', reason: 'done' });
  const st = (await loadOpsState(db, BACKUP_STATE_KEY)).value;
  const view = backupStatusView(st);
  assert.equal(view.last.day, '2026-10-14');
  assert.equal(view.last.rows, res.rows);
  assert.equal(view.running, null);
});

test('分好幾輪做（每輪有上限），最後接成一個檔，還原結果一樣', async () => {
  const db = await seededDb();
  const r2 = memoryR2();
  const env = { DB: db, MODELS: r2 };
  const opts = { pageRows: 10, maxRowsPerRun: 15, maxQueriesPerRun: 3 };
  const results = [];
  let now = T_0500;
  for (let i = 0; i < 30; i++) {
    const r = await runBackupStep(env, { now, opts });
    results.push(r);
    if (r.action === 'done') break;
    assert.equal(r.action, 'progress');
    // 還沒做完時，段落放在 backups/d1-parts/，正式的檔還沒出現
    assert.ok(r2.keys().some(k => k.startsWith(BACKUP_PARTS_PREFIX)));
    assert.ok(!r2.keys().includes('backups/d1/2026-10-14.sql.gz'));
    now += 5 * 60_000;
  }
  const done = results.at(-1);
  assert.equal(done.action, 'done');
  assert.ok(done.parts >= 3, `應該分好幾段，實際 ${done.parts}`);
  assert.ok(!r2.keys().some(k => k.startsWith(BACKUP_PARTS_PREFIX)), '段落接完要刪掉');
  const { target } = restore(r2.bytes(done.key));
  for (const t of ['users', 'projects', 'songs', 'login_attempts']) {
    assert.deepEqual(tableRows(target, t), tableRows(db.raw, t), t);
  }
  assert.equal(tableRows(target, 'songs').length, 37);
  assert.equal(tableRows(target, 'login_attempts').length, 25);
});

test('有人在做（租約還沒到）就不做；做到一半失敗會從上一段接著做', async () => {
  const db = await seededDb();
  const r2 = memoryR2();
  const env = { DB: db, MODELS: r2 };
  const opts = { pageRows: 10, maxRowsPerRun: 15, maxQueriesPerRun: 2 };
  const first = await runBackupStep(env, { now: T_0500, opts });
  assert.equal(first.action, 'progress');
  const st1 = (await loadOpsState(db, BACKUP_STATE_KEY)).value;

  // 別的排程拿著租約
  const loaded = await loadOpsState(db, BACKUP_STATE_KEY);
  await saveOpsState(db, BACKUP_STATE_KEY, { ...loaded.value, job: { ...loaded.value.job, leaseUntil: T_0500 + 10 * 60_000 } }, loaded.version, T_0500 + 1);
  assert.deepEqual(await runBackupStep(env, { now: T_0500 + 60_000, opts }), { action: 'idle', reason: 'busy' });
  const l2 = await loadOpsState(db, BACKUP_STATE_KEY);
  await saveOpsState(db, BACKUP_STATE_KEY, { ...l2.value, job: { ...l2.value.job, leaseUntil: 0 } }, l2.version, T_0500 + 2);

  // R2 寫入壞掉一次 → 這一輪失敗，進度不前進
  const realPut = r2.put;
  r2.put = async () => { throw new Error('R2 暫時不能寫'); };
  const failed = await runBackupStep(env, { now: T_0500 + 5 * 60_000, opts });
  assert.equal(failed.action, 'error');
  const st2 = (await loadOpsState(db, BACKUP_STATE_KEY)).value;
  assert.equal(st2.job.attempts, 1);
  assert.equal(st2.job.rows, st1.job.rows);
  assert.deepEqual(st2.job.parts, st1.job.parts);
  assert.equal(backupStatusView(st2).lastError.message, 'R2 暫時不能寫');
  r2.put = realPut;

  let now = T_0500 + 10 * 60_000, r;
  for (let i = 0; i < 30; i++) {
    r = await runBackupStep(env, { now, opts });
    if (r.action === 'done') break;
    now += 5 * 60_000;
  }
  assert.equal(r.action, 'done');
  const { target } = restore(r2.bytes(r.key));
  assert.deepEqual(tableRows(target, 'songs'), tableRows(db.raw, 'songs'));
  assert.equal(backupStatusView((await loadOpsState(db, BACKUP_STATE_KEY)).value).lastError, null);
});

test('連續失敗 5 次 → 放棄今天的、明天再做', async () => {
  const db = await seededDb();
  const r2 = memoryR2();
  r2.put = async () => { throw new Error('壞了'); };
  const env = { DB: db, MODELS: r2 };
  let r;
  for (let i = 0; i < 5; i++) r = await runBackupStep(env, { now: T_0500 + i * 5 * 60_000 });
  assert.equal(r.action, 'failed');
  assert.deepEqual(await runBackupStep(env, { now: T_0500 + HOUR }), { action: 'idle', reason: 'failed_today' });
  const view = backupStatusView((await loadOpsState(db, BACKUP_STATE_KEY)).value);
  assert.equal(view.failedDay, '2026-10-14');
  assert.equal(view.lastError.message, '壞了');
  // 隔天 04:00 以後再試
  assert.equal(backupDue((await loadOpsState(db, BACKUP_STATE_KEY)).value, T_0500 + DAY).due, true);
});

test('做完會刪掉超過保留期限的舊備份（不認得的檔不動）', async () => {
  const db = await seededDb();
  const r2 = memoryR2();
  // 放 40 天份的舊備份 + 一個不是備份的檔
  for (let i = 1; i <= 40; i++) {
    const day = new Date(Date.parse('2026-10-14T00:00:00Z') - i * DAY).toISOString().slice(0, 10);
    await r2.put(backupKey(day), 'old');
  }
  await r2.put('backups/d1/README.txt', 'keep me');
  const res = await runBackupStep({ DB: db, MODELS: r2 }, { now: T_0500 });
  assert.equal(res.action, 'done');
  const days = r2.keys().map(parseBackupKey).filter(Boolean).sort();
  // 留：今天 + 前 29 天（每日 30 份）+ 9/1（每月；9/4 以前的只留每月第一份）
  assert.equal(days.length, 30 + 1);
  assert.ok(days.includes('2026-10-14'));
  assert.ok(days.includes('2026-09-15'));
  assert.ok(!days.includes('2026-09-14'));
  assert.ok(days.includes('2026-09-04'), '9 月最早的一份（9/4）是每月備份');
  assert.ok(r2.keys().includes('backups/d1/README.txt'));
  const list = await listBackups(r2);
  assert.equal(list[0].day, '2026-10-14');
  assert.equal(list[0].file, '2026-10-14.sql.gz');
  assert.ok(list.find(x => x.day === '2026-09-04').monthly);
});
