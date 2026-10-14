import { describe, it, expect } from 'vitest';
import {
  parseSetlist, assignSongCodes, songCodeProblems, songNameKey,
  WIZARD_STEPS, stepIndex, nextStep, prevStep, stepFromParam, stepLabel,
  newProgress, markStep, resumeStep, unfinishedSteps, needsResume, readWizardProgress, writeWizardProgress, WIZARD_STORAGE_KEY,
  describeObjectCounts, countByCategory, parseCanvasFields, aspectText, SETLIST_MAX_SONGS, SONG_NAME_MAX,
} from './newProjectWizard';

const names = (text: string) => parseSetlist(text).songs.map(s => s.name);

describe('parseSetlist：貼上的歌單', () => {
  it('一行一首，去掉頭尾空白，空行跳過', () => {
    const r = parseSetlist('  開場  \n\n夜曲\n   \n安可\n');
    expect(r.songs.map(s => [s.name, s.code, s.line])).toEqual([['開場', null, 1], ['夜曲', null, 3], ['安可', null, 5]]);
    expect(r.skippedEmpty).toBe(2);
    expect(r.duplicates).toEqual([]);
  });

  it('頭尾多出來的空行不算「跳過的空行」；Windows 換行也看得懂', () => {
    const r = parseSetlist('\n\n開場\r\n夜曲\r\n\r\n');
    expect(r.songs.map(s => s.name)).toEqual(['開場', '夜曲']);
    expect(r.skippedEmpty).toBe(0);
  });

  it('有標點的編號一定拿掉：「1. 開場」「2、夜曲」「3) 安可」「(4) 謝幕」「第5首：彩蛋」「#6 返場」', () => {
    expect(names('1. 開場\n2、夜曲\n3) 安可\n(4) 謝幕\n第5首：彩蛋\n#6 返場')).toEqual(['開場', '夜曲', '安可', '謝幕', '彩蛋', '返場']);
    expect(names('1.開場')).toEqual(['開場']);
    expect(names('第 2 首 夜曲')).toEqual(['夜曲']);
    expect(names('- 開場\n• 夜曲')).toEqual(['開場', '夜曲']);
  });

  it('只有「數字 + 空白」：整份歌單都這樣編號才拿掉；歌名本身是數字開頭的不動', () => {
    expect(names('1 開場\n2 夜曲\n3 安可')).toEqual(['開場', '夜曲', '安可']);
    expect(names('2 Become 1')).toEqual(['2 Become 1']);
    expect(names('開場\n1999\n2 Become 1\n安可')).toEqual(['開場', '1999', '2 Become 1', '安可']);
    // 小數點、時間不是編號
    expect(names('3.14 圓周率')).toEqual(['3.14 圓周率']);
    expect(names('1:23 倒數')).toEqual(['1:23 倒數']);
  });

  it('開頭寫歌曲代號：「S01 開場」「S02_夜曲」「s3. 安可」「[S04] 謝幕」「S05彩蛋」→ 代號 + 歌名', () => {
    const r = parseSetlist('S01 開場\nS02_夜曲\ns3. 安可\n[S04] 謝幕\nS05彩蛋');
    expect(r.songs.map(s => [s.code, s.name])).toEqual([['S01', '開場'], ['S02', '夜曲'], ['S3', '安可'], ['S04', '謝幕'], ['S05', '彩蛋']]);
    // 編號 + 代號
    expect(parseSetlist('1. S07 開場').songs.map(s => [s.code, s.name])).toEqual([['S07', '開場']]);
    // 只有代號沒有歌名 → 整個當歌名
    expect(parseSetlist('S01').songs.map(s => [s.code, s.name])).toEqual([[null, 'S01']]);
    // 英文歌名開頭剛好是 S 不算代號
    expect(parseSetlist('Shape of You\nSO GOOD').songs.map(s => s.code)).toEqual([null, null]);
  });

  it('重複的歌只留第一首（全形半形、大小寫、空白都算同一首），而且說是哪幾首', () => {
    const r = parseSetlist('開場\n夜曲\n開 場\nLove Song\nlove song\n１. 夜曲');
    expect(r.songs.map(s => s.name)).toEqual(['開場', '夜曲', 'Love Song']);
    expect(r.duplicates).toEqual(['開 場', 'love song', '夜曲']);
    expect(songNameKey('Ｌｏｖｅ Song')).toBe(songNameKey('love song'));
  });

  it('從 Excel 貼的（Tab 分欄）：編號、代號、歌名、長度 → 只拿代號和歌名', () => {
    const r = parseSetlist('1\t開場\t3:45\n2\tS02\t夜曲\t4:10\nS03\t安可');
    expect(r.songs.map(s => [s.code, s.name])).toEqual([[null, '開場'], ['S02', '夜曲'], ['S03', '安可']]);
  });

  it('整個歌名用引號包起來的拿掉引號；太長的截到 80 字；最多 100 首', () => {
    expect(names('「開場」\n“夜曲”')).toEqual(['開場', '夜曲']);
    expect(names('「開場」與「夜曲」')).toEqual(['「開場」與「夜曲」']);
    const long = '長'.repeat(120);
    expect(names(long)[0]).toHaveLength(SONG_NAME_MAX);
    const many = Array.from({ length: SETLIST_MAX_SONGS + 5 }, (_, i) => `歌 ${i + 1}`).join('\n');
    const r = parseSetlist(many);
    expect(r.songs).toHaveLength(SETLIST_MAX_SONGS);
    expect(r.tooMany).toBe(5);
  });

  it('空的 / 全是空白 → 沒有歌', () => {
    expect(parseSetlist('').songs).toEqual([]);
    expect(parseSetlist('\n  \n\t\n').songs).toEqual([]);
  });
});

