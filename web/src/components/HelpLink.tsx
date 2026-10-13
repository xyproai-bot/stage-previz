// 小小的「?」：在新分頁打開使用說明的某一段（段落在 lib/helpLinks.ts）。
// 放在對話框標題、分頁標題旁邊；只有圖示，所以 title / aria-label 都是「說明」。
import { CircleHelp } from 'lucide-react';
import Icon from './Icon';
import { helpUrl, type HelpAnchor } from '../lib/helpLinks';
import './HelpLink.css';

export default function HelpLink({ anchor, className }: { anchor: HelpAnchor; className?: string }) {
  return (
    <a
      className={'help-link' + (className ? ' ' + className : '')}
      href={helpUrl(anchor)}
      target="_blank"
      rel="noopener"
      title="說明"
      aria-label="說明"
    >
      <Icon icon={CircleHelp} size="md" />
    </a>
  );
}
