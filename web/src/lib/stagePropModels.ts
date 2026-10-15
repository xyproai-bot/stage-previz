// 比例尺的樂手和器材：用 three 的基本形狀（方塊、圓柱、球…）組成的簡單灰色模型，不用下載任何檔案。
//
// 單位：公尺。每個模型的原點在腳底（地板）正中間，正面朝 +Z。組好後量一次外框：
// 鼓組、鋼琴這類「一整組」的把水平中心移到原點；單獨一個人（原點就在腳下）不移。
// 呼叫的人再用 root.scale = unitsPerMeter 換成場景單位。
// 每個模型是一個 Group，裡面有幾十個基本形狀，全部共用同一組材質（灰 + 深一點的灰），畫面很輕。

import * as THREE from 'three';
import { RISER_TYPE, stagePropSpec, type StagePropType } from './stageProps';

export interface PropMaterials {
  main: THREE.Material;
  accent: THREE.Material;
}

/** 一般的灰色 / 選到的琥珀色。有一點自發光，暗場（現場模式）裡也看得到形狀 */
export function createPropMaterials(): { normal: PropMaterials; selected: PropMaterials } {
  // toneMapped: false → 現場模式（暗場、曝光很低）裡也不會被壓成黑的；亮度另外靠 emissiveIntensity（StagePropsLayer.setBoost）
  const std = (color: number, emissive: number) => new THREE.MeshStandardMaterial({
    color, emissive, emissiveIntensity: 1, roughness: 0.92, metalness: 0, fog: false, toneMapped: false,
  });
  return {
    normal: { main: std(0xa8a8a8, 0x3c3c3c), accent: std(0x686868, 0x242424) },
    selected: { main: std(0xf2c46d, 0x6a4c14), accent: std(0xc48a22, 0x4a3008) },
  };
}

/** 把一個模型（含子零件）的材質換成這一組（選到 / 沒選到） */
export function applyPropMaterials(root: THREE.Object3D, mats: PropMaterials): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.keepMaterial) return;
    m.material = m.userData.accent ? mats.accent : mats.main;
  });
}

type V3 = [number, number, number];

/** 小工具：往一個 Group 裡加形狀（y 都是「底部的高度」，方便照真實尺寸疊） */
class Parts {
  readonly g = new THREE.Group();
  constructor(private readonly mats: PropMaterials) {}

  mesh(geo: THREE.BufferGeometry, accent: boolean, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, accent ? this.mats.accent : this.mats.main);
    m.position.set(x, y, z);
    m.userData.accent = accent;
    this.g.add(m);
    return m;
  }

  /** 零件組（取名字讓測試量尺寸） */
  sub(name: string): Parts {
    const p = new Parts(this.mats);
    p.g.name = name;
    this.g.add(p.g);
    return p;
  }

  box(w: number, h: number, d: number, x: number, y0: number, z: number, accent = false, rot: V3 = [0, 0, 0]): THREE.Mesh {
    const m = this.mesh(new THREE.BoxGeometry(w, h, d), accent, x, y0 + h / 2, z);
    m.rotation.set(rot[0], rot[1], rot[2]);
    return m;
  }

  /** 直立圓柱（上半徑、下半徑、高） */
  cyl(rTop: number, rBot: number, h: number, x: number, y0: number, z: number, accent = false, seg = 14): THREE.Mesh {
    return this.mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), accent, x, y0 + h / 2, z);
  }

  /** 躺著的圓柱，軸朝 z（大鼓） */
  cylZ(r: number, len: number, x: number, yc: number, z: number, accent = false): THREE.Mesh {
    const m = this.mesh(new THREE.CylinderGeometry(r, r, len, 18), accent, x, yc, z);
    m.rotation.x = Math.PI / 2;
    return m;
  }

  ball(r: number, x: number, y: number, z: number, accent = false, sx = 1, sy = 1, sz = 1): THREE.Mesh {
    const m = this.mesh(new THREE.SphereGeometry(r, 14, 10), accent, x, y, z);
    m.scale.set(sx, sy, sz);
    return m;
  }

  /** 兩點之間的一根棍子（手臂、腿、支架）；a 端半徑 r、b 端半徑 rEnd */
  rod(a: V3, b: V3, r: number, accent = false, rEnd = r): THREE.Mesh {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    const m = this.mesh(new THREE.CylinderGeometry(rEnd, r, Math.max(len, 1e-6), 8), accent, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    if (len > 1e-9) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return m;
  }

  /** 扁圓盤（鈸、唱盤） */
  disc(r: number, thick: number, x: number, yc: number, z: number, accent = false, tilt: V3 = [0, 0, 0]): THREE.Mesh {
    const m = this.mesh(new THREE.CylinderGeometry(r, r, thick, 20), accent, x, yc, z);
    m.rotation.set(tilt[0], tilt[1], tilt[2]);
    return m;
  }
}

