import { RotateCcw, Upload } from 'lucide-react';
import Icon from './Icon';
import { formatDateTime } from '../lib/serverTime';
import { videoProgressPercent, videoStatusLabel, type SongVideo } from '../lib/videoApi';
import { pendingUploadText, type StalledView } from '../lib/stalledUploads';
import { useViewAs } from '../lib/viewAsContext';
import './VideoJobRow.css';

interface Props {
  v: SongVideo;
  /** 這個人能不能動這一版（重試 / 繼續上傳 / 取消）：lib/songVersions.ts canModifyVideo */
  can: boolean;
  /** 不是這個分頁在傳的「上傳中」那一版現在的情況（lib/stalledUploads.ts） */
  view?: StalledView;
  /** 失敗的（貼連結 / Drive）→ 重試 */
  onRetry?: (v: SongVideo) => void;
  /** 整理成一個檔案沒成功 →「再試一次」 */
  onRetryFinish?: (v: SongVideo) => void;
  /** 「繼續上傳（選同一個檔案）」：外面打開選檔案 */
  onResume?: (v: SongVideo) => void;
  /** 取消 / 拿掉 */
  onRemove?: (v: SongVideo) => void;
  /** 多寫誰交的、什麼時候、說明，狀態前面寫「失敗」（影片版本視窗用；版本列上一行就好） */
  detailed?: boolean;
}

/**
 * 還沒好的一版（上傳中 / 複製中 / 失敗）：名字、進度條、狀態、重試 / 繼續上傳 / 取消。
 * 導演頁、動畫師工作站的版本列（SongVersionBar）和編輯頁的「影片版本」視窗共用。
 */
export default function PendingVideoRow({ v, can, view, onRetry, onRetryFinish, onResume, onRemove, detailed = false }: Props) {
  // 預覽模式（製作用其他身分看）：按鈕照樣出現但按不下去
  const { ro } = useViewAs();
  const pct = videoProgressPercent(v);
  const up = v.status === 'uploading' ? pendingUploadText(pct, view, can) : null;
  const finishing = view?.kind === 'finishing' || (view?.kind === 'finish' && can);
  const failed = v.status === 'failed';
  const name = v.title || v.originalUrl || '影片';
  const by = v.createdBy ? (v.createdBy.name || '（沒有名字）') : (v.source === 'drive' ? 'Drive 同步' : '');
  const when = formatDateTime(v.createdAt);
  return (
    <div className={`vjob vjob--compact vjob--${failed || up?.error ? 'failed' : 'copying'}`}>
      <div className="vjob__top">
        <span className="vjob__name" title={v.title || v.originalUrl || ''}>{name}</span>
        <span className="vjob__grow" />
        {can && failed && v.source !== 'upload' && onRetry && (
          <button type="button" className="vjob__btn" onClick={() => onRetry(v)} {...ro()}>
            <Icon icon={RotateCcw} size="sm" /> 重試
          </button>
        )}
        {can && view?.kind === 'finishFailed' && onRetryFinish && (
          <button type="button" className="vjob__btn" onClick={() => onRetryFinish(v)} {...ro()}>
            <Icon icon={RotateCcw} size="sm" /> 再試一次
          </button>
        )}
        {can && view?.kind === 'resume' && onResume && (
          <button
            type="button"
            className="vjob__btn"
            onClick={() => onResume(v)}
            {...ro('選當初傳的那個檔案，會從停下來的地方接著傳')}
          >
            <Icon icon={Upload} size="sm" /> 繼續上傳（選同一個檔案）
          </button>
        )}
        {can && onRemove && !finishing && (
          <button type="button" className="vjob__btn" onClick={() => onRemove(v)} {...ro()}>
            {failed ? '拿掉' : v.status === 'uploading' ? '取消這次上傳' : '取消'}
          </button>
        )}
      </div>
      {detailed && (by || when || v.note) && (
        <div className="vjob__by">
          {[by ? `${by} 交的` : '', when].filter(Boolean).join(' · ')}
          {v.note && <span className="vjob__note">「{v.note}」</span>}
        </div>
      )}
      {!failed && (
        <div className={'vjob__bar' + (pct == null || finishing ? ' is-indeterminate' : '')}>
          <span style={pct != null && !finishing ? { width: `${pct}%` } : undefined} />
        </div>
      )}
      <div className={'vjob__status' + (failed || up?.error ? ' is-error' : '')}>
        {failed
          ? (detailed ? `失敗：${v.error || '沒有交成功'}` : (v.error || '失敗了'))
          : up
          ? up.text
          : `${videoStatusLabel(v)}${pct != null ? ` ${pct}%` : '…'}`}
      </div>
    </div>
  );
}
