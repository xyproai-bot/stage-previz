// 一個物件裡三塊 LED（曲線升降：_L / _正面 / _R，UV 分開）走每個「下載 LED 圖」的入口，每塊都要各自一格、名稱是自己的。
// 結構跟真實專案一樣：
//   - 原專案：螢幕代號 o:物件id~mesh名稱（從模型的 mesh 拆）
//   - 試用專案：自動貼 UV 套用後切成手動螢幕 s:螢幕id（led_screens），編輯器的「下載每塊 LED 的圖」以前畫成整座一塊
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildLedLayout, type CanvasSize, type LedLayout } from './ledMap';
import { ledPanelInputs } from './ledMapScene';
import { ledScreenParts } from './ledScreen';
import { buildScreenList, manualKey, partKey, placementsFromInputs, spanFromAxes, usableParts, type LedTemplatePlan, type ManualScreen, type ScreenDef } from './ledTemplate';
import { layoutFromSpans } from './ledTemplateContent';
import { guideContentFor } from './ledTemplateDownload';
import { tilesOf } from './ledTemplateTiles';
import { layoutPanel } from './ledMap';
import { collectUvTriangles } from './ledMapScene';

const FULL: CanvasSize = { width: 11648, height: 3328 };
const LIFT = '曲線升降-6';
// 三塊在整張畫布上的像素範圍（跟真實資料一樣）
const PIECES = [
  { name: `${LIFT}_L`, x: 9472, w: 384 },
  { name: `${LIFT}_正面`, x: 9856, w: 1152 },
  { name: `${LIFT}_R`, x: 11008, w: 640 },
];
const Y = 2816, H = 512;

function quad(x: number, w: number, matName: string, name: string): THREE.Mesh {
  const u0 = x / FULL.width, u1 = (x + w) / FULL.width, v0 = Y / FULL.height, v1 = (Y + H) / FULL.height;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1], 2));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ name: matName }));
  m.name = name;
  return m;
}

function liftObject(): THREE.Object3D {
  const root = new THREE.Group();
  root.name = LIFT;
  for (const p of PIECES) root.add(quad(p.x, p.w, 'LED_Screen', p.name));
  root.add(quad(0, 10, 'Metal_Frame', `${LIFT}_台體`));   // 台體：不是螢幕
  return root;
}

const root = liftObject();
const OBJ = { id: 'so_lift6', name: LIFT, order: 20 };

// StageScene 的 ledObjectSpan / ledObjectParts 同一套
const spanOf = (r: THREE.Object3D) => {
  const l = layoutPanel({ id: 's', name: 's', tris: collectUvTriangles(r) }, { width: 1, height: 1 }, 0);
  return l ? spanFromAxes(l.u, l.v) : null;
};
const partsOf = (r: THREE.Object3D) => usableParts(ledScreenParts(r, r.name).map(p => {
  const l = layoutPanel({ id: 's', name: p.name, tris: collectUvTriangles(r, new Set(p.meshes)) }, { width: 1, height: 1 }, 0);
  return { name: p.name, src: l ? spanFromAxes(l.u, l.v) : null };
}));

const objSpan = spanOf(root)!;
const parts = partsOf(root);
const MANUALS: ManualScreen[] = PIECES.map((p, i) => ({
  id: `ls_${i}`, objectId: OBJ.id, name: p.name,
  uv: [p.x / FULL.width, Y / FULL.height, (p.x + p.w) / FULL.width, (Y + H) / FULL.height],
}));

function planFor(keys: string[], manuals: ManualScreen[]): LedTemplatePlan {
  return {
    v: 1, id: 't', name: '版型', canvas: FULL, scalePct: 100, cabinet: null,
    screens: placementsFromInputs(keys.map((key, i) => ({ key, dest: { x: PIECES[i].x, y: Y, w: PIECES[i].w, h: H }, rotate: 0, flipH: false, flipV: false })), manuals),
  };
}

const rows = (l: LedLayout) => l.panels.map(p => [p.name, p.rect.x, p.rect.y, p.rect.w, p.rect.h]);
const EXPECT = PIECES.map(p => [p.name, p.x, Y, p.w, H]);

/** 每張 tile 上畫到的格子（tile 範圍裡面的格子）= 只有自己那一塊 */
function tileContents(plan: LedTemplatePlan, defs: ScreenDef[], layout: LedLayout | null) {
  const content = guideContentFor(defs, { fullCanvas: FULL, layout }, plan)!;
  const { tiles } = tilesOf(plan, defs);
  return tiles.map(t => {
    const s = content.spanOf(t.key)!;
    const x0 = s.us * FULL.width, x1 = (s.us + s.ul) * FULL.width;
    const hit = content.layout.panels.filter(p => p.rect.x < x1 - 1 && p.rect.x + p.rect.w > x0 + 1);
    return [t.fileName, hit.map(h => h.name)];
  });
}

describe('曲線升降（一個物件三塊 LED）每個下載入口都拆成 _L / _正面 / _R', () => {
  it('模型讀得出三塊（台體不算）', () => {
    expect(parts.map(p => p.name).sort()).toEqual(PIECES.map(p => p.name).sort());
  });

  it('3D「⋯」整張畫布 / 「全部」/ 3D 測試圖（ledPanelInputs + buildLedLayout）', () => {
    const lay = buildLedLayout(ledPanelInputs([{ ...OBJ, root }], o => (partsOf(o.root).length < 2 ? null : ledScreenParts(o.root, o.root.name))), FULL);
    expect(rows(lay).sort()).toEqual(EXPECT.sort());
  });

  const autos = [{ objectId: OBJ.id, name: OBJ.name, order: OBJ.order, src: objSpan, parts }];
  const cases = [
    { title: '原專案（o:物件id~mesh名稱）', keys: PIECES.map(p => partKey(OBJ.id, p.name)), manuals: [] as ManualScreen[] },
    { title: '試用專案（自動貼 UV 切成手動螢幕 s:）', keys: MANUALS.map(m => manualKey(m.id)), manuals: MANUALS },
  ];
  for (const c of cases) {
    const defs = buildScreenList(autos, c.manuals, FULL);
    const plan = planFor(c.keys, c.manuals);
    it(`${c.title}：螢幕清單三塊`, () => {
      expect(defs.map(d => d.name).sort()).toEqual(PIECES.map(p => p.name).sort());
    });
    it(`${c.title}：版型編輯器「下載每塊 LED 的圖」/ 模板圖 / 版型畫面（整張畫布排法從物件範圍來）`, () => {
      const objLayout = layoutFromSpans([OBJ], { [OBJ.id]: objSpan }, FULL);
      expect(rows(objLayout)).toEqual([[LIFT, 9472, Y, 2176, H]]);   // 物件範圍 = 整座（截圖裡的那個）
      const content = guideContentFor(defs, { fullCanvas: FULL, layout: objLayout }, plan)!;
      expect(rows(content.layout).sort()).toEqual(EXPECT.sort());
      for (const [file, names] of tileContents(plan, defs, objLayout)) expect(names, String(file)).toEqual([String(file).replace(/\.png$/, '')]);
    });
    it(`${c.title}：3D「⋯」→ 這首歌的版型 / 中途換版型（沒有物件範圍，用螢幕清單排）`, () => {
      const content = guideContentFor(defs, { fullCanvas: FULL }, plan)!;
      expect(rows(content.layout).sort()).toEqual(EXPECT.sort());
      for (const [file, names] of tileContents(plan, defs, null)) expect(names, String(file)).toEqual([String(file).replace(/\.png$/, '')]);
    });
  }
});
