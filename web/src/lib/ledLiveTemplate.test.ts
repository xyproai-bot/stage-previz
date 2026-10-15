import { describe, expect, it } from 'vitest';
import type { LedTemplatePlan } from './ledTemplate';
import type { LedTemplate, LedTemplateList } from './ledTemplateApi';
import { chooseLedTemplate, fitsCanvas, isLiveSource, ledTemplateChip, liveSourceHint, songTemplatePlan } from './ledLiveTemplate';

const FULL = { width: 8800, height: 2024 };

const plan = (name: string, canvas: { width: number; height: number }, id: string | null = name): LedTemplatePlan => ({
  v: 1, id, name, canvas, scalePct: 100, screens: [],
});
const tpl = (name: string, canvas: { width: number; height: number }, kind: 'full' | 'custom' = 'custom'): LedTemplate => ({
  ...plan(name, canvas), id: name, kind, sortOrder: 0, songCount: 0, canvas,
});
const T1 = tpl('版型 1', { width: 1920, height: 1080 });
const T2 = tpl('版型 2', { width: 3840, height: 1000 });
const LIST: LedTemplateList = { fullCanvas: FULL, templates: [tpl('全部', FULL, 'full'), T1, T2], screens: [] };

describe('songTemplatePlan：這首歌選的版型', () => {
  it('找得到自己排的版型', () => {
    expect(songTemplatePlan(LIST, '版型 1')).toBe(T1);
  });
  it('沒選 / 選「全部」/ 已刪掉 / 清單還沒讀到 → null（整張畫布）', () => {
    expect(songTemplatePlan(LIST, null)).toBeNull();
    expect(songTemplatePlan(LIST, undefined)).toBeNull();
    expect(songTemplatePlan(LIST, '全部')).toBeNull();
    expect(songTemplatePlan(LIST, 'gone')).toBeNull();
    expect(songTemplatePlan(null, '版型 1')).toBeNull();
  });
});

describe('chooseLedTemplate：每個來源用哪一份', () => {
  const song = plan('版型 1', { width: 1920, height: 1080 });
  const snap = plan('舊版型', { width: 960, height: 540 });
  const test = plan('測試中', { width: 100, height: 100 });

  it('AE 即時、本地檔案：用這首歌現在選的版型', () => {
    expect(chooseLedTemplate({ source: 'ndi', songPlan: song })).toEqual({ plan: song, origin: 'song' });
    expect(chooseLedTemplate({ source: 'file', songPlan: song })).toEqual({ plan: song, origin: 'song' });
  });
  it('歌曲影片版本：只用那一版自己的快照，不借這首歌現在選的', () => {
    expect(chooseLedTemplate({ source: 'version', versionPlan: snap, songPlan: song })).toEqual({ plan: snap, origin: 'version' });
    // 那一版沒有快照（整張畫布做的）→ 整張畫布，就算這首歌後來才選了版型
    expect(chooseLedTemplate({ source: 'version', versionPlan: null, songPlan: song })).toEqual({ plan: null, origin: 'none' });
  });
  it('這首歌沒選版型 → 整張畫布（跟以前一樣）', () => {
    expect(chooseLedTemplate({ source: 'ndi', songPlan: null })).toEqual({ plan: null, origin: 'none' });
    expect(chooseLedTemplate({ source: 'file' })).toEqual({ plan: null, origin: 'none' });
    expect(chooseLedTemplate({ source: null, songPlan: song, versionPlan: snap })).toEqual({ plan: null, origin: 'none' });
  });
  it('暫時用整張畫布看：AE 即時、本地檔案變整張畫布；影片版本不受影響', () => {
    expect(chooseLedTemplate({ source: 'ndi', songPlan: song, fullView: true })).toEqual({ plan: null, origin: 'override' });
    expect(chooseLedTemplate({ source: 'file', songPlan: song, fullView: true })).toEqual({ plan: null, origin: 'override' });
    expect(chooseLedTemplate({ source: 'version', versionPlan: snap, songPlan: song, fullView: true })).toEqual({ plan: snap, origin: 'version' });
  });
  it('這首歌沒選版型時，「暫時用整張畫布看」沒有意義（還是 none）', () => {
    expect(chooseLedTemplate({ source: 'ndi', songPlan: null, fullView: true })).toEqual({ plan: null, origin: 'none' });
  });
  it('版型面板開著的測試圖蓋過所有東西（包括暫時用整張畫布看）', () => {
    for (const source of ['ndi', 'file', 'version', null] as const) {
      expect(chooseLedTemplate({ source, previewPlan: test, songPlan: song, versionPlan: snap, fullView: true })).toEqual({ plan: test, origin: 'preview' });
    }
  });
  it('isLiveSource：只有 AE 即時、本地檔案', () => {
    expect(isLiveSource('ndi')).toBe(true);
    expect(isLiveSource('file')).toBe(true);
    expect(isLiveSource('version')).toBe(false);
    expect(isLiveSource(null)).toBe(false);
  });
});

