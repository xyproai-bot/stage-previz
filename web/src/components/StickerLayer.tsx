// 貼圖（貼在 3D 畫面上的參考圖片）：疊在畫記那一塊畫面上（AnnotationLayer 裡面）。
//   調整中（editing）：點一張選到它 → 拖 = 移動、拖四個角 = 縮放（比例不變）、拖上面的圓點 = 旋轉（按住 Shift 每 15° 一格）、
//     兩根手指 = 縮放 + 旋轉 + 移動；下面一條：不透明度滑桿、刪除、完成。點別的地方 = 調整完了。
//   沒在調整：貼圖留在畫面上，滑鼠穿過去，3D 視角照樣可以轉（拿來對照舞台）。
//   畫記工具列開著時：工具選「移動照片」= 調整中（照片收滑鼠，按空白處只是取消選取）；選畫的工具 = 沒在調整（畫記的那層收滑鼠）。
//     誰收滑鼠的決定在 lib/review/stickerTool.ts，這裡只照 editing 掛事件。
//   打開留言時（唯讀）：貼圖照存的位置、大小、角度、不透明度出現。
// 算法（座標換算、縮放、旋轉、捏合）在 lib/review/stickers.ts；這裡只收事件、畫出來。
// 拖的過程只改這裡的 live，放開才交給外面存（外面是整個頁面的狀態，不要每一格動作都重畫整頁）。

