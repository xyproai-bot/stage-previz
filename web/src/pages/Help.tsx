// 線上使用說明（/help）：不用登入，給動畫師看的圖文步驟。目前只有「AE 即時預覽」這一章。
// 段落 id 在 lib/helpLinks.ts（分享頁、檢查清單卡片、設定頁會直接連到某一段，不要隨便改）；
// 圖片和紅框在 helpFigures.ts。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { HELP_ANCHORS as A, type HelpAnchor } from '../lib/helpLinks';
import { NDI_HELPER_DOWNLOAD_URL, NDI_HELPER_DOWNLOAD_URL_MAC, NDI_TOOLS_URL } from '../lib/downloads';
import { NDI_AUTOSTART_NOTE, OLD_HELPER_HINT, PERMISSION_PROMPT_TEXT, permissionFixSteps } from '../lib/ndiSteps';
import { FIGS, type FigKey, type HelpFig } from './helpFigures';
import './Help.css';

// ─── 目錄 ───

export interface HelpTocItem {
  id: HelpAnchor;
  label: string;
  children?: HelpTocItem[];
}

export const HELP_TOC: HelpTocItem[] = [
  { id: A.aeLive, label: 'AE 即時預覽是什麼' },
  { id: A.whatYouNeed, label: '要準備什麼' },
  {
    id: A.setup, label: '第一次設定（只要一次）', children: [
      { id: A.installNdiTools, label: '① 裝 NDI Tools' },
      {
        id: A.installHelper, label: '② 裝 NDI 小程序', children: [
          { id: A.installHelperWindows, label: 'Windows' },
          { id: A.installHelperMac, label: 'Mac' },
        ],
      },
      { id: A.aeNdiOutput, label: '③ AE 打開 NDI 輸出' },
      { id: A.chromeAllow, label: '④ 瀏覽器按「允許」' },
    ],
  },
  { id: A.use, label: '每次使用' },
  { id: A.resolution, label: '建議的預覽解析度' },
  { id: A.chooseSource, label: '有好幾台 AE：選來源' },
  {
    id: A.faq, label: '常見問題', children: [
      { id: A.faqWaitingFrames, label: 'AE 沒在送畫面 / 停住了' },
      { id: A.faqBlack, label: 'LED 一片黑' },
      { id: A.faqNoAe, label: '找不到 AE' },
      { id: A.faqNoHelper, label: '沒有偵測到 NDI 小程序' },
      { id: A.faqOutdated, label: '小程序有新版' },
      { id: A.faqNoNdiTools, label: '請先安裝 NDI Tools' },
      { id: A.faqBlocked, label: '瀏覽器擋住了' },
      { id: A.faqSafari, label: 'Safari 不支援' },
      { id: A.faqAutostart, label: '沒辦法開機自動啟動' },
    ],
  },
];

function flatToc(items: HelpTocItem[]): HelpTocItem[] {
  return items.flatMap(i => [i, ...flatToc(i.children ?? [])]);
}

// ─── 捲到某一段 ───

const TOP_OFFSET = 64;

/** 網址的 #段落 → 捲過去、亮一下；圖片陸續載入讓位置跑掉時（2.5 秒內、使用者沒自己捲）再對一次 */
function useHashScroll(hash: string) {
  const first = useRef(true);
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    const smooth = !first.current;
    first.current = false;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const align = (behavior: ScrollBehavior) => {
      const top = el.getBoundingClientRect().top + window.scrollY - TOP_OFFSET + 4;
      window.scrollTo({ top: Math.max(0, top), behavior });
    };
    align(smooth ? 'smooth' : 'auto');
    el.classList.remove('is-flash');
    void el.offsetWidth;  // 重新播放亮一下的動畫
    el.classList.add('is-flash');
    const flashTimer = window.setTimeout(() => el.classList.remove('is-flash'), 1800);

    if (smooth) return () => window.clearTimeout(flashTimer);
    let userMoved = false;
    const stop = () => { userMoved = true; };
    const onLoad = (e: Event) => {
      if (!userMoved && e.target instanceof HTMLImageElement) align('auto');
    };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchmove', stop, { passive: true });
    window.addEventListener('keydown', stop);
    window.addEventListener('pointerdown', stop);
    document.addEventListener('load', onLoad, true);
    document.addEventListener('error', onLoad, true);
    const done = window.setTimeout(cleanup, 2500);
    function cleanup() {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
      window.removeEventListener('keydown', stop);
      window.removeEventListener('pointerdown', stop);
      document.removeEventListener('load', onLoad, true);
      document.removeEventListener('error', onLoad, true);
    }
    return () => { cleanup(); window.clearTimeout(done); window.clearTimeout(flashTimer); };
  }, [hash]);
}

