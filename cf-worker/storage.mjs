// 省空間（0029）：刪掉的版本留 30 天再清檔案、救回來、專案結束清影片、搬到長期存放、空間用量、重複的檔案。
// worker.js 只負責接路由和排程（routes 在 access.mjs / ops.mjs），規則和資料庫 / R2 都在這裡；storage.test.mjs 有測。
//
//   最近刪除   listDeletedVideos / restoreVideo（只有製作；救回來的版本號碼不變）
//   清檔案     purgeEligible / runPurgeStep（排程，刪掉超過 30 天的才清；VIDEO_PURGE != 'on' 時只記錄不刪）
//   專案結束   planWrapUp / wrapUpPreview / applyWrapUp（只留每首歌最後通過的那一版；搬到長期存放）
//   長期存放   runStorageClassStep（R2 分段上傳：同一個位置寫一份新的 InfrequentAccess，一段一段搬）
//   空間用量   categorizeKey / runStorageScanStep（排程每 6 小時把 R2 列一次，結果存 storage_usage）/ storageSummary
//   重複的檔案 runFingerprintStep（從 R2 一段一段算指紋）/ findDuplicates / duplicateMarks / duplicateGroups

import { fingerprintBlocks, combineFingerprint, hashBlock, FINGERPRINT_RE } from '../web/src/lib/videoFingerprint.ts';
import { versionLabel, planParts, COPY_PART_SIZE, videoUploadDecision } from './videos.mjs';
import { loadOpsState, saveOpsState } from './backups.mjs';

export const DAY_MS = 86400_000;
export const PURGE_DAYS = 30;
export const PURGE_MS = PURGE_DAYS * DAY_MS;
export const IA = 'InfrequentAccess';
export const STANDARD = 'Standard';
export const SCAN_INTERVAL_MS = 6 * 3600_000;
export const STORAGE_DEFAULTS = Object.freeze({
  purgeBatch: 20,          // 一輪最多清幾版
  scanPages: 5,            // 一輪最多列幾頁 R2（一頁 1000 個檔案）
  classParts: 4,           // 搬到長期存放：一輪最多搬幾段（一段 32 MiB）
  fpBlocksCron: 6,         // 算指紋：排程一輪最多算幾段（一段 1 MiB，大約 0.5 ms）
  fpBlocksRequest: 6,      // 算指紋：看清單時順便算幾段
});

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const ok = (body) => ({ status: 200, body });
const err = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

/** 刪掉的版本什麼時候清檔案 */
export function purgeAfterIso(deletedMs) {
  return nowIso(deletedMs + PURGE_MS);
}

/** 還剩幾天（不到一天算 1 天；已經到了 = 0） */
export function daysLeft(purgeAfter, nowMs = Date.now()) {
  const t = Date.parse(purgeAfter || '');
  if (!Number.isFinite(t)) return PURGE_DAYS;
  return Math.max(0, Math.ceil((t - nowMs) / DAY_MS));
}

// ─────────────────────────────────────────────
// 清檔案（排程）
// ─────────────────────────────────────────────

/**
 * 這一版的 R2 檔案能不能清：刪掉了、還沒清、清的時間到了，而且刪的時間（讀得懂的話）真的超過 30 天
 * （救回來的 deleted_at 是 NULL → 永遠不會清；還在用的版本也是）
 */
export function purgeEligible(row, nowMs = Date.now()) {
  if (!row || !row.deleted_at || row.purged_at) return false;
  const pa = Date.parse(row.purge_after || '');
  if (!Number.isFinite(pa) || pa > nowMs) return false;
  const da = Date.parse(row.deleted_at);
  if (Number.isFinite(da) && da > nowMs - PURGE_MS) return false;
  return true;
}

/** 'on' 才真的刪；沒設 / 其他 = 只記錄（dry-run） */
export function purgeMode(env) {
  return String(env?.VIDEO_PURGE || '').trim().toLowerCase() === 'on' ? 'on' : 'dry-run';
}

/**
 * 一輪：找到刪掉超過 30 天的版本 → 先在資料庫標「清了」（標成功才刪，避免同時被救回來）→ 刪 R2 的檔案。
 * dry-run：只列出會清哪些（log + ops_state 'video_purge'），什麼都不動。
 */
