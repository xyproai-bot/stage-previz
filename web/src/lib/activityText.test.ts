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
  it('一排機關：一次建立、改共用設定、解散、刪除都是白話', () => {
    expect(describeActivity(e('bulk_create', 'mechanism', { name: 'LED 升降', count: 8 }))).toBe('一次建立 8 個機關「LED 升降」');
    expect(describeActivity(e('update', 'mechanism_group', { name: 'LED 升降', shared: true }))).toBe('修改一排機關「LED 升降」的共用設定');
    expect(describeActivity(e('update', 'mechanism_group', { name: 'LED 升降', dissolved: true, mechanisms: 8 }))).toBe('解散一排機關「LED 升降」（8 個機關留著）');
    expect(describeActivity(e('delete', 'mechanism_group', { name: 'LED 升降', mechanisms: 8 }))).toBe('刪除一排機關「LED 升降」（連同 8 個機關）');
  });
  it('一首歌所有 cue 的物件回到預設位置 / 復原：寫歌名和筆數，沒有歌名也不會出現 undefined', () => {
    expect(describeActivity(e('reset', 'song_cue_states', { songName: '開場', removed: 12, cues: 5 }))).toBe('把歌曲「開場」所有 cue 的物件重置回預設位置（清掉 12 筆）');
    expect(describeActivity(e('restore', 'song_cue_states', { songName: '開場', restored: 12 }))).toBe('復原歌曲「開場」所有 cue 的物件位置（寫回 12 筆）');
    expect(describeActivity(e('reset', 'song_cue_states', {}))).toBe('把歌曲所有 cue 的物件重置回預設位置');
  });
  it('物件預設隱藏：設定 / 取消都是白話', () => {
    expect(describeActivity(e('update', 'stage_object', { name: '瞬掉緞帶', changes: { defaultHidden: true } }))).toBe('把物件「瞬掉緞帶」設成預設隱藏');
    expect(describeActivity(e('update', 'stage_object', { name: '瞬掉緞帶', changes: { defaultHidden: false } }))).toBe('取消物件「瞬掉緞帶」的預設隱藏');
    expect(describeActivity(e('update', 'stage_object', { name: '主牆', changes: { locked: true } }))).toBe('修改物件「主牆」');
  });
  it('專案成員、邀請連結：寫給誰、什麼角色，沒有名字也不會出現 undefined', () => {
    expect(describeActivity(e('create', 'member', { name: '小華', summary: '把「小華」加進專案（導演）' }))).toBe('把「小華」加進專案（導演）');
    expect(describeActivity(e('update', 'member', { name: '小華', summary: '把「小華」從動畫師改成製作' }))).toBe('把「小華」從動畫師改成製作');
    expect(describeActivity(e('delete', 'member', { name: '小華' }))).toBe('把「小華」移出專案');
    expect(describeActivity(e('delete', 'member', {}))).toBe('移出了一位成員');
    expect(describeActivity(e('create', 'invite', { name: '小陳', role: 'admin' }))).toBe('建立邀請連結「小陳」（製作）');
    expect(describeActivity(e('create', 'invite', { name: '小陳', role: 'director' }))).toBe('建立邀請連結「小陳」（導演）');
    expect(describeActivity(e('create', 'invite', {}))).toBe('建立邀請連結');
    expect(describeActivity(e('delete', 'invite', {}))).toBe('撤銷一條邀請連結');
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
