import { useEffect, useMemo, useState } from 'react';
import { LayoutPanelLeft, LoaderCircle, Plus, Save, Scissors, Trash2, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import { confirmDialog, toast } from './dialogs';
import {
  createLedScreen, createLedTemplate, deleteLedScreen, deleteLedTemplate, updateLedTemplate,
  type LedTemplate, type LedTemplateList,
} from '../lib/ledTemplateApi';
import {
  buildScreenList, checkPlacements, defaultDestSize, formatPct, normalizeTemplateInput, placementsFromInputs, ROTATIONS, screenSizeLabel,
  type LedTemplatePlan, type PlacementInput, type Rotation, type ScreenDef, type SrcSpan,
} from '../lib/ledTemplate';
import './LedTemplatesDialog.css';

/**
 * 「LED 版型」（第 1a 階段：數字表單；拖拉編輯器之後再做）
 *   版型 = 只挑幾塊螢幕、排進一張比較小的畫布；動畫師只要輸出這張，3D 畫面會把它貼回對的螢幕，沒挑到的螢幕是黑的。
 *   「全部」是現在的整張 LED 畫布（每塊螢幕的真實點數都從它來），不能改。
 * 說明：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md
 */

export interface LedObjectInfo { id: string; name: string; order: number }

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  list: LedTemplateList | null;
  ledObjects: readonly LedObjectInfo[];
  /** 3D 畫面算出來的每個 LED 物件在整張畫布上的範圍；沒有（模型還沒載好）= null → 每塊當整張畫布 */
  getSpans: () => Record<string, SrcSpan> | null;
  /** 存好 / 刪掉以後，父層重新讀版型清單 */
  onChanged: () => Promise<unknown>;
}

interface RowDraft { on: boolean; x: string; y: string; w: string; h: string; rotate: Rotation; flipH: boolean; flipV: boolean }
interface Draft { id: string | null; name: string; width: string; height: string; scale: string; rows: Record<string, RowDraft> }

const WHOLE: SrcSpan = { us: 0, ul: 1, vs: 0, vl: 1 };
const SCALE_CHOICES = [100, 50, 25];
const NEW = '__new__';

const emptyRow = (): RowDraft => ({ on: false, x: '', y: '', w: '', h: '', rotate: 0, flipH: false, flipV: false });

function draftFromTemplate(t: LedTemplate): Draft {
  const rows: Record<string, RowDraft> = {};
  for (const p of t.screens) {
    rows[p.key] = { on: true, x: String(p.dest.x), y: String(p.dest.y), w: String(p.dest.w), h: String(p.dest.h), rotate: p.rotate, flipH: p.flipH, flipV: p.flipV };
  }
  return { id: t.id, name: t.name, width: String(t.canvas.width), height: String(t.canvas.height), scale: String(t.scalePct), rows };
}

function nextName(list: LedTemplateList | null): string {
  const names = new Set((list?.templates ?? []).map(t => t.name));
  for (let i = 1; i < 100; i++) if (!names.has(`版型 ${i}`)) return `版型 ${i}`;
  return '新版型';
}

const toInt = (s: string) => (/^\s*-?\d+\s*$/.test(s) ? Number(s) : NaN);

/** 表單 → 後台要的放法（只收打勾的）；有格子不是整數 → 錯誤說明 */
export function rowsToInputs(rows: Record<string, RowDraft>, screens: readonly ScreenDef[]): { inputs: PlacementInput[]; error: string | null } {
  const inputs: PlacementInput[] = [];
  for (const s of screens) {
    const r = rows[s.key];
    if (!r?.on) continue;
    const x = toInt(r.x), y = toInt(r.y), w = toInt(r.w), h = toInt(r.h);
    if ([x, y, w, h].some(n => Number.isNaN(n)) || w < 1 || h < 1) {
      return { inputs, error: `「${s.name}」的位置和大小要填整數（寬、高至少 1）` };
    }
    inputs.push({ key: s.key, dest: { x, y, w, h }, rotate: r.rotate, flipH: r.flipH, flipV: r.flipV });
  }
  return { inputs, error: null };
}

