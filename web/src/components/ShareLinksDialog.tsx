import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { ShareLink, Song } from '../lib/api';
import { toast } from '../lib/toast';
import {
  composeSlug, randomSlugSuffix, slugBaseFromName, slugProblem, slugProblemMessage, splitSlug,
} from '../lib/shareSlug';
import { shareSlugUrl, shareTokenUrl } from '../lib/siteUrl';
import { parseServerTime } from '../lib/serverTime';
import { Clock, Copy, Dices, ExternalLink, Eye, Folder, KeyRound, Lock, LockOpen, MessageSquareOff, MessageSquareText, Music, Pencil, ShieldBan, Stamp, Tag, Trash2, X } from 'lucide-react';
import Icon from './Icon';
import { chooseDialog, confirmDialog, promptDialog } from './dialogs';
import './ShareLinksDialog.css';
import { useEscapeClose } from '../lib/useEscapeClose';
import { NEW_LINK_PROTECTION, canSetMemberWatermark, memberWatermarkOn } from '../lib/watermark/policy';
import {
  EDIT_EXPIRY_LABEL, EDIT_PASSWORD_LABEL, EDIT_SONGS_LABEL, NEVER_EXPIRES_LABEL, REMOVE_PASSWORD_LABEL, SAVED_TOAST, SHARE_PASSWORD_MAX,
  expiryChoices, expiryPatch, expiryText, passwordPatch, scopeChoices, scopePatch, scopeText,
} from '../lib/shareLinkEdit';
import {
  LABEL_ON_WATERMARK_NOTE, LEGACY_LINK_NOTE, MEMBER_WATERMARK_DENIED, MEMBER_WATERMARK_HINT, MEMBER_WATERMARK_LABEL,
  NO_DOWNLOAD_HINT, NO_DOWNLOAD_LABEL, PROTECTION_LIMIT_NOTE, WATERMARK_HINT, WATERMARK_LABEL,
} from '../lib/watermark/copy';

interface Props {
  open: boolean;
  projectId: string;
  /** 專案名稱：好讀網址名稱的預設值從這裡來 */
  projectName?: string;
  songs: Song[];
  onClose: () => void;
  /** 專案的設定（成員看片也加浮水印）改了以後通知頁面重新讀 */
  onProjectChanged?: () => void;
}

/** 好讀網址的編輯中狀態：名稱 +（可選）4 個隨機字 */
interface SlugDraft {
  base: string;
  addSuffix: boolean;
  suffix: string;
}

function newDraft(projectName: string | undefined): SlugDraft {
  return { base: slugBaseFromName(projectName || ''), addSuffix: true, suffix: randomSlugSuffix() };
}

/** 編輯中的狀態 → 完整網址名稱；名稱留空 = ''（不要好讀網址） */
function draftSlug(d: SlugDraft): string {
  return d.base.trim() ? composeSlug(d.base, d.addSuffix ? d.suffix : null) : '';
}

/** 打字時就整理：大寫轉小寫、全形轉半形、空白 / 底線變「-」（不去頭尾，免得打到一半的空白被吃掉） */
function tidyTyping(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/[\s_]+/g, '-');
}

