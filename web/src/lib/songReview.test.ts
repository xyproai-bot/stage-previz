import { describe, it, expect } from 'vitest';
import type { Song, SongComment } from './api';
import {
  songStatusActions, songActionsHint, staleStatusMessage, decisionBarState, unsubmittedVideoLabel, NO_VIDEO_HINT, friendlyError, projectGoneMessage,
  canModifyComment, isOwnComment, sameSongs, sameComments, newCommentsFromOthers,
} from './songReview';

const song = (status: Song['status'], animatorUserId: string | null = null) => ({ status, animatorUserId });
const kinds = (...a: Parameters<typeof songStatusActions>) => songStatusActions(...a).map(x => `${x.kind}->${x.to}`);

describe('songStatusActions（跟後台 access.mjs 規則一樣）', () => {
  it('動畫師：待製作 / 需修改 → 提交；審查中 → 撤回；已通過 → 沒按鈕', () => {
    const base = { role: 'animator' as const, userId: 'u_a', flow: 'animator' as const };
    expect(kinds({ ...base, song: song('todo') })).toEqual(['submit->in_review']);
    expect(kinds({ ...base, song: song('needs_changes') })).toEqual(['resubmit->in_review']);
    expect(kinds({ ...base, song: song('in_review') })).toEqual(['withdraw->todo']);
    expect(kinds({ ...base, song: song('approved') })).toEqual([]);
  });

  it('動畫師：指派給自己可以，指派給別人就沒有按鈕', () => {
    const base = { role: 'animator' as const, userId: 'u_a', flow: 'animator' as const };
    expect(kinds({ ...base, song: song('todo', 'u_a') })).toEqual(['submit->in_review']);
    expect(kinds({ ...base, song: song('todo', 'u_b') })).toEqual([]);
    expect(songActionsHint({ ...base, song: song('todo', 'u_b') })).toContain('其他動畫師');
  });

  it('導演：每個狀態都有通過 / 需修改（隨時可以決定）', () => {
    const base = { role: 'director' as const, userId: 'u_d', flow: 'director' as const };
    for (const st of ['todo', 'in_review', 'needs_changes', 'approved'] as const) {
      expect(kinds({ ...base, song: song(st) })).toEqual(['approve->approved', 'needs_changes->needs_changes']);
    }
    expect(songActionsHint({ ...base, song: song('todo') })).toBeNull();
  });

  it('角色跟頁面對不上 → 沒按鈕（導演開動畫師頁、動畫師開導演頁）', () => {
    expect(kinds({ role: 'director', userId: 'u_d', song: song('todo'), flow: 'animator' })).toEqual([]);
    expect(kinds({ role: 'animator', userId: 'u_a', song: song('in_review'), flow: 'director' })).toEqual([]);
    expect(kinds({ role: 'animator', userId: 'u_a', song: song('in_review', 'u_a'), flow: 'director' })).toEqual([]);
  });

  it('admin：照頁面給那組按鈕，不管指派給誰', () => {
    expect(kinds({ role: 'admin', userId: 'u_x', song: song('todo', 'u_a'), flow: 'animator' })).toEqual(['submit->in_review']);
    expect(kinds({ role: 'admin', userId: 'u_x', song: song('in_review'), flow: 'director' })).toEqual(['approve->approved', 'needs_changes->needs_changes']);
  });

  it('不是成員 → 沒按鈕', () => {
    expect(kinds({ role: null, userId: 'u_a', song: song('todo'), flow: 'animator' })).toEqual([]);
    expect(songActionsHint({ role: null, userId: 'u_a', song: song('todo'), flow: 'animator' })).toContain('不是這個專案的成員');
  });
});

