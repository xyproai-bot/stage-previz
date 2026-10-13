import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronUp, GripHorizontal, MessageSquarePlus, Pause, Play, RefreshCw, Repeat, Volume2, VolumeX } from 'lucide-react';
import Icon from './Icon';
import { formatClock, parkVideo, type LocalVideoState } from '../lib/localVideo';
import type { SongComment } from '../lib/api';
import type { CompareOption } from '../lib/abCompare';
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
}

interface Props {
  player: LocalVideoState;
  /** 標題（例：V3） */
  label: string;
  /** 標題旁邊的小字（例：小明 · 3 分鐘前） */
  detail?: string;
  /** 記住位置 / 收起來（每個頁面一個） */
  storageKey: string;
  /** 掛在影片時間上的留言 → 時間軸上的小點 */
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

/**
 * 浮在 3D 畫面上的小播放器（像子母畫面）：看得到影片本身、播放 / 暫停、拉時間軸、時間。
 * 同一個 <video> 也是 LED 的貼圖，所以這裡暫停 LED 也停。
 * 可以拖標題列移位置、按 ︿ 收成一條；放在 3D 畫面裡面（不會蓋到下面的 cue 列）。
 */
export default function MiniPlayer({
  player, label, detail, storageKey, comments, onCommentPinClick, onAddCommentAtTime, onRetry, extra, compare,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement>(() => readPlacement(storageKey));
  // 沒記過要不要收起來：3D 畫面太矮（iPad 橫放、留言在下面）就先收起來
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const collapsed = place.collapsed ?? autoCollapsed;
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
    const measure = () => setAutoCollapsed(parent.clientHeight < 400 || parent.clientWidth < 520);
    measure();
    // 沒自己按過展開 / 收起 → 畫面變矮（iPad 橫放、留言移到下面）就自動收起來，變大再打開
    const ro = new ResizeObserver(() => { measure(); keepInside(); });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [keepInside]);
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
    const next = { ...placeRef.current, collapsed: !collapsed };
    setPlace(next);
    savePlacement(storageKey, next);
  };

  const { playing, time, duration, loop, muted, ready, error } = player;
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
  const pins = (comments || []).filter(c => typeof c.time === 'number' && c.time > 0 && duration > 0 && c.time <= duration + 1);

  const scrub = (
    <div className="mini-player__scrub">
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
          className={'mini-player__pin mini-player__pin--' + c.role}
          style={{ left: `${(c.time / duration) * 100}%` }}
          onClick={() => (onCommentPinClick ? onCommentPinClick(c) : player.seek(c.time))}
          title={`${formatClock(c.time)} ${c.author}：${c.text.slice(0, 60)}`}
          aria-label={`${formatClock(c.time)} 的留言`}
        />
      ))}
    </div>
  );

  const playBtn = (
    <button
      type="button"
      className="mini-player__btn mini-player__btn--play"
      onClick={player.togglePlay}
      disabled={!ready}
      title={playing ? '暫停' : '播放'}
      aria-label={playing ? '暫停' : '播放'}
    >
      <Icon icon={playing ? Pause : Play} size="md" />
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={'mini-player' + (collapsed ? ' is-collapsed' : '')}
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
        {collapsed && collapsedCompareBtn}
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
            <span className="mini-player__time">{formatClock(time)} / {formatClock(duration)}</span>
            <span className="mini-player__grow" />
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
                  onChange={(e) => compare!.onPick(e.target.value || null)}
                  aria-label="選另一個版本來比較"
                  title="選另一個版本，按右邊的按鈕（或 C）在兩版之間切換，停在同一個時間點"
                >
                  <option value="">不比較</option>
                  {compare!.options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
              {flipBtn || <span className="mini-player__compare-hint">選一版，按 C 切換</span>}
            </div>
          )}
          {onAddCommentAtTime && (
            <button type="button" className="mini-player__comment" onClick={() => onAddCommentAtTime(player.video.currentTime)} disabled={!ready}>
              <Icon icon={MessageSquarePlus} size="sm" /> 在 {formatClock(time)} 加留言
            </button>
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
