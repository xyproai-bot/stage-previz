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
import { useLiveRefresh } from '../liveRefresh';
import { toast } from '../toast';
import { clampValue, type CueMechanismPosition, type Mechanism, type MechanismValues } from './model';
import { defaultRow, ownValuesByCue, resolveSongMechanisms, valuesOf, type ResolvedRow } from './track';
import { buildMechanismTimeline, checkSongMechanisms, sortMasters, type MechanismTimeline, type MotionCue, type SongCheck } from './motion';
import * as mapi from './mechanismApi';
import type { StageSceneQuery } from '../../components/StageScene';

export interface MechanismSceneProps {
  mechanisms: Mechanism[] | null;
  mechanismTargets: MechanismValues;
  mechanismAtFrame?: () => MechanismValues | null;
  focusedMechanismId?: string | null;
  sceneQueryRef?: React.MutableRefObject<StageSceneQuery | null>;
}

type CueLike = MotionCue & { name?: string };

/** 位置清單 + 定義 + cue → 每個 cue 的位置、目前 cue 的目標、影片時間軸 */
function usePlayback(
  mechanisms: Mechanism[] | null,
  positions: CueMechanismPosition[],
  cues: CueLike[],
  selectedCueId: string | null,
  video?: HTMLVideoElement | null,
) {
  const resolved = useMemo(
    () => (mechanisms ? resolveSongMechanisms(mechanisms, cues, ownValuesByCue(positions)) : new Map<string, ResolvedRow>()),
    [mechanisms, cues, positions],
  );
  const selectedRow = useMemo<ResolvedRow>(() => {
    if (!mechanisms) return {};
    return (selectedCueId && resolved.get(selectedCueId)) || defaultRow(mechanisms);
  }, [mechanisms, resolved, selectedCueId]);
  const targets = useMemo(() => valuesOf(selectedRow), [selectedRow]);

  // 影片時間軸（只有正式 cue、有設影片時間的）；每幀 StageScene 問 mechanismAtFrame
  const timeline = useMemo<MechanismTimeline | null>(() => {
    if (!mechanisms || mechanisms.length === 0) return null;
    const masters = sortMasters(cues);
    return buildMechanismTimeline(mechanisms, masters, id => {
      const row = resolved.get(id);
      return row ? valuesOf(row) : null;
    });
  }, [mechanisms, cues, resolved]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const videoRef = useRef(video);
  videoRef.current = video;
  const mechanismAtFrame = useCallback((): MechanismValues | null => {
    const tl = timelineRef.current;
    const v = videoRef.current;
    return tl && v ? tl.valuesAt(v.currentTime) : null;
  }, []);
  return { resolved, selectedRow, targets, timeline, mechanismAtFrame };
}

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
}) {
  const { projectId, songId } = o;
  const [mechanisms, setMechanisms] = useState<Mechanism[] | null>(null);
  const [positions, setPositions] = useState<{ songId: string; list: CueMechanismPosition[] } | null>(null);
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const loadDefs = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await mapi.listMechanisms(projectId);
      setMechanisms(prev => (prev && sameJson(prev, list) ? prev : list));
    } catch {
      setMechanisms(prev => prev ?? []);  // 讀不到（舊後台 / 網路）→ 沒有機關，畫面照舊
    }
  }, [projectId]);
  const loadPositions = useCallback(async () => {
    if (!projectId || !songId) return;
    try {
      const list = await mapi.listSongPositions(projectId, songId);
      setPositions(prev => (prev && prev.songId === songId && sameJson(prev.list, list) ? prev : { songId, list }));
    } catch { /* 下次自動更新再試 */ }
  }, [projectId, songId]);

  useEffect(() => { setMechanisms(null); void loadDefs(); }, [loadDefs]);
  useEffect(() => { void loadPositions(); }, [loadPositions]);
  // 製作改了機關 → 30 秒內跟上（跟位置、留言一樣）
  useLiveRefresh(async () => { await Promise.all([loadDefs(), loadPositions()]); });

  const list = positions && positions.songId === songId ? positions.list : EMPTY_POSITIONS;
  const pb = usePlayback(mechanisms, list, o.cues, o.selectedCueId, o.video);
  const sceneProps: MechanismSceneProps = useMemo(() => ({
    mechanisms, mechanismTargets: pb.targets, mechanismAtFrame: pb.mechanismAtFrame,
  }), [mechanisms, pb.targets, pb.mechanismAtFrame]);
  return { mechanisms, sceneProps, timeline: pb.timeline };
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
  const [positions, setPositions] = useState<{ songId: string; list: CueMechanismPosition[] } | null>(null);
  useEffect(() => {
    if (!shareRef || !songId || !mechanisms || mechanisms.length === 0) return;
    let cancelled = false;
    mapi.getShareSongPositions(shareRef, songId, accessToken ?? undefined)
      .then(list => {
        if (cancelled) return;
        setPositions(prev => (prev && prev.songId === songId && JSON.stringify(prev.list) === JSON.stringify(list) ? prev : { songId, list }));
      })
      .catch(() => { /* 舊後台 / 網路：機關停在預設位置 */ });
    return () => { cancelled = true; };
  }, [shareRef, songId, accessToken, mechanisms, o.refreshKey]);
  const list = positions && positions.songId === songId ? positions.list : EMPTY_POSITIONS;
  const pb = usePlayback(mechanisms, list, o.cues, o.selectedCueId, o.video);
  const sceneProps: MechanismSceneProps = useMemo(() => ({
    mechanisms, mechanismTargets: pb.targets, mechanismAtFrame: pb.mechanismAtFrame,
  }), [mechanisms, pb.targets, pb.mechanismAtFrame]);
  return { mechanisms, sceneProps, timeline: pb.timeline };
}

