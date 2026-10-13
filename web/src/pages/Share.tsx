import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, SharePublicData, ShareVideo } from '../lib/api';
import StageScene from '../components/StageScene';
import { normalizeLookSettings } from '../lib/stageLook/lookSettings';
import { normalizeMaterialOverrides } from '../lib/stageLook/materialOverrides';
import { normalizeHomeView } from '../lib/homeView';
import { formatClock, useLocalVideo } from '../lib/localVideo';
import { usePersonalLook } from '../lib/stageLook/personalLook';
import { cueAtTime, cueTransitionSeconds } from '../lib/cueTiming';
import { cuePoses, cueWindows, poseAtTime, type CuePoseMap, type CueWindow } from '../lib/cueTimeline';
import type { NdiClientStatus } from '../lib/ndiClient';
import { NDI_HELPER_DOWNLOAD_URL, NDI_TOOLS_URL } from '../lib/downloads';
import './Share.css';

/** LED 畫面來源：AE 即時（NDI 小程序）或本地影片（拖進來的檔案，只在這台電腦播） */
type LedSource = 'ndi' | 'video';

/** 這首歌每個 cue 的舞台位置先全部開始抓（點 cue / 影片走到那裡時馬上有） */
function prefetchCueStates(token: string, songId: string, list: Cue[], pwd: string | undefined) {
  const cache = new Map<string, Promise<CueState[]>>();
  for (const c of list) {
    const p = api.getShareCueStates(token, songId, c.id, pwd);
    p.catch(() => cache.delete(c.id));  // 失敗就丟掉，用到時再抓一次
    cache.set(c.id, p);
  }
  return cache;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 公開分享連結 viewer — 無需登入。
 * 路由：/share/:token
 * 動畫師拿到這個連結：開著 AE → LED 顯示 AE 即時畫面；沒開 AE → 拖影片進來播在 LED 上
 */
export default function Share() {
  const { token } = useParams();
  const [data, setData] = useState<SharePublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [submittedPwd, setSubmittedPwd] = useState<string | null>(null);

  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [cueStates, setCueStates] = useState<CueState[]>([]);
  const [videos, setVideos] = useState<ShareVideo[]>([]);
  const [selectedVideoFid, setSelectedVideoFid] = useState<string | null>(null);

  // ── LED 畫面來源 ──
  const local = useLocalVideo();
  const [source, setSource] = useState<LedSource>('ndi');
  const [ndiStatus, setNdiStatus] = useState<NdiClientStatus>({ kind: 'idle' });
  // 剛打開 / 剛切到 AE 時給一點時間連線，連不上才顯示安裝步驟
  const [ndiGraceOver, setNdiGraceOver] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastAutoCueRef = useRef<string | null>(null);
  // 這首歌每個 cue 的舞台位置先全部抓好 → 點 cue 馬上開始動，不用等網路
  const cueStatesCacheRef = useRef<Map<string, Promise<CueState[]>>>(new Map());
  // 分頁切回來重抓 cue 時 +1 → 舞台位置、影片時間軸跟著換新的
  const [cueRefresh, setCueRefresh] = useState(0);
  // 影片時間軸：有影片時間的 cue 的移動時段 + 每個 cue 的物件位置（先算好，每幀直接拿）
  const timelineRef = useRef<{ windows: CueWindow[]; poses: Map<string, CuePoseMap>; timedIds: Set<string> } | null>(null);
  // 每幀要讀的值（不經過 React）
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const videoReadyRef = useRef(local.ready);
  videoReadyRef.current = local.ready;
  const selectedCueIdRef = useRef(selectedCueId);
  selectedCueIdRef.current = selectedCueId;

  // 切到 AE 即時 → 本地影片先暫停（不然聲音還會在背景播）
  useEffect(() => {
    if (source === 'ndi') local.video.pause();
  }, [source, local.video]);

  useEffect(() => {
    setNdiGraceOver(false);
    if (source !== 'ndi') return;
    const t = window.setTimeout(() => setNdiGraceOver(true), 3000);
    return () => window.clearTimeout(t);
  }, [source]);

  const openFile = useCallback((file: File | undefined | null) => {
    if (!file) return;
    if (local.load(file)) setSource('video');
  }, [local]);

  const load = useCallback(async (pwd?: string) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const d = await api.getSharePublicData(token, pwd);
      setData(d);
      setRequiresPassword(false);
      const firstSong = d.songs[0];
      if (firstSong) setSelectedSongId(firstSong.id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      const reqPwd = (e as { requiresPassword?: boolean }).requiresPassword;
      if (status === 401 && reqPwd) {
        setRequiresPassword(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // 切歌 → 拉 cues + videos
  useEffect(() => {
    if (!token || !selectedSongId) return;
    let cancelled = false;
    const pwd = submittedPwd ?? undefined;
    cueStatesCacheRef.current = new Map();
    timelineRef.current = null;  // 上一首歌的時間軸不要套到這首
    api.getShareSongCues(token, selectedSongId, pwd).then(list => {
      if (cancelled) return;
      cueStatesCacheRef.current = prefetchCueStates(token, selectedSongId, list, pwd);
      lastAutoCueRef.current = null;  // 新的一首歌 → 影片時間重新對 cue
      setCues(list);
      setSelectedCueId(list[0]?.id ?? null);
    }).catch(() => { if (!cancelled) setCues([]); });
    api.getShareSongVideos(token, selectedSongId, pwd).then(list => {
      if (cancelled) return;
      setVideos(list);
      setSelectedVideoFid(list[0]?.driveFileId ?? null);
    }).catch(() => { if (!cancelled) setVideos([]); });
    return () => { cancelled = true; };
  }, [token, selectedSongId, submittedPwd]);

  // 分頁切回來 → 重抓這首歌的 cue 和位置（管理頁改了淡入淡出 / 對應影片時間，不用重新整理就跟上）
  // 現在選的 cue 和正在播的影片都不動
  useEffect(() => {
    if (!token || !selectedSongId) return;
    let cancelled = false;
    let lastTs = 0;
    const pwd = submittedPwd ?? undefined;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastTs < 2000) return;  // 切分頁時 visibilitychange 和 focus 會一起來
      lastTs = now;
      api.getShareSongCues(token, selectedSongId, pwd).then(list => {
        if (cancelled) return;
        cueStatesCacheRef.current = prefetchCueStates(token, selectedSongId, list, pwd);
        setCues(prev => sameJson(prev, list) ? prev : list);
        setSelectedCueId(prev => (prev && list.some(c => c.id === prev)) ? prev : (list[0]?.id ?? null));
        setCueRefresh(n => n + 1);
      }).catch(() => { /* 網路一時不通就下次再抓 */ });
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [token, selectedSongId, submittedPwd]);

  // 切 cue → 拉 states
  useEffect(() => {
    if (!token || !selectedSongId || !selectedCueId) { setCueStates([]); return; }
    let cancelled = false;  // 連點好幾個 cue 時，只套最後點的那個
    const cache = cueStatesCacheRef.current;
    let p = cache.get(selectedCueId);
    if (!p) {
      p = api.getShareCueStates(token, selectedSongId, selectedCueId, submittedPwd ?? undefined);
      cache.set(selectedCueId, p);
    }
    // 內容一樣就不換（分頁切回來重抓時，沒改的話舞台不用重算）
    p.then(list => { if (!cancelled) setCueStates(prev => sameJson(prev, list) ? prev : list); })
      .catch(() => { cache.delete(selectedCueId); if (!cancelled) setCueStates([]); });
    return () => { cancelled = true; };
  }, [token, selectedSongId, selectedCueId, submittedPwd, cueRefresh]);

  // 影片時間軸要用的：每個有影片時間的 cue 的物件位置（用先抓好的；全部到了才換上，換之前沿用舊的）
  useEffect(() => {
    const windows = cueWindows(cues);
    if (windows.length === 0) { timelineRef.current = null; return; }
    let cancelled = false;
    const cache = cueStatesCacheRef.current;
    Promise.all(windows.map(w => {
      const p = cache.get(w.cueId);
      return p ? p.then(states => [w.cueId, cuePoses(states)] as const, () => null) : null;
    })).then(entries => {
      if (cancelled) return;
      const poses = new Map<string, CuePoseMap>();
      for (const e of entries) if (e) poses.set(e[0], e[1]);
      timelineRef.current = { windows, poses, timedIds: new Set(windows.map(w => w.cueId)) };
    });
    return () => { cancelled = true; };
  }, [cues, cueRefresh]);

  // 沒選 cue 時用 default
  const viewportStates: CueState[] = useMemo(() => {
    if (selectedCueId && cueStates.length > 0) return cueStates;
    if (!data) return [];
    return data.stageObjects.map(o => ({
      objectId: o.id,
      meshName: o.meshName,
      displayName: o.displayName,
      category: o.category,
      order: o.order,
      locked: o.locked,
      default: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale },
      override: null,
      effective: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale, visible: true },
    }));
  }, [selectedCueId, cueStates, data]);

  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId), [cues, selectedCueId]);

  // 現場設定：專案預設 + 自己調過的（存在這台電腦，重新整理也會留著）
  const projectLook = useMemo(() => normalizeLookSettings(data?.lookSettings), [data]);
  const personalLook = usePersonalLook(data?.project.id, projectLook);
  const materialOverrides = useMemo(() => normalizeMaterialOverrides(data?.materialOverrides), [data]);
  const homeView = useMemo(() => normalizeHomeView(data?.homeView ?? null), [data]);

  // ── 本地影片播到某秒 → 自動切到對應 cue（cue 有設「對應影片時間」才會動）──
  // 只在「應該的 cue」改變時才切，手動點的 cue 會保留到影片進入下一段
  useEffect(() => {
    if (source !== 'video' || !local.fileName) return;
    const target = cueAtTime(cues, local.time);
    if (target && target !== lastAutoCueRef.current) {
      lastAutoCueRef.current = target;
      setSelectedCueId(target);
    }
  }, [source, local.fileName, local.time, cues]);

  // 手動點 cue → 有影片的話跳到那個 cue 的時間
  const selectCue = useCallback((cue: Cue) => {
    setSelectedCueId(cue.id);
    if (source === 'video' && local.fileName && cue.videoTimeSec != null) {
      lastAutoCueRef.current = cue.id;
      local.seek(cue.videoTimeSec);
    }
  }, [source, local]);

  // 播本地影片時，舞台每一幀照影片時間擺：cue 在「對應影片時間」剛好到位，提前「淡入淡出時間」等速出發。
  // 暫停就停在半路、拉時間軸就跟著退。AE 即時 / 沒影片 / 沒有 cue 設影片時間 / 點了沒設時間的 cue → null（照舊點 cue 滑過去）
  const poseAtFrame = useCallback((): CuePoseMap | null => {
    if (sourceRef.current !== 'video' || !videoReadyRef.current) return null;
    const tl = timelineRef.current;
    if (!tl) return null;
    const sel = selectedCueIdRef.current;
    if (sel && !tl.timedIds.has(sel)) return null;
    return poseAtTime(tl.windows, tl.poses, local.video.currentTime);
  }, [local.video]);

  if (loading) return <div className="share-loading">⏳ 載入中…</div>;

  if (requiresPassword) {
    return (
      <div className="share-pwd">
        <h1>🔒 此分享需要密碼</h1>
        <form onSubmit={(e) => { e.preventDefault(); setSubmittedPwd(password); load(password); }}>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="輸入分享密碼"
            autoFocus
          />
          <button type="submit" className="btn btn--primary">解鎖</button>
        </form>
      </div>
    );
  }

  if (error) {
    return (
      <div className="share-error">
        <h1>⚠ 分享連結無效</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="share">
      <header className="share-top">
        <span className="share-top__brand">🎬 STAGE PREVIZ</span>
        <span className="share-top__title">{data.project.name}</span>
        <span className="grow" />
        <span className="share-top__hint">公開預覽 · 唯讀</span>
      </header>

      <div className="share-body">
        {data.songs.length > 1 && !data.restrictedToSongId && (
          <aside className="share-songs">
            <div className="share-songs__title">歌曲</div>
            <ul>
              {data.songs.map(s => (
                <li key={s.id}>
                  <button
                    className={'share-songs__item' + (s.id === selectedSongId ? ' is-active' : '')}
                    onClick={() => setSelectedSongId(s.id)}
                  >{s.name}</button>
                </li>
              ))}
            </ul>
          </aside>
        )}

        <main
          className="share-stage"
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); openFile(e.dataTransfer.files?.[0]); }}
        >
          <div className="share-source">
            <div className="share-source__switch">
              <button className={source === 'ndi' ? 'is-active' : ''} onClick={() => setSource('ndi')}>🔴 AE 即時</button>
              <button className={source === 'video' ? 'is-active' : ''} onClick={() => setSource('video')}>🎬 本地影片</button>
            </div>
            <span className="share-source__status">
              {source === 'ndi'
                // 「已連上」= 小程序有回應；有沒有畫面進來看 3D 工具列的 NDI 標示（LIVE / 等待中）
                ? (ndiStatus.kind === 'connected'
                  ? `已連上 NDI 小程序${ndiStatus.source ? ` · 來源：${ndiStatus.source}` : '（還沒選來源）'}`
                  : ndiStatus.kind === 'connecting' ? '連線 NDI 小程序中…' : '沒偵測到 NDI 小程序')
                : (local.fileName ? `${local.playing ? '▶' : '⏸'} ${local.fileName}` : '還沒選影片')}
            </span>
            <span className="grow" />
            <button className="btn btn--ghost btn--sm" onClick={() => fileInputRef.current?.click()}>🎬 選擇影片…</button>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ''; }}
            />
          </div>

          {videos.length > 0 && selectedVideoFid && (
            <div className="share-video-pane">
              {videos.length > 1 && (
                <select
                  className="share-video-pane__select"
                  value={selectedVideoFid}
                  onChange={e => setSelectedVideoFid(e.target.value)}
                >
                  {videos.map((v, i) => (
                    <option key={v.driveFileId} value={v.driveFileId}>
                      {i === 0 ? '最新 · ' : `V${videos.length - i} · `}{v.filename}
                    </option>
                  ))}
                </select>
              )}
              <video
                key={selectedVideoFid}
                className="share-video"
                src={api.apiBase() + videos.find(v => v.driveFileId === selectedVideoFid)!.streamUrl}
                controls
                preload="metadata"
              />
            </div>
          )}
          {selectedSongId && data.stageObjects.length > 0 ? (
            <StageScene
              key={selectedSongId}
              states={viewportStates}
              stageObjects={data.stageObjects}
              selectedObjectIds={[]}
              onSelect={() => {}}
              onTransform={() => {}}
              cueName={selectedCue?.name}
              modelUrl={data.modelUrl ? api.apiBase() + data.modelUrl : null}
              readOnly
              defaultRenderMode="live"
              cueKey={selectedCueId}
              crossfadeSeconds={cueTransitionSeconds(selectedCue)}
              showScaleButton={false}
              scaleCorrection={data.scaleCorrection ?? 1}
              mechanismOffsets={data.mechanismOffsets}
              lookSettings={personalLook.effective}
              onLookSettingsChange={personalLook.set}
              lookCustomized={personalLook.customized}
              onLookReset={personalLook.reset}
              materialOverrides={materialOverrides}
              homeView={homeView}
              enableNdi={source === 'ndi'}
              onNdiStatus={setNdiStatus}
              ledVideo={source === 'video' && local.ready ? local.video : null}
              poseAtFrame={poseAtFrame}
            />
          ) : (
            <div className="share-empty">這個專案沒有可預覽的內容</div>
          )}

          {/* 拖檔提示 / AE 安裝步驟 / 選影片提示 / 播放錯誤 */}
          {dragOver && (
            <div className="share-overlay share-overlay--drop">放開，影片會播在 LED 上（只在這台電腦播，不會上傳）</div>
          )}
          {!dragOver && source === 'ndi' && ndiGraceOver && ndiStatus.kind !== 'connected' && (
            <div className="share-overlay">
              <strong>要在 LED 上看 AE 即時畫面</strong>
              <ol>
                <li>安裝 <a href={NDI_TOOLS_URL} target="_blank" rel="noreferrer">NDI Tools</a>（官方免費）</li>
                <li>下載並打開 NDI 小程序：<a className="btn btn--sm" href={NDI_HELPER_DOWNLOAD_URL}>⬇ 下載安裝檔</a></li>
                <li>AE 的「視訊預覽」輸出選 NDI（NDI Tools 裡的 Adobe 外掛）</li>
              </ol>
              <span className="share-overlay__hint">接上後這裡會自動變成 LIVE。沒有 AE？按上面「🎬 本地影片」把影片拖進來。</span>
            </div>
          )}
          {!dragOver && source === 'video' && !local.fileName && !local.error && (
            <div className="share-overlay">
              <strong>把影片拖進來，或按「🎬 選擇影片…」</strong>
              <span>影片會直接播在 LED 上，只在這台電腦播，不會上傳。</span>
              <span className="share-overlay__hint">影片要是跟 AE 送 NDI 時一樣的整張畫布，才會對到每一片 LED。</span>
            </div>
          )}
          {!dragOver && source === 'video' && local.error && (
            <div className="share-overlay share-overlay--error">
              <strong>⚠ {local.error}</strong>
            </div>
          )}

          {source === 'video' && local.fileName && (
            <div className="share-player">
              <button className="share-player__btn" onClick={local.togglePlay} title={local.playing ? '暫停' : '播放'}>
                {local.playing ? '⏸' : '▶'}
              </button>
              <span className="share-player__time">{formatClock(local.time)} / {formatClock(local.duration)}</span>
              <input
                className="share-player__seek"
                type="range" min={0} max={local.duration || 0} step={0.01}
                value={Math.min(local.time, local.duration || 0)}
                onChange={(e) => local.seek(parseFloat(e.target.value))}
              />
              <button
                className={'share-player__btn' + (local.loop ? ' is-active' : '')}
                onClick={() => local.setLoop(!local.loop)}
                title={local.loop ? '循環播放：開' : '循環播放：關'}
              >🔁</button>
              <button className="share-player__btn" onClick={() => local.setMuted(!local.muted)} title={local.muted ? '開聲音' : '靜音'}>
                {local.muted ? '🔇' : '🔊'}
              </button>
              <span className="share-player__name" title={local.fileName}>{local.fileName}</span>
              <button className="share-player__btn" onClick={local.clear} title="移除這支影片">✕</button>
            </div>
          )}

          {cues.length > 0 && (
            <div className="share-cuebar">
              {cues.map((c, i) => (
                <button
                  key={c.id}
                  className={'share-cuebar__cue' + (c.id === selectedCueId ? ' is-active' : '')}
                  onClick={() => selectCue(c)}
                  title={c.videoTimeSec != null ? `影片 ${formatClock(c.videoTimeSec)}` : undefined}
                >
                  <span className="share-cuebar__num">{i + 1}</span>
                  <span className="share-cuebar__name">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
