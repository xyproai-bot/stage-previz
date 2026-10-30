// 示範專案的內容：歌、cue、機關、影片版本、音樂、導演的留言。全部呼叫本機後台 API。
//
//   S01 開場     V1（熱色）、V2（冷色）；導演對 V1 按了「需修改」，另有一則有 3D 視角、有畫記的留言
//   S02 主題曲   V1；還沒提交（提交審查那段用）
//   S03 抒情     V1；加影片那段用
//   S04 間奏     沒影片、有音樂；有 cue 和升降台機關
//   S05 安可     沒影片、沒音樂；LED 顯示測試圖、本地檔案那段用
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { API_BASE, api, d1Exec, log, probe } from './lib.mjs';
import { MEDIA_DIR, makeLedAnimation, makeMusic } from './media.mjs';
import { ledRects } from './uvRects.mjs';

/** 一首歌的設定 */
export const SONGS = [
  {
    key: 's01', code: 'S01', name: '開場', crossfade: 2,
    cues: [['開場', 0], ['升降台升起', 4], ['副歌全開', 8], ['收尾', 13]],
    lift: { 1: 2.5, 3: 0 },   // 第幾個 cue（從 0 算）→ 升降台的位置（公尺）
  },
  { key: 's02', code: 'S02', name: '主題曲', crossfade: 2, cues: [['前奏', 0], ['主歌', 5], ['副歌', 10]], lift: { 2: 2.5 } },
  { key: 's03', code: 'S03', name: '抒情', crossfade: 2, cues: [['前奏', 0], ['間奏', 6], ['結尾', 12]], lift: {} },
  {
    key: 's04', code: 'S04', name: '間奏', crossfade: 2,
    cues: [['前奏', 0], ['主歌', 8], ['副歌 升降台升起', 16], ['尾奏 升降台收回', 30]],
    lift: { 2: 2.5, 3: 0 },
  },
  { key: 's05', code: 'S05', name: '安可', crossfade: 2, cues: [['開始', 0], ['中段', 10], ['結束', 20]], lift: {} },
  // 沒指派給示範動畫師：「全部」看得到、「我的」看不到
  { key: 's06', code: 'S06', name: '謝幕', crossfade: 2, cues: [], lift: {}, unassigned: true },
];

export const MEDIA_FILES = {
  s01v1: 'S01_開場_V1.mp4', s01v2: 'S01_開場_V2.mp4', s02v1: 'S02_主題曲_V1.mp4', s03v1: 'S03_抒情_V1.mp4',
  s03v2: 'S03_抒情_V2.mp4',          // 「加影片」要傳的那一支
  local: '我的動畫.mp4',            // 「本地檔案」要拖進去的那一支
  music: 'S04_間奏.mp3',
};
export const mediaPath = (k) => join(MEDIA_DIR, MEDIA_FILES[k]);

/** 取得目前使用中的模型（貼好 UV 的）→ 每片 LED 的位置 */
export async function loadLedRects(token, projectId, canvas) {
  const m = await api(token, 'GET', `/api/projects/${projectId}/model`);
  const r = await fetch(API_BASE + '/r2/' + m.model.key);
  const glb = Buffer.from(await r.arrayBuffer());
  return ledRects(glb, canvas);
}

export function generateMedia(canvas, rects) {
  const spec = [
    ['s01v1', 'warm', 1], ['s01v2', 'cool', 2], ['s02v1', 'green', 3], ['s03v1', 'magenta', 4], ['s03v2', 'cool', 5], ['local', 'rainbow', 6],
  ];
  for (const [k, palette, seed] of spec) {
    makeLedAnimation({ out: mediaPath(k), canvas, rects, palette, seconds: 16, seed });
    const p = probe(mediaPath(k));
    if (p.width !== canvas.width || p.height !== canvas.height) throw new Error(`${MEDIA_FILES[k]} 的大小 ${p.width}×${p.height} 跟 LED 畫布 ${canvas.width}×${canvas.height} 不一樣`);
    log(`  動畫 ${MEDIA_FILES[k]}  ${p.width}×${p.height}  ${p.duration.toFixed(1)} 秒  ${(p.size / 1024 / 1024).toFixed(2)} MB`);
  }
  makeMusic({ out: mediaPath('music'), seconds: 40 });
  log(`  音樂 ${MEDIA_FILES.music}  ${(statSync(mediaPath('music')).size / 1024).toFixed(0)} KB`);
}

