// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSongCodeInput, songCodeKey, nextSongCode, fillMissingSongCodes, songCodeTakenBy, matchSongByFilename,
  videoMimeFor, extForMime, isDriveVideoFile, driveSourceRev, unsupportedFormatMessage, planDriveVersions, driveVersionKey,
  planParts, expectedPartSize, missingParts, nextCopyPart, UPLOAD_PART_SIZE, COPY_PART_SIZE, MIB, GIB,
  nextVideoVersion, versionLabel, videoMaxBytes, formatBytes, DEFAULT_VIDEO_MAX_BYTES, copyPartSize,
  videoUploadDecision, videoModifyDecision,
  classifyVideoLink, isBlockedHost, interpretProbe, filenameFromContentDisposition, totalFromContentRange,
  signVideoPass, verifyVideoPass, VIDEO_PASS_BUCKET_MS, parseRangeHeader,
} from './videos.mjs';

// ─── 歌曲代號 ───

test('代號輸入：大寫、去空白；只收英數字和中間的 -', () => {
  assert.deepEqual(normalizeSongCodeInput(' s01 '), { code: 'S01' });
  assert.deepEqual(normalizeSongCodeInput('enc-1'), { code: 'ENC-1' });
  assert.deepEqual(normalizeSongCodeInput('OP'), { code: 'OP' });
  assert.ok(normalizeSongCodeInput('').error);
  assert.ok(normalizeSongCodeInput('   ').error);
  assert.ok(normalizeSongCodeInput('S01_A').error, '底線是檔名的分隔符號，不能在代號裡');
  assert.ok(normalizeSongCodeInput('S 01').error);
  assert.ok(normalizeSongCodeInput('-S01').error);
  assert.ok(normalizeSongCodeInput('S01-').error);
  assert.ok(normalizeSongCodeInput('歌1').error);
  assert.ok(normalizeSongCodeInput('ABCDEFGHIJKLM').error, '超過 12 字');
  assert.ok(normalizeSongCodeInput(null).error);
});

test('比對用的代號：S1 = S01 = s001', () => {
  assert.equal(songCodeKey('S01'), 'S1');
  assert.equal(songCodeKey('s001'), 'S1');
  assert.equal(songCodeKey('S10'), 'S10');
  assert.equal(songCodeKey('ENC-02'), 'ENC-2');
  assert.notEqual(songCodeKey('S01A'), songCodeKey('S01'));
});

test('新歌代號：接在最大的 S 號碼後面', () => {
  assert.equal(nextSongCode([]), 'S01');
  assert.equal(nextSongCode(['S01', 'S02']), 'S03');
  assert.equal(nextSongCode(['S01', 'S05', 'OP']), 'S06');
  assert.equal(nextSongCode(['S9']), 'S10');
  assert.equal(nextSongCode(['S99']), 'S100');
  assert.equal(nextSongCode([null, 'ENC']), 'S01');
});

test('沒有代號的歌依順序補上，不跟現有的撞', () => {
  const out = fillMissingSongCodes([
    { id: 'a', code: 'S01' }, { id: 'b', code: null }, { id: 'c', code: 'S03' }, { id: 'd' },
  ]);
  assert.deepEqual(out, [{ id: 'b', code: 'S04' }, { id: 'd', code: 'S05' }]);
  assert.deepEqual(fillMissingSongCodes([{ id: 'a', code: 'S01' }]), []);
});

test('代號被別首歌用掉（S1 和 S01 算同一個）', () => {
  const songs = [{ id: 'a', code: 'S01' }, { id: 'b', code: 'S02' }];
  assert.equal(songCodeTakenBy('s1', songs)?.id, 'a');
  assert.equal(songCodeTakenBy('S01', songs, 'a'), null, '改自己的代號不算撞');
  assert.equal(songCodeTakenBy('S03', songs), null);
});

