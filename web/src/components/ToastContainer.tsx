import { useToasts, toast } from '../lib/toast';
import './ToastContainer.css';

export default function ToastContainer() {
  const items = useToasts();
  if (items.length === 0) return null;
  return (
    <div className="toast-container">
      {items.map(t => (
        <div key={t.id} className={'toast toast--' + t.kind} role="status">
          <span className="toast__icon">
            {t.kind === 'success' ? '✓'
              : t.kind === 'info' ? 'ℹ'
              : t.kind === 'warn' ? '⚠'
              : '✕'}
          </span>
          <span className="toast__text">{t.text}</span>
          <button className="toast__close" onClick={() => toast.dismiss(t.id)} aria-label="關閉">×</button>
        </div>
      ))}
    </div>
  );
}
