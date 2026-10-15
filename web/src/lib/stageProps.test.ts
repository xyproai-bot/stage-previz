import { describe, expect, it } from 'vitest';
import {
  STAGE_PROP_MAX, STAGE_PROP_SPECS, STAGE_PROP_TYPE_IDS, canEditStageProps, checkStagePropsForSave, facingYaw, freeSpot,
  moveStagePropWith, newStagePropId, normalizeRotY, normalizeStageProps, parseStoredStageProps, propsStandingOn,
  removeStageProp, riserTopAt, rotateStagePropBy, sanitizeStagePropItem, serializeStageProps, stagePropSpec, type StagePropItem,
} from './stageProps';

const item = (o: Partial<StagePropItem> & { id: string }): StagePropItem => ({ type: 'drummer', x: 0, y: 0, z: 0, rotY: 0, ...o });

describe('種類和尺寸', () => {
  it('十二種人 + 四種器材，每一種都有中文名字、不重複', () => {
    expect(STAGE_PROP_TYPE_IDS).toHaveLength(16);
    expect(STAGE_PROP_SPECS.map(s => s.type).sort()).toEqual([...STAGE_PROP_TYPE_IDS].sort());
    expect(new Set(STAGE_PROP_SPECS.map(s => s.label)).size).toBe(16);
    expect(STAGE_PROP_SPECS.filter(s => s.group === 'person').map(s => s.label)).toEqual([
      '主唱', '和聲', '舞者', '吉他手', '貝斯手', '鍵盤手', '鼓手', '打擊樂手', 'DJ', '小提琴手', '大提琴手', '管樂手',
    ]);
    expect(STAGE_PROP_SPECS.filter(s => s.group === 'gear').map(s => s.label)).toEqual(['平台鋼琴', '麥克風架', '地板監聽喇叭', '樂手台']);
  });

  it('需求給的尺寸（公尺）', () => {
    const size = (t: Parameters<typeof stagePropSpec>[0]) => stagePropSpec(t).size;
    expect(size('riser')).toEqual({ w: 2.4, d: 2.4, h: 0.4 });
    expect(size('monitor')).toEqual({ w: 0.6, d: 0.45, h: 0.35 });
    expect(size('piano')).toEqual({ w: 1.5, d: 2.1, h: 1 });
    expect(size('dj')).toEqual({ w: 1.8, d: 0.8, h: 1 });
    expect(size('keyboardist').w).toBe(1.3);
    expect(size('drummer').w).toBeCloseTo(2, 1);
    expect(size('drummer').d).toBeCloseTo(1.8, 1);
    for (const t of ['vocalist', 'backing', 'dancer', 'guitarist', 'bassist', 'percussionist', 'violinist', 'winds'] as const) {
      expect(size(t).h).toBe(1.7);
    }
  });
});