test('檔名開頭的代號對到歌', () => {
  const songs = [
    { id: 's1', code: 'S01' }, { id: 's2', code: 'S02' }, { id: 's10', code: 'S10' },
    { id: 'enc', code: 'ENC-1' }, { id: 's1b', code: 'S01-B' }, { id: 'none', code: null },
  ];
  assert.equal(matchSongByFilename('S01_開場.mp4', songs), 's1');
  assert.equal(matchSongByFilename('s01_開場.mp4', songs), 's1');
  assert.equal(matchSongByFilename('S1_開場.mp4', songs), 's1');
  assert.equal(matchSongByFilename('S01-開場.mp4', songs), 's1');
  assert.equal(matchSongByFilename('S01 開場.mp4', songs), 's1');
  assert.equal(matchSongByFilename('S01.mp4', songs), 's1');
  assert.equal(matchSongByFilename('S01開場.mp4', songs), 's1', '中文直接接在後面也算');
  assert.equal(matchSongByFilename('S10_x.mov', songs), 's10');
  assert.equal(matchSongByFilename('S01-B_x.mp4', songs), 's1b', '最長的代號優先');
  assert.equal(matchSongByFilename('S01-v2_x.mp4', songs), 's1');
  assert.equal(matchSongByFilename('ENC-1_安可.mp4', songs), 'enc');
  assert.equal(matchSongByFilename('S01A_x.mp4', songs), null, '代號後面接英數字不算');
  assert.equal(matchSongByFilename('S03_x.mp4', songs), null, '沒有這個代號 → 未分類');
  assert.equal(matchSongByFilename('開場_S01.mp4', songs), null, '代號要在最前面');
  assert.equal(matchSongByFilename('', songs), null);
});

test('舊專案：照順序補的代號跟以前「S03 = 第 3 首」對到同一首', () => {
  // migration 0021：order 0 → S01、1 → S02、2 → S03
  const songs = [{ id: 'first', order: 0 }, { id: 'second', order: 1 }, { id: 'third', order: 2 }]
    .map(s => ({ ...s, code: `S${String(s.order + 1).padStart(2, '0')}` }));
  // 以前 driveSyncProjectInternal：/^S(\d+)_/ 抓到 3 → order + 1 === 3 的那首
  const oldMatch = (name) => {
    const m = /^S(\d+)_/.exec(name);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return (songs.find(s => s.order + 1 === n) || songs.find(s => s.order + 1 === n + 1) || {}).id ?? null;
  };
  for (const name of ['S01_a.mp4', 'S02_b.mp4', 'S03_c.mov', 'S3_c.mov']) {
    assert.equal(matchSongByFilename(name, songs), oldMatch(name), name);
  }
});

// ─── 影片格式 ───

test('只收 MP4 / MOV / WebM；一般檔案類型看副檔名', () => {
  assert.equal(videoMimeFor({ mime: 'video/mp4' }), 'video/mp4');
  assert.equal(videoMimeFor({ mime: 'video/quicktime; charset=x' }), 'video/quicktime');
  assert.equal(videoMimeFor({ mime: 'video/webm' }), 'video/webm');
  assert.equal(videoMimeFor({ mime: 'video/x-m4v' }), 'video/mp4');
  assert.equal(videoMimeFor({ mime: 'application/octet-stream', filename: 'a.MOV' }), 'video/quicktime');
  assert.equal(videoMimeFor({ mime: '', filename: 'a.m4v' }), 'video/mp4');
  assert.equal(videoMimeFor({ mime: 'video/x-matroska', filename: 'a.mp4' }), null, '真的類型是 mkv → 不收');
  assert.equal(videoMimeFor({ mime: 'image/png', filename: 'a.mp4' }), null);
  assert.equal(videoMimeFor({ mime: 'application/octet-stream', filename: 'a.mkv' }), null);
  assert.equal(extForMime('video/quicktime'), 'mov');
  assert.equal(extForMime('video/webm'), 'webm');
  assert.equal(extForMime('video/mp4'), 'mp4');
  assert.match(unsupportedFormatMessage('a.mkv'), /\.mkv/);
});

