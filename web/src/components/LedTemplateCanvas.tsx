import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter, FlipHorizontal2, BoxSelect, FlipVertical2, Maximize, Redo2, RotateCw, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import Icon from './Icon';
import { useCanvasView } from '../lib/useCanvasView';
import {
  flaggedKeys, gridStep, SNAP_SCREEN_PX, snapTargets,
  type Handle, type SnapGuide, type SnapTargets, type View,
} from '../lib/ledTemplateEdit';
import {
  applyMarquee, boundsOf, flipPatches, groupTargets, isAdditive, marqueeBox, marqueeHits, movePatches, nudgeRects, pressSelect, releaseSelect,
  GROUP_HANDLES, isCornerHandle, rotatePatches, sameSelection, selectAllKeys, selectionInfo, selectionInfoText, selectionTag, snapGroupMove, snapGroupScale,
  type GroupHandle, type PressPending, type Selection,
} from '../lib/ledTemplateSelect';
import type { ItemPatch, ItemPatchEntry } from '../lib/ledTemplateDraft';
import { panelHue, type CanvasSize, type PixelRect } from '../lib/ledMap';
import { defaultDestSize, screenSizeLabel, type PlacementInput, type ScreenDef } from '../lib/ledTemplate';
import { upDirection, upText } from '../lib/ledTemplatePattern';
import { drawLayers, type FullMap, type LayerBackdrop } from '../lib/ledTemplateContentDraw';
import './LedTemplateCanvas.css';

/**
 * 版型畫布（拖拉編輯）：版型的畫布 + 每塊放進去的螢幕（長方形，寫著名字和「實際 W×H → 這個版型 w×h」）。
 *   點一下選一塊，Shift / Ctrl（Cmd）點 = 加選或取消選，空白處拖曳 = 框選（碰到的都選，Shift / Ctrl 加選），Ctrl+A 全選，點空白處取消選取。
 *   拖曳移動（選了好幾塊就整組一起動，吸附的是整組的外框）、拖角落縮放（預設鎖長寬比，按住 Shift 橫直各縮各的；選了好幾塊
 *   就是拖虛線外框的角落或邊，整組每一塊的位置和大小乘同樣的倍數）、方向鍵微調整組（Shift 10 px）、
 *   Delete 拿掉選到的（好幾塊只問一次）、Ctrl+Z / Ctrl+Shift+Z 復原重做（整組一個動作 = 一步）。
 *   位置、大小一定是整數；靠近沒選到的螢幕的邊或畫布的邊會吸過去（按住 Alt 不吸附）。
 *   重疊、超出畫布的畫紅框。滾輪縮放、按住空白鍵拖曳（或中鍵拖曳）平移、手機平板雙指縮放平移。
 *   每塊螢幕的框裡可以畫「對位圖內容」（整張畫布的測試圖裡屬於這塊螢幕的那一段，照轉動、翻轉擺進來），
 *   最底下可以墊一張自己載入的「底圖」；兩個都畫在同一張 canvas 上（lib/ledTemplateContentDraw.ts），框和字還是網頁元素。
 * 數字怎麼算：lib/ledTemplateEdit.ts（有單元測試）。
 */

export type PatchHow = 'live' | { tag?: string };
export type { ItemPatch, ItemPatchEntry };

