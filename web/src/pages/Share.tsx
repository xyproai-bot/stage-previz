import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, SharePublicData, ShareVideo } from '../lib/api';
import StageScene from '../components/StageScene';
import './Share.css';

/**
 * 公開分享連結 viewer — 無需登入。
 * 路由：/share/:token
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

        <main className="share-stage">
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
              defaultRenderMode="cinematic"
              crossfadeSeconds={selectedCue?.crossfadeSeconds ?? 0}
            />
          ) : (
            <div className="share-empty">這個專案沒有可預覽的內容</div>
          )}

          {cues.length > 0 && (
            <div className="share-cuebar">
              {cues.map((c, i) => (
                <button
                  key={c.id}
                  className={'share-cuebar__cue' + (c.id === selectedCueId ? ' is-active' : '')}
                  onClick={() => setSelectedCueId(c.id)}
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
