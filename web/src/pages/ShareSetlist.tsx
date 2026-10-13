import { useEffect, useRef, useState, type DragEvent } from 'react';
import { formatClock } from '../lib/localVideo';
import type { LocalMediaItem } from '../lib/localMedia';
import Icon from '../components/Icon';
import { Film, Image, Pause, Play, Plus, X } from 'lucide-react';

/** 清單裡拖曳排順序用的資料型別（跟從電腦拖檔案進來分開：檔案的 types 會有 'Files'） */
const ROW_DRAG_TYPE = 'application/x-stage-previz-media';

export const MEDIA_ACCEPT = 'video/*,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif';

interface Props {
  items: LocalMediaItem[];
  activeId: string | null;
  /** 正在放的影片在播嗎（列上顯示 ▶ 播放中 / ⏸ 暫停） */
  activePlaying: boolean;
  /** 正在放的影片長度（縮圖還沒做好、清單還不知道片長時用） */
  activeDuration: number;
  /** 正從電腦拖檔案進頁面 → 加入的框亮起來 */
  fileDragOver: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, insertAt: number) => void;
  onAddFiles: (files: FileList | null) => void;
}

/**
 * 分享頁左邊的「本地檔案」清單（像演唱會的歌單）：
 * 1、2、3… 由上往下，縮圖 + 檔名 + 影片 / 圖片 + 片長；點哪個 LED 就放哪個，拖曳排順序，✕ 移除。
 * 手機寬度時變成橫的一排（CSS）。
 */
export default function ShareSetlist({
  items, activeId, activePlaying, activeDuration, fileDragOver, onSelect, onRemove, onMove, onAddFiles,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  /** 放開的話會插在原本第幾個的前面 */
  const [dropAt, setDropAt] = useState<number | null>(null);

  // 換了正在放的（點的、↑↓）→ 捲到看得到；鍵盤焦點本來在清單上就跟著移過去
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.is-active .share-setlist__pick');
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const focused = document.activeElement;
    if (focused !== el && focused?.classList.contains('share-setlist__pick')) el.focus({ preventScroll: true });
  }, [activeId]);

  const endDrag = () => { setDragId(null); setDropAt(null); };

  const onRowDragOver = (e: DragEvent<HTMLLIElement>, index: number) => {
    if (!dragId || !e.dataTransfer.types.includes(ROW_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // 直的清單看上下半、手機橫的一排看左右半
    const r = e.currentTarget.getBoundingClientRect();
    const horizontal = listRef.current ? getComputedStyle(listRef.current).flexDirection === 'row' : false;
    const before = horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    const at = before ? index : index + 1;
    if (at !== dropAt) setDropAt(at);
  };

  const onListDrop = (e: DragEvent<HTMLOListElement>) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();  // 不要再被頁面當成「拖檔案進來」
    if (dropAt != null) onMove(dragId, dropAt);
    endDrag();
  };

  const fromIndex = dragId ? items.findIndex(x => x.id === dragId) : -1;
  // 放回原位不用畫插入線
  const showDropAt = dropAt != null && dropAt !== fromIndex && dropAt !== fromIndex + 1 ? dropAt : null;

  return (
    <section className={'share-setlist' + (items.length === 0 ? ' is-empty' : '')}>
      <div className="share-side__title share-setlist__head">
        <span>本地檔案{items.length > 0 && <span className="share-setlist__count">{items.length}</span>}</span>
        {items.length > 1 && <span className="share-setlist__tip">拖曳排順序 · ↑↓ 切換</span>}
      </div>

      {items.length > 0 && (
        <ol
          ref={listRef}
          className={'share-setlist__list' + (dragId ? ' is-dragging' : '')}
          onDragOver={(e) => { if (dragId && e.dataTransfer.types.includes(ROW_DRAG_TYPE)) e.preventDefault(); }}
          onDrop={onListDrop}
        >
          {items.map((it, i) => {
            const active = it.id === activeId;
            const duration = it.duration ?? (active ? activeDuration : 0);
            const thumb = it.thumb ?? (it.thumbReady && it.kind === 'image' ? it.url : null);
            return (
              <li
                key={it.id}
                className={'share-setlist__row'
                  + (active ? ' is-active' : '')
                  + (it.id === dragId ? ' is-dragged' : '')
                  + (showDropAt === i ? ' is-drop-before' : '')
                  + (showDropAt === items.length && i === items.length - 1 ? ' is-drop-after' : '')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(ROW_DRAG_TYPE, it.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragId(it.id);
                }}
                onDragOver={(e) => onRowDragOver(e, i)}
                onDragEnd={endDrag}
              >
                <button
                  className="share-setlist__pick"
                  onClick={() => onSelect(it.id)}
                  title={`${it.name}（點了放到 LED 上，拖曳可以排順序）`}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="share-setlist__num">{i + 1}</span>
                  <span className={'share-setlist__thumb' + (!it.thumbReady ? ' is-loading' : '')}>
                    {thumb
                      ? <img src={thumb} alt="" draggable={false} />
                      : it.thumbReady ? <span aria-hidden><Icon icon={it.kind === 'video' ? Film : Image} size="md" /></span> : null}
                  </span>
                  <span className="share-setlist__text">
                    <span className="share-setlist__name">{it.name}</span>
                    <span className="share-setlist__meta">
                      <span className="share-setlist__tag">{it.kind === 'video' ? '影片' : '圖片'}</span>
                      {it.kind === 'video' && duration > 0 && <span className="share-setlist__dur">{formatClock(duration)}</span>}
                      {active && (
                        <span className="share-setlist__now">
                          {it.kind === 'video'
                            ? (activePlaying ? <><Icon icon={Play} size="xs" /> 播放中</> : <><Icon icon={Pause} size="xs" /> 暫停</>)
                            : <><span className="ndi-dot ndi-dot--on" aria-hidden="true" /> 顯示中</>}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  className="share-setlist__remove"
                  onClick={() => onRemove(it.id)}
                  title="從清單移除"
                  aria-label={`從清單移除 ${it.name}`}
                ><Icon icon={X} /></button>
              </li>
            );
          })}
        </ol>
      )}

      <button
        className={'share-setlist__add' + (fileDragOver ? ' is-dragover' : '')}
        onClick={() => inputRef.current?.click()}
        title="加入影片 / 圖片（也可以直接把檔案拖進來）"
      >
        <span className="share-setlist__add-main"><Icon icon={Plus} /><span className="share-setlist__add-label"> 加入影片 / 圖片…</span></span>
        <span className="share-setlist__add-sub">{fileDragOver ? '放開就加進清單' : '也可以直接把檔案拖進來'}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        hidden
        onChange={(e) => { onAddFiles(e.target.files); e.target.value = ''; }}
      />
      <p className="share-setlist__hint">檔案只在這台電腦播放，不會上傳</p>
    </section>
  );
}
