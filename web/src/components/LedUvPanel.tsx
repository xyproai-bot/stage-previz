import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleCheck, Download, Eye, LoaderCircle, MoveLeft, MoveRight, Ruler, TriangleAlert, Undo2, X } from 'lucide-react';
import Icon from './Icon';
import { toast } from './dialogs';
import * as api from '../lib/api';
import { getUvImpact, getUvLayoutEdit, saveUvLayoutEdit, uploadModelHeld, applyAutoUv, type ApplyResult, type LedUvApiError, type UvImpact } from '../lib/ledUvApi';
import type { LedTemplateList } from '../lib/ledTemplateApi';
import { DEFAULT_LED_CANVAS, layoutToCsv, ledMapFileName, todayString, type LedMapMeta } from '../lib/ledMap';
import { downloadBlob, renderAlignmentMapPng } from '../lib/ledMapDraw';
import { AeCanvasTooBigError, downloadAeCompScript } from '../lib/aeCompScriptDownload';
import { isPhoneLayout } from '../lib/viewportVars';
import type { LedCanvas } from '../lib/ledCanvas';
import { buildLegacy, buildPlan, excludedIdsOf, pieceKey, pieceScreensOf, type ManualBox, type PieceChoice, type Plan, type PlanObjectIn } from '../lib/ledUv/plan';
import { previewLayout } from '../lib/ledUv/previewLayout';
import type { Arrangement, ArrangeNative } from '../lib/ledUv/arrange';
import type { PackResult } from '../lib/ledUv/pack';
import { useArrangeState } from '../lib/ledUv/useArrange';
import { editSignature, parseEditSnapshot, pieceOwner, pruneEditSnapshot, type UvEditSnapshot } from '../lib/ledUv/editState';
import { createLatestRunner, type LatestRunner } from '../lib/ledUv/latestRunner';
import LedUvArrange from './LedUvArrange';
import { PITCH_PRESETS, pitchLabel, type SizeSpec } from '../lib/ledUv/size';
import { EMPTY_FORM, MODE_LABEL, formIsEmpty, formToSpec, type SizeForm } from '../lib/ledUv/sizeForm';
import { EXCLUDE_TEXT, FREE_CHOICE, MODE_TEXT, OVERRIDE_HINT, PIECE_TEXT, OVERRIDE_LABEL, SEAM_TEXT, UNSUPPORTED_TEXT, defaultSelected, distortionLevel, distortionText, freeformText, pieceKindText, type DistortionLevel } from '../lib/ledUv/text';
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
 * 第 3 階段：第 3 步「排版」換成自己排整張畫布（LED 版型編輯器同一套畫布；螢幕大小鎖死，只能搬、轉 90°、翻轉；畫布自動或自己填；
 *   全部靠左上 / 自動排一次；幾塊可以連在一起）；邊排邊在 3D 預覽（節流）；排法、點數、勾的螢幕存在後台（停手自動存，套用時跟著新版本存），下次打開接著做。
 * 第 4 階段：曲面（沿直線擠出的波浪、折角照弧長拉直不拉伸；其他自由曲面用 LSCM 攤平，變形百分比照實算，製作選「照形狀展開」或「保留原本 UV」）、
 *   整圈 360 度圓柱（接縫預設在背對觀眾那一側，可以轉）、舊影片更牢的保護（原本的 UV 存進模型第二組 UV，套用時一起寫、更新舊版面快照）。
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

