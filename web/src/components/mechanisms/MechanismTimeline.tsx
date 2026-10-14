// 機關時間軸（管理頁，只有製作看得到）：開「機關」分頁時排在 3D 畫面下面（右邊欄太窄，時間軸要寬）
//   每個機關一行、橫的是影片時間；每一段移動一條色塊（開始動 → 照設定到位）
//   拖整條 = 改延遲；拖右邊 = 改走幾秒；按住 Alt 不吸到 0.1 秒；鍵盤：← → 延遲、↑ ↓ 走幾秒（Shift 一次 1 秒）
//   紅色 = 照最高速度來不及（後面斜線 = 實際會走到哪）；虛線 = 還沒走完就被下一個 cue 接手
//   上面是 cue 的記號（GO → 到位）；點時間尺 / 播放 → 3D 畫面的機關跟著時間軸動（物件停在目前選的 cue）
// 每幀不重畫 React：播放頭、時間字直接改 DOM；機關位置 StageScene 每幀問 mech.previewTimeRef
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Pause, Play, Square, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import Icon from '../Icon';
import type { Cue } from '../../lib/api';
import type { EditorMechanisms } from '../../lib/mechanisms/useMechanisms';
import { SPEED_TOLERANCE_S, formatMechValue, formatSeconds, sortMasters, type TimelineMove } from '../../lib/mechanisms/motion';
import { sheetTime } from '../../lib/mechanisms/cueSheet';

interface Props {
  mech: EditorMechanisms;
  /** 這首歌的 cue（正式 + 提案；只畫正式、有影片時間的） */
  cues: Cue[];
  selectedCueId: string | null;
  onSelectCue: (id: string) => void;
  onClose: () => void;
}

const LABEL_W = 132;
const MIN_PPS = 2, MAX_PPS = 240;
const snap = (v: number, alt: boolean) => (alt ? Math.round(v * 1000) / 1000 : Math.round(v * 10) / 10);
const clamp0 = (v: number) => Math.max(0, Math.min(3600, v));

type Drag = { cueId: string; mechId: string; mode: 'move' | 'resize'; x0: number; delay0: number; dur0: number; delay: number; dur: number; moved: boolean };

