// 機關時間軸（管理頁，只有製作看得到）：開「機關」分頁時排在 3D 畫面下面（右邊欄太窄，時間軸要寬）
//   每個機關一行、橫的是影片時間；每一段移動一條色塊（開始動 → 照設定到位）
//   拖整條 = 改延遲；拖右邊 = 改走幾秒；按住 Alt 不吸到 0.1 秒；鍵盤：← → 延遲、↑ ↓ 走幾秒（Shift 一次 1 秒）
//   虛線（灰色）= 還沒走完就被下一個 cue 接手
//   上面是 cue 的記號（GO → 到位）；點時間尺 / 播放 → 3D 畫面的機關跟著時間軸動（物件停在目前選的 cue）
//   還沒設影片時間的正式 cue 也在上面：暫排在前一個 cue 動完之後，記號畫成空心虛線（算法在 lib/provisionalCues.ts，只算在畫面上、不存）
// 每幀不重畫 React：播放頭、時間字直接改 DOM；機關位置 StageScene 每幀問 mech.previewTimeRef
// 導演頁也用這一份（readOnly：只能看，色塊拖不動、鍵盤改不了；有影片時 clock = 影片，播放頭跟著影片、點時間尺讓影片跳過去）
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Pause, Play, Square, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import Icon from '../Icon';
import './mechanisms.css';
import type { Cue } from '../../lib/api';
import type { Mechanism, MechanismGroup } from '../../lib/mechanisms/model';
import { layoutMechanisms } from '../../lib/mechanisms/group';
import { formatMechValue, formatSeconds, sortMasters, type TimelineMove } from '../../lib/mechanisms/motion';
import { sheetTime } from '../../lib/mechanisms/cueSheet';
import { LIB_START_ID } from '../../lib/mechanisms/libraryView';
import { STAGE_TIMELINE_TEXT, editHandlers, timelineEditing, timelineLength, type TimelineClock, type TimelineMech } from '../../lib/mechanisms/stageTimeline';

interface Props {
  mech: TimelineMech;
  /** 這首歌的 cue（正式 + 提案；只畫正式的：有影片時間的照設的，沒設的是暫排——要傳原本的 cue，不是填過暫排時間的） */
  cues: Cue[];
  selectedCueId: string | null;
  onSelectCue: (id: string) => void;
  onClose: () => void;
  /**
   * Cue 庫裡看一個 cue：cues 是 [預設位置, 這個 cue]（lib/mechanisms/libraryView.ts）；
   * 時間軸只畫這個 cue 從開始轉場（0 秒）到最後一個機關停下，沒有別的 cue
   */
  single?: { label: string; name: string } | null;
  /**
   * 只能看（導演頁）：色塊拖不動、鍵盤改不了、滑鼠移上去不是可以拖的游標；
   * 播放、暫停、點時間尺、縮放、收合一排照舊。編輯頁不給 = 跟以前完全一樣
   */
  readOnly?: boolean;
  /** 播放頭跟著這個時間走（導演頁放影片時是影片）：播放鍵控制它、點時間尺讓它跳過去，時間軸不自己播也不去搶 3D；不給 = 時間軸自己播 */
  clock?: TimelineClock | null;
}

const LABEL_W = 132;
const MIN_PPS = 2, MAX_PPS = 240;
const snap = (v: number, alt: boolean) => (alt ? Math.round(v * 1000) / 1000 : Math.round(v * 10) / 10);
const clamp0 = (v: number) => Math.max(0, Math.min(3600, v));

type Drag = { cueId: string; mechId: string; mode: 'move' | 'resize'; x0: number; delay0: number; dur0: number; delay: number; dur: number; moved: boolean };

/** 時間軸上的一行：一個機關，或一排的標題行（收起來時畫整排合併的色塊） */
type TlRow =
  | { key: string; kind: 'mech'; mech: Mechanism; member: boolean }
  | { key: string; kind: 'group'; group: MechanismGroup; members: Mechanism[]; collapsed: boolean };

