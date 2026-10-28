// 整組選：一個把手 / 滑桿一次動哪些機關。
//   一排機關（groupId）：只有這個 / 整排一起 / 照物件位置分的左半、右半（觀眾看過去的左右）
//   吊點（variant 'hoist'）：預設左右一起（整組吊掛的每個吊點）；取消就只動這一個，讓它斜
// 一起動的時候每個加一樣的量（draft.ts 的 moveTogether）。

import type { Mechanism, MechVec3 } from '../mechanisms/model';

export type ScopeKey = 'one' | 'all' | 'left' | 'right';

export type ScopeDef = Pick<Mechanism, 'id'> & Partial<Pick<Mechanism, 'groupId' | 'groupIndex' | 'variant' | 'rigId' | 'rigIndex'>>;

export interface Halves { left: string[]; right: string[] }

/** 一排的成員（照 groupIndex，一樣的照原本順序） */
export function membersOfGroup<T extends ScopeDef>(defs: T[], groupId: string): T[] {
  return defs
    .map((d, i) => ({ d, i }))
    .filter(x => x.d.groupId === groupId)
    .sort((a, b) => ((a.d.groupIndex ?? 1e9) - (b.d.groupIndex ?? 1e9)) || (a.i - b.i))
    .map(x => x.d);
}

/** 一組吊掛的吊點（照吊點編號） */
export function hoistsOfRigDefs<T extends ScopeDef>(defs: T[], rigId: string): T[] {
  return defs
    .map((d, i) => ({ d, i }))
    .filter(x => x.d.variant === 'hoist' && x.d.rigId === rigId)
    .sort((a, b) => ((a.d.rigIndex ?? 1e9) - (b.d.rigIndex ?? 1e9)) || (a.i - b.i))
    .map(x => x.d);
}

/**
 * 照物件位置分左半 / 右半（觀眾看過去：右 = (−正面) × 上）。各自照左到右排；正中間（跟平均差不到 1e-6）的兩邊都不算。
 * front 壞掉（沒有水平分量）→ 當成面向 +z。
 */
export function splitHalves(members: { id: string; pos: MechVec3 }[], front: MechVec3): Halves {
  let fx = front.x, fz = front.z;
  const len = Math.hypot(fx, fz);
  if (!(len > 1e-9)) { fx = 0; fz = 1; } else { fx /= len; fz /= len; }
  // (−f) × (0,1,0) = (fz, 0, −fx)
  const rx = fz, rz = -fx;
  const proj = members.map(m => ({ id: m.id, p: m.pos.x * rx + m.pos.z * rz }));
  if (proj.length === 0) return { left: [], right: [] };
  const mean = proj.reduce((s, x) => s + x.p, 0) / proj.length;
  const sorted = [...proj].sort((a, b) => a.p - b.p);
  return {
    left: sorted.filter(x => x.p < mean - 1e-6).map(x => x.id),
    right: sorted.filter(x => x.p > mean + 1e-6).map(x => x.id),
  };
}

export interface DriveOptions {
  mechId: string;
  defs: ScopeDef[];
  /** 每一排選的範圍（groupId → 範圍；沒有 = 只有這個） */
  scope: Record<string, ScopeKey | undefined>;
  /** 這組吊掛是不是左右一起 */
  linked: (rigId: string) => boolean;
  /** 這一排的左半 / 右半；分不出來 → null */
  halves: (groupId: string) => Halves | null;
}

/** 這個把手 / 滑桿一次動哪些機關（主要的一定在第一個以外的位置也沒關係：照排好的順序） */
export function driveIds(o: DriveOptions): string[] {
  const def = o.defs.find(d => d.id === o.mechId);
  if (!def) return [o.mechId];
  if (def.variant === 'hoist' && def.rigId) {
    if (!o.linked(def.rigId)) return [o.mechId];
    const ids = hoistsOfRigDefs(o.defs, def.rigId).map(d => d.id);
    return ids.length > 1 ? ids : [o.mechId];
  }
  if (def.groupId) {
    const members = membersOfGroup(o.defs, def.groupId).map(d => d.id);
    if (members.length < 2) return [o.mechId];
    const s = o.scope[def.groupId] ?? 'one';
    if (s === 'all') return members;
    if (s === 'left' || s === 'right') {
      const h = o.halves(def.groupId);
      const side = h ? h[s].filter(id => members.includes(id)) : [];
      return side.length > 0 ? members.filter(id => side.includes(id)) : [o.mechId];
    }
  }
  return [o.mechId];
}
