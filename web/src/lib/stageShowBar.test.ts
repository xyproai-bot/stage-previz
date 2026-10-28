// 全螢幕預演小條的資料（換歌 / 換 cue / 視角）和畫面規則。規則本身在 stageShow.ts，畫面在 StageShowBar.tsx / StageShow.css。
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { buildCueNav, buildSongNav, hasShowViews, STAGE_SHOW_HOST_ATTR, type StageShowInfo } from './stageShow';
import StageShowBar from '../components/StageShowBar';

const noop = () => {};

describe('小條上的上一首 / 下一首歌', () => {
  const songs = [{ id: 'a', label: 'S01 開場' }, { id: 'b', label: 'S02 主歌' }, { id: 'c', label: 'S03 安可' }];

  it('中間那首：前後都有，按了會選到那首歌', () => {
    const picked: string[] = [];
    const nav = buildSongNav(songs, 'b', id => picked.push(id));
    expect(nav?.prev?.label).toBe('S01 開場');
    expect(nav?.next?.label).toBe('S03 安可');
    nav?.prev?.onSelect();
    nav?.next?.onSelect();
    expect(picked).toEqual(['a', 'c']);
  });

  it('第一首沒有上一首、最後一首沒有下一首（按鈕變灰）', () => {
    expect(buildSongNav(songs, 'a', noop)?.prev).toBeNull();
    expect(buildSongNav(songs, 'a', noop)?.next?.label).toBe('S02 主歌');
    expect(buildSongNav(songs, 'c', noop)?.next).toBeNull();
    expect(buildSongNav(songs, 'c', noop)?.prev?.label).toBe('S02 主歌');
  });

  it('只有一首、現在這首不在清單裡、還沒選 → 不放這一段', () => {
    expect(buildSongNav([songs[0]], 'a', noop)).toBeUndefined();
    expect(buildSongNav([], 'a', noop)).toBeUndefined();
    expect(buildSongNav(songs, 'zzz', noop)).toBeUndefined();
    expect(buildSongNav(songs, null, noop)).toBeUndefined();
  });
});

describe('小條上的上一個 / 下一個 cue', () => {
  const cues = [{ id: 'c1', name: '開場' }, { id: 'c2', name: '副歌' }, { id: 'c3', name: '尾奏' }];

  it('現在是第幾個、叫什麼；前後都能走', () => {
    const steps: number[] = [];
    const nav = buildCueNav(cues, 'c2', d => steps.push(d));
    expect(nav).toMatchObject({ number: 2, total: 3, name: '副歌' });
    nav?.onPrev?.();
    nav?.onNext?.();
    expect(steps).toEqual([-1, 1]);
  });

  it('第一個不能再往前、最後一個不能再往後', () => {
    expect(buildCueNav(cues, 'c1', noop)).toMatchObject({ number: 1, onPrev: null });
    expect(buildCueNav(cues, 'c1', noop)?.onNext).toBeTypeOf('function');
    expect(buildCueNav(cues, 'c3', noop)).toMatchObject({ number: 3, onNext: null });
    expect(buildCueNav(cues, 'c3', noop)?.onPrev).toBeTypeOf('function');
  });

  it('還沒選 cue：編號 0、可以往後走到第一個，不能往前', () => {
    const nav = buildCueNav(cues, null, noop);
    expect(nav).toMatchObject({ number: 0, total: 3, name: '', onPrev: null });
    expect(nav?.onNext).toBeTypeOf('function');
  });

  it('這首歌沒有 cue → 不放這一段', () => {
    expect(buildCueNav([], null, noop)).toBeUndefined();
  });
});

describe('視角選單', () => {
  it('兩組都沒東西才不放「視角」按鈕', () => {
    expect(hasShowViews(undefined)).toBe(false);
    expect(hasShowViews([])).toBe(false);
    expect(hasShowViews([{ title: '專案的視角', items: [] }])).toBe(false);
    expect(hasShowViews([{ title: '常用看台視角', items: [{ id: 'front', label: '正面全景', onSelect: noop }] }])).toBe(true);
  });
});

