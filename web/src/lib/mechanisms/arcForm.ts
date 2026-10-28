// 「設定機關」畫面裡沿弧形軌道（variant 'arc'）會用到的小算法（純計算，畫面只負責顯示）：
//   挑圓心（跟哪個機關同一個圓心）、轉軸的正負（自動 / 手動）、「值變大往哪邊走」的白話。
// 設計：docs/superpowers/specs/2026-10-29-director-stage-control-design.md 第 3.2 節
import { LINEAR_DIRECTIONS, matchLinearDirection, splitSideName, type Mechanism, type MechVec3 } from './model';
import { arcAxisFor } from './arc';

export interface ArcCenterChoice {
  /** 下拉選單的值（機關 id；對開的兩邊 id:a / id:b） */
  key: string;
  label: string;
  /** 圓心（場景單位；複製品，改它不會動到機關） */
  pivot: MechVec3;
}

/**
 * 可以「跟它同一個圓心」的機關：有轉軸中心的旋轉機關、對開（A 邊、B 邊各一個）、別的弧形機關。
 * 不列自己；沒有圓心的（一般直線、吊掛）不列。
 */
export function arcCenterChoices(
  mechanisms: Pick<Mechanism, 'id' | 'name' | 'kind' | 'variant' | 'pivot' | 'mirror'>[], selfId: string | null,
): ArcCenterChoice[] {
  const out: ArcCenterChoice[] = [];
  for (const m of mechanisms) {
    if (m.id === selfId || !m.pivot) continue;
    if (m.kind !== 'rotary' && m.variant !== 'arc') continue;
    if (m.variant === 'split' && m.mirror?.pivot) {
      out.push({ key: `${m.id}:a`, label: splitSideName(m.name, 'a'), pivot: { ...m.pivot } });
      out.push({ key: `${m.id}:b`, label: splitSideName(m.name, 'b'), pivot: { ...m.mirror.pivot } });
    } else {
      out.push({ key: m.id, label: m.name, pivot: { ...m.pivot } });
    }
  }
  return out;
}

export interface ArcAxisState {
  /** 已經存的轉軸不是垂直（舊資料 / 別的工具建的）→ 原樣留著 */
  keepAxis: MechVec3 | null;
  /** 手動按過「反過來」，或編輯已經存好的弧形：照 down 的正負，不再自動挑 */
  touched: boolean;
  /** 轉軸朝下（-Y）；false = 朝上（+Y） */
  down: boolean;
  /** 切到弧形時原本直線的方向（自動挑正負時，讓值變大往這個方向那一邊走） */
  want: MechVec3;
}

/** 現在這個弧形用的轉軸（單位向量）。圓心 / 物件還沒有 → 先朝上 */
export function resolveArcAxis(s: ArcAxisState, pivot: MechVec3 | null, center: MechVec3 | null): MechVec3 {
  if (s.keepAxis) return s.keepAxis;
  if (s.touched || !pivot || !center) return s.down ? { x: 0, y: -1, z: 0 } : { x: 0, y: 1, z: 0 };
  return arcAxisFor(pivot, { x: 0, y: 1, z: 0 }, center, s.want);
}

/** 「值變大往哪邊走」白話（物件在原位置、往正的方向走的那個方向）；物件就在圓心上 / 缺圓心或物件 → null */
export function arcMoveWord(pivot: MechVec3 | null, axis: MechVec3, center: MechVec3 | null, front: MechVec3): string | null {
  if (!pivot || !center) return null;
  // 繞轉軸往正角度轉時，離圓心 rel 的點往 axis × rel 的方向走（右手定則）
  const rel = { x: center.x - pivot.x, y: center.y - pivot.y, z: center.z - pivot.z };
  const mv = {
    x: axis.y * rel.z - axis.z * rel.y,
    y: axis.z * rel.x - axis.x * rel.z,
    z: axis.x * rel.y - axis.y * rel.x,
  };
  const l = Math.hypot(mv.x, mv.y, mv.z);
  if (!(l > 1e-9)) return null;
  const dir = matchLinearDirection({ x: mv.x / l, y: mv.y / l, z: mv.z / l }, front).dir;
  const label = LINEAR_DIRECTIONS.find(x => x.key === dir)!.label;
  return `${label}${dir === 'left' || dir === 'right' ? '（觀眾看過去）' : ''}`;
}
