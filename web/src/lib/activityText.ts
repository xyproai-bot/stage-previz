// 「最近活動」每一筆寫成一句白話（管理頁的「最近活動」、導演頁的「活動」、動畫師工作站的「活動」共用）
//
// 以前沒列到的種類會直接把後台的代號印出來（「建立 song_video」「新增mechanism」），
// 交新版後自動回到審查中那一筆沒有歌名，會寫成「把歌曲「undefined」…」。
import type { ActivityEntry } from './api';
import { MEMBER_ROLE_NAME, type MemberRole } from './projectMembers';

const SONG_STATUS_LABEL: Record<string, string> = {
  todo: '待製作', in_review: '審查中', approved: '已通過', needs_changes: '需修改',
};

const TARGET_LABEL: Record<string, string> = {
  project: '專案', song: '歌曲', cue: 'cue', library_cue: 'Cue 庫的 cue', cue_state: '物件位置', song_cue_states: '物件位置', stage_object: '物件', model: '模型',
  song_video: '影片', mechanism: '機關', mechanism_group: '一排機關', drive_file: 'Drive 檔案', cue_template: '常用擺位', invite: '邀請連結',
  share_link: '分享連結', comment: '留言', member: '成員',
};

const ACTION_VERB: Record<string, string> = {
  create: '新增', update: '修改', delete: '刪除', reorder: '重新排序',
  reset: '重置', activate: '切換', archive: '封存', upload: '上傳', bulk_create: '批次建立', seed: '加入範例', restore: '救回',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** 中文接英文中間空一格（「新增 cue」「修改 Drive 檔案」） */
const join = (a: string, b: string) => (/^[A-Za-z]/.test(b) ? `${a} ${b}` : `${a}${b}`);
/** 83 → 1:23 */
const fmtClock = (sec: number) => { const t = Math.max(0, Math.floor(sec)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
/** 「名稱」：有名字才加引號，沒有就不寫（不會出現 undefined） */
const quoted = (name: string | undefined) => (name ? `「${name}」` : '');

/** 秒數：2 → 2、0.5 → 0.5 */
const fmtSec = (n: number) => String(Math.round(n * 100) / 100);
/** Cue 3「名稱」（編號是用戶自己打的文字） */
const cueName = (label: string | undefined, name: string | undefined) => `Cue${label ? ` ${label}` : ''}${quoted(name)}`;

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

  // Cue 庫（編號是用戶自己打的文字：「12」「3-1」）
  if (type === 'library_cue') {
    const lab = str(p.label) ?? '';
    const full = (l: string | undefined, n: string | undefined) => quoted([l, n].filter(Boolean).join(' '));
    if (action === 'create') {
      const bl = str(p.basedOnLabel), bn = str(p.basedOnName);
      // 導演在調整舞台複製 / 另存（另存會把這首歌的這個 cue 換成新的）
      if (p.kind === 'stage_copy' && (bl || bn)) return `從${full(bl, bn)}複製成${full(lab, name)}`;
      if (p.kind === 'stage_save_as' && (bl || bn)) {
        const song = str(p.songName);
        return `在調整舞台從${full(bl, bn)}另存成${full(lab, name)}${song ? `，歌曲${quoted(song)}改用它` : ''}`;
      }
      return bl || bn ? `從${full(bl, bn)}另存成${full(lab, name)}` : `新增 Cue 庫的 cue${full(lab, name)}`;
    }
    if (action === 'delete') return `刪除 Cue 庫的${full(lab, name)}`;
    if (action === 'update') {
      if (p.kind === 'rename') return `把${quoted(lab)}改名成${quoted(str(p.toName))}`;
      if (p.kind === 'relabel') return `把${full(str(p.fromLabel), name)}的編號改成 ${str(p.toLabel) ?? ''}`.trim();
      if (p.kind === 'crossfade') {
        const to = num(p.toSeconds);
        return `把 ${cueName(lab, name)}的轉場改成 ${to != null ? fmtSec(to) : '新的'} 秒（用到的歌一起變）`;
      }
      if (p.kind === 'look') {
        const songs = num(p.songCount);
        return `更新 Cue 庫的${full(lab, name)}${songs ? `（${songs} 首歌在用）` : ''}`;
      }
      // 導演在調整舞台把機關位置存回 Cue 庫 / 復原（用到這個 cue 的歌一起變）
      if (p.kind === 'stage_save' || p.kind === 'stage_undo') {
        const changed = num(p.changed);
        const songs = Array.isArray(p.songs) ? p.songs.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
        const total = num(p.songCount);
        const list = total != null && total > songs.length ? `${songs.join('、')} 等 ${total} 首` : songs.join('、');
        const together = songs.length > 0 ? `${changed != null ? '，' : ''}${list} 會一起變` : '';
        const inner = `${changed != null ? `改了 ${changed} 個機關` : ''}${together}`;
        return p.kind === 'stage_undo'
          ? `復原 Cue 庫的${full(lab, name)}的舞台調整${inner ? `（${inner}）` : ''}`
          : `在調整舞台存回 Cue 庫的${full(lab, name)}${inner ? `（${inner}）` : ''}`;
      }
    }
  }
  // 這首歌的 cue 指到 Cue 庫的 cue（加、換、改時間、拿掉）
  if (type === 'cue' && str(p.libraryLabel) !== undefined) {
    const song = str(p.songName);
    const lib = quoted([str(p.libraryLabel), str(p.libraryName)].filter(Boolean).join(' '));
    const at = num(p.videoTimeSec);
    const t = at != null ? fmtClock(at) : '';
    const songPart = song ? `歌曲${quoted(song)}` : '這首歌';
    if (action === 'create') return `在${songPart}${t} 加上${lib}`;
    if (action === 'delete') return `從${songPart}拿掉${t ? ` ${t} 的` : ''}${lib}`;
    if (action === 'update' && p.kind === 'repoint') return `把${songPart}${t} 的 cue 換成${lib}`;
    if (action === 'update' && p.kind === 'crossfade') {
      const to = num(p.toSeconds);
      const cue = cueName(str(p.libraryLabel), str(p.libraryName));
      return to == null || p.useLibrary === true
        ? `${songPart}的 ${cue}轉場改回用 Cue 庫的`
        : `${songPart}的 ${cue}另外設轉場 ${fmtSec(to)} 秒`;
    }
    if (action === 'update' && p.kind === 'retime') {
      const from = num(p.fromTimeSec), to = num(p.toTimeSec);
      return `把${songPart}${from != null ? fmtClock(from) : ''} 的 cue 時間${to != null ? `改成 ${fmtClock(to)}` : '清掉'}`;
    }
  }

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
    if (action === 'restore') return `從最近刪除救回影片${label ? ` ${label}` : ''}${quoted(title)}`;
  }
  // 專案結束清影片（storage.mjs）
  if (type === 'project' && p.wrapUp === true) {
    const removed = num(p.removedCount) ?? 0;
    const moved = num(p.queuedForInfrequent) ?? 0;
    const bits = [removed ? `清掉 ${removed} 版影片（30 天內可以救回來）` : '', moved ? `${moved} 版改成長期存放` : ''].filter(Boolean);
    return `專案結束清影片${bits.length ? `：${bits.join('、')}` : ''}`;
  }
  // 專案成員：加進專案 / 改角色 / 移出專案（後台寫好一句 summary）
  if (type === 'member') {
    const summary = str(p.summary);
    if (summary) return summary;
    if (action === 'delete') return name ? `把${quoted(name)}移出專案` : '移出了一位成員';
    return name ? `調整成員${quoted(name)}的角色` : '調整了一位成員的角色';
  }
  // 邀請連結：建立（寫給誰、什麼角色）/ 撤銷
  if (type === 'invite') {
    if (action === 'create') {
      const role = MEMBER_ROLE_NAME[String(p.role) as MemberRole];
      return `建立邀請連結${quoted(name)}${role ? `（${role}）` : ''}`;
    }
    if (action === 'delete') return '撤銷一條邀請連結';
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
  // 對開拆成兩個各自動的機關
  if (type === 'mechanism' && action === 'update' && p.unsplit === true) {
    const a = str(p.nameA), b = str(p.nameB);
    return `把對開機關${quoted(name)}拆成兩個機關${a && b ? `${quoted(a)}${quoted(b)}` : ''}`;
  }
  // 一排機關（機關 v2 第 3 階段）
  if (type === 'mechanism' && action === 'bulk_create') {
    const count = num(p.count);
    return `一次建立${count != null ? ` ${count} 個` : ''}機關${quoted(name)}`;
  }
  if (type === 'mechanism_group') {
    if (action === 'delete') return `刪除一排機關${quoted(name)}${num(p.mechanisms) != null ? `（連同 ${num(p.mechanisms)} 個機關）` : ''}`;
    if (action === 'update' && p.dissolved === true) return `解散一排機關${quoted(name)}（${num(p.mechanisms) ?? 0} 個機關留著）`;
    if (action === 'update') return `修改一排機關${quoted(name)}${p.shared === true ? '的共用設定' : ''}`;
  }
  if (action === 'bulk_create') {
    const inserted = num(p.inserted);
    return type === 'cue' ? `批次建立${inserted != null ? ` ${inserted} 個` : ''} cue` : `從模型建立${inserted != null ? ` ${inserted} 個` : ''}物件`;
  }
  if (action === 'seed') {
    const inserted = num(p.inserted);
    return `加入${inserted != null ? ` ${inserted} 個` : ''}範例物件`;
  }
  // 物件「預設隱藏」開關
  if (type === 'stage_object' && action === 'update' && p.changes && typeof p.changes === 'object' && 'defaultHidden' in (p.changes as Record<string, unknown>)) {
    const on = !!(p.changes as Record<string, unknown>).defaultHidden;
    return `${on ? '把' : '取消'}物件${quoted(name)}${on ? '設成預設隱藏' : '的預設隱藏'}`;
  }
  // 一首歌所有 cue 的物件一次回到預設位置 / 復原
  if (type === 'song_cue_states') {
    const songName = str(p.songName);
    if (action === 'reset') {
      const removed = num(p.removed);
      return `把歌曲${quoted(songName)}所有 cue 的物件重置回預設位置${removed != null ? `（清掉 ${removed} 筆）` : ''}`;
    }
    const restored = num(p.restored);
    return `復原歌曲${quoted(songName)}所有 cue 的物件位置${restored != null ? `（寫回 ${restored} 筆）` : ''}`;
  }
  if (type === 'cue_state' && action === 'reset') {
    const cueName = str(p.cueName);
    const objectName = str(p.objectName);
    return `把${cueName ? `「${cueName}」` : ''} cue 裡的${quoted(objectName) || '物件'}重置回預設位置`;
  }
  return `${join(verb, target)}${quoted(name)}`;
}
