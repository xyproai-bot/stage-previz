import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight, Brackets, ChevronDown, ChevronUp, GripHorizontal, MessageSquarePlus, Pause, Pencil, Play, RefreshCw, Repeat,
  StepBack, StepForward, Volume2, VolumeX, X,
} from 'lucide-react';
import Icon from './Icon';
import { formatClock, parkVideo, type LocalVideoState } from '../lib/localVideo';
import type { SongComment } from '../lib/api';
import type { CompareOption } from '../lib/abCompare';
import { LED_SWAP_PHONE_NOTE, ledBadgeText } from '../lib/abLedSync';
import { isTouchDevice, type ReviewSession } from '../lib/review/useReviewSession';
import { PLAYBACK_RATES, formatRange, formatTimecode, rateLabel } from '../lib/review/timecode';
import './MiniPlayer.css';

/** 「比較」（A/B）：選第二個版本，一個按鈕（或按 C）在兩版之間切，停在同一秒（lib/abCompare.ts） */
export interface MiniPlayerCompare {
  /** 可以拿來比的版本（不含正在看的） */
  options: CompareOption[];
  /** 比較中「另一版」的 key（沒在比 = null） */
  value: string | null;
  onPick: (key: string | null) => void;
  /** 切到另一版（同一秒、播放 / 暫停照舊）；還沒選比較的版本 → 跟上一版比 */
  onFlip: () => void;
  /** 比較中，LED 上現在放的是哪一版（徽章「LED：V2」）；沒在比 = null（lib/abLedSync.ts） */
  ledLabel?: string | null;
  /** 'instant' = 另一版先載在後面、跟著播，按 C 馬上換、LED 不會黑；'reload' = 手機：不同時放兩支影片，換的時候重新載入 */
  ledSwap?: 'instant' | 'reload';
}

/** 審片（lib/review/useReviewSession.ts）：逐格、速度、時間碼、區段、留言跟著播放、畫記 */
export interface MiniPlayerReview {
  session: ReviewSession;
  /** 離播放頭最近的留言（時間軸上亮起來） */
  activeId?: string | null;
  /** 點時間軸上的留言 / 區段 */
  onOpenComment?: (c: SongComment) => void;
  /** 「畫記」按鈕（沒給 = 沒有這個按鈕） */
  onDraw?: () => void;
  /** false = 沒有區段（標區段的按鈕、拖時間軸上面那一條）；分享連結沒開留言時 */
  ranges?: boolean;
}

interface Props {
  player: LocalVideoState;
  /** 標題（例：V3） */
  label: string;
  /** 標題旁邊的小字（例：小明 · 3 分鐘前） */
  detail?: string;
  /** 記住位置 / 收起來（每個頁面一個） */
  storageKey: string;
  /** 手機、iPad（觸控）上沒自己展開過就先收起來（審片頁、分享頁：展開的小視窗會蓋掉大半個 3D 畫面） */
  collapseOnTouch?: boolean;
  /** 掛在影片時間上的留言 → 時間軸上的小點（區段 → 一條） */
  comments?: SongComment[];
  onCommentPinClick?: (c: SongComment) => void;
  /** 有給才顯示「在 0:12 加留言」 */
  onAddCommentAtTime?: (t: number) => void;
  /** 影片讀不到時的「重新載入」 */
  onRetry?: () => void;
  /** 標題列右邊多放的東西 */
  extra?: ReactNode;
  /** 有給（而且有兩版以上）才顯示「比較」 */
  compare?: MiniPlayerCompare;
  /** 審片的播放控制（逐格、速度、時間碼、區段…） */
  review?: MiniPlayerReview;
}

interface Placement { right: number; bottom: number; collapsed: boolean | null }

const MARGIN = 8;

