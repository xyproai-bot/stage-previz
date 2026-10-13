// 「把現有 cue 的位置轉成機關位置」：升降台 / 轉台以前是一個 cue 一個 cue 手動擺高度、角度的 →
// 每個 cue 量出它離預設位置差多少（沿著機關的方向 / 繞著轉軸），變成這個 cue 的機關位置，物件自己存的位置扣掉這一段。
//
// 原則：轉完畫面一模一樣（每個 cue、每個物件）。怎麼做到：
//   每個 cue 決定一個 s（機關多走的量），機關位置 = 預設位置 + s；物件在這個 cue 要的「cue 位置」= 畫面位置倒回 s。
//   物件自己有存 → 改那一筆；沿用前面的 → 前面那筆已經倒回同樣的 s 就不用動，不一樣就在這個 cue 補一筆
//   （沿用規則跟 cf-worker/cueStates.mjs 一樣：同一首歌、順序在前面、最近一筆）。
//   s = 第一個物件（參考物件）離預設位置差多少；同一個機關裡有存位置的物件都要差一樣多（1 mm / 0.1° 以內）才轉，
//   不一樣的 cue 不轉（s = 0，畫面也一樣），列出來給人看。轉出來超出行程的也不轉。
//   機關位置只在跟沿用的值不一樣時才存（沿用規則跟 track.ts 一樣：只有正式 cue 往後傳）。
//
// 只給「還沒有任何 cue 設過位置」的機關用（後台會擋）。
// 這個檔案後台（cf-worker/mechanisms.mjs）也用：不 import 別的檔案、不用 three（四元數自己算）、不用要編譯的 TS 寫法。

export interface CVec { x: number; y: number; z: number }
export interface CEuler { pitch: number; yaw: number; roll: number }

export interface ConvertMechanism {
  kind: 'linear' | 'rotary';
  axis: CVec;
  pivot: CVec | null;
  defaultValue: number;
  travelMin: number;
  travelMax: number;
}
export interface ConvertObject { id: string; defaultPosition: CVec; defaultRotation: CEuler }
export interface ConvertCue { id: string; songId: string; order: number; status: string }
export interface ConvertRow {
  id: string;
  cueId: string;
  objectId: string;
  position: CVec | null;
  rotation: CEuler | null;
  scale?: unknown;
  visible?: unknown;
  customProps?: unknown;
}

export interface ConversionPlan {
  /** 每個 cue 要存的機關位置 */
  positions: { cueId: string; value: number }[];
  /** 改物件在這個 cue 自己存的位置 */
  rowUpdates: { rowId: string; cueId: string; objectId: string; position: CVec; rotation: CEuler }[];
  /** 在這個 cue 補一筆物件位置（本來是沿用前面的） */
  rowInserts: { cueId: string; objectId: string; position: CVec; rotation: CEuler; scale: unknown; visible: unknown; customProps: unknown }[];
  /** 轉成機關位置的 cue（機關不在預設位置的） */
  converted: string[];
  /** 沒轉的 cue：inconsistent = 物件動法不一致；range = 轉出來超出行程 */
  skipped: { cueId: string; reason: 'inconsistent' | 'range' }[];
}

export interface ConvertInput {
  mechanism: ConvertMechanism;
  /** 機關帶的物件（第一個 = 參考物件） */
  objects: ConvertObject[];
  /** 整個專案的 cue（任何順序；每首歌各自照 order 排） */
  cues: ConvertCue[];
  /** 這些物件在各 cue 自己存的位置 */
  rows: ConvertRow[];
  scaleCorrection: number;
}

/** 1 mm / 0.1° 以內算一樣 */
export const CONVERT_TOLERANCE = { meters: 0.001, degrees: 0.1 };

// ── 小小的四元數（跟 three.js 同一套公式；Euler 順序 XYZ = pitch / yaw / roll） ──
type Q = [number, number, number, number];  // x y z w
const D2R = Math.PI / 180;

