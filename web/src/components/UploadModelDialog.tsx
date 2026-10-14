import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { StageObjectCategory } from '../lib/api';
import { parseGlbFile, classifyMeshName, prettifyName, type ParsedMesh } from '../lib/parseGlb';
import { friendlyError } from '../lib/songReview';
import { COMPRESS_PHASE_TEXT, compressModelForUpload, formatModelSize, sizeChangeText, type ModelCompressOutcome, type ModelCompressPhase } from '../lib/modelCompress/compressText';
import { CircleCheck, FileText, LoaderCircle, Ruler, Scaling, Shrink, TriangleAlert, Upload, X } from 'lucide-react';
import Icon from './Icon';
import { STAGE_CATEGORY, STAGE_CATEGORY_ORDER } from './stageCategories';
import './UploadModelDialog.css';

/** 命名規則說明裡的分類（名稱 + 圖示） */
function CategoryName({ category }: { category: StageObjectCategory }) {
  const c = STAGE_CATEGORY[category];
  return <><Icon icon={c.icon} /> {c.label}</>;
}

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}

type Stage = 'pick' | 'parsing' | 'review' | 'confirmReplace' | 'importing' | 'done' | 'error';

/** 上傳前壓縮模型（lib/modelCompress）的狀態：解析完就在背景開始壓，按匯入時還沒好就等它 */
type CompressState =
  | { kind: 'idle' }
  | { kind: 'running'; phase: ModelCompressPhase; beforeBytes: number }
  | { kind: 'done'; outcome: ModelCompressOutcome };

/** 「清除現有物件」會刪掉的東西（後台算的） */
interface WillDelete { stageObjects: number; cueStates: number; cuesAffected: number }

function readWillDelete(v: unknown): WillDelete | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && isFinite(x) ? x : 0);
  return { stageObjects: n(o.stageObjects), cueStates: n(o.cueStates), cuesAffected: n(o.cuesAffected) };
}

