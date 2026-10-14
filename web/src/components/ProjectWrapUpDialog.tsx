// 專案結束清影片（封存的時候問；封存以後也可以在「封存的專案」、系統狀態的空間用量再做）
//   保留全部影片（預設）
//   只留每首歌最後通過的那一版（沒通過過的留最新的一版）：其他版本照一般刪除，30 天內可以救回來
//   改成長期存放：剩下的影片搬到 R2 長期存放（比較便宜，打開時比較慢、會有一點讀取費）
// 後台：cf-worker/storage.mjs（GET / POST /api/projects/:id/wrap-up，只有製作）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import * as api from '../lib/api';
import {
  applyWrapUp, formatGb, formatTwd, getStorageSummary, getWrapUpPreview, infrequentSavingUsd, monthlyCostUsd,
  R2_FREE_GB, type WrapUpKeep, type WrapUpPreview,
} from '../lib/storageApi';
import { toast } from '../lib/toast';
import { useEscapeClose } from '../lib/useEscapeClose';
import './SongVideosDialog.css';
import './ProjectWrapUpDialog.css';

interface Props {
  open: boolean;
  onClose: () => void;
  project: { id: string; name: string };
  /** archive = 封存的時候（按鈕會順便封存）；later = 已經封存 / 從系統狀態來，只清影片 */
  mode: 'archive' | 'later';
  /** 做完了（封存了 / 清了）→ 清單重新讀 */
  onDone: () => void;
}

const GB = 1024 ** 3;

