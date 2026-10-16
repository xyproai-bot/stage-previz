// 壓縮前後比對（第二關）：用網站真正載入模型的方法（GLTFLoader + Draco 解壓縮器，lib/modelLoader.ts）
// 把原檔和壓縮檔都載入一次，比網站實際會用到的東西：
//   - 每個節點：名稱、種類、位置 / 旋轉 / 縮放（矩陣）、世界座標矩陣、userData（extras）
//   - 每個形狀：頂點資料的種類、外框；每個材質：種類、名稱、顏色、發光、正反面、貼圖格（重複方式、UV 組、位移旋轉）
//   - 整個場景的外框、自動縮放倍率（computeScaleFactor）、物件所在的那一層（findBestScope）
//   - 上傳時算出來的物件清單（名稱、分類、預設位置 / 旋轉 / 縮放，存進資料庫的就是這些）
//   - StageScene 把縮放烤進物件後的位置 / 旋轉 / 縮放（cue 位置就是用這個單位存的）
//   - 每塊 LED 在 LED 對位圖上的位置（ledMap 的同一套算法）
// 任何一項不一樣 → 不用壓縮檔。測試也直接用這個（見 testing/assertSameModel.ts）。

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { parseModel } from '../modelLoader';
import { analyzeGltfScene, classifyMeshName, computeScaleFactor, findBestScope, type ParseResult } from '../parseGlb';
import { collectUvTriangles } from '../ledMapScene';
import { axisSpan, spanToPixels, type AxisSpan, type CanvasSize, type PixelRect } from '../ledMap';
import { TOLERANCE } from './settings';

/** 比 LED 對位圖用的畫布（夠大，四捨五入的差別也抓得到） */
export const VERIFY_LED_CANVAS = { width: 8800, height: 2024 } as const;

interface TextureSnap {
  wrapS: number; wrapT: number; minFilter: number; magFilter: number; flipY: boolean; channel: number;
  colorSpace: string; offset: number[]; repeat: number[]; rotation: number; center: number[];
  width: number | null; height: number | null;
}

interface MaterialSnap {
  props: Record<string, unknown>;
  maps: Record<string, TextureSnap | null>;
}

interface GeometrySnap {
  attributes: string[];
  bboxMin: number[];
  bboxMax: number[];
  extent: number;
  indexed: boolean;
  groups: number;
}

interface NodeSnap {
  path: string;
  name: string;
  type: string;
  local: number[];
  world: number[];
  userData: string;
  visible: boolean;
  geometry: GeometrySnap | null;
  materials: MaterialSnap[];
}

interface LedSnap {
  name: string;
  rect: PixelRect;
  u: AxisSpan;
  v: AxisSpan;
}

/** ledMap.layoutPanel 不算的三角形：UV 面積比這個小（跟 ledMap.ts 的 MIN_UV_AREA 一樣；測試會比對兩邊結果） */
const LED_MIN_UV_AREA = 1e-10;

/**
 * 一塊 LED 在對位圖上的位置：跟 ledMap.layoutPanel 算位置的那一段一模一樣（同樣的三角形篩選、axisSpan、spanToPixels），
 * 只是先把一模一樣的 UV 範圍去掉重複再交給 axisSpan（它只看範圍的聯集，重複的不影響結果）
 * —— 幾百萬個三角形的 LED 也只要零點幾秒（layoutPanel 整套要十幾秒，還會畫形狀，比對用不到）
 */
