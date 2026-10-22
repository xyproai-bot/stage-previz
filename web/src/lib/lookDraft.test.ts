import { describe, expect, it } from 'vitest';
import type { CueState } from './api';
import type { Look, LookObjectRow } from './cueLibraryApi';
import {
  applyDraftToLook, applyDraftToStates, applyLookToDraft, draftHasOps, emptyHistory, historyPush, historyRedo, historyUndo, labelError, newDraft,
  resetObject, resolveLook, resolveLookMechanisms, setMechanism, setObjectFields, suggestLabel, summarizeDraft, type ObjectDefaults,
} from './lookDraft';
// @ts-expect-error 後台的 .mjs 沒有型別
import * as server from '../../../cf-worker/cueLibrary.mjs';

const P0 = { x: 0, y: 0, z: 0 }, P1 = { x: 1, y: 2, z: 3 }, P2 = { x: 5, y: 5, z: 5 };
const R0 = { pitch: 0, yaw: 0, roll: 0 }, S1 = { x: 1, y: 1, z: 1 };
const row = (objectId: string, o: Partial<LookObjectRow>): LookObjectRow => ({
  objectId, position: null, rotation: null, scale: null, visible: null, customProps: null, own: true, ownFields: [], ...o,
});
const BASE: Look = {
  objects: [
    row('a', { position: P1, ownFields: ['position'] }),
    row('b', { position: P1, visible: false, own: false, ownFields: [] }),   // 沿用來的
    row('c', { visible: true, ownFields: ['visible'] }),
  ],
  mechanisms: [
    { mechanismId: 'm1', value: 3, delaySec: 1, durationSec: null, carried: false },
    { mechanismId: 'm2', value: 7, delaySec: null, durationSec: null, carried: true },
  ],
};

describe('草稿的動作', () => {
  it('改位置：新增一列，記成自己設的', () => {
    const d = setObjectFields(newDraft('L'), 'z', { position: P2 });
    const out = applyDraftToLook(BASE, d);
    const z = out.objects.find(r => r.objectId === 'z')!;
    expect(z).toMatchObject({ position: P2, own: true, ownFields: ['position'] });
    expect(out.objects).toHaveLength(4);
  });
  it('欄位 null = 回到預設；全部欄位空了就沒有這一列', () => {
    const d = setObjectFields(newDraft('L'), 'a', { position: null });
    expect(applyDraftToLook(BASE, d).objects.find(r => r.objectId === 'a')).toBeUndefined();
    const d2 = setObjectFields(newDraft('L'), 'c', { position: P2 });
    const c = applyDraftToLook(BASE, d2).objects.find(r => r.objectId === 'c')!;
    expect(c.ownFields.sort()).toEqual(['position', 'visible']);
  });
  it('整個物件回到預設，之後再改的欄位保留', () => {
    let d = setObjectFields(newDraft('L'), 'b', { rotation: { pitch: 1, yaw: 2, roll: 3 } });
    d = resetObject(d, 'b');
    expect(applyDraftToLook(BASE, d).objects.find(r => r.objectId === 'b')).toBeUndefined();
    d = setObjectFields(d, 'b', { visible: true });
    const b = applyDraftToLook(BASE, d).objects.find(r => r.objectId === 'b')!;
    expect(b).toMatchObject({ position: null, visible: true, ownFields: ['visible'] });
  });
  it('機關：新增、改、刪', () => {
    let d = setMechanism(newDraft('L'), 'm3', { value: 9, delaySec: null, durationSec: 2 });
    d = setMechanism(d, 'm1', { value: 4, delaySec: 1, durationSec: null });
    d = setMechanism(d, 'm2', null);
    const out = applyDraftToLook(BASE, d);
    expect(out.mechanisms.map(m => [m.mechanismId, m.value, m.carried])).toEqual([['m1', 4, false], ['m3', 9, false]]);
  });
  it('不改原本的畫面', () => {
    const copy = JSON.stringify(BASE);
    applyDraftToLook(BASE, setObjectFields(newDraft('L'), 'a', { position: P2 }));
    expect(JSON.stringify(BASE)).toBe(copy);
  });
  it('摘要：拖回原位不算，只算真的不一樣的', () => {
    let d = newDraft('L');
    expect(draftHasOps(d)).toBe(false);
    d = setObjectFields(d, 'a', { position: P1 });                 // 跟原本一樣
    d = setObjectFields(d, 'c', { visible: false });               // 改了
    d = setMechanism(d, 'm1', { value: 3, delaySec: 1, durationSec: null }); // 一樣
    d = setMechanism(d, 'm2', null);                                // 改了
    expect(draftHasOps(d)).toBe(true);
    expect(summarizeDraft(d, BASE)).toEqual({ objects: 1, mechanisms: 1 });
  });
});

