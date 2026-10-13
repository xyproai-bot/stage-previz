import { describe, expect, it } from 'vitest';
import { describeActivity } from './activityText';

const e = (action: string, targetType: string, payload: Record<string, unknown> = {}) =>
  ({ action, targetType, payload }) as unknown as Parameters<typeof describeActivity>[0];

describe('describeActivity（最近活動的一句話）', () => {
  it('影片版本、機關不會印出後台的代號', () => {
    expect(describeActivity(e('create', 'song_video', { label: 'V2', title: 'S01_V2' }))).toBe('交了影片 V2「S01_V2」');
    expect(describeActivity(e('delete', 'song_video', { label: 'V1' }))).toBe('刪除影片 V1');
    expect(describeActivity(e('create', 'mechanism', { name: '旋轉舞台' }))).toBe('新增機關「旋轉舞台」');
    expect(describeActivity(e('update', 'drive_file', {}))).toBe('修改 Drive 檔案');
  });
  it('交新版後自動回到審查中：沒有歌名也不會出現 undefined', () => {
    const s = describeActivity(e('update', 'song', { statusFrom: 'needs_changes', statusTo: 'in_review', auto: true, label: 'V2' }));
    expect(s).toBe('把歌曲從「需修改」改成「審查中」（交了新版 V2，自動改的）');
    expect(s).not.toContain('undefined');
  });
  it('一般的狀態改變', () => {
    expect(describeActivity(e('update', 'song', { name: '開場', statusFrom: 'in_review', statusTo: 'approved' })))
      .toBe('把歌曲「開場」從「審查中」改成「已通過」');
  });
  it('不認得的種類寫成白話，不會印出英文', () => {
    const s = describeActivity(e('mystery', 'something_new', {}));
    expect(s).toBe('更新項目');
    expect(describeActivity(e('reorder', 'mechanism', { count: 3 }))).toBe('重新排序 3 個機關');
    expect(describeActivity(e('create', 'cue', { name: 'Cue 1' }))).toBe('新增 cue「Cue 1」');
  });
});
