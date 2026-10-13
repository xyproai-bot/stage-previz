import { describe, expect, it } from 'vitest';
import type { SongComment } from './api';
import {
  buildThreads, defaultScope, scopeThreads, versionChip, resolvedLabel, filterAndSortThreads, threadRootId,
  visibleInScope, canPostComment, canResolveComment, canReopenComment,
} from './commentThreads';

let n = 0;
function c(p: Partial<SongComment> = {}): SongComment {
  n++;
  return {
    id: `c${n}`, time: 0, x: 0.5, y: 0.5, text: `留言 ${n}`, author: '王小明', email: null, role: 'director',
    createdAt: `2026-10-14T07:00:${String(n).padStart(2, '0')}.000Z`, status: 'open', ...p,
  };
}

describe('buildThreads（一層回覆）', () => {
  it('回覆掛在那一則底下（舊的在前），被刪的那則的回覆變成一般留言', () => {
    const a = c({ id: 'a' });
    const r2 = c({ id: 'r2', parentId: 'a', createdAt: '2026-10-14T08:00:02.000Z' });
    const r1 = c({ id: 'r1', parentId: 'a', createdAt: '2026-10-14T08:00:01.000Z' });
    const orphan = c({ id: 'o', parentId: 'gone' });
    const t = buildThreads([a, r2, r1, orphan]);
    expect(t.map(x => x.root.id)).toEqual(['a', 'o']);
    expect(t[0].replies.map(x => x.id)).toEqual(['r1', 'r2']);
  });
  it('回覆的回覆（舊資料）也掛在最上面那則', () => {
    const a = c({ id: 'a' });
    const r = c({ id: 'r', parentId: 'a' });
    const rr = c({ id: 'rr', parentId: 'r' });
    const t = buildThreads([a, r, rr]);
    expect(t).toHaveLength(1);
    expect(t[0].replies.map(x => x.id)).toEqual(['r', 'rr']);
  });
});

describe('「這一版 / 全部」', () => {
  const v1 = c({ id: 'v1open', videoVersion: 1, videoId: 'sv1' });
  const v1fixedIn2 = c({ id: 'v1fix2', videoVersion: 1, status: 'resolved', resolvedVersion: 2 });
  const v1fixedIn3 = c({ id: 'v1fix3', videoVersion: 1, status: 'resolved', resolvedVersion: 3 });
  const v1fixedIn1 = c({ id: 'v1fix1', videoVersion: 1, status: 'resolved', resolvedVersion: 1 });
  const v2 = c({ id: 'v2open', videoVersion: 2, videoId: 'sv2' });
  const v2done = c({ id: 'v2done', videoVersion: 2, status: 'resolved', resolvedVersion: 2 });
  const legacy = c({ id: 'legacy' });
  const legacyResolvedOld = c({ id: 'v1legacyfix', videoVersion: 1, status: 'resolved' });
  const all = [v1, v1fixedIn2, v1fixedIn3, v1fixedIn1, v2, v2done, legacy, legacyResolvedOld];
  const threads = buildThreads(all);
  const show = (version: number) => Object.fromEntries(
    scopeThreads(threads, 'version', { id: `sv${version}`, version }).map(t => [t.root.id, t.greyed ? 'grey' : t.carried ? 'carried' : 'here']),
  );

  it('有版本預設「這一版」，沒有就「全部」', () => {
    expect(defaultScope(true)).toBe('version');
    expect(defaultScope(false)).toBe('all');
  });

  it('看 V1：只有 V1 的留言；之後才改好的照常出現，V1 就改好的灰掉；舊留言、V2 的不出現', () => {
    expect(show(1)).toEqual({ v1open: 'here', v1fix2: 'here', v1fix3: 'here', v1fix1: 'grey', v1legacyfix: 'grey' });
  });

  it('看 V2：V2 的留言 + V1 還沒改好的帶過來 + 在 V2 改好的灰掉；更早改好的不出現', () => {
    expect(show(2)).toEqual({ v1open: 'carried', v1fix2: 'grey', v1fix3: 'carried', v2open: 'here', v2done: 'grey' });
  });

  it('看 V3：在 V2 改好的不再出現（不會越積越多）', () => {
    const s = show(3);
    expect(s.v1fix2).toBeUndefined();
    expect(s.v2done).toBeUndefined();
    expect(s.v1fix3).toBe('grey');
    expect(s.v1open).toBe('carried');
    expect(s.v2open).toBe('carried');
  });

  it('「全部」：每則都出現，已解決的灰掉；舊的 Drive 影片（沒有版本號）也當全部', () => {
    const scoped = scopeThreads(threads, 'all', { id: 'sv2', version: 2 });
    expect(scoped).toHaveLength(all.length);
    expect(scoped.find(t => t.root.id === 'v2done')!.greyed).toBe(true);
    expect(scoped.find(t => t.root.id === 'legacy')!.greyed).toBe(false);
    expect(scopeThreads(threads, 'version', null)).toHaveLength(all.length);
  });

  it('通知點進來的留言在「這一版」看不到 → 要切到「全部」', () => {
    expect(visibleInScope(all, 'legacy', 'version', { id: 'sv2', version: 2 })).toBe(false);
    expect(visibleInScope(all, 'legacy', 'all', { id: 'sv2', version: 2 })).toBe(true);
    expect(visibleInScope(all, 'v2open', 'version', { id: 'sv2', version: 2 })).toBe(true);
    expect(visibleInScope(all, 'nope', 'all', null)).toBe(false);
  });
});

