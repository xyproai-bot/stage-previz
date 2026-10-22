// 跑法：cd cf-worker && npm test
// Cue 庫第 1 階段：純計算核心。重點：舊 cue「烤成快照 → 再解回來」跟現在的算法結果一模一樣（規格 1.2 的每一種特殊情況），
// 加上編號 / 排序 / 合併 / 檢查 / 資料表外鍵。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCueStates } from './cueStates.mjs';
import { resolveSongMechanisms, ownValuesByCue, ownTimingsByCue } from './mechanismTrack.mjs';
import {
  bakeSlotLook, resolveLibraryObjectStates, resolveSlotMechanisms, lookKey, planProjectMigration,
  suggestLabel, compareLabels, validateLabel, orderSlots, validateLook, sha256Hex,
} from './cueLibrary.mjs';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';

const J = (o) => JSON.stringify(o);
const P = (x, y, z) => ({ x, y, z });

// ── 舊算法（跟 worker.js loadCueStates 餵 buildCueStates 的方式一樣）──
function objectRow(id, extra = {}) {
  return {
    object_id: id, mesh_name: id.toUpperCase(), display_name: null, category: 'other', object_order: 0,
    default_position: J(P(0, 0, 0)), default_rotation: J({ pitch: 0, yaw: 0, roll: 0 }), default_scale: J(P(1, 1, 1)),
    object_locked: 0, default_hidden: 0, ...extra,
  };
}
/** stateRows: cueId → [{stage_object_id, position, rotation, scale, visible, custom_props, updated_at}] */
function legacyStates(objects, cues, stateRows, cue) {
  const mine = new Map((stateRows[cue.id] || []).map(r => [r.stage_object_id, r]));
  const objR = objects.map(o => {
    const s = mine.get(o.object_id);
    return { ...o, state_position: s?.position ?? null, state_rotation: s?.rotation ?? null, state_scale: s?.scale ?? null,
      state_visible: s?.visible ?? null, state_custom: s?.custom_props ?? null, state_updated_at: s ? (s.updated_at ?? '2026-01-01') : null };
  });
  // 同一首歌、順序「嚴格」在前面、所有狀態，照 order 排（跟 SQL ORDER BY c."order" 一樣，同順序保持原本順序）
  const earlier = [];
  cues.forEach(c => {
    if (!(c.order < cue.order)) return;
    for (const r of stateRows[c.id] || []) earlier.push({ stage_object_id: r.stage_object_id, position: r.position, rotation: r.rotation, scale: r.scale, visible: r.visible, cue_order: c.order });
  });
  return buildCueStates(objR, earlier);
}

const MECHS = [
  { id: 'm_lift', defaultValue: 0, travelMin: 0, travelMax: 5 },
  { id: 'm_rot', defaultValue: 10, travelMin: 0, travelMax: 90 },
  { id: 'm_free', defaultValue: 1, travelMin: 0, travelMax: 3 },
  { id: 'm_rig', defaultValue: 0, travelMin: 0, travelMax: 1, variant: 'hoist_rig' },
];

