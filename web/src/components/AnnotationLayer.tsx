// 畫記（疊在 3D 畫面上的 SVG，不畫進 WebGL）：
//   畫的時候（draft.active）：筆 / 箭頭 / 方框 / 圓圈、5 個顏色、復原、清除；滑鼠、手指、iPad 的筆都可以
//     （用筆畫的時候手掌碰到螢幕不算）。3D 畫面這時候不能轉（畫記才會跟畫面對得上）。
//   打開有畫記的留言（showing）：攝影機飛到當時的視角後疊上去，比例跟當時一樣（containBox）；按播放或轉視角就收起來。
// 貼圖（貼在畫面上的參考圖片，StickerLayer）也在這一層：留言框裡的圖片「放到畫面上」、把圖片檔拖進 3D 畫面；
//   貼圖不用先按「畫記」，3D 視角照樣可以轉（拿來對照舞台）；打開有貼圖的留言，貼圖跟筆畫一起出現在同樣的位置。
// 座標 / 形狀的規則在 lib/review/annotations.ts。窄的畫面（手機、iPad 直放）工具列收成一排小按鈕。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Circle, ImagePlus, ImageUp, MoveUpRight, Pencil, Square, Trash2, Undo2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Icon from './Icon';
import {
  ANN_COLORS, ANN_TOOL_LABEL, ANN_TOOLS, containBox, makeShape, shapePath, strokePx, toNormalized,
  type AnnShape, type AnnTool, type Annotation,
} from '../lib/review/annotations';
import type { AnnotationDraft, StickerDraft } from '../lib/review/useReviewSession';
import { attachmentSrc, type CommentAttachment } from '../lib/api';
import { confirmDialog } from './dialogs';
import StickerLayer from './StickerLayer';
import './AnnotationLayer.css';
import './StickerLayer.css';

const TOOL_ICON: Record<AnnTool, LucideIcon> = { pen: Pencil, arrow: MoveUpRight, rect: Square, ellipse: Circle };

interface Props {
  draft?: AnnotationDraft | null;
  /** 打開的留言的畫記（沒在畫的時候才顯示） */
  showing?: Annotation | null;
  /** 畫記旁邊的小字（例：王導 · 0:12） */
  showingLabel?: string;
  onHideShowing?: () => void;
  /** 畫好了（收起工具列，回到留言框） */
  onDone?: () => void;
  /** 貼圖草稿（寫留言時貼在畫面上的參考圖片）；沒給 = 沒有貼圖功能 */
  stickers?: StickerDraft | null;
  /** 打開的留言的參考圖片（畫記裡的貼圖用它們的網址） */
  showingAttachments?: readonly CommentAttachment[];
}

