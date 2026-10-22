// 某個 cue 時，每個舞台物件在哪裡（純計算，不碰資料庫）。
// 管理頁 / 導演頁 / 動畫師工作站（/api/projects/.../states）和分享連結（/api/share/.../states）
// 都用這一個函式 → 客戶在分享連結看到的位置，跟導演看到的一模一樣。
//
// 規則（cue tracking）：每個物件
//   1. 這個 cue 自己有設 → 用自己的
//   2. 沒設 → 用同一首歌裡「前面的 cue」最近一次設的（整筆一起繼承）
//   3. 前面都沒設 → 用物件的預設位置
//
// 顯示 / 隱藏 還多一層「物件預設隱藏」（stage_objects.default_hidden，0040）：
//   - 這個 cue 自己設了顯示 / 隱藏 → 用自己的（明確設定永遠優先）
//   - 沒設 → 前面的 cue 最近一次設的（跟位置一樣整筆沿用）
//   - 前面都沒設過顯示 / 隱藏 → 物件預設：預設隱藏的是隱藏、其他是顯示（跟以前一模一樣）
//   預設隱藏的物件另外多一條：前面只要有任何一個 cue 明確設過顯示 / 隱藏，就沿用最近那一次
//   （前面最近那一筆設定只調了位置、沒有碰顯示 / 隱藏，物件也不會突然又變回預設隱藏）。
//   沒有預設隱藏的物件照舊，只看前面最近那一筆。

const DEFAULT_POSITION = { x: 0, y: 0, z: 0 };
const DEFAULT_ROTATION = { pitch: 0, yaw: 0, roll: 0 };
const DEFAULT_SCALE = { x: 1, y: 1, z: 1 };

function parseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * @param {object[]} objectRows   stage_objects LEFT JOIN 這個 cue 的 cue_object_states，欄位：
 *   object_id, mesh_name, display_name, category, object_order, default_position, default_rotation,
 *   default_scale, object_locked, state_position, state_rotation, state_scale, state_visible,
 *   state_custom, state_updated_at（沒有覆寫時 state_* 都是 null）
 *   順序就是回傳的順序（SQL 已經 ORDER BY o."order", o.created_at）
 * @param {object[]} earlierRows  同一首歌、順序在這個 cue 前面的 cue 的 cue_object_states，欄位：
 *   stage_object_id, position, rotation, scale, visible, cue_order
 * @returns {object[]} 每個物件的 { objectId, meshName, displayName, category, order, locked,
 *   default, override, tracked, effective }
 */
export function buildCueStates(objectRows, earlierRows) {
  // 前面的 cue 依順序排（同順序保持原本順序），後面的蓋前面的 → 留下最近一次的設定
  const earlier = (earlierRows || [])
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (Number(a.row.cue_order) - Number(b.row.cue_order)) || (a.i - b.i));
  const tracking = new Map();
  /** 物件 id → 前面最近一次「明確設過顯示 / 隱藏」的值（預設隱藏的物件才用得到） */
  const lastVisible = new Map();
  for (const { row } of earlier) {
    tracking.set(row.stage_object_id, {
      position: row.position, rotation: row.rotation, scale: row.scale, visible: row.visible,
      fromCueOrder: row.cue_order,
    });
    if (row.visible != null) lastVisible.set(row.stage_object_id, row.visible);
  }

  return (objectRows || []).map(row => {
    const def = {
      position: parseJson(row.default_position, DEFAULT_POSITION),
      rotation: parseJson(row.default_rotation, DEFAULT_ROTATION),
      scale: parseJson(row.default_scale, DEFAULT_SCALE),
    };
    const hasOverride = row.state_updated_at != null;
    const tr = tracking.get(row.object_id);

    const pick = (own, inherited, fallback) =>
      hasOverride && own ? parseJson(own, fallback)
        : inherited ? parseJson(inherited, fallback)
        : fallback;

    const defaultHidden = !!row.default_hidden;
    const effVisible = hasOverride && row.state_visible != null ? !!row.state_visible
      : tr?.visible != null ? !!tr.visible
      : defaultHidden && lastVisible.has(row.object_id) ? !!lastVisible.get(row.object_id)
      : !defaultHidden;

    // 每個欄位的值從哪來（Cue 庫搬家用，只是多一個欄位，不影響原本的輸出）：
    //   own = 這個 cue 自己設的、tracked = 從前面的 cue 繼承（含預設隱藏的「最近一次明確設過」）、default = 預設
    const srcOf = (own, inherited) => (hasOverride && own ? 'own' : inherited ? 'tracked' : 'default');
    const visSource = hasOverride && row.state_visible != null ? 'own'
      : tr?.visible != null ? 'tracked'
      : defaultHidden && lastVisible.has(row.object_id) ? 'tracked'
      : 'default';

    return {
      objectId: row.object_id,
      meshName: row.mesh_name,
      displayName: row.display_name || row.mesh_name,
      category: row.category,
      order: row.object_order,
      locked: !!row.object_locked,
      default: def,
      // 物件預設隱藏（0040）：畫面上寫「預設隱藏」用；effective.visible 已經算進去了
      defaultHidden,
      override: hasOverride ? {
        position: parseJson(row.state_position, null),
        rotation: parseJson(row.state_rotation, null),
        scale: parseJson(row.state_scale, null),
        visible: row.state_visible == null ? null : !!row.state_visible,
        customProps: parseJson(row.state_custom, null),
        updatedAt: row.state_updated_at,
      } : null,
      // 這個物件的位置是不是從前面的 cue 繼承來的（畫面上用來區分）
      tracked: !hasOverride && !!tr,
      effective: {
        position: pick(row.state_position, tr?.position, def.position),
        rotation: pick(row.state_rotation, tr?.rotation, def.rotation),
        scale: pick(row.state_scale, tr?.scale, def.scale),
        visible: effVisible,
      },
      sources: {
        position: srcOf(row.state_position, tr?.position),
        rotation: srcOf(row.state_rotation, tr?.rotation),
        scale: srcOf(row.state_scale, tr?.scale),
        visible: visSource,
      },
    };
  });
}