export default function LedTemplatesDialog({ open, projectId, onClose, list, ledObjects, getSpans, onChanged }: Props) {
  const [selected, setSelected] = useState<string>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [spans, setSpans] = useState<Record<string, SrcSpan>>({});
  const [splitObj, setSplitObj] = useState('');
  const [splitName, setSplitName] = useState('');
  const [splitRect, setSplitRect] = useState({ x: '', y: '', w: '', h: '' });

  const fullCanvas = list?.fullCanvas ?? null;
  const customs = useMemo(() => (list?.templates ?? []).filter(t => t.kind === 'custom'), [list]);
  const full = list?.templates.find(t => t.kind === 'full') ?? null;

  // 打開時：向 3D 畫面要每個 LED 物件的範圍、選第一個版型
  useEffect(() => {
    if (!open) return;
    setSpans(getSpans() ?? {});
    setSplitObj(ledObjects[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const screens = useMemo<ScreenDef[]>(() => {
    if (!fullCanvas) return [];
    return buildScreenList(
      ledObjects.map(o => ({ objectId: o.id, name: o.name, order: o.order, src: spans[o.id] ?? WHOLE })),
      list?.screens ?? [], fullCanvas,
    );
  }, [ledObjects, spans, list, fullCanvas]);

  // 選的版型變了 / 清單重讀 → 重新帶入表單（有沒存的修改時不蓋掉）
  useEffect(() => {
    if (!open || dirty) return;
    if (selected === NEW) return;
    const t = customs.find(x => x.id === selected);
    if (t) { setDraft(draftFromTemplate(t)); return; }
    if (customs.length > 0) { setSelected(customs[0].id); return; }
    setDraft(null);
    setSelected('');
  }, [open, selected, customs, dirty]);

  // Esc 關掉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) void tryClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy, dirty]);

  async function tryClose() {
    if (dirty && !(await confirmDialog({ title: '還沒存的修改要丟掉嗎？', message: '這個版型改的地方還沒按「儲存」。', confirmLabel: '丟掉', destructive: true }))) return;
    setDirty(false);
    onClose();
  }

  async function pick(id: string) {
    if (id === selected) return;
    if (dirty && !(await confirmDialog({ title: '還沒存的修改要丟掉嗎？', message: '這個版型改的地方還沒按「儲存」。', confirmLabel: '丟掉', destructive: true }))) return;
    setDirty(false);
    setSelected(id);
    if (id === NEW) startNew();
  }

  function startNew() {
    const canvas = fullCanvas ?? { width: 1920, height: 1080 };
    setDraft({ id: null, name: nextName(list), width: String(canvas.width), height: String(canvas.height), scale: '100', rows: {} });
    setSelected(NEW);
    setDirty(false);
  }

  function patch(p: Partial<Draft>) { setDraft(d => (d ? { ...d, ...p } : d)); setDirty(true); }
  function patchRow(key: string, p: Partial<RowDraft>) {
    setDraft(d => (d ? { ...d, rows: { ...d.rows, [key]: { ...(d.rows[key] ?? emptyRow()), ...p } } } : d));
    setDirty(true);
  }

  const scaleNum = draft ? Number(draft.scale) : 100;

  /** 打勾：沒填過位置就照比例填預設大小，放在已經放的螢幕下面 */
  function toggleScreen(s: ScreenDef, on: boolean) {
    if (!draft) return;
    const row = draft.rows[s.key] ?? emptyRow();
    if (!on) { patchRow(s.key, { on: false }); return; }
    if (row.w && row.h) { patchRow(s.key, { on: true }); return; }
    const size = defaultDestSize({ w: s.nativeW, h: s.nativeH }, Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : 100, row.rotate);
    let bottom = 0;
    for (const o of screens) {
      const r = draft.rows[o.key];
      if (o.key !== s.key && r?.on) bottom = Math.max(bottom, (toInt(r.y) || 0) + (toInt(r.h) || 0));
    }
    patchRow(s.key, { on: true, x: '0', y: String(bottom), w: String(size.w), h: String(size.h) });
  }

  /** 旋轉 90 / 270 度時，寬高對調（已經填了大小的才換） */
  function changeRotation(s: ScreenDef, rotate: Rotation) {
    if (!draft) return;
    const row = draft.rows[s.key] ?? emptyRow();
    const swap = (row.rotate === 90 || row.rotate === 270) !== (rotate === 90 || rotate === 270);
    patchRow(s.key, swap && row.w && row.h ? { rotate, w: row.h, h: row.w } : { rotate });
  }

  /** 畫布剛好包住打勾的螢幕 */
  function fitCanvas() {
    if (!draft) return;
    const { inputs, error } = rowsToInputs(draft.rows, screens);
    if (error || inputs.length === 0) { toast.warn(error ?? '先打勾要放進版型的螢幕'); return; }
    patch({
      width: String(Math.max(16, ...inputs.map(i => i.dest.x + i.dest.w))),
      height: String(Math.max(16, ...inputs.map(i => i.dest.y + i.dest.h))),
    });
  }

  const planForCheck = useMemo<LedTemplatePlan | null>(() => {
    if (!draft) return null;
    const { inputs, error } = rowsToInputs(draft.rows, screens);
    const w = toInt(draft.width), h = toInt(draft.height);
    if (error || Number.isNaN(w) || Number.isNaN(h) || !(scaleNum > 0)) return null;
    return { v: 1, id: draft.id, name: draft.name, canvas: { width: w, height: h }, scalePct: scaleNum, screens: placementsFromInputs(inputs, list?.screens ?? []) };
  }, [draft, screens, scaleNum, list]);
  const issues = useMemo(() => (planForCheck ? checkPlacements(planForCheck, screens) : []), [planForCheck, screens]);

  async function save() {
    if (!draft) return;
    const { inputs, error } = rowsToInputs(draft.rows, screens);
    if (error) { toast.error(error); return; }
    const parsed = normalizeTemplateInput({
      name: draft.name, canvas: { width: toInt(draft.width), height: toInt(draft.height) }, scalePct: scaleNum, screens: inputs,
    }, { partial: false });
    if (!parsed.ok) { toast.error(parsed.error); return; }
    const body = { name: parsed.value.name!, canvas: parsed.value.canvas!, scalePct: parsed.value.scalePct!, screens: parsed.value.screens! };
    setBusy(true);
    try {
      if (draft.id) await updateLedTemplate(projectId, draft.id, body);
      else await createLedTemplate(projectId, body);
      setDirty(false);
      const next = (await onChanged()) as LedTemplateList | null | undefined;
      toast.success(`版型「${body.name}」存好了`);
      if (!draft.id) setSelected(next?.templates.find(t => t.kind === 'custom' && t.name === body.name)?.id ?? '');   // 新增的：選到剛存的那個
    } catch (e) {
      toast.error('沒有存好：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft?.id) { setDirty(false); setSelected(''); setDraft(null); return; }
    if (!(await confirmDialog({
      title: `刪除版型「${draft.name}」？`,
      message: '已經交的影片版本會記住當時的排法，不受影響。還有歌在用這個版型的話要先改成別的。',
      confirmLabel: '刪除', destructive: true,
    }))) return;
    setBusy(true);
    try {
      await deleteLedTemplate(projectId, draft.id);
      setDirty(false);
      setSelected('');
      await onChanged();
      toast.success('版型刪掉了');
    } catch (e) {
      toast.error('沒有刪掉：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function addSplit() {
    if (!fullCanvas || !splitObj) return;
    const x = toInt(splitRect.x), y = toInt(splitRect.y), w = toInt(splitRect.w), h = toInt(splitRect.h);
    if ([x, y, w, h].some(Number.isNaN) || w < 1 || h < 1) { toast.error('範圍要填整數（單位：整張畫布的像素，寬、高至少 1）'); return; }
    setBusy(true);
    try {
      await createLedScreen(projectId, {
        objectId: splitObj, name: splitName.trim() || '螢幕',
        uv: [x / fullCanvas.width, y / fullCanvas.height, Math.min(1, (x + w) / fullCanvas.width), Math.min(1, (y + h) / fullCanvas.height)],
      });
      setSplitName(''); setSplitRect({ x: '', y: '', w: '', h: '' });
      await onChanged();
    } catch (e) {
      toast.error('沒有切開：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function removeSplit(id: string, name: string) {
    if (!(await confirmDialog({ title: `刪掉切開的螢幕「${name}」？`, message: '版型裡放著它的那一格也會一起拿掉；已經交的影片版本不受影響。', confirmLabel: '刪掉', destructive: true }))) return;
    setBusy(true);
    try { await deleteLedScreen(projectId, id); await onChanged(); } catch (e) { toast.error('沒有刪掉：' + (e instanceof Error ? e.message : String(e))); } finally { setBusy(false); }
  }

  const sizeOf = (s: ScreenDef, r: RowDraft | undefined) => (r?.on && r.w && r.h
    ? screenSizeLabel(s, { dest: { x: 0, y: 0, w: toInt(r.w) || 0, h: toInt(r.h) || 0 } })
    : `實際 ${s.nativeW}×${s.nativeH}`);
  const objName = (id: string) => ledObjects.find(o => o.id === id)?.name ?? id;

  // 所有 hook 都在上面；沒打開就什麼都不畫
  if (!open) return null;

  return (
    <div className="ledtpl-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) void tryClose(); }}>
      <div className="ledtpl" role="dialog" aria-modal="true" aria-labelledby="ledtpl-title">
        <header className="ledtpl__head">
          <div>
            <h2 id="ledtpl-title"><Icon icon={LayoutPanelLeft} size="lg" /> LED 版型</h2>
            <p className="muted">動畫師有時只要出幾塊螢幕：挑出來排進一張比較小的畫布，3D 畫面會貼回對的螢幕，沒挑到的螢幕是黑的。每首歌在歌單上選要用哪個版型。</p>
          </div>
          <button className="ledtpl__close" onClick={() => void tryClose()} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>

        {!list ? (
          <div className="ledtpl__empty muted">這個後台還沒有版型功能，或讀取失敗了。請重新整理。</div>
        ) : !fullCanvas ? (
          <div className="ledtpl__empty">
            <Icon icon={TriangleAlert} size="lg" />
            <div>還沒填這個專案的 LED 畫布大小。</div>
            <small className="muted">先到 3D 畫面工具列的「更多」→ LED 對位圖，填 AE 合成的寬 × 高（每塊螢幕的真實點數從它算），再回來建立版型。</small>
          </div>
        ) : (
          <div className="ledtpl__body">
            <aside className="ledtpl__list">
              <div className="ledtpl__fixed" title="現在的整張畫布；每塊螢幕的真實點數從它來">
                <strong>全部</strong>
                <span className="muted">{fullCanvas.width}×{fullCanvas.height}（真實點數）</span>
              </div>
              {customs.map(t => (
                <button key={t.id} className={'ledtpl__item' + (selected === t.id ? ' is-active' : '')} onClick={() => void pick(t.id)}>
                  <strong>{t.name}</strong>
                  <span className="muted">{t.canvas.width}×{t.canvas.height} · {formatPct(t.scalePct)} · {t.screens.length} 塊{t.songCount > 0 ? ` · ${t.songCount} 首歌在用` : ''}</span>
                </button>
              ))}
              {selected === NEW && <div className="ledtpl__item is-active"><strong>{draft?.name || '新版型'}</strong><span className="muted">還沒存</span></div>}
              <button className="btn btn--ghost ledtpl__add" onClick={() => void pick(NEW)} disabled={busy}><Icon icon={Plus} /> 新增版型</button>
              {full && <p className="ledtpl__note muted">「全部」是沒用版型的歌（以前的影片都是）。</p>}
            </aside>

            <section className="ledtpl__editor">
              {!draft ? (
                <div className="ledtpl__empty muted">還沒有版型。按左邊的「新增版型」。</div>
              ) : (
                <>
                  <div className="ledtpl__fields">
                    <label>名稱<input value={draft.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} /></label>
                    <label>畫布（影片大小）
                      <span className="ledtpl__pair">
                        <input inputMode="numeric" value={draft.width} onChange={(e) => patch({ width: e.target.value })} aria-label="畫布寬" />
                        <span>×</span>
                        <input inputMode="numeric" value={draft.height} onChange={(e) => patch({ height: e.target.value })} aria-label="畫布高" />
                      </span>
                    </label>
                    <label>比例
                      <span className="ledtpl__pair">
                        <select value={SCALE_CHOICES.includes(scaleNum) ? String(scaleNum) : 'custom'} onChange={(e) => patch({ scale: e.target.value === 'custom' ? '75' : e.target.value })}>
                          {SCALE_CHOICES.map(n => <option key={n} value={n}>{n}%</option>)}
                          <option value="custom">自訂</option>
                        </select>
                        {!SCALE_CHOICES.includes(scaleNum) && (
                          <input inputMode="decimal" value={draft.scale} onChange={(e) => patch({ scale: e.target.value })} aria-label="比例（%）" style={{ width: 70 }} />
                        )}
                      </span>
                    </label>
                    <button className="btn btn--ghost" onClick={fitCanvas} title="畫布寬高改成剛好包住打勾的螢幕">畫布剛好包住選的螢幕</button>
                  </div>
                  <p className="ledtpl__hint muted">比例 = 這個版型裡的螢幕比 LED 真實點數縮了多少（50% 就是一半大）。打勾放進版型的螢幕，位置和大小是版型畫布上的像素；轉動是順時針、轉完再翻。</p>

                  <div className="ledtpl__table" role="table" aria-label="螢幕">
                    <div className="ledtpl__row ledtpl__row--head" role="row">
                      <span>放進版型</span><span>螢幕</span><span>x</span><span>y</span><span>寬</span><span>高</span><span>轉動</span><span>翻轉</span>
                    </div>
                    {screens.length === 0 && <div className="ledtpl__empty muted">這個專案還沒有 LED 物件。</div>}
                    {screens.map(s => {
                      const r = draft.rows[s.key] ?? emptyRow();
                      return (
                        <div key={s.key} className={'ledtpl__row' + (r.on ? '' : ' is-off')} role="row">
                          <label className="ledtpl__check"><input type="checkbox" checked={r.on} onChange={(e) => toggleScreen(s, e.target.checked)} aria-label={`放進版型：${s.name}`} /></label>
                          <span className="ledtpl__name" title={s.name}>
                            <strong>{s.name}{s.manual ? '（切開的）' : ''}</strong>
                            <small className="muted">{sizeOf(s, r)}</small>
                          </span>
                          {(['x', 'y', 'w', 'h'] as const).map(k => (
                            <input key={k} inputMode="numeric" disabled={!r.on} value={r[k]} onChange={(e) => patchRow(s.key, { [k]: e.target.value })} aria-label={`${s.name} ${k === 'x' ? '左' : k === 'y' ? '上' : k === 'w' ? '寬' : '高'}`} />
                          ))}
                          <select disabled={!r.on} value={r.rotate} onChange={(e) => changeRotation(s, Number(e.target.value) as Rotation)} aria-label={`${s.name} 轉動`}>
                            {ROTATIONS.map(d => <option key={d} value={d}>{d}°</option>)}
                          </select>
                          <span className="ledtpl__flips">
                            <label title="左右翻"><input type="checkbox" disabled={!r.on} checked={r.flipH} onChange={(e) => patchRow(s.key, { flipH: e.target.checked })} /> 左右</label>
                            <label title="上下翻"><input type="checkbox" disabled={!r.on} checked={r.flipV} onChange={(e) => patchRow(s.key, { flipV: e.target.checked })} /> 上下</label>
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {issues.length > 0 && (
                    <ul className="ledtpl__issues" role="status">
                      {issues.map((i, n) => <li key={n}><Icon icon={TriangleAlert} size="sm" /> {i.text}</li>)}
                    </ul>
                  )}

                  <div className="ledtpl__actions">
                    <button className="btn btn--ghost ledtpl__delete" onClick={() => void remove()} disabled={busy}><Icon icon={Trash2} /> {draft.id ? '刪除版型' : '放棄'}</button>
                    <span className="ledtpl__spacer" />
                    {dirty && <span className="muted small">有還沒存的修改</span>}
                    <button className="btn btn--primary" onClick={() => void save()} disabled={busy || (!dirty && !!draft.id)}>
                      <Icon icon={busy ? LoaderCircle : Save} spin={busy} /> 儲存
                    </button>
                  </div>
                </>
              )}

              <details className="ledtpl__split">
                <summary><Icon icon={Scissors} size="sm" /> 一個物件裡有好幾塊螢幕？在整張畫布上切開{(list?.screens.length ?? 0) > 0 ? `（已切 ${list?.screens.length} 塊）` : ''}</summary>
                <p className="muted small">模型裡一個 LED 物件其實包著好幾塊獨立的螢幕時，在整張畫布（{fullCanvas.width}×{fullCanvas.height}）上框出每一塊，就能分別放進版型。切開以後，那個物件整塊的就不能放了。</p>
                {(list?.screens ?? []).map(sc => (
                  <div key={sc.id} className="ledtpl__splitrow">
                    <span><strong>{sc.name}</strong> <span className="muted">（{objName(sc.objectId)}）{Math.round(sc.uv[0] * fullCanvas.width)}, {Math.round(sc.uv[1] * fullCanvas.height)}　{Math.round((sc.uv[2] - sc.uv[0]) * fullCanvas.width)}×{Math.round((sc.uv[3] - sc.uv[1]) * fullCanvas.height)}</span></span>
                    <button className="btn btn--ghost" onClick={() => void removeSplit(sc.id, sc.name)} disabled={busy}><Icon icon={Trash2} /> 刪掉</button>
                  </div>
                ))}
                <div className="ledtpl__splitadd">
                  <select value={splitObj} onChange={(e) => setSplitObj(e.target.value)} aria-label="要切的 LED 物件">
                    {ledObjects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <input placeholder="螢幕名稱" value={splitName} maxLength={40} onChange={(e) => setSplitName(e.target.value)} aria-label="螢幕名稱" />
                  {(['x', 'y', 'w', 'h'] as const).map(k => (
                    <input key={k} inputMode="numeric" placeholder={k === 'x' ? '左' : k === 'y' ? '上' : k === 'w' ? '寬' : '高'} value={splitRect[k]} onChange={(e) => setSplitRect(r => ({ ...r, [k]: e.target.value }))} aria-label={`範圍${k}`} />
                  ))}
                  <button className="btn" onClick={() => void addSplit()} disabled={busy || !splitObj}><Icon icon={Plus} /> 切開</button>
                </div>
              </details>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