export function ledPanelRect(tris: ArrayLike<number>, canvas: CanvasSize): { rect: PixelRect; u: AxisSpan; v: AxisSpan } | null {
  const uSeen = new Map<number, Set<number>>(), vSeen = new Map<number, Set<number>>();
  const uR: [number, number][] = [], vR: [number, number][] = [];
  const addUnique = (seen: Map<number, Set<number>>, out: [number, number][], lo: number, hi: number) => {
    let set = seen.get(lo);
    if (!set) { set = new Set(); seen.set(lo, set); }
    if (set.has(hi)) return;
    set.add(hi);
    out.push([lo, hi]);
  };
  const n = Math.floor(tris.length / 6);
  let kept = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 6;
    const u0 = tris[o], v0 = tris[o + 1], u1 = tris[o + 2], v1 = tris[o + 3], u2 = tris[o + 4], v2 = tris[o + 5];
    if (!(Number.isFinite(u0) && Number.isFinite(v0) && Number.isFinite(u1) && Number.isFinite(v1) && Number.isFinite(u2) && Number.isFinite(v2))) continue;
    const area = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
    if (area < LED_MIN_UV_AREA) continue;
    kept++;
    addUnique(uSeen, uR, Math.min(u0, u1, u2), Math.max(u0, u1, u2));
    addUnique(vSeen, vR, Math.min(v0, v1, v2), Math.max(v0, v1, v2));
  }
  const u = axisSpan(uR), v = axisSpan(vR);
  if (!u || !v || kept === 0) return null;
  const px = spanToPixels(u, canvas.width), py = spanToPixels(v, canvas.height);
  return { rect: { x: px.pos, y: py.pos, w: px.len, h: py.len }, u, v };
}

export interface SceneSnapshot {
  nodes: NodeSnap[];
  bboxMin: number[];
  bboxMax: number[];
  diag: number;
  /** StageScene 用的自動縮放倍率（沒四捨五入的對角線算的） */
  scaleFactor: number;
  bestScopePath: string;
  /** 上傳時的物件清單（parseGlb） */
  parsed: ParseResult;
  /** StageScene 烤進縮放後，每個物件的位置 / 旋轉 / 縮放 */
  baked: { name: string; p: number[]; q: number[]; s: number[] }[];
  led: (LedSnap | { name: string; skipped: true })[];
  animations: number;
  cameras: number;
}

export interface SceneVerifyReport {
  ok: boolean;
  issues: string[];
  stats: { nodes: number; meshes: number; ledPanels: number };
}

const MAP_SLOTS = [
  'map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'lightMap', 'bumpMap',
  'displacementMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap',
  'sheenRoughnessMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap',
  'specularIntensityMap', 'specularColorMap', 'anisotropyMap',
] as const;

const MATERIAL_PROPS = [
  'type', 'name', 'side', 'transparent', 'opacity', 'alphaTest', 'depthWrite', 'depthTest', 'vertexColors', 'flatShading',
  'visible', 'blending', 'toneMapped', 'roughness', 'metalness', 'emissiveIntensity', 'envMapIntensity', 'aoMapIntensity',
  'lightMapIntensity', 'clearcoat', 'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'sheen', 'sheenRoughness',
  'iridescence', 'iridescenceIOR', 'specularIntensity', 'anisotropy', 'attenuationDistance', 'dispersion', 'wireframe',
] as const;

const COLOR_PROPS = ['color', 'emissive', 'sheenColor', 'specularColor', 'attenuationColor'] as const;

function snapTexture(t: THREE.Texture | null | undefined): TextureSnap | null {
  if (!t) return null;
  const img = t.image as { width?: number; height?: number } | null | undefined;
  return {
    wrapS: t.wrapS, wrapT: t.wrapT, minFilter: t.minFilter, magFilter: t.magFilter, flipY: t.flipY, channel: t.channel,
    colorSpace: t.colorSpace, offset: t.offset.toArray(), repeat: t.repeat.toArray(), rotation: t.rotation, center: t.center.toArray(),
    width: img?.width ?? null, height: img?.height ?? null,
  };
}

function snapMaterial(m: THREE.Material): MaterialSnap {
  const rec = m as unknown as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const k of MATERIAL_PROPS) if (k in rec) props[k] = rec[k];
  for (const k of COLOR_PROPS) {
    const c = rec[k] as THREE.Color | undefined;
    if (c && (c as THREE.Color).isColor) props[k] = c.toArray();
  }
  const ns = rec.normalScale as THREE.Vector2 | undefined;
  if (ns?.isVector2) props.normalScale = ns.toArray();
  props.userData = JSON.stringify(m.userData ?? {});
  const maps: Record<string, TextureSnap | null> = {};
  for (const k of MAP_SLOTS) if (k in rec) maps[k] = snapTexture(rec[k] as THREE.Texture | null);
  return { props, maps };
}

