import { describe, it, expect } from 'vitest';
import {
  activeMediaItem, addMediaItems, EMPTY_MEDIA_LIST, fitSize, mediaFileKey, mediaKindOf, moveMediaItem,
  removeMediaItem, selectMediaItem, skippedFilesMessage, splitMediaFiles, stepMediaItem, thumbnailTime,
  updateMediaItem, type LocalMediaItem, type LocalMediaKind, type LocalMediaList,
} from './localMedia';

const item = (id: string, kind: LocalMediaKind = 'video', key = id): LocalMediaItem => ({
  id, key, name: `${id}.${kind === 'video' ? 'mp4' : 'png'}`, kind, file: {} as File, url: kind === 'image' ? `blob:${id}` : null,
  thumb: null, thumbReady: false, duration: null,
});
const ids = (list: LocalMediaList) => list.items.map(x => x.id);

describe('mediaKindOf', () => {
  it('看 MIME type', () => {
    expect(mediaKindOf({ name: 'a.bin', type: 'video/mp4' })).toBe('video');
    expect(mediaKindOf({ name: 'a.mov', type: 'video/quicktime' })).toBe('video');
    expect(mediaKindOf({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(mediaKindOf({ name: 'a.jpg', type: 'image/jpeg' })).toBe('image');
    expect(mediaKindOf({ name: 'a.webp', type: 'image/webp' })).toBe('image');
    expect(mediaKindOf({ name: 'a.gif', type: 'image/gif' })).toBe('image');
  });
  it('瀏覽器打不開的圖片、其他檔案 → 不收', () => {
    expect(mediaKindOf({ name: 'a.tif', type: 'image/tiff' })).toBeNull();
    expect(mediaKindOf({ name: 'a.psd', type: 'image/vnd.adobe.photoshop' })).toBeNull();
    expect(mediaKindOf({ name: 'a.txt', type: 'text/plain' })).toBeNull();
    expect(mediaKindOf({ name: 'a.wav', type: 'audio/wav' })).toBeNull();
  });
  it('MIME 空的時候看副檔名', () => {
    expect(mediaKindOf({ name: 'S01_主題曲.MP4', type: '' })).toBe('video');
    expect(mediaKindOf({ name: 'render.mov', type: '' })).toBe('video');
    expect(mediaKindOf({ name: 'LED_底圖.PNG', type: '' })).toBe('image');
    expect(mediaKindOf({ name: 'look.jpeg', type: '' })).toBe('image');
    expect(mediaKindOf({ name: 'notes.txt', type: '' })).toBeNull();
    expect(mediaKindOf({ name: 'comp.aep', type: '' })).toBeNull();
  });
});

describe('splitMediaFiles / skippedFilesMessage', () => {
  it('分成能用的和略過的', () => {
    const { accepted, rejected } = splitMediaFiles([
      { name: 'a.mp4', type: 'video/mp4' },
      { name: 'b.png', type: 'image/png' },
      { name: 'c.txt', type: 'text/plain' },
    ]);
    expect(accepted.map(a => [a.file.name, a.kind])).toEqual([['a.mp4', 'video'], ['b.png', 'image']]);
    expect(rejected).toEqual(['c.txt']);
  });
  it('提示：沒略過 → null；太多只列前三個', () => {
    expect(skippedFilesMessage([])).toBeNull();
    expect(skippedFilesMessage(['a.txt'])).toContain('a.txt');
    const many = skippedFilesMessage(['1.txt', '2.txt', '3.txt', '4.txt', '5.txt'])!;
    expect(many).toContain('1.txt、2.txt、3.txt 等 5 個');
    expect(many).not.toContain('4.txt');
  });
});

describe('mediaFileKey', () => {
  it('名稱 + 大小 + 修改時間', () => {
    const a = mediaFileKey({ name: 'a.mp4', size: 10, lastModified: 1 });
    expect(a).toBe(mediaFileKey({ name: 'a.mp4', size: 10, lastModified: 1 }));
    expect(a).not.toBe(mediaFileKey({ name: 'a.mp4', size: 11, lastModified: 1 }));
  });
});

describe('addMediaItems', () => {
  it('加在後面，第一個新加的變成正在放的', () => {
    const { list, added } = addMediaItems(EMPTY_MEDIA_LIST, [item('a'), item('b', 'image')]);
    expect(list.items.map(x => x.id)).toEqual(['a', 'b']);
    expect(list.activeId).toBe('a');
    expect(added.map(x => x.id)).toEqual(['a', 'b']);

    const more = addMediaItems(list, [item('c', 'image')]);
    expect(more.list.items.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(more.list.activeId).toBe('c');
  });
  it('同一個檔案不重複加；拖進來的第一個已經在清單 → 放清單裡那個', () => {
    const start = addMediaItems(EMPTY_MEDIA_LIST, [item('a', 'video', 'k1'), item('b', 'image', 'k2')]).list;
    const again = addMediaItems(start, [item('b2', 'image', 'k2'), item('c', 'video', 'k3'), item('c2', 'video', 'k3')]);
    expect(again.list.items.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(again.added.map(x => x.id)).toEqual(['c']);
    expect(again.list.activeId).toBe('b');
  });
  it('沒有檔案 → 原樣', () => {
    const start = addMediaItems(EMPTY_MEDIA_LIST, [item('a')]).list;
    expect(addMediaItems(start, []).list).toBe(start);
  });
});

describe('removeMediaItem', () => {
  const start = addMediaItems(EMPTY_MEDIA_LIST, [item('a'), item('b', 'image'), item('c')]).list; // a 在放

  it('拿掉正在放的 → 沒有在放', () => {
    const { list, removed } = removeMediaItem(start, 'a');
    expect(removed?.id).toBe('a');
    expect(list.items.map(x => x.id)).toEqual(['b', 'c']);
    expect(list.activeId).toBeNull();
    expect(activeMediaItem(list)).toBeNull();
  });
  it('拿掉別的 → 正在放的不變', () => {
    const { list } = removeMediaItem(start, 'b');
    expect(list.items.map(x => x.id)).toEqual(['a', 'c']);
    expect(list.activeId).toBe('a');
  });
  it('不在清單 → 原樣', () => {
    const { list, removed } = removeMediaItem(start, 'zzz');
    expect(list).toBe(start);
    expect(removed).toBeNull();
  });
});

describe('selectMediaItem', () => {
  const start = addMediaItems(EMPTY_MEDIA_LIST, [item('a'), item('b', 'image')]).list;
  it('點別的 → 換成那個', () => {
    const list = selectMediaItem(start, 'b');
    expect(list.activeId).toBe('b');
    expect(activeMediaItem(list)?.kind).toBe('image');
  });
  it('點正在放的 / 不在清單的 → 原樣', () => {
    expect(selectMediaItem(start, 'a')).toBe(start);
    expect(selectMediaItem(start, 'zzz')).toBe(start);
  });
});

describe('moveMediaItem（拖曳排順序）', () => {
  // a b c d，b 在放
  const start = selectMediaItem(addMediaItems(EMPTY_MEDIA_LIST, [item('a'), item('b'), item('c'), item('d')]).list, 'b');

  it('往下拖：放到 d 前面 → a c b d', () => {
    expect(ids(moveMediaItem(start, 'b', 3))).toEqual(['a', 'c', 'b', 'd']);
  });
  it('往上拖：放到 a 前面 → c a b d', () => {
    expect(ids(moveMediaItem(start, 'c', 0))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('拖到最後（insertAt = 長度）', () => {
    expect(ids(moveMediaItem(start, 'a', 4))).toEqual(['b', 'c', 'd', 'a']);
  });
  it('正在放的不變', () => {
    expect(moveMediaItem(start, 'b', 0).activeId).toBe('b');
    expect(moveMediaItem(start, 'd', 0).activeId).toBe('b');
  });
  it('放回自己前面 / 後面、不在清單、位置亂給 → 原樣或夾在範圍內', () => {
    expect(moveMediaItem(start, 'b', 1)).toBe(start);
    expect(moveMediaItem(start, 'b', 2)).toBe(start);
    expect(moveMediaItem(start, 'zzz', 0)).toBe(start);
    expect(moveMediaItem(start, 'b', NaN)).toBe(start);
    expect(ids(moveMediaItem(start, 'a', 99))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(moveMediaItem(start, 'd', -5))).toEqual(['d', 'a', 'b', 'c']);
  });
  it('不改到原本的清單', () => {
    moveMediaItem(start, 'a', 4);
    expect(ids(start)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('stepMediaItem（↑ / ↓ 換上一個 / 下一個）', () => {
  const list = addMediaItems(EMPTY_MEDIA_LIST, [item('a'), item('b'), item('c')]).list; // a 在放
  it('下一個 / 上一個', () => {
    expect(stepMediaItem(list, 1)).toBe('b');
    expect(stepMediaItem(selectMediaItem(list, 'b'), -1)).toBe('a');
    expect(stepMediaItem(selectMediaItem(list, 'b'), 1)).toBe('c');
  });
  it('到頭 / 到尾 → null（不繞回去）', () => {
    expect(stepMediaItem(list, -1)).toBeNull();
    expect(stepMediaItem(selectMediaItem(list, 'c'), 1)).toBeNull();
  });
  it('沒有在放的 → ↓ 從第一個、↑ 從最後一個', () => {
    const none = removeMediaItem(list, 'a').list; // b c，沒有在放
    expect(stepMediaItem(none, 1)).toBe('b');
    expect(stepMediaItem(none, -1)).toBe('c');
  });
  it('清單空的 → null', () => {
    expect(stepMediaItem(EMPTY_MEDIA_LIST, 1)).toBeNull();
  });
});

describe('updateMediaItem', () => {
  const list = addMediaItems(EMPTY_MEDIA_LIST, [item('a'), item('b', 'image')]).list;
  it('填回縮圖和片長，其他不動', () => {
    const next = updateMediaItem(list, 'a', { thumb: 'data:x', thumbReady: true, duration: 83 });
    expect(next.items[0]).toMatchObject({ id: 'a', thumb: 'data:x', thumbReady: true, duration: 83, name: 'a.mp4' });
    expect(next.items[1]).toBe(list.items[1]);
    expect(next.activeId).toBe('a');
    expect(list.items[0].thumb).toBeNull();
  });
  it('已經拿掉的 → 原樣', () => {
    expect(updateMediaItem(list, 'zzz', { thumbReady: true })).toBe(list);
  });
});

describe('thumbnailTime（影片縮圖抓哪一秒）', () => {
  it('長片抓 10%', () => {
    expect(thumbnailTime(180)).toBeCloseTo(18);
    expect(thumbnailTime(30)).toBeCloseTo(3);
  });
  it('短片至少 1 秒；比 2 秒還短抓一半', () => {
    expect(thumbnailTime(5)).toBe(1);
    expect(thumbnailTime(1)).toBe(0.5);
  });
  it('不知道片長 → 第一格；無限長（直播錄的 webm）→ 1 秒', () => {
    expect(thumbnailTime(0)).toBe(0);
    expect(thumbnailTime(NaN)).toBe(0);
    expect(thumbnailTime(Infinity)).toBe(1);
  });
});

describe('fitSize（縮圖整張縮進框裡）', () => {
  it('很寬的 LED 畫布 → 寬度填滿', () => {
    expect(fitSize(8800, 2024, 176, 80)).toEqual({ w: 176, h: 40 });
  });
  it('16:9 → 高度填滿', () => {
    expect(fitSize(1920, 1080, 176, 80)).toEqual({ w: 142, h: 80 });
  });
  it('直的 / 超細的也至少 1px；沒有尺寸 → 整個框', () => {
    expect(fitSize(1080, 1920, 176, 80)).toEqual({ w: 45, h: 80 });
    expect(fitSize(100000, 10, 176, 80).h).toBe(1);
    expect(fitSize(0, 0, 176, 80)).toEqual({ w: 176, h: 80 });
  });
});