function readPlacement(key: string): Placement {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v.right === 'number' && typeof v.bottom === 'number') {
        return { right: v.right, bottom: v.bottom, collapsed: typeof v.collapsed === 'boolean' ? v.collapsed : null };
      }
    }
  } catch { /* 沒記過 / 壞掉 */ }
  return { right: 12, bottom: 12, collapsed: null };
}

function savePlacement(key: string, p: Placement) {
  try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* 只是下次不會記得 */ }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const hasRange = (c: SongComment) => c.timeEnd != null && c.timeEnd > c.time;

/**
 * 浮在 3D 畫面上的小播放器（像子母畫面）：看得到影片本身、播放 / 暫停、拉時間軸、時間。
 * 同一個 <video> 也是 LED 的貼圖，所以這裡暫停 LED 也停。
 * 可以拖標題列移位置、按 ︿ 收成一條；放在 3D 畫面裡面（不會蓋到下面的 cue 列）。
 * 有 review → 多了逐格、速度、時間碼、區段（拖時間軸上面那一條，或按 I / O）、畫記。
 */
export default function MiniPlayer({
  player, label, detail, storageKey, collapseOnTouch = false, comments, onCommentPinClick, onAddCommentAtTime, onRetry, extra, compare, review,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement>(() => readPlacement(storageKey));
  // 沒記過要不要收起來：3D 畫面太矮（iPad 橫放、留言在下面）就先收起來
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  // 打開有畫記的留言、停著看畫記的時候先收起來（不然會蓋到畫記）；按播放就展開回來（不記住）
  const showingAnnotation = !!review?.session.showing && !player.playing;
  const collapsed = showingAnnotation || (place.collapsed ?? autoCollapsed);
  // 畫記的時候整個藏起來：畫的地方大一點（手機），也不會畫到一半去拉時間軸（畫記是畫在按「畫記」那一格）
  const hiddenForDrawing = !!review?.session.draft.active;
  const placeRef = useRef(place);
  placeRef.current = place;

  // 影片畫面放進小視窗；收起來 / 關掉時搬回看不到的角落（拿掉的話瀏覽器會自己暫停）
  const { video } = player;
  useLayoutEffect(() => {
    const host = screenRef.current;
    if (collapsed || !host) { parkVideo(video); return; }
    host.appendChild(video);
    video.classList.add('mini-player__video');
    return () => {
      video.classList.remove('mini-player__video');
      parkVideo(video);
    };
  }, [video, collapsed]);

  // 父層（3D 畫面）變大變小 → 小視窗留在裡面；第一次量到高度時決定要不要先收起來
  const keepInside = useCallback(() => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const maxRight = Math.max(MARGIN, parent.clientWidth - el.offsetWidth - MARGIN);
    const maxBottom = Math.max(MARGIN, parent.clientHeight - el.offsetHeight - MARGIN);
    const p = placeRef.current;
    const right = clamp(p.right, MARGIN, maxRight);
    const bottom = clamp(p.bottom, MARGIN, maxBottom);
    if (right !== p.right || bottom !== p.bottom) setPlace({ ...p, right, bottom });
  }, []);
  useEffect(() => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!parent) return;
    // 審片頁、分享頁在手機、iPad（觸控）上先收起來：展開的小視窗有 400 多 px 寬、300 多 px 高，會蓋掉大半個 3D 畫面；要看影片再按展開
    const measure = () => setAutoCollapsed(parent.clientHeight < 400 || parent.clientWidth < 520 || (collapseOnTouch && isTouchDevice()));
    measure();
    // 沒自己按過展開 / 收起 → 畫面變矮（iPad 橫放、留言移到下面）就自動收起來，變大再打開
    const ro = new ResizeObserver(() => { measure(); keepInside(); });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [keepInside, collapseOnTouch]);
  useLayoutEffect(() => { keepInside(); }, [collapsed, keepInside]);

  // 拖標題列移位置
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number; id: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, a')) return;
    const p = placeRef.current;
    dragRef.current = { x: e.clientX, y: e.clientY, right: p.right, bottom: p.bottom, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!d || !el || !parent || d.id !== e.pointerId) return;
    const right = clamp(d.right - (e.clientX - d.x), MARGIN, Math.max(MARGIN, parent.clientWidth - el.offsetWidth - MARGIN));
    const bottom = clamp(d.bottom - (e.clientY - d.y), MARGIN, Math.max(MARGIN, parent.clientHeight - el.offsetHeight - MARGIN));
    setPlace(p => ({ ...p, right, bottom }));
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current.id !== e.pointerId) return;
    dragRef.current = null;
    savePlacement(storageKey, placeRef.current);
  };

  const toggleCollapsed = () => {
    if (showingAnnotation) { review?.session.clearSelection(); return; }
    const next = { ...placeRef.current, collapsed: !collapsed };
    setPlace(next);
    savePlacement(storageKey, next);
  };

  const { playing, time, duration, loop, muted, ready, error } = player;
  const session = review?.session;
  const rangesOn = !!review && review.ranges !== false;
  const canCompare = !!compare && compare.options.length > 0;
  const compareLabel = compare?.value ? compare.options.find(o => o.key === compare.value)?.label ?? null : null;
  const flipBtn = canCompare && compareLabel && (
    <button
      type="button"
      className="mini-player__btn mini-player__btn--flip"
      onClick={compare!.onFlip}
      title={`切到 ${compareLabel}（同一個時間點；快捷鍵 C）`}
      aria-label={`切到 ${compareLabel}`}
    >
      <Icon icon={ArrowLeftRight} size="sm" /> {compareLabel}
    </button>
  );
  // 收起來時（iPad / 手機）：還沒選比較的版本 → 按一下就跟上一版比（跟按 C 一樣）
  const collapsedCompareBtn = canCompare && (flipBtn || (
    <button
      type="button"
      className="mini-player__btn mini-player__btn--flip"
      onClick={compare!.onFlip}
      title="跟上一版比較（同一個時間點；快捷鍵 C）"
      aria-label="比較版本"
    >
      <Icon icon={ArrowLeftRight} size="sm" /> 比較
    </button>
  ));
  const inDuration = (t: number) => duration > 0 && t <= duration + 1;
  const all = comments || [];
  const pins = all.filter(c => typeof c.time === 'number' && c.time > 0 && inDuration(c.time) && !(rangesOn && hasRange(c)));
  const bars = rangesOn ? all.filter(c => hasRange(c) && inDuration(c.time)) : [];
  const pct = (t: number) => `${clamp(duration > 0 ? (t / duration) * 100 : 0, 0, 100)}%`;
  const openPin = (c: SongComment) => {
    if (review?.onOpenComment) review.onOpenComment(c);
    else if (onCommentPinClick) onCommentPinClick(c);
    else player.seek(c.time);
  };

  // 時間軸上面那一條：拖 = 標區段（手指也可以）；點一下 = 跳到那裡
  const laneRef = useRef<HTMLDivElement>(null);
  const laneDragRef = useRef<{ id: number; t0: number; x0: number; moved: boolean } | null>(null);
  const laneTime = (clientX: number) => {
    const r = laneRef.current?.getBoundingClientRect();
    if (!r || !(r.width > 0) || !(duration > 0)) return 0;
    return clamp(((clientX - r.left) / r.width) * duration, 0, duration);
  };
  const onLaneDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!session || !ready || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    laneDragRef.current = { id: e.pointerId, t0: laneTime(e.clientX), x0: e.clientX, moved: false };
  };
  const onLaneMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = laneDragRef.current;
    if (!d || d.id !== e.pointerId || !session) return;
    const t = laneTime(e.clientX);
    // 點 vs 拖：用手指移動了幾 px 判斷（長的歌用秒數判斷，輕點就會變成標了一小段）
    if (!d.moved && Math.abs(e.clientX - d.x0) < (e.pointerType === 'touch' ? 10 : 5)) return;
    d.moved = true;
    session.setMarks(d.t0, t);
  };
  const onLaneUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = laneDragRef.current;
    if (!d || d.id !== e.pointerId || !session) return;
    laneDragRef.current = null;
    if (!d.moved) { player.seek(d.t0); return; }
    session.setMarks(d.t0, laneTime(e.clientX));
  };

  const marks = session?.marks;
  const pendingRange = session?.range ?? null;
  const loopRange = session?.loop ?? null;
  const timeText = session?.timecode
    ? `${formatTimecode(time, session.fps)}`
    : `${formatClock(time)} / ${formatClock(duration)}`;

  const scrub = (
    <div className="mini-player__scrub">
      {rangesOn && (
        <div
          ref={laneRef}
          className={'mini-player__lane' + (pendingRange ? ' has-range' : '')}
          onPointerDown={onLaneDown}
          onPointerMove={onLaneMove}
          onPointerUp={onLaneUp}
          onPointerCancel={() => { laneDragRef.current = null; }}
          title="拖這一條可以標區段（也可以按 I / O）"
        >
          {loopRange && duration > 0 && (
            <span className="mini-player__loop" style={{ left: pct(loopRange.start), width: `calc(${pct(loopRange.end)} - ${pct(loopRange.start)})` }} aria-hidden="true" />
          )}
          {bars.map(c => (
            <button
              key={c.id}
              type="button"
              className={'mini-player__bar mini-player__bar--' + c.role
                + (review.activeId === c.id ? ' is-active' : '') + (session?.selectedId === c.id ? ' is-selected' : '')}
              style={{ left: pct(c.time), width: `max(4px, calc(${pct(c.timeEnd as number)} - ${pct(c.time)}))` }}
              onClick={() => openPin(c)}
              title={`${formatRange(c.time, c.timeEnd)} ${c.author}：${c.text.slice(0, 60)}`}
              aria-label={`${formatRange(c.time, c.timeEnd)} 的區段留言`}
            />
          ))}
          {pendingRange && duration > 0 && (
            <span className="mini-player__pending" style={{ left: pct(pendingRange.start), width: `calc(${pct(pendingRange.end)} - ${pct(pendingRange.start)})` }} aria-hidden="true" />
          )}
          {marks && marks.in != null && !pendingRange && duration > 0 && (
            <span className="mini-player__mark" style={{ left: pct(marks.in) }} aria-hidden="true" />
          )}
        </div>
      )}
      <div className="mini-player__track">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(time, duration || 0)}
          onChange={(e) => player.seek(parseFloat(e.target.value))}
          disabled={!ready}
          aria-label="影片時間"
        />
        {pins.map(c => (
          <button
            key={c.id}
            type="button"
            className={'mini-player__pin mini-player__pin--' + c.role
              + (review?.activeId === c.id ? ' is-active' : '') + (session?.selectedId === c.id ? ' is-selected' : '')}
            style={{ left: `calc(7px + (100% - 14px) * ${clamp(c.time / duration, 0, 1)})` }}
            onClick={() => openPin(c)}
            title={`${formatClock(c.time)} ${c.author}：${c.text.slice(0, 60)}`}
            aria-label={`${formatClock(c.time)} 的留言`}
          />
        ))}
      </div>
    </div>
  );

  const playBtn = (
    <button
      type="button"
      className="mini-player__btn mini-player__btn--play"
      onClick={player.togglePlay}
      disabled={!ready}
      title={playing ? '暫停（空白鍵）' : '播放（空白鍵）'}
      aria-label={playing ? '暫停' : '播放'}
    >
      <Icon icon={playing ? Pause : Play} size="md" />
    </button>
  );

  // 正在循環（打開了區段留言）：手機、iPad 沒有 Esc → 一顆「循環 0:05–0:09 ×」可以停
  const loopChip = session && loopRange && (
    <span className="mini-player__range-chip mini-player__range-chip--loop" title="正在循環這一段（打開的區段留言）">
      <Icon icon={Repeat} size="xs" /> 循環 {formatRange(loopRange.start, loopRange.end)}
      <button type="button" className="mini-player__chip-x" onClick={session.clearSelection} title="不再循環" aria-label="不再循環"><Icon icon={X} size="xs" /></button>
    </span>
  );

  // 區段按鈕：沒有 → 「標開始」；有開始 → 「標結束」；標好了 → 「區段 0:12–0:18 ×」
  const rangeBtn = session && rangesOn && (
    pendingRange ? (
      <span className="mini-player__range-chip">
        <Icon icon={Brackets} size="xs" /> {formatRange(pendingRange.start, pendingRange.end)}
        <button type="button" className="mini-player__chip-x" onClick={session.clearMarks} title="不要區段" aria-label="不要區段"><Icon icon={X} size="xs" /></button>
      </span>
    ) : (
      <button
        type="button"
        className={'mini-player__action' + (marks?.in != null ? ' is-active' : '')}
        onClick={() => (marks?.in != null ? session.markOut() : session.markIn())}
        disabled={!ready}
        title={marks?.in != null ? `區段的結束（快捷鍵 O），從 ${formatClock(marks.in)} 開始` : '區段的開始（快捷鍵 I）'}
      >
        <Icon icon={Brackets} size="sm" /> {marks?.in != null ? `標結束（${formatClock(marks.in)} 起）` : '標區段'}
      </button>
    )
  );

  return (
    <div
      ref={rootRef}
      className={'mini-player' + (collapsed ? ' is-collapsed' : '') + (review ? ' has-review' : '') + (hiddenForDrawing ? ' is-hidden-for-drawing' : '')}
      aria-hidden={hiddenForDrawing || undefined}
      style={{ right: place.right, bottom: place.bottom }}
      role="region"
      aria-label={`影片 ${label}`}
    >
      <div
        className="mini-player__head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        title="拖這裡可以移動"
      >
        <Icon icon={GripHorizontal} size="sm" className="mini-player__grip" />
        {collapsed && playBtn}
        <span className="mini-player__label">{label}</span>
        {!collapsed && detail && <span className="mini-player__detail">{detail}</span>}
        {collapsed && <span className="mini-player__time">{formatClock(time)} / {formatClock(duration)}</span>}
        <span className="mini-player__grow" />
        {collapsed && loopChip}
        {collapsed && !loopChip && collapsedCompareBtn}
        {!collapsed && extra}
        <button
          type="button"
          className="mini-player__btn"
          onClick={toggleCollapsed}
          title={collapsed ? '展開小視窗' : '收起來'}
          aria-label={collapsed ? '展開小視窗' : '收起來'}
          aria-expanded={!collapsed}
        >
          <Icon icon={collapsed ? ChevronUp : ChevronDown} size="sm" />
        </button>
      </div>

      {collapsed ? scrub : (
        <>
          <div className="mini-player__screen" ref={screenRef} onClick={player.togglePlay}>
            {!ready && !error && <div className="mini-player__msg">載入中…</div>}
          </div>
          <div className="mini-player__controls">
            {playBtn}
            {session && (
              <>
                <button type="button" className="mini-player__btn mini-player__btn--step" onClick={() => session.frameStep(-1)} disabled={!ready} title="往前一格（,）" aria-label="往前一格">
                  <Icon icon={StepBack} size="sm" />
                </button>
                <button type="button" className="mini-player__btn mini-player__btn--step" onClick={() => session.frameStep(1)} disabled={!ready} title="往後一格（.）" aria-label="往後一格">
                  <Icon icon={StepForward} size="sm" />
                </button>
              </>
            )}
            {session ? (
              <button
                type="button"
                className={'mini-player__time mini-player__time--btn' + (session.timecode ? ' is-timecode' : '')}
                onClick={session.toggleTimecode}
                title={session.timecode
                  ? `時間碼（${session.fps ? `${session.fps} 格 / 秒` : '還不知道幾格，先用 30 格 / 秒算'}）；按一下換回分:秒`
                  : '按一下顯示時間碼（時:分:秒:格）'}
              >{timeText}</button>
            ) : (
              <span className="mini-player__time">{formatClock(time)} / {formatClock(duration)}</span>
            )}
            <span className="mini-player__grow" />
            {session && (
              <select
                className="mini-player__rate"
                value={String(session.speed)}
                onChange={(e) => { session.setSpeed(parseFloat(e.target.value)); e.currentTarget.blur(); }}
                title="播放速度"
                aria-label="播放速度"
              >
                {PLAYBACK_RATES.map(r => <option key={r} value={String(r)}>{rateLabel(r)}</option>)}
                {!PLAYBACK_RATES.includes(session.speed as 0.5 | 1 | 2) && <option value={String(session.speed)}>{rateLabel(session.speed)}</option>}
              </select>
            )}
            <button
              type="button"
              className={'mini-player__btn' + (loop ? ' is-active' : '')}
              onClick={() => player.setLoop(!loop)}
              title={loop ? '循環播放：開' : '循環播放：關'}
              aria-label={loop ? '循環播放：開' : '循環播放：關'}
              aria-pressed={loop}
            >
              <Icon icon={Repeat} size="sm" />
            </button>
            <button
              type="button"
              className="mini-player__btn"
              onClick={() => player.setMuted(!muted)}
              title={muted ? '開聲音' : '靜音'}
              aria-label={muted ? '開聲音' : '靜音'}
            >
              <Icon icon={muted ? VolumeX : Volume2} size="sm" />
            </button>
          </div>
          {scrub}
          {canCompare && (
            <div className="mini-player__compare">
              <label className="mini-player__compare-pick">
                <span>比較</span>
                <select
                  value={compare!.value ?? ''}
                  onChange={(e) => { compare!.onPick(e.target.value || null); e.currentTarget.blur(); }}
                  aria-label="選另一個版本來比較"
                  title="選另一個版本，按右邊的按鈕（或 C）在兩版之間切換，停在同一個時間點"
                >
                  <option value="">不比較</option>
                  {compare!.options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
              {flipBtn || <span className="mini-player__compare-hint">選一版，按 C 切換</span>}
              {ledBadgeText(!!compare!.value, compare!.ledLabel) && (
                <span className="mini-player__led-chip" title="3D 舞台的 LED 現在放的是這一版">{ledBadgeText(true, compare!.ledLabel)}</span>
              )}
              {compare!.value && compare!.ledSwap === 'reload' && <span className="mini-player__compare-hint">{LED_SWAP_PHONE_NOTE}</span>}
            </div>
          )}
          {(onAddCommentAtTime || review?.onDraw || rangesOn || loopChip) && (
            <div className="mini-player__actions">
              {onAddCommentAtTime && (
                <button type="button" className="mini-player__action mini-player__action--main" onClick={() => onAddCommentAtTime(player.video.currentTime)} disabled={!ready}>
                  <Icon icon={MessageSquarePlus} size="sm" /> 在 {formatClock(time)} 加留言
                </button>
              )}
              {review?.onDraw && (
                <button type="button" className={'mini-player__action' + (session?.draft.active ? ' is-active' : '')} onClick={review.onDraw} disabled={!ready} title="暫停在這一格，在 3D 畫面上畫">
                  <Icon icon={Pencil} size="sm" /> 畫記
                </button>
              )}
              {loopChip}
              {rangeBtn}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mini-player__error" role="alert">
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={onRetry}>
              <Icon icon={RefreshCw} size="sm" /> 重新載入
            </button>
          )}
        </div>
      )}
    </div>
  );
}
