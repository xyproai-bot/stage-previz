// 設定頁的「系統狀態」（只有製作看得到）：資料庫最近一次自動備份、空間用量 / 估計費用 / 重複的檔案（StorageUsagePanel）、
// 最近 7 天的前端錯誤（同一個訊息算一組）
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, Database, Download, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import Icon from './Icon';
import { downloadBackup, formatBackupSize, getSystemStatus, type SystemStatus } from '../lib/systemStatusApi';
import { formatDateTime, formatRelativeTime } from '../lib/serverTime';
import { toast } from '../lib/toast';
import StorageUsagePanel from './StorageUsagePanel';
import './SystemStatusSection.css';

export default function SystemStatusSection() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // 按「重新整理」→ 空間用量也重新讀
  const [rev, setRev] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRev(n => n + 1);
    try {
      setData(await getSystemStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleDownload(file: string) {
    setDownloading(true);
    try {
      await downloadBackup(file);
    } catch (e) {
      toast.error('下載備份失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDownloading(false);
    }
  }

  const b = data?.backup;
  const groups = data?.clientErrors.groups ?? [];

  return (
    <section className="settings-card sys-status">
      <div className="sys-status__head">
        <h2>系統狀態</h2>
        <button className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={loading}>
          <Icon icon={loading ? LoaderCircle : RefreshCw} spin={loading} /> 重新整理
        </button>
      </div>
      <p className="settings-desc">資料庫每天自動備份一份；空間用了多少、每個月大概多少錢；大家的畫面出錯會自動回報到這裡。</p>

      {error && <p className="sys-status__warn"><Icon icon={TriangleAlert} /> 讀不到系統狀態：{error}</p>}

      {data && (
        <>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__title"><Icon icon={Database} /> 資料庫備份</div>
              <div className="settings-row__sub">
                {b?.last
                  ? <>最近一份：{formatDateTime(b.last.finishedAt)}（{formatRelativeTime(b.last.finishedAt)}）· {formatBackupSize(b.last.size)} · 共留著 {b.count} 份</>
                  : '還沒有備份（排程每 5 分鐘看一次，第一份很快就會好）'}
              </div>
              {b?.running && <div className="settings-row__sub">正在備份 {b.running.day}（已經 {b.running.rows} 列）</div>}
              {b?.lastError && (
                <div className="settings-row__sub sys-status__warn">
                  <Icon icon={TriangleAlert} /> {b.failedDay ? `${b.failedDay} 的備份失敗了，明天會再做` : '上一次備份出錯，會自動再試'}：{b.lastError.message}
                </div>
              )}
            </div>
            {b?.latest && (
              <button className="btn btn--ghost" onClick={() => void handleDownload(b.latest!.file)} disabled={downloading}>
                <Icon icon={downloading ? LoaderCircle : Download} spin={downloading} /> 下載最近一份
              </button>
            )}
          </div>

          <StorageUsagePanel key={rev} />

          <h3 className="sys-status__subtitle">最近 7 天的畫面錯誤</h3>
          {groups.length === 0 ? (
            <p className="sys-status__ok"><Icon icon={CircleCheck} /> 最近 7 天沒有錯誤</p>
          ) : (
            <ul className="sys-status__errors">
              {groups.map(g => (
                <li key={g.fingerprint} className="sys-status__error">
                  <div className="sys-status__msg">{g.message}</div>
                  <div className="sys-status__meta">
                    {g.count} 次 · {g.users > 0 ? `${g.users} 個人` : '沒登入的人'} · 最後一次 {formatRelativeTime(g.lastAt)}
                    {g.sample.path && <> · {g.sample.path}</>}
                    {g.sample.appVersion && <> · 版本 {g.sample.appVersion}</>}
                    {g.sample.userName && <> · 最近是 {g.sample.userName}</>}
                  </div>
                  {(g.sample.stack || g.sample.userAgent) && (
                    <details className="sys-status__details">
                      <summary>詳細內容</summary>
                      {g.sample.userAgent && <div className="sys-status__ua">{g.sample.userAgent}</div>}
                      {g.sample.stack && <pre className="sys-status__stack">{g.sample.stack}</pre>}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {!data && !error && <p className="settings-row__sub">讀取中…</p>}
    </section>
  );
}
