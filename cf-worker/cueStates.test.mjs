// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCueStates } from './cueStates.mjs';

const J = (o) => JSON.stringify(o);

// 一個物件（升降台），預設在原點
function objectRow(overrides = {}) {
  return {
    object_id: 'o_lift', mesh_name: 'LIFT', display_name: null, category: 'mechanism', object_order: 0,
    default_position: J({ x: 0, y: 0, z: 0 }), default_rotation: J({ pitch: 0, yaw: 0, roll: 0 }),
    default_scale: J({ x: 1, y: 1, z: 1 }), object_locked: 0,
    state_position: null, state_rotation: null, state_scale: null, state_visible: null,
    state_custom: null, state_updated_at: null,
    ...overrides,
  };
}

// 一首歌 3 個 cue：cue 2 把升降台升到 y=3，cue 3 什麼都沒改
const cue2State = { stage_object_id: 'o_lift', position: J({ x: 0, y: 3, z: 0 }), rotation: null, scale: null, visible: 1, cue_order: 1 };

test('cue 3 沒改 → 繼承 cue 2 的位置（不是預設位置）', () => {
  // 算 cue 3：自己沒有覆寫；前面的 cue（順序 0、1）只有 cue 2 有設
  const [lift] = buildCueStates([objectRow()], [cue2State]);
  assert.deepEqual(lift.effective.position, { x: 0, y: 3, z: 0 });
  assert.equal(lift.tracked, true);
  assert.equal(lift.override, null);
  assert.deepEqual(lift.effective.rotation, { pitch: 0, yaw: 0, roll: 0 });  // cue 2 沒設旋轉 → 預設
  assert.equal(lift.effective.visible, true);
  assert.equal(lift.displayName, 'LIFT');  // 沒有顯示名稱 → 用 mesh 名稱
});

test('cue 1（前面沒有 cue）→ 預設位置', () => {
  const [lift] = buildCueStates([objectRow()], []);
  assert.deepEqual(lift.effective.position, { x: 0, y: 0, z: 0 });
  assert.equal(lift.tracked, false);
});

test('cue 2 自己的設定優先', () => {
  const [lift] = buildCueStates([objectRow({
    state_position: J({ x: 0, y: 3, z: 0 }), state_visible: 1, state_updated_at: '2026-10-14 00:00:00',
  })], []);
  assert.deepEqual(lift.effective.position, { x: 0, y: 3, z: 0 });
  assert.equal(lift.tracked, false);
  assert.deepEqual(lift.override.position, { x: 0, y: 3, z: 0 });
  assert.equal(lift.override.visible, true);
});

test('前面好幾個 cue 都有設 → 用最近的那個（不管傳進來的順序）', () => {
  const rows = [
    { stage_object_id: 'o_lift', position: J({ x: 0, y: 5, z: 0 }), rotation: null, scale: null, visible: 0, cue_order: 2 },
    { stage_object_id: 'o_lift', position: J({ x: 0, y: 1, z: 0 }), rotation: null, scale: null, visible: 1, cue_order: 0 },
  ];
  const [lift] = buildCueStates([objectRow()], rows);
  assert.deepEqual(lift.effective.position, { x: 0, y: 5, z: 0 });
  assert.equal(lift.effective.visible, false);
});

test('別的物件的設定不會跑到這個物件上', () => {
  const other = { ...cue2State, stage_object_id: 'o_led' };
  const [lift] = buildCueStates([objectRow()], [other]);
  assert.deepEqual(lift.effective.position, { x: 0, y: 0, z: 0 });
  assert.equal(lift.tracked, false);
});

