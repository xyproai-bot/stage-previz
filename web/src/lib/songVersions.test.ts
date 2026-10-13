import { describe, it, expect } from 'vitest';
import {
  canAddVideo, canModifyVideo, choiceFor, deleteVersionMessage, itemFromShareVideo, itemFromVideo,
  itemsFromLegacyDrive, pendingVideos, pickVersion, readVersionChoice, readyItems, versionChoiceStorageKey,
  writeVersionChoice, type VersionItem,
} from './songVersions';
import type { SongVideo } from './videoApi';

const abs = (u: string) => 'https://api.test' + u;

function video(over: Partial<SongVideo> = {}): SongVideo {
  return {
    id: 'sv_1', projectId: 'p1', songId: 's1', version: 1, label: 'V1', title: 'S01_開場', note: '', source: 'upload',
    originalUrl: null, driveFileId: null, mime: 'video/mp4', sizeBytes: 10, width: null, height: null, durationSec: null,
    status: 'ready', error: null, progress: null, createdBy: { id: 'u_a', name: '小明' }, createdAt: '2026-10-14T01:00:00.000Z',
    updatedAt: '', readyAt: '2026-10-14T01:05:00.000Z', isLatest: false, streamUrl: '/api/videos/sv_1/stream?pass=x', ...over,
  };
}

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}

describe('排順序', () => {
  it('看版本號由大到小，不看修改時間', () => {
    const items = [
      // V1 最後才改過標題（updatedAt 最新）也不能跑到前面
      video({ id: 'a', version: 1, label: 'V1', updatedAt: '2026-10-20T00:00:00Z', readyAt: '2026-10-20T00:00:00Z' }),
      video({ id: 'c', version: 3, label: 'V3', readyAt: '2026-10-01T00:00:00Z' }),
      video({ id: 'b', version: 2, label: 'V2' }),
    ].map(v => itemFromVideo(v, abs));
    expect(readyItems(items).map(i => i.label)).toEqual(['V3', 'V2', 'V1']);
  });

  it('還沒好的不算可以播；上傳中 / 複製中 / 失敗的另外列，新的在前', () => {
    const vids = [
      video({ id: 'r', version: 1 }),
      video({ id: 'u', version: null, label: '', status: 'uploading', streamUrl: null, createdAt: '2026-10-14T02:00:00Z' }),
      video({ id: 'p', version: null, label: '', status: 'processing', streamUrl: null, createdAt: '2026-10-14T03:00:00Z' }),
      video({ id: 'f', version: null, label: '', status: 'failed', streamUrl: null, createdAt: '2026-10-14T01:00:00Z' }),
    ];
    expect(readyItems(vids.map(v => itemFromVideo(v, abs))).map(i => i.id)).toEqual(['r']);
    expect(pendingVideos(vids).map(v => v.id)).toEqual(['p', 'u', 'f']);
  });

  it('成員版本：網址接上後台、記下誰交的；Drive 同步寫「Drive 同步」', () => {
    const it1 = itemFromVideo(video({ note: '修了第二段的轉場' }), abs);
    expect(it1.url).toBe('https://api.test/api/videos/sv_1/stream?pass=x');
    expect(it1.by).toBe('小明');
    expect(it1.byId).toBe('u_a');
    expect(it1.note).toBe('修了第二段的轉場');
    expect(it1.crossOrigin).toBe('anonymous');
    expect(itemFromVideo(video({ createdBy: null, source: 'drive' }), abs).by).toBe('Drive 同步');
    expect(itemFromVideo(video({ status: 'processing', streamUrl: null }), abs).url).toBeNull();
  });

  it('分享連結的最新版：沒有說明、誰交的', () => {
    const it1 = itemFromShareVideo({
      id: 'sv_9', songId: 's1', version: 4, label: 'V4', title: 't', mime: 'video/mp4', sizeBytes: 1, width: null, height: null,
      durationSec: null, createdAt: '2026-10-14T00:00:00Z', readyAt: null, streamUrl: '/api/share/x/song-videos/sv_9/stream',
    }, abs);
    expect(it1).toMatchObject({ key: 'v:sv_9', label: 'V4', by: null, note: '', status: 'ready' });
    expect(it1.url).toBe('https://api.test/api/share/x/song-videos/sv_9/stream');
  });

  it('舊的 Drive 影片：新的在前，標 Drive 最新 / Drive 舊版 N', () => {
    const items = itemsFromLegacyDrive([
      { driveFileId: 'old', filename: 'S01_v1.mp4', modifiedTime: '2026-10-01T00:00:00Z', url: 'u1', crossOrigin: 'use-credentials' },
      { driveFileId: 'new', filename: 'S01_v2.mp4', modifiedTime: '2026-10-05T00:00:00Z', url: 'u2', crossOrigin: 'use-credentials' },
    ]);
    expect(items.map(i => [i.id, i.label])).toEqual([['new', 'Drive 最新'], ['old', 'Drive 舊版 1']]);
    expect(items[0].crossOrigin).toBe('use-credentials');
    expect(readyItems(items).map(i => i.id)).toEqual(['new', 'old']);
  });
});

