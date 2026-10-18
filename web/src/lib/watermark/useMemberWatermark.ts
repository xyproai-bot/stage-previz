// 團隊成員的頁面（導演頁、動畫師工作站、編輯頁）用：專案有打開「成員看片也加浮水印」→ 這一頁的 3D 畫面和小播放器印上自己的名字和時間。
// 頁面只要呼叫一次（傳專案的設定，還沒讀到就傳 undefined），畫面那邊（StageScene / MiniPlayer）自己去看 store。
import { useMemo } from 'react';
import { useAuth } from '../auth';
import { shouldWatermarkMember } from './policy';
import { useWatermarkScope } from './store';
import type { WatermarkIdentity } from './text';

export function useMemberWatermark(projectFlag: boolean | null | undefined): void {
  const { user } = useAuth();
  const on = shouldWatermarkMember(projectFlag);
  const identity = useMemo<WatermarkIdentity | null>(
    () => (on && user ? { kind: 'member', name: user.name, email: user.email ?? null } : null),
    [on, user],
  );
  useWatermarkScope(identity);
}
