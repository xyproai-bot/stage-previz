import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleCheck, Download, Eye, LoaderCircle, Ruler, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import { toast } from './dialogs';
import * as api from '../lib/api';
import { getUvImpact, uploadModelHeld, applyAutoUv, type ApplyResult, type LedUvApiError, type UvImpact } from '../lib/ledUvApi';
import type { LedTemplateList } from '../lib/ledTemplateApi';
import { DEFAULT_LED_CANVAS, layoutToCsv, ledMapFileName, todayString, type LedMapMeta } from '../lib/ledMap';
import { downloadBlob, drawAlignmentMap, renderAlignmentMapPng } from '../lib/ledMapDraw';
import { AeCanvasTooBigError, downloadAeCompScript } from '../lib/aeCompScriptDownload';
import { isPhoneLayout } from '../lib/viewportVars';
import type { LedCanvas } from '../lib/ledCanvas';
import { buildLegacy, buildPlan, pieceKey, pieceScreensOf, type ManualBox, type Plan, type PlanObjectIn } from '../lib/ledUv/plan';
import { previewLayout } from '../lib/ledUv/previewLayout';
import { PITCH_PRESETS, pitchLabel, type SizeSpec } from '../lib/ledUv/size';
import { EMPTY_FORM, MODE_LABEL, formIsEmpty, formToSpec, type SizeForm } from '../lib/ledUv/sizeForm';
import { MODE_TEXT, OVERRIDE_HINT, OVERRIDE_LABEL, UNSUPPORTED_TEXT, arcText, distortionLevel, distortionText, freeformText, type DistortionLevel } from '../lib/ledUv/text';
import type { AnalyzeOk, BuildPhase } from '../lib/ledUv/pipeline';
import type { UvSession, UvPreview } from '../lib/ledUv/ledUvClient';
import type { ObjectInfo } from '../lib/ledUv/objectInfo';
import type { DistortionStat, SurfaceOverride } from '../lib/ledUv/surfaces';
import './LedUvPanel.css';

/**
 * 「自動貼 UV」（編輯專案頁下方的面板；不蓋住 3D 畫面；只有製作）
 *   選 LED 螢幕 → 填每一片的點數（點距 / 總點數 / 箱體）→ 看照舞台排出來的畫布 → 套用成新的模型版本。
 *   第 1 階段只做平面；弧面和沒勾的螢幕保留原本的 UV（只搬到新位置）。套用時自動建「舊版面」保護沒有版型的舊影片。
 *   所有運算在瀏覽器的 worker 裡（lib/ledUv/），後台只收做好的 .glb 和一個「一次換好」的呼叫。
 * 第 2 階段：弧面（圓柱的一段）也能貼，照真正的弧長攤平；辨識錯了可以手動指定「平面 / 弧面」；每塊顯示變形百分比；
 *   「在 3D 預覽」把 3D 畫面的 LED 暫時換成套用以後的樣子（測試圖），確認方向、接縫沒問題再套用。
 * 說明：docs/superpowers/specs/2026-10-16-auto-uv-design.md
 */

export interface UvLedObject { id: string; meshName: string; name: string; order: number }

interface Props {
  open: boolean;
  projectId: string;
  projectName?: string;
  ledObjects: UvLedObject[];
  /** 版型清單（已經手動切的螢幕、版型數量）；舊的後台沒有 = null */
  list: LedTemplateList | null;
  ledCanvas: LedCanvas | null;
  scaleCorrection: number;
  onClose: () => void;
  /** 套用成功以後：父層重讀模型、畫布、版型 */
  onApplied: (r: ApplyResult) => void;
  /** 3D 預覽：給 3D 畫面暫時換上的新 UV（null = 關掉預覽，3D 畫面放回模型原本的 UV） */
  onPreview: (p: UvPreview | null) => void;
}

type Tab = 'pick' | 'size' | 'layout' | 'apply';
const TABS: [Tab, string][] = [['pick', '1 選螢幕'], ['size', '2 解析度'], ['layout', '3 排版'], ['apply', '4 套用']];

type Load = { state: 'idle' | 'loading' | 'ready' } | { state: 'error'; message: string };

type Run =
  | { state: 'idle' }
  | { state: 'running'; step: string; pct: number | null }
  | { state: 'error'; message: string; issues?: string[] }
  | { state: 'done'; result: ApplyResult; plan: Plan };

