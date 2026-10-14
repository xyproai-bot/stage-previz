// 導演頁、動畫師工作站外面包的這一層（App 路由）：製作用 ?as= 打開時變成預覽模式（lib/viewAsContext.tsx）
import type { ReactNode } from 'react';
import { ViewAsProvider } from '../lib/viewAsContext';
import ViewAsBanner from './ViewAsBanner';

export default function ViewAsPage({ children }: { children: ReactNode }) {
  return <ViewAsProvider banner={<ViewAsBanner />}>{children}</ViewAsProvider>;
}
