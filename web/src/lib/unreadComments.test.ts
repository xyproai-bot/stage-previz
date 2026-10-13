import { describe, it, expect } from 'vitest';
import type { SongComment } from './api';
import { newFromOthersSince, songsToFetch, unreadFromSummary, type SummaryLike } from './unreadComments';

const me = { id: 'u_me', name: '我' };

function c(id: string, createdAt: string, authorUserId = 'u_dir'): SongComment {
  return {
    id, text: id, time: 0, author: authorUserId === me.id ? '我' : '導演', authorUserId, role: 'director', createdAt,
  } as SongComment;
}

function sum(songId: string, over: Partial<SummaryLike> = {}): SummaryLike {
  return { songId, count: 0, openCount: 0, latestAt: null, fromOthersCount: 0, latestFromOthersAt: null, ...over };
}

describe('用留言摘要算未讀', () => {
  it('從沒看過 → 別人留的都算（不用抓留言）', () => {
    expect(unreadFromSummary(sum('s1', { count: 5, fromOthersCount: 3 }), null, undefined, me)).toBe(3);
  });

  it('別人最新一則沒有比上次看的新 → 0', () => {
    const s = sum('s1', { count: 2, fromOthersCount: 2, latestFromOthersAt: '2026-10-14T01:00:00.000Z' });
    expect(unreadFromSummary(s, '2026-10-14T01:00:00.000Z', undefined, me)).toBe(0);
    expect(unreadFromSummary(sum('s1'), '2026-10-14T01:00:00.000Z', undefined, me)).toBe(0);
  });

  it('比較新 → 用抓到的留言算準的；還沒抓到先算 1', () => {
    const s = sum('s1', { count: 3, fromOthersCount: 3, latestFromOthersAt: '2026-10-14T03:00:00.000Z' });
    const seen = '2026-10-14T01:00:00.000Z';
    expect(unreadFromSummary(s, seen, undefined, me)).toBe(1);
    const list = [c('a', '2026-10-14T00:00:00.000Z'), c('b', '2026-10-14T02:00:00.000Z'), c('m', '2026-10-14T02:30:00.000Z', me.id), c('d', '2026-10-14T03:00:00.000Z')];
    expect(unreadFromSummary(s, seen, list, me)).toBe(2);
    // 抓到的是舊的（新留言還沒進來）→ 至少 1
    expect(unreadFromSummary(s, seen, [c('a', '2026-10-14T00:00:00.000Z')], me)).toBe(1);
  });

  it('沒有摘要（舊版後台）→ 照舊用留言算', () => {
    expect(unreadFromSummary(undefined, null, [c('a', '2026-10-14T00:00:00.000Z')], me)).toBe(1);
    expect(unreadFromSummary(undefined, null, undefined, me)).toBe(0);
  });
});

describe('這次要抓哪幾首歌的留言', () => {
  const seen: Record<string, string | null> = { s1: '2026-10-14T01:00:00.000Z', s2: '2026-10-14T01:00:00.000Z', s3: null };
  const lastSeenFor = (id: string) => seen[id] ?? null;

  it('第一次：只抓有新留言、看過的歌 + 正在看的那首；沒看過的用摘要的數字就好', () => {
    const curr = [
      sum('s1', { count: 1, latestAt: '2026-10-14T02:00:00.000Z', fromOthersCount: 1, latestFromOthersAt: '2026-10-14T02:00:00.000Z' }),
      sum('s2', { count: 1, latestAt: '2026-10-14T00:30:00.000Z', fromOthersCount: 1, latestFromOthersAt: '2026-10-14T00:30:00.000Z' }),
      sum('s3', { count: 4, latestAt: '2026-10-14T02:00:00.000Z', fromOthersCount: 4, latestFromOthersAt: '2026-10-14T02:00:00.000Z' }),
      sum('s4'),
    ];
    expect(songsToFetch(curr, null, lastSeenFor, () => false, 's4')).toEqual(['s1', 's4']);
  });

  it('之後：摘要沒變、已經抓過的不再抓；多了別人的新留言 → 抓（要跳提示）', () => {
    const prevList = [
      sum('s1', { count: 1, latestAt: '2026-10-14T02:00:00.000Z', fromOthersCount: 1, latestFromOthersAt: '2026-10-14T02:00:00.000Z' }),
      sum('s2', { count: 1, latestAt: '2026-10-14T00:30:00.000Z', fromOthersCount: 1, latestFromOthersAt: '2026-10-14T00:30:00.000Z' }),
    ];
    const prev = new Map(prevList.map(s => [s.songId, s]));
    const curr = [
      prevList[0],
      sum('s2', { count: 2, latestAt: '2026-10-14T04:00:00.000Z', fromOthersCount: 2, latestFromOthersAt: '2026-10-14T04:00:00.000Z' }),
    ];
    expect(songsToFetch(curr, prev, lastSeenFor, () => true, null)).toEqual(['s2']);
  });

  it('自己留的言（別人的沒變）不用為了提示去抓', () => {
    const p = sum('s2', { count: 1, latestAt: '2026-10-14T00:30:00.000Z', fromOthersCount: 1, latestFromOthersAt: '2026-10-14T00:30:00.000Z' });
    const curr = [{ ...p, count: 2, latestAt: '2026-10-14T05:00:00.000Z' }];
    expect(songsToFetch(curr, new Map([[p.songId, p]]), lastSeenFor, () => true, null)).toEqual([]);
  });

  it('提示：上次摘要之後別人新留的，舊的在前', () => {
    const list = [c('old', '2026-10-14T01:00:00.000Z'), c('mine', '2026-10-14T05:00:00.000Z', me.id), c('n2', '2026-10-14T04:00:00.000Z'), c('n1', '2026-10-14T03:00:00.000Z')];
    expect(newFromOthersSince(list, '2026-10-14T02:00:00.000Z', me).map(x => x.id)).toEqual(['n1', 'n2']);
  });
});
