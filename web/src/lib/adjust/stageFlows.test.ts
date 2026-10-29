import { describe, expect, it, vi } from 'vitest';
import type { CueMechanismPosition } from '../mechanisms/model';
import { createStageFlows, type StageFlowDeps } from './stageFlows';
import type { StageApiError, StageMechRow } from './stageApi';

const rows: CueMechanismPosition[] = [
  { cueId: 'c1', mechanismId: 'm1', value: 1, delaySec: 0.5, durationSec: 2, updatedAt: '', libraryCueId: 'lc30' },
  { cueId: 'c1', mechanismId: 'm2', value: 90, carried: true, updatedAt: '', libraryCueId: 'lc30' },
  { cueId: 'c9', mechanismId: 'm1', value: 7, updatedAt: '', libraryCueId: 'lc99' },
];
const usage = {
  slots: [
    { cueId: 'a', songId: 's5', songName: '開場', songCode: 'S05', videoTimeSec: 1 },
    { cueId: 'b', songId: 's12', songName: '副歌', songCode: 'S12', videoTimeSec: 1 },
  ],
};
const sentRows: StageMechRow[] = [
  { mechanismId: 'm1', value: 2.5, delaySec: 0.5, durationSec: 2, carried: false },
  { mechanismId: 'm2', value: 90, delaySec: null, durationSec: null, carried: true },
];

function conflictError(msg = '這個 cue 剛剛被 王導 改過'): StageApiError {
  const e = new Error(msg) as StageApiError;
  e.status = 409;
  e.data = { error: msg, conflict: true, rev: 4, changedBy: { id: 'u1', name: '王導' } };
  return e;
}

