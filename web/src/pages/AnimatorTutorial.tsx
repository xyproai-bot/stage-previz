// 動畫師上手教學（/tutorial/animator）：不用登入。照做一首歌的順序，八段、每段一張卡。
//   內容在 lib/tutorial/animatorTutorialContent.tsx（這個檔案只負責排版）；圖片 / 短片在 components/TutorialMedia.tsx。
//   寬畫面：左邊固定的目錄（捲到哪一段就亮哪一段）；窄畫面：目錄變成上面一排可以左右滑的小按鈕（只有那一排可以左右滑，整頁不行）。
//   網址帶 #段落id 或 #step-id 打開會捲到那裡。
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import Icon from '../components/Icon';
import TutorialMedia from '../components/TutorialMedia';
import { ANIMATOR_TUTORIAL, ANIMATOR_TUTORIAL_VIDEO, type TutorialSection, type TutorialStep } from '../lib/tutorial/animatorTutorialContent';
import { HELP_PATH, helpUrl } from '../lib/helpLinks';
import './AnimatorTutorial.css';

export const TUTORIAL_TITLE = '動畫師上手教學';
const DOC_TITLE = `${TUTORIAL_TITLE} — STAGE PREVIZ`;

/** 捲到哪一段就亮哪一段：段落的上緣過了「上方列 + 目錄」的下面就算讀到了；捲到最底 = 最後一段 */
function useCurrentSection(ids: string[]): string {
  const [current, setCurrent] = useState(ids[0] ?? '');
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const offset = cssOffset();
      let found = ids[0] ?? '';
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= offset + 24) found = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) found = ids[ids.length - 1] ?? found;
      setCurrent(found);
    };
    const onScroll = () => { if (!raf) raf = window.requestAnimationFrame(check); };
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [ids, setCurrent]);
  return current;
}

/** 固定在上面的東西（上方列 + 窄畫面的目錄）有多高：段落捲過去要讓開 */
function cssOffset(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tut-offset'));
  return Number.isFinite(v) ? v : 64;
}

function flash(el: HTMLElement): () => void {
  el.classList.remove('is-flash');
  void el.offsetWidth;  // 重新播放亮一下的動畫
  el.classList.add('is-flash');
  const t = window.setTimeout(() => el.classList.remove('is-flash'), 1800);
  return () => window.clearTimeout(t);
}

/**
 * 網址的 #id → 捲過去、亮一下。第一次打開時圖片陸續載入會讓位置跑掉：2.5 秒內、使用者沒自己捲，再對一次。
 */
function useHashScroll(hash: string) {
  const first = useRef(true);
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    const smooth = !first.current;
    first.current = false;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: smooth && !reduced ? 'smooth' : 'auto', block: 'start' });
    const stopFlash = flash(el);
    if (smooth) return stopFlash;

    let userMoved = false;
    const stop = () => { userMoved = true; };
    const onLoad = (e: Event) => {
      if (!userMoved && e.target instanceof HTMLImageElement) el.scrollIntoView({ behavior: 'auto', block: 'start' });
    };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchmove', stop, { passive: true });
    window.addEventListener('keydown', stop);
    window.addEventListener('pointerdown', stop);
    document.addEventListener('load', onLoad, true);
    const done = window.setTimeout(cleanup, 2500);
    function cleanup() {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
      window.removeEventListener('keydown', stop);
      window.removeEventListener('pointerdown', stop);
      document.removeEventListener('load', onLoad, true);
      window.clearTimeout(done);
    }
    return () => { cleanup(); stopFlash(); };
  }, [hash]);
}

function StepView({ step }: { step: TutorialStep }) {
  return (
    <article id={step.id} className="tut-step" aria-labelledby={`${step.id}-title`}>
      <h3 id={`${step.id}-title`} className="tut-step__title">{step.title}</h3>
      <p className="tut-step__lead">{step.lead}</p>
      {step.actions && step.actions.length > 0 && (
        <ol className="tut-actions">
          {step.actions.map((a, i) => <li key={i}>{a}</li>)}
        </ol>
      )}
      {step.media && <TutorialMedia item={step.media} />}
      {step.more && step.more.length > 0 && (
        <p className="tut-more">
          <span className="tut-more__label">想知道更多</span>
          {step.more.map(m => (
            <Link key={m.anchor + m.label} className="tut-more__link" to={helpUrl(m.anchor)}>{m.label}</Link>
          ))}
        </p>
      )}
    </article>
  );
}

