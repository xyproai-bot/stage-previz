import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ANN_TOOLS, ANN_TOOL_LABEL, type AnnTool } from './annotations';
import type { AnnImage } from './stickerRules';
import { pickSticker } from './stickers';
import {
  MOVE_HINT, MOVE_TOOL_LABEL, activeTool, canMovePhotos, layerRouting, planPress, type PointerTool,
} from './stickerTool';

// CSS 用 ?raw 讀會是空的（測試不處理 CSS），直接讀檔
const readText = (rel: string) => new TextDecoder().decode(readFileSync(new URL(rel, import.meta.url)));
const annCss = readText('../../components/AnnotationLayer.css');
const stkCss = readText('../../components/StickerLayer.css');

const A = 'ca_aaaaaaaa11112222';
const el = (extra: Partial<AnnImage> = {}): AnnImage => ({ type: 'image', attachmentId: A, x: 0.5, y: 0.5, w: 0.2, h: 0.3, rot: 0, opacity: 0.8, ...extra });
const W = 1000, H = 500;

describe('畫記工具列的「移動照片」：有貼照片才有', () => {
  it('這則留言至少貼了一張照片才顯示', () => {
    expect(canMovePhotos(0)).toBe(false);
    expect(canMovePhotos(1)).toBe(true);
    expect(canMovePhotos(4)).toBe(true);
  });

  it('貼圖在調整 + 還有照片 = 移動照片；其他都是畫的那個工具', () => {
    for (const t of ANN_TOOLS) {
      expect(activeTool(t, true, 1)).toBe('move');
      expect(activeTool(t, false, 1)).toBe(t);
      // 沒有照片 → 沒有「移動照片」可選（拿掉最後一張就自動換回畫的工具）
      expect(activeTool(t, true, 0)).toBe(t);
      expect(activeTool(t, false, 0)).toBe(t);
    }
  });

  it('文字都是繁體中文，不含英文字母', () => {
    expect(MOVE_TOOL_LABEL).toBe('移動照片');
    expect(MOVE_HINT).toBe('要移動照片，先點「移動照片」');
    expect(MOVE_HINT).toContain(MOVE_TOOL_LABEL);
    for (const s of [MOVE_TOOL_LABEL, MOVE_HINT]) expect(s).not.toMatch(/[A-Za-z]/);
  });
});

describe('按下去的這一下怎麼處理（planPress）', () => {
  it('移動照片：按到照片 = 給照片，不畫、不取消選取', () => {
    expect(planPress('move', true)).toEqual({ to: 'sticker', deselect: false, hintMove: false });
  });

  it('移動照片：按到空白處 = 取消選取，什麼都不畫', () => {
    expect(planPress('move', false)).toEqual({ to: 'none', deselect: true, hintMove: false });
  });

  it('畫的工具：按在照片上照樣畫，並且可以提醒要先點「移動照片」', () => {
    for (const t of ANN_TOOLS) {
      expect(planPress(t, true)).toEqual({ to: 'draw', deselect: false, hintMove: true });
    }
  });

  it('畫的工具：按在空白處照樣畫，不提醒', () => {
    for (const t of ANN_TOOLS) {
      expect(planPress(t, false)).toEqual({ to: 'draw', deselect: false, hintMove: false });
    }
  });

  it('只有「移動照片」不會開始畫', () => {
    const tools: PointerTool[] = ['move', ...ANN_TOOLS];
    for (const t of tools) for (const onSticker of [true, false]) {
      expect(planPress(t, onSticker).to === 'draw').toBe(t !== 'move');
    }
  });

  it('跟點到照片的判斷接起來：轉過的照片，外框角落那一小塊不算點到照片（照畫、不提醒）', () => {
    const rotated = el({ rot: 45, w: 0.3, h: 0.3 });
    const inside = [500, 250] as const;        // 中心
    const cornerOfBox = [500 - 0.15 * W + 4, 250 - 0.15 * H + 4] as const;  // 沒轉的外框左上角附近，轉了 45 度後是空的
    expect(planPress('pen', !!pickSticker(inside, [rotated], W, H)).hintMove).toBe(true);
    expect(planPress('pen', !!pickSticker(cornerOfBox, [rotated], W, H)).hintMove).toBe(false);
    expect(planPress('move', !!pickSticker(cornerOfBox, [rotated], W, H)).deselect).toBe(true);
  });
});

