import { describe, it, expect } from 'vitest';
import {
  applyLocalTransform, buildObjectUniforms, buildScreenList, checkPlacements, compareVideoToTemplate, defaultDestSize, localTransform,
  mapObjectUv, mapUvRectToTemplate, mapUvToTemplate, nativeSize, normalizeManualScreenInput, normalizePlacementInputs, normalizeTemplateInput,
  normalizeTemplateName, parsePlan, parseScreenKey, placementsFromInputs, spanFromAxes, spanFromUv, templateVideoNote, uvToLocal,
  versionTemplateLabel, MAX_SCREENS_PER_OBJECT,
  type LedTemplatePlan, type Placement, type Rotation, type SrcSpan,
} from './ledTemplate';

const close = (a: number, b: number, d = 6) => expect(a).toBeCloseTo(b, d);
const plc = (over: Partial<Placement> = {}): Placement => ({
  key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 100, h: 50 }, rotate: 0, flipH: false, flipV: false, ...over,
});
const plan = (screens: Placement[], over: Partial<LedTemplatePlan> = {}): LedTemplatePlan => ({
  v: 1, id: 't', name: '中間底幕', canvas: { width: 200, height: 100 }, scalePct: 100, screens, ...over,
});
const FULL = { width: 8800, height: 2024 };

