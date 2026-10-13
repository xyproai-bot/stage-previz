// 全站統一的線條圖示（lucide-react）：同一個線條粗細、同一套尺寸、跟旁邊的文字置中對齊。
//
// 用法（一定要「按名字」import，打包才只會帶用到的圖示）：
//   import { Trash2 } from 'lucide-react';
//   <button><Icon icon={Trash2} /> 刪除</button>
//
//   - 旁邊有文字 → 不用給 label，圖示自動 aria-hidden（螢幕報讀只念文字）
//   - 只有圖示的按鈕 → 按鈕自己要有 title + aria-label（繁體中文），圖示一樣 aria-hidden
//   - 圖示本身要被念出來（旁邊沒有任何字）→ 給 label
import type { LucideIcon, LucideProps } from 'lucide-react';
import type { SongStatus } from '../lib/mockData';
import './Icon.css';

/** 尺寸：xs 12（小標記）/ sm 14（一般按鈕、清單）/ md 16（工具列）/ lg 20（標題）/ xl 32、xxl 44（空狀態的大圖示） */
export const ICON_SIZES = { xs: 12, sm: 14, md: 16, lg: 20, xl: 32, xxl: 44 } as const;
export type IconSize = keyof typeof ICON_SIZES;
/** 全站線條粗細（lucide 原本是 2，細一點比較精緻） */
export const ICON_STROKE = 1.75;

type IconProps = Omit<LucideProps, 'size' | 'ref'> & {
  icon: LucideIcon;
  size?: IconSize;
  /** 只有圖示、旁邊沒有字、又需要被念出來時才給 */
  label?: string;
  /** 一直轉（載入中，配 LoaderCircle）；使用者設定「減少動態」時不轉 */
  spin?: boolean;
};

export default function Icon({ icon: Glyph, size = 'sm', label, spin = false, className, strokeWidth = ICON_STROKE, ...rest }: IconProps) {
  return (
    <Glyph
      size={ICON_SIZES[size]}
      strokeWidth={strokeWidth}
      className={`ui-icon ui-icon--${size}${spin ? ' ui-icon--spin' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    />
  );
}

/** 審片狀態的小色點（待製作 灰 / 審查中 橘 / 需修改 紅 / 已通過 綠）；旁邊一定要有狀態文字 */
export function StatusDot({ status, className }: { status: SongStatus; className?: string }) {
  return <span className={`review-dot review-dot--${status}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
