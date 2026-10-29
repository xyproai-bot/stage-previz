import { describe, expect, it } from 'vitest';
import type { Mechanism } from '../mechanisms/model';
import { AdjustStore, type AdjustCueContext } from './store';

// 測試用的小舞台（數字是編的）：
//   一排 4 個沿弧形軌道的橫移 s0..s3，各帶一個自轉 r0..r3，自轉帶 LED 物件 o0..o3（鏈 = [r_i, s_i]）
//   一個升降 lift 帶平台 plat；一組吊掛 rig（兩個吊點 hL、hR）帶提詞 LED prompter
function mech(p: Partial<Mechanism> & { id: string }): Mechanism {
  return {
    name: p.id, kind: 'linear', axis: { x: 1, y: 0, z: 0 }, pivot: null, travelMin: -5, travelMax: 5, defaultValue: 0,
    maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0, metadata: null, cueCount: 0,
    updatedAt: '', variant: null, mirror: null, objectSides: {}, groupId: null, groupIndex: null, rigId: null, rigIndex: null,
    attach: null, arcRadius: null, ...p,
  };
}
const defs: Mechanism[] = [
  ...[0, 1, 2, 3].map(i => mech({
    id: `s${i}`, name: `橫移 ${i + 1}`, variant: 'arc', arcRadius: 10, pivot: { x: 0, y: 0, z: 10 }, axis: { x: 0, y: 1, z: 0 },
    groupId: 'g', groupIndex: i, presets: [{ name: '原位置', value: 0 }],
  })),
  ...[0, 1, 2, 3].map(i => mech({
    id: `r${i}`, name: `自轉 ${i + 1}`, kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: i * 2 - 3, y: 0, z: 0 },
    travelMin: -360, travelMax: 360, parentId: `s${i}`, objectIds: [`o${i}`], groupId: 'gr', groupIndex: i,
    presets: [{ name: 'LED 面', value: 0 }, { name: '背面', value: 180 }],
  })),
  mech({ id: 'lift', name: '升降', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 2, objectIds: ['plat'], presets: [{ name: '升 2 m', value: 2 }] }),
  mech({ id: 'rig', name: '提詞 LED', variant: 'hoist_rig', objectIds: ['prompter'] }),
  mech({ id: 'hL', name: '左吊點', axis: { x: 0, y: 1, z: 0 }, variant: 'hoist', rigId: 'rig', rigIndex: 0, attach: { x: -1, y: 5, z: 20 }, travelMin: -6, travelMax: 2 }),
  mech({ id: 'hR', name: '右吊點', axis: { x: 0, y: 1, z: 0 }, variant: 'hoist', rigId: 'rig', rigIndex: 1, attach: { x: 1, y: 5, z: 20 }, travelMin: -6, travelMax: 2 }),
];
const saved = { s0: 0, s1: 0, s2: 0, s3: 0, r0: 0, r1: 0, r2: 0, r3: 0, lift: 0, hL: 0, hR: 0 };
const cue = (over: Partial<AdjustCueContext> = {}): AdjustCueContext => ({
  cueId: 'c2', cueName: '2', saved, prevName: '1', prevValues: { ...saved, r1: -90, lift: 1 }, seconds: 2, timings: {}, ...over,
});

function setup() {
  let t = 1000;
  const clock = { now: () => t, set: (v: number) => { t = v; } };
  const s = new AdjustStore(clock.now);
  s.setDefs(defs);
  s.setCue(cue());
  s.setHalves(g => (g === 'g' ? { left: ['s0', 's1'], right: ['s2', 's3'] } : g === 'gr' ? { left: ['r0', 'r1'], right: ['r2', 'r3'] } : null));
  s.enter({});
  return { s, clock };
}

