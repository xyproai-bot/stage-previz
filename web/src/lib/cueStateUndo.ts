// 物件在某個 cue 的設定（位置 / 角度 / 顯示）怎麼復原、怎麼先顯示改好的樣子
//
// 後台的 PUT 只會「改有帶的欄位」，沒辦法把某個欄位改回「沒設（跟著前面的 cue / 預設）」；
// 要回到沒設只能整個清掉（DELETE）再把原本有設的欄位寫回去。

import type { CueState, Euler, Vec3 } from './api';

export type CueStatePatch = Partial<{
  position: Vec3;
  rotation: Euler;
  scale: Vec3;
  visible: boolean;
  customProps: Record<string, unknown>;
}>;
export type CueStateField = keyof CueStatePatch;
type Override = NonNullable<CueState['override']>;

const FIELDS: CueStateField[] = ['position', 'rotation', 'scale', 'visible', 'customProps'];

/** 這個 cue 自己有設的欄位（沒設的 = 跟著前面的 cue / 預設，不放進來） */
export function overridePatch(before: Override | null | undefined): CueStatePatch {
  const out: Record<string, unknown> = {};
  if (!before) return out as CueStatePatch;
  for (const k of FIELDS) {
    if (before[k] != null) out[k] = before[k];
  }
  return out as CueStatePatch;
}

/**
 * 復原「改了 changed 這些欄位」要怎麼做：
 *   - 原本這個 cue 沒有自己的設定 → 整個清掉（reset），不用再寫
 *   - 改的欄位原本都有自己的值 → 只把那些欄位寫回原本的值（別的欄位不動）
 *   - 有欄位原本是「沒設」→ 先整個清掉，再把原本有設的欄位寫回去
 * put = null 表示清掉就好
 */
export function cueStateRestorePlan(
  before: Override | null | undefined,
  changed: CueStateField[],
): { reset: boolean; put: CueStatePatch | null } {
  if (!before) return { reset: true, put: null };
  const own = overridePatch(before);
  if (changed.every(k => own[k] !== undefined)) {
    const put: Record<string, unknown> = {};
    for (const k of changed) put[k] = own[k];
    return { reset: false, put: put as CueStatePatch };
  }
  return { reset: true, put: Object.keys(own).length > 0 ? own : null };
}

/** 存成功後先在畫面上套用（不用等重新讀取）：這個 cue 自己的設定 + 看到的樣子都換成新的 */
export function applyCueStatePatch(state: CueState, patch: CueStatePatch): CueState {
  const base: Override = state.override ?? {
    position: null, rotation: null, scale: null, visible: null, customProps: null, updatedAt: '',
  };
  const override: Override = { ...base, updatedAt: new Date().toISOString() };
  const effective = { ...state.effective };
  if (patch.position) { override.position = { ...patch.position }; effective.position = { ...patch.position }; }
  if (patch.rotation) { override.rotation = { ...patch.rotation }; effective.rotation = { ...patch.rotation }; }
  if (patch.scale) { override.scale = { ...patch.scale }; effective.scale = { ...patch.scale }; }
  if (patch.visible !== undefined) { override.visible = patch.visible; effective.visible = patch.visible; }
  if (patch.customProps) override.customProps = { ...patch.customProps };
  return { ...state, override, effective };
}
