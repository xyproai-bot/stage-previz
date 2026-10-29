// 頁面用的機關 hook：讀資料 → 算每個 cue 的位置（沿用規則）→ 給 StageScene 的 props。
//
//   useEditorMechanisms  — 管理頁（製作）：可以改，含速度檢查、復原、預覽
//   useStageMechanisms   — 導演頁 / 動畫師工作站：只看；跟著自動更新（25 秒一次）；播影片時跟著影片時間
//   useShareMechanisms   — 分享連結：只看正式 cue
// 每頁只要：const mech = useXxxMechanisms(...); <StageScene {...mech.sceneProps} />

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ShareRef } from '../api';
import type { HistoryStep } from '../editHistory';
import { historyScope } from '../editHistory';
import { STOP_LIVE_REFRESH, isProjectGoneError, useLiveRefresh } from '../liveRefresh';
import { toast } from '../toast';
import { clampValue, valueAxes, type CueMechanismPosition, type Mechanism, type MechanismGroup, type MechanismTimings, type MechanismValues } from './model';
import { buildHoistRigs, checkHoistRigs, type HoistCueItem } from './hoist';
import type { BulkPositionItem } from './group';
import { defaultRow, resolvePositions, valuesOf, type PositionsMode, type ResolvedRow } from './track';
import { buildMechanismTimeline, checkSongMechanisms, ownMoveFor, sortMasters, type MechanismMotion, type MechanismTimeline, type MotionCue, type SongCheck } from './motion';
import * as mapi from './mechanismApi';
import type { StageSceneQuery } from '../../components/StageScene';
import type { DraftMech } from '../lookDraft';
import { buildLibraryView } from './libraryView';

export interface MechanismSceneProps {
  mechanisms: Mechanism[] | null;
  mechanismTargets: MechanismValues;
  mechanismAtFrame?: () => MechanismValues | null;
  /** 目前這個 cue 自己設的延遲 / 走幾秒（換 cue 時用） */
  mechanismTimings?: MechanismTimings;
  /** 管理頁：機關時間軸拉 / 播的時候每幀都問 mechanismAtFrame（不用等影片） */
  mechanismFrameAlways?: boolean;
  /** 換 cue 時機關怎麼走：不給 = 照走幾秒（沒設 = 轉場秒數）；'instant' = 直接到位 */
  mechanismMotion?: MechanismMotion;
  focusedMechanismId?: string | null;
  sceneQueryRef?: React.MutableRefObject<StageSceneQuery | null>;
}

type CueLike = MotionCue & { name?: string };
/** Cue 庫預覽時，只存在畫面上的假 cue 的 id */
export const PREVIEW_CUE_ID = '__library_preview__';