describe('小條長什麼樣子（只看有哪些按鈕，不開瀏覽器）', () => {
  const html = (info: StageShowInfo, views?: Parameters<typeof StageShowBar>[0]['views']) => renderToStaticMarkup(
    createElement(StageShowBar, { visible: true, info, views, onExit: noop }),
  );
  const full: StageShowInfo = {
    title: 'S02 主歌',
    transport: { playing: false, time: 12, duration: 225, onTogglePlay: noop },
    songNav: { prev: { label: 'S01 開場', onSelect: noop }, next: null },
    cueNav: { number: 2, total: 3, name: '副歌', onPrev: noop, onNext: noop },
  };

  it('全部都有：換歌、播放 + 時間、換 cue（編號 + 名字）、視角、離開，按鈕都有中文提示', () => {
    const out = html(full, [{ title: '常用看台視角', items: [{ id: 'front', label: '正面全景', onSelect: noop }] }]);
    for (const t of [
      'aria-label="上一首"', 'aria-label="下一首"', 'aria-label="播放"', '0:12 / 3:45', 'aria-label="上一個 cue"',
      'aria-label="下一個 cue"', '副歌', 'aria-label="視角"', 'aria-label="離開全螢幕預演"', 'S02 主歌',
    ]) {
      expect(out, t).toContain(t);
    }
    expect(out).toContain('title="上一首：S01 開場"');
    // 沒有下一首 → 下一首灰掉；上一首、換 cue 都能按
    expect(out).toMatch(/<button[^>]*aria-label="下一首"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="下一首"/);
    expect(out).not.toMatch(/<button[^>]*aria-label="上一首"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="上一首"/);
    // 視角選單平常不展開
    expect(out).not.toContain('role="menu"');
  });

  it('頁面沒給的就不放：只有歌名時不出現換歌、換 cue、視角、播放', () => {
    const out = html({ title: '舞台' });
    expect(out).toContain('舞台');
    for (const t of ['aria-label="上一首"', 'aria-label="下一首"', 'aria-label="上一個 cue"', 'aria-label="視角"', 'aria-label="播放"']) {
      expect(out, t).not.toContain(t);
    }
    expect(out).toContain('aria-label="離開全螢幕預演"');
  });

  it('cue 到頭：上一個灰掉；還沒選 cue 時寫「還沒選 cue」', () => {
    const first = html({ cueNav: { number: 1, total: 3, name: '開場', onPrev: null, onNext: noop } });
    expect(first).toMatch(/<button[^>]*aria-label="上一個 cue"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="上一個 cue"/);
    expect(first).not.toMatch(/<button[^>]*aria-label="下一個 cue"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="下一個 cue"/);
    expect(html({ cueNav: { number: 0, total: 3, name: '', onPrev: null, onNext: noop } })).toContain('還沒選 cue');
  });

  it('小條沒顯示的時候，按鈕不能用 Tab 選到', () => {
    const out = renderToStaticMarkup(createElement(StageShowBar, { visible: false, info: full, onExit: noop }));
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain('tabindex="0"');
  });
});

describe('全螢幕預演的畫面規則（StageShow.css）', () => {
  const css = new TextDecoder().decode(readFileSync(new URL('../components/StageShow.css', import.meta.url)));
  // 去掉註解再比對，註解裡提到的選擇器不算
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('3D 舞台裡預設全部藏起來，只留：畫面、小條、浮水印、物件名稱', () => {
    const m = rules.match(/\.stage-scene\.is-show > ((?::not\([^)]*\))+) \{ display: none !important; \}/);
    expect(m, '找不到「預演中藏起所有直接放在 .stage-scene 下的東西」那條規則').not.toBeNull();
    const kept = [...(m as RegExpMatchArray)[1].matchAll(/:not\(([^)]*)\)/g)].map(x => x[1]).sort();
    expect(kept).toEqual(['.stage-scene__labels', '.stage-show-bar', '.wm-overlay', 'canvas']);
  });

  it('套在外層的全螢幕：外層裡 3D 舞台以外的東西（小播放器、徽章）也藏起來；CSS 模式蓋滿視窗', () => {
    expect(STAGE_SHOW_HOST_ATTR).toBe('data-stage-show-host');
    expect(rules).toContain('[data-stage-show-host]:not(.stage-scene) > :not(.stage-scene) { display: none !important; }');
    expect(rules).toMatch(/\[data-stage-show-host="css"\] \{[^}]*position: fixed !important;[^}]*height: 100dvh !important;/);
  });

  it('頁面右下角的小通知在預演中也不出現', () => {
    expect(rules).toContain('html[data-stage-show="1"] .toast-container { display: none !important; }');
  });
});