describe('誰收滑鼠（layerRouting）', () => {
  it('畫記工具列開著 + 移動照片：照片收，畫記那層讓開；按空白處只取消選取（工具不換）', () => {
    expect(layerRouting(true, 'move')).toEqual({ stickersGetPointer: true, drawSurfaceGetsPointer: false, blankPress: 'deselect' });
  });

  it('畫記工具列開著 + 畫的工具：畫記那層收，照片不收', () => {
    for (const t of ANN_TOOLS as readonly AnnTool[]) {
      expect(layerRouting(true, t)).toEqual({ stickersGetPointer: false, drawSurfaceGetsPointer: true, blankPress: 'deselect' });
    }
  });

  it('沒在畫：畫記那層從來不收；貼圖在調整才收；按別的地方 = 調整完了', () => {
    expect(layerRouting(false, 'move')).toEqual({ stickersGetPointer: true, drawSurfaceGetsPointer: false, blankPress: 'finish' });
    expect(layerRouting(false, 'arrow')).toEqual({ stickersGetPointer: false, drawSurfaceGetsPointer: false, blankPress: 'finish' });
  });

  it('把工具選擇接起來：放到畫面上（貼圖進入調整）→ 換到移動照片；選畫的工具（貼圖離開調整）→ 換回去', () => {
    // 畫的時候選著筆，貼圖沒在調整
    let editing = false;
    expect(layerRouting(true, activeTool('pen', editing, 1)).drawSurfaceGetsPointer).toBe(true);
    // 放到畫面上 / 拖進圖片檔 → place() 讓貼圖進入調整
    editing = true;
    const afterPlace = layerRouting(true, activeTool('pen', editing, 1));
    expect(afterPlace.stickersGetPointer).toBe(true);
    expect(afterPlace.drawSurfaceGetsPointer).toBe(false);
    // 點「筆」→ setTool() 讓貼圖離開調整
    editing = false;
    const afterPen = layerRouting(true, activeTool('pen', editing, 1));
    expect(afterPen.stickersGetPointer).toBe(false);
    expect(afterPen.drawSurfaceGetsPointer).toBe(true);
    // 再點「移動照片」→ edit() 讓貼圖進入調整
    editing = true;
    expect(layerRouting(true, activeTool('pen', editing, 1)).stickersGetPointer).toBe(true);
  });

  it('四種畫的工具都有中文名字（工具列的提示用）', () => {
    for (const t of ANN_TOOLS) expect(ANN_TOOL_LABEL[t]).toMatch(/^[一-鿿]+$/);
  });
});

describe('照片永遠在筆畫下面（CSS 的上下順序）', () => {
  const zOf = (css: string, selector: RegExp): number => {
    const m = css.match(selector);
    if (!m) throw new Error(`找不到 ${selector}`);
    return Number(m[1]);
  };
  const svgZ = zOf(annCss, /\.ann-layer__svg\s*\{[^}]*?z-index:\s*(\d+)/);
  const selectedZ = zOf(stkCss, /\.stk\.is-selected\s*\{\s*z-index:\s*(\d+)/);

  it('筆畫的那層比選到的照片高（選到的照片只比別張照片高）', () => {
    expect(selectedZ).toBeGreaterThan(0);
    expect(svgZ).toBeGreaterThan(selectedZ);
  });

  it('照片下面那一條、工具列、小標、提示都比筆畫高（不會被筆畫蓋住或擋住）', () => {
    expect(zOf(stkCss, /\.stk-panel\s*\{[^}]*?z-index:\s*(\d+)/)).toBeGreaterThan(svgZ);
    expect(zOf(annCss, /\.ann-toolbar\s*\{[^}]*?z-index:\s*(\d+)/)).toBeGreaterThan(svgZ);
    expect(zOf(annCss, /\.ann-badge\s*\{[^}]*?z-index:\s*(\d+)/)).toBeGreaterThan(svgZ);
    expect(zOf(stkCss, /\.stk-pill\s*\{[^}]*?z-index:\s*(\d+)/)).toBeGreaterThan(svgZ);
  });

  it('選「移動照片」時畫記那層讓開（滑鼠才到得了照片），照片自己收滑鼠', () => {
    expect(annCss).toMatch(/\.ann-layer\.is-moving\s+\.ann-layer__svg\s*\{\s*pointer-events:\s*none/);
    expect(stkCss).toMatch(/\.stk\.is-editable\s*\{\s*pointer-events:\s*auto/);
  });
});