// ─── 上傳影片（分段，照 docs/videos-api.md） ───
export async function uploadVideo(token, projectId, songId, file, { title, note } = {}) {
  const p = probe(file);
  const buf = readFileSync(file);
  const { video } = await api(token, 'POST', `/api/projects/${projectId}/songs/${songId}/videos/uploads`, {
    filename: file.split(/[\\/]/).pop(), sizeBytes: buf.length, mime: 'video/mp4', title, note,
    width: p.width, height: p.height, durationSec: Math.round(p.duration * 10) / 10,
  });
  const { partSize, partCount } = video.upload;
  for (let n = 1; n <= partCount; n++) {
    const part = buf.subarray((n - 1) * partSize, Math.min(buf.length, n * partSize));
    await api(token, 'PUT', `/api/projects/${projectId}/songs/${songId}/videos/${video.id}/parts/${n}`, part, { headers: { 'Content-Type': 'application/octet-stream' } });
  }
  const done = await api(token, 'POST', `/api/projects/${projectId}/songs/${songId}/videos/${video.id}/complete`, { width: p.width, height: p.height, durationSec: Math.round(p.duration * 10) / 10 });
  return done.video;
}

/** 升降台機關：升降台 + 它前面那片 LED，直線往上 0～2.5 公尺 */
async function createLift(tok, projectId) {
  const { stageObjects } = await api(tok, 'GET', `/api/projects/${projectId}/stage-objects`);
  const byName = new Map(stageObjects.map(o => [o.meshName, o.id]));
  const ids = ['STAGE_升降台', 'LED_升降台正面'].map(n => {
    const id = byName.get(n);
    if (!id) throw new Error(`模型裡找不到 ${n}`);
    return id;
  });
  const { mechanism } = await api(tok, 'POST', `/api/projects/${projectId}/mechanisms`, {
    name: '中央升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null,
    travelMin: 0, travelMax: 2.5, defaultValue: 0, maxSpeed: 1,
    presets: [{ name: '收起', value: 0 }, { name: '升起', value: 2.5 }],
    objectIds: ids, consoleLabel: 'Axis 1',
  });
  return mechanism;
}

/** 建一首歌（歌、指派動畫師、cue、升降台位置）；回傳 { id, cues } */
export async function createSong(ctx, spec) {
  const { tok, projectId, accounts, lift } = ctx;
  const { id } = await api(tok, 'POST', `/api/projects/${projectId}/songs`, { name: spec.name, code: spec.code });
  if (!spec.unassigned) await api(tok, 'PATCH', `/api/projects/${projectId}/songs/${id}`, { animator_user_id: accounts.animator.id });
  const cues = [];
  for (let i = 0; i < spec.cues.length; i++) {
    const [name, t] = spec.cues[i];
    const { id: cueId } = await api(tok, 'POST', `/api/projects/${projectId}/songs/${id}/cues`, { name, crossfadeSeconds: spec.crossfade });
    await api(tok, 'PATCH', `/api/projects/${projectId}/songs/${id}/cues/${cueId}`, { videoTimeSec: t });
    cues.push({ id: cueId, name, t });
    if (lift && spec.lift[i] !== undefined) {
      await api(tok, 'PUT', `/api/projects/${projectId}/songs/${id}/cues/${cueId}/mechanisms/${lift.id}`, { value: spec.lift[i] });
    }
  }
  return { id, cues, spec };
}

/** 導演在 V1 留的一則有 3D 視角、有畫記的意見（升降台升起來之後的畫面） */
export const DIRECTOR_COMMENT = {
  text: '升降台升起來以後，前面這片 LED 太亮了，亮度壓低一點。',
  time: 6,
  view: { position: [5.5, 3.2, 13], target: [0, 2.2, -3], fov: 50, aspect: 16 / 9 },
  annotation: {
    v: 1, aspect: 16 / 9, t: 6,
    shapes: [
      { t: 'rect', c: '#ffcc00', w: 0.006, p: [0.41, 0.31, 0.575, 0.51] },
      { t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.8, 0.22, 0.585, 0.4] },
    ],
  },
};

export async function postDirectorComment(dirToken, projectId, songId, { videoId, cueId, thumbnail }) {
  const session = `${projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28)}-${songId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28)}`;
  const c = {
    id: 'c_demo' + Math.random().toString(36).slice(2, 8), text: DIRECTOR_COMMENT.text, time: DIRECTOR_COMMENT.time, x: 0.5, y: 0.5, email: null,
    createdAt: new Date().toISOString(), videoId, view: DIRECTOR_COMMENT.view, annotation: DIRECTOR_COMMENT.annotation,
  };
  if (cueId) c.cueId = cueId;
  if (thumbnail) c.thumbnail = thumbnail;
  const d = await api(dirToken, 'POST', `/api/comments?session=${session}`, { comment: c });
  return d.comments?.find(x => x.id === c.id) || c;
}