test('壞掉的 JSON → 用預設，不會整個掛掉', () => {
  const [lift] = buildCueStates([objectRow({ default_position: '{bad', state_position: 'nope', state_updated_at: 'x' })], []);
  assert.deepEqual(lift.default.position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(lift.effective.position, { x: 0, y: 0, z: 0 });
});

// ── 物件「預設隱藏」（0040）──
const hiddenRow = (overrides = {}) => objectRow({ default_hidden: 1, ...overrides });
const earlierRow = (visible, cueOrder, position = null) => ({ stage_object_id: 'o_lift', position, rotation: null, scale: null, visible, cue_order: cueOrder });

test('預設隱藏：整首歌都沒有人設過顯示 / 隱藏 → 隱藏；沒有預設隱藏的物件照舊顯示', () => {
  const [hidden] = buildCueStates([hiddenRow()], []);
  assert.equal(hidden.effective.visible, false);
  assert.equal(hidden.defaultHidden, true);
  assert.equal(hidden.override, null);
  // 前面的 cue 有設位置、沒碰顯示 → 還是預設隱藏
  const [moved] = buildCueStates([hiddenRow()], [earlierRow(null, 0, J({ x: 0, y: 3, z: 0 }))]);
  assert.equal(moved.effective.visible, false);
  assert.deepEqual(moved.effective.position, { x: 0, y: 3, z: 0 });
  // 沒有預設隱藏（含舊資料沒有這個欄位）：跟以前一樣顯示
  assert.equal(buildCueStates([objectRow()], [])[0].effective.visible, true);
  assert.equal(buildCueStates([objectRow({ default_hidden: 0 })], [])[0].effective.visible, true);
  assert.equal(buildCueStates([objectRow()], [])[0].defaultHidden, false);
});

test('預設隱藏：cue 自己明確設成顯示 → 顯示（明確設定優先）；自己設成隱藏 → 隱藏', () => {
  const show = hiddenRow({ state_visible: 1, state_updated_at: '2026-10-20 00:00:00' });
  assert.equal(buildCueStates([show], [])[0].effective.visible, true);
  assert.equal(buildCueStates([show], [])[0].override.visible, true);
  // 前面 cue 說隱藏、這個 cue 自己說顯示 → 顯示
  assert.equal(buildCueStates([show], [earlierRow(0, 0)])[0].effective.visible, true);
  const hide = hiddenRow({ state_visible: 0, state_updated_at: '2026-10-20 00:00:00' });
  assert.equal(buildCueStates([hide], [earlierRow(1, 0)])[0].effective.visible, false);
});

test('預設隱藏：前面 cue 設成顯示 → 後面沒設的 cue 沿用顯示（第 1 首歌的 cue 照樣顯示）', () => {
  const [after] = buildCueStates([hiddenRow()], [earlierRow(1, 1)]);
  assert.equal(after.effective.visible, true);
  assert.equal(after.tracked, true);
  // 前面最近一筆只調了位置（顯示沒設）、更前面的 cue 明確設過顯示 → 還是顯示
  const [carried] = buildCueStates([hiddenRow()], [earlierRow(1, 0), earlierRow(null, 1, J({ x: 1, y: 0, z: 0 }))]);
  assert.equal(carried.effective.visible, true);
  assert.deepEqual(carried.effective.position, { x: 1, y: 0, z: 0 });
  // 顯示又被隱藏 → 之後隱藏；再被顯示 → 之後顯示（最近一次明確設定為準）
  assert.equal(buildCueStates([hiddenRow()], [earlierRow(1, 0), earlierRow(0, 1), earlierRow(null, 2)])[0].effective.visible, false);
  assert.equal(buildCueStates([hiddenRow()], [earlierRow(1, 0), earlierRow(0, 1), earlierRow(1, 2)])[0].effective.visible, true);
});

test('預設隱藏：別的物件的顯示設定不影響這個物件', () => {
  const other = { ...earlierRow(1, 0), stage_object_id: 'o_led' };
  assert.equal(buildCueStates([hiddenRow()], [other])[0].effective.visible, false);
});

test('沒有預設隱藏的物件：前面最近一筆沒碰顯示 → 還是顯示（舊的行為完全不變）', () => {
  // 前面 cue 0 隱藏、cue 1 只調位置：舊行為是「整筆沿用最近那一筆」→ 顯示
  const [lift] = buildCueStates([objectRow()], [earlierRow(0, 0), earlierRow(null, 1, J({ x: 0, y: 2, z: 0 }))]);
  assert.equal(lift.effective.visible, true);
  // 最近一筆有設就用它
  assert.equal(buildCueStates([objectRow()], [earlierRow(1, 0), earlierRow(0, 1)])[0].effective.visible, false);
});