// ─────────────────────────────────────────────
// 人
// ─────────────────────────────────────────────

interface PersonOpts {
  /** 坐下時屁股離地的高度；沒給 = 站著 */
  seat?: number;
  /** 腳左右張開幾倍（1 = 正常） */
  spread?: number;
  /** 手的位置（人的腳底原點為準；沒給 = 垂在身體兩側） */
  hands?: { l?: V3; r?: V3 };
  /** 腳踝的位置（站著才有用；沒給 = 站直） */
  feet?: { l?: V3; r?: V3 };
}

/** 一個 1.7 公尺的人（站著）或坐著的人，回傳放這個人的零件組（原點 = 腳底中間） */
function person(parent: Parts, name: string, o: PersonOpts = {}): Parts {
  const p = parent.sub(name);
  const seated = o.seat !== undefined;
  const hip = seated ? (o.seat as number) : 0.83;
  const sp = o.spread ?? 1;
  // 腿
  for (const s of [-1, 1]) {
    if (seated) {
      const kx = 0.11 * sp * s;
      p.rod([0.1 * s, hip + 0.02, -0.02], [kx, hip, 0.42], 0.07, false, 0.065);   // 大腿
      p.rod([kx, hip, 0.42], [kx, 0.06, 0.46], 0.055, false, 0.045);               // 小腿
      p.box(0.1, 0.06, 0.26, kx, 0, 0.5, true);                                    // 腳
    } else {
      const ankle: V3 = (s < 0 ? o.feet?.l : o.feet?.r) ?? [0.1 * sp * s, 0.04, 0];
      p.rod([0.1 * s, hip, 0], ankle, 0.065, false, 0.05);
      p.box(0.1, 0.06, 0.26, ankle[0], Math.max(0, ankle[1] - 0.04), ankle[2] + 0.06, true);
    }
  }
  // 身體：骨盆、胸、脖子、頭（站著從 0.83 到 1.70）
  p.box(0.34, 0.16, 0.2, 0, hip - 0.08, 0);
  p.box(0.38, 0.5, 0.21, 0, hip + 0.08, 0);
  p.rod([0, hip + 0.58, 0], [0, hip + 0.64, 0], 0.045);
  p.ball(0.125, 0, hip + 0.745, 0.01);
  // 手：肩膀 → 手
  const shoulderY = hip + 0.52;
  for (const s of [-1, 1]) {
    const hand: V3 = (s < 0 ? o.hands?.l : o.hands?.r) ?? [0.26 * s, hip - (seated ? 0.02 : 0.07), seated ? 0.35 : 0.05];
    p.rod([0.22 * s, shoulderY, 0], hand, 0.045, false, 0.036);
    p.ball(0.04, hand[0], hand[1], hand[2], true);
  }
  return p;
}

/** 吉他 / 貝斯：琴身 + 長長的琴頸，掛在身上（人的座標） */
function guitar(parent: Parts, neckEnd: V3, bodyY: number, bodyScale: number): void {
  const g = parent.sub('guitar');
  g.box(0.34 * bodyScale, 0.26 * bodyScale, 0.06, 0.06, bodyY - 0.2 * bodyScale, 0.17, true, [0, 0, 0.3]);
  g.box(0.26 * bodyScale, 0.2 * bodyScale, 0.06, 0.0, bodyY, 0.17, true, [0, 0, 0.3]);
  g.rod([-0.02, bodyY + 0.06, 0.2], neckEnd, 0.022, true);
  g.box(0.1, 0.03, 0.03, neckEnd[0] - 0.05, neckEnd[1] + 0.02, neckEnd[2], true, [0, 0, 0.3]);
}

/** 立式麥克風架：三隻腳 + 桿 + 麥克風（boom = 有斜伸出去的長臂） */
function micStandParts(parent: Parts, x: number, z: number, height: number, boom: boolean): void {
  const s = parent.sub('micstand');
  for (let k = 0; k < 3; k++) {
    const a = (k * 2 * Math.PI) / 3 + Math.PI / 2;
    s.rod([x, 0.05, z], [x + 0.22 * Math.cos(a), 0.01, z + 0.22 * Math.sin(a)], 0.012, true);
  }
  s.rod([x, 0.02, z], [x, height - 0.1, z], 0.014, true);
  if (boom) {
    s.rod([x, height - 0.1, z], [x, height, z + 0.34], 0.011, true);
    s.cyl(0.026, 0.026, 0.13, x, height - 0.02, z + 0.34, false, 10);
  } else {
    s.cyl(0.026, 0.026, 0.13, x, height - 0.1, z, false, 10);
  }
}

