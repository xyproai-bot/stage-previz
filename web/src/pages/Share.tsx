import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, SharePublicData, ShareRef, ShareVideo } from '../lib/api';
import StageScene from '../components/StageScene';
import { normalizeLookSettings } from '../lib/stageLook/lookSettings';
import { normalizeMaterialOverrides } from '../lib/stageLook/materialOverrides';
import { normalizeHomeView } from '../lib/homeView';
import { formatClock } from '../lib/localVideo';
import { skippedFilesMessage, useLocalMedia } from '../lib/localMedia';
import { toast } from '../lib/toast';
import { cueTransitionSeconds, videoCueSelection } from '../lib/cueTiming';
import { cuePoses, cueWindows, poseAtTime, type CuePoseMap, type CueWindow } from '../lib/cueTimeline';
import { ndiShortLabel, type NdiGuide } from '../lib/ndiSteps';
import ShareSetlist from './ShareSetlist';
import './Share.css';

/** LED 畫面來源：AE 即時（NDI 小程序）或本地檔案（拖進來的影片 / 圖片，只在這台電腦播） */
type LedSource = 'ndi' | 'file';

/** 這首歌每個 cue 的舞台位置先全部開始抓（點 cue / 影片走到那裡時馬上有） */
function prefetchCueStates(ref: ShareRef, songId: string, list: Cue[], pwd: string | undefined) {
  const cache = new Map<string, Promise<CueState[]>>();
  for (const c of list) {
    const p = api.getShareCueStates(ref, songId, c.id, pwd);
    p.catch(() => cache.delete(c.id));  // 失敗就丟掉，用到時再抓一次
    cache.set(c.id, p);
  }
  return cache;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 公開分享連結 viewer — 無需登入。
 * 路由：/share/:token（舊式網址）或 /s/:slug（好讀網址），畫面一模一樣
 * 動畫師拿到這個連結：開著 AE → LED 顯示 AE 即時畫面；沒開 AE → 拖影片 / 圖片進來放在 LED 上
 */
export default function Share() {
  const { token, slug } = useParams();
  // 用哪種網址打開的 → 後端就用那一種去查（好讀網址只查網址名稱、舊式只查連結碼）
  const shareRef = useMemo<ShareRef | null>(
    () => (slug ? { kind: 'slug', key: slug } : token ? { kind: 'token', key: token } : null),
    [slug, token],
  );
  const [data, setData] = useState<SharePublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [submittedPwd, setSubmittedPwd] = useState<string | null>(null);
  /** 密碼框下面的提示（密碼不對 / 錯太多次被擋） */
  const [pwdError, setPwdError] = useState<string | null>(null);

  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [cueStates, setCueStates] = useState<CueState[]>([]);
  const [videos, setVideos] = useState<ShareVideo[]>([]);
  const [selectedVideoFid, setSelectedVideoFid] = useState<string | null>(null);

  // ── LED 畫面來源 ──
  const media = useLocalMedia();
  const local = media.player;
  const [source, setSource] = useState<LedSource>('ndi');
  // AE 即時現在卡在哪一步（3D 畫面上的檢查清單卡片會帶著做；這裡只顯示一句狀態）
  const [ndiGuide, setNdiGuide] = useState<NdiGuide | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const lastAutoCueRef = useRef<string | null>(null);
  // 這首歌每個 cue 的舞台位置先全部抓好 → 點 cue 馬上開始動，不用等網路
  const cueStatesCacheRef = useRef<Map<string, Promise<CueState[]>>>(new Map());
  // 分頁切回來重抓 cue 時 +1 → 舞台位置、影片時間軸跟著換新的
  const [cueRefresh, setCueRefresh] = useState(0);
  // 影片時間軸：有影片時間的 cue 的移動時段 + 每個 cue 的物件位置（先算好，每幀直接拿）
  const timelineRef = useRef<{ windows: CueWindow[]; poses: Map<string, CuePoseMap>; timedIds: Set<string> } | null>(null);
  // 每幀要讀的值（不經過 React）
  // 正在 LED 上放本地影片（不是圖片 / AE）→ 影片時間軸、自動切 cue 才開
  const videoMode = source === 'file' && media.active?.kind === 'video' && !!local.fileName;
  const videoModeRef = useRef(videoMode);
  videoModeRef.current = videoMode;
  const videoReadyRef = useRef(local.ready);
  videoReadyRef.current = local.ready;
  const selectedCueIdRef = useRef(selectedCueId);
  selectedCueIdRef.current = selectedCueId;

  // 切到 AE 即時 → 本地影片先暫停（不然聲音還會在背景播）
  useEffect(() => {
    if (source === 'ndi') local.video.pause();
  }, [source, local.video]);

  // 拖進來 / 選的檔案加進清單，第一個馬上放在 LED 上；不是影片或圖片的略過
  const addFiles = useCallback((files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    const { rejected, shown } = media.add(Array.from(files));
    const skipped = skippedFilesMessage(rejected);
    if (skipped) toast.warn(skipped);
    if (shown) setSource('file');
  }, [media]);

  // 本地檔案：↑ / ↓ 換清單上一個 / 下一個（焦點在輸入框、拉桿、走路模式時不搶方向鍵）
  const stepMedia = media.step;
  useEffect(() => {
    if (source !== 'file') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || document.pointerLockElement) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (stepMedia(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, stepMedia]);

  const load = useCallback(async (pwd?: string) => {
    if (!shareRef) return;
    setLoading(true);
    setError(null);
    try {
      const d = await api.getSharePublicData(shareRef, pwd);
      setData(d);
      setRequiresPassword(false);
      setPwdError(null);
      const firstSong = d.songs[0];
      if (firstSong) setSelectedSongId(firstSong.id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      const reqPwd = (e as { requiresPassword?: boolean }).requiresPassword;
      if (status === 401 && reqPwd) {
        // 第一次打開（還沒輸入）不算錯；輸入了還是 401 = 密碼不對
        setRequiresPassword(true);
        setPwdError(pwd ? '密碼不對，再試一次' : null);
      } else if (status === 429 && !pwd) {
        // 沒帶密碼就被擋 = 這台電腦一直打開不存在的好讀網址，被擋一陣子 → 直接說原因
        setError(e instanceof Error && e.message && !e.message.startsWith('HTTP ') ? e.message : '請稍後再試');
      } else if (status === 429) {
        // 密碼錯太多次被擋一陣子：留在密碼畫面說明（不是連結壞了）
        setRequiresPassword(true);
        setPwdError(e instanceof Error && e.message && !e.message.startsWith('HTTP ') ? e.message : '錯太多次了，請稍後再試');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [shareRef]);

  useEffect(() => { load(); }, [load]);

  // 切歌 → 拉 cues + videos
  useEffect(() => {
    if (!shareRef || !selectedSongId) return;
    let cancelled = false;
    const pwd = submittedPwd ?? undefined;
    cueStatesCacheRef.current = new Map();
    timelineRef.current = null;  // 上一首歌的時間軸不要套到這首
    api.getShareSongCues(shareRef, selectedSongId, pwd).then(list => {
      if (cancelled) return;
      cueStatesCacheRef.current = prefetchCueStates(shareRef, selectedSongId, list, pwd);
      lastAutoCueRef.current = null;  // 新的一首歌 → 影片時間重新對 cue
      setCues(list);
      setSelectedCueId(list[0]?.id ?? null);
    }).catch(() => { if (!cancelled) setCues([]); });
    api.getShareSongVideos(shareRef, selectedSongId, pwd).then(list => {
      if (cancelled) return;
      setVideos(list);
      setSelectedVideoFid(list[0]?.driveFileId ?? null);
    }).catch(() => { if (!cancelled) setVideos([]); });
    return () => { cancelled = true; };
  }, [shareRef, selectedSongId, submittedPwd]);

  // 分頁切回來 → 重抓這首歌的 cue 和位置（管理頁改了淡入淡出 / 對應影片時間，不用重新整理就跟上）
  // 現在選的 cue 和正在播的影片都不動
  useEffect(() => {
    if (!shareRef || !selectedSongId) return;
    let cancelled = false;
    let lastTs = 0;
    const pwd = submittedPwd ?? undefined;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastTs < 2000) return;  // 切分頁時 visibilitychange 和 focus 會一起來
      lastTs = now;
      api.getShareSongCues(shareRef, selectedSongId, pwd).then(list => {
        if (cancelled) return;
        cueStatesCacheRef.current = prefetchCueStates(shareRef, selectedSongId, list, pwd);
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
  }, [shareRef, selectedSongId, submittedPwd]);

  // 切 cue → 拉 states
  useEffect(() => {
    if (!shareRef || !selectedSongId || !selectedCueId) { setCueStates([]); return; }
    let cancelled = false;  // 連點好幾個 cue 時，只套最後點的那個
    const cache = cueStatesCacheRef.current;
    let p = cache.get(selectedCueId);
    if (!p) {
      p = api.getShareCueStates(shareRef, selectedSongId, selectedCueId, submittedPwd ?? undefined);
      cache.set(selectedCueId, p);
    }
    // 內容一樣就不換（分頁切回來重抓時，沒改的話舞台不用重算）
    p.then(list => { if (!cancelled) setCueStates(prev => sameJson(prev, list) ? prev : list); })
      .catch(() => { cache.delete(selectedCueId); if (!cancelled) setCueStates([]); });
    return () => { cancelled = true; };
  }, [shareRef, selectedSongId, selectedCueId, submittedPwd, cueRefresh]);

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

  // 現場燈光：一律照專案預設（動畫師只看，不能調）
  const projectLook = useMemo(() => normalizeLookSettings(data?.lookSettings), [data]);
  const materialOverrides = useMemo(() => normalizeMaterialOverrides(data?.materialOverrides), [data]);
  const homeView = useMemo(() => normalizeHomeView(data?.homeView ?? null), [data]);

  // ── 本地影片播到某秒 → cue 列亮的跟著影片時間（cue 有設「對應影片時間」才會動）──
  // 亮的永遠跟舞台一致：舞台照時間軸擺時亮 cueAtTime；手動點了沒設時間的 cue → 舞台照那個 cue，
  // 留到影片走進下一段才回到時間軸（規則在 videoCueSelection）
  useEffect(() => {
    if (!videoMode) return;
    const next = videoCueSelection(cues, local.time, selectedCueId, lastAutoCueRef.current);
    lastAutoCueRef.current = next.targetId;
    if (next.selectedId !== selectedCueId) setSelectedCueId(next.selectedId);
  }, [videoMode, local.time, cues, selectedCueId]);

  // 手動點 cue → 有影片的話跳到那個 cue 的時間
  const selectCue = useCallback((cue: Cue) => {
    setSelectedCueId(cue.id);
    if (videoMode && cue.videoTimeSec != null) {
      lastAutoCueRef.current = cue.id;
      local.seek(cue.videoTimeSec);
    }
  }, [videoMode, local]);

  // 播本地影片時，舞台每一幀照影片時間擺：cue 在「對應影片時間」剛好到位，提前「淡入淡出時間」等速出發。
  // 暫停就停在半路、拉時間軸就跟著退。AE 即時 / 放圖片 / 沒影片 / 沒有 cue 設影片時間 / 點了沒設時間的 cue → null（照舊點 cue 滑過去）
  const poseAtFrame = useCallback((): CuePoseMap | null => {
    if (!videoModeRef.current || !videoReadyRef.current) return null;
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
        {pwdError && <p className="share-pwd__error" role="alert">{pwdError}</p>}
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

      {/* 檔案拖到頁面哪裡都收（左邊清單、舞台都可以）；清單裡拖曳排順序的不算（沒有 'Files'） */}
      <div
        className="share-body"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {/* 左邊欄：歌曲（多首歌才有）在上、本地檔案清單（選了本地檔案才有）在下；兩個都沒有 → 舞台吃滿寬度 */}
        {((data.songs.length > 1 && !data.restrictedToSongId) || source === 'file') && (
          <aside className="share-side">
            {data.songs.length > 1 && !data.restrictedToSongId && (
              <section className="share-songs">
                <div className="share-side__title">歌曲</div>
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
              </section>
            )}
            {source === 'file' && (
              <ShareSetlist
                items={media.items}
                activeId={media.active?.id ?? null}
                activePlaying={local.playing}
                activeDuration={local.duration}
                fileDragOver={dragOver}
                onSelect={media.select}
                onRemove={media.remove}
                onMove={media.move}
                onAddFiles={addFiles}
              />
            )}
          </aside>
        )}

        <main className="share-stage">
          <div className="share-source">
            <div className="share-source__switch">
              <button className={source === 'ndi' ? 'is-active' : ''} onClick={() => setSource('ndi')}>🔴 AE 即時</button>
              <button className={source === 'file' ? 'is-active' : ''} onClick={() => setSource('file')}>🎬 本地檔案</button>
            </div>
            <span className="share-source__status">
              {source === 'ndi'
                ? (!ndiGuide ? '連線中…'
                  : ndiGuide.step === 'live'
                  ? `● ${ndiGuide.source ?? 'AE'}${ndiGuide.fps != null ? ` · ${ndiGuide.fps} fps` : ''}`
                  : ndiShortLabel(ndiGuide))
                : media.active?.kind === 'video' ? `${local.playing ? '▶' : '⏸'} ${media.active.name}`
                : media.active ? `🖼 ${media.active.name}`
                : media.items.length > 0 ? '點清單裡的檔案，放到 LED 上' : '還沒選檔案'}
            </span>
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
              toolbarMode="viewer"
              cueKey={selectedCueId}
              crossfadeSeconds={cueTransitionSeconds(selectedCue)}
              scaleCorrection={data.scaleCorrection ?? 1}
              mechanismOffsets={data.mechanismOffsets}
              lookSettings={projectLook}
              materialOverrides={materialOverrides}
              homeView={homeView}
              enableNdi={source === 'ndi'}
              onNdiStatus={setNdiGuide}
              ndiGuide
              ndiGuideHint="沒有 AE？按上面「🎬 本地檔案」把影片或圖片拖進來"
              ledVideo={videoMode && local.ready ? local.video : null}
              ledImage={source === 'file' && media.active?.kind === 'image' ? media.image : null}
              poseAtFrame={poseAtFrame}
            />
          ) : (
            <div className="share-empty">這個專案沒有可預覽的內容</div>
          )}

          {/* 拖檔提示 / 選影片提示 / 播放錯誤（AE 即時的步驟在 3D 畫面上的卡片） */}
          {dragOver && (
            <div className="share-overlay share-overlay--drop">放開，影片 / 圖片會加進清單、放在 LED 上（只在這台電腦播，不會上傳）</div>
          )}
          {!dragOver && source === 'file' && media.items.length === 0 && (
            <div className="share-overlay">
              <strong>把影片或圖片拖進來，或按「＋ 加入影片 / 圖片…」</strong>
              <span>可以一次放好幾個，點清單裡的哪個，LED 就放哪個。只在這台電腦播，不會上傳。</span>
              <span className="share-overlay__hint">畫面要是跟 AE 送 NDI 時一樣的整張畫布，才會對到每一片 LED。</span>
            </div>
          )}
          {!dragOver && source === 'file' && media.active && (media.active.kind === 'video' ? local.error : media.imageError) && (
            <div className="share-overlay share-overlay--error">
              <strong>⚠ {media.active.kind === 'video' ? local.error : media.imageError}</strong>
            </div>
          )}

          {videoMode && media.active && (
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
              <span className="share-player__name" title={media.active.name}>{media.active.name}</span>
              <button className="share-player__btn" onClick={() => { if (media.active) media.remove(media.active.id); }} title="從清單移除這支影片">✕</button>
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
