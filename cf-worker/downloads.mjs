// NDI 小程序從我們自己的網域下載（中國大陸連 GitHub 很慢或連不上）
//
//   GET /downloads/stage-previz-ndi-helper-windows.msi
//   GET /downloads/stage-previz-ndi-helper-mac.zip
//
// 檔案放 R2：downloads/ndi-helper/<版本 tag>/<GitHub 檔案 id>-<更新時間>-<大小>/<檔名>
//   - 最多 30 分鐘問一次 GitHub 最新版（排程每 5 分鐘看一下是不是該問了；下載的人碰到太久沒問也會在背景問）
//   - 同一個版本 tag，GitHub 上的檔案換掉（Mac 版發佈後會換成 Apple 公證過的 zip）→ 檔案 id / 更新時間 / 大小不一樣 → 重新抓
//   - R2 上沒有、又抓不到 → 302 轉到 GitHub（至少還下載得到）
//   - 支援 Range（續傳 / 多段下載）、HEAD、If-None-Match
// 進度（上次什麼時候問的、現在是哪個檔）存在 R2 的 downloads/ndi-helper/state.json

import { parseRangeHeader } from './videos.mjs';

export const NDI_REPO = 'xyproai-bot/stage-previz';
export const NDI_RELEASE_API = `https://api.github.com/repos/${NDI_REPO}/releases/latest`;
export const NDI_DOWNLOADS = Object.freeze({
  'stage-previz-ndi-helper-windows.msi': { contentType: 'application/x-msi' },
  'stage-previz-ndi-helper-mac.zip': { contentType: 'application/zip' },
});
export const DOWNLOADS_PREFIX = 'downloads/ndi-helper/';
export const DOWNLOADS_STATE_KEY = `${DOWNLOADS_PREFIX}state.json`;
export const RELEASE_CHECK_INTERVAL_MS = 30 * 60_000;
export const GITHUB_UA = 'stage-previz-proxy/1.0 (+https://proxy.haimiaan.com)';

/** 抓不到時轉去的 GitHub 網址 */
export function githubFallbackUrl(name) {
  return `https://github.com/${NDI_REPO}/releases/latest/download/${name}`;
}

/** '/downloads/<檔名>' → 檔名（只認上面兩個） */
export function downloadNameFromPath(pathname) {
  const m = /^\/downloads\/([^/]+)$/.exec(String(pathname || ''));
  if (!m) return null;
  return Object.prototype.hasOwnProperty.call(NDI_DOWNLOADS, m[1]) ? m[1] : null;
}

/** R2 key（照版本 tag 分資料夾；同一個 tag 換過檔案會是不同的 key） */
export function assetR2Key(tag, asset) {
  const safeTag = String(tag || 'untagged').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'untagged';
  const updated = String(asset.updated_at || '').replace(/[^0-9]/g, '').slice(0, 14) || '0';
  return `${DOWNLOADS_PREFIX}${safeTag}/${asset.id}-${updated}-${asset.size}/${asset.name}`;
}

/** 存著的檔跟 GitHub 上現在的檔是不是同一個（id、更新時間、大小都一樣） */
export function sameAsset(entry, asset) {
  return !!entry && !!asset
    && String(entry.assetId) === String(asset.id)
    && entry.updatedAt === asset.updated_at
    && Number(entry.size) === Number(asset.size);
}

/** 該不該問 GitHub 了（最多 30 分鐘一次） */
export function releaseCheckDue(state, nowMs, intervalMs = RELEASE_CHECK_INTERVAL_MS) {
  const t = Number(state?.checkedAt);
  return !Number.isFinite(t) || nowMs - t >= intervalMs;
}

/**
 * GitHub 最新版 → 每個檔要做什麼
 * @returns {Array<{name: string, action: 'keep'|'fetch'|'missing', asset?: any, entry?: any}>}
 *   keep = 存著的就是最新的；fetch = 要重新抓；missing = 最新版沒有這個檔（先留著舊的）
 */
export function planReleaseSync(state, release, present = {}) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return Object.keys(NDI_DOWNLOADS).map(name => {
    const asset = assets.find(a => a && a.name === name && (a.state === undefined || a.state === 'uploaded'));
    const entry = state?.assets?.[name] || null;
    if (!asset) return { name, action: 'missing', entry };
    if (sameAsset(entry, asset) && present[name] !== false) return { name, action: 'keep', asset, entry };
    return { name, action: 'fetch', asset, entry };
  });
}

export function contentDispositionFor(name) {
  return `attachment; filename="${name}"`;
}