describe('assignSongCodes：歌曲代號', () => {
  it('新專案：照順序 S01、S02、S03…', () => {
    expect(assignSongCodes([{ name: '開場' }, { name: '夜曲' }, { name: '安可' }]).map(s => [s.code, s.auto]))
      .toEqual([['S01', true], ['S02', true], ['S03', true]]);
  });

  it('有寫代號的照用（存成大寫、S3 寫成 S3），沒寫的接著前一首往下排', () => {
    const r = assignSongCodes([{ name: '開場' }, { name: '夜曲', code: 's05' }, { name: '安可' }, { name: '彩蛋', code: 'ENC-1' }, { name: '謝幕' }]);
    expect(r.map(s => s.code)).toEqual(['S01', 'S05', 'S06', 'ENC-1', 'S07']);
    expect(r.map(s => s.auto)).toEqual([true, false, true, false, true]);
  });

  it('專案裡已經有歌：接在最大的 S 號碼後面、不撞到（S1 和 S01 算同一個）', () => {
    expect(assignSongCodes([{ name: 'A' }, { name: 'B' }], ['S01', 'S02', null, 'X9']).map(s => s.code)).toEqual(['S03', 'S04']);
    // 寫的代號被已經有的歌用掉了 → 改成系統排的
    expect(assignSongCodes([{ name: 'A', code: 'S1' }], ['S01']).map(s => [s.code, s.auto])).toEqual([['S02', true]]);
    // 同一份歌單寫了兩次一樣的 → 第二個改成系統排的
    expect(assignSongCodes([{ name: 'A', code: 'S02' }, { name: 'B', code: 'S2' }]).map(s => s.code)).toEqual(['S02', 'S03']);
    // 往下排時跳過已經被用掉的
    expect(assignSongCodes([{ name: 'A' }, { name: 'B' }, { name: 'C', code: 'S02' }]).map(s => s.code)).toEqual(['S01', 'S03', 'S02']);
  });

  it('格式不對的代號不用，改成系統排的', () => {
    expect(assignSongCodes([{ name: 'A', code: 'S 01' }, { name: 'B', code: '太長太長太長太長太長太長太長' }]).map(s => s.code)).toEqual(['S01', 'S02']);
  });

  it('songCodeProblems：表格裡改過的代號再檢查一次', () => {
    const rows = [{ code: 'S01' }, { code: 's1' }, { code: 'S 3' }, { code: '' }, { code: 'S04' }, { code: 'S09' }];
    expect(songCodeProblems(rows, [{ name: '舊歌', code: 'S09' }])).toEqual([
      null,
      '「S1」跟第 1 首重複了',
      '代號只能用英文字母、數字和中間的「-」（例：S01、ENC-1）',
      '代號不能是空的',
      null,
      '「S09」已經是「舊歌」的代號了',
    ]);
  });
});

