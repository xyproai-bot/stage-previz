// 審片播放器的快捷鍵（導演頁、動畫師工作站、分享連結共用）——純函式（reviewShortcuts.test.ts 有測）
//
// 不會互相打架的安排（整理在 REVIEW_SHORTCUTS，使用說明的快捷鍵表直接用這份）：
//   空白鍵           播放 / 暫停
//   J / K / L        倒轉 / 停 / 播放（再按一次 J 或 L = 2 倍速）；按住 K 再按 J / L = 一格
//   , / .            往前 / 往後一格（知道影片幾格就照格數，不知道 = 1/30 秒）
//   I / O            區段的開始 / 結束（留言會蓋住這一段）
//   C                比較兩版（A/B，lib/abCompare.ts 自己處理，這裡只列出來）
//   Shift + J / K    下一個 / 上一個 cue（跟以前一樣）
//   [ / ]            上一首 / 下一首歌（只有動畫師工作站；以前是 J / K，讓給播放）
//   Esc              收起畫記、取消選的留言（停止循環）
// 打字的時候、按著 Ctrl / Cmd / Alt、漫遊模式（滑鼠被鎖住）都不算。
// 3D 畫面的 L（物件名稱）在這三頁讓給播放（StageScene transportKeys）；X（線框）照舊。

import { isTypingTarget } from '../keyTarget';

export type ReviewAction =
  | 'playPause' | 'shuttleBack' | 'shuttleStop' | 'shuttleForward'
  | 'frameBack' | 'frameForward' | 'markIn' | 'markOut'
  | 'nextCue' | 'prevCue' | 'prevSong' | 'nextSong' | 'escape';

export interface ShortcutDef {
  /** 鍵盤上的字（說明表顯示用） */
  keys: string[];
  /** 做什麼 */
  label: string;
  /** 哪些頁面有（沒寫 = 三頁都有） */
  pages?: ('preview' | 'studio' | 'share')[];
  /** 'compare' = 由比較（A/B）自己處理 */
  action: ReviewAction | 'compare';
}

export const REVIEW_SHORTCUTS: readonly ShortcutDef[] = [
  { keys: ['空白鍵'], label: '播放 / 暫停', action: 'playPause' },
  { keys: ['J'], label: '倒轉（再按一次 = 2 倍速）', action: 'shuttleBack' },
  { keys: ['K'], label: '停（按住 K 再按 J / L = 往前 / 往後一格）', action: 'shuttleStop' },
  { keys: ['L'], label: '播放（再按一次 = 2 倍速）', action: 'shuttleForward' },
  { keys: [','], label: '往前一格', action: 'frameBack' },
  { keys: ['.'], label: '往後一格', action: 'frameForward' },
  { keys: ['I'], label: '區段的開始（在這裡開始）', action: 'markIn' },
  { keys: ['O'], label: '區段的結束（到這裡結束）', action: 'markOut' },
  { keys: ['C'], label: '在兩版之間切換（比較）', action: 'compare', pages: ['preview', 'studio'] },
  { keys: ['Shift', 'J'], label: '下一個 cue', action: 'nextCue' },
  { keys: ['Shift', 'K'], label: '上一個 cue', action: 'prevCue' },
  { keys: ['['], label: '上一首歌', action: 'prevSong', pages: ['studio'] },
  { keys: [']'], label: '下一首歌', action: 'nextSong', pages: ['studio'] },
  { keys: ['Esc'], label: '收起畫記、停止循環、清掉標的區段', action: 'escape' },
];

/** 某一頁有哪些快捷鍵（說明表） */
export function shortcutsFor(page: 'preview' | 'studio' | 'share'): ShortcutDef[] {
  return REVIEW_SHORTCUTS.filter(s => !s.pages || s.pages.includes(page));
}

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

/**
 * 這個按鍵是哪一個動作；不是（或現在不該搶）回 null
 * @param pointerLocked 漫遊模式（滑鼠被鎖住，WASD / 空白鍵是走路用的）
 */
export function reviewActionFor(e: KeyLike, { pointerLocked = false }: { pointerLocked?: boolean } = {}): ReviewAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (pointerLocked) return null;
  if (isTypingTarget(e.target ?? null)) return null;
  const k = e.key;
  if (e.shiftKey) {
    if (k === 'J' || k === 'j') return 'nextCue';
    if (k === 'K' || k === 'k') return 'prevCue';
    return null;
  }
  switch (k) {
    case ' ': case 'Spacebar': {
      // 勾選框、選項上的空白鍵是勾 / 不勾（讓給它們）；其他按鈕上也是播放 / 暫停
      const t = e.target as { tagName?: string; type?: string } | null | undefined;
      if (t && typeof t.tagName === 'string' && t.tagName.toUpperCase() === 'INPUT'
        && (t.type === 'checkbox' || t.type === 'radio')) return null;
      return 'playPause';
    }
    case 'j': case 'J': return 'shuttleBack';
    case 'k': case 'K': return 'shuttleStop';
    case 'l': case 'L': return 'shuttleForward';
    case ',': return 'frameBack';
    case '.': return 'frameForward';
    case 'i': case 'I': return 'markIn';
    case 'o': case 'O': return 'markOut';
    case '[': return 'prevSong';
    case ']': return 'nextSong';
    case 'Escape': return 'escape';
    default: return null;
  }
}

// ─── J / K / L 倒轉、停、播放 ───

/** 現在的播放狀態：dir 1 = 往後播、-1 = 倒轉、0 = 停；rate = 幾倍速 */
export interface Shuttle { dir: -1 | 0 | 1; rate: number }

const SHUTTLE_RATES = [1, 2];

/** 按了 J / K / L 之後的狀態（再按一次同一個方向 = 下一個速度，最多 2 倍） */
export function nextShuttle(cur: Shuttle, action: 'shuttleBack' | 'shuttleStop' | 'shuttleForward'): Shuttle {
  if (action === 'shuttleStop') return { dir: 0, rate: 1 };
  const dir: -1 | 1 = action === 'shuttleBack' ? -1 : 1;
  if (cur.dir !== dir) return { dir, rate: 1 };
  const i = SHUTTLE_RATES.indexOf(cur.rate);
  return { dir, rate: SHUTTLE_RATES[Math.min(SHUTTLE_RATES.length - 1, (i < 0 ? 0 : i) + 1)] };
}