describe('畫面上顯示', () => {
  const state = (over: CueState['override'], eff: Partial<CueState['effective']> = {}): CueState => ({
    objectId: 'a', meshName: 'A', displayName: 'A', category: 'led' as never, order: 0, locked: false,
    default: { position: P0, rotation: R0, scale: S1 }, defaultHidden: true, override: over,
    effective: { position: P0, rotation: R0, scale: S1, visible: false, ...eff },
  });
  it('套草稿後看到新值；回到預設的欄位用預設（預設隱藏 → 隱藏）', () => {
    const [s] = applyDraftToStates([state(null)], setObjectFields(newDraft('L'), 'a', { position: P2, visible: true }));
    expect(s.effective.position).toEqual(P2);
    expect(s.effective.visible).toBe(true);
    const [t] = applyDraftToStates([s], setObjectFields(newDraft('L'), 'a', { visible: null }));
    expect(t.effective.visible).toBe(false);
  });
  it('整個物件回到預設', () => {
    const start = state({ position: P1, rotation: null, scale: null, visible: true, customProps: null, updatedAt: '' }, { position: P1, visible: true });
    const [s] = applyDraftToStates([start], resetObject(newDraft('L'), 'a'));
    expect(s.override).toBeNull();
    expect(s.effective).toEqual({ position: P0, rotation: R0, scale: S1, visible: false });
  });
  it('沒有草稿就原封不動', () => {
    const list = [state(null)];
    expect(applyDraftToStates(list, null)).toBe(list);
  });
});

describe('復原 / 重做', () => {
  it('一步一步退回去、再做一次', () => {
    const d1 = setObjectFields(newDraft('L'), 'a', { position: P1 });
    const d2 = setObjectFields(d1, 'a', { position: P2 });
    let h = historyPush(historyPush(emptyHistory(), d1), d2);
    h = historyUndo(h);
    expect(h.present).toBe(d1);
    h = historyUndo(h);
    expect(h.present).toBeNull();
    expect(historyUndo(h)).toBe(h);
    h = historyRedo(h);
    expect(h.present).toBe(d1);
    h = historyPush(h, d2);
    expect(h.future).toHaveLength(0);
  });
});

describe('編號', () => {
  it('建議編號、錯誤字跟後台一樣', () => {
    for (const l of [[], ['1'], ['3-1', '12', 'A'], ['301'], ['  7 ', 'x']]) expect(suggestLabel(l)).toBe(server.suggestLabel(l));
    for (const [input, ex] of [['', []], ['  ', []], ['x'.repeat(17), []], ['3-1', ['3-1']], ['A', ['a']], ['3-1', ['3']], ['最後一號', []]] as [string, string[]][]) {
      const s = server.validateLabel(input, ex);
      expect(labelError(input, ex)).toBe(s.ok ? null : s.error);
    }
    expect(labelError('', [])).toBe('編號不能空白');
    expect(labelError('3-1', ['3-1'])).toBe('這個編號已經有了');
    expect(labelError('x'.repeat(17), [])).toBe('編號最多 16 個字');
  });
});

