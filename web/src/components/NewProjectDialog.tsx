import { useEffect, useRef, useState } from 'react';
import './NewProjectDialog.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (data: { name: string; description: string }) => void | Promise<void>;
  submitting?: boolean;
}

export default function NewProjectDialog({ open, onClose, onCreate, submitting = false }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open]);

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
    onCreate({ name: name.trim(), description: description.trim() });
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
