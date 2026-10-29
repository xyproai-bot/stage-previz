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
  it('對開拆成兩個機關：寫原名和拆成哪兩個，沒有名字也不會出現 undefined', () => {
    expect(describeActivity(e('update', 'mechanism', { unsplit: true, name: '側面 LED', nameA: '側面 LED A', nameB: '側面 LED B', bId: 'x', positions: 4, libraryPositions: 3 })))
      .toBe('把對開機關「側面 LED」拆成兩個機關「側面 LED A」「側面 LED B」');
    expect(describeActivity(e('update', 'mechanism', { unsplit: true }))).toBe('把對開機關拆成兩個機關');
    // 一般的修改機關不受影響
    expect(describeActivity(e('update', 'mechanism', { name: '升降台' }))).toBe('修改機關「升降台」');
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
  it('Cue 庫：另存、新增、更新、改名、改編號、刪除、這首歌加 / 換 / 改時間 / 拿掉都是白話（編號是自己打的文字）', () => {
    expect(describeActivity(e('create', 'library_cue', { label: '12-1', name: '副歌全開', basedOnLabel: '12', basedOnName: '副歌全開' }))).toBe('從「12 副歌全開」另存成「12-1 副歌全開」');
    expect(describeActivity(e('create', 'library_cue', { label: '12', name: '副歌全開' }))).toBe('新增 Cue 庫的 cue「12 副歌全開」');
    expect(describeActivity(e('update', 'library_cue', { kind: 'look', label: '12', name: '副歌全開', songCount: 3 }))).toBe('更新 Cue 庫的「12 副歌全開」（3 首歌在用）');
    expect(describeActivity(e('update', 'library_cue', { kind: 'look', label: '12', name: '副歌全開', songCount: 0 }))).toBe('更新 Cue 庫的「12 副歌全開」');
    expect(describeActivity(e('update', 'library_cue', { kind: 'rename', label: '12', fromName: 'A', toName: '新名字' }))).toBe('把「12」改名成「新名字」');
    expect(describeActivity(e('update', 'library_cue', { kind: 'relabel', name: '副歌', fromLabel: '12', toLabel: '3-1' }))).toBe('把「12 副歌」的編號改成 3-1');
    expect(describeActivity(e('delete', 'library_cue', { label: '12', name: '副歌' }))).toBe('刪除 Cue 庫的「12 副歌」');
    // 導演在調整舞台存起來
    expect(describeActivity(e('update', 'library_cue', { kind: 'stage_save', label: '30', name: '副歌全開', changed: 2, songCount: 2, songs: ['S05', 'S12'] })))
      .toBe('在調整舞台存回 Cue 庫的「30 副歌全開」（改了 2 個機關，S05、S12 會一起變）');
    expect(describeActivity(e('update', 'library_cue', { kind: 'stage_save', label: '30', name: '副歌全開', changed: 1, songs: [] })))
      .toBe('在調整舞台存回 Cue 庫的「30 副歌全開」（改了 1 個機關）');
    expect(describeActivity(e('update', 'library_cue', { kind: 'stage_save', label: '30', name: '副歌全開' }))).toBe('在調整舞台存回 Cue 庫的「30 副歌全開」');
    expect(describeActivity(e('update', 'library_cue', { kind: 'stage_undo', label: '30', name: '副歌全開', changed: 1, songs: ['S05'] })))
      .toBe('復原 Cue 庫的「30 副歌全開」的舞台調整（改了 1 個機關，S05 會一起變）');
    expect(describeActivity(e('create', 'library_cue', { kind: 'stage_save_as', label: '30-1', name: '副歌全開（導演改）', basedOnLabel: '30', basedOnName: '副歌全開', songName: '開場曲', placed: 'replace' })))
      .toBe('在調整舞台從「30 副歌全開」另存成「30-1 副歌全開（導演改）」，歌曲「開場曲」改用它');
    expect(describeActivity(e('create', 'library_cue', { kind: 'stage_copy', label: '30-2', name: '副歌全開（複製）', basedOnLabel: '30', basedOnName: '副歌全開' })))
      .toBe('從「30 副歌全開」複製成「30-2 副歌全開（複製）」');
    expect(describeActivity(e('create', 'cue', { songName: 'X', videoTimeSec: 45, libraryLabel: '12', libraryName: '副歌' }))).toBe('在歌曲「X」0:45 加上「12 副歌」');
    expect(describeActivity(e('update', 'cue', { kind: 'repoint', songName: 'X', videoTimeSec: 83, libraryLabel: '13', libraryName: 'B' }))).toBe('把歌曲「X」1:23 的 cue 換成「13 B」');
    expect(describeActivity(e('update', 'cue', { kind: 'retime', songName: 'X', fromTimeSec: 83, toTimeSec: 90, libraryLabel: '13', libraryName: 'B' }))).toBe('把歌曲「X」1:23 的 cue 時間改成 1:30');
    expect(describeActivity(e('delete', 'cue', { songName: 'X', videoTimeSec: 83, libraryLabel: '12', libraryName: '副歌' }))).toBe('從歌曲「X」拿掉 1:23 的「12 副歌」');
    // 舊的 cue 活動文字不變
    expect(describeActivity(e('delete', 'cue', { name: '副歌' }))).toBe('刪除 cue「副歌」');
  });
  it('Cue 庫轉場秒數：改預設、這首歌另外設、改回用 Cue 庫的', () => {
    expect(describeActivity(e('update', 'library_cue', { kind: 'crossfade', label: '3', name: '副歌', fromSeconds: 1, toSeconds: 2 }))).toBe('把 Cue 3「副歌」的轉場改成 2 秒（用到的歌一起變）');
    expect(describeActivity(e('update', 'cue', { kind: 'crossfade', songName: 'X', libraryLabel: '3', libraryName: '副歌', toSeconds: 2, useLibrary: false }))).toBe('歌曲「X」的 Cue 3「副歌」另外設轉場 2 秒');
    expect(describeActivity(e('update', 'cue', { kind: 'crossfade', songName: 'X', libraryLabel: '3', libraryName: '副歌', toSeconds: null, useLibrary: true }))).toBe('歌曲「X」的 Cue 3「副歌」轉場改回用 Cue 庫的');
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