function snapGeometry(g: THREE.BufferGeometry): GeometrySnap {
  // 外框用實際的頂點算，不用 glTF 檔頭記的 min / max：3ds Max 匯出的 Draco 檔，檔頭是量化前的真值，
  // 解壓縮出來的頂點會差一個量化格（毫米等級），重新壓縮以後檔頭就變成解壓縮後的值，比檔頭會誤報「外框變了」
  const pos = g.getAttribute('position');
  const bb = pos ? new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute) : (g.boundingBox ?? new THREE.Box3());
  const ext = bb.isEmpty() ? 0 : Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z,
    Math.abs(bb.min.x), Math.abs(bb.min.y), Math.abs(bb.min.z), Math.abs(bb.max.x), Math.abs(bb.max.y), Math.abs(bb.max.z));
  const attributes = Object.entries(g.attributes)
    .map(([name, a]) => `${name}:${a.itemSize}:${a.normalized ? 'n' : ''}:${(a as THREE.BufferAttribute).array?.constructor?.name ?? ''}`)
    .sort();
  return { attributes, bboxMin: bb.min.toArray(), bboxMax: bb.max.toArray(), extent: ext, indexed: !!g.index, groups: g.groups.length };
}

function nodePath(o: THREE.Object3D, root: THREE.Object3D): string {
  const parts: string[] = [];
  let cur: THREE.Object3D | null = o;
  while (cur && cur !== root) {
    const parent: THREE.Object3D | null = cur.parent;
    const idx = parent ? parent.children.indexOf(cur) : 0;
    parts.unshift(`${cur.name || '(沒名字)'}#${idx}`);
    cur = parent;
  }
  return parts.join('/') || '(場景)';
}

const yieldToUi = () => new Promise<void>(r => setTimeout(r, 0));

/** 把一份載入好的模型整理成可以比對的資料（不改動場景） */
export async function snapshotScene(gltf: GLTF): Promise<SceneSnapshot> {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const nodes: NodeSnap[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mats = mesh.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints
      ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean) : [];
    nodes.push({
      path: nodePath(o, scene),
      name: o.name,
      type: o.type,
      local: o.matrix.toArray(),
      world: o.matrixWorld.toArray(),
      userData: JSON.stringify(o.userData ?? {}),
      visible: o.visible,
      geometry: mesh.geometry ? snapGeometry(mesh.geometry) : null,
      materials: mats.map(snapMaterial),
    });
  });
  await yieldToUi();

  // 跟 StageScene / parseGlb 同一套
  const box = new THREE.Box3().setFromObject(scene, true);  // 用實際的頂點算（理由見 snapGeometry）
  const diag = box.getSize(new THREE.Vector3()).length();
  const scaleFactor = computeScaleFactor(diag);
  const bestScope = findBestScope(scene);
  const parsed = analyzeGltfScene(scene);
  const baked = bestScope.children.filter(c => (c.name || '').trim()).map((child) => {
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    child.matrixWorld.decompose(wp, wq, ws);
    return { name: child.name.trim(), p: wp.multiplyScalar(scaleFactor).toArray(), q: wq.toArray(), s: ws.multiplyScalar(scaleFactor).toArray() };
  });
  await yieldToUi();

  // LED 對位圖（LED_ 開頭的物件）
  const led: SceneSnapshot['led'] = [];
  for (const child of bestScope.children) {
    const name = (child.name || '').trim();
    if (!name || classifyMeshName(name).category !== 'led_panel') continue;
    const l = ledPanelRect(collectUvTriangles(child), VERIFY_LED_CANVAS);
    if (l) {
      led.push({ name, rect: l.rect, u: l.u, v: l.v });
    } else {
      led.push({ name, skipped: true });
    }
    await yieldToUi();
  }

  return {
    nodes,
    bboxMin: box.min.toArray(),
    bboxMax: box.max.toArray(),
    diag,
    scaleFactor,
    bestScopePath: nodePath(bestScope, scene),
    parsed,
    baked,
    led,
    animations: gltf.animations?.length ?? 0,
    cameras: gltf.cameras?.length ?? 0,
  };
}

function closeRel(a: number, b: number, rel: number, scale = 1): boolean {
  return Math.abs(a - b) <= rel * Math.max(scale, Math.abs(a), Math.abs(b));
}

