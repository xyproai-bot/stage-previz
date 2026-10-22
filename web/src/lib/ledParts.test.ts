// 一個物件裡有好幾塊 LED mesh：版型裡每一塊是獨立的螢幕（key = o:<物件 id>~<mesh 名稱>）；3D 裡還是同一個物件
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ledScreenParts, partNames } from './ledScreen';
import { collectUvTriangles } from './ledMapScene';
import { layoutPanel } from './ledMap';
import {
  buildObjectUniforms, buildScreenList, mapObjectUv, normalizePlacementInputs, parsePlan, parseScreenKey, partKey, placementsFromInputs,
  spanFromAxes, spanOverlapRatio, usableParts, type LedTemplatePlan, type Placement, type SrcSpan,
} from './ledTemplate';

function plane(name: string, matName: string, uv: [number, number, number, number]): THREE.Mesh {
  const g = new THREE.PlaneGeometry(2, 1);
  const [u0, v0, u1, v1] = uv;
  const a = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXY(i, u0 + a.getX(i) * (u1 - u0), v0 + a.getY(i) * (v1 - v0));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ name: matName }));
  m.name = name;
  return m;
}

/** 曲線升降台：台體（金屬）+ 三塊 LED，各自的 UV 在畫布上不同的位置 */
function lift(): THREE.Group {
  const root = new THREE.Group();
  root.name = '曲線升降-1';
  root.add(plane('曲線升降-1_台體', '升降台_金屬', [0, 0, 1, 1]));
  root.add(plane('曲線升降-1_正面', 'LED_front', [0, 0, 0.5, 0.25]));
  root.add(plane('曲線升降-1_左側', 'LED_left', [0.5, 0, 0.75, 0.25]));
  root.add(plane('曲線升降-1_右側', 'LED_right', [0.75, 0, 1, 0.25]));
  return root;
}

const spanOf = (root: THREE.Object3D, meshes?: Set<THREE.Mesh>): SrcSpan => {
  const lay = layoutPanel({ id: 'x', name: 'x', tris: collectUvTriangles(root, meshes) }, { width: 1, height: 1 }, 0)!;
  return spanFromAxes(lay.u, lay.v);
};

describe('ledScreenParts（3D 場景裡 LED 物件分成幾塊）', () => {
  it('台體 + 三塊 LED → 三塊，名稱是 mesh 名稱，台體不算', () => {
    const parts = ledScreenParts(lift());
    expect(parts.map(p => p.name)).toEqual(['曲線升降-1_正面', '曲線升降-1_左側', '曲線升降-1_右側']);
  });
  it('只有一塊 LED（加台體）→ 不拆', () => {
    const root = new THREE.Group();
    root.add(plane('台體', '金屬', [0, 0, 1, 1]));
    root.add(plane('正面', 'LED_front', [0, 0, 1, 1]));
    expect(ledScreenParts(root)).toEqual([]);
  });
  it('整個物件都當螢幕（材質名稱沒有 LED 的舊模型）→ 不拆，跟以前一樣', () => {
    const root = new THREE.Group();
    root.add(plane('a', 'Screen', [0, 0, 0.5, 1]));
    root.add(plane('b', 'Screen', [0.5, 0, 1, 1]));
    expect(ledScreenParts(root)).toEqual([]);
  });
  it('多個 primitive 的 mesh（three 變成 Group 底下好幾個 Mesh）算同一塊', () => {
    const root = new THREE.Group();
    const two = new THREE.Group();
    two.name = '雙材質面';
    two.add(plane('雙材質面', 'LED_a', [0, 0, 0.25, 1]), plane('雙材質面', 'LED_b', [0.25, 0, 0.5, 1]));
    root.add(two, plane('另一塊', 'LED_c', [0.5, 0, 1, 1]));
    const parts = ledScreenParts(root);
    expect(parts.map(p => [p.name, p.meshes.length])).toEqual([['雙材質面', 2], ['另一塊', 1]]);
  });
  it('超過 8 塊不拆', () => {
    const root = new THREE.Group();
    for (let i = 0; i < 9; i++) root.add(plane(`p${i}`, 'LED_x', [i / 9, 0, (i + 1) / 9, 1]));
    expect(ledScreenParts(root)).toEqual([]);
  });
  it('同名的 mesh 後面加 2、3；沒有名字叫「物件名 序號」', () => {
    expect(partNames(['面', '面', '', undefined, '面'], '升降')).toEqual(['面', '面 2', '升降 3', '升降 4', '面 3']);
  });
  it('每一塊的 UV 範圍是自己那個 mesh 的，不是整個物件的', () => {
    const root = lift();
    const parts = ledScreenParts(root);
    const spans = parts.map(p => spanOf(root, new Set(p.meshes)));
    expect(spans[0]).toMatchObject({ us: 0, ul: 0.5, vs: 0, vl: 0.25 });
    expect(spans[1].us).toBeCloseTo(0.5);
    expect(spans[2].us).toBeCloseTo(0.75);
    // 整個物件的範圍照舊只算 LED（不含台體）
    expect(spanOf(root)).toMatchObject({ us: 0, ul: 1 });
  });
});

