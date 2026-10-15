import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Maximize, Scissors, ZoomIn, ZoomOut } from 'lucide-react';
import Icon from './Icon';
import NumField from './NumField';
import { useCanvasView } from '../lib/useCanvasView';
import {
  clipRectToCanvas, gridStep, nextSplitName, pickObjectForRect, rectFromPoints, SNAP_SCREEN_PX, snapLine, snapTargets, spanRects, uvToRect,
  type SnapGuide, type SnapTargets, type View,
} from '../lib/ledTemplateEdit';
import { panelHue, type CanvasSize, type PixelRect } from '../lib/ledMap';
import type { ManualScreen, SrcSpan } from '../lib/ledTemplate';
import { zoomText } from './LedTemplateCanvas';
import './LedTemplateCanvas.css';

/**
 * 整張畫布（切螢幕）：一個 LED 物件裡其實包著好幾塊獨立的螢幕時，在整張畫布上拖出每一塊的範圍，就能分別放進版型。
 * 每個 LED 物件在整張畫布上佔的範圍從模型的 UV 算（淡色框）；已經切開的物件改畫虛線，切出來的螢幕是實心的。
 * 拖曳 = 畫新的範圍（靠近別人的邊會吸附，Alt 不吸附）；Shift + 拖曳、中鍵拖曳、滾輪、雙指 = 平移縮放。
 */

export interface SplitObject { objectId: string; name: string; src: SrcSpan; index: number }

interface Props {
  fullCanvas: CanvasSize;
  objects: readonly SplitObject[];
  manuals: readonly ManualScreen[];
  resetKey: string;
  busy: boolean;
  onCreate: (input: { objectId: string; name: string; rect: PixelRect }) => Promise<boolean>;
}

type Pt = { x: number; y: number };
type Drag = { kind: 'draw'; start: Pt; targets: SnapTargets } | { kind: 'pan'; startLocal: Pt; startView: View };

