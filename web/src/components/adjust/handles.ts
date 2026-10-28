// 調整舞台的 3D 疊層（three.js，不經過 React）：每幀跟著畫面上的位置更新。
//
//   發亮的框：選到的物件 + 現在的把手會一起動到的物件（綠色實線框，穿過別的東西也看得到）
//   虛線框：改過的物件在「這個 cue 存的位置」留一個白色虛線框
//   把手（綠色、螢幕上固定大小）：
//     直線 / 升降 = 沿方向的雙箭頭（升降在物件中間，左右走的在物件頂上）
//     沿弧形軌道、繞遠處轉軸轉（門）= 物件頂上一個圓點 + 沿圓的切線箭頭，沿著圓拖
//     自轉 = 物件底下（地上）一個圈 + 圓點（圓點 = 值 0 時朝觀眾的那一面現在朝哪）
//     吊掛 = 每個吊點一個上下箭頭
//   全部都是額外加的線和小形狀：不碰 LED 的材質、不改畫法；挑把手用螢幕上的距離（不 raycast）。

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { applyChain, rigValue, type RigMechanism } from '../../lib/mechanisms/pose';
import type { MechVec3 } from '../../lib/mechanisms/model';
import type { AdjustStore } from '../../lib/adjust/store';
import { angleOnPlane, closestParamOnLine, distToPolyline2D, distToSegment2D, wrapPi, type P2 } from '../../lib/adjust/dragMath';
import type { StageAdjustHost } from '../StageScene';

const GREEN = 0x22d38a;
const HOVER = 0xa6ffd6;
const BOX = 0x10c78a;
const GHOST = 0xffffff;
const ORDER = 1000;
/** 箭頭半長、圓錐、圓點（px） */
const ARROW_PX = 42;
const CONE_PX = 7;
const KNOB_PX = 7;
/** 挑把手：離線段 / 圈幾 px 內算點到 */
const PICK_PX = 13;
const PICK_TOUCH_PX = 22;

const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const IDQ = new THREE.Quaternion();

export type Handle =
  | { key: string; mechId: string; kind: 'line'; anchor: THREE.Vector3; dir: THREE.Vector3; perScene: number }
  | { key: string; mechId: string; kind: 'orbit' | 'ring'; anchor: THREE.Vector3; center: THREE.Vector3; normal: THREE.Vector3; radius: number; perRad: number };

interface ObjInfo { box: THREE.Box3; center: THREE.Vector3; diag: number }

interface Visual {
  kind: Handle['kind'];
  group: THREE.Group;
  shaft: Line2;
  coneA: THREE.Mesh;
  coneB: THREE.Mesh;
  knob: THREE.Mesh;
  ring: Line2 | null;
}

interface DragState {
  h: Handle;
  v0: number;
  raw: number;
  mode: 'exact' | 'screen';
  t0: number;
  angPrev: number;
  accum: number;
  last: P2;
}

function noRaycast(o: THREE.Object3D) {
  o.traverse(c => { c.raycast = () => {}; });
}

/** 一個物件自己座標裡的外框（含子物件）；算一次就留著（物件自己的位置變了也一樣） */
function localInfo(obj: THREE.Object3D): ObjInfo {
  obj.updateWorldMatrix(true, true);
  const inv = obj.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  obj.traverse(c => {
    const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g || !(c as THREE.Mesh).isMesh) return;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    box.union(g.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inv, c.matrixWorld)));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  return { box, center: box.getCenter(new THREE.Vector3()), diag: box.getSize(new THREE.Vector3()).length() };
}

/** 外框的 12 條邊（給 LineSegmentsGeometry） */
function boxEdges(b: THREE.Box3): number[] {
  const { min: a, max: z } = b;
  const c = [
    [a.x, a.y, a.z], [z.x, a.y, a.z], [z.x, a.y, z.z], [a.x, a.y, z.z],
    [a.x, z.y, a.z], [z.x, z.y, a.z], [z.x, z.y, z.z], [a.x, z.y, z.z],
  ];
  const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return e.flatMap(([i, j]) => [...c[i], ...c[j]]);
}

