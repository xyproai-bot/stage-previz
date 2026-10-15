import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STAGE_PROP_SPECS, STAGE_PROP_TYPE_IDS } from './stageProps';
import {
  applyPropMaterials, buildStageProp, countStagePropMeshes, createPropMaterials, disposeStageProp, measureStageProp,
} from './stagePropModels';
import { createStagePropsLayer } from './stagePropsScene';
import { hitNormalY } from './scaleReferenceScene';

const mats = createPropMaterials();
const TOL = 0.08;   // 模型的外框跟尺寸表差幾公尺以內都算「大約」

describe('模型的尺寸（公尺）', () => {
  for (const spec of STAGE_PROP_SPECS) {
    it(`${spec.label}：外框 ${spec.size.w} × ${spec.size.d} × ${spec.size.h}${spec.measuredPart ? `（量「${spec.measuredPart}」那一組）` : ''}`, () => {
      const root = buildStageProp(spec.type, mats.normal);
      const m = measureStageProp(root, spec.measuredPart);
      expect(Math.abs(m.w - spec.size.w)).toBeLessThan(TOL);
      expect(Math.abs(m.d - spec.size.d)).toBeLessThan(TOL);
      expect(Math.abs(m.h - spec.size.h)).toBeLessThan(TOL);
    });
  }

  it('需求寫的幾個數字', () => {
    const size = (t: (typeof STAGE_PROP_TYPE_IDS)[number], part?: string) => measureStageProp(buildStageProp(t, mats.normal), part);
    const riser = size('riser');
    expect([riser.w, riser.d, riser.h].map(n => +n.toFixed(2))).toEqual([2.4, 2.4, 0.4]);
    const wedge = size('monitor');
    expect([wedge.w, wedge.d, wedge.h].map(n => +n.toFixed(2))).toEqual([0.6, 0.45, 0.35]);
    const piano = size('piano', 'body');
    expect(piano.w).toBeCloseTo(1.5, 1);
    expect(piano.d).toBeCloseTo(2.1, 1);
    expect(piano.h).toBeCloseTo(1, 1);
    expect(size('piano').h).toBeGreaterThan(1.3);        // 掀開的琴蓋比琴身高
    const table = size('dj', 'table');
    expect([table.w, table.d, table.h].map(n => +n.toFixed(1))).toEqual([1.8, 0.8, 1]);
    expect(size('keyboardist', 'keyboard').w).toBeCloseTo(1.3, 1);
    const kit = size('drummer');
    expect(kit.w).toBeCloseTo(2, 1);
    expect(kit.d).toBeCloseTo(1.8, 1);
    for (const t of ['vocalist', 'backing', 'dancer', 'guitarist', 'bassist', 'percussionist', 'violinist', 'winds', 'keyboardist'] as const) {
      expect(size(t).h).toBeGreaterThan(1.65);
      expect(size(t).h).toBeLessThan(1.76);
    }
  });

  it('一整組的水平中心在原點；坐著的人比站著矮', () => {
    for (const t of ['drummer', 'piano', 'dj', 'riser', 'monitor', 'micStand', 'keyboardist', 'percussionist', 'cellist'] as const) {
      const m = measureStageProp(buildStageProp(t, mats.normal));
      expect(Math.abs(m.center.x)).toBeLessThan(0.02);
      expect(Math.abs(m.center.z)).toBeLessThan(0.02);
    }
    expect(measureStageProp(buildStageProp('cellist', mats.normal)).h).toBeLessThan(1.6);
  });

  it('腳踩在地板上（最低點 y = 0）', () => {
    for (const t of STAGE_PROP_TYPE_IDS) {
      const root = buildStageProp(t, mats.normal);
      root.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(root);
      expect(Math.abs(box.min.y)).toBeLessThan(0.02);
    }
  });
});

describe('輕量：每個模型幾十個基本形狀、共用兩種材質', () => {
  it('形狀數 ≤ 40，而且只用「灰」「深一點的灰」兩種材質', () => {
    for (const t of STAGE_PROP_TYPE_IDS) {
      const root = buildStageProp(t, mats.normal);
      expect(countStagePropMeshes(root)).toBeLessThanOrEqual(40);
      expect(countStagePropMeshes(root)).toBeGreaterThanOrEqual(2);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) expect([mats.normal.main, mats.normal.accent]).toContain(m.material);
      });
    }
  });

  it('選到 / 沒選到只是換材質，形狀不重做', () => {
    const root = buildStageProp('drummer', mats.normal);
    applyPropMaterials(root, mats.selected);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !m.userData.walkTop) expect([mats.selected.main, mats.selected.accent]).toContain(m.material);
    });
    applyPropMaterials(root, mats.normal);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) expect([mats.normal.main, mats.normal.accent]).toContain(m.material);
    });
    disposeStageProp(root);
  });
});

