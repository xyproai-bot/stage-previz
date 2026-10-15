// 版型編輯器的畫面：縮放、平移（滾輪縮放、Shift + 滾輪左右平移、雙指縮放平移、按鈕）。數字怎麼算在 lib/ledTemplateEdit.ts。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { CanvasSize } from './ledMap';
import { fitView, toCanvas, zoomAt, type View } from './ledTemplateEdit';

export interface CanvasViewApi {
  hostRef: RefObject<HTMLDivElement>;
  size: { w: number; h: number };
  view: View;
  setView: (v: View | ((p: View) => View)) => void;
  /** 整張畫布塞進畫面 */
  fit: () => void;
  zoomBy: (factor: number) => void;
  /** 滑鼠 / 手指在畫面上的位置（相對於這塊區域） */
  local: (e: { clientX: number; clientY: number }) => { x: number; y: number };
  /** 滑鼠 / 手指在畫布上的像素位置（可以有小數） */
  point: (e: { clientX: number; clientY: number }) => { x: number; y: number };
  /** 手指：回傳 true = 現在是兩指縮放中（別的拖曳要取消） */
  touchDown: (e: ReactPointerEvent) => boolean;
  touchMove: (e: ReactPointerEvent) => boolean;
  touchUp: (e: ReactPointerEvent) => void;
}

/**
 * canvas = 要顯示的畫布大小；resetKey 變了（換一個版型）就重新「符合畫面」一次。
 * 滾輪：縮放（以滑鼠位置為中心）；Shift + 滾輪：左右平移。
 */
export function useCanvasView(canvas: CanvasSize | null, resetKey: string): CanvasViewApi {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ zoom: 1, panX: 0, panY: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fittedFor = useRef('');
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setSize(prev => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height })); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 第一次知道畫面多大、或換了版型 → 符合畫面
  useEffect(() => {
    if (!canvas || size.w < 40 || size.h < 40) return;
    if (fittedFor.current === resetKey) return;
    fittedFor.current = resetKey;
    setView(fitView(canvas, size));
  }, [canvas, size, resetKey]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.shiftKey && !e.ctrlKey) {
        const d = (e.deltaX || e.deltaY) * unit;
        setView(v => ({ ...v, panX: v.panX - d }));
        return;
      }
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016));
      setView(v => zoomAt(v, factor, { x: e.clientX - r.left, y: e.clientY - r.top }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = useCallback((e: { clientX: number; clientY: number }) => {
    const r = hostRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }, []);
  const point = useCallback((e: { clientX: number; clientY: number }) => toCanvas(viewRef.current, local(e)), [local]);
  const fit = useCallback(() => { if (canvas) setView(fitView(canvas, size)); }, [canvas, size]);
  const zoomBy = useCallback((factor: number) => {
    const r = hostRef.current?.getBoundingClientRect();
    setView(v => zoomAt(v, factor, { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 }));
  }, []);

  const pinchState = () => {
    const pts = [...touches.current.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  const touchDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType !== 'touch') return false;
    touches.current.set(e.pointerId, local(e));
    pinch.current = pinchState();
    return pinch.current !== null;
  }, [local]);
  const touchMove = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType !== 'touch' || !touches.current.has(e.pointerId)) return false;
    touches.current.set(e.pointerId, local(e));
    const prev = pinch.current;
    const next = pinchState();
    if (!prev || !next) return false;
    const factor = next.dist / prev.dist;
    setView(v => {
      const z = zoomAt(v, factor, { x: next.cx, y: next.cy });
      return { ...z, panX: z.panX + (next.cx - prev.cx), panY: z.panY + (next.cy - prev.cy) };
    });
    pinch.current = next;
    return true;
  }, [local]);
  const touchUp = useCallback((e: ReactPointerEvent) => {
    touches.current.delete(e.pointerId);
    pinch.current = pinchState();
  }, []);

  return { hostRef, size, view, setView, fit, zoomBy, local, point, touchDown, touchMove, touchUp };
}