/** 每個規格 1.2 的特殊情況放一個物件 / 機關；一首歌 7 個 cue */
function scenario() {
  const objects = [
    objectRow('o_quirk'),                       // 整筆繼承：cue1 {pos}, cue2 {visible 0, pos NULL}, cue3 沒列 → 預設位置
    objectRow('o_tie'),                         // 順序一樣的兩個 cue：嚴格小於才算「前面」
    objectRow('o_hid', { default_hidden: 1 }),  // 預設隱藏：前面只調位置，仍沿用更前面明確設過的顯示
    objectRow('o_snap'),                        // 快照列：visible = 1
    objectRow('o_empty'),                       // 自己有一列但所有欄位 NULL
    objectRow('o_custom'),                      // 自訂欄位 + 旋轉 / 大小
    objectRow('o_none'),                        // 完全沒人碰
    objectRow('o_hid2', { default_hidden: 1 }), // 預設隱藏，整首歌都沒人碰
  ];
  const cues = [
    { id: 'c1', order: 0, status: 'master' },
    { id: 'c2', order: 1, status: 'master' },
    { id: 'c3', order: 2, status: 'master' },
    { id: 'c3b', order: 2, status: 'master' },   // 跟 c3 同順序
    { id: 'c4', order: 3, status: 'proposal' },  // 提案：物件會繼承它、機關不會
    { id: 'c5', order: 4, status: 'master' },
    { id: 'c6', order: 5, status: 'alternate' },
  ];
  const stateRows = {
    c1: [
      { stage_object_id: 'o_quirk', position: J(P(1, 2, 3)), rotation: null, scale: null, visible: null, custom_props: null },
      { stage_object_id: 'o_hid', position: null, rotation: null, scale: null, visible: 1, custom_props: null },
      { stage_object_id: 'o_snap', position: J(P(4, 4, 4)), rotation: J({ pitch: 1, yaw: 2, roll: 3 }), scale: J(P(2, 2, 2)), visible: 1, custom_props: null },
    ],
    c2: [
      { stage_object_id: 'o_quirk', position: null, rotation: null, scale: null, visible: 0, custom_props: null },
      { stage_object_id: 'o_hid', position: J(P(9, 9, 9)), rotation: null, scale: null, visible: null, custom_props: null },
      { stage_object_id: 'o_empty', position: null, rotation: null, scale: null, visible: null, custom_props: null, updated_at: '2026-02-02' },
    ],
    c3: [
      { stage_object_id: 'o_tie', position: J(P(5, 0, 0)), rotation: null, scale: null, visible: null, custom_props: null },
    ],
    c3b: [
      { stage_object_id: 'o_tie', position: J(P(6, 0, 0)), rotation: null, scale: null, visible: 0, custom_props: null },
      { stage_object_id: 'o_custom', position: null, rotation: J({ pitch: 0, yaw: 45, roll: 0 }), scale: J(P(3, 3, 3)), visible: null, custom_props: J({ color: 'red' }), updated_at: '2026-03-03T00:00:00Z' },
    ],
    c4: [
      { stage_object_id: 'o_quirk', position: J(P(7, 7, 7)), rotation: null, scale: null, visible: 1, custom_props: null },
    ],
    c5: [],
    c6: [
      { stage_object_id: 'o_hid', position: null, rotation: null, scale: null, visible: 0, custom_props: null },
    ],
  };
  const positions = [
    { cueId: 'c1', mechanismId: 'm_lift', value: 2, delaySec: null, durationSec: null },
    { cueId: 'c1', mechanismId: 'm_rot', value: 45, delaySec: 1.5, durationSec: 4 },
    { cueId: 'c2', mechanismId: 'm_lift', value: 100, delaySec: 0, durationSec: null },       // 超出行程：存的值不改、算出來夾住
    { cueId: 'c3', mechanismId: 'm_free', value: 2.5, delaySec: null, durationSec: 2 },
    { cueId: 'c3b', mechanismId: 'm_free', value: 0.5, delaySec: null, durationSec: null },   // 同順序的第二個
    { cueId: 'c4', mechanismId: 'm_lift', value: 4, delaySec: 3, durationSec: 1 },            // 提案
    { cueId: 'c5', mechanismId: 'm_rot', value: 80, delaySec: null, durationSec: null },
    { cueId: 'c6', mechanismId: 'm_rot', value: 20, delaySec: 2, durationSec: null },         // 備案
  ];
  return { objects, cues, stateRows, positions };
}

const nullFrom = (row) => {
  const out = {};
  for (const k in row) out[k] = { ...row[k], fromCueId: row[k].source === 'own' ? row[k].fromCueId : null };
  return out;
};
// 舊的 sources 說 tracked、新的說 carried（同一個意思）
const norm = (s) => ({ ...s, sources: Object.fromEntries(Object.entries(s.sources).map(([k, v]) => [k, v === 'tracked' ? 'carried' : v])) });

test('buildCueStates 只多一個 sources，其他輸出完全不變', () => {
  const sc = scenario();
  const st = legacyStates(sc.objects, sc.cues, sc.stateRows, sc.cues[2]);   // c3
  for (const s of st) {
    assert.deepEqual(Object.keys(s).sort(), ['category', 'default', 'defaultHidden', 'displayName', 'effective', 'locked', 'meshName', 'objectId', 'order', 'override', 'sources', 'tracked']);
  }
  const quirk = st.find(s => s.objectId === 'o_quirk');
  assert.deepEqual(quirk.sources, { position: 'default', rotation: 'default', scale: 'default', visible: 'tracked' });  // 整筆繼承：c2 的 pos 是 NULL → 預設
  assert.deepEqual(quirk.effective.position, P(0, 0, 0));
  assert.equal(quirk.effective.visible, false);
  assert.equal(quirk.tracked, true);
});

test('烤成快照 → 解回來：每個 cue 的物件跟現在的算法一模一樣（規格 1.2 全部的特殊情況）', () => {
  const sc = scenario();
  for (const cue of sc.cues) {
    const legacy = legacyStates(sc.objects, sc.cues, sc.stateRows, cue);
    const look = bakeSlotLook({ states: legacy, mechs: MECHS, resolved: {}, timings: {} });
    const back = resolveLibraryObjectStates(sc.objects, look.objects);
    assert.deepEqual(back, legacy.map(norm), `cue ${cue.id}`);
  }
});

