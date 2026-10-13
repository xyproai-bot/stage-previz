// AE 即時（NDI 小程序）的引導畫面：3D 舞台上的檢查清單卡片、工具列 NDI 標示的面板都用這些。
// 該說什麼、卡在哪一步全部來自 lib/ndiSteps.ts（只有一個說法）。

import {
  ndiAutostartNote, ndiChecklist, ndiStepMessage, showSourcePicker, sourceLabel, sourcePickerInStep,
  type NdiGuide as Guide,
} from '../lib/ndiSteps';
import type { NdiEnv } from '../lib/ndiConnection';
import { NDI_HELPER_DOWNLOAD_URL, NDI_HELPER_DOWNLOAD_URL_MAC, NDI_TOOLS_URL } from '../lib/downloads';
import { helpUrl, ndiHelpAnchor } from '../lib/helpLinks';
import { toast } from '../lib/toast';
import './NdiGuide.css';

interface GuideProps {
  guide: Guide;
  env: NdiEnv;
  onConnect: () => void;
  onSelectSource: (name: string | null) => void;
}

/** 小程序下載：Windows / Mac 兩個都給，這台電腦是哪個就亮哪個 */
export function NdiDownloadButtons({ os, update = false }: { os: NdiEnv['os']; update?: boolean }) {
  const verb = update ? '下載新版' : '下載';
  const win = (
    <a key="win" className={'ndi-guide__btn' + (os !== 'mac' ? ' ndi-guide__btn--primary' : '')} href={NDI_HELPER_DOWNLOAD_URL}>
      ⬇ {verb}（Windows）
    </a>
  );
  const mac = (
    <a key="mac" className={'ndi-guide__btn' + (os === 'mac' ? ' ndi-guide__btn--primary' : '')} href={NDI_HELPER_DOWNLOAD_URL_MAC}>
      ⬇ {verb}（Mac）
    </a>
  );
  return <div className="ndi-guide__actions">{os === 'mac' ? [mac, win] : [win, mac]}</div>;
}

async function copyPageLink() {
  const url = typeof location !== 'undefined' ? location.href : '';
  try {
    await navigator.clipboard.writeText(url);
    toast.success('已複製連結，貼到 Chrome、Edge 或 Firefox 打開');
  } catch {
    // 不給複製（權限 / 舊瀏覽器）→ 顯示出來讓他自己選
    window.prompt('複製這個連結，貼到 Chrome、Edge 或 Firefox 打開：', url);
  }
}

/** 目前這一步可以按的東西 */
function StepActions({ guide, env, onConnect }: Omit<GuideProps, 'onSelectSource'>) {
  switch (guide.step) {
    case 'browser_unsupported':
      return (
        <div className="ndi-guide__actions">
          <button className="ndi-guide__btn ndi-guide__btn--primary" onClick={copyPageLink}>📋 複製這個連結</button>
        </div>
      );
    case 'need_permission':
      return (
        <div className="ndi-guide__actions">
          <button className="ndi-guide__btn ndi-guide__btn--primary" onClick={onConnect} disabled={guide.pending}>
            {guide.pending ? '等你按「允許」…' : '連接 AE 即時'}
          </button>
        </div>
      );
    case 'helper_missing':
      return <NdiDownloadButtons os={env.os} />;
    case 'helper_outdated':
      return <NdiDownloadButtons os={env.os} update />;
    case 'ndi_missing':
      return (
        <div className="ndi-guide__actions">
          <a className="ndi-guide__btn ndi-guide__btn--primary" href={NDI_TOOLS_URL} target="_blank" rel="noreferrer">下載 NDI Tools ↗</a>
        </div>
      );
    default:
      return null;
  }
}

/** 「看圖文說明」：開新分頁到說明頁對應的那一段（舞台不會不見）；這一步沒有說明 → 不顯示 */
export function NdiHelpLink({ guide, label = '📖 看圖文說明' }: { guide: Guide; label?: string }) {
  const anchor = ndiHelpAnchor(guide.step);
  if (!anchor) return null;
  return (
    <a className="ndi-guide__help" href={helpUrl(anchor)} target="_blank" rel="noopener">{label}</a>
  );
}

/**
 * 來源選單（不只一個來源、或這台電腦的 AE 沒在送但網路上有別台的才出現）：
 * AE 排前面、標出這台電腦 / 哪一台電腦；「自動」= null（只接這台電腦的）
 */