interface Props {
  canvas: CanvasSize;
  scalePct: number;
  defs: readonly ScreenDef[];
  items: readonly PlacementInput[];
  /** 選到的螢幕（可以好幾塊；不存在的代號呼叫的人先拿掉） */
  selected: Selection;
  /** 換版型時重新「符合畫面」 */
  resetKey: string;
  canUndo: boolean;
  canRedo: boolean;
  onSelect: (keys: string[]) => void;
  /** 一次改好幾塊（整組拖、微調、各自轉…）；交給外面記成「一步」復原 */
  onPatch: (patches: readonly ItemPatchEntry[], how: PatchHow) => void;
  /** 一次拖曳開始 / 結束（結束時記成復原的一步） */
  onGesture: (phase: 'start' | 'end') => void;
  /** 拿掉選到的螢幕（好幾塊時外面只問一次） */
  onRemove: (keys: string[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** 有給 → 工具列多「左右置中」「上下置中」：選到的整組（沒選就全部）放到畫布正中間 */
  onCenter?: (axis: 'x' | 'y') => void;
  /** 整張畫布的測試圖（畫好留著的那張）；還沒有 = null */
  fullMap?: FullMap | null;
  /** 框裡畫對位圖內容 */
  showContent?: boolean;
  /** 框裡對位圖內容的不透明度（0～1，預設 1）；調低可以透出底圖 */
  contentOpacity?: number;
  /** 底圖（含開關、不透明度、怎麼擺）；沒有 = null */
  backdrop?: LayerBackdrop | null;
  /** 工具列下面那排開關 */
  layersBar?: ReactNode;
  /**
   * 大小鎖死（自動貼 UV 的排版用）：螢幕的大小是 LED 規格決定的，所以沒有縮放把手（單塊、整組都沒有），只能移動、轉 90°、翻轉。
   * 沒給 = 跟版型編輯器一樣可以縮放。
   */
  lockSize?: boolean;
  /** 能不能用 Delete 拿掉選到的（預設可以；排版時每一塊都是必要的，不能拿掉） */
  allowRemove?: boolean;
  /** 「轉 90°」「左右翻轉」「上下翻轉」怎麼改選到的螢幕（排版時連在一起的整組要當一個整體轉）；沒給 = 各自在原地轉 / 翻 */
  transformPatches?: (kind: 'rotate' | 'flipH' | 'flipV', selected: readonly PlacementInput[]) => ItemPatchEntry[];
  /** 選到的螢幕裡有沒有能轉 / 翻的（按鈕亮不亮）；沒給 = 有選就亮 */
  canTransform?: (selected: readonly PlacementInput[]) => boolean;
  /** 畫布上方的名稱（預設「版型畫布」） */
  canvasName?: string;
  /** 每一塊框裡寫的大小（預設「實際 W×H → 這個版型 w×h」） */
  sizeLabel?: (def: ScreenDef, item: PlacementInput) => string;
  /** 畫布上沒有螢幕時的說明 */
  emptyText?: string;
  /** 畫布底下那一行操作說明 */
  hint?: string;
}

type Pt = { x: number; y: number };
type Drag =
  | { kind: 'move'; keys: string[]; startRects: PixelRect[]; anchor: string; baseSel: string[]; pending: PressPending; startPt: Pt; startClient: Pt; targets: SnapTargets; started: boolean }
  | { kind: 'resize'; key: string; handle: Handle; startRect: PixelRect; targets: SnapTargets }
  | { kind: 'gscale'; handle: GroupHandle; keys: string[]; startRects: PixelRect[]; targets: SnapTargets }
  | { kind: 'marquee'; startPt: Pt; startClient: Pt; base: string[]; additive: boolean; last: string[]; started: boolean }
  | { kind: 'pan'; startLocal: Pt; startView: View };

const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];
const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
const GROUP_CURSOR: Record<GroupHandle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};
/** 整組外框在畫面上短於這個長度（像素）的那一邊，不放邊的把手（會跟角落的把手疊在一起） */
const EDGE_HANDLE_MIN_PX = 44;
const MOVE_SLOP_PX = 3;
const STRETCH_TOLERANCE = 0.02;

export function zoomText(zoom: number): string {
  const pct = zoom * 100;
  return `${pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1))}%`;
}

const DEFAULT_HINT = '空白處拖曳框選（Shift / Ctrl 加選，Ctrl+A 全選）· 拖曳螢幕移動，選了好幾塊就一起動 · 拖角落縮放（預設鎖長寬比，Shift 可以自由拉；選了好幾塊就是整組一起縮放，拖虛線外框的角落或邊）· 方向鍵微調 1 像素（Shift 10 像素）· 靠近邊會吸附（Alt 不吸附）· 滾輪縮放 · 按住空白鍵拖曳、滑鼠中鍵拖曳或雙指平移';
const DEFAULT_EMPTY = '版型裡還沒有螢幕。在右邊的清單按「加入版型」，就會放在畫布上，再用滑鼠拖到想要的位置。';

