// 管理頁（編輯專案）在手機上的小提醒。編輯是為電腦、平板橫放設計的（要拖 3D 物件、排 cue、改機關），
// 手機只適合看；這條提醒只在手機寬度（640px 以下）出現，電腦和 iPad 看不到。按「知道了」這次開著就不再出現。
import { useState } from 'react';
import { Monitor, X } from 'lucide-react';
import Icon from './Icon';
import './PhoneEditNote.css';

const CLOSED_KEY = 'sp_phone_edit_note_closed';

function wasClosed(): boolean {
  try { return sessionStorage.getItem(CLOSED_KEY) === '1'; } catch { return false; }
}

export default function PhoneEditNote() {
  const [closed, setClosed] = useState(wasClosed);
  if (closed) return null;
  const close = () => {
    try { sessionStorage.setItem(CLOSED_KEY, '1'); } catch { /* 沒存成，下次還會看到而已 */ }
    setClosed(true);
  };
  return (
    <div className="phone-edit-note" role="note">
      <Icon icon={Monitor} size="md" />
      <span className="phone-edit-note__text">編輯請用電腦或平板橫放；手機上可以看，但很多操作不方便。</span>
      <button type="button" className="phone-edit-note__close" onClick={close} title="知道了" aria-label="知道了">
        <Icon icon={X} size="sm" />
      </button>
    </div>
  );
}
