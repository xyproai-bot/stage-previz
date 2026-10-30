// 動畫師上手教學頁：用伺服器端畫出來看（八段標題、目錄、短片 / 圖片、連到說明頁、不用登入）
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import AnimatorTutorial from './AnimatorTutorial';
import TutorialMedia from '../components/TutorialMedia';
import { ANIMATOR_TUTORIAL, ANIMATOR_TUTORIAL_VIDEO } from '../lib/tutorial/animatorTutorialContent';
import { ANIMATOR_TUTORIAL_PATH } from '../lib/tutorial/animatorTour';

const appSource = (Object.values(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true })) as string[])[0];

const render = () => renderToStaticMarkup(
  <StaticRouter location={ANIMATOR_TUTORIAL_PATH}>
    <AnimatorTutorial />
  </StaticRouter>,
);

describe('AnimatorTutorial：教學頁', () => {
  const html = render();

  it('標題、副標、連回使用說明', () => {
    expect(html).toContain('動畫師上手教學');
    expect(html).toContain('照著做一次就會。你在 AE 裡的做法不用改。');
    expect(html).toContain('href="/help"');
  });

  it('八段的標題都在，每段有自己的 id', () => {
    expect(ANIMATOR_TUTORIAL).toHaveLength(8);
    for (const sec of ANIMATOR_TUTORIAL) {
      expect(html, sec.title).toContain(sec.title);
      expect(html).toContain(`id="${sec.id}"`);
    }
  });

  it('每個 step 都畫出來了，有自己的 id', () => {
    for (const step of ANIMATOR_TUTORIAL.flatMap(s => s.steps)) {
      expect(html, step.id).toContain(`id="${step.id}"`);
      expect(html).toContain(step.title);
    }
  });

  it('目錄有八個連結，各連到一段', () => {
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    const links = nav.match(/<a /g) ?? [];
    expect(links).toHaveLength(8);
    for (const sec of ANIMATOR_TUTORIAL) expect(nav).toContain(`href="#${sec.id}"`);
  });

  it('沒有教學影片（ANIMATOR_TUTORIAL_VIDEO 是 null）時，沒有影片區塊', () => {
    expect(ANIMATOR_TUTORIAL_VIDEO).toBeNull();
    expect(html).not.toContain('tut-video');
    expect(html).not.toContain('<video');
  });

  it('「想知道更多」連到說明頁的段落', () => {
    expect(html).toContain('想知道更多');
    expect(html).toContain('href="/help#anim-source"');
    expect(html).toContain('href="/help#faq-black"');
    expect(html).toContain('href="/help#q-upload"');
  });

  it('最後一步寫「找邀請你進來的製作」', () => {
    expect(html).toContain('還是不行，找邀請你進來的製作。');
    expect(html.split('還是不行，找邀請你進來的製作。')).toHaveLength(2);   // 只寫一次
  });

  it('圖片是延遲載入、有替代文字', () => {
    expect(html).toContain('loading="lazy"');
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(5);
    for (const img of imgs) expect(img).toMatch(/alt="[^"]+"/);
  });

  it('沒有英文角色字', () => {
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).not.toMatch(/\b(users?|admins?|directors?|animators?|producers?)\b/i);
  });
});

describe('TutorialMedia：圖片和短片', () => {
  it('圖片：延遲載入', () => {
    const out = renderToStaticMarkup(<TutorialMedia item={{ kind: 'image', src: '/help/animator/compare.webp', alt: '比較', width: 600, height: 583 }} />);
    expect(out).toContain('<img');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('alt="比較"');
  });

  it('短片：沒聲音、循環、自動播、行內播放、有封面和說明', () => {
    const out = renderToStaticMarkup(<TutorialMedia item={{ kind: 'clip', src: '/help/tutorial/a.mp4', poster: '/help/tutorial/a.webp', alt: '示範' }} />);
    expect(out).toContain('<video');
    expect(out).toMatch(/muted/);
    expect(out).toMatch(/loop/);
    expect(out).toMatch(/autoPlay|autoplay/);
    expect(out).toMatch(/playsInline|playsinline/);
    expect(out).toContain('poster="/help/tutorial/a.webp"');
    expect(out).toContain('preload="metadata"');
    expect(out).toContain('aria-label="示範"');
  });
});

describe('路由', () => {
  it('/tutorial/animator 不用登入（跟說明頁一樣，沒有包 RequireAuth）', () => {
    const line = appSource.split('\n').find(l => l.includes('ANIMATOR_TUTORIAL_PATH') && l.includes('<Route'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('RequireAuth');
    expect(line).toContain('<AnimatorTutorial />');
    expect(ANIMATOR_TUTORIAL_PATH).toBe('/tutorial/animator');
  });
});
