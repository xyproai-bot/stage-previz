// 物件狀態分頁的小提醒：這個物件裝在機關上 → 畫面上的位置 = 這裡的位置 + 機關
import { Cog } from 'lucide-react';
import Icon from '../Icon';
import type { EditorMechanisms } from '../../lib/mechanisms/useMechanisms';
import { formatMechValue } from '../../lib/mechanisms/motion';
import './mechanisms.css';

export default function MechanismObjectHint({ mech, objectId }: { mech: EditorMechanisms; objectId: string }) {
  const m = mech.mechanisms.find(x => x.objectIds.includes(objectId));
  if (!m) return null;
  const value = mech.targets[m.id] ?? m.defaultValue;
  return (
    <div className="mech-object-hint" role="note">
      <Icon icon={Cog} size="sm" />
      <span>這個物件在「{m.name}」上（目前 {formatMechValue(value, m.kind)}），畫面上的位置還要加上機關。要改{m.name}請到「機關」分頁</span>
    </div>
  );
}