describe('localTransform：先順時針轉、再在目的地裡翻', () => {
  // 單位正方形的四個角（左上、右上、右下、左下）轉完會去哪（y 朝下）
  const corners: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const run = (rot: Rotation, fh = false, fv = false) => corners.map(([x, y]) => applyLocalTransform(localTransform(rot, fh, fv), x, y));

  it('0 度：不動', () => {
    expect(run(0)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });
  it('90 度順時針：左上角跑到右上角，右上角跑到右下角', () => {
    expect(run(90)).toEqual([[1, 0], [1, 1], [0, 1], [0, 0]]);
  });
  it('180 度：左上角跑到右下角', () => {
    expect(run(180)).toEqual([[1, 1], [0, 1], [0, 0], [1, 0]]);
  });
  it('270 度（= 逆時針 90 度）：左上角跑到左下角', () => {
    expect(run(270)).toEqual([[0, 1], [0, 0], [1, 0], [1, 1]]);
  });
  it('左右翻：左上角跑到右上角；上下翻：左上角跑到左下角', () => {
    expect(run(0, true, false)[0]).toEqual([1, 0]);
    expect(run(0, false, true)[0]).toEqual([0, 1]);
    expect(run(0, true, true)[0]).toEqual([1, 1]);
  });
  it('轉完再翻：90 度 + 左右翻 → 左上角 (1,0) 再左右翻 = (0,0)', () => {
    expect(run(90, true, false)[0]).toEqual([0, 0]);
    // 跟「先左右翻再轉」不一樣（順序有定義）
    expect(run(90, false, true)[0]).toEqual([1, 1]);
  });
  it('八種方向的矩陣都是可逆的 0/±1 排列（沒有縮放）', () => {
    for (const rot of [0, 90, 180, 270] as Rotation[]) {
      for (const fh of [false, true]) for (const fv of [false, true]) {
        const t = localTransform(rot, fh, fv);
        const det = t.a[0] * t.a[3] - t.a[1] * t.a[2];
        expect(Math.abs(det)).toBe(1);
        // 四個角還是落在單位正方形的四個角
        for (const [x, y] of corners) {
          const [tx, ty] = applyLocalTransform(t, x, y);
          expect([0, 1]).toContain(tx);
          expect([0, 1]).toContain(ty);
        }
      }
    }
  });
});

describe('uvToLocal：螢幕範圍（會繞回、可以跨接縫）', () => {
  it('一般範圍', () => {
    const s: SrcSpan = { us: 0.2, ul: 0.4, vs: 0.1, vl: 0.5 };
    expect(uvToLocal(s, 0.2, 0.1)).toEqual([0, 0]);
    const l = uvToLocal(s, 0.4, 0.35)!;
    close(l[0], 0.5); close(l[1], 0.5);
    expect(uvToLocal(s, 0.7, 0.2)).toBeNull();
    expect(uvToLocal(s, 0.3, 0.7)).toBeNull();
  });
  it('貼圖是繞回的：UV 在 [-0.8, -0.45] 的 LED = [0.2, 0.55]', () => {
    const s: SrcSpan = { us: 0.2, ul: 0.35, vs: 0, vl: 1 };
    const l = uvToLocal(s, -0.8, 0.5)!;
    close(l[0], 0); close(l[1], 0.5);
    const e = uvToLocal(s, -0.45, 0.5)!;
    close(e[0], 1, 4);
    expect(uvToLocal(s, -0.2, 0.5)).toBeNull();
  });
  it('跨 0 / 1 接縫（u 從 0.95 開始、長 0.1）：0.97 和 0.03 都在裡面，0.03 在 0.7 處', () => {
    const s: SrcSpan = { us: 0.95, ul: 0.1, vs: 0, vl: 1 };
    close(uvToLocal(s, 0.97, 0.5)![0], 0.2);
    close(uvToLocal(s, 0.03, 0.5)![0], 0.8);
    expect(uvToLocal(s, 0.5, 0.5)).toBeNull();
  });
  it('邊界上差一點點（浮點誤差）也算在裡面，不會露出一條黑邊', () => {
    const s: SrcSpan = { us: 0.25, ul: 0.5, vs: 0, vl: 1 };
    expect(uvToLocal(s, 0.25 - 1e-7, 0.5)).not.toBeNull();
    expect(uvToLocal(s, 0.75 + 1e-7, 0.5)).not.toBeNull();
    expect(uvToLocal(s, 0.76, 0.5)).toBeNull();
  });
});

describe('mapUvToTemplate：整張畫布 UV → 版型貼圖 UV', () => {
  const span: SrcSpan = { us: 0, ul: 0.5, vs: 0, vl: 1 };       // 左半張
  const canvas = { width: 200, height: 100 };
  it('一對一放在左上角：貼圖 UV = 螢幕本地座標 × 目的地長方形（往裡縮半個像素）', () => {
    const p = plc({ dest: { x: 0, y: 0, w: 100, h: 100 } });
    const m = mapUvToTemplate(p, span, canvas, 0.25, 0.5)!;
    close(m[0], 0.25); close(m[1], 0.5);
    // 左上角：往裡縮半個像素 = 0.5 / 200
    const c = mapUvToTemplate(p, span, canvas, 0, 0)!;
    close(c[0], 0.5 / 200); close(c[1], 0.5 / 100);
  });
  it('放在版型的右下方：位置、大小都照目的地長方形', () => {
    const p = plc({ dest: { x: 100, y: 50, w: 100, h: 50 } });
    const m = mapUvToTemplate(p, span, canvas, 0.25, 0.5)!;
    close(m[0], 150 / 200); close(m[1], 75 / 100);
  });
  it('轉 90 度：螢幕左上角出現在目的地右上角；目的地寬高是轉完的', () => {
    const p = plc({ rotate: 90, dest: { x: 0, y: 0, w: 50, h: 100 } });
    const tl = mapUvToTemplate(p, span, canvas, 0, 0)!;
    close(tl[0], 50 / 200, 1); close(tl[1], 0, 1);
    const br = mapUvToTemplate(p, span, canvas, 0.5, 0.9999)!;
    close(br[0], 0, 1); close(br[1], 1, 1);
  });
  it('左右翻：螢幕左邊跑到目的地右邊', () => {
    const p = plc({ flipH: true, dest: { x: 0, y: 0, w: 100, h: 100 } });
    const l = mapUvToTemplate(p, span, canvas, 0.001, 0.5)!;
    expect(l[0]).toBeGreaterThan(0.45);
  });
  it('不在這塊螢幕裡 = null', () => {
    expect(mapUvToTemplate(plc(), span, canvas, 0.75, 0.5)).toBeNull();
  });
  it('mapObjectUv：同一個物件放了兩塊，找包住這點的那塊；都沒包住 = null（黑的）', () => {
    const left = plc({ key: 's:l', uv: [0, 0, 0.5, 1], dest: { x: 0, y: 0, w: 100, h: 100 } });
    const right = plc({ key: 's:r', uv: [0.5, 0, 1, 1], dest: { x: 100, y: 0, w: 100, h: 100 } });
    const pl = plan([left, right]);
    const srcFor = (p: Placement) => (p.uv ? spanFromUv(p.uv) : null);
    const a = mapObjectUv(pl, 'a', srcFor, 0.25, 0.5)!;
    close(a[0], 0.25);
    const b = mapObjectUv(pl, 'a', srcFor, 0.75, 0.5)!;
    close(b[0], 0.75);
    expect(mapObjectUv(pl, 'nobody', srcFor, 0.25, 0.5)).toBeNull();
    expect(mapObjectUv(plan([left]), 'a', srcFor, 0.75, 0.5)).toBeNull();
  });
  it('縮小的版型（50%）：整塊螢幕鋪滿目的地，UV 範圍正確', () => {
    // 螢幕 = 整張畫布 8800×2024，版型 4400×1012，一塊鋪滿
    const p = plc({ dest: { x: 0, y: 0, w: 4400, h: 1012 } });
    const m = mapUvToTemplate(p, { us: 0, ul: 1, vs: 0, vl: 1 }, { width: 4400, height: 1012 }, 0.5, 0.5)!;
    close(m[0], 0.5); close(m[1], 0.5);
  });
});

describe('mapUvRectToTemplate：燈光取色的長方形跟著換位置', () => {
  const srcFor = (p: Placement) => (p.uv ? spanFromUv(p.uv) : { us: 0, ul: 1, vs: 0, vl: 1 });
  it('整塊螢幕一對一放進版型 → 取色長方形換成目的地那一塊', () => {
    const pl = plan([plc({ dest: { x: 100, y: 0, w: 100, h: 50 } })]);
    const r = mapUvRectToTemplate(pl, 'a', srcFor, { u0: 0, v0: 0, u1: 1, v1: 1 })!;
    expect([r.u0, r.v0, r.u1, r.v1]).toEqual([0.5, 0, 1, 0.5]);
  });
  it('轉 90 度：寬高對調後的外框', () => {
    const pl = plan([plc({ rotate: 90, dest: { x: 0, y: 0, w: 50, h: 100 } })]);
    const r = mapUvRectToTemplate(pl, 'a', srcFor, { u0: 0, v0: 0, u1: 1, v1: 1 })!;
    expect([r.u0, r.v0, r.u1, r.v1]).toEqual([0, 0, 0.25, 1]);
  });
  it('不在版型裡的物件 = null（燈關掉）', () => {
    expect(mapUvRectToTemplate(plan([plc({})]), 'zzz', srcFor, { u0: 0, v0: 0, u1: 1, v1: 1 })).toBeNull();
  });
});

describe('buildObjectUniforms：給 shader 的陣列', () => {
  it('只拿這個物件的螢幕，其餘補 0；轉動 / 翻轉變成矩陣', () => {
    const pl = plan([
      plc({ key: 'o:a', objectId: 'a', rotate: 90, flipH: true, dest: { x: 20, y: 10, w: 40, h: 80 } }),
      plc({ key: 'o:b', objectId: 'b' }),
    ]);
    const u = buildObjectUniforms(pl, 'a', () => ({ us: 0.1, ul: 0.5, vs: 0.2, vl: 0.6 }));
    expect(u.count).toBe(1);
    expect(u.src.slice(0, 4)).toEqual([0.1, 0.2, 0.5, 0.6]);
    expect(u.dst.slice(0, 4)).toEqual([0.1, 0.1, 0.3, 0.9]);
    expect(u.mat.slice(0, 4)).toEqual(localTransform(90, true, false).a);
    expect(u.off.slice(0, 2)).toEqual(localTransform(90, true, false).b);
    expect(u.src.length).toBe(MAX_SCREENS_PER_OBJECT * 4);
    expect(u.off.length).toBe(MAX_SCREENS_PER_OBJECT * 2);
    expect(u.src.slice(4).every(n => n === 0)).toBe(true);
    expect(u.half).toEqual([0.5 / 200, 0.5 / 100]);
    // 沒有放的物件 = 0 塊（整個黑的）
    expect(buildObjectUniforms(pl, 'zzz', () => ({ us: 0, ul: 1, vs: 0, vl: 1 })).count).toBe(0);
  });
  it('一個物件最多 8 塊；範圍算不出來的略過', () => {
    const many = Array.from({ length: 12 }, (_, i) => plc({ key: `s:${i}`, uv: [0, 0, 1, 1] }));
    expect(buildObjectUniforms(plan(many), 'a', () => ({ us: 0, ul: 1, vs: 0, vl: 1 })).count).toBe(8);
    expect(buildObjectUniforms(plan(many), 'a', () => null).count).toBe(0);
  });
});

describe('螢幕清單', () => {
  const autos = [
    { objectId: 'o2', name: '左側幕', order: 1, src: { us: 0, ul: 0.25, vs: 0, vl: 1 } },
    { objectId: 'o1', name: '中間底幕', order: 0, src: { us: 0.25, ul: 0.5, vs: 0.8, vl: 0.2 } },
  ];
  it('每個 LED 物件一塊，照物件順序；真實點數從整張畫布算', () => {
    const list = buildScreenList(autos, [], FULL);
    expect(list.map(s => [s.key, s.name, s.manual])).toEqual([['o:o1', '中間底幕', false], ['o:o2', '左側幕', false]]);
    expect([list[0].nativeW, list[0].nativeH]).toEqual([4400, 405]);
    expect([list[1].nativeW, list[1].nativeH]).toEqual([2200, 2024]);
  });
  it('物件有手動切的螢幕時，只列手動切的（整個物件那一塊不列）', () => {
    const list = buildScreenList(autos, [
      { id: 'm1', objectId: 'o1', name: '中間左', uv: [0.25, 0.8, 0.5, 1] },
      { id: 'm2', objectId: 'o1', name: '中間右', uv: [0.5, 0.8, 0.75, 1] },
    ], FULL);
    expect(list.map(s => s.key)).toEqual(['s:m1', 's:m2', 'o:o2']);
    expect(list[0].manual).toBe(true);
    expect([list[0].nativeW, list[0].nativeH]).toEqual([2200, 405]);
  });
  it('跨接縫的螢幕：範圍用 start + length', () => {
    const src = spanFromAxes({ start: 0.95, length: 0.1, wraps: true }, { start: 0, length: 1, wraps: false });
    const list = buildScreenList([{ objectId: 'w', name: '跨邊', order: 0, src }], [], FULL);
    expect(list[0].src).toEqual({ us: 0.95, ul: 0.1, vs: 0, vl: 1 });
    expect(list[0].nativeW).toBe(880);
  });
  it('nativeSize 至少 1', () => {
    expect(nativeSize({ us: 0, ul: 1e-9, vs: 0, vl: 1e-9 }, FULL)).toEqual({ w: 1, h: 1 });
  });
  it('defaultDestSize：照比例縮；轉 90 度寬高對調', () => {
    expect(defaultDestSize({ w: 8800, h: 400 }, 50)).toEqual({ w: 4400, h: 200 });
    expect(defaultDestSize({ w: 8800, h: 400 }, 50, 90)).toEqual({ w: 200, h: 4400 });
    expect(defaultDestSize({ w: 3, h: 3 }, 10)).toEqual({ w: 1, h: 1 });
  });
  it('placementsFromInputs：整個物件一塊補 objectId，手動切的補 objectId 和 uv，對不到的丟掉', () => {
    const out = placementsFromInputs([
      { key: 'o:o1', dest: { x: 0, y: 0, w: 10, h: 10 }, rotate: 0, flipH: false, flipV: false },
      { key: 's:m1', dest: { x: 10, y: 0, w: 10, h: 10 }, rotate: 90, flipH: true, flipV: false },
      { key: 's:gone', dest: { x: 20, y: 0, w: 10, h: 10 }, rotate: 0, flipH: false, flipV: false },
    ], [{ id: 'm1', objectId: 'o9', name: 'x', uv: [0, 0, 0.5, 1] }]);
    expect(out.map(p => [p.key, p.objectId, p.uv])).toEqual([['o:o1', 'o1', null], ['s:m1', 'o9', [0, 0, 0.5, 1]]]);
  });
});

describe('checkPlacements：排法的提醒（不擋存檔）', () => {
  const screens = buildScreenList(
    [{ objectId: 'a', name: '中間底幕', order: 0, src: { us: 0, ul: 1, vs: 0, vl: 0.2 } },
      { objectId: 'b', name: '左側幕', order: 1, src: { us: 0, ul: 0.25, vs: 0, vl: 1 } }],
    [], FULL,
  );
  // a: 8800 × 405（0.2 × 2024 = 404.8 → 405），b: 2200 × 2024
  it('剛好照比例放 = 沒有提醒', () => {
    const pl = plan([plc({ key: 'o:a', objectId: 'a', dest: { x: 0, y: 0, w: 4400, h: 203 } })], { canvas: { width: 4400, height: 1012 }, scalePct: 50 });
    expect(checkPlacements(pl, screens)).toEqual([]);
  });
  it('超出畫布、重疊、被拉伸、找不到螢幕', () => {
    const pl = plan([
      plc({ key: 'o:a', objectId: 'a', dest: { x: 100, y: 0, w: 4400, h: 203 } }),                 // 超出（100 + 4400 > 4400）
      plc({ key: 'o:b', objectId: 'b', dest: { x: 200, y: 100, w: 600, h: 1012 } }),             // 跟 a 重疊、寬度被拉伸（應該 1100）
      plc({ key: 'o:gone', objectId: 'gone', dest: { x: 0, y: 0, w: 5, h: 5 } }),
    ], { canvas: { width: 4400, height: 1012 }, scalePct: 50 });
    const kinds = checkPlacements(pl, screens).map(i => `${i.kind}:${i.key}`);
    expect(kinds).toContain('outside:o:a');
    expect(kinds).toContain('stretch:o:b');
    expect(kinds).toContain('overlap:o:a');
    expect(kinds).toContain('unknown:o:gone');
    const stretch = checkPlacements(pl, screens).find(i => i.kind === 'stretch')!;
    expect(stretch.text).toContain('實際 2200×2024 → 這個版型 600×1012');
  });
  it('轉 90 度：預期大小寬高對調，不會被誤判成拉伸', () => {
    const pl = plan([plc({ key: 'o:b', objectId: 'b', rotate: 90, dest: { x: 0, y: 0, w: 1012, h: 1100 } })], { canvas: { width: 4400, height: 1100 }, scalePct: 50 });
    expect(checkPlacements(pl, screens).filter(i => i.kind === 'stretch')).toEqual([]);
  });
});

describe('compareVideoToTemplate：上傳時影片大小跟版型畫布比', () => {
  const canvas = { width: 4400, height: 1012 };
  it('一樣大', () => {
    expect(compareVideoToTemplate({ width: 4400, height: 1012 }, canvas)).toEqual({ kind: 'exact' });
    expect(templateVideoNote({ width: 4400, height: 1012 }, { name: 'X', canvas })).toBeNull();
  });
  it('剛好一半 / 兩倍：接受，標百分比', () => {
    const half = compareVideoToTemplate({ width: 2200, height: 506 }, canvas);
    expect(half).toMatchObject({ kind: 'scaled', pct: 50 });
    const dbl = compareVideoToTemplate({ width: 8800, height: 2024 }, canvas);
    expect(dbl).toMatchObject({ kind: 'scaled', pct: 200 });
  });
  it('四捨五入差 1 個像素內算等比例（版型 5249×1281 的 50% 輸出 2624×640）', () => {
    const c = { width: 5249, height: 1281 };
    expect(compareVideoToTemplate({ width: 2624, height: 640 }, c).kind).toBe('scaled');
    expect(compareVideoToTemplate({ width: 2625, height: 641 }, c).kind).toBe('scaled');
  });
  it('比例不一樣：變形，說是左右拉寬還是上下拉長', () => {
    const wide = compareVideoToTemplate({ width: 1920, height: 1080 }, { width: 4000, height: 1000 });
    expect(wide).toEqual({ kind: 'stretch', how: '左右拉寬' });
    const tall = compareVideoToTemplate({ width: 8800, height: 2024 }, { width: 3840, height: 2160 });
    expect(tall).toEqual({ kind: 'stretch', how: '上下拉長' });
  });
  it('提示的話（中文）', () => {
    const n1 = templateVideoNote({ width: 2200, height: 506 }, { name: '中間底幕', canvas })!;
    expect(n1.level).toBe('info');
    expect(n1.text).toBe('影片是版型「中間底幕」的 50%（2200×506，版型是 4400×1012）：播放時自動放大貼回，LED 像素格照真實點數畫');
    const n2 = templateVideoNote({ width: 1920, height: 1080 }, { name: '中間底幕', canvas })!;
    expect(n2.level).toBe('warn');
    expect(n2.text).toBe('影片是 1920×1080，版型「中間底幕」是 4400×1012，比例不一樣：畫面會被左右拉寬（變形）。請用 4400×1012 的合成輸出');
  });
  it('版本列上的一行', () => {
    const p = { name: '中間底幕', canvas };
    expect(versionTemplateLabel(null, { width: 1, height: 1 })).toBeNull();
    expect(versionTemplateLabel(p, { width: 4400, height: 1012 })).toBe('版型「中間底幕」');
    expect(versionTemplateLabel(p, { width: 2200, height: 506 })).toBe('版型「中間底幕」· 影片是版型的 50%');
    expect(versionTemplateLabel(p, { width: 100, height: 100 })).toContain('會變形');
    expect(versionTemplateLabel(p, { width: null, height: null })).toBe('版型「中間底幕」');
  });
});

describe('輸入檢查（後台和表單共用）', () => {
  it('名稱：去頭尾空白、不能空、不能太長、不能叫「全部」', () => {
    expect(normalizeTemplateName('  中間  底幕 ')).toEqual({ ok: true, value: '中間 底幕' });
    expect(normalizeTemplateName('')).toMatchObject({ ok: false });
    expect(normalizeTemplateName('字'.repeat(41))).toMatchObject({ ok: false });
    expect(normalizeTemplateName(' 全部 ')).toMatchObject({ ok: false });
  });
  it('parseScreenKey', () => {
    expect(parseScreenKey('o:abc_1')).toEqual({ kind: 'object', id: 'abc_1' });
    expect(parseScreenKey('s:x')).toEqual({ kind: 'manual', id: 'x' });
    expect(parseScreenKey('x:abc')).toBeNull();
    expect(parseScreenKey('o:')).toBeNull();
    expect(parseScreenKey(5)).toBeNull();
  });
  it('放法：整數、寬高至少 1、轉動只能 90 的倍數、同一塊螢幕只能放一次', () => {
    const good = normalizePlacementInputs([{ key: 'o:a', dest: { x: -5, y: 3, w: 10, h: 20 }, rotate: 270, flipH: 1, flipV: false }]);
    expect(good).toEqual({ ok: true, value: [{ key: 'o:a', dest: { x: -5, y: 3, w: 10, h: 20 }, rotate: 270, flipH: true, flipV: false }] });
    expect(normalizePlacementInputs([{ key: 'o:a', dest: { x: '5', y: '0', w: '10', h: '10' } }])).toMatchObject({ ok: true });
    for (const bad of [
      [{ key: 'o:a', dest: { x: 0, y: 0, w: 0, h: 5 } }],
      [{ key: 'o:a', dest: { x: 0.5, y: 0, w: 5, h: 5 } }],
      [{ key: 'o:a', dest: { x: 0, y: 0, w: 5, h: 5 }, rotate: 91 }],
      [{ key: 'o:a', dest: { x: 0, y: 0, w: 5, h: 5 } }, { key: 'o:a', dest: { x: 9, y: 0, w: 5, h: 5 } }],
      [{ key: 'zzz', dest: { x: 0, y: 0, w: 5, h: 5 } }],
      'nope',
    ]) expect(normalizePlacementInputs(bad)).toMatchObject({ ok: false });
  });
  it('整個版型：新增要有名稱和畫布；修改只檢查有給的欄位', () => {
    expect(normalizeTemplateInput({ name: 'A', canvas: { width: 100, height: 50 } }, { partial: false })).toEqual({
      ok: true, value: { name: 'A', canvas: { width: 100, height: 50 }, scalePct: 100, screens: [] },
    });
    expect(normalizeTemplateInput({ canvas: { width: 100, height: 50 } }, { partial: false })).toMatchObject({ ok: false });
    expect(normalizeTemplateInput({ scalePct: 50 }, { partial: true })).toEqual({ ok: true, value: { scalePct: 50 } });
    expect(normalizeTemplateInput({ scalePct: 'abc' }, { partial: true })).toMatchObject({ ok: false });
    expect(normalizeTemplateInput({ scalePct: 33.333 }, { partial: true })).toEqual({ ok: true, value: { scalePct: 33.33 } });
    expect(normalizeTemplateInput(null, { partial: true })).toMatchObject({ ok: false });
  });
  it('手動切的螢幕：uv 或像素', () => {
    const fullCanvas = { width: 1000, height: 500 };
    expect(normalizeManualScreenInput({ name: 'L', objectId: 'o1', uv: [0, 0, 0.5, 1] }, { partial: false, fullCanvas: null }))
      .toEqual({ ok: true, value: { name: 'L', objectId: 'o1', uv: [0, 0, 0.5, 1] } });
    expect(normalizeManualScreenInput({ name: 'L', objectId: 'o1', rect: { x: 500, y: 0, w: 500, h: 500 } }, { partial: false, fullCanvas }))
      .toEqual({ ok: true, value: { name: 'L', objectId: 'o1', uv: [0.5, 0, 1, 1] } });
    expect(normalizeManualScreenInput({ name: 'L', objectId: 'o1', rect: { x: 0, y: 0, w: 1, h: 1 } }, { partial: false, fullCanvas: null })).toMatchObject({ ok: false });
    expect(normalizeManualScreenInput({ name: 'L', objectId: 'o1', uv: [0.5, 0, 0.2, 1] }, { partial: false, fullCanvas })).toMatchObject({ ok: false });
    expect(normalizeManualScreenInput({ name: 'L', objectId: 'o1', uv: [0, 0, 1.1, 1] }, { partial: false, fullCanvas })).toMatchObject({ ok: false });
  });
});

describe('parsePlan：壞資料 = null（當整張畫布）', () => {
  const good = {
    v: 1, id: 't1', name: '中間底幕', canvas: { width: 4400, height: 200 }, scalePct: 50,
    screens: [{ key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 4400, h: 200 }, rotate: 90, flipH: true, flipV: false }],
  };
  it('好的', () => {
    const p = parsePlan(good)!;
    expect(p.name).toBe('中間底幕');
    expect(p.screens[0]).toEqual(good.screens[0]);
    expect(parsePlan(JSON.stringify(good))!.screens.length).toBe(1);
  });
  it('壞的', () => {
    expect(parsePlan(null)).toBeNull();
    expect(parsePlan('{oops')).toBeNull();
    expect(parsePlan({ ...good, canvas: { width: 3, height: 3 } })).toBeNull();
    expect(parsePlan({ ...good, screens: 'x' })).toBeNull();
  });
  it('單一一筆壞掉只丟掉那一筆；手動切的沒有 uv 的丟掉；轉動不合法當 0', () => {
    const p = parsePlan({
      ...good,
      screens: [
        good.screens[0],
        { key: 'o:b', dest: { x: 0, y: 0, w: 0, h: 5 } },
        { key: 's:m', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 5, h: 5 } },
        { key: 's:n', objectId: 'a', uv: [0, 0, 0.5, 1], dest: { x: 0, y: 0, w: 5, h: 5 }, rotate: 45 },
      ],
    })!;
    expect(p.screens.map(s => s.key)).toEqual(['o:a', 's:n']);
    expect(p.screens[1].rotate).toBe(0);
  });
});