test('Drive 資料夾只列影片檔', () => {
  assert.equal(isDriveVideoFile({ name: 'S01_a.mp4', mimeType: 'video/mp4' }), true);
  assert.equal(isDriveVideoFile({ name: 'S01_a.mkv', mimeType: 'video/x-matroska' }), true);
  assert.equal(isDriveVideoFile({ name: 'S01_a.mov', mimeType: 'application/octet-stream' }), true);
  assert.equal(isDriveVideoFile({ name: 'S01_封面.png', mimeType: 'image/png' }), false);
  assert.equal(isDriveVideoFile({ name: 'S01 歌詞', mimeType: 'application/vnd.google-apps.document' }), false);
  assert.equal(isDriveVideoFile({ name: 'S01', mimeType: 'application/vnd.google-apps.folder' }), false);
  assert.equal(driveSourceRev({ md5Checksum: 'abc', modifiedTime: 't' }), 'md5:abc');
  assert.equal(driveSourceRev({ modifiedTime: 't', size: '9' }), 'mt:t|9');
});

test('Drive 同步：新的 / 改過的影片建新版，看過的不重複，照 Drive 時間排', () => {
  const songs = [{ id: 's1', code: 'S01' }, { id: 's2', code: 'S02' }];
  const files = [
    { id: 'f2', name: 'S02_b.mp4', mimeType: 'video/mp4', size: '100', md5Checksum: 'b1', modifiedTime: '2026-01-02T00:00:00Z' },
    { id: 'f1', name: 'S01_a.mov', mimeType: 'video/quicktime', size: '200', md5Checksum: 'a1', modifiedTime: '2026-01-01T00:00:00Z',
      videoMediaMetadata: { width: 1920, height: 1080, durationMillis: '61500' } },
    { id: 'f3', name: 'S09_none.mp4', mimeType: 'video/mp4', size: '5', md5Checksum: 'c', modifiedTime: '2026-01-03T00:00:00Z' },
    { id: 'f4', name: 'S01_raw.mkv', mimeType: 'video/x-matroska', size: '5', md5Checksum: 'd', modifiedTime: '2026-01-04T00:00:00Z' },
    { id: 'f5', name: 'S02_huge.mp4', mimeType: 'video/mp4', size: String(5 * GIB), md5Checksum: 'e', modifiedTime: '2026-01-05T00:00:00Z' },
  ];
  const pairs = files.map(f => ({ file: f, songId: matchSongByFilename(f.name, songs) }));
  const plan = planDriveVersions({ pairs, seen: new Set(), maxBytes: 4 * GIB });
  assert.deepEqual(plan.map(p => [p.file.id, p.songId, p.status]), [
    ['f1', 's1', 'processing'], ['f2', 's2', 'processing'], ['f4', 's1', 'failed'], ['f5', 's2', 'failed'],
  ], '沒對到歌的 f3 不建；照時間排');
  assert.equal(plan[0].mime, 'video/quicktime');
  assert.deepEqual([plan[0].width, plan[0].height, plan[0].durationSec], [1920, 1080, 61.5]);
  assert.match(plan[2].error, /.mkv/);
  assert.match(plan[3].error, /太大/);
  // 第二次同步：都看過了 → 不建
  const seen = new Set(plan.map(p => driveVersionKey(p.songId, p.file.id, p.rev)));
  assert.deepEqual(planDriveVersions({ pairs, seen, maxBytes: 4 * GIB }), []);
  // f1 內容改了（md5 變了）→ 只建 f1 的新版
  const changed = pairs.map(p => p.file.id === 'f1' ? { ...p, file: { ...p.file, md5Checksum: 'a2' } } : p);
  assert.deepEqual(planDriveVersions({ pairs: changed, seen, maxBytes: 4 * GIB }).map(p => p.file.id), ['f1']);
  // 手動把 f2 改歸到 s1 → s1 多一版（s2 那一版留著）
  const moved = pairs.map(p => p.file.id === 'f2' ? { ...p, songId: 's1' } : p);
  assert.deepEqual(planDriveVersions({ pairs: moved, seen, maxBytes: 4 * GIB }).map(p => [p.file.id, p.songId]), [['f2', 's1']]);
  // 同一批裡重複的只算一次
  assert.equal(planDriveVersions({ pairs: [pairs[0], pairs[0]], seen: new Set() }).length, 1);
});

// ─── 分段 ───

