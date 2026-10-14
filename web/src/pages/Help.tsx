// 線上使用說明（/help）：不用登入，製作、動畫師、導演、客戶都看這一份。
//   左邊目錄（手機收到上面的「目錄」）、上面可以選角色、可以搜尋（只在這一頁裡找，不連網路）。
//   段落 id 在 lib/helpLinks.ts（分享頁、檢查清單卡片、設定頁、各個「?」會直接連到某一段，不要隨便改）；
//   圖片和紅框在 helpFigures.ts。
//
// 章節：開始使用 → 製作 → 動畫師 → AE 即時預覽（動畫師）→ 導演 → 客戶 → 常見問題

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type MouseEvent, type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { HELP_ANCHORS as A, type HelpAnchor } from '../lib/helpLinks';
import { NDI_HELPER_DOWNLOAD_URL, NDI_HELPER_DOWNLOAD_URL_MAC, NDI_TOOLS_URL } from '../lib/downloads';
import { NDI_AUTOSTART_NOTE, OLD_HELPER_HINT, PERMISSION_PROMPT_TEXT, permissionFixSteps } from '../lib/ndiSteps';
import { DRIVE_MATCH_RULE } from '../lib/songCode';
import { FIGS, type FigKey, type HelpFig } from './helpFigures';
import { REVIEW_SHORTCUTS } from '../lib/review/reviewShortcuts';
import Icon from '../components/Icon';
import {
  Check, ChevronDown, CircleHelp, Clapperboard, ClipboardList, Copy, Download, Ellipsis, ExternalLink, Eye, FolderOpen, Globe,
  Image, Info, Laptop, Lightbulb, Link, Menu, Monitor, Palette, Puzzle, Radio, RadioTower, Rocket, Scan, Search, SearchX, Square,
  SquareCheck, TriangleAlert, Video, X,
} from 'lucide-react';
import './Help.css';

// ─── 角色 ───

export type HelpRole = 'producer' | 'animator' | 'director' | 'client';
type RoleFilter = 'all' | HelpRole;

const ROLES: { key: HelpRole; label: string; icon: LucideIcon; hint: string }[] = [
  { key: 'producer', label: '製作', icon: ClipboardList, hint: '建專案、放模型、排歌和 cue、設定機關、邀請大家' },
  { key: 'animator', label: '動畫師', icon: Clapperboard, hint: '交影片、用 AE 即時在 LED 上看、看導演的意見' },
  { key: 'director', label: '導演', icon: Eye, hint: '看每首歌的影片、留言、按「通過」或「需修改」' },
  { key: 'client', label: '客戶', icon: Link, hint: '用分享連結看成果，不用帳號' },
];
const ROLE_STORAGE_KEY = 'sp_help_role';

// ─── 目錄（章 → 段 → 小段）───

export interface HelpTocItem {
  id: HelpAnchor;
  label: string;
  children?: HelpTocItem[];
}

export interface HelpChapter extends HelpTocItem {
  /** 目錄、章節標題上面的小字 */
  kicker: string;
  icon: LucideIcon;
  /** 給哪些角色看；null = 每個人 */
  roles: HelpRole[] | null;
  children: HelpTocItem[];
}