export default function ProjectWrapUpDialog({ open, onClose, project, mode, onDone }: Props) {
  const [preview, setPreview] = useState<WrapUpPreview | null>(null);
  const [accountStandard, setAccountStandard] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keep, setKeep] = useState<WrapUpKeep>('all');
  const [infrequent, setInfrequent] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeClose(open && !busy, onClose);

  useEffect(() => {
    if (!open) return;
    setKeep('all'); setInfrequent(false); setError(null); setPreview(null);
    panelRef.current?.focus();
    let alive = true;
    getWrapUpPreview(project.id).then(p => { if (alive) setPreview(p); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    getStorageSummary().then(s => { if (alive) setAccountStandard(s.account.standardBytes); }).catch(() => { /* 只是少一句提醒 */ });
    return () => { alive = false; };
  }, [open, project.id]);

  const t = preview?.totals;
  const removeCount = keep === 'final' ? (t?.removeCount ?? 0) : 0;
  const moveBytes = t ? (keep === 'final' ? t.keepBytes - t.keepIaBytes : t.videoBytes - t.allIaBytes) : 0;
  const saving = useMemo(() => {
    if (!t) return null;
    const freed = keep === 'final' ? t.removeBytes : 0;
    const std = accountStandard ?? t.videoBytes;
    // 刪掉的 30 天後才省到；長期存放：帳號還在免費額度裡的話是負的（反而要錢）
    const freedUsd = monthlyCostUsd({ standardBytes: freed, iaBytes: 0 });
    const iaUsd = infrequent ? infrequentSavingUsd(moveBytes, std) : 0;
    return { freedUsd, iaUsd };
  }, [t, keep, infrequent, moveBytes, accountStandard]);
  const inFreeTier = accountStandard !== null && accountStandard < R2_FREE_GB * GB;

  if (!open) return null;

  const nothing = keep === 'all' && !infrequent;
  const danger = keep === 'final' && removeCount > 0;
  const actionLabel = (() => {
    const parts: string[] = [];
    if (danger) parts.push(`清掉 ${removeCount} 版`);
    if (infrequent) parts.push('改成長期存放');
    if (mode === 'archive') return parts.length ? `封存並${parts.join('、')}` : '封存';
    return parts.length ? parts.join('並') : '照選的做';
  })();

  async function submit() {
    setBusy(true);
    try {
      let msg = '';
      if (!nothing) {
        const r = await applyWrapUp(project.id, keep, infrequent ? 'infrequent' : 'standard');
        const bits = [];
        if (r.removedCount) bits.push(`清掉 ${r.removedCount} 版（30 天內可以救回來）`);
        if (r.queuedForInfrequent) bits.push(`${r.queuedForInfrequent} 版排進長期存放（背景慢慢搬，播放不受影響）`);
        msg = bits.join('，');
      }
      if (mode === 'archive') await api.archiveProject(project.id);
      toast.success(mode === 'archive' ? `已封存「${project.name}」${msg ? `：${msg}` : ''}` : (msg || '沒有要改的'));
      onDone();
      onClose();
    } catch (e) {
      toast.error((mode === 'archive' ? '封存失敗：' : '沒有成功：') + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="songvid-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={panelRef} className="songvid wrapup" role="dialog" aria-modal="true" aria-labelledby="wrapup-title" tabIndex={-1}
        onKeyDown={(e) => e.stopPropagation()}>
        <header className="songvid__head">
          <div className="songvid__titles">
            <h2 id="wrapup-title">{mode === 'archive' ? <>封存專案 · <span className="songvid__song">{project.name}</span></> : <>專案結束清影片 · <span className="songvid__song">{project.name}</span></>}</h2>
            <p className="songvid__sub">
              {mode === 'archive' ? '封存後不會出現在專案總覽，資料都會留著，之後可以在「封存的專案」還原。' : '不會改專案的其他資料（歌、cue、留言、審片紀錄都留著）。'}
              {' '}專案結束了，可以順便把用不到的影片清掉，省一點空間費。
            </p>
          </div>
          <button type="button" className="songvid__close" onClick={onClose} disabled={busy} title="關閉" aria-label="關閉">
            <Icon icon={X} size="md" />
          </button>
        </header>

        <div className="songvid__body">
          {error && <div className="wrapup__warn" role="alert"><Icon icon={TriangleAlert} /> 讀不到這個專案的影片：{error}</div>}
          {!preview && !error && <div className="wrapup__muted" role="status"><Icon icon={LoaderCircle} spin /> 讀取影片中…</div>}
          {t && (
            <div className="wrapup__muted">這個專案現在有 {t.videoCount} 版影片，共 {formatGb(t.videoBytes)}{t.allIaBytes > 0 ? `（其中 ${formatGb(t.allIaBytes)} 已經是長期存放）` : ''}。</div>
          )}

          <fieldset className="wrapup__group" disabled={busy}>
            <legend>影片要留哪些</legend>
            <label className={'wrapup__opt' + (keep === 'all' ? ' is-on' : '')}>
              <input type="radio" name="wrapup-keep" checked={keep === 'all'} onChange={() => setKeep('all')} />
              <span><strong>保留全部影片</strong><small>什麼都不刪。</small></span>
            </label>
            <label className={'wrapup__opt is-danger' + (keep === 'final' ? ' is-on' : '')}>
              <input type="radio" name="wrapup-keep" checked={keep === 'final'} onChange={() => setKeep('final')} disabled={!t || t.removeCount === 0} />
              <span>
                <strong>只留每首歌最後通過的那一版</strong>
                <small>
                  {t && t.removeCount === 0 ? '每首歌都只有一版，沒有可以清的。' : <>
                    沒有通過過的歌留最新的一版。其他 {t?.removeCount ?? '…'} 版（{t ? formatGb(t.removeBytes) : '…'}）照一般刪除：
                    {preview?.keepDays ?? 30} 天內可以在「影片版本 → 最近刪除」救回來，之後檔案清掉。
                  </>}
                </small>
              </span>
            </label>
            {keep === 'final' && preview && preview.songs.some(s => s.remove.length > 0) && (
              <ul className="wrapup__songs">
                {preview.songs.filter(s => s.remove.length > 0).map(s => (
                  <li key={s.songId}>
                    <span className="wrapup__song">{[s.code, s.name].filter(Boolean).join(' ')}</span>
                    ：留 {s.keep.label}（{s.keep.reason === 'approved' ? '最後通過的' : '最新的'}）· 清掉 {s.remove.map(r => r.label).join('、')}
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <fieldset className="wrapup__group" disabled={busy}>
            <legend>存放方式</legend>
            <label className={'wrapup__opt' + (infrequent ? ' is-on' : '')}>
              <input type="checkbox" checked={infrequent} onChange={(e) => setInfrequent(e.target.checked)} disabled={!t || moveBytes <= 0} />
              <span>
                <strong>改成長期存放（比較便宜，打開時比較慢、會有一點費用）</strong>
                <small>
                  {t && moveBytes <= 0 ? '影片都已經是長期存放了。' : <>
                    把留下來的影片（{formatGb(moveBytes)}）搬到 Cloudflare 的長期存放，背景慢慢搬，搬的時候照樣可以播。
                  </>}
                </small>
              </span>
            </label>
            <div className="wrapup__cost">
              <Icon icon={Info} size="sm" />
              <div>
                標準存放每 GB 每月大約 NT$0.5（整個帳號前 {R2_FREE_GB} GB 免費）；長期存放便宜大約三成，
                但每次打開（播放、下載）每 GB 另外大約 NT$0.3，而且搬過去的檔案至少算 30 天的錢。
                專案之後還原也不會自動搬回標準存放：照樣可以播，只是打開時有讀取費。
              </div>
            </div>
            {infrequent && inFreeTier && (
              <div className="wrapup__warn" role="status">
                <Icon icon={TriangleAlert} size="sm" /> 整個帳號現在只用了 {formatGb(accountStandard ?? 0)}，還在每個月 {R2_FREE_GB} GB 的免費額度裡：
                標準存放現在不用錢，改成長期存放反而每個月要付{saving ? `大約 ${formatTwd(-saving.iaUsd)}` : '一點錢'}。不急的話可以先不要改。
              </div>
            )}
          </fieldset>

          {saving && !nothing && (
            <div className="wrapup__muted">
              估計：
              {keep === 'final' && removeCount > 0 && <>清掉的 {removeCount} 版 30 天後每個月省大約 {formatTwd(saving.freedUsd)}（還沒扣免費額度）。</>}
              {infrequent && (saving.iaUsd >= 0
                ? <>長期存放每個月省大約 {formatTwd(saving.iaUsd)}。</>
                : <>長期存放每個月多大約 {formatTwd(-saving.iaUsd)}。</>)}
              {' '}只是估計，看影片、下載在 Cloudflare 本身不收錢。
            </div>
          )}
        </div>

        <footer className="songvid__foot">
          <span className="songvid__count" />
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className={'btn ' + (danger || mode === 'archive' ? 'btn--danger' : 'btn--primary')}
            onClick={() => void submit()}
            disabled={busy || (mode === 'later' && nothing) || (!preview && !error && mode === 'later')}
          >
            {busy ? <><Icon icon={LoaderCircle} spin /> 處理中…</> : <>{mode === 'archive' && <Icon icon={Archive} />} {actionLabel}</>}
          </button>
        </footer>
      </div>
    </div>
  );
}