describe('AdjustStore：開 / 關', () => {
  it('還沒開 → override 是 null（審片的畫面完全照舊）', () => {
    const s = new AdjustStore(() => 0);
    s.setDefs(defs);
    s.setCue(cue());
    expect(s.override()).toBeNull();
  });
  it('開了 → 3D 用存的值', () => {
    const { s } = setup();
    expect(s.override()).toMatchObject(saved);
    expect(s.getState().on).toBe(true);
  });
  it('關掉 → 草稿、選取都清掉，override 回到 null', () => {
    const { s } = setup();
    s.selectObject('plat');
    s.setValue('lift', 1);
    s.exit();
    expect(s.override()).toBeNull();
    expect(s.getState()).toMatchObject({ on: false, draft: {}, selection: null });
  });
});

describe('選東西、面板要畫的機關', () => {
  it('點 3D 物件 → 選到它的機關鏈（裡面的在前）', () => {
    const { s } = setup();
    expect(s.selectObject('o1')).toBe(true);
    expect(s.getState().selection).toEqual({ objectId: 'o1', mechId: 'r1' });
    expect(s.controls().map(c => (c.type === 'mech' ? c.id : c.rigId))).toEqual(['r1', 's1']);
  });
  it('沒有機關的物件 → 選不到', () => {
    const { s } = setup();
    expect(s.selectObject('floor')).toBe(false);
    expect(s.getState().selection).toBeNull();
  });
  it('從清單挑機關 → 選到它帶的（或裝在它上面的）物件', () => {
    const { s } = setup();
    expect(s.selectMechanism('s2')).toBe(true);
    expect(s.getState().selection).toEqual({ objectId: 'o2', mechId: 's2' });
    expect(s.selectMechanism('hR')).toBe(true);
    expect(s.getState().selection).toEqual({ objectId: 'prompter', mechId: 'hR' });
  });
  it('吊掛：一個「整組」控制，裡面是每個吊點（照編號）', () => {
    const { s } = setup();
    s.selectObject('prompter');
    const c = s.controls();
    expect(c).toHaveLength(1);
    expect(c[0].type === 'rig' && c[0].hoists.map(h => h.id)).toEqual(['hL', 'hR']);
  });
});

describe('改值：馬上看到、改了幾個、回到存的值', () => {
  it('滑桿 / 數字 → override 馬上變；改回一樣就不算改', () => {
    const { s } = setup();
    s.setValue('lift', 1.25);
    expect(s.override()!.lift).toBe(1.25);
    expect(s.changedCount()).toBe(1);
    s.setValue('lift', 0);
    expect(s.changedCount()).toBe(0);
  });
  it('不能超出行程；拖的時候對齊 0.1 m 和常用位置，Alt 不對齊', () => {
    const { s } = setup();
    s.beginDrag('lift');
    s.dragTo('lift', 9, false);
    expect(s.value('lift')).toBe(2);
    s.dragTo('lift', 1.234, false);
    expect(s.value('lift')).toBe(1.2);
    s.dragTo('lift', 1.9, false);
    expect(s.value('lift')).toBe(2);
    s.dragTo('lift', 1.234, true);
    expect(s.value('lift')).toBe(1.234);
    s.endDrag();
  });
  it('回到存的值（一個）/ 放棄全部', () => {
    const { s } = setup();
    s.setValue('lift', 1);
    s.setValue('r0', 90);
    s.revert(['lift']);
    expect(s.getState().draft).toEqual({ r0: 90 });
    s.discardAll();
    expect(s.changedCount()).toBe(0);
    expect(s.override()!.r0).toBe(0);
  });
  it('常用位置按鈕：範圍裡每個都到那個值', () => {
    const { s } = setup();
    s.setScope('gr', 'all');
    s.applyPreset('r1', 180);
    expect(['r0', 'r1', 'r2', 'r3'].map(id => s.value(id))).toEqual([180, 180, 180, 180]);
  });
});