test('切段：每段一樣大，最後一段放剩下的', () => {
  const p = planParts(40 * MIB + 5, UPLOAD_PART_SIZE);
  assert.deepEqual(p, { ok: true, partSize: UPLOAD_PART_SIZE, partCount: 3 });
  assert.equal(expectedPartSize(40 * MIB + 5, UPLOAD_PART_SIZE, 1), UPLOAD_PART_SIZE);
  assert.equal(expectedPartSize(40 * MIB + 5, UPLOAD_PART_SIZE, 3), 40 * MIB + 5 - 2 * UPLOAD_PART_SIZE);
  assert.equal(expectedPartSize(40 * MIB + 5, UPLOAD_PART_SIZE, 4), 0);
  assert.equal(expectedPartSize(40 * MIB + 5, UPLOAD_PART_SIZE, 0), 0);
  assert.deepEqual(planParts(1000), { ok: true, partSize: UPLOAD_PART_SIZE, partCount: 1 });
  assert.equal(planParts(0).ok, false);
  assert.equal(planParts(1.5).ok, false);
  // 超過 10000 段 → 每段放大
  const huge = planParts(10001 * MIB, MIB * 1);
  assert.ok(huge.partCount <= 10000);
  assert.deepEqual(missingParts(4, [1, 3]), [2, 4]);
  assert.deepEqual(missingParts(2, ['1', '2']), []);
});

test('後台複製：下一段的範圍', () => {
  const size = 2 * COPY_PART_SIZE + 10;
  assert.deepEqual(nextCopyPart({ size, partSize: COPY_PART_SIZE, doneParts: [] }),
    { partNumber: 1, start: 0, end: COPY_PART_SIZE - 1, length: COPY_PART_SIZE, partCount: 3 });
  assert.deepEqual(nextCopyPart({ size, partSize: COPY_PART_SIZE, doneParts: new Set([1, 2]) }),
    { partNumber: 3, start: 2 * COPY_PART_SIZE, end: size - 1, length: 10, partCount: 3 });
  assert.equal(nextCopyPart({ size, partSize: COPY_PART_SIZE, doneParts: [1, 2, 3] }), null);
});

// ─── 版本號 ───

test('版本號只增不減（刪掉的號碼不再用）', () => {
  assert.equal(nextVideoVersion(0, 0), 1);
  assert.equal(nextVideoVersion(null, null), 1);
  assert.equal(nextVideoVersion(3, 2), 4, 'V3 被刪了，下一版還是 V4');
  assert.equal(nextVideoVersion(0, 5), 6, '舊資料沒有計數 → 看最大版本');
  assert.equal(versionLabel(3), 'V3');
  assert.equal(versionLabel(null), '');
});

test('上限：預設 4 GB，可以用 VIDEO_MAX_BYTES 改', () => {
  assert.equal(videoMaxBytes({}), DEFAULT_VIDEO_MAX_BYTES);
  assert.equal(videoMaxBytes({ VIDEO_MAX_BYTES: String(2 * GIB) }), 2 * GIB);
  assert.equal(videoMaxBytes({ VIDEO_MAX_BYTES: 'abc' }), DEFAULT_VIDEO_MAX_BYTES);
  assert.equal(copyPartSize({}), COPY_PART_SIZE);
  assert.equal(copyPartSize({ VIDEO_COPY_PART_BYTES: String(5 * MIB) }), 5 * MIB);
  assert.equal(copyPartSize({ VIDEO_COPY_PART_BYTES: '100' }), COPY_PART_SIZE, '小於 5 MiB 不行（R2 規定）');
  assert.equal(formatBytes(4 * GIB), '4 GB');
  assert.equal(formatBytes(1.5 * GIB), '1.5 GB');
  assert.equal(formatBytes(300 * MIB), '300 MB');
});

// ─── 權限 ───

