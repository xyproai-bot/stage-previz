// 畫記工具列上的「移動照片」：按下去的那一下該給誰——純函式（stickerTool.test.ts 有測）
//
// 畫記工具列開著的時候，整個 3D 畫面都是畫板，照片（貼圖）在畫板下面。同一個位置只能給一個人，所以跟一般的繪圖軟體一樣用「工具」分：
//   移動照片   按到照片 = 選到它（可以拖、縮放、旋轉）；按到空白處 = 取消選取；什麼都不畫
//   筆 / 箭頭 / 方框 / 圓圈   按哪裡都是畫（照片上也能畫）；第一次按在照片上，提醒一聲「要移動照片，先點「移動照片」」
// 畫面上誰收滑鼠（layerRouting）、現在是哪個工具（activeTool）、這一下怎麼處理（planPress）都在這裡；
// 畫面元件（AnnotationLayer、StickerLayer）只照這裡的答案掛事件、加 class。
// 「移動照片」不是畫筆，不存進筆畫（AnnTool 只有四種畫的），所以另外用 PointerTool 這個型別。

import type { AnnTool } from './annotations';

/** 工具列上的工具：四種畫的 + 移動照片 */
export type PointerTool = AnnTool | 'move';

export const MOVE_TOOL_LABEL = '移動照片';
/** 用畫的工具按在照片上時的提醒 */
export const MOVE_HINT = '要移動照片，先點「移動照片」';

/** 工具列要不要有「移動照片」：這則留言至少貼了一張照片 */
export function canMovePhotos(stickerCount: number): boolean {
  return stickerCount > 0;
}

/**
 * 現在用的是哪個工具。
 * 貼圖在調整（editing）而且還有照片 = 移動照片；否則是畫的那個。
 * 放到畫面上、拖進圖片檔都會讓貼圖進入調整 → 自動換到「移動照片」；選畫的工具、拿掉最後一張照片 → 換回去。
 */
export function activeTool(drawTool: AnnTool, stickerEditing: boolean, stickerCount: number): PointerTool {
  return stickerEditing && canMovePhotos(stickerCount) ? 'move' : drawTool;
}

export interface PressPlan {
  /** 這一下給誰：照片 / 畫記 / 沒有人（空白處，什麼都不畫） */
  to: 'sticker' | 'draw' | 'none';
  /** 取消選取（移動照片時按在空白處） */
  deselect: boolean;
  /** 用畫的工具按在照片上 → 可以提醒「要移動照片，先點「移動照片」」 */
  hintMove: boolean;
}

/**
 * 畫記工具列開著，按下去的這一下怎麼處理
 * @param onSticker 按下去的位置在不在某一張照片上
 */
export function planPress(tool: PointerTool, onSticker: boolean): PressPlan {
  if (tool === 'move') {
    return onSticker
      ? { to: 'sticker', deselect: false, hintMove: false }
      : { to: 'none', deselect: true, hintMove: false };
  }
  return { to: 'draw', deselect: false, hintMove: onSticker };
}

export interface LayerRouting {
  /** 照片收滑鼠（可以選、拖、縮放、旋轉） */
  stickersGetPointer: boolean;
  /** 畫記的那層（SVG）收滑鼠：按下去就開始畫 */
  drawSurfaceGetsPointer: boolean;
  /** 按在照片以外的地方：調整完了（沒在畫的時候）/ 只取消選取（畫的時候，工具還是「移動照片」） */
  blankPress: 'finish' | 'deselect';
}

/**
 * 誰收滑鼠。
 * @param drawing 畫記工具列開著
 * @param tool activeTool 的答案
 */
export function layerRouting(drawing: boolean, tool: PointerTool): LayerRouting {
  const move = tool === 'move';
  return {
    stickersGetPointer: move,
    drawSurfaceGetsPointer: drawing && !move,
    blankPress: drawing ? 'deselect' : 'finish',
  };
}