function setup(over: Partial<StageFlowDeps> = {}, draft: Record<string, number> = { m1: 2.5 }) {
  const order: string[] = [];
  const track = <T>(name: string, v: T) => { order.push(name); return v; };
  const store = {
    saveTarget: vi.fn(() => ({ cueId: 'c1', cueName: '副歌全開', libraryCueId: 'lc30', libraryLabel: '30', baseRev: 3 })),
    changedCount: vi.fn(() => Object.keys(draft).length),
    discardAll: vi.fn(),
    getState: () => ({ draft }),
  };
  const api = {
    saveStagePositions: vi.fn(async () => track('save', { ok: true as const, rev: 4, previous: { rev: 3, mechanisms: [{ mechanismId: 'm1', value: 1, delaySec: 0.5, durationSec: 2, carried: false }] }, songs: [{ id: 's5', name: '開場', code: 'S05' }, { id: 's12', name: '副歌', code: 'S12' }], changed: 1, notified: 3 })),
    saveStageAs: vi.fn(async () => track('saveAs', { libraryCue: { id: 'lc_new', label: '30-1', name: 'x', basedOnId: 'lc30', rev: 0, crossfadeSeconds: 1 }, slot: { id: 'c1', songId: 's1', libraryCueId: 'lc_new' }, song: { id: 's1', name: '歌', code: null }, notified: 2 })),
    copyStageCue: vi.fn(async () => ({ libraryCue: { id: 'lc_copy', label: '30-2', name: 'x', basedOnId: 'lc30', rev: 0, crossfadeSeconds: 1 } })),
    patchStageCue: vi.fn(async () => ({})),
    setSlotStageCrossfade: vi.fn(async () => ({})),
    getLibraryCueUsage: vi.fn(async () => track('usage', usage)),
  };
  const ui = {
    confirm: vi.fn(async (_o: unknown): Promise<boolean> => track('confirm', true)),
    prompt: vi.fn(async (_o: unknown): Promise<string | null> => '  我的版本  '),
    choose: vi.fn(async (_o: unknown): Promise<string | null> => 'reload'),
    toast: { success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    notice: vi.fn(),
  };
  const reloadPositions = vi.fn(async () => track('reloadPositions', true));
  const reloadCues = vi.fn(async () => { track('reloadCues', 0); });
  const deps: StageFlowDeps = {
    projectId: 'p1', song: { id: 's1', name: '歌', code: 'S01' },
    cue: { id: 'c1', name: '副歌全開', crossfadeSeconds: 1.5, crossfadeOwn: false, libraryCrossfadeSeconds: 1.5, libraryCueId: 'lc30', libraryCue: { id: 'lc30', label: '30', name: '副歌全開' } },
    store, positionRows: rows, reloadPositions, reloadCues, api, ui, ...over,
  };
  return { flows: createStageFlows(() => deps), store, api, ui, reloadPositions, reloadCues, order, deps };
}

describe('存回 Cue 庫', () => {
  it('先列出哪些歌會一起變 → 問 → 帶開始調時的版本存整份 → 讀回最新的 → 綠色提示（可以復原）', async () => {
    const { flows, api, ui, order, reloadPositions } = setup();
    await flows.saveBack();
    expect(api.getLibraryCueUsage).toHaveBeenCalledWith('p1', 'lc30');
    const ask = ui.confirm.mock.calls[0][0] as { title: string; message: string; confirmLabel: string };
    expect(ask.title).toBe('存回 cue 30？');
    expect(ask.message).toBe('這些歌會一起變：S05、S12。\n改了 1 個機關的位置；物件的位置和顯示都不會動。');
    expect(ask.confirmLabel).toBe('存回');
    expect(api.saveStagePositions).toHaveBeenCalledWith('p1', 'lc30', { ifRev: 3, mechanisms: sentRows, songId: 's1' });
    expect(order).toEqual(['usage', 'confirm', 'save', 'reloadPositions']);
    expect(reloadPositions).toHaveBeenCalledTimes(1);
    const [text, undo] = ui.notice.mock.calls[0];
    expect(text).toBe('已存回 cue 30（改了 1 個機關，S05、S12 會一起變）');
    expect(typeof undo).toBe('function');
  });
  it('只送這個 Cue 庫的 cue 的列（別的 cue 的列不會混進來）', async () => {
    const { flows, api } = setup();
    await flows.saveBack();
    const sent = (api.saveStagePositions.mock.calls[0] as unknown as [string, string, { mechanisms: StageMechRow[] }])[2].mechanisms;
    expect(sent.map(r => r.mechanismId)).toEqual(['m1', 'm2']);
    expect(sent.find(r => r.mechanismId === 'm1')!.value).toBe(2.5);
  });
  it('按取消 → 什麼都不存', async () => {
    const { flows, api, ui } = setup();
    ui.confirm.mockResolvedValueOnce(false);
    await flows.saveBack();
    expect(api.saveStagePositions).not.toHaveBeenCalled();
    expect(ui.notice).not.toHaveBeenCalled();
  });
  it('讀不到哪些歌在用 → 說一聲、不存', async () => {
    const { flows, api, ui } = setup();
    api.getLibraryCueUsage.mockRejectedValueOnce(new Error('x'));
    await flows.saveBack();
    expect(ui.toast.error).toHaveBeenCalledWith('讀不到哪些歌在用這個 cue，先不存（網路有問題？）。');
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(api.saveStagePositions).not.toHaveBeenCalled();
  });
  it('沒有改動、cue 沒指到 Cue 庫、後台沒給版本 → 不存', async () => {
    const none = setup({}, {});
    await none.flows.saveBack();
    expect(none.api.getLibraryCueUsage).not.toHaveBeenCalled();
    const noLib = setup();
    noLib.store.saveTarget.mockReturnValue({ cueId: 'c1', cueName: 'x', libraryCueId: null as unknown as string, libraryLabel: null as unknown as string, baseRev: 1 });
    await noLib.flows.saveBack();
    expect(noLib.ui.toast.warn).toHaveBeenCalledWith('這個 cue 還沒有指到 Cue 庫，沒辦法存（請製作先處理）。');
    const old = setup();
    old.store.saveTarget.mockReturnValue({ cueId: 'c1', cueName: 'x', libraryCueId: 'lc30', libraryLabel: '30', baseRev: null as unknown as number });
    await old.flows.saveBack();
    expect(old.ui.toast.warn).toHaveBeenCalledWith('後台還沒更新，這一版先不能存（可以先預覽）。');
    for (const s of [noLib, old]) expect(s.api.saveStagePositions).not.toHaveBeenCalled();
  });
  it('跟存的一樣（沒有東西要存）→ 說一聲、草稿清掉', async () => {
    const { flows, api, ui, store } = setup();
    api.saveStagePositions.mockResolvedValueOnce({ ok: true, unchanged: true, rev: 3, songs: [], changed: 0, notified: 0 } as never);
    await flows.saveBack();
    expect(ui.toast.info).toHaveBeenCalledWith('跟存的一樣，沒有東西要存。');
    expect(store.discardAll).toHaveBeenCalled();
    expect(ui.notice).not.toHaveBeenCalled();
  });
  it('位置讀不回來 → 還是存好了，提醒一下', async () => {
    const { flows, ui, reloadPositions } = setup();
    reloadPositions.mockResolvedValueOnce(false);
    await flows.saveBack();
    expect(ui.toast.warn).toHaveBeenCalledWith('已經存好了，但畫面還沒更新到最新，過幾秒會自動更新。');
    expect(ui.notice).toHaveBeenCalled();
  });
  it('其他錯誤（沒有權限、網路…）往外丟，由畫面用白話跳出來', async () => {
    const { flows, api } = setup();
    api.saveStagePositions.mockRejectedValueOnce(Object.assign(new Error('只有導演或製作可以調整舞台'), { status: 403, data: {} }));
    await expect(flows.saveBack()).rejects.toThrow('只有導演或製作可以調整舞台');
  });
});

describe('衝突：存的時候這個 cue 剛剛被別人改過', () => {
  it('提示列已經說「被別人改過」（stale）→ 不用再問「要存嗎」，直接問後台是誰改的、跳說明', async () => {
    const { flows, api, ui, store } = setup();
    (store as unknown as { getState: () => { draft: Record<string, number>; stale: boolean } }).getState = () => ({ draft: { m1: 2.5 }, stale: true });
    api.saveStagePositions.mockRejectedValueOnce(conflictError());
    await flows.saveBack();
    expect(api.getLibraryCueUsage).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect((ui.choose.mock.calls[0][0] as { title: string }).title).toBe('這個 cue 剛剛被 王導 改過');
  });
  it('跳說明（寫是被誰改的）；重新載入 = 放棄草稿、讀最新的', async () => {
    const { flows, api, ui, store, reloadPositions } = setup();
    api.saveStagePositions.mockRejectedValueOnce(conflictError());
    await flows.saveBack();
    const o = ui.choose.mock.calls[0][0] as { title: string; message: string; cancelLabel: string; choices: { value: string; label: string; primary?: boolean }[] };
    expect(o.title).toBe('這個 cue 剛剛被 王導 改過');
    expect(o.message).toContain('你調的還沒有存進去');
    expect(o.choices).toEqual([{ value: 'reload', label: '重新載入', primary: true }, { value: 'saveAs', label: '另存成新 cue' }]);
    expect(o.cancelLabel).toBe('先不要');
    expect(store.discardAll).toHaveBeenCalled();
    expect(reloadPositions).toHaveBeenCalledTimes(2);     // 一次是搶先讀最新的、一次是重新載入
    expect(ui.toast.info).toHaveBeenCalledWith('已重新載入，這個 cue 現在是最新的樣子。');
    expect(ui.notice).not.toHaveBeenCalled();
  });
  it('選「另存成新 cue」→ 把你調的存成新的，原本的不動', async () => {
    const { flows, api, ui, store } = setup();
    api.saveStagePositions.mockRejectedValueOnce(conflictError('這個 cue 剛剛被別人改過'));
    ui.choose.mockResolvedValueOnce('saveAs');
    await flows.saveBack();
    expect(api.saveStageAs).toHaveBeenCalledWith('p1', 'lc30', { name: '我的版本', mechanisms: sentRows, songId: 's1', cueId: 'c1' });
    expect(store.discardAll).not.toHaveBeenCalled();
    expect(ui.notice.mock.calls.at(-1)![0]).toBe('已另存成 cue 30-1，這首歌改用它');
  });
  it('選「先不要」→ 草稿留著，不放棄', async () => {
    const { flows, api, ui, store } = setup();
    api.saveStagePositions.mockRejectedValueOnce(conflictError());
    ui.choose.mockResolvedValueOnce(null);
    await flows.saveBack();
    expect(store.discardAll).not.toHaveBeenCalled();
    expect(api.saveStageAs).not.toHaveBeenCalled();
  });
});

describe('復原', () => {
  it('用後台回的上一版、新的版本再存一次，讀回來，寫「已復原」', async () => {
    const { flows, api, ui, reloadPositions } = setup();
    await flows.saveBack();
    const undo = ui.notice.mock.calls[0][1] as () => Promise<void>;
    api.saveStagePositions.mockClear();
    reloadPositions.mockClear();
    ui.notice.mockClear();
    await undo();
    expect(api.saveStagePositions).toHaveBeenCalledWith('p1', 'lc30', {
      ifRev: 4, mechanisms: [{ mechanismId: 'm1', value: 1, delaySec: 0.5, durationSec: 2, carried: false }], songId: 's1', undo: true,
    });
    expect(reloadPositions).toHaveBeenCalledTimes(1);
    expect(ui.notice).toHaveBeenCalledWith('已復原 cue 30');
  });
  it('復原的時候又被別人改過 → 不能復原，說清楚、提示收掉', async () => {
    const { flows, api, ui } = setup();
    await flows.saveBack();
    const undo = ui.notice.mock.calls[0][1] as () => Promise<void>;
    api.saveStagePositions.mockRejectedValueOnce(conflictError());
    ui.notice.mockClear();
    await undo();
    expect(ui.toast.error).toHaveBeenCalledWith('這個 cue 剛剛被 王導 改過，沒辦法復原。重新載入再調吧。');
    expect(ui.notice).toHaveBeenCalledWith(null);
  });
});

describe('另存成新 cue', () => {
  it('預設名字「原名（導演改）」；名字去掉前後空白；存完讀回 cue 和位置', async () => {
    const { flows, api, ui, reloadCues, reloadPositions } = setup();
    await flows.saveAs();
    const o = ui.prompt.mock.calls[0][0] as { title: string; defaultValue: string; hint: string; confirmLabel: string };
    expect(o.title).toBe('另存成新 cue');
    expect(o.defaultValue).toBe('副歌全開（導演改）');
    expect(o.hint).toContain('只有這首歌的這個 cue 會換成新的');
    expect(api.saveStageAs).toHaveBeenCalledWith('p1', 'lc30', { name: '我的版本', mechanisms: sentRows, songId: 's1', cueId: 'c1' });
    expect(reloadCues).toHaveBeenCalledTimes(1);
    expect(reloadPositions).toHaveBeenCalledTimes(1);
    expect(ui.notice).toHaveBeenCalledWith('已另存成 cue 30-1，這首歌改用它');
  });
  it('取消 / 空白名字 → 不存', async () => {
    const a = setup();
    a.ui.prompt.mockResolvedValueOnce(null);
    await a.flows.saveAs();
    const b = setup();
    b.ui.prompt.mockResolvedValueOnce('   ');
    await b.flows.saveAs();
    expect(a.api.saveStageAs).not.toHaveBeenCalled();
    expect(b.api.saveStageAs).not.toHaveBeenCalled();
  });
});

describe('複製、改名、轉場秒數', () => {
  it('複製：預設名字「原名（複製）」；有還沒存的改動時說「不會一起複製」', async () => {
    const { flows, api, ui } = setup();
    await flows.copy();
    const o = ui.prompt.mock.calls[0][0] as { title: string; defaultValue: string; hint: string };
    expect(o.title).toBe('複製 cue 30');
    expect(o.defaultValue).toBe('副歌全開（複製）');
    expect(o.hint).toContain('還沒存的不會一起複製');
    expect(api.copyStageCue).toHaveBeenCalledWith('p1', 'lc30', { name: '我的版本' });
    expect(ui.toast.success).toHaveBeenCalledWith('已複製成 cue 30-2（放進 Cue 庫了，還沒放進任何一首歌）');
    const clean = setup({}, {});
    await clean.flows.copy();
    expect((clean.ui.prompt.mock.calls[0][0] as { hint: string }).hint).not.toContain('還沒存');
  });
  it('改名：只送名字；沒改就不送；存完讀回 cue', async () => {
    const { flows, api, ui, reloadCues } = setup();
    await flows.rename();
    expect(api.patchStageCue).toHaveBeenCalledWith('p1', 'lc30', { name: '我的版本', songId: 's1' });
    expect(reloadCues).toHaveBeenCalledTimes(1);
    expect(ui.toast.success).toHaveBeenCalledWith('cue 30 改名成「我的版本」');
    const same = setup();
    same.ui.prompt.mockResolvedValueOnce('副歌全開');
    await same.flows.rename();
    expect(same.api.patchStageCue).not.toHaveBeenCalled();
  });
  it('沒選到 cue / 沒指到 Cue 庫 → 說一聲', async () => {
    const { flows, ui, api } = setup({ cue: null });
    await flows.copy(); await flows.rename(); await flows.seconds();
    expect(ui.toast.warn).toHaveBeenCalledTimes(3);
    expect(ui.prompt).not.toHaveBeenCalled();
    expect(api.copyStageCue).not.toHaveBeenCalled();
  });
  it('轉場秒數（用 Cue 庫的）：先列出受影響的歌，改的是 Cue 庫的', async () => {
    const { flows, api, ui } = setup();
    ui.prompt.mockResolvedValueOnce('2.5');
    await flows.seconds();
    const o = ui.prompt.mock.calls[0][0] as { title: string; defaultValue: string; hint: string; validate: (v: string) => string | null };
    expect(o.title).toBe('改 cue 30 的轉場秒數');
    expect(o.defaultValue).toBe('1.5');
    expect(o.hint).toBe('改的是 cue 30 的轉場（Cue 庫的），這些歌會一起變：S05、S12。');
    expect(o.validate('abc')).not.toBeNull();
    expect(o.validate('2')).toBeNull();
    expect(api.patchStageCue).toHaveBeenCalledWith('p1', 'lc30', { crossfadeSeconds: 2.5, songId: 's1' });
    expect(api.setSlotStageCrossfade).not.toHaveBeenCalled();
    expect(ui.toast.success).toHaveBeenCalledWith('cue 30 的轉場改成 2.5 秒（用到的歌一起變）');
  });
  it('轉場秒數（這首歌自己設了）：寫「這首歌自己設了 3 秒」，改的是這首歌自己的', async () => {
    const own = { id: 'c1', name: '副歌全開', crossfadeSeconds: 3, crossfadeOwn: true, libraryCrossfadeSeconds: 1.5, libraryCueId: 'lc30', libraryCue: { id: 'lc30', label: '30', name: '副歌全開' } };
    const { flows, api, ui } = setup({ cue: own });
    ui.prompt.mockResolvedValueOnce('4');
    await flows.seconds();
    const o = ui.prompt.mock.calls[0][0] as { title: string; defaultValue: string; hint: string };
    expect(o.title).toBe('改這首歌的轉場秒數（cue 30）');
    expect(o.defaultValue).toBe('3');
    expect(o.hint).toContain('這首歌自己設了 3 秒');
    expect(api.getLibraryCueUsage).not.toHaveBeenCalled();
    expect(api.setSlotStageCrossfade).toHaveBeenCalledWith('p1', 's1', 'c1', 4);
    expect(api.patchStageCue).not.toHaveBeenCalled();
    expect(ui.toast.success).toHaveBeenCalledWith('這首歌的 cue 30 轉場改成 4 秒');
  });
  it('秒數沒變 / 取消 / 打錯 → 不送', async () => {
    for (const answer of ['1.5', null, 'abc']) {
      const { flows, api, ui } = setup();
      ui.prompt.mockResolvedValueOnce(answer);
      await flows.seconds();
      expect(api.patchStageCue).not.toHaveBeenCalled();
      expect(api.setSlotStageCrossfade).not.toHaveBeenCalled();
    }
  });
});
