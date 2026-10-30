// 教學頁的內容資料：八段、編號、id 不重複、「想知道更多」都連得到說明頁真的有的段落、圖片檔真的存在、沒有英文角色字
import { describe, expect, it } from 'vitest';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { ANIMATOR_TUTORIAL, ANIMATOR_TUTORIAL_VIDEO, type TutorialStep } from './animatorTutorialContent';
import { HELP_ANCHORS } from '../helpLinks';

const allSteps: TutorialStep[] = ANIMATOR_TUTORIAL.flatMap(s => s.steps);
const text = (n: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, n)).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
/** 一個段落 / step 裡所有給人讀的字 */
const stepText = (s: TutorialStep) => [s.title, text(s.lead), ...(s.actions ?? []).map(text), ...(s.more ?? []).map(m => m.label), s.media?.alt ?? ''].join(' ');

describe('動畫師上手教學的內容', () => {
  it('八段，編號 1 到 8，照順序', () => {
    expect(ANIMATOR_TUTORIAL).toHaveLength(8);
    expect(ANIMATOR_TUTORIAL.map(s => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ANIMATOR_TUTORIAL.map(s => s.title)).toEqual([
      '先看這裡', '第一次登入', '開工前：把 AE 合成做對', '做的時候在舞台上看', '交一版', '錄成影片給導演', '導演有意見時', '卡住了',
    ]);
  });

  it('每一段有摘要，裡面有一到數個 step', () => {
    for (const sec of ANIMATOR_TUTORIAL) {
      expect(sec.summary.length, sec.id).toBeGreaterThan(0);
      expect(sec.steps.length, sec.id).toBeGreaterThan(0);
    }
  });

  it('段落和 step 的 id 不重複（網址 #id 才指得到唯一一個）', () => {
    const ids = [...ANIMATOR_TUTORIAL.map(s => s.id), ...allSteps.map(s => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('每個 step 有標題和一段話', () => {
    for (const s of allSteps) {
      expect(s.title.length, s.id).toBeGreaterThan(0);
      expect(text(s.lead).trim().length, s.id).toBeGreaterThan(0);
    }
  });

  it('「想知道更多」每一條都連到說明頁真的有的段落', () => {
    const valid = new Set<string>(Object.values(HELP_ANCHORS));
    let n = 0;
    for (const s of allSteps) {
      for (const m of s.more ?? []) {
        n++;
        expect(valid.has(m.anchor), `${s.id} → ${m.anchor}`).toBe(true);
        expect(m.label.length).toBeGreaterThan(0);
      }
    }
    expect(n).toBeGreaterThan(8);
  });

  it('每段最後都有可以看更多的連結', () => {
    for (const sec of ANIMATOR_TUTORIAL) {
      expect(sec.steps.some(s => (s.more ?? []).length > 0), sec.id).toBe(true);
    }
  });

  it('圖片檔真的在 web/public 底下，也有替代文字', () => {
    let n = 0;
    for (const s of allSteps) {
      if (!s.media) continue;
      n++;
      expect(s.media.src, s.id).toMatch(/^\/help\//);
      expect(existsSync(new URL('../../../public' + s.media.src, import.meta.url)), `${s.id}: ${s.media.src}`).toBe(true);
      expect(s.media.alt.length, s.id).toBeGreaterThan(0);
    }
    expect(n).toBeGreaterThan(5);
  });

  it('沒有英文角色字', () => {
    for (const s of allSteps) expect(stepText(s), s.id).not.toMatch(/\b(users?|admins?|directors?|animators?|producers?)\b/i);
    for (const sec of ANIMATOR_TUTORIAL) expect(sec.title + sec.summary).not.toMatch(/\b(users?|admins?|directors?|animators?|producers?)\b/i);
  });

  it('找人的時候一律寫「製作」，最後一段寫到「邀請你進來的製作」', () => {
    const last = ANIMATOR_TUTORIAL[7];
    expect(last.steps.map(stepText).join(' ')).toContain('邀請你進來的製作');
  });

  it('卡住了：最常見的五種狀況都在', () => {
    const stuck = ANIMATOR_TUTORIAL[7].steps;
    const anchors = stuck.flatMap(s => (s.more ?? []).map(m => m.anchor));
    for (const a of [HELP_ANCHORS.faqBlack, HELP_ANCHORS.animTestPattern, HELP_ANCHORS.qUpload, HELP_ANCHORS.faqBlocked, HELP_ANCHORS.faqSafari]) {
      expect(anchors).toContain(a);
    }
  });

  it('教學影片第三階段才做：現在是 null（頁面不顯示那一塊）', () => {
    expect(ANIMATOR_TUTORIAL_VIDEO).toBeNull();
  });
});
