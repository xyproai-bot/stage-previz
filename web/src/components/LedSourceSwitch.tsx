import type { ReactNode } from 'react';
import { Film, FolderOpen, Radio } from 'lucide-react';
import Icon from './Icon';
import './LedSourceSwitch.css';

/** LED 畫面放什麼：歌曲影片（交上來的版本）/ AE 即時（NDI 小程序）/ 本地檔案（這台電腦的檔案，不上傳） */
export type LedSource = 'version' | 'ndi' | 'file';

const SOURCES: LedSource[] = ['version', 'ndi', 'file'];

/** 上次選的來源（每個頁面分開記；讀不到 = null → 用頁面的預設） */
export function readLedSource(key: string): LedSource | null {
  try {
    const v = localStorage.getItem(key);
    return v && (SOURCES as string[]).includes(v) ? (v as LedSource) : null;
  } catch {
    return null;
  }
}

export function saveLedSource(key: string, s: LedSource) {
  try { localStorage.setItem(key, s); } catch { /* 只是下次不會記得 */ }
}

interface Props {
  /** null = 什麼都沒選（分享連結：這首歌沒有影片 → LED 顯示測試圖） */
  source: LedSource | null;
  onChange: (s: LedSource) => void;
  /** 有影片可以放時才出現「影片」；label = V3 / Drive 最新 */
  showVersion: boolean;
  versionLabel?: string | null;
  /** 右邊的一句狀態 */
  status: ReactNode;
  children?: ReactNode;
}

/** 分享頁、動畫師工作站共用的來源切換：影片 V3 ｜ AE 即時 ｜ 本地檔案 */
export default function LedSourceSwitch({ source, onChange, showVersion, versionLabel, status, children }: Props) {
  const btn = (s: LedSource, icon: typeof Film, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={source === s}
      className={source === s ? 'is-active' : ''}
      onClick={() => onChange(s)}
      data-tour={s === 'file' ? 'source-file' : s === 'ndi' ? 'source-ae' : undefined}
    >
      <Icon icon={icon} size="sm" /> {label}
    </button>
  );
  return (
    <div className="led-source">
      <div className="led-source__switch" role="tablist" aria-label="LED 畫面來源">
        {(showVersion || source === 'version') && btn('version', Film, versionLabel ? `影片 ${versionLabel}` : '影片')}
        {btn('ndi', Radio, 'AE 即時')}
        {btn('file', FolderOpen, '本地檔案')}
      </div>
      <span className="led-source__status">{status}</span>
      {children && <><span className="led-source__grow" />{children}</>}
    </div>
  );
}
