// 測試用的舞台模型（程式產生，每次都一樣）：專門放壓縮最容易出錯的東西
//   - 多層巢狀節點（外層包一個「舞台」）、不等比縮放、旋轉、鏡像（負的縮放）、一個用 matrix 寫的節點（也鏡像）
//   - LED_ / MECH_ / STAGE_ / PROP_ / WALK_ / LIGHT_ 命名
//   - LED 的 UV：v 在負的（-0.8 ~ -0.45）、跨過畫布邊緣（u 0.95 ~ 1.05）、地屏 v -1 ~ 0；貼圖 RepeatWrapping
//   - 超過 65535 個頂點的地屏（uint32 索引）、兩組 UV、頂點顏色、硬邊（同位置不同法線）、重複頂點、沒有面積的三角形
//   - 共用同一個形狀的兩個節點、沒有索引的三角形、線段、動畫、extras、發光強度、貼圖位移（KHR_texture_transform）
// 只用 @gltf-transform/core / extensions，node 和瀏覽器都能跑。

import { Document, MathUtils, Primitive, TextureInfo, type Accessor, type Buffer as GBuffer, type Node } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength, KHRTextureTransform } from '@gltf-transform/extensions';

/** 8×8 的小 PNG（棋盤格 + 漸層），當 LED 對位測試圖 */
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAh0lEQVR4nBXOQQ0AQAgDQZQQpCAFKUhBClJw0tt7TtKka24mD5PSpDJ548GLz2RuIY+QMqQKeePBiy9kspQi5ZnySqnx4MWXf1BSlDxLXiU1Hrz46l80DU1D09A04MGLr/9gaBgahoahAQ9efPMvloalYWlYGvDgxbd/cDQcDUfD0YAHL77TA+afm2FbZ/hfAAAAAElFTkSuQmCC';

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Geo {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

/** XY 平面上的格子（朝 +Z），UV 從 uv0 線性到 uv1 */
function gridGeo(segU: number, segV: number, w: number, h: number, uv0: [number, number], uv1: [number, number], wave = 0): Geo {
  const g: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i <= segU; i++) {
      const s = i / segU, t = j / segV;
      // 有一點彎（曲面 LED），座標就不會剛好是整齊的數字
      const z = wave * Math.sin(s * Math.PI) * Math.cos(t * 1.3);
      g.pos.push((s - 0.5) * w, (t - 0.5) * h, z);
      g.nrm.push(-wave * Math.cos(s * Math.PI) * 0.3, 0, 1);
      g.uv.push(uv0[0] + (uv1[0] - uv0[0]) * s, uv0[1] + (uv1[1] - uv0[1]) * (1 - t));
    }
  }
  const row = segU + 1;
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      g.idx.push(a, b, d, a, d, c);
    }
  }
  return g;
}

/** 硬邊的方塊：每面 4 個頂點（同位置不同法線） */
function boxGeo(sx: number, sy: number, sz: number): Geo {
  const g: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = g.pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      g.pos.push((n[0] + u[0] * a + v[0] * b) * sx / 2, (n[1] + u[1] * a + v[1] * b) * sy / 2, (n[2] + u[2] * a + v[2] * b) * sz / 2);
      g.nrm.push(n[0], n[1], n[2]);
      g.uv.push((a + 1) / 2, (1 - b) / 2);
    }
    g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return g;
}

/** 圓柱側面（平滑法線，接縫重複頂點） */
function cylinderGeo(seg: number, r: number, h: number): Geo {
  const g: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    for (const y of [-h / 2, h / 2]) {
      g.pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      g.nrm.push(Math.cos(a), 0, Math.sin(a));
      g.uv.push(i / seg, y > 0 ? 0 : 1);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    g.idx.push(a, b, d, a, d, c);
  }
  return g;
}

export interface StageFixtureOptions {
  /** 地屏的格數（預設 260 × 260 → 67081 個頂點，要用 uint32 索引） */
  floorSegments?: number;
}

