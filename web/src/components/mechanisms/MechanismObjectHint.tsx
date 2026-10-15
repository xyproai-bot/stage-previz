// 物件狀態分頁的小提醒：這個物件裝在機關上 → 畫面上的位置 = 這裡的位置 + 機關
// 管理頁用 <MechanismHintProvider value={mech}> 包住右邊欄，物件面板放一個 <MechanismObjectHint objectId=… /> 就好
import { createContext, useContext } from 'react';
import { Cog } from 'lucide-react';
import Icon from '../Icon';
import type { EditorMechanisms } from '../../lib/mechanisms/useMechanisms';
import { formatMechValue } from '../../lib/mechanisms/motion';
import './mechanisms.css';

const Ctx = createContext<EditorMechanisms | null>(null);
export const MechanismHintProvider = Ctx.Provider;

export default function MechanismObjectHint({ objectId }: { objectId: string }) {
  const mech = useContext(Ctx);
  const m = mech?.mechanisms.find(x => x.objectIds.includes(objectId));
  if (!mech || !m) return null;
  if (m.variant === 'hoist_rig') {
    return (
      <div className="mech-object-hint" role="note">
        <Icon icon={Cog} size="sm" />
        <span>這個物件在吊掛「{m.name}」上，畫面上的位置還要加上吊點拉高的高度。要改請到「機關」分頁</span>
      </div>
    );
  }
  const value = mech.targets[m.id] ?? m.defaultValue;
  return (
    <div className="mech-object-hint" role="note">
      <Icon icon={Cog} size="sm" />
      <span>這個物件在「{m.name}」上（目前 {formatMechValue(value, m.kind)}），畫面上的位置還要加上機關。要改{m.name}請到「機關」分頁</span>
    </div>
  );
}
