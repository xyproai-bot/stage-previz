// 跑法：cd cf-worker && npm test
// NDI 小程序下載：R2 快取 GitHub 最新版（假的 GitHub）、30 分鐘最多問一次、同一個版本換檔會重抓、Range、抓不到轉 GitHub
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import {
  handleNdiDownload, syncRelease, refreshDownloadsIfStale, planReleaseSync, sameAsset, releaseCheckDue,
  assetR2Key, downloadNameFromPath, githubFallbackUrl, readDownloadState, NDI_RELEASE_API, GITHUB_UA,
  DOWNLOADS_STATE_KEY,
} from './downloads.mjs';

const WIN = 'stage-previz-ndi-helper-windows.msi';
const MAC = 'stage-previz-ndi-helper-mac.zip';
const MIN = 60_000;

function bytesOf(text) { return new TextEncoder().encode(text); }

/** 假的 GitHub：releases/latest + 檔案下載；記下每次被呼叫 */
function fakeGithub() {
  const gh = {
    calls: [],
    etag: '"rel-1"',
    tag: 'ndi-helper-v0.1.11',
    files: {
      [WIN]: { id: 101, updated_at: '2026-10-13T08:00:00Z', data: bytesOf('MSI-0.1.11-' + 'w'.repeat(500)) },
      [MAC]: { id: 102, updated_at: '2026-10-13T08:00:00Z', data: bytesOf('ZIP-0.1.11-unsigned') },
    },
    apiStatus: 200,
    failDownload: false,
  };
  gh.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    gh.calls.push({ url: String(url), headers });
    if (String(url) === NDI_RELEASE_API) {
      if (gh.apiStatus !== 200) return new Response('{"message":"API rate limit exceeded"}', { status: gh.apiStatus });
      if (headers.get('if-none-match') === gh.etag) return new Response(null, { status: 304 });
      const assets = Object.entries(gh.files).map(([name, f]) => ({
        id: f.id, name, size: f.data.byteLength, updated_at: f.updated_at, state: 'uploaded',
        browser_download_url: `https://github.com/xyproai-bot/stage-previz/releases/download/${gh.tag}/${name}`,
      }));
      return new Response(JSON.stringify({ tag_name: gh.tag, name: 'NDI helper', assets }), { status: 200, headers: { etag: gh.etag, 'content-type': 'application/json' } });
    }
    const m = /\/releases\/download\/[^/]+\/(.+)$/.exec(String(url));
    if (m && gh.files[m[1]]) {
      if (gh.failDownload) return new Response('nope', { status: 502 });
      return new Response(gh.files[m[1]].data, { status: 200, headers: { 'content-length': String(gh.files[m[1]].data.byteLength) } });
    }
    return new Response('not found', { status: 404 });
  };
  gh.apiCalls = () => gh.calls.filter(c => c.url === NDI_RELEASE_API).length;
  gh.downloadCalls = (name) => gh.calls.filter(c => c.url.endsWith('/' + name)).length;
  return gh;
}

const req = (name, headers = {}, method = 'GET') => new Request(`https://proxy.test/downloads/${name}`, { method, headers });

test('網址只認兩個檔名', () => {
  assert.equal(downloadNameFromPath('/downloads/' + WIN), WIN);
  assert.equal(downloadNameFromPath('/downloads/' + MAC), MAC);
  assert.equal(downloadNameFromPath('/downloads/../state.json'), null);
  assert.equal(downloadNameFromPath('/downloads/other.exe'), null);
  assert.equal(githubFallbackUrl(WIN), 'https://github.com/xyproai-bot/stage-previz/releases/latest/download/' + WIN);
});

test('R2 key 照 tag 分、換過檔案是不同的 key', () => {
  const a = { id: 5, name: MAC, size: 10, updated_at: '2026-10-13T08:00:00Z' };
  assert.equal(assetR2Key('ndi-helper-v0.1.11', a), `downloads/ndi-helper/ndi-helper-v0.1.11/5-20261013080000-10/${MAC}`);
  assert.notEqual(assetR2Key('ndi-helper-v0.1.11', a), assetR2Key('ndi-helper-v0.1.11', { ...a, id: 6, updated_at: '2026-10-13T09:00:00Z', size: 12 }));
  assert.equal(assetR2Key('../x y', a).startsWith('downloads/ndi-helper/.._x_y/'), true);
});