test('各特殊情況烤出來的列', () => {
  const sc = scenario();
  const bake = (id) => {
    const cue = sc.cues.find(c => c.id === id);
    const look = bakeSlotLook({ states: legacyStates(sc.objects, sc.cues, sc.stateRows, cue), mechs: [], resolved: {} });
    return Object.fromEntries(look.objects.map(o => [o.stage_object_id, o]));
  };
  const c3 = bake('c3');
  assert.equal(c3.o_quirk.own, 0);                       // 整筆繼承：寫一列（tracked 才會一樣），位置是 NULL
  assert.equal(c3.o_quirk.position, null);
  assert.equal(c3.o_quirk.visible, 0);
  assert.equal(c3.o_none, undefined);                    // 沒人碰 → 沒有列
  assert.equal(c3.o_hid2, undefined);                    // 預設隱藏、沒人設過 → 沒有列（解回來還是隱藏）
  assert.equal(c3.o_hid.visible, 1);                     // 預設隱藏的「最近一次明確設過」被烤成明確的顯示
  assert.equal(c3.o_hid.own, 0);
  const c2 = bake('c2');
  assert.equal(c2.o_empty.own, 1);                       // 有一列但所有欄位 NULL
  assert.equal(c2.o_empty.own_fields, 0);
  assert.equal(c2.o_empty.position, null);
  assert.equal(c2.o_empty.updated_at, '2026-02-02');
  assert.equal(c2.o_quirk.own_fields, 8);                // 只有 visible 是自己設的
  const c1 = bake('c1');
  assert.equal(c1.o_snap.own_fields, 1 | 2 | 4 | 8);     // 快照列：位置 / 角度 / 大小 / 顯示（visible = 1）
  assert.equal(c1.o_snap.visible, 1);
  const c3b = bake('c3b');
  assert.equal(c3b.o_custom.own_fields, 2 | 4 | 16);
  assert.equal(c3b.o_custom.custom_props, J({ color: 'red' }));
  assert.equal(c3b.o_tie.visible, 0);
  assert.equal(c3b.o_tie.own_fields, 1 | 8);
  // 同順序的 c3 不算 c3b 的「前面」：c3b 看不到 c3 的 o_tie 位置，只有自己的
  assert.equal(c3b.o_tie.position, J(P(6, 0, 0)));
  // 提案 c4 之後的 c5 繼承了提案 c4 設的 o_quirk（物件會穿過提案）
  const c5 = bake('c5');
  assert.equal(c5.o_quirk.position, J(P(7, 7, 7)));
  assert.equal(c5.o_quirk.visible, 1);
});

test('烤成快照 → 解回來：機關的值 / 自己設或沿用 / 超出行程 / 時間 都一樣', () => {
  const sc = scenario();
  const own = ownValuesByCue(sc.positions), tim = ownTimingsByCue(sc.positions);
  const rows = resolveSongMechanisms(MECHS, sc.cues, own);
  for (const cue of sc.cues) {
    const legacy = rows.get(cue.id);
    const look = bakeSlotLook({ states: [], mechs: MECHS, resolved: legacy, timings: tim.get(cue.id) });
    assert.ok(look.mechanisms.every(m => m.mechanism_id !== 'm_rig'), '吊掛骨架不烤');
    const back = resolveSlotMechanisms(MECHS, look.mechanisms, cue.id);
    const expected = nullFrom(legacy);
    delete expected.m_rig; delete back.row.m_rig;
    assert.deepEqual(back.row, expected, `cue ${cue.id}`);
    assert.deepEqual(back.timings, tim.get(cue.id) || {}, `timing ${cue.id}`);
  }
  // 幾個明確的點
  const c2 = resolveSlotMechanisms(MECHS, bakeSlotLook({ states: [], mechs: MECHS, resolved: rows.get('c2'), timings: tim.get('c2') }).mechanisms, 'c2').row;
  assert.equal(c2.m_lift.stored, 100); assert.equal(c2.m_lift.value, 5); assert.equal(c2.m_lift.clamped, true);
  const c4 = resolveSlotMechanisms(MECHS, bakeSlotLook({ states: [], mechs: MECHS, resolved: rows.get('c4'), timings: tim.get('c4') }).mechanisms, 'c4').row;
  assert.equal(c4.m_lift.source, 'own');                  // 提案自己設的
  const c5 = resolveSlotMechanisms(MECHS, bakeSlotLook({ states: [], mechs: MECHS, resolved: rows.get('c5'), timings: tim.get('c5') }).mechanisms, 'c5').row;
  assert.equal(c5.m_lift.stored, 100);                    // 機關不穿過提案：c5 沿用的是 c2 的 100，不是提案 c4 的 4
  assert.equal(c5.m_lift.source, 'inherited');
});

