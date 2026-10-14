// 系統狀態裡的「空間用量」和「重複的檔案」（只有製作）。
//   每個專案：影片 / 已刪除（還在 30 天內）/ 模型 / 留言圖片、幾版、每月大概多少錢；整個帳號的合計；最大的三個專案有「專案結束清影片」
//   重複的檔案：同一個專案裡一模一樣的影片（指紋），浪費多少空間，按「打開影片版本」到編輯頁刪掉多的（照一般 30 天刪除流程）
// 影片的數字從資料庫算（隨時是最新的）；模型、留言圖片是排程每 6 小時把 R2 列一次的結果。
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Film, HardDrive, LoaderCircle, RefreshCw } from 'lucide-react';
import Icon from './Icon';
import ProjectWrapUpDialog from './ProjectWrapUpDialog';
import {
  formatGb, formatTwd, formatUsd, getStorageSummary, monthlyCostUsd, R2_FREE_GB, requestStorageRescan,
  type ProjectUsage, type StorageSummary,
} from '../lib/storageApi';
import { formatRelativeTime } from '../lib/serverTime';
import { toast } from '../lib/toast';

function cost(usd: number): string {
  return `${formatUsd(usd)}（${formatTwd(usd)}）`;
}

export default function StorageUsagePanel() {
  const navigate = useNavigate();
  const [data, setData] = useState<StorageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrapUp, setWrapUp] = useState<ProjectUsage | null>(null);

  const load = useCallback(async () => {
    try { setData(await getStorageSummary()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function rescan() {
    try {
      const r = await requestStorageRescan();
      toast.success(r.already ? '正在重新計算，幾分鐘後再按「重新整理」' : '好，5 分鐘內會重新計算模型和留言圖片的大小');
    } catch (e) {
      toast.error('沒有成功：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (error) return <p className="sys-status__warn">讀不到空間用量：{error}</p>;
  if (!data) return <p className="settings-row__sub"><Icon icon={LoaderCircle} spin size="sm" /> 讀取空間用量中…</p>;

  const a = data.account;
  const accountUsd = monthlyCostUsd({ standardBytes: a.standardBytes, iaBytes: a.iaBytes }, true);
  const projects = data.projects.filter(p => p.totalBytes > 0);
  const top = new Set(projects.slice(0, 3).filter(p => p.videoCount + p.deletedCount > 0).map(p => p.id));
  const dups = data.duplicates;

  return (
    <div className="storage">
      <h3 className="sys-status__subtitle"><Icon icon={HardDrive} /> 空間用量</h3>
      <div className="storage__total">
        <div>
          <div className="storage__big">{formatGb(a.totalBytes)}</div>
          <div className="settings-row__sub">
            {[
              '整個帳號',
              `影片 ${formatGb(a.videoBytes)}（${a.videoCount} 版）`,
              `已刪除（還在 30 天內）${formatGb(a.deletedBytes)}`,
              `模型 ${formatGb(a.modelBytes)}`,
              `留言圖片 ${formatGb(a.commentImageBytes)}`,
              a.accountBytes > 0 ? `共用模型庫、備份、下載檔 ${formatGb(a.accountBytes)}` : '',
              a.iaBytes > 0 ? `其中長期存放 ${formatGb(a.iaBytes)}` : '',
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="storage__cost">
          <div>每月大約 <strong>{cost(accountUsd)}</strong></div>
          <div className="settings-row__sub">{a.standardBytes < R2_FREE_GB * 1024 ** 3 ? `還在每月 ${R2_FREE_GB} GB 免費額度裡` : `已經扣掉前 ${R2_FREE_GB} GB 免費額度`}</div>
        </div>
      </div>
      <p className="settings-desc storage__note">
        只是估計：標準存放每 GB 每月 US$0.015（整個帳號前 {R2_FREE_GB} GB 免費）、長期存放 US$0.01（打開時每 GB 另外 US$0.01）。
        看影片、下載在 Cloudflare 不收錢。台幣用 1 美元 = 32 元粗估。下面每個專案的費用沒有扣免費額度（免費額度是整個帳號一起算）。
        <br />
        影片的大小隨時是最新的；模型、留言圖片每 6 小時算一次
        {a.r2.scannedAt ? `（上次 ${formatRelativeTime(a.r2.scannedAt)}，R2 實際存了 ${formatGb(a.r2.bytes)}、${a.r2.objects} 個檔案）` : '（還沒算過，排程 5 分鐘內會算）'}。
        {' '}<button type="button" className="storage__link" onClick={() => void rescan()}><Icon icon={RefreshCw} size="xs" /> 重新計算</button>
      </p>

      {projects.length === 0 ? <p className="settings-row__sub">還沒有存任何東西。</p> : (
        <ul className="storage__list">
          {projects.map(p => {
            const usd = monthlyCostUsd({ standardBytes: p.standardBytes, iaBytes: p.iaBytes });
            const moving = p.storageJobs.queued;
            return (
              <li key={p.id} className={'storage__row' + (top.has(p.id) ? ' is-top' : '')}>
                <div className="storage__row-main">
                  <div className="storage__row-name">
                    {p.name}
                    {p.status === 'archived' && <span className="storage__tag">已封存</span>}
                    {top.has(p.id) && <span className="storage__tag is-top">最大的前三名</span>}
                  </div>
                  <div className="settings-row__sub">
                    {[
                      `影片 ${formatGb(p.videoBytes)}`,
                      `已刪除（還在 30 天內）${formatGb(p.deletedBytes)}`,
                      `模型 ${formatGb(p.modelBytes)}`,
                      `留言圖片 ${formatGb(p.commentImageBytes)}`,
                      p.otherBytes > 0 ? `其他 ${formatGb(p.otherBytes)}` : '',
                      `${p.videoCount} 版${p.deletedCount > 0 ? `（另外刪掉 ${p.deletedCount} 版）` : ''}`,
                      p.iaBytes > 0 ? `長期存放 ${formatGb(p.iaBytes)}` : '',
                      moving > 0 ? `還有 ${moving} 版在搬到長期存放` : '',
                      p.storageJobs.failed > 0 ? `${p.storageJobs.failed} 版沒搬成功` : '',
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="storage__row-side">
                  <div className="storage__row-total">{formatGb(p.totalBytes)}</div>
                  <div className="settings-row__sub">每月大約 {cost(usd)}</div>
                  {top.has(p.id) && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setWrapUp(p)}>
                      <Icon icon={Film} /> 專案結束清影片
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="sys-status__subtitle"><Icon icon={Copy} /> 重複的檔案</h3>
      <p className="settings-desc">
        同一個專案裡一模一樣的影片（看檔案的頭、中、尾比對）。多的那幾版可以到「影片版本」刪掉，30 天內還救得回來。
        {data.fingerprints.pending > 0 && ` 還有 ${data.fingerprints.pending} 版還沒比對完（排程慢慢算）。`}
      </p>
      {dups.groupCount === 0 ? (
        <p className="sys-status__ok">沒有重複的檔案</p>
      ) : (
        <>
          <p className="settings-row__sub">共 {dups.groupCount} 組，多佔了 <strong>{formatGb(dups.wasteBytes)}</strong></p>
          <ul className="storage__list">
            {dups.groups.map(g => {
              const first = g.versions[0];
              const songs = new Map<string, string[]>();
              for (const v of g.versions) {
                const name = [v.songCode, v.songName].filter(Boolean).join(' ');
                songs.set(name, [...(songs.get(name) ?? []), v.label]);
              }
              return (
                <li key={`${g.projectId}:${first.videoId}`} className="storage__row">
                  <div className="storage__row-main">
                    <div className="storage__row-name">{[...songs].map(([name, labels]) => `${name} ${labels.join('、')}`).join(' / ')}</div>
                    <div className="settings-row__sub">{g.projectName}{g.projectArchived ? '（已封存）' : ''} · 每個 {formatGb(g.sizeBytes)} · 多佔 {formatGb(g.wasteBytes)}</div>
                  </div>
                  <div className="storage__row-side">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => navigate(`/admin/projects/${encodeURIComponent(g.projectId)}`, { state: { openVersionsSongId: g.versions[g.versions.length - 1].songId } })}
                    >
                      <Icon icon={Film} /> 打開影片版本
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="settings-row__sub">
        刪掉的版本留 {data.purge.keepDays} 天後自動清掉檔案
        {data.purge.mode === 'on' ? '' : '（現在先只記錄會清哪些，還沒有真的清）'}
        {data.purge.last ? `；上次檢查 ${formatRelativeTime(data.purge.last.at)}，${data.purge.last.candidates ? `有 ${data.purge.last.candidates} 版到期` : '沒有到期的'}` : ''}。
      </p>

      {wrapUp && (
        <ProjectWrapUpDialog open mode="later" project={wrapUp} onClose={() => setWrapUp(null)} onDone={() => { void load(); }} />
      )}
    </div>
  );
}