describe('resolveLook 跟後台的算法一樣', () => {
  const objs: ObjectDefaults[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
    objectId: id, defaultPosition: { x: i, y: 0, z: 0 }, defaultRotation: R0, defaultScale: S1, defaultHidden: i === 3,
  }));
  const toDb = (l: Look) => l.objects.map(r => ({
    stage_object_id: r.objectId, own: r.own ? 1 : 0,
    own_fields: (r.ownFields.includes('position') ? 1 : 0) | (r.ownFields.includes('rotation') ? 2 : 0) | (r.ownFields.includes('scale') ? 4 : 0)
      | (r.ownFields.includes('visible') ? 8 : 0) | (r.ownFields.includes('customProps') ? 16 : 0),
    position: r.position ? JSON.stringify(r.position) : null, rotation: r.rotation ? JSON.stringify(r.rotation) : null,
    scale: r.scale ? JSON.stringify(r.scale) : null, visible: r.visible == null ? null : (r.visible ? 1 : 0),
    custom_props: r.customProps ? JSON.stringify(r.customProps) : null, updated_at: 't',
  }));
  const objRows = objs.map((o, i) => ({
    object_id: o.objectId, mesh_name: o.objectId, display_name: o.objectId, category: 'led', object_order: i, object_locked: 0,
    default_position: JSON.stringify(o.defaultPosition), default_rotation: JSON.stringify(o.defaultRotation), default_scale: JSON.stringify(o.defaultScale),
    default_hidden: o.defaultHidden ? 1 : 0,
  }));
  const looks: Look[] = [
    { objects: [], mechanisms: [] },
    BASE,
    { objects: [row('d', { visible: true, ownFields: ['visible'] }), row('e', { visible: false, rotation: { pitch: 1, yaw: 1, roll: 1 }, ownFields: ['rotation'] }), row('a', { scale: P2, own: false })], mechanisms: [] },
    applyDraftToLook(BASE, setObjectFields(setObjectFields(newDraft('L'), 'd', { visible: true, position: P2 }), 'a', { position: null })),
  ];
  it('每種畫面的物件解出來都一樣', () => {
    for (const look of looks) {
      const mine = resolveLook(objs, look);
      const theirs = server.resolveLibraryObjectStates(objRows, toDb(look));
      mine.forEach((m: ReturnType<typeof resolveLook>[number], i: number) => {
        const t = theirs[i];
        expect(m.effective).toEqual(t.effective);
        expect(m.sources).toEqual(t.sources);
        expect(m.tracked).toBe(t.tracked);
        expect(m.default).toEqual(t.default);
        const tOv = t.override ? { ...t.override } : null;
        if (tOv) delete tOv.updatedAt;
        expect(m.override).toEqual(tOv);
      });
    }
  });
  it('機關解出來的位置跟來源也一樣（超出行程會夾住）', () => {
    const mechs = [{ id: 'm1', defaultValue: 0, travelMin: 0, travelMax: 5 }, { id: 'm2', defaultValue: 1, travelMin: 0, travelMax: 9 }, { id: 'm3', defaultValue: 2, travelMin: 0, travelMax: 4 }];
    const look: Look = { objects: [], mechanisms: [
      { mechanismId: 'm1', value: 99, delaySec: null, durationSec: null, carried: false },
      { mechanismId: 'm2', value: 7, delaySec: null, durationSec: null, carried: true },
    ] };
    const mine = resolveLookMechanisms(mechs, look, 'slot1');
    const theirs = server.resolveSlotMechanisms(mechs, look.mechanisms.map(m => ({ mechanism_id: m.mechanismId, value: m.value, carried: m.carried ? 1 : 0, delay_sec: m.delaySec, duration_sec: m.durationSec })), 'slot1').row;
    expect(mine).toEqual(theirs);
  });
});

describe('套用常用擺位進草稿', () => {
  const TPL: Look = {
    objects: [row('a', { position: P2, visible: true, ownFields: ['position', 'visible'] }), row('z', { position: P1, visible: true, ownFields: ['position', 'visible'] })],
    mechanisms: [{ mechanismId: 'm1', value: 9, delaySec: 0.5, durationSec: null, carried: false }],
  };
  it('擺位裡的物件換成擺位的值，擺位沒提到的物件 / 機關回到預設', () => {
    const d = applyLookToDraft('L', BASE, TPL);
    const out = applyDraftToLook(BASE, d);
    const byId = new Map(out.objects.map(r => [r.objectId, r]));
    expect(byId.get('a')?.position).toEqual(P2);
    expect(byId.get('z')?.position).toEqual(P1);
    expect(byId.has('b')).toBe(false);
    expect(byId.has('c')).toBe(false);
    expect(out.mechanisms.map(m => [m.mechanismId, m.value, m.delaySec])).toEqual([['m1', 9, 0.5]]);
  });
  it('擺位跟現在一樣就不算改動；有差才算', () => {
    const same = applyLookToDraft('L', BASE, { objects: BASE.objects, mechanisms: BASE.mechanisms.filter(m => !m.carried) });
    // b 是沿用來的、m2 是沿用的 → 套同樣內容後它們變成自己設或回預設，仍算有改動；a / c / m1 沒變
    expect(summarizeDraft(same, BASE).objects).toBeGreaterThan(0);
    expect(summarizeDraft(applyLookToDraft('L', BASE, TPL), BASE)).toEqual({ objects: 4, mechanisms: 2 });
  });
});