export interface StageFixture {
  doc: Document;
  /** 用 matrix 寫的節點（寫成 .glb 之後才換成 matrix，見 patchGlbJson） */
  matrixNodeName: string;
}

const deg = (d: number) => (d * Math.PI) / 180;
function quatAxis(axis: [number, number, number], angleDeg: number): [number, number, number, number] {
  const s = Math.sin(deg(angleDeg) / 2), l = Math.hypot(...axis);
  return [axis[0] / l * s, axis[1] / l * s, axis[2] / l * s, Math.cos(deg(angleDeg) / 2)];
}

export function buildStageFixture(opts: StageFixtureOptions = {}): StageFixture {
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'stage-previz test fixture';
  const buffer = doc.createBuffer();
  const acc = (type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4', arr: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>): Accessor =>
    doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer as GBuffer);
  const prim = (g: Geo, extra: Record<string, Accessor> = {}, indexed = true) => {
    const p = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos)))
      .setAttribute('NORMAL', acc('VEC3', new Float32Array(g.nrm)))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(g.uv)));
    for (const [k, a] of Object.entries(extra)) p.setAttribute(k, a);
    if (indexed) {
      const n = g.pos.length / 3;
      p.setIndices(acc('SCALAR', n > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx)));
    }
    return p;
  };

  // 材質
  const image = base64Bytes(TEST_PNG_BASE64);
  const ledTex = doc.createTexture('LED 對位測試圖').setImage(image).setMimeType('image/png');
  const emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength);
  const transformExt = doc.createExtension(KHRTextureTransform);
  const ledMat = doc.createMaterial('LED_Screen')
    .setBaseColorFactor([0.02, 0.02, 0.02, 1])
    .setEmissiveFactor([1, 1, 1])
    .setEmissiveTexture(ledTex)
    .setRoughnessFactor(0.3)
    .setMetallicFactor(0);
  ledMat.getEmissiveTextureInfo()!
    .setWrapS(TextureInfo.WrapMode.REPEAT).setWrapT(TextureInfo.WrapMode.REPEAT)
    .setMagFilter(TextureInfo.MagFilter.LINEAR).setMinFilter(TextureInfo.MinFilter.LINEAR_MIPMAP_LINEAR);
  ledMat.setExtension('KHR_materials_emissive_strength', emissiveExt.createEmissiveStrength().setEmissiveStrength(2.5));
  const metal = doc.createMaterial('Truss_Metal').setBaseColorFactor([0.6, 0.6, 0.65, 1]).setMetallicFactor(0.9).setRoughnessFactor(0.35);
  const speakerTex = doc.createTexture('喇叭網').setImage(image.slice()).setMimeType('image/png');
  const speaker = doc.createMaterial('Speaker').setBaseColorTexture(speakerTex).setDoubleSided(true);
  speaker.getBaseColorTextureInfo()!.setTexCoord(0)
    .setExtension('KHR_texture_transform', transformExt.createTransform().setOffset([0.25, -0.5]).setScale([2, 3]).setRotation(0.2));
  const floorMat = doc.createMaterial('Floor').setAlphaMode('BLEND').setBaseColorFactor([0.1, 0.1, 0.12, 0.9]);

  const scene = doc.createScene('Scene');
  const wrapper = doc.createNode('舞台').setTranslation([0.5, 0, -1]).setRotation(quatAxis([0, 1, 0], 15)).setScale([1, 1, 1])
    .setExtras({ c4d: { layer: '舞台', exportedBy: 'C4D 2025' } });
  scene.addChild(wrapper);

  const meshNode = (name: string, meshName: string, p: Primitive | Primitive[]): Node => {
    const mesh = doc.createMesh(meshName);
    for (const x of Array.isArray(p) ? p : [p]) mesh.addPrimitive(x);
    return doc.createNode(name).setMesh(mesh);
  };

  // LED_01 主牆：v 在負的
  const led1 = meshNode('LED_01_主牆', 'LED_01_主牆', prim(gridGeo(24, 12, 8, 4.5, [0, -0.8], [1, -0.45], 0.4)).setMaterial(ledMat))
    .setTranslation([0, 4, -6]).setRotation(quatAxis([1, 0, 0], -5)).setScale([2, 1.25, 1]);
  wrapper.addChild(led1);

  // LED_02 側屏：外面包一層、鏡像，UV 跨過畫布邊緣
  const led2 = doc.createNode('LED_02_側屏').setTranslation([-6, 3, -3]).setRotation(quatAxis([0, 1, 0], 70)).setScale([-1, 1, 1]);
  led2.addChild(meshNode('側屏_面', '側屏', prim(gridGeo(10, 6, 3, 2, [0.95, 0.2], [1.05, 0.55])).setMaterial(ledMat))
    .setTranslation([0, 0, 0.05]).setRotation(quatAxis([0, 0, 1], 3)).setScale([1, 1.5, 1]));
  wrapper.addChild(led2);

  // LED_03 地屏：很多頂點（uint32 索引），v -1 ~ 0
  const fs = opts.floorSegments ?? 260;
  wrapper.addChild(meshNode('LED_03_地屏', 'LED_03_地屏', prim(gridGeo(fs, fs, 10, 6, [0, -1], [1, 0], 0.02)).setMaterial(ledMat))
    .setTranslation([0, 0.01, 0]).setRotation(quatAxis([1, 0, 0], -90)));

  // LED_04 天幕：之後換成 matrix 寫法（含鏡像）
  wrapper.addChild(meshNode('LED_04_天幕', 'LED_04_天幕', prim(gridGeo(16, 4, 6, 1.5, [0, 0.6], [0.5, 0.75])).setMaterial(ledMat))
    .setTranslation([1.25, 7.5, -4.5]).setRotation(quatAxis([0.3, 1, 0.2], 25)).setScale([-1.2, 0.8, 1.1]));

  // MECH_01 升降台：多層、不等比縮放、任意旋轉；台面和細節共用同一個形狀
  const box = doc.createMesh('台面');
  box.addPrimitive(prim(boxGeo(2, 0.4, 1.6)).setMaterial(metal));
  const mech = doc.createNode('MECH_01_升降台').setTranslation([0, 0, 2]).setExtras({ travel: 1.5 });
  const top = doc.createNode('台面').setMesh(box).setTranslation([0, 0.5, 0])
    .setRotation(quatAxis([0.2, 0.9, 0.4], 37)).setScale([1.5, 0.3, 2.0]);
  top.addChild(doc.createNode('台面_細節').setMesh(box).setTranslation([0.2, 0.1, 0]).setScale([0.5, 0.5, 0.5]));
  mech.addChild(top);
  wrapper.addChild(mech);

  // STAGE_02 旋轉台：兩組 UV、頂點顏色、重複頂點、沒有面積的三角形
  const cyl = cylinderGeo(48, 2.5, 0.6);
  const nv = cyl.pos.length / 3;
  // 重複頂點：最後一個頂點再放一次（完全一樣）；沒有面積的三角形：同一個頂點用兩次
  cyl.pos.push(...cyl.pos.slice(0, 3));
  cyl.nrm.push(...cyl.nrm.slice(0, 3));
  cyl.uv.push(...cyl.uv.slice(0, 2));
  cyl.idx.push(0, 1, nv, 3, 3, 5);
  const uv1: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < cyl.pos.length / 3; i++) {
    uv1.push(cyl.uv[i * 2] * 0.5 + 0.25, cyl.uv[i * 2 + 1] * -2);
    colors.push(0.2 + (i % 7) / 10, 0.5, 1 - (i % 5) / 8, 1);
  }
  wrapper.addChild(meshNode('STAGE_02_旋轉台', 'STAGE_02_旋轉台', prim(cyl, {
    TEXCOORD_1: acc('VEC2', new Float32Array(uv1)),
    COLOR_0: acc('VEC4', new Float32Array(colors)),
  }).setMaterial(metal)).setTranslation([3, 0, 1]).setRotation(quatAxis([0, 1, 0], 30)).setScale([1, 0.5, 1]));

  // PROP 兩個喇叭共用同一個形狀，一個鏡像
  const spk = doc.createMesh('喇叭');
  spk.addPrimitive(prim(boxGeo(0.6, 1.2, 0.5)).setMaterial(speaker));
  wrapper.addChild(doc.createNode('PROP_01_喇叭').setMesh(spk).setTranslation([-4, 0.6, 3]));
  wrapper.addChild(doc.createNode('PROP_02_喇叭').setMesh(spk).setTranslation([4, 0.6, 3]).setScale([-1, 1, 1]));

  // WALK_01：沒有索引的三角形（Draco 不壓，要原封不動）
  const walk = gridGeo(2, 1, 1, 1, [0, 0], [1, 1]);
  const flat: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  for (const k of walk.idx) {
    flat.pos.push(...walk.pos.slice(k * 3, k * 3 + 3));
    flat.nrm.push(...walk.nrm.slice(k * 3, k * 3 + 3));
    flat.uv.push(...walk.uv.slice(k * 2, k * 2 + 2));
  }
  wrapper.addChild(meshNode('WALK_01_主舞', 'WALK_01', prim(flat, {}, false).setMaterial(floorMat)).setTranslation([0, 0.02, 4]));

  // LIGHT_01：線段
  const line = doc.createPrimitive().setMode(Primitive.Mode.LINES)
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 0, -6, 1.5, 0.5, 0, 0, 0.5, -6, 1.5])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 3])));
  wrapper.addChild(meshNode('LIGHT_01_光束', '光束', line).setTranslation([0, 8, 0]));

  // 地板（沒有命名規則的物件）
  wrapper.addChild(meshNode('Floor', 'Floor', prim(gridGeo(4, 4, 30, 20, [0, 0], [6, 4])).setMaterial(floorMat))
    .setRotation(quatAxis([1, 0, 0], -90)));

  // 動畫：升降台上下
  const anim = doc.createAnimation('升降');
  const sampler = doc.createAnimationSampler()
    .setInput(acc('SCALAR', new Float32Array([0, 1, 2])))
    .setOutput(acc('VEC3', new Float32Array([0, 0, 2, 0, 1.5, 2, 0, 0, 2])))
    .setInterpolation('LINEAR');
  anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(mech).setTargetPath('translation').setSampler(sampler));

  return { doc, matrixNodeName: 'LED_04_天幕' };
}