test('交影片：admin、負責的動畫師（沒指派 = 專案動畫師都可以）；導演只能看', () => {
  const song = { animator_user_id: 'u_a' };
  assert.equal(videoUploadDecision({ role: 'admin', userId: 'x', song }).ok, true);
  assert.equal(videoUploadDecision({ role: 'animator', userId: 'u_a', song }).ok, true);
  const other = videoUploadDecision({ role: 'animator', userId: 'u_b', song });
  assert.equal(other.ok, false);
  assert.equal(other.status, 403);
  assert.equal(videoUploadDecision({ role: 'animator', userId: 'u_b', song: { animator_user_id: null } }).ok, true);
  const dir = videoUploadDecision({ role: 'director', userId: 'u_d', song });
  assert.equal(dir.ok, false);
  assert.match(dir.error, /導演/);
  assert.equal(videoUploadDecision({ role: null, userId: 'x', song }).ok, false);
});

test('改 / 刪 / 繼續上傳某一版：admin 或交這一版的人', () => {
  const song = { animator_user_id: null };
  assert.equal(videoModifyDecision({ role: 'admin', userId: 'x', song, video: { created_by: 'u_a' } }).ok, true);
  assert.equal(videoModifyDecision({ role: 'animator', userId: 'u_a', song, video: { created_by: 'u_a' } }).ok, true);
  assert.equal(videoModifyDecision({ role: 'animator', userId: 'u_b', song, video: { created_by: 'u_a' } }).ok, false);
  assert.equal(videoModifyDecision({ role: 'animator', userId: 'u_a', song, video: { created_by: null } }).ok, false, 'Drive 同步的版本只有 admin 能改');
  // 歌後來指派給別人 → 原本交的人也不能再動
  assert.equal(videoModifyDecision({ role: 'animator', userId: 'u_a', song: { animator_user_id: 'u_b' }, video: { created_by: 'u_a' } }).ok, false);
  assert.equal(videoModifyDecision({ role: 'director', userId: 'u_d', song, video: { created_by: 'u_d' } }).ok, false);
});

// ─── 貼連結 ───

test('Google Drive 單檔連結', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const url of [
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/file/u/0/d/${id}/view`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?id=${id}&export=download`,
    `https://drive.usercontent.google.com/download?id=${id}&export=download`,
    `https://docs.google.com/file/d/${id}/edit`,
  ]) {
    const r = classifyVideoLink(url);
    assert.equal(r.ok, true, url);
    assert.equal(r.kind, 'drive');
    assert.equal(r.fileId, id);
  }
  assert.equal(classifyVideoLink(`https://drive.google.com/file/d/${id}/view?resourcekey=0-abc_DEF`).resourceKey, '0-abc_DEF');
  assert.match(classifyVideoLink(`https://drive.google.com/drive/folders/${id}`).error, /資料夾/);
  assert.match(classifyVideoLink(`https://drive.google.com/drive/u/0/folders/${id}`).error, /資料夾/);
  assert.match(classifyVideoLink(`https://docs.google.com/document/d/${id}/edit`).error, /Google 文件/);
  assert.equal(classifyVideoLink('https://drive.google.com/file/d/short/view').ok, false);
});

test('Dropbox：改成 dl=1，資料夾 / 自己的網址給清楚的錯誤', () => {
  const a = classifyVideoLink('https://www.dropbox.com/scl/fi/abc123/S01_x.mp4?rlkey=k1&dl=0');
  assert.equal(a.kind, 'dropbox');
  const d = new URL(a.downloadUrl);
  assert.equal(d.searchParams.get('dl'), '1');
  assert.equal(d.searchParams.get('rlkey'), 'k1');
  assert.equal(a.filenameHint, 'S01_x.mp4');
  const b = classifyVideoLink('https://dropbox.com/s/xyz/a.mov?raw=1');
  assert.equal(new URL(b.downloadUrl).hostname, 'www.dropbox.com');
  assert.equal(new URL(b.downloadUrl).searchParams.get('raw'), null);
  assert.equal(classifyVideoLink('https://dl.dropboxusercontent.com/s/xyz/a.mov').kind, 'dropbox');
  assert.match(classifyVideoLink('https://www.dropbox.com/scl/fo/abc/xyz?rlkey=1').error, /資料夾/);
  assert.match(classifyVideoLink('https://www.dropbox.com/sh/abc/xyz').error, /資料夾/);
  assert.match(classifyVideoLink('https://www.dropbox.com/home/Videos').error, /分享/);
});

