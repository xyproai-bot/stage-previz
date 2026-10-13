import { describe, it, expect } from 'vitest';
import { labelSteps, planToolbar, rowWidth, type ToolbarPlanItem, type ToolbarPlanOptions } from './toolbarLayout';

const ALL = Infinity, NONE = -1, PINNED = 0;

const OPTS = { gap: 4, separator: 5, more: 32 };

// 管理頁的工具列（寬度大約照實際量到的）
const editor: ToolbarPlanItem[] = [
  { id: 'move', group: 'edit', priority: 0, labeled: 62, compact: 32 },
  { id: 'rotate', group: 'edit', priority: 0, labeled: 62, compact: 32 },
  { id: 'space', group: 'edit', priority: 2, labeled: 62, compact: 32 },
  { id: 'render', group: 'look', priority: 0, labeled: 62, compact: 32 },
  { id: 'look', group: 'look', priority: 1, labeled: 62, compact: 32 },
  { id: 'material', group: 'look', priority: 3, labeled: 62, compact: 32 },
  { id: 'wire', group: 'look', priority: 5, labeled: 62, compact: 32 },
  { id: 'scale', group: 'show', priority: 6, labeled: 74, compact: 32 },
  { id: 'labels', group: 'show', priority: 2, labeled: 62, compact: 32 },
  { id: 'reset', group: 'camera', priority: 0, labeled: 32, compact: 32 },
  { id: 'home', group: 'camera', priority: 4, labeled: 22, compact: 22 },
  { id: 'walk', group: 'camera', priority: 6, labeled: 62, compact: 32 },
  { id: 'views', group: 'camera', priority: 3, labeled: 62, compact: 32 },
  { id: 'measure', group: 'mark', priority: 4, labeled: 62, compact: 32 },
  { id: 'ndi', group: 'status', priority: 0, labeled: 80, compact: 80, noSepBefore: true },
  { id: 'cue', group: 'status', priority: 3.5, labeled: 240, compact: 240, flexMin: 90, flexCompactMin: 64, noSepBefore: true },
];

const opts = (available: number, alwaysMore = true): ToolbarPlanOptions => ({ ...OPTS, available, alwaysMore });

describe('rowWidth', () => {
  it('間距、分隔線、更多按鈕都算進去', () => {
    const items: ToolbarPlanItem[] = [
      { id: 'a', group: 'g1', priority: 0, labeled: 50, compact: 30 },
      { id: 'b', group: 'g1', priority: 1, labeled: 50, compact: 30 },
      { id: 'c', group: 'g2', priority: 1, labeled: 50, compact: 30 },
    ];
    // 50 + 4 + 50 + (4 + 5 + 4) + 50 = 167；更多：+4 +32
    expect(rowWidth(items, ALL, false, OPTS)).toBe(167);
    expect(rowWidth(items, ALL, true, OPTS)).toBe(203);
    // 只剩圖示：30 + 4 + 30 + 13 + 30 = 107
    expect(rowWidth(items, NONE, false, OPTS)).toBe(107);
    // 只有 a（priority 0）帶字
    expect(rowWidth(items, PINNED, false, OPTS)).toBe(127);
  });
  it('noSepBefore 的那組前面不加分隔線', () => {
    const items: ToolbarPlanItem[] = [
      { id: 'a', group: 'g1', priority: 0, labeled: 50, compact: 30 },
      { id: 's', group: 'status', priority: 0, labeled: 80, compact: 80, noSepBefore: true },
    ];
    expect(rowWidth(items, ALL, false, OPTS)).toBe(134);
  });
  it('空的只剩更多按鈕', () => {
    expect(rowWidth([], ALL, true, OPTS)).toBe(32);
    expect(rowWidth([], ALL, false, OPTS)).toBe(0);
  });
});