describe('要播哪一版', () => {
  const ready = readyItems([
    video({ id: 'v1', version: 1, label: 'V1' }),
    video({ id: 'v2', version: 2, label: 'V2' }),
  ].map(v => itemFromVideo(v, abs)));

  it('預設最新的', () => {
    expect(pickVersion(ready, null)?.label).toBe('V2');
    expect(pickVersion([], null)).toBeNull();
  });

  it('記住的那版還在、沒有更新的版本 → 那版', () => {
    expect(pickVersion(ready, { key: 'v:v1', latestKey: 'v:v2' })?.label).toBe('V1');
  });

  it('記住的那版被刪了 → 最新', () => {
    expect(pickVersion(ready, { key: 'v:gone', latestKey: 'v:v2' })?.label).toBe('V2');
  });

  it('選了 V1 之後又交了 V3 → 自動看 V3（不會一直停在舊版）', () => {
    const withV3 = readyItems([...ready, itemFromVideo(video({ id: 'v3', version: 3, label: 'V3' }), abs)]);
    expect(pickVersion(withV3, { key: 'v:v1', latestKey: 'v:v2' })?.label).toBe('V3');
  });

  it('選最新的 = 不用記；選舊的記下當時最新的是哪版', () => {
    expect(choiceFor(ready, 'v:v2')).toBeNull();
    expect(choiceFor(ready, 'v:v1')).toEqual({ key: 'v:v1', latestKey: 'v:v2' });
  });

  it('存在 localStorage：每個人、每個專案、每首歌分開；壞掉的資料當沒記', () => {
    const s = memStorage();
    const k = versionChoiceStorageKey('u_a', 'p1', 's1');
    expect(k).toBe('sp_song_version:u_a:p1:s1');
    expect(readVersionChoice(k, s)).toBeNull();
    writeVersionChoice(k, { key: 'v:v1', latestKey: 'v:v2' }, s);
    expect(readVersionChoice(k, s)).toEqual({ key: 'v:v1', latestKey: 'v:v2' });
    expect(readVersionChoice(versionChoiceStorageKey('u_b', 'p1', 's1'), s)).toBeNull();
    writeVersionChoice(k, null, s);
    expect(readVersionChoice(k, s)).toBeNull();
    s.setItem(k, '{not json');
    expect(readVersionChoice(k, s)).toBeNull();
    s.setItem(k, JSON.stringify({ key: 5 }));
    expect(readVersionChoice(k, s)).toBeNull();
  });

  it('localStorage 不能用（私密瀏覽、丟錯）也不會壞', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(readVersionChoice('k', broken)).toBeNull();
    expect(() => writeVersionChoice('k', { key: 'v:a', latestKey: null }, broken)).not.toThrow();
    expect(readVersionChoice('k', null)).toBeNull();
  });
});

describe('誰能加 / 刪影片（跟後台一樣）', () => {
  const unassigned = { animatorUserId: null };
  const mine = { animatorUserId: 'u_a' };
  const other = { animatorUserId: 'u_b' };

  it('admin 都可以（全站 admin 或專案 admin）', () => {
    expect(canAddVideo({ projectRole: 'admin', userId: 'u_x', song: other })).toBe(true);
    expect(canAddVideo({ accountRole: 'admin', projectRole: 'director', userId: 'u_x', song: other })).toBe(true);
  });

  it('動畫師：自己的歌、還沒指派的歌可以；指派給別人的不行', () => {
    expect(canAddVideo({ projectRole: 'animator', userId: 'u_a', song: mine })).toBe(true);
    expect(canAddVideo({ projectRole: 'animator', userId: 'u_a', song: unassigned })).toBe(true);
    expect(canAddVideo({ projectRole: 'animator', userId: 'u_a', song: other })).toBe(false);
  });

  it('導演只能看；不是成員 / 沒登入 / 沒歌不行', () => {
    expect(canAddVideo({ projectRole: 'director', userId: 'u_d', song: unassigned })).toBe(false);
    expect(canAddVideo({ projectRole: null, userId: 'u_d', song: unassigned })).toBe(false);
    expect(canAddVideo({ projectRole: 'animator', userId: null, song: unassigned })).toBe(false);
    expect(canAddVideo({ projectRole: 'animator', userId: 'u_a', song: null })).toBe(false);
  });

  it('刪：admin，或交這一版的人；舊的 Drive 影片不能刪', () => {
    const byA: Pick<VersionItem, 'kind' | 'byId'> = { kind: 'version', byId: 'u_a' };
    expect(canModifyVideo({ projectRole: 'animator', userId: 'u_a', song: mine, item: byA })).toBe(true);
    expect(canModifyVideo({ projectRole: 'animator', userId: 'u_c', song: unassigned, item: byA })).toBe(false);
    expect(canModifyVideo({ projectRole: 'admin', userId: 'u_x', song: mine, item: byA })).toBe(true);
    expect(canModifyVideo({ projectRole: 'director', userId: 'u_a', song: mine, item: byA })).toBe(false);
    // 交的人後來歌被指派給別人 → 也不能刪了（跟後台一樣）
    expect(canModifyVideo({ projectRole: 'animator', userId: 'u_a', song: other, item: byA })).toBe(false);
    expect(canModifyVideo({ projectRole: 'admin', userId: 'u_x', song: mine, item: { kind: 'drive', byId: null } })).toBe(false);
  });

  it('刪除確認講清楚號碼不會再用', () => {
    const msg = deleteVersionMessage({ label: 'V2', title: 'S01_開場' });
    expect(msg).toContain('V2（S01_開場）');
    expect(msg).toContain('V2 這個號碼不會再用');
  });
});
