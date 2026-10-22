// cue 清單每一列左邊的拖拉把手（滑鼠和手指都能拖；也可以用鍵盤上下鍵）。
// 用 pointer 事件自己做（原生 drag 在觸控螢幕上不會動）：按住把手移動，經過哪一列就標哪一列，放開就換。
// 每一列要有 data-cue-row={cue id}，才認得出手指/滑鼠現在在哪一列上面。

import { useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import Icon from './Icon';
import './CueDragHandle.css';

interface Options {
  canDrop: (fromId: string, toId: string) => boolean;
  onDrop: (fromId: string, toId: string) => void;
  /** 鍵盤上下鍵：dir = -1 往上 / 1 往下 */
  onStep: (id: string, dir: -1 | 1) => void;
  disabled?: boolean;
}

export function useCueRowDrag({ canDrop, onDrop, onStep, disabled }: Options) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const cur = useRef<{ id: string; over: string | null } | null>(null);

  function end(commit: boolean) {
    const c = cur.current;
    cur.current = null;
    setDragId(null);
    setOverId(null);
    if (commit && c && c.over) onDrop(c.id, c.over);
  }
  function move(e: React.PointerEvent) {
    const c = cur.current;
    if (!c) return;
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-cue-row]');
    const to = row?.getAttribute('data-cue-row') ?? null;
    const ok = to && to !== c.id && canDrop(c.id, to) ? to : null;
    if (ok !== c.over) { c.over = ok; setOverId(ok); }
  }

  function handleProps(id: string) {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        e.stopPropagation();
        try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* 不支援就算了 */ }
        cur.current = { id, over: null };
        setDragId(id);
      },
      onPointerMove: move,
      onPointerUp: () => end(true),
      onPointerCancel: () => end(false),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (disabled) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          onStep(id, e.key === 'ArrowUp' ? -1 : 1);
        } else if (e.key === 'Escape' && cur.current) end(false);
      },
    };
  }
  /** 給每一列的 className 用 */
  function rowClass(id: string): string {
    return (dragId === id ? ' is-dragging' : '') + (overId === id ? ' is-drop-target' : '') + (dragId ? ' is-sorting' : '');
  }
  return { dragId, overId, handleProps, rowClass };
}

export default function CueDragHandle({ props, label, disabled }: { props: ReturnType<ReturnType<typeof useCueRowDrag>['handleProps']>; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="cue-drag-handle"
      aria-label={`${label}：按住上下拖，或用上下鍵換順序`}
      title="按住上下拖，換順序"
      disabled={disabled}
      {...props}
    >
      <Icon icon={GripVertical} />
    </button>
  );
}