export class AdjustScene {
  private group = new THREE.Group();
  private infos = new WeakMap<THREE.Object3D, ObjInfo>();
  private boxes = new Map<string, { obj: THREE.Object3D; line: LineSegments2 }>();
  private ghosts = new Map<string, { obj: THREE.Object3D; line: LineSegments2; mat: LineMaterial }>();
  private visuals = new Map<string, Visual>();
  private handles: Handle[] = [];
  private hoverKey: string | null = null;
  private drag: DragState | null = null;
  private lists: { affected: string[]; ghosts: string[] } = { affected: [], ghosts: [] };
  private unsub: () => void;
  // 共用的材質、形狀
  private lineMat = new LineMaterial({ color: GREEN, linewidth: 3, transparent: true, depthTest: false, depthWrite: false });
  private lineMatHot = new LineMaterial({ color: HOVER, linewidth: 4, transparent: true, depthTest: false, depthWrite: false });
  private boxMat = new LineMaterial({ color: BOX, linewidth: 2, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
  private meshMat = new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
  private meshMatHot = new THREE.MeshBasicMaterial({ color: HOVER, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
  private coneGeo = new THREE.ConeGeometry(1, 2.4, 14).translate(0, 1.2, 0);
  private knobGeo = new THREE.SphereGeometry(1, 16, 12);
  private shaftGeo = new LineGeometry().setPositions([0, -1, 0, 0, 1, 0]);
  private ringGeo = (() => {
    const pts: number[] = [];
    for (let i = 0; i <= 72; i++) { const a = (i / 72) * Math.PI * 2; pts.push(Math.cos(a), 0, Math.sin(a)); }
    return new LineGeometry().setPositions(pts);
  })();
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  constructor(
    private readonly host: StageAdjustHost,
    private readonly store: AdjustStore,
    private readonly front: () => MechVec3,
  ) {
    this.group.name = 'adjust-overlay';
    host.scene()?.add(this.group);
    const refresh = () => { this.lists = { affected: store.affectedObjects(), ghosts: store.ghostObjects() }; };
    refresh();
    this.unsub = store.subscribe(refresh);
  }

  dispose() {
    this.unsub();
    this.group.parent?.remove(this.group);
    for (const b of this.boxes.values()) b.line.geometry.dispose();
    for (const g of this.ghosts.values()) { g.line.geometry.dispose(); g.mat.dispose(); }
    for (const m of [this.lineMat, this.lineMatHot, this.boxMat, this.meshMat, this.meshMatHot]) m.dispose();
    for (const g of [this.coneGeo, this.knobGeo, this.shaftGeo, this.ringGeo]) g.dispose();
    this.boxes.clear(); this.ghosts.clear(); this.visuals.clear();
  }

  // ─────────── 每幀 ───────────

  update() {
    const scene = this.host.scene();
    const cam = this.host.camera();
    const canvas = this.host.canvas();
    if (!scene || !cam || !canvas) return;
    if (this.group.parent !== scene) scene.add(this.group);
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    for (const m of [this.lineMat, this.lineMatHot, this.boxMat]) m.resolution.set(w, h);
    for (const g of this.ghosts.values()) g.mat.resolution.set(w, h);
    this.updateBoxes();
    this.updateGhosts();
    this.handles = this.store.getState().selection ? this.buildHandles() : [];
    this.updateVisuals(cam, h);
  }

  private info(obj: THREE.Object3D): ObjInfo {
    let i = this.infos.get(obj);
    if (!i) { i = localInfo(obj); this.infos.set(obj, i); }
    return i;
  }

  private updateBoxes() {
    const meshes = this.host.meshes();
    const want = new Set(this.lists.affected);
    for (const [id, b] of this.boxes) {
      if (!want.has(id) || meshes.get(id) !== b.obj) { this.group.remove(b.line); b.line.geometry.dispose(); this.boxes.delete(id); }
    }
    for (const id of want) {
      const obj = meshes.get(id);
      if (!obj) continue;
      let b = this.boxes.get(id);
      if (!b) {
        const geo = new LineSegmentsGeometry().setPositions(boxEdges(this.info(obj).box));
        const line = new LineSegments2(geo, this.boxMat);
        line.matrixAutoUpdate = false; line.frustumCulled = false; line.renderOrder = ORDER;
        noRaycast(line);
        this.group.add(line);
        b = { obj, line };
        this.boxes.set(id, b);
      }
      obj.updateWorldMatrix(true, false);
      b.line.matrix.copy(obj.matrixWorld);
      b.line.matrixWorldNeedsUpdate = true;
    }
  }

  private updateGhosts() {
    const meshes = this.host.meshes();
    const scene = this.host.scene();
    const want = new Set(this.lists.ghosts);
    for (const [id, g] of this.ghosts) {
      if (!want.has(id) || meshes.get(id) !== g.obj) { this.group.remove(g.line); g.line.geometry.dispose(); g.mat.dispose(); this.ghosts.delete(id); }
    }
    const saved = this.store.savedValues();
    const chains = this.host.rig().chains;
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const id of want) {
      const obj = meshes.get(id);
      const base = this.host.basePose(id);
      if (!obj || !base || obj.parent !== scene) continue;
      let g = this.ghosts.get(id);
      if (!g) {
        const info = this.info(obj);
        const geo = new LineSegmentsGeometry().setPositions(boxEdges(info.box));
        const mat = new LineMaterial({
          color: GHOST, linewidth: 1.6, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false,
          dashed: true, dashSize: info.diag * 0.035, gapSize: info.diag * 0.025,
        });
        const line = new LineSegments2(geo, mat);
        line.computeLineDistances();
        line.matrixAutoUpdate = false; line.frustumCulled = false; line.renderOrder = ORDER - 1;
        noRaycast(line);
        this.group.add(line);
        g = { obj, line, mat };
        this.ghosts.set(id, g);
      }
      applyChain(chains.get(id), saved, base.pos, base.quat, p, q);
      g.line.matrix.compose(p, q, obj.scale);
      g.line.matrixWorldNeedsUpdate = true;
    }
  }

  /** 選到的物件的機關鏈 → 每個機關一個把手（吊掛 = 每個吊點一個） */
  private buildHandles(): Handle[] {
    const sel = this.store.getState().selection;
    if (!sel) return [];
    const obj = this.host.meshes().get(sel.objectId);
    const base = this.host.basePose(sel.objectId);
    const chain = this.host.rig().chains.get(sel.objectId);
    if (!obj || !base || !chain) return [];
    const values = this.host.shownValues();
    const info = this.info(obj);
    // 物件在 cue 位置的中心、上下有多高、水平多寬（場景座標）
    const toBase = (v: THREE.Vector3) => v.clone().multiply(obj.scale).applyQuaternion(base.quat).add(base.pos);
    const centerBase = toBase(info.center);
    let top = -Infinity, bottom = Infinity, horiz = 0;
    const b = info.box;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const c = toBase(new THREE.Vector3(x, y, z));
      top = Math.max(top, c.y - centerBase.y);
      bottom = Math.min(bottom, c.y - centerBase.y);
      horiz = Math.max(horiz, Math.hypot(c.x - centerBase.x, c.z - centerBase.z));
    }
    const out: Handle[] = [];
    const tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i];
      const outer = chain.slice(i + 1);
      const outerQuat = new THREE.Quaternion();
      applyChain(outer, values, ZERO, IDQ, tmpP, outerQuat);
      const toWorld = (p: THREE.Vector3) => { const o = new THREE.Vector3(); applyChain(outer, values, p, IDQ, o, tmpQ); return o; };
      if (node.hoist) {
        for (const hm of node.hoist.hoists) {
          const a = this.store.def(hm.id)?.attach;
          if (!a) continue;
          const anchor = new THREE.Vector3();
          applyChain(chain, values, new THREE.Vector3(a.x, a.y, a.z), IDQ, anchor, tmpQ);
          out.push({ key: `h:${hm.id}`, mechId: hm.id, kind: 'line', anchor, dir: UP.clone().applyQuaternion(outerQuat), perScene: 1 / hm.linearSceneScale });
        }
        continue;
      }
      const pre = new THREE.Vector3();
      applyChain(chain.slice(0, i), values, centerBase, IDQ, pre, tmpQ);
      const v = rigValue(node, values);
      const vertical = Math.abs(node.axis.y) > 0.7;
      if (node.kind === 'linear' && node.arcRadius === undefined) {
        const after = pre.clone().addScaledVector(node.axis, v * node.linearSceneScale);
        if (!vertical) after.addScaledVector(UP, top);
        out.push({ key: `m:${node.id}:${i}`, mechId: node.id, kind: 'line', anchor: toWorld(after), dir: node.axis.clone().applyQuaternion(outerQuat), perScene: 1 / node.linearSceneScale });
        continue;
      }
      out.push(this.circleHandle(node, i, pre, v, vertical, top, bottom, horiz, toWorld, outerQuat));
    }
    return out;
  }