// ─────────────────────────────────────────────
// 每一種
// ─────────────────────────────────────────────

type Builder = (b: Parts) => void;

const BUILDERS: Record<StagePropType, Builder> = {
  vocalist(b) {
    person(b, 'person', { hands: { l: [-0.25, 0.78, 0.06], r: [0.12, 1.47, 0.3] } });
    micStandParts(b, 0.12, 0.34, 1.55, false);
  },

  backing(b) {
    person(b, 'person', { hands: { l: [-0.25, 0.78, 0.06], r: [0.1, 1.5, 0.2] } });
    b.rod([0.1, 1.48, 0.2], [0.08, 1.6, 0.17], 0.02, true);
    b.ball(0.035, 0.08, 1.62, 0.17);
  },

  dancer(b) {
    person(b, 'person', {
      hands: { l: [-0.8, 1.4, 0.06], r: [0.8, 1.4, 0.06] },
      feet: { l: [-0.3, 0.04, 0.22], r: [0.22, 0.04, -0.2] },
    });
  },

  guitarist(b) {
    person(b, 'person', { hands: { l: [-0.5, 1.2, 0.32], r: [0.12, 0.96, 0.22] } });
    guitar(b, [-0.62, 1.3, 0.3], 0.95, 1);
  },

  bassist(b) {
    person(b, 'person', { hands: { l: [-0.78, 1.28, 0.36], r: [0.12, 0.86, 0.22] } });
    guitar(b, [-0.98, 1.4, 0.38], 0.86, 1.2);
  },

  keyboardist(b) {
    person(b, 'person', { hands: { l: [-0.2, 0.97, 0.42], r: [0.2, 0.97, 0.42] } });
    const k = b.sub('keyboard');
    k.box(1.3, 0.08, 0.36, 0, 0.86, 0.42);
    k.box(1.2, 0.02, 0.14, 0, 0.94, 0.5, true);
    for (const x of [-0.5, 0.5]) {
      k.rod([x, 0, 0.24], [x, 0.86, 0.6], 0.018, true);
      k.rod([x, 0, 0.6], [x, 0.86, 0.24], 0.018, true);
    }
  },

  drummer(b) {
    // 椅子 + 坐著的鼓手（坐在 z = -0.55）
    b.cyl(0.24, 0.24, 0.03, 0, 0, -0.55, true);
    b.cyl(0.03, 0.03, 0.42, 0, 0.03, -0.55, true);
    b.cyl(0.17, 0.17, 0.07, 0, 0.45, -0.55, true);
    const p = person(b, 'person', { seat: 0.52, spread: 1.4, hands: { l: [-0.26, 0.98, 0.3], r: [0.26, 0.98, 0.3] } });
    p.g.position.set(0, 0, -0.55);
    // 大鼓、兩個懸掛鼓、小鼓、落地鼓
    b.cylZ(0.3, 0.42, 0, 0.32, 0.36);
    b.rod([0, 0.6, 0.4], [0, 0.78, 0.44], 0.015, true);
    b.cyl(0.16, 0.16, 0.2, -0.2, 0.74, 0.46);
    b.cyl(0.16, 0.16, 0.2, 0.2, 0.74, 0.46);
    b.cyl(0.18, 0.18, 0.14, -0.05, 0.62, -0.02);
    b.rod([-0.05, 0.62, -0.02], [-0.05, 0.02, -0.02], 0.012, true);
    b.cyl(0.22, 0.22, 0.4, 0.62, 0.44, 0.12);
    b.rod([0.46, 0.01, 0.06], [0.5, 0.44, 0.1], 0.014, true);
    b.rod([0.78, 0.01, 0.2], [0.74, 0.44, 0.16], 0.014, true);
    // 腳踏鈸 + 兩片大鈸 + 一片遠的大鈸
    b.rod([-0.58, 0.01, -0.08], [-0.58, 0.93, -0.08], 0.012, true);
    b.disc(0.15, 0.015, -0.58, 0.95, -0.08, true);
    b.disc(0.15, 0.015, -0.58, 0.975, -0.08, true);
    b.rod([-0.8, 0.01, 0.4], [-0.8, 1.27, 0.4], 0.012, true);
    b.disc(0.2, 0.015, -0.8, 1.29, 0.4, true, [0, 0, 0.12]);
    b.rod([0.78, 0.01, 0.34], [0.78, 1.15, 0.34], 0.012, true);
    b.disc(0.2, 0.015, 0.78, 1.17, 0.34, true, [0, 0, -0.1]);
    b.rod([0.3, 0.01, 0.74], [0.3, 1.4, 0.74], 0.012, true);
    b.disc(0.2, 0.015, 0.3, 1.42, 0.8, true, [0.1, 0, 0]);
  },

  percussionist(b) {
    person(b, 'person', { hands: { l: [-0.15, 0.82, 0.38], r: [0.15, 0.82, 0.38] } });
    for (const x of [-0.15, 0.15]) {
      b.cyl(0.125, 0.085, 0.76, x, 0, 0.38);
      b.disc(0.13, 0.02, x, 0.77, 0.38, true);
    }
  },

  dj(b) {
    const p = person(b, 'person', { hands: { l: [-0.55, 1.02, 0.66], r: [0.55, 1.02, 0.66] } });
    p.g.position.set(0, 0, -0.66);
    // 桌子：桌面高 0.92，上面的混音器、唱盤讓整張桌子剛好 1 公尺高
    const t = b.sub('table');
    t.box(1.8, 0.06, 0.8, 0, 0.86, 0);
    for (const x of [-0.85, 0.85]) for (const z of [-0.35, 0.35]) t.box(0.06, 0.86, 0.06, x, 0, z, true);
    t.box(0.36, 0.07, 0.42, 0, 0.92, 0, true);
    for (const x of [-0.6, 0.6]) {
      t.box(0.46, 0.05, 0.44, x, 0.92, 0);
      t.disc(0.17, 0.02, x, 0.975, 0.02, true);
    }
  },

  violinist(b) {
    person(b, 'person', { hands: { l: [-0.12, 1.47, 0.5], r: [0.22, 1.3, 0.34] } });
    b.box(0.2, 0.05, 0.34, -0.03, 1.44, 0.2, true);
    b.rod([-0.04, 1.47, 0.36], [-0.12, 1.47, 0.64], 0.013, true);
    b.rod([0.24, 1.28, 0.38], [-0.2, 1.42, 0.46], 0.008);
  },

  cellist(b) {
    // 椅子
    b.box(0.42, 0.04, 0.42, 0, 0.42, 0, true);
    for (const x of [-0.17, 0.17]) for (const z of [-0.17, 0.17]) b.rod([x, 0, z], [x, 0.42, z], 0.014, true);
    person(b, 'person', { seat: 0.46, spread: 2, hands: { l: [-0.08, 1.05, 0.3], r: [0.25, 0.72, 0.4] } });
    // 琴
    b.ball(0.2, 0, 0.62, 0.34, true, 1, 1.55, 0.55);
    b.ball(0.15, 0, 0.98, 0.34, true, 1, 1.2, 0.55);
    b.rod([0, 1.08, 0.34], [0.03, 1.5, 0.27], 0.02, true);
    b.rod([0, 0.34, 0.36], [0, 0, 0.46], 0.01, true);
    b.rod([0.34, 0.72, 0.46], [-0.1, 0.72, 0.3], 0.008);
  },

  winds(b) {
    person(b, 'person', { hands: { l: [0.0, 1.2, 0.22], r: [0.06, 0.95, 0.25] } });
    b.rod([0, 1.52, 0.12], [0.02, 1.24, 0.2], 0.014, true);
    b.rod([0.02, 1.24, 0.2], [0.06, 0.72, 0.26], 0.03, true);
    b.rod([0.06, 0.72, 0.26], [0.06, 0.6, 0.46], 0.04, true);
    b.cyl(0.1, 0.04, 0.2, 0.06, 0.4, 0.5, true);
  },

  piano(b) {
    // 琴身：輪廓放在地面上，往上拉。輪廓的 y = 場景 -z，所以鍵盤（-z 那頭）畫在 y = +0.9
    const body = b.sub('body');
    const s = new THREE.Shape();
    s.moveTo(-0.75, 0.9);
    s.lineTo(0.75, 0.9);
    s.lineTo(0.75, 0.5);
    s.bezierCurveTo(0.75, -0.1, 0.35, -0.6, -0.1, -1.05);
    s.lineTo(-0.75, -1.05);
    s.lineTo(-0.75, 0.9);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    body.mesh(geo, false, 0, 0.78, 0);
    for (const [x, z] of [[-0.62, -0.78], [0.62, -0.78], [-0.45, 0.9]]) body.cyl(0.05, 0.04, 0.78, x, 0, z, true);
    body.box(1.2, 0.04, 0.24, 0, 0.72, -0.93, true);   // 琴鍵（突出來）
    // 掀開的琴蓋：貼著左邊（直的那一邊）轉開，用支棍撐住
    const lid = b.sub('lid');
    const hinge = new THREE.Group();
    hinge.position.set(-0.75, 1.0, 0.1);
    hinge.rotation.z = 0.6;
    lid.g.add(hinge);
    const panel = lid.mesh(new THREE.BoxGeometry(0.8, 0.025, 1.5), false, 0.4, 0.0125, 0);
    lid.g.remove(panel);
    hinge.add(panel);
    lid.rod([-0.4, 1.0, 0.3], [-0.12, 1.42, 0.3], 0.012, true);
  },

  micStand(b) {
    micStandParts(b, 0, -0.1, 1.5, true);
  },

  monitor(b) {
    // 側面輪廓：後面高、前面低的楔形（喇叭面朝前上方），往左右拉 0.6
    const s = new THREE.Shape();
    s.moveTo(-0.225, 0);
    s.lineTo(0.225, 0);
    s.lineTo(0.225, 0.35);
    s.lineTo(-0.225, 0.12);
    s.lineTo(-0.225, 0);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.6, bevelEnabled: false });
    geo.rotateY(Math.PI / 2);
    geo.translate(-0.3, 0, 0);
    b.mesh(geo, false, 0, 0, 0);
    b.box(0.5, 0.02, 0.02, 0, 0.1, 0.22, true);
  },

  riser(b) {
    b.box(2.34, 0.34, 2.34, 0, 0, 0, true);
    b.box(2.4, 0.06, 2.4, 0, 0.34, 0);
  },
};