export async function runPurgeStep(env, { now = Date.now(), limit = STORAGE_DEFAULTS.purgeBatch, mode = purgeMode(env) } = {}) {
  const t = nowIso(now);
  const cutoff = nowIso(now - PURGE_MS);
  const r = await env.DB.prepare(`
    SELECT id, project_id, song_id, version, r2_key, size_bytes, deleted_at, purge_after, purged_at, upload_id
      FROM song_videos
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after IS NOT NULL AND purge_after <= ?
     ORDER BY purge_after LIMIT ?
  `).bind(t, limit).all();
  const rows = (r.results || []).filter(row => purgeEligible(row, now));
  const view = rows.map(v => ({ id: v.id, projectId: v.project_id, label: versionLabel(v.version), deletedAt: v.deleted_at, bytes: v.size_bytes || 0 }));
  const out = { mode, at: t, candidates: view.length, purged: 0, bytes: 0, failed: 0, items: view.slice(0, 20) };
  if (mode === 'on') {
    for (const v of rows) {
      const claim = await env.DB.prepare(`
        UPDATE song_videos SET purged_at = ?, fp_progress = NULL, upload_id = NULL
         WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after <= ? AND deleted_at <= ?
      `).bind(t, v.id, t, cutoff).run();
      if (!claim.meta?.changes) continue;
      try {
        if (v.upload_id) { try { await env.MODELS.resumeMultipartUpload(v.r2_key, v.upload_id).abort(); } catch { /* 已經沒了 */ } }
        const job = await env.DB.prepare(`SELECT upload_id FROM video_storage_jobs WHERE video_id = ? LIMIT 1`).bind(v.id).first();
        if (job?.upload_id) { try { await env.MODELS.resumeMultipartUpload(v.r2_key, job.upload_id).abort(); } catch { /* ignore */ } }
        await env.DB.prepare(`DELETE FROM video_storage_jobs WHERE video_id = ?`).bind(v.id).run();
        if (v.r2_key) await env.MODELS.delete(v.r2_key);
        out.purged++;
        out.bytes += v.size_bytes || 0;
      } catch (e) {
        // R2 沒刪成功 → 放回去，下一輪再試
        await env.DB.prepare(`UPDATE song_videos SET purged_at = NULL WHERE id = ?`).bind(v.id).run();
        out.failed++;
        console.error('[cron purge]', v.id, e?.message || e);
      }
    }
  }
  if (out.candidates || mode !== 'on') {
    console.log('[cron purge]', JSON.stringify({ mode, candidates: out.candidates, purged: out.purged, failed: out.failed, items: out.items.slice(0, 5) }));
  }
  try {
    const st = await loadOpsState(env.DB, 'video_purge');
    const prev = st.value || {};
    const value = { last: out, totalPurged: (prev.totalPurged || 0) + out.purged, totalBytes: (prev.totalBytes || 0) + out.bytes };
    await saveOpsState(env.DB, 'video_purge', value, st.version, now);
  } catch { /* 只是紀錄 */ }
  return out;
}

// ─────────────────────────────────────────────
// 最近刪除 / 救回來（只有製作；router 已經檢查）
// ─────────────────────────────────────────────

function deletedToApi(v, nowMs) {
  return {
    id: v.id,
    songId: v.song_id,
    version: v.version,
    label: versionLabel(v.version),
    title: v.title || '',
    note: v.note || '',
    source: v.source,
    sizeBytes: v.size_bytes ?? null,
    createdBy: v.created_by ? { id: v.created_by, name: v.created_by_name || null } : null,
    createdAt: v.created_at,
    readyAt: v.ready_at || null,
    deletedAt: v.deleted_at,
    deletedBy: v.deleted_by ? { id: v.deleted_by, name: v.deleted_by_name || null } : null,
    purgeAfter: v.purge_after || null,
    daysLeft: daysLeft(v.purge_after, nowMs),
  };
}

/** 這首歌最近刪掉、還在 30 天內的版本（交好的才算；上傳到一半取消的不列） */
export async function listDeletedVideos(env, { projectId, songId, now = Date.now() }) {
  const r = await env.DB.prepare(`
    SELECT v.*, u.name AS created_by_name, d.name AS deleted_by_name
      FROM song_videos v
      LEFT JOIN users u ON u.id = v.created_by
      LEFT JOIN users d ON d.id = v.deleted_by
     WHERE v.project_id = ? AND v.song_id = ? AND v.deleted_at IS NOT NULL AND v.purged_at IS NULL
       AND v.status = 'ready' AND v.version IS NOT NULL
     ORDER BY v.deleted_at DESC
  `).bind(projectId, songId).all();
  return ok({ videos: (r.results || []).map(v => deletedToApi(v, now)), keepDays: PURGE_DAYS });
}

/** 救回來：號碼不變（號碼本來就不會給別人用）；檔案已經清掉 / 不在了 → 410 */
export async function restoreVideo(env, { projectId, songId, videoId, now = Date.now() }) {
  const v = await env.DB.prepare(
    `SELECT * FROM song_videos WHERE id = ? AND song_id = ? AND project_id = ? LIMIT 1`
  ).bind(videoId, songId, projectId).first();
  if (!v) return err(404, '這首歌裡找不到這一版影片');
  if (!v.deleted_at) return err(409, '這一版沒有被刪掉');
  if (v.purged_at) return err(410, `已經超過 ${PURGE_DAYS} 天，檔案清掉了，救不回來`);
  if (v.status !== 'ready' || v.version == null) return err(409, '這一版還沒交好就取消了，沒辦法救回來');
  const head = env.MODELS ? await env.MODELS.head(v.r2_key) : null;
  if (!head) return err(410, '這一版的檔案已經不在了，救不回來');
  const t = nowIso(now);
  const r = await env.DB.prepare(`
    UPDATE song_videos SET deleted_at = NULL, purge_after = NULL, deleted_by = NULL, updated_at = ?
     WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL
  `).bind(t, v.id).run();
  if (!r.meta?.changes) return err(409, '這一版剛剛被清掉或救回來了，請重新整理');
  await env.DB.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).bind(projectId).run();
  return { status: 200, body: { ok: true, videoId: v.id, version: v.version, label: versionLabel(v.version) }, row: v };
}

// ─────────────────────────────────────────────
// 專案結束清影片
// ─────────────────────────────────────────────

/**
 * 每首歌留哪一版：最後一次「已通過」的那一版（還在的話）；沒有通過過（或通過的那版刪了）→ 最新的一版。
 * @param {{videos: {id: string, song_id: string, version: number}[], approvals: {song_id: string, video_id: string|null, created_at: string}[]}} p
 *   videos = 還在、交好的版本；approvals = 審片紀錄裡的「已通過」（哪個順序都可以）
 * @returns {{keep: Map<string, {id: string, reason: 'approved'|'latest'}>, remove: object[]}}
 */