describe('步驟', () => {
  it('六個步驟的順序、上一步 / 下一步', () => {
    expect(WIZARD_STEPS.map(s => s.key)).toEqual(['name', 'model', 'canvas', 'songs', 'invite', 'done']);
    expect(WIZARD_STEPS.map(s => s.label)).toEqual(['名稱', '3D 模型', 'LED 畫布大小', '歌單', '邀請人', '完成']);
    expect(stepIndex('canvas')).toBe(2);
    expect(stepLabel('songs')).toBe('歌單');
    expect(nextStep('name')).toBe('model');
    expect(nextStep('invite')).toBe('done');
    expect(nextStep('done')).toBeNull();
    expect(prevStep('model')).toBe('name');
    expect(prevStep('name')).toBeNull();
  });

  it('網址上的步驟：沒有 = 沒開；看不懂 / 還沒有專案 → 從名稱開始', () => {
    expect(stepFromParam(null, false)).toBeNull();
    expect(stepFromParam(undefined, true)).toBeNull();
    expect(stepFromParam('', false)).toBe('name');
    expect(stepFromParam('songs', true)).toBe('songs');
    expect(stepFromParam('songs', false)).toBe('name');
    expect(stepFromParam('???', true)).toBe('name');
    expect(stepFromParam('done', true)).toBe('done');
  });

  it('進度：做好了蓋過跳過，跳過不蓋掉做好的；繼續設定從第一個還沒碰過的步驟開始', () => {
    let p = newProgress('p1', '示範專案', 1000);
    expect(p.marks).toEqual({ name: 'done' });
    expect(resumeStep(p)).toBe('model');
    expect(unfinishedSteps(p)).toEqual(['model', 'canvas', 'songs', 'invite']);
    expect(needsResume(p)).toBe(true);

    p = markStep(p, 'model', 'done', 2000);
    p = markStep(p, 'canvas', 'skipped', 3000);
    expect(resumeStep(p)).toBe('songs');
    expect(unfinishedSteps(p)).toEqual(['canvas', 'songs', 'invite']);
    expect(p.updatedAt).toBe(3000);

    // 跳過不會蓋掉做好的；之後補做好會蓋過跳過
    expect(markStep(p, 'model', 'skipped', 4000)).toBe(p);
    p = markStep(p, 'canvas', 'done', 5000);
    expect(p.marks.canvas).toBe('done');

    p = markStep(markStep(p, 'songs', 'done'), 'invite', 'skipped');
    expect(resumeStep(p)).toBe('done');
    expect(needsResume(p)).toBe(true);           // 邀請還沒做，也還沒走到完成那一頁
    p = markStep(p, 'done', 'done');
    expect(p.finished).toBe(true);
    expect(needsResume(p)).toBe(false);          // 走到完成那一頁就不再提醒
    expect(needsResume(null)).toBe(false);
  });

  it('進度存在這台電腦：壞資料 / 讀不到 / 不能存都不會出錯', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    };
    expect(readWizardProgress(storage)).toBeNull();
    const p = markStep(newProgress('p1', '示範專案', 1), 'model', 'skipped', 2);
    writeWizardProgress(storage, p);
    expect(readWizardProgress(storage)).toEqual(p);
    mem.set(WIZARD_STORAGE_KEY, '{"projectId":"p2","marks":{"model":"done","songs":"maybe","x":"done"},"updatedAt":"x"}');
    expect(readWizardProgress(storage)).toEqual({ projectId: 'p2', projectName: '', marks: { model: 'done' }, finished: false, updatedAt: 0 });
    mem.set(WIZARD_STORAGE_KEY, 'not json');
    expect(readWizardProgress(storage)).toBeNull();
    mem.set(WIZARD_STORAGE_KEY, '{"marks":{}}');
    expect(readWizardProgress(storage)).toBeNull();
    writeWizardProgress(storage, null);
    expect(mem.has(WIZARD_STORAGE_KEY)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readWizardProgress(broken)).toBeNull();
    expect(() => writeWizardProgress(broken, p)).not.toThrow();
    expect(readWizardProgress(null)).toBeNull();
  });
});

describe('模型裡找到什麼、LED 畫布大小', () => {
  it('「找到 12 片 LED、2 個機關、1 個走位點…」照固定順序，0 個的不寫', () => {
    const objs = [
      ...Array.from({ length: 12 }, () => ({ category: 'led_panel' as const })),
      { category: 'mechanism' as const }, { category: 'mechanism' as const },
      { category: 'other' as const }, { category: 'walk_point' as const }, { category: 'performer' as const },
    ];
    expect(describeObjectCounts(countByCategory(objs))).toBe('找到 12 片 LED、2 個機關、1 個走位點、1 位表演者、1 個其他物件');
    expect(describeObjectCounts({ fixture: 3 })).toBe('找到 3 個燈光 / 道具');
    expect(describeObjectCounts({})).toBe('模型裡沒有讀到物件');
  });

  it('寬高欄位：整數 16～32768 才收，用白話說哪裡不對', () => {
    expect(parseCanvasFields('3840', '2160')).toEqual({ canvas: { width: 3840, height: 2160 } });
    expect(parseCanvasFields(' 10496 ', '5120')).toEqual({ canvas: { width: 10496, height: 5120 } });
    expect(parseCanvasFields('', '2160')).toEqual({ error: '寬和高都要填' });
    expect(parseCanvasFields('3840.5', '2160')).toEqual({ error: '寬和高要是 16～32768 的整數（像素）' });
    expect(parseCanvasFields('8', '2160')).toEqual({ error: '寬和高要是 16～32768 的整數（像素）' });
    expect(parseCanvasFields('99999', '2160')).toEqual({ error: '寬和高要是 16～32768 的整數（像素）' });
  });

  it('比例', () => {
    expect(aspectText({ width: 3840, height: 2160 })).toBe('16:9');
    expect(aspectText({ width: 1920, height: 1080 })).toBe('16:9');
    expect(aspectText({ width: 10496, height: 5120 })).toBe('2.05:1');
    expect(aspectText({ width: 1080, height: 1920 })).toBe('9:16');
    expect(aspectText({ width: 1000, height: 3001 })).toBe('1:3');
  });
});