export default function UploadModelDialog({ open, projectId, onClose, onImported }: Props) {
  const [stage, setStage] = useState<Stage>('pick');
  const [error, setError] = useState<string | null>(null);
  const [meshes, setMeshes] = useState<ParsedMesh[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [replace, setReplace] = useState(false);
  const [filename, setFilename] = useState('');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  const [uploadPct, setUploadPct] = useState<number>(0); // 0~100
  const [sceneSize, setSceneSize] = useState(0);
  const [unitGuess, setUnitGuess] = useState<'normal' | 'too_big' | 'too_small'>('normal');
  const [urlInput, setUrlInput] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  // 3D pin 留言會被影響的 mesh 名稱（current 模型有但新模型沒有的）
  const [orphanedMeshes, setOrphanedMeshes] = useState<string[]>([]);
  // 勾了「清除現有物件」：後台先回會刪掉多少，給使用者在這個視窗裡確認
  const [replaceInfo, setReplaceInfo] = useState<{ message: string; willDelete: WillDelete } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [compress, setCompress] = useState<CompressState>({ kind: 'idle' });
  // 背景壓縮的工作（換檔案 / 關掉視窗就取消）
  const compressJobRef = useRef<{ promise: Promise<ModelCompressOutcome>; abort: AbortController } | null>(null);
  // 按了匯入、還在等壓縮做完
  const [waitingCompress, setWaitingCompress] = useState(false);

  function cancelCompression() {
    compressJobRef.current?.abort.abort();
    compressJobRef.current = null;
  }

  // 關掉視窗 / 離開頁面 → 停掉還在跑的壓縮
  useEffect(() => {
    if (!open) cancelCompression();
    return () => cancelCompression();
  }, [open]);

  useEffect(() => {
    if (open) {
      setCompress({ kind: 'idle' });
      setWaitingCompress(false);
      setStage('pick');
      setError(null);
      setMeshes([]);
      setWarnings([]);
      setReplace(false);
      setFilename('');
      setPickedFile(null);
      setUploadProgress('');
      setReplaceInfo(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && stage !== 'parsing' && stage !== 'importing') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, stage]);

  if (!open) return null;

  async function handleFile(file: File) {
    if (!/\.glb$|\.gltf$/i.test(file.name)) {
      setError('只接受 .glb / .gltf 檔');
      setStage('error');
      return;
    }
    setFilename(file.name);
    setPickedFile(file);
    setStage('parsing');
    setError(null);
    cancelCompression();
    setCompress({ kind: 'idle' });
    try {
      const { meshes, warnings, sceneSizeMeters, unitGuess: ug } = await parseGlbFile(file);
      setMeshes(meshes);
      setWarnings(warnings);
      setSceneSize(sceneSizeMeters);
      setUnitGuess(ug);
      setStage(meshes.length > 0 ? 'review' : 'error');
      if (meshes.length === 0) setError('檔案裡讀不到任何物件：請確認 C4D 匯出時物件是分開的（不要全部合併成一個）');
      // 解析得出來 → 背景開始壓縮（使用者看物件清單的時候就在壓了）
      if (meshes.length > 0) startCompression(file);

      // 比對既有 stage_objects 的 mesh_name → 找出在新模型裡消失的（影響 3D pin 留言）
      try {
        const existing = await api.listStageObjects(projectId);
        const newMeshNames = new Set(meshes.map(m => m.meshName));
        const orphans = existing
          .map(o => o.meshName)
          .filter(n => !newMeshNames.has(n));
        setOrphanedMeshes(orphans);
      } catch { setOrphanedMeshes([]); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  }

  /** 背景壓縮：壓好、兩關比對都過才用壓縮檔；不然就用原檔（原因寫在 console 和畫面上） */
  function startCompression(file: File) {
    cancelCompression();
    const abort = new AbortController();
    setCompress({ kind: 'running', phase: 'start', beforeBytes: file.size });
    const promise = compressModelForUpload(file, {
      signal: abort.signal,
      onPhase: (phase) => { if (!abort.signal.aborted) setCompress({ kind: 'running', phase, beforeBytes: file.size }); },
    }).catch((e): ModelCompressOutcome => {
      const reason = e instanceof Error ? e.message : String(e);
      if (!abort.signal.aborted) console.warn('[模型壓縮] 出錯，上傳原檔：', e);
      return { status: 'failed', reason, blob: file, beforeBytes: file.size, afterBytes: file.size, timings: {} };
    }).then((outcome) => {
      if (!abort.signal.aborted) setCompress({ kind: 'done', outcome });
      return outcome;
    });
    compressJobRef.current = { promise, abort };
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  async function fetchFromUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setFetchingUrl(true);
    setError(null);
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} 抓不到檔案（CORS / 403？）`);
      const blob = await resp.blob();
      const guessName = url.split('/').pop()?.split('?')[0] || 'model.glb';
      const safeName = /\.(glb|gltf)$/i.test(guessName) ? guessName : guessName + '.glb';
      const file = new File([blob], safeName, { type: blob.type || 'model/gltf-binary' });
      setUrlInput('');
      await handleFile(file);
    } catch (e) {
      setError('從 URL 載入失敗：' + (e instanceof Error ? e.message : String(e)) + '\n（檢查 URL 是否公開、CORS 是否允許）');
      setStage('error');
    } finally {
      setFetchingUrl(false);
    }
  }

  function patchMesh(idx: number, patch: Partial<ParsedMesh>) {
    setMeshes(prev => prev.map((m, i) => i === idx ? { ...m, ...patch } : m));
  }

  function importItems() {
    return meshes.map(m => ({
      meshName: m.meshName,
      displayName: m.displayName || m.meshName,
      category: m.category,
      defaultPosition: m.defaultPosition,
      defaultRotation: m.defaultRotation,
      defaultScale: m.defaultScale,
    }));
  }

  // 把 .glb 真檔上傳到 R2（如果有 file）：壓縮過、檢查過的就上傳壓縮檔，不然上傳原檔
  async function uploadPickedFile() {
    if (!pickedFile) return;
    let body: Blob = pickedFile;
    const job = compressJobRef.current;
    if (job) {
      setUploadPct(0);
      setWaitingCompress(true);
      try {
        const outcome = await job.promise;
        if (outcome.status === 'compressed') body = outcome.blob;
      } finally {
        setWaitingCompress(false);
      }
    }
    const compressed = body !== pickedFile;
    setUploadProgress(compressed
      ? `上傳壓縮後的模型 ${formatModelSize(body.size)} 中…（原本 ${formatModelSize(pickedFile.size)}）`
      : `上傳 ${formatModelSize(pickedFile.size)} 中…`);
    setUploadPct(0);
    await api.uploadModel(projectId, body, (loaded, total) => {
      if (total > 0) setUploadPct(Math.min(100, Math.round((loaded / total) * 100)));
    });
    setUploadPct(100);
  }

  function finishImport() {
    setStage('done');
    setTimeout(() => { onImported(); onClose(); }, 1500);
  }

  /**
   * withReplace：這次要不要清除現有物件（預設照勾選框）
   * confirmed：使用者已經在確認畫面看過會刪掉多少、按了確定
   */
  async function doImport(opts: { withReplace?: boolean; confirmed?: boolean } = {}): Promise<void> {
    const withReplace = opts.withReplace ?? replace;
    const items = importItems();
    setError(null);
    setStage('importing');
    setUploadPct(0);

    // 要清除現有物件：先問後台會刪掉多少（沒帶確認的話後台一律回 409、什麼都不刪），
    // 在上傳模型檔之前問 → 使用者按「回上一步」的話什麼都沒動
    if (withReplace && !opts.confirmed) {
      setUploadProgress('確認清除會影響哪些 cue…');
      try {
        await api.bulkCreateStageObjects(projectId, items, { replace: true });
        // 舊版後台不會先問，直接清除並匯入了 → 物件已經換好，接著上傳模型檔就好
        await uploadPickedFile();
        finishImport();
      } catch (e) {
        const willDelete = readWillDelete((e as api.ApiError).data?.willDelete);
        if (api.errorStatus(e) === 409 && willDelete) {
          if (willDelete.stageObjects === 0) {
            // 本來就沒有物件，沒東西會被刪 → 不用問
            return doImport({ withReplace: true, confirmed: true });
          }
          setReplaceInfo({ message: e instanceof Error ? e.message : '', willDelete });
          setStage('confirmReplace');
          return;
        }
        setError(friendlyError(e));
        setStage('error');
      }
      return;
    }

    try {
      await uploadPickedFile();
      setUploadProgress('匯入物件清單…');
      await api.bulkCreateStageObjects(projectId, items, withReplace ? { replace: true, confirmReplace: true } : undefined);
      finishImport();
    } catch (e) {
      setError(friendlyError(e));
      setStage('error');
    }
  }

  // counts by category for review summary
  const counts: Record<StageObjectCategory, number> = {
    led_panel: 0, mechanism: 0, walk_point: 0, fixture: 0, performer: 0, other: 0,
  };
  meshes.forEach(m => { counts[m.category]++; });
  const otherCount = counts.other;
  const compressText = compress.kind === 'running'
    ? `壓縮模型中…（${formatModelSize(compress.beforeBytes)}）`
    : compress.kind === 'done' && compress.outcome.status === 'compressed'
      ? `模型壓縮好了：${sizeChangeText(compress.outcome)}`
      : compress.kind === 'done'
        ? (compress.outcome.reason === '這個模型已經壓縮過了' ? '模型已經壓縮過了，直接上傳' : '不壓縮，上傳原檔')
        : '';
  const compressOk = compress.kind === 'done' && compress.outcome.status === 'compressed';
  const compressTitle = compress.kind === 'running' ? COMPRESS_PHASE_TEXT[compress.phase]
    : compressOk ? '只壓縮形狀資料：物件名稱、位置、旋轉、縮放、UV 都檢查過跟原檔一樣'
      : compress.kind === 'done' ? compress.outcome.reason : undefined;
  const importingText = waitingCompress && compress.kind === 'running'
    ? `壓縮模型中（${formatModelSize(compress.beforeBytes)}）：${COMPRESS_PHASE_TEXT[compress.phase]}`
    : uploadProgress || '匯入中…';

  return (
    <div className="upload-overlay" onClick={() => stage !== 'parsing' && stage !== 'importing' && stage !== 'confirmReplace' && onClose()}>
      <div className="upload-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="upload-dialog__header">
          <h2>上傳 3D 模型（.glb / .gltf）</h2>
          <button className="upload-dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>

        {stage === 'pick' && (
          <>
            <div
              className="upload-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
            >
              <div className="upload-dropzone__icon"><Icon icon={Upload} size="xxl" /></div>
              <div className="upload-dropzone__title">拖放 .glb 或 .gltf 到這裡</div>
              <small className="muted">或點擊選檔</small>
              <input
                ref={inputRef}
                type="file"
                accept=".glb,.gltf"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </div>
            <div className="upload-url-row">
              <input
                type="url"
                className="upload-url-input"
                placeholder="或貼 .glb 檔案的直接下載網址（Sketchfab / GitHub / 公開的雲端連結）"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                disabled={fetchingUrl}
              />
              <button
                className="btn btn--ghost btn--sm"
                onClick={fetchFromUrl}
                disabled={fetchingUrl || !urlInput.trim()}
              >
                {fetchingUrl ? '載入中…' : '從網址載入'}
              </button>
            </div>

            <div className="upload-dialog__hint">
              <strong>命名規則</strong>（系統會自動分類）：
              <ul>
                <li><code>LED_01_主牆</code> → <CategoryName category="led_panel" /></li>
                <li><code>STAGE_01_升降</code> → <CategoryName category="mechanism" /></li>
                <li><code>ARTIST_01_主唱</code> → <CategoryName category="performer" /></li>
                <li><code>PROP_01_麥架</code> / <code>LIGHT_01_搖頭</code> → <CategoryName category="fixture" /></li>
                <li><code>WALK_01_主舞</code> → <CategoryName category="walk_point" /></li>
                <li>其他名稱 → <CategoryName category="other" />（可手動改分類）</li>
              </ul>
            </div>
          </>
        )}

        {stage === 'parsing' && (
          <div className="upload-status">
            <div className="spinner" /> 解析 GLB 中…
          </div>
        )}

        {stage === 'review' && (
          <>
            <div className="upload-summary">
              <span className="upload-summary__file"><Icon icon={FileText} /> {filename}</span>
              <span className="upload-summary__count">{meshes.length} 個物件</span>
              <span className={'upload-summary__size' + (unitGuess !== 'normal' ? ' is-warn' : '')}>
                <Icon icon={Scaling} /> 對角 {sceneSize.toFixed(sceneSize < 10 ? 2 : 1)} m
              </span>
              {Object.entries(counts).filter(([, n]) => n > 0).map(([cat, n]) => {
                const opt = STAGE_CATEGORY[cat as StageObjectCategory];
                return (
                  <span key={cat} className="upload-summary__cat">
                    <Icon icon={opt.icon} /> {n} {opt.label}
                  </span>
                );
              })}
              {otherCount > 0 && (
                <span className="upload-warn"><Icon icon={TriangleAlert} /> {otherCount} 個沒對到命名規則，請手動選分類</span>
              )}
              {compressText && (
                <span
                  className={'upload-summary__compress' + (compressOk ? ' is-ok' : compress.kind === 'done' ? ' is-muted' : '')}
                  title={compressTitle}
                  data-testid="upload-compress-status"
                >
                  <Icon icon={compress.kind === 'running' ? LoaderCircle : Shrink} spin={compress.kind === 'running'} /> {compressText}
                </span>
              )}
            </div>
            {compress.kind === 'done' && compress.outcome.status === 'failed' && compress.outcome.reason && (
              <div className="upload-compress-note">沒有壓縮的原因：{compress.outcome.reason}</div>
            )}

            {warnings.length > 0 && (
              <div className="upload-warnings">
                {warnings.map((w, i) => <div key={i}><Icon icon={TriangleAlert} /> {w}</div>)}
              </div>
            )}

            {orphanedMeshes.length > 0 && (
              <div className="upload-orphan-warn">
                <strong><Icon icon={TriangleAlert} /> 留言可能跑掉</strong>
                <p>
                  舊模型有 <strong>{orphanedMeshes.length}</strong> 個物件名稱在新模型裡找不到：
                  <code className="upload-orphan-warn__list">
                    {orphanedMeshes.slice(0, 8).join('、')}
                    {orphanedMeshes.length > 8 && ` …等 ${orphanedMeshes.length} 個`}
                  </code>
                </p>
                <p className="muted">
                  如果之前有人在這些物件上釘 3D 留言，匯入後留言會掛在錯的位置。
                  在 C4D 裡保留原本的物件名稱就不會有這個問題。
                </p>
              </div>
            )}

            {unitGuess !== 'normal' && (
              <div className="upload-unit-hint">
                <strong><Icon icon={Ruler} /> 尺寸看起來不對</strong>
                <p>
                  GLB 標準是 1 unit = 1 公尺，舞臺對角通常 5-50 m 之間。
                  你的模型對角是 <strong>{sceneSize.toFixed(2)} m</strong>，看起來
                  {unitGuess === 'too_big' ? ' 過大' : ' 過小'}。
                </p>
                <p className="muted">
                  匯入後系統會 <strong>自動 {unitGuess === 'too_big' ? '縮小到 1/100' : '放大 100×'}</strong>。
                  建議：在 C4D / Blender 把單位改成「公尺」再匯出 .glb。
                </p>
              </div>
            )}

            <div className="upload-meshes">
              <table>
                <thead>
                  <tr>
                    <th>C4D 物件名稱</th>
                    <th>顯示名稱</th>
                    <th>分類</th>
                    <th title="子節點數">子</th>
                  </tr>
                </thead>
                <tbody>
                  {meshes.map((m, i) => {
                    const isOther = m.category === 'other';
                    return (
                      <tr key={m.meshName} className={isOther ? 'is-unmatched' : ''}>
                        <td className="mono">{m.meshName}</td>
                        <td>
                          <input
                            type="text"
                            value={m.displayName}
                            onChange={(e) => patchMesh(i, { displayName: e.target.value })}
                            maxLength={80}
                          />
                        </td>
                        <td>
                          <select
                            value={m.category}
                            onChange={(e) => patchMesh(i, { category: e.target.value as StageObjectCategory })}
                            className={isOther ? 'is-unmatched' : ''}
                          >
                            {STAGE_CATEGORY_ORDER.map(c => (
                              <option key={c} value={c}>{STAGE_CATEGORY[c].label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="mono muted">{m.childCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="upload-options">
              <label>
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                <span>清除這個專案現有的物件後再匯入（每個 cue 裡這些物件的位置也會一起刪掉，匯入前會再跟你確認一次）</span>
              </label>
            </div>

            <footer className="upload-dialog__footer">
              <button className="btn btn--ghost" onClick={onClose}>取消</button>
              <button className="btn btn--primary" onClick={() => doImport()}>
                匯入 {meshes.length} 個物件
              </button>
            </footer>
          </>
        )}

        {stage === 'confirmReplace' && replaceInfo && (
          <>
            <div className="upload-replace-confirm">
              <strong>確定要清除現有的物件嗎？</strong>
              {replaceInfo.message && <p>{replaceInfo.message}</p>}
              <ul>
                <li>會刪掉 <b>{replaceInfo.willDelete.stageObjects}</b> 個物件</li>
                {replaceInfo.willDelete.cueStates > 0 ? (
                  <li>影響 <b>{replaceInfo.willDelete.cuesAffected}</b> 個 cue，共 <b>{replaceInfo.willDelete.cueStates}</b> 筆物件位置（不能復原）</li>
                ) : (
                  <li>目前沒有 cue 調過這些物件的位置</li>
                )}
                <li>模型檔還沒上傳，按「回上一步」什麼都不會改</li>
              </ul>
              <p className="muted">
                只是換新版模型、物件名稱沒變的話，不用清除：選「不清除，直接匯入」，各個 cue 的位置都會留著。
              </p>
            </div>
            <footer className="upload-dialog__footer">
              <button className="btn btn--ghost" onClick={() => setStage('review')}>回上一步</button>
              <button className="btn btn--ghost" onClick={() => { setReplace(false); void doImport({ withReplace: false }); }}>
                不清除，直接匯入
              </button>
              <button className="btn btn--primary upload-replace-confirm__danger" onClick={() => doImport({ withReplace: true, confirmed: true })}>
                確定清除並匯入
              </button>
            </footer>
          </>
        )}

        {stage === 'importing' && (
          <div className="upload-status">
            <div className="spinner" />
            <div style={{ width: '100%', maxWidth: 400 }}>
              <div style={{ marginBottom: 6, fontSize: 12.5 }} data-testid="upload-importing-text">{importingText}</div>
              {uploadPct > 0 && uploadPct < 100 && (
                <>
                  <div className="upload-progress-bar">
                    <div className="upload-progress-bar__fill" style={{ width: `${uploadPct}%` }} />
                  </div>
                  <div className="upload-progress-text">{uploadPct}%</div>
                </>
              )}
            </div>
          </div>
        )}

        {stage === 'done' && (
          <div className="upload-status upload-status--ok">
            <Icon icon={CircleCheck} size="lg" /> 匯入成功！
            {compressOk && compress.kind === 'done' && (
              <small className="upload-status__compressed">模型 {sizeChangeText(compress.outcome)}</small>
            )}
          </div>
        )}

        {stage === 'error' && (
          <div className="upload-error">
            <div className="upload-error__icon"><Icon icon={TriangleAlert} size="xl" /></div>
            <div className="upload-error__msg">{error || '失敗'}</div>
            <button className="btn btn--ghost" onClick={() => setStage('pick')}>重來</button>
          </div>
        )}
      </div>
    </div>
  );
}

// re-exports so callers don't need to know parseGlb internals
export { classifyMeshName, prettifyName };
