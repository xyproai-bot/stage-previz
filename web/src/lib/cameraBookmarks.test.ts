import { describe, expect, it } from 'vitest';
import {
  addCameraBookmark, canEditCameraBookmarks, CAMERA_BOOKMARK_MAX, checkCameraBookmarksForSave, cleanBookmarkName, defaultBookmarkName,
  localBookmarksKey, localOfferKey, mergeLocalIntoProject, moveCameraBookmark, newCameraBookmarkId, normalizeCameraBookmarks,
  parseLocalBookmarks, parseStoredCameraBookmarks, planLocalOffer, removeCameraBookmark, renameCameraBookmark, sameBookmark,
  sanitizeCameraBookmark, serializeCameraBookmarks, type CameraBookmark,
} from './cameraBookmarks';

const FOH: CameraBookmark = { id: 'cb_foh00001', name: '控台看舞台', position: [12.5, 4.25, 30], target: [0, 2, 0], fov: 45 };
const STANDS: CameraBookmark = { id: 'cb_stands01', name: '二樓看台', position: [-20, 14, 25.5], target: [0, 3, -2], fov: 50 };
const seq = (...vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };

describe('權限：誰能存 / 改視角書籤', () => {
  it('製作、導演可以；動畫師、沒有角色的（訪客、不是成員）不行', () => {
    expect(canEditCameraBookmarks('admin')).toBe(true);
    expect(canEditCameraBookmarks('director')).toBe(true);
    expect(canEditCameraBookmarks('animator')).toBe(false);
    expect(canEditCameraBookmarks(null)).toBe(false);
    expect(canEditCameraBookmarks(undefined)).toBe(false);
  });
});

describe('一筆視角的檢查', () => {
  it('合法的原樣收下，座標取到千分位、名字去頭尾空白', () => {
    expect(sanitizeCameraBookmark(FOH)).toEqual(FOH);
    expect(sanitizeCameraBookmark({ ...FOH, name: '  特區  ', position: [1.23456, 2, 3], fov: 44.4444 }))
      .toEqual({ ...FOH, name: '特區', position: [1.235, 2, 3], fov: 44.444 });
  });

  it('壞資料一律不收（不能把 null、字串當成 0）', () => {
    const bad: unknown[] = [
      null, 'x', [], {},
      { ...FOH, id: '' }, { ...FOH, id: '../x' }, { ...FOH, id: 5 },
      { ...FOH, name: '' }, { ...FOH, name: '   ' }, { ...FOH, name: 'x'.repeat(41) }, { ...FOH, name: 3 },
      { ...FOH, position: [1, 2] }, { ...FOH, position: [1, 2, 3, 4] }, { ...FOH, position: [1, 'a', 3] },
      { ...FOH, position: [1, null, 3] }, { ...FOH, position: 'nope' }, { ...FOH, position: [1e9, 0, 0] }, { ...FOH, position: [NaN, 0, 0] },
      { ...FOH, target: [0, 0] },
      { ...FOH, position: [0, 2, 0], target: [0, 2, 0] },   // 看向自己
      { ...FOH, fov: 'wide' }, { ...FOH, fov: null }, { ...FOH, fov: 4 }, { ...FOH, fov: 151 }, { ...FOH, fov: NaN },
    ];
    for (const b of bad) expect(sanitizeCameraBookmark(b), JSON.stringify(b)).toBeNull();
  });

  it('名字剛好 40 個字可以', () => {
    expect(sanitizeCameraBookmark({ ...FOH, name: '視'.repeat(40) })).not.toBeNull();
  });
});

