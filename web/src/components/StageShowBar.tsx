// 全螢幕預演的小條（給客戶看簡報時，畫面上唯一留著的操作）：滑鼠一動或手指一點出現 2.5 秒，之後自己收起來。
//   上一首 / 下一首歌 + 歌名、播放 / 暫停 + 時間、上一個 / 下一個 cue + 現在的 cue、視角（只能切換）、離開（Esc）。
// 半透明、貼著畫面下緣，不擋住舞台。「視角」選單開著、滑鼠停在小條上時不收。
// 怎麼進出、什麼時候出現：lib/useStageFullscreen.ts；規則和資料長什麼樣子：lib/stageShow.ts。

import { useEffect, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Minimize, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import Icon from './Icon';
import { hasShowViews, showClockText, showTransportUsable, type StageShowInfo, type StageShowViewGroup } from '../lib/stageShow';
import './StageShow.css';

interface Props {
  visible: boolean;
  info?: StageShowInfo;
  /** info 沒有歌名時的備用（現在的 cue 名字 / 專案名） */
  fallbackTitle?: string;
  /** 視角選單的內容（常用看台視角、專案的視角）；沒有 = 不放「視角」按鈕 */
  views?: StageShowViewGroup[];
  /** 選單開著 / 滑鼠停在小條上 = true（小條先不要收） */
  onHold?: (on: boolean) => void;
  onExit: () => void;
}

export default function StageShowBar({ visible, info, fallbackTitle, views, onHold, onExit }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [inside, setInside] = useState(false);
  const transport = info?.transport;
  const usable = showTransportUsable(transport) ? transport : null;
  const songNav = info?.songNav;
  const cueNav = info?.cueNav;
  const title = info?.title || fallbackTitle || '';
  const hasViews = hasShowViews(views);
  const tab = visible ? 0 : -1;

  // 小條收起來了 / 這一頁沒有視角 → 選單也收起來
  useEffect(() => {
    if (!visible || !hasViews) setMenuOpen(false);
  }, [visible, hasViews]);

  // 選單開著或滑鼠停在小條上：小條不收；放開後再留一下（useStageFullscreen.holdBar）
  const hold = menuOpen || inside;
  useEffect(() => { onHold?.(hold); }, [hold, onHold]);
  useEffect(() => () => onHold?.(false), [onHold]);

  // 點到小條外面（轉視角、點畫面）→ 選單收起來
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menuOpen]);

  return (
    <div
      ref={barRef}
      className={'stage-show-bar' + (visible ? ' is-visible' : '')}
      role="toolbar"
      aria-label="全螢幕預演"
      aria-hidden={!visible}
      onPointerEnter={() => setInside(true)}
      onPointerLeave={() => setInside(false)}
      // 按小條上的按鈕不要把鍵盤焦點留在按鈕上（不然接著按空白鍵會變成再按一次那顆）
      onMouseDown={(e) => e.preventDefault()}
    >
      {songNav && (
        <div className="stage-show-bar__group" role="group" aria-label="換歌">
          <button
            type="button"
            className="stage-show-bar__btn"
            disabled={!songNav.prev}
            onClick={songNav.prev?.onSelect}
            title={songNav.prev ? `上一首：${songNav.prev.label}` : '已經是第一首'}
            aria-label="上一首"
            tabIndex={tab}
          ><Icon icon={SkipBack} size="md" /></button>
          {title && <span className="stage-show-bar__title" title={title}>{title}</span>}
          <button
            type="button"
            className="stage-show-bar__btn"
            disabled={!songNav.next}
            onClick={songNav.next?.onSelect}
            title={songNav.next ? `下一首：${songNav.next.label}` : '已經是最後一首'}
            aria-label="下一首"
            tabIndex={tab}
          ><Icon icon={SkipForward} size="md" /></button>
        </div>
      )}
      {!songNav && title && <span className="stage-show-bar__title" title={title}>{title}</span>}

      {usable && (
        <div className="stage-show-bar__group" role="group" aria-label="播放">
          <button
            type="button"
            className="stage-show-bar__btn"
            onClick={usable.onTogglePlay}
            title={usable.playing ? '暫停（空白鍵）' : '播放（空白鍵）'}
            aria-label={usable.playing ? '暫停' : '播放'}
            tabIndex={tab}
          >
            <Icon icon={usable.playing ? Pause : Play} size="md" />
          </button>
          <span className="stage-show-bar__time">{showClockText(usable.time, usable.duration)}</span>
        </div>
      )}

      {cueNav && (
        <div className="stage-show-bar__group" role="group" aria-label="換 cue">
          <button
            type="button"
            className="stage-show-bar__btn"
            disabled={!cueNav.onPrev}
            onClick={cueNav.onPrev ?? undefined}
            title={cueNav.onPrev ? '上一個 cue（Shift+K）' : '已經是第一個 cue'}
            aria-label="上一個 cue"
            tabIndex={tab}
          ><Icon icon={ChevronLeft} size="md" /></button>
          <span className="stage-show-bar__cue" title={`第 ${cueNav.number || '－'} / ${cueNav.total} 個 cue`}>
            {cueNav.number > 0 && <span className="stage-show-bar__cue-num">{cueNav.number}</span>}
            <span className="stage-show-bar__cue-name">{cueNav.name || '還沒選 cue'}</span>
          </span>
          <button
            type="button"
            className="stage-show-bar__btn"
            disabled={!cueNav.onNext}
            onClick={cueNav.onNext ?? undefined}
            title={cueNav.onNext ? '下一個 cue（Shift+J）' : '已經是最後一個 cue'}
            aria-label="下一個 cue"
            tabIndex={tab}
          ><Icon icon={ChevronRight} size="md" /></button>
        </div>
      )}

      {hasViews && (
        <button
          type="button"
          className={'stage-show-bar__btn stage-show-bar__btn--wide' + (menuOpen ? ' is-active' : '')}
          onClick={() => setMenuOpen(o => !o)}
          title="視角：切到常用看台視角或專案存的視角"
          aria-label="視角"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tabIndex={tab}
        >
          <Icon icon={Camera} size="md" />
          <span className="stage-show-bar__label">視角</span>
        </button>
      )}

      <button
        type="button"
        className="stage-show-bar__btn stage-show-bar__btn--wide stage-show-bar__exit"
        onClick={onExit}
        title="離開全螢幕預演（Esc）"
        aria-label="離開全螢幕預演"
        tabIndex={tab}
      >
        <Icon icon={Minimize} size="md" />
        <span className="stage-show-bar__label">離開（Esc）</span>
      </button>

      {menuOpen && hasViews && views && (
        <div className="stage-show-bar__menu" role="menu" aria-label="視角">
          {views.filter(g => g.items.length > 0).map(g => (
            <div key={g.title} className="stage-show-bar__menu-group" role="group" aria-label={g.title}>
              <div className="stage-show-bar__menu-title">{g.title}</div>
              <div className="stage-show-bar__menu-items">
                {g.items.map(it => (
                  <button
                    key={it.id}
                    type="button"
                    role="menuitem"
                    className="stage-show-bar__menu-item"
                    title={it.hint}
                    onClick={() => { it.onSelect(); setMenuOpen(false); }}
                  >{it.label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