const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtPx = (n: number) => (n >= 1e4 ? `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1).replace(/\.0$/, '')} 萬` : fmtInt(n));
const fmtDots = (n: number) => `${fmtPx(n)}點`;

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function LedUvPanel({ open, projectId, projectName, ledObjects, list, ledCanvas, scaleCorrection, onClose, onApplied, onPreview }: Props) {
  const phone = isPhoneLayout();
  const [tab, setTab] = useState<Tab>('pick');
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [ana, setAna] = useState<AnalyzeOk | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [impact, setImpact] = useState<UvImpact | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [forms, setForms] = useState<Record<string, SizeForm>>({});
  const [bulk, setBulk] = useState<SizeForm>(EMPTY_FORM);
  const [gutter, setGutter] = useState('0');
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [overrides, setOverrides] = useState<Record<string, SurfaceOverride>>({});
  const [reBusy, setReBusy] = useState<string | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [pv, setPv] = useState<{ state: 'idle' | 'wait' | 'loading' | 'ready' | 'error'; message?: string }>({ state: 'idle' });
  const bufRef = useRef<ArrayBuffer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<UvSession | null>(null);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const running = run.state === 'running';

  const oldCanvas = ledCanvas ?? DEFAULT_LED_CANVAS;
  const manualsBy = useMemo(() => {
    const m: Record<string, ManualBox[]> = {};
    for (const s of list?.screens ?? []) (m[s.objectId] ??= []).push({ id: s.id, name: s.name, uv: s.uv });
    return m;
  }, [list]);

  // 開啟 → 抓現在的模型、分析每個 LED 物件
  const analyze = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoad({ state: 'loading' });
    setAna(null);
    setRun({ state: 'idle' });
    setOverrides({});
    setPreviewOn(false);
    sessionRef.current?.close();
    sessionRef.current = null;
    try {
      const model = await api.getModelInfo(projectId);
      if (!model) throw new Error('這個專案還沒有 3D 模型');
      const imp = await getUvImpact(projectId);
      if (!imp) throw new Error('後台還沒更新到支援自動貼 UV 的版本');
      if (ledObjects.length === 0) throw new Error('這個專案還沒有 LED 物件（物件分類要是 LED 螢幕）');
      const resp = await fetch(api.modelDownloadUrl(model.key), { signal: ac.signal });
      if (!resp.ok) throw new Error(`下載模型失敗（HTTP ${resp.status}）`);
      const buf = await resp.arrayBuffer();
      const client = await import('../lib/ledUv/ledUvClient');
      const session = client.openUvSession();
      sessionRef.current = session;
      const result = await session.analyze(buf, { objects: ledObjects.map(o => ({ id: o.id, meshName: o.meshName })), oldCanvas }, ac.signal);
      if (ac.signal.aborted) return;
      if (!result.ok) throw new Error(result.reason);
      bufRef.current = buf;
      setActiveKey(model.key);
      setImpact(imp);
      setAna(result);
      const sel: Record<string, boolean> = {};
      for (const o of ledObjects) {
        const info = result.infos[o.id];
        sel[o.id] = !!info && info.kind === 'ok' && !(manualsBy[o.id]?.length);
      }
      setSelected(sel);
      setForms({});
      setLoad({ state: 'ready' });
      setTab('pick');
    } catch (e) {
      if (ac.signal.aborted) return;
      setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ledObjects, oldCanvas.width, oldCanvas.height]);

  useEffect(() => {
    if (!open || phone) return;
    void analyze();
    return () => {
      abortRef.current?.abort();
      sessionRef.current?.close();
      sessionRef.current = null;
      onPreviewRef.current(null);
    };
    // 只在打開時分析一次（畫布、物件在途中改了不重來）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  const metersPerUnit = (ana?.scaleFactor ?? 1) * scaleCorrection;
  const inputs: PlanObjectIn[] = useMemo(() => ledObjects.map((o) => {
    const info = ana?.infos[o.id] ?? null;
    const sizes: Record<number, SizeSpec | undefined> = {};
    if (info && info.kind === 'ok') info.pieces.forEach((_, i) => { sizes[i] = formToSpec(forms[pieceKey(o.id, info.pieces.length, i)] ?? EMPTY_FORM); });
    return { id: o.id, name: o.name, order: o.order, info, selected: !!selected[o.id], sizes, manuals: manualsBy[o.id] ?? [], override: overrides[o.id] ?? 'auto' };
  }), [ledObjects, ana, forms, selected, manualsBy, overrides]);

  const gutterPx = Math.max(0, Math.min(64, Math.round(Number(gutter) || 0)));
  const plan: Plan | null = useMemo(
    () => (ana ? buildPlan(inputs, { front: ana.front, metersPerUnit, oldCanvas, gutter: gutterPx }) : null),
    [ana, inputs, metersPerUnit, oldCanvas, gutterPx],
  );

  const autoPieces = useMemo(() => (plan ? plan.objects.flatMap(o => (o.mode === 'auto' ? o.pieces : [])) : []), [plan]);
  const stats = useMemo(() => {
    if (!plan) return null;
    const keeps = plan.objects.filter(o => o.mode === 'keep');
    let dots = 0;
    for (const p of autoPieces) if (p.size?.ok) dots += p.size.w * p.size.h;
    for (const o of keeps) if (o.keep) dots += o.keep.rect.w * o.keep.rect.h;
    return { autoCount: autoPieces.length, keepCount: keeps.length, dots };
  }, [plan, autoPieces]);

  const legacy = useMemo(() => (plan && ana ? buildLegacy(plan, inputs, oldCanvas) : null), [plan, ana, inputs, oldCanvas]);

  // 3D 預覽：方案的重點（畫布、每塊排在哪、類型）變了才重算；填點數打字時不會每按一個鍵就重算
  const planKey = useMemo(() => (plan
    ? JSON.stringify([plan.canvas, plan.blockers.length, plan.objects.map(o => [o.id, o.mode, o.override, o.pieces.map(p => p.placed), o.keep ? o.keep.placed : null])])
    : ''), [plan]);
  useEffect(() => {
    const session = sessionRef.current;
    if (!open || !previewOn || !session || !plan || load.state !== 'ready') {
      onPreviewRef.current(null);
      setPv({ state: 'idle' });
      return;
    }
    if (plan.blockers.length > 0) {
      onPreviewRef.current(null);
      setPv({ state: 'wait', message: plan.blockers[0] });
      return;
    }
    const ac = new AbortController();
    setPv({ state: 'loading' });
    const t = window.setTimeout(async () => {
      try {
        const r = await session.preview(ledObjects.map(o => ({ id: o.id, meshName: o.meshName })), plan, oldCanvas, ac.signal);
        if (ac.signal.aborted) return;
        if (!r.ok) { onPreviewRef.current(null); setPv({ state: 'error', message: r.reason }); return; }
        onPreviewRef.current(r.preview);
        setPv({ state: 'ready' });
      } catch (e) {
        if (ac.signal.aborted) return;
        onPreviewRef.current(null);
        setPv({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }, 350);
    return () => { window.clearTimeout(t); ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, previewOn, planKey, load.state]);

  if (!open) return null;

  const close = () => { if (!running) onClose(); };

  if (phone) {
    return (
      <section className="uvdock uvdock--note" aria-label="自動貼 UV">
        <header className="uvdock__head">
          <h2><Icon icon={Ruler} size="md" /> 自動貼 UV</h2>
          <span className="uvdock__spacer" />
          <button className="uvdock__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="uvdock__empty">請用電腦做自動貼 UV（iPad 橫放也可以）</div>
      </section>
    );
  }

  /** 換一個物件的類型（自動 / 平面 / 弧面）：只重新分析那個物件（用已經讀進來的模型） */
  async function changeOverride(id: string, value: SurfaceOverride) {
    const session = sessionRef.current;
    if (!session || reBusy) return;
    const next = { ...overrides, [id]: value };
    setReBusy(id);
    try {
      const r = await session.reanalyze({ objects: ledObjects.map(o => ({ id: o.id, meshName: o.meshName })), oldCanvas, overrides: next, only: [id] });
      if (!r.ok) throw new Error(r.reason);
      setOverrides(next);
      setAna(a => (a ? { ...a, infos: { ...a.infos, ...r.infos } } : a));
    } catch (e) {
      toast.error('換類型失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setReBusy(null);
    }
  }

  const setSel = (id: string, v: boolean) => setSelected(s => ({ ...s, [id]: v }));
  const setForm = (key: string, patch: Partial<SizeForm>) => setForms(f => ({ ...f, [key]: { ...(f[key] ?? EMPTY_FORM), ...patch } }));

  function applyBulk() {
    if (formIsEmpty(bulk)) { toast.warn('上面「一次填給全部已選的螢幕」還沒填完整'); return; }
    setForms((f) => {
      const next = { ...f };
      for (const p of autoPieces) next[p.key] = { ...bulk };
      return next;
    });
  }

  async function doApply() {
    if (!plan || !ana || !bufRef.current || plan.blockers.length > 0 || running) return;
    const objects = ledObjects.map(o => ({ id: o.id, meshName: o.meshName }));
    setRun({ state: 'running', step: '準備工具…', pct: null });
    let heldKey: string | null = null;
    try {
      const client = await import('../lib/ledUv/ledUvClient');
      const outcome = await client.buildLedModel(bufRef.current.slice(0), objects, plan, oldCanvas, {
        onPhase: (p: BuildPhase | 'verifyScene') => setRun({ state: 'running', step: client.BUILD_PHASE_TEXT[p], pct: null }),
      });
      if (!outcome.ok) { setRun({ state: 'error', message: `沒有套用：${outcome.reason}。模型沒有改。`, issues: outcome.issues }); return; }

      setRun({ state: 'running', step: '上傳新模型…', pct: 0 });
      const held = await uploadModelHeld(projectId, outcome.blob, (loaded, total) => {
        if (total > 0) setRun({ state: 'running', step: '上傳新模型…', pct: Math.min(100, Math.round((loaded / total) * 100)) });
      });
      heldKey = held.key;

      setRun({ state: 'running', step: '確認上傳的檔案跟做好的一樣…', pct: null });
      const back = await fetch(api.modelDownloadUrl(held.key), { cache: 'no-store' });
      if (!back.ok) throw new Error(`下載剛上傳的模型失敗（HTTP ${back.status}）`);
      const [a, b] = await Promise.all([sha256(await back.arrayBuffer()), outcome.blob.arrayBuffer().then(sha256)]);
      if (a !== b) throw new Error('上傳的檔案跟做好的不一樣（網路傳輸出錯）');

      setRun({ state: 'running', step: '換成新版（模型、畫布、舊版面一次換好）…', pct: null });
      const lg = buildLegacy(plan, inputs, oldCanvas);
      const autoCount = plan.objects.reduce((n, o) => n + (o.mode === 'auto' ? o.pieces.length : 0), 0);
      const result = await applyAutoUv(projectId, {
        key: held.key,
        ifActive: activeKey,
        ledCanvas: { width: plan.canvas.width, height: plan.canvas.height },
        note: `自動貼 UV · ${autoCount} 塊螢幕 · ${plan.canvas.width}×${plan.canvas.height}`,
        recipe: recipeOf(plan, oldCanvas, metersPerUnit),
        legacy: lg.screens.length > 0 ? { canvas: { width: lg.canvas.width, height: lg.canvas.height }, screens: lg.screens.map(s => ({ key: s.key, dest: s.dest, rotate: s.rotate, flipH: s.flipH, flipV: s.flipV })) } : null,
        pieceScreens: pieceScreensOf(plan),
        screenUpdates: plan.objects.flatMap(o => o.keep?.manualUpdates ?? []),
      });
      heldKey = null;
      setPreviewOn(false);
      setRun({ state: 'done', result, plan });
      onApplied(result);
      toast.success(`已套用：新的模型版本，畫布 ${plan.canvas.width} × ${plan.canvas.height}。舊的版本還在，隨時可以在「模型版本」換回去。`);
    } catch (e) {
      // 上傳了但沒換成功 → 把沒人用的新版刪掉
      if (heldKey) { try { await api.deleteModelVersion(projectId, heldKey); } catch { /* 刪不掉就留著，模型版本裡看得到 */ } }
      const err = e as LedUvApiError;
      const msg = err.status === 409 ? (err.data?.conflict ? '模型已經被別人換過了，請關掉重新分析。' : err.message) : (e instanceof Error ? e.message : String(e));
      setRun({ state: 'error', message: `沒有套用：${msg}。模型沒有改。` });
    }
  }

  const body = !ana || !plan
    ? null
    : tab === 'pick' ? <PickTab plan={plan} ana={ana} inputs={inputs} selected={selected} onSel={setSel} overrides={overrides} busyId={reBusy} onOverride={(id, v) => void changeOverride(id, v)} onAll={(v) => setSelected(Object.fromEntries(ledObjects.map(o => [o.id, v && ana.infos[o.id]?.kind === 'ok' && !(manualsBy[o.id]?.length)])))} />
      : tab === 'size' ? <SizeTab plan={plan} forms={forms} bulk={bulk} setBulk={setBulk} onBulk={applyBulk} setForm={setForm} scaleCorrection={scaleCorrection} />
        : tab === 'layout' ? <LayoutTab plan={plan} oldCanvas={oldCanvas} hasProjectCanvas={!!ledCanvas} projectName={projectName} gutter={gutter} setGutter={setGutter} />
          : <ApplyTab plan={plan} stats={stats!} legacy={legacy!} impact={impact} list={list} oldCanvas={oldCanvas} hasProjectCanvas={!!ledCanvas} run={run} onApply={doApply} projectName={projectName} />;

  return (
    <section className="uvdock" aria-label="自動貼 UV">
      <header className="uvdock__head">
        <h2><Icon icon={Ruler} size="md" /> 自動貼 UV</h2>
        <nav className="uvdock__tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={'uvdock__tab' + (tab === k ? ' is-on' : '')} onClick={() => setTab(k)} disabled={load.state !== 'ready'}>{label}</button>
          ))}
        </nav>
        <span className="uvdock__spacer" />
        {stats && <span className="uvdock__sum muted small">{stats.autoCount} 塊自動貼 · {stats.keepCount} 個保留 · 畫布 {plan!.canvas.width} × {plan!.canvas.height}</span>}
        <button
          className={'btn btn--sm uvdock__pv' + (previewOn ? ' is-on' : '')}
          onClick={() => setPreviewOn(v => !v)}
          disabled={load.state !== 'ready' || running}
          aria-pressed={previewOn}
          title="把 3D 畫面的 LED 暫時換成套用以後的樣子（測試圖），確認方向、接縫都對再套用；不會存檔"
          data-testid="uv-preview"
        ><Icon icon={Eye} size="sm" /> {previewOn ? '關閉 3D 預覽' : '在 3D 預覽'}</button>
        <button className="uvdock__close" onClick={close} disabled={running} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
      </header>
      <div className="uvdock__body">
        {previewOn && load.state === 'ready' && (
          <div className={'uvpv uvpv--' + pv.state} role="status" data-testid="uv-preview-status">
            {pv.state === 'loading' && <><Icon icon={LoaderCircle} spin size="sm" /> 正在算 3D 預覽…</>}
            {pv.state === 'wait' && <><Icon icon={TriangleAlert} size="sm" /> 要先把點數填好才能預覽：{pv.message}</>}
            {pv.state === 'error' && <><Icon icon={TriangleAlert} size="sm" /> 沒辦法預覽：{pv.message}（套用不受影響）</>}
            {pv.state === 'ready' && <><Icon icon={Eye} size="sm" /> 3D 畫面現在顯示套用以後的樣子（畫布 {plan!.canvas.width} × {plan!.canvas.height}）：每塊有名字、格線、黃色的「上」「右」箭頭。字要正的、箭頭要朝上和朝右；方向不對就回「1 選螢幕」改類型。</>}
          </div>
        )}
        {load.state === 'loading' && <div className="uvdock__empty"><Icon icon={LoaderCircle} spin /> 下載模型、分析每個 LED 螢幕…</div>}
        {load.state === 'error' && (
          <div className="uvdock__empty">
            <div className="uvdock__err"><Icon icon={TriangleAlert} /> {load.message}</div>
            <button className="btn btn--ghost btn--sm" onClick={() => void analyze()}>重試</button>
          </div>
        )}
        {body}
      </div>
    </section>
  );
}

/** 之後「重新編輯」要用的：製作填的東西 */
function recipeOf(plan: Plan, oldCanvas: { width: number; height: number }, metersPerUnit: number): Record<string, unknown> {
  return {
    v: 1,
    canvas: plan.canvas,
    oldCanvas,
    metersPerUnit,
    surfaces: plan.objects.map(o => ({
      objectId: o.id, name: o.name, mode: o.mode, override: o.override,
      pieces: o.pieces.map(p => ({ key: p.key, name: p.name, surface: p.surface, convex: p.convex, spanDeg: p.spanDeg, distortion: p.distortion, measuredM: p.measured, size: p.size && p.size.ok ? { w: p.size.w, h: p.size.h } : null, place: p.placed })),
      keep: o.keep ? { place: o.keep.placed, rect: o.keep.rect } : null,
    })),
  };
}

// ───────────────────────── 變形、類型的小零件 ─────────────────────────

const worstOf = (list: readonly DistortionStat[]): DistortionStat => ({
  max: Math.max(0, ...list.map(d => d.max)),
  mean: list.length ? list.reduce((a, d) => a + d.mean, 0) / list.length : 0,
});

/** 一個物件的螢幕是哪種：平面 / 弧面（凸或凹、幾度） */
function surfaceSummary(info: ObjectInfo): string {
  const one = (p: ObjectInfo['pieces'][number]) => (p.arc ? arcText(p.arc.convex, (p.arc.span * 180) / Math.PI) : '平面');
  if (info.pieces.length > 1) return `${info.pieces.length} 片分開的螢幕：${info.pieces.map(one).join('、')}`;
  return one(info.pieces[0]);
}

const distortionShort = (d: DistortionStat): string => {
  const lv = distortionLevel(d);
  const p = d.max * 100;
  const n = p === 0 ? '0' : p < 0.05 ? '< 0.1' : p < 10 ? p.toFixed(1) : p.toFixed(0);
  return `${lv === 'ok' ? '變形' : lv === 'warn' ? '輕微拉伸' : '會變形'} ${n}%`;
};

function DistortionChip({ d }: { d: DistortionStat }) {
  const lv: DistortionLevel = distortionLevel(d);
  return <span className={'uvdist uvdist--' + lv} title={distortionText(d)}>{distortionShort(d)}</span>;
}

// ───────────────────────── 1 選螢幕 ─────────────────────────

function PickTab({ plan, ana, inputs, selected, onSel, onAll, overrides, busyId, onOverride }: {
  plan: Plan; ana: AnalyzeOk; inputs: PlanObjectIn[]; selected: Record<string, boolean>;
  onSel: (id: string, v: boolean) => void; onAll: (v: boolean) => void;
  overrides: Record<string, SurfaceOverride>; busyId: string | null; onOverride: (id: string, v: SurfaceOverride) => void;
}) {
  return (
    <div className="uvtab">
      <div className="uvtab__bar">
        <span className="muted small">勾要自動貼的 LED 螢幕（平面、圓柱的弧面都能貼）。沒勾的、不是平面也不是圓柱的，會保留原本的 UV，只搬到新位置。</span>
        <span className="uvdock__spacer" />
        <button className="btn btn--ghost btn--sm" onClick={() => onAll(true)}>全選能貼的</button>
        <button className="btn btn--ghost btn--sm" onClick={() => onAll(false)}>全不選</button>
      </div>
      <ul className="uvlist">
        {plan.objects.map((o) => {
          const inp = inputs.find(i => i.id === o.id)!;
          const info = ana.infos[o.id];
          const ok = info?.kind === 'ok';
          const splits = inp.manuals.length > 0;
          const can = ok && !splits;
          const busy = busyId === o.id;
          const worst = ok && info ? worstOf(info.pieces.map(p => p.distortion)) : null;
          return (
            <li key={o.id} className={'uvlist__row' + (selected[o.id] && can ? ' is-on' : '')}>
              <label className="uvlist__check">
                <input type="checkbox" checked={!!selected[o.id] && can} disabled={!can} onChange={e => onSel(o.id, e.target.checked)} />
                <span className="uvlist__name">{o.name}</span>
              </label>
              <span className={'uvbadge uvbadge--' + o.mode}>{MODE_TEXT[o.mode]}</span>
              <label className="uvlist__type">
                <span className="muted small">類型</span>
                <select
                  value={overrides[o.id] ?? 'auto'}
                  onChange={e => onOverride(o.id, e.target.value as SurfaceOverride)}
                  disabled={!info || splits || !!busyId}
                  aria-label={`${o.name} 的類型`}
                  title={OVERRIDE_HINT}
                >
                  {(['auto', 'flat', 'arc'] as const).map(k => <option key={k} value={k}>{OVERRIDE_LABEL[k]}</option>)}
                </select>
                {busy && <Icon icon={LoaderCircle} spin size="sm" />}
              </label>
              <span className="uvlist__meta muted small">
                {!info ? '模型裡找不到' : ok ? surfaceSummary(info) : info.kind === 'unsupported' ? UNSUPPORTED_TEXT[info.unsupported ?? 'other'] : ''}
                {splits ? ` · 已手動切成 ${inp.manuals.length} 塊` : ''}
                {info?.oldRegion ? ` · 原本在畫布 ${info.oldRegion.rect.w} × ${info.oldRegion.rect.h}` : info ? ' · 原本沒有 UV' : ''}
              </span>
              {worst && <DistortionChip d={worst} />}
              {info && ok && info.override && info.override !== 'auto' && <span className="uvlist__why small">已手動指定成「{OVERRIDE_LABEL[info.override]}」。</span>}
              {worst && distortionLevel(worst) !== 'ok' && (
                <span className={'uvlist__' + (distortionLevel(worst) === 'bad' ? 'bad' : 'warn') + ' small'}>
                  <Icon icon={TriangleAlert} size="xs" /> {distortionText(worst)}
                </span>
              )}
              {info && info.kind === 'unsupported' && info.freeform && (
                <span className={'uvlist__' + (distortionLevel(info.freeform.distortion) === 'bad' ? 'bad' : 'warn') + ' small'}>
                  <Icon icon={TriangleAlert} size="xs" /> {freeformText(info.freeform)}
                </span>
              )}
              {(o.reason && (!selected[o.id] || !can)) && <span className="uvlist__why small">{o.reason}</span>}
              {o.warnings.map((w, i) => <span key={i} className="uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {w}</span>)}
            </li>
          );
        })}
      </ul>
      {ana.warnings.map((w, i) => <p key={i} className="uvtab__warn small"><Icon icon={TriangleAlert} size="xs" /> {w}</p>)}
    </div>
  );
}

// ───────────────────────── 2 解析度 ─────────────────────────

function SizeFields({ f, onChange }: { f: SizeForm; onChange: (p: Partial<SizeForm>) => void }) {
  return (
    <span className="uvfields">
      <select value={f.mode} onChange={e => onChange({ mode: e.target.value as SizeForm['mode'] })} aria-label="輸入方式">
        {(Object.keys(MODE_LABEL) as SizeForm['mode'][]).map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
      </select>
      {f.mode === 'pitch' && (
        <>
          <input className="uvfields__n" inputMode="decimal" placeholder="例如 3.9" value={f.pitch} onChange={e => onChange({ pitch: e.target.value })} aria-label="點距（毫米）" list="uv-pitch-list" />
          <span className="muted small">mm</span>
        </>
      )}
      {f.mode === 'pixels' && (
        <>
          <input className="uvfields__n" inputMode="numeric" placeholder="寬" value={f.pw} onChange={e => onChange({ pw: e.target.value })} aria-label="總點數寬" />
          <span>×</span>
          <input className="uvfields__n" inputMode="numeric" placeholder="高" value={f.ph} onChange={e => onChange({ ph: e.target.value })} aria-label="總點數高" />
          <span className="muted small">點</span>
        </>
      )}
      {f.mode === 'cabinets' && (
        <>
          <span className="muted small">每箱</span>
          <input className="uvfields__n" inputMode="numeric" placeholder="點寬" value={f.cpxW} onChange={e => onChange({ cpxW: e.target.value })} aria-label="每箱點數寬" />
          <span>×</span>
          <input className="uvfields__n" inputMode="numeric" placeholder="點高" value={f.cpxH} onChange={e => onChange({ cpxH: e.target.value })} aria-label="每箱點數高" />
          <span className="muted small">點，實體</span>
          <input className="uvfields__n" inputMode="decimal" placeholder="mm 寬" value={f.cmmW} onChange={e => onChange({ cmmW: e.target.value })} aria-label="箱體實體寬（毫米）" />
          <span>×</span>
          <input className="uvfields__n" inputMode="decimal" placeholder="mm 高" value={f.cmmH} onChange={e => onChange({ cmmH: e.target.value })} aria-label="箱體實體高（毫米）" />
          <span className="muted small">mm，箱數</span>
          <input className="uvfields__s" inputMode="numeric" placeholder="自動" value={f.cols} onChange={e => onChange({ cols: e.target.value })} aria-label="橫向箱數" />
          <span>×</span>
          <input className="uvfields__s" inputMode="numeric" placeholder="自動" value={f.rows} onChange={e => onChange({ rows: e.target.value })} aria-label="直向箱數" />
        </>
      )}
    </span>
  );
}

function SizeTab({ plan, forms, bulk, setBulk, onBulk, setForm, scaleCorrection }: {
  plan: Plan; forms: Record<string, SizeForm>; bulk: SizeForm; setBulk: (f: SizeForm) => void; onBulk: () => void;
  setForm: (key: string, patch: Partial<SizeForm>) => void; scaleCorrection: number;
}) {
  const pieces = plan.objects.flatMap(o => (o.mode === 'auto' ? o.pieces.map(p => ({ o, p })) : []));
  return (
    <div className="uvtab">
      <datalist id="uv-pitch-list">{PITCH_PRESETS.map(p => <option key={p} value={String(p)}>{pitchLabel(p)}</option>)}</datalist>
      <div className="uvtab__bar uvtab__bar--wrap">
        <strong className="small">一次填給全部已選的螢幕</strong>
        <SizeFields f={bulk} onChange={p => setBulk({ ...bulk, ...p })} />
        <button className="btn btn--ghost btn--sm" onClick={onBulk} disabled={pieces.length === 0}>套用到全部已選</button>
      </div>
      <p className="muted small uvtab__note">
        模型量到的尺寸按目前測距校準（×{scaleCorrection.toFixed(2)}）換算成公尺；「總點數」不管模型量到多大。{scaleCorrection === 1 ? '還沒做測距校準的話，先到 3D 畫面量一段已知長度，或改用「總點數」。' : ''}
      </p>
      {pieces.length === 0 && <div className="uvdock__empty">還沒有勾要自動貼的螢幕，回到「1 選螢幕」勾幾塊。</div>}
      <ul className="uvlist">
        {pieces.map(({ p }) => {
          const f = forms[p.key] ?? EMPTY_FORM;
          const res = p.size;
          return (
            <li key={p.key} className="uvlist__row uvlist__row--size">
              <span className="uvlist__name">{p.name}</span>
              <span className="muted small">
                {p.surface === 'arc'
                  ? `弧面（${p.convex ? '凸' : '凹'}，${Math.round(p.spanDeg ?? 0)}°）：弧長 ${p.measured.w.toFixed(2)} × 高 ${p.measured.h.toFixed(2)} m`
                  : `模型量到 ${p.measured.w.toFixed(2)} × ${p.measured.h.toFixed(2)} m`}
              </span>
              {p.surface === 'arc' || distortionLevel(p.distortion) !== 'ok' ? <DistortionChip d={p.distortion} /> : null}
              <SizeFields f={f} onChange={patch => setForm(p.key, patch)} />
              <span className={'uvres small' + (res ? (res.ok ? ' is-ok' : ' is-bad') : ' is-wait')}>{res ? (res.ok ? res.line : res.error) : '還沒填點數'}</span>
              {res?.warnings.map((w, i) => <span key={i} className="uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {w}</span>)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────────────────────── 3 排版 ─────────────────────────

function LayoutTab({ plan, oldCanvas, hasProjectCanvas, projectName, gutter, setGutter }: {
  plan: Plan; oldCanvas: { width: number; height: number }; hasProjectCanvas: boolean; projectName?: string; gutter: string; setGutter: (s: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const layout = useMemo(() => previewLayout(plan), [plan]);
  const { width: W, height: H } = plan.canvas;
  useEffect(() => {
    const c = ref.current;
    if (!c || !W || !H) return;
    const s = Math.min(1, 1100 / W, 640 / H);
    c.width = Math.max(1, Math.round(W * s));
    c.height = Math.max(1, Math.round(H * s));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const meta: LedMapMeta = { projectName: projectName || '', date: todayString(), canvas: { width: W, height: H }, canvasSource: 'project' };
    drawAlignmentMap(ctx, layout, meta, s, true);
  }, [layout, W, H, projectName]);
  return (
    <div className="uvtab">
      <div className="uvtab__bar">
        <span className="small">
          整張畫布會從 <strong>{oldCanvas.width} × {oldCanvas.height}</strong>{hasProjectCanvas ? '' : '（專案還沒設定畫布，用預設大小算）'} 變成 <strong>{W || '—'} × {H || '—'}</strong>
        </span>
        <span className="uvdock__spacer" />
        <label className="uvfields">
          <span className="muted small">螢幕間隔</span>
          <input className="uvfields__s" inputMode="numeric" value={gutter} onChange={e => setGutter(e.target.value)} aria-label="螢幕之間的間隔（點）" />
          <span className="muted small">點</span>
        </label>
      </div>
      <p className="muted small uvtab__note">照舞台的樣子排：左邊的螢幕在左邊、上面的在上面，地屏在最下面（離觀眾越遠越上面）。這是套用後的對位圖，之後可以在 3D 工具列「⋯」→ LED 對位圖再下載。</p>
      {W > 0 ? <canvas ref={ref} className="uvprev" aria-label="排版預覽" /> : <div className="uvdock__empty">還沒有可以排的螢幕</div>}
    </div>
  );
}

// ───────────────────────── 4 套用 ─────────────────────────

function ApplyTab({ plan, stats, legacy, impact, list, oldCanvas, hasProjectCanvas, run, onApply, projectName }: {
  plan: Plan; stats: { autoCount: number; keepCount: number; dots: number }; legacy: ReturnType<typeof buildLegacy>; impact: UvImpact | null;
  list: LedTemplateList | null; oldCanvas: { width: number; height: number }; hasProjectCanvas: boolean; run: Run; onApply: () => void; projectName?: string;
}) {
  const blocked = plan.blockers.length > 0;
  const stretched = useMemo(() => {
    // 自己建的版型裡用到被處理的螢幕：方向或大小可能變了
    const touched = new Set(plan.objects.filter(o => o.mode === 'auto').map(o => o.id));
    const out: { name: string; n: number }[] = [];
    for (const t of list?.templates ?? []) {
      if (t.kind !== 'custom' || t.name.startsWith('舊版面')) continue;
      const n = t.screens.filter(s => touched.has(s.objectId)).length;
      if (n > 0) out.push({ name: t.name, n });
    }
    return out;
  }, [plan, list]);
  const meta: LedMapMeta = { projectName: projectName || '', date: todayString(), canvas: plan.canvas, canvasSource: 'project' };
  const done = run.state === 'done';
  const layout = useMemo(() => previewLayout(plan), [plan]);

  async function dlPng() {
    try {
      const png = await renderAlignmentMapPng(layout, meta);
      downloadBlob(png.blob, ledMapFileName('png', meta));
    } catch (e) { toast.error('對位圖沒畫出來：' + (e instanceof Error ? e.message : String(e))); }
  }
  async function dlAe() {
    try { await downloadAeCompScript(layout, meta); }
    catch (e) { toast.error(e instanceof AeCanvasTooBigError ? e.message : 'AE 合成腳本沒做出來：' + (e instanceof Error ? e.message : String(e))); }
  }
  function dlCsv() {
    downloadBlob(new Blob([layoutToCsv(layout)], { type: 'text/csv;charset=utf-8' }), ledMapFileName('csv', meta));
  }

  return (
    <div className="uvtab">
      <div className="uvsum">
        <div className="uvsum__line">
          <Icon icon={ArrowRight} size="sm" /> 整張畫布會從 <strong>{oldCanvas.width} × {oldCanvas.height}</strong> 變成 <strong>{plan.canvas.width} × {plan.canvas.height}</strong>
          {hasProjectCanvas ? '' : '（專案原本沒有設定畫布）'}
        </div>
        <div className="uvsum__line">共 <strong>{stats.autoCount}</strong> 塊自動貼、<strong>{stats.keepCount}</strong> 個保留原本的 UV · 約 {fmtDots(stats.dots)}</div>
        <div className="uvsum__line muted small">舊的模型版本會保留，隨時可以在「模型版本」換回去（畫布和舊影片會一起換回來）。</div>
        {impact && impact.videoVersions > 0 && (
          <div className="uvsum__line">
            沒有選版型的舊影片共 <strong>{impact.videoVersions}</strong> 個版本（{impact.songsWithVideos} 首歌）：套用時會自動建一個「舊版面」版型讓它們照舊貼對，不用重新輸出。
            {legacy.unprotected.length > 0 && <span className="uvlist__warn small"> 有 {legacy.unprotected.length} 塊（{legacy.unprotected.slice(0, 3).join('、')}{legacy.unprotected.length > 3 ? '…' : ''}）原本的畫面橫跨畫布邊緣，舊影片在那幾塊貼不對。</span>}
            {legacy.approximate.length > 0 && <span className="uvlist__warn small"> 有 {legacy.approximate.length} 塊原本的 UV 不是整齊的長方形，舊影片在那幾塊可能有一點歪。</span>}
          </div>
        )}
        {impact && impact.videoVersions === 0 && <div className="uvsum__line muted small">這個專案沒有需要保護的舊影片版本；仍會建一個「舊版面」版型（要看舊的本地檔案時，到歌單的「LED 版型」選它）。</div>}
        {stretched.map(t => (
          <div key={t.name} className="uvsum__line uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> 版型「{t.name}」裡有 {t.n} 塊螢幕的大小或方向可能變了，請重新檢查版型。</div>
        ))}
        {plan.objects.filter(o => o.mode === 'auto').flatMap(o => o.pieces.map(p => ({ o, p }))).filter(({ p }) => distortionLevel(p.distortion) !== 'ok').map(({ o, p }) => (
          <div key={p.key} className={'uvsum__line small ' + (distortionLevel(p.distortion) === 'bad' ? 'uvlist__bad' : 'uvlist__warn')} data-testid="uv-distortion">
            <Icon icon={TriangleAlert} size="xs" /> 「{p.name}」{o.override !== 'auto' ? `（手動指定成${OVERRIDE_LABEL[o.override]}）` : ''}：{distortionText(p.distortion)}
          </div>
        ))}
        {plan.objects.filter(o => o.mode === 'keep' && o.freeform).map(o => (
          <div key={o.id} className={'uvsum__line small ' + (distortionLevel(o.freeform!.distortion) === 'bad' ? 'uvlist__bad' : 'uvlist__warn')}>
            <Icon icon={TriangleAlert} size="xs" /> 「{o.name}」不是平面也不是圓柱，保留原本的 UV：{freeformText(o.freeform!)}
          </div>
        ))}
        {plan.objects.filter(o => o.mode === 'auto').flatMap(o => o.warnings).map((w, i) => <div key={i} className="uvsum__line uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {w}</div>)}
        {plan.blockers.map((b, i) => <div key={i} className="uvsum__line uvlist__bad small"><Icon icon={TriangleAlert} size="xs" /> {b}</div>)}
      </div>

      {run.state === 'running' && (
        <div className="uvrun" role="status"><Icon icon={LoaderCircle} spin /> {run.step}{run.pct !== null ? ` ${run.pct}%` : ''}</div>
      )}
      {run.state === 'error' && (
        <div className="uvrun uvrun--bad" role="alert">
          <Icon icon={TriangleAlert} /> {run.message}
          {run.issues && run.issues.length > 1 && <ul className="uvrun__issues">{run.issues.slice(0, 6).map((s, i) => <li key={i}>{s}</li>)}</ul>}
        </div>
      )}
      {done && (
        <div className="uvrun uvrun--ok" role="status" data-testid="uv-done">
          <Icon icon={CircleCheck} /> 套用好了：新的模型版本，畫布 {run.result.ledCanvas.width} × {run.result.ledCanvas.height}
          {run.result.legacyTemplateName ? `；舊影片 ${run.result.stampedVideos} 個版本改用「${run.result.legacyTemplateName}」` : ''}。對位圖、AE 合成腳本、座標表都已經是新的版面：
          <span className="uvrun__dl">
            <button className="btn btn--ghost btn--sm" onClick={() => void dlPng()}><Icon icon={Download} /> 下載對位圖</button>
            <button className="btn btn--ghost btn--sm" onClick={() => void dlAe()}><Icon icon={Download} /> 下載 AE 合成腳本</button>
            <button className="btn btn--ghost btn--sm" onClick={dlCsv}><Icon icon={Download} /> 下載座標表</button>
          </span>
        </div>
      )}
      <div className="uvtab__bar">
        <span className="uvdock__spacer" />
        <button className="btn btn--primary" onClick={onApply} disabled={blocked || run.state === 'running' || done} data-testid="uv-apply">
          {run.state === 'running' ? <><Icon icon={LoaderCircle} spin /> 處理中…</> : '套用並存成新模型版本'}
        </button>
      </div>
    </div>
  );
}