test('判斷要不要重抓：id / 更新時間 / 大小有一個不一樣就重抓', () => {
  const entry = { assetId: 5, updatedAt: 'T1', size: 10 };
  assert.equal(sameAsset(entry, { id: 5, updated_at: 'T1', size: 10 }), true);
  assert.equal(sameAsset(entry, { id: 5, updated_at: 'T2', size: 10 }), false);
  assert.equal(sameAsset(entry, { id: 5, updated_at: 'T1', size: 11 }), false);
  assert.equal(sameAsset(entry, { id: 6, updated_at: 'T1', size: 10 }), false);
  const plan = planReleaseSync({ assets: { [WIN]: entry } }, { assets: [{ id: 5, name: WIN, updated_at: 'T1', size: 10 }] });
  assert.deepEqual(plan.map(p => [p.name, p.action]), [[WIN, 'keep'], [MAC, 'missing']]);
  const plan2 = planReleaseSync({ assets: { [WIN]: entry } }, { assets: [{ id: 5, name: WIN, updated_at: 'T1', size: 10 }] }, { [WIN]: false });
  assert.equal(plan2[0].action, 'fetch', 'R2 上的檔不見了就重抓');
  assert.equal(releaseCheckDue(null, 0), true);
  assert.equal(releaseCheckDue({ checkedAt: 1000 }, 1000 + 29 * MIN), false);
  assert.equal(releaseCheckDue({ checkedAt: 1000 }, 1000 + 30 * MIN), true);
});