test('OneDrive / SharePoint：盡量轉成下載網址', () => {
  const a = classifyVideoLink('https://1drv.ms/v/s!AbCdEf');
  assert.equal(a.kind, 'onedrive');
  assert.match(a.downloadUrl, /^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u!/);
  assert.ok(!a.downloadUrl.includes('='), 'base64url 不帶 =');
  const b = classifyVideoLink('https://contoso.sharepoint.com/:v:/g/personal/a_b/EaBc?e=xyz');
  assert.equal(b.kind, 'sharepoint');
  assert.equal(new URL(b.downloadUrl).searchParams.get('download'), '1');
  assert.match(classifyVideoLink('https://contoso-my.sharepoint.com/personal/a/_layouts/15/onedrive.aspx?id=1').error, /分享/);
  assert.match(classifyVideoLink('https://onedrive.live.com/?id=root').error, /分享/);
});

test('直接網址；影音網站、內部網路、亂打的給中文錯誤', () => {
  const a = classifyVideoLink('https://cdn.example.com/media/S01_final.mp4?sig=1');
  assert.equal(a.kind, 'direct');
  assert.equal(a.filenameHint, 'S01_final.mp4');
  assert.equal(classifyVideoLink('http://example.com/v').kind, 'direct');
  assert.match(classifyVideoLink('https://www.youtube.com/watch?v=1').error, /YouTube/);
  assert.match(classifyVideoLink('https://youtu.be/1').error, /YouTube/);
  assert.match(classifyVideoLink('https://vimeo.com/1').error, /YouTube/);
  assert.match(classifyVideoLink('https://wetransfer.com/downloads/1').error, /Dropbox/);
  assert.match(classifyVideoLink('').error, /貼上/);
  assert.match(classifyVideoLink('影片').error, /網址/);
  assert.match(classifyVideoLink('ftp://x.com/a.mp4').error, /https/);
  assert.match(classifyVideoLink('http://localhost:8787/a.mp4').error, /內部/);
  assert.match(classifyVideoLink('http://192.168.1.5/a.mp4').error, /內部/);
  assert.match(classifyVideoLink('https://proxy.haimiaan.com/r2/x.mp4', { selfHosts: ['proxy.haimiaan.com'] }).error, /內部/);
  assert.equal(classifyVideoLink('https://user:pw@example.com/a.mp4').ok, false);
});

test('擋內部網路位址', () => {
  for (const h of ['localhost', 'a.localhost', 'x.local', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '[::1]', 'fe80::1']) {
    assert.equal(isBlockedHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'drive.google.com']) {
    assert.equal(isBlockedHost(h), false, h);
  }
});