function closeArr(a: readonly number[], b: readonly number[], rel: number, scale = 1): boolean {
  return a.length === b.length && a.every((v, i) => closeRel(v, b[i], rel, scale));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface CompareOptions {
  /**
   * 「場景大小 / 物件大小」這兩個從檔頭外框算出來的數字，額外容許的相對誤差（預設 0 = 照原本的容差）。
   * 用在原檔是 Draco 的情況：gltf-pipeline 之類匯出的 Draco 檔，檔頭的 min / max 比解壓縮出來的頂點多留了約一個量化格（例如 65 m 的場景差 8 cm），
   * 重新壓縮後檔頭是解壓縮後的真值，所以這兩個數字會小一點。頂點資料本身另外逐點比對過，這裡只是「推算出來的大小」的一致性檢查。
   */
  sizeSlackRel?: number;
}

/** 兩份快照比對；回傳不一樣的地方（白話），空的 = 一樣 */
export function compareSnapshots(a: SceneSnapshot, b: SceneSnapshot, opts: CompareOptions = {}): string[] {
  const issues: string[] = [];
  const add = (m: string) => { if (issues.length < 20) issues.push(m); };

  if (a.nodes.length !== b.nodes.length) {
    add(`節點數量不一樣（原檔 ${a.nodes.length}、壓縮後 ${b.nodes.length}）`);
  } else {
    a.nodes.forEach((x, i) => {
      const y = b.nodes[i];
      const where = `「${x.path}」`;
      if (x.path !== y.path || x.name !== y.name) { add(`第 ${i + 1} 個節點不一樣（${x.path} → ${y.path}）`); return; }
      if (x.type !== y.type) add(`${where} 的種類變了（${x.type} → ${y.type}）`);
      if (x.visible !== y.visible) add(`${where} 顯示 / 隱藏變了`);
      if (x.userData !== y.userData) add(`${where} 的 extras 變了`);
      if (!closeArr(x.local, y.local, TOLERANCE.matrixRel)) add(`${where} 的位置 / 旋轉 / 縮放變了`);
      if (!closeArr(x.world, y.world, TOLERANCE.matrixRel)) add(`${where} 的世界座標矩陣變了`);
      if (!!x.geometry !== !!y.geometry) add(`${where} 的形狀不見了或多出來`);
      else if (x.geometry && y.geometry) {
        const gx = x.geometry, gy = y.geometry;
        if (!same(gx.attributes, gy.attributes)) add(`${where} 的頂點資料種類變了（${gx.attributes.join(' ')} → ${gy.attributes.join(' ')}）`);
        if (gx.groups !== gy.groups) add(`${where} 的材質分組變了`);
        const s = Math.max(gx.extent, 1e-9);
        if (!closeArr(gx.bboxMin, gy.bboxMin, TOLERANCE.bboxRel, s) || !closeArr(gx.bboxMax, gy.bboxMax, TOLERANCE.bboxRel, s)) {
          add(`${where} 的外框變了`);
        }
      }
      if (x.materials.length !== y.materials.length) add(`${where} 的材質數量變了`);
      else x.materials.forEach((mx, k) => {
        const my = y.materials[k];
        if (!same(mx.props, my.props)) add(`${where} 的材質「${String(mx.props.name ?? '')}」設定變了`);
        if (!same(mx.maps, my.maps)) add(`${where} 的材質「${String(mx.props.name ?? '')}」貼圖格變了`);
      });
    });
  }

  const tolBox = TOLERANCE.bboxRel * Math.max(a.diag, 1e-9);
  const boxOk = [0, 1, 2].every(k => Math.abs(a.bboxMin[k] - b.bboxMin[k]) <= tolBox && Math.abs(a.bboxMax[k] - b.bboxMax[k]) <= tolBox);
  if (!boxOk) add('整個場景的外框變了');
  if (!(Math.abs(a.diag - b.diag) <= tolBox)) add(`場景對角線長度變了（${a.diag} → ${b.diag}）`);
  if (a.scaleFactor !== b.scaleFactor) add(`自動縮放倍率變了（×${a.scaleFactor} → ×${b.scaleFactor}）`);
  if (a.bestScopePath !== b.bestScopePath) add(`物件所在的那一層變了（${a.bestScopePath} → ${b.bestScopePath}）`);

  // 上傳時的物件清單（存進資料庫的預設位置）：一模一樣
  const pa = a.parsed, pb = b.parsed;
  const slack = opts.sizeSlackRel ?? 0;
  const sizeOk = (x: number, y: number) => Math.abs(x - y) <= 0.0015 + (TOLERANCE.bboxRel + slack) * Math.max(x, y);
  if (pa.scaleFactor !== pb.scaleFactor || pa.unitGuess !== pb.unitGuess || (slack === 0 ? pa.sceneSizeMeters !== pb.sceneSizeMeters : !sizeOk(pa.sceneSizeMeters, pb.sceneSizeMeters))) add('上傳時判斷的場景大小 / 單位變了');
  if (!same(pa.warnings, pb.warnings)) add('上傳時的提醒變了');
  if (pa.meshes.length !== pb.meshes.length) add(`物件數量變了（${pa.meshes.length} → ${pb.meshes.length}）`);
  else pa.meshes.forEach((m, i) => {
    const n = pb.meshes[i];
    const { sizeMeters: s1, ...restA } = m;
    const { sizeMeters: s2, ...restB } = n;
    if (!same(restA, restB)) add(`物件「${m.meshName}」的名稱、分類或預設位置 / 旋轉 / 縮放變了`);
    if (!sizeOk(s1, s2)) add(`物件「${m.meshName}」的大小變了（${s1} → ${s2}）`);
  });

  // StageScene 烤進縮放後的物件位置（cue 位置的單位）
  if (a.baked.length !== b.baked.length) add('舞台物件數量變了');
  else a.baked.forEach((x, i) => {
    const y = b.baked[i];
    if (x.name !== y.name || !closeArr(x.p, y.p, TOLERANCE.matrixRel) || !closeArr(x.q, y.q, TOLERANCE.matrixRel) || !closeArr(x.s, y.s, TOLERANCE.matrixRel)) {
      add(`舞台物件「${x.name}」的位置 / 旋轉 / 縮放變了`);
    }
  });

  // LED 對位圖
  if (a.led.length !== b.led.length) add('LED 數量變了');
  else a.led.forEach((x, i) => {
    const y = b.led[i];
    if (x.name !== y.name || ('skipped' in x) !== ('skipped' in y)) { add(`LED「${x.name}」對不起來`); return; }
    if ('skipped' in x || 'skipped' in y) return;
    const spanOk = (s: AxisSpan, t: AxisSpan) => s.wraps === t.wraps && Math.abs(s.start - t.start) <= TOLERANCE.ledSpan && Math.abs(s.length - t.length) <= TOLERANCE.ledSpan;
    if (!same(x.rect, y.rect)) add(`LED「${x.name}」在對位圖上的位置變了（${JSON.stringify(x.rect)} → ${JSON.stringify(y.rect)}）`);
    else if (!spanOk(x.u, y.u) || !spanOk(x.v, y.v)) add(`LED「${x.name}」的 UV 範圍變了`);
  });

  if (a.animations !== b.animations) add('動畫數量變了');
  if (a.cameras !== b.cameras) add('攝影機數量變了');
  return issues;
}

/** 釋放載入的模型（比對完就丟） */
export function disposeGltf(gltf: GLTF): void {
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      const rec = m as unknown as Record<string, unknown>;
      for (const k of MAP_SLOTS) {
        const t = rec[k] as THREE.Texture | null | undefined;
        if (t?.isTexture) {
          (t.image as { close?: () => void } | null)?.close?.();
          t.dispose();
        }
      }
      m.dispose();
    }
  });
}

/**
 * 原檔、壓縮檔都用網站的方法載入，比對網站會用到的每一項。
 * 兩份都比完才回傳；任何一項不一樣 → ok = false
 */
export async function verifyModelIdentity(original: ArrayBuffer, compressed: ArrayBuffer): Promise<SceneVerifyReport> {
  const ga = await parseModel(original);
  const a = await snapshotScene(ga);
  disposeGltf(ga);
  await yieldToUi();
  const gb = await parseModel(compressed);
  const b = await snapshotScene(gb);
  disposeGltf(gb);
  const issues = compareSnapshots(a, b);
  return {
    ok: issues.length === 0,
    issues,
    stats: { nodes: a.nodes.length, meshes: a.nodes.filter(n => n.geometry).length, ledPanels: a.led.length },
  };
}