export async function seedContent({ accounts, projectId, canvas }) {
  const tok = accounts.producer.token;
  const ani = accounts.animator.token;
  const dir = accounts.director.token;
  log('生示範動畫和音樂…');
  const rects = await loadLedRects(tok, projectId, canvas);
  generateMedia(canvas, rects);

  log('機關、歌、cue…');
  const lift = await createLift(tok, projectId);
  const ctx = { tok, projectId, accounts, lift };
  const songs = {};
  for (const spec of SONGS) songs[spec.key] = await createSong(ctx, spec);

  log('影片版本…');
  const s01v1 = await uploadVideo(ani, projectId, songs.s01.id, mediaPath('s01v1'), { title: 'S01_開場', note: '第一版' });
  const s01v2 = await uploadVideo(ani, projectId, songs.s01.id, mediaPath('s01v2'), { title: 'S01_開場', note: '改成冷色調' });
  await uploadVideo(ani, projectId, songs.s02.id, mediaPath('s02v1'), { title: 'S02_主題曲', note: '第一版' });
  await uploadVideo(ani, projectId, songs.s03.id, mediaPath('s03v1'), { title: 'S03_抒情', note: '第一版' });

  log('導演審 S01 V1…');
  // 動畫師先提交審查，導演對 V1 按「需修改」（V1、V2 都交了，導演看的是 V1）
  await api(ani, 'PATCH', `/api/projects/${projectId}/songs/${songs.s01.id}`, { status: 'in_review', expectedStatus: 'todo' });
  await api(dir, 'PATCH', `/api/projects/${projectId}/songs/${songs.s01.id}`, {
    status: 'needs_changes', expectedStatus: 'in_review', reviewVideoId: s01v1.id,
    reason: '整體顏色太熱了，改成冷色調；升降台升起那段，亮度壓低一點。',
  });

  // 導演在 V1 的 0:06 留一則有 3D 視角、有畫記的意見（升降台升起來以後）
  await postDirectorComment(dir, projectId, songs.s01.id, { videoId: s01v1.id, cueId: songs.s01.cues[1].id });

  log('音樂…');
  const music = readFileSync(mediaPath('music'));
  await api(tok, 'PUT', `/api/projects/${projectId}/songs/${songs.s04.id}/music?filename=${encodeURIComponent(MEDIA_FILES.music)}&durationSec=40`, music, { headers: { 'Content-Type': 'audio/mpeg' } });

  await markNotificationsRead(ani);
  return { songs, s01v1, s01v2, lift, rects };
}

// ─── 每段短片錄之前，把會被改到的資料還原 ───

const sessionOf = (projectId, songId) => `${projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28)}-${songId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28)}`;

export async function markNotificationsRead(token) {
  await api(token, 'POST', '/api/notifications/read', { all: true });
}

/** 留言：回覆刪掉、「已改好」改回未解決 */
export async function resetComments(tokens, projectId, songId) {
  const session = sessionOf(projectId, songId);
  const d = await api(tokens.producer, 'GET', `/api/comments?session=${session}`);
  for (const c of d.comments || []) {
    if (c.parentId || c.role === 'animator') {
      await api(tokens.producer, 'DELETE', `/api/comments?session=${session}&id=${encodeURIComponent(c.id)}`).catch(() => {});
    } else if (c.status === 'resolved') {
      await api(tokens.producer, 'PATCH', `/api/comments?session=${session}`, { id: c.id, status: 'open' }).catch(() => {});
    }
  }
}

/** 還沒提交審查的樣子（S02） */
export async function resetSubmitReview(tokens, projectId, songId) {
  const song = await api(tokens.producer, 'GET', `/api/projects/${projectId}/songs/${songId}`);
  if (song.song?.status && song.song.status !== 'todo') {
    d1Exec(`UPDATE songs SET status = 'todo' WHERE id = '${songId}';`);
  }
  await resetComments(tokens, projectId, songId);
}

/** 只有 V1 的樣子（S03）：加影片錄完以後把新的版本拿掉，下一版又是 V2 */
export function resetAddVideo(songId) {
  d1Exec(`DELETE FROM song_videos WHERE song_id = '${songId}' AND version > 1; DELETE FROM song_videos WHERE song_id = '${songId}' AND version IS NULL; UPDATE songs SET video_version_seq = 1 WHERE id = '${songId}';`);
}