// ─── 進度（R2 JSON）───

export async function readDownloadState(bucket) {
  try {
    const o = await bucket.get(DOWNLOADS_STATE_KEY);
    if (!o) return null;
    const s = JSON.parse(await o.text());
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

async function writeDownloadState(bucket, state) {
  await bucket.put(DOWNLOADS_STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
}

function githubHeaders(env, extra = {}) {
  const h = { 'User-Agent': GITHUB_UA, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
  if (env?.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

/** 從 GitHub 抓一個檔存進 R2（大小一定要對得上） */
async function storeAsset(bucket, tag, asset, fetchImpl) {
  const meta = NDI_DOWNLOADS[asset.name];
  const res = await fetchImpl(asset.browser_download_url, {
    headers: { 'User-Agent': GITHUB_UA, Accept: 'application/octet-stream' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`下載 ${asset.name} 失敗（HTTP ${res.status}）`);
  const key = assetR2Key(tag, asset);
  const putOpts = {
    httpMetadata: { contentType: meta.contentType, contentDisposition: contentDispositionFor(asset.name) },
    customMetadata: { tag: String(tag || ''), assetId: String(asset.id), updatedAt: String(asset.updated_at || ''), size: String(asset.size) },
  };
  let obj;
  if (typeof globalThis.FixedLengthStream === 'function' && Number(asset.size) > 0) {
    // 大小固定：R2 才收得下串流；大小對不上會直接失敗（不會存一個壞掉的檔）
    const { readable, writable } = new globalThis.FixedLengthStream(Number(asset.size));
    const pipe = res.body.pipeTo(writable);
    pipe.catch(() => {});
    [obj] = await Promise.all([bucket.put(key, readable, putOpts), pipe]);
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (Number(asset.size) > 0 && buf.byteLength !== Number(asset.size)) {
      throw new Error(`${asset.name} 大小對不上（${buf.byteLength} / ${asset.size}）`);
    }
    obj = await bucket.put(key, buf, putOpts);
  }
  return {
    key, tag: String(tag || ''), assetId: asset.id, updatedAt: asset.updated_at || null, size: Number(asset.size),
    digest: typeof asset.digest === 'string' ? asset.digest : null,
    etag: obj?.httpEtag || null, contentType: meta.contentType,
  };
}

/** R2 上留著：現在的 + 上一個（下載到一半的人還能續傳），其他的刪掉 */
async function pruneOldAssets(bucket, state) {
  const keep = new Set([DOWNLOADS_STATE_KEY]);
  for (const e of Object.values(state.assets || {})) if (e?.key) keep.add(e.key);
  for (const k of Object.values(state.previous || {})) if (k) keep.add(k);
  const listed = await bucket.list({ prefix: DOWNLOADS_PREFIX, limit: 1000 });
  const remove = (listed.objects || []).map(o => o.key).filter(k => !keep.has(k));
  if (remove.length) await bucket.delete(remove);
  return remove;
}

/**
 * 問 GitHub 最新版，有新的就抓進 R2
 * @param {{MODELS: any, GITHUB_TOKEN?: string}} env
 * @param {{now?: number, fetchImpl?: typeof fetch}} [o]
 * @returns {Promise<{state: any, changed: string[], error: string|null, status?: number}>}
 */
export async function syncRelease(env, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const bucket = env.MODELS;
  const state = (await readDownloadState(bucket)) || { assets: {} };
  state.assets = state.assets || {};
  state.previous = state.previous || {};

  // R2 上的檔還在不在（不在的話不帶 If-None-Match，強制拿完整的清單）
  const present = {};
  for (const name of Object.keys(NDI_DOWNLOADS)) {
    const e = state.assets[name];
    present[name] = e?.key ? !!(await bucket.head(e.key).catch(() => null)) : false;
  }
  const allPresent = Object.values(present).every(Boolean);

  const changed = [];
  let error = null, status;
  try {
    const headers = githubHeaders(env, state.etag && allPresent ? { 'If-None-Match': state.etag } : {});
    const res = await fetchImpl(NDI_RELEASE_API, { headers });
    status = res.status;
    if (res.status === 304) {
      // 沒變
    } else if (!res.ok) {
      error = `GitHub 回 HTTP ${res.status}`;
    } else {
      const release = await res.json();
      const tag = release?.tag_name || null;
      let allOk = true;
      for (const step of planReleaseSync(state, release, present)) {
        if (step.action === 'keep') continue;
        if (step.action === 'missing') { allOk = false; continue; }
        try {
          const entry = await storeAsset(bucket, tag, step.asset, fetchImpl);
          entry.storedAt = now;
          if (state.assets[step.name]?.key && state.assets[step.name].key !== entry.key) {
            state.previous[step.name] = state.assets[step.name].key;
          }
          state.assets[step.name] = entry;
          changed.push(step.name);
        } catch (e) {
          allOk = false;
          error = String(e?.message || e).slice(0, 200);
        }
      }
      state.tag = tag;
      state.releaseName = typeof release?.name === 'string' ? release.name.slice(0, 120) : null;
      // 有檔案沒抓成功 → 不記 ETag（下次問的時候拿完整清單再試）
      state.etag = allOk ? (res.headers.get('etag') || null) : null;
    }
  } catch (e) {
    error = String(e?.message || e).slice(0, 200);
  }
  state.checkedAt = now;
  state.lastError = error ? { at: now, message: error, status: status ?? null } : null;
  await writeDownloadState(bucket, state);
  if (changed.length) await pruneOldAssets(bucket, state).catch(() => {});
  return { state, changed, error, status };
}

/** 排程用：超過 30 分鐘沒問就問一次 */
export async function refreshDownloadsIfStale(env, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  if (!env.MODELS) return { skipped: true };
  const state = await readDownloadState(env.MODELS);
  if (!releaseCheckDue(state, now)) return { skipped: true };
  return syncRelease(env, { now, fetchImpl });
}

function redirectToGithub(name) {
  return new Response(null, { status: 302, headers: { Location: githubFallbackUrl(name), 'Cache-Control': 'no-store' } });
}

/** 從 R2 回檔案（Range、HEAD、If-None-Match） */
async function serveEntry(request, bucket, name, entry) {
  const isHead = request.method === 'HEAD';
  const headers = new Headers();
  headers.set('Content-Type', NDI_DOWNLOADS[name].contentType);
  headers.set('Content-Disposition', contentDispositionFor(name));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (entry.tag) headers.set('X-Release-Tag', entry.tag);

  const head = await bucket.head(entry.key);
  if (!head) return null;
  const size = Number(head.size);
  const etag = head.httpEtag || entry.etag || null;
  if (etag) headers.set('ETag', etag);
  if (head.uploaded) headers.set('Last-Modified', new Date(head.uploaded).toUTCString());

  const inm = request.headers.get('if-none-match');
  if (inm && etag && inm.split(',').map(s => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (isHead) {
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  // If-Range 對不上（檔案換了）→ 整個檔重給
  const ifRange = request.headers.get('if-range');
  const rangeHeader = ifRange && etag && ifRange.trim() !== etag ? null : request.headers.get('range');
  const range = parseRangeHeader(rangeHeader, size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const obj = await bucket.get(entry.key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {});
  if (!obj || !obj.body) return null;
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  return new Response(obj.body, { status: 200, headers });
}

/**
 * GET / HEAD /downloads/<檔名>
 * @param {{now?: number, fetchImpl?: typeof fetch, waitUntil?: (p: Promise<any>) => void}} [o]
 */
export async function handleNdiDownload(request, env, name, { now = Date.now(), fetchImpl = globalThis.fetch, waitUntil = null } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'GET, HEAD' } });
  }
  if (!NDI_DOWNLOADS[name]) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const bucket = env.MODELS;
  if (!bucket) return redirectToGithub(name);

  let state = await readDownloadState(bucket);
  const due = releaseCheckDue(state, now);
  let entry = state?.assets?.[name] || null;
  if (entry) {
    const resp = await serveEntry(request, bucket, name, entry).catch(() => null);
    if (resp) {
      // 太久沒問 GitHub → 先給現在的檔，背景問一次
      if (due && waitUntil) waitUntil(syncRelease(env, { now, fetchImpl }).catch(() => {}));
      return resp;
    }
  }
  // R2 上沒有：該問了（或檔案不見了、上次問已經超過 1 分鐘）→ 現在就抓
  const lastCheck = Number(state?.checkedAt) || 0;
  if (due || (entry && now - lastCheck > 60_000)) {
    try {
      const r = await syncRelease(env, { now, fetchImpl });
      state = r.state;
      entry = state?.assets?.[name] || null;
      if (entry) {
        const resp = await serveEntry(request, bucket, name, entry).catch(() => null);
        if (resp) return resp;
      }
    } catch (e) {
      console.warn('[downloads]', name, String(e?.message || e).slice(0, 200));
    }
  }
  return redirectToGithub(name);
}