  private circleHandle(
    node: RigMechanism, i: number, pre: THREE.Vector3, v: number, vertical: boolean, top: number, bottom: number, horiz: number,
    toWorld: (p: THREE.Vector3) => THREE.Vector3, outerQuat: THREE.Quaternion,
  ): Handle {
    const arcR = node.arcRadius;
    const theta = arcR === undefined ? THREE.MathUtils.degToRad(v) : v / arcR;
    const perRad = arcR === undefined ? 180 / Math.PI : arcR;
    const q = new THREE.Quaternion().setFromAxisAngle(node.axis, theta);
    const rel = pre.clone().sub(node.pivot);
    const perp = rel.clone().addScaledVector(node.axis, -rel.dot(node.axis));
    const normal = node.axis.clone().applyQuaternion(outerQuat);
    const isRing = arcR === undefined && vertical && perp.length() < Math.max(horiz * 0.6, 1e-6);
    if (isRing) {
      // 自轉：物件底下的圈；圓點 = 值 0 時朝觀眾的方向，現在轉到哪
      const bottomPt = pre.clone().addScaledVector(UP, bottom);
      const centerL = node.pivot.clone().addScaledVector(node.axis, bottomPt.clone().sub(node.pivot).dot(node.axis));
      const radius = Math.max(horiz * 1.15, 0.05);
      const f = this.front();
      const ref = new THREE.Vector3(f.x, f.y, f.z);
      ref.addScaledVector(node.axis, -ref.dot(node.axis));
      if (ref.lengthSq() < 1e-9) ref.set(1, 0, 0).addScaledVector(node.axis, -node.axis.x);
      ref.normalize();
      const knobL = centerL.clone().addScaledVector(ref.applyQuaternion(q), radius);
      const center = toWorld(centerL);
      const anchor = toWorld(knobL);
      return { key: `m:${node.id}:${i}`, mechId: node.id, kind: 'ring', anchor, center, normal, radius: anchor.distanceTo(center), perRad };
    }
    // 沿弧形軌道 / 門：物件頂上的點繞圓心走
    const basePt = vertical ? pre.clone().addScaledVector(UP, top) : pre.clone();
    const r = basePt.clone().sub(node.pivot);
    const centerL = node.pivot.clone().addScaledVector(node.axis, r.dot(node.axis));
    const anchorL = node.pivot.clone().add(r.applyQuaternion(q));
    const center = toWorld(centerL);
    const anchor = toWorld(anchorL);
    return { key: `m:${node.id}:${i}`, mechId: node.id, kind: 'orbit', anchor, center, normal, radius: anchor.distanceTo(center), perRad };
  }