test('試抓結果：大小、能不能分段、格式', () => {
  const ok = interpretProbe({
    status: 206, kind: 'direct', filenameHint: 'a.mp4',
    headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/123456' },
  });
  assert.deepEqual(ok, { ok: true, size: 123456, rangeSupported: true, mime: 'video/mp4', filename: 'a.mp4' });
  const single = interpretProbe({ status: 200, kind: 'dropbox', headers: { 'content-type': 'application/binary', 'content-length': '999', 'content-disposition': 'attachment; filename="S01 x.MOV"' } });
  assert.equal(single.ok, true);
  assert.equal(single.rangeSupported, false);
  assert.equal(single.mime, 'video/quicktime');
  assert.equal(single.filename, 'S01 x.MOV');
  // Drive API 先給了類型和大小
  const drive = interpretProbe({ status: 206, kind: 'drive', knownMime: 'video/mp4', knownSize: 50, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-0/50' } });
  assert.equal(drive.mime, 'video/mp4');
  assert.match(interpretProbe({ status: 200, kind: 'onedrive', headers: { 'content-type': 'text/html; charset=utf-8' } }).error, /OneDrive/);
  assert.match(interpretProbe({ status: 200, kind: 'drive', headers: { 'content-type': 'text/html' } }).error, /公開/);
  assert.match(interpretProbe({ status: 403, kind: 'drive', headers: {} }).error, /Google 帳號/);
  assert.match(interpretProbe({ status: 404, kind: 'direct', headers: {} }).error, /找不到/);
  assert.match(interpretProbe({ status: 500, kind: 'direct', headers: {} }).error, /HTTP 500/);
  assert.match(interpretProbe({ status: 200, kind: 'direct', headers: { 'content-type': 'image/jpeg', 'content-length': '5' } }).error, /image\/jpeg/);
  assert.match(interpretProbe({ status: 200, kind: 'direct', filenameHint: 'a.mkv', headers: { 'content-type': 'video/x-matroska', 'content-length': '5' } }).error, /\.mkv/);
  assert.match(interpretProbe({ status: 200, kind: 'direct', filenameHint: 'a.mp4', headers: { 'content-type': 'video/mp4' } }).error, /多大/);
  const big = interpretProbe({ status: 206, kind: 'direct', filenameHint: 'a.mp4', maxBytes: 100, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/101' } });
  assert.equal(big.ok, false);
  assert.equal(big.status, 413);
  assert.match(big.error, /太大/);
});

test('Content-Disposition 檔名、Content-Range 總長', () => {
  assert.equal(filenameFromContentDisposition(`attachment; filename*=UTF-8''S01_%E9%96%8B%E5%A0%B4.mp4`), 'S01_開場.mp4');
  assert.equal(filenameFromContentDisposition('inline; filename="a b.mov"'), 'a b.mov');
  assert.equal(filenameFromContentDisposition('attachment; filename=a.mp4'), 'a.mp4');
  assert.equal(filenameFromContentDisposition(null), '');
  assert.equal(totalFromContentRange('bytes 0-0/1234'), 1234);
  assert.equal(totalFromContentRange('bytes */1234'), 1234);
  assert.equal(totalFromContentRange('bytes 0-0/*'), null);
});

// ─── 播放 ───

test('播放通行證：同一段時間網址一樣；換影片、換人、過期、亂改都不行', async () => {
  const secret = 's3cret';
  const now = 1_700_000_000_000;
  const t = await signVideoPass(secret, { videoId: 'sv_1', userId: 'u_a', now });
  assert.equal(await signVideoPass(secret, { videoId: 'sv_1', userId: 'u_a', now: now + 1000 }), t, '同一段時間一樣');
  assert.equal(await verifyVideoPass(secret, t, { videoId: 'sv_1', now }), 'u_a');
  assert.equal(await verifyVideoPass(secret, t, { videoId: 'sv_2', now }), null);
  assert.equal(await verifyVideoPass('other', t, { videoId: 'sv_1', now }), null);
  assert.equal(await verifyVideoPass(secret, t, { videoId: 'sv_1', now: now + 3 * VIDEO_PASS_BUCKET_MS }), null, '過期');
  const [exp, , sig] = t.split('.');
  assert.equal(await verifyVideoPass(secret, `${exp}.u_b.${sig}`, { videoId: 'sv_1', now }), null, '換人');
  assert.equal(await verifyVideoPass(secret, `${Number(exp) + 1}.u_a.${sig}`, { videoId: 'sv_1', now }), null);
  assert.equal(await verifyVideoPass(secret, 'garbage', { videoId: 'sv_1', now }), null);
  assert.equal(await verifyVideoPass(secret, '', { videoId: 'sv_1', now }), null);
  // 至少還有 6 小時
  assert.ok(Number(exp) - now >= VIDEO_PASS_BUCKET_MS);
});

test('播放的 Range header', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=100-', 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRangeHeader('bytes=900-5000', 1000), { start: 900, end: 999 }, '結尾超過 → 截到最後');
  assert.deepEqual(parseRangeHeader('bytes=-50', 1000), { start: 950, end: 999 });
  assert.deepEqual(parseRangeHeader('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRangeHeader('BYTES = 0 - 0', 1000), { start: 0, end: 0 });
  assert.equal(parseRangeHeader('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRangeHeader('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRangeHeader('bytes=5-1', 1000), null, '看不懂 → 忽略');
  assert.equal(parseRangeHeader('bytes=0-1,5-6', 1000), null, '多段 → 忽略');
  assert.equal(parseRangeHeader('items=0-1', 1000), null);
  assert.equal(parseRangeHeader('bytes=-', 1000), null);
  assert.equal(parseRangeHeader(null, 1000), null);
});
