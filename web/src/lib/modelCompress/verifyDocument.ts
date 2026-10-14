// 壓縮前後逐項比對（第一關，在壓縮 worker 裡跑；gltf-transform 讀出來的資料）
//
// 節點：名稱、階層、位置 / 旋轉 / 縮放、extras 要「一模一樣」（壓縮根本不該碰到）
// 材質、貼圖（圖片的每個位元組）、取樣方式（Repeat / Clamp…）、動畫、骨架、攝影機：一模一樣
// 形狀：每個 primitive 的頂點和三角形逐點比對（geometryMatch.ts），位置 / UV 誤差在 float 精度內
// 整個場景的外框：差 ≤ 1e-5 × 對角線
//
// 第二關（three.js 實際載入後比節點、外框、自動縮放、物件預設位置、LED 對位圖）在 verifyScene.ts。

import { Accessor, getBounds, type Document, type Node, type Primitive, type Property } from '@gltf-transform/core';
import { attributeExtent, matchGeometry, type AttrKind, type MatchAttr } from './geometryMatch';
import { MATCH_WORK_FACTOR, TOLERANCE } from './settings';
import { DRACO_EXTENSION } from './glbJson';

export interface DocumentVerifyReport {
  ok: boolean;
  /** 不一樣的地方（白話，最多列 20 個） */
  issues: string[];
  stats: {
    nodes: number;
    primitives: number;
    /** 資料完全沒變的 primitive（沒被壓縮的） */
    primitivesUnchanged: number;
    /** 逐點比對過的 primitive */
    primitivesMatched: number;
    trianglesOriginal: number;
    trianglesCompressed: number;
    /** 被拿掉的沒有面積的三角形（原檔就畫不出來） */
    degenerateDropped: number;
    /** 每種資料：最大誤差 / 容許誤差（< 1 才算過） */
    maxErrorRatio: Record<string, number>;
  };
}

const MAX_ISSUES = 20;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function equalsSkipping(a: Property, b: Property, skip: string[]): boolean {
  return a.equals(b as never, new Set(skip));
}

function kindOf(semantic: string, acc: Accessor): { kind: AttrKind; tol: number } {
  const float = acc.getComponentType() === Accessor.ComponentType.FLOAT;
  if (!float) return { kind: 'exact', tol: 0 };
  const { range, maxAbs } = attributeExtent(acc.getArray()!, acc.getElementSize(), acc.getCount());
  const rel = Math.max(range, maxAbs, 1e-9) * TOLERANCE.floatRel;
  if (semantic === 'POSITION') return { kind: 'position', tol: rel };
  if (semantic === 'NORMAL') return { kind: 'normal', tol: TOLERANCE.normalAbs };
  if (semantic.startsWith('COLOR_')) return { kind: 'float', tol: TOLERANCE.colorAbs };
  return { kind: 'float', tol: rel };
}

function primName(node: Node | null, meshName: string, i: number): string {
  return `${node ? `「${node.getName() || '(沒名字)'}」` : ''}${meshName ? `形狀「${meshName}」` : '形狀'} 第 ${i + 1} 組`;
}

