import { useEffect, useRef, useState } from 'react';
import './NewProjectDialog.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (data: { name: string; description: string }) => void | Promise<void>;
  submitting?: boolean;
}

export default function NewShowDialog({ open, onClose, onCreate, submitting = false }: Props) {
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
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
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
          <h2>新增 Show 巡迴</h2>
          <button className="dialog__close" onClick={onClose} aria-label="關閉">×</button>
        </header>

        <form onSubmit={submit} className="dialog__body">
          <div className="form-row">
            <label htmlFor="show-name">Show 名稱 *</label>
            <input
              ref={nameRef}
              id="show-name"
              type="text"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：魅影巡迴 2026"
              required
            />
          </div>

          <div className="form-row">
            <label htmlFor="show-desc">描述</label>
            <textarea
              id="show-desc"
              maxLength={300}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="這個 Show 是什麼（巡迴日期、地點…）"
            />
            <small className="form-hint">{description.length}/300</small>
          </div>

          <div className="form-row form-row--upload">
            <label>底下的場次</label>
            <div className="upload-placeholder">
              <span>建好後再加專案進來</span>
              <small>每場次（每天）建一個 project，歸屬到這個 Show</small>
            </div>
          </div>

          <footer className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="btn btn--primary" disabled={!name.trim() || submitting}>
              {submitting ? '建立中…' : '建立 Show'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
