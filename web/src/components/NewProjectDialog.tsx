import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { Show } from '../lib/api';
import './NewProjectDialog.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (data: { name: string; description: string; showId?: string | null }) => void | Promise<void>;
  submitting?: boolean;
  /** 如果提供，新專案會 pre-select 這個 Show */
  defaultShowId?: string | null;
}

export default function NewProjectDialog({ open, onClose, onCreate, submitting = false, defaultShowId = null }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [showId, setShowId] = useState<string>(defaultShowId || '');
  const [shows, setShows] = useState<Show[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setShowId(defaultShowId || '');
      setTimeout(() => nameRef.current?.focus(), 50);
      api.listShows().then(setShows).catch(() => setShows([]));
    }
  }, [open, defaultShowId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      description: description.trim(),
      showId: showId || null,
    });
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>新增專案</h2>
          <button className="dialog__close" onClick={onClose} aria-label="關閉">×</button>
        </header>

        <form onSubmit={submit} className="dialog__body">
          <div className="form-row">
            <label htmlFor="proj-name">專案名稱 *</label>
            <input
              ref={nameRef}
              id="proj-name"
              type="text"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：魅影 2026"
              required
            />
          </div>

          <div className="form-row">
            <label htmlFor="proj-desc">描述</label>
            <textarea
              id="proj-desc"
              maxLength={300}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句話描述這個專案"
            />
            <small className="form-hint">{description.length}/300</small>
          </div>

          <div className="form-row">
            <label htmlFor="proj-show">歸屬於 Show（巡迴）</label>
            <select
              id="proj-show"
              value={showId}
              onChange={(e) => setShowId(e.target.value)}
            >
              <option value="">— 不歸屬任何 Show（獨立專案）—</option>
              {shows.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <small className="form-hint">同一場巡迴的多個場次選同一個 Show，方便一起管理</small>
          </div>

          <div className="form-row form-row--upload">
            <label>3D 模型（.glb / .gltf）</label>
            <div className="upload-placeholder">
              <span>稍後再上傳</span>
              <small>建立後到「模型」分頁拖放或選檔</small>
            </div>
          </div>

          <footer className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="submit" className="btn btn--primary" disabled={!name.trim() || submitting}>
              {submitting ? '建立中…' : '建立專案'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