/** 一整組要把水平中心移到原點；單獨一個人原點留在腳下 */
const RECENTER: ReadonlySet<StagePropType> = new Set<StagePropType>([
  'keyboardist', 'drummer', 'percussionist', 'dj', 'cellist', 'piano', 'micStand', 'monitor', 'riser',
]);

/**
 * 組一個模型。回傳的 Group 原點在腳底中間、正面朝 +Z、單位公尺。
 * userData：propType、radius（選到時的圈圈半徑：離中心最遠的水平距離，公尺）。
 * 樂手台多一個看不到的頂面（userData.walkTop），讓別的東西可以站上去。
 */
export function buildStageProp(type: StagePropType, mats: PropMaterials): THREE.Group {
  const parts = new Parts(mats);
  BUILDERS[type](parts);
  const root = new THREE.Group();
  root.name = `stage-prop:${type}`;
  root.userData.propType = type;
  root.add(parts.g);
  if (RECENTER.has(type)) {
    const c = new THREE.Box3().setFromObject(parts.g).getCenter(new THREE.Vector3());
    parts.g.position.x -= c.x;
    parts.g.position.z -= c.z;
  }
  const box = new THREE.Box3().setFromObject(root);
  root.userData.radius = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
  if (type === RISER_TYPE) {
    const { w, d, h } = stagePropSpec(RISER_TYPE).size;
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mats.main);
    top.rotation.x = -Math.PI / 2;   // 法線朝上，只有從上面往下的光線打得到
    top.position.set(0, h, 0);
    top.visible = false;
    top.userData.walkTop = true;
    top.userData.keepMaterial = true;
    root.add(top);
  }
  return root;
}

/** 量模型的外框大小（公尺）；part 有給就量裡面那個名字的零件 */
export function measureStageProp(root: THREE.Object3D, part?: string): { w: number; d: number; h: number; center: { x: number; z: number } } {
  const target = part ? root.getObjectByName(part) : root;
  if (!target) throw new Error('找不到零件：' + part);
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(target);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  return { w: size.x, d: size.z, h: size.y, center: { x: c.x, z: c.z } };
}

/** 數一個模型有幾個基本形狀（含看不到的頂面以外） */
export function countStagePropMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.walkTop) n++; });
  return n;
}

/** 放掉一個模型的幾何（材質是共用的，不在這裡放） */
export function disposeStageProp(root: THREE.Object3D): void {
  root.traverse((o) => { (o as THREE.Mesh).geometry?.dispose?.(); });
}
