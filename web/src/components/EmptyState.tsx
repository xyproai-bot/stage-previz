// 空白頁的說明（還沒有歌、還沒有指派給你的歌、沒有等你審的…）：圖示 + 一句話 + 下一步可以做什麼。
// 不要讓畫面留一塊空白；說明用白話，有能按的下一步就給按鈕。
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import Icon from './Icon';
import './EmptyState.css';

interface Props {
  icon: LucideIcon;
  title: string;
  /** 補充說明（下一步會發生什麼、去哪裡做） */
  children?: ReactNode;
  /** 按鈕（下一步） */
  actions?: ReactNode;
  /** compact = 放在小欄位裡（審片看板的一欄、側欄） */
  size?: 'page' | 'compact';
  className?: string;
}

export default function EmptyState({ icon, title, children, actions, size = 'page', className }: Props) {
  return (
    <div className={`empty-state-box empty-state-box--${size}${className ? ` ${className}` : ''}`} role="status">
      <span className="empty-state-box__icon"><Icon icon={icon} size={size === 'page' ? 'xl' : 'lg'} /></span>
      <div className="empty-state-box__title">{title}</div>
      {children && <div className="empty-state-box__text">{children}</div>}
      {actions && <div className="empty-state-box__actions">{actions}</div>}
    </div>
  );
}