test('烤出來的機關列：沿用的一定沒有時間、符合資料表的限制', () => {
  const sc = scenario();
  const rows = resolveSongMechanisms(MECHS, sc.cues, ownValuesByCue(sc.positions));
  const tim = ownTimingsByCue(sc.positions);
  const db = freshDb();
  db.raw.exec(`INSERT INTO projects (id, name) VALUES ('p', 'P'); INSERT INTO library_cues (id, project_id, label, name) VALUES ('lc', 'p', '1', 'X');
    INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m_lift','p','a','linear'),('m_rot','p','b','linear'),('m_free','p','c','linear');`);
  for (const cue of sc.cues) {
    const look = bakeSlotLook({ states: [], mechs: MECHS, resolved: rows.get(cue.id), timings: tim.get(cue.id) });
    for (const m of look.mechanisms) {
      if (m.carried === 1) assert.equal(m.delay_sec, null);
      db.raw.prepare('DELETE FROM library_cue_mechanism_positions').run();
      db.raw.prepare(`INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried) VALUES ('lc', ?, ?, ?, ?, ?)`)
        .run(m.mechanism_id, m.value, m.delay_sec, m.duration_sec, m.carried);
    }
  }
});

test('lookKey：名稱去頭尾空白、順序無關、不看 updated_at；名稱或內容不同就不同', () => {
  const o1 = { stage_object_id: 'a', position: J({ x: 1, y: 2, z: 3 }), rotation: null, scale: null, visible: 1, custom_props: null, own: 1, own_fields: 9, updated_at: 'x' };
  const o2 = { stage_object_id: 'b', position: null, rotation: null, scale: null, visible: 0, custom_props: null, own: 0, own_fields: 0, updated_at: 'y' };
  const m1 = { mechanism_id: 'm1', value: 2, delay_sec: null, duration_sec: null, carried: 0 };
  const m2 = { mechanism_id: 'm2', value: 3, delay_sec: null, duration_sec: null, carried: 1 };
  const base = lookKey({ name: '開場', objects: [o1, o2], mechanisms: [m1, m2] });
  assert.equal(lookKey({ name: '  開場 ', objects: [o2, { ...o1, updated_at: 'z' }], mechanisms: [m2, m1] }), base);
  assert.equal(lookKey({ name: '開場', objects: [o1, o2], mechanisms: [m1, m2] }), base);
  assert.equal(lookKey({ name: '一樣的 JSON 不同鍵順序', objects: [], mechanisms: [] }), lookKey({ name: '一樣的 JSON 不同鍵順序', objects: [], mechanisms: [] }));
  assert.equal(lookKey({ name: '開場', objects: [{ ...o1, position: '{"z":3,"y":2,"x":1}' }, o2], mechanisms: [m1, m2] }), base);
  assert.notEqual(lookKey({ name: '間奏', objects: [o1, o2], mechanisms: [m1, m2] }), base);
  assert.notEqual(lookKey({ name: '開場', objects: [o1, o2], mechanisms: [{ ...m2, carried: 0 }, m1] }), base);
  assert.notEqual(lookKey({ name: '開場', objects: [{ ...o1, own: 0, own_fields: 0 }, o2], mechanisms: [m1, m2] }), base);
});