export function planWrapUp({ videos, approvals }) {
  const bySong = new Map();
  for (const v of videos || []) {
    if (v.version == null) continue;
    if (!bySong.has(v.song_id)) bySong.set(v.song_id, []);
    bySong.get(v.song_id).push(v);
  }
  const lastApproved = new Map();  // songId → 照時間由新到舊的 video id
  const sorted = [...(approvals || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const a of sorted) {
    if (!a.video_id) continue;
    if (!lastApproved.has(a.song_id)) lastApproved.set(a.song_id, []);
    lastApproved.get(a.song_id).push(a.video_id);
  }
  const keep = new Map();
  const remove = [];
  for (const [songId, list] of bySong) {
    const ids = new Set(list.map(v => v.id));
    const approvedId = (lastApproved.get(songId) || []).find(id => ids.has(id)) || null;
    const latest = list.reduce((a, b) => (b.version > a.version ? b : a));
    const keepId = approvedId || latest.id;
    keep.set(songId, { id: keepId, reason: approvedId ? 'approved' : 'latest' });
    for (const v of list) if (v.id !== keepId) remove.push(v);
  }
  return { keep, remove };
}

async function wrapUpData(env, projectId) {
  const [vr, ar, sr, jr] = await env.DB.batch([
    env.DB.prepare(`
      SELECT id, song_id, version, size_bytes, storage_class, title FROM song_videos
       WHERE project_id = ? AND status = 'ready' AND deleted_at IS NULL AND version IS NOT NULL
    `).bind(projectId),
    env.DB.prepare(`SELECT song_id, video_id, created_at FROM song_reviews WHERE project_id = ? AND status = 'approved'`).bind(projectId),
    env.DB.prepare(`SELECT id, name, code, "order" FROM songs WHERE project_id = ? ORDER BY "order", created_at, id`).bind(projectId),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM video_storage_jobs WHERE project_id = ? GROUP BY status`).bind(projectId),
  ]);
  return { videos: vr.results || [], approvals: ar.results || [], songs: sr.results || [], jobs: jr.results || [] };
}

/** 專案結束清影片：先看會怎樣（每首歌留哪一版、會清掉幾版、多大） */
export async function wrapUpPreview(env, { projectId }) {
  const d = await wrapUpData(env, projectId);
  const plan = planWrapUp(d);
  const removeIds = new Set(plan.remove.map(v => v.id));
  const songs = [];
  for (const s of d.songs) {
    const list = d.videos.filter(v => v.song_id === s.id).sort((a, b) => b.version - a.version);
    if (!list.length) continue;
    const k = plan.keep.get(s.id);
    const kept = list.find(v => v.id === k.id);
    songs.push({
      songId: s.id, code: s.code || null, name: s.name,
      keep: { id: kept.id, label: versionLabel(kept.version), reason: k.reason, sizeBytes: kept.size_bytes || 0 },
      remove: list.filter(v => removeIds.has(v.id)).map(v => ({ id: v.id, label: versionLabel(v.version), sizeBytes: v.size_bytes || 0 })),
    });
  }
  const sum = (arr) => arr.reduce((a, v) => a + (v.size_bytes || 0), 0);
  const kept = d.videos.filter(v => !removeIds.has(v.id));
  const jobs = Object.fromEntries(d.jobs.map(j => [j.status, j.n]));
  return ok({
    songs,
    totals: {
      videoCount: d.videos.length,
      videoBytes: sum(d.videos),
      removeCount: plan.remove.length,
      removeBytes: sum(plan.remove),
      keepCount: kept.length,
      keepBytes: sum(kept),
      keepIaBytes: sum(kept.filter(v => v.storage_class === IA)),
      allIaBytes: sum(d.videos.filter(v => v.storage_class === IA)),
    },
    storageJobs: { queued: jobs.queued || 0, done: jobs.done || 0, failed: jobs.failed || 0 },
    keepDays: PURGE_DAYS,
  });
}

/**
 * 專案結束清影片：keep = 'all'（全部留著）/ 'final'（只留每首歌最後通過的那一版，其他的照一般刪除，30 天內可以救回來）
 * storage = 'standard'（不動）/ 'infrequent'（剩下的影片排進「搬到長期存放」）
 */
export async function applyWrapUp(env, { projectId, me, keep = 'all', storage = 'standard', now = Date.now() }) {
  if (!['all', 'final'].includes(keep)) return err(400, 'keep 要是 all 或 final');
  if (!['standard', 'infrequent'].includes(storage)) return err(400, 'storage 要是 standard 或 infrequent');
  const d = await wrapUpData(env, projectId);
  const t = nowIso(now);
  let removed = [];
  if (keep === 'final') {
    removed = planWrapUp(d).remove;
    const stmts = removed.map(v => env.DB.prepare(`
      UPDATE song_videos SET deleted_at = ?, purge_after = ?, deleted_by = ?, updated_at = ?
       WHERE id = ? AND project_id = ? AND deleted_at IS NULL
    `).bind(t, purgeAfterIso(now), me?.id || null, t, v.id, projectId));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }
  let queued = 0;
  if (storage === 'infrequent') {
    const removedIds = new Set(removed.map(v => v.id));
    const todo = d.videos.filter(v => !removedIds.has(v.id) && v.storage_class !== IA);
    const stmts = todo.map(v => env.DB.prepare(`
      INSERT INTO video_storage_jobs (video_id, project_id, target_class, status, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?)
      ON CONFLICT (video_id) DO UPDATE SET target_class = excluded.target_class, status = 'queued', error = NULL,
        attempts = 0, requested_by = excluded.requested_by, updated_at = excluded.updated_at
      WHERE video_storage_jobs.status != 'queued'
    `).bind(v.id, projectId, IA, me?.id || null, t, t));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    queued = todo.length;
  }
  if (removed.length) await env.DB.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).bind(projectId).run();
  const sum = (arr) => arr.reduce((a, v) => a + (v.size_bytes || 0), 0);
  return ok({
    ok: true, keep, storage,
    removedCount: removed.length, removedBytes: sum(removed),
    removed: removed.map(v => ({ id: v.id, songId: v.song_id, label: versionLabel(v.version) })),
    queuedForInfrequent: queued,
    keepDays: PURGE_DAYS,
  });
}

// ─────────────────────────────────────────────
// 搬到長期存放（排程，一段一段搬）
// ─────────────────────────────────────────────

function bodyFor(obj, length) {
  // 正式環境：直接串過去（不佔運算時間）；本機測試沒有 FixedLengthStream → 讀成一塊
  if (typeof FixedLengthStream === 'function' && obj.body) {
    const { readable, writable } = new FixedLengthStream(length);
    obj.body.pipeTo(writable).catch(() => { /* uploadPart 會失敗 */ });
    return readable;
  }
  return obj.arrayBuffer();
}

/**
 * 一輪：拿一個等著的工作，往下搬幾段（R2 分段上傳到同一個位置，指定 storageClass）；都好了 → 合併（新的那份取代舊的）。
 * 播放不受影響：合併之前讀到的都是原本那份；之後是長期存放的那份（打開要一點讀取費）。
 */
export async function runStorageClassStep(env, { now = Date.now(), maxParts = STORAGE_DEFAULTS.classParts } = {}) {
  if (!env.MODELS) return { idle: true };
  const job = await env.DB.prepare(`
    SELECT j.*, v.r2_key, v.size_bytes, v.status AS v_status, v.deleted_at, v.purged_at, v.storage_class
      FROM video_storage_jobs j JOIN song_videos v ON v.id = j.video_id
     WHERE j.status = 'queued' AND (j.lease_until IS NULL OR j.lease_until < ?)
     ORDER BY j.created_at LIMIT 1
  `).bind(now).first();
  if (!job) return { idle: true };
  const got = await env.DB.prepare(`
    UPDATE video_storage_jobs SET lease_until = ?, attempts = attempts + 1, updated_at = ?
     WHERE video_id = ? AND status = 'queued' AND (lease_until IS NULL OR lease_until < ?)
  `).bind(now + 10 * 60_000, nowIso(now), job.video_id, now).run();
  if (!got.meta?.changes) return { skipped: true };

  const finish = async (status, error = null) => {
    if (job.upload_id && status !== 'done') {
      try { await env.MODELS.resumeMultipartUpload(job.r2_key, job.upload_id).abort(); } catch { /* ignore */ }
    }
    await env.DB.prepare(`
      UPDATE video_storage_jobs SET status = ?, error = ?, upload_id = NULL, parts_json = '[]', lease_until = NULL, updated_at = ?
       WHERE video_id = ?
    `).bind(status, error, nowIso(now), job.video_id).run();
    return { videoId: job.video_id, status, error };
  };
  if (job.v_status !== 'ready' || job.deleted_at || job.purged_at) return finish('failed', '這一版已經刪掉了，沒有搬');
  if (job.attempts > 40) return finish('failed', '試了很多次都沒搬成功');

  try {
    const head = await env.MODELS.head(job.r2_key);
    if (!head) return finish('failed', '找不到這一版的檔案');
    let state = { srcEtag: head.etag, parts: [] };
    try { const s = JSON.parse(job.parts_json || '[]'); if (s && !Array.isArray(s)) state = s; } catch { /* 重來 */ }
    if (head.storageClass === job.target_class && !job.upload_id) {
      await env.DB.prepare(`UPDATE song_videos SET storage_class = ? WHERE id = ?`).bind(job.target_class, job.video_id).run();
      return finish('done');
    }
    let uploadId = job.upload_id;
    let partSize = job.part_size;
    // 檔案在搬的途中變了（不應該發生）→ 重來
    if (uploadId && state.srcEtag !== head.etag) {
      try { await env.MODELS.resumeMultipartUpload(job.r2_key, uploadId).abort(); } catch { /* ignore */ }
      uploadId = null;
    }
    if (!uploadId) {
      const mpu = await env.MODELS.createMultipartUpload(job.r2_key, {
        httpMetadata: head.httpMetadata, customMetadata: head.customMetadata, storageClass: job.target_class,
      });
      uploadId = mpu.uploadId;
      partSize = planParts(head.size, COPY_PART_SIZE).partSize;
      state = { srcEtag: head.etag, parts: [] };
      await env.DB.prepare(`UPDATE video_storage_jobs SET upload_id = ?, part_size = ?, parts_json = ?, bytes_done = 0 WHERE video_id = ?`)
        .bind(uploadId, partSize, JSON.stringify(state), job.video_id).run();
    }
    const mpu = env.MODELS.resumeMultipartUpload(job.r2_key, uploadId);
    const count = Math.max(1, Math.ceil(head.size / partSize));
    const done = new Set(state.parts.map(p => p.n));
    let moved = 0;
    for (let n = 1; n <= count && moved < maxParts; n++) {
      if (done.has(n)) continue;
      const offset = (n - 1) * partSize;
      const length = Math.min(partSize, head.size - offset);
      const obj = await env.MODELS.get(job.r2_key, { range: { offset, length } });
      if (!obj) return finish('failed', '找不到這一版的檔案');
      if (obj.etag && obj.etag !== state.srcEtag) throw new Error('檔案在搬的途中變了，下一輪重來');
      const part = await mpu.uploadPart(n, await bodyFor(obj, length));
      state.parts.push({ n, etag: part.etag });
      done.add(n);
      moved++;
      await env.DB.prepare(`UPDATE video_storage_jobs SET parts_json = ?, bytes_done = ?, updated_at = ? WHERE video_id = ?`)
        .bind(JSON.stringify(state), Math.min(head.size, done.size * partSize), nowIso(now), job.video_id).run();
    }
    if (done.size < count) {
      await env.DB.prepare(`UPDATE video_storage_jobs SET lease_until = NULL WHERE video_id = ?`).bind(job.video_id).run();
      return { videoId: job.video_id, moved, remaining: count - done.size };
    }
    // 合併之前再確認一次這一版還在（刪掉了就不要再寫一份回去）
    const still = await env.DB.prepare(`SELECT deleted_at, purged_at FROM song_videos WHERE id = ? LIMIT 1`).bind(job.video_id).first();
    if (!still || still.deleted_at || still.purged_at) return finish('failed', '這一版已經刪掉了，沒有搬');
    const parts = [...state.parts].sort((a, b) => a.n - b.n).map(p => ({ partNumber: p.n, etag: p.etag }));
    const obj = await mpu.complete(parts);
    if (obj?.size !== head.size) throw new Error(`搬完的大小不對（${obj?.size} / ${head.size}）`);
    job.upload_id = null;
    await env.DB.prepare(`UPDATE song_videos SET storage_class = ? WHERE id = ?`).bind(job.target_class, job.video_id).run();
    return finish('done');
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await env.DB.prepare(`UPDATE video_storage_jobs SET lease_until = NULL, error = ?, updated_at = ? WHERE video_id = ?`)
      .bind(msg, nowIso(now), job.video_id).run();
    console.warn('[storage class]', job.video_id, msg);
    return { videoId: job.video_id, error: msg };
  }
}

// ─────────────────────────────────────────────
// 空間用量（排程把 R2 列一次；看頁面時不列）
// ─────────────────────────────────────────────

const PROJECT_PREFIXES = {
  'models': 'models',
  'videos': 'videos',
  'comment-thumbs': 'comment-images',
  'comment-attachments': 'comment-images',
};
const ACCOUNT_PREFIXES = { 'assets': 'assets', 'backups': 'backups', 'downloads': 'downloads' };

/** R2 的位置 → 哪個專案（'' = 不屬於專案）、哪一類 */
export function categorizeKey(key, projectIds = null) {
  const parts = String(key || '').split('/');
  const top = parts[0];
  if (PROJECT_PREFIXES[top] && parts.length >= 3 && parts[1]) return { projectId: parts[1], category: PROJECT_PREFIXES[top] };
  if (ACCOUNT_PREFIXES[top]) return { projectId: '', category: ACCOUNT_PREFIXES[top] };
  if (parts.length >= 3 && projectIds?.has(parts[1])) return { projectId: parts[1], category: 'other' };
  return { projectId: '', category: 'other' };
}

/**
 * 一輪：R2 往下列幾頁（每頁 1000 個），加進累計；列完 → 整批換掉 storage_usage。
 * 6 小時做一次（ops_state 'storage_scan'；同時只會有一個在做，存的時候版本對不上就放棄這一輪）。
 */
export async function runStorageScanStep(env, { now = Date.now(), maxPages = STORAGE_DEFAULTS.scanPages, intervalMs = SCAN_INTERVAL_MS, force = false } = {}) {
  if (!env.MODELS) return { idle: true };
  const st = await loadOpsState(env.DB, 'storage_scan');
  const s = st.value || {};
  let job = s.job || null;
  if (!job) {
    if (!force && s.last && now - Number(s.last.finishedAtMs || 0) < intervalMs) return { idle: true };
    job = { cursor: null, startedAt: nowIso(now), pages: 0, acc: {} };
  }
  const pr = await env.DB.prepare(`SELECT id FROM projects`).all();
  const projectIds = new Set((pr.results || []).map(p => p.id));
  let done = false;
  for (let i = 0; i < maxPages; i++) {
    const page = await env.MODELS.list({ cursor: job.cursor || undefined, limit: 1000 });
    for (const o of page.objects || []) {
      const { projectId, category } = categorizeKey(o.key, projectIds);
      const k = `${projectId}|${category}`;
      const a = job.acc[k] || (job.acc[k] = [0, 0, 0]);
      a[0] += o.size || 0;
      a[1] += 1;
      if (o.storageClass === IA) a[2] += o.size || 0;
    }
    job.pages++;
    if (!page.truncated) { done = true; break; }
    job.cursor = page.cursor;
  }
  if (!done) {
    await saveOpsState(env.DB, 'storage_scan', { ...s, job }, st.version, now);
    return { scanning: true, pages: job.pages };
  }
  const t = nowIso(now);
  const stmts = [env.DB.prepare(`DELETE FROM storage_usage`)];
  let bytes = 0, objects = 0;
  for (const [k, [b, n, ia]] of Object.entries(job.acc)) {
    const [projectId, category] = k.split('|');
    bytes += b; objects += n;
    stmts.push(env.DB.prepare(
      `INSERT INTO storage_usage (project_id, category, bytes, objects, ia_bytes, scanned_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(projectId, category, b, n, ia, t));
  }
  const saved = await saveOpsState(env.DB, 'storage_scan', { last: { finishedAt: t, finishedAtMs: now, bytes, objects, pages: job.pages } }, st.version, now);
  if (saved === false) return { conflict: true };
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { done: true, bytes, objects, pages: job.pages };
}

/** 製作按「重新計算」：下一輪排程（5 分鐘內）馬上重列 */
export async function requestStorageRescan(env, now = Date.now()) {
  const st = await loadOpsState(env.DB, 'storage_scan');
  const s = st.value || {};
  if (s.job) return { already: true };
  await saveOpsState(env.DB, 'storage_scan', { ...s, last: s.last ? { ...s.last, finishedAtMs: 0 } : null }, st.version, now);
  return { requested: true };
}

// ─────────────────────────────────────────────
// 重複的檔案（指紋）
// ─────────────────────────────────────────────

/** 瀏覽器送來的指紋（格式不對 → null） */
export function cleanFingerprint(fp) {
  const s = String(fp || '').trim().toLowerCase();
  return FINGERPRINT_RE.test(s) ? s : null;
}

/**
 * 從 R2 往下算幾段指紋（每段 1 MiB，算好的存在 fp_progress，下次接著算）。
 * 先做算到一半的，再做新的；filter：{ videoId } / { songId }。回傳這一輪算了幾段、算完幾個。
 */
export async function runFingerprintStep(env, { maxBlocks = STORAGE_DEFAULTS.fpBlocksCron, videoId = null, songId = null } = {}) {
  if (!env.MODELS) return { blocks: 0, finished: 0 };
  let left = maxBlocks;
  let finished = 0;
  const tried = new Set();
  while (left > 0) {
    const where = [`status = 'ready'`, `fingerprint IS NULL`, `purged_at IS NULL`, `COALESCE(size_bytes, 0) > 0`];
    const binds = [];
    if (videoId) { where.push('id = ?'); binds.push(videoId); }
    if (songId) { where.push('song_id = ?'); binds.push(songId); }
    if (tried.size) { where.push(`id NOT IN (${[...tried].map(() => '?').join(',')})`); binds.push(...tried); }
    const v = await env.DB.prepare(`
      SELECT id, r2_key, size_bytes, fp_progress FROM song_videos WHERE ${where.join(' AND ')}
       ORDER BY (fp_progress IS NULL), ready_at DESC LIMIT 1
    `).bind(...binds).first();
    if (!v) break;
    tried.add(v.id);
    let prog = null;
    try { prog = v.fp_progress ? JSON.parse(v.fp_progress) : null; } catch { prog = null; }
    if (!prog || !Array.isArray(prog.hashes) || !Number.isFinite(prog.size)) {
      const head = await env.MODELS.head(v.r2_key);
      if (!head) {
        await env.DB.prepare(`UPDATE song_videos SET fingerprint = 'none:missing', fp_progress = NULL WHERE id = ? AND fingerprint IS NULL`).bind(v.id).run();
        continue;
      }
      prog = { size: head.size, hashes: [] };
    }
    const blocks = fingerprintBlocks(prog.size);
    const before = v.fp_progress || null;
    while (left > 0 && prog.hashes.length < blocks.length) {
      const b = blocks[prog.hashes.length];
      const obj = await env.MODELS.get(v.r2_key, { range: { offset: b.offset, length: b.length } });
      if (!obj) { prog = null; break; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.byteLength !== b.length) { prog = null; break; }
      prog.hashes.push(await hashBlock(bytes));
      left--;
    }
    if (!prog) {
      await env.DB.prepare(`UPDATE song_videos SET fp_progress = NULL WHERE id = ?`).bind(v.id).run();
      continue;
    }
    if (prog.hashes.length >= blocks.length) {
      const fp = await combineFingerprint(prog.size, prog.hashes);
      const r = await env.DB.prepare(
        `UPDATE song_videos SET fingerprint = ?, fp_progress = NULL WHERE id = ? AND fingerprint IS NULL AND fp_progress IS ?`
      ).bind(fp, v.id, before).run();
      if (r.meta?.changes) finished++;
    } else {
      // 同時有別的地方在算同一版 → 進度對不上就放掉這一輪（不會算錯）
      await env.DB.prepare(`UPDATE song_videos SET fp_progress = ? WHERE id = ? AND fingerprint IS NULL AND fp_progress IS ?`)
        .bind(JSON.stringify(prog), v.id, before).run();
      break;
    }
  }
  return { blocks: maxBlocks - left, finished };
}

function matchToApi(m, { songId, nowMs }) {
  return {
    videoId: m.id,
    songId: m.song_id,
    songCode: m.song_code || null,
    songName: m.song_name || '',
    sameSong: m.song_id === songId,
    version: m.version,
    label: versionLabel(m.version),
    sizeBytes: m.size_bytes ?? null,
    createdBy: m.created_by ? { id: m.created_by, name: m.created_by_name || null } : null,
    createdAt: m.ready_at || m.created_at,
    deleted: !!m.deleted_at,
    deletedAt: m.deleted_at || null,
    daysLeft: m.deleted_at ? daysLeft(m.purge_after, nowMs) : null,
  };
}

/** 這個專案裡有沒有同一個檔案（還在的、最近刪掉還沒清的都算）；只看這個專案 */
export async function findDuplicates(env, { projectId, songId = null, fingerprint, excludeId = null, now = Date.now() }) {
  const fp = cleanFingerprint(fingerprint);
  if (!fp) return [];
  const r = await env.DB.prepare(`
    SELECT v.id, v.song_id, v.version, v.size_bytes, v.created_at, v.ready_at, v.deleted_at, v.purge_after, v.created_by,
           u.name AS created_by_name, s.name AS song_name, s.code AS song_code
      FROM song_videos v JOIN songs s ON s.id = v.song_id LEFT JOIN users u ON u.id = v.created_by
     WHERE v.project_id = ? AND v.fingerprint = ? AND v.status = 'ready' AND v.version IS NOT NULL
       AND v.purged_at IS NULL AND v.id != ?
     ORDER BY (v.deleted_at IS NOT NULL), (v.song_id = ?) DESC, v.version DESC
     LIMIT 20
  `).bind(projectId, fp, excludeId || '', songId || '').all();
  return (r.results || []).map(m => matchToApi(m, { songId, nowMs: now }));
}

/** POST songs/:s/videos/duplicates { fingerprint }：交影片的人才能問（跟上傳同一個權限） */
export async function handleDuplicateCheck(env, ctx, body, now = Date.now()) {
  const d = videoUploadDecision({ role: ctx.role, userId: ctx.me.id, song: ctx.song });
  if (!d.ok) return err(d.status, d.error);
  const fp = cleanFingerprint(body?.fingerprint);
  if (!fp) return err(400, '檔案指紋格式不對');
  const matches = await findDuplicates(env, { projectId: ctx.projectId, songId: ctx.song.id, fingerprint: fp, now });
  return ok({ fingerprint: fp, matches });
}

/**
 * 清單上每一版要不要標「跟 V2 重複」：同一個專案裡、更早交好的、還在的那一版（同一首歌優先）。
 * 回 Map(videoId → { videoId, label, songId, songCode, songName, sameSong })；另外回還在算指紋的（剛交好一小時內的）
 */
export async function duplicateMarks(env, projectId, rows, now = Date.now()) {
  const marks = new Map();
  const pending = new Set();
  const ready = (rows || []).filter(v => v.status === 'ready' && !v.deleted_at);
  for (const v of ready) {
    const at = Date.parse(v.ready_at || v.created_at || '');
    if (!v.fingerprint && Number.isFinite(at) && now - at < 3600_000) pending.add(v.id);
  }
  const fps = [...new Set(ready.map(v => v.fingerprint).filter(fp => FINGERPRINT_RE.test(fp || '')))];
  if (!fps.length) return { marks, pending };
  const r = await env.DB.prepare(`
    SELECT v.id, v.song_id, v.version, v.fingerprint, v.ready_at, s.name AS song_name, s.code AS song_code
      FROM song_videos v JOIN songs s ON s.id = v.song_id
     WHERE v.project_id = ? AND v.status = 'ready' AND v.deleted_at IS NULL AND v.version IS NOT NULL
       AND v.fingerprint IN (${fps.map(() => '?').join(',')})
  `).bind(projectId, ...fps).all();
  const all = r.results || [];
  const earlier = (a, b) => String(a.ready_at || '') < String(b.ready_at || '')
    || (String(a.ready_at || '') === String(b.ready_at || '') && a.id < b.id);
  for (const v of ready) {
    if (!v.fingerprint) continue;
    const others = all.filter(o => o.fingerprint === v.fingerprint && o.id !== v.id && earlier(o, v));
    if (!others.length) continue;
    others.sort((a, b) => ((b.song_id === v.song_id) - (a.song_id === v.song_id)) || (earlier(a, b) ? -1 : 1));
    const o = others[0];
    marks.set(v.id, { videoId: o.id, label: versionLabel(o.version), songId: o.song_id, songCode: o.song_code || null, songName: o.song_name || '', sameSong: o.song_id === v.song_id });
  }
  return { marks, pending };
}

/** 整個帳號重複的檔案：每個專案裡同一個指紋有兩版以上（還在的）= 一組；多出來的那幾版就是浪費的空間 */
export async function duplicateGroups(env) {
  const r = await env.DB.prepare(`
    SELECT v.id, v.project_id, p.name AS project_name, p.status AS project_status, v.song_id, s.name AS song_name, s.code AS song_code,
           v.version, v.size_bytes, v.fingerprint, v.ready_at
      FROM song_videos v JOIN songs s ON s.id = v.song_id JOIN projects p ON p.id = v.project_id
     WHERE v.status = 'ready' AND v.deleted_at IS NULL AND v.version IS NOT NULL AND v.fingerprint LIKE 'fp1:%'
       AND (v.project_id, v.fingerprint) IN (
         SELECT project_id, fingerprint FROM song_videos
          WHERE status = 'ready' AND deleted_at IS NULL AND version IS NOT NULL AND fingerprint LIKE 'fp1:%'
          GROUP BY project_id, fingerprint HAVING COUNT(*) > 1)
     ORDER BY v.project_id, v.fingerprint, v.ready_at, v.id
  `).all();
  const groups = new Map();
  for (const v of r.results || []) {
    const k = `${v.project_id}|${v.fingerprint}`;
    if (!groups.has(k)) groups.set(k, { projectId: v.project_id, projectName: v.project_name, projectArchived: v.project_status === 'archived', sizeBytes: v.size_bytes || 0, versions: [] });
    groups.get(k).versions.push({ videoId: v.id, songId: v.song_id, songCode: v.song_code || null, songName: v.song_name, version: v.version, label: versionLabel(v.version) });
  }
  const list = [...groups.values()].map(g => ({ ...g, wasteBytes: g.sizeBytes * (g.versions.length - 1) }))
    .sort((a, b) => b.wasteBytes - a.wasteBytes);
  return { groups: list.slice(0, 100), groupCount: list.length, wasteBytes: list.reduce((a, g) => a + g.wasteBytes, 0) };
}

// ─────────────────────────────────────────────
// 系統狀態：空間用量
// ─────────────────────────────────────────────

/** GET /api/admin/storage：每個專案的空間用量（影片從資料庫算、模型和留言圖片用排程列 R2 的結果）+ 重複的檔案 */
export async function storageSummary(env, { now = Date.now() } = {}) {
  const [pr, live, del, usage, jobs, fpr] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, status, updated_at FROM projects`),
    env.DB.prepare(`
      SELECT project_id, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes,
             COALESCE(SUM(CASE WHEN storage_class = 'InfrequentAccess' THEN size_bytes ELSE 0 END), 0) AS ia
        FROM song_videos WHERE status = 'ready' AND deleted_at IS NULL GROUP BY project_id`),
    env.DB.prepare(`
      SELECT project_id, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes,
             COALESCE(SUM(CASE WHEN storage_class = 'InfrequentAccess' THEN size_bytes ELSE 0 END), 0) AS ia
        FROM song_videos WHERE status = 'ready' AND deleted_at IS NOT NULL AND purged_at IS NULL GROUP BY project_id`),
    env.DB.prepare(`SELECT project_id, category, bytes, objects, ia_bytes, scanned_at FROM storage_usage`),
    env.DB.prepare(`SELECT project_id, status, COUNT(*) AS n, COALESCE(SUM(bytes_done), 0) AS done FROM video_storage_jobs GROUP BY project_id, status`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE status = 'ready' AND fingerprint IS NULL AND purged_at IS NULL`),
  ]);
  const byId = new Map();
  const proj = (id) => {
    if (!byId.has(id)) {
      byId.set(id, {
        id, name: null, status: null,
        videoBytes: 0, videoIaBytes: 0, videoCount: 0,
        deletedBytes: 0, deletedIaBytes: 0, deletedCount: 0,
        modelBytes: 0, commentImageBytes: 0, otherBytes: 0, scannedIaBytes: 0,
        storageJobs: { queued: 0, done: 0, failed: 0 },
      });
    }
    return byId.get(id);
  };
  for (const p of pr.results || []) Object.assign(proj(p.id), { name: p.name, status: p.status });
  for (const r of live.results || []) Object.assign(proj(r.project_id), { videoBytes: r.bytes, videoIaBytes: r.ia, videoCount: r.n });
  for (const r of del.results || []) Object.assign(proj(r.project_id), { deletedBytes: r.bytes, deletedIaBytes: r.ia, deletedCount: r.n });
  const account = { assets: 0, backups: 0, downloads: 0, other: 0 };
  let r2Bytes = 0, r2IaBytes = 0, r2Objects = 0, scannedAt = null, r2VideoBytes = 0;
  for (const u of usage.results || []) {
    r2Bytes += u.bytes; r2IaBytes += u.ia_bytes; r2Objects += u.objects;
    scannedAt = scannedAt && scannedAt > u.scanned_at ? scannedAt : u.scanned_at;
    if (u.category === 'videos') { r2VideoBytes += u.bytes; continue; }  // 影片用資料庫的數字（隨時是最新的）
    if (!u.project_id) { account[u.category in account ? u.category : 'other'] += u.bytes; continue; }
    const p = proj(u.project_id);
    if (u.category === 'models') p.modelBytes += u.bytes;
    else if (u.category === 'comment-images') p.commentImageBytes += u.bytes;
    else p.otherBytes += u.bytes;
    p.scannedIaBytes += u.ia_bytes;
  }
  for (const j of jobs.results || []) {
    const p = proj(j.project_id);
    if (j.status in p.storageJobs) p.storageJobs[j.status] += j.n;
  }
  const projects = [...byId.values()]
    .map(p => {
      const totalBytes = p.videoBytes + p.deletedBytes + p.modelBytes + p.commentImageBytes + p.otherBytes;
      const iaBytes = p.videoIaBytes + p.deletedIaBytes + p.scannedIaBytes;
      return { ...p, name: p.name ?? '（已經刪掉的專案）', totalBytes, iaBytes, standardBytes: totalBytes - iaBytes };
    })
    .filter(p => p.totalBytes > 0 || p.status)
    .sort((a, b) => b.totalBytes - a.totalBytes);
  const sum = (k) => projects.reduce((a, p) => a + p[k], 0);
  const accountBytes = account.assets + account.backups + account.downloads + account.other;
  const totalBytes = sum('totalBytes') + accountBytes;
  const iaBytes = sum('iaBytes');
  const [purgeSt, scanSt, dups] = await Promise.all([
    loadOpsState(env.DB, 'video_purge').catch(() => ({ value: null })),
    loadOpsState(env.DB, 'storage_scan').catch(() => ({ value: null })),
    duplicateGroups(env),
  ]);
  return {
    projects,
    account: {
      ...account, accountBytes, totalBytes, iaBytes, standardBytes: totalBytes - iaBytes,
      videoBytes: sum('videoBytes'), deletedBytes: sum('deletedBytes'), modelBytes: sum('modelBytes'), commentImageBytes: sum('commentImageBytes'),
      videoCount: sum('videoCount'), deletedCount: sum('deletedCount'),
      r2: { bytes: r2Bytes, iaBytes: r2IaBytes, objects: r2Objects, videoBytes: r2VideoBytes, scannedAt, scanning: !!scanSt.value?.job },
    },
    duplicates: dups,
    fingerprints: { pending: fpr.results?.[0]?.n || 0 },
    purge: { mode: purgeMode(env), keepDays: PURGE_DAYS, last: purgeSt.value?.last || null, totalPurged: purgeSt.value?.totalPurged || 0 },
    generatedAt: nowIso(now),
  };
}

// ─────────────────────────────────────────────
// 排程（每 5 分鐘）：清檔案、列 R2、搬長期存放、補算指紋，每件事自己接錯誤
// ─────────────────────────────────────────────

export async function runStorageCron(env, { now = Date.now() } = {}) {
  if (!env.DB) return {};
  const out = {};
  for (const [name, fn] of [
    ['purge', () => runPurgeStep(env, { now })],
    ['scan', () => runStorageScanStep(env, { now })],
    ['storageClass', () => runStorageClassStep(env, { now })],
    ['fingerprint', () => runFingerprintStep(env, { maxBlocks: STORAGE_DEFAULTS.fpBlocksCron })],
  ]) {
    try { out[name] = await fn(); } catch (e) {
      out[name] = { error: String(e?.message || e).slice(0, 200) };
      console.error(`[cron storage ${name}]`, e?.message || e);
    }
  }
  return out;
}
