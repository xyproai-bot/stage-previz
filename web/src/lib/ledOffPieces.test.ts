import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blackenMaterial, isOffMesh, normalizeOffPieces, offPieceKey, offScreenMeshes, restoreOffMaterials, swapOffMaterials } from './ledOffPieces';
import { buildLedEmitters } from './stageLook/ledEmitters';

/** 台體 + 三塊 LED（正面、左、右），LED 共用同一個材質 */
function stage() {
  const root = new THREE.Group();
  root.name = '升降台';
  const shared = new THREE.MeshStandardMaterial({ name: 'LED_face', color: 0x88aaff });
  const mk = (name: string, mat: THREE.Material, x: number, ry: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), mat);
    m.name = name; m.position.x = x; m.rotation.y = ry;
    root.add(m);
    return m;
  };
  const base = mk('台體', new THREE.MeshStandardMaterial({ name: 'Frame' }), 0, 0);
  const front = mk('LED_F', shared, 0, 0);
  const left = mk('LED_L', shared, -3, Math.PI / 2);
  const right = mk('LED_R', shared, 3, -Math.PI / 2);
  return { root, shared, base, front, left, right };
}

describe('offScreenMeshes：哪些螢幕要黑', () => {
  it('物件裡某一塊被排除：只有那一塊（其他塊、台體照常）', () => {
    const s = stage();
    const off = offScreenMeshes(s.root, 'o1', true, [offPieceKey('o1', 'LED_R')]);
    expect([...off]).toEqual([s.right]);
  });
  it('兩塊都排除 / 別的物件的塊不算', () => {
    const s = stage();
    const off = offScreenMeshes(s.root, 'o1', true, ['o1~LED_L', 'o1~LED_R', 'o2~LED_F']);
    expect(new Set(off)).toEqual(new Set([s.left, s.right]));
  });
  it('整個物件被排除（類型已經是其他）：物件裡所有螢幕都黑，台體不黑', () => {
    const s = stage();
    const off = offScreenMeshes(s.root, 'o1', false, ['o1']);
    expect(new Set(off)).toEqual(new Set([s.front, s.left, s.right]));
    expect(off.has(s.base)).toBe(false);
  });
  it('整個物件那一項：製作手動改回 LED 面板之後不算（照常顯示）', () => {
    const s = stage();
    expect(offScreenMeshes(s.root, 'o1', true, ['o1']).size).toBe(0);
  });
  it('沒排除過（空清單 / 沒有這個物件）→ 什麼都不黑', () => {
    const s = stage();
    expect(offScreenMeshes(s.root, 'o1', true, []).size).toBe(0);
    expect(offScreenMeshes(s.root, 'o1', false, []).size).toBe(0);
    expect(offScreenMeshes(s.root, 'o1', true, ['o2', 'o2~LED_R']).size).toBe(0);
    expect(offScreenMeshes(s.root, 'o1', true, new Set())).toEqual(new Set());
  });
  it('只有一塊 LED 的物件分不出「某一塊」：物件裡的塊記號不生效', () => {
    const root = new THREE.Group();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ name: 'LED' }));
    m.name = 'LED_A';
    root.add(m);
    expect(offScreenMeshes(root, 'o1', true, ['o1~LED_A']).size).toBe(0);
  });
});

describe('黑色材質：換成自己的複本，共用的來源不動，還原得回來', () => {
  it('被排除的塊黑色、不發光、沒貼圖；其他塊和共用的材質完全不變', () => {
    const s = stage();
    s.shared.emissive.set(0x3366ff); s.shared.emissiveIntensity = 1.5;
    const before = { color: s.shared.color.getHex(), emissive: s.shared.emissive.getHex(), roughness: s.shared.roughness };
    const off = offScreenMeshes(s.root, 'o1', true, ['o1~LED_R']);
    swapOffMaterials(off);
    const own = s.right.material as THREE.MeshStandardMaterial;
    expect(own).not.toBe(s.shared);
    expect(own.name).toBe('LED_face');
    blackenMaterial(own);
    expect(own.color.getHex()).toBe(0x000000);
    expect(own.map).toBeNull();
    expect(own.emissiveMap).toBeNull();
    // 共用的來源、別塊都沒被動到
    expect(s.front.material).toBe(s.shared);
    expect(s.left.material).toBe(s.shared);
    expect({ color: s.shared.color.getHex(), emissive: s.shared.emissive.getHex(), roughness: s.shared.roughness }).toEqual(before);
    expect(isOffMesh(s.right)).toBe(true);
    expect(isOffMesh(s.front)).toBe(false);
  });
  it('重複整理不會一直複製；清單改掉（不再排除）→ 還原成原本共用的材質', () => {
    const s = stage();
    const off = offScreenMeshes(s.root, 'o1', true, ['o1~LED_R']);
    swapOffMaterials(off);
    const first = s.right.material;
    swapOffMaterials(off);
    expect(s.right.material).toBe(first);
    restoreOffMaterials(s.root);
    expect(s.right.material).toBe(s.shared);
    expect(isOffMesh(s.right)).toBe(false);
    restoreOffMaterials(s.root);   // 沒換過的再還原一次也沒事
    expect(s.front.material).toBe(s.shared);
  });
});

describe('被排除的塊不打光', () => {
  it('buildLedEmitters 跳過被排除的 mesh；沒有排除 = 跟以前一模一樣', () => {
    const s = stage();
    s.root.updateMatrixWorld(true);
    const all = buildLedEmitters(s.root, { maxAngleDeg: 35, maxPerObject: 8 });
    const same = buildLedEmitters(s.root, { maxAngleDeg: 35, maxPerObject: 8, exclude: new Set() });
    expect(same).toEqual(all);
    const noRight = buildLedEmitters(s.root, { maxAngleDeg: 35, maxPerObject: 8, exclude: new Set([s.right]) });
    expect(all.length).toBe(3);
    expect(noRight.length).toBe(2);
  });
});

describe('normalizeOffPieces', () => {
  it('只留字串、去重；不是陣列 = 空', () => {
    expect(normalizeOffPieces(['a', 'a~b', 5, '', null, 'a'])).toEqual(['a', 'a~b']);
    expect(normalizeOffPieces(undefined)).toEqual([]);
    expect(normalizeOffPieces({})).toEqual([]);
  });
});