export default function LedSplitCanvas({ fullCanvas, objects, manuals, resetKey, busy, onCreate }: Props) {
  const api = useCanvasView(fullCanvas, 'full:' + resetKey);
  const { view, size } = api;
  const dragRef = useRef<Drag | null>(null);
  const [rect, setRect] = useState<PixelRect | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [objectId, setObjectId] = useState('');
  const [name, setName] = useState('');
  const nameTouched = useRef(false);

  const splitObjects = useMemo(() => new Set(manuals.map(m => m.objectId)), [manuals]);
  const objName = (id: string) => objects.find(o => o.objectId === id)?.name ?? id;
  const allRects = useMemo(() => [
    ...objects.flatMap(o => spanRects(o.src, fullCanvas)),
    ...manuals.map(m => uvToRect(m.uv, fullCanvas)),
  ], [objects, manuals, fullCanvas]);
  const targets = useMemo(() => snapTargets(fullCanvas, allRects), [fullCanvas, allRects]);

  // 預設名字：「物件名 1」，不跟這個物件已經切的重複
  useEffect(() => {
    if (!objectId || nameTouched.current) return;
    setName(nextSplitName(objName(objectId), manuals.filter(m => m.objectId === objectId).map(m => m.name)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, manuals, rect === null]);

  const snapPoint = (p: Pt, alt: boolean): { pt: Pt; guides: SnapGuide[] } => {
    let x = Math.round(p.x), y = Math.round(p.y);
    const g: SnapGuide[] = [];
    if (!alt) {
      const th = SNAP_SCREEN_PX / view.zoom;
      const sx = snapLine([x], targets.xs, th);
      if (sx) { x += sx.delta; g.push({ axis: 'x', at: sx.at }); }
      const sy = snapLine([y], targets.ys, th);
      if (sy) { y += sy.delta; g.push({ axis: 'y', at: sy.at }); }
    }
    return { pt: { x: Math.min(fullCanvas.width, Math.max(0, x)), y: Math.min(fullCanvas.height, Math.max(0, y)) }, guides: g };
  };

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (api.touchDown(e)) { dragRef.current = null; setDrawing(false); return; }
    if (e.button !== 0 && e.button !== 1) return;
    const host = api.hostRef.current;
    if (!host) return;
    try { host.setPointerCapture(e.pointerId); } catch { /* 有些瀏覽器不給 */ }
    e.preventDefault();
    if (e.button === 1 || e.shiftKey) {
      dragRef.current = { kind: 'pan', startLocal: api.local(e), startView: view };
      return;
    }
    const { pt } = snapPoint(api.point(e), e.altKey);
    dragRef.current = { kind: 'draw', start: pt, targets };
    setDrawing(true);
    setRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
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
    const { pt, guides: g } = snapPoint(api.point(e), e.altKey);
    setGuides(g);
    setRect(rectFromPoints(d.start, pt));
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    api.touchUp(e);
    const d = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    setDrawing(false);
    try { api.hostRef.current?.releasePointerCapture(e.pointerId); } catch { /* 已經放開了 */ }
    if (d?.kind === 'draw') {
      if (rect && rect.w >= 2 && rect.h >= 2) {
        // 猜它是在切哪個物件（跟哪個物件的範圍重疊最多）
        setObjectId(pickObjectForRect(clipRectToCanvas(rect, fullCanvas) ?? rect, objects, fullCanvas) ?? objects[0]?.objectId ?? '');
        nameTouched.current = false;
      } else {
        setRect(null);
      }
    }
  }

  const clipped = rect ? clipRectToCanvas(rect, fullCanvas) : null;
  async function submit() {
    if (!clipped || !objectId) return;
    const ok = await onCreate({ objectId, name: name.trim() || '螢幕', rect: clipped });
    if (ok) { setRect(null); nameTouched.current = false; setName(''); }
  }

  const sx = (x: number) => x * view.zoom + view.panX;
  const sy = (y: number) => y * view.zoom + view.panY;
  const step = gridStep(view.zoom);
  const gridPath = useMemo(() => {
    if (size.w <= 0) return '';
    const x0 = Math.max(0, Math.floor(-view.panX / view.zoom / step) * step);
    const x1 = Math.min(fullCanvas.width, Math.ceil((size.w - view.panX) / view.zoom / step) * step);
    const y0 = Math.max(0, Math.floor(-view.panY / view.zoom / step) * step);
    const y1 = Math.min(fullCanvas.height, Math.ceil((size.h - view.panY) / view.zoom / step) * step);
    let d = '';
    for (let x = x0, n = 0; x <= x1 && n < 600; x += step, n++) d += `M${sx(x)} ${sy(y0)}V${sy(y1)}`;
    for (let y = y0, n = 0; y <= y1 && n < 600; y += step, n++) d += `M${sx(x0)} ${sy(y)}H${sx(x1)}`;
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, size, step, fullCanvas]);

  const piece = (key: string, r: PixelRect, cls: string, hue: number, label?: string, sub?: string) => {
    const w = r.w * view.zoom, h = r.h * view.zoom;
    const style = { transform: `translate(${sx(r.x)}px, ${sy(r.y)}px)`, width: w, height: h, '--hue': hue.toFixed(1) } as CSSProperties;
    return (
      <div key={key} className={'ltc__piece ' + cls} style={style}>
        {label && w >= 50 && h >= 22 && (
          <div className="ltc__label">
            <strong>{label}</strong>
            {sub && h >= 40 && <span>{sub}</span>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="ltc">
      <div className="ltc__toolbar" role="toolbar" aria-label="整張畫布工具">
        <button className="ltc__btn" onClick={() => api.zoomBy(1 / 1.25)} title="縮小" aria-label="縮小"><Icon icon={ZoomOut} /></button>
        <button className="ltc__btn ltc__btn--zoom" onClick={api.fit} title="符合畫面">{zoomText(view.zoom)}</button>
        <button className="ltc__btn" onClick={() => api.zoomBy(1.25)} title="放大" aria-label="放大"><Icon icon={ZoomIn} /></button>
        <button className="ltc__btn" onClick={api.fit} title="符合畫面"><Icon icon={Maximize} /> <span className="ltc__btn-text">符合畫面</span></button>
      </div>

      <div
        ref={api.hostRef}
        className={'ltc__host' + (drawing ? ' is-grabbing' : '')}
        style={{ cursor: 'crosshair' }}
        role="application"
        aria-label={`整張畫布 ${fullCanvas.width}×${fullCanvas.height}，拖曳畫出要切開的螢幕範圍`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg className="ltc__bg" width={size.w} height={size.h} aria-hidden="true">
          <rect x={sx(0)} y={sy(0)} width={fullCanvas.width * view.zoom} height={fullCanvas.height * view.zoom} className="ltc__canvas" />
          <path d={gridPath} className="ltc__grid" />
          <rect x={sx(0)} y={sy(0)} width={fullCanvas.width * view.zoom} height={fullCanvas.height * view.zoom} className="ltc__canvas-edge" />
          {guides.map((g, i) => (g.axis === 'x'
            ? <line key={i} x1={sx(g.at)} x2={sx(g.at)} y1={0} y2={size.h} className="ltc__guide" />
            : <line key={i} y1={sy(g.at)} y2={sy(g.at)} x1={0} x2={size.w} className="ltc__guide" />))}
        </svg>
        <div className="ltc__canvas-label" style={{ left: Math.max(6, sx(0)), top: Math.max(4, sy(0) - 20) }}>
          整張畫布 {fullCanvas.width}×{fullCanvas.height} 像素（LED 的真實點數）
        </div>

        {objects.flatMap(o => spanRects(o.src, fullCanvas).map((r, i) => piece(
          `o:${o.objectId}:${i}`, r, splitObjects.has(o.objectId) ? 'is-split' : '', panelHue(o.index),
          i === 0 ? o.name : undefined, i === 0 ? `${r.w}×${r.h}` : undefined,
        )))}
        {manuals.map(m => {
          const r = uvToRect(m.uv, fullCanvas);
          const oi = objects.find(o => o.objectId === m.objectId)?.index ?? 0;
          return piece(`m:${m.id}`, r, 'is-manual', panelHue(oi), m.name, `${r.w}×${r.h}（切開的）`);
        })}
        {rect && rect.w > 0 && rect.h > 0 && (
          <div className="ltc__draw" style={{ transform: `translate(${sx(rect.x)}px, ${sy(rect.y)}px)`, width: rect.w * view.zoom, height: rect.h * view.zoom }}>
            <span className="ltc__draw-size">{rect.w}×{rect.h}</span>
          </div>
        )}
        {objects.length === 0 && <div className="ltc__empty muted">這個專案還沒有 LED 物件。</div>}
      </div>

      {rect && rect.w >= 2 && rect.h >= 2 ? (
        <div className="ltc__splitform" role="group" aria-label="切開成一塊螢幕">
          <label>切自哪個 LED 物件
            <select value={objectId} onChange={(e) => { setObjectId(e.target.value); }}>
              {objects.map(o => <option key={o.objectId} value={o.objectId}>{o.name}</option>)}
            </select>
          </label>
          <label>螢幕名稱
            <input value={name} maxLength={40} onChange={(e) => { nameTouched.current = true; setName(e.target.value); }} />
          </label>
          <span className="ltc__splitnums">
            <label>左<NumField value={rect.x} min={0} max={fullCanvas.width} label="範圍 左" onChange={(n) => setRect(r => r && { ...r, x: n })} /></label>
            <label>上<NumField value={rect.y} min={0} max={fullCanvas.height} label="範圍 上" onChange={(n) => setRect(r => r && { ...r, y: n })} /></label>
            <label>寬<NumField value={rect.w} min={1} max={fullCanvas.width} label="範圍 寬" onChange={(n) => setRect(r => r && { ...r, w: n })} /></label>
            <label>高<NumField value={rect.h} min={1} max={fullCanvas.height} label="範圍 高" onChange={(n) => setRect(r => r && { ...r, h: n })} /></label>
          </span>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !clipped || !objectId}><Icon icon={Scissors} /> 切開</button>
          <button className="btn btn--ghost" onClick={() => setRect(null)} disabled={busy}>取消</button>
          {rect && !clipped && <span className="ltc__warn">範圍在畫布外面</span>}
        </div>
      ) : (
        <p className="ltc__hint ltc__hint--wrap muted">
          在整張畫布上拖出一個長方形，就能把一個 LED 物件切出一塊獨立的螢幕（淡色框是每個 LED 物件原本的範圍，虛線 = 已經切開）。靠近別人的邊會吸附（Alt 不吸附）；Shift + 拖曳平移，滾輪縮放。
        </p>
      )}
    </div>
  );
}
