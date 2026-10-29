import { describe, expect, it } from 'vitest';
import {
  NO_MOUNTS, gizmoBlockedByMechanism, mechanismNameOfObject, mountedNames, objectMountMap, stageLockMessage, type MountingMechanism,
} from './stageLock';

const mech = (name: string, objectIds: string[]): MountingMechanism => ({ name, objectIds });
const lift = mech('中央升降台', ['led1', 'led2']);
const turntable = mech('轉台', ['drum']);
const hoistRig = mech('吊掛一組', ['truss']);
const hoistPoint = mech('吊點 1', []);          // 吊點自己沒有物件
const row = [mech('一排 1', ['bar1']), mech('一排 2', ['bar2'])];
const all = [lift, turntable, hoistRig, hoistPoint, ...row];

describe('裝在機關上的物件：哪個機關', () => {
  it('在機關的物件清單裡 → 回傳機關名字', () => {
    expect(mechanismNameOfObject('led1', all)).toBe('中央升降台');
    expect(mechanismNameOfObject('drum', all)).toBe('轉台');
  });
  it('吊掛整組帶的物件、一排裡每個成員帶的物件都算', () => {
    expect(mechanismNameOfObject('truss', all)).toBe('吊掛一組');
    expect(mechanismNameOfObject('bar1', all)).toBe('一排 1');
    expect(mechanismNameOfObject('bar2', all)).toBe('一排 2');
  });
  it('沒裝在任何機關上 / 沒有機關 / 還沒讀到 → null', () => {
    expect(mechanismNameOfObject('speaker', all)).toBeNull();
    expect(mechanismNameOfObject('led1', [])).toBeNull();
    expect(mechanismNameOfObject('led1', null)).toBeNull();
    expect(mechanismNameOfObject('led1', undefined)).toBeNull();
  });
  it('同一個物件在兩個機關（資料不該這樣）→ 用排在前面的', () => {
    expect(mechanismNameOfObject('x', [mech('甲', ['x']), mech('乙', ['x'])])).toBe('甲');
  });
  it('名字空白 → 寫「機關」，不會是空的', () => {
    expect(mechanismNameOfObject('x', [mech('', ['x'])])).toBe('機關');
  });
  it('沒有任何物件裝在機關上 → 共用的空表', () => {
    expect(objectMountMap([hoistPoint])).toBe(NO_MOUNTS);
    expect(objectMountMap(null)).toBe(NO_MOUNTS);
  });
});

describe('選到的物件 → 哪些機關', () => {
  const mounts = objectMountMap(all);
  it('照選的順序、同一個機關只列一次', () => {
    expect(mountedNames(['drum', 'led1', 'led2', 'speaker'], mounts)).toEqual(['轉台', '中央升降台']);
  });
  it('一個都沒裝在機關上 = 空', () => {
    expect(mountedNames(['speaker', 'piano'], mounts)).toEqual([]);
    expect(mountedNames([], mounts)).toEqual([]);
  });
});

describe('畫面上那一句話', () => {
  it('單選：這個物件裝在「X」上，只能用機關的滑桿動（不會超過上下限）', () => {
    expect(stageLockMessage(['中央升降台'], 1)).toBe('這個物件裝在「中央升降台」上，只能用機關的滑桿動（不會超過上下限）');
  });
  it('沒有裝在機關上 → 沒有這句話', () => {
    expect(stageLockMessage([], 1)).toBeNull();
    expect(stageLockMessage([], 3)).toBeNull();
  });
  it('多選：只要有一個是，整組都不能直接動', () => {
    const t = stageLockMessage(['轉台'], 3)!;
    expect(t).toContain('「轉台」');
    expect(t).toContain('整組都不能直接移動或旋轉');
    expect(t).toContain('不會超過上下限');
  });
  it('機關很多 → 只列前三個，其餘寫「等 N 個機關」', () => {
    const t = stageLockMessage(['甲', '乙', '丙', '丁', '戊'], 8)!;
    expect(t).toContain('「甲」「乙」「丙」等 5 個機關');
    expect(t).not.toContain('「丁」');
  });
});

describe('3D 畫面：要不要擋掉移動 / 旋轉箭頭', () => {
  const mounts = objectMountMap(all);
  it('單選裝在機關上的物件 → 擋', () => {
    expect(gizmoBlockedByMechanism(['led1'], mounts, false)).toBe(true);
    expect(gizmoBlockedByMechanism(['truss'], mounts, false)).toBe(true);
  });
  it('單選沒裝在機關上的物件 → 不擋（照舊能拖）', () => {
    expect(gizmoBlockedByMechanism(['speaker'], mounts, false)).toBe(false);
  });
  it('多選：只要有一個裝在機關上，整組都擋', () => {
    expect(gizmoBlockedByMechanism(['speaker', 'piano', 'drum'], mounts, false)).toBe(true);
    expect(gizmoBlockedByMechanism(['speaker', 'piano'], mounts, false)).toBe(false);
  });
  it('專案沒有任何機關 → 不擋', () => {
    expect(gizmoBlockedByMechanism(['speaker'], NO_MOUNTS, false)).toBe(false);
  });
  it('機關清單還在讀 → 先擋（讀到之前分不出來）', () => {
    expect(gizmoBlockedByMechanism(['speaker'], NO_MOUNTS, true)).toBe(true);
  });
});