describe('planToolbar', () => {
  it('夠寬：全部帶字，cue 名字拿剩下的空間（最多到原本的寬度）', () => {
    const p = planToolbar(editor, opts(2000));
    expect(p.labelUpTo).toBe(ALL);
    expect(p.overflow).toEqual([]);
    expect(p.visible).toHaveLength(editor.length);
    expect(p.showMore).toBe(true);
    expect(p.flexWidth.cue).toBe(240);
    expect(p.overfull).toBe(false);
  });

  it('選單沒有固定內容又放得下 → 不顯示更多', () => {
    const p = planToolbar(editor, opts(2000, false));
    expect(p.showMore).toBe(false);
  });

  it('要試的順序：全部帶字 → 從最不常用的開始拿掉字 → 全部只剩圖示', () => {
    expect(labelSteps(editor)).toEqual([ALL, 5, 4, 3.5, 3, 2, 1, 0, NONE]);
  });

  it('全部帶字放不下 → 先拿掉最不常用的字（漫遊、比例尺），常用的字留著', () => {
    const full = rowWidth(editor, ALL, true, OPTS);
    const step5 = rowWidth(editor, 5, true, OPTS);
    expect(step5).toBeLessThan(full);
    const p = planToolbar(editor, opts(step5));
    expect(p.labelUpTo).toBe(5);
    expect(p.overflow).toEqual([]);
  });

  it('再窄 → 只剩一定要看得到的帶字；cue 名字分到剩下的空間', () => {
    const pinned = rowWidth(editor, PINNED, true, OPTS);
    const p = planToolbar(editor, opts(pinned + 10));
    expect(p.labelUpTo).toBe(PINNED);
    expect(p.overflow).toEqual([]);
    expect(p.flexWidth.cue).toBe(64 + 10);
  });

  it('再窄 → 全部只剩圖示', () => {
    const none = rowWidth(editor, NONE, true, OPTS);
    const p = planToolbar(editor, opts(none));
    expect(p.labelUpTo).toBe(NONE);
    expect(p.overflow).toEqual([]);
  });

  it('還是放不下 → 照 priority 從大到小收；同樣大的先收後面的', () => {
    const none = rowWidth(editor, NONE, true, OPTS);
    // 少 1px：要收一個，priority 最大的是 scale（6）和 walk（6）→ 排在後面的 walk 先收
    const p1 = planToolbar(editor, opts(none - 1));
    expect(p1.overflow).toEqual(['walk']);
    // 再少一點（走掉一個 32 + 4）→ 接著收 scale
    const p2 = planToolbar(editor, opts(none - 37));
    expect(p2.overflow).toEqual(['scale', 'walk']);
    expect(p2.labelUpTo).toBe(NONE);
  });

  it('收的時候分隔線也跟著少（整組收完那條線就不見了）', () => {
    const items: ToolbarPlanItem[] = [
      { id: 'a', group: 'g1', priority: 0, labeled: 30, compact: 30 },
      { id: 'b', group: 'g2', priority: 1, labeled: 30, compact: 30 },
      { id: 'c', group: 'g3', priority: 0, labeled: 30, compact: 30 },
    ];
    // 三個都在：30 + 13 + 30 + 13 + 30 + 4 + 32 = 152
    expect(rowWidth(items, NONE, true, OPTS)).toBe(152);
    // 收掉 b：g2 整組不見，只剩一條分隔線 → 30 + 13 + 30 + 36 = 109（還留兩條線的話要 122）
    const p = planToolbar(items, opts(109));
    expect(p.visible).toEqual(['a', 'c']);
    expect(p.overflow).toEqual(['b']);
    expect(p.overfull).toBe(false);
  });

  it('很窄（手機）：只剩一定要看得到的 + 更多，cue 名字藏起來', () => {
    // 一定要看得到的 + 「現場設定」剛好 314px；300px 就只剩一定要看得到的
    expect(planToolbar(editor, opts(314)).visible).toEqual(['move', 'rotate', 'render', 'look', 'reset', 'ndi']);
    const p = planToolbar(editor, opts(300));
    expect(p.visible).toEqual(['move', 'rotate', 'render', 'reset', 'ndi']);
    expect(p.overflow).toContain('cue');
    expect(p.overflow).toContain('look');
    expect(p.showMore).toBe(true);
    expect(p.overfull).toBe(false);
  });

  it('cue 名字在 priority 3.5：比 3 以下的工具晚收、比 4 以上的早收', () => {
    // 把 priority > 3.5 的都收掉後剛好放得下 → cue 還在
    const keep = editor.filter(i => i.priority <= 3.5);
    const w = rowWidth(keep, NONE, true, OPTS);
    const p = planToolbar(editor, opts(w));
    expect(p.visible).toContain('cue');
    expect(p.overflow.sort()).toEqual(['home', 'measure', 'scale', 'walk', 'wire'].sort());
    // 少 1px → 接著收 cue
    const p2 = planToolbar(editor, opts(w - 1));
    expect(p2.overflow).toContain('cue');
    expect(p2.visible).toContain('material');
  });

  it('連一定要看得到的都放不下 → 不會收它們，回報 overfull', () => {
    const p = planToolbar(editor, opts(100));
    expect(p.visible).toEqual(['move', 'rotate', 'render', 'reset', 'ndi']);
    expect(p.overfull).toBe(true);
  });

  it('只看模式（動畫師 / 分享）：重置攝影機 + AE 即時 + cue，手機也放得下', () => {
    const viewer: ToolbarPlanItem[] = [
      { id: 'reset', group: 'camera', priority: 0, labeled: 32, compact: 32 },
      { id: 'ndi', group: 'status', priority: 0, labeled: 90, compact: 90, noSepBefore: true },
      { id: 'cue', group: 'status', priority: 3.5, labeled: 200, compact: 200, flexMin: 90, flexCompactMin: 64, noSepBefore: true },
    ];
    const p = planToolbar(viewer, opts(375 - 34));
    expect(p.labelUpTo).toBe(ALL);
    expect(p.overflow).toEqual([]);
    // 341 - (32 + 4 + 90 + 4 + 4 + 32) = 175
    expect(p.flexWidth.cue).toBe(175);
    expect(planToolbar(viewer, opts(600)).flexWidth.cue).toBe(200);
    const narrow = planToolbar(viewer, opts(240));
    expect(narrow.visible).toContain('cue');
    expect(narrow.flexWidth.cue).toBeGreaterThanOrEqual(64);
  });

  it('伸縮項目最小寬度比原本還寬時用原本的寬度', () => {
    const items: ToolbarPlanItem[] = [
      { id: 'cue', group: 's', priority: 1, labeled: 40, compact: 40, flexMin: 90, flexCompactMin: 64 },
    ];
    const p = planToolbar(items, opts(500));
    expect(p.flexWidth.cue).toBe(40);
  });
});