/** 目前讀到哪一段（目錄亮那一格） */
function useCurrentSection(ids: string[]): string {
  const [current, setCurrent] = useState(ids[0] ?? '');
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      let found = ids[0] ?? '';
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= TOP_OFFSET + 24) found = id;
      }
      // 捲到最底：最後一段
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        found = ids[ids.length - 1] ?? found;
      }
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
  }, [ids]);
  return current;
}

// ─── 小元件 ───

/** 說明頁裡連到別一段 */
function useGoTo() {
  const navigate = useNavigate();
  return useCallback((e: MouseEvent, id: HelpAnchor) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate({ hash: '#' + id });
  }, [navigate]);
}

function Go({ to, children }: { to: HelpAnchor; children: ReactNode }) {
  const go = useGoTo();
  return <a href={'#' + to} onClick={e => go(e, to)}>{children}</a>;
}

/** 介面上的字（按鈕、選單） */
function Ui({ children }: { children: ReactNode }) {
  return <span className="help-ui">{children}</span>;
}

function Num({ n }: { n: number }) {
  return <span className="help-num" aria-label={`第 ${n} 個框`}>{n}</span>;
}

function Note({ kind = 'tip', title, children }: { kind?: 'tip' | 'warn'; title?: string; children: ReactNode }) {
  return (
    <div className={'help-note help-note--' + kind}>
      <span className="help-note__icon" aria-hidden>{kind === 'warn' ? '⚠' : '💡'}</span>
      <div>
        {title && <strong className="help-note__title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}

/** 圖 + 紅框；圖片還沒放進來 → 「圖片準備中」（optional → 不顯示） */
function FigImage({ fig, onMissing, zoomed = false }: { fig: HelpFig; onMissing?: () => void; zoomed?: boolean }) {
  return (
    <span className={'help-fig__frame' + (zoomed ? ' is-zoomed' : '')}>
      <img
        src={fig.src}
        alt={fig.alt}
        width={fig.w}
        height={fig.h}
        loading={zoomed || !fig.w ? 'eager' : 'lazy'}
        decoding="async"
        onError={onMissing}
      />
      {fig.boxes?.map((b, i) => (
        <span
          key={i}
          className={'help-fig__box' + (b.dashed ? ' is-dashed' : '')}
          style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}
          aria-hidden
        >
          {b.n != null && <span className="help-fig__badge">{b.n}</span>}
        </span>
      ))}
    </span>
  );
}

/** 點圖看大圖（頁面最外層給） */
const ZoomContext = createContext<(k: FigKey) => void>(() => {});

function F({ k }: { k: FigKey }) {
  const onZoom = useContext(ZoomContext);
  const fig: HelpFig = FIGS[k];
  const [missing, setMissing] = useState(false);
  if (missing && fig.optional) return null;
  const maxWidth = fig.width ?? fig.w;
  return (
    <figure className="help-fig" style={maxWidth ? { maxWidth } : undefined}>
      {missing ? (
        <div className="help-fig__placeholder" role="img" aria-label={fig.alt}>
          <span className="help-fig__placeholder-icon" aria-hidden>🖼</span>
          <span>{fig.alt}</span>
          <span className="help-fig__placeholder-sub">（圖片準備中）</span>
        </div>
      ) : (
        <button type="button" className="help-fig__zoom" onClick={() => onZoom(k)} title="點一下看大圖">
          <FigImage fig={fig} onMissing={() => setMissing(true)} />
        </button>
      )}
      {fig.caption && <figcaption>{fig.caption}</figcaption>}
    </figure>
  );
}

function Lightbox({ k, onClose }: { k: FigKey; onClose: () => void }) {
  const fig: HelpFig = FIGS[k];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="help-lightbox" role="dialog" aria-modal="true" aria-label={fig.alt} onClick={onClose}>
      <div className="help-lightbox__bar" onClick={e => e.stopPropagation()}>
        <span className="help-lightbox__title">{fig.caption ?? fig.alt}</span>
        <a href={fig.src} target="_blank" rel="noreferrer">原圖 ↗</a>
        <button type="button" onClick={onClose} aria-label="關閉">×</button>
      </div>
      <div className="help-lightbox__body">
        <FigImage fig={fig} zoomed />
      </div>
    </div>
  );
}

/** 對話框裡的原文 */
function Quote({ children }: { children: ReactNode }) {
  return <span className="help-quote">{children}</span>;
}

/** Chrome 詢問視窗的示意圖（不是真的截圖） */
function ChromePromptMock() {
  return (
    <figure className="help-fig help-mock help-mock--chrome" aria-label={`示意圖：Chrome 問「${PERMISSION_PROMPT_TEXT}」，按「允許」`}>
      <div className="help-mock__frame help-mock__frame--light">
        <span className="help-mock__tag">示意圖</span>
        <div className="help-mock__url" aria-hidden><span className="help-mock__lock">ⓘ</span> previz.haimiaan.com/s/…</div>
        <div className="help-mock__prompt" aria-hidden>
          <div className="help-mock__prompt-title">previz.haimiaan.com 想要</div>
          <div className="help-mock__prompt-row"><span>🖥</span>{PERMISSION_PROMPT_TEXT}</div>
          <div className="help-mock__prompt-btns">
            <span className="help-mock__btn">封鎖</span>
            <span className="help-mock__btn is-primary">允許<span className="help-num help-mock__num">1</span></span>
          </div>
        </div>
      </div>
      <figcaption>示意圖：① 按「允許」（不要按「封鎖」）。Edge、Firefox 的樣子不太一樣，一樣按允許。</figcaption>
    </figure>
  );
}

/** 解析度選單的示意圖（不是真的截圖；有真的截圖 win/ae-resolution.png 時兩個都會顯示） */
function ResolutionMock() {
  return (
    <figure className="help-fig help-mock" aria-label="示意圖：AE 合成視窗下方的解析度選單，選 Third">
      <div className="help-mock__frame">
        <span className="help-mock__tag">示意圖</span>
        <div className="help-mock__viewer" aria-hidden>合成視窗</div>
        <div className="help-mock__bar" aria-hidden>
          <span className="help-mock__chip">50% ▾</span>
          <span className="help-mock__chip is-on">Third ▾<span className="help-num help-mock__num">1</span></span>
          <span className="help-mock__chip">▣</span>
          <span className="help-mock__chip">0:00:12:05</span>
        </div>
        <ul className="help-mock__menu" aria-hidden>
          <li>Full</li>
          <li>Half</li>
          <li className="is-on">✓ Third</li>
          <li>Quarter</li>
          <li className="is-sep">Custom…</li>
        </ul>
      </div>
      <figcaption>示意圖：① 合成視窗正下方「Full」那個選單 → 選 Third（大畫布建議）</figcaption>
    </figure>
  );
}

function DownloadHelper({ only }: { only?: 'windows' | 'mac' }) {
  return (
    <div className="help-actions">
      {only !== 'mac' && <a className="help-btn help-btn--primary" href={NDI_HELPER_DOWNLOAD_URL}>⬇ 下載 NDI 小程序（Windows）</a>}
      {only !== 'windows' && <a className={'help-btn' + (only === 'mac' ? ' help-btn--primary' : '')} href={NDI_HELPER_DOWNLOAD_URL_MAC}>⬇ 下載 NDI 小程序（Mac）</a>}
    </div>
  );
}

function NdiToolsButton() {
  return (
    <div className="help-actions">
      <a className="help-btn help-btn--primary" href={NDI_TOOLS_URL} target="_blank" rel="noreferrer">前往 NDI Tools 下載頁（免費）↗</a>
    </div>
  );
}

function Section({ id, level = 2, title, children }: { id: HelpAnchor; level?: 2 | 3 | 4; title: ReactNode; children: ReactNode }) {
  const H = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <section id={id} className={`help-section help-section--h${level}`}>
      <H className="help-section__title">
        <a className="help-section__anchor" href={'#' + id} aria-label="這一段的連結">#</a>
        {title}
      </H>
      {children}
    </section>
  );
}

