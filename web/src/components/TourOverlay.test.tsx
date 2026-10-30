// 帶著做的說明框：用伺服器端畫出第一格看（還沒量到要亮的東西 = 找不到目標）
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TourOverlay, { isTourEscape } from './TourOverlay';
import { ANIMATOR_TUTORIAL_PATH, animatorTourSteps } from '../lib/tutorial/animatorTour';

const steps = animatorTourSteps({ ledHasPicture: false, producerNames: ['王小明'] });
const indexOf = (id: string) => steps.findIndex(s => s.id === id);

const render = (index: number, over: Partial<Parameters<typeof TourOverlay>[0]> = {}) => renderToStaticMarkup(
  <TourOverlay steps={steps} index={index} onIndex={() => {}} onClose={() => {}} stepDone={false} tutorialHref={ANIMATOR_TUTORIAL_PATH} {...over} />,
);

describe('TourOverlay：說明框', () => {
  it('標題、內容、第幾步 / 共幾步', () => {
    const html = render(1);
    expect(html).toContain('這是你的歌');
    expect(html).toContain('2 / 10');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    expect(html).toContain('aria-labelledby=');
  });

  it('第一步沒有「上一步」，有「下一步」和「跳過」', () => {
    const html = render(0);
    expect(html).not.toContain('上一步');
    expect(html).toContain('下一步');
    expect(html).toContain('跳過');
  });

  it('中間的步驟有「上一步」', () => {
    expect(render(3)).toContain('上一步');
  });

  it('找不到目標：沒有亮框，說明框放中間，內容後面接 missingHint', () => {
    const i = indexOf('help');
    const html = render(i);
    expect(html).not.toContain('tour__spot');
    expect(html).toContain('tour__bubble--center');
    expect(html).toContain(steps[i].missingHint!);
    expect(html).toContain('卡住了怎麼辦');
  });

  it('沒有要亮的東西的步驟（歡迎）：整個畫面變暗、說明框放中間', () => {
    const html = render(0);
    expect(html).toContain('tour__dim');
    expect(html).toContain('tour__bubble--center');
  });

  it('最後一步是「完成」，有「打開上手教學」連到教學頁（開新分頁）', () => {
    const html = render(steps.length - 1);
    expect(html).toContain('完成');
    expect(html).not.toContain('下一步');
    expect(html).toContain('打開上手教學');
    expect(html).toContain(`href="${ANIMATOR_TUTORIAL_PATH}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('王小明');
  });

  it('不是最後一步就沒有「打開上手教學」', () => {
    expect(render(4)).not.toContain('打開上手教學');
  });

  it('做到了（stepDone）→ 換成「成功了」的標題和內容', () => {
    const i = indexOf('local-file');
    const before = render(i);
    const after = render(i, { stepDone: true });
    expect(before).toContain('把你的動畫放上去');
    expect(before).not.toContain('成功了');
    expect(after).toContain('成功了');
    expect(after).toContain('這就是你的動畫在舞台上的樣子');
    expect(after).not.toContain('把你的動畫放上去');
  });

  it('沒有 done 文字的步驟，stepDone 不影響', () => {
    const i = indexOf('stage');
    expect(render(i, { stepDone: true })).toContain('轉轉看舞台');
  });

  it('步數超出範圍不會壞', () => {
    expect(render(99)).toBe('');
  });

  it('沒有英文角色字、沒有 emoji', () => {
    for (let i = 0; i < steps.length; i++) {
      const text = render(i).replace(/<[^>]*>/g, ' ');
      expect(text).not.toMatch(/admin|animator|director|producer/i);
    }
  });
});

describe('Esc = 跳過', () => {
  it('Esc 算跳過；別人已經處理掉的 Esc（例如關選單）、其他鍵不算', () => {
    expect(isTourEscape({ key: 'Escape', defaultPrevented: false })).toBe(true);
    expect(isTourEscape({ key: 'Escape', defaultPrevented: true })).toBe(false);
    expect(isTourEscape({ key: ' ', defaultPrevented: false })).toBe(false);
    expect(isTourEscape({ key: 'Enter', defaultPrevented: false })).toBe(false);
  });
});
