import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { StageObjectCategory } from '../lib/api';
import { parseGlbFile, classifyMeshName, prettifyName, type ParsedMesh } from '../lib/parseGlb';
import './UploadModelDialog.css';

const CATEGORY_OPTIONS: Array<[StageObjectCategory, string, string]> = [
  ['led_panel',  '🟦', 'LED 面板'],
  ['mechanism', '⚙️', '機關'],
  ['walk_point', '📍', '走位點'],
  ['fixture',   '💡', '燈光/道具'],
  ['performer', '🧍', '表演者'],
  ['other',     '⬜', '其他'],
];

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}

type Stage = 'pick' | 'parsing' | 'review' | 'importing' | 'done' | 'error';

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStage('pick');
      setError(null);
      setMeshes([]);
      setWarnings([]);
      setReplace(false);
      setFilename('');
      setPickedFile(null);
      setUploadProgress('');
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
    try {
      const { meshes, warnings, sceneSizeMeters, unitGuess: ug } = await parseGlbFile(file);
      setMeshes(meshes);
      setWarnings(warnings);
      setSceneSize(sceneSizeMeters);
      setUnitGuess(ug);
      setStage(meshes.length > 0 ? 'review' : 'error');
      if (meshes.length === 0) setError('GLB 解析後找不到 top-level 物件 — 確認模型是有 group/mesh，沒被全展平');

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

  async function doImport() {
    setStage('importing');
    setError(null);
    try {
      // Step 1：把 .glb 真檔上傳到 R2（如果有 file）
      if (pickedFile) {
        setUploadProgress(`上傳 ${(pickedFile.size / 1024 / 1024).toFixed(1)} MB 中…`);
        setUploadPct(0);
        await api.uploadModel(projectId, pickedFile, (loaded, total) => {
          if (total > 0) setUploadPct(Math.min(100, Math.round((loaded / total) * 100)));
        });
        setUploadPct(100);
      }

      // Step 2：bulk insert stage_objects metadata
      setUploadProgress('匯入物件清單…');
      const items = meshes.map(m => ({
        meshName: m.meshName,
        displayName: m.displayName || m.meshName,
        category: m.category,
        defaultPosition: m.defaultPosition,
        defaultRotation: m.defaultRotation,
        defaultScale: m.defaultScale,
      }));
      const r = await api.bulkCreateStageObjects(projectId, items, { replace });
      setStage('done');
      setTimeout(() => { onImported(); onClose(); }, 1500);
      void r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  }

  // counts by category for review summary
  const counts: Record<StageObjectCategory, number> = {
    led_panel: 0, mechanism: 0, walk_point: 0, fixture: 0, performer: 0, other: 0,
  };
  meshes.forEach(m => { counts[m.category]++; });
  const otherCount = counts.other;

  return (
    <div className="upload-overlay" onClick={() => stage !== 'parsing' && stage !== 'importing' && onClose()}>
      <div className="upload-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="upload-dialog__header">
          <h2>上傳 3D 模型（.glb / .gltf）</h2>
          <button className="upload-dialog__close" onClick={onClose}>×</button>
        </header>

        {stage === 'pick' && (
          <>
            <div
              className="upload-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
            >
              <div className="upload-dropzone__icon">📦</div>
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
                placeholder="或貼 .glb 檔案直連 URL（Sketchfab / GitHub raw / 公開 R2）"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                disabled={fetchingUrl}
              />
              <button
                className="btn btn--ghost btn--sm"
                onClick={fetchFromUrl}
                disabled={fetchingUrl || !urlInput.trim()}
              >
                {fetchingUrl ? '載入中…' : '從 URL 載入'}
              </button>
            </div>

            <div className="upload-dialog__hint">
              <strong>命名規則</strong>（系統會自動分類）：
              <ul>
                <li><code>LED_01_主牆</code> → 🟦 LED 面板</li>
                <li><code>STAGE_01_升降</code> → ⚙️ 機關</li>
                <li><code>ARTIST_01_主唱</code> → 🧍 表演者</li>
                <li><code>PROP_01_麥架</code> / <code>LIGHT_01_搖頭</code> → 💡 燈光/道具</li>
                <li><code>WALK_01_主舞</code> → 📍 走位點</li>
                <li>其他名稱 → ⬜ 其他（可手動改分類）</li>
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
              <span className="upload-summary__file">📄 {filename}</span>
              <span className="upload-summary__count">{meshes.length} 個物件</span>
              <span className={'upload-summary__size' + (unitGuess !== 'normal' ? ' is-warn' : '')}>
                📐 對角 {sceneSize.toFixed(sceneSize < 10 ? 2 : 1)} m
              </span>
              {Object.entries(counts).filter(([, n]) => n > 0).map(([cat, n]) => {
                const opt = CATEGORY_OPTIONS.find(c => c[0] === cat as StageObjectCategory)!;
                return (
                  <span key={cat} className="upload-summary__cat">
                    {opt[1]} {n} {opt[2]}
                  </span>
                );
              })}
              {otherCount > 0 && (
                <span className="upload-warn">⚠️ {otherCount} 個未匹配規則，請手動指派</span>
              )}
            </div>

            {warnings.length > 0 && (
              <div className="upload-warnings">
                {warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}

            {orphanedMeshes.length > 0 && (
              <div className="upload-orphan-warn">
                <strong>⚠ 留言可能跑掉</strong>
                <p>
                  舊模型有 <strong>{orphanedMeshes.length}</strong> 個物件名稱在新模型裡找不到：
                  <code className="upload-orphan-warn__list">
                    {orphanedMeshes.slice(0, 8).join('、')}
                    {orphanedMeshes.length > 8 && ` …等 ${orphanedMeshes.length} 個`}
                  </code>
                </p>
                <p className="muted">
                  如果之前有人在這些物件上釘 3D 留言，匯入後留言會掛在錯的位置（fallback 顯示）。
                  保留原本 mesh 命名可避免這問題。
                </p>
              </div>
            )}

            {unitGuess !== 'normal' && (
              <div className="upload-unit-hint">
                <strong>📏 尺寸看起來不對</strong>
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
                    <th>Mesh 名稱</th>
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
                            {CATEGORY_OPTIONS.map(([c, ic, label]) => (
                              <option key={c} value={c}>{ic} {label}</option>
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
                <span>清除這個專案現有的物件後再匯入</span>
              </label>
            </div>

            <footer className="upload-dialog__footer">
              <button className="btn btn--ghost" onClick={onClose}>取消</button>
              <button className="btn btn--primary" onClick={doImport}>
                匯入 {meshes.length} 個物件
              </button>
            </footer>
          </>
        )}

        {stage === 'importing' && (
          <div className="upload-status">
            <div className="spinner" />
            <div style={{ width: '100%', maxWidth: 400 }}>
              <div style={{ marginBottom: 6, fontSize: 12.5 }}>{uploadProgress || '匯入中…'}</div>
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
            ✅ 匯入成功！
          </div>
        )}

        {stage === 'error' && (
          <div className="upload-error">
            <div className="upload-error__icon">⚠️</div>
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
