// 「最近活動」每一筆寫成一句白話（管理頁的「最近活動」、導演頁的「活動」、動畫師工作站的「活動」共用）
//
// 以前沒列到的種類會直接把後台的代號印出來（「建立 song_video」「新增mechanism」），
// 交新版後自動回到審查中那一筆沒有歌名，會寫成「把歌曲「undefined」…」。
import type { ActivityEntry } from './api';

const SONG_STATUS_LABEL: Record<string, string> = {
  todo: '待製作', in_review: '審查中', approved: '已通過', needs_changes: '需修改',
};

const TARGET_LABEL: Record<string, string> = {
  project: '專案', song: '歌曲', cue: 'cue', cue_state: '物件位置', stage_object: '物件', model: '模型',
  song_video: '影片', mechanism: '機關', drive_file: 'Drive 檔案', cue_template: '常用擺位', invite: '邀請連結',
  share_link: '分享連結', comment: '留言',
};

const ACTION_VERB: Record<string, string> = {
  create: '新增', update: '修改', delete: '刪除', reorder: '重新排序',
  reset: '重置', activate: '切換', archive: '封存', upload: '上傳', bulk_create: '批次建立', seed: '加入範例',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** 中文接英文中間空一格（「新增 cue」「修改 Drive 檔案」） */
const join = (a: string, b: string) => (/^[A-Za-z]/.test(b) ? `${a} ${b}` : `${a}${b}`);
/** 「名稱」：有名字才加引號，沒有就不寫（不會出現 undefined） */
const quoted = (name: string | undefined) => (name ? `「${name}」` : '');

export function activityTargetLabel(t: string): string {
  return TARGET_LABEL[t] ?? '項目';
}
export function activityVerb(a: string): string {
  return ACTION_VERB[a] ?? '更新';
}

/** 一筆活動 → 一句話（不含是誰做的） */
export function describeActivity(e: Pick<ActivityEntry, 'action' | 'targetType' | 'payload'>): string {
  const p = (e.payload || {}) as Record<string, unknown>;
  const action = String(e.action);
  const type = String(e.targetType);
  const target = activityTargetLabel(type);
  const verb = activityVerb(action);
  const name = str(p.name);

  // 歌曲狀態改了（含交新版後自動回到審查中）
  if (type === 'song' && action === 'update') {
    const from = str(p.statusFrom);
    const to = str(p.statusTo);
    if (from && to && from !== to) {
      const base = `把歌曲${quoted(name)}從「${SONG_STATUS_LABEL[from] ?? from}」改成「${SONG_STATUS_LABEL[to] ?? to}」`;
      return p.auto ? `${base}（交了新版${str(p.label) ? ` ${str(p.label)}` : ''}，自動改的）` : base;
    }
    // 同一個狀態再決定一次（已通過 V1 → 通過 V2）
    if (from && to && from === to && (to === 'approved' || to === 'needs_changes')) {
      return `把歌曲${quoted(name)}再標一次「${SONG_STATUS_LABEL[to]}」`;
    }
  }
  // 影片版本
  if (type === 'song_video') {
    const label = str(p.label);
    const title = str(p.title);
    if (action === 'create') return `交了影片${label ? ` ${label}` : ''}${quoted(title)}`;
    if (action === 'delete') return `刪除影片${label ? ` ${label}` : ''}${quoted(title)}`;
  }
  // 模型切換版本
  if (type === 'model' && action === 'activate') {
    const toKey = str(p.toKey);
    const assetName = str(p.assetName);
    if (assetName) return `改用模型庫的「${assetName}」`;
    return `切換模型版本${toKey ? `（${toKey.split('/').pop()}）` : ''}`;
  }
  if (action === 'reorder') {
    const count = num(p.count);
    return count != null ? `重新排序 ${count} ${join("個", target)}` : join("重新排序", target);
  }
  if (action === 'bulk_create') {
    const inserted = num(p.inserted);
    return type === 'cue' ? `批次建立${inserted != null ? ` ${inserted} 個` : ''} cue` : `從模型建立${inserted != null ? ` ${inserted} 個` : ''}物件`;
  }
  if (action === 'seed') {
    const inserted = num(p.inserted);
    return `加入${inserted != null ? ` ${inserted} 個` : ''}範例物件`;
  }
  if (type === 'cue_state' && action === 'reset') {
    const cueName = str(p.cueName);
    const objectName = str(p.objectName);
    return `把${cueName ? `「${cueName}」` : ''} cue 裡的${quoted(objectName) || '物件'}重置回預設位置`;
  }
  return `${join(verb, target)}${quoted(name)}`;
}
