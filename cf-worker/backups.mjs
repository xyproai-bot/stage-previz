// 資料庫每天自動備份（還原步驟：docs/backups.md）
//
// 排程（每 5 分鐘）呼叫 runBackupStep：
//   - 什麼時候備：台灣時間每天 04:00 以後做當天的一份；24 小時內都沒有備份（例如第一次上線）就馬上做
//   - 匯出所有資料表（不含 sqlite_ / _cf_ 開頭的系統表）成 SQL（CREATE TABLE + INSERT），gzip（CompressionStream）
//     存到 R2：backups/d1/YYYY-MM-DD.sql.gz（日期是台灣時間開始備份那天）
//   - 一頁一頁讀（每頁 pageRows 列，用 rowid 往下翻），每一輪有上限（列數 / 大小 / 時間 / 查詢次數）
//     資料庫小（現在不到 1 MB）→ 一輪做完；大的話分好幾輪：每一輪壓成一段放 backups/d1-parts/，
//     最後一輪把每段接起來（gzip 可以直接接：解壓出來就是整份 SQL）
//   - 第一輪把每個表的第一頁用同一個 batch 讀（同一個交易 → 小資料庫拿到的是同一個時間點的資料）
//   - 留最近 30 天的每日備份 + 最近 12 個月每個月的第一份，其他的刪掉
//   - 進度存在 D1 的 ops_state（key = backup_d1）；同時只會有一輪在跑（租約 + 版本檢查）
//
// 製作看清單 / 下載：GET /api/admin/backups、GET /api/admin/backups/YYYY-MM-DD.sql.gz（ops.mjs）

export const BACKUP_PREFIX = 'backups/d1/';
export const BACKUP_PARTS_PREFIX = 'backups/d1-parts/';
export const BACKUP_STATE_KEY = 'backup_d1';
/** 台灣時間（UTC+8，沒有日光節約） */
export const BACKUP_TZ_OFFSET_MS = 8 * 3600_000;

export const BACKUP_DEFAULTS = Object.freeze({
  hour: 4,                          // 台灣時間幾點以後做當天的備份
  pageRows: 1000,                   // 一次讀幾列
  maxRowsPerRun: 20000,             // 一輪最多幾列
  maxRawBytesPerRun: 24 * 1024 * 1024, // 一輪最多產生多少 SQL（壓縮前）
  maxMsPerRun: 20_000,              // 一輪最多跑多久
  maxQueriesPerRun: 150,            // 一輪最多查幾次資料庫
  leaseMs: 3 * 60_000,              // 一輪的租約（別的排程看到就不重複做）
  stuckMs: 6 * 3600_000,            // 一份備份做超過 6 小時還沒好 → 重來
  maxAttempts: 5,                   // 連續失敗幾次就放棄今天的（明天再做）
  keepDaily: 30,
  keepMonthly: 12,
});

const DAY_MS = 86400_000;

/** 台灣時間的日期 'YYYY-MM-DD' */
export function backupDay(nowMs) {
  return new Date(nowMs + BACKUP_TZ_OFFSET_MS).toISOString().slice(0, 10);
}
/** 台灣時間幾點（0–23） */
export function backupLocalHour(nowMs) {
  return new Date(nowMs + BACKUP_TZ_OFFSET_MS).getUTCHours();
}
export function backupKey(day) {
  return `${BACKUP_PREFIX}${day}.sql.gz`;
}
/** 'backups/d1/2026-10-14.sql.gz' → '2026-10-14'；不是備份檔 → null */
export function parseBackupKey(key) {
  const m = /^backups\/d1\/(\d{4}-\d{2}-\d{2})\.sql\.gz$/.exec(String(key || ''));
  return m ? m[1] : null;
}
/** 下載網址上的檔名 → 日期 */
export function parseBackupFileName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})\.sql\.gz$/.exec(String(name || ''));
  return m ? m[1] : null;
}