  /** 這一點附近 1 px 是多少場景單位 */
  private pxWorld(cam: THREE.PerspectiveCamera, p: THREE.Vector3, viewH: number): number {
    const d = Math.max(cam.position.distanceTo(p), cam.near * 2);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / viewH;
  }

  /** 切線 / 方向（單位長度） */
  private dirOf(h: Handle): THREE.Vector3 {
    if (h.kind === 'line') return h.dir.clone().normalize();
    const t = new THREE.Vector3().crossVectors(h.normal, h.anchor.clone().sub(h.center));
    return t.lengthSq() > 1e-12 ? t.normalize() : new THREE.Vector3(1, 0, 0);
  }

  private updateVisuals(cam: THREE.PerspectiveCamera, viewH: number) {
    const used = new Set<string>();
    const activeKey = this.drag?.h.key ?? this.hoverKey;
    for (const h of this.handles) {
      used.add(h.key);
      let vis = this.visuals.get(h.key);
      if (vis && vis.kind !== h.kind) { this.group.remove(vis.group); this.visuals.delete(h.key); vis = undefined; }
      if (!vis) { vis = this.makeVisual(h.kind); this.visuals.set(h.key, vis); }
      const hot = h.key === activeKey;
      const lm = hot ? this.lineMatHot : this.lineMat;
      const mm = hot ? this.meshMatHot : this.meshMat;
      vis.shaft.material = lm;
      vis.coneA.material = mm; vis.coneB.material = mm; vis.knob.material = mm;
      if (vis.ring) vis.ring.material = lm;
      const s = this.pxWorld(cam, h.anchor, viewH);
      const dir = this.dirOf(h);
      const showArrow = h.kind !== 'ring';
      vis.shaft.visible = vis.coneA.visible = vis.coneB.visible = showArrow;
      if (showArrow) {
        const L = ARROW_PX * s;
        vis.shaft.position.copy(h.anchor);
        vis.shaft.quaternion.setFromUnitVectors(UP, dir);
        vis.shaft.scale.setScalar(L);
        const c = CONE_PX * s;
        vis.coneA.position.copy(h.anchor).addScaledVector(dir, L);
        vis.coneA.quaternion.setFromUnitVectors(UP, dir);
        vis.coneA.scale.setScalar(c);
        vis.coneB.position.copy(h.anchor).addScaledVector(dir, -L);
        vis.coneB.quaternion.setFromUnitVectors(UP, dir.clone().negate());
        vis.coneB.scale.setScalar(c);
      }
      vis.knob.position.copy(h.anchor);
      vis.knob.scale.setScalar(KNOB_PX * s * (h.kind === 'line' ? 0.6 : 1));
      if (vis.ring && h.kind === 'ring') {
        vis.ring.position.copy(h.center);
        vis.ring.quaternion.setFromUnitVectors(UP, h.normal.clone().normalize());
        vis.ring.scale.setScalar(h.radius);
      }
    }
    for (const [k, vis] of this.visuals) if (!used.has(k)) { this.group.remove(vis.group); this.visuals.delete(k); }
  }

