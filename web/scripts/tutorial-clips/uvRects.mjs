// 從貼好 UV 的模型（.glb）算出每片 LED 在畫布上的位置（像素）：生示範動畫要照這個位置畫，LED 才對得準。
// 模型沒壓縮（自動貼 UV 寫出來的是一般的 .glb），直接讀 TEXCOORD_0 的範圍。

const COMPONENT_BYTES = { 5126: 4, 5123: 2, 5121: 1, 5125: 4, 5122: 2, 5120: 1 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(j, bin, idx) {
  const a = j.accessors[idx];
  const bv = j.bufferViews[a.bufferView];
  const n = TYPE_COUNT[a.type];
  const cb = COMPONENT_BYTES[a.componentType];
  const stride = bv.byteStride || n * cb;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = [];
  for (let i = 0; i < a.count; i++) {
    const row = [];
    for (let k = 0; k < n; k++) {
      const off = base + i * stride + k * cb;
      let v;
      if (a.componentType === 5126) v = view.getFloat32(off, true);
      else if (a.componentType === 5123) v = view.getUint16(off, true) / (a.normalized ? 65535 : 1);
      else if (a.componentType === 5125) v = view.getUint32(off, true);
      else v = view.getUint8(off) / (a.normalized ? 255 : 1);
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

/** @returns {{ name: string, u0: number, v0: number, u1: number, v1: number }[]}  每個物件 UV 的範圍（0~1） */
export function readUvBoxes(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const j = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = glb.subarray(binStart);
  const out = [];
  for (const node of j.nodes) {
    if (node.mesh === undefined) continue;
    const mesh = j.meshes[node.mesh];
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const prim of mesh.primitives) {
      const t = prim.attributes.TEXCOORD_0;
      if (t === undefined) continue;
      for (const [u, v] of readAccessor(j, bin, t)) {
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
    }
    if (u0 === Infinity) continue;
    out.push({ name: node.name, u0, v0, u1, v1 });
  }
  return out;
}

/** 每片 LED 在畫布上的位置（像素）。UV 的 v 往下算（glTF 慣例：v = 0 在圖的最上面）。 */
export function ledRects(glb, canvas) {
  return readUvBoxes(glb)
    .filter(b => /^LED[_-]/i.test(b.name))
    .map(b => ({
      name: b.name,
      x: Math.round(b.u0 * canvas.width), y: Math.round(b.v0 * canvas.height),
      w: Math.max(1, Math.round((b.u1 - b.u0) * canvas.width)), h: Math.max(1, Math.round((b.v1 - b.v0) * canvas.height)),
    }));
}