describe('整組選', () => {
  it('整排一起：拖一個，每個加一樣的量（從開始拖的值算）', () => {
    const { s } = setup();
    s.setValue('s3', 4.5);
    s.selectObject('o1');
    s.setScope('g', 'all');
    s.beginDrag('s1');
    s.dragTo('s1', 1.04, false);
    expect(['s0', 's1', 's2', 's3'].map(id => s.value(id))).toEqual([1, 1, 1, 5]);
    s.dragTo('s1', 0.5, false);
    expect(['s0', 's1', 's2', 's3'].map(id => s.value(id))).toEqual([0.5, 0.5, 0.5, 5]);
    s.endDrag();
  });
  it('左半 / 右半；選的那個不在那一半 → 改選那一半的第一個', () => {
    const { s } = setup();
    s.selectObject('o1');
    s.setScope('g', 'left');
    expect(s.driveIds('s1')).toEqual(['s0', 's1']);
    s.setScope('g', 'right');
    expect(s.getState().selection).toEqual({ objectId: 'o2', mechId: 's2' });
    expect(s.driveIds('s2')).toEqual(['s2', 's3']);
  });
  it('發亮的物件 = 整組動到的；虛線框 = 改過的物件', () => {
    const { s } = setup();
    s.selectObject('o1');
    s.setScope('g', 'all');
    expect(s.affectedObjects().sort()).toEqual(['o0', 'o1', 'o2', 'o3']);
    s.setScope('g', 'one');
    s.setValue('r1', 45);
    expect(s.affectedObjects()).toEqual(['o1']);
    expect(s.ghostObjects()).toEqual(['o1']);
  });
  it('吊點：預設左右一起；取消就單調一邊', () => {
    const { s } = setup();
    s.selectObject('prompter');
    s.beginDrag('hR'); s.dragTo('hR', 1, false); s.endDrag();
    expect([s.value('hL'), s.value('hR')]).toEqual([1, 1]);
    s.setLinked('rig', false);
    s.beginDrag('hR'); s.dragTo('hR', 2, false); s.endDrag();
    expect([s.value('hL'), s.value('hR')]).toEqual([1, 2]);
    expect(s.ghostObjects()).toEqual(['prompter']);
  });
});

describe('換 cue、播轉場', () => {
  it('換 cue → 草稿丟掉（回傳丟了幾個），照轉場秒數走到新的 cue', () => {
    const { s, clock } = setup();
    s.setValue('lift', 2);
    clock.set(2000);
    const r = s.setCue(cue({ cueId: 'c3', cueName: '3', saved: { ...saved, lift: 1 }, seconds: 2 }));
    expect(r.dropped).toBe(1);
    expect(s.changedCount()).toBe(0);
    expect(s.override()!.lift).toBeCloseTo(2, 9);
    clock.set(3000);
    expect(s.override()!.lift).toBeCloseTo(1.5, 9);
    clock.set(4100);
    expect(s.override()!.lift).toBeCloseTo(1, 9);
  });
  it('同一個 cue 存的值更新了（自動更新）→ 草稿留著', () => {
    const { s } = setup();
    s.setValue('lift', 2);
    const r = s.setCue(cue({ saved: { ...saved, r0: 10 } }));
    expect(r.dropped).toBe(0);
    expect(s.value('lift')).toBe(2);
    expect(s.override()!.r0).toBe(10);
  });
  it('播轉場：從上一個 cue 用轉場秒數走到草稿值，走完 playing 變回 false', () => {
    const { s, clock } = setup();
    s.setValue('r1', 90);
    clock.set(5000);
    s.play();
    expect(s.getState().playing).toBe(true);
    expect(s.override()!.r1).toBeCloseTo(-90, 9);
    expect(s.override()!.lift).toBeCloseTo(1, 9);
    clock.set(6000);
    expect(s.override()!.r1).toBeCloseTo(0, 9);
    clock.set(7100);
    expect(s.override()!.r1).toBeCloseTo(90, 9);
    expect(s.override()!.lift).toBeCloseTo(0, 9);
    expect(s.getState().playing).toBe(false);
  });
  it('播到一半又改值 → 直接跳到新的值、不再播', () => {
    const { s, clock } = setup();
    s.play();
    clock.set(1500);
    s.setValue('lift', 2);
    expect(s.getState().playing).toBe(false);
    expect(s.override()!.lift).toBe(2);
  });
});