  private makeVisual(kind: Handle['kind']): Visual {
    const group = new THREE.Group();
    const shaft = new Line2(this.shaftGeo, this.lineMat);
    const coneA = new THREE.Mesh(this.coneGeo, this.meshMat);
    const coneB = new THREE.Mesh(this.coneGeo, this.meshMat);
    const knob = new THREE.Mesh(this.knobGeo, this.meshMat);
    const ring = kind === 'ring' ? new Line2(this.ringGeo, this.lineMat) : null;
    for (const o of [shaft, coneA, coneB, knob, ring]) {
      if (!o) continue;
      o.renderOrder = ORDER + 1; o.frustumCulled = false;
      group.add(o);
    }
    noRaycast(group);
    this.group.add(group);
    return { kind, group, shaft, coneA, coneB, knob, ring };
  }

  // ─────────── 滑鼠 ───────────

  private updateRect() {
    const c = this.host.canvas();
    if (!c) return;
    const r = c.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }
  private toScreen(p: THREE.Vector3): P2 | null {
    const cam = this.host.camera();
    if (!cam) return null;
    const v = p.clone().project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return { x: this.rect.left + ((v.x + 1) / 2) * this.rect.width, y: this.rect.top + ((1 - v.y) / 2) * this.rect.height };
  }
  /** 滑鼠的射線 */
  ray(clientX: number, clientY: number): THREE.Ray | null {
    const cam = this.host.camera();
    if (!cam) return null;
    this.updateRect();
    const ndc = new THREE.Vector2(((clientX - this.rect.left) / this.rect.width) * 2 - 1, -((clientY - this.rect.top) / this.rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    return rc.ray;
  }

  /** 滑鼠下面的把手（螢幕距離最近的）；沒有 → null */
  pick(clientX: number, clientY: number, touch = false): Handle | null {
    const cam = this.host.camera();
    if (!cam || this.handles.length === 0) return null;
    this.updateRect();
    const p = { x: clientX, y: clientY };
    const limit = touch ? PICK_TOUCH_PX : PICK_PX;
    let best: { h: Handle; d: number } | null = null;
    for (const h of this.handles) {
      const a = this.toScreen(h.anchor);
      if (!a) continue;
      let d = Math.hypot(p.x - a.x, p.y - a.y) - 4;
      if (h.kind === 'ring') {
        const pts: P2[] = [];
        const ref = h.anchor.clone().sub(h.center);
        const n = h.normal.clone().normalize();
        const q = new THREE.Quaternion();
        for (let i = 0; i < 48; i++) {
          q.setFromAxisAngle(n, (i / 48) * Math.PI * 2);
          const sp = this.toScreen(h.center.clone().add(ref.clone().applyQuaternion(q)));
          if (sp) pts.push(sp);
        }
        d = Math.min(d, distToPolyline2D(p, pts, true));
      } else {
        const s = this.pxWorld(cam, h.anchor, this.rect.height);
        const dir = this.dirOf(h);
        const e1 = this.toScreen(h.anchor.clone().addScaledVector(dir, ARROW_PX * s * 1.15));
        const e2 = this.toScreen(h.anchor.clone().addScaledVector(dir, -ARROW_PX * s * 1.15));
        if (e1 && e2) d = Math.min(d, distToSegment2D(p, e1, e2));
      }
      if (d <= limit && (!best || d < best.d)) best = { h, d };
    }
    return best?.h ?? null;
  }

  /** 滑過把手：亮一點；回傳有沒有在把手上（游標用） */
  hover(clientX: number, clientY: number, touch = false): boolean {
    if (this.drag) return true;
    const h = this.pick(clientX, clientY, touch);
    this.hoverKey = h?.key ?? null;
    return !!h;
  }
  clearHover() { if (!this.drag) this.hoverKey = null; }

  get dragging(): boolean { return !!this.drag; }

  beginDrag(h: Handle, clientX: number, clientY: number) {
    const ray = this.ray(clientX, clientY);
    const frozen: Handle = h.kind === 'line'
      ? { ...h, anchor: h.anchor.clone(), dir: h.dir.clone().normalize() }
      : { ...h, anchor: h.anchor.clone(), center: h.center.clone(), normal: h.normal.clone().normalize() };
    const v0 = this.store.value(h.mechId);
    const d: DragState = { h: frozen, v0, raw: v0, mode: 'screen', t0: 0, angPrev: 0, accum: 0, last: { x: clientX, y: clientY } };
    if (ray) {
      if (frozen.kind === 'line') {
        const t = closestParamOnLine(ray.origin, ray.direction, frozen.anchor, frozen.dir);
        if (t !== null) { d.mode = 'exact'; d.t0 = t; }
      } else {
        const a = angleOnPlane(ray.origin, ray.direction, frozen.center, frozen.normal, frozen.anchor.clone().sub(frozen.center));
        if (a !== null) { d.mode = 'exact'; d.angPrev = a; }
      }
    }
    this.drag = d;
    this.hoverKey = h.key;
    this.store.beginDrag(h.mechId);
  }

  moveDrag(clientX: number, clientY: number, free: boolean) {
    const d = this.drag;
    if (!d) return;
    const h = d.h;
    const ray = this.ray(clientX, clientY);
    let done = false;
    if (d.mode === 'exact' && ray) {
      if (h.kind === 'line') {
        const t = closestParamOnLine(ray.origin, ray.direction, h.anchor, h.dir);
        if (t !== null) { d.raw = d.v0 + (t - d.t0) * h.perScene; done = true; }
      } else {
        const a = angleOnPlane(ray.origin, ray.direction, h.center, h.normal, h.anchor.clone().sub(h.center));
        if (a !== null) {
          d.accum += wrapPi(a - d.angPrev);
          d.angPrev = a;
          d.raw = d.v0 + d.accum * h.perRad;
          done = true;
        }
      }
      if (!done) d.mode = 'screen';   // 轉到側著看了 → 改用螢幕方向（接著現在的值）
    }
    if (!done) {
      // 螢幕方向：滑鼠移動投影到把手方向在螢幕上的樣子
      const cam = this.host.camera();
      const s = cam ? this.pxWorld(cam, h.anchor, this.rect.height) * 10 : 0;
      const a = this.toScreen(h.anchor);
      const dir = this.dirOf(h);
      const b = s > 0 ? this.toScreen(h.anchor.clone().addScaledVector(dir, s)) : null;
      if (a && b) {
        const jx = (b.x - a.x) / s, jy = (b.y - a.y) / s;   // px / 場景單位
        const j2 = jx * jx + jy * jy;
        if (j2 > 1e-9) {
          const dw = ((clientX - d.last.x) * jx + (clientY - d.last.y) * jy) / j2;   // 場景單位
          d.raw += h.kind === 'line' ? dw * h.perScene : (dw / Math.max(h.radius, 1e-6)) * h.perRad;
          if (h.kind !== 'line' && ray) {
            const ang = angleOnPlane(ray.origin, ray.direction, h.center, h.normal, h.anchor.clone().sub(h.center));
            if (ang !== null) { d.angPrev = ang; d.accum = (d.raw - d.v0) / h.perRad; }
          }
        }
      }
    }
    d.last = { x: clientX, y: clientY };
    this.store.dragTo(h.mechId, d.raw, free);
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.store.endDrag();
  }

  /** 點到哪個物件（有機關的、沒有機關的都回傳；點空白 → null） */
  pickObject(clientX: number, clientY: number): string | null {
    const cam = this.host.camera();
    if (!cam) return null;
    this.updateRect();
    const ndc = new THREE.Vector2(((clientX - this.rect.left) / this.rect.width) * 2 - 1, -((clientY - this.rect.top) / this.rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    const objs = [...this.host.meshes().values()].filter(o => o.visible);
    const hit = rc.intersectObjects(objs, true).find(x => x.object.visible);
    let t: THREE.Object3D | null = hit?.object ?? null;
    let id: string | undefined;
    while (t && !(id = t.userData.objectId)) t = t.parent;
    return id ?? null;
  }

  /** 選到的物件現在的中心和大小（場景座標；鏡頭飛過去用） */
  objectSphere(objectId: string): { center: THREE.Vector3; radius: number } | null {
    const obj = this.host.meshes().get(objectId);
    if (!obj) return null;
    obj.updateWorldMatrix(true, false);
    const info = this.info(obj);
    const center = info.center.clone().applyMatrix4(obj.matrixWorld);
    const s = obj.getWorldScale(new THREE.Vector3());
    return { center, radius: (info.diag / 2) * Math.max(s.x, s.y, s.z) };
  }

  /** 物件在 cue 位置的中心（左半 / 右半、弧形讀數用） */
  baseCenter(objectId: string): THREE.Vector3 | null {
    const obj = this.host.meshes().get(objectId);
    const base = this.host.basePose(objectId);
    if (!obj || !base) return null;
    return this.info(obj).center.clone().multiply(obj.scale).applyQuaternion(base.quat).add(base.pos);
  }
}