describe('usableParts / 範圍重疊', () => {
  const a: SrcSpan = { us: 0, ul: 0.5, vs: 0, vl: 0.5 };
  const b: SrcSpan = { us: 0.5, ul: 0.5, vs: 0, vl: 0.5 };
  it('分得開 → 全部留下', () => {
    expect(usableParts([{ name: 'a', src: a }, { name: 'b', src: b }]).map(p => p.name)).toEqual(['a', 'b']);
  });
  it('擠在同一塊 UV（重疊）→ 不拆', () => {
    expect(spanOverlapRatio(a, a)).toBeCloseTo(1);
    expect(usableParts([{ name: 'a', src: a }, { name: 'b', src: a }])).toEqual([]);
  });
  it('跨畫布邊緣的範圍也算得出重疊', () => {
    const wrap: SrcSpan = { us: 0.9, ul: 0.2, vs: 0, vl: 0.5 };
    expect(spanOverlapRatio(wrap, { us: 0, ul: 0.05, vs: 0, vl: 0.5 })).toBeCloseTo(1);
    expect(spanOverlapRatio(wrap, { us: 0.3, ul: 0.1, vs: 0, vl: 0.5 })).toBe(0);
  });
  it('有一塊沒有 UV / 只有一塊 / 超過 8 塊 → 不拆', () => {
    expect(usableParts([{ name: 'a', src: a }, { name: 'b', src: null }])).toEqual([]);
    expect(usableParts([{ name: 'a', src: a }])).toEqual([]);
  });
});

describe('版型的螢幕清單：物件裡每個 LED mesh 一塊', () => {
  const full = { width: 4000, height: 2000 };
  const parts = [
    { name: '曲線升降-1_正面', src: { us: 0, ul: 0.5, vs: 0, vl: 0.25 } },
    { name: '曲線升降-1_左側', src: { us: 0.5, ul: 0.25, vs: 0, vl: 0.25 } },
    { name: '曲線升降-1_右側', src: { us: 0.75, ul: 0.25, vs: 0, vl: 0.25 } },
  ];
  const autos = [
    { objectId: 'so_a', name: '主牆', order: 0, src: { us: 0, ul: 1, vs: 0.5, vl: 0.5 } },
    { objectId: 'so_lift', name: '曲線升降-1', order: 1, src: { us: 0, ul: 1, vs: 0, vl: 0.25 }, parts },
  ];

  it('清單：沒拆的物件一塊，拆開的物件變三塊，名稱是 mesh 名稱', () => {
    const list = buildScreenList(autos, [], full);
    expect(list.map(s => s.key)).toEqual(['o:so_a', 'o:so_lift~曲線升降-1_正面', 'o:so_lift~曲線升降-1_左側', 'o:so_lift~曲線升降-1_右側']);
    expect(list.map(s => s.name)).toEqual(['主牆', '曲線升降-1_正面', '曲線升降-1_左側', '曲線升降-1_右側']);
    expect(list[1].objectId).toBe('so_lift');
    expect(list[1]).toMatchObject({ nativeW: 2000, nativeH: 500, manual: false, uv: null });
  });
  it('沒有 parts（或只有一塊）= 跟以前一模一樣', () => {
    const plain = autos.map(a => ({ ...a, parts: undefined }));
    expect(buildScreenList(plain, [], full).map(s => s.key)).toEqual(['o:so_a', 'o:so_lift']);
    expect(buildScreenList([{ ...autos[1], parts: [parts[0]] }], [], full).map(s => s.key)).toEqual(['o:so_lift']);
  });
  it('舊版型用的 o:<物件 id> 還在用 → 也留在清單裡（舊資料照讀）', () => {
    const list = buildScreenList(autos, [], full, new Set(['o:so_lift']));
    expect(list.map(s => s.key)).toContain('o:so_lift');
    expect(list.map(s => s.key)).toHaveLength(5);
  });
  it('手動切過的物件：照舊只列手動切的', () => {
    const manuals = [{ id: 'm1', objectId: 'so_lift', name: '手切', uv: [0, 0, 0.5, 0.25] as [number, number, number, number] }];
    expect(buildScreenList(autos, manuals, full).map(s => s.key)).toEqual(['o:so_a', 's:m1']);
  });
});