export default function ShareLinksDialog({ open, projectId, projectName, songs, onClose, onProjectChanged }: Props) {
  useEscapeClose(open, onClose);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 建立新連結 form
  const [songId, setSongId] = useState<string>('');
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number>(0); // 0 = 永久
  // 0026：連結名稱（團隊看訪客留言時顯示）、允許看的人留言（預設關）
  const [label, setLabel] = useState('');
  const [allowComments, setAllowComments] = useState(false);
  // 0038：浮水印、禁止下載（新連結：浮水印預設關、禁止下載預設開）
  const [watermark, setWatermark] = useState<boolean>(NEW_LINK_PROTECTION.watermark);
  const [noDownload, setNoDownload] = useState<boolean>(NEW_LINK_PROTECTION.noDownload);
  const [creating, setCreating] = useState(false);
  // 專案的「成員看片也加浮水印」（null = 還沒讀到）+ 我在這個專案的角色（只有製作能改）
  const [memberWm, setMemberWm] = useState<boolean | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [savingMemberWm, setSavingMemberWm] = useState(false);
  const [createDraft, setCreateDraft] = useState<SlugDraft>(() => newDraft(projectName));
  // 名稱還沒被改過 → 專案名稱晚一點才拿到時跟著換
  const createBaseTouched = useRef(false);

  // 正在改哪一條連結的好讀網址（一次一條）
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<SlugDraft>(() => newDraft(projectName));
  const [savingSlug, setSavingSlug] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listShareLinks(projectId);
      setLinks(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (open) { setEditingToken(null); refresh(); } }, [open, refresh]);

  // 打開時讀專案的設定（成員看片也加浮水印）；讀不到就不顯示這一段
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    api.getProjectInfo(projectId)
      .then(info => { if (!cancelled) { setMemberWm(memberWatermarkOn(info.project.watermark_members)); setMyRole(info.myRole); } })
      .catch(() => { if (!cancelled) setMemberWm(null); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  useEffect(() => {
    if (createBaseTouched.current) return;
    setCreateDraft(d => ({ ...d, base: slugBaseFromName(projectName || '') }));
  }, [projectName]);

  const createSlug = draftSlug(createDraft);
  const createProblem = createSlug ? slugProblem(createSlug) : null;

  async function handleCreate() {
    if (createProblem) {
      toast.error(slugProblemMessage(createProblem, createSlug));
      return;
    }
    setCreating(true);
    try {
      await api.createShareLink(projectId, {
        songId: songId || undefined,
        password: password || undefined,
        expiresInDays: expiresInDays > 0 ? expiresInDays : undefined,
        slug: createSlug || null,
        label: label.trim() || null,
        allowComments,
        watermark,
        noDownload,
      });
      setPassword('');
      setLabel('');
      setAllowComments(false);
      setWatermark(NEW_LINK_PROTECTION.watermark);
      setNoDownload(NEW_LINK_PROTECTION.noDownload);
      // 下一條連結換一組隨機碼（名稱留著）
      setCreateDraft(d => ({ ...d, suffix: randomSlugSuffix() }));
      await refresh();
    } catch (e) {
      toast.error('建立連結失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally { setCreating(false); }
  }

  async function handleDelete(token: string) {
    if (!(await confirmDialog({
      title: '刪除這個分享連結？',
      message: '已經傳出去的這個連結會馬上打不開。',
      confirmLabel: '刪除',
      destructive: true,
    }))) return;
    try { await api.deleteShareLink(projectId, token); toast.success('已刪除分享連結'); await refresh(); }
    catch (e) { toast.error('刪除失敗：' + (e instanceof Error ? e.message : String(e))); }
  }

  function startEditSlug(l: ShareLink) {
    if (l.slug) {
      const { base, suffix } = splitSlug(l.slug);
      setEditDraft({ base, addSuffix: !!suffix, suffix: suffix ?? randomSlugSuffix() });
    } else {
      setEditDraft(newDraft(projectName));
    }
    setEditingToken(l.token);
  }

  async function saveSlug(l: ShareLink, slug: string | null) {
    if ((l.slug ?? null) === slug) { setEditingToken(null); return; }
    setSavingSlug(true);
    try {
      await api.updateShareLinkSlug(projectId, l.token, slug);
      toast.success(slug ? '好讀網址已更新' : '已拿掉好讀網址');
      setEditingToken(null);
      await refresh();
    } catch (e) {
      toast.error('存不起來：' + (e instanceof Error ? e.message : String(e)));
    } finally { setSavingSlug(false); }
  }

  async function clearSlug(l: ShareLink) {
    if (!(await confirmDialog({
      title: '拿掉這條連結的好讀網址？',
      message: '之前傳出去的好讀網址會馬上打不開；下面那串舊式網址照樣能用。',
      confirmLabel: '拿掉',
      destructive: true,
    }))) return;
    void saveSlug(l, null);
  }

  async function toggleComments(l: ShareLink) {
    const on = !l.allowComments;
    if (on && !(await confirmDialog({
      title: '允許看的人留言？',
      message: '拿到這條連結的人寫一個名字，就能在影片上留言、畫記（不用帳號）。他們只看得到從這條連結留的留言、和你們在底下的回覆；團隊的其他留言看不到。之後可以隨時關掉。',
      confirmLabel: '允許留言',
    }))) return;
    try {
      await api.updateShareLink(projectId, l.token, { allowComments: on });
      toast.success(on ? '這條連結的人可以留言了' : '已關掉這條連結的留言（之前的留言還在）');
      await refresh();
    } catch (e) {
      toast.error('沒有改成：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 改一條連結的「浮水印」或「禁止下載」；關掉比較危險（外流追不到 / 擋不住下載）→ 先問一次，打開不用問 */
  async function toggleProtection(l: ShareLink, key: 'watermark' | 'noDownload') {
    const on = !l[key];
    const name = key === 'watermark' ? WATERMARK_LABEL : NO_DOWNLOAD_LABEL;
    if (!on && !(await confirmDialog({
      title: `關掉這條連結的「${name}」？`,
      message: key === 'watermark'
        ? '關掉之後，拿到這條連結的人看的畫面不會再印名字和時間，外流時就追不到是誰。'
        : '關掉之後，這條連結的影片網址不再有時效，下載按鈕也會回來。',
      confirmLabel: '關掉',
      destructive: true,
    }))) return;
    try {
      await api.updateShareLink(projectId, l.token, { [key]: on });
      toast.success(on ? `已打開「${name}」` : `已關掉「${name}」`);
      await refresh();
    } catch (e) {
      toast.error('沒有改成：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function toggleMemberWatermark() {
    if (memberWm === null || !canSetMemberWatermark(myRole)) return;
    const on = !memberWm;
    setSavingMemberWm(true);
    try {
      await api.updateProject(projectId, { watermarkMembers: on });
      setMemberWm(on);
      toast.success(on ? '團隊成員看片也會加浮水印了' : '已關掉成員看片的浮水印');
      onProjectChanged?.();
    } catch (e) {
      toast.error('沒有改成：' + (e instanceof Error ? e.message : String(e)));
    } finally { setSavingMemberWm(false); }
  }

  async function editLabel(l: ShareLink) {
    const next = await promptDialog({
      title: '連結的名稱',
      message: '給誰看的（例：給經紀人、給主辦）。團隊看得到，訪客留言時會寫「訪客：名字（這個名稱）」；開了浮水印的連結，名稱也會印在對方畫面的浮水印上。',
      label: '名稱',
      defaultValue: l.label || '',
      maxLength: 40,
      confirmLabel: '儲存',
    });
    if (next === null || next === undefined) return;
    try {
      await api.updateShareLink(projectId, l.token, { label: next.trim() || null });
      toast.success(next.trim() ? '名稱改好了' : '已拿掉名稱');
      await refresh();
    } catch (e) {
      toast.error('存不起來：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 建好以後改密碼 / 有效期 / 分享的歌：存好提示「已更新」 */
  async function saveEdit(l: ShareLink, patch: api.ShareLinkPatch) {
    try {
      await api.updateShareLink(projectId, l.token, patch);
      toast.success(SAVED_TOAST);
      await refresh();
    } catch (e) {
      toast.error('沒有改成：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function editPassword(l: ShareLink) {
    const next = await promptDialog({
      title: EDIT_PASSWORD_LABEL,
      message: l.hasPassword
        ? '改好之後，舊密碼馬上不能用；已經用舊密碼打開的人，要重新輸入新密碼才能繼續看。'
        : '這條連結現在沒有密碼。設好之後，打開的人要先輸入密碼。',
      label: '新密碼',
      maxLength: SHARE_PASSWORD_MAX,
      confirmLabel: '儲存',
    });
    const patch = passwordPatch(next);
    if (!patch) return;
    await saveEdit(l, patch);
  }

  async function removePassword(l: ShareLink) {
    if (!(await confirmDialog({
      title: '拿掉這條連結的密碼？',
      message: '拿掉之後，拿到連結的人不用輸入密碼就能打開。',
      confirmLabel: REMOVE_PASSWORD_LABEL,
      destructive: true,
    }))) return;
    await saveEdit(l, { password: null });
  }

  async function editExpiry(l: ShareLink) {
    const picked = await chooseDialog({
      title: EDIT_EXPIRY_LABEL,
      message: `現在：${expiryText(l.expiresAt)}。選一個，從今天重新算起。`,
      choices: expiryChoices(l.expiresAt),
    });
    const patch = expiryPatch(picked);
    if (!patch) return;
    await saveEdit(l, patch);
  }

  async function editSongs(l: ShareLink) {
    const picked = await chooseDialog({
      title: EDIT_SONGS_LABEL,
      message: `現在分享的是：${scopeText(l.songId, songs)}。選好之後，拿到連結的人就只看得到這個範圍。`,
      choices: scopeChoices(songs, l.songId),
      layout: 'list',
    });
    const patch = scopePatch(picked, songs);
    if (!patch) return;
    if ((patch.songId ?? null) === (l.songId ?? null)) return;
    await saveEdit(l, patch);
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('已複製連結');
    } catch {
      // 瀏覽器不讓複製 → 把連結顯示出來讓他自己選起來複製
      void promptDialog({
        title: '複製這個連結',
        message: '瀏覽器不讓我們直接複製，請把下面的連結選起來複製（手機長按）。',
        defaultValue: url,
        readOnly: true,
        confirmLabel: '好',
        cancelLabel: null,
      });
    }
  }

  if (!open) return null;

  const editSlug = draftSlug(editDraft);
  const editProblem = editSlug ? slugProblem(editSlug) : 'empty';

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" style={{ maxWidth: 760 }}>
        <header className="dlg__header">
          <h2>公開分享連結</h2>
          <button className="dlg__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dlg__body">
          <p className="share-dlg__hint">
            建立連結後傳給外部的人，對方不用登入就能看（包含 3D 舞台和 cue 切換；不能改）。勾「允許看的人留言」的連結，對方也可以留言。
          </p>

          {/* Create form */}
          <section className="share-dlg__create">
            <div className="share-dlg__row">
              <label>
                <span>範圍</span>
                <select value={songId} onChange={e => setSongId(e.target.value)}>
                  <option value="">整個專案</option>
                  {songs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>
                <span>密碼（可選）</span>
                <input
                  type="text"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="留空 = 不設密碼"
                  maxLength={60}
                />
              </label>
              <label>
                <span>有效期</span>
                <select value={expiresInDays} onChange={e => setExpiresInDays(parseInt(e.target.value, 10))}>
                  <option value={0}>永久</option>
                  <option value={1}>1 天</option>
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>
            </div>
            <div className="share-dlg__row">
              <label className="share-dlg__label-field">
                <span>名稱（可選）</span>
                <input
                  type="text"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="例：給經紀人"
                  maxLength={40}
                />
                <small className="share-dlg__field-note">{watermark ? LABEL_ON_WATERMARK_NOTE : '只有團隊看得到。'}</small>
              </label>
            </div>
            <SlugFields
              draft={createDraft}
              onChange={(d) => { if (d.base !== createDraft.base) createBaseTouched.current = true; setCreateDraft(d); }}
              allowEmpty
            />
            <label className="share-dlg__allow">
              <input type="checkbox" checked={allowComments} onChange={e => setAllowComments(e.target.checked)} />
              <span>
                <strong>允許看的人留言</strong>
                <small>寫一個名字就能在影片上留言、畫記；只看得到從這條連結留的留言和你們的回覆。你們會收到通知。</small>
              </span>
            </label>
            <label className="share-dlg__allow">
              <input type="checkbox" checked={watermark} onChange={e => setWatermark(e.target.checked)} />
              <span>
                <strong><Icon icon={Stamp} size="xs" /> {WATERMARK_LABEL}</strong>
                <small>{WATERMARK_HINT}</small>
              </span>
            </label>
            <label className="share-dlg__allow">
              <input type="checkbox" checked={noDownload} onChange={e => setNoDownload(e.target.checked)} />
              <span>
                <strong><Icon icon={ShieldBan} size="xs" /> {NO_DOWNLOAD_LABEL}</strong>
                <small>{NO_DOWNLOAD_HINT}</small>
              </span>
            </label>
            <p className="share-dlg__limit">{PROTECTION_LIMIT_NOTE}</p>
            <button className="btn btn--primary btn--sm" onClick={handleCreate} disabled={creating || !!createProblem}>
              {creating ? '建立中…' : '+ 建立分享連結'}
            </button>
          </section>

          {error && <div className="share-dlg__err">{error}</div>}

          {memberWm !== null && (
            <section className="share-dlg__member">
              <label className={'share-dlg__allow' + (canSetMemberWatermark(myRole) ? '' : ' is-disabled')}>
                <input
                  type="checkbox"
                  checked={memberWm}
                  disabled={!canSetMemberWatermark(myRole) || savingMemberWm}
                  onChange={() => { void toggleMemberWatermark(); }}
                />
                <span>
                  <strong><Icon icon={Stamp} size="xs" /> {MEMBER_WATERMARK_LABEL}</strong>
                  <small>{MEMBER_WATERMARK_HINT}{canSetMemberWatermark(myRole) ? '' : ` ${MEMBER_WATERMARK_DENIED}。`}</small>
                </span>
              </label>
              <p className="share-dlg__limit">{LEGACY_LINK_NOTE}</p>
            </section>
          )}

          <section className="share-dlg__list">
            <h3>已建立的連結（{links.length}）</h3>
            {loading ? (
              <div className="share-dlg__empty">載入中…</div>
            ) : links.length === 0 ? (
              <div className="share-dlg__empty">還沒建立任何分享連結</div>
            ) : (
              <ul>
                {links.map(l => {
                  const tokenUrl = shareTokenUrl(l.token);
                  const prettyUrl = l.slug ? shareSlugUrl(l.slug) : null;
                  const mainUrl = prettyUrl || tokenUrl;
                  const expired = parseServerTime(l.expiresAt) < Date.now();
                  const editing = editingToken === l.token;
                  return (
                    <li key={l.token} className={'share-link-row' + (expired ? ' is-expired' : '')}>
                      <div className="share-link-row__top">
                        <div className="share-link-row__main">
                          {l.label && <div className="share-link-row__label"><Icon icon={Tag} size="xs" /> {l.label}</div>}
                          <code className="share-link-row__url" title={mainUrl}>{mainUrl}</code>
                          {prettyUrl && (
                            <div className="share-link-row__alt">
                              <span>舊式網址（一直能用）：</span>
                              <code title={tokenUrl}>{tokenUrl}</code>
                              <button className="share-link-row__mini" onClick={() => copyLink(tokenUrl)} title="複製舊式網址" aria-label="複製舊式網址"><Icon icon={Copy} size="xs" /></button>
                            </div>
                          )}
                          <div className="share-link-row__meta">
                            {l.songId
                              ? <><Icon icon={Music} size="xs" /> {songs.find(s => s.id === l.songId)?.name || '單首歌'}</>
                              : <><Icon icon={Folder} size="xs" /> 整個專案</>}
                            {l.hasPassword && <> · <Icon icon={Lock} size="xs" /> 有密碼</>}
                            {l.expiresAt
                              ? <> · <Icon icon={Clock} size="xs" /> {expired ? '已過期' : `到期 ${new Date(parseServerTime(l.expiresAt)).toLocaleDateString('zh-TW')}`}</>
                              : <> · <Icon icon={Clock} size="xs" /> {NEVER_EXPIRES_LABEL}</>}
                            <> · <Icon icon={Eye} size="xs" /> {l.viewCount} 次瀏覽</>
                            {l.allowComments && <> · <span className="share-link-row__comments"><Icon icon={MessageSquareText} size="xs" /> 可以留言{l.guestCommentCount ? `（${l.guestCommentCount} 則）` : ''}</span></>}
                            {!l.allowComments && !!l.guestCommentCount && <> · <Icon icon={MessageSquareOff} size="xs" /> 留言已關（之前 {l.guestCommentCount} 則）</>}
                            {l.lastViewedAt && ` · 上次 ${formatRelative(l.lastViewedAt)}`}
                          </div>
                          <div className="share-link-row__protect">
                            <span className={'share-link-row__flag' + (l.watermark ? ' is-on' : '')}><Icon icon={Stamp} size="xs" /> {l.watermark ? '有浮水印' : '沒有浮水印'}</span>
                            <span className={'share-link-row__flag' + (l.noDownload ? ' is-on' : '')}><Icon icon={ShieldBan} size="xs" /> {l.noDownload ? '禁止下載' : '可以下載'}</span>
                            {l.shortId && <span className="share-link-row__code" title="浮水印上印的連結編號：外流的畫面上看到這組，就是這一條連結">編號 {l.shortId}</span>}
                          </div>
                          <div className="share-link-row__settings">
                            <button type="button" className="share-link-row__setting" onClick={() => void editPassword(l)}>
                              <Icon icon={KeyRound} size="xs" /> {EDIT_PASSWORD_LABEL}
                            </button>
                            {l.hasPassword && (
                              <button type="button" className="share-link-row__setting" onClick={() => void removePassword(l)}>
                                <Icon icon={LockOpen} size="xs" /> {REMOVE_PASSWORD_LABEL}
                              </button>
                            )}
                            <button type="button" className="share-link-row__setting" onClick={() => void editExpiry(l)}>
                              <Icon icon={Clock} size="xs" /> {EDIT_EXPIRY_LABEL}
                            </button>
                            <button type="button" className="share-link-row__setting" onClick={() => void editSongs(l)}>
                              <Icon icon={Music} size="xs" /> {EDIT_SONGS_LABEL}
                            </button>
                          </div>
                        </div>
                        <div className="share-link-row__actions">
                          <button className="btn btn--ghost btn--sm" onClick={() => copyLink(mainUrl)} title="複製連結" aria-label="複製連結"><Icon icon={Copy} /></button>
                          <a className="btn btn--ghost btn--sm" href={mainUrl} target="_blank" rel="noreferrer" title="打開看看" aria-label="打開看看"><Icon icon={ExternalLink} /></a>
                          <button
                            className="btn btn--ghost btn--sm"
                            onClick={() => (editing ? setEditingToken(null) : startEditSlug(l))}
                            title={l.slug ? '改好讀網址' : '加一個好讀網址'}
                            aria-label={l.slug ? '改好讀網址' : '加一個好讀網址'}
                          ><Icon icon={Pencil} /></button>
                          <button
                            className={'btn btn--ghost btn--sm' + (l.allowComments ? ' is-on' : '')}
                            onClick={() => toggleComments(l)}
                            title={l.allowComments ? '關掉「允許看的人留言」' : '允許看的人留言'}
                            aria-label={l.allowComments ? '關掉「允許看的人留言」' : '允許看的人留言'}
                            aria-pressed={!!l.allowComments}
                          ><Icon icon={l.allowComments ? MessageSquareText : MessageSquareOff} /></button>
                          <button
                            className={'btn btn--ghost btn--sm' + (l.watermark ? ' is-on' : '')}
                            onClick={() => toggleProtection(l, 'watermark')}
                            title={l.watermark ? '關掉浮水印' : '打開浮水印'}
                            aria-label={l.watermark ? '關掉浮水印' : '打開浮水印'}
                            aria-pressed={!!l.watermark}
                          ><Icon icon={Stamp} /></button>
                          <button
                            className={'btn btn--ghost btn--sm' + (l.noDownload ? ' is-on' : '')}
                            onClick={() => toggleProtection(l, 'noDownload')}
                            title={l.noDownload ? '關掉禁止下載' : '打開禁止下載'}
                            aria-label={l.noDownload ? '關掉禁止下載' : '打開禁止下載'}
                            aria-pressed={!!l.noDownload}
                          ><Icon icon={ShieldBan} /></button>
                          <button className="btn btn--ghost btn--sm" onClick={() => editLabel(l)} title="改連結的名稱" aria-label="改連結的名稱"><Icon icon={Tag} /></button>
                          <button className="btn btn--ghost btn--sm" onClick={() => handleDelete(l.token)} title="刪除這條連結" aria-label="刪除這條連結"><Icon icon={Trash2} /></button>
                        </div>
                      </div>
                      {editing && (
                        <div className="share-link-row__edit">
                          <SlugFields draft={editDraft} onChange={setEditDraft} />
                          {l.slug && (
                            <p className="share-slug__note">
                              改了之後，舊的好讀網址 <code>/s/{l.slug}</code> 會馬上打不開（舊式網址照樣能用）。
                            </p>
                          )}
                          <div className="share-link-row__edit-actions">
                            <button
                              className="btn btn--primary btn--sm"
                              onClick={() => saveSlug(l, editSlug)}
                              disabled={savingSlug || !!editProblem}
                            >{savingSlug ? '儲存中…' : '儲存'}</button>
                            <button className="btn btn--ghost btn--sm" onClick={() => setEditingToken(null)} disabled={savingSlug}>取消</button>
                            {l.slug && (
                              <button className="btn btn--ghost btn--sm share-link-row__danger" onClick={() => clearSlug(l)} disabled={savingSlug}>
                                拿掉好讀網址
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** 好讀網址名稱 + 隨機碼勾選 + 預覽 / 哪裡不對（建立和修改共用） */
function SlugFields({ draft, onChange, allowEmpty = false }: {
  draft: SlugDraft;
  onChange: (d: SlugDraft) => void;
  /** 名稱可以留空（= 不要好讀網址）；修改時不行（要拿掉請按「拿掉好讀網址」） */
  allowEmpty?: boolean;
}) {
  const slug = draftSlug(draft);
  const problem = slug ? slugProblem(slug) : null;
  return (
    <div className="share-slug">
      <label className="share-slug__field">
        <span>好讀網址名稱</span>
        <div className="share-slug__input">
          <span className="share-slug__affix">/s/</span>
          <input
            type="text"
            value={draft.base}
            onChange={e => onChange({ ...draft, base: tidyTyping(e.target.value) })}
            placeholder={allowEmpty ? '例：jinma2026（留空 = 不要）' : '例：jinma2026'}
            maxLength={60}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
          {draft.addSuffix && <span className="share-slug__affix share-slug__affix--suffix">-{draft.suffix}</span>}
          {draft.addSuffix && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onChange({ ...draft, suffix: randomSlugSuffix() })}
              title="換一組隨機碼"
              aria-label="換一組隨機碼"
            ><Icon icon={Dices} /></button>
          )}
        </div>
      </label>
      <label className="share-slug__check">
        <input
          type="checkbox"
          checked={draft.addSuffix}
          onChange={e => onChange({ ...draft, addSuffix: e.target.checked })}
        />
        加上隨機碼（建議：避免別人猜到網址）
      </label>
      {!slug ? (
        allowEmpty
          ? <div className="share-slug__hint">留空 = 不要好讀網址，只用一長串的舊式網址</div>
          : <div className="share-slug__err">請輸入網址名稱</div>
      ) : problem ? (
        <div className="share-slug__err">{slugProblemMessage(problem, slug)}</div>
      ) : (
        <div className="share-slug__preview">
          網址會是：<code>{shareSlugUrl(slug)}</code>
          {!draft.addSuffix && <span className="share-slug__warn">（沒有隨機碼：知道名稱的人就猜得到）</span>}
        </div>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(parseServerTime(iso));
    if (Number.isNaN(d.getTime())) return iso;
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '剛剛';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
  } catch { return iso; }
}
