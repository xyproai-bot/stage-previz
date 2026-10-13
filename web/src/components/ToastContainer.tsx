import { useToasts, toast } from '../lib/toast';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import './ToastContainer.css';

export default function ToastContainer() {
  const items = useToasts();
  if (items.length === 0) return null;
  return (
    <div className="toast-container">
      {items.map(t => (
        <div key={t.id} className={'toast toast--' + t.kind} role="status">
          <span className="toast__icon">
            <Icon
              size="md"
              icon={t.kind === 'success' ? CircleCheck
                : t.kind === 'info' ? Info
                : t.kind === 'warn' ? TriangleAlert
                : CircleX}
            />
          </span>
          <span className="toast__text">{t.text}</span>
          <button className="toast__close" onClick={() => toast.dismiss(t.id)} title="關閉" aria-label="關閉"><Icon icon={X} /></button>
        </div>
      ))}
    </div>
  );
}