// ── .glb 的 JSON 直接改（測試用：換成 matrix 寫法、故意改壞壓縮檔） ──

const GLB_MAGIC = 0x46546c67;

export function patchGlbJson(glb: Uint8Array, patch: (json: Record<string, unknown>) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a glb');
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as Record<string, unknown>;
  patch(json);
  const rest = glb.subarray(20 + jsonLen);  // BIN chunk（含 chunk header）
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad) {
    const padded = new Uint8Array(jsonBytes.length + pad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const out = new Uint8Array(12 + 8 + jsonBytes.length + rest.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, GLB_MAGIC, true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, out.length, true);
  ov.setUint32(12, jsonBytes.length, true);
  ov.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.length);
  return out;
}

/** 把某個節點的 translation / rotation / scale 換成同樣意思的 matrix */
export function useMatrixForNode(glb: Uint8Array, nodeName: string): Uint8Array {
  return patchGlbJson(glb, (json) => {
    const nodes = json.nodes as { name?: string; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
    const n = nodes.find(x => x.name === nodeName);
    if (!n) throw new Error(`node ${nodeName} not found`);
    const m = MathUtils.compose(
      (n.translation ?? [0, 0, 0]) as [number, number, number],
      (n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
      (n.scale ?? [1, 1, 1]) as [number, number, number],
      new Array(16).fill(0) as unknown as Parameters<typeof MathUtils.compose>[3],
    );
    delete n.translation; delete n.rotation; delete n.scale;
    n.matrix = Array.from(m as ArrayLike<number>);
  });
}