describe('螢幕代號 o:<物件 id>~<mesh 名稱>', () => {
  it('讀得懂新的，舊的 o:<id> 照舊', () => {
    expect(parseScreenKey('o:so_lift~曲線升降-1_正面')).toEqual({ kind: 'object', id: 'so_lift', part: '曲線升降-1_正面' });
    expect(parseScreenKey('o:so_lift')).toEqual({ kind: 'object', id: 'so_lift' });
    expect(parseScreenKey('s:abc')).toEqual({ kind: 'manual', id: 'abc' });
  });
  it('不合格的：手動螢幕不能有名稱、空名稱、控制字元、太長', () => {
    expect(parseScreenKey('s:abc~x')).toBeNull();
    expect(parseScreenKey('o:so~')).toBeNull();
    expect(parseScreenKey('o:so~a\nb')).toBeNull();
    expect(parseScreenKey(`o:so~${'a'.repeat(81)}`)).toBeNull();
    expect(parseScreenKey(`o:so~${'字'.repeat(80)}`)).not.toBeNull();
  });
  it('後台存 / 讀版型：新的 key 通過檢查、放法補得出 objectId', () => {
    const k = partKey('so_lift', '曲線升降-1_左側');
    const r = normalizePlacementInputs([{ key: k, dest: { x: 0, y: 0, w: 100, h: 50 }, rotate: 0, flipH: false, flipV: false }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pl = placementsFromInputs(r.value, []);
    expect(pl).toHaveLength(1);
    expect(pl[0]).toMatchObject({ key: k, objectId: 'so_lift', uv: null });
  });
  it('快照 parsePlan：新的 key 讀得回來；舊的 o:<id> 也是', () => {
    const plan = parsePlan({
      v: 1, canvas: { width: 1000, height: 500 }, name: 't', scalePct: 100,
      screens: [
        { key: 'o:so_lift~左', objectId: 'so_lift', dest: { x: 0, y: 0, w: 10, h: 10 } },
        { key: 'o:so_old', dest: { x: 10, y: 0, w: 10, h: 10 } },
      ],
    });
    expect(plan!.screens.map(s => [s.key, s.objectId])).toEqual([['o:so_lift~左', 'so_lift'], ['o:so_old', 'so_old']]);
  });
});

describe('每一塊 LED 畫面貼到自己那塊版型的位置', () => {
  const plan: LedTemplatePlan = {
    v: 1, id: 't', name: 't', canvas: { width: 1000, height: 1000 }, scalePct: 100,
    screens: [
      { key: 'o:so_lift~正面', objectId: 'so_lift', uv: null, dest: { x: 0, y: 0, w: 500, h: 500 }, rotate: 0, flipH: false, flipV: false },
      { key: 'o:so_lift~左側', objectId: 'so_lift', uv: null, dest: { x: 500, y: 500, w: 500, h: 500 }, rotate: 0, flipH: false, flipV: false },
    ],
  };
  const spans: Record<string, SrcSpan> = {
    正面: { us: 0, ul: 0.5, vs: 0, vl: 0.25 },
    左側: { us: 0.5, ul: 0.25, vs: 0, vl: 0.25 },
  };
  const srcFor = (p: Placement): SrcSpan | null => spans[parseScreenKey(p.key)!.part!] ?? null;

  it('正面的點貼到左上、左側的點貼到右下、右側（沒放進版型）是黑的', () => {
    const f = mapObjectUv(plan, 'so_lift', srcFor, 0.25, 0.125)!;
    expect(f[0]).toBeCloseTo(0.25, 2); expect(f[1]).toBeCloseTo(0.25, 2);
    const l = mapObjectUv(plan, 'so_lift', srcFor, 0.625, 0.125)!;
    expect(l[0]).toBeCloseTo(0.75, 2); expect(l[1]).toBeCloseTo(0.75, 2);
    expect(mapObjectUv(plan, 'so_lift', srcFor, 0.9, 0.1)).toBeNull();
  });
  it('shader 資料：這個物件有兩塊，各自的範圍和目的地', () => {
    const d = buildObjectUniforms(plan, 'so_lift', srcFor);
    expect(d.count).toBe(2);
    expect(d.src.slice(0, 8)).toEqual([0, 0, 0.5, 0.25, 0.5, 0, 0.25, 0.25]);
    expect(d.dst.slice(0, 8)).toEqual([0, 0, 0.5, 0.5, 0.5, 0.5, 1, 1]);
  });
});
