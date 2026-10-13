// 測試用：用 Node 內建的 node:sqlite 在記憶體裡開一個資料庫，假裝成 Cloudflare D1（env.DB）。
//   - prepare(sql).bind(...).all() / first() / run()、batch([...])（一個交易）跟 D1 一樣
//   - 跟 D1 一樣打開外鍵檢查；bind 到 undefined 會丟錯（D1 也會）
//   - applyMigrations：照檔名順序跑 migrations/*.sql（可以只跑到某一個之前）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function toParam(v) {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map(toParam));
  }
  _stmt() {
    return this.db.raw.prepare(this.sql);
  }
  async all() { return this._all(); }
  _all() {
    const st = this._stmt();
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
    if (isRead) return { results: st.all(...this.params).map(r => ({ ...r })), success: true, meta: {} };
    const r = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) {
    const row = this._stmt().get(...this.params);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async run() { return this._all(); }
}

export class D1Sqlite {
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys = ON;');
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(stmts) {
    this.raw.exec('BEGIN');
    try {
      const out = stmts.map(s => s._all());
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) { this.raw.exec(sql); return { count: 1 }; }
}

/** migrations/ 裡的檔名（照順序） */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
}

/**
 * 照順序跑 migration。before = '0024' → 只跑 0024 之前的；only = '0024' → 只跑那一個
 */
export function applyMigrations(db, { before = null, only = null } = {}) {
  const ran = [];
  for (const f of migrationFiles()) {
    const num = f.slice(0, 4);
    if (before && num >= before) continue;
    if (only && num !== only) continue;
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    ran.push(f);
  }
  return ran;
}

/** 開一個跑完全部 migration 的資料庫 */
export function freshDb() {
  const db = new D1Sqlite();
  applyMigrations(db);
  return db;
}
