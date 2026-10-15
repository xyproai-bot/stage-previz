// 留言的參考圖片和連結（導演頁、動畫師工作站、分享連結共用）：
//   留言框：AttachmentDropZone（貼上 Ctrl+V、拖進來）+ AttachButton（選檔案）+ AttachmentTray（還沒送出的，可以拿掉 / 重試）
//   留言裡：CommentText（網址變成可以點的、認得的影片網站多一張小卡片）+ AttachmentGrid（縮圖，點了開大圖）
//   大圖（ImageLightbox）：上一張 / 下一張（左右鍵）、Esc 關、「在新分頁開啟」
// 規則：lib/review/attachmentRules.ts、imagePrep.ts、commentLinks.ts；上傳：lib/review/useAttachmentDraft.ts

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Camera, ChevronLeft, ChevronRight, CirclePlay, ExternalLink, FolderOpen, HardDrive, ImagePlus, LoaderCircle, RotateCcw, X,
  type LucideIcon,
} from 'lucide-react';
import Icon from './Icon';
import { attachmentSrc, type CommentAttachment } from '../lib/api';
import type { AttachmentDraft } from '../lib/review/useAttachmentDraft';
import type { StickerDraft } from '../lib/review/useReviewSession';
import { stickerSourceOf } from '../lib/review/useStickerBridge';
import { ACCEPT_ATTR, pastePlan } from '../lib/review/imagePrep';
import { linkCards, shortenUrl, splitLinks, youtubeThumb, type LinkCard, type LinkKind } from '../lib/review/commentLinks';
import './CommentAttachments.css';

// ─── 留言框 ───

/** 包住留言框：貼上圖片（Ctrl+V）、把圖片拖進來 */
export function AttachmentDropZone({ draft, disabled = false, className, children }: {
  draft: AttachmentDraft; disabled?: boolean; className?: string; children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const on = draft.enabled && !disabled;
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  return (
    <div
      className={'att-drop' + (over ? ' is-over' : '') + (className ? ` ${className}` : '')}
      onPaste={on ? (e) => {
        const files = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
        if (pastePlan(files.length, e.clipboardData?.getData('text/html') || '') !== 'images') return;
        e.preventDefault();
        draft.addFiles(files);
      } : undefined}
      onDragEnter={on ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); } : undefined}
      onDragOver={on ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } : undefined}
      onDragLeave={on ? () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); } : undefined}
      onDrop={on ? (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        draft.addFiles(Array.from(e.dataTransfer.files));
      } : undefined}
    >
      {children}
      {over && <div className="att-drop__hint" aria-hidden="true"><Icon icon={ImagePlus} size="md" /> 放開就加進留言（最多 {draft.max} 張）</div>}
    </div>
  );
}