describe('ledTemplateChip：「LED 版型：…」標籤', () => {
  const song = T1;
  const base = { list: LIST, songPlan: song };

  it('AE 即時照這首歌的版型：寫名字和大小，可以暫時用整張畫布看', () => {
    const c = ledTemplateChip(chooseLedTemplate({ source: 'ndi', songPlan: song }), { ...base, source: 'ndi' });
    expect(c).toMatchObject({ text: 'LED 版型：版型 1（1920×1080）', canToggle: true, fullView: false });
  });
  it('影片版本：寫那一版快照的版型；不能「暫時用整張畫布看」', () => {
    const snap = plan('舊版型', { width: 960, height: 540 });
    const c = ledTemplateChip(chooseLedTemplate({ source: 'version', versionPlan: snap, songPlan: song }), { ...base, source: 'version' });
    expect(c).toMatchObject({ text: 'LED 版型：舊版型（960×540）', canToggle: false });
  });
  it('這首歌沒選版型：「LED 版型：全部」，沒東西可以切', () => {
    const c = ledTemplateChip(chooseLedTemplate({ source: 'file', songPlan: null }), { list: LIST, songPlan: null, source: 'file' });
    expect(c).toMatchObject({ text: 'LED 版型：全部', canToggle: false, fullView: false });
  });
  it('暫時用整張畫布看：標「（暫時）」、說明寫原本是哪個版型，還可以再按回去', () => {
    const c = ledTemplateChip(chooseLedTemplate({ source: 'ndi', songPlan: song, fullView: true }), { ...base, source: 'ndi' });
    expect(c?.text).toBe('LED 版型：全部（暫時）');
    expect(c?.title).toContain('版型 1');
    expect(c).toMatchObject({ canToggle: true, fullView: true });
  });
  it('編輯版型時：寫測試中的版型，沒有可按的切換', () => {
    const c = ledTemplateChip(chooseLedTemplate({ source: 'ndi', previewPlan: T2, songPlan: song }), { ...base, source: 'ndi' });
    expect(c).toMatchObject({ text: 'LED 版型：版型 2（3840×1000）', canToggle: false });
  });
  it('專案根本沒有自己排的版型（或舊的後台）→ 不顯示', () => {
    const onlyFull: LedTemplateList = { fullCanvas: FULL, templates: [tpl('全部', FULL, 'full')], screens: [] };
    expect(ledTemplateChip({ plan: null, origin: 'none' }, { list: onlyFull, songPlan: null, source: 'ndi' })).toBeNull();
    expect(ledTemplateChip({ plan: null, origin: 'none' }, { list: null, songPlan: null, source: 'ndi' })).toBeNull();
  });
  it('字裡沒有英文叫人的字、沒有 emoji', () => {
    const all = [
      ledTemplateChip(chooseLedTemplate({ source: 'ndi', songPlan: song }), { ...base, source: 'ndi' }),
      ledTemplateChip(chooseLedTemplate({ source: 'ndi', songPlan: song, fullView: true }), { ...base, source: 'ndi' }),
      ledTemplateChip(chooseLedTemplate({ source: 'file', songPlan: null }), { list: LIST, songPlan: null, source: 'file' }),
    ].flatMap(c => [c?.text ?? '', c?.title ?? '']).join('\n');
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('fitsCanvas：剛好一樣大 / 等比例縮放', () => {
  const c = { width: 1920, height: 1080 };
  it('一樣大、一半、兩倍都算', () => {
    expect(fitsCanvas({ width: 1920, height: 1080 }, c)).toBe(true);
    expect(fitsCanvas({ width: 960, height: 540 }, c)).toBe(true);
    expect(fitsCanvas({ width: 3840, height: 2160 }, c)).toBe(true);
  });
  it('比例不同不算', () => {
    expect(fitsCanvas({ width: 8800, height: 2024 }, c)).toBe(false);
  });
  it('AE 即時縮過的畫面差一兩個像素：寬鬆比對（寬高比差 3% 內）才算', () => {
    const odd = { width: 1281, height: 720 };   // 2/3 倍但寬多 1，嚴格比對差 < 1 像素仍算
    expect(fitsCanvas(odd, c)).toBe(true);
    const off = { width: 1300, height: 720 };   // 寬高比差約 1.4%
    expect(fitsCanvas(off, c)).toBe(false);
    expect(fitsCanvas(off, c, true)).toBe(true);
    expect(fitsCanvas({ width: 1400, height: 720 }, c, true)).toBe(false);
  });
  it('大小是 0 或畫布是 0（還沒收到畫面）→ 不算', () => {
    expect(fitsCanvas({ width: 0, height: 0 }, c)).toBe(false);
    expect(fitsCanvas({ width: 1920, height: 1080 }, { width: 0, height: 0 })).toBe(false);
  });
});

describe('liveSourceHint：畫面大小跟版型對不上時的提示', () => {
  const song = chooseLedTemplate({ source: 'file', songPlan: T1 });
  const common = { fullCanvas: FULL, templates: [T1, T2] };

  it('檔案是版型畫布的大小或等比例縮放 → 沒事', () => {
    expect(liveSourceHint({ ...common, choice: song, source: 'file', frame: { width: 1920, height: 1080 } })).toBeNull();
    expect(liveSourceHint({ ...common, choice: song, source: 'file', frame: { width: 960, height: 540 } })).toBeNull();
  });
  it('檔案是整張畫布的大小，但這首歌用版型 → 提醒（點名版型和大小，說可以暫時用整張畫布看）', () => {
    const h = liveSourceHint({ ...common, choice: song, source: 'file', frame: { width: 8800, height: 2024 } });
    expect(h?.kind).toBe('full');
    expect(h?.level).toBe('warn');
    expect(h?.text).toContain('整張畫布的大小');
    expect(h?.text).toContain('「版型 1」');
    expect(h?.text).toContain('1920×1080');
    expect(h?.text).toContain('暫時用整張畫布看');
    expect(h?.text).toContain('檔案');
  });
  it('AE 的畫面叫「畫面」，縮小過的整張畫布也認得出來', () => {
    // Half：4400×1012 是整張畫布的 50%
    const h = liveSourceHint({ ...common, choice: song, source: 'ndi', frame: { width: 4400, height: 1012 } });
    expect(h?.kind).toBe('full');
    expect(h?.text).toContain('這個畫面');
  });
  it('大小像另一個版型 → 提醒是不是選錯', () => {
    const h = liveSourceHint({ ...common, choice: song, source: 'file', frame: { width: 3840, height: 1000 } });
    expect(h?.kind).toBe('other');
    expect(h?.text).toContain('「版型 2」');
    expect(h?.text).toContain('「版型 1」');
  });
  it('跟誰都對不上 → 說會變形', () => {
    const wide = liveSourceHint({ ...common, choice: song, source: 'file', frame: { width: 2000, height: 600 } });
    expect(wide?.kind).toBe('stretch');
    expect(wide?.text).toContain('變形');
    expect(wide?.text).toContain('1920×1080');
  });
  it('還不知道畫面大小 / 沒在照版型放（整張畫布、暫時用整張畫布看、影片版本、版型面板）→ 不提示', () => {
    const frame = { width: 8800, height: 2024 };
    expect(liveSourceHint({ ...common, choice: song, source: 'file', frame: null })).toBeNull();
    expect(liveSourceHint({ ...common, choice: { plan: null, origin: 'none' }, source: 'file', frame })).toBeNull();
    expect(liveSourceHint({ ...common, choice: { plan: null, origin: 'override' }, source: 'ndi', frame })).toBeNull();
    expect(liveSourceHint({ ...common, choice: chooseLedTemplate({ source: 'version', versionPlan: T1 }), source: 'version', frame })).toBeNull();
    expect(liveSourceHint({ ...common, choice: chooseLedTemplate({ source: 'ndi', previewPlan: T1, songPlan: T1 }), source: 'ndi', frame })).toBeNull();
  });
  it('專案還沒填 LED 畫布大小（fullCanvas = null）：不會誤報成「整張畫布」', () => {
    const h = liveSourceHint({ choice: song, source: 'file', frame: { width: 8800, height: 2024 }, fullCanvas: null, templates: [T1] });
    expect(h?.kind).toBe('stretch');
  });
  it('版型畫布剛好等比例於整張畫布：以版型為準，不吵', () => {
    const same = tpl('一半', { width: 4400, height: 1012 });
    const choice = chooseLedTemplate({ source: 'file', songPlan: same });
    expect(liveSourceHint({ choice, source: 'file', frame: FULL, fullCanvas: FULL, templates: [same] })).toBeNull();
  });
  it('提示的字沒有英文叫人的字、沒有 emoji', () => {
    const frames = [{ width: 8800, height: 2024 }, { width: 3840, height: 1000 }, { width: 2000, height: 600 }];
    const all = frames.map(frame => liveSourceHint({ ...common, choice: song, source: 'file', frame })?.text ?? '').join('\n');
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
