import { describe, it, expect } from 'vitest';
import { parseTemplateList } from './ledTemplateApi';
import { itemFromShareVideo, itemFromVideo } from './songVersions';
import type { SongVideo } from './videoApi';

const planJson = {
  v: 1, id: 'lt_1', name: '中間底幕', canvas: { width: 4400, height: 200 }, scalePct: 50,
  screens: [{ key: 'o:oa', objectId: 'oa', uv: null, dest: { x: 0, y: 0, w: 4400, h: 200 }, rotate: 0, flipH: false, flipV: false }],
};

describe('parseTemplateList：後台給的版型清單', () => {
  it('「全部」的畫布跟著專案；自訂版型的放法讀得進來；手動切的螢幕', () => {
    const list = parseTemplateList({
      fullCanvas: { width: 8800, height: 2024 },
      templates: [
        { id: 'lt_full_p', kind: 'full', name: '全部', canvas: { width: 8800, height: 2024 }, scalePct: 100, sortOrder: 0, songCount: 0, screens: [] },
        { ...planJson, kind: 'custom', sortOrder: 1, songCount: 2 },
      ],
      screens: [{ id: 'ls1', objectId: 'oa', name: '左半', uv: [0, 0, 0.5, 1], sortOrder: 1 }],
    });
    expect(list.fullCanvas).toEqual({ width: 8800, height: 2024 });
    expect(list.templates.map(t => [t.id, t.kind, t.canvas.width])).toEqual([['lt_full_p', 'full', 8800], ['lt_1', 'custom', 4400]]);
    expect(list.templates[1].songCount).toBe(2);
    expect(list.templates[1].screens[0].key).toBe('o:oa');
    expect(list.screens).toEqual([{ id: 'ls1', objectId: 'oa', name: '左半', uv: [0, 0, 0.5, 1] }]);
  });
  it('專案還沒填 LED 畫布：「全部」的畫布是 0×0（畫面不會拿來用），照樣讀得進來', () => {
    const list = parseTemplateList({ fullCanvas: null, templates: [{ id: 'f', kind: 'full', name: '全部', canvas: null, scalePct: 100, screens: [] }], screens: [] });
    expect(list.fullCanvas).toBeNull();
    expect(list.templates[0].canvas).toEqual({ width: 0, height: 0 });
  });
  it('壞資料不會讓畫面掛掉', () => {
    expect(parseTemplateList(null)).toEqual({ fullCanvas: null, templates: [], screens: [] });
    expect(parseTemplateList({ templates: [null, { id: 5 }, { id: 'x', kind: 'custom', name: 'n', canvas: { width: 2, height: 2 }, screens: [] }], screens: [{ id: 1 }] }).templates).toEqual([]);
  });
});

describe('影片版本帶著做的時候的版型', () => {
  const video = (template?: unknown): SongVideo => ({
    id: 'sv1', projectId: 'p', songId: 's', version: 2, label: 'V2', title: '', note: '', source: 'upload', originalUrl: null, driveFileId: null,
    mime: 'video/mp4', sizeBytes: 1, width: 2200, height: 100, durationSec: 1, status: 'ready', error: null, progress: null, createdBy: null,
    createdAt: 'x', updatedAt: 'x', readyAt: 'x', isLatest: true, streamUrl: '/api/x', ...(template !== undefined ? { template } : {}),
  });
  const abs = (u: string) => 'https://x' + u;
  it('成員看到的一版：template 讀成 plan；沒有 / 壞掉 = null（整張畫布）；舊的後台沒有這欄也行', () => {
    expect(itemFromVideo(video(planJson), abs).template?.name).toBe('中間底幕');
    expect(itemFromVideo(video(null), abs).template).toBeNull();
    expect(itemFromVideo(video(), abs).template).toBeNull();
    expect(itemFromVideo(video({ nonsense: true }), abs).template).toBeNull();
  });
  it('分享連結看到的一版也一樣', () => {
    const v = { id: 'sv1', songId: 's', version: 2, label: 'V2', title: '', mime: 'video/mp4', sizeBytes: 1, width: 1, height: 1, durationSec: 1, createdAt: 'x', readyAt: 'x', streamUrl: '/x' };
    expect(itemFromShareVideo({ ...v, template: planJson }, abs).template?.screens.length).toBe(1);
    expect(itemFromShareVideo(v, abs).template).toBeNull();
  });
});
