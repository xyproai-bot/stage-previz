import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { FlipHorizontal2, FlipVertical2, Maximize, Redo2, RotateCw, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import Icon from './Icon';
import { useCanvasView } from '../lib/useCanvasView';
import {
  flaggedKeys, gridStep, nudgeRect, rotatePlacement90, SNAP_SCREEN_PX, snapMove, snapResize, snapTargets,
  type Handle, type SnapGuide, type SnapTargets, type View,
} from '../lib/ledTemplateEdit';
import { panelHue, type CanvasSize, type PixelRect } from '../lib/ledMap';
import { defaultDestSize, screenSizeLabel, type PlacementInput, type ScreenDef } from '../lib/ledTemplate';
import { upDirection, upText } from '../lib/ledTemplatePattern';
import './LedTemplateCanvas.css';

/**
 * 版型畫布（拖拉編輯）：版型的畫布 + 每塊放進去的螢幕（長方形，寫著名字和「實際 W×H → 這個版型 w×h」）。
 *   拖曳移動、拖四個角縮放（Shift 鎖長寬比）、方向鍵微調（Shift 10 px）、Delete 拿掉、Ctrl+Z / Ctrl+Shift+Z 復原重做。
 *   位置、大小一定是整數；靠近別塊螢幕的邊或畫布的邊會吸過去（按住 Alt 不吸附）。
 *   重疊、超出畫布的畫紅框。滾輪縮放、空白處拖曳（或中鍵）平移、手機平板雙指縮放。
 * 數字怎麼算：lib/ledTemplateEdit.ts（有單元測試）。
 */

export type PatchHow = 'live' | { tag?: string };
export interface ItemPatch { dest?: PixelRect; rotate?: PlacementInput['rotate']; flipH?: boolean; flipV?: boolean }

interface Props {
  canvas: CanvasSize;
  scalePct: number;
  defs: readonly ScreenDef[];
  items: readonly PlacementInput[];
  selected: string | null;
  /** 換版型時重新「符合畫面」 */
  resetKey: string;
  canUndo: boolean;
  canRedo: boolean;
  onSelect: (key: string | null) => void;
  onPatch: (key: string, patch: ItemPatch, how: PatchHow) => void;
  /** 一次拖曳開始 / 結束（結束時記成復原的一步） */
  onGesture: (phase: 'start' | 'end') => void;
  onRemove: (key: string) => void;
  onUndo: () => void;
  onRedo: () => void;
}

type Pt = { x: number; y: number };
type Drag =
  | { kind: 'move'; key: string; startPt: Pt; startClient: Pt; startRect: PixelRect; targets: SnapTargets; started: boolean }
  | { kind: 'resize'; key: string; handle: Handle; startRect: PixelRect; targets: SnapTargets }
  | { kind: 'pan'; startLocal: Pt; startView: View };

const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];
const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
const MOVE_SLOP_PX = 3;
const STRETCH_TOLERANCE = 0.02;

export function zoomText(zoom: number): string {
  const pct = zoom * 100;
  return `${pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1))}%`;
}

