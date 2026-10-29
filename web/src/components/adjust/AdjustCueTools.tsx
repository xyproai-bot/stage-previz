// 調整舞台時，cue 列上選到的 cue 旁邊的三顆小按鈕：複製 / 改名 / 轉場秒數
//   複製：從這個 cue 複製一個新的放進 Cue 庫（還沒放進任何歌）
//   改名：只改名字，編號不動
//   轉場秒數：這首歌自己另外設了 → 改這首歌自己的；沒有 → 改 Cue 庫的（用到的歌一起變，先列出來）
// 流程在 useStageSave；後台權限是導演和製作（動畫師看不到調整舞台）。

import { Copy, Pencil, Timer } from 'lucide-react';
import Icon from '../Icon';
import { STAGE_SAVE_TEXT } from '../../lib/adjust/saveBack';
import type { StageSaveApi } from './useStageSave';
import './AdjustStage.css';

export default function AdjustCueTools({ save, enabled }: { save: StageSaveApi; enabled: boolean }) {
  const tip = (t: string) => (enabled ? t : STAGE_SAVE_TEXT.noCue);
  return (
    <span className="adjust-cue-tools" role="group" aria-label="這個 cue">
      <button type="button" onClick={save.copy} disabled={!enabled || save.busy} title={tip('從這個 cue 複製一個新的放進 Cue 庫（不會放進任何一首歌）')} aria-label={STAGE_SAVE_TEXT.copy}>
        <Icon icon={Copy} /><span className="adjust-cue-tools__label"> {STAGE_SAVE_TEXT.copy}</span>
      </button>
      <button type="button" onClick={save.rename} disabled={!enabled || save.busy} title={tip('只改這個 cue 的名字，編號不變')} aria-label={STAGE_SAVE_TEXT.rename}>
        <Icon icon={Pencil} /><span className="adjust-cue-tools__label"> {STAGE_SAVE_TEXT.rename}</span>
      </button>
      <button type="button" onClick={save.seconds} disabled={!enabled || save.busy} title={tip('改這個 cue 的轉場秒數')} aria-label={STAGE_SAVE_TEXT.seconds}>
        <Icon icon={Timer} /><span className="adjust-cue-tools__label"> {STAGE_SAVE_TEXT.seconds}</span>
      </button>
    </span>
  );
}
