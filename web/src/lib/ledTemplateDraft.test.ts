import { describe, it, expect } from 'vitest';
import {
  addScreenToDraft, copyTemplateName, draftFromTemplate, draftSignature, draftToBody, draftToPlan, emptyDraft, nextTemplateName,
  patchDraftItem, removeScreenFromDraft, resetItemSize, type Draft,
} from './ledTemplateDraft';
import { normalizeTemplateInput, type Rotation } from './ledTemplate';
import type { LedTemplate } from './ledTemplateApi';

const d0 = (): Draft => ({ ...emptyDraft('版型 1', { width: 1000, height: 400 }), scalePct: 50 });
const A = { key: 'o:a', nativeW: 800, nativeH: 200 };
const B = { key: 'o:b', nativeW: 100, nativeH: 400 };

describe('加入 / 拿掉螢幕', () => {
  it('加入：真實點數 × 比例，放在左上角的空位', () => {
    const d = addScreenToDraft(d0(), A);
    expect(d.items).toEqual([{ key: 'o:a', dest: { x: 0, y: 0, w: 400, h: 100 }, rotate: 0, flipH: false, flipV: false }]);
  });
  it('第二塊放在第一塊旁邊，不重疊', () => {
    const d = addScreenToDraft(addScreenToDraft(d0(), A), B);
    expect(d.items[1].dest).toEqual({ x: 400, y: 0, w: 50, h: 200 });
  });
  it('已經在版型裡就不重複加；拿掉', () => {
    const d = addScreenToDraft(d0(), A);
    expect(addScreenToDraft(d, A)).toBe(d);
    expect(removeScreenFromDraft(d, 'o:a').items).toEqual([]);
    expect(removeScreenFromDraft(d, 'o:zzz')).toBe(d);
  });
  it('標準大小：轉 90 度時寬高對調，位置不動', () => {
    let d = addScreenToDraft(d0(), A);
    d = patchDraftItem(d, 'o:a', { dest: { x: 30, y: 40, w: 7, h: 9 }, rotate: 90 as Rotation });
    expect(resetItemSize(d, A).items[0].dest).toEqual({ x: 30, y: 40, w: 100, h: 400 });
  });
});

describe('草稿', () => {
  it('patchDraftItem：沒有實際改動就回同一個物件', () => {
    const d = addScreenToDraft(d0(), A);
    expect(patchDraftItem(d, 'o:zzz', { flipH: true })).toBe(d);
    expect(patchDraftItem(d, 'o:a', { flipH: true }).items[0].flipH).toBe(true);
  });
  it('指紋：內容一樣就一樣，改任何東西都不一樣', () => {
    const a = addScreenToDraft(d0(), A);
    const b = addScreenToDraft(d0(), A);
    expect(draftSignature(a)).toBe(draftSignature(b));
    expect(draftSignature(patchDraftItem(a, 'o:a', { rotate: 90 }))).not.toBe(draftSignature(a));
    expect(draftSignature({ ...a, name: 'x' })).not.toBe(draftSignature(a));
    expect(draftSignature({ ...a, width: 999 })).not.toBe(draftSignature(a));
  });
  it('從後台給的版型帶入，再轉成存檔內容，後台的檢查會過', () => {
    const t = {
      id: 'lt_1', kind: 'custom', name: '中間底幕', canvas: { width: 4400, height: 200 }, scalePct: 50, sortOrder: 1, songCount: 0, v: 1,
      screens: [{ key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 4400, h: 200 }, rotate: 0, flipH: false, flipV: true }],
    } as unknown as LedTemplate;
    const d = draftFromTemplate(t);
    expect(d.id).toBe('lt_1');
    const body = draftToBody(d, new Set(['o:a']));
    expect(normalizeTemplateInput(body, { partial: false }).ok).toBe(true);
    expect(body.screens[0].flipV).toBe(true);
  });
  it('存檔時，模型裡找不到的螢幕拿掉', () => {
    let d = addScreenToDraft(d0(), A);
    d = addScreenToDraft(d, B);
    expect(draftToBody(d, new Set(['o:a'])).screens.map(s => s.key)).toEqual(['o:a']);
  });
  it('草稿 → plan：手動切的螢幕帶著 uv', () => {
    const d: Draft = { ...d0(), items: [{ key: 's:ls_1', dest: { x: 0, y: 0, w: 10, h: 10 }, rotate: 0, flipH: false, flipV: false }] };
    const plan = draftToPlan(d, [{ id: 'ls_1', objectId: 'so_2', name: '左半', uv: [0, 0, 0.5, 1] }]);
    expect(plan.screens[0].objectId).toBe('so_2');
    expect(plan.screens[0].uv).toEqual([0, 0, 0.5, 1]);
  });
});

describe('名字', () => {
  it('新版型：版型 1、版型 2…', () => {
    expect(nextTemplateName([])).toBe('版型 1');
    expect(nextTemplateName(['版型 1', '版型 2'])).toBe('版型 3');
  });
  it('複製版型：加「複本」，重複就加數字，不分大小寫，不超過 40 字', () => {
    expect(copyTemplateName('中間底幕', ['中間底幕'])).toBe('中間底幕 複本');
    expect(copyTemplateName('中間底幕', ['中間底幕', '中間底幕 複本'])).toBe('中間底幕 複本 2');
    expect(copyTemplateName('中間底幕 複本', ['中間底幕', '中間底幕 複本'])).toBe('中間底幕 複本 2');
    expect(copyTemplateName('Abc', ['abc 複本'])).toBe('Abc 複本 2');
    expect(copyTemplateName('字'.repeat(40), []).length).toBeLessThanOrEqual(40);
  });
});