const NO_NATIVES: ArrangeNative[] = [];
const NO_PACK: Pick<PackResult, 'placed' | 'canvas'> = { placed: new Map(), canvas: { width: 0, height: 0 } };
/** 排好以後停手多久才存到後台 */
const AUTOSAVE_MS = 1500;
/** 3D 預覽：兩次開始計算至少隔多久（拖曳中邊拖邊更新，但不會每一幀都重算） */
const PREVIEW_GAP_MS = 200;

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
  /** 選了「不放進畫布」的物件（蓋過 selected；套用後類型改成「其他」） */
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  /** 物件裡有好幾塊 LED mesh 時，個別塊的選擇（「物件id~mesh 名稱」→ 保留 / 不放進畫布；沒列 = 跟著整個物件） */
  const [pieceFlags, setPieceFlags] = useState<Record<string, PieceChoice>>({});
  const [forms, setForms] = useState<Record<string, SizeForm>>({});
  const [bulk, setBulk] = useState<SizeForm>(EMPTY_FORM);
  const [gutter, setGutter] = useState('0');
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [overrides, setOverrides] = useState<Record<string, SurfaceOverride>>({});
  /** 整圈圓柱的接縫位置（物件 id → 從背面往觀眾右手邊轉幾度；沒有 = 0） */
  const [seams, setSeams] = useState<Record<string, number>>({});
  const [reBusy, setReBusy] = useState<string | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [pv, setPv] = useState<{ state: 'idle' | 'wait' | 'loading' | 'ready' | 'error'; message?: string }>({ state: 'idle' });
  /** 上次存的排法還沒還原（螢幕清單要等點數填好才有，還原要等到那時候） */
  const [pendingArr, setPendingArr] = useState<Arrangement | null>(null);
  const bufRef = useRef<ArrayBuffer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<UvSession | null>(null);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const running = run.state === 'running';
  /** 自動存：上次存好（或剛讀進來）的內容指紋；null = 還沒有基準 */
  const lastSigRef = useRef<string | null>(null);
  const saveBlockedRef = useRef(false);
  const restoreArrRef = useRef<(a: Arrangement | null) => void>(() => undefined);
  const previewRunnerRef = useRef<LatestRunner | null>(null);
  const planRef = useRef<Plan | null>(null);
  const previewOnRef = useRef(false);
  const ledObjectsRef = useRef(ledObjects);
  ledObjectsRef.current = ledObjects;

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
    setSeams({});
    setPreviewOn(false);
    setPendingArr(null);
    restoreArrRef.current(null);
    lastSigRef.current = null;
    saveBlockedRef.current = false;
    sessionRef.current?.close();
    sessionRef.current = null;
    try {
      const model = await api.getModelInfo(projectId);
      if (!model) throw new Error('這個專案還沒有 3D 模型');
      const imp = await getUvImpact(projectId);
      if (!imp) throw new Error('後台還沒更新到支援自動貼 UV 的版本');
      if (ledObjects.length === 0) throw new Error('這個專案還沒有 LED 物件（物件分類要是 LED 螢幕）');
      // 上次排到哪裡（勾的螢幕、點數、類型、排法）：同一個模型版本接著做；讀不到就從頭開始
      let restored: UvEditSnapshot | null = null;
      try {
        const saved = await getUvLayoutEdit(projectId);
        const snap = saved && saved.key === model.key ? parseEditSnapshot(saved.edit) : null;
        if (snap) restored = pruneEditSnapshot(snap, new Set(ledObjects.map(o => o.id)));
      } catch { /* 讀不到就從頭開始 */ }
      const resp = await fetch(api.modelDownloadUrl(model.key), { signal: ac.signal });
      if (!resp.ok) throw new Error(`下載模型失敗（HTTP ${resp.status}）`);
      const buf = await resp.arrayBuffer();
      const client = await import('../lib/ledUv/ledUvClient');
      const session = client.openUvSession();
      sessionRef.current = session;
      const result = await session.analyze(buf, { objects: ledObjects.map(o => ({ id: o.id, meshName: o.meshName })), oldCanvas, overrides: restored?.overrides, seams: restored?.seams }, ac.signal);
      if (ac.signal.aborted) return;
      if (!result.ok) throw new Error(result.reason);
      bufRef.current = buf;
      setActiveKey(model.key);
      setImpact(imp);
      setAna(result);
      const sel: Record<string, boolean> = {};
      for (const o of ledObjects) {
        const info = result.infos[o.id];
        const can = !!info && info.kind === 'ok' && !(manualsBy[o.id]?.length);
        sel[o.id] = can && (restored && o.id in restored.selected ? restored.selected[o.id] : !!info && defaultSelected(info.pieces));
      }
      setSelected(sel);
      setExcluded(restored?.excluded ?? {});
      setPieceFlags({
        ...Object.fromEntries(Object.keys(restored?.keepPieces ?? {}).map(k => [k, 'keep' as const])),
        ...Object.fromEntries(Object.keys(restored?.excludedPieces ?? {}).map(k => [k, 'exclude' as const])),
      });
      setForms(restored?.forms ?? {});
      setOverrides(restored?.overrides ?? {});
      setSeams(restored?.seams ?? {});
      setGutter(restored?.gutter ?? '0');
      setPendingArr(restored?.arrangement ?? null);
      setLoad({ state: 'ready' });
      setTab(restored?.arrangement ? 'layout' : 'pick');
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
    // 在排版畫布上按 Esc 是「取消選取」，不是關掉整個面板
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || running) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.target instanceof HTMLElement && e.target.closest('.ltc__host')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  const metersPerUnit = (ana?.scaleFactor ?? 1) * scaleCorrection;
  const inputs: PlanObjectIn[] = useMemo(() => ledObjects.map((o) => {
    const info = ana?.infos[o.id] ?? null;
    const sizes: Record<number, SizeSpec | undefined> = {};
    if (info && info.kind === 'ok') info.pieces.forEach((_, i) => { sizes[i] = formToSpec(forms[pieceKey(o.id, info.pieces.length, i)] ?? EMPTY_FORM); });
    const pieceChoices: Record<string, PieceChoice> = {};
    for (const [k, v] of Object.entries(pieceFlags)) if (pieceOwner(k) === o.id) pieceChoices[k.slice(o.id.length + 1)] = v;
    return { id: o.id, name: o.name, order: o.order, info, selected: !!selected[o.id], excluded: !!excluded[o.id], sizes, manuals: manualsBy[o.id] ?? [], override: overrides[o.id] ?? 'auto', seamDeg: seams[o.id] ?? 0, ...(Object.keys(pieceChoices).length > 0 ? { pieceChoices } : {}) };
  }), [ledObjects, ana, forms, selected, excluded, manualsBy, overrides, seams, pieceFlags]);

  const gutterPx = Math.max(0, Math.min(64, Math.round(Number(gutter) || 0)));
  // 照舞台自動排的方案（沒套用自己排的排法）：螢幕清單、框裡的畫面、「自動排一次」都從它來
  const autoPlan: Plan | null = useMemo(
    () => (ana ? buildPlan(inputs, { front: ana.front, metersPerUnit, oldCanvas, gutter: gutterPx }) : null),
    [ana, inputs, metersPerUnit, oldCanvas, gutterPx],
  );
  // 自己排的排法（位置 / 轉 90° / 翻轉 / 畫布大小 / 連在一起）；沒動過 = 照自動排
  const arrange = useArrangeState(autoPlan ? autoPlan.items : NO_NATIVES, autoPlan ? autoPlan.pack : NO_PACK);
  restoreArrRef.current = arrange.restore;
  const plan: Plan | null = useMemo(
    () => (!ana ? null : arrange.arrangement
      ? buildPlan(inputs, { front: ana.front, metersPerUnit, oldCanvas, gutter: gutterPx, arrangement: arrange.arrangement })
      : autoPlan),
    [ana, inputs, metersPerUnit, oldCanvas, gutterPx, arrange.arrangement, autoPlan],
  );
  planRef.current = plan;

  // 上次存的排法：螢幕清單有了（點數填好了）就還原一次
  useEffect(() => {
    if (!pendingArr || !autoPlan || autoPlan.items.length === 0) return;
    arrange.restore(pendingArr);
    setPendingArr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingArr, autoPlan]);

  const autoPieces = useMemo(() => (plan ? plan.objects.flatMap(o => (o.mode === 'auto' ? o.pieces.filter(p => !p.choice) : [])) : []), [plan]);
  // 套用好以後 LED 物件清單會少掉「不放進畫布」的、新切出來的螢幕也會讓雙片的物件變成「已手動切」：摘要的數字照套用當下的方案
  const statsPlan = plan && run.state === 'done' ? run.plan : plan;
  const stats = useMemo(() => {
    if (!statsPlan) return null;
    const all = statsPlan.objects.flatMap(o => (o.mode === 'auto' ? o.pieces : []));
    const pieces = all.filter(p => !p.choice);
    const keepPieces = all.filter(p => p.choice === 'keep');
    const keeps = statsPlan.objects.filter(o => o.mode === 'keep');
    let dots = 0;
    for (const p of pieces) if (p.size?.ok) dots += p.size.w * p.size.h;
    for (const p of keepPieces) if (p.keepRect) dots += p.keepRect.w * p.keepRect.h;
    for (const o of keeps) if (o.keep) dots += o.keep.rect.w * o.keep.rect.h;
    return { autoCount: pieces.length, keepCount: keeps.length + keepPieces.length, excludedCount: statsPlan.objects.filter(o => o.mode === 'excluded').length + all.filter(p => p.choice === 'exclude').length, dots };
  }, [statsPlan]);

  // 預測：原本的 UV 存得進模型第二組 UV 的物件（舊影片一個像素都不差）；實際存了多少以寫檔的結果為準（doApply）
  const exactIds = useMemo(() => new Set(Object.entries(ana?.uv1 ?? {}).filter(([, s]) => s === 'fresh').map(([id]) => id)), [ana]);
  const legacy = useMemo(() => (plan && ana ? buildLegacy(plan, inputs, oldCanvas, exactIds) : null), [plan, ana, inputs, oldCanvas, exactIds]);

  // ───────── 排到一半的東西：停手 1.5 秒自動存到後台（同一個模型版本，下次打開接著做）─────────
  const snapshot = useMemo<UvEditSnapshot>(
    () => ({ v: 1, selected, excluded: Object.fromEntries(Object.entries(excluded).filter(([, v]) => v)), ...pieceFlagsSnapshot(pieceFlags), forms, overrides, seams: Object.fromEntries(Object.entries(seams).filter(([, v]) => v !== 0)), gutter, arrangement: arrange.arrangement ?? pendingArr }),
    [selected, excluded, pieceFlags, forms, overrides, seams, gutter, arrange.arrangement, pendingArr],
  );
  const snapshotSig = useMemo(() => editSignature(snapshot), [snapshot]);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const canSave = open && !phone && load.state === 'ready' && !!ana && !!activeKey && run.state !== 'running' && run.state !== 'done';
  useEffect(() => {
    if (!canSave) return;
    if (lastSigRef.current === null) { lastSigRef.current = snapshotSig; return; }   // 剛讀完 / 剛還原完的樣子就是基準，不用存
    if (snapshotSig === lastSigRef.current || saveBlockedRef.current) return;
    const sig = snapshotSig;
    const t = window.setTimeout(async () => {
      try {
        await saveUvLayoutEdit(projectId, activeKey, snapshotRef.current as unknown as Record<string, unknown>);
        lastSigRef.current = sig;
      } catch (e) {
        const err = e as LedUvApiError;
        if (err.status === 409) {
          saveBlockedRef.current = true;
          toast.warn('模型已經被別人換過了，這份排版不會再自動存。要接著做請關掉重新打開。');
        } else if (err.status === 404) {
          saveBlockedRef.current = true;   // 舊的後台沒有這個功能：照常用，只是不記住
        }
      }
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotSig, canSave, projectId, activeKey]);

  // ───────── 3D 預覽：邊排邊更新（節流：同一時間只算一次、兩次開始之間隔 200 毫秒、永遠算最新的排法）─────────
  // 方案的重點（畫布、每塊排在哪 / 轉動 / 翻轉、類型）變了才重算；填點數打字時不會每按一個鍵就重算
  const planKey = useMemo(() => (plan
    ? JSON.stringify([plan.canvas, plan.blockers.length, plan.objects.map(o => [o.id, o.mode, o.override, o.pieces.map(p => p.placed), o.keep ? o.keep.placed : null])])
    : ''), [plan]);
  previewOnRef.current = previewOn;
  useEffect(() => {
    if (!open) return;
    const runner = createLatestRunner(async () => {
      const session = sessionRef.current;
      const p = planRef.current;
      if (!session || !p || !previewOnRef.current) return;
      // 自己排的排法超出畫布只會擋住「套用」，預覽照樣看得到（方便邊排邊看）；點數沒填完才沒辦法預覽
      const waiting = p.blockers.filter(b => !p.arrangeBlockers.includes(b));
      if (waiting.length > 0) {
        onPreviewRef.current(null);
        setPv({ state: 'wait', message: waiting[0] });
        return;
      }
      setPv(cur => (cur.state === 'ready' ? cur : { state: 'loading' }));
      try {
        const r = await session.preview(ledObjectsRef.current.map(o => ({ id: o.id, meshName: o.meshName })), p, oldCanvas, undefined);
        if (!previewOnRef.current || sessionRef.current !== session) return;
        if (!r.ok) { onPreviewRef.current(null); setPv({ state: 'error', message: r.reason }); return; }
        onPreviewRef.current(r.preview);
        setPv({ state: 'ready' });
      } catch (e) {
        if (!previewOnRef.current || (e instanceof DOMException && e.name === 'AbortError')) return;
        onPreviewRef.current(null);
        setPv({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }, { gapMs: PREVIEW_GAP_MS });
    previewRunnerRef.current = runner;
    return () => { runner.dispose(); previewRunnerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, oldCanvas.width, oldCanvas.height]);
  useEffect(() => {
    if (!open || !previewOn || load.state !== 'ready') {
      onPreviewRef.current(null);
      setPv({ state: 'idle' });
      return;
    }
    previewRunnerRef.current?.trigger();
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

  /** 換一個物件的類型（自動 / 平面 / 弧面 / 自由曲面）或整圈圓柱的接縫位置：只重新分析那個物件（用已經讀進來的模型） */
  async function reanalyzeOne(id: string, nextOverrides: Record<string, SurfaceOverride>, nextSeams: Record<string, number>, what: string) {
    const session = sessionRef.current;
    if (!session || reBusy) return;
    setReBusy(id);
    try {
      const r = await session.reanalyze({ objects: ledObjects.map(o => ({ id: o.id, meshName: o.meshName })), oldCanvas, overrides: nextOverrides, seams: nextSeams, only: [id] });
      if (!r.ok) throw new Error(r.reason);
      setOverrides(nextOverrides);
      setSeams(nextSeams);
      setAna(a => (a ? { ...a, infos: { ...a.infos, ...r.infos }, uv1: { ...a.uv1, ...r.uv1 } } : a));
      // 換類型以後，曲面的預設選擇跟著重算（變形太大的預設保留原本 UV）；已經動過的物件不改他的選擇
      const info = r.infos[id];
      if (what === 'override') setSelected(s => ({ ...s, [id]: !!info && info.kind === 'ok' && !(manualsBy[id]?.length) && defaultSelected(info.pieces) }));
    } catch (e) {
      toast.error((what === 'override' ? '換類型失敗：' : '轉接縫失敗：') + (e instanceof Error ? e.message : String(e)));
    } finally {
      setReBusy(null);
    }
  }
  const changeOverride = (id: string, value: SurfaceOverride) => reanalyzeOne(id, { ...overrides, [id]: value }, seams, 'override');
  const changeSeam = (id: string, deg: number) => reanalyzeOne(id, overrides, { ...seams, [id]: Math.max(-180, Math.min(180, Math.round(deg * 10) / 10)) }, 'seam');

  /** 每一列的三選一：自動貼 / 保留原本 UV / 不放進畫布 */
  const setChoice = (id: string, c: 'auto' | 'keep' | 'exclude') => {
    setExcluded(e => ({ ...e, [id]: c === 'exclude' }));
    if (c !== 'exclude') setSelected(s => ({ ...s, [id]: c === 'auto' }));
    // 物件那一列的選擇 = 一次設全部塊：各塊自己的選擇清掉
    setPieceFlags(f => (Object.keys(f).some(k => pieceOwner(k) === id) ? Object.fromEntries(Object.entries(f).filter(([k]) => pieceOwner(k) !== id)) : f));
  };
  /** 物件裡某一塊 LED mesh 的選擇 */
  const setPieceChoice = (id: string, label: string, c: 'auto' | PieceChoice) => {
    setPieceFlags((f) => {
      const next = { ...f };
      if (c === 'auto') delete next[`${id}~${label}`]; else next[`${id}~${label}`] = c;
      return next;
    });
  };
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
      // 原本的 UV 這次真的存進第二組 UV 的物件：這些物件的舊影片取色直接用它（精確）；其他的靠長方形版型近似
      const fresh = new Set(Object.entries(outcome.uv1).filter(([, s]) => s === 'fresh').map(([id]) => id));
      const lg = buildLegacy(plan, inputs, oldCanvas, fresh);
      const autoCount = plan.objects.reduce((n, o) => n + (o.mode === 'auto' ? o.pieces.filter(p => !p.choice).length : 0), 0);
      const excludeIds = excludedIdsOf(plan);
      const result = await applyAutoUv(projectId, {
        key: held.key,
        ifActive: activeKey,
        ledCanvas: { width: plan.canvas.width, height: plan.canvas.height },
        note: `自動貼 UV · ${autoCount} 塊螢幕 · ${plan.canvas.width}×${plan.canvas.height}`,
        recipe: { ...recipeOf(plan, oldCanvas, metersPerUnit, snapshotRef.current), uv1: outcome.uv1 },
        legacy: lg.screens.length > 0 || lg.originalUv.length > 0
          ? { canvas: { width: lg.canvas.width, height: lg.canvas.height }, screens: lg.screens.map(s => ({ key: s.key, dest: s.dest, rotate: s.rotate, flipH: s.flipH, flipV: s.flipV })), originalUv: lg.originalUv }
          : null,
        pieceScreens: pieceScreensOf(plan),
        screenUpdates: plan.objects.flatMap(o => o.keep?.manualUpdates ?? []),
        ...(excludeIds.length > 0 ? { excludeObjects: excludeIds } : {}),
      });
      heldKey = null;
      setPreviewOn(false);
      setRun({ state: 'done', result, plan });
      onApplied(result);
      toast.success(`已套用：新的模型版本，畫布 ${plan.canvas.width} × ${plan.canvas.height}。舊的版本還在，隨時可以在「模型版本」換回去。`);
      if (excludeIds.length > 0) {
        // 舊的後台不認識 excludeObjects，不會回 excludedObjects：模型和畫布換好了，但那幾個物件的類型沒有改
        if (!result.excludedObjects) toast.warn(`後台還不支援「不放進畫布」，那 ${excludeIds.length} 個物件的類型沒有改成「其他」，請到「物件」分頁自己改。`);
        else toast.success(`${result.excludedObjects.length} 個物件的類型已改成「其他」（不放進畫布）。`);
      }
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
    : tab === 'pick' ? <PickTab plan={plan} ana={ana} inputs={inputs} selected={selected} excluded={excluded} onChoice={setChoice} onPieceChoice={setPieceChoice} overrides={overrides} busyId={reBusy} onOverride={(id, v) => void changeOverride(id, v)} onSeam={(id, deg) => void changeSeam(id, deg)} onAll={(v) => setSelected(Object.fromEntries(ledObjects.map(o => [o.id, v && ana.infos[o.id]?.kind === 'ok' && !(manualsBy[o.id]?.length)])))} />
      : tab === 'size' ? <SizeTab plan={plan} forms={forms} bulk={bulk} setBulk={setBulk} onBulk={applyBulk} setForm={setForm} scaleCorrection={scaleCorrection} />
        : tab === 'layout' ? <LedUvArrange projectId={projectId} autoPlan={autoPlan!} plan={plan} arrange={arrange} gutter={gutter} setGutter={setGutter} />
          : <ApplyTab plan={statsPlan ?? plan} stats={stats!} legacy={legacy!} uv1={ana.uv1} impact={impact} list={list} oldCanvas={oldCanvas} hasProjectCanvas={!!ledCanvas} run={run} onApply={doApply} projectName={projectName} />;

  return (
    <section className={'uvdock' + (tab === 'layout' ? ' uvdock--tall' : '')} aria-label="自動貼 UV">
      <header className="uvdock__head">
        <h2><Icon icon={Ruler} size="md" /> 自動貼 UV</h2>
        <nav className="uvdock__tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={'uvdock__tab' + (tab === k ? ' is-on' : '')} onClick={() => setTab(k)} disabled={load.state !== 'ready'}>{label}</button>
          ))}
        </nav>
        <span className="uvdock__spacer" />
        {stats && <span className="uvdock__sum muted small">{stats.autoCount} 塊自動貼 · {stats.keepCount} 個保留{stats.excludedCount > 0 ? ` · ${stats.excludedCount} 個不放進畫布` : ''} · 畫布 {plan!.canvas.width} × {plan!.canvas.height}</span>}
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
      <div className={'uvdock__body' + (tab === 'layout' ? ' uvdock__body--fill' : '')}>
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
function recipeOf(plan: Plan, oldCanvas: { width: number; height: number }, metersPerUnit: number, edit: UvEditSnapshot): Record<string, unknown> {
  return {
    v: 1,
    /** 製作填的東西（勾的螢幕、點數、類型、排法）：下次打開自動貼 UV 接著做 */
    edit,
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

/** 各塊的選擇 → 存進 edit 的兩個欄位（沒有就不寫） */
function pieceFlagsSnapshot(flags: Record<string, PieceChoice>): Pick<UvEditSnapshot, 'excludedPieces' | 'keepPieces'> {
  const ex = Object.entries(flags).filter(([, v]) => v === 'exclude').map(([k]) => [k, true] as const);
  const kp = Object.entries(flags).filter(([, v]) => v === 'keep').map(([k]) => [k, true] as const);
  return { ...(ex.length > 0 ? { excludedPieces: Object.fromEntries(ex) } : {}), ...(kp.length > 0 ? { keepPieces: Object.fromEntries(kp) } : {}) };
}

// ───────────────────────── 變形、類型的小零件 ─────────────────────────

/** 物件 id 清單 → 名字（最多三個） */
function nameList(plan: Plan, ids: readonly string[]): string {
  const name = (id: string) => plan.objects.find(o => o.id === id)?.name ?? id;
  return ids.slice(0, 3).map(name).join('、') + (ids.length > 3 ? '…' : '');
}

const worstOf = (list: readonly DistortionStat[]): DistortionStat => ({
  max: Math.max(0, ...list.map(d => d.max)),
  mean: list.length ? list.reduce((a, d) => a + d.mean, 0) / list.length : 0,
});

/** 一個物件的螢幕是哪種：平面 / 弧面（凸或凹、幾度） */
function surfaceSummary(info: ObjectInfo): string {
  const one = (p: ObjectInfo['pieces'][number]) => pieceKindText(p);
  if (info.pieces.length > 1) return `${info.pieces.length} 片分開的螢幕：${info.pieces.map(one).join('、')}`;
  return one(info.pieces[0]);
}

const distortionShort = (d: DistortionStat): string => {
  const lv = distortionLevel(d);
  const p = d.max * 100;
  const n = p === 0 ? '0' : p < 0.05 ? '< 0.1' : p < 10 ? p.toFixed(1) : p.toFixed(0);
  if (lv === 'ok') return '沒有變形'; // 很小的數字（例如 0.01%）是曲面由平面拼成的誤差，看不出來；數字留在滑鼠提示裡
  return `${lv === 'warn' ? '輕微拉伸' : '會變形'} ${n}%`;
};

/** 整圈 360 度圓柱的接縫位置：預設在背對觀眾的那一側；往觀眾的右手邊（正）或左手邊（負）轉 */
function SeamControl({ info, seamDeg, busy, name, onSeam }: { info: ObjectInfo; seamDeg: number; busy: boolean; name: string; onSeam: (deg: number) => void }) {
  const closed = info.pieces.find(p => p.arc?.closed);
  const [draft, setDraft] = useState<string | null>(null);
  if (!closed?.arc) return null;
  const wrap = (v: number) => { const m = ((v + 180) % 360 + 360) % 360 - 180; return m === -180 ? 180 : m; };
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.trim().replace(/°$/, ''));
    setDraft(null);
    if (Number.isFinite(n)) onSeam(wrap(n));
  };
  return (
    <span className="uvseam" data-testid="uv-seam">
      <span className="muted small" title={SEAM_TEXT.hint}>{SEAM_TEXT.title}</span>
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onSeam(wrap(seamDeg - 15))} title={SEAM_TEXT.left} aria-label={`${name} 的${SEAM_TEXT.left}`}><Icon icon={MoveLeft} size="sm" /></button>
      <input
        className="uvfields__n" inputMode="decimal" value={draft ?? String(seamDeg)} disabled={busy}
        onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        aria-label={`${name} 的${SEAM_TEXT.inputLabel}`} title={SEAM_TEXT.inputLabel}
      />
      <span className="muted small">°</span>
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onSeam(wrap(seamDeg + 15))} title={SEAM_TEXT.right} aria-label={`${name} 的${SEAM_TEXT.right}`}><Icon icon={MoveRight} size="sm" /></button>
      <button className="btn btn--ghost btn--sm" disabled={busy || seamDeg === 0} onClick={() => onSeam(0)} title={SEAM_TEXT.reset}><Icon icon={Undo2} size="sm" /> {SEAM_TEXT.reset}</button>
      <span className="muted small" data-testid="uv-seam-actual">{SEAM_TEXT.actual(closed.arc.seamDeg)}</span>
    </span>
  );
}

function DistortionChip({ d }: { d: DistortionStat }) {
  const lv: DistortionLevel = distortionLevel(d);
  return <span className={'uvdist uvdist--' + lv} title={distortionText(d)}>{distortionShort(d)}</span>;
}

// ───────────────────────── 1 選螢幕 ─────────────────────────

function PickTab({ plan, ana, inputs, selected, excluded, onChoice, onPieceChoice, onAll, overrides, busyId, onOverride, onSeam }: {
  plan: Plan; ana: AnalyzeOk; inputs: PlanObjectIn[]; selected: Record<string, boolean>; excluded: Record<string, boolean>;
  onChoice: (id: string, c: 'auto' | 'keep' | 'exclude') => void; onPieceChoice: (id: string, label: string, c: 'auto' | PieceChoice) => void; onAll: (v: boolean) => void;
  overrides: Record<string, SurfaceOverride>; busyId: string | null; onOverride: (id: string, v: SurfaceOverride) => void;
  onSeam: (id: string, deg: number) => void;
}) {
  return (
    <div className="uvtab">
      <div className="uvtab__bar">
        <span className="muted small">每塊 LED 螢幕選一種：「自動貼」（平面、弧面、整圈圓柱、波浪、折角和其他曲面都能貼）、「保留原本 UV」（只搬到新位置）、「不放進畫布」（完全不進畫布，例如提詞用的 LED）。攤不平的曲面預設保留原本的 UV。{EXCLUDE_TEXT.bulkNote}</span>
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
          const ex = !!excluded[o.id];
          const choice: 'auto' | 'keep' | 'exclude' = ex ? 'exclude' : selected[o.id] && can ? 'auto' : 'keep';
          const curved = !!info && ok && !splits && info.pieces.some(p => p.kind === 'ext' || p.kind === 'free');
          const worst = !ex && ok && info ? worstOf(info.pieces.map(p => p.distortion)) : null;
          return (
            <li key={o.id} className={'uvlist__row' + (choice === 'auto' ? ' is-on' : '') + (ex ? ' is-excluded' : '')}>
              <span className="uvlist__check">
                <span className="uvlist__name">{o.name}</span>
              </span>
              <span className={'uvbadge uvbadge--' + o.mode}>{MODE_TEXT[o.mode]}</span>
              <span className="uvchoice" role="group" aria-label={`${o.name} 要怎麼處理`} title={EXCLUDE_TEXT.choiceHint} data-testid="uv-choice">
                <button className={'uvchoice__btn' + (choice === 'auto' ? ' is-on' : '')} aria-pressed={choice === 'auto'} disabled={!can} onClick={() => onChoice(o.id, 'auto')} title={curved ? FREE_CHOICE.hint : undefined} data-testid="uv-choice-auto">{EXCLUDE_TEXT.choiceAuto}</button>
                <button className={'uvchoice__btn' + (choice === 'keep' ? ' is-on' : '')} aria-pressed={choice === 'keep'} onClick={() => onChoice(o.id, 'keep')} data-testid="uv-choice-keep">{EXCLUDE_TEXT.choiceKeep}</button>
                <button className={'uvchoice__btn uvchoice__btn--exclude' + (choice === 'exclude' ? ' is-on' : '')} aria-pressed={choice === 'exclude'} onClick={() => onChoice(o.id, 'exclude')} data-testid="uv-choice-exclude">{EXCLUDE_TEXT.choiceExclude}</button>
              </span>
              {!ex && (
                <label className="uvlist__type">
                  <span className="muted small">類型</span>
                  <select
                    value={overrides[o.id] ?? 'auto'}
                    onChange={e => onOverride(o.id, e.target.value as SurfaceOverride)}
                    disabled={!info || splits || !!busyId}
                    aria-label={`${o.name} 的類型`}
                    title={OVERRIDE_HINT}
                  >
                    {(['auto', 'flat', 'arc', 'free'] as const).map(k => <option key={k} value={k}>{OVERRIDE_LABEL[k]}</option>)}
                  </select>
                  {busy && <Icon icon={LoaderCircle} spin size="sm" />}
                </label>
              )}
              <span className="uvlist__meta muted small">
                {!info ? '模型裡找不到' : ok ? surfaceSummary(info) : info.kind === 'unsupported' ? UNSUPPORTED_TEXT[info.unsupported ?? 'other'] : ''}
                {splits ? ` · 已手動切成 ${inp.manuals.length} 塊` : ''}
                {info?.oldRegion ? ` · 原本在畫布 ${info.oldRegion.rect.w} × ${info.oldRegion.rect.h}` : info ? ' · 原本沒有 UV' : ''}
              </span>
              {ex && <span className="uvlist__warn small" data-testid="uv-exclude-note"><Icon icon={TriangleAlert} size="xs" /> {EXCLUDE_TEXT.rowNote}</span>}
              {worst && <DistortionChip d={worst} />}
              {!ex && info && ok && info.override && info.override !== 'auto' && <span className="uvlist__why small">已手動指定成「{OVERRIDE_LABEL[info.override]}」。</span>}
              {!ex && info && ok && !splits && <SeamControl info={info} seamDeg={inputs.find(i => i.id === o.id)?.seamDeg ?? 0} busy={busy || !!busyId} name={o.name} onSeam={deg => onSeam(o.id, deg)} />}
              {worst && distortionLevel(worst) !== 'ok' && (
                <span className={'uvlist__' + (distortionLevel(worst) === 'bad' ? 'bad' : 'warn') + ' small'}>
                  <Icon icon={TriangleAlert} size="xs" /> {distortionText(worst)}
                </span>
              )}
              {!ex && info && info.kind === 'unsupported' && info.freeform && (
                <span className={'uvlist__' + (distortionLevel(info.freeform.distortion) === 'bad' ? 'bad' : 'warn') + ' small'}>
                  <Icon icon={TriangleAlert} size="xs" /> {freeformText(info.freeform)}
                </span>
              )}
              {(!ex && o.reason && choice !== 'auto') && <span className="uvlist__why small">{o.reason}</span>}
              {o.warnings.map((w, i) => <span key={i} className="uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {w}</span>)}
              {o.mode === 'auto' && o.pieces.length > 1 && o.pieces.every(p => !!p.label) && (
                <ul className="uvparts" data-testid="uv-parts">
                  {o.pieces.map((p) => {
                    const pc: 'auto' | PieceChoice = p.choice ?? 'auto';
                    return (
                      <li key={p.label} className={'uvparts__row' + (pc === 'exclude' ? ' is-excluded' : '')} data-testid="uv-part">
                        <span className="uvparts__name">{p.label}</span>
                        <span className="uvchoice" role="group" aria-label={`${o.name} 的 ${p.label} 要怎麼處理`}>
                          <button className={'uvchoice__btn' + (pc === 'auto' ? ' is-on' : '')} aria-pressed={pc === 'auto'} onClick={() => onPieceChoice(o.id, p.label!, 'auto')} data-testid="uv-part-auto">{EXCLUDE_TEXT.choiceAuto}</button>
                          <button className={'uvchoice__btn' + (pc === 'keep' ? ' is-on' : '')} aria-pressed={pc === 'keep'} onClick={() => onPieceChoice(o.id, p.label!, 'keep')} data-testid="uv-part-keep">{EXCLUDE_TEXT.choiceKeep}</button>
                          <button className={'uvchoice__btn uvchoice__btn--exclude' + (pc === 'exclude' ? ' is-on' : '')} aria-pressed={pc === 'exclude'} onClick={() => onPieceChoice(o.id, p.label!, 'exclude')} data-testid="uv-part-exclude">{EXCLUDE_TEXT.choiceExclude}</button>
                        </span>
                        {pc === 'exclude' && <span className="uvlist__warn small">{PIECE_TEXT.excludeNote}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
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
  const pieces = plan.objects.flatMap(o => (o.mode === 'auto' ? o.pieces.filter(p => !p.choice).map(p => ({ o, p })) : []));
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

// ───────────────────────── 4 套用 ─────────────────────────

function ApplyTab({ plan, stats, legacy, uv1, impact, list, oldCanvas, hasProjectCanvas, run, onApply, projectName }: {
  plan: Plan; stats: { autoCount: number; keepCount: number; excludedCount: number; dots: number }; legacy: ReturnType<typeof buildLegacy>; uv1: AnalyzeOk['uv1']; impact: UvImpact | null;
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
  // 套用好以後 LED 物件清單會少掉「不放進畫布」的那幾個（類型已經改成其他）：摘要照套用當下的方案
  const shownPlan = run.state === 'done' ? run.plan : plan;
  const excludedIds = useMemo(() => excludedIdsOf(shownPlan), [shownPlan]);
  const excludedInTemplates = useMemo(() => {
    const gone = new Set(excludedIds);
    const out: { name: string; n: number }[] = [];
    for (const t of list?.templates ?? []) {
      if (t.kind !== 'custom' || t.name.startsWith('舊版面')) continue;
      const n = t.screens.filter(s => gone.has(s.objectId)).length;
      if (n > 0) out.push({ name: t.name, n });
    }
    return out;
  }, [excludedIds, list]);
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
        <div className="uvsum__line">共 <strong>{stats.autoCount}</strong> 塊自動貼、<strong>{stats.keepCount}</strong> 個保留原本的 UV{excludedIds.length > 0 ? <>、<strong>{excludedIds.length}</strong> 個不放進畫布</> : ''} · 約 {fmtDots(stats.dots)}</div>
        {excludedIds.length > 0 && (
          <div className="uvsum__line uvlist__warn small" data-testid="uv-excluded-summary">
            <Icon icon={TriangleAlert} size="xs" /> {EXCLUDE_TEXT.summary(excludedIds.length, nameList(shownPlan, excludedIds))}
          </div>
        )}
        {shownPlan.objects.some(o => o.mode === 'auto' && o.pieces.some(p => p.choice === 'exclude')) && (
          <div className="uvsum__line uvlist__warn small" data-testid="uv-excluded-parts-summary">
            <Icon icon={TriangleAlert} size="xs" /> {PIECE_TEXT.summary(shownPlan.objects.flatMap(o => (o.mode === 'auto' ? o.pieces.filter(p => p.choice === 'exclude').map(p => `${o.name}：${p.label}`) : [])))}
          </div>
        )}
        {excludedInTemplates.map(t => (
          <div key={t.name} className="uvsum__line uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {EXCLUDE_TEXT.template(t.name, t.n)}</div>
        ))}
        <div className="uvsum__line muted small">舊的模型版本會保留，隨時可以在「模型版本」換回去（畫布和舊影片會一起換回來）。</div>
        {impact && impact.videoVersions > 0 && (
          <div className="uvsum__line">
            沒有選版型的舊影片共 <strong>{impact.videoVersions}</strong> 個版本（{impact.songsWithVideos} 首歌）：套用時會自動建一個「舊版面」版型讓它們照舊貼對，不用重新輸出。
            {legacy.unprotected.length > 0 && <span className="uvlist__warn small"> 有 {legacy.unprotected.length} 塊（{legacy.unprotected.slice(0, 3).join('、')}{legacy.unprotected.length > 3 ? '…' : ''}）原本的畫面橫跨畫布邊緣，舊影片在那幾塊貼不對。</span>}
            {legacy.approximate.length > 0 && <span className="uvlist__warn small"> 有 {legacy.approximate.length} 塊原本的 UV 不是整齊的長方形，舊影片在那幾塊可能有一點歪。</span>}
          </div>
        )}
        {impact && impact.videoVersions > 0 && legacy.originalUv.length > 0 && (
          <div className="uvsum__line small" data-testid="uv-original-uv">
            <Icon icon={CircleCheck} size="xs" /> {legacy.originalUv.length} 個物件（{nameList(plan, legacy.originalUv)}）原本的 UV 會存進模型的第二組 UV：舊影片取色直接用它，一個像素都不差（跨過畫布邊緣、弧長不均勻的也是）；「舊版面」版型只是備援。
          </div>
        )}
        {(() => {
          const touched = new Set(plan.objects.filter(o => o.mode === 'auto' || o.mode === 'keep').map(o => o.id));
          const blocked = Object.entries(uv1).filter(([id, s]) => s === 'blocked' && touched.has(id)).map(([id]) => id);
          const carried = Object.entries(uv1).filter(([id, s]) => s === 'carried' && touched.has(id)).map(([id]) => id);
          return (
            <>
              {blocked.length > 0 && <div className="uvsum__line uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {blocked.length} 個物件（{nameList(plan, blocked)}）的模型已經有第二組 UV（例如燈光貼圖），原本的 UV 存不進去：舊影片在這幾塊退回「舊版面」版型的長方形近似。</div>}
              {carried.length > 0 && <div className="uvsum__line muted small">{carried.length} 個物件（{nameList(plan, carried)}）之前套用時已經存過最原始的 UV，這次繼續帶著，更早的舊影片仍然精確；現在這個版本才做的影片，在這幾塊用「舊版面」版型近似。</div>}
            </>
          );
        })()}
        {impact && impact.videoVersions === 0 && <div className="uvsum__line muted small">這個專案沒有需要保護的舊影片版本；仍會建一個「舊版面」版型（要看舊的本地檔案時，到歌單的「LED 版型」選它）。</div>}
        {stretched.map(t => (
          <div key={t.name} className="uvsum__line uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> 版型「{t.name}」裡有 {t.n} 塊螢幕的大小或方向可能變了，請重新檢查版型。</div>
        ))}
        {plan.objects.filter(o => o.mode === 'auto').flatMap(o => o.pieces.filter(p => !p.choice).map(p => ({ o, p }))).filter(({ p }) => distortionLevel(p.distortion) !== 'ok').map(({ o, p }) => (
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
        {plan.warnings.map((w, i) => <div key={i} className="uvsum__line uvlist__warn small" data-testid="uv-plan-warning"><Icon icon={TriangleAlert} size="xs" /> {w}</div>)}
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