test('planProjectMigration：照歌單順序編 1、2、3；一模一樣（畫面和名稱）的合併；名稱規則；id 固定', () => {
  const empty = { objects: [], mechanisms: [] };
  const lookA = { objects: [{ stage_object_id: 'a', position: J(P(1, 1, 1)), rotation: null, scale: null, visible: 1, custom_props: null, own: 1, own_fields: 9, updated_at: 't' }], mechanisms: [] };
  const songs = [
    { id: 's2', name: '安可', code: 'S02', order: 1 },
    { id: 's1', name: '一二三四五六七八九十一二三', code: null, order: 0 },
    { id: 's3', name: '第三首', code: ' ', order: 2 },
  ];
  const slots = [
    { id: 'x3', songId: 's2', name: '開場', order: 0, createdAt: '2', look: lookA },     // 跟 s1 的「開場」一樣 → 合併
    { id: 'x1', songId: 's1', name: '開場', order: 0, createdAt: '1', look: lookA },
    { id: 'x2', songId: 's1', name: '間奏', order: 1, createdAt: '1', look: lookA },     // 畫面一樣、名稱不同 → 不合併
    { id: 'x4', songId: 's2', name: '間奏', order: 1, createdAt: '2', look: empty },     // 名稱一樣、畫面不同 → 不合併
    { id: 'x5', songId: 's3', name: ' 開場 ', order: 0, createdAt: '3', look: lookA },   // 名稱去頭尾空白後一樣 → 也合併
  ];
  const plan = planProjectMigration({ projectId: 'p', songs, slots });
  assert.deepEqual(plan.libraryCues.map(c => c.label), ['1', '2', '3']);
  assert.deepEqual(plan.libraryCues.map(c => c.name), ['開場', '一二三四五六七八九十一二 間奏', 'S02 間奏']);
  assert.deepEqual(plan.libraryCues[0].migratedFrom, ['x1', 'x3', 'x5']);   // 歌單順序：s1、s2、s3
  assert.deepEqual(plan.merged, [{ name: '開場', slotIds: ['x1', 'x3', 'x5'] }]);
  assert.equal(plan.slotToLibrary.x3, plan.libraryCues[0].id);
  assert.equal(plan.slotToLibrary.x2, plan.libraryCues[1].id);
  assert.equal(plan.slotToLibrary.x4, plan.libraryCues[2].id);
  // 固定的 id：跟 node:crypto 的 sha256 一樣，再跑一次結果一樣
  assert.equal(plan.libraryCues[0].id, 'lc_' + createHash('sha256').update('p:x1').digest('hex').slice(0, 20));
  assert.deepEqual(planProjectMigration({ projectId: 'p', songs, slots }), plan);
  // 沒有歌代號用歌名前 12 個字、名稱最多 100 字
  const long = planProjectMigration({ projectId: 'p', songs: [{ id: 's', name: 'N', code: 'C', order: 0 }], slots: [{ id: 'y', songId: 's', name: '長'.repeat(200), order: 0, look: empty }] });
  assert.equal([...long.libraryCues[0].name].length, 100);
});

test('搬家整條路：一首歌所有 cue → 烤 → 合併 → 解回來，每個 cue 的物件 / 機關都跟舊算法一樣', () => {
  const sc = scenario();
  const own = ownValuesByCue(sc.positions), tim = ownTimingsByCue(sc.positions);
  const rows = resolveSongMechanisms(MECHS, sc.cues, own);
  // 再加一個跟 c5 一模一樣的 cue（同名、同畫面）→ 會合併
  const cues = [...sc.cues, { id: 'c7', order: 6, status: 'master' }];
  const stateRows = { ...sc.stateRows, c7: [] };
  const positions = [...sc.positions, { cueId: 'c7', mechanismId: 'm_lift', value: 4, delaySec: null, durationSec: null }];
  const rows2 = resolveSongMechanisms(MECHS, cues, ownValuesByCue(positions)), tim2 = ownTimingsByCue(positions);
  void rows; void tim;
  const slots = cues.map(c => ({
    id: c.id, songId: 's', name: 'cue ' + (c.id === 'c7' ? 'c5' : c.id).slice(1), order: c.order, createdAt: c.id,
    look: bakeSlotLook({ states: legacyStates(sc.objects, cues, stateRows, c), mechs: MECHS, resolved: rows2.get(c.id), timings: tim2.get(c.id) }),
  }));
  const plan = planProjectMigration({ projectId: 'p', songs: [{ id: 's', name: 'S', code: 'S01', order: 0 }], slots });
  const byLib = new Map(plan.libraryCues.map(l => [l.id, l]));
  for (const c of cues) {
    const lib = byLib.get(plan.slotToLibrary[c.id]);
    assert.deepEqual(resolveLibraryObjectStates(sc.objects, lib.objects), legacyStates(sc.objects, cues, stateRows, c).map(norm), `物件 ${c.id}`);
    const back = resolveSlotMechanisms(MECHS, lib.mechanisms, c.id);
    const exp = nullFrom(rows2.get(c.id)); delete exp.m_rig; delete back.row.m_rig;
    // 合併後 fromCueId 填的是被合併的那個 cue；只比自己設的 / 沿用的 / 值
    for (const id in exp) assert.deepEqual({ ...back.row[id], fromCueId: null }, { ...exp[id], fromCueId: null }, `機關 ${c.id} ${id}`);
  }
});