describe('清單：讀進來 / 存檔前檢查', () => {
  it('normalize：壞的那筆、重複的代號丟掉，其他留著；JSON 字串也收', () => {
    const list = normalizeCameraBookmarks([FOH, { ...FOH, name: '重複代號' }, null, { ...STANDS, fov: 'x' }, STANDS]);
    expect(list.map(b => b.id)).toEqual([FOH.id, STANDS.id]);
    expect(normalizeCameraBookmarks(JSON.stringify([FOH]))).toEqual([FOH]);
    expect(normalizeCameraBookmarks('oops')).toEqual([]);
    expect(normalizeCameraBookmarks({ a: 1 })).toEqual([]);
    expect(normalizeCameraBookmarks(undefined)).toEqual([]);
  });

  it('最多 40 個', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...FOH, id: 'cb_' + i, name: '視角 ' + i }));
    expect(normalizeCameraBookmarks(many)).toHaveLength(CAMERA_BOOKMARK_MAX);
  });

  it('存檔前檢查比讀進來嚴格：有一筆不對整份拒絕，說第幾個', () => {
    expect(checkCameraBookmarksForSave([FOH, STANDS])).toEqual({ ok: true, bookmarks: [FOH, STANDS] });
    expect(checkCameraBookmarksForSave([])).toEqual({ ok: true, bookmarks: [] });
    const notList = checkCameraBookmarksForSave('nope');
    expect(notList.ok).toBe(false);
    const second = checkCameraBookmarksForSave([FOH, { ...STANDS, name: '' }]);
    expect(second).toEqual({ ok: false, error: '第 2 個視角的資料不對' });
    const dup = checkCameraBookmarksForSave([FOH, FOH]);
    expect(dup).toEqual({ ok: false, error: '第 2 個視角的代號重複了' });
    const tooMany = checkCameraBookmarksForSave(Array.from({ length: 41 }, (_, i) => ({ ...FOH, id: 'cb_' + i })));
    expect(tooMany.ok).toBe(false);
    expect(checkCameraBookmarksForSave(Array.from({ length: 40 }, (_, i) => ({ ...FOH, id: 'cb_' + i }))).ok).toBe(true);
  });

  it('存進資料庫再讀回來是同一份、順序不變；壞字串讀回空清單', () => {
    const text = serializeCameraBookmarks([STANDS, FOH]);
    expect(parseStoredCameraBookmarks(text)).toEqual([STANDS, FOH]);
    expect(parseStoredCameraBookmarks(null)).toEqual([]);
    expect(parseStoredCameraBookmarks('')).toEqual([]);
    expect(parseStoredCameraBookmarks('{{')).toEqual([]);
  });
});

describe('清單的小操作', () => {
  it('新增接在最後；滿了、代號重複、資料不對 → null', () => {
    expect(addCameraBookmark([FOH], STANDS)).toEqual([FOH, STANDS]);
    expect(addCameraBookmark([FOH], FOH)).toBeNull();
    expect(addCameraBookmark([FOH], { ...STANDS, name: '' })).toBeNull();
    const full = Array.from({ length: CAMERA_BOOKMARK_MAX }, (_, i) => ({ ...FOH, id: 'cb_' + i }));
    expect(addCameraBookmark(full, STANDS)).toBeNull();
  });

  it('改名只改那一個；空名字不改', () => {
    expect(renameCameraBookmark([FOH, STANDS], STANDS.id, '  特區  ')).toEqual([FOH, { ...STANDS, name: '特區' }]);
    expect(renameCameraBookmark([FOH, STANDS], STANDS.id, '   ')).toEqual([FOH, STANDS]);
    expect(renameCameraBookmark([FOH], 'nope', 'x')).toEqual([FOH]);
    expect(cleanBookmarkName('  a  ')).toBe('a');
    expect(cleanBookmarkName(null)).toBeNull();
    expect(cleanBookmarkName('x'.repeat(60))).toHaveLength(40);
  });

  it('刪除', () => {
    expect(removeCameraBookmark([FOH, STANDS], FOH.id)).toEqual([STANDS]);
    expect(removeCameraBookmark([FOH], 'nope')).toEqual([FOH]);
  });

  it('換順序：往前 / 往後一格，頭尾不動，不改原本的陣列', () => {
    const a = { ...FOH, id: 'cb_a' }, b = { ...FOH, id: 'cb_b' }, c = { ...FOH, id: 'cb_c' };
    const list = [a, b, c];
    expect(moveCameraBookmark(list, 'cb_b', -1).map(x => x.id)).toEqual(['cb_b', 'cb_a', 'cb_c']);
    expect(moveCameraBookmark(list, 'cb_b', 1).map(x => x.id)).toEqual(['cb_a', 'cb_c', 'cb_b']);
    expect(moveCameraBookmark(list, 'cb_a', -1).map(x => x.id)).toEqual(['cb_a', 'cb_b', 'cb_c']);
    expect(moveCameraBookmark(list, 'cb_c', 1).map(x => x.id)).toEqual(['cb_a', 'cb_b', 'cb_c']);
    expect(moveCameraBookmark(list, 'nope', 1).map(x => x.id)).toEqual(['cb_a', 'cb_b', 'cb_c']);
    expect(list.map(x => x.id)).toEqual(['cb_a', 'cb_b', 'cb_c']);
  });

  it('預設名字「視角 N」不會跟已經有的撞名；代號格式合法', () => {
    expect(defaultBookmarkName([])).toBe('視角 1');
    expect(defaultBookmarkName([FOH])).toBe('視角 2');
    expect(defaultBookmarkName([{ ...FOH, name: '視角 2' }])).toBe('視角 3');
    const id = newCameraBookmarkId(seq(0.1, 0.5, 0.9));
    expect(id).toMatch(/^cb_[a-z0-9]{8}$/);
    expect(sanitizeCameraBookmark({ ...FOH, id })).not.toBeNull();
  });
});

