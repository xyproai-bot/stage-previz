import { describe, expect, it } from 'vitest';
import { shortDateTime, reviewLine, newVersionLabel, lastReviewSentence, reviewerLabel, decisionNotifyHint } from './reviewHistory';
import type { SongLastReview } from './reviewApi';

const tz = { timeZone: 'Asia/Taipei', now: Date.parse('2026-10-14T10:00:00.000Z') };
const last = (p: Partial<SongLastReview> = {}): SongLastReview => ({
  videoId: 'sv2', version: 2, versionLabel: 'V2', status: 'needs_changes', reason: '第二段太亮', byName: '王小明', byRole: 'director',
  at: '2026-10-14T07:20:00.000Z', ...p,
});

describe('審片紀錄', () => {
  it('一行：「V2 需修改 · 導演 王小明 · 10/14 15:20」（台灣時間）', () => {
    expect(reviewLine({ versionLabel: 'V2', statusLabel: '需修改', by: { name: '王小明', role: 'director' }, createdAt: '2026-10-14T07:20:00.000Z' }, tz))
      .toBe('V2 需修改 · 導演 王小明 · 10/14 15:20');
    expect(reviewLine({ versionLabel: '', statusLabel: '已通過', by: { name: '小花', role: 'admin' }, createdAt: '2025-12-31T16:05:00.000Z' }, tz))
      .toBe('已通過 · 製作 小花 · 1/1 00:05');
    expect(shortDateTime('2025-06-01T04:05:00.000Z', tz)).toBe('2025/6/1 12:05');
    expect(shortDateTime('壞掉的')).toBe('');
    expect(reviewerLabel({ name: '阿凱', role: '' })).toBe('阿凱');
  });

  it('有新版：看過 V2、最新 V3 → V3；看的就是最新、從沒審過、沒影片 → 沒有', () => {
    expect(newVersionLabel({ latestVideoVersion: 3, lastReview: last(), reviewedVersion: 2 })).toBe('V3');
    expect(newVersionLabel({ latestVideoVersion: 2, lastReview: last(), reviewedVersion: 2 })).toBeNull();
    expect(newVersionLabel({ latestVideoVersion: 3, lastReview: null, reviewedVersion: null })).toBeNull();
    expect(newVersionLabel({ latestVideoVersion: null, lastReview: last(), reviewedVersion: 2 })).toBeNull();
    // 當時沒有版本（舊的 Drive 影片）→ 後來交的 V1 算新版
    expect(newVersionLabel({ latestVideoVersion: 1, lastReview: last({ version: null, versionLabel: '' }), reviewedVersion: null })).toBe('V1');
    // 審過 V3 之後又回頭審 V2：看過的最新還是 V3
    expect(newVersionLabel({ latestVideoVersion: 3, lastReview: last({ version: 2 }), reviewedVersion: 3 })).toBeNull();
  });

  it('通過 / 需修改後說誰會收到通知', () => {
    expect(decisionNotifyHint({ animatorUserId: 'u_a', latestVideoId: null })).toBe('負責的動畫師會收到通知');
    expect(decisionNotifyHint({ animatorUserId: null, latestVideoId: 'sv1' })).toBe('交這一版的動畫師會收到通知');
    expect(decisionNotifyHint({ animatorUserId: null, latestVideoId: null })).toMatch(/還沒指派/);
  });

  it('動畫師看到的一句', () => {
    expect(lastReviewSentence(last())).toBe('導演看過 V2：需修改（第二段太亮）');
    expect(lastReviewSentence(last({ status: 'approved', versionLabel: 'V3', reason: '' }))).toBe('導演看過 V3：已通過');
    expect(lastReviewSentence(last({ byRole: 'admin', reason: '' }))).toBe('製作看過 V2：需修改');
    expect(lastReviewSentence(null)).toBeNull();
  });
});
