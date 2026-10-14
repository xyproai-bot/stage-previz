import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../lib/api';
import type { DriveAccount, DriveFile, DriveSyncLogEntry, Song } from '../lib/api';
import { toast } from '../lib/toast';
import { formatRelativeTime } from '../lib/serverTime';
import {
  CircleCheck, CircleQuestionMark, ExternalLink, FileText, Film, Image, Lock, Music, RefreshCw, Save, Settings2, TriangleAlert, X,
  type LucideIcon,
} from 'lucide-react';
import Icon from './Icon';
import { DRIVE_MATCH_RULE } from '../lib/songCode';
import './DriveSettingsDialog.css';
import { useEscapeClose } from '../lib/useEscapeClose';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  songs: Song[];
  /** 從 worker 抓回來的當前 project meta — 含 drive_folder_id / drive_oauth_token_id */
  initialFolderId: string;
  initialAccountId: string;
  onChanged: () => void;
}

export default function DriveSettingsDialog({
  open, onClose, projectId, songs,
  initialFolderId, initialAccountId, onChanged,
}: Props) {
  useEscapeClose(open, onClose);
  const [accounts, setAccounts] = useState<DriveAccount[] | null>(null);
  const [accountsConfigured, setAccountsConfigured] = useState(true);
  const [accountsErr, setAccountsErr] = useState<string | null>(null);

  const [accountId, setAccountId] = useState<string>(initialAccountId);
  const [folderInput, setFolderInput] = useState<string>(initialFolderId);

  const [savingSettings, setSavingSettings] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ filesFound: number; classified: number; unclassified: number; durationMs: number } | null>(null);

  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [filesErr, setFilesErr] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<DriveSyncLogEntry[]>([]);

  // ── Load on open ──
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.listDriveAccounts().then(d => {
      if (cancelled) return;
      setAccounts(d.accounts);
      setAccountsConfigured(d.configured);
    }).catch(e => { if (!cancelled) setAccountsErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [open]);

  const refreshFiles = useCallback(async () => {
    try {
      const list = await api.listDriveProjectFiles(projectId);
      setFiles(list);
    } catch (e) { setFilesErr(e instanceof Error ? e.message : String(e)); }
  }, [projectId]);

  const refreshSyncLog = useCallback(async () => {
    try {
      const list = await api.listDriveSyncLog(projectId);
      setSyncLog(list);
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setAccountId(initialAccountId);
    setFolderInput(initialFolderId);
    refreshFiles();
    refreshSyncLog();
  }, [open, initialAccountId, initialFolderId, refreshFiles, refreshSyncLog]);

  // 接受多種輸入：folder ID / Drive URL / shareable URL
  const folderId = useMemo(() => extractFolderId(folderInput), [folderInput]);

  async function handleSaveSettings() {
    setSavingSettings(true);
    try {
      await api.updateProjectDriveSettings(projectId, {
        drive_folder_id: folderId || null,
        drive_oauth_token_id: accountId || null,
      });
      onChanged();
    } catch (e) {
      toast.error('存設定失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleSync() {
    if (!folderId || !accountId) {
      toast.warn('請先選 Google 帳號 + 設定 Drive 資料夾');
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    try {
      // 設定還沒存就先存
      await api.updateProjectDriveSettings(projectId, {
        drive_folder_id: folderId,
        drive_oauth_token_id: accountId,
      });
      const r = await api.syncDriveProject(projectId);
      setSyncResult(r);
      await refreshFiles();
      await refreshSyncLog();
      onChanged();
    } catch (e) {
      toast.error('同步失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSyncing(false);
    }
  }

  async function handleAssign(file: DriveFile, songId: string | null) {
    try {
      await api.assignDriveFile(projectId, file.id, songId);
      await refreshFiles();
    } catch (e) { toast.error('歸類失敗：' + (e instanceof Error ? e.message : String(e))); }
  }

  if (!open) return null;

  // 防禦：HMR 重載期間 hook slot 重排，state 變數偶爾會 undefined
  const sl = syncLog || [];
  const lastSync = sl.length > 0 ? sl[0] : null;
  const filesArr: DriveFile[] | null = files === undefined ? null : files;
  const accountsArr: DriveAccount[] | null = accounts === undefined ? null : accounts;
  const songsArr: Song[] = songs || [];

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg drive-dlg">
        <header className="dlg__header">
          <h2>Drive 來源設定</h2>
          <button className="dlg__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>

        <div className="dlg__body">
          {!accountsConfigured && (
            <div className="drive-dlg__warn">
              <Icon icon={TriangleAlert} /> 平台還沒設定 Google 登入用的金鑰（OAuth）。請先到 Cloudflare Workers 設定，才能連接 Drive 帳號。
            </div>
          )}

          <section>
            <label className="drive-dlg__label">
              <span>Google 帳號</span>
              {accountsConfigured && (
                <Link to="/admin/drive-sources" className="link-btn" target="_blank">+ 連接新帳號 <Icon icon={ExternalLink} size="xs" /></Link>
              )}
            </label>
            {accountsErr && <div className="drive-dlg__err">{accountsErr}</div>}
            {accountsArr === null ? (
              <div className="drive-dlg__hint">載入中…</div>
            ) : accountsArr.length === 0 ? (
              <div className="drive-dlg__hint">
                還沒連接任何 Google 帳號。請先到「<Link to="/admin/drive-sources">Drive 來源</Link>」頁連接。
              </div>
            ) : (
              <select
                className="drive-dlg__select"
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
              >
                <option value="">— 沒選 —</option>
                {accountsArr.map(a => (
                  <option key={a.id} value={a.id}>{a.name || a.email} ({a.email})</option>
                ))}
              </select>
            )}
          </section>

          <section>
            <label className="drive-dlg__label">
              <span>Drive 資料夾</span>
            </label>
            <input
              type="text"
              className="drive-dlg__input"
              value={folderInput}
              onChange={e => setFolderInput(e.target.value)}
              placeholder="貼上 Drive 資料夾連結，或直接貼資料夾 ID"
            />
            {folderInput && !folderId && (
              <div className="drive-dlg__err">看不懂這個資料夾連結，請確認是 Drive 資料夾的連結或資料夾 ID</div>
            )}
            {folderId && (
              <div className="drive-dlg__hint">解析到：<code>{folderId}</code></div>
            )}
          </section>

          <section>
            <label className="drive-dlg__label">
              <span>檔案怎麼對到歌</span>
            </label>
            <div className="drive-dlg__rule">{DRIVE_MATCH_RULE}</div>
            {songsArr.some(s => s.code) && (
              <div className="drive-dlg__hint">
                這個專案的歌曲代號：{songsArr.filter(s => s.code).slice(0, 8).map(s => `${s.code} ${s.name}`).join('、')}
                {songsArr.filter(s => s.code).length > 8 ? ' …' : ''}（在歌單上點代號可以改）
              </div>
            )}
            <div className="drive-dlg__hint">只收影片檔。對不到的檔案會放在下面的「未分類」，可以手動選是哪首歌。新的或改過的影片會自動變成那首歌的下一個版本（V1、V2…）。</div>
          </section>

          <div className="drive-dlg__actions">
            <button className="btn" onClick={handleSaveSettings} disabled={savingSettings}>
              <Icon icon={Save} /> 存設定
            </button>
            <button
              className="btn btn--primary"
              onClick={handleSync}
              disabled={syncing || !folderId || !accountId}
            >
              {syncing ? '同步中…' : <><Icon icon={RefreshCw} /> 立即同步</>}
            </button>
            {lastSync && (
              <span className="muted small drive-dlg__last-sync">
                上次同步：{formatRelativeTime(lastSync.ranAt)}
                （{lastSync.filesClassified} 已分類 / {lastSync.filesUnclassified} 未分類）
              </span>
            )}
          </div>

          {syncResult && (
            <div className="drive-dlg__sync-result">
              <Icon icon={CircleCheck} /> 同步完成：找到 {syncResult.filesFound} 個檔案，
              已分類 <strong>{syncResult.classified}</strong>，
              未分類 <strong>{syncResult.unclassified}</strong>，
              耗時 {syncResult.durationMs}ms
            </div>
          )}

          <section className="drive-dlg__files">
            <h3>同步到的檔案 ({filesArr?.length ?? 0})</h3>
            {filesErr && <div className="drive-dlg__err">{filesErr}</div>}
            {filesArr === null ? (
              <div className="drive-dlg__hint">載入中…</div>
            ) : filesArr.length === 0 ? (
              <div className="drive-dlg__hint">還沒同步過，或資料夾是空的</div>
            ) : (
              <div className="drive-files">
                <div className="drive-files__group">
                  <div className="drive-files__group-title">
                    <Icon icon={CircleQuestionMark} /> 未分類（{filesArr.filter(f => !f.songId).length}）
                  </div>
                  {filesArr.filter(f => !f.songId).length === 0 ? (
                    <div className="muted small">— 全部已分類 —</div>
                  ) : filesArr.filter(f => !f.songId).map(f => (
                    <DriveFileRow key={f.id} file={f} songs={songsArr} onAssign={handleAssign} />
                  ))}
                </div>

                {songsArr.map(s => {
                  const songFiles = filesArr.filter(f => f.songId === s.id);
                  if (songFiles.length === 0) return null;
                  return (
                    <div key={s.id} className="drive-files__group">
                      <div className="drive-files__group-title">
                        <Icon icon={Music} /> {s.code ? `${s.code} ` : ''}{s.name}（{songFiles.length}）
                      </div>
                      {songFiles.map(f => (
                        <DriveFileRow key={f.id} file={f} songs={songsArr} onAssign={handleAssign} />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function DriveFileRow({ file, songs, onAssign }: {
  file: DriveFile;
  songs: Song[];
  onAssign: (file: DriveFile, songId: string | null) => void;
}) {
  return (
    <div className="drive-file">
      <div className="drive-file__icon"><Icon icon={iconFor(file.mimeType)} size="lg" /></div>
      <div className="drive-file__info">
        <div className="drive-file__name">{file.filename}</div>
        <div className="drive-file__meta">
          {file.mimeType && <span>{shortMime(file.mimeType)}</span>}
          {file.sizeBytes && <span>{formatSize(file.sizeBytes)}</span>}
          {file.modifiedTime && <span>{formatRelativeTime(file.modifiedTime)}</span>}
          <span className={'drive-file__badge drive-file__badge--' + file.classifiedBy}>
            {file.classifiedBy === 'manual' ? <><Icon icon={Lock} size="xs" /> 手動</> : <><Icon icon={Settings2} size="xs" /> 檔名代號</>}
          </span>
        </div>
      </div>
      <select
        className="drive-file__select"
        value={file.songId || ''}
        onChange={e => onAssign(file, e.target.value || null)}
        title="手動改這個檔案屬於哪首歌"
      >
        <option value="">未分類</option>
        {songs.map(s => (
          <option key={s.id} value={s.id}>{s.code ? `${s.code} ` : ''}{s.name}</option>
        ))}
      </select>
    </div>
  );
}

function extractFolderId(input: string): string {
  if (!input) return '';
  // 1. drive.google.com/drive/folders/<id>
  const m1 = input.match(/\/folders\/([a-zA-Z0-9_-]{20,})/);
  if (m1) return m1[1];
  // 2. drive.google.com/drive/u/0/folders/<id>
  const m2 = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  // 3. ?id=<id>
  const m3 = input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m3) return m3[1];
  // 4. 直接是 ID
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input.trim())) return input.trim();
  return '';
}

function shortMime(m: string): string {
  if (m.startsWith('video/')) return '影片';
  if (m.startsWith('image/')) return '圖片';
  if (m === 'application/vnd.google-apps.folder') return '資料夾';
  return m;
}

function iconFor(mime: string | null): LucideIcon {
  if (!mime) return FileText;
  if (mime.startsWith('video/')) return Film;
  if (mime.startsWith('image/')) return Image;
  if (mime.startsWith('audio/')) return Music;
  return FileText;
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
