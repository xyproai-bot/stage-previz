import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { Song } from '../lib/api';
import type { Project } from '../lib/mockData';
import { toast } from '../lib/toast';
import './ImportCuesDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  songId: string;
  songName: string;
  onClose: () => void;
  onImported: () => void;
}

interface ProjectWithSongs {
  project: Project;
  songs: Song[];
}

export default function ImportCuesDialog({ open, projectId, songId, songName, onClose, onImported }: Props) {
  const [projects, setProjects] = useState<ProjectWithSongs[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pickedSong, setPickedSong] = useState<{ id: string; name: string; projectName: string } | null>(null);
  const [replace, setReplace] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPickedSong(null);
    (async () => {
      try {
        const list = await api.listProjects();
        const grouped: ProjectWithSongs[] = [];
        // 4 個併發抓 songs
        const queue = [...list];
        async function work() {
          while (queue.length > 0 && !cancelled) {
            const p = queue.shift();
            if (!p) return;
            try {
              const songs = await api.listSongs(p.id);
              if (!cancelled) {
                grouped.push({ project: p, songs });
                setProjects([...grouped].sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt)));
              }
            } catch { /* skip */ }
          }
        }
        await Promise.all([work(), work(), work(), work()]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  async function handleImport() {
    if (!pickedSong) return;
    setImporting(true);
    try {
      const r = await api.importCuesFromSong(projectId, songId, {
        fromSongId: pickedSong.id,
        replace,
      });
      toast.success(r.message);
      onImported();
      onClose();
    } catch (e) {
      toast.error('匯入失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setImporting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg import-cues-dlg">
        <header className="dlg__header">
          <h2>📥 匯入 Cue 到「{songName}」</h2>
          <button className="dlg__close" onClick={onClose}>×</button>
        </header>
        <div className="dlg__body">
          <p className="import-cues-dlg__hint">
            從別首歌（同專案或別專案）一鍵把所有 cue + 物件位置複製過來。<br />
            物件用 <strong>mesh 名稱</strong>對應；對不到的會略過（會告訴你有幾個）。
          </p>

          <div className="import-cues-dlg__opt">
            <label>
              <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />
              <span>取代現有 cue（勾起來會先清空目前歌的所有 cue）</span>
            </label>
          </div>

          {loading ? (
            <div className="import-cues-dlg__loading">載入專案清單…</div>
          ) : (
            <div className="import-cues-dlg__list">
              {projects.map(({ project, songs }) => {
                const validSongs = songs.filter(s => s.id !== songId && s.cueCount > 0);
                if (validSongs.length === 0) return null;
                return (
                  <div key={project.id} className="import-cues-dlg__project">
                    <div className="import-cues-dlg__proj-name">📁 {project.name}</div>
                    <ul>
                      {validSongs.map(s => (
                        <li key={s.id}>
                          <button
                            className={'import-cues-dlg__song' + (pickedSong?.id === s.id ? ' is-picked' : '')}
                            onClick={() => setPickedSong({ id: s.id, name: s.name, projectName: project.name })}
                          >
                            <span>{s.name}</span>
                            <span className="muted small">{s.cueCount} 個 cue</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="dlg__footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
          {pickedSong && (
            <span className="muted small" style={{ alignSelf: 'center', flex: 1 }}>
              準備從「{pickedSong.projectName} / {pickedSong.name}」匯入
            </span>
          )}
          <button className="btn btn--ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn--primary"
            onClick={handleImport}
            disabled={!pickedSong || importing}
          >
            {importing ? '匯入中…' : '📥 開始匯入'}
          </button>
        </footer>
      </div>
    </div>
  );
}
