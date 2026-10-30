// 「帶著做」的亮框＋說明框（動畫師工作站第一次進來；步驟內容在 lib/tutorial/animatorTour.ts）。
//   整層 pointer-events:none：不擋滑鼠，他可以直接按亮起來的按鈕、拖舞台、把檔案拖進頁面；只有說明框接收點擊。
//   要亮的東西靠工作站裡的 data-tour="..." 標記找；每一格畫面量一次位置（目標會因捲動、拖小播放器、版面變動而移動）。
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ExternalLink } from 'lucide-react';
import Icon from './Icon';
import { placeBubble, type Placement, type Rect } from '../lib/tutorial/tourPlacement';
import type { TourStep, TourTarget } from '../lib/tutorial/animatorTour';
import './TourOverlay.css';

export interface TourOverlayProps {
  steps: TourStep[];
  index: number;
  onIndex: (n: number) => void;
  /** 'skip' = 按跳過或 Esc；'done' = 最後一步按完成 */
  onClose: (reason: 'skip' | 'done') => void;
  /** 這一步要他做的事已經做到了（local-file 換成 done 的字） */
  stepDone: boolean;
  /** 最後一步多一個「打開上手教學」連結 */
  tutorialHref: string;
}

/** 這個按鍵是不是「跳過」：Esc；別人已經處理掉的（例如關選單）不算 */
export function isTourEscape(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>): boolean {
  return e.key === 'Escape' && !e.defaultPrevented;
}

/**
 * 說明框裡的按鍵：Esc = 跳過；所有按鍵都不往上傳（工作站的空白鍵 / J K L 播放快捷鍵吃不到）。
 * 注意：這裡一定要自己處理 Esc —— 焦點在說明框裡時，按鍵往上傳之前就被擋掉了，外面的 Esc 監聽收不到。
 */
export function handleBubbleKey(
  e: Pick<KeyboardEvent, 'key' | 'defaultPrevented'> & { stopPropagation(): void },
  onClose: (reason: 'skip' | 'done') => void,
): void {
  if (isTourEscape(e)) onClose('skip');
  e.stopPropagation();
}

/** 亮框比目標外面多出來的邊 */
const SPOT_PAD = 6;

/** 看得到才算：有版面、寬高 > 0、不是 visibility:hidden、至少有一部分在畫面內 */
function isShown(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/** 同一個標記有好幾個（寬畫面按鈕＋窄畫面選單）→ 取第一個看得到的 */
function findTarget(target: TourTarget | null): HTMLElement | null {
  if (!target) return null;
  const list = document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`);
  for (const el of Array.from(list)) if (isShown(el)) return el;
  return null;
}

interface Measure { target: Rect | null; bubble: { w: number; h: number }; vp: { w: number; h: number } }

function sameMeasure(a: Measure, b: Measure): boolean {
  const ra = a.target, rb = b.target;
  const sameRect = ra === rb || (!!ra && !!rb && ra.x === rb.x && ra.y === rb.y && ra.w === rb.w && ra.h === rb.h);
  return sameRect && a.bubble.w === b.bubble.w && a.bubble.h === b.bubble.h && a.vp.w === b.vp.w && a.vp.h === b.vp.h;
}

export default function TourOverlay({ steps, index, onIndex, onClose, stepDone, tutorialHref }: TourOverlayProps) {
  const step = steps[index];
  const titleId = useId();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [m, setM] = useState<Measure>(() => ({
    target: null, bubble: { w: 340, h: 180 },
    vp: { w: typeof window === 'undefined' ? 1280 : window.innerWidth, h: typeof window === 'undefined' ? 800 : window.innerHeight },
  }));

  // 每一格畫面量一次：目標位置、說明框大小、視窗大小；沒變就不重畫
  const targetName = step?.target ?? null;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = findTarget(targetName);
      const r = el ? el.getBoundingClientRect() : null;
      const b = bubbleRef.current;
      const next: Measure = {
        target: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
        bubble: { w: b?.offsetWidth ?? 340, h: b?.offsetHeight ?? 180 },
        vp: { w: window.innerWidth, h: window.innerHeight },
      };
      setM(prev => (sameMeasure(prev, next) ? prev : next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetName]);

  // 換步 → 焦點放到「下一步」
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [index]);

  // Esc = 跳過（別人已經處理掉的 Esc，例如關選單，不算）
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTourEscape(e)) closeRef.current('skip');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const placement: Placement = useMemo(
    () => placeBubble(m.target, m.bubble, m.vp),
    [m.target, m.bubble, m.vp],
  );

  if (!step) return null;
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;
  const showDone = stepDone && !!step.done;
  const title = showDone ? step.done!.title : step.title;
  const baseBody = showDone ? step.done!.body : step.body;
  const missing = step.target !== null && m.target === null;
  const body = missing && step.missingHint ? `${baseBody} ${step.missingHint}` : baseBody;

  // 亮框：目標外面多一圈（夾在畫面內）；沒有目標 = 整個畫面都變暗
  let spot: CSSProperties | null = null;
  if (m.target) {
    const left = Math.max(0, m.target.x - SPOT_PAD);
    const top = Math.max(0, m.target.y - SPOT_PAD);
    const right = Math.min(m.vp.w, m.target.x + m.target.w + SPOT_PAD);
    const bottom = Math.min(m.vp.h, m.target.y + m.target.h + SPOT_PAD);
    spot = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  const bubbleStyle: CSSProperties = {};
  let bubbleClass = 'tour__bubble';
  if (placement.mode === 'anchored') {
    bubbleStyle.left = placement.x;
    bubbleStyle.top = placement.y;
  } else if (placement.mode === 'sheet') {
    // 手機：貼在畫面底部；要亮的東西在下半部就改貼在上面，不要蓋住它
    const lower = !!m.target && m.target.y + m.target.h / 2 > m.vp.h * 0.55;
    bubbleClass += lower ? ' tour__bubble--sheet-top' : ' tour__bubble--sheet';
  } else {
    bubbleClass += ' tour__bubble--center';
  }

  return (
    <div className="tour">
      {spot ? <div className="tour__spot" style={spot} /> : <div className="tour__dim" />}
      <div
        ref={bubbleRef}
        className={bubbleClass}
        style={bubbleStyle}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        onKeyDown={(e) => handleBubbleKey(e, onClose)}
      >
        <div className="tour__count" aria-label={`第 ${index + 1} 步，共 ${steps.length} 步`}>{index + 1} / {steps.length}</div>
        <h2 id={titleId} className="tour__title">{title}</h2>
        <p className="tour__body" aria-live="polite">{body}</p>
        {isLast && (
          <a className="tour__link" href={tutorialHref} target="_blank" rel="noopener">
            <Icon icon={ExternalLink} /> 打開上手教學
          </a>
        )}
        <div className="tour__actions">
          <button type="button" className="tour__skip" onClick={() => onClose('skip')}>跳過</button>
          <span className="tour__grow" />
          {!isFirst && (
            <button type="button" className="tour__btn" onClick={() => onIndex(index - 1)}>上一步</button>
          )}
          <button
            ref={nextRef}
            type="button"
            className="tour__btn tour__btn--primary"
            onClick={() => (isLast ? onClose('done') : onIndex(index + 1))}
          >{isLast ? '完成' : '下一步'}</button>
        </div>
      </div>
    </div>
  );
}