function Faq({ id, title, children }: { id: HelpAnchor; title: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="help-section help-faq">
      <h3 className="help-section__title">
        <a className="help-section__anchor" href={'#' + id} aria-label="這一段的連結">#</a>
        {title}
      </h3>
      <div className="help-faq__body">{children}</div>
    </section>
  );
}

// ─── 目錄 ───

function TocList({ items, current, onPick }: { items: HelpTocItem[]; current: string; onPick: (e: MouseEvent, id: HelpAnchor) => void }) {
  return (
    <ul>
      {items.map(i => (
        <li key={i.id}>
          <a
            href={'#' + i.id}
            className={i.id === current ? 'is-current' : undefined}
            aria-current={i.id === current ? 'location' : undefined}
            onClick={e => onPick(e, i.id)}
          >{i.label}</a>
          {i.children && <TocList items={i.children} current={current} onPick={onPick} />}
        </li>
      ))}
    </ul>
  );
}

// ─── 頁面 ───

export default function Help() {
  const location = useLocation();
  const go = useGoTo();
  const [zoom, setZoom] = useState<FigKey | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const ids = useMemo(() => flatToc(HELP_TOC).map(i => i.id), []);
  const current = useCurrentSection(ids);
  const currentLabel = flatToc(HELP_TOC).find(i => i.id === current)?.label ?? '';
  useHashScroll(location.hash);

  useEffect(() => {
    const prev = document.title;
    document.title = '使用說明：AE 即時預覽 — STAGE PREVIZ';
    return () => { document.title = prev; };
  }, []);

  // 手機的目錄打開時，按 Esc 收起
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const pick = useCallback((e: MouseEvent, id: HelpAnchor) => {
    setMenuOpen(false);
    go(e, id);
  }, [go]);
  const closeZoom = useCallback(() => setZoom(null), []);

  return (
    <ZoomContext.Provider value={setZoom}>
      <div className="help">
        <header className="help-top">
          <a className="help-top__brand" href="/">🎬 STAGE PREVIZ</a>
          <span className="help-top__title">使用說明</span>
          <span className="grow" />
          <button
            type="button"
            className="help-top__menu"
            aria-expanded={menuOpen}
            aria-controls="help-toc"
            onClick={() => setMenuOpen(o => !o)}
          >
            <span aria-hidden>☰</span> 目錄<span className="help-top__current">{currentLabel ? ` · ${currentLabel}` : ''}</span>
          </button>
        </header>

        <div className="help-layout">
          <nav id="help-toc" className={'help-toc' + (menuOpen ? ' is-open' : '')} aria-label="目錄">
            <div className="help-toc__chapter">AE 即時預覽</div>
            <TocList items={HELP_TOC} current={current} onPick={pick} />
          </nav>
          {menuOpen && <div className="help-toc__backdrop" onClick={() => setMenuOpen(false)} aria-hidden />}

          <main className="help-main">
            <div className="help-chapter">
              <div className="help-chapter__kicker">使用說明</div>
              <h1>AE 即時預覽</h1>
              <p className="help-lead">在 After Effects 做動畫，同時在瀏覽器的 3D 舞台上看 LED 的效果。AE 一動，舞台上的 LED 就跟著動。</p>
            </div>

            <Section id={A.aeLive} title="AE 即時預覽是什麼">
              <ol className="help-flow" aria-label="畫面怎麼送到 LED">
                <li><strong>After Effects</strong><span>你在做的動畫</span></li>
                <li><strong>NDI</strong><span>AE 把畫面送出來</span></li>
                <li><strong>NDI 小程序</strong><span>在你電腦上接收</span></li>
                <li><strong>瀏覽器</strong><span>打開分享連結</span></li>
                <li><strong>3D 舞台的 LED</strong><span>即時看到</span></li>
              </ol>
              <p>全部在<strong>同一台電腦</strong>上：AE、小程序、瀏覽器都開在你自己的電腦。小程序會自動接這台電腦的 AE。</p>
              <p>第一次要花幾分鐘設定（<Go to={A.setup}>第一次設定</Go>），之後每次只要打開 AE、打開分享連結就好（<Go to={A.use}>每次使用</Go>）。</p>
            </Section>

            <Section id={A.whatYouNeed} title="要準備什麼">
              <ul className="help-checklist">
                <li><span aria-hidden>💻</span><div><strong>Windows 或 Mac 電腦</strong>（就是跑 AE 的那台）</div></li>
                <li><span aria-hidden>🌐</span><div><strong>Chrome、Edge 或 Firefox</strong> 瀏覽器。<em>Safari 不行</em>（iPhone、iPad 也不行）</div></li>
                <li><span aria-hidden>📡</span><div><strong>NDI Tools</strong>：NDI 官方的免費軟體，AE 靠它把畫面送出來</div></li>
                <li><span aria-hidden>🧩</span><div><strong>NDI 小程序</strong>：我們做的小程式，免費，在背景接收 AE 的畫面</div></li>
                <li><span aria-hidden>🎬</span><div><strong>After Effects</strong></div></li>
                <li><span aria-hidden>🔗</span><div><strong>分享連結</strong>：導演或管理員給你的網址</div></li>
              </ul>
            </Section>

            <Section id={A.setup} title="第一次設定（只要做一次）">
              <p>照順序做完這四步，以後就不用再設定了。</p>

              <Section id={A.installNdiTools} level={3} title="① 裝 NDI Tools">
                <p>AE 要靠 NDI Tools 才能把畫面「送出去」。</p>
                <ol className="help-steps">
                  <li>到 NDI 官網下載 <strong>NDI Tools</strong>（免費；Windows、Mac 都有）
                    <NdiToolsButton />
                  </li>
                  <li>打開下載的安裝檔，照預設一直按下一步裝完。<br />
                    裡面的「<Ui>NDI for Adobe Creative Cloud</Ui>」就是 AE 要用的，保持勾選。</li>
                  <li><strong>AE 開著的話，要關掉重開</strong>，AE 才會認得 NDI。</li>
                </ol>
              </Section>

              <Section id={A.installHelper} level={3} title="② 裝 NDI 小程序">
                <p>小程序在背景接收 AE 的畫面，交給瀏覽器。<strong>裝一次就好</strong>，之後開機會自己啟動，不用管它。</p>

                <Section id={A.installHelperWindows} level={4} title="Windows">
                  <ol className="help-steps">
                    <li>按這個按鈕下載安裝檔：
                      <DownloadHelper only="windows" />
                    </li>
                    <li>打開下載的 <code>stage-previz-ndi-helper-windows.msi</code>。</li>
                    <li>如果跳出藍色的「<Ui>Windows 已保護您的電腦</Ui>」：按「<Ui>其他資訊</Ui>」→「<Ui>仍要執行</Ui>」。</li>
                    <li>按「<Ui>Next</Ui>」→「<Ui>Install</Ui>」。問「要允許此 App 變更您的裝置嗎？」→ 按「<Ui>是</Ui>」。
                      <F k="helperInstallingWin" />
                    </li>
                    <li>最後一頁<strong>「<Ui>Launch Stage Previz NDI Helper now</Ui>」保持打勾</strong> → 按「<Ui>Finish</Ui>」。</li>
                    <li>右下角時鐘旁邊（可能收在 <Ui>^</Ui> 裡面）出現一個<strong>圓點</strong>，就裝好了。</li>
                  </ol>
                </Section>

                <Section id={A.installHelperMac} level={4} title="Mac">
                  <ol className="help-steps">
                    <li>按這個按鈕下載：
                      <DownloadHelper only="mac" />
                    </li>
                    <li>雙擊下載的 zip 解壓縮，把「<Ui>Stage Previz NDI Helper</Ui>」<strong>拖進「應用程式」資料夾</strong>。<br />
                      一定要先拖進「應用程式」再打開，不然開機自動啟動會失效。</li>
                    <li>在「應用程式」裡雙擊打開。第一次 Mac 會問：<br />
                      <Quote>「Stage Previz NDI Helper」是一個從網際網路下載的 App。確定要打開嗎？</Quote>
                      → 按「<Ui>打開</Ui>」（只有第一次會問）。</li>
                    <li>如果 Mac 問要不要讓它找「<Ui>區域網路</Ui>」（本地網路）上的裝置：<br />
                      <Quote>要允許「Stage Previz NDI Helper」尋找區域網路上的裝置嗎？</Quote>
                      → 按「<Ui>允許</Ui>」。不是每台 Mac 都會問，沒問就不用管。<br />
                      <span className="help-muted">（不小心按了不允許：系統設定 → 隱私權與安全性 → 區域網路，把 Stage Previz NDI Helper 打開）</span></li>
                    <li>右上角選單列出現一個<strong>圓點</strong>，就裝好了。</li>
                  </ol>
                </Section>

                <div className="help-table-wrap">
                  <table className="help-table">
                    <caption>小程序圓點的顏色</caption>
                    <tbody>
                      <tr><td><span className="help-dot help-dot--green" aria-hidden />綠</td><td>網頁正在收 AE 的畫面</td></tr>
                      <tr><td><span className="help-dot help-dot--gray" aria-hidden />灰</td><td>待機（沒有網頁在看，幾乎不吃電腦資源）</td></tr>
                      <tr><td><span className="help-dot help-dot--orange" aria-hidden />橘</td><td>要處理：沒裝 NDI Tools、找不到這台電腦 AE 的 NDI 輸出、或開了兩個小程序</td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="help-muted">以後有新版時，網頁會告訴你；下載新的再裝一次就好（會自動關掉舊的）。</p>
              </Section>

              <Section id={A.aeNdiOutput} level={3} title="③ 在 AE 打開 NDI 輸出（最重要）">
                <p>這一步讓 AE 把畫面送出去。打開 AE 的「<Ui>視訊預覽</Ui>（Video Preview）」設定：</p>
                <div className="help-os">
                  <div className="help-os__item">
                    <div className="help-os__label">Windows</div>
                    <p><Ui>Edit 編輯</Ui> → <Ui>Preferences 偏好設定</Ui> → <Ui>Video Preview… 視訊預覽</Ui></p>
                  </div>
                  <div className="help-os__item">
                    <div className="help-os__label">Mac</div>
                    <p><Ui>After Effects</Ui> → <Ui>Settings 設定</Ui> → <Ui>Video Preview… 視訊預覽</Ui></p>
                  </div>
                </div>
                <F k="aeMenuWin" />
                <p className="help-muted">Mac 打開的是同一個「視訊預覽」頁，勾的地方跟下面 Windows 的圖一樣。</p>

                <p>在「視訊預覽」頁，照這樣設定：</p>
                <ol className="help-steps help-steps--marked">
                  <li><Num n={1} />☑ <strong>勾</strong>「<Ui>Enable Mercury Transmit</Ui>」</li>
                  <li><Num n={2} />在清單裡「<Ui>NDI output</Ui>」那一行，☑ <strong>勾</strong>「<Ui>Video Stream</Ui>」<br />
                    <span className="help-muted">（沒有「NDI output」這一行 = NDI Tools 還沒裝好，或裝完還沒重開 AE）</span></li>
                  <li><Num n={3} />☐ <strong>不要勾</strong>「<Ui>Disable video output when in the background</Ui>」（中文版：在背景時停用視訊輸出）<br />
                    <span className="help-muted">（不然你一點到瀏覽器，AE 就停止送畫面）</span></li>
                  <li><Num n={4} />按「<Ui>OK</Ui>」</li>
                </ol>
                <F k="aeVideoPreviewWin" />

                <Note title="小技巧">
                  <p>數字鍵盤的「<kbd>/</kbd>」可以快速開關 Mercury Transmit（就是第 ① 個勾）。不小心按到，畫面就不會送出去。</p>
                </Note>
                <Note kind="warn" title="AE 要在播放">
                  <p>AE 只有在<strong>畫面有變化</strong>時才會送新的畫面。停在同一格時，LED 會停在最後一張。按空白鍵播放你的合成就會動。</p>
                </Note>
              </Section>

              <Section id={A.chromeAllow} level={3} title="④ 用 Chrome 打開分享連結，按「允許」">
                <ol className="help-steps">
                  <li>用 <strong>Chrome</strong>（或 Edge、Firefox）打開導演給你的分享連結。</li>
                  <li>上面選「<Ui>🔴 AE 即時</Ui>」（預設就是），3D 舞台上會出現「AE 即時畫面」卡片 → 按「<Ui>連接 AE 即時</Ui>」。
                    <F k="sharePermission" />
                  </li>
                  <li>瀏覽器左上角（網址列下面）會跳出一個小視窗問：<br />
                    <Quote>{PERMISSION_PROMPT_TEXT}</Quote>
                    → 按「<Ui>允許</Ui>」。
                    <ChromePromptMock />
                  </li>
                </ol>
                <p>這是讓網頁連到你電腦上的小程序。<strong>每個網站只問一次</strong>：正式網址 <code>previz.haimiaan.com</code> 和測試網址各問一次。</p>
                <p>不小心按到「封鎖」？看 <Go to={A.faqBlocked}>瀏覽器擋住了</Go>。</p>
              </Section>
            </Section>

            <Section id={A.use} title="每次使用">
              <p>設定好之後，每次只要：</p>
              <ol className="help-steps">
                <li>打開 AE 和你的專案（小程序開機就自己開了，不用管）。</li>
                <li>按空白鍵<strong>播放</strong>你的合成。</li>
                <li>用 Chrome 打開分享連結，上面選「<Ui>🔴 AE 即時</Ui>」。</li>
                <li>3D 畫面上方出現綠色「<Ui>LIVE</Ui>」，LED 就是 AE 的畫面了。</li>
              </ol>
              <F k="shareLive" />
              <p>畫面卡卡的或電腦很燙？看 <Go to={A.resolution}>建議的預覽解析度</Go>。</p>
              <p>卡片上的「<Ui>×</Ui>」可以把卡片收起來；按 3D 畫面上方的 NDI 標示可以再打開。沒有 AE 的時候，可以按「<Ui>🎬 本地檔案</Ui>」把影片或圖片拖進來看。</p>
            </Section>

            <Section id={A.resolution} title="建議的預覽解析度">
              <p>AE 送出去的畫面大小，就是<strong>合成視窗下方的「<Ui>解析度 / 降低取樣</Ui>」選單</strong>：<Ui>Full 完整</Ui>、<Ui>Half 一半</Ui>、<Ui>Third 三分之一</Ui>、<Ui>Quarter 四分之一</Ui>。</p>
              <p>位置：合成視窗<strong>正下方那排小工具</strong>裡，寫著「<Ui>Full</Ui>」（中文版「完整」）的下拉選單，旁邊是放大比例（例如 50%）。</p>
              <F k="aeResolutionWin" />
              <ResolutionMock />
              <ul className="help-list">
                <li><strong>LED 畫布很大</strong>（例如 10496×5120）：建議用 <strong>Third（三分之一）</strong>，送出去大約 3499×1707。電腦和網路都比較輕，預覽也夠清楚。</li>
                <li><strong>畫布小</strong>（1920×1080 以內）：可以用 Full 或 Half。</li>
                <li>改了解析度，網頁會自動跟上，不用重新整理。</li>
                <li>小程序還會再縮一半保持流暢，所以用 Full 不會清楚太多，反而讓 AE 變慢。</li>
                <li>畫面卡卡的話，先降到 <strong>Quarter（四分之一）</strong>。</li>
              </ul>
            </Section>

            <Section id={A.chooseSource} title="有好幾台 AE：選來源">
              <p>小程序<strong>只會自動接「這台電腦」的 AE</strong>。網路上別台電腦（例如同事）的 AE 也在送 NDI 的話，不會自動出現，要自己選：</p>
              <ol className="help-steps">
                <li>按 3D 畫面上方的 NDI 標示（例如「<Ui>LIVE</Ui>」或「<Ui>找不到這台電腦的 AE</Ui>」）。</li>
                <li>在「<Ui>來源</Ui>」選單裡選：
                  <ul className="help-list">
                    <li>「<Ui>自動（這台電腦的 AE）</Ui>」：預設，接你自己的 AE</li>
                    <li>「<Ui>這台電腦的 Adobe After Effects</Ui>」：你自己的 AE</li>
                    <li>「<Ui>STUDIO-PC 的 Adobe After Effects</Ui>」：別台電腦的 AE（前面是那台電腦的名字）</li>
                  </ul>
                </li>
              </ol>
              <F k="popoverSource" />
              <p>選過會記住。想回到自己的 AE，選「<Ui>自動</Ui>」。</p>
            </Section>

            <Section id={A.faq} title="常見問題">
              <p>標題就是 3D 舞台上卡片寫的字。卡片上按「<Ui>看圖文說明</Ui>」會直接跳到這裡對應的那一題。</p>

              <Faq id={A.faqWaitingFrames} title="「已連上 AE，但 AE 沒在送畫面」/「AE 停住了」">
                <p>小程序找到 AE 了，可是超過 3 秒沒有新畫面。LED 會停在最後一張。照順序檢查：</p>
                <ol className="help-steps">
                  <li>AE 有在<strong>播放</strong>嗎？停在同一格就不會送新畫面 → 按空白鍵播放。</li>
                  <li>「<Ui>Disable video output when in the background</Ui>」有<strong>取消勾選</strong>嗎？沒取消的話，一點到瀏覽器 AE 就停了 → 看 <Go to={A.aeNdiOutput}>③ 的第 3 點</Go>。</li>
                  <li>是不是按到數字鍵盤的「<kbd>/</kbd>」，把 Mercury Transmit 關掉了？再按一次打開。</li>
                </ol>
                <F k="cardWaiting" />
              </Faq>

              <Faq id={A.faqBlack} title="LED 一片黑">
                <ol className="help-steps">
                  <li>先看 AE 裡的畫面：時間指示器是不是停在沒有東西的地方？</li>
                  <li>檢查 <Go to={A.aeNdiOutput}>③ 的三個勾</Go>，特別是「<Ui>Enable Mercury Transmit</Ui>」（數字鍵盤「<kbd>/</kbd>」會開關它）。</li>
                  <li>點一下 AE 的合成視窗，再按空白鍵播放。</li>
                  <li>還是黑的：把 AE 關掉重開（剛裝 NDI Tools 一定要重開）。</li>
                </ol>
              </Faq>

              <Faq id={A.faqNoAe} title="「找不到 AE」/「這台電腦的 AE 沒有在送 NDI」">
                <ol className="help-steps">
                  <li>AE 有打開嗎？</li>
                  <li>AE 的「視訊預覽」有照 <Go to={A.aeNdiOutput}>③</Go> 勾好嗎？</li>
                  <li>剛裝好 NDI Tools 的話，要把 AE 關掉重開。</li>
                  <li>AE 要在播放。</li>
                </ol>
                <p>卡片寫「要看網路上別台電腦的 AE，請在下面選」：表示網路上有別台電腦在送，但不會自動接 → 看 <Go to={A.chooseSource}>選來源</Go>。</p>
                <F k="cardNoAe" />
              </Faq>

              <Faq id={A.faqNoHelper} title="「沒有偵測到 NDI 小程序」">
                <ul className="help-list">
                  <li><strong>還沒裝</strong>：照 <Go to={A.installHelper}>② 裝 NDI 小程序</Go>。裝好打開後網頁會自動連上。</li>
                  <li><strong>裝了但沒開</strong>：Windows 從「開始」選單打開「<Ui>Stage Previz NDI Helper</Ui>」；Mac 從「應用程式」打開。</li>
                  <li><strong>{OLD_HELPER_HINT}</strong>。舊版小程序在新網址上看起來跟沒開一樣。</li>
                </ul>
                <DownloadHelper />
                <F k="cardNoHelper" />
              </Faq>

              <Faq id={A.faqOutdated} title="「小程序有新版，請下載更新」">
                <p>下載新版，直接再裝一次就好（會自動關掉舊的、裝完自動打開新的）。更新之前，舊版的畫面照樣可以用。</p>
                <DownloadHelper />
                <F k="cardOutdated" />
              </Faq>

              <Faq id={A.faqNoNdiTools} title="「請先安裝 NDI Tools（免費）」">
                <p>小程序找不到 NDI。照 <Go to={A.installNdiTools}>① 裝 NDI Tools</Go> 裝好，小程序會自己找到，不用重開小程序（但 AE 要重開）。</p>
                <NdiToolsButton />
                <F k="cardNdiMissing" />
              </Faq>

              <Faq id={A.faqBlocked} title="「瀏覽器擋住了連到 NDI 小程序」">
                <p>之前瀏覽器問「{PERMISSION_PROMPT_TEXT}」時按到了「封鎖」。改回來：</p>
                <ul className="help-list">
                  {permissionFixSteps('other').map(s => <li key={s}>{s}</li>)}
                </ul>
                <p>改好後會自動連上。</p>
                <F k="cardBlocked" />
              </Faq>

              <Faq id={A.faqSafari} title="「Safari 不支援 AE 即時畫面」">
                <p>Safari 會直接擋掉網頁連到小程序，沒辦法用。請改用 <strong>Chrome、Edge 或 Firefox</strong> 打開同一個連結。卡片上的「<Ui>📋 複製這個連結</Ui>」可以把網址複製起來，貼到 Chrome。</p>
                <p className="help-muted">iPhone、iPad 上的瀏覽器都是 Safari 核心，也不行。AE 即時本來就要在跑 AE 的電腦上看。</p>
                <F k="cardSafari" />
              </Faq>

              <Faq id={A.faqAutostart} title="「小程序沒辦法設成開機自動啟動」">
                <p>{NDI_AUTOSTART_NOTE}。</p>
                <p>不影響使用，只是下次開機後要自己打開小程序（Windows：「開始」選單；Mac：「應用程式」）。</p>
              </Faq>
            </Section>

            <footer className="help-footer">
              <p>還是不行？把 3D 舞台上卡片的畫面截圖傳給導演或管理員。</p>
            </footer>
          </main>
        </div>

        {zoom && <Lightbox k={zoom} onClose={closeZoom} />}
      </div>
    </ZoomContext.Provider>
  );
}
