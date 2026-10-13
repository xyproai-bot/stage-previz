// 導演（或製作）按「需修改」：一定要寫原因（動畫師才知道從哪裡改），原因也會發成一則留言。
// 標題寫清楚看的是哪一版（V2），送出後後台記到審片紀錄。

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import Icon from './Icon';
import './NewProjectDialog.css';
import './DecisionDialog.css';

export const REASON_MAX = 500;

interface Props {
  songName: string;
  /** 看的是哪一版（'V2'）；沒有影片 = '' */
  versionLabel: string;
  onCancel: () => void;
  /** 回 true = 送出成功（關掉） */
  onSubmit: (reason: string) => Promise<boolean>;
}

export default function DecisionDialog({ songName, versionLabel, onCancel, onSubmit }: Props) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [onCancel, busy]);

  const text = reason.trim();
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!text || busy) return;
    setBusy(true);
    try {
      if (await onSubmit(text)) return;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="dialog decision-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-title" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 id="decision-title">
            {versionLabel ? <span className="decision-dialog__ver">{versionLabel}</span> : null}
            需修改：{songName}
          </h2>
          <button className="dialog__close" onClick={onCancel} disabled={busy} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <form className="dialog__body" onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="decision-reason">要改什麼（一定要寫）</label>
            <textarea
              id="decision-reason"
              ref={ref}
              rows={4}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
              placeholder="例：第二段 LED 太亮；0:42 的轉場慢半拍"
            />
            <small className="form-hint">{reason.length}/{REASON_MAX}</small>
          </div>
          <p className="decision-dialog__note">
            這段話會出現在留言裡{versionLabel ? `（綁在 ${versionLabel}）` : ''}，動畫師也會收到通知。動畫師交新版後，歌會自動回到「審查中」。
          </p>
          <div className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>取消</button>
            <button type="submit" className="btn btn--danger" disabled={!text || busy}>{busy ? '送出中…' : '送出「需修改」'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
