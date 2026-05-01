import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { Cue, CueState, StageObject } from '../lib/api';
import StageScene from './StageScene';
import { toast } from '../lib/toast';
import { exportSongStoryboardAsPdf, loadCueThumbs } from '../lib/exportPdf';
import './CueStoryboard.css';

interface Props {
  projectId: string;
  songId: string;
  cues: Cue[];                  // master cues only
  stageObjects: StageObject[];
  modelUrl: string | null;
  selectedCueId: string | null;
  onSelectCue: (id: string) => void;
  /** 拖拉排序後通知上層 refresh cues */
  onReordered?: () => void;
  /** 用於 PDF 匯出檔名 */
  projectName?: string;
  songName?: string;
}

const STORAGE_PREFIX = 'sp-cue-thumb:';   // localStorage key prefix（小張縮圖夠存）

/**
 * 自動為每個 cue 抓一張縮圖：
 *   1. 用一個 hidden StageScene render 該 cue 的 states
 *   2. snapshot API 回傳 blob
 *   3. 存進 localStorage（base64）+ 顯示在 storyboard
 *   4. 用戶可手動「重新生成」單張或全部
 */
export default function CueStoryboard({
  projectId, songId, cues, stageObjects, modelUrl, selectedCueId, onSelectCue, onReordered,
  projectName, songName,
}: Props) {
  const [orderedCues, setOrderedCues] = useState<Cue[]>(cues);
  useEffect(() => { setOrderedCues(cues); }, [cues]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  async function commitReorder(next: Cue[]) {
    setOrderedCues(next);
    try {
      await api.reorderCues(projectId, songId, next.map(c => c.id));
      toast.success('已重新排序');
      onReordered?.();
    } catch (e) {
      toast.error('排序失敗：' + (e instanceof Error ? e.message : String(e)));
      setOrderedCues(cues); // 還原
    }
  }

  function onDragStart(e: React.DragEvent, id: string) {
    setDraggingId(id);
    // dataTransfer 帶資訊，讓 effectAllowed 能跨 reorder/copy
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
  }
  function onDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    // Alt 鍵 → 顯示複製游標
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    if (draggingId && draggingId !== id) setOverId(id);
  }
  async function onDrop(e: React.DragEvent, targetId: string) {
    if (!draggingId) return;
    const altKey = e.altKey;
    const draggedId = draggingId;
    setDraggingId(null);
    setOverId(null);

    // Alt+drop = 複製
    if (altKey) {
      const src = orderedCues.find(c => c.id === draggedId);
      if (!src) return;
      try {
        await api.createCue(projectId, songId, {
          name: `${src.name} (複製)`,
          cloneFrom: src.id,
        });
        toast.success(`已複製 cue「${src.name}」`);
        onReordered?.();
      } catch (err) {
        toast.error('複製失敗：' + (err instanceof Error ? err.message : String(err)));
      }
      return;
    }

    // 一般 drop = 重新排序
    if (draggedId === targetId) return;
    const fromIdx = orderedCues.findIndex(c => c.id === draggedId);
    const toIdx = orderedCues.findIndex(c => c.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...orderedCues];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    commitReorder(next);
  }
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [generating, setGenerating] = useState<string | null>(null); // 正在生成的 cueId
  const [hidden, setHidden] = useState<{ cueId: string; states: CueState[] } | null>(null);
  const snapshotApiRef = useRef<{ snapshot: () => Promise<Blob | null> } | null>(null);

  // 從 localStorage 載入既有縮圖
  useEffect(() => {
    const map = new Map<string, string>();
    for (const c of cues) {
      try {
        const dataUrl = localStorage.getItem(STORAGE_PREFIX + c.id);
        if (dataUrl) map.set(c.id, dataUrl);
      } catch { /* ignore */ }
    }
    setThumbs(map);
  }, [cues]);

  const generateOne = useCallback(async (cue: Cue) => {
    setGenerating(cue.id);
    try {
      // 抓該 cue 的 states
      const states = await api.listCueStates(projectId, songId, cue.id);
      // mount hidden StageScene
      setHidden({ cueId: cue.id, states });
      // 等 react render + 兩個 animation frame（讓 scene 套位置 + 第一次 paint）
      await new Promise<void>(r => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      });
      // 等 1 秒讓 model + texture 載入（有 LED imageUrl 時）
      await new Promise(r => setTimeout(r, 1200));
      const blob = await snapshotApiRef.current?.snapshot();
      if (!blob) { setGenerating(null); return; }
      // base64 化存 localStorage（縮圖 ≤ 30 KB 通常）
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        try { localStorage.setItem(STORAGE_PREFIX + cue.id, dataUrl); }
        catch { /* quota — 略 */ }
        setThumbs(prev => { const m = new Map(prev); m.set(cue.id, dataUrl); return m; });
        setGenerating(null);
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      console.warn('cue snapshot failed', e);
      setGenerating(null);
    }
  }, [projectId, songId]);

  const generateAll = useCallback(async () => {
    for (const c of cues) {
      if (thumbs.has(c.id)) continue; // 已有就跳過
      await generateOne(c);
    }
    setHidden(null);
  }, [cues, thumbs, generateOne]);

  function regenerate(cue: Cue) {
    try { localStorage.removeItem(STORAGE_PREFIX + cue.id); } catch {}
    setThumbs(prev => { const m = new Map(prev); m.delete(cue.id); return m; });
    void generateOne(cue);
  }

  if (cues.length === 0) {
    return <div className="storyboard storyboard--empty">先建幾個 cue，這裡會自動產生縮圖</div>;
  }

  const missingCount = cues.filter(c => !thumbs.has(c.id)).length;

  return (
    <div className="storyboard">
      <div className="storyboard__head">
        <span>Storyboard ({cues.length} cue · {thumbs.size} 已生成) <span className="muted small">· 拖卡片重排 · Alt+拖複製</span></span>
        <div style={{ display: 'flex', gap: 6 }}>
          {missingCount > 0 && (
            <button
              className="btn btn--sm btn--primary"
              onClick={generateAll}
              disabled={!!generating}
            >
              {generating ? '生成中…' : `🎬 自動生成 ${missingCount} 張縮圖`}
            </button>
          )}
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => {
              const tm = loadCueThumbs(cues.map(c => c.id));
              exportSongStoryboardAsPdf({
                projectName: projectName || '專案',
                songName: songName || '歌曲',
                cues,
                thumbs: tm,
              });
              toast.info('開啟列印對話框 → 選「儲存為 PDF」');
            }}
            disabled={cues.length === 0}
            title="匯出 storyboard 為 PDF"
          >📄 匯出 PDF</button>
        </div>
      </div>
      <div className="storyboard__strip">
        {orderedCues.map((c, idx) => {
          const url = thumbs.get(c.id);
          const isActive = c.id === selectedCueId;
          const isGenerating = generating === c.id;
          const isDragging = draggingId === c.id;
          const isOver = overId === c.id;
          return (
            <div
              key={c.id}
              className={'storyboard__card'
                + (isActive ? ' is-active' : '')
                + (isDragging ? ' is-dragging' : '')
                + (isOver ? ' is-over' : '')}
              draggable
              onDragStart={(e) => onDragStart(e, c.id)}
              onDragEnd={() => { setDraggingId(null); setOverId(null); }}
              onDragOver={(e) => onDragOver(e, c.id)}
              onDrop={(e) => onDrop(e, c.id)}
            >
              <button
                className="storyboard__thumb"
                onClick={() => onSelectCue(c.id)}
              >
                {url ? (
                  <img src={url} alt={c.name} />
                ) : isGenerating ? (
                  <div className="storyboard__placeholder">⏳ 生成中…</div>
                ) : (
                  <div className="storyboard__placeholder">🎬 還沒縮圖</div>
                )}
                <span className="storyboard__num">#{idx + 1}</span>
                <span className="storyboard__drag-hint" title="拖拉重新排序">⋮⋮</span>
              </button>
              <div className="storyboard__meta">
                <span className="storyboard__name">{c.name}</span>
                <button
                  className="link-btn"
                  onClick={() => regenerate(c)}
                  disabled={!!generating}
                  title="重新抓縮圖"
                >↻</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hidden StageScene — 在用戶看不到的地方 render，snapshot 抓圖 */}
      {hidden && (
        <div className="storyboard__hidden-stage">
          <StageScene
            key={`storyboard:${hidden.cueId}`}
            states={hidden.states}
            stageObjects={stageObjects}
            selectedObjectIds={[]}
            onSelect={() => {}}
            onTransform={() => {}}
            modelUrl={modelUrl}
            readOnly
            defaultRenderMode="cinematic"
            snapshotApiRef={snapshotApiRef}
          />
        </div>
      )}
    </div>
  );
}
