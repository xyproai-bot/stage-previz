import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { ModelVersion } from '../lib/api';
import { parseServerTime } from '../lib/serverTime';
import { useViewAsUser } from '../lib/viewAsContext';
import { COMPRESS_PHASE_TEXT, compressModelForUpload, sizeChangeText, type ModelCompressPhase } from '../lib/modelCompress/compressText';
import { Box, CircleCheck, LoaderCircle, RotateCcw, Shrink, Trash2, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import { confirmDialog, toast } from './dialogs';
import './ModelVersionsDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  /** 切換版本 / 刪除版本後呼叫，讓父層 refresh 模型；切換時後台把 LED 畫布也換回那個版本的（restoredCanvas） */
  onChanged: (info?: { restoredCanvas: boolean; ledCanvas: { width: number; height: number } | null; objectTypesChanged?: boolean }) => void;
}

function formatTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(parseServerTime(iso));  // 後台時間是 UTC 沒寫時區，不轉會差 8 小時
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return '剛才';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return d.toLocaleDateString('zh-TW') + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

/** 「壓縮這個模型」做到哪了 */
type CompressJob =
  | { stage: 'download' }
  | { stage: 'compress'; phase: ModelCompressPhase }
  | { stage: 'upload'; pct: number; sizes: string }
  | { stage: 'done'; sizes: string }
  | { stage: 'skipped' | 'failed'; message: string };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ModelVersionsDialog({ open, projectId, onClose, onChanged }: Props) {
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // 壓縮只給製作（admin）用
  const viewer = useViewAsUser();
  const isAdmin = viewer?.role === 'admin';
  const [compressJob, setCompressJob] = useState<CompressJob | null>(null);
  const compressing = !!compressJob && (compressJob.stage === 'download' || compressJob.stage === 'compress' || compressJob.stage === 'upload');

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const { versions } = await api.listModelVersions(projectId);
      setVersions(versions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (open) { refresh(); setCompressJob(null); } /* eslint-disable-next-line */ }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    // 壓縮途中不關（下載、壓縮、上傳要做完）
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !compressing) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, compressing]);

  if (!open) return null;

  async function handleActivate(v: ModelVersion) {
    if (v.isActive) return;
    if (!(await confirmDialog({
      title: '換成這一版模型？',
      message: `${formatTime(v.uploaded)} 上傳（${formatSize(v.size)}）\n換了之後 3D 畫面會重新載入這一版。`,
      confirmLabel: '換成這一版',
    }))) return;
    setBusyKey(v.key);
    try {
      const r = await api.activateModelVersion(projectId, v.key);
      onChanged({ restoredCanvas: !!r.restoredCanvas, ledCanvas: r.ledCanvas ?? null, objectTypesChanged: !!r.objectTypesChanged });
      await refresh();
    } catch (e) {
      toast.error('沒有換成：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * 壓縮現在用的這一版：下載 → 壓縮 + 兩關比對 → 用一般「上傳模型」的路上傳成新的一版（會換成新的那版）。
   * 只上傳模型檔，不動物件清單：物件、每個 cue 的位置都留著（不會「清除現有物件」）；舊的那一版留在清單裡，可以切回。
   */
  async function handleCompress(v: ModelVersion) {
    if (!v.isActive || compressing) return;
    if (!(await confirmDialog({
      title: '壓縮這個模型？',
      message: `${formatSize(v.size)}\n會做一個壓縮過的新版本，並換成那一版：只壓縮形狀資料，物件名稱、位置、旋轉、縮放、UV 都不變，各個 cue 的位置都會留著。\n現在這一版會留在清單裡，隨時可以切回。`,
      confirmLabel: '壓縮',
    }))) return;
    setCompressJob({ stage: 'download' });
    try {
      const resp = await fetch(api.modelDownloadUrl(v.key));
      if (!resp.ok) throw new Error(`下載模型失敗（HTTP ${resp.status}）`);
      const blob = await resp.blob();
      setCompressJob({ stage: 'compress', phase: 'start' });
      const outcome = await compressModelForUpload(blob, { onPhase: (phase) => setCompressJob({ stage: 'compress', phase }) });
      if (outcome.status !== 'compressed') {
        setCompressJob({ stage: outcome.status === 'skipped' ? 'skipped' : 'failed', message: outcome.reason || '沒有壓縮' });
        return;
      }
      const sizes = sizeChangeText(outcome);
      setCompressJob({ stage: 'upload', pct: 0, sizes });
      await api.uploadModel(projectId, outcome.blob, (loaded, total) => {
        if (total > 0) setCompressJob({ stage: 'upload', pct: Math.min(100, Math.round((loaded / total) * 100)), sizes });
      });
      setCompressJob({ stage: 'done', sizes });
      onChanged();
      await refresh();
    } catch (e) {
      setCompressJob({ stage: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleDelete(v: ModelVersion) {
    if (v.isActive) return;
    if (!(await confirmDialog({
      title: '刪除這一版舊模型？',
      message: `${formatTime(v.uploaded)} 上傳（${formatSize(v.size)}）\n檔案會直接刪掉，刪了就救不回來。`,
      confirmLabel: '刪除',
      destructive: true,
    }))) return;
    setBusyKey(v.key);
    try {
      await api.deleteModelVersion(projectId, v.key);
      await refresh();
    } catch (e) {
      toast.error('刪除失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="versions-overlay" onClick={() => { if (!compressing) onClose(); }}>
      <div className="versions-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="versions-dialog__header">
          <div>
            <h2>模型版本歷史</h2>
            <p className="versions-dialog__sub muted">
              每次上傳都會留一份。可以隨時切回舊版、或刪掉用不到的版本。
            </p>
          </div>
          <button className="versions-dialog__close" onClick={onClose} disabled={compressing} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>

        <div className="versions-dialog__body">
          {compressJob && (
            <div
              className={'versions-compress' + (compressJob.stage === 'done' ? ' is-ok' : compressJob.stage === 'failed' || compressJob.stage === 'skipped' ? ' is-muted' : '')}
              role="status"
              data-testid="versions-compress-status"
            >
              {compressJob.stage === 'download' && <><Icon icon={LoaderCircle} spin /> 下載模型中…</>}
              {compressJob.stage === 'compress' && <><Icon icon={LoaderCircle} spin /> 壓縮模型中：{COMPRESS_PHASE_TEXT[compressJob.phase]}</>}
              {compressJob.stage === 'upload' && <><Icon icon={LoaderCircle} spin /> 上傳壓縮後的模型 {compressJob.pct}%（{compressJob.sizes}）</>}
              {compressJob.stage === 'done' && (
                <><Icon icon={CircleCheck} /> 壓縮好了：{compressJob.sizes}。已經換成壓縮過的新版本，原本那一版留在下面，隨時可以切回。</>
              )}
              {(compressJob.stage === 'skipped' || compressJob.stage === 'failed') && (
                <><Icon icon={compressJob.stage === 'failed' ? TriangleAlert : Shrink} /> 沒有壓縮：{compressJob.message}。模型沒有改。</>
              )}
            </div>
          )}
          {loading ? (
            <div className="versions-empty muted">載入中…</div>
          ) : error ? (
            <div className="versions-empty">
              <Icon icon={TriangleAlert} size="xl" className="versions-empty__icon" />
              <div>載入失敗</div>
              <small style={{ color: 'var(--warn)' }}>{error}</small>
              <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 12 }}>重試</button>
            </div>
          ) : versions.length === 0 ? (
            <div className="versions-empty">
              <Icon icon={Box} size="xl" className="versions-empty__icon" />
              <div>還沒有任何模型版本</div>
              <small className="muted">關掉這個視窗，到「物件」分頁上傳第一個 .glb / .gltf</small>
            </div>
          ) : (
            <ul className="versions-list">
              {versions.map((v, i) => (
                <li key={v.key} className={'version-row' + (v.isActive ? ' is-active' : '')}>
                  <div className="version-row__num">v{versions.length - i}</div>
                  <div className="version-row__main">
                    <div className="version-row__title">
                      {v.isActive
                        ? <span className="version-row__active-tag">當前使用</span>
                        : <span className="muted small">舊版本</span>}
                      <span className="version-row__time">{formatTime(v.uploaded)}</span>
                    </div>
                    <div className="version-row__meta muted small">
                      {formatSize(v.size)}
                      <span className="dot">·</span>
                      <span className="mono">{v.key.split('/').pop()}</span>
                    </div>
                    {(v.note || v.ledCanvas) && (
                      <div className="version-row__meta muted small" data-testid="version-uv-note">
                        {v.note}{v.note && v.ledCanvas ? ' · ' : ''}{v.ledCanvas ? `LED 畫布 ${v.ledCanvas.width} × ${v.ledCanvas.height}` : ''}
                      </div>
                    )}
                  </div>
                  <div className="version-row__actions">
                    {isAdmin && v.isActive && (
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => handleCompress(v)}
                        disabled={compressing || busyKey !== null}
                        title="做一個壓縮過的新版本：檔案變小、載入變快，物件和 cue 的位置都不變"
                      >
                        {compressing ? <><Icon icon={LoaderCircle} spin /> 壓縮中…</> : <><Icon icon={Shrink} /> 壓縮這個模型</>}
                      </button>
                    )}
                    {!v.isActive && (
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => handleActivate(v)}
                        disabled={busyKey === v.key || compressing}
                      >
                        {busyKey === v.key ? '切換中…' : <><Icon icon={RotateCcw} /> 切回此版</>}
                      </button>
                    )}
                    {!v.isActive && (
                      <button
                        className="btn btn--ghost btn--sm version-row__delete"
                        onClick={() => handleDelete(v)}
                        disabled={busyKey === v.key || compressing}
                        title="刪除這個舊版本（不可復原）"
                        aria-label="刪除這個舊版本"
                      >
                        <Icon icon={Trash2} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="versions-dialog__footer">
          <span className="muted small">共 {versions.length} 個版本</span>
          <button className="btn btn--ghost" onClick={onClose} disabled={compressing}>關閉</button>
        </footer>
      </div>
    </div>
  );
}