/** 「加參考圖片」按鈕（選檔案） */
export function AttachButton({ draft, disabled = false, compact = false }: { draft: AttachmentDraft; disabled?: boolean; compact?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (!draft.enabled) return null;
  const full = draft.items.length >= draft.max;
  const title = full ? `一則留言最多 ${draft.max} 張圖片` : `加參考圖片（PNG、JPEG、WebP、GIF，最多 ${draft.max} 張；也可以直接貼上或拖進來）`;
  return (
    <>
      <button
        type="button"
        className={'att-add' + (compact ? ' att-add--compact' : '')}
        onClick={() => inputRef.current?.click()}
        disabled={disabled || full}
        title={title}
        aria-label="加參考圖片"
      >
        <Icon icon={ImagePlus} size="sm" />{!compact && <span>圖片</span>}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        hidden
        onChange={(e) => { if (e.target.files) draft.addFiles(e.target.files); e.target.value = ''; }}
      />
    </>
  );
}

/**
 * 還沒送出的圖片（縮圖、上傳中幾 %、失敗可以重試、拿掉）
 * stickers 有給 → 傳好的圖片多一顆「放到畫面上」：貼在 3D 畫面上，跟這則留言一起存（再按一下拿下來，圖片還是會送出）
 */
export function AttachmentTray({ draft, disabled = false, stickers }: { draft: AttachmentDraft; disabled?: boolean; stickers?: StickerDraft }) {
  if (!draft.items.length) return null;
  return (
    <ul className="att-tray" aria-label="要一起送出的參考圖片">
      {draft.items.map((it, i) => {
        const src = stickers ? stickerSourceOf(it) : null;
        const placed = !!src && stickers!.has(src.id);
        return (
        <li key={it.key} className={`att-tray__item is-${it.status}${placed ? ' is-placed' : ''}`} title={it.error || undefined}>
          {it.preview ? <img src={it.preview} alt={`參考圖片 ${i + 1}`} /> : <span className="att-tray__blank" />}
          {(it.status === 'preparing' || it.status === 'uploading') && (
            <span className="att-tray__state">
              <Icon icon={LoaderCircle} size="sm" spin />
              {it.status === 'uploading' && <span>{Math.round(it.progress * 100)}%</span>}
            </span>
          )}
          {it.status === 'error' && (
            <button type="button" className="att-tray__retry" onClick={() => draft.retry(it.key)} title={`${it.error || '沒傳上去'}（按一下重試）`} aria-label="重試上傳">
              <Icon icon={RotateCcw} size="sm" />
            </button>
          )}
          <button type="button" className="att-tray__remove" onClick={() => draft.remove(it.key)} disabled={disabled} title="拿掉這張" aria-label="拿掉這張圖片">
            <Icon icon={X} size="xs" />
          </button>
          {src && (
            <button
              type="button"
              className={'att-tray__place' + (placed ? ' is-on' : '')}
              onClick={() => { if (placed) stickers!.remove(src.id); else stickers!.place(src); }}
              disabled={disabled}
              aria-pressed={placed}
              title={placed ? '已經貼在 3D 畫面上了（按一下拿下來，圖片還是會一起送出）' : '把這張圖片貼到 3D 畫面上，可以移動、縮放、旋轉、調半透明，跟留言一起存'}
              aria-label={placed ? `第 ${i + 1} 張圖片：已放在畫面上，按一下拿下來` : `第 ${i + 1} 張圖片：放到畫面上`}
            >{placed ? '在畫面上' : '放到畫面上'}</button>
          )}
        </li>
        );
      })}
    </ul>
  );
}

// ─── 留言裡 ───

const CARD_ICON: Record<LinkKind, LucideIcon> = {
  youtube: CirclePlay, vimeo: CirclePlay, bilibili: CirclePlay, youku: CirclePlay,
  drive: HardDrive, dropbox: FolderOpen, instagram: Camera,
};

function LinkCardView({ card }: { card: LinkCard }) {
  // YouTube 縮圖：先顯示圖示，縮圖真的載好才換上去（連不到 i.ytimg.com 的地方就一直是圖示，不會破圖）
  const [thumbOk, setThumbOk] = useState(false);
  return (
    <a className={`att-card att-card--${card.kind}`} href={card.url} target="_blank" rel="noopener noreferrer" title={card.url}>
      <span className="att-card__media">
        <Icon icon={CARD_ICON[card.kind]} size="lg" />
        {card.youtubeId && (
          <img
            src={youtubeThumb(card.youtubeId)}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className={thumbOk ? 'is-loaded' : ''}
            onLoad={(e) => { if ((e.currentTarget.naturalWidth || 0) > 120) setThumbOk(true); }}
            onError={() => setThumbOk(false)}
          />
        )}
      </span>
      <span className="att-card__text">
        <span className="att-card__host">{card.label}</span>
        <span className="att-card__what">{card.what} · {shortenUrl(card.url, 32)}</span>
      </span>
      <Icon icon={ExternalLink} size="xs" className="att-card__go" />
    </a>
  );
}

/** 留言文字：網址變成可以點的（新分頁開），太長的縮短；認得的影片 / 參考網站多一張小卡片。只顯示文字，不會跑 HTML */
export function CommentText({ text, className = 'rvc-text', cards = true }: { text: string; className?: string; cards?: boolean }) {
  const parts = splitLinks(text);
  const list = cards ? linkCards(text) : [];
  return (
    <>
      {text ? (
        <div className={className}>
          {parts.map((p, i) => (p.type === 'text'
            ? <span key={i}>{p.text}</span>
            : <a key={i} className="att-link" href={p.url} target="_blank" rel="noopener noreferrer" title={p.url}>{shortenUrl(p.text)}</a>))}
        </div>
      ) : null}
      {list.length > 0 && (
        <div className="att-cards">{list.map(c => <LinkCardView key={c.url} card={c} />)}</div>
      )}
    </>
  );
}

/** 留言裡的參考圖片：縮圖一排，點了開大圖 */
export function AttachmentGrid({ attachments }: { attachments: CommentAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!attachments.length) return null;
  return (
    <>
      <div className={`att-grid att-grid--${Math.min(attachments.length, 4)}`}>
        {attachments.map((a, i) => (
          <button key={a.id} type="button" className="att-grid__item" onClick={() => setOpen(i)} title="看大圖" aria-label={`看參考圖片 ${i + 1}（共 ${attachments.length} 張）`}>
            <img src={attachmentSrc(a.thumbUrl || a.url)} alt={`參考圖片 ${i + 1}`} loading="lazy" decoding="async" />
            {a.type === 'image/gif' && <span className="att-grid__badge">GIF</span>}
          </button>
        ))}
      </div>
      {open !== null && <ImageLightbox items={attachments} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

/** 大圖：左右鍵 / 按鈕換張、Esc 或點外面關、「在新分頁開啟」 */
export function ImageLightbox({ items, index, onIndex, onClose }: {
  items: CommentAttachment[]; index: number; onIndex: (i: number) => void; onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const cb = useRef({ onIndex, onClose, index, n: items.length });
  cb.current = { onIndex, onClose, index, n: items.length };
  const a = items[Math.max(0, Math.min(index, items.length - 1))];
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setLoaded(false); }, [a?.id]);

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // 捕捉階段先處理：頁面的快捷鍵（播放、逐格、轉攝影機）在大圖開著時都不動
    const onKey = (e: KeyboardEvent) => {
      const c = cb.current;
      if (e.key === 'Escape') { e.preventDefault(); c.onClose(); }
      else if (e.key === 'ArrowLeft' && c.n > 1) { e.preventDefault(); c.onIndex((c.index - 1 + c.n) % c.n); }
      else if (e.key === 'ArrowRight' && c.n > 1) { e.preventDefault(); c.onIndex((c.index + 1) % c.n); }
      // 其他鍵（Tab、Enter、空白鍵按按鈕）照瀏覽器原本的做，只是不讓頁面收到
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      html.style.overflow = prev;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  if (!a) return null;
  const many = items.length > 1;
  const src = attachmentSrc(a.url);
  return createPortal(
    <div className="att-lightbox" role="dialog" aria-modal="true" aria-label={`參考圖片 ${index + 1} / ${items.length}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="att-lightbox__bar">
        <span className="att-lightbox__count">{many ? `${index + 1} / ${items.length}` : '參考圖片'}{a.width && a.height ? ` · ${a.width}×${a.height}` : ''}</span>
        <a className="att-lightbox__btn" href={src} target="_blank" rel="noopener noreferrer"><Icon icon={ExternalLink} size="sm" /> 在新分頁開啟</a>
        <button ref={closeRef} type="button" className="att-lightbox__btn att-lightbox__btn--icon" onClick={onClose} title="關閉（Esc）" aria-label="關閉"><Icon icon={X} size="md" /></button>
      </div>
      <div className="att-lightbox__stage" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {!loaded && <Icon icon={LoaderCircle} size="xl" spin className="att-lightbox__spin" />}
        <img key={a.id} src={src} alt={`參考圖片 ${index + 1}`} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} className={loaded ? 'is-loaded' : ''} />
      </div>
      {many && (
        <>
          <button type="button" className="att-lightbox__nav att-lightbox__nav--prev" onClick={() => onIndex((index - 1 + items.length) % items.length)} title="上一張（左鍵）" aria-label="上一張"><Icon icon={ChevronLeft} size="lg" /></button>
          <button type="button" className="att-lightbox__nav att-lightbox__nav--next" onClick={() => onIndex((index + 1) % items.length)} title="下一張（右鍵）" aria-label="下一張"><Icon icon={ChevronRight} size="lg" /></button>
        </>
      )}
    </div>,
    document.body,
  );
}