export function quatFromEuler(e: CEuler): Q {
  const c1 = Math.cos(e.pitch * D2R / 2), c2 = Math.cos(e.yaw * D2R / 2), c3 = Math.cos(e.roll * D2R / 2);
  const s1 = Math.sin(e.pitch * D2R / 2), s2 = Math.sin(e.yaw * D2R / 2), s3 = Math.sin(e.roll * D2R / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

export function eulerFromQuat(q: Q): CEuler {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const yaw = Math.asin(Math.max(-1, Math.min(1, m13)));
  let pitch: number, roll: number;
  if (Math.abs(m13) < 0.9999999) { pitch = Math.atan2(-m23, m33); roll = Math.atan2(-m12, m11); }
  else { pitch = Math.atan2(m32, m22); roll = 0; }
  return { pitch: pitch / D2R, yaw: yaw / D2R, roll: roll / D2R };
}

function qmul(a: Q, b: Q): Q {
  return [
    a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
    a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
    a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qinv = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
function qAxisAngle(a: CVec, deg: number): Q {
  const h = deg * D2R / 2, s = Math.sin(h);
  return [a.x * s, a.y * s, a.z * s, Math.cos(h)];
}
function qrot(q: Q, v: CVec): CVec {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v.z - qz * v.y), ty = 2 * (qz * v.x - qx * v.z), tz = 2 * (qx * v.y - qy * v.x);
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}
const qsame = (a: Q, b: Q) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) > 1 - 1e-10;

function unit(v: CVec): CVec {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** q 繞著 axis 轉了幾度（扭轉角，-180 ~ 180） */
export function twistDegrees(q: Q, axis: CVec): number {
  const a = unit(axis);
  const d = q[0] * a.x + q[1] * a.y + q[2] * a.z;
  let ang = 2 * Math.atan2(d, q[3]) / D2R;
  while (ang > 180) ang -= 360;
  while (ang <= -180) ang += 360;
  return Math.abs(ang) < 1e-9 ? 0 : ang;
}

const r6 = (n: number) => { const v = Math.round(n * 1e6) / 1e6; return Object.is(v, -0) ? 0 : v; };
const r4 = (n: number) => { const v = Math.round(n * 1e4) / 1e4; return Object.is(v, -0) ? 0 : v; };
const roundVec = (v: CVec): CVec => ({ x: r6(v.x), y: r6(v.y), z: r6(v.z) });
const roundEuler = (e: CEuler): CEuler => ({ pitch: r4(e.pitch), yaw: r4(e.yaw), roll: r4(e.roll) });

interface Pose { position: CVec; rotation: CEuler; q: Q }
interface SourceRow { position: CVec | null; rotation: CEuler | null; scale: unknown; visible: unknown }

export function planCueConversion(input: ConvertInput): ConversionPlan {
  const { mechanism: m, objects, scaleCorrection } = input;
  const plan: ConversionPlan = { positions: [], rowUpdates: [], rowInserts: [], converted: [], skipped: [] };
  if (!objects.length) return plan;
  const sc = scaleCorrection > 0 && Number.isFinite(scaleCorrection) ? scaleCorrection : 1;
  const axis = unit(m.axis);
  const pivot = m.pivot ?? { x: 0, y: 0, z: 0 };
  const tol = m.kind === 'rotary' ? CONVERT_TOLERANCE.degrees : CONVERT_TOLERANCE.meters;
  const objIds = new Set(objects.map(o => o.id));

  const rowsByCue = new Map<string, Map<string, ConvertRow>>();
  for (const r of input.rows) {
    if (!objIds.has(r.objectId)) continue;
    let mm = rowsByCue.get(r.cueId);
    if (!mm) { mm = new Map(); rowsByCue.set(r.cueId, mm); }
    mm.set(r.objectId, r);
  }

  /** 物件離預設位置差多少（直線：公尺；旋轉：度） */
  const component = (o: ConvertObject, pose: Pose): number => {
    if (m.kind === 'linear') {
      const d = { x: pose.position.x - o.defaultPosition.x, y: pose.position.y - o.defaultPosition.y, z: pose.position.z - o.defaultPosition.z };
      return (d.x * axis.x + d.y * axis.y + d.z * axis.z) * sc;
    }
    return twistDegrees(qmul(pose.q, qinv(quatFromEuler(o.defaultRotation))), axis);
  };
  /** 畫面位置倒回機關多走的 s → cue 位置 */
  const unapply = (pose: Pose, s: number): Pose => {
    if (s === 0) return pose;
    if (m.kind === 'linear') {
      const k = s / sc;
      return { position: { x: pose.position.x - axis.x * k, y: pose.position.y - axis.y * k, z: pose.position.z - axis.z * k }, rotation: pose.rotation, q: pose.q };
    }
    const qi = qAxisAngle(axis, -s);
    const rel = qrot(qi, { x: pose.position.x - pivot.x, y: pose.position.y - pivot.y, z: pose.position.z - pivot.z });
    const q = qmul(qi, pose.q);
    return { position: { x: pivot.x + rel.x, y: pivot.y + rel.y, z: pivot.z + rel.z }, rotation: eulerFromQuat(q), q };
  };
  const poseOf = (o: ConvertObject, own: SourceRow | null | undefined, inherited: SourceRow | null | undefined): Pose => {
    const position = own?.position ?? inherited?.position ?? o.defaultPosition;
    const rotation = own?.rotation ?? inherited?.rotation ?? o.defaultRotation;
    return { position, rotation, q: quatFromEuler(rotation) };
  };
  const samePose = (a: Pose, b: Pose) =>
    Math.abs(a.position.x - b.position.x) < 1e-6 && Math.abs(a.position.y - b.position.y) < 1e-6 &&
    Math.abs(a.position.z - b.position.z) < 1e-6 && qsame(a.q, b.q);

  // 每首歌各自照順序走
  const bySong = new Map<string, ConvertCue[]>();
  input.cues.forEach(c => { const l = bySong.get(c.songId) || []; l.push(c); bySong.set(c.songId, l); });
  const valueByCue = new Map<string, number>();

  for (const list of bySong.values()) {
    const cues = list.map((c, i) => ({ c, i })).sort((a, b) => (a.c.order - b.c.order) || (a.i - b.i)).map(x => x.c);
    const preLatest = new Map<string, SourceRow>();   // 原本的資料：每個物件最近一筆
    const postLatest = new Map<string, SourceRow>();  // 轉完之後的
    let gi = 0;
    while (gi < cues.length) {
      // 順序一樣的 cue 一起算（它們彼此不沿用）
      let gj = gi;
      while (gj < cues.length && cues[gj].order === cues[gi].order) gj++;
      const group = cues.slice(gi, gj);
      const preAdds: [string, SourceRow][] = [];
      const postAdds: [string, SourceRow][] = [];
      for (const cue of group) {
        const own = rowsByCue.get(cue.id) || new Map<string, ConvertRow>();
        const poses = objects.map(o => poseOf(o, own.get(o.id), preLatest.get(o.id)));
        const comps = objects.map((o, k) => component(o, poses[k]));
        const s0 = comps[0];
        const consistent = comps.every(c => Math.abs(c - s0) <= tol);
        const value = m.defaultValue + s0;
        const inRange = value >= m.travelMin - 1e-9 && value <= m.travelMax + 1e-9;
        const moved = Math.abs(s0) > tol;
        let s = 0;
        if (!consistent) plan.skipped.push({ cueId: cue.id, reason: 'inconsistent' });
        else if (moved && !inRange) plan.skipped.push({ cueId: cue.id, reason: 'range' });
        else if (moved) {
          s = s0;
          // 只算參考物件自己在這個 cue 有存位置的（沿用前面的不重複算）
          if (own.has(objects[0].id)) plan.converted.push(cue.id);
        }
        valueByCue.set(cue.id, s === 0 ? m.defaultValue : r6(m.defaultValue + s));

        objects.forEach((o, k) => {
          const need = unapply(poses[k], s);
          const row = own.get(o.id);
          const outPos = roundVec(need.position);
          const outRot = roundEuler(need.rotation);
          if (row) {
            // 轉完這一筆在畫面上的樣子（空的欄位沿用前面轉完的）跟需要的不一樣 → 改這一筆（兩個欄位都寫清楚）
            const after = poseOf(o, row, postLatest.get(o.id));
            if (!samePose(after, need)) {
              plan.rowUpdates.push({ rowId: row.id, cueId: cue.id, objectId: o.id, position: outPos, rotation: outRot });
              postAdds.push([o.id, { position: outPos, rotation: outRot, scale: row.scale, visible: row.visible }]);
            } else {
              postAdds.push([o.id, { position: row.position, rotation: row.rotation, scale: row.scale, visible: row.visible }]);
            }
            preAdds.push([o.id, { position: row.position, rotation: row.rotation, scale: row.scale, visible: row.visible }]);
          } else {
            const inh = postLatest.get(o.id);
            if (!samePose(poseOf(o, null, inh), need)) {
              plan.rowInserts.push({
                cueId: cue.id, objectId: o.id, position: outPos, rotation: outRot,
                scale: inh?.scale ?? null, visible: inh?.visible ?? 1, customProps: null,
              });
              postAdds.push([o.id, { position: outPos, rotation: outRot, scale: inh?.scale ?? null, visible: inh?.visible ?? 1 }]);
            }
          }
        });
      }
      for (const [id, r] of preAdds) preLatest.set(id, r);
      for (const [id, r] of postAdds) postLatest.set(id, r);
      gi = gj;
    }

    // 機關位置：跟沿用的值（只有正式 cue 往後傳）不一樣才存
    let last = m.defaultValue;
    const masters: { order: number; value: number }[] = [];
    for (const cue of cues) {
      if (cue.status !== 'master') continue;
      const v = valueByCue.get(cue.id)!;
      if (Math.abs(v - last) > 1e-9) plan.positions.push({ cueId: cue.id, value: v });
      last = v;
      masters.push({ order: cue.order, value: v });
    }
    for (const cue of cues) {
      if (cue.status === 'master') continue;
      let base = m.defaultValue;
      for (const x of masters) { if (x.order < cue.order) base = x.value; else break; }
      const v = valueByCue.get(cue.id)!;
      if (Math.abs(v - base) > 1e-9) plan.positions.push({ cueId: cue.id, value: v });
    }
  }
  return plan;
}