test('第一次下載：問 GitHub、抓進 R2、回檔案（Content-Type / Content-Disposition / 大小 / 內容都對）', async () => {
  const gh = fakeGithub();
  const r2 = memoryR2();
  const env = { MODELS: r2 };
  const now = Date.parse('2026-10-14T00:00:00Z');
  const r = await handleNdiDownload(req(WIN), env, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/x-msi');
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="${WIN}"`);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('x-release-tag'), 'ndi-helper-v0.1.11');
  assert.equal(Number(r.headers.get('content-length')), gh.files[WIN].data.byteLength);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), gh.files[WIN].data);
  // GitHub 要帶 User-Agent
  assert.ok(gh.calls.every(c => c.headers.get('user-agent') === GITHUB_UA));
  assert.equal(gh.apiCalls(), 1);
  // 兩個檔都抓了
  assert.equal(gh.downloadCalls(WIN), 1);
  assert.equal(gh.downloadCalls(MAC), 1);
  const mac = await handleNdiDownload(req(MAC), env, MAC, { now: now + MIN, fetchImpl: gh.fetch });
  assert.equal(mac.headers.get('content-type'), 'application/zip');
  assert.equal(await mac.text(), 'ZIP-0.1.11-unsigned');
  assert.equal(gh.apiCalls(), 1, '30 分鐘內不再問 GitHub');
  assert.ok(r2.keys().includes(DOWNLOADS_STATE_KEY));
});

test('Range（續傳）、HEAD、If-None-Match', async () => {
  const gh = fakeGithub();
  const env = { MODELS: memoryR2() };
  const now = Date.parse('2026-10-14T00:00:00Z');
  await syncRelease(env, { now, fetchImpl: gh.fetch });
  const size = gh.files[WIN].data.byteLength;

  const part = await handleNdiDownload(req(WIN, { range: 'bytes=4-9' }), env, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 4-9/${size}`);
  assert.equal(part.headers.get('content-length'), '6');
  assert.equal(await part.text(), '0.1.11');

  const tail = await handleNdiDownload(req(WIN, { range: 'bytes=-3' }), env, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), 'www');

  const bad = await handleNdiDownload(req(WIN, { range: `bytes=${size + 10}-` }), env, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${size}`);

  const head = await handleNdiDownload(req(WIN, {}, 'HEAD'), env, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(size));
  assert.equal(await head.text(), '');

  const etag = head.headers.get('etag');
  assert.ok(etag);
  const cached = await handleNdiDownload(req(WIN, { 'if-none-match': etag }), env, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(cached.status, 304);
  // 檔案換了（If-Range 對不上）→ 整個檔重給
  const ifRange = await handleNdiDownload(req(WIN, { range: 'bytes=0-1', 'if-range': '"old"' }), env, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(ifRange.status, 200);
  assert.equal(gh.apiCalls(), 1);
});

test('超過 30 分鐘：先給現在的檔、背景問 GitHub；沒變（304）就不重抓', async () => {
  const gh = fakeGithub();
  const env = { MODELS: memoryR2() };
  const now = Date.parse('2026-10-14T00:00:00Z');
  await syncRelease(env, { now, fetchImpl: gh.fetch });
  const bg = [];
  const r = await handleNdiDownload(req(WIN), env, WIN, { now: now + 31 * MIN, fetchImpl: gh.fetch, waitUntil: (p) => bg.push(p) });
  assert.equal(r.status, 200);
  assert.equal(bg.length, 1);
  await Promise.all(bg);
  assert.equal(gh.apiCalls(), 2);
  assert.equal(gh.calls.filter(c => c.url === NDI_RELEASE_API).at(-1).headers.get('if-none-match'), '"rel-1"');
  assert.equal(gh.downloadCalls(WIN), 1, '沒變就不重抓');
  const st = await readDownloadState(env.MODELS);
  assert.equal(st.checkedAt, now + 31 * MIN);
  // 排程：剛問過就不問
  assert.deepEqual(await refreshDownloadsIfStale(env, { now: now + 40 * MIN, fetchImpl: gh.fetch }), { skipped: true });
  assert.equal(gh.apiCalls(), 2);
});

test('同一個版本 tag，Mac 版換成公證過的（id / 更新時間 / 大小不同）→ 重抓、之後下載拿到新的', async () => {
  const gh = fakeGithub();
  const r2 = memoryR2();
  const env = { MODELS: r2 };
  const now = Date.parse('2026-10-14T00:00:00Z');
  await syncRelease(env, { now, fetchImpl: gh.fetch });
  const oldKey = (await readDownloadState(r2)).assets[MAC].key;

  gh.files[MAC] = { id: 202, updated_at: '2026-10-13T09:30:00Z', data: bytesOf('ZIP-0.1.11-notarized!!') };
  gh.etag = '"rel-2"';
  const res = await refreshDownloadsIfStale(env, { now: now + 30 * MIN, fetchImpl: gh.fetch });
  assert.deepEqual(res.changed, [MAC]);
  assert.equal(gh.downloadCalls(WIN), 1, 'Windows 版沒變不重抓');
  assert.equal(gh.downloadCalls(MAC), 2);
  const st = await readDownloadState(r2);
  assert.notEqual(st.assets[MAC].key, oldKey);
  assert.equal(st.previous[MAC], oldKey, '上一個留著（下載到一半的人可以續傳）');
  const mac = await handleNdiDownload(req(MAC), env, MAC, { now: now + 31 * MIN, fetchImpl: gh.fetch });
  assert.equal(await mac.text(), 'ZIP-0.1.11-notarized!!');

  // 再換一次 → 最舊的那個刪掉
  gh.files[MAC] = { id: 303, updated_at: '2026-10-13T10:00:00Z', data: bytesOf('ZIP-0.1.12') };
  gh.tag = 'ndi-helper-v0.1.12';
  gh.etag = '"rel-3"';
  await refreshDownloadsIfStale(env, { now: now + 61 * MIN, fetchImpl: gh.fetch });
  assert.ok(!r2.keys().includes(oldKey));
  assert.ok(r2.keys().some(k => k.startsWith('downloads/ndi-helper/ndi-helper-v0.1.12/')));
});

test('GitHub 掛了：有存著的照樣給；什麼都沒有 → 轉去 GitHub；下載一半壞掉不記 ETag（下次重試）', async () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  // 什麼都沒有 + GitHub API 被限流 → 302
  const gh = fakeGithub();
  gh.apiStatus = 403;
  const empty = { MODELS: memoryR2() };
  const r = await handleNdiDownload(req(WIN), empty, WIN, { now, fetchImpl: gh.fetch });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), githubFallbackUrl(WIN));
  const st = await readDownloadState(empty.MODELS);
  assert.match(st.lastError.message, /403/);
  // 剛問過（失敗）→ 30 分鐘內不再問，直接轉
  const r2nd = await handleNdiDownload(req(WIN), empty, WIN, { now: now + MIN, fetchImpl: gh.fetch });
  assert.equal(r2nd.status, 302);
  assert.equal(gh.apiCalls(), 1);

  // 有存著的 + GitHub 掛了 → 給存著的
  const gh2 = fakeGithub();
  const env = { MODELS: memoryR2() };
  await syncRelease(env, { now, fetchImpl: gh2.fetch });
  gh2.apiStatus = 500;
  const bg = [];
  const ok = await handleNdiDownload(req(WIN), env, WIN, { now: now + 31 * MIN, fetchImpl: gh2.fetch, waitUntil: (p) => bg.push(p) });
  assert.equal(ok.status, 200);
  await Promise.all(bg);

  // 下載檔案失敗 → 不記 ETag
  const gh3 = fakeGithub();
  gh3.failDownload = true;
  const env3 = { MODELS: memoryR2() };
  const res = await syncRelease(env3, { now, fetchImpl: gh3.fetch });
  assert.match(res.error, /502/);
  assert.equal(res.state.etag, null);
  const fallback = await handleNdiDownload(req(WIN), env3, WIN, { now: now + MIN, fetchImpl: gh3.fetch });
  assert.equal(fallback.status, 302);
  gh3.failDownload = false;
  const later = await handleNdiDownload(req(WIN), env3, WIN, { now: now + 31 * MIN, fetchImpl: gh3.fetch });
  assert.equal(later.status, 200);
  assert.equal(gh3.calls.filter(c => c.url === NDI_RELEASE_API).at(-1).headers.get('if-none-match'), null);
});

test('走真的路由：/downloads/<檔名>（只有 GET / HEAD；其他檔名 404）', async () => {
  const env = { MODELS: memoryR2() };
  const notFound = await worker.fetch(new Request('https://proxy.test/downloads/evil.exe'), env);
  assert.equal(notFound.status, 404);
  const post = await worker.fetch(new Request('https://proxy.test/downloads/' + WIN, { method: 'POST' }), env);
  assert.equal(post.status, 405);
});