export const HELP_CHAPTERS: HelpChapter[] = [
  {
    id: A.start, label: '開始使用', kicker: '每個人', icon: Rocket, roles: null, children: [
      { id: A.roles, label: '四種角色和歌的狀態' },
      { id: A.loginInvite, label: '用邀請連結進來' },
      { id: A.loginCode, label: '用登入碼登入' },
      { id: A.landing, label: '登入後會到哪裡' },
      { id: A.notifications, label: '通知（小鈴鐺）' },
    ],
  },
  {
    id: A.producer, label: '製作', kicker: '製作', icon: ClipboardList, roles: ['producer'], children: [
      { id: A.prodProject, label: '建立專案' },
      { id: A.prodModel, label: '匯入 3D 模型', children: [{ id: A.prodNaming, label: '物件怎麼命名' }] },
      { id: A.prodCalibrate, label: '測距校準' },
      { id: A.prodSongs, label: '歌曲和歌曲代號', children: [{ id: A.prodVideos, label: '影片版本（看、刪除）' }, { id: A.prodDrive, label: 'Google Drive 資料夾' }] },
      { id: A.prodAssign, label: '指派負責動畫師' },
      {
        id: A.prodCues, label: 'cue：位置和轉場', children: [
          { id: A.prodCueTiming, label: 'cue 跟著影片時間走' },
          { id: A.prodTemplates, label: '常用擺位' },
          { id: A.prodUndo, label: '復原、重做、快捷鍵' },
        ],
      },
      {
        id: A.prodMechanisms, label: '機關', children: [
          { id: A.prodMechSetup, label: '設定機關' },
          { id: A.prodMechCue, label: '每個 cue 的機關位置' },
          { id: A.prodMechSpeed, label: '來不及到位、照機器速度' },
          { id: A.prodMechSheet, label: '機關總表' },
          { id: A.prodMechConvert, label: '把現有 cue 的位置轉成機關位置' },
        ],
      },
      { id: A.prodLedCanvas, label: 'LED 畫布大小和對位圖' },
      { id: A.prodView, label: '重置攝影機和現場設定' },
      { id: A.prodShare, label: '分享連結和密碼' },
      { id: A.prodInvite, label: '邀請連結' },
      { id: A.prodViewAs, label: '用導演 / 動畫師的畫面看' },
      { id: A.prodLoginCodes, label: '用戶和登入碼' },
      { id: A.prodSystem, label: '系統狀態（備份、錯誤）' },
      { id: A.prodArchive, label: '封存和還原' },
    ],
  },
  {
    id: A.animator, label: '動畫師', kicker: '動畫師', icon: Clapperboard, roles: ['animator'], children: [
      { id: A.animStudio, label: '工作站畫面' },
      { id: A.animSource, label: '影片 / AE 即時 / 本地檔案' },
      { id: A.animAddVideo, label: '交影片（加影片）' },
      { id: A.animAeExport, label: 'AE 輸出設定（交影片前）' },
      { id: A.animVersions, label: '版本 V1、V2' },
      { id: A.animSubmit, label: '提交審查' },
      { id: A.animFeedback, label: '看意見、回覆、已改好' },
      { id: A.animCompare, label: '比較兩版（C 鍵）' },
      { id: A.animLedMap, label: 'LED 對位圖（做 AE 合成）' },
      { id: A.animAeScript, label: '用 AE 腳本建合成' },
      { id: A.animTestPattern, label: 'LED 顯示測試圖' },
    ],
  },
  {
    id: A.aeLive, label: 'AE 即時預覽', kicker: '動畫師', icon: Radio, roles: ['animator'], children: [
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
      { id: A.aeLiveColor, label: 'AE 即時的顏色（校正）' },
      { id: A.chooseSource, label: '有好幾台 AE：選來源' },
      {
        id: A.faq, label: 'AE 即時的問題', children: [
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
    ],
  },
  {
    id: A.director, label: '導演', kicker: '導演', icon: Eye, roles: ['director'], children: [
      { id: A.dirBoard, label: '總覽和狀態' },
      { id: A.dirPlay, label: '在 LED 上看某一版' },
      { id: A.dirAddLink, label: '貼連結加影片' },
      { id: A.dirComment, label: '留言、@ 提及' },
      { id: A.dirAnnotate, label: '畫記、記住視角、區段' },
      { id: A.dirOpen, label: '打開留言（飛到那個視角）' },
      { id: A.dirPlayer, label: '播放器和快捷鍵' },
      { id: A.dirDecide, label: '通過 / 需修改' },
      { id: A.dirHistory, label: '審片紀錄' },
      { id: A.dirCompare, label: '比較兩版' },
      { id: A.dirExport, label: '匯出留言（PDF、CSV）' },
    ],
  },
  {
    id: A.client, label: '客戶（分享連結）', kicker: '客戶', icon: Link, roles: ['client'], children: [
      { id: A.clientOpen, label: '打開連結、輸入密碼' },
      { id: A.clientCamera, label: '轉動視角、重置攝影機' },
      { id: A.clientPlay, label: '看影片' },
      { id: A.clientComment, label: '留言（製作有開的連結）' },
      { id: A.clientLocal, label: '本地檔案' },
      { id: A.clientMobile, label: '手機和 iPad' },
    ],
  },
  {
    id: A.questions, label: '常見問題', kicker: '每個人', icon: CircleHelp, roles: null, children: [
      { id: A.qPermission, label: '瀏覽器問要不要允許連線' },
      { id: A.qVideo, label: '影片播不出來' },
      { id: A.qUpload, label: '上傳到一半中斷了' },
      { id: A.qChina, label: '在中國大陸使用' },
      { id: A.qBrowsers, label: '支援哪些瀏覽器' },
    ],
  },
];

/** 整份目錄（章 → 段 → 小段）；每個段落 id 只出現一次 */
export const HELP_TOC: HelpTocItem[] = HELP_CHAPTERS;

function flatToc(items: HelpTocItem[]): HelpTocItem[] {
  return items.flatMap(i => [i, ...flatToc(i.children ?? [])]);
}

const CHAPTER_BY_ID = new Map<string, HelpChapter>(HELP_CHAPTERS.map(c => [c.id, c]));

// ─── 篩選（角色 + 搜尋）───

/** 現在被藏起來的章 / 段（id） */
const HiddenContext = createContext<ReadonlySet<string>>(new Set());
const NO_HIDDEN: ReadonlySet<string> = new Set();

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** 照角色和搜尋的字，算出要藏哪些章、哪些段（看畫面上真的字，所以圖說、表格都找得到） */
function computeHidden(root: HTMLElement | null, role: RoleFilter, query: string): Set<string> {
  const hidden = new Set<string>();
  const q = normText(query);
  for (const ch of HELP_CHAPTERS) {
    const roleOk = role === 'all' || !ch.roles || ch.roles.includes(role);
    if (!roleOk) {
      hidden.add(ch.id);
      ch.children.forEach(s => hidden.add(s.id));
      continue;
    }
    if (!q || !root) continue;
    let any = false;
    for (const s of ch.children) {
      const el = root.querySelector(`[id="${s.id}"]`);
      if (el && normText(el.textContent ?? '').includes(q)) any = true;
      else hidden.add(s.id);
    }
    const head = root.querySelector(`[id="${ch.id}"] > .help-chapter__head`);
    if (!any && !(head && normText(head.textContent ?? '').includes(q))) hidden.add(ch.id);
  }
  return hidden;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(x => b.has(x));

/** 這個元素（或它外面的章 / 段）有沒有被藏起來 */
const isHiddenEl = (el: Element | null) => !!el?.closest('[hidden]');

// ─── 捲到某一段 ───

const TOP_OFFSET = 64;

function alignTo(el: HTMLElement, behavior: ScrollBehavior) {
  const top = el.getBoundingClientRect().top + window.scrollY - TOP_OFFSET + 4;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

function flash(el: HTMLElement): () => void {
  el.classList.remove('is-flash');
  void el.offsetWidth;  // 重新播放亮一下的動畫
  el.classList.add('is-flash');
  const t = window.setTimeout(() => el.classList.remove('is-flash'), 1800);
  return () => window.clearTimeout(t);
}

/**
 * 網址的 #段落 → 捲過去、亮一下；圖片陸續載入讓位置跑掉時（2.5 秒內、使用者沒自己捲）再對一次。
 * 那一段被篩選藏起來了 → 先叫 onHidden（把篩選清掉），之後由 onHidden 的人再捲。
 */
function useHashScroll(hash: string, onHidden: (id: string) => void) {
  const first = useRef(true);
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    const smooth = !first.current;
    first.current = false;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    if (isHiddenEl(el)) { onHiddenRef.current(id); return; }
    alignTo(el, smooth ? 'smooth' : 'auto');
    const stopFlash = flash(el);

    if (smooth) return stopFlash;
    let userMoved = false;
    const stop = () => { userMoved = true; };
    const onLoad = (e: Event) => {
      if (!userMoved && e.target instanceof HTMLImageElement) alignTo(el, 'auto');
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
    return () => { cleanup(); window.clearTimeout(done); stopFlash(); };
  }, [hash]);
}

/** 目前讀到哪一段（目錄亮那一格）；藏起來的段不算 */
function useCurrentSection(ids: string[], hidden: ReadonlySet<string>): string {
  const [current, setCurrent] = useState(ids[0] ?? '');
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      let found = '';
      let last = '';
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || el.offsetParent === null) continue;
        last = id;
        if (!found) found = id;
        if (el.getBoundingClientRect().top <= TOP_OFFSET + 24) found = id;
      }
      // 捲到最底：最後一段
      if (last && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) found = last;
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
  }, [ids, hidden]);
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
      <span className="help-note__icon" aria-hidden><Icon icon={kind === 'warn' ? TriangleAlert : Lightbulb} size="md" /></span>
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
    <figure className={'help-fig' + (fig.phone ? ' help-fig--phone' : '')} style={maxWidth ? { maxWidth } : undefined}>
      {missing ? (
        <div className="help-fig__placeholder" role="img" aria-label={fig.alt}>
          <span className="help-fig__placeholder-icon" aria-hidden><Icon icon={Image} size="xl" /></span>
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

/** 兩張圖並排（窄的時候上下排） */
function FigRow({ children }: { children: ReactNode }) {
  return <div className="help-fig-row">{children}</div>;
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
        <a href={fig.src} target="_blank" rel="noreferrer">原圖 <Icon icon={ExternalLink} size="xs" /></a>
        <button type="button" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
      </div>
      <div className="help-lightbox__body">
        <FigImage fig={fig} zoomed />
      </div>
    </div>
  );
}

/** 對話框裡的原文 */
/** 播放器的快捷鍵（導演頁、動畫師工作站、分享連結）：直接用程式裡的那一份（lib/review/reviewShortcuts.ts），不會對不上 */
const PAGE_NAME = { preview: '導演頁', studio: '動畫師工作站', share: '分享連結' } as const;
function ReviewKeysTable() {
  return (
    <div className="help-table-wrap">
      <table className="help-table">
        <caption>播放器的快捷鍵（導演頁、動畫師工作站、分享連結）</caption>
        <tbody>
          {REVIEW_SHORTCUTS.map(s => (
            <tr key={s.keys.join('+')}>
              <td>{s.keys.map((k, i) => <span key={k}>{i > 0 && '+'}<kbd>{k}</kbd></span>)}</td>
              <td>{s.label}{s.pages ? `（只有${s.pages.map(p => PAGE_NAME[p]).join('、')}）` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return <span className="help-quote">{children}</span>;
}

/** Chrome 詢問視窗的示意圖（不是真的截圖） */
function ChromePromptMock() {
  return (
    <figure className="help-fig help-mock help-mock--chrome" aria-label={`示意圖：Chrome 問「${PERMISSION_PROMPT_TEXT}」，按「允許」`}>
      <div className="help-mock__frame help-mock__frame--light">
        <span className="help-mock__tag">示意圖</span>
        <div className="help-mock__url" aria-hidden><span className="help-mock__lock"><Icon icon={Info} size="xs" /></span> previz.haimiaan.com/s/…</div>
        <div className="help-mock__prompt" aria-hidden>
          <div className="help-mock__prompt-title">previz.haimiaan.com 想要</div>
          <div className="help-mock__prompt-row"><Icon icon={Monitor} /> {PERMISSION_PROMPT_TEXT}</div>
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
    <figure className="help-fig help-mock" aria-label="示意圖：AE 合成視窗下方的解析度選單，選 Half">
      <div className="help-mock__frame">
        <span className="help-mock__tag">示意圖</span>
        <div className="help-mock__viewer" aria-hidden>合成視窗</div>
        <div className="help-mock__bar" aria-hidden>
          <span className="help-mock__chip">50% <Icon icon={ChevronDown} size="xs" /></span>
          <span className="help-mock__chip is-on">Half <Icon icon={ChevronDown} size="xs" /><span className="help-num help-mock__num">1</span></span>
          <span className="help-mock__chip"><Icon icon={Scan} size="xs" /></span>
          <span className="help-mock__chip">0:00:12:05</span>
        </div>
        <ul className="help-mock__menu" aria-hidden>
          <li>Full</li>
          <li className="is-on"><Icon icon={Check} size="xs" /> Half</li>
          <li>Third</li>
          <li>Quarter</li>
          <li className="is-sep">Custom…</li>
        </ul>
      </div>
      <figcaption>示意圖：① 合成視窗正下方「Full」那個選單 → 選 Half（建議）</figcaption>
    </figure>
  );
}

/** cue 跟著影片時間走的示意圖（示範專案 S01 開場的 4 個 cue） */
const TIMELINE_TOTAL = 40;
const TIMELINE_CUES = [
  { name: '開場', at: 0, fade: 0 },
  { name: '升降台上升', at: 10, fade: 6 },
  { name: '轉台轉向', at: 30, fade: 20 },
  { name: '收尾', at: 38, fade: 8 },
];
function CueTimelineMock() {
  let prev = -Infinity;
  const rows = TIMELINE_CUES.map((c, i) => {
    const start = i === 0 ? c.at : Math.max(c.at - c.fade, prev);
    prev = c.at;
    return { ...c, start, n: i + 1 };
  });
  const pct = (s: number) => `${(s / TIMELINE_TOTAL) * 100}%`;
  const clock = (s: number) => `0:${String(s).padStart(2, '0')}`;
  return (
    <figure className="help-fig help-timeline" aria-label="示意圖：影片時間軸上每個 cue 什麼時候開始動、什麼時候到位">
      <div className="help-timeline__frame">
        <span className="help-mock__tag">示意圖</span>
        <div className="help-timeline__track" aria-hidden>
          {[0, 10, 20, 30, 40].map(s => (
            <span key={s} className="help-timeline__tick" style={{ left: pct(s) }}><span>{clock(s)}</span></span>
          ))}
          {rows.filter(r => r.at > r.start).map(r => (
            <span key={'m' + r.n} className={'help-timeline__move' + (r.n === 3 ? ' is-example' : '')} style={{ left: pct(r.start), width: pct(r.at - r.start) }}>
              <span>轉場 {r.at - r.start} 秒</span>
            </span>
          ))}
          {rows.map(r => (
            <span key={'c' + r.n} className={'help-timeline__cue' + (r.n === 3 ? ' is-example' : '')} style={{ left: pct(r.at) }}>{r.n}</span>
          ))}
        </div>
        <ol className="help-timeline__legend">
          {rows.map(r => (
            <li key={r.n} className={r.n === 3 ? 'is-example' : undefined}>
              <strong>{r.n}「{r.name}」</strong>影片 {clock(r.at)} 到位
              {r.fade === 0 ? '，直接切換' : `，轉場 ${r.fade} 秒 → ${clock(r.start)} 開始動`}
              {r.n === 4 && '（上一個 cue 0:30 才到，所以從 0:30 開始）'}
            </li>
          ))}
        </ol>
      </div>
      <figcaption>示意圖：綠色的段落是舞台在移動。cue 3 在 0:30 到位、轉場 20 秒，所以 0:10 就開始動。</figcaption>
    </figure>
  );
}

function DownloadHelper({ only }: { only?: 'windows' | 'mac' }) {
  return (
    <div className="help-actions">
      {only !== 'mac' && <a className="help-btn help-btn--primary" href={NDI_HELPER_DOWNLOAD_URL}><Icon icon={Download} /> 下載 NDI 小程序（Windows）</a>}
      {only !== 'windows' && <a className={'help-btn' + (only === 'mac' ? ' help-btn--primary' : '')} href={NDI_HELPER_DOWNLOAD_URL_MAC}><Icon icon={Download} /> 下載 NDI 小程序（Mac）</a>}
    </div>
  );
}

function NdiToolsButton() {
  return (
    <div className="help-actions">
      <a className="help-btn help-btn--primary" href={NDI_TOOLS_URL} target="_blank" rel="noreferrer">前往 NDI Tools 下載頁（免費）<Icon icon={ExternalLink} size="xs" /></a>
    </div>
  );
}

/** 一章：最外層（被角色 / 搜尋藏起來時整章不顯示） */
function Chapter({ id, lead, children }: { id: HelpAnchor; lead: ReactNode; children: ReactNode }) {
  const hidden = useContext(HiddenContext);
  const ch = CHAPTER_BY_ID.get(id)!;
  return (
    <section id={id} className="help-chapter help-section" hidden={hidden.has(id)}>
      <header className="help-chapter__head">
        <div className="help-chapter__kicker"><Icon icon={ch.icon} /> {ch.kicker}</div>
        <h2 className="help-chapter__title">
          <a className="help-section__anchor" href={'#' + id} aria-label="這一章的連結">#</a>
          {ch.label}
        </h2>
        <p className="help-lead">{lead}</p>
      </header>
      {children}
    </section>
  );
}

/** 一段。level 2 = 章裡的一段（搜尋時一段一段藏）；3、4 = 裡面的小段 */
function Section({ id, level = 2, title, children }: { id: HelpAnchor; level?: 2 | 3 | 4; title: ReactNode; children: ReactNode }) {
  const hidden = useContext(HiddenContext);
  const H = `h${level + 1}` as 'h3' | 'h4' | 'h5';
  return (
    <section id={id} className={`help-section help-section--h${level}`} hidden={level === 2 && hidden.has(id) ? true : undefined}>
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
      <h4 className="help-section__title">
        <a className="help-section__anchor" href={'#' + id} aria-label="這一段的連結">#</a>
        {title}
      </h4>
      <div className="help-faq__body">{children}</div>
    </section>
  );
}

/** 歌的狀態小圓點 */
function Dot({ s }: { s: 'todo' | 'review' | 'changes' | 'approved' }) {
  return <span className={'help-dot help-dot--' + s} aria-hidden />;
}

// ─── 目錄 ───

function TocList({ items, current, hidden, onPick, depth = 0 }: {
  items: HelpTocItem[]; current: string; hidden: ReadonlySet<string>; onPick: (e: MouseEvent, id: HelpAnchor) => void; depth?: number;
}) {
  const shown = items.filter(i => !hidden.has(i.id));
  if (shown.length === 0) return null;
  return (
    <ul>
      {shown.map(i => {
        const ch = depth === 0 ? CHAPTER_BY_ID.get(i.id) : undefined;
        return (
          <li key={i.id} className={ch ? 'help-toc__chapter-item' : undefined}>
            <a
              href={'#' + i.id}
              className={(i.id === current ? 'is-current' : '') + (ch ? ' help-toc__chapter-link' : '')}
              aria-current={i.id === current ? 'location' : undefined}
              onClick={e => onPick(e, i.id)}
            >{ch && <Icon icon={ch.icon} />}{i.label}</a>
            {i.children && <TocList items={i.children} current={current} hidden={hidden} onPick={onPick} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

// ─── 頁面 ───

export default function Help() {
  const location = useLocation();
  const go = useGoTo();
  const [zoom, setZoom] = useState<FigKey | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [role, setRole] = useState<RoleFilter>('all');
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_HIDDEN);
  const mainRef = useRef<HTMLElement>(null);
  const pendingRef = useRef<string | null>(null);
  const allItems = useMemo(() => flatToc(HELP_TOC), []);
  const ids = useMemo(() => allItems.map(i => i.id), [allItems]);
  const current = useCurrentSection(ids, hidden);
  const currentLabel = allItems.find(i => i.id === current)?.label ?? '';
  const tocRef = useRef<HTMLElement>(null);

  // 目錄很長：讀到的那一格跑出目錄的可見範圍時，把目錄捲過去（只捲目錄自己，不動頁面）
  useEffect(() => {
    const toc = tocRef.current;
    const a = toc?.querySelector<HTMLElement>('a.is-current');
    if (!toc || !a || toc.scrollHeight <= toc.clientHeight) return;
    const tr = toc.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    if (ar.top < tr.top + 32 || ar.bottom > tr.bottom - 32) toc.scrollTop += ar.top - tr.top - tr.height / 3;
  }, [current]);

  // 上次選的角色（這台電腦記得）；網址有指定段落時一律看全部，才找得到那一段
  useEffect(() => {
    if (location.hash) return;
    try {
      const saved = localStorage.getItem(ROLE_STORAGE_KEY);
      if (saved && ROLES.some(r => r.key === saved)) setRole(saved as HelpRole);
    } catch { /* 讀不到就看全部 */ }
    // 只在打開頁面時讀一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseRole = useCallback((r: RoleFilter) => {
    setRole(r);
    try { localStorage.setItem(ROLE_STORAGE_KEY, r); } catch { /* 只是下次不記得 */ }
  }, []);

  useLayoutEffect(() => {
    const next = computeHidden(mainRef.current, role, query);
    setHidden(prev => (sameSet(prev, next) ? prev : next));
  }, [role, query]);

  // 連過來的段落被篩選藏起來了 → 清掉篩選，畫面更新後再捲過去
  useHashScroll(location.hash, (id) => {
    pendingRef.current = id;
    setQuery('');
    setRole('all');
  });
  useEffect(() => {
    const id = pendingRef.current;
    if (!id || hidden.size > 0) return;
    pendingRef.current = null;
    const el = document.getElementById(id);
    if (el) { alignTo(el, 'auto'); flash(el); }
  }, [hidden]);

  useEffect(() => {
    const prev = document.title;
    document.title = '使用說明 — STAGE PREVIZ';
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

  const searching = query.trim().length > 0;
  const shownSections = HELP_CHAPTERS.flatMap(c => c.children).filter(s => !hidden.has(s.id)).length;
  const nothing = HELP_CHAPTERS.every(c => hidden.has(c.id));
  const roleInfo = ROLES.find(r => r.key === role);

  return (
    <ZoomContext.Provider value={setZoom}>
      <HiddenContext.Provider value={hidden}>
        <div className="help">
          <header className="help-top">
            <a className="help-top__brand" href="/"><span className="brand-mark" aria-hidden="true" />STAGE PREVIZ</a>
            <span className="help-top__title">使用說明</span>
            <span className="grow" />
            <button
              type="button"
              className="help-top__menu"
              aria-expanded={menuOpen}
              aria-controls="help-toc"
              onClick={() => setMenuOpen(o => !o)}
            >
              <Icon icon={Menu} /> 目錄<span className="help-top__current">{currentLabel ? ` · ${currentLabel}` : ''}</span>
            </button>
          </header>

          <div className="help-layout">
            <nav id="help-toc" ref={tocRef} className={'help-toc' + (menuOpen ? ' is-open' : '')} aria-label="目錄">
              <div className="help-toc__heading">目錄</div>
              <TocList items={HELP_TOC} current={current} hidden={hidden} onPick={pick} />
              {nothing && <p className="help-toc__empty">沒有符合的段落</p>}
            </nav>
            {menuOpen && <div className="help-toc__backdrop" onClick={() => setMenuOpen(false)} aria-hidden />}

            <main className="help-main" ref={mainRef}>
              <div className="help-hero">
                <div className="help-chapter__kicker">STAGE PREVIZ</div>
                <h1>使用說明</h1>
                <p className="help-lead">在瀏覽器裡看 3D 舞台：LED 上直接放動畫，製作、動畫師、導演、客戶一起看同一個舞台。先選你的角色，只看跟你有關的。</p>

                <div className="help-filter" role="group" aria-label="只看某個角色">
                  <button type="button" className={'help-chip' + (role === 'all' ? ' is-on' : '')} aria-pressed={role === 'all'} onClick={() => chooseRole('all')}>全部</button>
                  {ROLES.map(r => (
                    <button
                      key={r.key}
                      type="button"
                      className={'help-chip' + (role === r.key ? ' is-on' : '')}
                      aria-pressed={role === r.key}
                      onClick={() => chooseRole(r.key)}
                      title={r.hint}
                    ><Icon icon={r.icon} /> {r.label}</button>
                  ))}
                </div>
                {roleInfo && <p className="help-filter__hint">只顯示「{roleInfo.label}」要看的章節：{roleInfo.hint}。開始使用、常見問題每個角色都會顯示。</p>}

                <label className="help-search">
                  <Icon icon={Search} />
                  <input
                    type="search"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="搜尋說明，例：密碼、轉場、上傳"
                    aria-label="搜尋說明"
                  />
                  {query && (
                    <button type="button" className="help-search__clear" onClick={() => setQuery('')} title="清除搜尋" aria-label="清除搜尋">
                      <Icon icon={X} />
                    </button>
                  )}
                </label>
                {searching && !nothing && <p className="help-filter__hint" role="status">找到 {shownSections} 段有「{query.trim()}」</p>}
              </div>

              {nothing && (
                <div className="help-empty" role="status">
                  <Icon icon={SearchX} size="xl" />
                  <p>{searching ? `沒有找到「${query.trim()}」` : '這個角色沒有要看的章節'}</p>
                  <div className="help-actions">
                    {searching && <button type="button" className="help-btn" onClick={() => setQuery('')}>清除搜尋</button>}
                    {role !== 'all' && <button type="button" className="help-btn" onClick={() => chooseRole('all')}>看全部角色</button>}
                  </div>
                </div>
              )}

              <StartChapter />
              <ProducerChapter />
              <AnimatorChapter />
              <AeLiveChapter />
              <DirectorChapter />
              <ClientChapter />
              <QuestionsChapter />

              <footer className="help-footer">
                <p>還是不清楚？把畫面截圖傳給製作，或寫信問我們。</p>
              </footer>
            </main>
          </div>

          {zoom && <Lightbox k={zoom} onClose={closeZoom} />}
        </div>
      </HiddenContext.Provider>
    </ZoomContext.Provider>
  );
}

// ═══════════════════════════ 開始使用 ═══════════════════════════

function StartChapter() {
  return (
    <Chapter id={A.start} lead="一個專案就是一場演出（或巡迴的一個場次）。製作把 3D 舞台和歌準備好，動畫師交影片，導演在網頁上看、留言、決定通過或修改，最後用分享連結給客戶看。">
      <ol className="help-flow" aria-label="一首歌從做到通過">
        <li><strong>製作</strong><span>建專案、放模型、排 cue</span></li>
        <li><strong>動畫師</strong><span>交影片（V1、V2…）</span></li>
        <li><strong>提交審查</strong><span>導演收到通知</span></li>
        <li><strong>導演</strong><span>看、留言、通過或需修改</span></li>
        <li><strong>客戶</strong><span>用分享連結看成果</span></li>
      </ol>

      <Section id={A.roles} title="四種角色和歌的狀態">
        <div className="help-table-wrap">
          <table className="help-table help-table--wide">
            <caption>每個人在專案裡是哪個角色，就看到哪些東西</caption>
            <thead><tr><th>角色</th><th>做什麼</th><th>怎麼進來</th></tr></thead>
            <tbody>
              <tr><td>製作</td><td>建專案、放 3D 模型、排歌和 cue、設定機關、邀請大家、建分享連結</td><td>登入碼</td></tr>
              <tr><td>動畫師</td><td>交影片、用 AE 即時在 LED 上看自己的動畫、看導演的意見、提交審查</td><td>邀請連結（或登入碼）</td></tr>
              <tr><td>導演</td><td>看每首歌的影片放在 LED 上的樣子、留言、按「通過」或「需修改」；有影片連結也可以貼上來加一版</td><td>邀請連結（或登入碼）</td></tr>
              <tr><td>客戶</td><td>看成果：3D 舞台、每首歌最新的一版影片。只能看，不能改</td><td>分享連結，不用帳號</td></tr>
            </tbody>
          </table>
        </div>
        <p>角色是<strong>每個專案分開</strong>的：同一個人可以在 A 專案是導演、在 B 專案是動畫師。每個人只看得到自己被加入的專案（製作看得到全部）。</p>

        <div className="help-table-wrap">
          <table className="help-table">
            <caption>每首歌都有一個狀態</caption>
            <tbody>
              <tr><td><Dot s="todo" />待製作</td><td>還沒交給導演看</td></tr>
              <tr><td><Dot s="review" />審查中</td><td>動畫師提交了，等導演看</td></tr>
              <tr><td><Dot s="changes" />需修改</td><td>導演要改，原因寫在留言裡</td></tr>
              <tr><td><Dot s="approved" />已通過</td><td>導演通過了</td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id={A.loginInvite} title="用邀請連結進來">
        <p>導演、動畫師通常會收到製作傳來的<strong>邀請連結</strong>（LINE、微信、Email 都可以），點開就能進專案，不用記密碼。</p>
        <ol className="help-steps">
          <li>點開邀請連結。畫面會寫「<Ui>（你的名字）你好</Ui>」、專案名稱和你的身分。</li>
          <li>按「<Ui>進入專案</Ui>」。</li>
          <li>直接進到專案：動畫師進「動畫師工作站」，導演進「導演審片」頁。</li>
          <li>這台裝置會記得你，下次直接打開網站就可以。</li>
        </ol>
        <FigRow>
          <F k="inviteOpenPhone" />
          <F k="inviteOpen" />
        </FigRow>
        <Note title="在手機上">
          <p>在 LINE 裡點開的話，建議先選「<Ui>用瀏覽器開啟</Ui>」（Safari 或 Chrome）再按「進入專案」，之後用同一個瀏覽器打開網站才會記得你。</p>
        </Note>
        <ul className="help-list">
          <li>邀請連結有期限（例如 7 天），通常<strong>只能用一次</strong>。過期或用過了，畫面會寫「這個連結不能用了」→ 跟製作要一個新的。</li>
          <li>換了手機、換了電腦：請製作再傳一個邀請連結給你。</li>
          <li>已經有登入碼的話，也可以到登入頁用登入碼登入。</li>
        </ul>
      </Section>

      <Section id={A.loginCode} title="用登入碼登入">
        <ol className="help-steps help-steps--marked">
          <li><Num n={1} />打開網站（<code>previz.haimiaan.com</code>），沒登入會自動到登入頁。在「<Ui>登入碼</Ui>」輸入製作給你的登入碼，按「<Ui>登入</Ui>」。</li>
        </ol>
        <F k="login" />
        <ul className="help-list">
          <li>登入碼是 10 個英文字母和數字（沒有 0、O、1、I 這種容易看錯的字）。大小寫、中間有沒有空格都沒關係。</li>
          <li>忘記登入碼：請製作按「<Ui>重設</Ui>」給你一組新的（舊的會馬上不能用）。</li>
          <li>同一台電腦連續打錯 10 次，要等 15 分鐘才能再試。</li>
          <li>登入碼不要給別人：拿到的人就能用你的身分進來。</li>
        </ul>
      </Section>

      <Section id={A.landing} title="登入後會到哪裡">
        <div className="help-table-wrap">
          <table className="help-table help-table--wide">
            <tbody>
              <tr><td>製作</td><td>「專案總覽」：所有專案。點專案進編輯頁。</td></tr>
              <tr><td>動畫師</td><td>「動畫師工作站」。只有一個專案就直接進去；有好幾個會先讓你選。</td></tr>
              <tr><td>導演</td><td>「導演審片」頁。只有一個專案就直接進去；有好幾個會先讓你選。</td></tr>
              <tr><td>客戶</td><td>分享連結直接打開 3D 舞台，不用登入。</td></tr>
            </tbody>
          </table>
        </div>
        <p>管理頁（專案總覽、用戶…）只有製作能開。每個人都有「<Ui>設定</Ui>」頁：看自己的帳號、檢查 AE 即時的連線。</p>
      </Section>

      <Section id={A.notifications} title="通知（小鈴鐺）">
        <p>上方的<strong>小鈴鐺</strong>（製作的管理頁在左下角）會告訴你跟你有關的事，數字是還沒看的則數。</p>
        <ul className="help-list">
          <li>有人在留言裡 <strong>@ 你</strong>、有人<strong>回覆</strong>你的留言</li>
          <li>你的歌被「<Ui>需修改</Ui>」或「<Ui>通過</Ui>」（動畫師）</li>
          <li><strong>有新版等你審</strong>（導演）</li>
          <li>歌<strong>指派給你</strong>（動畫師）</li>
        </ul>
        <F k="notifications" />
        <ul className="help-list">
          <li>點一則：直接打開那首歌、那一版影片、那則留言。</li>
          <li>「<Ui>全部標為已讀</Ui>」：把數字清掉。</li>
          <li>每 25 秒自動更新，切回這個分頁時也會馬上更新。60 天以前的通知會自動清掉。</li>
          <li>用分享連結看的客戶沒有通知。</li>
        </ul>
      </Section>
    </Chapter>
  );
}

// ═══════════════════════════ 製作 ═══════════════════════════

function ProducerChapter() {
  return (
    <Chapter id={A.producer} lead="製作負責把專案準備好：模型、歌、cue、機關，再把動畫師和導演邀請進來。下面照第一次建專案的順序寫。">
      <ol className="help-flow help-flow--steps" aria-label="第一次建專案的順序">
        <li><strong>1 建專案</strong></li>
        <li><strong>2 匯入模型</strong></li>
        <li><strong>3 測距校準</strong></li>
        <li><strong>4 加歌</strong></li>
        <li><strong>5 邀請、指派</strong></li>
        <li><strong>6 排 cue、機關</strong></li>
        <li><strong>7 分享給客戶</strong></li>
      </ol>

      <Section id={A.prodProject} title="建立專案">
        <F k="adminOverview" />
        <p>左邊選「<Ui>專案</Ui>」（專案總覽），按右上角「<Ui>＋ 新增專案</Ui>」。接下來會一步一步帶你把專案準備好，最上面看得到在第幾步：</p>
        <ol className="help-steps">
          <li><strong>名稱</strong>：填「<Ui>專案名稱</Ui>」（例：魅影巡演 2026），同一場巡迴的不同場次可以選同一個「<Ui>Show</Ui>」，需要的話寫一句描述 → 按「<Ui>建立專案</Ui>」。按下去專案就建好了。</li>
          <li><strong>3D 模型</strong>：按「<Ui>上傳 3D 模型</Ui>」（跟編輯頁的上傳視窗一樣，看 <Go to={A.prodModel}>匯入 3D 模型</Go>）。匯入後寫「找到 4 片 LED、2 個機關…」；名稱沒對到命名規則的會提醒你（看 <Go to={A.prodNaming}>物件怎麼命名</Go>）。</li>
          <li><strong>LED 畫布大小</strong>：AE 合成的寬 × 高（像素），先放常用的 3840 × 2160。有模型的話下面會畫出每塊 LED 在畫布上的位置（跟 <Go to={A.prodLedCanvas}>LED 對位圖</Go> 一樣）。</li>
          <li><strong>歌單</strong>：把歌單貼進來，一行一首。前面的編號（「1. 開場」）會拿掉、空行跳過、重複的只留一首；寫了「S01 開場」就用 S01 當歌曲代號，沒寫的照順序排 S01、S02…。下面的表格裡代號、歌名都可以改；專案裡已經有動畫師的話，可以先選負責動畫師 → 按「<Ui>加入 N 首歌</Ui>」。</li>
          <li><strong>邀請人</strong>：建邀請連結給動畫師、導演，按「<Ui>複製訊息</Ui>」貼到 LINE / 微信（看 <Go to={A.prodInvite}>邀請連結</Go>）。</li>
          <li><strong>完成</strong>：列出做好了什麼、還沒做什麼。按「<Ui>進入編輯頁</Ui>」繼續排 cue；也可以直接「<Ui>建立分享連結</Ui>」或「<Ui>用其他身分看</Ui>」。</li>
        </ol>
        <FigRow>
          <F k="newProject" />
          <F k="newProjectModel" />
        </FigRow>
        <FigRow>
          <F k="newProjectSongs" />
          <F k="newProjectDone" />
        </FigRow>
        <Note title="每一步都可以先跳過">
          <p>除了名稱，每一步都可以按「<Ui>先跳過</Ui>」，之後在編輯頁做。按「<Ui>上一步</Ui>」或瀏覽器、手機的返回鍵回到上一步；最上面的步驟也可以直接點。</p>
          <p>中途按右上角的叉叉或 Esc 離開也沒關係：做好的都已經存在專案上。專案總覽上面會寫「還沒設定完」，按「<Ui>繼續設定</Ui>」從還沒做的那一步接著做。</p>
        </Note>
        <F k="projectCardMenu" />
        <p>專案卡片右上角的「<Ui>⋯</Ui>」：</p>
        <ul className="help-list">
          <li><strong>複製專案</strong>：開新場次最快。會帶過去：模型（共用同一份，不用重新上傳）、物件、歌曲（代號、狀態、負責動畫師）、cue 和每個 cue 的位置、機關。<strong>不會</strong>帶過去：影片版本、留言、審片紀錄、成員和分享連結，新專案要再邀請導演和動畫師。</li>
          <li><strong>匯出 JSON</strong>：把整個專案存成一個檔案備份。要放回來：專案總覽右上角「<Ui>匯入</Ui>」，或直接把檔案拖進頁面。</li>
          <li><strong>編輯標籤</strong>、<strong>封存</strong>（看 <Go to={A.prodArchive}>封存和還原</Go>）。</li>
          <li><strong>用其他身分看</strong>：導演、動畫師、客戶打開來看到的畫面（看 <Go to={A.prodViewAs}>用導演 / 動畫師的畫面看</Go>）。</li>
        </ul>
        <p>編輯頁長這樣：</p>
        <F k="editorOverview" />
      </Section>

      <Section id={A.prodModel} title="匯入 3D 模型">
        <ol className="help-steps">
          <li>編輯頁右邊點「<Ui>物件</Ui>」分頁，按「<Ui>上傳模型</Ui>」（新專案的 3D 畫面中間也有「<Ui>上傳模型</Ui>」按鈕）。</li>
          <li>把 <code>.glb</code>（或 <code>.gltf</code>）拖進框裡，或點一下選檔案。</li>
          <li>系統讀出模型裡的物件，照名稱自動分類（LED 面板、機關、表演者…）。沒對到命名規則的會標出來，在「<Ui>分類</Ui>」選單自己選。</li>
          <li>「<Ui>顯示名稱</Ui>」可以先改成大家好認的名字。</li>
          <li>按「<Ui>匯入 N 個物件</Ui>」。</li>
        </ol>
        <FigRow>
          <F k="uploadModel" />
          <F k="uploadReview" />
        </FigRow>
        <ul className="help-list">
          <li><strong>換新版模型</strong>：一樣按「上傳模型」。物件名稱沒變的話選「<Ui>不清除，直接匯入</Ui>」，每個 cue 裡的位置都會留著。勾「清除這個專案現有的物件後再匯入」會把每個 cue 裡這些物件的位置一起刪掉（匯入前會再問一次）。</li>
          <li><strong>歷史版本</strong>：以前上傳的模型都留著，可以切回舊版。<strong>模型庫</strong>：用別的專案上傳過的模型，不用重複上傳。</li>
          <li><strong>自動壓縮</strong>：上傳時系統會先把模型壓小（例：「<Ui>模型壓縮好了：60 MB → 4.7 MB</Ui>」），大家打開 3D 畫面快很多，網路慢、在大陸也一樣。只壓縮形狀資料，物件名稱、位置、旋轉、縮放、UV 都會檢查過跟原檔一模一樣才用；檢查沒過就照樣上傳原檔。以前上傳、還沒壓縮的模型：到「<Ui>歷史版本</Ui>」按目前那一版的「<Ui>壓縮這個模型</Ui>」，會多一個壓縮過的新版本，物件和每個 cue 的位置都不動，舊的那一版留著可以切回。</li>
          <li>沒有模型也可以先按「<Ui>範例</Ui>」加 10 個常用物件試試看。</li>
          <li>尺寸：模型的 1 單位 = 1 公尺。舞台對角通常 5～50 公尺，太大或太小系統會提醒、自動放大縮小。尺寸對不上請用 <Go to={A.prodCalibrate}>測距校準</Go>，<strong>不要去縮放模型</strong>（會讓每個 cue 的位置跑掉）。</li>
        </ul>

        <Section id={A.prodNaming} level={3} title="物件怎麼命名（C4D / GLB 匯出）">
          <p>名稱的<strong>開頭</strong>決定分類，後面接底線 <code>_</code> 或減號 <code>-</code>，英文大小寫都可以：</p>
          <div className="help-table-wrap">
            <table className="help-table help-table--wide">
              <thead><tr><th>名稱開頭</th><th>分類</th><th>例子</th></tr></thead>
              <tbody>
                <tr><td><code>LED_</code></td><td>LED 面板：會顯示影片、AE 畫面</td><td><code>LED_01_主牆</code></td></tr>
                <tr><td><code>STAGE_</code>、<code>MECH_</code></td><td>機關：升降台、轉台…</td><td><code>STAGE_01_中央升降台</code></td></tr>
                <tr><td><code>ARTIST_</code></td><td>表演者</td><td><code>ARTIST_01_主唱</code></td></tr>
                <tr><td><code>PROP_</code>、<code>LIGHT_</code></td><td>燈光 / 道具</td><td><code>PROP_01_麥架</code>、<code>LIGHT_01_搖頭</code></td></tr>
                <tr><td><code>WALK_</code></td><td>走位點</td><td><code>WALK_01_主舞</code></td></tr>
                <tr><td>其他名稱</td><td>其他（可以手動改分類）</td><td><code>舞台地板</code></td></tr>
              </tbody>
            </table>
          </div>
          <ul className="help-list">
            <li><strong>顯示名稱</strong>：去掉開頭、底線換成空格。<code>LED_01_主牆</code> 會顯示成「01 主牆」。</li>
            <li><strong>每個要在 cue 裡單獨移動的東西，都要是一個獨立的物件</strong>，而且放在同一層（可以全部包在一個總群組裡，例如「舞台」，系統會找名稱對到最多的那一層）。一個物件底下可以有很多零件，會一起動，例如轉台和上面的白線。</li>
            <li>名稱不要重複（重複的第二個會被跳過），不要沒有名字。</li>
            <li><strong>不要把整個場景合併成一個物件</strong>，不然只讀得到一個東西。</li>
            <li>匯出成 <code>.glb</code>，單位設成<strong>公尺</strong>（1 單位 = 1 公尺）。</li>
            <li><strong>LED 的 UV</strong> 決定每塊 LED 拿 AE 畫面的哪一塊：在 UV 編輯器裡把每塊 LED 擺在 AE 合成上對應的位置。匯入後用 <Go to={A.prodLedCanvas}>LED 對位圖</Go> 和 <Go to={A.animTestPattern}>LED 顯示測試圖</Go> 檢查。</li>
            <li><code>STAGE_</code>、<code>MECH_</code> 只是分類。要讓升降台、轉台真的照 cue 動，還要在「機關」分頁設定一次（看 <Go to={A.prodMechanisms}>機關</Go>）。</li>
          </ul>
        </Section>
      </Section>

      <Section id={A.prodCalibrate} title="測距校準">
        <p>機關的行程、物件的位置都是用<strong>公尺</strong>算的。模型的單位不準時，先用一個知道長度的東西（例如主牆的寬度）校準一次，畫面上的距離才會對。</p>
        <ol className="help-steps">
          <li>3D 工具列按「<Ui>測距</Ui>」（尺的圖示；工具列太窄時收在最右邊的「<Ui>⋯</Ui>」裡）。</li>
          <li>在 3D 畫面點兩個點（地板或物件表面），例如主牆的左邊和右邊。</li>
          <li>畫面下方顯示量到的距離 → 按「<Ui>設為已知距離</Ui>」。</li>
          <li>輸入它實際是幾公尺（例：12）→ 按「<Ui>套用</Ui>」。</li>
        </ol>
        <FigRow>
          <F k="measure" />
          <F k="calibrate" />
        </FigRow>
        <ul className="help-list">
          <li>校準是<strong>整個專案、所有人一起用</strong>的：測距、比例尺、機關都會換算。</li>
          <li>量錯了再量一次就好；「<Ui>重設</Ui>」回到模型原本的尺寸。</li>
          <li>只有製作可以校準。</li>
        </ul>
      </Section>

      <Section id={A.prodSongs} title="歌曲和歌曲代號">
        <ol className="help-steps">
          <li>編輯頁左邊「<Ui>歌曲</Ui>」最下面按「<Ui>＋ 新增歌曲</Ui>」，輸入歌名 → 「<Ui>新增</Ui>」。</li>
          <li>每首歌會自動拿到一個<strong>歌曲代號</strong>：S01、S02、S03…</li>
          <li>點代號可以改：英文字母、數字，中間可以有 <code>-</code>，最多 12 個字（例：S05、ENC-1）。S1 和 S01 算同一個。</li>
          <li>每首歌最右邊的「<Ui>⋯</Ui>」裡有：上移 / 下移（換順序<strong>不會</strong>改代號）、改名、刪除（歌的所有 cue 會一起刪掉）。</li>
        </ol>
        <F k="songList" />
        <ul className="help-list">
          <li>狀態（待製作、審查中…）點一下可以直接改。改成「需修改」一定要寫原因。</li>
          <li>上面的狀態按鈕可以只看某個狀態的歌；「只看我改過的」只列你動過的歌。</li>
          <li>代號會出現在 Drive 檔名、通知、分享連結的歌單上。</li>
        </ul>

        <Section id={A.prodVideos} level={3} title="影片版本（看、刪除）">
          <p>歌單上的「<Ui>影片 V3</Ui>」點一下，會打開這首歌的「<Ui>影片版本</Ui>」：</p>
          <F k="songVideos" />
          <ul className="help-list">
            <li>每一版都列出來，<strong>新的在前</strong>：號碼、誰交的、什麼時候、說明、狀態（可以播 / 這台電腦播不了；還沒好的寫上傳中、複製中幾 %、失敗）。</li>
            <li>「<Ui>到導演頁播放</Ui>」：在新分頁打開導演頁，直接放這一版。</li>
            <li>「<Ui>刪除 V2</Ui>」：所有人的清單上都看不到這一版，沒辦法從畫面上救回來。<strong>號碼不會再用</strong>：有 V1～V3 時刪掉 V2，下一版是 V4，不會補回 V2。</li>
            <li>沒交成功或卡住的：貼連結的可以「<Ui>重試</Ui>」，上傳停住的可以「<Ui>繼續上傳</Ui>」（選同一個檔案），不要了按「<Ui>取消</Ui>」或「<Ui>拿掉</Ui>」，號碼不會被佔走。</li>
            <li>下面的「<Ui>加影片</Ui>」跟歌單上的「<Ui>＋ 加影片</Ui>」一樣。還沒有影片的歌，歌單上寫「還沒有影片」。</li>
          </ul>
        </Section>

        <Section id={A.prodDrive} level={3} title="Google Drive 資料夾（選用）">
          <p>動畫師習慣把影片丟到 Google Drive 的話，可以讓系統自動抓進來：</p>
          <ol className="help-steps">
            <li>左邊「<Ui>Drive 來源</Ui>」→「<Ui>＋ 連接 Google</Ui>」（只要一次，只要讀取權限）。</li>
            <li>回到專案編輯頁，上方按「<Ui>Drive</Ui>」。</li>
            <li>選 Google 帳號，貼上 Drive 資料夾的連結 →「<Ui>存設定</Ui>」。</li>
            <li>規則：<strong>{DRIVE_MATCH_RULE}</strong>。</li>
          </ol>
          <F k="drive" />
          <ul className="help-list">
            <li><code>S03_主題曲.mp4</code>、<code>S03-主題曲.mov</code>、<code>S03 主題曲.mp4</code>、<code>S03.mp4</code> 都算 S03；<code>S03A_x.mp4</code> 不算。</li>
            <li>每 5 分鐘自動同步，也可以按「<Ui>立即同步</Ui>」。新的或改過的影片會變成那首歌的下一個版本（V1、V2…），系統會複製一份到我們自己的伺服器播放。</li>
            <li>只收影片檔。對不到代號的放在「<Ui>未分類</Ui>」，可以手動選是哪首歌。</li>
            <li>瀏覽器播不了的格式（例如 .mkv）會顯示失敗。</li>
          </ul>
        </Section>
      </Section>

      <Section id={A.prodAssign} title="指派負責動畫師">
        <ol className="help-steps">
          <li>先把動畫師邀請進這個專案（看 <Go to={A.prodInvite}>邀請連結</Go>）。</li>
          <li>歌單上每首歌的「<Ui>負責動畫師</Ui>」選單選一個人。</li>
          <li>他會收到通知，這首歌出現在他工作站的「<Ui>我的</Ui>」。</li>
        </ol>
        <ul className="help-list">
          <li><strong>指派了</strong>：只有那位動畫師（和製作）可以交影片、提交審查、留言。別的動畫師只能看。</li>
          <li><strong>沒指派</strong>：專案裡的動畫師都可以交影片、提交。</li>
          <li><strong>導演</strong>：可以用「<Ui>貼連結</Ui>」加一版（不能上傳檔案）。導演貼的不會把歌從「需修改」改回「審查中」，會通知這首歌的動畫師和製作（看 <Go to={A.dirAddLink}>貼連結加影片</Go>）。</li>
        </ul>
      </Section>

      <Section id={A.prodCues} title="cue：位置和轉場">
        <p>一個 <strong>cue</strong> 就是一個舞台畫面：每個物件在哪裡、轉幾度、看不看得到。一首歌由好幾個 cue 組成。</p>
        <ol className="help-steps">
          <li>左邊選一首歌，右邊點「<Ui>Cue</Ui>」分頁。</li>
          <li>按「<Ui>＋ 新增 cue</Ui>」= 空白 cue（全部在預設位置）。旁邊的小箭頭還有：「<Ui>沿用目前的 cue</Ui>」（複製目前 cue 的所有調整）、「<Ui>從目前 3D 狀態建立</Ui>」、「<Ui>從常用擺位建立</Ui>」。</li>
          <li>點一個 cue，會跳到「<Ui>物件狀態</Ui>」分頁。</li>
          <li>在 3D 畫面點物件，用「<Ui>移動</Ui>」（W）、「<Ui>旋轉</Ui>」（E）拖；或在右邊直接打數字（位置是公尺、角度是度），按 Enter 或點別的地方就存。按住 Shift 點可以選好幾個一起動。</li>
          <li>眼睛圖示：這個 cue 裡顯示 / 隱藏這個物件。</li>
        </ol>
        <FigRow>
          <F k="cueList" />
          <F k="cueAdd" />
        </FigRow>
        <Note title="沿用上一個 cue">
          <p>cue 沒有另外設定的物件，會<strong>沿用同一首歌前一個 cue 的位置</strong>（不會跳回預設）。物件旁邊有小點 = 這個 cue 自己設定的。在前面的 cue 動了東西，後面沒另外設定的 cue 會跟著。</p>
        </Note>
        <p>每個 cue 最右邊的「<Ui>⋯</Ui>」裡有：上移 / 下移、複製、存成常用擺位、<strong>重置</strong>（清掉這個 cue 自己設的物件位置和機關位置，改回沿用上一個 cue）、改名、刪除。</p>
        <p>每個 cue 上面有兩個重要的數字（在「物件狀態」分頁最上面）：</p>
        <ul className="help-list">
          <li><strong>轉場（秒）</strong>：換到這個 cue 時，舞台花幾秒滑過去。<strong>0 = 直接切換</strong>（不滑）。cue 清單上寫「轉場 6 秒」或「直接切換」。</li>
          <li><strong>對應影片時間</strong>：影片播到這一秒，這個 cue 剛好到位。寫秒數（15.5）或 分:秒（1:23）。空白 = 不跟影片走。</li>
        </ul>
        <F k="cueMeta" />

        <Section id={A.prodCueTiming} level={3} title="cue 怎麼跟著影片時間走">
          <p>有填「對應影片時間」的 cue，在導演頁、工作站、分享連結<strong>播影片時</strong>會自己切，舞台跟著影片動：</p>
          <ul className="help-list">
            <li>cue 在「對應影片時間」那一秒<strong>剛好到位</strong>。</li>
            <li>開始動的時間 = 對應影片時間 − 轉場秒數。例：<strong>cue 在 30 秒、轉場 20 秒 → 影片 10 秒開始動，30 秒到位</strong>。</li>
            <li>不會比上一個 cue 到位還早出發：上一個 cue 30 秒才到，下一個 cue 就從 30 秒開始動。</li>
            <li>轉場 0（直接切換）= 到那一秒直接換。</li>
            <li>往回拉、跳著看，畫面都一樣（照時間算出來的）。點 cue 列的某個 cue，影片會跳到那個 cue 的時間。</li>
            <li>沒填影片時間的 cue 不會自動切，要手動點。</li>
          </ul>
          <CueTimelineMock />
        </Section>

        <Section id={A.prodTemplates} level={3} title="常用擺位">
          <p>常常用到的舞台畫面（例如「主唱升起」）可以存起來，下次新增 cue 直接套用。</p>
          <ol className="help-steps">
            <li>按 cue 最右邊的「<Ui>⋯</Ui>」→「<Ui>存成常用擺位</Ui>」。</li>
            <li>取名字 →「<Ui>下一步</Ui>」→ 選「<Ui>只給這個專案</Ui>」或「<Ui>所有專案都能用</Ui>」。</li>
            <li>要用的時候：「新增 cue」旁的小箭頭 →「<Ui>從常用擺位建立</Ui>」→ 選一個按「<Ui>套用</Ui>」。</li>
          </ol>
          <FigRow>
            <F k="templateSave" />
            <F k="templatePick" />
          </FigRow>
          <ul className="help-list">
            <li>存的是每個物件的位置（照物件名稱對，所以別的專案物件名稱一樣也套得上）和機關位置（照機關名稱對）。</li>
            <li>刪除：在選擇視窗按垃圾桶。已經用它建好的 cue 不受影響。</li>
          </ul>
        </Section>

        <Section id={A.prodUndo} level={3} title="復原、重做和快捷鍵">
          <ul className="help-list">
            <li>上方「<Ui>復原</Ui>」（Ctrl+Z，Mac 是 Cmd+Z）、「<Ui>重做</Ui>」（Ctrl+Shift+Z 或 Ctrl+Y）。括號裡的數字 = 還能復原幾步。</li>
            <li><strong>每個 cue 分開記</strong>：只會復原「這個 cue」最近 50 步的修改（位置、角度、顯示、機關位置），換 cue 不會改到別的 cue。</li>
            <li>在文字欄位裡打字時，Ctrl+Z 是復原打的字。</li>
            <li>刪除 cue、刪除歌不能復原（會先問你）。</li>
          </ul>
          <div className="help-table-wrap">
            <table className="help-table">
              <caption>常用快捷鍵（編輯頁）</caption>
              <tbody>
                <tr><td><kbd>W</kbd> / <kbd>E</kbd></td><td>移動 / 旋轉</td></tr>
                <tr><td><kbd>Q</kbd></td><td>世界座標軸 / 物件自己的軸</td></tr>
                <tr><td><kbd>L</kbd></td><td>顯示 / 隱藏物件名稱</td></tr>
                <tr><td><kbd>X</kbd></td><td>線框（看穿模型）</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>取消選取</td></tr>
                <tr><td><kbd>J</kbd> / <kbd>K</kbd></td><td>下一首 / 上一首歌</td></tr>
                <tr><td><kbd>Shift</kbd>+<kbd>J</kbd> / <kbd>K</kbd></td><td>下一個 / 上一個 cue</td></tr>
                <tr><td><kbd>?</kbd></td><td>管理頁的快速說明</td></tr>
              </tbody>
            </table>
          </div>
        </Section>
      </Section>

      <Section id={A.prodMechanisms} title="機關（升降台、轉台、滑軌）">
        <p><strong>機關</strong> = 舞台上會動的機械。每個機關設定一次（帶哪些物件、往哪裡動、能走多遠、多快），之後每個 cue 只要選位置。導演、動畫師、客戶看到的機器會照<strong>真的速度</strong>動，太快的地方製作會先看到提醒。</p>
        <F k="mechTab" />
        <p>「機關」分頁標題旁邊的「<Icon icon={CircleHelp} />」會打開這一段說明。機關只有製作能改，導演和動畫師只看得到它動。</p>

        <Section id={A.prodMechSetup} level={3} title="設定機關（每個只要一次）">
          <ol className="help-steps">
            <li>右邊「<Ui>機關</Ui>」分頁，下面「設定機關」按「<Ui>＋ 新增機關</Ui>」。</li>
            <li><strong>名稱</strong>：例：中央升降台。</li>
            <li><strong>動作</strong>：「<Ui>直線移動</Ui>」或「<Ui>旋轉</Ui>」。</li>
            <li>直線：「<Ui>數字變大時往</Ui>」往上、往下、往觀眾、往舞台後方、往左、往右（左右是觀眾看過去的左右）。<br />
              旋轉：「<Ui>轉軸</Ui>」水平轉（像轉台）、前後翻、左右翻，和正的角度往哪邊轉；「<Ui>轉軸中心</Ui>」可以按「<Ui>用物件中心</Ui>」。</li>
            <li><strong>帶動的物件</strong>：勾要一起動的東西，例如升降台本體、前緣 LED、站在上面的主唱。也可以在 3D 畫面按住 Shift 點好幾個，再按「<Ui>用 3D 畫面選取的物件</Ui>」。</li>
            <li><strong>跟著另一個機關動</strong>（選填）：例如裝在轉台上的升降台，選「旋轉舞台」，轉台轉的時候會一起轉。</li>
            <li><strong>行程</strong>：最低、最高（公尺或度）。<strong>預設位置</strong>：沒有 cue 設定時停在這裡。</li>
            <li><strong>最高速度</strong>（選填）：公尺/秒、度/秒。填了才會檢查轉場夠不夠；沒填就照轉場秒數移動。</li>
            <li><strong>常用位置</strong>：例如 收起 / 半開 / 全開（按「<Ui>加入 收起 / 半開 / 全開</Ui>」會自動填最低、中間、最高），最多 12 個。</li>
            <li><strong>控台編號</strong>（選填）：自動化控台上這個軸的名字，例：Axis 12，會列在機關總表。</li>
            <li>按「<Ui>儲存</Ui>」。</li>
          </ol>
          <FigRow>
            <F k="mechForm" />
            <F k="mech3d" />
          </FigRow>
          <ul className="help-list">
            <li>位置從物件在 cue 裡原本的位置算起：<strong>0 = cue 放的位置</strong>，2.5 = 往上 2.5 公尺。</li>
            <li>一個物件只能直接放在一個機關裡（要疊在一起就用「跟著另一個機關動」）。</li>
            <li>看到「還沒做測距校準」的提醒：先做 <Go to={A.prodCalibrate}>測距校準</Go>，移動的距離才準。</li>
            <li>改了行程、有 cue 存的位置超出新的行程 → 會提醒「播放時會停在邊界」。</li>
            <li>「<Ui>刪除機關</Ui>」會一起清掉每個 cue 裡設定的機關位置，不能復原。</li>
          </ul>
        </Section>

        <Section id={A.prodMechCue} level={3} title="每個 cue 的機關位置">
          <ol className="help-steps">
            <li>選一個 cue（或用機關分頁上面的「<Ui>換 cue</Ui>」選單）。</li>
            <li>每個機關一行：點<strong>常用位置</strong>（收起、全開…）、拖滑桿，或在右邊打數字按 Enter。</li>
            <li>每行右上角寫這個位置是「<Ui>這個 cue 設定</Ui>」、「<Ui>沿用「主歌」</Ui>」還是「<Ui>預設位置</Ui>」。</li>
            <li>想回到沿用上一個 cue：按那一行最右邊的圓形箭頭「<Ui>回到沿用上一個 cue</Ui>」。</li>
          </ol>
          <ul className="help-list">
            <li>沒設定的 cue 沿用前一個 cue 的位置（跟物件一樣）。</li>
            <li>滑桿不會超出行程；拖的時候 3D 畫面跟著動，放開才存。Ctrl+Z 可以復原。</li>
            <li>沒選 cue 的時候，改的是「預設位置」。</li>
          </ul>
        </Section>

        <Section id={A.prodMechSpeed} level={3} title="來不及到位、照機器速度">
          <p>有填最高速度的機關，轉場太短時那一行會出現<strong>橘色提醒</strong>，「機關」分頁標題旁也會有一個橘點：</p>
          <ul className="help-list">
            <li>「<Ui>轉場 6 秒太快：這段要走 2.5 m（最高 0.25 m/秒），需要 10 秒</Ui>」→ 按「<Ui>照機器速度（10 秒）</Ui>」，這個 cue 的轉場會改成 10 秒（這個 cue 的其他物件也會用 10 秒移動）。</li>
            <li>「<Ui>跟上一個 cue 只隔 N 秒，機器需要 M 秒…</Ui>」：改轉場沒有用，要把這個 cue 的影片時間往後挪，或減少行程。</li>
            <li>「<Ui>上一段還沒走完，會晚 N 秒到位</Ui>」：前一個 cue 的機器還在走。</li>
            <li>「<Ui>cue 的順序跟影片時間對不上</Ui>」：清單順序和影片時間的順序不一樣，機關會從影片時間的上一個 cue 出發。</li>
          </ul>
          <p><strong>播放時</strong>（導演頁、工作站、分享連結）：機器照最高速度走，來不及就<strong>晚一點到</strong>，讓大家提早看到現場真的會發生的事。提醒只有製作看得到。</p>
          <p><strong>「照機器速度播放」</strong>（機關分頁上面的勾選）：</p>
          <ul className="help-list">
            <li>不勾（預設）：在編輯頁換 cue 時，機關照轉場秒數走，跟物件一起到，編輯比較快。提醒照樣會出現。</li>
            <li>勾了：換 cue 時機關照最高速度走，跟導演、客戶看到的一樣。</li>
            <li>這個勾選只記在你這台電腦。</li>
          </ul>
        </Section>

        <Section id={A.prodMechSheet} level={3} title="機關總表（給自動化控台操作員）">
          <ol className="help-steps">
            <li>機關分頁上面按「<Ui>匯出機關總表</Ui>」。</li>
            <li>下載一個 CSV 檔（<code>機關總表-專案名稱-日期.csv</code>），用 Excel 打開。</li>
          </ol>
          <ul className="help-list">
            <li>整個專案每首歌、每個 cue、每個機關一行：GO 時間、到位時間、轉場、控台編號、起點、目標、常用位置、行程、可用秒數、需要秒數、速度、檢查（OK、太快…）。</li>
            <li>可以在 Excel 篩選、排序、加自己的欄位，也可以印成 PDF。下面有每個機關的說明。</li>
            <li>只列正式的 cue。需要秒數用等速計算，沒有算加減速，實際會再久一點。</li>
          </ul>
        </Section>

        <Section id={A.prodMechConvert} level={3} title="把現有 cue 的位置轉成機關位置">
          <p>以前升降台、轉台是一個 cue 一個 cue 手動擺高度、角度的話，定義成機關之後兩種動法會加在一起。用這個按鈕把它們變成機關的位置：</p>
          <ol className="help-steps">
            <li>先「新增機關」，帶好那些物件（還沒在任何 cue 設過機關位置）。</li>
            <li>按那個機關的「<Ui>編輯</Ui>」，表單最下面按「<Ui>把現有 cue 的位置轉成機關位置</Ui>」。</li>
            <li>視窗會說會轉幾個 cue → 按「<Ui>轉換</Ui>」。</li>
          </ol>
          <ul className="help-list">
            <li><strong>畫面看起來不會變</strong>，之後就能檢查速度、匯出總表。</li>
            <li>物件動法不一致、或轉出來會超出行程的 cue 不會轉，會列出名字，照原本的樣子留著。</li>
            <li>只有還沒在 cue 裡設過位置的機關才有這個按鈕。想先試試看：先「複製專案」，在副本上試。</li>
          </ul>
        </Section>
      </Section>

      <Section id={A.prodLedCanvas} title="LED 畫布大小和 LED 對位圖">
        <p><strong>LED 畫布</strong> = 動畫師 AE 合成的寬 × 高。所有 LED 共用這一張畫面，每塊 LED 拿它自己那一塊（照模型的 UV）。</p>
        <ol className="help-steps">
          <li>3D 工具列最右邊按「<Ui>⋯</Ui>」，看「<Ui>LED 對位圖</Ui>」那一段。</li>
          <li>按「<Ui>設定畫布大小…</Ui>」，寫成「寬 × 高」（例：10496 × 5120）→「<Ui>儲存</Ui>」。</li>
          <li>「<Ui>下載對位圖（PNG）</Ui>」傳給動畫師，他放進 AE 當參考圖層。</li>
        </ol>
        <F k="ledMenu" />
        <F k="ledCanvas" />
        <ul className="help-list">
          <li>畫布大小存在專案上，<strong>所有人一起用</strong>。只有製作能改。</li>
          <li>沒設定的話：用目前影片的大小，沒有影片就用 3840 × 2160。選單最下面會寫現在是多大、從哪裡來的。</li>
          <li>「<Ui>下載位置表（CSV / JSON）</Ui>」：每塊 LED 的名字和 x、y、w、h。</li>
          <li>對位圖長什麼樣子、動畫師怎麼用：看 <Go to={A.animLedMap}>LED 對位圖（做 AE 合成）</Go>。</li>
        </ul>
      </Section>

      <Section id={A.prodView} title="重置攝影機和現場設定">
        <p><strong>重置攝影機</strong>（工具列的攝影機圖示）：把視角轉回設定好的畫面。旁邊的小箭頭可以設定這個畫面：</p>
        <ol className="help-steps">
          <li>在 3D 畫面轉到你想要的角度（拖拉旋轉、滾輪縮放）。</li>
          <li>按攝影機圖示旁邊的小箭頭「<Ui>設定重置攝影機的畫面</Ui>」。</li>
          <li>按「<Ui>用現在的畫面</Ui>」。也可以打數字，或「<Ui>回到自動（正面全景）</Ui>」。</li>
        </ol>
        <F k="homeView" />
        <p>所有人（包括分享連結的客戶）按「重置攝影機」都會回到這裡，第一眼看到的也是這個畫面，所以選一個最好看的角度。</p>
        <p><strong>畫面模式</strong>（工具列「快速 / 現場」）：</p>
        <ul className="help-list">
          <li><strong>快速</strong>：只看 LED 畫面本身（不受燈光、反光影響），看得最清楚。</li>
          <li><strong>現場</strong>：暗場、LED 照亮周圍、光暈、地板倒影，比較像演出當天的樣子。</li>
          <li>現場模式的「<Ui>設定</Ui>」：現場底光、曝光、LED 照明、光暈、LED 側看變暗、地板倒影、倒影清晰度。你調的只存在你這台電腦；按「<Ui>設為所有人的預設</Ui>」才會變成大家打開時的樣子。</li>
          <li>「<Ui>材質</Ui>」：依 C4D 材質名稱調顏色、亮霧面、金屬感、反射、透明度，指定鏡面地板（所有人共用）。</li>
        </ul>
        <F k="lookSettings" />
        <p><strong>LED 的顏色</strong>：快速和現場兩種模式，正面看 LED 都是影片、圖片原本的顏色，亮度和對比跟原檔一樣。現場設定的曝光、底光只改變舞台其他地方，不會改 LED 畫面；每塊 LED 自己的亮度設定照樣有用（1 = 跟原檔一樣）。這是固定的，沒有開關，所有人（包括動畫師、導演、分享連結）看到的都一樣。</p>
      </Section>

      <Section id={A.prodShare} title="分享連結和密碼">
        <p>分享連結給<strong>客戶或外部的人</strong>：不用帳號就能看 3D 舞台、每首歌最新的一版影片和 cue。只能看，不能改，看不到團隊的留言。</p>
        <ol className="help-steps">
          <li>編輯頁上方按「<Ui>分享</Ui>」。</li>
          <li><strong>範圍</strong>：整個專案，或只給某一首歌。</li>
          <li><strong>密碼</strong>（可選）：留空 = 不設密碼。</li>
          <li><strong>有效期</strong>：永久、1 天、7 天、30 天、90 天。</li>
          <li><strong>好讀網址名稱</strong>（例：jinma2026），建議勾「<Ui>加上隨機碼</Ui>」，別人比較猜不到。</li>
          <li>按「<Ui>＋ 建立分享連結</Ui>」，下面「已建立的連結」按複製圖示，貼給對方。</li>
        </ol>
        <F k="shareLinks" />
        <ul className="help-list">
          <li><strong>密碼另外告訴對方</strong>，不要跟連結放在同一則訊息比較安全。</li>
          <li>每條連結看得到瀏覽次數、上次什麼時候被看。</li>
          <li>刪除：已經傳出去的連結馬上打不開。改好讀網址：舊的好讀網址打不開，下面那串舊式網址照樣能用。</li>
          <li><strong>名稱</strong>（可選）：給誰看的，例：給經紀人。只有團隊看得到，連結清單上和訪客的留言上會寫。</li>
          <li><strong>允許看的人留言</strong>（只有製作能打開，預設關）：對方寫一個名字，就能在影片上留言、畫記、標區段。他們只看得到從這條連結留的留言、和你們在底下的回覆。建這條連結的人、專案的導演、這首歌的動畫師會收到通知（小鈴鐺）；訪客在一串留言底下回覆時，在這串回覆過的人也會收到。留言寫「<Ui>訪客：小李（給經紀人）</Ui>」。連結清單上的對話圖示可以隨時打開 / 關掉（關掉之後之前的留言還在）。</li>
          <li>客戶怎麼看：<Go to={A.client}>客戶（分享連結）</Go>。</li>
        </ul>
      </Section>

      <Section id={A.prodInvite} title="邀請連結（給導演、動畫師）">
        <p>最簡單的加人方法：傳一個連結，對方點開按「進入專案」就進來了（新的人會自動建帳號，不用記登入碼）。</p>
        <ol className="help-steps">
          <li>編輯頁上方按「<Ui>邀請</Ui>」（或左邊「<Ui>用戶</Ui>」→「<Ui>邀請連結</Ui>」，可以選專案）。</li>
          <li><strong>邀請誰</strong>：「<Ui>新的人</Ui>」寫名字；「<Ui>已經有帳號的人</Ui>」從清單選（例如他換了手機、忘記登入碼）。</li>
          <li><strong>角色</strong>：導演（進審片頁）或動畫師（進工作站）。</li>
          <li><strong>有效期限</strong>：1、3、7、14、30 天。建議勾「<Ui>只能用一次</Ui>」；不勾的話期限內最多可以用 10 次（同一個人手機、電腦都要開）。</li>
          <li>按「<Ui>建立邀請連結</Ui>」。</li>
          <li>按「<Ui>複製訊息</Ui>」，貼到 LINE / 微信。訊息已經寫好了，例如：<Quote>小明你好，這是「示範專案」的 Stage Previz 連結，點開就能進去看：https://previz.haimiaan.com/invite/…（7 天內有效，只能用一次）</Quote></li>
        </ol>
        <FigRow>
          <F k="inviteForm" />
          <F k="inviteResult" />
        </FigRow>
        <ul className="help-list">
          <li><strong>連結只會顯示這一次</strong>。要再傳給同一個人：在「還沒用的邀請連結」按「<Ui>撤銷</Ui>」，再建一個新的。</li>
          <li>撤銷之後，之前傳出去的連結馬上不能用。</li>
          <li>製作帳號不能用邀請連結，請在「用戶」頁新增、用登入碼登入。</li>
          <li>對方點開之後的樣子：<Go to={A.loginInvite}>用邀請連結進來</Go>。</li>
        </ul>
      </Section>

      <Section id={A.prodViewAs} title="用導演 / 動畫師的畫面看">
        <p>想知道導演、動畫師打開來看到什麼：編輯頁上方按「<Ui>用其他身分看</Ui>」（手機在「<Ui>⋯</Ui>」裡；專案總覽的專案卡片「<Ui>⋯</Ui>」也有）。每一種都開新分頁，編輯頁還在原來的分頁。</p>
        <ul className="help-list">
          <li><strong>導演畫面</strong>：導演頁的總覽、「<Ui>通過</Ui>」/「<Ui>需修改</Ui>」、留言，跟導演看到的一樣。</li>
          <li><strong>動畫師「小明」的畫面</strong>：動畫師工作站，「<Ui>我的</Ui>」就是指派給小明的歌。「<Ui>動畫師畫面（還沒指派歌的）</Ui>」是剛加進來、還沒有歌的動畫師看到的樣子。</li>
          <li><strong>客戶畫面（分享連結）</strong>：打開這個專案最新的分享連結（客戶看到的就是這個）。還沒有分享連結的話，會告訴你先到「<Ui>分享</Ui>」建立一個（看 <Go to={A.prodShare}>分享連結和密碼</Go>）。</li>
        </ul>
        <F k="viewAsMenu" />
        <p>預覽的時候，畫面最上面有一條橘色的「<Ui>預覽：導演看到的畫面（只能看，不會改到資料）</Ui>」：</p>
        <ul className="help-list">
          <li><strong>只能看</strong>：按鈕都在原來的位置，但按不下去（滑鼠移上去寫「預覽模式只能看」）。不會改到任何資料，也不會通知任何人。</li>
          <li>只在你這台電腦的動作照常可以用：播影片、換版本、比較兩版、本地檔案、AE 即時、轉攝影機、下載 LED 對位圖。</li>
          <li>預覽時小鈴鐺不顯示通知：裡面是你自己（製作）的通知，不是導演 / 動畫師的，回到編輯再看。</li>
          <li>橘色那條的右邊：「<Ui>換成動畫師</Ui>」/「<Ui>換成導演</Ui>」、換看哪一個動畫師、「<Ui>回到編輯</Ui>」。</li>
        </ul>
        <Note title="想從頭到尾真的走一次">
          預覽只能看。要真的試留言、提交審查、按通過：按「<Ui>邀請</Ui>」邀請一個測試用的人（例：名字寫「測試導演」），把邀請連結貼到瀏覽器的<strong>無痕視窗</strong>打開，就是另一個人登入，不會影響你自己的登入。
          測試帳號做的事是真的（例如提交審查，專案裡的導演會收到通知），建議先「<Ui>複製專案</Ui>」出一份來試；試完在「<Ui>用戶</Ui>」頁停用這個測試帳號。
        </Note>
      </Section>

      <Section id={A.prodLoginCodes} title="用戶和登入碼">
        <F k="users" />
        <ul className="help-list">
          <li><strong>新增用戶</strong>：名稱、預設角色、指派到哪些專案 →「<Ui>建立並產生登入碼</Ui>」。</li>
          <li><strong>登入碼只顯示這一次</strong>：按「<Ui>複製登入碼</Ui>」或「<Ui>複製訊息</Ui>」（已經寫好怎麼登入），傳給對方。關掉之後就看不到了。</li>
          <li><strong>忘記登入碼</strong>：按「<Ui>重設</Ui>」，舊的馬上不能用，新的一樣只顯示一次。用邀請連結進來的人沒有登入碼，需要的話按「<Ui>產生登入碼</Ui>」。</li>
          <li><strong>指派</strong>：加進 / 移出專案、改他在某個專案的角色。</li>
          <li><strong>停用</strong>：不能登入，資料都留著，之後可以「啟用」。垃圾桶是<strong>永久刪除</strong>，救不回來。</li>
        </ul>
        <F k="loginCode" />
      </Section>

      <Section id={A.prodSystem} title="系統狀態（備份和錯誤）">
        <p>「<Ui>設定</Ui>」頁最下面的「<Ui>系統狀態</Ui>」，只有製作看得到：</p>
        <ul className="help-list">
          <li><strong>資料庫備份</strong>：每天自動備份一份。看最近一份的時間、大小、留了幾份；「<Ui>下載最近一份</Ui>」存一份到自己電腦。備份失敗會寫出來，隔天會再做。</li>
          <li><strong>最近 7 天的畫面錯誤</strong>：大家的畫面出錯會自動回報到這裡，同一個問題算一組（幾次、幾個人、最後一次在哪一頁）。看到錯誤可以截圖給我們。</li>
        </ul>
        <F k="systemStatus" />
      </Section>

      <Section id={A.prodArchive} title="封存和還原">
        <ul className="help-list">
          <li><strong>封存</strong>：專案卡片的「<Ui>⋯</Ui>」→「<Ui>封存</Ui>」（或勾好幾個專案「<Ui>批次封存</Ui>」）。封存的專案不會出現在專案總覽，導演、動畫師也打不開，資料都留著。</li>
          <li><strong>還原</strong>：左邊「<Ui>封存的專案</Ui>」→「<Ui>還原</Ui>」，回到專案總覽，大家又看得到。</li>
        </ul>
        <F k="archived" />
      </Section>
    </Chapter>
  );
}

// ═══════════════════════════ 動畫師 ═══════════════════════════

function AnimatorChapter() {
  return (
    <Chapter id={A.animator} lead="在動畫師工作站交影片、看導演的意見；用 AE 即時或本地檔案，直接在 3D 舞台的 LED 上看自己的動畫。">
      <Section id={A.animStudio} title="工作站畫面">
        <F k="studioOverview" />
        <ul className="help-list">
          <li>① <strong>歌曲</strong>：「<Ui>我的</Ui>」= 指派給你的歌，「<Ui>全部</Ui>」= 整個專案。歌名旁邊的小圓點是狀態，「有新版」= 導演還沒看過的版本，留言圖示的數字 = 新留言。</li>
          <li>② <strong>LED 畫面來源</strong>：影片 / AE 即時 / 本地檔案（下一段）。</li>
          <li>③ <strong>這首歌的影片</strong>：V2、V1…和「<Ui>＋ 加影片</Ui>」。</li>
          <li>④ <strong>小播放器</strong>：播放、暫停、拉時間、循環、聲音、比較。按住上面那條可以拖到別的地方，右上角可以收起來。</li>
          <li>⑤ <strong>cue 列</strong>：點一個 cue 看那個舞台畫面（有放影片的話，影片跳到那個 cue 的時間）。</li>
          <li>⑥ 右邊：<strong>Cue</strong> 清單、<strong>審查 / 留言</strong>、<strong>活動</strong>（專案最近的修改）。</li>
        </ul>
        <p>鍵盤：<kbd>[</kbd> / <kbd>]</kbd> 切歌（以前是 J / K，現在 J / K / L 給播放用），<kbd>Shift</kbd>+<kbd>J</kbd> / <kbd>K</kbd> 切 cue；播放的快捷鍵看 <Go to={A.dirPlayer}>播放器和快捷鍵</Go>。3D 畫面拖拉旋轉、滾輪縮放；轉亂了按攝影機圖示「重置攝影機」。</p>
      </Section>

      <Section id={A.animSource} title="LED 畫面來源：影片 / AE 即時 / 本地檔案">
        <F k="sourceSwitch" />
        <ul className="help-list">
          <li>① <strong>影片</strong>（例：影片 V2）：放這首歌交上來的影片，預設最新一版。舞台跟著影片時間切 cue。</li>
          <li>② <strong>AE 即時</strong>：LED 直接顯示你 After Effects 裡的畫面，AE 一動 LED 就跟著動。要先裝 NDI 小程序，看 <Go to={A.aeLive}>AE 即時預覽</Go> 那一章。</li>
          <li>③ <strong>本地檔案</strong>：選這台電腦裡的影片或圖片放到 LED 上。<strong>不會上傳、別人看不到</strong>，關掉頁面就沒了。要給導演看請用「加影片」。</li>
        </ul>
        <p>會記得你上次選哪一個。右邊的「<Icon icon={CircleHelp} />」打開這一段說明。</p>
        <p><strong>LED 的顏色</strong>：正面看 LED，就是檔案原本的顏色（跟小播放器裡看到的一樣）；製作有開「LED 側看變暗」的話，從側面看會像真的 LED 牆一樣暗一點。你自己螢幕的顏色設定（亮度、色溫、夜間模式）還是會影響看到的顏色，要比對請在同一台螢幕上比。</p>
        <F k="studioLive" />
        <p>NDI 小程序（免費）：</p>
        <DownloadHelper />
        <p className="help-muted">第一次設定（裝 NDI Tools、AE 打開 NDI 輸出、瀏覽器按允許）：<Go to={A.setup}>第一次設定</Go>。</p>
        <FigRow>
          <F k="localFilesEmpty" />
          <F k="localFiles" />
        </FigRow>
        <ul className="help-list">
          <li>本地檔案可以一次放好幾個，點清單裡的哪個 LED 就放哪個，拖曳可以排順序。直接把檔案拖進頁面也可以。</li>
          <li>畫面要是跟 AE 合成一樣的<strong>整張畫布</strong>，才會對到每一片 LED。</li>
        </ul>
      </Section>

      <Section id={A.animAddVideo} title="交影片（加影片）">
        <p>交給導演看的影片，用「<Ui>＋ 加影片</Ui>」交。有三種方法：</p>
        <F k="addVideoUpload" />
        <p><strong>上傳檔案</strong>（最穩）</p>
        <ol className="help-steps">
          <li>選歌，按「<Ui>＋ 加影片</Ui>」。</li>
          <li>「說明」寫一句話（選填），例：修了第二段的轉場。</li>
          <li>把影片拖到框裡，或點框選檔案。MP4 / MOV / WebM，最大 4 GB。</li>
          <li>會先在你的電腦<strong>試播一下</strong>（幾秒鐘，檔案還沒傳出去）：沒問題就直接開始傳；瀏覽器播不了的（例如 ProRes、HAP）會擋下來，不會白傳好幾 GB。看 <Go to={A.animAeExport}>AE 輸出設定</Go>。</li>
          <li>進度條跑完會寫「<Ui>完成，變成 V3</Ui>」，LED 自動開始播新的一版。</li>
        </ol>
        <F k="uploading" />
        <ul className="help-list">
          <li>上傳中可以關掉視窗、切到別首歌，上傳會繼續。<strong>關掉整個分頁會中斷</strong>，下次選同一個檔案會接著傳（看 <Go to={A.qUpload}>上傳到一半中斷了</Go>）。</li>
          <li>一次交一個檔案。其他格式請先轉成 H.264 的 MP4。</li>
        </ul>
        <p><strong>貼連結</strong></p>
        <ul className="help-list">
          <li>可以貼 Google Drive 單一檔案（檔案要設「<Ui>知道連結的使用者都能查看</Ui>」）、Dropbox、OneDrive，或 .mp4 / .mov / .webm 的直接網址 →「<Ui>加入</Ui>」。</li>
          <li>系統會複製一份到我們的伺服器，好了變成下一個版本。大檔要幾分鐘，可以先關掉視窗。</li>
          <li>不收：資料夾、Google 文件、YouTube / Vimeo、WeTransfer。</li>
        </ul>
        <F k="addVideoLink" />
        <p><strong>本地檔案</strong>：只在這台電腦放到 LED 上，不會交出去（上一段）。</p>
        <p className="help-muted">對話框右上角的「<Icon icon={CircleHelp} />」打開這一段說明。</p>
      </Section>

      <Section id={A.animAeExport} title="AE 輸出設定（交影片前）">
        <p>交給導演看的影片請用 <strong>H.264 的 MP4</strong>：每台電腦、每個瀏覽器都播得了，檔案也不會太大。</p>
        <Note kind="warn" title="為什麼 ProRes、HAP 不行">
          ProRes、HAP（還有 DNxHD、Animation、沒有壓縮的 .mov）是給剪接、媒體伺服器用的格式，畫質好、檔案很大，
          但 <strong>Chrome、Edge、Firefox 都播不了</strong>：只有聲音、一片黑，或根本打不開。
          交影片時會先在你的電腦試播，播不了的會直接擋下來，寫「<Ui>這個影片瀏覽器播不了（可能是 ProRes / HAP 編碼）</Ui>」。
        </Note>
        <div className="help-table-wrap">
          <table className="help-table help-table--wide">
            <caption>建議的設定</caption>
            <tbody>
              <tr><td>格式</td><td><strong>H.264</strong>（.mp4）</td></tr>
              <tr><td>大小</td><td>跟 <strong>LED 畫布</strong>一樣：3D 工具列最右邊「<Ui>⋯</Ui>」選單最下面寫的「畫布 寬 × 高」。比例不一樣，放到 LED 上會被拉長；比較小會比較糊</td></tr>
              <tr><td>影格速率</td><td>固定，跟合成一樣（例：30 fps）。不要用「可變影格速率」</td></tr>
              <tr><td>位元速率</td><td>VBR、1 次。4K（3840 × 2160）大約 <strong>20–40 Mbps</strong>；1920 × 1080 大約 10–15 Mbps。超過 80 Mbps 筆電播起來會卡</td></tr>
              <tr><td>寬度</td><td>8192 px 以內最穩；更寬的很多電腦（筆電、iPad）播不動</td></tr>
              <tr><td>色彩</td><td>Rec.709、8-bit；「HDR」不要勾</td></tr>
              <tr><td>聲音</td><td>AAC 48 kHz（有沒有聲音都可以）</td></tr>
            </tbody>
          </table>
        </div>
        <p><strong>用 Adobe Media Encoder</strong>（建議）</p>
        <ol className="help-steps">
          <li>AE 選好合成 → <Ui>Composition 合成</Ui> → <Ui>Add to Adobe Media Encoder Queue… 新增至 Adobe Media Encoder 佇列</Ui>。</li>
          <li>Media Encoder 裡「<Ui>Format 格式</Ui>」選 <Ui>H.264</Ui>，「<Ui>Preset 預設集</Ui>」選 <Ui>Match Source - High bitrate</Ui>。</li>
          <li>點藍色的預設集名稱打開「<Ui>Export Settings 匯出設定</Ui>」→「<Ui>Video 視訊</Ui>」：寬、高跟 LED 畫布一樣，<Ui>Frame Rate</Ui> 跟合成一樣；<Ui>Bitrate Encoding</Ui> 選 <Ui>VBR, 1 pass</Ui>，<Ui>Target Bitrate</Ui> 4K 填 30 左右。</li>
          <li>按右上角綠色的開始按鈕。</li>
        </ol>
        <p><strong>直接用 AE 的轉譯佇列</strong>（AE 2023 以後）</p>
        <ol className="help-steps">
          <li><Ui>Composition 合成</Ui> → <Ui>Add to Render Queue 新增至轉譯佇列</Ui>。</li>
          <li>點「<Ui>Output Module 輸出模組</Ui>」：<Ui>Format</Ui> 選 <Ui>H.264</Ui>；「<Ui>Format Options…</Ui>」裡 <Ui>Bitrate Encoding</Ui> 選 VBR、1 pass，<Ui>Target Bitrate</Ui> 4K 填 30 左右。</li>
          <li>「<Ui>Output To</Ui>」選存檔的地方 → <Ui>Render 轉譯</Ui>。</li>
        </ol>
        <p className="help-muted">AE 2022 以前的轉譯佇列沒有 H.264，請用 Media Encoder。</p>
        <ul className="help-list">
          <li><strong>HEVC（H.265）</strong>：檔案比較小，但不是每台電腦的瀏覽器都播得了（要看顯示卡）。交給導演、客戶看還是用 H.264。</li>
          <li>選好檔案後寫「<Ui>可以交，但先看一下</Ui>」：例如大小跟 LED 畫布不一樣（「影片是 1920×1080，LED 畫布是 3840×2160，比例對，但會比較糊」）、位元速率太高、寬度超過 8192。可以按「<Ui>照樣上傳</Ui>」，但最好照上面的設定重新輸出。</li>
          <li>擋下來的影片：照上面重新輸出 H.264 MP4 再交。製作看得到「<Ui>還是要上傳</Ui>」可以硬傳（例：Mac 的 Safari 播得了 ProRes，但導演用 Chrome 就看不到）。</li>
          <li><strong>貼連結</strong>交的影片沒辦法在複製前檢查：第一次播的時候檢查，有問題會寫在版本列下面（例：「<Ui>V3：這個影片瀏覽器播不了…</Ui>」），版本號碼也會變紅、多一個警告圖示。</li>
        </ul>
      </Section>

      <Section id={A.animVersions} title="版本 V1、V2…">
        <F k="versionBar" />
        <ul className="help-list">
          <li>每交一次、好了就是下一個號碼：V1、V2、V3…。號碼不會變：刪掉 V2，下一版是 V3。</li>
          <li>點哪一版，LED 就放哪一版。滑鼠移上去看誰交的、什麼時候、說明。</li>
          <li>「<Ui>刪除 V2</Ui>」：只有交的人和製作可以刪。</li>
          <li>導演也可以貼連結加一版（例如客戶給的參考影片），版本旁邊寫導演的名字；你會收到「<Ui>導演 王導 貼了一版影片 V3 到「夜曲」</Ui>」的通知。</li>
          <li>還在上傳、複製或失敗的會列在下面，可以「<Ui>取消</Ui>」或「<Ui>重試</Ui>」。</li>
          <li>交了新版：歌在「需修改」會自動回到「審查中」；歌在審查中或已通過，導演也會收到「有新版」的通知。</li>
        </ul>
      </Section>

      <Section id={A.animSubmit} title="提交審查">
        <ol className="help-steps">
          <li>右邊點「<Ui>審查 / 留言</Ui>」分頁。</li>
          <li>留言框可以先寫一段給導演的話（例：請看 0:10 升降台上來那段）。</li>
          <li>按「<Ui>提交審查</Ui>」→ 確認。狀態變成「審查中」，導演收到通知。</li>
        </ol>
        <F k="reviewTab" />
        <ul className="help-list">
          <li>還沒交影片就提交，會先問你（導演看到的會是空的）。</li>
          <li>「<Ui>撤回（改回待製作）</Ui>」：還在審查中才能撤回。</li>
          <li>導演按了需修改：交新版（加影片）就會自動回到審查中；或改好後按「<Ui>修改完成，重新提交</Ui>」。</li>
          <li>指派給別的動畫師的歌，你只能看。</li>
        </ul>
      </Section>

      <Section id={A.animFeedback} title="看導演的意見、回覆、已改好">
        <ul className="help-list">
          <li>「目前狀態」下面那一行：導演上次的決定，例如「<Ui>導演看過 V1：需修改（0:12 主牆再亮一點…）</Ui>」。</li>
          <li>留言清單裡有紅色「<Ui>需修改</Ui>」標籤的就是原因。每則留言標著是看哪一版時留的（「V1 的留言」）；有時間的（例：0:12）點一下，影片跳到那一秒。</li>
          <li>「<Ui>這一版（V2）</Ui>」只看這一版的留言和之前版本還沒改好的；「<Ui>所有版本</Ui>」看全部。</li>
          <li><strong>回覆</strong>：按留言下面的「<Ui>回覆</Ui>」，對方會收到通知。打 <strong>@</strong> 加名字可以提及某人。</li>
          <li><strong>改好了</strong>：按「<Ui>已改好（V2）</Ui>」，會記下是哪一版改好的，留言變灰。導演覺得還沒好可以按「<Ui>重新打開</Ui>」。</li>
          <li><strong>點一則留言</strong>：換到那一版、跳到那一格，攝影機飛到導演留言時的 3D 視角，導演的畫記疊上去；區段留言（0:12–0:18）會一直循環那一段。看 <Go to={A.dirOpen}>打開留言</Go>。</li>
          <li>你也可以畫記、標區段，跟導演一樣（看 <Go to={A.dirAnnotate}>畫記、記住視角、區段</Go>）。分享連結的訪客留的寫「<Ui>訪客：名字（連結名稱）</Ui>」，你負責的歌有訪客留言會收到通知；在底下回覆訪客也看得到。</li>
          <li>「<Ui>審片紀錄</Ui>」：每次通過、需修改的紀錄。</li>
          <li>留言、狀態大約 25 秒自動更新，切回分頁也會馬上更新。</li>
        </ul>
      </Section>

      <Section id={A.animCompare} title="比較兩版（C 鍵）">
        <ol className="help-steps">
          <li>小播放器下面「<Ui>比較</Ui>」選另一版（例：V1）。</li>
          <li>按旁邊的按鈕，或鍵盤 <kbd>C</kbd>，在兩版之間切換。停在<strong>同一秒</strong>，播放 / 暫停照舊。</li>
          <li>選「<Ui>不比較</Ui>」結束。</li>
        </ol>
        <F k="compare" />
      </Section>

      <Section id={A.animLedMap} title="LED 對位圖（做 AE 合成用）">
        <p>做 AE 合成前，先知道每塊 LED 在畫布上的哪裡：</p>
        <ol className="help-steps">
          <li>3D 工具列最右邊按「<Ui>⋯</Ui>」。</li>
          <li>「<Ui>下載對位圖（PNG）</Ui>」：跟 AE 畫布一樣大，畫出每塊 LED 的名字、x y w h、每 100 px 的格線；不是長方形的 LED 畫出實際形狀。</li>
          <li>把 PNG 拖進 AE，放在最上面當參考（設成導引圖層就不會算圖出去）。</li>
          <li>AE 合成大小照選單最下面寫的「畫布 寬 × 高」，以製作給的為準。</li>
        </ol>
        <p>想省掉這些步驟：用「<Ui>下載 AE 合成腳本（.jsx）</Ui>」，AE 自動建好合成、外框和名字（下一段）。</p>
        <FigRow>
          <F k="animLedMenu" />
          <F k="ledMapSample" />
        </FigRow>
        <ul className="help-list">
          <li>「<Ui>下載位置表（CSV / JSON）</Ui>」：每塊 LED 的名字和 x、y、w、h，Excel 或 AE 腳本可以讀。</li>
          <li>位置一樣的 LED 名字會寫在一起；壓在畫布邊上的 LED 兩邊都會畫。</li>
          <li>畫布大小不對：請製作改（<Go to={A.prodLedCanvas}>LED 畫布大小</Go>）。</li>
        </ul>
      </Section>

      <Section id={A.animAeScript} title="用 AE 腳本建合成">
        <p>不用自己對位置：下載一個 AE 腳本，跑一下就建好 LED 畫布大小的合成，每塊 LED 的外框和名字都放好了。</p>
        <ol className="help-steps">
          <li>3D 工具列最右邊按「<Ui>⋯</Ui>」→「<Ui>下載 AE 合成腳本（.jsx）</Ui>」。</li>
          <li>打開 After Effects（2020 以後的版本，Windows、Mac 都可以）。</li>
          <li><Ui>File 檔案</Ui> → <Ui>Scripts 指令碼</Ui> → <Ui>Run Script File… 執行指令碼檔案</Ui>，選剛剛下載的 .jsx。</li>
          <li>問「合成多長？」：寫 分:秒（預設 3:00）→ <Ui>OK</Ui>。按 <Ui>Cancel</Ui> 什麼都不會建。</li>
          <li>跑完會跳一個說明，寫建了什麼；合成會自己打開。</li>
        </ol>
        <F k="aeScriptMenu" />
        <F k="aeScriptResult" />
        <F k="aeScriptLayers" />
        <p>建出來的東西都放在專案面板的「<Ui>Stage Previz LED 對位</Ui>」資料夾：</p>
        <ul className="help-list">
          <li><strong>合成</strong>：名字像「<Ui>Stage Previz – 示範專案 – 3840x2160</Ui>」，大小 = LED 畫布，30 fps（要別的影格速率，到 <Ui>Composition Settings</Ui> 改）。</li>
          <li><strong>每塊 LED 一個外框</strong>（形狀圖層，名字 = LED 的名字，每塊不同顏色）。不是長方形的 LED 照實際形狀；壓在畫布邊上的兩邊都畫。</li>
          <li><strong>名字標籤</strong>（文字圖層）：LED 的名字、像素大小、位置 x y。位置一樣的 LED 寫在同一個標籤。</li>
          <li><strong>LED 對位圖</strong>：夾在腳本裡的參考圖，放在外框下面（濾色、不透明度 60%）。</li>
          <li>全部是<strong>導引圖層</strong>（Guide Layer）而且<strong>鎖住</strong>：算圖時不會出現，也不會不小心拖到。</li>
        </ul>
        <ul className="help-list">
          <li>把你的素材放在這些導引圖層<strong>下面</strong>，外框留在最上面當參考。</li>
          <li>全部不要了：跑完馬上按 Ctrl+Z（Mac 是 Cmd+Z）一次就復原。只想關掉外框：把那幾個圖層的眼睛關掉。</li>
          <li>說明裡寫「<Ui>沒有放：AE 現在不允許腳本存檔</Ui>」：<Ui>Edit</Ui> → <Ui>Preferences</Ui> → <Ui>Scripting &amp; Expressions</Ui>（Mac：<Ui>After Effects</Ui> → <Ui>Settings</Ui> → <Ui>Scripting &amp; Expressions</Ui>），勾「<Ui>Allow Scripts to Write Files and Access Network</Ui>」再跑一次。外框和名字不用這個設定。</li>
          <li>對位圖存在 .jsx 旁邊（同一個資料夾）。搬走的話 AE 會說找不到檔案，重新連結或再跑一次就好。</li>
          <li>模型或 LED 畫布大小改了：重新下載腳本再跑一次（會建一個新的合成，不會動到舊的）。</li>
        </ul>
      </Section>

      <Section id={A.animTestPattern} title="LED 顯示測試圖">
        <p>LED 沒有畫面的時候（沒有影片、沒有 AE 即時、沒有本地檔案），會自動顯示<strong>測試圖</strong>：每塊 LED 自己的名字、x y w h、格線、彩條、灰階、中心十字、四個角的記號。</p>
        <F k="testPattern" />
        <ul className="help-list">
          <li>有畫面時也想檢查：「<Ui>⋯</Ui>」→ 勾「<Ui>LED 顯示測試圖</Ui>」（只有你這邊看得到）。</li>
          <li>怎麼看：名字和位置跟你 AE 裡的一樣、四個角的記號在 LED 的四個角、字不是反的，就是對的。</li>
          <li>對不上：通常是模型的 LED UV 擺錯，或 AE 合成大小不對，請找製作。</li>
        </ul>
      </Section>
    </Chapter>
  );
}

// ═══════════════════════════ AE 即時預覽（原本的那一章，id 不能改）═══════════════════════════

function AeLiveChapter() {
  return (
    <Chapter id={A.aeLive} lead="在 After Effects 做動畫，同時在瀏覽器的 3D 舞台上看 LED 的效果。AE 一動，舞台上的 LED 就跟著動。">
      <ol className="help-flow" aria-label="畫面怎麼送到 LED">
        <li><strong>After Effects</strong><span>你在做的動畫</span></li>
        <li><strong>NDI</strong><span>AE 把畫面送出來</span></li>
        <li><strong>NDI 小程序</strong><span>在你電腦上接收</span></li>
        <li><strong>瀏覽器</strong><span>工作站或分享連結</span></li>
        <li><strong>3D 舞台的 LED</strong><span>即時看到</span></li>
      </ol>
      <p>全部在<strong>同一台電腦</strong>上：AE、小程序、瀏覽器都開在你自己的電腦。小程序會自動接這台電腦的 AE。</p>
      <p>第一次要花幾分鐘設定（<Go to={A.setup}>第一次設定</Go>），之後每次只要打開 AE、打開工作站或分享連結就好（<Go to={A.use}>每次使用</Go>）。</p>

      <Section id={A.whatYouNeed} title="要準備什麼">
        <ul className="help-checklist">
          <li><span aria-hidden><Icon icon={Laptop} size="lg" /></span><div><strong>Windows 或 Mac 電腦</strong>（就是跑 AE 的那台）</div></li>
          <li><span aria-hidden><Icon icon={Globe} size="lg" /></span><div><strong>Chrome、Edge 或 Firefox</strong> 瀏覽器。<em>Safari 不行</em>（iPhone、iPad 也不行）</div></li>
          <li><span aria-hidden><Icon icon={RadioTower} size="lg" /></span><div><strong>NDI Tools</strong>：NDI 官方的免費軟體，AE 靠它把畫面送出來</div></li>
          <li><span aria-hidden><Icon icon={Puzzle} size="lg" /></span><div><strong>NDI 小程序</strong>：我們做的小程式，免費，在背景接收 AE 的畫面</div></li>
          <li><span aria-hidden><Icon icon={Clapperboard} size="lg" /></span><div><strong>After Effects</strong></div></li>
          <li><span aria-hidden><Icon icon={Link} size="lg" /></span><div><strong>動畫師工作站</strong>，或導演、製作給你的<strong>分享連結</strong></div></li>
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
            <li><Num n={1} /><Icon icon={SquareCheck} /> <strong>勾</strong>「<Ui>Enable Mercury Transmit</Ui>」</li>
            <li><Num n={2} />在清單裡「<Ui>NDI output</Ui>」那一行，<Icon icon={SquareCheck} /> <strong>勾</strong>「<Ui>Video Stream</Ui>」<br />
              <span className="help-muted">（沒有「NDI output」這一行 = NDI Tools 還沒裝好，或裝完還沒重開 AE）</span></li>
            <li><Num n={3} /><Icon icon={Square} /> <strong>不要勾</strong>「<Ui>Disable video output when in the background</Ui>」（中文版：在背景時停用視訊輸出）<br />
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

        <Section id={A.chromeAllow} level={3} title="④ 用 Chrome 打開，按「允許」">
          <ol className="help-steps">
            <li>用 <strong>Chrome</strong>（或 Edge、Firefox）打開動畫師工作站，或導演給你的分享連結。</li>
            <li>上面選「<Ui><Icon icon={Radio} /> AE 即時</Ui>」，3D 舞台上會出現「AE 即時畫面」卡片 → 按「<Ui>連接 AE 即時</Ui>」。
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
          <li>用 Chrome 打開工作站或分享連結，上面選「<Ui><Icon icon={Radio} /> AE 即時</Ui>」。</li>
          <li>3D 畫面上方出現綠色「<Ui>LIVE</Ui>」，LED 就是 AE 的畫面了。</li>
        </ol>
        <F k="shareLive" />
        <p>畫面卡卡的或電腦很燙？看 <Go to={A.resolution}>建議的預覽解析度</Go>。</p>
        <p>卡片右上角的「<Ui><Icon icon={X} /></Ui>」可以把卡片收起來；按 3D 畫面上方的 NDI 標示可以再打開。沒有 AE 的時候，可以按「<Ui><Icon icon={FolderOpen} /> 本地檔案</Ui>」把影片或圖片拖進來看。</p>
      </Section>

      <Section id={A.resolution} title="建議的預覽解析度">
        <p>AE 送出去的畫面大小，就是<strong>合成視窗下方的「<Ui>解析度 / 降低取樣</Ui>」選單</strong>：<Ui>Full 完整</Ui>、<Ui>Half 一半</Ui>、<Ui>Third 三分之一</Ui>、<Ui>Quarter 四分之一</Ui>。</p>
        <p>位置：合成視窗<strong>正下方那排小工具</strong>裡，寫著「<Ui>Full</Ui>」（中文版「完整」）的下拉選單，旁邊是放大比例（例如 50%）。</p>
        <F k="aeResolutionWin" />
        <ResolutionMock />
        <ul className="help-list">
          <li><strong>建議用 Half（二分之一）</strong>：例如 8800×2024 的畫布送出去 4400×1012，小程序原樣送到網頁，LED 夠清楚。</li>
          <li><strong>畫布很大</strong>（例如 10496×5120）<strong>而且 AE 預覽卡卡的</strong>：才改成 <strong>Third（三分之一）</strong>。</li>
          <li><strong>不要用 Quarter（四分之一）</strong>：AE 只算寬、高各四分之一（像素只剩 1/16），LED 會糊、一格一格的。</li>
          <li><strong>畫布小</strong>（1920×1080 以內）：可以用 Full。</li>
          <li>改了解析度，網頁會自動跟上，不用重新整理。</li>
          <li>小程序（0.1.13 起）畫面不大就原樣送；超過 450 萬像素（例如 Full 的 8800×2024）才縮小，所以大畫布用 Full 不會比 Half 清楚多少，反而讓 AE 變慢。</li>
        </ul>
      </Section>

      <Section id={A.aeLiveColor} title="AE 即時的顏色（校正）">
        <p>AE 經過 NDI 送過來的顏色會偏一點（黑色變灰、亮的地方不準）。小程序 0.1.13 起，網頁會<strong>自動校正</strong>，LED 的顏色就跟 AE 裡一樣，不用做任何事。</p>
        <p>想要更準（例如換了電腦、AE 版本），可以用你這台電腦量一次：</p>
        <ol className="help-steps">
          <li>按 3D 畫面上方的 NDI 標示 →「<Ui><Icon icon={Palette} /> 校正 AE 即時顏色</Ui>」（也在「<Ui><Icon icon={Ellipsis} /></Ui>」選單、設定頁的「NDI 小程序」裡）。</li>
          <li>按「<Ui>下載校正圖（PNG）</Ui>」，把它拖進 AE 的合成，放大到差不多填滿（選圖層按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>，Mac 是 <kbd>Cmd</kbd>+<kbd>Option</kbd>+<kbd>F</kbd>）。不要加效果、不要調顏色。</li>
          <li>解析度選 <strong>Full</strong>，按空白鍵播放，確認 LED 上看得到校正圖（四個角有方形記號、中間是灰階和紅綠藍的色塊）。</li>
          <li>按「<Ui>校正</Ui>」。會顯示校正前、校正後差幾階，並存在<strong>這台電腦的這個瀏覽器</strong>。</li>
        </ol>
        <p>量完把校正圖從合成拿掉就好。想回到網頁內建的校正，按「<Ui>回到預設</Ui>」；之後想再量一次，按「<Ui>重新校正</Ui>」。</p>
        <p className="help-muted">小程序是 0.1.12 以前的版本時，顏色照以前顯示（不另外校正），校正按鈕也不能按：請下載最新版。只有 After Effects 的畫面會校正，其他 NDI 程式送的畫面照原樣顯示。</p>
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

      <Section id={A.faq} title="AE 即時的問題">
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
          <p>Safari 會直接擋掉網頁連到小程序，沒辦法用。請改用 <strong>Chrome、Edge 或 Firefox</strong> 打開同一個連結。卡片上的「<Ui><Icon icon={Copy} /> 複製這個連結</Ui>」可以把網址複製起來，貼到 Chrome。</p>
          <p className="help-muted">iPhone、iPad 上的瀏覽器都是 Safari 核心，也不行。AE 即時本來就要在跑 AE 的電腦上看。</p>
          <F k="cardSafari" />
        </Faq>

        <Faq id={A.faqAutostart} title="「小程序沒辦法設成開機自動啟動」">
          <p>{NDI_AUTOSTART_NOTE}。</p>
          <p>不影響使用，只是下次開機後要自己打開小程序（Windows：「開始」選單；Mac：「應用程式」）。</p>
        </Faq>
      </Section>
    </Chapter>
  );
}

// ═══════════════════════════ 導演 ═══════════════════════════

function DirectorChapter() {
  return (
    <Chapter id={A.director} lead="在導演頁一首一首看：影片直接放在 3D 舞台的 LED 上，cue 跟著影片走。看完留言，決定「通過」或「需修改」。">
      <Section id={A.dirBoard} title="總覽和狀態">
        <F k="board" />
        <ul className="help-list">
          <li>① 四欄：<Dot s="todo" />待製作、<Dot s="review" />審查中、<Dot s="changes" />需修改、<Dot s="approved" />已通過。等你看的歌在「<strong>審查中</strong>」。</li>
          <li>② 「<Ui>有新版 V2</Ui>」：動畫師交了你還沒審過的新版本。</li>
          <li>③ 審查中的歌可以直接按「<Ui>通過</Ui>」「<Ui>需修改</Ui>」（記在最新一版）。想先看再決定，點卡片進去。</li>
          <li>④ 上面的進度：已通過幾首 / 全部。</li>
          <li>「<Ui>整場串播</Ui>」：從目前這首開始依序自動播放，每個 cue 停幾秒可以選。</li>
          <li>頁面每 25 秒自動更新，動畫師提交時你也會收到通知（小鈴鐺）。</li>
        </ul>
        <F k="boardPhone" />
      </Section>

      <Section id={A.dirPlay} title="在 LED 上看某一版、小播放器">
        <F k="songDetail" />
        <ul className="help-list">
          <li>③ <strong>版本</strong>：點 V2、V1…，LED 就放那一版。預設是最新一版。</li>
          <li>舞台跟著影片時間切 cue，機關照真的速度動。點 ⑤ cue 列的某個 cue，影片跳到那個 cue 的時間。</li>
          <li>④ <strong>小播放器</strong>：播放 / 暫停、往前 / 往後一格、時間（點一下換成時間碼）、速度、循環、聲音。時間軸上的小圓點是留言的時間點、上面那一條是區段留言，點一下打開那則留言。按住上面那條可以拖到別的地方，右上角可以收起來。快捷鍵看 <Go to={A.dirPlayer}>播放器和快捷鍵</Go>。</li>
          <li>① 上一首 / 下一首；左上角「<Ui>回總覽</Ui>」。</li>
          <li>3D 畫面：拖拉旋轉、滾輪縮放；轉亂了按工具列的攝影機圖示「<Ui>重置攝影機</Ui>」。</li>
          <li>cue 列最左邊的播放鍵：沒有影片時每 2 秒自動切下一個 cue。<kbd>Shift</kbd>+<kbd>J</kbd> / <kbd>K</kbd> 切 cue。</li>
        </ul>
        <F k="songPhone" />
      </Section>

      <Section id={A.dirAddLink} title="貼連結加影片">
        <p>手上有影片連結（例如客戶給的參考、別的版本），可以直接貼上來變成這首歌的下一版，大家都能在 LED 上看。</p>
        <ol className="help-steps">
          <li>打開那首歌，版本列右邊按「<Ui>＋ 加影片</Ui>」。</li>
          <li>貼上影片連結：Google Drive 單一檔案、Dropbox、OneDrive，或 .mp4 / .mov / .webm 的直接網址。說明可以寫一句（選填）。</li>
          <li>按「<Ui>加入</Ui>」。系統會複製一份到我們的伺服器，好了變成下一個版本（例：V3），版本旁邊寫你的名字。</li>
        </ol>
        <ul className="help-list">
          <li>連結要設成「<Ui>知道連結的人都能看</Ui>」（Google Drive：共用 → 一般存取權 → 知道連結的使用者），不然系統抓不到。</li>
          <li><strong>上傳檔案</strong>是製作和動畫師用的；導演只能貼連結。</li>
          <li>你貼的那一版<strong>不會改歌的狀態</strong>（需修改還是需修改），也不會通知其他導演；會通知這首歌的動畫師和製作。</li>
          <li>還在複製或失敗的那一版，你可以取消或重試；好了之後你可以刪掉自己貼的那一版。別人交的版本只有交的人和製作可以刪。</li>
          <li>不收：資料夾、Google 文件、YouTube / Vimeo、WeTransfer。瀏覽器播不了的格式（例如 ProRes）複製好了也播不出來，版本會變紅（看 <Go to={A.animAeExport}>AE 輸出設定</Go>）。</li>
        </ul>
      </Section>

      <Section id={A.dirComment} title="留言、@ 提及">
        <ol className="help-steps">
          <li>在小播放器停到要講的那一秒，按「<Ui>在 0:15 加留言</Ui>」。</li>
          <li>留言框上面出現「<Ui>掛在 00:14</Ui>」（這則留言綁在影片的這一秒），寫你的意見。</li>
          <li>要某人注意：打 <strong>@</strong> 再打名字，選清單裡的人，他會收到通知。</li>
          <li>按「<Ui>送出</Ui>」。</li>
        </ol>
        <FigRow>
          <F k="commentTime" />
          <F k="commentMention" />
        </FigRow>
        <ul className="help-list">
          <li>直接在留言框寫也會綁在影片<strong>現在停的那一秒</strong>（留言框上面寫「<Ui>在 0:12</Ui>」）；整首歌的意見不想綁時間，按那個叉叉。留言會記在你正在看的那一版（例：V2 的留言）。</li>
          <li><strong>3D 留言</strong>：工具列「<Ui>3D 留言</Ui>」→ 點 3D 畫面的某個物件或位置，留言會釘在那裡，轉視角也跟著。</li>
          <li>篩選：「<Ui>未解決 / 已解決 / 全部</Ui>」（已解決 = 動畫師標了「已改好」）、「<Ui>這一版 / 所有版本</Ui>」、角色（含訪客）、依影片時間排。勾選好幾則可以一次標成已改好或刪除。</li>
          <li>動畫師改好會按「已改好（V2）」；你覺得還沒好，按「<Ui>重新打開</Ui>」。</li>
          <li>分享連結的<strong>訪客</strong>（製作有打開「允許看的人留言」的連結）留的，寫「<Ui>訪客：小李（給經紀人）</Ui>」，你會收到通知；在底下回覆，訪客也看得到。</li>
          <li>想更清楚：<Go to={A.dirAnnotate}>在畫面上畫出來、標一段時間</Go>。</li>
        </ul>
      </Section>

      <Section id={A.dirAnnotate} title="畫記、記住視角、區段">
        <ol className="help-steps">
          <li>停在要講的那一格（暫停，或按 <kbd>,</kbd> / <kbd>.</kbd> 一格一格找）。</li>
          <li>小播放器或留言框上面按「<Ui>畫記</Ui>」：3D 畫面外框變紅，上面出現畫記工具。</li>
          <li>選<strong>筆、箭頭、方框、圓圈</strong>和顏色（預設紅色），在畫面上拖拉。畫錯按「<Ui>復原</Ui>」（或 <kbd>Ctrl</kbd>+<kbd>Z</kbd>），垃圾桶 = 全部擦掉。</li>
          <li>寫留言 → 「<Ui>送出</Ui>」。畫記、這一格、你現在的 3D 視角會一起存起來，還會存一張小縮圖。</li>
        </ol>
        <F k="annotate" />
        <ul className="help-list">
          <li><strong>視角</strong>：每則新留言都會記住送出時的 3D 視角（留言框上面寫「<Ui>會記住現在的視角</Ui>」）。想讓動畫師從某個角度看，先把 3D 畫面轉到那裡再留言。</li>
          <li>畫的時候小播放器先藏起來、影片不會動，畫的是按「<Ui>畫記</Ui>」那一格；先標好區段再畫也可以，打開留言時會先停在畫的那一格，按播放再循環整段。</li>
          <li>畫錯了：「<Ui>復原</Ui>」一次拿掉一筆，垃圾桶擦掉的也能用復原拿回來。按叉叉（不要畫記了）會先問你。</li>
          <li>畫的時候 3D 畫面不能轉（畫記才對得準）。要換角度：先按右上角的叉叉（不要畫記了），轉好再按「<Ui>畫記</Ui>」。</li>
          <li><strong>區段</strong>（一段時間，例：0:12–0:18 升降台太快）：開始的地方按 <kbd>I</kbd>、結束的地方按 <kbd>O</kbd>；或在小播放器時間軸上面那一條拖一段；手機、iPad 按「<Ui>標區段</Ui>」兩次。留言框上面會寫「<Ui>區段 0:12–0:18</Ui>」。</li>
          <li>iPad 可以用手指或 Apple Pencil 畫（用筆畫的時候手掌碰到螢幕不算）。手機、iPad 直放時畫記工具收成一顆按鈕，點開換工具和顏色。</li>
        </ul>
      </Section>

      <Section id={A.dirOpen} title="打開留言：攝影機飛到那個視角">
        <F k="commentOpen" />
        <ul className="help-list">
          <li><strong>點一則留言</strong>（或時間軸上的點、區段條）：換到留言的那一版、跳到那一格、攝影機繞著舞台飛到留言時的視角，畫記疊上去。</li>
          <li>區段留言會一直<strong>循環那一段</strong>；拉到區段外面、或按 <kbd>Esc</kbd> 就不循環了。</li>
          <li>按播放、或自己轉視角，畫記就收起來（留言還是選著）。畫記旁邊的叉叉也可以收起來。</li>
          <li>舊的留言沒有記視角：只會跳到那一秒。</li>
          <li><strong>跟著播放</strong>：播放時，離播放頭最近的那則會亮起來，清單自己捲過去；不想它捲，把「<Ui>跟著播放</Ui>」取消。</li>
        </ul>
      </Section>

      <Section id={A.dirPlayer} title="播放器和快捷鍵">
        <p>小播放器：播放、往前 / 往後一格、時間（點一下換成時間碼「時:分:秒:格」）、速度 0.5× / 1× / 2×、循環、聲音、比較。</p>
        <ReviewKeysTable />
        <ul className="help-list">
          <li>在留言框打字的時候，快捷鍵不會作用。</li>
          <li>逐格照影片的格數（播一下就量得到）；還不知道時一格算 1/30 秒。</li>
          <li>這幾頁的 <kbd>L</kbd> 給播放用，3D 畫面的「物件名稱」改從工具列開。</li>
        </ul>
      </Section>

      <Section id={A.dirDecide} title="通過 / 需修改">
        <p>歌在「審查中」時，上方有「<Ui>通過 V2</Ui>」「<Ui>需修改 V2</Ui>」：會記下你看的是<strong>哪一版</strong>。旁邊的「<Icon icon={CircleHelp} />」打開這一段說明。</p>
        <ul className="help-list">
          <li><strong>需修改</strong>：一定要寫原因（例：第二段 LED 太亮；0:42 的轉場慢半拍）→「<Ui>送出「需修改」</Ui>」。原因會變成一則留言（綁在那一版），動畫師收到通知。動畫師交新版後，歌會自動回到「審查中」，並出現「有新版 V3」。</li>
          <li><strong>通過</strong>：歌變成「已通過」，動畫師收到通知。按錯了按「<Ui>撤回通過</Ui>」。</li>
          <li>待製作、需修改的歌沒有這兩個按鈕（等動畫師提交）。</li>
          <li>剛好有人同時改了狀態：畫面會說現在是什麼狀態，並自動更新，不會蓋掉別人的決定。</li>
        </ul>
        <F k="needsChanges" />
      </Section>

      <Section id={A.dirHistory} title="審片紀錄">
        <p>留言上方的「<Ui>審片紀錄</Ui>」點開：每次通過、需修改的紀錄（哪一版、誰、什麼時候、原因）。點原因會跳到那則留言。</p>
        <F k="reviewHistory" />
      </Section>

      <Section id={A.dirCompare} title="比較兩版">
        <ol className="help-steps">
          <li>小播放器下面「<Ui>比較</Ui>」選另一版（例：V1）。</li>
          <li>按旁邊的按鈕，或鍵盤 <kbd>C</kbd>：在兩版之間切換，停在同一秒，播放 / 暫停照舊。</li>
          <li>選「<Ui>不比較</Ui>」結束。</li>
        </ol>
        <F k="dirCompare" />
      </Section>

      <Section id={A.dirExport} title="匯出留言（PDF、CSV）">
        <ol className="help-steps">
          <li>留言上面按「<Ui>匯出留言</Ui>」。</li>
          <li>選版本（這一版 / 全部版本）和狀態（全部 / 未解決 / 已解決）。</li>
          <li>「<Ui>列印 / 存成 PDF</Ui>」：瀏覽器的列印視窗選「<Ui>儲存為 PDF</Ui>」。每則有時間碼、誰、內容、狀態、留言時的畫面（含畫記）和回覆。</li>
          <li>「<Ui>下載 CSV</Ui>」：Excel 打得開，一則一行，回覆接在下面。</li>
        </ol>
        <p className="help-muted">舊的留言沒有縮圖（那時候還沒有這個功能）。</p>
      </Section>
    </Chapter>
  );
}

// ═══════════════════════════ 客戶 ═══════════════════════════

function ClientChapter() {
  return (
    <Chapter id={A.client} lead="製作傳給你一個分享連結，點開就能看 3D 舞台和每首歌最新的影片。不用帳號、不用裝軟體，只能看不能改（製作有打開的話可以留言）。">
      <Section id={A.clientOpen} title="打開連結、輸入密碼">
        <ol className="help-steps">
          <li>點製作傳給你的連結（例：<code>https://previz.haimiaan.com/s/…</code>）。</li>
          <li>有密碼的話，輸入密碼 → 按「<Ui>解鎖</Ui>」。</li>
          <li>等 3D 舞台載入（第一次大約幾秒到十幾秒）。</li>
        </ol>
        <F k="sharePassword" />
        <ul className="help-list">
          <li>畫面寫「<Ui>分享連結無效</Ui>」：連結過期或被刪了，請跟製作要新的。</li>
          <li>密碼錯了會再問一次；不知道密碼請問製作。</li>
        </ul>
      </Section>

      <Section id={A.clientCamera} title="轉動視角、重置攝影機">
        <div className="help-table-wrap">
          <table className="help-table">
            <tbody>
              <tr><td>電腦</td><td>左鍵拖 = 轉視角；滾輪 = 放大縮小；右鍵拖 = 平移</td></tr>
              <tr><td>手機、iPad</td><td>一指拖 = 轉視角；兩指捏 = 放大縮小、移動</td></tr>
            </tbody>
          </table>
        </div>
        <p>轉亂了：按 3D 工具列的攝影機圖示「<Ui><Icon icon={Video} /> 重置攝影機</Ui>」，回到製作設定好的畫面。</p>
      </Section>

      <Section id={A.clientPlay} title="看影片">
        <F k="shareDesktop" />
        <ol className="help-steps">
          <li>① 選歌（只有一首歌的連結不會有這一欄；手機在上面一排）。</li>
          <li>② 上面選「<Ui>影片 V2</Ui>」：放這首歌<strong>最新的一版</strong>。</li>
          <li>④ 小播放器按播放。舞台會跟著影片時間切 cue，升降台、轉台這些機關也會照真的速度動。</li>
          <li>⑤ 點下面的 cue，直接看那個舞台畫面（影片跳到那個 cue 的時間）。</li>
        </ol>
        <p>還沒有影片的歌，上面會寫「<Ui>這首歌還沒有影片</Ui>」，LED 顯示測試圖；舞台和 cue 照樣可以看。</p>
        <p>3D 工具列最右邊的「<Ui><Icon icon={Ellipsis} /></Ui>」：LED 對位圖、LED 顯示測試圖，最下面的「<Ui>說明</Ui>」會打開這份使用說明。</p>
        <F k="shareMenu" />
        <p className="help-muted">「AE 即時」是給動畫師用的（在跑 AE 的電腦上看），看 <Go to={A.aeLive}>AE 即時預覽</Go>。</p>
      </Section>

      <Section id={A.clientComment} title="留言（製作有開的連結）">
        <p>製作有打開「允許看的人留言」的連結，右邊（手機在舞台下面）會有「<Ui>留言</Ui>」。</p>
        <ol className="help-steps">
          <li>第一次先寫你的名字（只要寫一次，製作團隊會看到）。</li>
          <li>小播放器停在要講的地方，按「<Ui>在 0:12 加留言</Ui>」，或直接在留言框寫。</li>
          <li>想圈出來：按「<Ui>畫記</Ui>」，在畫面上畫箭頭、圈圈（手機用手指畫）。講一段時間：按「<Ui>標區段</Ui>」兩次，或拖時間軸上面那一條。</li>
          <li>按「<Ui>送出</Ui>」。會記住你現在的 3D 視角，團隊點開就是你看到的畫面。</li>
        </ol>
        <F k="guestComment" />
        <ul className="help-list">
          <li>你只看得到從這條連結留的留言，和製作團隊在底下的回覆。</li>
          <li>點一則留言：跳到那一格、攝影機飛到留言時的視角、畫記疊上去。</li>
          <li>送出後不能改、不能刪；要補充就按「<Ui>回覆</Ui>」。只收文字，一則最多 1000 字。</li>
          <li>一直送出會請你等幾分鐘再留。</li>
        </ul>
      </Section>

      <Section id={A.clientLocal} title="本地檔案（放自己電腦裡的影片）">
        <ol className="help-steps">
          <li>上面選「<Ui><Icon icon={FolderOpen} /> 本地檔案</Ui>」。</li>
          <li>按「<Ui>＋ 加入影片 / 圖片…</Ui>」，或直接把檔案拖進頁面。可以放好幾個。</li>
          <li>點清單裡的哪個，LED 就放哪個；拖曳可以排順序。</li>
        </ol>
        <ul className="help-list">
          <li>只在這台電腦播，<strong>不會上傳</strong>，別人看不到；關掉頁面就沒了。</li>
          <li>畫面要是跟 AE 合成一樣的整張畫布，才會對到每一片 LED。</li>
        </ul>
      </Section>

      <Section id={A.clientMobile} title="手機和 iPad">
        <F k="sharePhone" />
        <ul className="help-list">
          <li>手機、iPad 的 Safari、Chrome 都可以看 3D 舞台和影片。</li>
          <li>橫著拿，舞台比較大。</li>
          <li>3D 比較吃電：太燙或卡的話，關掉其他分頁。畫面會自動調低畫質保持順暢（左下角會說）。</li>
          <li>影片第一次載入要等一下，網路慢的話更久。</li>
          <li>iPhone、iPad 沒辦法用 AE 即時（那是在跑 AE 的電腦上用的）。</li>
        </ul>
      </Section>
    </Chapter>
  );
}

// ═══════════════════════════ 常見問題 ═══════════════════════════

function QuestionsChapter() {
  return (
    <Chapter id={A.questions} lead="AE 即時的問題在「AE 即時預覽」那一章的最後面。">
      <Section id={A.qPermission} title="瀏覽器問要不要「允許」連到這台裝置">
        <p>看到 <Quote>{PERMISSION_PROMPT_TEXT}</Quote> 這是網頁要連到你電腦上的 <strong>NDI 小程序</strong>（AE 即時用）。只有按了「<Ui>連接 AE 即時</Ui>」才會問。</p>
        <ul className="help-list">
          <li><strong>Chrome、Edge</strong>：按「<Ui>允許</Ui>」。<strong>每個網站只問一次</strong>，之後不會再問。</li>
          <li>不用 AE 即時的人（導演、客戶）不用理它。</li>
          <li>按到「封鎖」：看 <Go to={A.faqBlocked}>瀏覽器擋住了</Go>。</li>
          <li><strong>Safari 沒辦法</strong>：Safari 會直接擋掉，請改用 Chrome（看 <Go to={A.faqSafari}>Safari 不支援</Go>）。</li>
        </ul>
      </Section>

      <Section id={A.qVideo} title="影片播不出來">
        <ol className="help-steps">
          <li>寫「<Ui>讀取影片中…</Ui>」：等一下，大檔第一次要一點時間。</li>
          <li>小播放器說出錯了：按「<Ui>重新載入</Ui>」。頁面開了很久（幾個小時）播放網址會過期，按一下就好。</li>
          <li>版本旁邊寫「複製中」：貼連結、Drive 的影片還在複製到我們的伺服器，等它好。</li>
          <li>寫「失敗」：看紅字的原因。例如 Drive 檔案沒有設「知道連結的使用者都能查看」→ 改好按「<Ui>重試</Ui>」。</li>
          <li>檔案格式：<strong>H.264 的 MP4</strong> 最穩。ProRes 的 .mov、.mkv、某些 HEVC 影片有些電腦播不了 → 轉成 H.264 MP4 再交一次（看 <Go to={A.animAeExport}>AE 輸出設定</Go>）。版本號碼變紅、寫「這個影片瀏覽器播不了」就是這個原因。</li>
          <li>公司或學校網路可能擋影片：換個網路（例如手機熱點）試試。</li>
        </ol>
      </Section>

      <Section id={A.qUpload} title="上傳到一半中斷了">
        <p>上傳是一段一段傳的，<strong>傳好的部分不會不見</strong>。</p>
        <ol className="help-steps">
          <li>打開同一首歌，版本列下面會寫「<Ui>上傳到 44% 就停了</Ui>」。</li>
          <li>按「<Ui>繼續上傳（選同一個檔案）</Ui>」，選<strong>當初傳的那個檔案</strong>（換一台電腦也可以）。</li>
          <li>會從斷掉的地方接著傳。</li>
        </ol>
        <ul className="help-list">
          <li>每一段都已經傳上來、只差最後一步的話，交這一版的人或製作打開這一頁就會<strong>自動完成</strong>，不用再選檔案。</li>
          <li>寫「<Ui>上傳中 44%（在別的分頁或別台電腦傳）</Ui>」= 剛剛還有在傳，等一下就好。</li>
          <li>不要了：按「<Ui>取消這次上傳</Ui>」，版本號碼不會被佔走。兩天沒動的上傳會自動取消。</li>
          <li>上傳中關分頁，瀏覽器會先問你要不要離開。</li>
          <li>關掉的只有上傳的「視窗」的話，上傳本來就會繼續，不用重傳。</li>
        </ul>
      </Section>

      <Section id={A.qChina} title="在中國大陸使用">
        <ul className="help-list">
          <li><strong>影片</strong>：都放在我們自己的伺服器播放，<strong>不經過 Google</strong>。用 Google Drive 交的影片也會先複製一份過來，所以大陸也能看。</li>
          <li><strong>NDI 小程序</strong>：從我們自己的網域下載（不經過 GitHub），上面的下載按鈕在大陸也能用。</li>
          <li>在大陸的動畫師交影片，用「<Ui>上傳檔案</Ui>」最穩（Google Drive 在大陸連不上）。</li>
          <li>NDI Tools 官網在大陸可能比較慢：下載不了的話，請製作下載好傳給你。</li>
          <li>網頁打不開或很慢：先換個網路（例如手機熱點）試試，再告訴製作是哪個網路、什麼時間。</li>
        </ul>
      </Section>

      <Section id={A.qBrowsers} title="支援哪些瀏覽器">
        <div className="help-table-wrap">
          <table className="help-table help-table--wide">
            <thead><tr><th>瀏覽器</th><th>看 3D 舞台、影片、留言</th><th>AE 即時</th></tr></thead>
            <tbody>
              <tr><td>Chrome（電腦）</td><td>可以（建議）</td><td>可以</td></tr>
              <tr><td>Edge</td><td>可以</td><td>可以</td></tr>
              <tr><td>Firefox</td><td>可以</td><td>可以</td></tr>
              <tr><td>Safari（Mac）</td><td>可以</td><td>不行</td></tr>
              <tr><td>iPhone、iPad</td><td>可以</td><td>不行</td></tr>
              <tr><td>Android 手機</td><td>可以</td><td>不行（要在跑 AE 的電腦上）</td></tr>
            </tbody>
          </table>
        </div>
        <ul className="help-list">
          <li>請用新版的瀏覽器。太舊的電腦 3D 會比較卡，畫面會自動調低畫質。</li>
          <li>支援 VR 的瀏覽器（例如 Quest）：3D 畫面右下角會出現「進入 VR」。</li>
        </ul>
      </Section>
    </Chapter>
  );
}