describe('這台電腦原本存的視角 → 放到專案裡', () => {
  const legacy = JSON.stringify([
    { id: 'bm_ab12cd34', name: '控台', pos: [10.1234, 3, 20], target: [0, 1, 0], fov: 45 },
    { id: 'bm_ab12cd34', name: '代號重複', pos: [1, 2, 3], target: [0, 0, 0], fov: 400 },
    { id: 'bm_bad', name: '', pos: [1, 2, 3], target: [0, 0, 0], fov: 45 },
    { id: 'bm_nan', name: '壞座標', pos: [1, 'x', 3], target: [0, 0, 0], fov: 45 },
    { id: 'bm_same', name: '看自己', pos: [1, 1, 1], target: [1, 1, 1], fov: 45 },
  ]);

  it('舊格式（pos）讀成新格式（position）；壞的丟掉；重複的代號換新的；視角太大夾在範圍內', () => {
    const list = parseLocalBookmarks(legacy, seq(0.2, 0.4, 0.6, 0.8));
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: 'bm_ab12cd34', name: '控台', position: [10.123, 3, 20], target: [0, 0 + 1, 0], fov: 45 });
    expect(list[1].name).toBe('代號重複');
    expect(list[1].id).not.toBe('bm_ab12cd34');
    expect(list[1].fov).toBe(150);
    expect(new Set(list.map(b => b.id)).size).toBe(2);
  });

  it('沒有 / 壞掉的字串 → 空清單', () => {
    expect(parseLocalBookmarks(null)).toEqual([]);
    expect(parseLocalBookmarks('')).toEqual([]);
    expect(parseLocalBookmarks('{{')).toEqual([]);
    expect(parseLocalBookmarks('{"a":1}')).toEqual([]);
  });

  it('key 的格式跟舊版一樣（才讀得到舊版存的）', () => {
    expect(localBookmarksKey('p_123')).toBe('sp_camera_bookmarks:p_123');
    expect(localOfferKey('p_123')).toBe('sp_camera_bookmarks_offer:p_123');
  });

  it('同一個視角 = 名字、位置、看向的點都一樣（差不到千分之一）', () => {
    expect(sameBookmark(FOH, { ...FOH, id: 'cb_other' })).toBe(true);
    expect(sameBookmark(FOH, { ...FOH, name: '別的名字' })).toBe(false);
    expect(sameBookmark(FOH, { ...FOH, position: [12.6, 4.25, 30] })).toBe(false);
  });

  const local = [FOH, STANDS];
  it('什麼時候問：有權限、專案清單讀到了、還沒回答過、這台電腦有專案上沒有的', () => {
    const plan = planLocalOffer({ canEdit: true, projectLoaded: true, answered: false, local, project: [] });
    expect(plan?.items).toEqual(local);
    expect(plan?.question).toBe('這台電腦存了 2 個視角，要放到專案裡讓大家都看得到嗎？');
  });

  it('專案上已經有的不算進去（只問還沒放上去的）', () => {
    const plan = planLocalOffer({ canEdit: true, projectLoaded: true, answered: false, local, project: [{ ...FOH, id: 'cb_in_project' }] });
    expect(plan?.items).toEqual([STANDS]);
    expect(plan?.question).toBe('這台電腦存了 1 個視角，要放到專案裡讓大家都看得到嗎？');
  });

  it('不問的情況：動畫師 / 訪客（不能存）、清單還沒讀到、已經回答過、這台電腦沒有、全都已經在專案上', () => {
    const base = { canEdit: true, projectLoaded: true, answered: false, local, project: [] as CameraBookmark[] };
    expect(planLocalOffer({ ...base, canEdit: false })).toBeNull();
    expect(planLocalOffer({ ...base, projectLoaded: false })).toBeNull();
    expect(planLocalOffer({ ...base, answered: true })).toBeNull();
    expect(planLocalOffer({ ...base, local: [] })).toBeNull();
    expect(planLocalOffer({ ...base, project: local })).toBeNull();
  });

  it('放上去：接在專案清單後面，代號撞到換新的，不重複放，超過 40 個的不放', () => {
    const merged = mergeLocalIntoProject([FOH], [{ ...STANDS, id: FOH.id }], seq(0.3, 0.6));
    expect(merged.added).toBe(1);
    expect(merged.list).toHaveLength(2);
    expect(merged.list[0]).toEqual(FOH);
    expect(merged.list[1].name).toBe('二樓看台');
    expect(merged.list[1].id).not.toBe(FOH.id);

    expect(mergeLocalIntoProject([FOH], [FOH]).added).toBe(0);

    const nearFull = Array.from({ length: CAMERA_BOOKMARK_MAX - 1 }, (_, i) => ({ ...FOH, id: 'cb_' + i, name: '視角 ' + i }));
    const result = mergeLocalIntoProject(nearFull, [STANDS, { ...STANDS, id: 'cb_x', name: '多的' }]);
    expect(result.added).toBe(1);
    expect(result.list).toHaveLength(CAMERA_BOOKMARK_MAX);
  });
});
