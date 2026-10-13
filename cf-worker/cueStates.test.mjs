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