/**
 * 留哪些、刪哪些：最近 keepDaily 份（照日期）+ 最近 keepMonthly 個月、每個月最早的那一份
 * @param {string[]} days  'YYYY-MM-DD'
 * @returns {{keep: string[], remove: string[], daily: Set<string>, monthly: Set<string>}}
 */
export function planBackupPrune(days, { keepDaily = BACKUP_DEFAULTS.keepDaily, keepMonthly = BACKUP_DEFAULTS.keepMonthly } = {}) {
  const sorted = [...new Set(days.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().reverse();
  const daily = new Set(sorted.slice(0, keepDaily));
  const firstOfMonth = new Map();  // 'YYYY-MM' → 最早的日期
  for (const d of sorted) {
    const m = d.slice(0, 7);
    if (!firstOfMonth.has(m) || d < firstOfMonth.get(m)) firstOfMonth.set(m, d);
  }
  const months = [...firstOfMonth.keys()].sort().reverse().slice(0, keepMonthly);
  const monthly = new Set(months.map(m => firstOfMonth.get(m)));
  const keep = sorted.filter(d => daily.has(d) || monthly.has(d));
  const remove = sorted.filter(d => !daily.has(d) && !monthly.has(d));
  return { keep, remove, daily, monthly };
}

/**
 * 這一輪要不要做
 * @returns {{due: boolean, reason: string, resume?: boolean, restart?: boolean}}
 */
export function backupDue(state, nowMs, opts = BACKUP_DEFAULTS) {
  const o = { ...BACKUP_DEFAULTS, ...opts };
  const s = state || {};
  const today = backupDay(nowMs);
  if (s.job) {
    if (Number(s.job.leaseUntil) > nowMs) return { due: false, reason: 'busy' };
    if (nowMs - Number(s.job.startedAt) > o.stuckMs) return { due: true, reason: 'stuck', restart: true };
    return { due: true, reason: 'resume', resume: true };
  }
  if (s.last?.day === today) return { due: false, reason: 'done' };
  if (s.failedDay === today) return { due: false, reason: 'failed_today' };
  if (backupLocalHour(nowMs) >= o.hour) return { due: true, reason: 'daily' };
  if (!s.last || nowMs - Number(s.last.finishedAt || 0) >= DAY_MS) return { due: true, reason: 'overdue' };
  return { due: false, reason: 'waiting' };
}

// ─── SQL ───

export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** 一個值 → SQL 字面值（字串裡有 NUL 用 hex，BLOB 用 X'..'） */
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return String(v);
    if (Number.isNaN(v)) return 'NULL';
    return v > 0 ? '9e999' : '-9e999';
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') {
    if (v.includes('\u0000')) return `CAST(X'${bytesToHex(new TextEncoder().encode(v))}' AS TEXT)`;
    return "'" + v.replace(/'/g, "''") + "'";
  }
  if (v instanceof ArrayBuffer) return `X'${bytesToHex(new Uint8Array(v))}'`;
  if (ArrayBuffer.isView(v)) return `X'${bytesToHex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}'`;
  if (Array.isArray(v) && v.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return `X'${bytesToHex(v)}'`;
  return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
}

const ROWID_COL = '__sp_rowid';

/** 一列 → INSERT（明確寫欄位名稱，表的欄位順序不同也能還原） */
export function insertStatement(table, row) {
  const cols = Object.keys(row).filter(c => c !== ROWID_COL);
  return `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(',')}) VALUES (${cols.map(c => sqlLiteral(row[c])).join(',')});\n`;
}

function isSkippedTable(name) {
  return /^sqlite_/i.test(name) || /^_cf_/i.test(name);
}

/** CREATE TABLE 裡 REFERENCES 到哪些表 */
export function referencedTables(sql) {
  const out = new Set();
  const re = /REFERENCES\s+["`[]?([A-Za-z0-9_]+)["`\]]?/gi;
  let m;
  while ((m = re.exec(String(sql || '')))) out.add(m[1]);
  return out;
}

/**
 * 被參照的表排前面（還原時就算沒有延後檢查外鍵，也是先有專案才有歌）；繞成一圈的照名字排
 * @param {Array<{name: string, sql: string}>} tables  已照名字排好
 */
export function orderTablesByDependency(tables) {
  const names = new Set(tables.map(t => t.name));
  const deps = new Map(tables.map(t => [t.name, [...referencedTables(t.sql)].filter(n => n !== t.name && names.has(n))]));
  const done = new Set();
  const out = [];
  let progress = true;
  while (out.length < tables.length && progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t.name)) continue;
      if (deps.get(t.name).every(d => done.has(d))) { done.add(t.name); out.push(t); progress = true; }
    }
  }
  for (const t of tables) if (!done.has(t.name)) out.push(t);
  return out;
}

/** 要備份的資料表（被參照的排前面）：[{ name, sql, rowid }] */
export async function listBackupTables(db) {
  const r = await db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY name`
  ).all();
  const tables = (r.results || [])
    .filter(t => !isSkippedTable(t.name) && !/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql))
    .map(t => ({ name: t.name, sql: t.sql, rowid: !/WITHOUT\s+ROWID/i.test(t.sql.slice(t.sql.lastIndexOf(')'))) }));
  return orderTablesByDependency(tables);
}

/** 資料都寫完以後才建的東西（索引、view、trigger） */
async function schemaFooter(db, tableNames) {
  const r = await db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE type IN ('index', 'view', 'trigger') AND sql IS NOT NULL
      ORDER BY CASE type WHEN 'index' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name`
  ).all();
  const tables = new Set(tableNames);
  return (r.results || [])
    .filter(o => !isSkippedTable(o.name) && (o.type === 'view' || tables.has(o.tbl_name)))
    .map(o => o.sql.trim().replace(/;?\s*$/, ';') + '\n')
    .join('');
}

function pageStatement(db, table, cursor, pageRows) {
  if (table.rowid) {
    return db.prepare(
      `SELECT rowid AS ${ROWID_COL}, * FROM ${quoteIdent(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`
    ).bind(cursor ?? -9007199254740991, pageRows);
  }
  return db.prepare(`SELECT * FROM ${quoteIdent(table.name)} LIMIT ? OFFSET ?`).bind(pageRows, cursor ?? 0);
}

// ─── gzip 一段 ───

class GzipChunk {
  constructor() {
    this.cs = new CompressionStream('gzip');
    this.writer = this.cs.writable.getWriter();
    this.out = new Response(this.cs.readable).arrayBuffer();
    this.out.catch(() => {});
    this.pending = [];
    this.pendingLen = 0;
    this.rawBytes = 0;
    this.enc = new TextEncoder();
  }
  async write(text) {
    this.pending.push(text);
    this.pendingLen += text.length;
    if (this.pendingLen >= 64 * 1024) await this.flush();
  }
  async flush() {
    if (!this.pending.length) return;
    const bytes = this.enc.encode(this.pending.join(''));
    this.pending = [];
    this.pendingLen = 0;
    this.rawBytes += bytes.byteLength;
    await this.writer.write(bytes);
  }
  async finish() {
    await this.flush();
    await this.writer.close();
    return new Uint8Array(await this.out);
  }
  abort() {
    try { this.writer.abort(); } catch { /* ignore */ }
  }
}

// ─── 進度（D1 ops_state）───

export async function loadOpsState(db, key) {
  const row = await db.prepare(`SELECT value, updated_at FROM ops_state WHERE key = ? LIMIT 1`).bind(key).first();
  if (!row) return { value: null, version: null };
  let value = null;
  try { value = JSON.parse(row.value); } catch { value = null; }
  return { value, version: Number(row.updated_at) };
}

/** 存進度：版本對得上才存（別的排程先改了 → false） */
export async function saveOpsState(db, key, value, expectedVersion, nowMs = Date.now()) {
  const version = Math.max(nowMs, (Number(expectedVersion) || 0) + 1);
  const r = await db.prepare(
    `INSERT INTO ops_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE ops_state.updated_at IS ?`
  ).bind(key, JSON.stringify(value), version, expectedVersion ?? null).run();
  return r?.meta?.changes ? version : false;
}

// ─── R2 ───

async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const r = await bucket.list({ prefix, cursor, limit: 1000 });
    out.push(...(r.objects || []));
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
}

async function deleteKeys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const slice = keys.slice(i, i + 1000);
    if (slice.length) await bucket.delete(slice);
  }
}

/** 每段接起來成一個檔（gzip 可以直接接） */
async function assembleParts(bucket, parts, finalKey, meta) {
  const total = parts.reduce((s, p) => s + Number(p.size || 0), 0);
  const opts = { httpMetadata: { contentType: 'application/gzip' }, customMetadata: meta };
  if (typeof globalThis.FixedLengthStream === 'function') {
    const { readable, writable } = new globalThis.FixedLengthStream(total);
    const pump = (async () => {
      for (const p of parts) {
        const o = await bucket.get(p.key);
        if (!o) throw new Error(`備份的第 ${p.key} 段不見了`);
        await o.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    })();
    pump.catch(() => {});
    const [obj] = await Promise.all([bucket.put(finalKey, readable, opts), pump]);
    return obj;
  }
  // 測試環境（沒有 FixedLengthStream）：放記憶體接
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    const o = await bucket.get(p.key);
    if (!o) throw new Error(`備份的第 ${p.key} 段不見了`);
    const b = new Uint8Array(await o.arrayBuffer());
    buf.set(b, off);
    off += b.byteLength;
  }
  return bucket.put(finalKey, buf, opts);
}

// ─── 一輪 ───

function newJob(day, nowMs, tables) {
  return {
    day, startedAt: nowMs, leaseUntil: 0,
    // 每個表各自的進度：cursor = 讀到哪個 rowid（WITHOUT ROWID 的表是 offset），done = 讀完了
    tables: tables.map(t => ({ name: t.name, sql: t.sql, rowid: t.rowid, cursor: null, done: false })),
    headerDone: false, firstPagesDone: false,
    parts: [], rows: 0, rawBytes: 0, attempts: 0, error: null,
  };
}

function header(job) {
  return [
    `-- Stage Previz 資料庫備份（D1 stage-previz-db）${job.day}，開始時間 ${new Date(job.startedAt).toISOString()}`,
    '-- 還原方式：docs/backups.md（請還原到新的空資料庫）',
    'PRAGMA defer_foreign_keys = TRUE;',
    ...job.tables.map(t => t.sql.trim().replace(/;?\s*$/, ';')),
    '',
  ].join('\n');
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * 排程每一輪呼叫一次：該做就往下做一段
 * @param {{DB: any, MODELS: any}} env
 * @param {{now?: number, opts?: Partial<typeof BACKUP_DEFAULTS>, clock?: () => number}} [o]
 * @returns {Promise<{action: string, reason?: string, day?: string, key?: string, size?: number, rows?: number, parts?: number, error?: string}>}
 */
export async function runBackupStep(env, { now = Date.now(), opts = {}, clock = () => Date.now() } = {}) {
  const o = { ...BACKUP_DEFAULTS, ...opts };
  const db = env.DB, bucket = env.MODELS;
  if (!db || !bucket) return { action: 'skip', reason: 'no_bindings' };

  const loaded = await loadOpsState(db, BACKUP_STATE_KEY);
  const state = loaded.value || {};
  const due = backupDue(state, now, o);
  if (!due.due) return { action: 'idle', reason: due.reason };

  let job;
  if (due.resume) {
    job = state.job;
  } else {
    if (due.restart && state.job?.parts?.length) {
      await deleteKeys(bucket, state.job.parts.map(p => p.key)).catch(() => {});
    }
    // 上一份沒做完留下的段落一起清掉（同時只會有一份在做）
    const leftovers = await listAll(bucket, BACKUP_PARTS_PREFIX).catch(() => []);
    if (leftovers.length) await deleteKeys(bucket, leftovers.map(x => x.key)).catch(() => {});
    job = newJob(backupDay(now), now, await listBackupTables(db));
  }

  // 租約：別的排程看到就不做
  job.leaseUntil = now + o.leaseMs;
  let version = await saveOpsState(db, BACKUP_STATE_KEY, { ...state, job }, loaded.version, now);
  if (!version) return { action: 'idle', reason: 'busy' };
  // 這一輪失敗 → 進度回到這一輪開始的樣子（這一輪讀的還沒存進 R2）
  const atStart = clone(job);

  const t0 = clock();
  const gz = new GzipChunk();
  try {
    let queries = 0, rowsThisRun = 0;
    const emit = async (table, rows) => {
      for (const row of rows) await gz.write(insertStatement(table.name, row));
      rowsThisRun += rows.length;
      job.rows += rows.length;
      if (rows.length < o.pageRows) {
        table.done = true;
        table.cursor = null;
      } else {
        table.cursor = table.rowid ? rows[rows.length - 1][ROWID_COL] : (Number(table.cursor) || 0) + rows.length;
      }
    };

    if (!job.headerDone) {
      await gz.write(header(job));
      job.headerDone = true;
      for (const t of job.tables) delete t.sql;  // 進度裡不用再留建表的 SQL
    }

    // 第一輪：每個表的第一頁用同一個 batch 讀（同一個交易 → 小資料庫拿到同一個時間點的資料）
    if (!job.firstPagesDone && job.tables.length) {
      const res = await db.batch(job.tables.map(t => pageStatement(db, t, null, o.pageRows)));
      queries += 1;
      for (let i = 0; i < job.tables.length; i++) await emit(job.tables[i], res[i]?.results || []);
      job.firstPagesDone = true;
    }

    // 還沒讀完的表：一頁一頁往下讀，到這一輪的上限就停
    for (;;) {
      const table = job.tables.find(t => !t.done);
      if (!table) break;
      if (rowsThisRun >= o.maxRowsPerRun || gz.rawBytes + gz.pendingLen >= o.maxRawBytesPerRun
          || clock() - t0 >= o.maxMsPerRun || queries >= o.maxQueriesPerRun) break;
      const r = await pageStatement(db, table, table.cursor, o.pageRows).all();
      queries += 1;
      await emit(table, r.results || []);
    }

    const finished = job.tables.every(t => t.done);
    if (finished) {
      await gz.write(await schemaFooter(db, job.tables.map(t => t.name)));
      await gz.write(`-- 備份結束：${job.tables.length} 個表、${job.rows} 列\n`);
    }
    const bytes = await gz.finish();
    job.rawBytes += gz.rawBytes;

    const finalKey = backupKey(job.day);
    const meta = { day: job.day, rows: String(job.rows), tables: String(job.tables.length), startedAt: new Date(job.startedAt).toISOString() };
    let finalObj = null;
    if (finished && job.parts.length === 0) {
      // 一輪就做完（一般情況）：直接存成最後的檔
      finalObj = await bucket.put(finalKey, bytes, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: meta });
    } else {
      const seq = job.parts.length;
      const partKey = `${BACKUP_PARTS_PREFIX}${job.day}/${job.startedAt}-${String(seq).padStart(5, '0')}.sql.gz`;
      await bucket.put(partKey, bytes, { httpMetadata: { contentType: 'application/gzip' } });
      job.parts.push({ key: partKey, size: bytes.byteLength });
      if (finished) {
        finalObj = await assembleParts(bucket, job.parts, finalKey, meta);
        await deleteKeys(bucket, job.parts.map(p => p.key)).catch(() => {});
      }
    }

    if (!finished) {
      job.leaseUntil = 0;
      job.error = null;
      await saveOpsState(db, BACKUP_STATE_KEY, { ...state, job }, version, clock());
      return { action: 'progress', day: job.day, rows: job.rows, parts: job.parts.length };
    }

    const size = Number(finalObj?.size ?? bytes.byteLength);
    const last = {
      day: job.day, key: finalKey, size, rows: job.rows, rawBytes: job.rawBytes, tables: job.tables.length,
      parts: Math.max(1, job.parts.length), startedAt: job.startedAt, finishedAt: clock(),
    };
    const pruned = await pruneBackups(bucket, o).catch(e => ({ removed: [], error: String(e?.message || e) }));
    await saveOpsState(db, BACKUP_STATE_KEY, { last, job: null, failedDay: null, lastError: null, pruned: pruned.removed }, version, clock());
    return { action: 'done', day: job.day, key: finalKey, size, rows: job.rows, parts: last.parts, pruned: pruned.removed };
  } catch (e) {
    gz.abort();
    const message = String(e?.message || e).slice(0, 300);
    const failedJob = { ...atStart, attempts: (atStart.attempts || 0) + 1, error: message, leaseUntil: 0 };
    const lastError = { day: failedJob.day, at: clock(), message };
    if (failedJob.attempts >= o.maxAttempts) {
      const leftovers = await listAll(bucket, BACKUP_PARTS_PREFIX).catch(() => []);
      await deleteKeys(bucket, leftovers.map(x => x.key)).catch(() => {});
      await saveOpsState(db, BACKUP_STATE_KEY, { ...state, job: null, failedDay: failedJob.day, lastError }, version, clock()).catch(() => {});
      return { action: 'failed', day: failedJob.day, error: message };
    }
    await saveOpsState(db, BACKUP_STATE_KEY, { ...state, job: failedJob, lastError }, version, clock()).catch(() => {});
    return { action: 'error', day: failedJob.day, error: message };
  }
}

/** 刪掉不用留的備份（留最近 30 天 + 12 個月） */
export async function pruneBackups(bucket, opts = BACKUP_DEFAULTS) {
  const objs = await listAll(bucket, BACKUP_PREFIX);
  const days = objs.map(x => parseBackupKey(x.key)).filter(Boolean);
  const plan = planBackupPrune(days, opts);
  const keys = plan.remove.map(backupKey);
  await deleteKeys(bucket, keys);
  return { removed: plan.remove, kept: plan.keep };
}

/** 清單（新的在前），每一份標「每日 / 每月」 */
export async function listBackups(bucket, opts = BACKUP_DEFAULTS) {
  const objs = await listAll(bucket, BACKUP_PREFIX);
  const items = objs.map(x => ({ day: parseBackupKey(x.key), key: x.key, size: x.size, uploaded: x.uploaded })).filter(x => x.day);
  const plan = planBackupPrune(items.map(x => x.day), opts);
  return items
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map(x => ({
      day: x.day,
      file: `${x.day}.sql.gz`,
      size: x.size,
      createdAt: x.uploaded instanceof Date ? x.uploaded.toISOString() : (x.uploaded || null),
      monthly: plan.monthly.has(x.day),
    }));
}

/** 備份狀態（給製作的「系統狀態」） */
export function backupStatusView(state) {
  const s = state || {};
  return {
    last: s.last ? {
      day: s.last.day, size: s.last.size, rows: s.last.rows, tables: s.last.tables,
      finishedAt: new Date(Number(s.last.finishedAt)).toISOString(),
    } : null,
    running: s.job ? { day: s.job.day, rows: s.job.rows, parts: s.job.parts?.length || 0, attempts: s.job.attempts || 0, error: s.job.error || null } : null,
    lastError: s.lastError ? { day: s.lastError.day, at: new Date(Number(s.lastError.at)).toISOString(), message: s.lastError.message } : null,
    failedDay: s.failedDay || null,
  };
}
