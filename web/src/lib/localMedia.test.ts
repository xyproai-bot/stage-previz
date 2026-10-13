import { describe, it, expect } from 'vitest';
import {
  activeMediaItem, addMediaItems, EMPTY_MEDIA_LIST, mediaFileKey, mediaKindOf,
  removeMediaItem, selectMediaItem, skippedFilesMessage, splitMediaFiles,
  type LocalMediaItem, type LocalMediaKind,
} from './localMedia';

const item = (id: string, kind: LocalMediaKind = 'video', key = id): LocalMediaItem => ({
  id, key, name: `${id}.${kind === 'video' ? 'mp4' : 'png'}`, kind, file: {} as File, url: kind === 'image' ? `blob:${id}` : null,
});

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