// ─────────────────────────────────────────────
// 分鏡縮圖：每個 cue 的機關位置（直接到位）
// ─────────────────────────────────────────────

export function useSongMechanismTable(projectId: string | undefined, songId: string | null, cues: CueLike[]) {
  const st = useStageMechanisms({ projectId, songId, cues, selectedCueId: null });
  return st;
}

// ─────────────────────────────────────────────
// 管理頁（製作）
// ─────────────────────────────────────────────

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
}) {
  const { projectId, songId, selectedCueId } = o;
  const [mechanisms, setMechanisms] = useState<Mechanism[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [positions, setPositions] = useState<{ songId: string; list: CueMechanismPosition[] } | null>(null);
  // 拖滑桿時的預覽（還沒存）：mechId → value
  const [preview, setPreview] = useState<MechanismValues>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const sceneQueryRef = useRef<StageSceneQuery | null>(null);
  const mechsRef = useRef<Mechanism[] | null>(null);
  mechsRef.current = mechanisms;
  const posRef = useRef(positions);
  posRef.current = positions;
  const historyRef = useRef(o.history);
  historyRef.current = o.history;

  const refreshDefs = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await mapi.listMechanisms(projectId);
      setMechanisms(list);
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
      const list = await mapi.listSongPositions(projectId, songId);
      setPositions({ songId, list });
    } catch (e) {
      console.warn('[mechanisms] positions failed', e);
    }
  }, [projectId, songId]);

  useEffect(() => { setStatus('loading'); setMechanisms(null); void refreshDefs(); }, [refreshDefs]);
  // 換歌 / cue 清單變了（新增、沿用、刪除 cue 時後台會複製 / 刪掉位置）→ 重新讀
  useEffect(() => { void refreshPositions(); }, [refreshPositions, o.cues]);
  useEffect(() => { setPreview({}); }, [selectedCueId, songId]);

  const list = positions && positions.songId === songId ? positions.list : EMPTY_POSITIONS;
  const pb = usePlayback(mechanisms, list, o.cues, selectedCueId);
  const targets = useMemo(() => {
    const keys = Object.keys(preview);
    return keys.length ? { ...pb.targets, ...preview } : pb.targets;
  }, [pb.targets, preview]);
  const check = useMemo<SongCheck | null>(
    () => (mechanisms && mechanisms.length ? checkSongMechanisms(mechanisms, o.cues, pb.resolved) : null),
    [mechanisms, o.cues, pb.resolved],
  );

  // ── 本地更新（存成功後先套到畫面上） ──
  const putLocal = (sid: string, cueId: string, mechId: string, value: number | null) => {
    setPositions(prev => {
      const base = prev && prev.songId === sid ? prev.list : [];
      const rest = base.filter(p => !(p.cueId === cueId && p.mechanismId === mechId));
      return { songId: sid, list: value === null ? rest : [...rest, { cueId, mechanismId: mechId, value, updatedAt: '' }] };
    });
  };
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
      if (selectedCueId && songId) {
        const cueId = selectedCueId, sid = songId;
        const before = ownValue(cueId, mechId);
        if (before !== null && Math.abs(before - value) < 1e-9) return;
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
  }, [projectId, songId, selectedCueId, o.canEdit, writeCue, refreshPositions]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 回到沿用上一個 cue（刪掉這個 cue 自己的值） */
  const clearValue = useCallback(async (mechId: string) => {
    if (!projectId || !selectedCueId || !songId || !o.canEdit) return;
    const cueId = selectedCueId, sid = songId;
    const before = ownValue(cueId, mechId);
    if (before === null) return;
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
  }, [projectId, songId, selectedCueId, o.canEdit, writeCue, refreshPositions]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (patch.objectIds) await refreshDefs(); else replaceMech(r.mechanism);
    return r;
  }, [projectId, refreshDefs]);
  const remove = useCallback(async (mechId: string) => {
    if (!projectId) throw new Error('no project');
    const r = await mapi.deleteMechanism(projectId, mechId);
    setFocusedId(f => (f === mechId ? null : f));
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
  }), [mechanisms, targets, focusedId]);

  return {
    status, mechanisms: mechanisms || EMPTY_MECHS, positions: list, resolved: pb.resolved, selectedRow: pb.selectedRow,
    targets, check, preview, focusedId, setFocusedId, sceneQueryRef,
    commitValue, clearValue, previewValue, create, update, remove, reorder,
    refreshDefs, refreshPositions, sceneProps,
    /** 目前 cue 的機關值（從目前 3D 畫面建立 cue 時一起存） */
    currentValues: pb.targets,
    /** 這首歌有幾個 cue 的機關來不及到位 */
    problemCount: check?.problemCueIds.length ?? 0,
  };
}

const EMPTY_MECHS: Mechanism[] = [];

export type EditorMechanisms = ReturnType<typeof useEditorMechanisms>;