import { useEffect, useRef, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import Icon from './Icon';
import type { AnnImage } from '../lib/review/annotations';
import {
  moveSticker, pinchSticker, rotateSticker, scaleSticker, setStickerOpacity, stickerCss, type Pt,
} from '../lib/review/stickers';
import './StickerLayer.css';

interface Props {
  /** 畫記那塊畫面的大小（像素；貼圖的位置都是這一塊的比例） */
  width: number;
  height: number;
  items: readonly AnnImage[];
  /** 貼圖的圖片網址（沒有 = 不畫） */
  srcOf: (attachmentId: string) => string | undefined;
  /** 可以調整（拖、縮放、旋轉）；沒給 = 唯讀 */
  editing?: boolean;
  selectedId?: string | null;
  onSelect?: (attachmentId: string | null) => void;
  onCommit?: (attachmentId: string, el: AnnImage) => void;
  onRemove?: (attachmentId: string) => void;
  onFinish?: () => void;
  /** 按在貼圖以外的地方；沒給 = 跟 onFinish 一樣（調整完了）。畫記工具列開著時給「只取消選取」 */
  onBlank?: () => void;
  /** 滑鼠滾輪在貼圖上是不是轉交給 3D 畫面縮放（預設要；畫記的時候 3D 視角鎖住，不要轉交） */
  forwardWheel?: boolean;
  imageRef?: (attachmentId: string, el: HTMLImageElement | null) => void;
  /** 打開留言的時候：淡入 */
  showing?: boolean;
}

type Mode = 'move' | 'scale' | 'rotate' | 'pinch';
interface Gesture {
  id: string;
  mode: Mode;
  /** 這個動作開始時的貼圖 */
  start: AnnImage;
  startPtr: Pt;
  pinchStart?: readonly [Pt, Pt];
  pointers: Map<number, Pt>;
  current: AnnImage;
  /** 有真的動過（光點一下不算，不用存） */
  dirty: boolean;
}

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;

const sameImage = (a: AnnImage, b: AnnImage) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rot === b.rot && a.opacity === b.opacity;

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

export default function StickerLayer({
  width: W, height: H, items, srcOf, editing = false, selectedId = null, onSelect, onCommit, onRemove, onFinish, onBlank, forwardWheel = true,
  imageRef, showing = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [live, setLive] = useState<AnnImage | null>(null);
  const [opacityLive, setOpacityLive] = useState<{ id: string; value: number } | null>(null);
  const opacityRef = useRef<{ id: string; value: number } | null>(null);
  const sliderDown = useRef(false);
  const cb = useRef({ onSelect, onCommit, onRemove, onFinish, onBlank });
  cb.current = { onSelect, onCommit, onRemove, onFinish, onBlank };

  const shown = items.map(i => {
    if (live && live.attachmentId === i.attachmentId) return live;
    if (opacityLive && opacityLive.id === i.attachmentId) return { ...i, opacity: opacityLive.value };
    return i;
  });
  const selected = shown.find(i => i.attachmentId === selectedId) ?? null;

  // 不在調整了 → 進行到一半的動作作廢
  useEffect(() => {
    if (editing) return;
    gesture.current = null;
    setLive(null);
    opacityRef.current = null;
    setOpacityLive(null);
  }, [editing]);

  // 滑鼠滾輪在貼圖上也要能縮放 3D 視角（貼圖蓋住了整個畫面也一樣）：轉交給 3D 畫面
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !editing || !forwardWheel) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('.stk') || t.closest('.stk-panel')) return;
      const canvas = root.closest('.stage-scene')?.querySelector('canvas');
      if (!canvas) return;
      e.preventDefault();
      e.stopPropagation();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      }));
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [editing, forwardWheel]);

  // 點別的地方 = 調整完了；Delete 刪掉選到的；Esc 也算調整完了
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('[data-stk]')) return;
      (cb.current.onBlank ?? cb.current.onFinish)?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cb.current.onFinish?.(); return; }
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.defaultPrevented || !selectedId) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      cb.current.onRemove?.(selectedId);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [editing, selectedId]);

  const relPos = (e: { clientX: number; clientY: number }): Pt => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? [e.clientX - r.left, e.clientY - r.top] : [0, 0];
  };

  const begin = (e: React.PointerEvent, el: AnnImage, mode: Mode) => {
    if (!editing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = relPos(e);
    const g = gesture.current;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* 沒有也能動，只是手指滑出去會斷 */ }
    if (g) {
      // 第二根手指放在同一張貼圖上 → 捏合（縮放 + 旋轉）
      if (g.id === el.attachmentId && g.mode === 'move' && g.pointers.size === 1 && mode === 'move') {
        const first = [...g.pointers.values()][0];
        g.pointers.set(e.pointerId, p);
        g.mode = 'pinch';
        g.start = g.current;
        g.pinchStart = [first, p];
      }
      return;
    }
    cb.current.onSelect?.(el.attachmentId);
    gesture.current = { id: el.attachmentId, mode, start: el, current: el, startPtr: p, pointers: new Map([[e.pointerId, p]]), dirty: false };
  };

  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !g.pointers.has(e.pointerId)) return;
    const p = relPos(e);
    g.pointers.set(e.pointerId, p);
    let next = g.current;
    if (g.mode === 'pinch') {
      const pts = [...g.pointers.values()];
      if (pts.length >= 2 && g.pinchStart) next = pinchSticker(g.start, g.pinchStart, [pts[0], pts[1]], W, H);
    } else if (g.mode === 'move') {
      next = moveSticker(g.start, p[0] - g.startPtr[0], p[1] - g.startPtr[1], W, H);
    } else if (g.mode === 'scale') {
      next = scaleSticker(g.start, g.startPtr, p, W, H);
    } else {
      next = rotateSticker(g.start, g.startPtr, p, W, H, e.shiftKey);
    }
    if (!sameImage(next, g.current)) g.dirty = true;
    g.current = next;
    setLive(next);
  };

  const end = (e: React.PointerEvent, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || !g.pointers.has(e.pointerId)) return;
    g.pointers.delete(e.pointerId);
    if (g.mode === 'pinch' && g.pointers.size >= 1) {
      // 剩一根手指 → 接著用它拖
      g.mode = 'move';
      g.start = g.current;
      g.startPtr = [...g.pointers.values()][0];
      return;
    }
    if (g.pointers.size > 0) return;
    gesture.current = null;
    setLive(null);
    if (!cancelled && g.dirty) cb.current.onCommit?.(g.id, g.current);
  };

  const setOpacity = (v: { id: string; value: number } | null) => { opacityRef.current = v; setOpacityLive(v); };
  const commitOpacity = () => {
    sliderDown.current = false;
    const cur = opacityRef.current;
    setOpacity(null);
    if (!cur) return;
    const base = items.find(i => i.attachmentId === cur.id);
    if (base) cb.current.onCommit?.(cur.id, setStickerOpacity(base, cur.value));
  };

  if (!(W > 0) || !(H > 0)) return null;
  const pct = selected ? Math.round(selected.opacity * 100) : 0;

  return (
    <div
      ref={rootRef}
      className={'stk-layer' + (editing ? ' is-editing' : '') + (showing ? ' is-showing' : '')}
      style={{ width: W, height: H }}
    >
      {shown.map((el, i) => {
        const src = srcOf(el.attachmentId);
        if (!src) return null;
        const isSel = editing && el.attachmentId === selectedId;
        return (
          <div
            key={el.attachmentId}
            data-stk={editing ? '' : undefined}
            className={'stk' + (editing ? ' is-editable' : '') + (isSel ? ' is-selected' : '')}
            style={stickerCss(el, W, H)}
            onPointerDown={editing ? (e) => begin(e, el, 'move') : undefined}
            onPointerMove={editing ? move : undefined}
            onPointerUp={editing ? (e) => end(e, false) : undefined}
            onPointerCancel={editing ? (e) => end(e, true) : undefined}
          >
            <img
              ref={(node) => imageRef?.(el.attachmentId, node)}
              src={src}
              alt={`貼圖 ${i + 1}`}
              draggable={false}
              style={{ opacity: el.opacity }}
            />
            {isSel && (
              <>
                {CORNERS.map(c => (
                  <span
                    key={c}
                    className={`stk__handle stk__handle--${c}`}
                    onPointerDown={(e) => begin(e, el, 'scale')}
                    title="拖這裡縮放"
                  />
                ))}
                <span className="stk__rotline" aria-hidden="true" />
                <span className="stk__rotate" onPointerDown={(e) => begin(e, el, 'rotate')} title="拖這裡旋轉（按住 Shift 每 15 度一格）" />
              </>
            )}
          </div>
        );
      })}

      {editing && selected && (
        <div className="stk-panel" data-stk role="group" aria-label="調整貼圖">
          <label className="stk-panel__opacity" title="調成半透明，才看得到底下的舞台">
            <span>不透明度</span>
            <input
              type="range"
              min={5}
              max={100}
              step={1}
              value={opacityLive && opacityLive.id === selected.attachmentId ? Math.round(opacityLive.value * 100) : pct}
              aria-label="貼圖的不透明度"
              onChange={(e) => {
                const value = Number(e.target.value) / 100;
                setOpacity({ id: selected.attachmentId, value });
                // 滑鼠 / 手指拖滑桿：放開才存；用鍵盤一格一格調：馬上存
                if (!sliderDown.current) commitOpacity();
              }}
              onPointerDown={() => { sliderDown.current = true; }}
              onPointerUp={commitOpacity}
              onPointerCancel={commitOpacity}
              onBlur={() => { if (sliderDown.current) commitOpacity(); }}
            />
            <span className="stk-panel__pct">{opacityLive && opacityLive.id === selected.attachmentId ? Math.round(opacityLive.value * 100) : pct}%</span>
          </label>
          <button
            type="button"
            className="stk-panel__btn"
            onClick={() => cb.current.onRemove?.(selected.attachmentId)}
            title="把這張貼圖從畫面上拿掉（圖片還在留言裡；Delete 鍵也可以）"
            aria-label="刪除這張貼圖"
          ><Icon icon={Trash2} size="md" /></button>
          <button type="button" className="stk-panel__btn stk-panel__btn--done" onClick={() => cb.current.onFinish?.()} title="調整完了（貼圖留在畫面上，可以轉 3D 視角對照）" aria-label="調整完了">
            <Icon icon={Check} size="md" /><span>完成</span>
          </button>
          <span className="stk-panel__tip stk-panel__tip--mouse">拖曳移動 · 拖角落縮放 · 拖上面的圓點旋轉（Shift 每 15 度）</span>
          <span className="stk-panel__tip stk-panel__tip--touch">單指拖曳移動 · 兩指縮放、旋轉</span>
        </div>
      )}
    </div>
  );
}
