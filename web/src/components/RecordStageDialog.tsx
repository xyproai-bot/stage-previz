// 「錄成影片」的設定視窗（工作站）：解析度、範圍、鏡頭、要不要疊 cue 字幕 → 按「開始錄」。
// 錄影本身在 lib/useStageRecorder.ts；選項的規則在 lib/stageRecording.ts。

import { useState } from 'react';
import { Clapperboard, X } from 'lucide-react';
import Icon from './Icon';
import { useEscapeClose } from '../lib/useEscapeClose';
import type { CameraBookmark } from '../lib/cameraBookmarks';
import {
  DEFAULT_RECORD_RESOLUTION, RECORD_RESOLUTIONS, WEBM_NOTE, progressLabel, recordRange, recordResolution,
  type RecordFormat, type RecordResolution, type RecordScope,
} from '../lib/stageRecording';
import './NewProjectDialog.css';
import './RecordStageDialog.css';

export interface RecordChoice {
  resolution: RecordResolution;
  scope: RecordScope;
  /** 專案視角的 id；null = 現在的視角 */
  bookmarkId: string | null;
  caption: boolean;
}

interface Props {
  onClose: () => void;
  onStart: (c: RecordChoice) => void;
  format: RecordFormat | null;
  bookmarks: readonly CameraBookmark[];
  /** 影片現在的時間和總長（算「從目前時間」要錄多久） */
  currentTime: number;
  duration: number;
  /** 這支影片的名字（顯示用） */
  sourceLabel: string;
}

export default function RecordStageDialog({ onClose, onStart, format, bookmarks, currentTime, duration, sourceLabel }: Props) {
  useEscapeClose(true, onClose);
  const [resId, setResId] = useState<string>(DEFAULT_RECORD_RESOLUTION.id);
  const [scope, setScope] = useState<RecordScope>('all');
  const [bookmarkId, setBookmarkId] = useState<string>('');
  const [caption, setCaption] = useState(true);
  const res = recordResolution(resId);
  const range = recordRange(scope, currentTime, duration);
  const fromNowUseful = currentTime > 0 && currentTime < duration - 0.5;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog record-dialog" role="dialog" aria-modal="true" aria-labelledby="record-title" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 id="record-title">錄成影片</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          <p className="record-dialog__lead">
            把「3D 舞台 + 影片貼在 LED 上」播一遍錄下來，存成影片檔，可以直接傳 Google Drive 給導演。影片：{sourceLabel}
          </p>
          <div className="record-dialog__row">
            <span className="record-dialog__label">解析度</span>
            <div className="comment-scope" role="radiogroup" aria-label="解析度">
              {RECORD_RESOLUTIONS.map(r => (
                <button key={r.id} type="button" role="radio" aria-checked={resId === r.id}
                  className={'comment-scope__btn' + (resId === r.id ? ' is-active' : '')} onClick={() => setResId(r.id)}
                >{r.label}</button>
              ))}
            </div>
          </div>
          {res.note && <p className="record-dialog__warn">{res.note}</p>}
          <div className="record-dialog__row">
            <span className="record-dialog__label">範圍</span>
            <div className="comment-scope" role="radiogroup" aria-label="錄的範圍">
              <button type="button" role="radio" aria-checked={scope === 'all'}
                className={'comment-scope__btn' + (scope === 'all' ? ' is-active' : '')} onClick={() => setScope('all')}
              >整首（從頭到尾）</button>
              <button type="button" role="radio" aria-checked={scope === 'fromNow'} disabled={!fromNowUseful}
                className={'comment-scope__btn' + (scope === 'fromNow' ? ' is-active' : '')} onClick={() => setScope('fromNow')}
              >從目前時間到結束</button>
            </div>
          </div>
          <div className="record-dialog__row">
            <span className="record-dialog__label">鏡頭</span>
            <select value={bookmarkId} onChange={(e) => setBookmarkId(e.target.value)} aria-label="鏡頭">
              <option value="">現在的視角</option>
              {bookmarks.map(b => <option key={b.id} value={b.id}>專案視角：{b.name}</option>)}
            </select>
          </div>
          <label className="record-dialog__check">
            <input type="checkbox" checked={caption} onChange={(e) => setCaption(e.target.checked)} />
            左下角疊 cue 名稱字幕（例如「Cue 3 副歌全開」）
          </label>
          <p className="record-dialog__hint">
            會錄 {progressLabel({ elapsed: 0, length: range.length })}，要等它播完；錄的時候播放控制會鎖住，請讓這個分頁留在最前面。
            {format && !format.isMp4 && <strong className="record-dialog__webm"> {WEBM_NOTE}。</strong>}
          </p>
          <div className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose}>取消</button>
            <button type="button" className="btn btn--primary" disabled={range.length <= 0}
              onClick={() => onStart({ resolution: res, scope, bookmarkId: bookmarkId || null, caption })}
            >
              <Icon icon={Clapperboard} /> 開始錄
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
