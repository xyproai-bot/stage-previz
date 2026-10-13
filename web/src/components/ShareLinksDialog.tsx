import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { ShareLink, Song } from '../lib/api';
import { toast } from '../lib/toast';
import {
  composeSlug, randomSlugSuffix, slugBaseFromName, slugProblem, slugProblemMessage, splitSlug,
} from '../lib/shareSlug';
import { shareSlugUrl, shareTokenUrl } from '../lib/siteUrl';
import { parseServerTime } from '../lib/serverTime';
import './ShareLinksDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  /** 專案名稱：好讀網址名稱的預設值從這裡來 */
  projectName?: string;
  songs: Song[];
  onClose: () => void;
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

export default function ShareLinksDialog({ open, projectId, projectName, songs, onClose }: Props) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 建立新連結 form
  const [songId, setSongId] = useState<string>('');
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number>(0); // 0 = 永久
  const [creating, setCreating] = useState(false);
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
      });
      setPassword('');
      // 下一條連結換一組隨機碼（名稱留著）
      setCreateDraft(d => ({ ...d, suffix: randomSlugSuffix() }));
      await refresh();
    } catch (e) {
      toast.error('建立連結失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally { setCreating(false); }
  }

  async function handleDelete(token: string) {
    if (!confirm('刪除這個分享連結？\n\n之前發出去的人會立刻失效。')) return;
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
      toast.success(slug ? '好讀網址已更新 ✓' : '已拿掉好讀網址');
      setEditingToken(null);
      await refresh();
    } catch (e) {
      toast.error('存不起來：' + (e instanceof Error ? e.message : String(e)));
    } finally { setSavingSlug(false); }
  }

  function clearSlug(l: ShareLink) {
    if (!confirm('拿掉這條連結的好讀網址？\n\n之前發出去的好讀網址會馬上打不開；下面那串舊式網址照樣能用。')) return;
    void saveSlug(l, null);
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('已複製連結 ✓');
    } catch {
      // fallback：開新分頁讓用戶自己複製
      window.prompt('複製這個連結：', url);
    }
  }

  if (!open) return null;

  const editSlug = draftSlug(editDraft);
  const editProblem = editSlug ? slugProblem(editSlug) : 'empty';

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" style={{ maxWidth: 760 }}>
        <header className="dlg__header">
          <h2>🔗 公開分享連結</h2>
          <button className="dlg__close" onClick={onClose}>×</button>
        </header>
        <div className="dlg__body">
          <p className="share-dlg__hint">
            建立連結後寄給外部人 → 對方不需登入，直接看 read-only 預覽（包含 3D 場景 + cue 切換）
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
            <SlugFields
              draft={createDraft}
              onChange={(d) => { if (d.base !== createDraft.base) createBaseTouched.current = true; setCreateDraft(d); }}
              allowEmpty
            />
            <button className="btn btn--primary btn--sm" onClick={handleCreate} disabled={creating || !!createProblem}>
              {creating ? '建立中…' : '+ 建立分享連結'}
            </button>
          </section>

          {error && <div className="share-dlg__err">{error}</div>}

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
                          <code className="share-link-row__url" title={mainUrl}>{mainUrl}</code>
                          {prettyUrl && (
                            <div className="share-link-row__alt">
                              <span>舊式網址（一直能用）：</span>
                              <code title={tokenUrl}>{tokenUrl}</code>
                              <button className="share-link-row__mini" onClick={() => copyLink(tokenUrl)} title="複製舊式網址">📋</button>
                            </div>
                          )}
                          <div className="share-link-row__meta">
                            {l.songId
                              ? `🎵 ${songs.find(s => s.id === l.songId)?.name || '單首歌'}`
                              : '📁 整個專案'}
                            {l.hasPassword && ' · 🔒 有密碼'}
                            {l.expiresAt && ` · ⏰ ${expired ? '已過期' : `到期 ${new Date(parseServerTime(l.expiresAt)).toLocaleDateString('zh-TW')}`}`}
                            {' · 👁 ' + l.viewCount + ' 次瀏覽'}
                            {l.lastViewedAt && ` · 上次 ${formatRelative(l.lastViewedAt)}`}
                          </div>
                        </div>
                        <div className="share-link-row__actions">
                          <button className="btn btn--ghost btn--sm" onClick={() => copyLink(mainUrl)} title="複製連結">📋</button>
                          <a className="btn btn--ghost btn--sm" href={mainUrl} target="_blank" rel="noreferrer" title="打開看看">↗</a>
                          <button
                            className="btn btn--ghost btn--sm"
                            onClick={() => (editing ? setEditingToken(null) : startEditSlug(l))}
                            title={l.slug ? '改好讀網址' : '加一個好讀網址'}
                          >✏️</button>
                          <button className="btn btn--ghost btn--sm" onClick={() => handleDelete(l.token)} title="刪除">🗑</button>
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
            >🎲</button>
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
