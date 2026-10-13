import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, SharePublicData, ShareVideo } from '../lib/api';
import StageScene from '../components/StageScene';
import { normalizeLookSettings } from '../lib/stageLook/lookSettings';
import { normalizeMaterialOverrides } from '../lib/stageLook/materialOverrides';
import { formatClock, useLocalVideo } from '../lib/localVideo';
import { cueAtTime } from '../lib/cueTiming';
import type { NdiClientStatus } from '../lib/ndiClient';
import './Share.css';

/** LED 畫面來源：AE 即時（NDI 小程序）或本地影片（拖進來的檔案，只在這台電腦播） */
type LedSource = 'ndi' | 'video';

// NDI 小程序安裝檔（跟模型放同一個公開儲存空間；上線時上傳）
const NDI_HELPER_DOWNLOAD_PATH = '/r2/assets/downloads/stage-previz-ndi-helper-0.1.7.msi';
const NDI_TOOLS_URL = 'https://ndi.video/tools/';

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
    api.getShareSongCues(token, selectedSongId, submittedPwd ?? undefined).then(list => {
      setCues(list);
      setSelectedCueId(list[0]?.id ?? null);
    }).catch(() => setCues([]));
    api.getShareSongVideos(token, selectedSongId, submittedPwd ?? undefined).then(list => {
      setVideos(list);
      setSelectedVideoFid(list[0]?.driveFileId ?? null);
    }).catch(() => setVideos([]));
  }, [token, selectedSongId, submittedPwd]);

  // 切 cue → 拉 states
  useEffect(() => {
    if (!token || !selectedSongId || !selectedCueId) { setCueStates([]); return; }
    api.getShareCueStates(token, selectedSongId, selectedCueId, submittedPwd ?? undefined)
      .then(list => setCueStates(list))
      .catch(() => setCueStates([]));
  }, [token, selectedSongId, selectedCueId, submittedPwd]);

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

  // ── 本地影片播到某秒 → 自動切到對應 cue（cue 有設「對應影片時間」才會動）──
  // 只在「應該的 cue」改變時才切，手動點的 cue 會保留到影片進入下一段
  useEffect(() => { lastAutoCueRef.current = null; }, [cues]);
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
              crossfadeSeconds={selectedCue?.crossfadeSeconds ?? 0}
              scaleCorrection={data.scaleCorrection ?? 1}
              mechanismOffsets={data.mechanismOffsets}
              lookSettings={normalizeLookSettings(data.lookSettings)}
              materialOverrides={normalizeMaterialOverrides(data.materialOverrides)}
              enableNdi={source === 'ndi'}
              onNdiStatus={setNdiStatus}
              ledVideo={source === 'video' && local.ready ? local.video : null}
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
                <li>下載並打開 NDI 小程序：<a className="btn btn--sm" href={api.apiBase() + NDI_HELPER_DOWNLOAD_PATH}>⬇ 下載安裝檔</a></li>
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
