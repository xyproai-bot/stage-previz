import { useSaveStatus } from '../lib/saveStatus';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import Icon from './Icon';
import './SaveIndicator.css';

export default function SaveIndicator() {
  const s = useSaveStatus();

  if (s.kind === 'idle') return null;
  if (s.kind === 'saving') {
    return <span className="save-ind save-ind--saving" title="儲存中"><Icon icon={LoaderCircle} spin /> 儲存中…</span>;
  }
  if (s.kind === 'saved') {
    return <span className="save-ind save-ind--saved" title="已儲存"><Icon icon={Check} /> 已儲存</span>;
  }
  return <span className="save-ind save-ind--error" title={s.message}><Icon icon={TriangleAlert} /> 儲存失敗</span>;
}