function SectionCard({ sec }: { sec: TutorialSection }) {
  return (
    <section id={sec.id} className="tut-card" aria-labelledby={`${sec.id}-title`}>
      <header className="tut-card__head">
        <span className="tut-card__num" aria-hidden="true">{sec.number}</span>
        <div className="tut-card__head-text">
          <h2 id={`${sec.id}-title`} className="tut-card__title">{sec.title}</h2>
          <p className="tut-card__summary">{sec.summary}</p>
        </div>
      </header>
      {sec.steps.map(step => <StepView key={step.id} step={step} />)}
    </section>
  );
}

export default function AnimatorTutorial() {
  const location = useLocation();
  const navigate = useNavigate();
  const tocRef = useRef<HTMLElement>(null);
  const ids = useMemo(() => ANIMATOR_TUTORIAL.map(s => s.id), []);
  const current = useCurrentSection(ids);

  useHashScroll(location.hash);

  useEffect(() => {
    const prev = document.title;
    document.title = DOC_TITLE;
    return () => { document.title = prev; };
  }, []);

  // 窄畫面的目錄是橫的一排：讀到的那一格跑出可見範圍時，只把那一排往旁邊捲（不動整頁）
  useEffect(() => {
    const nav = tocRef.current;
    const a = nav?.querySelector<HTMLElement>('a.is-current');
    if (!nav || !a || nav.scrollWidth <= nav.clientWidth) return;
    const left = a.offsetLeft - nav.clientWidth / 2 + a.clientWidth / 2;
    nav.scrollLeft = Math.max(0, left);
  }, [current]);

  const jump = useCallback((e: MouseEvent, id: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate({ hash: '#' + id });
  }, [navigate]);

  return (
    <div className="tut">
      <header className="tut-top">
        <a className="tut-top__brand" href="/"><span className="brand-mark" aria-hidden="true" />STAGE PREVIZ</a>
        <span className="tut-top__title">{TUTORIAL_TITLE}</span>
        <span className="tut-top__grow" />
        <Link className="tut-top__help" to={HELP_PATH}><Icon icon={BookOpen} /> 使用說明</Link>
      </header>

      <div className="tut-layout">
        <nav ref={tocRef} className="tut-toc" aria-label="目錄">
          <div className="tut-toc__heading">目錄</div>
          <ol className="tut-toc__list">
            {ANIMATOR_TUTORIAL.map(sec => (
              <li key={sec.id}>
                <a
                  href={'#' + sec.id}
                  className={'tut-toc__link' + (current === sec.id ? ' is-current' : '')}
                  aria-current={current === sec.id ? 'location' : undefined}
                  onClick={e => jump(e, sec.id)}
                >
                  <span className="tut-toc__num" aria-hidden="true">{sec.number}</span>
                  <span className="tut-toc__text">{sec.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <main className="tut-main">
          <div className="tut-hero">
            <div className="tut-hero__kicker">STAGE PREVIZ</div>
            <h1>{TUTORIAL_TITLE}</h1>
            <p className="tut-hero__lead">照著做一次就會。你在 AE 裡的做法不用改。</p>
            <p className="tut-hero__sub">想查細節的時候，看 <Link to={HELP_PATH}>使用說明</Link>。</p>
          </div>

          {ANIMATOR_TUTORIAL_VIDEO && (
            <section className="tut-video" aria-label="教學影片">
              <video controls preload="metadata" poster={ANIMATOR_TUTORIAL_VIDEO.poster} src={ANIMATOR_TUTORIAL_VIDEO.src} />
            </section>
          )}

          {ANIMATOR_TUTORIAL.map(sec => <SectionCard key={sec.id} sec={sec} />)}

          <footer className="tut-footer">
            <p><Link to={HELP_PATH}>看完整的使用說明</Link></p>
          </footer>
        </main>
      </div>
    </div>
  );
}
