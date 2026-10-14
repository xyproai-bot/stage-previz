// 維運：製作才看得到的「系統狀態」API + 排程裡的備份 / 下載檔更新 / 清舊錯誤
//
//   GET /api/admin/system-status           最近一份備份 + 最近的前端錯誤（一組一列）
//   GET /api/admin/backups                 備份清單
//   GET /api/admin/backups/YYYY-MM-DD.sql.gz  下載一份備份
//   GET /api/admin/client-errors?days=7    最近的前端錯誤（同一個訊息算一組）
//   GET /api/admin/storage                 空間用量、估計費用要的數字、重複的檔案（storage.mjs）
//   POST /api/admin/storage/rescan         請排程馬上重新列一次 R2（模型、留言圖片的大小）
// 全部只有全站的製作（users.role = 'admin'）能用；權限判斷在 describeOpsRoute。

import * as backups from './backups.mjs';
import { listClientErrorGroups, pruneClientErrors } from './clientErrors.mjs';
import { refreshDownloadsIfStale } from './downloads.mjs';
import * as storage from './storage.mjs';

/**
 * /api/admin/... 是哪一個、什麼方法可以用（全部要全站製作）
 * @returns {{kind: string, file?: string, methodNotAllowed?: boolean} | null}
 */
export function describeOpsRoute(method, segs) {
  const m = (method || 'GET').toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  const [api, admin, sub = null, file = null, extra = null] = segs;
  if (api !== 'api' || admin !== 'admin' || extra !== null) return null;
  const r = (kind, more = {}) => (read ? { kind, need: 'globalAdmin', ...more } : { kind, need: 'globalAdmin', methodNotAllowed: true });
  if (sub === 'system-status' && !file) return r('ops.status');
  if (sub === 'client-errors' && !file) return r('ops.clientErrors');
  // 空間用量（storage.mjs）：看 / 請排程馬上重新列一次 R2
  if (sub === 'storage' && !file) return r('ops.storage');
  if (sub === 'storage' && file === 'rescan') {
    return m === 'POST' ? { kind: 'ops.storageRescan', need: 'globalAdmin' } : { kind: 'ops.storageRescan', need: 'globalAdmin', methodNotAllowed: true };
  }
  if (sub === 'backups') {
    if (!file) return r('ops.backups');
    if (!backups.parseBackupFileName(file)) return null;
    return r('ops.backupDownload', { file });
  }
  return null;
}

/** 只有全站製作 */
export function opsAccessDecision(me) {
  if (!me) return { ok: false, status: 401, error: '未登入' };
  if (me.role !== 'admin') return { ok: false, status: 403, error: '只有製作可以看系統狀態' };
  return { ok: true };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function backupSummary(env) {
  const [st, list] = await Promise.all([
    backups.loadOpsState(env.DB, backups.BACKUP_STATE_KEY).catch(() => ({ value: null })),
    env.MODELS ? backups.listBackups(env.MODELS).catch(() => []) : [],
  ]);
  return { status: backups.backupStatusView(st.value), backups: list };
}

/**
 * /api/admin/* 的 handler
 * @param {{me: any, now?: number}} o  me = 登入的人（worker.js getCurrentUser）
 */
export async function handleOpsRoute(request, env, url, { me, now = Date.now() } = {}) {
  const route = describeOpsRoute(request.method, url.pathname.split('/').filter(Boolean));
  if (!route) return json({ error: 'Not found' }, 404);
  const gate = opsAccessDecision(me);
  if (!gate.ok) return json({ error: gate.error }, gate.status);
  if (route.methodNotAllowed) return json({ error: 'Method not allowed' }, 405);
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);

  try {
    switch (route.kind) {
      case 'ops.status': {
        const [b, errors] = await Promise.all([
          backupSummary(env),
          listClientErrorGroups(env.DB, { now, days: 7, limit: 20 }).catch(() => []),
        ]);
        return json({
          backup: { ...b.status, count: b.backups.length, latest: b.backups[0] || null },
          clientErrors: { days: 7, groups: errors },
        });
      }
      case 'ops.backups': {
        const b = await backupSummary(env);
        return json({ status: b.status, backups: b.backups });
      }
      case 'ops.backupDownload': {
        if (!env.MODELS) return json({ error: 'R2 not configured' }, 500);
        const day = backups.parseBackupFileName(route.file);
        const obj = request.method === 'HEAD'
          ? await env.MODELS.head(backups.backupKey(day))
          : await env.MODELS.get(backups.backupKey(day));
        if (!obj) return json({ error: '找不到這一份備份' }, 404);
        const headers = new Headers({
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="stage-previz-db-${day}.sql.gz"`,
          'Content-Length': String(obj.size),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
      }
      case 'ops.storage':
        return json(await storage.storageSummary(env, { now }));
      case 'ops.storageRescan':
        return json(await storage.requestStorageRescan(env, now));
      case 'ops.clientErrors': {
        const days = Number(url.searchParams.get('days')) || 7;
        const groups = await listClientErrorGroups(env.DB, { now, days, limit: 100 });
        return json({ days: Math.max(1, Math.min(30, days)), groups });
      }
      default:
        return json({ error: 'Not found' }, 404);
    }
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/**
 * 備份每一輪的上限可以用環境變數調（不設就用 backups.mjs 的預設）：
 *   BACKUP_PAGE_ROWS（一次讀幾列）、BACKUP_MAX_ROWS_PER_RUN（一輪最多幾列）
 */
export function backupOptsFromEnv(env) {
  const opts = {};
  const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const page = num(env?.BACKUP_PAGE_ROWS);
  const rows = num(env?.BACKUP_MAX_ROWS_PER_RUN);
  if (page) opts.pageRows = Math.min(page, 5000);
  if (rows) opts.maxRowsPerRun = rows;
  return opts;
}

/**
 * 排程（每 5 分鐘）：備份往下做一段、NDI 小程序檢查新版（最多 30 分鐘一次）、每小時清一次舊的前端錯誤
 * 每件事自己接錯誤，不會互相影響
 */
export async function runOpsCron(env, { now = Date.now() } = {}) {
  const out = {};
  const jobs = [
    ['backup', () => backups.runBackupStep(env, { now, opts: backupOptsFromEnv(env) })],
    ['downloads', () => refreshDownloadsIfStale(env, { now })],
  ];
  if (new Date(now).getUTCMinutes() < 5) jobs.push(['clientErrorsPrune', () => pruneClientErrors(env.DB, now)]);
  await Promise.all(jobs.map(async ([name, fn]) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: String(e?.message || e).slice(0, 200) };
      console.error(`[cron ${name}]`, e?.message || e);
    }
  }));
  const b = out.backup;
  if (b && b.action && b.action !== 'idle') console.log('[cron backup]', JSON.stringify(b));
  const d = out.downloads;
  if (d && !d.skipped) console.log('[cron downloads]', JSON.stringify({ tag: d.state?.tag || null, changed: d.changed || [], error: d.error || null }));
  return out;
}
