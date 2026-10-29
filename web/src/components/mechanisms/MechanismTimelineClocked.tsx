// 編輯頁用的機關時間軸：就是 MechanismTimeline，只是音樂是這首歌的時間時（沒影片、有音樂），播放頭跟著音樂走
// （clock 從 EditorMusicContext 拿；其他情況跟原本完全一樣）。
//   - 頁面自己傳 clock 就用頁面傳的
//   - Cue 庫裡看單一個 cue 的時間軸（single）不跟音樂走：它的 0 秒是這個 cue 開始轉場，不是歌的時間
import { useContext, type ComponentProps } from 'react';
import MechanismTimeline from './MechanismTimeline';
import { EditorMusicContext } from '../../lib/editorMusicContext';

export default function MechanismTimelineClocked(props: ComponentProps<typeof MechanismTimeline>) {
  const { clock } = useContext(EditorMusicContext);
  const own = props.clock !== undefined || props.single ? props.clock : clock;
  return <MechanismTimeline {...props} clock={own} />;
}