export default function MechanismTimeline({ mech, cues, selectedCueId, onSelectCue, onClose }: Props) {
  const tl = mech.timeline;
  const mechanisms = mech.mechanisms;
  const masters = useMemo(() => sortMasters(cues), [cues]);
  const cueNo = useMemo(() => new Map(masters.map((c, i) => [c.id, i + 1])), [masters]);
  const cueById = useMemo(() => new Map(cues.map(c => [c.id, c])), [cues]);
  const untimed = masters.filter(c => c.videoTimeSec == null).length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const [pps, setPps] = useState<number | null>(null);   // 每秒幾 px；null = 還沒量（整首放得下）
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const total = Math.max(10, (tl?.endTime ?? 0) + 4);

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
    const h = headRef.current;
    if (h) { h.style.display = t === null ? 'none' : 'block'; if (t !== null) h.style.transform = `translateX(${t * scale}px)`; }
    if (clockRef.current) clockRef.current.textContent = t === null ? '' : sheetTime(t);
  };
  const setTime = (t: number | null) => {
    mech.setPreviewTime(t);
    showHead(t);
    setPreviewing(t !== null);
  };
  useEffect(() => { showHead(mech.previewTimeRef.current); }); // 縮放後播放頭跟著
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
  const onRulerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPlaying(false);
    setTime(timeAtX(e.clientX));
  };
  const onRulerMove = (e: React.PointerEvent) => {
    if (e.buttons & 1) setTime(timeAtX(e.clientX));
  };

  // ── 拖色塊 ──
  const startDrag = (e: React.PointerEvent, mv: TimelineMove, mode: Drag['mode']) => {
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
    if (d.mode === 'move' && d.delay !== d.delay0) void mech.commitTiming(d.cueId, d.mechId, { delaySec: d.delay });
    if (d.mode === 'resize' && d.dur !== d.dur0) void mech.commitTiming(d.cueId, d.mechId, { durationSec: d.dur });
  };
  const select = (mv: TimelineMove) => {
    if (mv.cueId !== selectedCueId) onSelectCue(mv.cueId);
    if (mech.focusedId !== mv.mechId) mech.setFocusedId(mv.mechId);
    if (playing) setPlaying(false);
  };
  // 鍵盤：先改草稿，放開再存（像滑桿）
  const onBarKey = (e: React.KeyboardEvent, mv: TimelineMove) => {
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
    if (Object.keys(patch).length) void mech.commitTiming(d.cueId, d.mechId, patch);
  };

  // 時間尺的刻度
  const tickStep = [1, 2, 5, 10, 15, 30, 60, 120].find(s => s * scale >= 56) ?? 300;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += tickStep) ticks.push(t);

  const header = (
    <div className="mech-tl__bar">
      <strong className="mech-tl__title">機關時間軸</strong>
      <span className="muted small mech-tl__hint">拖整條改延遲、拖右邊改走幾秒（按住 Alt 不吸附）；紅色 = 照最高速度來不及</span>
      <span className="grow" />
      <span ref={clockRef} className="mech-tl__clock" aria-live="off" />
      <button type="button" className="mech-icon-btn" disabled={!tl} onClick={() => { if (playing) setPlaying(false); else { if (mech.previewTimeRef.current === null || mech.previewTimeRef.current >= total) setTime(0); setPreviewing(true); setPlaying(true); } }}
        title={playing ? '暫停' : '播放（3D 畫面的機關跟著時間軸動）'} aria-label={playing ? '暫停' : '播放'}><Icon icon={playing ? Pause : Play} /></button>
      <button type="button" className="mech-icon-btn" disabled={!previewing} onClick={() => { setPlaying(false); setTime(null); }}
        title="停止預覽（機關回到目前選的 cue）" aria-label="停止預覽"><Icon icon={Square} /></button>
      <button type="button" className="mech-icon-btn" onClick={() => setPps(p => Math.max(MIN_PPS, (p ?? 10) * 0.8))} title="縮小" aria-label="縮小"><Icon icon={ZoomOut} /></button>
      <button type="button" className="mech-icon-btn" onClick={() => setPps(p => Math.min(MAX_PPS, (p ?? 10) * 1.25))} title="放大" aria-label="放大"><Icon icon={ZoomIn} /></button>
      <button type="button" className="mech-icon-btn" onClick={fit} title="整首放進來" aria-label="整首放進來"><Icon icon={Maximize2} /></button>
      <button type="button" className="mech-icon-btn" onClick={onClose} title="收起機關時間軸" aria-label="收起機關時間軸"><Icon icon={ChevronDown} /></button>
    </div>
  );

  if (!tl || mechanisms.length === 0) {
    return (
      <section className="mech-tl" aria-label="機關時間軸">
        {header}
        <div className="mech-tl__empty muted small">
          {mechanisms.length === 0
            ? '還沒有機關：先在右邊「機關」分頁新增機關'
            : '這首歌的 cue 還沒有設「對應影片時間」：設了之後機關就會排在時間軸上'}
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
  const cueLabel = (id: string) => `Cue ${cueNo.get(id) ?? '?'}「${cueById.get(id)?.name ?? ''}」`;

  return (
    <section className="mech-tl" aria-label="機關時間軸">
      {header}
      <div className="mech-tl__body">
        <div className="mech-tl__labels" style={{ width: LABEL_W }}>
          <div className="mech-tl__ruler-pad">{untimed > 0 ? <span className="muted small" title="沒設影片時間的 cue 不在時間軸上">{untimed} 個 cue 沒設時間</span> : null}</div>
          {mechanisms.map(m => (
            <button key={m.id} type="button" className={'mech-tl__label' + (mech.focusedId === m.id ? ' is-focused' : '')}
              onClick={() => mech.setFocusedId(m.id)} title={m.name}>{m.name}</button>
          ))}
        </div>
        <div className="mech-tl__scroll" ref={scrollRef}>
          <div className="mech-tl__content" style={{ width }}>
            <div className="mech-tl__ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} title="點一下 / 拖：3D 畫面的機關跟著這個時間">
              {ticks.map(t => (
                <span key={t} className="mech-tl__tick" style={{ left: 8 + t * scale }}>{sheetTime(t).replace(/\.0$/, '')}</span>
              ))}
              {tl.windows.map(w => (
                <span key={w.cueId}>
                  {w.arrive > w.start && <span className="mech-tl__go" style={{ left: 8 + w.start * scale, width: (w.arrive - w.start) * scale }} />}
                  <span className={'mech-tl__cue' + (w.cueId === selectedCueId ? ' is-selected' : '')} style={{ left: 8 + w.arrive * scale }}
                    title={`${cueLabel(w.cueId)}：${sheetTime(w.start)} GO、${sheetTime(w.arrive)} 到位`}>{cueNo.get(w.cueId)}</span>
                </span>
              ))}
            </div>
            {mechanisms.map(m => (
              <div key={m.id} className={'mech-tl__row' + (mech.focusedId === m.id ? ' is-focused' : '')}>
                {tl.windows.map(w => <span key={w.cueId} className="mech-tl__gridline" style={{ left: 8 + w.arrive * scale }} />)}
                {(movesBy.get(m.id) || []).map(mv => {
                  const d = drag && drag.cueId === mv.cueId && drag.mechId === mv.mechId ? drag : null;
                  const delay = d ? d.delay : mv.delay;
                  const dur = d ? d.dur : mv.duration;
                  const start = mv.go + delay;
                  const fast = mv.need > dur + SPEED_TOLERANCE_S;
                  const lateEnd = start + Math.max(dur, mv.need);
                  const cutAt = !d && mv.cut ? mv.cut.at : null;
                  const sel = mv.cueId === selectedCueId && mech.focusedId === mv.mechId;
                  const issue = fast ? `\n照最高速度要 ${formatSeconds(mv.need)} 秒，會晚 ${formatSeconds(mv.need - dur)} 秒到位` : '';
                  const cutTxt = mv.cut ? `\n${cueLabel(mv.cut.byCueId)} ${sheetTime(mv.cut.at)} 接手時${mv.cut.started ? '還沒走完' : '還沒開始動'}` : '';
                  const label = `「${m.name}」${cueLabel(mv.cueId)}：${sheetTime(start)} 開始、走 ${formatSeconds(dur)} 秒、${sheetTime(start + dur)} 到位（${formatMechValue(mv.from, m.kind)} → ${formatMechValue(mv.to, m.kind)}）`;
                  return (
                    <span key={mv.cueId}>
                      {fast && <span className="mech-tl__late" style={{ left: 8 + (start + dur) * scale, width: (lateEnd - start - dur) * scale }} aria-hidden="true" />}
                      <button
                        type="button"
                        className={'mech-tl__move' + (fast ? ' is-fast' : '') + (sel ? ' is-selected' : '') + (cutAt !== null ? ' is-cut' : '') + (d ? ' is-dragging' : '')}
                        style={{ left: 8 + start * scale, width: Math.max(4, dur * scale) }}
                        title={`${label}${issue}${cutTxt}\n拖整條改延遲、拖右邊改走幾秒`}
                        aria-label={label}
                        onPointerDown={(e) => startDrag(e, mv, 'move')}
                        onPointerMove={onDragMove}
                        onPointerUp={endDrag}
                        onPointerCancel={() => setDrag(null)}
                        onKeyDown={(e) => onBarKey(e, mv)}
                        onKeyUp={onBarKeyUp}
                        onClick={() => select(mv)}
                      >
                        {cutAt !== null && cutAt < start + dur && (
                          <span className="mech-tl__cutrest" style={{ left: Math.max(0, (cutAt - start) * scale) }} aria-hidden="true" />
                        )}
                        {dur * scale > 46 && <span className="mech-tl__movelabel">{cueNo.get(mv.cueId)}</span>}
                        <span className="mech-tl__handle" onPointerDown={(e) => startDrag(e, mv, 'resize')} aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
            <div ref={headRef} className="mech-tl__head" style={{ display: 'none' }} aria-hidden="true" />
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