describe('標籤', () => {
  it('V2 小標籤；舊留言沒有', () => {
    expect(versionChip({ videoVersion: 2 })).toBe('V2');
    expect(versionChip({})).toBeNull();
  });
  it('已改好（V3）；舊資料沒有版本 → 已改好；沒解決 → null', () => {
    expect(resolvedLabel({ status: 'resolved', resolvedVersion: 3 })).toBe('已改好（V3）');
    expect(resolvedLabel({ status: 'resolved' })).toBe('已改好');
    expect(resolvedLabel({ status: 'open', resolvedVersion: 3 })).toBeNull();
  });
});

describe('篩選 / 排序 / 找串', () => {
  it('最新優先看整串最新的一則（有新回覆的串排前面）；角色看整串', () => {
    const old = c({ id: 'old', createdAt: '2026-10-14T01:00:00.000Z' });
    const reply = c({ id: 'rep', parentId: 'old', role: 'animator', createdAt: '2026-10-14T09:00:00.000Z' });
    const mid = c({ id: 'mid', createdAt: '2026-10-14T05:00:00.000Z', status: 'resolved' });
    const t = buildThreads([old, reply, mid]).map(x => ({ ...x, greyed: false, carried: false }));
    expect(filterAndSortThreads(t, { sort: 'newest' }).map(x => x.root.id)).toEqual(['old', 'mid']);
    expect(filterAndSortThreads(t, { sort: 'oldest' }).map(x => x.root.id)).toEqual(['old', 'mid']);
    expect(filterAndSortThreads(t, { status: 'resolved' }).map(x => x.root.id)).toEqual(['mid']);
    expect(filterAndSortThreads(t, { role: 'animator' }).map(x => x.root.id)).toEqual(['old']);
    expect(threadRootId([old, reply, mid], 'rep')).toBe('old');
    expect(threadRootId([old, reply, mid], 'mid')).toBe('mid');
    expect(threadRootId([old], 'x')).toBeNull();
  });
});

describe('誰能做什麼（跟後台 access.mjs 一樣）', () => {
  const mine = { animatorUserId: 'u_a1' };
  const open = { animatorUserId: null };
  it('留言 / 回覆：導演、製作都可以；動畫師只能自己的或沒指派的', () => {
    expect(canPostComment({ role: 'director', userId: 'u_d', song: mine })).toBe(true);
    expect(canPostComment({ role: 'admin', userId: 'u_x', song: mine })).toBe(true);
    expect(canPostComment({ role: 'animator', userId: 'u_a1', song: mine })).toBe(true);
    expect(canPostComment({ role: 'animator', userId: 'u_a2', song: mine })).toBe(false);
    expect(canPostComment({ role: 'animator', userId: 'u_a2', song: open })).toBe(true);
    expect(canPostComment({ role: null, userId: 'u_a2', song: open })).toBe(false);
  });
  it('已改好：負責的動畫師、製作、留言的人自己；導演不行但可以重新打開', () => {
    const byDir = { authorUserId: 'u_d' };
    expect(canResolveComment(byDir, { role: 'animator', userId: 'u_a1', song: mine })).toBe(true);
    expect(canResolveComment(byDir, { role: 'animator', userId: 'u_a2', song: mine })).toBe(false);
    expect(canResolveComment(byDir, { role: 'director', userId: 'u_d2', song: mine })).toBe(false);
    // 導演自己的留言也不出現「已改好」（改好了沒有由動畫師說）
    expect(canResolveComment(byDir, { role: 'director', userId: 'u_d', song: mine })).toBe(false);
    expect(canResolveComment({ authorUserId: 'u_a2' }, { role: 'animator', userId: 'u_a2', song: mine })).toBe(true);
    expect(canReopenComment(byDir, { role: 'director', userId: 'u_d2', song: mine })).toBe(true);
    expect(canReopenComment(byDir, { role: 'animator', userId: 'u_a2', song: mine })).toBe(false);
  });
});
