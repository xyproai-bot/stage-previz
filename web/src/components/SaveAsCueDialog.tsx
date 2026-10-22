// 「另存成新的 cue」：編號（自己打，預填建議的）+ 名稱（預填原本的名稱）。規格第 10 節。

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import Icon from './Icon';
import { labelError, LABEL_MAX } from '../lib/lookDraft';
import './NewProjectDialog.css';
import './LookDraftBar.css';

interface Props {
  defaultLabel: string;
  defaultName: string;
  /** 專案裡已經有的編號（先檢查，後台也會再檢查一次） */
  existingLabels: string[];
  /** 回 null = 存好了（關掉）；回文字 = 要顯示的錯誤 */
  onSave: (label: string, name: string) => Promise<string | null>;
  onCancel: () => void;
}

export default function SaveAsCueDialog({ defaultLabel, defaultName, existingLabels, onSave, onCancel }: Props) {
  const [label, setLabel] = useState(defaultLabel);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.select(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [onCancel, busy]);

  const labelErr = labelError(label, existingLabels);
  const nameOk = name.trim().length > 0;
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (labelErr || !nameOk || busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const err = await onSave(label.trim(), name.trim());
      if (err) setServerError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="dialog cue-save-dlg" role="dialog" aria-modal="true" aria-labelledby="cue-save-title" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 id="cue-save-title">另存成新的 cue</h2>
          <button className="dialog__close" onClick={onCancel} disabled={busy} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <form className="dialog__body" onSubmit={submit}>
          <p className="cue-save-dlg__hint">這首歌目前的 cue 會改成用這個新的 cue，其他歌不受影響。</p>
          <div className="form-row">
            <label htmlFor="cue-save-label">編號</label>
            <input id="cue-save-label" ref={ref} value={label} maxLength={LABEL_MAX + 8} onChange={(e) => { setLabel(e.target.value); setServerError(null); }} placeholder="例：3-1、301、最後一號" />
            {(labelErr || serverError) && <div className="cue-save-dlg__error">{serverError || labelErr}</div>}
          </div>
          <div className="form-row">
            <label htmlFor="cue-save-name">名稱</label>
            <input id="cue-save-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>取消</button>
            <button type="submit" className="btn btn--primary" disabled={!!labelErr || !nameOk || busy}>{busy ? '儲存中…' : '另存'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