describe('圖層：依清單擺放、選取、點選、樂手台頂面', () => {
  const UPM = 2;   // 1 公尺 = 2 個場景單位
  const items = [
    { id: 'r', type: 'riser' as const, x: 1, y: 0, z: 1, rotY: 0 },
    { id: 'd', type: 'drummer' as const, x: 1, y: 0.4, z: 1, rotY: 90 },
    { id: 'v', type: 'vocalist' as const, x: 6, y: 0, z: 1, rotY: 0 },
  ];
  const fromAbove = (x: number, z: number) => {
    const ray = new THREE.Raycaster();
    ray.set(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0));
    return ray;
  };

  it('公尺換成場景單位、轉角換成弧度、只畫清單裡有的', () => {
    const layer = createStagePropsLayer(UPM);
    layer.sync(items, null);
    expect(layer.group.children).toHaveLength(3);
    const d = layer.group.children.find(c => c.userData.propId === 'd') as THREE.Group;
    expect(d.position.toArray()).toEqual([2, 0.8, 2]);
    expect(d.scale.x).toBe(UPM);
    expect(d.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    layer.sync(items.slice(0, 1), null);
    expect(layer.group.children).toHaveLength(1);
    layer.sync([], null);
    expect(layer.group.children).toHaveLength(0);
    layer.dispose();
  });

  it('光線打到哪一個就選哪一個；站在樂手台上的鼓手比樂手台先被點到', () => {
    const layer = createStagePropsLayer(UPM);
    layer.sync(items, null);
    expect(layer.pick(fromAbove(2, 2))?.id).toBe('d');          // 鼓組中間（上方）
    expect(layer.pick(fromAbove(12, 2))?.id).toBe('v');         // 主唱
    expect(layer.pick(fromAbove(2 + 2.3 * 2, 2))).toBeNull();   // 都沒有的地方
    layer.dispose();
  });

  it('選到：換成琥珀色 + 腳下有圈圈和轉動把手（點得到）；取消就拿掉', () => {
    const layer = createStagePropsLayer(UPM);
    layer.sync(items, 'v');
    const v = layer.group.children.find(c => c.userData.propId === 'v') as THREE.Group;
    const decor = v.getObjectByName('stage-prop-selection');
    expect(decor).toBeTruthy();
    const handle = decor?.children.find(c => c.userData.rotateHandle) as THREE.Mesh;
    expect(handle).toBeTruthy();
    // 把手在正面（+Z）那一邊：世界位置 = 主唱位置 + 往 +Z 一個圈圈半徑
    const wp = handle.getWorldPosition(new THREE.Vector3());
    expect(wp.x).toBeCloseTo(12, 5);
    expect(wp.z).toBeGreaterThan(2);
    const ray = new THREE.Raycaster();
    ray.set(new THREE.Vector3(wp.x, 20, wp.z), new THREE.Vector3(0, -1, 0));
    expect(layer.pickHandle(ray)?.id).toBe('v');
    expect(layer.pick(ray)?.id).not.toBe('v');                  // 圈圈和把手不算「點到這個東西」
    layer.sync(items, null);
    expect(v.getObjectByName('stage-prop-selection')).toBeUndefined();
    layer.dispose();
  });

  it('樂手台的頂面可以站（正在拖的和站在它上面的不算）；別的東西沒有', () => {
    const layer = createStagePropsLayer(UPM);
    layer.sync(items, null);
    const tops = layer.walkables();
    expect(tops).toHaveLength(1);
    const hit = fromAbove(2, 2).intersectObject(tops[0], false)[0];
    expect(hit.point.y).toBeCloseTo(0.4 * UPM, 5);
    expect(hitNormalY(hit)).toBeCloseTo(1, 5);   // 面朝上（拖的時候用法線 y 分辨是地面還是牆）
    // 從下面往上打不會打到（只有正面）
    const up = new THREE.Raycaster();
    up.set(new THREE.Vector3(2, -5, 2), new THREE.Vector3(0, 1, 0));
    expect(up.intersectObject(tops[0], false)).toHaveLength(0);
    expect(layer.walkables(new Set(['r']))).toHaveLength(0);
    layer.dispose();
  });
});