export default function LedTemplateCanvas({
  canvas, scalePct, defs, items, selected, resetKey, canUndo, canRedo, onSelect, onPatch, onGesture, onRemove, onUndo, onRedo, onCenter,
  fullMap = null, showContent = false, contentOpacity = 1, backdrop = null, layersBar = null,
  lockSize = false, allowRemove = true, transformPatches, canTransform, canvasName = '版型畫布', sizeLabel = screenSizeLabel, emptyText = DEFAULT_EMPTY, hint = DEFAULT_HINT,
}: Props) {
  const api = useCanvasView(canvas, resetKey);
  const { view, size } = api;
  const dragRef = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [grabbing, setGrabbing] = useState(false);
  /** 框選拉出來的框（畫布位置，可以有小數）；沒在框選 = null */
  const [marquee, setMarquee] = useState<PixelRect | null>(null);
  /** 按住空白鍵 = 左鍵拖曳變平移 */
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceRef = useRef(false);
  const hoverRef = useRef(false);
  const pixRef = useRef<HTMLCanvasElement>(null);

  const defByKey = useMemo(() => new Map(defs.map(d => [d.key, d])), [defs]);
  const placed = useMemo(() => items.filter(i => defByKey.has(i.key)), [items, defByKey]);
  const flagged = useMemo(() => flaggedKeys(placed.map(i => ({ key: i.key, dest: i.dest })), canvas), [placed, canvas]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  /** 選到的螢幕（照版型裡的順序） */
  const selItems = useMemo(() => placed.filter(i => selectedSet.has(i.key)), [placed, selectedSet]);
  const selKeys = useMemo(() => selItems.map(i => i.key), [selItems]);
  /** 剛好只選一塊：那一塊自己的四個角把手（選了好幾塊是整組外框的把手） */
  const selInfo = useMemo(() => selectionInfo(placed, selKeys), [placed, selKeys]);
  const sel = selItems.length === 1 ? selItems[0] : null;
  const groupBox = useMemo(() => (selItems.length > 1 ? boundsOf(selItems.map(i => i.dest)) : null), [selItems]);

  const targetsFor = (key: string): SnapTargets =>
    snapTargets(canvas, placed.filter(i => i.key !== key).map(i => i.dest));

  // 按住空白鍵拖曳平移：滑鼠在畫布上（或畫布有焦點）時才接空白鍵，在輸入欄位 / 按鈕上打字不受影響
  useEffect(() => {
    const host = api.hostRef.current;
    const setSpace = (on: boolean) => { if (spaceRef.current !== on) { spaceRef.current = on; setSpaceHeld(on); } };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target as Node | null;
      if (!(host && t && host.contains(t)) && !(hoverRef.current && t === document.body)) return;
      e.preventDefault();
      setSpace(true);
    };
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    const onBlur = () => setSpace(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [api.hostRef]);

  function endDrag(release?: { pointerId: number }) {
    const d = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    setGrabbing(false);
    setMarquee(null);
    if (d && (d.kind === 'resize' || d.kind === 'gscale' || (d.kind === 'move' && d.started))) onGesture('end');
    if (release) { try { api.hostRef.current?.releasePointerCapture(release.pointerId); } catch { /* 已經放開了 */ } }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (api.touchDown(e)) { endDrag(); return; }   // 兩指縮放 / 平移
    if (e.button !== 0 && e.button !== 1) return;
    const host = api.hostRef.current;
    if (!host) return;
    host.focus({ preventScroll: true });
    const target = e.target as HTMLElement;
    const handleEl = target.closest('[data-handle]') as HTMLElement | null;
    const itemEl = target.closest('[data-key]') as HTMLElement | null;
    try { host.setPointerCapture(e.pointerId); } catch { /* 有些瀏覽器不給 */ }
    e.preventDefault();
    const pt = api.point(e);
    const startClient = { x: e.clientX, y: e.clientY };
    // 中鍵、或按著空白鍵的左鍵：平移（不管底下有沒有螢幕）
    if (e.button === 1 || spaceRef.current) { dragRef.current = { kind: 'pan', startLocal: api.local(e), startView: view }; setGrabbing(true); return; }
    if (handleEl && sel) {
      dragRef.current = { kind: 'resize', key: sel.key, handle: handleEl.dataset.handle as Handle, startRect: sel.dest, targets: targetsFor(sel.key) };
      onGesture('start');
      return;
    }
    if (handleEl && groupBox) {
      // 複選：拖整組外框的把手 = 整組一起縮放（一次拖曳 = 復原一步）
      dragRef.current = {
        kind: 'gscale', handle: handleEl.dataset.handle as GroupHandle, keys: selKeys, startRects: selItems.map(i => i.dest),
        targets: groupTargets(canvas, placed, selKeys),
      };
      onGesture('start');
      return;
    }
    const key = itemEl?.dataset.key;
    if (key && placed.some(i => i.key === key)) {
      const press = pressSelect(selKeys, key, isAdditive(e));
      if (!sameSelection(press.selection, selKeys)) onSelect(press.selection);
      const moving = placed.filter(i => press.selection.includes(i.key));
      dragRef.current = {
        kind: 'move', keys: moving.map(i => i.key), startRects: moving.map(i => i.dest), anchor: key, baseSel: press.selection, pending: press.pending,
        startPt: pt, startClient, targets: groupTargets(canvas, placed, press.selection), started: false,
      };
      return;
    }
    // 空白處：拖曳 = 框選（沒拖 = 點一下，放開時取消選取）
    dragRef.current = { kind: 'marquee', startPt: pt, startClient, base: [...selKeys], additive: isAdditive(e), last: [...selKeys], started: false };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (api.touchMove(e)) return;
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      const l = api.local(e);
      api.setView({ ...d.startView, panX: d.startView.panX + (l.x - d.startLocal.x), panY: d.startView.panY + (l.y - d.startLocal.y) });
      return;
    }
    const p = api.point(e);
    const threshold = SNAP_SCREEN_PX / view.zoom;
    const snap = !e.altKey;
    if (d.kind === 'marquee') {
      if (!d.started) {
        if (Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < MOVE_SLOP_PX) return;
        d.started = true;
      }
      const box = marqueeBox(d.startPt, p);
      setMarquee(box);
      const next = applyMarquee(d.base, marqueeHits(box, placed), d.additive);
      if (!sameSelection(next, d.last)) { d.last = next; onSelect(next); }
      return;
    }
    if (d.kind === 'move') {
      if (!d.started) {
        if (Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < MOVE_SLOP_PX) return;
        d.started = true;
        setGrabbing(true);
        onGesture('start');
      }
      const r = snapGroupMove(d.startRects, p.x - d.startPt.x, p.y - d.startPt.y, d.targets, { threshold, snap });
      setGuides(r.guides);
      onPatch(movePatches(d.keys.map(key => ({ key })), r.rects), 'live');
    } else if (d.kind === 'gscale') {
      // 角落預設鎖整組的長寬比，按住 Shift 橫直各縮各的；邊只縮那一個方向
      const r = snapGroupScale(d.startRects, d.handle, p.x, p.y, d.targets, { threshold, snap, keepAspect: !e.shiftKey });
      setGuides(r.guides);
      onPatch(movePatches(d.keys.map(key => ({ key })), r.rects), 'live');
    } else {
      // 單塊縮放 = 只有一塊的整組縮放：跟整組同一套規則（角落預設鎖長寬比，按住 Shift 橫直各縮各的）
      const r = snapGroupScale([d.startRect], d.handle, p.x, p.y, d.targets, { threshold, snap, keepAspect: !e.shiftKey });
      setGuides(r.guides);
      onPatch([{ key: d.key, patch: { dest: r.rects[0] } }], 'live');
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    api.touchUp(e);
    const d = dragRef.current;
    if (d?.kind === 'move') {
      // 沒拖：按著 Shift / Ctrl 點已選的 = 拿掉；沒按點複選裡的一塊 = 只留這一塊
      const next = releaseSelect(d.baseSel, d.anchor, d.pending, d.started);
      if (!sameSelection(next, d.baseSel)) onSelect(next);
    } else if (d?.kind === 'marquee' && !d.started && !d.additive && d.base.length > 0) {
      onSelect([]);   // 點空白處 = 取消選取
    }
    endDrag(e);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey && (k === 'z' || k === 'y')) {
      stop();
      if (k === 'y' || e.shiftKey) onRedo(); else onUndo();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && k === 'a') {
      stop();
      if (!dragRef.current) onSelect(selectAllKeys(placed));
      return;
    }
    if (mod || e.altKey) return;
    if (k === 'escape') { if (selKeys.length > 0) { stop(); onSelect([]); } return; }
    if (selItems.length === 0) return;
    if (k === 'delete' || k === 'backspace') { if (allowRemove) { stop(); onRemove(selKeys); } return; }
    const step = e.shiftKey ? 10 : 1;
    const dir = k === 'arrowleft' ? [-step, 0] : k === 'arrowright' ? [step, 0] : k === 'arrowup' ? [0, -step] : k === 'arrowdown' ? [0, step] : null;
    if (dir) {
      stop();
      onPatch(movePatches(selItems, nudgeRects(selItems.map(i => i.dest), dir[0], dir[1])), { tag: selectionTag('nudge', selKeys) });
    }
  }

  // 轉 90° / 翻轉：選到幾塊就各自在原地轉 / 翻
  const transformable = selItems.length > 0 && (canTransform ? canTransform(selItems) : true);
  const rotate90 = () => {
    if (!transformable) return;
    const patches = transformPatches ? transformPatches('rotate', selItems) : rotatePatches(selItems, 1);
    if (patches.length) onPatch(patches, {});
  };
  const flip = (axis: 'h' | 'v') => {
    if (!transformable) return;
    const patches = transformPatches ? transformPatches(axis === 'h' ? 'flipH' : 'flipV', selItems) : flipPatches(selItems, axis);
    if (patches.length) onPatch(patches, {});
  };
  const allFlipped = (axis: 'h' | 'v') => selItems.length > 0 && selItems.every(i => (axis === 'h' ? i.flipH : i.flipV));

  // ───────── 畫面 ─────────
  const sx = (x: number) => x * view.zoom + view.panX;
  const sy = (y: number) => y * view.zoom + view.panY;
  const step = gridStep(view.zoom);
  const gridPath = useMemo(() => {
    if (size.w <= 0) return { minor: '', major: '' };
    const x0 = Math.max(0, Math.floor(-view.panX / view.zoom / step) * step);
    const x1 = Math.min(canvas.width, Math.ceil((size.w - view.panX) / view.zoom / step) * step);
    const y0 = Math.max(0, Math.floor(-view.panY / view.zoom / step) * step);
    const y1 = Math.min(canvas.height, Math.ceil((size.h - view.panY) / view.zoom / step) * step);
    let minor = '', major = '';
    let n = 0;
    for (let x = x0; x <= x1 && n < 600; x += step, n++) {
      const seg = `M${sx(x)} ${sy(y0)}V${sy(y1)}`;
      if (x % (step * 5) === 0) major += seg; else minor += seg;
    }
    for (let y = y0, m = 0; y <= y1 && m < 600; y += step, m++) {
      const seg = `M${sx(x0)} ${sy(y)}H${sx(x1)}`;
      if (y % (step * 5) === 0) major += seg; else minor += seg;
    }
    return { minor, major };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, size, step, canvas]);

  const ordered = useMemo(() => [...placed].sort((a, b) => (selectedSet.has(a.key) ? 1 : 0) - (selectedSet.has(b.key) ? 1 : 0)), [placed, selectedSet]);

  // 底圖 + 框裡的對位圖內容：畫在一張 canvas 上（整張畫布的測試圖是畫好留著的，這裡只是剪一塊貼進框裡）
  const contentShown = showContent && !!fullMap && fullMap.canvas.width > 0;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  useLayoutEffect(() => {
    const el = pixRef.current;
    if (!el || size.w <= 0 || size.h <= 0) return;
    const pw = Math.round(size.w * dpr), ph = Math.round(size.h * dpr);
    if (el.width !== pw || el.height !== ph) { el.width = pw; el.height = ph; }
    const ctx = el.getContext('2d');
    if (!ctx) return;
    try {
      drawLayers(ctx, {
        canvas, view, size, dpr, backdrop,
        content: contentShown && fullMap ? { map: fullMap, spanOf: (k: string) => defByKey.get(k)?.src ?? null, opacity: contentOpacity } : null,
        items: ordered.map(i => ({ key: i.key, dest: i.dest, rotate: i.rotate, flipH: i.flipH, flipV: i.flipV })),
      });
    } catch (e) {
      console.warn('[ledTemplate] canvas layers draw failed:', e);
    }
  }, [canvas, view, size, dpr, backdrop, contentShown, contentOpacity, fullMap, defByKey, ordered]);

  return (
    <div className="ltc">
      <div className="ltc__toolbar" role="toolbar" aria-label="版型畫布工具">
        <button className="ltc__btn" onClick={() => api.zoomBy(1 / 1.25)} title="縮小" aria-label="縮小"><Icon icon={ZoomOut} /></button>
        <button className="ltc__btn ltc__btn--zoom" onClick={api.fit} title="符合畫面（整張畫布塞進來）">{zoomText(view.zoom)}</button>
        <button className="ltc__btn" onClick={() => api.zoomBy(1.25)} title="放大" aria-label="放大"><Icon icon={ZoomIn} /></button>
        <button className="ltc__btn" onClick={api.fit} title="符合畫面"><Icon icon={Maximize} /> <span className="ltc__btn-text">符合畫面</span></button>
        <span className="ltc__sep" />
        <button className="ltc__btn" onClick={() => onSelect(selectAllKeys(placed))} disabled={placed.length === 0} title="全選（Ctrl+A）" data-testid="ltc-select-all"><Icon icon={BoxSelect} /> <span className="ltc__btn-text">全選</span></button>
        <button className="ltc__btn" onClick={onUndo} disabled={!canUndo} title="復原（Ctrl+Z）" aria-label="復原"><Icon icon={Undo2} /></button>
        <button className="ltc__btn" onClick={onRedo} disabled={!canRedo} title="重做（Ctrl+Shift+Z）" aria-label="重做"><Icon icon={Redo2} /></button>
        <span className="ltc__sep" />
        <button className="ltc__btn" onClick={rotate90} disabled={!transformable} title={transformPatches ? '選到的螢幕順時針轉 90 度（寬高對調）；連在一起的整組一起轉，其餘的各自在原地轉' : '選到的螢幕順時針轉 90 度（寬高對調）；選了好幾塊就各自在原地轉'}><Icon icon={RotateCw} /> <span className="ltc__btn-text">轉 90°</span></button>
        <button className="ltc__btn" onClick={() => flip('h')} disabled={!transformable} aria-pressed={allFlipped('h')} title={transformPatches ? '左右翻轉；連在一起的整組一起翻，其餘的各自翻' : '左右翻轉（轉完再翻）；選了好幾塊就各自翻'}><Icon icon={FlipHorizontal2} /> <span className="ltc__btn-text">左右翻轉</span></button>
        <button className="ltc__btn" onClick={() => flip('v')} disabled={!transformable} aria-pressed={allFlipped('v')} title={transformPatches ? '上下翻轉；連在一起的整組一起翻，其餘的各自翻' : '上下翻轉（轉完再翻）；選了好幾塊就各自翻'}><Icon icon={FlipVertical2} /> <span className="ltc__btn-text">上下翻轉</span></button>
        {onCenter && (
          <>
            <span className="ltc__sep" />
            <button className="ltc__btn" onClick={() => onCenter('x')} title="左右置中：選到的螢幕（沒選就全部）整組放到畫布左右正中間，彼此的位置不變"><Icon icon={AlignHorizontalJustifyCenter} /> <span className="ltc__btn-text">左右置中</span></button>
            <button className="ltc__btn" onClick={() => onCenter('y')} title="上下置中：選到的螢幕（沒選就全部）整組放到畫布上下正中間，彼此的位置不變"><Icon icon={AlignVerticalJustifyCenter} /> <span className="ltc__btn-text">上下置中</span></button>
          </>
        )}
        {selInfo && <span className="ltc__count" role="status" data-testid="ltc-sel-info" title="外框的大小，單位是點（畫布像素）">{selectionInfoText(selInfo)}</span>}
      </div>
      {layersBar}

      <div
        ref={api.hostRef}
        className={'ltc__host' + (grabbing ? ' is-grabbing' : '') + (spaceHeld ? ' is-space' : '')}
        tabIndex={0}
        role="application"
        aria-label={`${canvasName} ${canvas.width}×${canvas.height}，用方向鍵微調選到的螢幕，在空白處拖曳可以框選好幾塊`}
        onPointerEnter={() => { hoverRef.current = true; }}
        onPointerLeave={() => { hoverRef.current = false; }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <svg className="ltc__bg" width={size.w} height={size.h} aria-hidden="true">
          <rect x={sx(0)} y={sy(0)} width={canvas.width * view.zoom} height={canvas.height * view.zoom} className="ltc__canvas" />
          <path d={gridPath.minor} className="ltc__grid" />
          <path d={gridPath.major} className="ltc__grid ltc__grid--major" />
        </svg>
        <canvas ref={pixRef} className="ltc__pix" style={{ width: size.w, height: size.h }} aria-hidden="true" />
        <svg className="ltc__guides" width={size.w} height={size.h} aria-hidden="true">
          <rect x={sx(0)} y={sy(0)} width={canvas.width * view.zoom} height={canvas.height * view.zoom} className="ltc__canvas-edge" />
          {guides.map((g, i) => (g.axis === 'x'
            ? <line key={i} x1={sx(g.at)} x2={sx(g.at)} y1={0} y2={size.h} className="ltc__guide" />
            : <line key={i} y1={sy(g.at)} y2={sy(g.at)} x1={0} x2={size.w} className="ltc__guide" />))}
        </svg>
        <div className="ltc__canvas-label" style={{ left: Math.max(6, sx(0)), top: Math.max(4, sy(0) - 20) }}>
          {canvasName} {canvas.width}×{canvas.height} 像素
        </div>

        {ordered.map(it => {
          const def = defByKey.get(it.key)!;
          const w = it.dest.w * view.zoom, h = it.dest.h * view.zoom;
          const probs = flagged.get(it.key);
          const exp = defaultDestSize({ w: def.nativeW, h: def.nativeH }, scalePct, it.rotate);
          const stretched = Math.abs(it.dest.w / exp.w - 1) > STRETCH_TOLERANCE || Math.abs(it.dest.h / exp.h - 1) > STRETCH_TOLERANCE;
          const up = upDirection(it.rotate, it.flipH, it.flipV);
          const angle = Math.round((Math.atan2(up.dx, -up.dy) * 180) / Math.PI);
          const hue = panelHue(defs.indexOf(def));
          const style = { transform: `translate(${sx(it.dest.x)}px, ${sy(it.dest.y)}px)`, width: w, height: h, '--hue': hue.toFixed(1) } as CSSProperties;
          const bad = probs?.size ? [probs.has('outside') ? '超出畫布' : '', probs.has('overlap') ? '重疊' : ''].filter(Boolean).join('、') : '';
          const tip = `${def.name}：${sizeLabel(def, it)}；位置 ${it.dest.x}, ${it.dest.y}；螢幕的上方${upText(up)}`
            + (it.rotate ? `；轉 ${it.rotate}°` : '') + (it.flipH ? '；左右翻' : '') + (it.flipV ? '；上下翻' : '') + (bad ? `；${bad}` : '') + (stretched ? '；被拉伸' : '');
          return (
            <div
              key={it.key}
              data-key={it.key}
              className={'ltc__item' + (selectedSet.has(it.key) ? ' is-selected' : '') + (bad ? ' is-bad' : '') + (grabbing && selectedSet.has(it.key) ? ' is-grabbing' : '') + (contentShown ? ' has-pix' : '')}
              style={style}
              title={tip}
            >
              {w >= 30 && h >= 30 && (
                <svg className="ltc__arrow" viewBox="-10 -10 20 20" style={{ transform: `rotate(${angle}deg)` }} aria-hidden="true">
                  <path d="M0 -8 L6 -1 H2.2 V8 H-2.2 V-1 H-6 Z" />
                </svg>
              )}
              {w >= 56 && h >= 26 && (
                <div className="ltc__label">
                  <strong>{def.name}</strong>
                  {h >= 44 && <span>{sizeLabel(def, it)}</span>}
                  {h >= 60 && (it.rotate || it.flipH || it.flipV || stretched) ? (
                    <span className="ltc__tags">
                      {it.rotate ? `轉 ${it.rotate}°` : ''}{it.flipH ? ' 左右翻' : ''}{it.flipV ? ' 上下翻' : ''}
                      {stretched ? <em> 被拉伸</em> : null}
                    </span>
                  ) : null}
                </div>
              )}
              {bad && w >= 56 && <span className="ltc__bad">{bad}</span>}
            </div>
          );
        })}

        {groupBox && (
          <div
            className="ltc__group"
            aria-hidden="true"
            style={{ transform: `translate(${sx(groupBox.x)}px, ${sy(groupBox.y)}px)`, width: groupBox.w * view.zoom, height: groupBox.h * view.zoom }}
          />
        )}

        {groupBox && !lockSize && (() => {
          const b = groupBox;
          const x0 = sx(b.x), x1 = sx(b.x + b.w), y0 = sy(b.y), y1 = sy(b.y + b.h);
          const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          const pos: Record<GroupHandle, Pt> = { nw: { x: x0, y: y0 }, n: { x: mx, y: y0 }, ne: { x: x1, y: y0 }, e: { x: x1, y: my }, se: { x: x1, y: y1 }, s: { x: mx, y: y1 }, sw: { x: x0, y: y1 }, w: { x: x0, y: my } };
          const wideEnough = x1 - x0 >= EDGE_HANDLE_MIN_PX, tallEnough = y1 - y0 >= EDGE_HANDLE_MIN_PX;
          return GROUP_HANDLES.filter(hd => isCornerHandle(hd) || (hd === 'n' || hd === 's' ? wideEnough : tallEnough)).map(hd => (
            <span
              key={hd}
              data-handle={hd}
              className={'ltc__handle' + (isCornerHandle(hd) ? '' : ' ltc__handle--edge')}
              style={{ transform: `translate(${pos[hd].x}px, ${pos[hd].y}px)`, cursor: GROUP_CURSOR[hd] }}
            />
          ));
        })()}

        {sel && !lockSize && (() => {
          const b = sel.dest;
          const pos: Record<Handle, Pt> = {
            nw: { x: sx(b.x), y: sy(b.y) }, ne: { x: sx(b.x + b.w), y: sy(b.y) },
            sw: { x: sx(b.x), y: sy(b.y + b.h) }, se: { x: sx(b.x + b.w), y: sy(b.y + b.h) },
          };
          return HANDLES.map(hd => (
            <span key={hd} data-handle={hd} className="ltc__handle" style={{ transform: `translate(${pos[hd].x}px, ${pos[hd].y}px)`, cursor: CURSOR[hd] }} />
          ));
        })()}

        {marquee && (
          <div
            className="ltc__marquee"
            aria-hidden="true"
            style={{ transform: `translate(${sx(marquee.x)}px, ${sy(marquee.y)}px)`, width: marquee.w * view.zoom, height: marquee.h * view.zoom }}
          />
        )}

        {placed.length === 0 && (
          <div className="ltc__empty muted">{emptyText}</div>
        )}
      </div>
      <p className="ltc__hint ltc__hint--wrap muted">{hint}</p>
    </div>
  );
}