describe('decisionBarState（導演頁的決定列）', () => {
  const v2 = { videoId: 'v2', label: 'V2' };
  const st = (status: Song['status'], lastReview: { status: 'approved' | 'needs_changes'; videoId: string | null } | null = null) => ({ status, animatorUserId: 'u_a', lastReview });
  const texts = (b: ReturnType<typeof decisionBarState>) => b?.buttons.map(x => `${x.text}${x.disabledReason ? '（不能按）' : ''}`);

  it('導演和製作都看得到；動畫師沒有決定列', () => {
    expect(texts(decisionBarState({ role: 'director', userId: 'u_d', song: st('in_review'), judged: v2 }))).toEqual(['通過 V2', '需修改 V2']);
    expect(texts(decisionBarState({ role: 'admin', userId: 'u_x', song: st('in_review'), judged: v2 }))).toEqual(['通過 V2', '需修改 V2']);
    expect(decisionBarState({ role: 'animator', userId: 'u_a', song: st('in_review'), judged: v2 })).toBeNull();
    expect(decisionBarState({ role: null, userId: 'u_a', song: st('in_review'), judged: v2 })?.hint).toContain('不是這個專案的成員');
  });

  it('還沒送審（待製作）也可以決定，說明寫你也可以直接決定', () => {
    const b = decisionBarState({ role: 'director', userId: 'u_d', song: st('todo'), judged: { videoId: 'v1', label: 'V1' } });
    expect(texts(b)).toEqual(['通過 V1', '需修改 V1']);
    expect(b?.hint).toBe('動畫師還沒送審，你也可以直接決定');
    expect(decisionBarState({ role: 'director', userId: 'u_d', song: st('needs_changes'), judged: v2 })?.hint).toContain('你也可以直接決定');
    expect(decisionBarState({ role: 'director', userId: 'u_d', song: st('in_review'), judged: v2 })?.hint).toBeNull();
  });

  it('沒有影片 → 兩顆都按不下去，寫還沒有影片', () => {
    const b = decisionBarState({ role: 'director', userId: 'u_d', song: st('todo'), judged: null });
    expect(texts(b)).toEqual(['通過（不能按）', '需修改（不能按）']);
    expect(b?.buttons.every(x => x.disabledReason === NO_VIDEO_HINT)).toBe(true);
    expect(b?.hint).toBe('還沒有影片，等動畫師交了再決定');
  });

  it('已通過 V2 又在看 V2：通過按不下去、需修改可以（改主意）；看別一版就可以再通過', () => {
    const b = decisionBarState({ role: 'director', userId: 'u_d', song: st('approved', { status: 'approved', videoId: 'v2' }), judged: v2 });
    expect(texts(b)).toEqual(['通過 V2（不能按）', '需修改 V2']);
    expect(b?.buttons[0].disabledReason).toBe('已經是「已通過 V2」了');
    const b3 = decisionBarState({ role: 'director', userId: 'u_d', song: st('approved', { status: 'approved', videoId: 'v2' }), judged: { videoId: 'v3', label: 'V3' } });
    expect(texts(b3)).toEqual(['通過 V3', '需修改 V3']);
    // 需修改 V2 → 通過 V2 可以
    expect(texts(decisionBarState({ role: 'director', userId: 'u_d', song: st('needs_changes', { status: 'needs_changes', videoId: 'v2' }), judged: v2 }))).toEqual(['通過 V2', '需修改 V2（不能按）']);
  });

  it('總覽：待製作已經有影片 →「有影片 V1 · 還沒送審」', () => {
    expect(unsubmittedVideoLabel({ status: 'todo', latestVideoVersion: 1 })).toBe('有影片 V1 · 還沒送審');
    expect(unsubmittedVideoLabel({ status: 'todo', latestVideoVersion: null })).toBeNull();
    expect(unsubmittedVideoLabel({ status: 'in_review', latestVideoVersion: 2 })).toBeNull();
  });
});

describe('staleStatusMessage（409：畫面上的狀態不是最新的）', () => {
  it('被導演改掉 → 講是導演改的', () => {
    expect(staleStatusMessage('needs_changes', 'in_review')).toBe('導演剛剛已經改成「需修改」了，畫面已更新');
    expect(staleStatusMessage('approved', 'in_review')).toBe('導演剛剛已經改成「已通過」了，畫面已更新');
  });
  it('其他狀態 → 一般說法', () => {
    expect(staleStatusMessage('todo', 'in_review')).toContain('撤回');
    expect(staleStatusMessage('in_review', 'todo')).toContain('審查中');
    expect(staleStatusMessage(undefined)).toBe('這首歌的狀態剛剛被別人改了，畫面已更新');
  });
  it('現在的狀態就是我們以為的 → 不是被搶先，回 null（改顯示後台的說明）', () => {
    expect(staleStatusMessage('in_review', 'in_review')).toBeNull();
  });
});