export default function LedTemplateCanvas({ canvas, scalePct, defs, items, selected, resetKey, canUndo, canRedo, onSelect, onPatch, onGesture, onRemove, onUndo, onRedo }: Props) {
  const api = useCanvasView(canvas, resetKey);
  const { view, size } = api;
  const dragRef = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [grabbing, setGrabbing] = useState(false);

  const defByKey = useMemo(() => new Map(defs.map(d => [d.key, d])), [defs]);
  const placed = useMemo(() => items.filter(i => defByKey.has(i.key)), [items, defByKey]);
  const flagged = useMemo(() => flaggedKeys(placed.map(i => ({ key: i.key, dest: i.dest })), canvas), [placed, canvas]);
  const itemByKey = useMemo(() => new Map(placed.map(i => [i.key, i])), [placed]);
  const sel = selected ? itemByKey.get(selected) ?? null : null;

  const targetsFor = (key: string): SnapTargets =>
    snapTargets(canvas, placed.filter(i => i.key !== key).map(i => i.dest));

  function endDrag(release?: { pointerId: number }) {
    const d = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    setGrabbing(false);
    if (d && (d.kind === 'resize' || (d.kind === 'move' && d.started))) onGesture('end');
    if (release) { try { api.hostRef.current?.releasePointerCapture(release.pointerId); } catch { /* 已經放開了 */ } }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (api.touchDown(e)) { endDrag(); return; }   // 兩指縮放
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
    if (e.button === 1) { dragRef.current = { kind: 'pan', startLocal: api.local(e), startView: view }; setGrabbing(true); return; }
    if (handleEl && sel) {
      dragRef.current = { kind: 'resize', key: sel.key, handle: handleEl.dataset.handle as Handle, startRect: sel.dest, targets: targetsFor(sel.key) };
      onGesture('start');
      return;
    }
    if (itemEl?.dataset.key) {
      const key = itemEl.dataset.key;
      const it = itemByKey.get(key);
      onSelect(key);
      if (it) dragRef.current = { kind: 'move', key, startPt: pt, startClient: { x: e.clientX, y: e.clientY }, startRect: it.dest, targets: targetsFor(key), started: false };
      return;
    }
    onSelect(null);
    dragRef.current = { kind: 'pan', startLocal: api.local(e), startView: view };
    setGrabbing(true);
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
    if (d.kind === 'move') {
      if (!d.started) {
        if (Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < MOVE_SLOP_PX) return;
        d.started = true;
        setGrabbing(true);
        onGesture('start');
      }
      const r = snapMove(d.startRect, d.startRect.x + (p.x - d.startPt.x), d.startRect.y + (p.y - d.startPt.y), d.targets, { threshold, snap });
      setGuides(r.guides);
      onPatch(d.key, { dest: r.rect }, 'live');
    } else {
      const r = snapResize(d.startRect, d.handle, p.x, p.y, d.targets, { threshold, snap, keepAspect: e.shiftKey });
      setGuides(r.guides);
      onPatch(d.key, { dest: r.rect }, 'live');
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    api.touchUp(e);
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
    if (mod || e.altKey) return;
    if (k === 'escape') { if (selected) { stop(); onSelect(null); } return; }
    if (!sel) return;
    if (k === 'delete' || k === 'backspace') { stop(); onRemove(sel.key); return; }
    const step = e.shiftKey ? 10 : 1;
    const dir = k === 'arrowleft' ? [-step, 0] : k === 'arrowright' ? [step, 0] : k === 'arrowup' ? [0, -step] : k === 'arrowdown' ? [0, step] : null;
    if (dir) {
      stop();
      onPatch(sel.key, { dest: nudgeRect(sel.dest, dir[0], dir[1]) }, { tag: `nudge:${sel.key}` });
    }
  }

  function rotate90() {
    if (!sel) return;
    onPatch(sel.key, rotatePlacement90(sel, 1), {});
  }

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

  const ordered = useMemo(() => [...placed].sort((a, b) => (a.key === selected ? 1 : 0) - (b.key === selected ? 1 : 0)), [placed, selected]);

  return (
    <div className="ltc">
      <div className="ltc__toolbar" role="toolbar" aria-label="版型畫布工具">
        <button className="ltc__btn" onClick={() => api.zoomBy(1 / 1.25)} title="縮小" aria-label="縮小"><Icon icon={ZoomOut} /></button>
        <button className="ltc__btn ltc__btn--zoom" onClick={api.fit} title="符合畫面（整張畫布塞進來）">{zoomText(view.zoom)}</button>
        <button className="ltc__btn" onClick={() => api.zoomBy(1.25)} title="放大" aria-label="放大"><Icon icon={ZoomIn} /></button>
        <button className="ltc__btn" onClick={api.fit} title="符合畫面"><Icon icon={Maximize} /> <span className="ltc__btn-text">符合畫面</span></button>
        <span className="ltc__sep" />
        <button className="ltc__btn" onClick={onUndo} disabled={!canUndo} title="復原（Ctrl+Z）" aria-label="復原"><Icon icon={Undo2} /></button>
        <button className="ltc__btn" onClick={onRedo} disabled={!canRedo} title="重做（Ctrl+Shift+Z）" aria-label="重做"><Icon icon={Redo2} /></button>
        <span className="ltc__sep" />
        <button className="ltc__btn" onClick={rotate90} disabled={!sel} title="選到的螢幕順時針轉 90 度（寬高對調）"><Icon icon={RotateCw} /> <span className="ltc__btn-text">轉 90°</span></button>
        <button className="ltc__btn" onClick={() => sel && onPatch(sel.key, { flipH: !sel.flipH }, {})} disabled={!sel} aria-pressed={!!sel?.flipH} title="左右翻轉（轉完再翻）"><Icon icon={FlipHorizontal2} /> <span className="ltc__btn-text">左右翻轉</span></button>
        <button className="ltc__btn" onClick={() => sel && onPatch(sel.key, { flipV: !sel.flipV }, {})} disabled={!sel} aria-pressed={!!sel?.flipV} title="上下翻轉（轉完再翻）"><Icon icon={FlipVertical2} /> <span className="ltc__btn-text">上下翻轉</span></button>
      </div>

      <div
        ref={api.hostRef}
        className={'ltc__host' + (grabbing ? ' is-grabbing' : '')}
        tabIndex={0}
        role="application"
        aria-label={`版型畫布 ${canvas.width}×${canvas.height}，用方向鍵微調選到的螢幕`}
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
          <rect x={sx(0)} y={sy(0)} width={canvas.width * view.zoom} height={canvas.height * view.zoom} className="ltc__canvas-edge" />
          {guides.map((g, i) => (g.axis === 'x'
            ? <line key={i} x1={sx(g.at)} x2={sx(g.at)} y1={0} y2={size.h} className="ltc__guide" />
            : <line key={i} y1={sy(g.at)} y2={sy(g.at)} x1={0} x2={size.w} className="ltc__guide" />))}
        </svg>
        <div className="ltc__canvas-label" style={{ left: Math.max(6, sx(0)), top: Math.max(4, sy(0) - 20) }}>
          版型畫布 {canvas.width}×{canvas.height} 像素
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
          const tip = `${def.name}：${screenSizeLabel(def, it)}；位置 ${it.dest.x}, ${it.dest.y}；螢幕的上方${upText(up)}`
            + (it.rotate ? `；轉 ${it.rotate}°` : '') + (it.flipH ? '；左右翻' : '') + (it.flipV ? '；上下翻' : '') + (bad ? `；${bad}` : '') + (stretched ? '；被拉伸' : '');
          return (
            <div
              key={it.key}
              data-key={it.key}
              className={'ltc__item' + (it.key === selected ? ' is-selected' : '') + (bad ? ' is-bad' : '') + (grabbing && it.key === selected ? ' is-grabbing' : '')}
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
                  {h >= 44 && <span>{screenSizeLabel(def, it)}</span>}
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

        {sel && (() => {
          const b = sel.dest;
          const pos: Record<Handle, Pt> = {
            nw: { x: sx(b.x), y: sy(b.y) }, ne: { x: sx(b.x + b.w), y: sy(b.y) },
            sw: { x: sx(b.x), y: sy(b.y + b.h) }, se: { x: sx(b.x + b.w), y: sy(b.y + b.h) },
          };
          return HANDLES.map(hd => (
            <span key={hd} data-handle={hd} className="ltc__handle" style={{ transform: `translate(${pos[hd].x}px, ${pos[hd].y}px)`, cursor: CURSOR[hd] }} />
          ));
        })()}

        {placed.length === 0 && (
          <div className="ltc__empty muted">版型裡還沒有螢幕。在右邊的清單按「加入版型」，就會放在畫布上，再用滑鼠拖到想要的位置。</div>
        )}
      </div>
      <p className="ltc__hint muted">拖曳移動 · 拖角落縮放（Shift 鎖長寬比）· 方向鍵微調 1 像素（Shift 10 像素）· 靠近邊會吸附（Alt 不吸附）· 滾輪縮放 · 空白處拖曳平移</p>
    </div>
  );
}