export function NdiSourcePicker({ guide, onSelectSource }: Pick<GuideProps, 'guide' | 'onSelectSource'>) {
  if (!showSourcePicker(guide)) return null;
  const value = guide.mode === 'manual' && guide.preferred ? guide.preferred : '';
  const offline = value && !guide.sources.some(s => s.name === value);
  return (
    <label className="ndi-source-picker">
      <span className="ndi-source-picker__label">來源</span>
      <select value={value} onChange={e => onSelectSource(e.target.value || null)}>
        <option value="">自動（這台電腦的 AE）</option>
        {guide.sources.map(s => <option key={s.name} value={s.name}>{sourceLabel(s)}</option>)}
        {offline && <option value={value}>{value}（現在沒在線上）</option>}
      </select>
    </label>
  );
}

/** 小程序沒辦法開機自動啟動：一行小提醒（不擋 AE 即時） */
export function NdiAutostartNote({ guide }: { guide: Guide }) {
  const note = ndiAutostartNote(guide);
  if (!note) return null;
  return <p className="ndi-guide__note" role="note"><span aria-hidden>⚠ </span>{note}</p>;
}

/**
 * ☑ / ☐ 五格檢查清單；卡住的那一格展開說明 + 按鈕。
 * 下面跟著「開機自動啟動沒設好」的提醒（showAutostartNote=false → 自己放別的地方）
 */
export function NdiChecklist({ guide, env, onConnect, onSelectSource, showAutostartNote = true }: GuideProps & {
  showAutostartNote?: boolean;
}) {
  const rows = ndiChecklist(guide);
  const msg = ndiStepMessage(guide, env.browser);
  return (
    <>
      <ol className="ndi-guide__list">
        {rows.map(r => (
          <li key={r.label} className={'ndi-guide__row is-' + r.state}>
            <div className="ndi-guide__row-head">
              <span className="ndi-guide__mark" aria-hidden>{r.state === 'done' ? '☑' : '☐'}</span>
              <span className="ndi-guide__label">{r.label}</span>
            </div>
            {r.state === 'current' && (
              <div className="ndi-guide__detail">
                <p className="ndi-guide__title">{msg.title}</p>
                {msg.detail.map(d => <p key={d} className="ndi-guide__sub">{d}</p>)}
                <StepActions guide={guide} env={env} onConnect={onConnect} />
                {sourcePickerInStep(guide) && <NdiSourcePicker guide={guide} onSelectSource={onSelectSource} />}
                <NdiHelpLink guide={guide} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {showAutostartNote && <NdiAutostartNote guide={guide} />}
    </>
  );
}

/** 3D 舞台上要不要顯示引導卡片（連線中 / 已經 LIVE 不用） */
export function ndiCardVisible(guide: Guide): boolean {
  return guide.step !== 'live' && guide.step !== 'connecting' && guide.step !== 'ready';
}

/** 收起卡片要記哪一步（換到別的問題會再出現） */
export function ndiCardKey(guide: Guide): string {
  return guide.step + (guide.step === 'waiting_frames' && guide.hadFrames ? ':paused' : '');
}

/**
 * 3D 舞台上的卡片：AE 即時還沒接好時才出現（LIVE 就收掉）。
 * 播到一半 AE 停住 → 只顯示一條小提示（LED 留在最後一格，不擋畫面）。
 */
export function NdiGuideCard({ guide, env, onConnect, onSelectSource, onCollapse, hint }: GuideProps & {
  onCollapse: () => void;
  /** 卡片最下面的小字（分享頁：沒有 AE 可以改放本地檔案） */
  hint?: string;
}) {
  if (guide.step === 'waiting_frames' && guide.hadFrames) {
    const msg = ndiStepMessage(guide, env.browser);
    return (
      <div className="ndi-guide ndi-guide--banner" role="status">
        <span className="ndi-guide__banner-icon" aria-hidden>⏸</span>
        <span className="ndi-guide__banner-text">{msg.title}</span>
        <button className="ndi-guide__close" onClick={onCollapse} title="收起" aria-label="收起">×</button>
      </div>
    );
  }
  const done = ndiChecklist(guide).filter(r => r.state === 'done').length;
  return (
    <div className="ndi-guide" role="status" aria-live="polite">
      <div className="ndi-guide__head">
        <strong>🔴 AE 即時畫面</strong>
        <span className="ndi-guide__count">{done} / 5</span>
        <button
          className="ndi-guide__close"
          onClick={onCollapse}
          title="收起（按上面的 NDI 標示可以再打開）"
          aria-label="收起"
        >×</button>
      </div>
      <NdiChecklist guide={guide} env={env} onConnect={onConnect} onSelectSource={onSelectSource} />
      {hint && <div className="ndi-guide__hint">{hint}</div>}
    </div>
  );
}