export function verifyDocuments(orig: Document, dec: Document): DocumentVerifyReport {
  const issues: string[] = [];
  const add = (msg: string) => { if (issues.length < MAX_ISSUES) issues.push(msg); };
  const stats: DocumentVerifyReport['stats'] = {
    nodes: 0, primitives: 0, primitivesUnchanged: 0, primitivesMatched: 0,
    trianglesOriginal: 0, trianglesCompressed: 0, degenerateDropped: 0, maxErrorRatio: {},
  };
  const ra = orig.getRoot(), rb = dec.getRoot();

  // 擴充：壓縮檔只多一個 Draco
  const extA = ra.listExtensionsUsed().map(e => e.extensionName).sort();
  const extB = rb.listExtensionsUsed().map(e => e.extensionName).filter(n => n !== DRACO_EXTENSION).sort();
  if (!sameJson(extA.filter(n => n !== DRACO_EXTENSION), extB)) add(`用到的擴充不一樣（原檔 ${extA.join(', ') || '無'}；壓縮後 ${extB.join(', ') || '無'}）`);

  if (!sameJson(ra.getExtras(), rb.getExtras())) add('檔案的 extras 不一樣');
  if ((ra.getAsset().copyright ?? '') !== (rb.getAsset().copyright ?? '')) add('檔案的版權欄位不一樣');

  // ── 節點 ──
  const nodesA = ra.listNodes(), nodesB = rb.listNodes();
  stats.nodes = nodesA.length;
  const nodeIndexA = new Map(nodesA.map((n, i) => [n, i]));
  const nodeIndexB = new Map(nodesB.map((n, i) => [n, i]));
  if (nodesA.length !== nodesB.length) {
    add(`節點數量不一樣（原檔 ${nodesA.length}、壓縮後 ${nodesB.length}）`);
  } else {
    for (let i = 0; i < nodesA.length; i++) {
      const a = nodesA[i], b = nodesB[i];
      const label = `節點「${a.getName() || `#${i}`}」`;
      if (a.getName() !== b.getName()) add(`第 ${i + 1} 個節點名稱不一樣（「${a.getName()}」→「${b.getName()}」）`);
      if (!sameJson(a.getTranslation(), b.getTranslation()) || !sameJson(a.getRotation(), b.getRotation()) || !sameJson(a.getScale(), b.getScale())) {
        add(`${label} 的位置 / 旋轉 / 縮放變了`);
      }
      if (!sameJson(a.getWorldMatrix(), b.getWorldMatrix())) add(`${label} 的世界座標矩陣變了`);
      if (!equalsSkipping(a, b, ['mesh', 'children', 'skin'])) add(`${label} 的其他設定（extras、攝影機、擴充）變了`);
      const ca = a.listChildren().map(c => nodeIndexA.get(c)), cb = b.listChildren().map(c => nodeIndexB.get(c));
      if (!sameJson(ca, cb)) add(`${label} 底下的子節點不一樣`);
      const ma = a.getMesh(), mb = b.getMesh();
      if (!!ma !== !!mb || (ma && mb && ra.listMeshes().indexOf(ma) !== rb.listMeshes().indexOf(mb))) add(`${label} 掛的形狀不一樣`);
      const sa = a.getSkin(), sb = b.getSkin();
      if (!!sa !== !!sb || (sa && sb && ra.listSkins().indexOf(sa) !== rb.listSkins().indexOf(sb))) add(`${label} 的骨架不一樣`);
    }
  }

  // ── 場景 ──
  const scenesA = ra.listScenes(), scenesB = rb.listScenes();
  if (scenesA.length !== scenesB.length) add(`場景數量不一樣（${scenesA.length} → ${scenesB.length}）`);
  else {
    if (scenesA.indexOf(ra.getDefaultScene()!) !== scenesB.indexOf(rb.getDefaultScene()!)) add('預設場景不一樣');
    scenesA.forEach((sa, i) => {
      const sb = scenesB[i];
      if (!equalsSkipping(sa, sb, ['children'])) add(`第 ${i + 1} 個場景的名稱或設定不一樣`);
      if (!sameJson(sa.listChildren().map(c => nodeIndexA.get(c)), sb.listChildren().map(c => nodeIndexB.get(c)))) add(`第 ${i + 1} 個場景最上層的節點不一樣`);
      // 外框
      const ba = getBounds(sa), bb = getBounds(sb);
      const diag = Math.hypot(ba.max[0] - ba.min[0], ba.max[1] - ba.min[1], ba.max[2] - ba.min[2]);
      const tol = Math.max(diag, 1e-9) * TOLERANCE.bboxRel;
      for (let k = 0; k < 3; k++) {
        if (!(Math.abs(ba.min[k] - bb.min[k]) <= tol) || !(Math.abs(ba.max[k] - bb.max[k]) <= tol)) {
          add(`第 ${i + 1} 個場景的外框變了`);
          break;
        }
      }
    });
  }

  // ── 材質、貼圖、攝影機、動畫、骨架（壓縮不該碰到，要一模一樣） ──
  const matsA = ra.listMaterials(), matsB = rb.listMaterials();
  if (matsA.length !== matsB.length) add(`材質數量不一樣（${matsA.length} → ${matsB.length}）`);
  else matsA.forEach((m, i) => { if (!m.equals(matsB[i])) add(`材質「${m.getName() || `#${i}`}」的設定或貼圖變了`); });
  const texA = ra.listTextures(), texB = rb.listTextures();
  if (texA.length !== texB.length) add(`貼圖數量不一樣（${texA.length} → ${texB.length}）`);
  else texA.forEach((t, i) => { if (!t.equals(texB[i])) add(`貼圖「${t.getName() || t.getURI() || `#${i}`}」的圖片變了`); });
  const camA = ra.listCameras(), camB = rb.listCameras();
  if (camA.length !== camB.length || camA.some((c, i) => !c.equals(camB[i]))) add('攝影機不一樣');
  const skA = ra.listSkins(), skB = rb.listSkins();
  if (skA.length !== skB.length) add('骨架數量不一樣');
  else skA.forEach((s, i) => {
    const t = skB[i];
    const ibmA = s.getInverseBindMatrices(), ibmB = t.getInverseBindMatrices();
    if (s.getName() !== t.getName()
      || !sameJson(s.listJoints().map(j => nodeIndexA.get(j)), t.listJoints().map(j => nodeIndexB.get(j)))
      || nodeIndexA.get(s.getSkeleton()!) !== nodeIndexB.get(t.getSkeleton()!)
      || !!ibmA !== !!ibmB || (ibmA && ibmB && !ibmA.equals(ibmB))) add(`骨架「${s.getName() || `#${i}`}」不一樣`);
  });
  const animA = ra.listAnimations(), animB = rb.listAnimations();
  if (animA.length !== animB.length) add('動畫數量不一樣');
  else animA.forEach((an, i) => {
    const bn = animB[i];
    const chA = an.listChannels(), chB = bn.listChannels();
    let same = an.getName() === bn.getName() && chA.length === chB.length && sameJson(an.getExtras(), bn.getExtras());
    for (let c = 0; same && c < chA.length; c++) {
      const x = chA[c], y = chB[c];
      const sx = x.getSampler(), sy = y.getSampler();
      same = x.getTargetPath() === y.getTargetPath()
        && nodeIndexA.get(x.getTargetNode()!) === nodeIndexB.get(y.getTargetNode()!)
        && !!sx === !!sy
        && (!sx || !sy || (sx.getInterpolation() === sy.getInterpolation()
          && !!sx.getInput()?.equals(sy.getInput()!) && !!sx.getOutput()?.equals(sy.getOutput()!)));
    }
    if (!same) add(`動畫「${an.getName() || `#${i}`}」不一樣`);
  });

  // ── 形狀 ──
  const meshesA = ra.listMeshes(), meshesB = rb.listMeshes();
  if (meshesA.length !== meshesB.length) {
    add(`形狀數量不一樣（${meshesA.length} → ${meshesB.length}）`);
  } else {
    meshesA.forEach((ma, mi) => {
      const mb = meshesB[mi];
      const owner = ma.listParents().find((p): p is Node => p.propertyType === 'Node') ?? null;
      if (!equalsSkipping(ma, mb, ['primitives'])) add(`形狀「${ma.getName() || `#${mi}`}」的名稱或設定變了`);
      const pa = ma.listPrimitives(), pb = mb.listPrimitives();
      if (pa.length !== pb.length) { add(`形狀「${ma.getName() || `#${mi}`}」的組數不一樣`); return; }
      pa.forEach((a, pi) => {
        stats.primitives++;
        const msg = comparePrimitive(a, pb[pi], stats);
        if (msg) add(`${primName(owner, ma.getName(), pi)}：${msg}`);
      });
    });
  }

  return { ok: issues.length === 0, issues, stats };
}

/** 一組形狀（primitive）比對；一樣 → null，不一樣 → 原因 */
function comparePrimitive(a: Primitive, b: Primitive, stats: DocumentVerifyReport['stats']): string | null {
  // 材質（深比較，含貼圖）、繪製方式、extras、擴充
  if (!equalsSkipping(a, b, ['attributes', 'indices', 'targets'])) return '材質或繪製方式變了';
  const semA = a.listSemantics().slice().sort(), semB = b.listSemantics().slice().sort();
  if (!sameJson(semA, semB)) return `頂點資料的種類不一樣（${semA.join(', ')} → ${semB.join(', ')}）`;
  for (const s of semA) {
    const x = a.getAttribute(s)!, y = b.getAttribute(s)!;
    if (x.getElementSize() !== y.getElementSize() || x.getComponentType() !== y.getComponentType() || x.getNormalized() !== y.getNormalized()) {
      return `${s} 的資料格式變了`;
    }
  }
  // morph target（Draco 不壓，要一模一樣）
  const ta = a.listTargets(), tb = b.listTargets();
  if (ta.length !== tb.length) return '變形目標數量不一樣';
  for (let t = 0; t < ta.length; t++) {
    const s1 = ta[t].listSemantics().slice().sort(), s2 = tb[t].listSemantics().slice().sort();
    if (!sameJson(s1, s2) || s1.some(s => !ta[t].getAttribute(s)!.equals(tb[t].getAttribute(s)!))) return '變形目標的資料變了';
  }

  const ia = a.getIndices(), ib = b.getIndices();
  // 沒被壓縮（資料原封不動）→ 不用逐點比
  const unchanged = semA.every(s => a.getAttribute(s)!.equals(b.getAttribute(s)!)) && (!!ia === !!ib) && (!ia || ia.equals(ib!));
  const mode = a.getMode();
  const triangles = mode === 4;  // TRIANGLES
  const trisOf = (p: Primitive) => {
    const idx = p.getIndices();
    const n = idx ? idx.getCount() : (p.getAttribute('POSITION')?.getCount() ?? 0);
    return triangles ? Math.floor(n / 3) : 0;
  };
  if (unchanged) {
    stats.primitivesUnchanged++;
    stats.trianglesOriginal += trisOf(a);
    stats.trianglesCompressed += trisOf(b);
    return null;
  }
  if (mode === 5 || mode === 6) return '三角形帶 / 扇形的資料變了';  // Draco 不會壓這兩種 → 不該變
  const posA = a.getAttribute('POSITION'), posB = b.getAttribute('POSITION');
  if (!posA || !posB) return '沒有位置資料，沒辦法比對';

  const attrs: MatchAttr[] = [];
  for (const s of ['POSITION', ...semA.filter(x => x !== 'POSITION')]) {
    const x = a.getAttribute(s)!, y = b.getAttribute(s)!;
    const { kind, tol } = kindOf(s, x);
    attrs.push({ name: s, kind, tol, itemSize: x.getElementSize(), a: x.getArray()!, b: y.getArray()! });
  }
  const r = matchGeometry({
    attrs,
    countA: posA.getCount(),
    countB: posB.getCount(),
    indexA: ia ? ia.getArray() : null,
    indexB: ib ? ib.getArray() : null,
    triangles,
    workFactor: MATCH_WORK_FACTOR,
  });
  stats.primitivesMatched++;
  stats.trianglesOriginal += r.trianglesA;
  stats.trianglesCompressed += r.trianglesB;
  stats.degenerateDropped += Math.max(0, r.degenerateA - r.degenerateB);
  for (const [k, v] of Object.entries(r.errorRatio)) {
    stats.maxErrorRatio[k] = Math.max(stats.maxErrorRatio[k] ?? 0, v);
  }
  return r.ok ? null : (r.reason || '形狀不一樣');
}
