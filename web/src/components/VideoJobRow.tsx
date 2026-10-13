import { Check, CircleAlert, Link2, LoaderCircle, RotateCcw, Upload, X } from 'lucide-react';
import Icon from './Icon';
import { isJobActive, jobPercent, jobStatusText, videoJobs, type VideoJob } from '../lib/videoJobs';
import './VideoJobRow.css';

/** 一個正在交的影片：檔名 / 連結、進度條（百分比 + MB）、取消 / 重試 / 拿掉 */
export default function VideoJobRow({ job, compact = false }: { job: VideoJob; compact?: boolean }) {
  const pct = jobPercent(job);
  const active = isJobActive(job);
  const failed = job.phase === 'failed';
  const done = job.phase === 'done';
  return (
    <div className={`vjob vjob--${job.phase}${compact ? ' vjob--compact' : ''}`}>
      <div className="vjob__top">
        <Icon
          icon={failed ? CircleAlert : done ? Check : active ? (job.kind === 'link' ? Link2 : Upload) : X}
          size="sm"
          className="vjob__icon"
        />
        <span className="vjob__name" title={job.name}>{job.name}</span>
        {active && (job.phase === 'starting' || job.phase === 'finishing') && <Icon icon={LoaderCircle} spin size="sm" />}
        <span className="vjob__grow" />
        {failed && job.retryable && (
          <button type="button" className="vjob__btn" onClick={() => videoJobs.retry(job.id)}>
            <Icon icon={RotateCcw} size="sm" /> 重試
          </button>
        )}
        {(active || failed) && (
          <button type="button" className="vjob__btn" onClick={() => void videoJobs.cancel(job.id)}>
            取消
          </button>
        )}
        {!active && (
          <button
            type="button"
            className="vjob__btn vjob__btn--icon"
            onClick={() => videoJobs.dismiss(job.id)}
            title="從清單拿掉"
            aria-label="從清單拿掉"
          >
            <Icon icon={X} size="sm" />
          </button>
        )}
      </div>
      {(active || done) && (
        <div
          className={'vjob__bar' + (pct == null ? ' is-indeterminate' : '')}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-label={jobStatusText(job)}
        >
          <span style={pct != null ? { width: `${pct}%` } : undefined} />
        </div>
      )}
      <div className={'vjob__status' + (failed ? ' is-error' : '')} role={failed ? 'alert' : undefined}>
        {jobStatusText(job)}
      </div>
    </div>
  );
}