function useSize(ref: React.RefObject<HTMLElement>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function ShapePaths({ shapes, W, H }: { shapes: readonly AnnShape[]; W: number; H: number }) {
  return (
    <>
      {shapes.map((s, i) => {
        const d = shapePath(s, W, H);
        const sw = strokePx(s.w, H);
        return (
          <g key={i}>
            {/* 深色描邊：亮的舞台上也看得清楚 */}
            <path d={d} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={sw + 2.5} strokeLinecap="round" strokeLinejoin="round" />
            <path d={d} fill="none" stroke={s.c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      })}
    </>
  );
}

export default function AnnotationLayer({ draft, showing, showingLabel, onHideShowing, onDone, stickers, showingAttachments }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(rootRef);
  const drawing = !!draft?.active;
  const draftImages = stickers?.items ?? [];
  // 打開別人的留言時，自己正在貼的貼圖先藏起來（留言收起來就回來）
  const stickerDraftShown = draftImages.length > 0 && !showing;
  const aspect = drawing ? draft!.aspect : showing ? showing.aspect : stickerDraftShown ? stickers!.aspect : 16 / 9;
  const box = containBox(w, h, aspect);
  const compact = w > 0 && w < 560;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!drawing) setExpanded(false); }, [drawing]);

  // 正在畫的這一筆（還沒放開）
  const [live, setLive] = useState<number[] | null>(null);
  const strokeRef = useRef<{ id: number; type: string; pts: number[] } | null>(null);
  const penSeenRef = useRef(false);

  const frameRect = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return null;
    return { left: r.left + box.left, top: r.top + box.top, width: box.width, height: box.height };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draft) return;
    if (e.pointerType === 'pen') penSeenRef.current = true;
    // 用過筆 → 手指 / 手掌碰到不算（iPad 用 Apple Pencil 畫的時候）
    if (e.pointerType === 'touch' && penSeenRef.current) return;
    if (strokeRef.current) return;  // 第二根手指不算
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const r = frameRect();
    if (!r) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const [x, y] = toNormalized(e.clientX, e.clientY, r);
    strokeRef.current = { id: e.pointerId, type: e.pointerType, pts: [x, y] };
    setLive([x, y]);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const st = strokeRef.current;
    if (!st || st.id !== e.pointerId) return;
    const r = frameRect();
    if (!r) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    let changed = false;
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const [x, y] = toNormalized(ev.clientX, ev.clientY, r);
      const n = st.pts.length;
      const lx = st.pts[n - 2], ly = st.pts[n - 1];
      if (draft?.tool !== 'pen') { st.pts = [st.pts[0], st.pts[1], x, y]; changed = true; continue; }
      if (Math.hypot((x - lx) * aspect, y - ly) < 0.0025) continue;
      st.pts.push(x, y);
      changed = true;
    }
    if (changed) setLive(st.pts.slice());
  };
  const finishStroke = (e: React.PointerEvent<SVGSVGElement>, cancelled = false) => {
    const st = strokeRef.current;
    if (!st || st.id !== e.pointerId) return;
    strokeRef.current = null;
    setLive(null);
    if (cancelled || !draft) return;
    const s = makeShape(draft.tool, draft.color, st.pts, aspect);
    if (s) draft.add(s);
  };

  // Ctrl / Cmd + Z = 復原一筆（畫的時候）
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
        e.preventDefault();
        draft?.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, draft]);

  // 已經畫了東西才按叉叉 → 先問一聲（叉叉跟「畫好了」挨在一起，手機上容易按錯）
  async function cancelDrawing() {
    if (!draft) return;
    if (draft.shapes.length > 0 && !(await confirmDialog({
      title: '不要這個畫記了？',
      message: `畫好的 ${draft.shapes.length} 筆會不見。要留著的話按「畫好了」，再寫留言送出。`,
      confirmLabel: '不要了',
      cancelLabel: '繼續畫',
      destructive: true,
    }))) return;
    draft.cancel();
  }

  // 把圖片檔拖進 3D 畫面 → 交給留言框上傳，傳好就貼上去（沿用留言框的流程：縮小、上傳、張數上限）
  const stickersRef = useRef(stickers);
  stickersRef.current = stickers;
  const [dropOver, setDropOver] = useState(false);
  const canDrop = !!stickers?.canDrop;
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host || !canDrop) { setDropOver(false); return; }
    let depth = 0;
    const isImageDrag = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt || !Array.from(dt.types || []).includes('Files')) return false;
      const items = Array.from(dt.items || []);
      return items.length === 0 || items.some(i => i.kind === 'file' && i.type.startsWith('image/'));
    };
    const onEnter = (e: DragEvent) => {
      if (!isImageDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth++;
      setDropOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isImageDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!isImageDrag(e)) return;
      e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (!depth) setDropOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isImageDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      setDropOver(false);
      stickersRef.current?.dropFiles(Array.from(e.dataTransfer?.files || []));
    };
    host.addEventListener('dragenter', onEnter);
    host.addEventListener('dragover', onOver);
    host.addEventListener('dragleave', onLeave);
    host.addEventListener('drop', onDrop);
    return () => {
      host.removeEventListener('dragenter', onEnter);
      host.removeEventListener('dragover', onOver);
      host.removeEventListener('dragleave', onLeave);
      host.removeEventListener('drop', onDrop);
      setDropOver(false);
    };
  }, [canDrop]);

  if (!drawing && !showing && !stickerDraftShown && !dropOver) return <div ref={rootRef} className="ann-layer" aria-hidden="true" />;

  const W = box.width, H = box.height;
  const liveShape: AnnShape | null = live && draft
    ? (draft.tool === 'pen'
      ? { t: 'pen', c: draft.color, w: 0.006, p: live }
      : live.length >= 4 ? { t: draft.tool, c: draft.color, w: 0.006, p: live.slice(0, 2).concat(live.slice(-2)) } : null)
    : null;
  const shapes = drawing ? draft!.shapes : showing?.shapes ?? [];
  // 貼圖：打開的留言用它自己的圖片網址；草稿用本機預覽（或上傳好的網址）
  const showingSrc = (id: string) => {
    const a = showingAttachments?.find(x => x.id === id);
    return a ? attachmentSrc(a.url) : undefined;
  };
  const showingImages = showing?.images ?? [];
  const editingStickers = !!stickers && stickers.editing && !drawing && !showing;
  const showingKind = !showing ? '' : showing.shapes.length ? (showingImages.length ? '畫記和貼圖' : '畫記') : '貼圖';

  const toolButtons = ANN_TOOLS.map(t => (
    <button
      key={t}
      type="button"
      className={'ann-tool' + (draft?.tool === t ? ' is-active' : '')}
      onClick={() => { draft?.setTool(t); if (compact) setExpanded(false); }}
      title={ANN_TOOL_LABEL[t]}
      aria-label={ANN_TOOL_LABEL[t]}
      aria-pressed={draft?.tool === t}
    ><Icon icon={TOOL_ICON[t]} size="md" /></button>
  ));
  const colorButtons = ANN_COLORS.map(c => (
    <button
      key={c.value}
      type="button"
      className={'ann-color' + (draft?.color === c.value ? ' is-active' : '')}
      style={{ ['--ann-swatch' as string]: c.value }}
      onClick={() => { draft?.setColor(c.value); if (compact) setExpanded(false); }}
      title={`顏色：${c.label}`}
      aria-label={`顏色：${c.label}`}
      aria-pressed={draft?.color === c.value}
    />
  ));

  return (
    <div ref={rootRef} className={'ann-layer' + (drawing ? ' is-drawing' : showing ? ' is-showing' : ' is-stickers')}>
      {/* 貼圖在筆畫下面（畫記的時候筆畫要蓋在貼圖上） */}
      {W > 0 && H > 0 && (showing ? showingImages.length > 0 : stickerDraftShown) && (
        <div style={{ position: 'absolute', left: box.left, top: box.top, width: W, height: H, pointerEvents: 'none' }}>
          {showing ? (
            <StickerLayer width={W} height={H} items={showingImages} srcOf={showingSrc} showing />
          ) : (
            <StickerLayer
              width={W}
              height={H}
              items={draftImages}
              srcOf={(id) => stickers!.sources[id]?.src}
              editing={editingStickers}
              selectedId={stickers!.selectedId}
              onSelect={stickers!.select}
              onCommit={stickers!.commit}
              onRemove={stickers!.remove}
              onFinish={stickers!.finish}
              imageRef={stickers!.imageRef}
            />
          )}
        </div>
      )}
      {(drawing || shapes.length > 0) && (
        <svg
          className="ann-layer__svg"
          style={{ left: box.left, top: box.top, width: W, height: H }}
          viewBox={`0 0 ${Math.max(1, W)} ${Math.max(1, H)}`}
          onPointerDown={drawing ? onPointerDown : undefined}
          onPointerMove={drawing ? onPointerMove : undefined}
          onPointerUp={drawing ? (e) => finishStroke(e) : undefined}
          onPointerCancel={drawing ? (e) => finishStroke(e, true) : undefined}
          role={drawing ? 'img' : undefined}
          aria-label={drawing ? '畫記：在畫面上拖拉畫出來' : '這則留言的畫記'}
        >
          <ShapePaths shapes={shapes} W={W} H={H} />
          {liveShape && <ShapePaths shapes={[liveShape]} W={W} H={H} />}
        </svg>
      )}

      {drawing && draft && (
        <div className={'ann-toolbar' + (compact ? ' is-compact' : '') + (expanded ? ' is-expanded' : '')} role="toolbar" aria-label="畫記工具">
          {compact ? (
            <>
              <button
                type="button"
                className="ann-tool is-active ann-toolbar__pick"
                onClick={() => setExpanded(x => !x)}
                title="換工具、換顏色"
                aria-label={`工具：${ANN_TOOL_LABEL[draft.tool]}（換工具、換顏色）`}
                aria-expanded={expanded}
              >
                <Icon icon={TOOL_ICON[draft.tool]} size="md" />
                <span className="ann-toolbar__dot" style={{ background: draft.color }} aria-hidden="true" />
                <Icon icon={ChevronDown} size="xs" />
              </button>
              {expanded && (
                <div className="ann-toolbar__menu">
                  <div className="ann-toolbar__row">{toolButtons}</div>
                  <div className="ann-toolbar__row">{colorButtons}</div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="ann-toolbar__group">{toolButtons}</div>
              <span className="ann-toolbar__sep" aria-hidden="true" />
              <div className="ann-toolbar__group">{colorButtons}</div>
              <span className="ann-toolbar__sep" aria-hidden="true" />
            </>
          )}
          <button type="button" className="ann-tool" onClick={draft.undo} disabled={!draft.canUndo} title="復原一筆（Ctrl+Z；擦掉的也拿得回來）" aria-label="復原一筆">
            <Icon icon={Undo2} size="md" />
          </button>
          {!compact && (
            <button type="button" className="ann-tool" onClick={draft.clear} disabled={draft.shapes.length === 0} title="全部擦掉（按復原拿得回來）" aria-label="全部擦掉">
              <Icon icon={Trash2} size="md" />
            </button>
          )}
          <span className="ann-toolbar__count">{draft.shapes.length > 0 ? `${draft.shapes.length} 筆` : '在畫面上拖拉'}</span>
          {onDone && (
            <button type="button" className="ann-tool ann-tool--done" onClick={onDone} title="畫好了，回到留言框" aria-label="畫好了，回到留言框">
              <Icon icon={Check} size="md" />{!compact && <span>畫好了</span>}
            </button>
          )}
          <button type="button" className="ann-tool ann-tool--cancel" onClick={() => void cancelDrawing()} title="不要畫記了" aria-label="不要畫記了">
            <Icon icon={X} size="md" />
          </button>
        </div>
      )}

      {!drawing && showing && (
        // 3D 工具列在上面 → 小標放在工具列下面，不會疊在一起
        <div className="ann-badge" style={{ left: box.left + 8, top: Math.max(box.top + 8, 58) }}>
          <Icon icon={showing.shapes.length ? Pencil : ImageUp} size="xs" />
          <span>{showingLabel ? `${showingKind} · ${showingLabel}` : showingKind}</span>
          {onHideShowing && (
            <button type="button" className="ann-badge__close" onClick={onHideShowing} title="收起畫記" aria-label="收起畫記">
              <Icon icon={X} size="xs" />
            </button>
          )}
        </div>
      )}

      {/* 貼圖留在畫面上、沒在調整：左上角一顆小按鈕回去調整 */}
      {!drawing && !showing && stickerDraftShown && !stickers!.editing && (
        <button
          type="button"
          data-stk=""
          className="stk-pill"
          style={{ left: box.left + 8, top: Math.max(box.top + 8, 58) }}
          onClick={stickers!.edit}
          title="回去調整貼圖的位置、大小、角度、不透明度"
        >
          <Icon icon={ImageUp} size="xs" />
          <span>貼圖 {draftImages.length} 張 · 調整</span>
        </button>
      )}

      {/* 圖片檔拖到 3D 畫面上 */}
      {dropOver && (
        <div className="stk-drop" aria-hidden="true">
          <Icon icon={ImagePlus} size="md" /> 放開就貼到畫面上，一起放進留言
        </div>
      )}
    </div>
  );
}