test('sha256Hex 跟 node:crypto 一樣（含中文、長字串）', () => {
  for (const s of ['', 'abc', '開場 cue', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  }
});

test('suggestLabel：現有編號裡最大的開頭整數 + 1，空的就 1', () => {
  assert.equal(suggestLabel([]), '1');
  assert.equal(suggestLabel(['1', '2', '3']), '4');
  assert.equal(suggestLabel(['1', '3-1', '2.5']), '4');
  assert.equal(suggestLabel(['301', '5']), '302');
  assert.equal(suggestLabel(['A', 'B']), '1');
  assert.equal(suggestLabel(['A', '7b']), '8');
  assert.equal(suggestLabel([' 12 ']), '13');
});

test('compareLabels：自然排序 1, 2, 2.5, 3, 3-1, 12, 301', () => {
  const list = ['301', '12', '3-1', '3', '2.5', '2', '1'];
  assert.deepEqual([...list].sort(compareLabels), ['1', '2', '2.5', '3', '3-1', '12', '301']);
  assert.deepEqual(['b', 'A', '10', '9'].sort(compareLabels), ['9', '10', 'A', 'b']);
  assert.equal(compareLabels('A', 'a'), 0);
  assert.equal(compareLabels('2.10', '2.9'), 1);
  // 一樣的不調順序（排序是穩定的 → 呼叫的人用建立順序）
  assert.equal(compareLabels(' 3 ', '3'), 0);
});

test('validateLabel：不能空白 / 最多 16 個字 / 同專案不能重複（去頭尾空白、不分大小寫）', () => {
  assert.deepEqual(validateLabel('  3-1 ', ['1']), { ok: true, label: '3-1' });
  assert.deepEqual(validateLabel('', []), { ok: false, error: '編號不能空白' });
  assert.deepEqual(validateLabel('   ', []), { ok: false, error: '編號不能空白' });
  assert.deepEqual(validateLabel(null, []), { ok: false, error: '編號不能空白' });
  assert.deepEqual(validateLabel('1234567890123456', []), { ok: true, label: '1234567890123456' });
  assert.deepEqual(validateLabel('12345678901234567', []), { ok: false, error: '編號最多 16 個字' });
  assert.deepEqual(validateLabel('一二三四五六七八九十一二三四五六', []), { ok: true, label: '一二三四五六七八九十一二三四五六' });
  assert.deepEqual(validateLabel(' a1 ', ['A1']), { ok: false, error: '這個編號已經有了' });
  assert.deepEqual(validateLabel('12', ['12', '3']), { ok: false, error: '這個編號已經有了' });
  assert.deepEqual(validateLabel('1', ['10']), { ok: true, label: '1' });
});

test('orderSlots：有時間的照時間排、沒時間的跟在前一個後面、一樣的保持原本順序', () => {
  const ids = (a) => a.map(s => s.id);
  const mk = (id, order, t) => ({ id, order, videoTimeSec: t });
  // 全部有時間，亂序
  assert.deepEqual(ids(orderSlots([mk('a', 0, 30), mk('b', 1, 10), mk('c', 2, 20)])), ['b', 'c', 'a']);
  // 相同時間：保持原本順序
  assert.deepEqual(ids(orderSlots([mk('a', 0, 10), mk('b', 1, 10), mk('c', 2, 5)])), ['c', 'a', 'b']);
  // 沒時間的跟在前一個後面
  assert.deepEqual(ids(orderSlots([mk('a', 0, 30), mk('n', 1, null), mk('b', 2, 10)])), ['b', 'a', 'n']);
  // 最前面沒時間的排最前面
  assert.deepEqual(ids(orderSlots([mk('n1', 0, null), mk('a', 1, 0), mk('n2', 2, null), mk('b', 3, 5)])), ['n1', 'a', 'n2', 'b']);
  // 全部沒時間：不動
  assert.deepEqual(ids(orderSlots([mk('a', 0, null), mk('b', 1, null)])), ['a', 'b']);
  // order 重新寫成 0..n-1；傳進來的 order 不是從 0 開始 / 有重複也行（同 order 照傳進來的順序）
  const out = orderSlots([mk('a', 5, 2), mk('b', 5, 1), mk('c', 9, 1)]);
  assert.deepEqual(out.map(s => [s.id, s.order]), [['b', 0], ['c', 1], ['a', 2]]);
  assert.deepEqual(orderSlots([]), []);
  // 時間 0 和沒時間不同
  assert.deepEqual(ids(orderSlots([mk('n', 0, null), mk('z', 1, 0)])), ['n', 'z']);
});

test('validateLook：檢查物件 / 機關屬於這個專案、數量、吊掛骨架、沿用不能有時間、時間範圍', () => {
  const ctx = { objectIds: new Set(['o1', 'o2']), mechanisms: new Map([['m1', {}], ['rig', { variant: 'hoist_rig' }]]) };
  const obj = (o = {}) => ({ stage_object_id: 'o1', position: J(P(1, 1, 1)), rotation: null, scale: null, visible: 1, custom_props: null, own: 1, own_fields: 9, ...o });
  const mech = (m = {}) => ({ mechanism_id: 'm1', value: 1, delay_sec: null, duration_sec: null, carried: 0, ...m });
  const bad = (look, re) => { const r = validateLook(look, ctx); assert.equal(r.ok, false); assert.match(r.error, re); };
  assert.deepEqual(validateLook({ objects: [obj(), obj({ stage_object_id: 'o2', own: 0, own_fields: 0 })], mechanisms: [mech(), mech({ mechanism_id: 'm1' })].slice(0, 1) }, ctx), { ok: true });
  assert.deepEqual(validateLook({ objects: [], mechanisms: [] }, ctx), { ok: true });
  bad({}, /格式/);
  bad({ objects: [obj({ stage_object_id: 'zz' })], mechanisms: [] }, /不在這個專案/);
  bad({ objects: [obj(), obj()], mechanisms: [] }, /兩次/);
  bad({ objects: [obj({ visible: 2 })], mechanisms: [] }, /顯示/);
  bad({ objects: [obj({ own: 0, own_fields: 1 })], mechanisms: [] }, /沿用/);
  bad({ objects: [obj({ own_fields: 32 })], mechanisms: [] }, /自己設的欄位/);
  bad({ objects: [obj({ position: 'not json' })], mechanisms: [] }, /格式/);
  bad({ objects: [], mechanisms: [mech({ mechanism_id: 'zz' })] }, /不在這個專案/);
  bad({ objects: [], mechanisms: [mech({ mechanism_id: 'rig' })] }, /吊掛/);
  bad({ objects: [], mechanisms: [mech(), mech()] }, /兩次/);
  bad({ objects: [], mechanisms: [mech({ value: NaN })] }, /數字/);
  bad({ objects: [], mechanisms: [mech({ carried: 1, delay_sec: 1 })] }, /沿用的機關不能有時間/);
  bad({ objects: [], mechanisms: [mech({ delay_sec: -1 })] }, /0 到 3600/);
  bad({ objects: [], mechanisms: [mech({ duration_sec: 3601 })] }, /0 到 3600/);
  assert.deepEqual(validateLook({ objects: [], mechanisms: [mech({ delay_sec: 0, duration_sec: 3600 })] }, ctx), { ok: true });
  const many = { objectIds: new Set(Array.from({ length: 2001 }, (_, i) => 'o' + i)), mechanisms: new Map() };
  assert.equal(validateLook({ objects: Array.from({ length: 2001 }, (_, i) => obj({ stage_object_id: 'o' + i })), mechanisms: [] }, many).ok, false);
});

// ── 資料表 ──
function seedDb() {
  const db = freshDb();
  db.raw.exec(`
    INSERT INTO projects (id, name) VALUES ('p', 'P'), ('q', 'Q');
    INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', '歌', 0), ('s_q', 'q', '歌', 0);
    INSERT INTO stage_objects (id, project_id, mesh_name) VALUES ('o', 'p', 'A');
    INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m', 'p', 'M', 'linear');
    INSERT INTO library_cues (id, project_id, label, name) VALUES ('lc1', 'p', '1', '甲'), ('lc2', 'p', '2', '乙'), ('lcq', 'q', '1', '丙');
    INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, position, own, own_fields) VALUES ('lc1', 'o', '{"x":1,"y":1,"z":1}', 1, 1);
    INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value) VALUES ('lc1', 'm', 2);
    INSERT INTO cues (id, song_id, name, "order", library_cue_id) VALUES ('c1', 's', 'x', 0, 'lc1'), ('c2', 's', 'y', 1, 'lc1'), ('cq', 's_q', 'z', 0, 'lcq');
  `);
  return db;
}
const count = (db, t, w = '1') => Number(db.raw.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${w}`).get().n);

test('migration 0042：只新增；舊專案 cue_library = 0、舊 cue 沒有 library_cue_id', () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0042' });
  db.raw.exec(`INSERT INTO projects (id, name) VALUES ('p', 'P'); INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', 'S', 0);
    INSERT INTO cues (id, song_id, name, "order") VALUES ('c', 's', 'x', 0);`);
  const before = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name);
  applyMigrations(db, { only: '0042' });
  const after = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name);
  assert.deepEqual(after.filter(n => !before.includes(n)).sort(), ['library_cue_mechanism_positions', 'library_cue_object_states', 'library_cues']);
  assert.deepEqual(before.filter(n => !after.includes(n)), []);
  assert.equal(db.raw.prepare(`SELECT cue_library FROM projects WHERE id = 'p'`).get().cue_library, 0);
  assert.equal(db.raw.prepare(`SELECT library_cue_id FROM cues WHERE id = 'c'`).get().library_cue_id, null);
});

test('外鍵：還有歌在用的 Cue 庫的 cue 直接刪會失敗；沒人用的刪得掉（它的列跟著走）', () => {
  const db = seedDb();
  assert.throws(() => db.raw.prepare(`DELETE FROM library_cues WHERE id = 'lc1'`).run(), /FOREIGN KEY/);
  assert.equal(count(db, 'library_cues', `id = 'lc1'`), 1);
  assert.equal(count(db, 'library_cue_object_states'), 1);
  db.raw.prepare(`DELETE FROM library_cues WHERE id = 'lc2'`).run();
  assert.equal(count(db, 'library_cues', `project_id = 'p'`), 1);
  // 歌的 cue 拿掉之後就刪得掉，列跟著走
  db.raw.prepare(`DELETE FROM cues WHERE library_cue_id = 'lc1'`).run();
  db.raw.prepare(`DELETE FROM library_cues WHERE id = 'lc1'`).run();
  assert.equal(count(db, 'library_cue_object_states'), 0);
  assert.equal(count(db, 'library_cue_mechanism_positions'), 0);
});

test('外鍵：整個專案刪掉（有 cue 指到 Cue 庫的 cue）刪得掉，兩邊一起 cascade，別的專案不受影響', () => {
  const db = seedDb();
  db.raw.prepare(`DELETE FROM projects WHERE id = 'p'`).run();
  assert.equal(count(db, 'library_cues', `project_id = 'p'`), 0);
  assert.equal(count(db, 'library_cue_object_states'), 0);
  assert.equal(count(db, 'library_cue_mechanism_positions'), 0);
  assert.equal(count(db, 'cues', `song_id = 's'`), 0);
  assert.equal(count(db, 'library_cues', `id = 'lcq'`), 1);
  assert.equal(count(db, 'cues', `id = 'cq'`), 1);
});

test('外鍵：刪物件 / 刪機關，Cue 庫裡對應的列跟著刪；刪歌不會刪 Cue 庫的 cue', () => {
  const db = seedDb();
  db.raw.prepare(`DELETE FROM mechanisms WHERE id = 'm'`).run();
  assert.equal(count(db, 'library_cue_mechanism_positions'), 0);
  db.raw.prepare(`DELETE FROM stage_objects WHERE id = 'o'`).run();
  assert.equal(count(db, 'library_cue_object_states'), 0);
  db.raw.prepare(`DELETE FROM songs WHERE id = 's'`).run();
  assert.equal(count(db, 'library_cues', `project_id = 'p'`), 2);
});

test('編號：同專案不能重複（去頭尾空白、不分大小寫）、不同專案可以；不能空白、最多 16 個字', () => {
  const db = seedDb();
  const ins = (id, proj, label) => db.raw.prepare(`INSERT INTO library_cues (id, project_id, label, name) VALUES (?, ?, ?, 'n')`).run(id, proj, label);
  assert.throws(() => ins('x1', 'p', '1'), /UNIQUE/);
  assert.throws(() => ins('x2', 'p', ' 1 '), /UNIQUE/);
  ins('x3', 'p', 'A'); assert.throws(() => ins('x4', 'p', 'a'), /UNIQUE/);
  ins('x5', 'q', '2');                       // 別的專案
  ins('x6', 'p', '3-1'); ins('x7', 'p', '301');
  assert.throws(() => ins('x8', 'p', ''), /CHECK/);
  assert.throws(() => ins('x9', 'p', '   '), /CHECK/);
  assert.throws(() => ins('x10', 'p', '1'.repeat(17)), /CHECK/);
  ins('x11', 'p', '一'.repeat(16));
});

test('資料表的限制：沿用的機關不能有時間、沿用的物件不能有自己設的欄位、own_fields 0..31', () => {
  const db = seedDb();
  const m = (c, d) => db.raw.prepare(`INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, carried) VALUES (?, 'm', 1, ?, ?)`).run(c, d, 1);
  assert.throws(() => m('lc2', 1), /CHECK/);
  m('lc2', null);
  assert.throws(() => db.raw.prepare(`INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, own, own_fields) VALUES ('lc2', 'o', 0, 1)`).run(), /CHECK/);
  assert.throws(() => db.raw.prepare(`INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, own, own_fields) VALUES ('lc2', 'o', 1, 32)`).run(), /CHECK/);
  db.raw.prepare(`INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, own, own_fields) VALUES ('lc2', 'o', 0, 0)`).run();
});