/** 位置清單 + 定義 + cue → 每個 cue 的位置、目前 cue 的目標、影片時間軸 */
function usePlayback(
  mechanisms: Mechanism[] | null,
  positions: CueMechanismPosition[],
  cues: CueLike[],
  selectedCueId: string | null,
  video?: HTMLVideoElement | null,
  mode?: PositionsMode,
) {
  // 有自己位置的機關（吊掛的整組沒有，只有它的每個吊點有）
  const axes = useMemo(() => (mechanisms ? valueAxes(mechanisms) : null), [mechanisms]);
  const solved = useMemo(
    () => (axes ? resolvePositions(mode, axes, cues, positions) : null),
    [axes, cues, positions, mode],
  );
  const resolved = useMemo(() => solved?.resolved ?? new Map<string, ResolvedRow>(), [solved]);
  const selectedRow = useMemo<ResolvedRow>(() => {
    if (!axes) return {};
    return (selectedCueId && resolved.get(selectedCueId)) || defaultRow(axes);
  }, [axes, resolved, selectedCueId]);
  const targets = useMemo(() => valuesOf(selectedRow), [selectedRow]);
  // 每個 cue 自己設的延遲 / 走幾秒（不沿用）
  const timings = useMemo(() => solved?.timings ?? new Map<string, MechanismTimings>(), [solved]);
  const selectedTimings = useMemo<MechanismTimings>(
    () => (selectedCueId && timings.get(selectedCueId)) || EMPTY_TIMINGS, [timings, selectedCueId],
  );

  // 影片時間軸（只有正式 cue、有設影片時間的）；每幀 StageScene 問 mechanismAtFrame
  const timeline = useMemo<MechanismTimeline | null>(() => {
    if (!axes || axes.length === 0) return null;
    const masters = sortMasters(cues);
    return buildMechanismTimeline(axes, masters, id => {
      const row = resolved.get(id);
      return row ? valuesOf(row) : null;
    }, ownMoveFor(resolved, timings));
  }, [axes, cues, resolved, timings]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const videoRef = useRef(video);
  videoRef.current = video;
  const mechanismAtFrame = useCallback((): MechanismValues | null => {
    const tl = timelineRef.current;
    const v = videoRef.current;
    return tl && v ? tl.valuesAt(v.currentTime) : null;
  }, []);
  return { axes, resolved, selectedRow, targets, timings, selectedTimings, timeline, timelineRef, mechanismAtFrame };
}

const EMPTY_TIMINGS: MechanismTimings = {};

// ─────────────────────────────────────────────
// 導演頁 / 動畫師工作站（只看）
// ─────────────────────────────────────────────

export function useStageMechanisms(o: {
  projectId: string | undefined;
  songId: string | null;
  cues: CueLike[];
  selectedCueId: string | null;
  /** 播影片時的 <video>（跟著影片時間）；沒有就只照點 cue 走 */
  video?: HTMLVideoElement | null;
  /** 要不要自動更新（專案看不到了 / 已封存 → false）；預設 true */
  live?: boolean;
}) {
  const { projectId, songId, live = true } = o;
  const [mechanisms, setMechanisms] = useState<Mechanism[] | null>(null);
  // 一排一排的分組（導演頁的機關時間軸要照排畫；舊後台沒有 → 空的）
  const [groups, setGroups] = useState<MechanismGroup[]>(EMPTY_GROUPS);
  const [positions, setPositions] = useState<{ songId: string; list: CueMechanismPosition[]; mode: PositionsMode } | null>(null);
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /** 回 true = 專案看不到了（404 / 403），自動更新可以停了 */
  const loadDefs = useCallback(async (): Promise<boolean> => {
    if (!projectId) return false;
    try {
      const { mechanisms: list, groups: gs } = await mapi.listMechanismsAndGroups(projectId);
      setMechanisms(prev => (prev && sameJson(prev, list) ? prev : list));
      setGroups(prev => (sameJson(prev, gs) ? prev : gs));
      return false;
    } catch (e) {
      setMechanisms(prev => prev ?? []);  // 讀不到（舊後台 / 網路）→ 沒有機關，畫面照舊
      return isProjectGoneError(e);
    }
  }, [projectId]);
  const loadPositions = useCallback(async () => {
    if (!projectId || !songId) return;
    try {
      const { positions: list, mode } = await mapi.listSongPositionsWithMode(projectId, songId);
      setPositions(prev => (prev && prev.songId === songId && prev.mode === mode && sameJson(prev.list, list) ? prev : { songId, list, mode }));
    } catch { /* 下次自動更新再試 */ }
  }, [projectId, songId]);

  useEffect(() => { setMechanisms(null); void loadDefs(); }, [loadDefs]);
  useEffect(() => { void loadPositions(); }, [loadPositions]);
  // 製作改了機關 → 30 秒內跟上（跟位置、留言一樣）；專案被封存 / 刪除了就不再問
  //（只看機關清單：位置是這首歌的，歌被刪了不代表專案不見）
  useLiveRefresh(async () => {
    const [gone] = await Promise.all([loadDefs(), loadPositions()]);
    if (gone) return STOP_LIVE_REFRESH;
  }, { enabled: live });

  const list = positions && positions.songId === songId ? positions.list : EMPTY_POSITIONS;
  const pb = usePlayback(mechanisms, list, o.cues, o.selectedCueId, o.video, positions?.mode);
  const sceneProps: MechanismSceneProps = useMemo(() => ({
    mechanisms, mechanismTargets: pb.targets, mechanismAtFrame: pb.mechanismAtFrame, mechanismTimings: pb.selectedTimings,
  }), [mechanisms, pb.targets, pb.mechanismAtFrame, pb.selectedTimings]);
  // 調整舞台用：是不是 Cue 庫模式、某個 cue 的機關值（播轉場從上一個 cue 走過來）、每個 cue 自己設的時間
  const { resolved, timings } = pb;
  const valuesForCue = useCallback((cueId: string): MechanismValues | null => {
    const row = resolved.get(cueId);
    return row ? valuesOf(row) : null;
  }, [resolved]);
  const timingsForCue = useCallback((cueId: string): MechanismTimings => timings.get(cueId) ?? EMPTY_TIMINGS, [timings]);
  // 模式是整個專案的設定：換歌、新的那首還沒讀到時沿用上一首讀到的（調整舞台才不會一換歌就關掉）
  const mode = positions ? positions.mode : null;
  return { mechanisms, groups, sceneProps, timeline: pb.timeline, mode, valuesForCue, timingsForCue };
}

const EMPTY_POSITIONS: CueMechanismPosition[] = [];

// ─────────────────────────────────────────────
// 分享連結（只看正式 cue）
// ─────────────────────────────────────────────

export function useShareMechanisms(o: {
  shareRef: ShareRef | null;
  /** 分享頁 /data 回傳的 mechanisms（舊後台沒有 → undefined → 沒有機關） */
  mechanisms: unknown;
  songId: string | null;
  accessToken: string | null;
  cues: CueLike[];
  selectedCueId: string | null;
  /** 分頁切回來重抓時 +1 */
  refreshKey?: unknown;
  video?: HTMLVideoElement | null;
}) {
  const { shareRef, songId, accessToken } = o;
  const mechanisms = useMemo(() => (o.mechanisms === undefined ? null : mapi.parseMechanisms(o.mechanisms)), [o.mechanisms]);
  const [positions, setPositions] = useState<{ songId: string; list: CueMechanismPosition[]; mode: PositionsMode } | null>(null);
  useEffect(() => {
    if (!shareRef || !songId || !mechanisms || mechanisms.length === 0) return;
    let cancelled = false;
    mapi.getShareSongPositionsWithMode(shareRef, songId, accessToken ?? undefined)
      .then(({ positions: list, mode }) => {
        if (cancelled) return;
        setPositions(prev => (prev && prev.songId === songId && prev.mode === mode && JSON.stringify(prev.list) === JSON.stringify(list) ? prev : { songId, list, mode }));
      })
      .catch(() => { /* 舊後台 / 網路：機關停在預設位置 */ });
    return () => { cancelled = true; };
  }, [shareRef, songId, accessToken, mechanisms, o.refreshKey]);
  const list = positions && positions.songId === songId ? positions.list : EMPTY_POSITIONS;
  const pb = usePlayback(mechanisms, list, o.cues, o.selectedCueId, o.video, positions?.mode);
  const sceneProps: MechanismSceneProps = useMemo(() => ({
    mechanisms, mechanismTargets: pb.targets, mechanismAtFrame: pb.mechanismAtFrame, mechanismTimings: pb.selectedTimings,
  }), [mechanisms, pb.targets, pb.mechanismAtFrame, pb.selectedTimings]);
  return { mechanisms, sceneProps, timeline: pb.timeline };
}

// ─────────────────────────────────────────────
// 管理頁（製作）
// ─────────────────────────────────────────────

/** 機關時間軸開著還是收起來（記在這台電腦；預設開） */
export const TIMELINE_PREF_KEY = 'sp_mech_timeline';
const localStore = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export interface EditorHistory {
  push(scope: string, step: HistoryStep): void;
  bump(): void;
}

export function useEditorMechanisms(o: {
  projectId: string | undefined;
  songId: string | null;
  /** 這首歌的 cue（正式 + 提案） */
  cues: CueLike[];
  selectedCueId: string | null;
  canEdit: boolean;
  history?: EditorHistory;
  /** 測距校準倍率（吊掛的傾斜 / 共面提醒要把公尺換成場景單位）；沒給 = 1 */
  scaleCorrection?: number;
  /**
   * Cue 庫專案：機關的修改先放進「還沒存的改動」（草稿），不直接寫後台。
   * mechanisms = 草稿裡目前的機關；set = 改一個（null = 回到預設）
   */
  libDraft?: { mechanisms: Record<string, DraftMech | null>; set: (entries: Record<string, DraftMech | null>) => void };
  /**
   * Cue 庫的「預覽」：舞台上看的是某個 Cue 庫的 cue，但這首歌沒有 cue 指到它。
   * 給它的機關列 → 當成一個只存在畫面上的 cue（不寫後台）
   */
  previewLook?: { mechanisms: { mechanismId: string; value: number; delaySec: number | null; durationSec: number | null; carried: boolean }[] } | null;
  /**
   * 右邊「Cue 庫」分頁的機關：看的是 Cue 庫的一個 cue，不屬於哪一首歌。
   * 給了 → 檢查表和時間軸改用「預設位置 → 這個 cue」的小時間表（lib/mechanisms/libraryView.ts），
   * 時間軸只畫這個 cue 從開始轉場到最後一個機關停下；不給 = 照歌的 cue（右邊「機關」分頁）
   */
  libraryView?: { name: string; crossfadeSeconds: number } | null;
}) {
  const { projectId, songId } = o;
  const previewLook = o.previewLook ?? null;
  const selectedCueId = previewLook ? PREVIEW_CUE_ID : o.selectedCueId;
  const cues = useMemo<CueLike[]>(
    () => (previewLook ? [...o.cues, { id: PREVIEW_CUE_ID, order: 1_000_000, status: 'master', name: '預覽', videoTimeSec: null } as CueLike] : o.cues),
    [o.cues, previewLook],
  );
  const [mechanisms, setMechanisms] = useState<Mechanism[] | null>(null);
  const [groups, setGroups] = useState<MechanismGroup[]>(EMPTY_GROUPS);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [positions, setPositions] = useState<{ songId: string; list: CueMechanismPosition[]; mode: PositionsMode } | null>(null);
  // 拖滑桿時的預覽（還沒存）：mechId → value
  const [preview, setPreview] = useState<MechanismValues>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpenState] = useState(() => { try { return localStore()?.getItem(TIMELINE_PREF_KEY) !== '0'; } catch { return true; } });
  const setTimelineOpen = useCallback((on: boolean) => {
    setTimelineOpenState(on);
    try { if (on) localStore()?.removeItem(TIMELINE_PREF_KEY); else localStore()?.setItem(TIMELINE_PREF_KEY, '0'); } catch { /* 不能存 → 這次有效就好 */ }
  }, []);
  const sceneQueryRef = useRef<StageSceneQuery | null>(null);
  const mechsRef = useRef<Mechanism[] | null>(null);
  mechsRef.current = mechanisms;
  const posRef = useRef(positions);
  const libDraftRef = useRef(o.libDraft);
  libDraftRef.current = o.libDraft;
  const historyRef = useRef(o.history);
  historyRef.current = o.history;

  const refreshDefs = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await mapi.listMechanismsAndGroups(projectId);
      setMechanisms(r.mechanisms);
      setGroups(r.groups);
      setStatus('ready');
    } catch (e) {
      console.warn('[mechanisms] load failed', e);
      setStatus(s => (s === 'ready' ? s : 'error'));
      setMechanisms(prev => prev ?? []);
    }
  }, [projectId]);
  const refreshPositions = useCallback(async () => {
    if (!projectId || !songId) return;
    try {
      const { positions: list, mode } = await mapi.listSongPositionsWithMode(projectId, songId);
      setPositions({ songId, list, mode });
    } catch (e) {
      console.warn('[mechanisms] positions failed', e);
    }
  }, [projectId, songId]);

  useEffect(() => { setStatus('loading'); setMechanisms(null); setGroups(EMPTY_GROUPS); void refreshDefs(); }, [refreshDefs]);
  // 換歌 / cue 清單變了（新增、沿用、刪除 cue 時後台會複製 / 刪掉位置）→ 重新讀
  useEffect(() => { void refreshPositions(); }, [refreshPositions, o.cues]);
  useEffect(() => { setPreview({}); }, [selectedCueId, songId]);

  const rawSaved = positions && positions.songId === songId ? positions.list : EMPTY_POSITIONS;
  const rawList = useMemo(() => (previewLook
    ? [...rawSaved, ...previewLook.mechanisms.map(m => ({ cueId: PREVIEW_CUE_ID, mechanismId: m.mechanismId, value: m.value, delaySec: m.delaySec, durationSec: m.durationSec, updatedAt: '', carried: m.carried }))]
    : rawSaved), [rawSaved, previewLook]);
  // Cue 庫專案：目前選的 cue 的機關列蓋上草稿（畫面、時間軸、速度檢查都看得到還沒存的改動）
  const draftMech = o.libDraft?.mechanisms;
  // Cue 庫專案、有看一個 Cue 庫的 cue → 改動進草稿（不需要先選歌）
  const libActive = !!o.libDraft;
  const list = useMemo(() => {
    if (!libActive || !draftMech || !selectedCueId || Object.keys(draftMech).length === 0) return rawList;
    const kept = rawList.filter(p => !(p.cueId === selectedCueId && p.mechanismId in draftMech));
    for (const [mechanismId, e] of Object.entries(draftMech)) {
      if (e) kept.push({ cueId: selectedCueId, mechanismId, value: e.value, delaySec: e.delaySec, durationSec: e.durationSec, updatedAt: '', carried: false });
    }
    return kept;
  }, [libActive, draftMech, selectedCueId, rawList]);
  posRef.current = positions ? { ...positions, list } : positions;
  const pb = usePlayback(mechanisms, list, cues, selectedCueId, undefined, positions?.mode ?? (o.libDraft ? 'library' : undefined));
  const lv = o.libraryView ?? null;
  const libView = useMemo(
    () => (lv && selectedCueId && pb.axes && pb.axes.length ? buildLibraryView(pb.axes, pb.resolved, pb.timings, selectedCueId, lv.name, lv.crossfadeSeconds) : null),
    [lv?.name, lv?.crossfadeSeconds, !!lv, selectedCueId, pb.axes, pb.resolved, pb.timings], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const timeline = libView ? libView.timeline : pb.timeline;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const targets = useMemo(() => {
    const keys = Object.keys(preview);
    return keys.length ? { ...pb.targets, ...preview } : pb.targets;
  }, [pb.targets, preview]);
  const songCheck = useMemo<SongCheck | null>(
    () => (pb.axes && pb.axes.length ? checkSongMechanisms(pb.axes, cues, pb.resolved, pb.timings) : null),
    [pb.axes, cues, pb.resolved, pb.timings],
  );
  const check = libView ? libView.check : songCheck;
  // 吊掛（v2 第 4 階段）：每個 cue、每一組吊掛的傾斜和說明（到位時 + 走過來的路上四個吊點不在同一個平面上 / 兩點的高度差比距離大）
  const scale = o.scaleCorrection && o.scaleCorrection > 0 ? o.scaleCorrection : 1;
  const hoistRigs = useMemo(() => buildHoistRigs(mechanisms), [mechanisms]);
  const hoistChecks = useMemo(() => {
    if (hoistRigs.length === 0 || !check) return null;
    const itemOf = (cueId: string, hoistId: string): HoistCueItem | null => {
      const r = pb.resolved.get(cueId)?.[hoistId];
      const c = check.cues.get(cueId)?.items[hoistId];
      if (!r || !c) return null;
      return { value: r.value, from: c.from, delay: c.delay, duration: c.status === 'move' ? c.available ?? 0 : 0 };
    };
    return checkHoistRigs(hoistRigs, sortMasters(cues).map(c => c.id), itemOf, 1 / scale);
  }, [hoistRigs, check, pb.resolved, cues, scale]);

  // ── 本地更新（存成功後先套到畫面上） ──
  /** value = null → 刪掉這一列（時間一起清掉）；timing 沒給 → 照舊 */
  const putLocal = (sid: string, cueId: string, mechId: string, value: number | null, timing?: { delaySec: number | null; durationSec: number | null }) => {
    setPositions(prev => {
      const base = prev && prev.songId === sid ? prev.list : [];
      const old = base.find(p => p.cueId === cueId && p.mechanismId === mechId);
      const rest = base.filter(p => p !== old);
      const mode = prev?.mode ?? 'legacy';
      if (value === null) return { songId: sid, list: rest, mode };
      const t = timing ?? { delaySec: old?.delaySec ?? null, durationSec: old?.durationSec ?? null };
      return { songId: sid, list: [...rest, { cueId, mechanismId: mechId, value, ...t, updatedAt: '' }], mode };
    });
    // Cue 庫模式：同一個 Cue 庫的 cue 可能有好幾個 cue 在用，存完重新讀一次才會每一列都對（舊模式不用）
    if (posRef.current?.mode === 'library') void refreshPositions();
  };
  const ownEntry = (cueId: string, mechId: string) => posRef.current?.list.find(x => x.cueId === cueId && x.mechanismId === mechId) ?? null;
  const ownValue = (cueId: string, mechId: string): number | null => {
    const p = posRef.current;
    return p?.list.find(x => x.cueId === cueId && x.mechanismId === mechId)?.value ?? null;
  };
  const mechById = (id: string) => mechsRef.current?.find(m => m.id === id) || null;
  const replaceMech = (m: Mechanism) => setMechanisms(prev => (prev ? prev.map(x => (x.id === m.id ? m : x)) : prev));

  const writeCue = useCallback(async (sid: string, cueId: string, mechId: string, value: number | null) => {
    if (!projectId) return;
    if (value === null) {
      await mapi.clearCuePosition(projectId, sid, cueId, mechId);
      putLocal(sid, cueId, mechId, null);
    } else {
      const r = await mapi.setCuePosition(projectId, sid, cueId, mechId, value);
      putLocal(sid, cueId, mechId, r.value);
    }
    // cueCount（設定清單「幾個 cue 有設定」）跟著更新
    setMechanisms(prev => prev && prev.map(m => (m.id !== mechId ? m : {
      ...m, cueCount: Math.max(0, m.cueCount + (value === null ? -1 : 0)),
    })));
  }, [projectId]);

  /** 存一個值：選了 cue → 這個 cue 的位置；沒選 cue → 預設位置。會記一步復原 */
  const commitValue = useCallback(async (mechId: string, raw: number) => {
    const m = mechById(mechId);
    if (!projectId || !m || !o.canEdit) return;
    const value = clampValue(raw, m.travelMin, m.travelMax);
    setPreview(p => { if (!(mechId in p)) return p; const n = { ...p }; delete n[mechId]; return n; });
    const scope = historyScope(selectedCueId);
    try {
      if (selectedCueId && (songId || libActive)) {
        const cueId = selectedCueId, sid = songId ?? '';
        const before = ownValue(cueId, mechId);
        if (before !== null && Math.abs(before - value) < 1e-9) return;
        if (libActive && libDraftRef.current) {
          const old = ownEntry(cueId, mechId);
          libDraftRef.current.set({ [mechId]: { value, delaySec: old?.carried ? null : old?.delaySec ?? null, durationSec: old?.carried ? null : old?.durationSec ?? null } });
          return;
        }
        const hadOwn = before !== null;
        if (!hadOwn) setMechanisms(prev => prev && prev.map(x => (x.id === mechId ? { ...x, cueCount: x.cueCount + 1 } : x)));
        await writeCue(sid, cueId, mechId, value);
        historyRef.current?.push(scope, {
          undo: async () => { await writeCue(sid, cueId, mechId, before); },
          redo: async () => {
            if (!hadOwn) setMechanisms(prev => prev && prev.map(x => (x.id === mechId ? { ...x, cueCount: x.cueCount + 1 } : x)));
            await writeCue(sid, cueId, mechId, value);
          },
        });
      } else {
        const before = m.defaultValue;
        if (Math.abs(before - value) < 1e-9) return;
        const setDefault = async (v: number) => {
          const r = await mapi.updateMechanism(projectId, mechId, { defaultValue: v });
          replaceMech(r.mechanism);
        };
        await setDefault(value);
        historyRef.current?.push(scope, { undo: () => setDefault(before), redo: () => setDefault(value) });
      }
      historyRef.current?.bump();
    } catch (e) {
      toast.error('機關位置沒有存到：' + (e instanceof Error ? e.message : String(e)));
      void refreshPositions();
    }
  }, [projectId, songId, selectedCueId, o.canEdit, writeCue, refreshPositions, libActive]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 回到沿用上一個 cue（刪掉這個 cue 自己的值） */
  const clearValue = useCallback(async (mechId: string) => {
    if (!projectId || !selectedCueId || (!songId && !libActive) || !o.canEdit) return;
    const cueId = selectedCueId, sid = songId ?? '';
    const before = ownValue(cueId, mechId);
    if (before === null) return;
    if (libActive && libDraftRef.current) { libDraftRef.current.set({ [mechId]: null }); return; }
    try {
      await writeCue(sid, cueId, mechId, null);
      historyRef.current?.push(historyScope(cueId), {
        undo: async () => {
          setMechanisms(prev => prev && prev.map(x => (x.id === mechId ? { ...x, cueCount: x.cueCount + 1 } : x)));
          await writeCue(sid, cueId, mechId, before);
        },
        redo: async () => { await writeCue(sid, cueId, mechId, null); },
      });
      historyRef.current?.bump();
    } catch (e) {
      toast.error('沒有改回沿用：' + (e instanceof Error ? e.message : String(e)));
      void refreshPositions();
    }
  }, [projectId, songId, selectedCueId, o.canEdit, writeCue, refreshPositions, libActive]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 存某個 cue 某個機關的延遲 / 走幾秒（機關時間軸拖完、這個 cue 的欄位打完）。null = 跟著 cue；沒放的欄位不改。
   * 這個 cue 還沒有自己的位置 → 用沿用來的值一起存（畫面不會變）；復原時整列刪掉回到沿用。
   */
  const commitTiming = useCallback(async (cueId: string, mechId: string, patch: { delaySec?: number | null; durationSec?: number | null }) => {
    const sid = songId ?? '';
    if (!projectId || (!sid && !libActive) || !o.canEdit) return;
    const own = ownEntry(cueId, mechId);
    const before = { delaySec: own?.delaySec ?? null, durationSec: own?.durationSec ?? null };
    const after = {
      delaySec: patch.delaySec !== undefined ? patch.delaySec : before.delaySec,
      durationSec: patch.durationSec !== undefined ? patch.durationSec : before.durationSec,
    };
    if (own && after.delaySec === before.delaySec && after.durationSec === before.durationSec) return;
    const inherited = pb.resolved.get(cueId)?.[mechId]?.value;
    if (!own && inherited === undefined) return;
    if (libActive && libDraftRef.current) {
      if (cueId !== selectedCueId) { toast.info('先選這個 cue 才能改它的機關時間'); return; }
      libDraftRef.current.set({ [mechId]: { value: own ? own.value : inherited!, delaySec: after.delaySec, durationSec: after.durationSec } });
      return;
    }
    const write = async (t: { delaySec: number | null; durationSec: number | null }) => {
      const body = ownEntry(cueId, mechId) ? t : { ...t, value: inherited };
      const r = await mapi.setCueTiming(projectId, sid, cueId, mechId, body);
      putLocal(sid, cueId, mechId, r.value, { delaySec: r.delaySec, durationSec: r.durationSec });
    };
    const bumpCount = (d: number) => setMechanisms(prev => prev && prev.map(x => (x.id === mechId ? { ...x, cueCount: Math.max(0, x.cueCount + d) } : x)));
    try {
      if (!own) bumpCount(1);
      await write(after);
      historyRef.current?.push(historyScope(cueId), {
        undo: async () => {
          if (own) await write(before);
          else { await mapi.clearCuePosition(projectId, sid, cueId, mechId); putLocal(sid, cueId, mechId, null); bumpCount(-1); }
        },
        redo: async () => { if (!own) bumpCount(1); await write(after); },
      });
      historyRef.current?.bump();
    } catch (e) {
      toast.error('機關的時間沒有存到：' + (e instanceof Error ? e.message : String(e)));
      void refreshPositions();
    }
  }, [projectId, songId, o.canEdit, pb.resolved, refreshPositions, libActive, selectedCueId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 一次存很多個機關在這個 cue 的位置和延遲（套用花樣）；整批一個交易，復原也是一步。
   * delaySec 沒放 = 不動延遲（第一個 cue 沒有「走過來」，花樣不設延遲）；null = 清掉（跟著 cue）。
   * 回 true = 存好了
   */
  const applyPositions = useCallback(async (cueId: string, items: { mechanismId: string; value: number; delaySec?: number | null }[]): Promise<boolean> => {
    const sid = songId ?? '';
    if (!projectId || (!sid && !libActive) || !o.canEdit || items.length === 0) return false;
    if (libActive && libDraftRef.current) {
      if (cueId !== selectedCueId) { toast.info('先選這個 cue 才能改它的機關'); return false; }
      const entries: Record<string, DraftMech | null> = {};
      for (const it of items) {
        const old = ownEntry(cueId, it.mechanismId);
        const keep = old && !old.carried ? old : null;
        entries[it.mechanismId] = {
          value: it.value,
          delaySec: it.delaySec === undefined ? (keep?.delaySec ?? null) : it.delaySec,
          durationSec: keep?.durationSec ?? null,
        };
      }
      libDraftRef.current.set(entries);
      return true;
    }
    const before = items.map(it => ownEntry(cueId, it.mechanismId));
    const forward: BulkPositionItem[] = items.map(it => (it.delaySec === undefined
      ? { mechanismId: it.mechanismId, value: it.value }
      : { mechanismId: it.mechanismId, value: it.value, delaySec: it.delaySec }));
    const backward: BulkPositionItem[] = items.map((it, i) => {
      const b = before[i];
      return b ? { mechanismId: it.mechanismId, value: b.value, delaySec: b.delaySec ?? null, durationSec: b.durationSec ?? null } : { mechanismId: it.mechanismId, value: null };
    });
    const fresh = new Set(items.filter((_, i) => !before[i]).map(it => it.mechanismId));
    const bumpCounts = (d: number) => {
      if (fresh.size === 0) return;
      setMechanisms(prev => prev && prev.map(x => (fresh.has(x.id) ? { ...x, cueCount: Math.max(0, x.cueCount + d) } : x)));
    };
    const run = async (list: BulkPositionItem[]) => {
      const res = await mapi.setCuePositionsBulk(projectId, sid, cueId, list);
      for (const r of res) {
        if (r.removed) putLocal(sid, cueId, r.mechanismId, null);
        else putLocal(sid, cueId, r.mechanismId, r.value ?? 0, { delaySec: r.delaySec ?? null, durationSec: r.durationSec ?? null });
      }
    };
    try {
      bumpCounts(1);
      try { await run(forward); } catch (e) { bumpCounts(-1); throw e; }
      historyRef.current?.push(historyScope(cueId), {
        undo: async () => { await run(backward); bumpCounts(-1); },
        redo: async () => { bumpCounts(1); await run(forward); },
      });
      historyRef.current?.bump();
      return true;
    } catch (e) {
      toast.error('花樣沒有存到：' + (e instanceof Error ? e.message : String(e)));
      void refreshPositions();
      return false;
    }
  }, [projectId, songId, o.canEdit, refreshPositions, libActive, selectedCueId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 套用花樣前的預覽：一次讓好幾個機關在 3D 畫面移到指定位置（不存）；null = 取消預覽 */
  const previewValues = useCallback((values: MechanismValues | null) => setPreview(values ? { ...values } : {}), []);

  // ── 機關時間軸：拉時間尺 / 播放時，3D 畫面的機關跟著時間軸（物件停在目前選的 cue）──
  // 只寫 ref，不重畫 React；StageScene 每幀問 mechanismAtFrame
  const previewTimeRef = useRef<number | null>(null);
  const setPreviewTime = useCallback((t: number | null) => { previewTimeRef.current = t; }, []);
  const editorAtFrame = useCallback((): MechanismValues | null => {
    const t = previewTimeRef.current;
    const tl = timelineRef.current;
    return t !== null && tl ? tl.valuesAt(t) : null;
  }, []);

  /** 拖滑桿時邊拖邊看（不存）；null = 取消預覽 */
  const previewValue = useCallback((mechId: string, value: number | null) => {
    setPreview(p => {
      if (value === null) { if (!(mechId in p)) return p; const n = { ...p }; delete n[mechId]; return n; }
      return { ...p, [mechId]: value };
    });
  }, []);

  // ── 定義 ──
  const create = useCallback(async (input: mapi.MechanismPayload) => {
    if (!projectId) throw new Error('no project');
    const m = await mapi.createMechanism(projectId, input);
    await refreshDefs();
    return m;
  }, [projectId, refreshDefs]);
  const update = useCallback(async (mechId: string, patch: mapi.MechanismPayload) => {
    if (!projectId) throw new Error('no project');
    const r = await mapi.updateMechanism(projectId, mechId, patch);
    // 物件被移走的別的機關也要更新 → 整個重讀
    // 整組吊掛換了吊點（新增 / 刪除 / 改位置）：吊點和它們的位置都可能變 → 一起重讀
    if (patch.hoists) await Promise.all([refreshDefs(), refreshPositions()]);
    else if (patch.objectIds) await refreshDefs(); else replaceMech(r.mechanism);
    return r;
  }, [projectId, refreshDefs, refreshPositions]);
  const remove = useCallback(async (mechId: string) => {
    if (!projectId) throw new Error('no project');
    const r = await mapi.deleteMechanism(projectId, mechId);
    setFocusedId(f => (f === mechId ? null : f));
    await Promise.all([refreshDefs(), refreshPositions()]);
    return r;
  }, [projectId, refreshDefs, refreshPositions]);
  /** 一次建立 N 個機關（一排）；物件已經在別的機關 → 丟 409，問過後帶 moveObjects 再送 */
  const createBatch = useCallback(async (input: mapi.BatchPayload) => {
    if (!projectId) throw new Error('no project');
    const r = await mapi.createMechanismBatch(projectId, input);
    await refreshDefs();
    return r;
  }, [projectId, refreshDefs]);
  /** 改這一排的名字 / 共用設定（每個成員都改） */
  const updateGroup = useCallback(async (groupId: string, patch: mapi.GroupPatch) => {
    if (!projectId) throw new Error('no project');
    const r = await mapi.updateMechanismGroup(projectId, groupId, patch);
    await refreshDefs();
    return r;
  }, [projectId, refreshDefs]);
  /** 解散（機關留著）或連同機關一起刪掉 */
  const removeGroup = useCallback(async (groupId: string, dissolve: boolean) => {
    if (!projectId) throw new Error('no project');
    const r = await mapi.deleteMechanismGroup(projectId, groupId, dissolve);
    setFocusedId(null);
    await Promise.all([refreshDefs(), refreshPositions()]);
    return r;
  }, [projectId, refreshDefs, refreshPositions]);
  const reorder = useCallback(async (ids: string[]) => {
    if (!projectId) return;
    setMechanisms(prev => prev && ids.map(id => prev.find(m => m.id === id)!).filter(Boolean).map((m, i) => ({ ...m, order: i })));
    try { await mapi.reorderMechanisms(projectId, ids); }
    catch (e) { toast.error('排序沒有存到：' + (e instanceof Error ? e.message : String(e))); void refreshDefs(); }
  }, [projectId, refreshDefs]);

  const sceneProps: MechanismSceneProps = useMemo(() => ({
    mechanisms, mechanismTargets: targets, focusedMechanismId: focusedId, sceneQueryRef,
    mechanismMotion: 'transition' as MechanismMotion,
    mechanismTimings: pb.selectedTimings, mechanismAtFrame: editorAtFrame, mechanismFrameAlways: true,
  }), [mechanisms, targets, focusedId, pb.selectedTimings, editorAtFrame]);

  return {
    status, mechanisms: mechanisms || EMPTY_MECHS, positions: list, resolved: pb.resolved, selectedRow: pb.selectedRow,
    targets, check, preview, focusedId, setFocusedId, sceneQueryRef,
    commitValue, clearValue, previewValue, create, update, remove, reorder,
    /** 一排機關（v2 第 3 階段）：分組、一次建立、共用設定、花樣（一次存很多個位置）、花樣預覽 */
    groups, createBatch, updateGroup, removeGroup, applyPositions, previewValues,
    /** 吊掛（v2 第 4 階段）：每一組的吊點資料、每個 cue 的傾斜和說明 */
    hoistRigs, hoistChecks,
    /** 延遲 / 走幾秒（v2）、機關時間軸 */
    commitTiming, timings: pb.timings, timeline, libraryCues: libView?.cues ?? null, setPreviewTime, previewTimeRef, timelineOpen, setTimelineOpen,
    refreshDefs, refreshPositions, sceneProps,
    /** 目前 cue 的機關值（從目前 3D 畫面建立 cue 時一起存） */
    currentValues: pb.targets,
    /** 機關位置是哪首歌的（換歌後還沒讀到 = 上一首 / null） */
    positionsSongId: positions?.songId ?? null,
  };
}

const EMPTY_MECHS: Mechanism[] = [];
const EMPTY_GROUPS: MechanismGroup[] = [];

export type EditorMechanisms = ReturnType<typeof useEditorMechanisms>;