export default function MechanismTimeline({ mech, cues, selectedCueId, onSelectCue, onClose, single = null, readOnly = false, clock = null }: Props) {
  const tl = mech.timeline;
  const mechanisms = mech.mechanisms;
  const edit = timelineEditing(readOnly);
  const timeClock = clock;
  const timeClockRef = useRef(timeClock);
  timeClockRef.current = timeClock;
  const masters = useMemo(() => sortMasters(cues), [cues]);
  const cueNo = useMemo(() => new Map<string, string | number>(masters.map((c, i) => [c.id, single ? single.label : i + 1])), [masters, single]);
  const cueById = useMemo(() => new Map(cues.map(c => [c.id, c])), [cues]);
  // 暫排的 cue = 正式 cue 裡沒設影片時間的（時間軸給的位置是 lib/provisionalCues.ts 排的）
  const provisionalIds = useMemo(
    () => new Set(single ? [] : masters.filter(c => c.videoTimeSec == null).map(c => c.id)),
    [masters, single],
  );
  const untimed = provisionalIds.size;
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const rulerHeadRef = useRef<HTMLDivElement>(null);
  const rulerWrapRef = useRef<HTMLDivElement>(null);
  // 時間尺固定在最上面（上下捲只捲機關那幾排），左右捲時跟著色塊一起動
  const syncRuler = () => { if (rulerWrapRef.current && scrollRef.current) rulerWrapRef.current.scrollLeft = scrollRef.current.scrollLeft; };
  const clockRef = useRef<HTMLSpanElement>(null);
  const [pps, setPps] = useState<number | null>(null);   // 每秒幾 px；null = 還沒量（整首放得下）
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const total = timelineLength({ endTime: tl?.endTime ?? 0, single: !!single, clockDuration: timeClock?.duration });
  // 一排機關：標題行可以收起來（預設展開）；一排的成員接在標題行後面
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo<TlRow[]>(() => {
    const out: TlRow[] = [];
    for (const it of layoutMechanisms(mechanisms, mech.groups)) {
      if (it.type === 'single') { out.push({ key: it.mech.id, kind: 'mech', mech: it.mech, member: false }); continue; }
      if (it.type === 'rig') {
        // 吊掛：整組是一個可以收起來的標題行，每個吊點是它的成員
        const gid = 'rig:' + it.rig.id;
        const isCollapsed = collapsed.has(gid);
        out.push({
          key: 'g:' + gid, kind: 'group', group: { id: gid, name: it.rig.name, order: it.rig.order, settings: null, updatedAt: '' },
          members: it.hoists, collapsed: isCollapsed,
        });
        if (!isCollapsed) for (const m of it.hoists) out.push({ key: m.id, kind: 'mech', mech: m, member: true });
        continue;
      }
      const isCollapsed = collapsed.has(it.group.id);
      out.push({ key: 'g:' + it.group.id, kind: 'group', group: it.group, members: it.members, collapsed: isCollapsed });
      if (!isCollapsed) for (const m of it.members) out.push({ key: m.id, kind: 'mech', mech: m, member: true });
    }
    return out;
  }, [mechanisms, mech.groups, collapsed]);

  const fit = () => {
    const w = scrollRef.current?.clientWidth ?? 600;
    setPps(Math.max(MIN_PPS, Math.min(MAX_PPS, (w - 16) / total)));
  };
  useEffect(() => { if (pps === null && tl) fit(); }); // eslint-disable-line react-hooks/exhaustive-deps
  const scale = pps ?? 10;
  const width = Math.ceil(total * scale) + 16;

  // Ctrl + 滾輪 = 放大縮小（要自己掛，React 的 wheel 不能擋預設）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setPps(p => Math.max(MIN_PPS, Math.min(MAX_PPS, (p ?? 10) * (e.deltaY < 0 ? 1.25 : 0.8))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── 播放頭（只改 DOM）──
  const showHead = (t: number | null) => {
    for (const h of [headRef.current, rulerHeadRef.current]) {
      if (h) { h.style.display = t === null ? 'none' : 'block'; if (t !== null) h.style.transform = `translateX(${t * scale}px)`; }
    }
    if (clockRef.current) clockRef.current.textContent = t === null ? '' : sheetTime(t);
  };
  const setTime = (t: number | null) => {
    mech.setPreviewTime(t);
    showHead(t);
    setPreviewing(t !== null);
  };
  useEffect(() => { showHead(timeClockRef.current ? timeClockRef.current.now() : mech.previewTimeRef.current); syncRuler(); }); // 縮放後播放頭跟著
  // 跟著別人的時間（導演頁的影片）：播放頭每幀讀它的時間，只改 DOM
  useEffect(() => {
    if (!timeClock) return;
    let raf = 0;
    const step = () => {
      const c = timeClockRef.current;
      showHead(c ? c.now() : null);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [!!timeClock, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { mech.setPreviewTime(null); }, [mech.setPreviewTime]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const t = (mech.previewTimeRef.current ?? 0) + (now - last) / 1000;
      last = now;
      if (t >= total) { mech.setPreviewTime(total); showHead(total); setPlaying(false); return; }
      mech.setPreviewTime(t);
      showHead(t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeAtX = (clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + el.scrollLeft - 8) / scale));
  };
  // 點 / 拖時間尺：跟著影片時 → 讓影片跳過去（3D 本來就跟著影片）；自己播時 → 3D 的機關跟著這個時間
  const scrub = (t: number) => {
    const c = timeClockRef.current;
    if (c) { c.seek(t); showHead(t); } else setTime(t);
  };
  const onRulerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!timeClockRef.current) setPlaying(false);
    scrub(timeAtX(e.clientX));
  };
  const onRulerMove = (e: React.PointerEvent) => {
    if (e.buttons & 1) scrub(timeAtX(e.clientX));
  };

  // ── 拖色塊 ──
  const startDrag = (e: React.PointerEvent, mv: TimelineMove, mode: Drag['mode']) => {
    if (readOnly) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    select(mv);
    const delay0 = mv.delay, dur0 = mv.duration;
    setDrag({ cueId: mv.cueId, mechId: mv.mechId, mode, x0: e.clientX, delay0, dur0, delay: delay0, dur: dur0, moved: false });
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const ds = (e.clientX - d.x0) / scale;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    setDrag(d.mode === 'move'
      ? { ...d, moved: true, delay: clamp0(snap(d.delay0 + ds, e.altKey)) }
      : { ...d, moved: true, dur: clamp0(snap(d.dur0 + ds, e.altKey)) });
  };
  const endDrag = () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d || !d.moved) return;
    if (d.mode === 'move' && d.delay !== d.delay0) void mech.commitTiming?.(d.cueId, d.mechId, { delaySec: d.delay });
    if (d.mode === 'resize' && d.dur !== d.dur0) void mech.commitTiming?.(d.cueId, d.mechId, { durationSec: d.dur });
  };
  const select = (mv: TimelineMove) => {
    if (mv.cueId !== selectedCueId) onSelectCue(mv.cueId);
    if (mech.focusedId !== mv.mechId) mech.setFocusedId(mv.mechId);
    if (playing) setPlaying(false);
  };
  // 鍵盤：先改草稿，放開再存（像滑桿）
  const onBarKey = (e: React.KeyboardEvent, mv: TimelineMove) => {
    if (readOnly) return;
    const step = e.shiftKey ? 1 : 0.1;
    const cur = dragRef.current && dragRef.current.cueId === mv.cueId && dragRef.current.mechId === mv.mechId ? dragRef.current : null;
    const base: Drag = cur ?? { cueId: mv.cueId, mechId: mv.mechId, mode: 'move', x0: 0, delay0: mv.delay, dur0: mv.duration, delay: mv.delay, dur: mv.duration, moved: false };
    let next: Drag | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') next = { ...base, mode: 'move', moved: true, delay: clamp0(snap(base.delay + (e.key === 'ArrowRight' ? step : -step), false)) };
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') next = { ...base, mode: 'resize', moved: true, dur: clamp0(snap(base.dur + (e.key === 'ArrowUp' ? step : -step), false)) };
    if (!next) return;
    e.preventDefault();
    setDrag(next);
  };
  const onBarKeyUp = (e: React.KeyboardEvent) => {
    if (!e.key.startsWith('Arrow')) return;
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    const patch: { delaySec?: number; durationSec?: number } = {};
    if (d.delay !== d.delay0) patch.delaySec = d.delay;
    if (d.dur !== d.dur0) patch.durationSec = d.dur;
    if (Object.keys(patch).length) void mech.commitTiming?.(d.cueId, d.mechId, patch);
  };

  // 時間尺的刻度
  const tickStep = [1, 2, 5, 10, 15, 30, 60, 120].find(s => s * scale >= 56) ?? 300;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += tickStep) ticks.push(t);

  const header = (
    <div className="mech-tl__bar">
      <strong className="mech-tl__title">{single ? `Cue ${single.label} 的機關時間軸` : '機關時間軸'}</strong>
      <span className="muted small mech-tl__hint" title={single ? '0 秒 = 這個 cue 開始轉場；預覽從預設位置開始動，在歌裡會從前一個 cue 的位置開始' : undefined}>
        {readOnly
          ? (timeClock ? STAGE_TIMELINE_TEXT.readOnlyHintVideo : STAGE_TIMELINE_TEXT.readOnlyHint)
          : single ? '0 秒 = 開始轉場。拖整條改延遲、拖右邊改走幾秒（按住 Alt 不吸附）' : '拖整條改延遲、拖右邊改走幾秒（按住 Alt 不吸附）'}
      </span>
      <span className="grow" />
      <span ref={clockRef} className="mech-tl__clock" aria-live="off" />
      <button type="button" className="mech-icon-btn" disabled={!tl}
        onClick={() => {
          if (timeClock) { timeClock.toggle(); return; }
          if (playing) setPlaying(false); else { if (mech.previewTimeRef.current === null || mech.previewTimeRef.current >= total) setTime(0); setPreviewing(true); setPlaying(true); }
        }}
        title={timeClock ? (timeClock.playing ? STAGE_TIMELINE_TEXT.pauseVideoTitle : STAGE_TIMELINE_TEXT.playVideoTitle) : (playing ? '暫停' : '播放（3D 畫面的機關跟著時間軸動）')}
        aria-label={(timeClock ? timeClock.playing : playing) ? '暫停' : '播放'}><Icon icon={(timeClock ? timeClock.playing : playing) ? Pause : Play} /></button>
      {!timeClock && (
        <button type="button" className="mech-icon-btn" disabled={!previewing} onClick={() => { setPlaying(false); setTime(null); }}
          title="停止預覽（機關回到目前選的 cue）" aria-label="停止預覽"><Icon icon={Square} /></button>
      )}
      <button type="button" className="mech-icon-btn" onClick={() => setPps(p => Math.max(MIN_PPS, (p ?? 10) * 0.8))} title="縮小" aria-label="縮小"><Icon icon={ZoomOut} /></button>
      <button type="button" className="mech-icon-btn" onClick={() => setPps(p => Math.min(MAX_PPS, (p ?? 10) * 1.25))} title="放大" aria-label="放大"><Icon icon={ZoomIn} /></button>
      <button type="button" className="mech-icon-btn" onClick={fit} title="整首放進來" aria-label="整首放進來"><Icon icon={Maximize2} /></button>
      <button type="button" className="mech-icon-btn" onClick={onClose} title="收起機關時間軸" aria-label="收起機關時間軸"><Icon icon={ChevronDown} /></button>
    </div>
  );

  if (!tl || mechanisms.length === 0) {
    return (
      <section className={'mech-tl' + (readOnly ? ' mech-tl--readonly' : '')} aria-label="機關時間軸">
        {header}
        <div className="mech-tl__empty muted small">
          {mechanisms.length === 0
            ? (readOnly ? STAGE_TIMELINE_TEXT.noMechanisms : '還沒有機關：先在右邊「機關」分頁新增機關')
            : single ? '這個 cue 還沒有可以畫的機關'
            : readOnly ? STAGE_TIMELINE_TEXT.noCueTimes
            : '這首歌還沒有正式的 cue：新增 cue 之後機關就會排在時間軸上'}
        </div>
      </section>
    );
  }

  const movesBy = new Map<string, TimelineMove[]>();
  for (const mv of tl.moves) {
    const list = movesBy.get(mv.mechId) || [];
    list.push(mv);
    movesBy.set(mv.mechId, list);
  }
  const cueLabel = (id: string) => (id === LIB_START_ID ? '預設位置' : `Cue ${cueNo.get(id) ?? '?'}「${cueById.get(id)?.name ?? ''}」`);
  const toggleGroup = (id: string) => setCollapsed(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /** 一排的標題行：每個 cue 一條合併的色塊（最早開始動 → 最後一個到位）；收起來時看這一條就知道整排什麼時候動 */
  const groupRow = (row: Extract<TlRow, { kind: 'group' }>) => {
    const byCue = new Map<string, { start: number; end: number; first: TimelineMove; n: number }>();
    for (const m of row.members) {
      for (const mv of movesBy.get(m.id) || []) {
        const start = mv.go + mv.delay, end = start + mv.duration;
        const cur = byCue.get(mv.cueId);
        if (!cur) byCue.set(mv.cueId, { start, end, first: mv, n: 1 });
        else { cur.start = Math.min(cur.start, start); cur.end = Math.max(cur.end, end); cur.n++; }
      }
    }
    return (
      <div key={row.key} className={'mech-tl__row mech-tl__row--group' + (row.members.some(m => m.id === mech.focusedId) ? ' is-focused' : '')}>
        {tl!.windows.filter(w => w.cueId !== LIB_START_ID).map(w => <span key={w.cueId} className="mech-tl__gridline" style={{ left: 8 + w.arrive * scale }} />)}
        {[...byCue.entries()].map(([cueId, b]) => {
          const sel = cueId === selectedCueId && row.members.some(m => m.id === mech.focusedId);
          const label = `「${row.group.name}」${cueLabel(cueId)}：${b.n} 個機關，${sheetTime(b.start)} 最早開始動、${sheetTime(b.end)} 最後一個到位`;
          return (
            <button key={cueId} type="button" className={'mech-tl__gmove' + (sel ? ' is-selected' : '')}
              style={{ left: 8 + b.start * scale, width: Math.max(4, (b.end - b.start) * scale) }}
              title={readOnly ? label : `${label}\n展開這一排可以拖每一個機關的色塊`}
              aria-label={label} onClick={() => select(b.first)}>
              {(b.end - b.start) * scale > 46 && <span className="mech-tl__movelabel">{cueNo.get(cueId)}</span>}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <section className={'mech-tl' + (readOnly ? ' mech-tl--readonly' : '')} aria-label="機關時間軸">
      {header}
      <div className="mech-tl__body">
        <div className="mech-tl__labels" style={{ width: LABEL_W }}>
          <div className="mech-tl__ruler-pad">{untimed > 0 ? <span className="muted small" title={STAGE_TIMELINE_TEXT.provisionalTip}>{untimed} {STAGE_TIMELINE_TEXT.provisionalCount}</span> : null}</div>
          {rows.map(row => (row.kind === 'group' ? (
            <button key={row.key} type="button" className={'mech-tl__label mech-tl__label--group' + (row.members.some(m => m.id === mech.focusedId) ? ' is-focused' : '')}
              aria-expanded={!row.collapsed} onClick={() => toggleGroup(row.group.id)}
              title={`${row.group.name}（${row.members.length} 個機關）：${row.collapsed ? '按一下展開' : '按一下收起來'}`}>
              <Icon icon={row.collapsed ? ChevronRight : ChevronDown} size="sm" />{row.group.name}
            </button>
          ) : (
            <button key={row.key} type="button" className={'mech-tl__label' + (row.member ? ' mech-tl__label--member' : '') + (mech.focusedId === row.mech.id ? ' is-focused' : '')}
              onClick={() => mech.setFocusedId(row.mech.id)} title={row.mech.name}>{row.mech.name}</button>
          )))}
        </div>
        <div className="mech-tl__main">
          <div className="mech-tl__rulerwrap" ref={rulerWrapRef}>
            <div style={{ width }}>
          <div className="mech-tl__ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} title={timeClock ? STAGE_TIMELINE_TEXT.rulerTipVideo : '點一下 / 拖：3D 畫面的機關跟著這個時間'}>
            {ticks.map(t => (
              <span key={t} className="mech-tl__tick" style={{ left: 8 + t * scale }}>{sheetTime(t).replace(/\.0$/, '')}</span>
            ))}
            {tl.windows.filter(w => w.cueId !== LIB_START_ID).map(w => {
              const prov = provisionalIds.has(w.cueId);
              return (
                <span key={w.cueId}>
                  {w.arrive > w.start && <span className={'mech-tl__go' + (prov ? ' is-provisional' : '')} style={{ left: 8 + w.start * scale, width: (w.arrive - w.start) * scale }} />}
                  <span className={'mech-tl__cue' + (w.cueId === selectedCueId ? ' is-selected' : '') + (prov ? ' is-provisional' : '')} style={{ left: 8 + w.arrive * scale }}
                    title={`${cueLabel(w.cueId)}：${sheetTime(w.start)} GO、${sheetTime(w.arrive)} 到位${prov ? `（暫排）\n${STAGE_TIMELINE_TEXT.provisionalTip}` : ''}`}>{cueNo.get(w.cueId)}</span>
                </span>
              );
            })}
            <div ref={rulerHeadRef} className="mech-tl__head" style={{ display: 'none' }} aria-hidden="true" />
          </div>
            </div>
          </div>
          <div className="mech-tl__scroll" ref={scrollRef} onScroll={syncRuler}>
          <div className="mech-tl__content" style={{ width }}>
            {rows.map(row => {
              if (row.kind === 'group') return groupRow(row);
              const m = row.mech;
              return (
              <div key={m.id} className={'mech-tl__row' + (mech.focusedId === m.id ? ' is-focused' : '')}>
                {tl.windows.filter(w => w.cueId !== LIB_START_ID).map(w => <span key={w.cueId} className="mech-tl__gridline" style={{ left: 8 + w.arrive * scale }} />)}
                {(movesBy.get(m.id) || []).map(mv => {
                  const d = drag && drag.cueId === mv.cueId && drag.mechId === mv.mechId ? drag : null;
                  const delay = d ? d.delay : mv.delay;
                  const dur = d ? d.dur : mv.duration;
                  const start = mv.go + delay;
                  const cutAt = !d && mv.cut ? mv.cut.at : null;
                  const sel = mv.cueId === selectedCueId && mech.focusedId === mv.mechId;
                  const cutTxt = mv.cut ? `\n${cueLabel(mv.cut.byCueId)} ${sheetTime(mv.cut.at)} 接手時${mv.cut.started ? '還沒走完' : '還沒開始動'}` : '';
                  const label = `「${m.name}」${cueLabel(mv.cueId)}：${sheetTime(start)} 開始、走 ${formatSeconds(dur)} 秒、${sheetTime(start + dur)} 到位（${formatMechValue(mv.from, m.kind)} → ${formatMechValue(mv.to, m.kind)}）`;
                  return (
                    <span key={mv.cueId}>
                      <button
                        type="button"
                        className={'mech-tl__move' + (sel ? ' is-selected' : '') + (cutAt !== null ? ' is-cut' : '') + (d ? ' is-dragging' : '')}
                        style={{ left: 8 + start * scale, width: Math.max(4, dur * scale) }}
                        title={`${label}${cutTxt}\n${edit.drag ? '拖整條改延遲、拖右邊改走幾秒' : STAGE_TIMELINE_TEXT.barTip}`}
                        aria-label={label}
                        {...editHandlers(readOnly, {
                          onPointerDown: (e: React.PointerEvent) => startDrag(e, mv, 'move'),
                          onPointerMove: onDragMove,
                          onPointerUp: endDrag,
                          onPointerCancel: () => setDrag(null),
                          onKeyDown: (e: React.KeyboardEvent) => onBarKey(e, mv),
                          onKeyUp: onBarKeyUp,
                        })}
                        onClick={() => select(mv)}
                      >
                        {cutAt !== null && cutAt < start + dur && (
                          <span className="mech-tl__cutrest" style={{ left: Math.max(0, (cutAt - start) * scale) }} aria-hidden="true" />
                        )}
                        {dur * scale > 46 && <span className="mech-tl__movelabel">{cueNo.get(mv.cueId)}</span>}
                        {edit.resize && <span className="mech-tl__handle" onPointerDown={(e) => startDrag(e, mv, 'resize')} aria-hidden="true" />}
                      </button>
                    </span>
                  );
                })}
              </div>
              );
            })}
            <div ref={headRef} className="mech-tl__head" style={{ display: 'none' }} aria-hidden="true" />
          </div>
          </div>
        </div>
      </div>
      {drag && drag.moved && (
        <div className="mech-tl__drag muted small" role="status">
          {drag.mode === 'move' ? `延遲 ${formatSeconds(drag.delay)} 秒` : `走 ${formatSeconds(drag.dur)} 秒`}
        </div>
      )}
    </section>
  );
}