describe('存檔格式（存進資料庫 / 讀回來）', () => {
  const a = item({ id: 'sp_a', type: 'drummer', x: 1.2345, y: 0.4, z: -2, rotY: 15 });
  const b = item({ id: 'sp_b', type: 'riser', x: 0, y: 0, z: 0, rotY: -90 });

  it('存成字串再讀回來，內容一樣（座標取到公釐）', () => {
    const text = serializeStageProps([a, b]);
    expect(JSON.parse(text)).toEqual([{ ...a, x: 1.235 }, b]);
    expect(parseStoredStageProps(text)).toEqual([{ ...a, x: 1.235 }, b]);
    expect(serializeStageProps([])).toBe('[]');
  });

  it('壞掉的資料不會丟錯：空 / null / 亂碼 / 不是清單 → 空清單', () => {
    for (const bad of [null, undefined, '', 'oops', '{"a":1}', '123', 'null']) expect(parseStoredStageProps(bad as string)).toEqual([]);
    expect(normalizeStageProps(42)).toEqual([]);
  });

  it('讀的時候丟掉不合法的和重複的，其他照留；最多 60 個', () => {
    const raw = [a, { ...a }, { ...b, type: 'tuba' }, { ...b, x: 'x' }, { ...b, id: '' }, null, 5, b];
    expect(normalizeStageProps(raw).map(i => i.id)).toEqual(['sp_a', 'sp_b']);
    const many = Array.from({ length: 80 }, (_, i) => ({ ...a, id: 'sp_' + i }));
    expect(normalizeStageProps(many)).toHaveLength(STAGE_PROP_MAX);
  });

  it('舊版 / 少欄位：沒有 rotY 當 0；缺座標不收', () => {
    expect(sanitizeStagePropItem({ id: 'sp_x', type: 'piano', x: 1, y: 0, z: 2 })).toEqual({ id: 'sp_x', type: 'piano', x: 1, y: 0, z: 2, rotY: 0 });
    expect(sanitizeStagePropItem({ id: 'sp_x', type: 'piano', x: 1, y: 0 })).toBeNull();
    expect(sanitizeStagePropItem({ id: 'sp_x', type: 'piano', x: null, y: 0, z: 0 })).toBeNull();
    expect(sanitizeStagePropItem({ id: 'sp_x', type: 'piano', x: '1', y: 0, z: 0 })).toBeNull();
    expect(sanitizeStagePropItem({ id: 'sp_x', type: 'piano', x: NaN, y: 0, z: 0 })).toBeNull();
    expect(sanitizeStagePropItem({ id: 'sp_x', type: 'piano', x: 1e7, y: 0, z: 0 })).toBeNull();
    expect(sanitizeStagePropItem({ id: 'a b', type: 'piano', x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('後台存檔前的檢查：有一筆不對整份拒絕，說清楚第幾個', () => {
    expect(checkStagePropsForSave([a, b])).toEqual({ ok: true, props: [{ ...a, x: 1.235 }, b] });
    expect(checkStagePropsForSave([])).toEqual({ ok: true, props: [] });
    expect(checkStagePropsForSave('x')).toMatchObject({ ok: false });
    expect(checkStagePropsForSave([a, { ...b, type: 'tuba' }])).toEqual({ ok: false, error: '第 2 個樂手或器材的資料不對' });
    expect(checkStagePropsForSave([a, { ...a }])).toEqual({ ok: false, error: '第 2 個樂手或器材的代號重複了' });
    const tooMany = Array.from({ length: STAGE_PROP_MAX + 1 }, (_, i) => ({ ...a, id: 'sp_' + i }));
    expect(checkStagePropsForSave(tooMany)).toMatchObject({ ok: false });
    expect(checkStagePropsForSave(tooMany.slice(0, STAGE_PROP_MAX)).ok).toBe(true);
  });

  it('角度換成 (-180, 180]', () => {
    expect(normalizeRotY(270)).toBe(-90);
    expect(normalizeRotY(-190)).toBe(170);
    expect(normalizeRotY(180)).toBe(180);
    expect(normalizeRotY(-180)).toBe(180);
    expect(normalizeRotY(360)).toBe(0);
    expect(normalizeRotY(15.04)).toBe(15);
    expect(normalizeRotY(NaN)).toBe(0);
    expect(Object.is(normalizeRotY(-0.01), 0)).toBe(true);
  });

  it('新代號：sp_ 開頭、不重複、後台認得', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newStagePropId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(sanitizeStagePropItem({ id, type: 'riser', x: 0, y: 0, z: 0 })).not.toBeNull();
  });
});

describe('誰能改（製作、導演；動畫師和分享連結訪客只能看）', () => {
  it('canEditStageProps', () => {
    expect(canEditStageProps('admin')).toBe(true);
    expect(canEditStageProps('director')).toBe(true);
    expect(canEditStageProps('animator')).toBe(false);
    expect(canEditStageProps(null)).toBe(false);       // 分享連結的訪客 / 不是成員
    expect(canEditStageProps(undefined)).toBe(false);
  });
});

describe('擺放', () => {
  it('面向觀眾：正面 +Z → 0 度；+X → 90 度；-Z → 180 度', () => {
    expect(facingYaw({ x: 0, z: 1 })).toBe(0);
    expect(facingYaw({ x: 1, z: 0 })).toBe(90);
    expect(facingYaw({ x: 0, z: -1 })).toBe(180);
    expect(facingYaw({ x: -1, z: 0 })).toBe(-90);
    expect(facingYaw({ x: 0, z: 0 })).toBe(0);
  });

  it('新增的位置：前緣正中間有人就往左右找空位（右、左、再右…）', () => {
    const base = { x: 0, z: 5 };
    const right = { x: 1, z: 0 };
    expect(freeSpot([], base, right)).toEqual(base);
    const first = item({ id: 'a', x: 0, z: 5 });
    expect(freeSpot([first], base, right)).toEqual({ x: 1.2, z: 5 });
    const second = item({ id: 'b', x: 1.2, z: 5 });
    expect(freeSpot([first, second], base, right)).toEqual({ x: -1.2, z: 5 });
    // 右邊不是 +X 也行（舞台轉了方向）
    const turned = freeSpot([first], base, { x: 0, z: -1 });
    expect(turned.x).toBeCloseTo(0, 5);
    expect(turned.z).toBeCloseTo(3.8, 5);
  });

  it('轉 15 度、刪除', () => {
    const list = [item({ id: 'a', rotY: 170 }), item({ id: 'b' })];
    expect(rotateStagePropBy(list, 'a', 15).find(i => i.id === 'a')?.rotY).toBe(-175);
    expect(rotateStagePropBy(list, 'a', -15).find(i => i.id === 'a')?.rotY).toBe(155);
    expect(rotateStagePropBy(list, 'nope', 15)).toEqual(list);
    expect(removeStageProp(list, 'a').map(i => i.id)).toEqual(['b']);
  });
});

describe('樂手台：站在上面的東西跟著走', () => {
  const riser = item({ id: 'r', type: 'riser', x: 10, y: 0, z: 5, rotY: 0 });
  const drums = item({ id: 'd', type: 'drummer', x: 10.5, y: 0.4, z: 5.5 });
  const onFloor = item({ id: 'f', type: 'vocalist', x: 10.5, y: 0, z: 5.5 });         // 同一個位置但站在地上（穿過樂手台）→ 不算
  const outside = item({ id: 'o', type: 'piano', x: 14, y: 0.4, z: 5 });              // 在樂手台外面
  const upper = item({ id: 'r2', type: 'riser', x: 10, y: 0.4, z: 5 });              // 疊在上面的另一個樂手台
  const onUpper = item({ id: 'u', type: 'dj', x: 10.2, y: 0.8, z: 5.2 });

  it('站在上面的：腳在頂面高度、位置在台面內', () => {
    expect(propsStandingOn([riser, drums, onFloor, outside], 'r')).toEqual(['d']);
    expect(propsStandingOn([riser, drums], 'd')).toEqual([]);          // 不是樂手台
    expect(propsStandingOn([riser], 'nope')).toEqual([]);
    expect(propsStandingOn([riser, upper, onUpper], 'r').sort()).toEqual(['r2', 'u']);
  });

  it('台面轉了以後，邊界跟著轉', () => {
    const turned = { ...riser, rotY: 45 };
    const corner = item({ id: 'c', type: 'monitor', x: 10 + 1.2, y: 0.4, z: 5 + 1.2 });  // 沒轉時是角落（在台面內），轉 45 度後在台面外
    expect(propsStandingOn([riser, corner], 'r')).toEqual(['c']);
    expect(propsStandingOn([turned, corner], 'r')).toEqual([]);
  });

  it('拖樂手台：站在上面的跟著平移', () => {
    const next = moveStagePropWith([riser, drums, outside], 'r', { x: 12, y: 0, z: 4, rotY: 0 });
    const by = (id: string) => next.find(i => i.id === id) as StagePropItem;
    expect(by('r')).toMatchObject({ x: 12, z: 4 });
    expect(by('d')).toMatchObject({ x: 12.5, z: 4.5, y: 0.4 });
    expect(by('o')).toEqual(outside);
  });

  it('轉樂手台：站在上面的繞著樂手台中心轉，面向也跟著轉', () => {
    const next = rotateStagePropBy([riser, drums], 'r', 90);
    const d = next.find(i => i.id === 'd') as StagePropItem;
    // three.js 的 rotation.y +90 度：(x, z) → (z, -x)；(0.5, 0.5) → (0.5, -0.5)
    expect(d.x).toBeCloseTo(10.5, 2);
    expect(d.z).toBeCloseTo(4.5, 2);
    expect(d.rotY).toBe(90);
    expect(next.find(i => i.id === 'r')?.rotY).toBe(90);
  });

  it('拖到樂手台範圍內、高度沒高過頂面（滑鼠指在側面，光線穿過去打到地板）→ 站到頂面上', () => {
    const none = new Set<string>();
    expect(riserTopAt([riser], none, 10.5, 5.5, 0)).toBeCloseTo(0.4, 5);          // 指在側面：高度 = 地板 → 頂面
    expect(riserTopAt([riser], none, 10.5, 5.5, 0.4)).toBeCloseTo(0.4, 5);        // 已經在頂面
    expect(riserTopAt([riser], none, 12, 5.5, 0)).toBeNull();                      // 台外
    expect(riserTopAt([riser], none, 10.5, 5.5, 1.5)).toBeNull();                  // 在台子上方很高（站在別的地方）
    expect(riserTopAt([riser], new Set(['r']), 10.5, 5.5, 0)).toBeNull();          // 正在拖的就是這個樂手台
    expect(riserTopAt([riser, upper], none, 10.2, 5.2, 0)).toBeCloseTo(0.8, 5);    // 疊了兩層 → 最高那一層
    expect(riserTopAt([{ ...riser, rotY: 45 }], none, 11.2, 6.2, 0)).toBeNull();   // 轉 45 度以後，原本的角落已經在台外
    expect(riserTopAt([], none, 0, 0, 0)).toBeNull();
  });

  it('拖一般的東西只動它自己；樂手台拖上樂手台，高度一起變', () => {
    const next = moveStagePropWith([riser, drums], 'd', { x: 1, y: 0.4, z: 2, rotY: 30 });
    expect(next.find(i => i.id === 'd')).toMatchObject({ x: 1, z: 2, rotY: 30 });
    expect(next.find(i => i.id === 'r')).toEqual(riser);
    const lifted = moveStagePropWith([riser, drums], 'r', { x: 10, y: 0.4, z: 5, rotY: 0 });
    expect(lifted.find(i => i.id === 'd')?.y).toBeCloseTo(0.8, 5);
  });
});