describe('存回：拿到存的值的時候的版本、被別人搶先改過', () => {
  const lib = (over: Partial<AdjustCueContext> = {}) => cue({ libraryCueId: 'lc_30', libraryLabel: '30', rev: 3, ...over });
  function setupLib() {
    const r = setup();
    r.s.setCue(lib());
    return r;
  }
  it('存回要的資料：哪個 cue、Cue 庫的 cue、編號、版本', () => {
    const { s } = setupLib();
    expect(s.saveTarget()).toEqual({ cueId: 'c2', cueName: '2', libraryCueId: 'lc_30', libraryLabel: '30', baseRev: 3 });
    // 後台沒給版本（舊後台）→ null，畫面就不讓存
    s.setCue(lib({ rev: null }));
    expect(s.saveTarget().baseRev).toBeNull();
  });
  it('沒有草稿的時候版本一直跟著最新的；一開始調就停在那一刻', () => {
    const { s } = setupLib();
    s.setCue(lib({ rev: 4 }));
    expect(s.saveTarget().baseRev).toBe(4);
    s.setValue('lift', 2);
    expect(s.saveTarget().baseRev).toBe(4);
    expect(s.getState().stale).toBe(false);
    // 調的時候別人存了（自動更新拿到新版本）→ 版本停在 4，現在是 5 → stale
    s.setCue(lib({ rev: 5, saved: { ...saved, r0: 10 } }));
    expect(s.saveTarget().baseRev).toBe(4);
    expect(s.getState().stale).toBe(true);
    expect(s.value('lift')).toBe(2);        // 草稿還在
    // 放棄改動 → 回到最新的版本、不再 stale
    s.discardAll();
    expect(s.saveTarget().baseRev).toBe(5);
    expect(s.getState().stale).toBe(false);
  });
  it('自己存完：位置讀回來，跟草稿一樣的自動不算改了、版本換成新的，畫面的值不跳', () => {
    const { s, clock } = setupLib();
    s.setValue('lift', 2);
    s.setValue('r0', 45);
    clock.set(1500);
    const before = s.override()!;
    // 後台存好了，位置讀回來：lift、r0 就是剛存的，版本 4
    s.setCue(lib({ rev: 4, saved: { ...saved, lift: 2, r0: 45 } }));
    expect(s.changedCount()).toBe(0);
    expect(s.saveTarget().baseRev).toBe(4);
    expect(s.getState().stale).toBe(false);
    expect(s.override()).toEqual(before);
  });
  it('存完以後又多調了一個：只剩那個，版本換成新的前先停著（它是在新版本上調的）', () => {
    const { s } = setupLib();
    s.setValue('lift', 2);
    s.setCue(lib({ rev: 4, saved: { ...saved, lift: 2 } }));
    expect(s.changedCount()).toBe(0);
    s.setValue('r1', 30);
    expect(s.saveTarget().baseRev).toBe(4);
    expect(s.getState().stale).toBe(false);
  });
  it('換 cue → 草稿丟掉、版本換成新 cue 的', () => {
    const { s } = setupLib();
    s.setValue('lift', 2);
    s.setCue(lib({ cueId: 'c3', cueName: '3', libraryCueId: 'lc_31', libraryLabel: '31', rev: 9, saved: { ...saved, lift: 1 } }));
    expect(s.saveTarget()).toEqual({ cueId: 'c3', cueName: '3', libraryCueId: 'lc_31', libraryLabel: '31', baseRev: 9 });
    expect(s.getState().stale).toBe(false);
  });
  it('關掉調整舞台 → 不再是 stale', () => {
    const { s } = setupLib();
    s.setValue('lift', 2);
    s.setCue(lib({ rev: 9 }));
    expect(s.getState().stale).toBe(true);
    s.exit();
    expect(s.getState().stale).toBe(false);
  });
});

describe('訂閱', () => {
  it('有變才通知；狀態是新的物件', () => {
    const { s } = setup();
    let n = 0;
    const off = s.subscribe(() => { n++; });
    const before = s.getState();
    s.setValue('lift', 1);
    expect(n).toBe(1);
    expect(s.getState()).not.toBe(before);
    s.setValue('lift', 1);
    expect(n).toBe(1);
    off();
    s.setValue('lift', 0);
    expect(n).toBe(1);
  });
});