describe('friendlyError', () => {
  const err = (message: string, status?: number) => Object.assign(new Error(message), { status });
  it('中文訊息照用', () => {
    expect(friendlyError(err('這個專案裡找不到這首歌', 404))).toBe('這個專案裡找不到這首歌');
  });
  it('英文訊息換成白話', () => {
    expect(friendlyError(err('Not found', 404))).toBe('找不到這筆資料，可能剛被刪除，或專案已封存');
    expect(friendlyError(err('Project not found', 404))).toContain('找不到');
    expect(friendlyError(err('HTTP 502', 502))).toBe('伺服器暫時出了問題，請稍後再試');
    expect(friendlyError(new TypeError('Failed to fetch'))).toBe('連不上伺服器，請檢查網路後再試');
    expect(friendlyError(err('Unauthorized', 401))).toBe('登入過期了，請重新登入');
  });
  it('專案讀不到（封存 / 被移出）', () => {
    expect(projectGoneMessage(err('x', 404))).toContain('封存');
    expect(projectGoneMessage(err('x', 403))).toContain('不是這個專案的成員');
    expect(projectGoneMessage(err('x', 500))).toBeNull();
    expect(projectGoneMessage(new TypeError('Failed to fetch'))).toBeNull();
  });
});

describe('留言：誰能改 / 刪', () => {
  const mine = { authorUserId: 'u_a', author: '小明' };
  const theirs = { authorUserId: 'u_b', author: '阿華' };
  const legacy = { author: '小明' } as Pick<SongComment, 'authorUserId' | 'author'>;
  it('自己的可以，別人的不行', () => {
    expect(canModifyComment(mine, { id: 'u_a', role: 'animator' }, 'animator')).toBe(true);
    expect(canModifyComment(theirs, { id: 'u_a', role: 'animator' }, 'animator')).toBe(false);
  });
  it('專案 admin 或全站 admin 都可以', () => {
    expect(canModifyComment(theirs, { id: 'u_x', role: 'director' }, 'admin')).toBe(true);
    expect(canModifyComment(theirs, { id: 'u_x', role: 'admin' }, null)).toBe(true);
  });
  it('很舊的留言沒有 authorUserId → 只有 admin 能改（跟後台一樣，同名不算）', () => {
    expect(canModifyComment(legacy, { id: 'u_a', role: 'animator' }, 'animator')).toBe(false);
    expect(isOwnComment(legacy, { id: 'u_a', name: '小明' })).toBe(true);  // 未讀 / 跳通知用：同名當自己
  });
});

describe('自動更新的比對', () => {
  const s = (id: string, status: Song['status']): Song => ({
    id, name: id, order: 0, animatorUserId: null, status, createdAt: '', cueCount: 0, proposalCount: 0,
    code: null, latestVideoId: null, latestVideoVersion: null,
  });
  it('sameSongs：內容一樣就算一樣，狀態變了就不一樣', () => {
    expect(sameSongs([s('a', 'todo')], [s('a', 'todo')])).toBe(true);
    expect(sameSongs([s('a', 'todo')], [s('a', 'in_review')])).toBe(false);
    expect(sameSongs([s('a', 'todo')], [s('a', 'todo'), s('b', 'todo')])).toBe(false);
  });
  const c = (id: string, authorUserId: string, extra: Partial<SongComment> = {}): SongComment => ({
    id, time: 0, x: 0.5, y: 0.5, text: 't', author: authorUserId, email: null, role: 'director',
    createdAt: '2026-10-14T00:00:00Z', authorUserId, ...extra,
  });
  it('sameComments：文字 / 已解決改了也算不一樣', () => {
    expect(sameComments([c('1', 'u_d')], [c('1', 'u_d')])).toBe(true);
    expect(sameComments([c('1', 'u_d')], [c('1', 'u_d', { status: 'resolved' })])).toBe(false);
    expect(sameComments(undefined, [])).toBe(false);
  });
  it('newCommentsFromOthers：只算別人新留的；上次沒資料不算', () => {
    const me = { id: 'u_a', name: '小明' };
    expect(newCommentsFromOthers([c('1', 'u_d')], [c('1', 'u_d'), c('2', 'u_d'), c('3', 'u_a')], me).map(x => x.id)).toEqual(['2']);
    expect(newCommentsFromOthers(undefined, [c('1', 'u_d')], me)).toEqual([]);
  });
});
