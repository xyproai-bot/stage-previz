// 還沒有影片、LED 只顯示測試圖時也照版型：版型放了的螢幕照原本位置顯示測試圖，沒放的螢幕黑掉（像沒通電）
// 測試圖本來就是整張 UV 畫布，不用搬位置，只借版型的「哪些螢幕有放」→ 每塊的目的地 = 自己原本的範圍、不轉不翻
// （以前測試圖不管版型、整個舞台全亮，選了「Main LED」地板還是有畫面）

import { MAX_SCREENS_PER_OBJECT, type LedTemplatePlan, type Placement, type SrcSpan, type TemplateUniformData } from '../ledTemplate';
import type { UvRect } from './ledEmitters';

export function buildCoverageUniforms(
  plan: LedTemplatePlan, objectId: string, srcFor: (p: Placement) => SrcSpan | null,
): TemplateUniformData {
  const src: number[] = [], dst: number[] = [], mat: number[] = [], off: number[] = [];
  let count = 0;
  for (const p of plan.screens) {
    if (p.objectId !== objectId || count >= MAX_SCREENS_PER_OBJECT) continue;
    const s = srcFor(p);
    if (!s) continue;
    src.push(s.us, s.vs, s.ul, s.vl);
    dst.push(s.us, s.vs, s.us + s.ul, s.vs + s.vl);
    mat.push(1, 0, 0, 1);
    off.push(0, 0);
    count++;
  }
  const pad = (arr: number[], n: number) => { while (arr.length < n) arr.push(0); return arr; };
  return {
    count,
    src: pad(src, MAX_SCREENS_PER_OBJECT * 4),
    dst: pad(dst, MAX_SCREENS_PER_OBJECT * 4),
    mat: pad(mat, MAX_SCREENS_PER_OBJECT * 4),
    off: pad(off, MAX_SCREENS_PER_OBJECT * 2),
    half: [0, 0],
  };
}

// UV 落在這塊螢幕範圍裡（跟 shader 一樣處理繞一圈的 UV）
const inSpan = (s: SrcSpan, u: number, v: number): boolean => {
  let du = u - s.us; du -= Math.floor(du + 1e-5);
  let dv = v - s.vs; dv -= Math.floor(dv + 1e-5);
  return du <= s.ul + 1e-5 && dv <= s.vl + 1e-5;
};

/** 燈光取色：這一小塊在版型放了的螢幕上 = 原位置取色；沒放 = null（黑的、不打光） */
export function coverageRemap(
  plan: LedTemplatePlan, objectId: string, srcFor: (p: Placement) => SrcSpan | null,
): (r: UvRect) => UvRect | null {
  const spans = plan.screens
    .filter(p => p.objectId === objectId)
    .map(srcFor)
    .filter((s): s is SrcSpan => !!s);
  return (r) => (spans.some(s => inSpan(s, (r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2)) ? r : null);
}
