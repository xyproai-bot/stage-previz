// 物件「預設隱藏」的前端小零件：沒有 cue 時顯不顯示、畫面上的字、物件狀態旁邊的說明
import { describe, expect, it } from 'vitest';
import type { CueState } from './api';
import { DEFAULT_HIDDEN_LABEL, defaultHiddenToast, defaultHiddenToggleText, defaultVisible, isDefaultHidden, visibilityNote } from './defaultHidden';

const state = (hidden: boolean | undefined, ownVisible: boolean | null | 'none', effVisible: boolean): Pick<CueState, 'defaultHidden' | 'override' | 'effective'> => ({
  defaultHidden: hidden,
  override: ownVisible === 'none' ? null : { position: null, rotation: null, scale: null, visible: ownVisible, customProps: null, updatedAt: '' },
  effective: { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 }, visible: effVisible },
});

describe('預設隱藏：沒有 cue 的時候（物件預設那一份）', () => {
  it('開著 = 隱藏；沒開 / 舊的後台沒有這個欄位 = 顯示', () => {
    expect(defaultVisible({ defaultHidden: true })).toBe(false);
    expect(defaultVisible({ defaultHidden: false })).toBe(true);
    expect(defaultVisible({})).toBe(true);
    expect(defaultVisible(null)).toBe(true);
    expect(isDefaultHidden(undefined)).toBe(false);
    expect(isDefaultHidden({ defaultHidden: true })).toBe(true);
  });
});

describe('預設隱藏：畫面上的字', () => {
  it('開關的說明：沒開 → 設成；開著 → 取消；都有物件名稱', () => {
    const off = defaultHiddenToggleText({ displayName: '瞬掉緞帶', defaultHidden: false });
    expect(off.label).toBe('把「瞬掉緞帶」設成預設隱藏');
    expect(off.title).toContain('沒有 cue 設定過顯示的歌');
    const on = defaultHiddenToggleText({ displayName: '瞬掉緞帶', defaultHidden: true });
    expect(on.label).toBe('取消「瞬掉緞帶」的預設隱藏');
    expect(on.title).toContain('按一下取消');
  });
  it('改完的一句話', () => {
    expect(defaultHiddenToast('瞬掉緞帶', true)).toContain('現在是預設隱藏');
    expect(defaultHiddenToast('瞬掉緞帶', false)).toContain('不再預設隱藏');
  });
});

describe('物件狀態旁邊的說明（顯示 / 隱藏是怎麼來的）', () => {
  it('沒有預設隱藏的物件不寫', () => {
    expect(visibilityNote(state(false, 'none', true))).toBeNull();
    expect(visibilityNote(state(undefined, 'none', true))).toBeNull();
  });
  it('預設隱藏：這首歌還沒有設定過顯示 → 寫還沒有設定', () => {
    expect(visibilityNote(state(true, 'none', false))).toBe(`${DEFAULT_HIDDEN_LABEL}：這首歌到這個 cue 還沒有設定過顯示`);
    // 這個 cue 有自己的設定，但沒碰顯示（只調了位置）
    expect(visibilityNote(state(true, null, false))).toBe(`${DEFAULT_HIDDEN_LABEL}：這首歌到這個 cue 還沒有設定過顯示`);
  });
  it('預設隱藏：這個 cue 明確設成顯示 / 隱藏；前面的 cue 設成顯示、這個 cue 沿用', () => {
    expect(visibilityNote(state(true, true, true))).toBe(`${DEFAULT_HIDDEN_LABEL}，這個 cue 設成顯示`);
    expect(visibilityNote(state(true, false, false))).toBe(`${DEFAULT_HIDDEN_LABEL}，這個 cue 也設成隱藏`);
    expect(visibilityNote(state(true, 'none', true))).toBe(`${DEFAULT_HIDDEN_LABEL}，前面的 cue 設成顯示，這個 cue 沿用`);
  });
});
