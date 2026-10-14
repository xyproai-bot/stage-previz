// 畫記（疊在 3D 畫面上的 SVG，不畫進 WebGL）：
//   畫的時候（draft.active）：筆 / 箭頭 / 方框 / 圓圈、5 個顏色、復原、清除；滑鼠、手指、iPad 的筆都可以
//     （用筆畫的時候手掌碰到螢幕不算）。3D 畫面這時候不能轉（畫記才會跟畫面對得上）。
//   打開有畫記的留言（showing）：攝影機飛到當時的視角後疊上去，比例跟當時一樣（containBox）；按播放或轉視角就收起來。
// 座標 / 形狀的規則在 lib/review/annotations.ts。窄的畫面（手機、iPad 直放）工具列收成一排小按鈕。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Circle, MoveUpRight, Pencil, Square, Trash2, Undo2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Icon from './Icon';
import {
  ANN_COLORS, ANN_TOOL_LABEL, ANN_TOOLS, containBox, makeShape, shapePath, strokePx, toNormalized,
  type AnnShape, type AnnTool, type Annotation,
} from '../lib/review/annotations';
import type { AnnotationDraft } from '../lib/review/useReviewSession';
import { confirmDialog } from './dialogs';
import './AnnotationLayer.css';

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

export default function AnnotationLayer({ draft, showing, showingLabel, onHideShowing, onDone }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(rootRef);
  const drawing = !!draft?.active;
  const aspect = drawing ? draft!.aspect : showing?.aspect ?? 16 / 9;
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

  if (!drawing && !showing) return <div ref={rootRef} className="ann-layer" aria-hidden="true" />;

  const W = box.width, H = box.height;
  const liveShape: AnnShape | null = live && draft
    ? (draft.tool === 'pen'
      ? { t: 'pen', c: draft.color, w: 0.006, p: live }
      : live.length >= 4 ? { t: draft.tool, c: draft.color, w: 0.006, p: live.slice(0, 2).concat(live.slice(-2)) } : null)
    : null;
  const shapes = drawing ? draft!.shapes : showing!.shapes;

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
    <div ref={rootRef} className={'ann-layer' + (drawing ? ' is-drawing' : ' is-showing')}>
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
          <Icon icon={Pencil} size="xs" />
          <span>{showingLabel ? `畫記 · ${showingLabel}` : '畫記'}</span>
          {onHideShowing && (
            <button type="button" className="ann-badge__close" onClick={onHideShowing} title="收起畫記" aria-label="收起畫記">
              <Icon icon={X} size="xs" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
