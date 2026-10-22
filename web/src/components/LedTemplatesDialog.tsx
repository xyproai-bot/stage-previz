import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, FileBraces, FileCode, FileSpreadsheet, LayoutPanelLeft, LoaderCircle, Monitor, Plus, Save, Scissors, Trash2, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import OverflowMenu from './OverflowMenu';
import NumField from './NumField';
import CabinetPicker from './CabinetPicker';
import { applyCabinets, cabinetsEqual, gridCells, resolveCabinet } from '../lib/ledCabinet';
import LedTemplateCanvas, { type PatchHow } from './LedTemplateCanvas';
import LedSplitCanvas from './LedSplitCanvas';
import LedTemplateLayers from './LedTemplateLayers';
import { confirmDialog, promptDialog, toast } from './dialogs';
import {
  createLedScreen, createLedTemplate, deleteLedScreen, deleteLedTemplate, updateLedTemplate,
  type LedTemplateList,
} from '../lib/ledTemplateApi';
import {
  buildScreenList, checkPlacements, formatPct, normalizeTemplateInput, normalizeTemplateName, ROTATIONS, screenSizeLabel,
  type AutoScreenPart, type Rotation, type ScreenDef, type SrcSpan,
} from '../lib/ledTemplate';
import {
  addScreenToDraft, copyTemplateName, draftFromTemplate, draftSignature, draftToBody, draftToPlan, emptyDraft, nextTemplateName,
  patchDraftItems, removeScreensFromDraft, resetItemSize, setItemsCabinet, type Draft, type ItemPatch, type ItemPatchEntry,
} from '../lib/ledTemplateDraft';
import { boundsOf, centerGroupOnCanvas, clickSelect, isAdditive, moveGroupTo, movePatches, pruneSelection, scaleGroupPct, scaleGroupTo, selectionTag } from '../lib/ledTemplateSelect';
import {
  commit, fitCanvasToItems, newHistory, redo, rectToUv, setRotation, settle, transient, undo, type History,
} from '../lib/ledTemplateEdit';
import { panelColor, todayString, type PixelRect } from '../lib/ledMap';
import { downloadBlob } from '../lib/ledMapDraw';
import { downloadTemplateTable, downloadTemplateTilesZip, guideContentFor, guideShrinkWarning, renderTemplateGuideFile } from '../lib/ledTemplateDownload';
import { layoutFromSpans, splitLayoutByScreens } from '../lib/ledTemplateContent';
import { wholeCanvasLayout, type LayerBackdrop } from '../lib/ledTemplateContentDraw';
import { useLedFullMap } from '../lib/useLedFullMap';
import { useTemplateBackdrop } from '../lib/useTemplateBackdrop';
import type { LedPatternSource } from '../lib/useLedPatternCanvas';
import { isPhoneLayout } from '../lib/viewportVars';
import type { LedCanvas } from '../lib/ledCanvas';
import { parseCanvasFields } from '../lib/newProjectWizard';
import './LedTemplatesDialog.css';

/**
 * 「LED 版型」編輯器（編輯專案頁下方的面板；不蓋住 3D 畫面）
 *   版型 = 只挑幾塊螢幕、排進一張比較小的畫布；動畫師只要輸出這張，3D 畫面會把它貼回對的螢幕，沒挑到的螢幕是黑的。
 *   左邊：版型畫布（拖曳移動、拖角落縮放、吸附、轉 90°、翻轉、復原重做）或整張畫布（拖出範圍切螢幕）；右邊：螢幕清單 + 選到的螢幕的數字欄位（跟畫布雙向連動）。
 *   面板開著的時候，3D 的 LED 顯示這個版型的測試圖（每塊螢幕不同顏色 + 名字 + 指著上方的箭頭 + 像素格），放錯、轉錯一眼就看得出來。
 *   「下載模板圖」= 版型畫布大小的 PNG，給動畫師當 AE 的參考圖層。「複製版型」= 複製一份再改名字。
 *   「下載 AE 合成腳本」= 一個 .jsx，在 AE 跑一下就建好版型畫布大小的合成（外框 + 模板圖，導引圖層）；
 *   「下載座標表」（CSV / JSON）= 每塊螢幕在版型和整張畫布上的位置、轉向、翻轉、真實點數，給 LED 工程師、d3 操作員。
 *   （檔案內容：lib/aeTemplateScript.ts / lib/ledTemplateTable.ts；下載：lib/ledTemplateDownload.ts；3D 工具列的「⋯」也有同樣的下載）
 *   「全部」是現在的整張 LED 畫布（每塊螢幕的真實點數都從它來），不能改。
 *   版型畫布上：每塊螢幕的框裡畫「對位圖內容」（整張畫布的測試圖裡屬於這塊螢幕的那一段，照轉動、翻轉擺進來）；最底下可以墊一張自己載入的「底圖」
 *   （只存在這台電腦的瀏覽器裡，不上傳）。對位圖內容和底圖都只是編輯時的參考，不會存進版型。
 * 純邏輯：lib/ledTemplateEdit.ts / ledTemplateDraft.ts / ledTemplatePattern.ts（有單元測試）
 * 說明：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md
 */

export interface LedObjectInfo { id: string; name: string; order: number }

interface Props {
  open: boolean;
  projectId: string;
  projectName?: string;
  onClose: () => void;
  list: LedTemplateList | null;
  ledObjects: readonly LedObjectInfo[];
  /** 3D 畫面算出來的每個 LED 物件在整張畫布上的範圍；沒有（模型還沒載好）= null → 每塊當整張畫布 */
  getSpans: () => Record<string, SrcSpan> | null;
  /** 有 2 塊以上 LED mesh 的物件：每個 mesh 一塊（名稱、範圍）；沒給 = 每個物件一塊 */
  getParts?: () => Record<string, AutoScreenPart[]> | null;
  /** 存好 / 刪掉以後，父層重新讀版型清單 */
  onChanged: () => Promise<unknown>;
  /** 正在編輯的版型（3D 的 LED 要貼它的測試圖）；沒在編輯 = null */
  onPreview: (p: LedPatternSource | null) => void;
  /** 父層知道的 LED 畫布大小（3D 工具列「設定畫布大小…」剛存的，後台清單還沒重讀時先用它） */
  ledCanvas?: LedCanvas | null;
  /** 有給 → 還沒設畫布大小時，直接在這裡填（跟「設定畫布大小…」存同一個地方） */
  onSetCanvas?: (c: LedCanvas) => void;
}

const WHOLE: SrcSpan = { us: 0, ul: 1, vs: 0, vl: 1 };
const SCALE_CHOICES = [100, 50, 25];
const NEW = '__new__';
const PREVIEW_THROTTLE_MS = 100;
const CONTENT_OPACITY_KEY = 'sp_ledtpl_content_opacity';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function LedTemplatesDialog({ open, projectId, projectName, onClose, list, ledObjects, getSpans, getParts, onChanged, onPreview, ledCanvas, onSetCanvas }: Props) {
  const phone = isPhoneLayout();
  const [canvasW, setCanvasW] = useState('');
  const [canvasH, setCanvasH] = useState('');
  const [canvasErr, setCanvasErr] = useState('');
  const [selectedTpl, setSelectedTpl] = useState('');
  const [hist, setHist] = useState<History<Draft> | null>(null);
  const [savedSig, setSavedSig] = useState('');
  /** 選到的螢幕代號（可以好幾塊；順序 = 選的先後） */
  const [selKeys, setSelKeys] = useState<string[]>([]);
  const [mode, setMode] = useState<'template' | 'full'>('template');
  const [busy, setBusy] = useState(false);
  const [spans, setSpans] = useState<Record<string, SrcSpan>>({});
  const [parts, setParts] = useState<Record<string, AutoScreenPart[]>>({});
  /** 問了很多次 3D 畫面都沒有 LED 的範圍（沒有模型）：對位圖內容改畫整張畫布一張 */
  const [sceneGaveUp, setSceneGaveUp] = useState(false);
  const [contentOn, setContentOn] = useState(true);
  // 框裡對位圖內容的不透明度：記在這台電腦（讀不到就用 100%）
  const [contentOpacity, setContentOpacityState] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem(CONTENT_OPACITY_KEY));
      return window.localStorage.getItem(CONTENT_OPACITY_KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch { return 1; }
  });
  const setContentOpacity = useCallback((o: number) => {
    const v = Math.min(1, Math.max(0, o));
    setContentOpacityState(v);
    try { window.localStorage.setItem(CONTENT_OPACITY_KEY, String(v)); } catch { /* 存不了就只在這次有效 */ }
  }, []);
  const histRef = useRef(hist);
  histRef.current = hist;
  const gestureBase = useRef<Draft | null>(null);
  const loadedFor = useRef('');

  const draft = hist?.present ?? null;
  const dirty = !!draft && draftSignature(draft) !== savedSig;
  const fullCanvas = list?.fullCanvas ?? ledCanvas ?? null;
  const customs = useMemo(() => (list?.templates ?? []).filter(t => t.kind === 'custom'), [list]);
  const manuals = list?.screens;

  // 打開時：向 3D 畫面要每個 LED 物件的範圍（模型還沒載好就等一下再問）
  useEffect(() => {
    if (!open) return;
    let tries = 0;
    let timer = 0;
    setSceneGaveUp(false);
    const grab = () => {
      const s = getSpans();
      if (s && Object.keys(s).length > 0) { setSpans(s); setParts(getParts?.() ?? {}); }
      else if (tries++ < 12) timer = window.setTimeout(grab, 700);
      else setSceneGaveUp(true);
    };
    grab();
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { if (!open) { setMode('template'); setSelKeys([]); } }, [open]);

  const screens = useMemo<ScreenDef[]>(() => {
    if (!fullCanvas) return [];
    // 舊版型用的「整個物件一塊」(o:<id>) 還有版型在用時照舊留在清單裡
    const inUse = new Set<string>();
    for (const t of customs) for (const sc of t.screens) inUse.add(sc.key);
    return buildScreenList(
      ledObjects.map(o => ({ objectId: o.id, name: o.name, order: o.order, src: spans[o.id] ?? WHOLE, parts: parts[o.id] })),
      manuals ?? [], fullCanvas, inUse,
    );
  }, [ledObjects, spans, parts, manuals, fullCanvas, customs]);
  const defKeys = useMemo(() => new Set(screens.map(s => s.key)), [screens]);

  // 選的版型變了 / 清單重讀 → 重新帶入草稿（有沒存的修改時不蓋掉；內容沒變就不動，選到的螢幕不會被清掉）
  useEffect(() => {
    if (!open || phone || dirty) return;
    if (selectedTpl === NEW) return;
    const t = customs.find(x => x.id === selectedTpl);
    if (t) {
      const d = draftFromTemplate(t);
      const stamp = `${t.id}:${draftSignature(d)}`;
      if (loadedFor.current === stamp && hist) return;
      loadedFor.current = stamp;
      setHist(newHistory(d));
      setSavedSig(draftSignature(d));
      setSelKeys([]);
      return;
    }
    if (customs.length > 0) { setSelectedTpl(customs[0].id); return; }
    loadedFor.current = '';
    setHist(null);
    setSavedSig('');
    setSelectedTpl('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phone, selectedTpl, customs, dirty]);

  const plan = useMemo(() => (draft ? draftToPlan(draft, manuals ?? []) : null), [draft, manuals]);
  const source = useMemo<LedPatternSource | null>(
    () => (open && !phone && plan && fullCanvas ? { plan, defs: screens } : null),
    [open, phone, plan, fullCanvas, screens],
  );

  // 3D 的 LED 測試圖：最多每 0.1 秒更新一次（拖曳的時候不會每一幀都重畫整個畫面）
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const latestSource = useRef(source);
  latestSource.current = source;
  const lastSent = useRef(0);
  const previewTimer = useRef(0);
  useEffect(() => {
    if (!source) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = 0;
      onPreviewRef.current(null);
      return;
    }
    if (previewTimer.current) return;   // 已經排好一次了，它會拿最新的
    const wait = Math.max(0, lastSent.current + PREVIEW_THROTTLE_MS - Date.now());
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = 0;
      lastSent.current = Date.now();
      onPreviewRef.current(latestSource.current);
    }, wait);
  }, [source]);
  useEffect(() => () => { window.clearTimeout(previewTimer.current); onPreviewRef.current(null); }, []);

  // 對位圖內容：整張畫布的測試圖（跟 3D 的 LED 沒有影片時顯示的同一張），排法 / 畫布大小換了才重畫一次，拖曳時一直用同一張
  const sceneReady = Object.keys(spans).length > 0;
  const fullW = fullCanvas?.width ?? 0, fullH = fullCanvas?.height ?? 0;
  // 測試圖網格一格 = 一片 LED 箱體：只有箱體設定變了才重畫整張（拖曳不會）
  const cabinetSig = JSON.stringify([draft?.cabinet ?? null, (draft?.items ?? []).map(i => i.cabinet ?? null)]);
  const cabinetPlan = useMemo(
    () => (draft ? { cabinet: draft.cabinet ?? null, screens: draft.items.map(i => ({ key: i.key, cabinet: i.cabinet ?? null })) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cabinetSig],
  );
  const mapLayout = useMemo(() => {
    if (!open || phone || !contentOn || !fullW || !fullH) return null;
    const canvas = { width: fullW, height: fullH };
    if (sceneReady) {
      const lay = applyCabinets(splitLayoutByScreens(layoutFromSpans(ledObjects, spans, canvas), screens), cabinetPlan);
      if (lay.panels.length > 0) return lay;
    }
    return sceneGaveUp ? applyCabinets(wholeCanvasLayout(canvas), cabinetPlan) : null;
  }, [open, phone, contentOn, fullW, fullH, sceneReady, spans, ledObjects, sceneGaveUp, screens, cabinetPlan]);
  const fullMap = useLedFullMap(mapLayout);
  const contentNote = fullMap.error
    ? `對位圖內容畫不出來：${fullMap.error}`
    : fullMap.busy ? '畫圖中…' : !mapLayout ? '等 3D 畫面載好…' : '';

  // 底圖：存在這台電腦的瀏覽器裡（專案 + 版型），不上傳
  const backdrop = useTemplateBackdrop(projectId, open && !phone && draft ? draft.id : undefined);
  const backdropLayer = useMemo<LayerBackdrop | null>(
    () => (backdrop.picture ? { image: backdrop.picture.image, width: backdrop.picture.width, height: backdrop.picture.height, prefs: backdrop.prefs } : null),
    [backdrop.picture, backdrop.prefs],
  );

  const issues = useMemo(() => {
    if (!plan) return [];
    return checkPlacements({ ...plan, screens: plan.screens.filter(p => defKeys.has(p.key)) }, screens);
  }, [plan, screens, defKeys]);
  const orphans = draft ? draft.items.filter(i => !defKeys.has(i.key)).length : 0;
  const placedCount = draft ? draft.items.filter(i => defKeys.has(i.key)).length : 0;
  const itemByKey = useMemo(() => new Map((draft?.items ?? []).map(i => [i.key, i])), [draft]);
  // 選到的：版型裡已經沒有的（復原、拿掉之後）自動排除
  const selected = useMemo(() => pruneSelection(selKeys, k => itemByKey.has(k) && defKeys.has(k)), [selKeys, itemByKey, defKeys]);
  const selSet = useMemo(() => new Set(selected), [selected]);
  const selItems = useMemo(() => (draft?.items ?? []).filter(i => selSet.has(i.key)), [draft, selSet]);
  /** 剛好選一塊：數字欄位照舊；選了好幾塊：整組的外框 */
  const selItem = selItems.length === 1 ? selItems[0] : null;
  const selDef = selItem ? screens.find(s => s.key === selItem.key) ?? null : null;
  const groupBox = useMemo(() => (selItems.length > 1 ? boundsOf(selItems.map(i => i.dest)) : null), [selItems]);

  // ───────── 改草稿 ─────────
  const apply = useCallback((fn: (d: Draft) => Draft, how: PatchHow) => {
    setHist(h => {
      if (!h) return h;
      const next = fn(h.present);
      if (next === h.present) return h;
      return how === 'live' ? transient(h, next) : commit(h, next, { tag: how.tag });
    });
  }, []);
  // 一次改好幾塊 = 草稿只換一次 = 復原只有一步
  const patchItems = useCallback((patches: readonly ItemPatchEntry[], how: PatchHow) => apply(d => patchDraftItems(d, patches), how), [apply]);
  const patchItem = useCallback((key: string, patch: ItemPatch, how: PatchHow) => patchItems([{ key, patch }], how), [patchItems]);
  const onGesture = useCallback((phase: 'start' | 'end') => {
    if (phase === 'start') { gestureBase.current = histRef.current?.present ?? null; return; }
    const base = gestureBase.current;
    gestureBase.current = null;
    setHist(h => (h && base && h.present !== base ? settle(h, base) : h));
  }, []);
  const doUndo = useCallback(() => setHist(h => (h ? undo(h) : h)), []);
  const doRedo = useCallback(() => setHist(h => (h ? redo(h) : h)), []);
  const addScreen = (def: ScreenDef) => { apply(d => addScreenToDraft(d, def), {}); setSelKeys([def.key]); setMode('template'); };
  const removeScreens = (keys: readonly string[]) => { apply(d => removeScreensFromDraft(d, keys), {}); setSelKeys(prev => prev.filter(k => !keys.includes(k))); };
  const removeScreen = (key: string) => removeScreens([key]);
  /** 拿掉選到的螢幕：一塊直接拿掉（可以復原），好幾塊只問一次 */
  async function removeSelected(keys: readonly string[]) {
    if (keys.length === 0) return;
    if (keys.length > 1 && !(await confirmDialog({
      title: `從版型拿掉這 ${keys.length} 塊螢幕？`,
      message: '拿掉的螢幕在 3D 上會顯示黑的。拿掉以後可以按 Ctrl+Z 一次全部復原。',
      confirmLabel: '拿掉', destructive: true,
    }))) return;
    removeScreens(keys);
  }
  /** 整組外框的寬 / 高欄位：左上角不動，整組每一塊的位置和大小乘同樣的倍數 */
  const [lockGroupAspect, setLockGroupAspect] = useState(true);
  const [groupPctText, setGroupPctText] = useState('100');
  // 在寬 / 高欄位裡一個字一個字打（6 → 66 → 660）：每一個字都要從「開始打之前」的樣子算，不然中間縮太小的會回不來
  const scaleBase = useRef<{ tag: string; at: number; rects: PixelRect[] } | null>(null);
  const scaleGroupField = (axis: 'w' | 'h', n: number) => {
    const tag = selectionTag(`g:${axis}`, selected);
    const now = Date.now();
    const b = scaleBase.current;
    const base = b && b.tag === tag && now - b.at <= 600 ? b.rects : selItems.map(i => i.dest);
    scaleBase.current = { tag, at: now, rects: base };
    const rects = scaleGroupTo(base, { [axis]: n }, lockGroupAspect);
    apply(d => patchDraftItems(d, movePatches(selItems, rects)), { tag });
  };
  /** 「整組縮放 %」：50 = 縮成一半大，以整組外框的左上角為準 */
  const applyGroupPct = () => {
    const n = Number(groupPctText.trim());
    if (!/^\d+$/.test(groupPctText.trim()) || n < 1 || n > 1000) { toast.warn('縮放比例請填 1 到 1000 的整數（50 = 縮成一半大，200 = 放大一倍）'); return; }
    if (n === 100) return;
    const rects = scaleGroupPct(selItems.map(i => i.dest), n);
    apply(d => patchDraftItems(d, movePatches(selItems, rects)), {});
    setGroupPctText('100');
  };
  /** 數字欄位改整組外框的左 / 上：整組一起平移 */
  const moveGroup = (axis: 'x' | 'y', n: number) => apply(d => {
    const cur = d.items.filter(i => selSet.has(i.key));
    return patchDraftItems(d, movePatches(cur, moveGroupTo(cur.map(c => c.dest), { [axis]: n })));
  }, { tag: selectionTag(`g:${axis}`, selected) });
  const setMeta = (p: Partial<Pick<Draft, 'name' | 'width' | 'height' | 'scalePct' | 'cabinet'>>, tag: string) => apply(d => ({ ...d, ...p }), { tag });

  // 切換 / 關閉前：有沒存的修改要問
  async function askDiscard(): Promise<boolean> {
    if (!dirty || (draft && !draft.id && draft.items.length === 0)) return true;
    return confirmDialog({ title: '還沒存的修改要丟掉嗎？', message: '這個版型改的地方還沒按「儲存」。', confirmLabel: '丟掉', destructive: true });
  }
  async function tryClose() {
    if (busy) return;
    if (!(await askDiscard())) return;
    setHist(null); setSavedSig(''); setSelectedTpl(''); loadedFor.current = '';
    onClose();
  }
  async function pick(id: string) {
    if (id === selectedTpl || busy) return;
    if (!(await askDiscard())) return;
    loadedFor.current = '';
    if (id === NEW) { startNew(); return; }
    setHist(null);
    setSavedSig('');
    setSelectedTpl(id);
  }
  function startNew() {
    const d = emptyDraft(nextTemplateName((list?.templates ?? []).map(t => t.name)), fullCanvas ?? { width: 1920, height: 1080 });
    setHist(newHistory(d));
    setSavedSig('');
    setSelKeys([]);
    setSelectedTpl(NEW);
    setMode('template');
  }

  const validate = (d: Draft) => {
    const parsed = normalizeTemplateInput(draftToBody(d, defKeys), { partial: false });
    return parsed.ok ? { body: draftToBody(d, defKeys) } : { error: parsed.error };
  };
  const afterSave = async (name: string) => {
    const next = (await onChanged()) as LedTemplateList | null | undefined;
    return next?.templates.find(t => t.kind === 'custom' && t.name === name)?.id ?? '';
  };

  async function save() {
    if (!draft || busy) return;
    const v = validate(draft);
    if (!v.body) { toast.error(v.error!); return; }
    setBusy(true);
    try {
      if (draft.id) await updateLedTemplate(projectId, draft.id, v.body);
      else await createLedTemplate(projectId, v.body);
      // 存好的樣子就是現在的草稿（拿掉模型裡找不到的螢幕）
      const kept: Draft = { ...draft, items: draft.items.filter(i => defKeys.has(i.key)) };
      setHist(h => (h ? { ...h, present: kept } : h));
      setSavedSig(draftSignature(kept));
      const newId = await afterSave(v.body.name);
      toast.success(`版型「${v.body.name}」存好了`);
      if (!draft.id && newId) {
        await backdrop.adopt(projectId, null, newId);   // 還沒存的時候載入的底圖，跟著換成真正的版型代號
        loadedFor.current = '';
        setSelectedTpl(newId);
      }
    } catch (e) {
      toast.error('沒有存好：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!draft || busy) return;
    const taken = (list?.templates ?? []).map(t => t.name);
    const name = await promptDialog({
      title: '複製版型',
      label: '新版型的名稱',
      defaultValue: copyTemplateName(draft.name, taken),
      confirmLabel: '複製',
      maxLength: 40,
      hint: draft.id && dirty ? '會連同你還沒存的修改一起複製；原本的版型維持現在的樣子。' : '複製以後可以直接改。',
      validate: (v) => {
        const n = normalizeTemplateName(v);
        if (!n.ok) return n.error;
        return taken.some(t => t.toLowerCase() === n.value.toLowerCase()) ? '已經有同名的版型了，請換一個名字' : null;
      },
    });
    if (!name) return;
    const body = { ...draftToBody(draft, defKeys), name: name.trim().replace(/\s+/g, ' ') };
    setBusy(true);
    try {
      await createLedTemplate(projectId, body);
      const newId = await afterSave(body.name);
      toast.success(`複製好了：「${body.name}」`);
      if (newId) { loadedFor.current = ''; setHist(null); setSavedSig(''); setSelectedTpl(newId); }
    } catch (e) {
      toast.error('沒有複製成功：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft || busy) return;
    if (!draft.id) {
      if (!(await askDiscard())) return;
      setHist(null); setSavedSig(''); setSelectedTpl(''); loadedFor.current = '';
      return;
    }
    if (!(await confirmDialog({
      title: `刪除版型「${draft.name}」？`,
      message: '已經交的影片版本會記住當時的排法，不受影響。還有歌在用這個版型的話要先改成別的。',
      confirmLabel: '刪除', destructive: true,
    }))) return;
    setBusy(true);
    try {
      await deleteLedTemplate(projectId, draft.id);
      void backdrop.purge(projectId, draft.id);
      setHist(null); setSavedSig(''); setSelectedTpl(''); loadedFor.current = '';
      await onChanged();
      toast.success('版型刪掉了');
    } catch (e) {
      toast.error('沒有刪掉：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function downloadGuide() {
    if (!draft || !plan || busy) return;
    if (placedCount === 0) { toast.warn('版型裡還沒有螢幕：先把螢幕「加入版型」'); return; }
    setBusy(true);
    try {
      const shown = { ...plan, screens: plan.screens.filter(p => defKeys.has(p.key)) };
      await new Promise(r => requestAnimationFrame(() => r(null)));
      const { png, fileName } = await renderTemplateGuideFile(shown, screens, projectName ?? '', guideContentFor(screens, downloadMeta(), shown));
      if (png.scale < 1) toast.warn(guideShrinkWarning(png, shown.canvas));
      else toast.success(`模板圖下載好了（${png.width}×${png.height}）`);
      downloadBlob(png.blob, fileName);
    } catch (e) {
      toast.error('下載不了模板圖：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  /** 下載用的畫布資料：整張畫布大小 + 3D 物件範圍排出來的測試圖排法（跟編輯器框裡看到的同一張） */
  function downloadMeta() {
    const layout = fullCanvas && sceneReady ? layoutFromSpans(ledObjects, spans, fullCanvas) : null;
    return { projectName: projectName ?? '', date: todayString(), fullCanvas: fullCanvas ?? { width: 0, height: 0 }, layout: layout && layout.panels.length > 0 ? layout : null };
  }

  /** 每塊 LED 一張圖 + AE 腳本（zip）：跟「下載模板圖」一樣照現在編輯的樣子（沒存也可以） */
  async function downloadTiles() {
    if (!draft || !plan || busy) return;
    if (!fullCanvas) { toast.warn('還沒填這個專案的 LED 畫布大小'); return; }
    if (placedCount === 0) { toast.warn('版型裡還沒有螢幕：先把螢幕「加入版型」'); return; }
    setBusy(true);
    try {
      await new Promise(r => requestAnimationFrame(() => r(null)));   // 先讓「忙碌中」顯示出來再開始畫（大畫布要一兩秒）
      const shown = { ...plan, screens: plan.screens.filter(p => defKeys.has(p.key)) };
      const r = await downloadTemplateTilesZip(shown, screens, downloadMeta());
      toast.success(`每塊 LED 的圖（${r.count} 塊）下載好了：解壓縮後，在 AE 按「File > Scripts > Run Script File…」選裡面的 AE建合成腳本.jsx${r.shrunk ? '（有幾塊太大，圖縮小了，AE 腳本會自動放大回來）' : ''}`, 9000);
    } catch (e) {
      toast.error('每塊 LED 的圖沒做出來：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  /** 座標表（給 LED 工程師、d3 操作員）：CSV 或 JSON */
  function downloadTable(kind: 'csv' | 'json') {
    if (!draft || !plan || busy) return;
    if (!fullCanvas) { toast.warn('還沒填這個專案的 LED 畫布大小'); return; }
    if (placedCount === 0) { toast.warn('版型裡還沒有螢幕：先把螢幕「加入版型」'); return; }
    try {
      const shown = { ...plan, screens: plan.screens.filter(p => defKeys.has(p.key)) };
      downloadTemplateTable(kind, shown, screens, { projectName: projectName ?? '', date: todayString(), fullCanvas });
      toast.success(kind === 'csv' ? '座標表下載好了（CSV，Excel 打得開）' : '座標表下載好了（JSON）');
    } catch (e) {
      toast.error('下載不了座標表：' + msg(e));
    }
  }

  async function createSplit(input: { objectId: string; name: string; rect: PixelRect }): Promise<boolean> {
    if (!fullCanvas) return false;
    setBusy(true);
    try {
      await createLedScreen(projectId, { objectId: input.objectId, name: input.name, uv: rectToUv(input.rect, fullCanvas) });
      await onChanged();
      toast.success(`切出「${input.name}」了，現在可以把它放進版型`);
      return true;
    } catch (e) {
      toast.error('沒有切開：' + msg(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function removeSplit(id: string, name: string) {
    if (!(await confirmDialog({ title: `刪掉切開的螢幕「${name}」？`, message: '版型裡放著它的那一格也會一起拿掉；已經交的影片版本不受影響。', confirmLabel: '刪掉', destructive: true }))) return;
    setBusy(true);
    try { await deleteLedScreen(projectId, id); await onChanged(); } catch (e) { toast.error('沒有刪掉：' + msg(e)); } finally { setBusy(false); }
  }

  const fitCanvas = () => {
    const fit = fitCanvasToItems(draft?.items.filter(i => defKeys.has(i.key)) ?? []);
    if (!fit) { toast.warn('先把要放進版型的螢幕「加入版型」'); return; }
    apply(d => ({ ...d, width: fit.width, height: fit.height }), {});
  };

  const splitObjects = useMemo(
    () => ledObjects.map((o, index) => ({ objectId: o.id, name: o.name, src: spans[o.id] ?? WHOLE, index })),
    [ledObjects, spans],
  );
  const colorOf = (s: ScreenDef) => panelColor(screens.indexOf(s));

  // 所有 hook 都在上面；沒打開就什麼都不畫
  if (!open) return null;

  if (phone) {
    return (
      <div className="ledtpl-phone" role="dialog" aria-modal="true" aria-labelledby="ledtpl-phone-title">
        <div className="ledtpl-phone__box">
          <Icon icon={Monitor} size="xl" />
          <h2 id="ledtpl-phone-title">請用電腦編輯版型</h2>
          <p className="muted">版型要在畫布上拖曳、縮放螢幕，手機的畫面太小了。請改用電腦，或把 iPad 橫放。</p>
          <button className="btn btn--primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    );
  }

  const scaleIsChoice = !!draft && SCALE_CHOICES.includes(draft.scalePct);
  const resetKey = draft ? `${draft.id ?? NEW}` : '';

  return (
    <section className="ledtpl-dock" role="region" aria-label="LED 版型編輯">
      <header className="ledtpl-dock__head">
        <h2><Icon icon={LayoutPanelLeft} size="md" /> LED 版型</h2>
        {list && fullCanvas && (
          <>
            <select className="ledtpl-dock__pick" value={selectedTpl} onChange={(e) => void pick(e.target.value)} aria-label="選版型" disabled={busy}>
              {!selectedTpl && <option value="">{customs.length ? '選一個版型…' : '還沒有版型'}</option>}
              {customs.map(t => <option key={t.id} value={t.id}>{t.name}（{t.canvas.width}×{t.canvas.height} · {formatPct(t.scalePct)} · {t.screens.length} 塊{t.songCount > 0 ? ` · ${t.songCount} 首歌在用` : ''}）</option>)}
              {selectedTpl === NEW && draft && <option value={NEW}>{draft.name}（新版型，還沒存）</option>}
            </select>
            <button className="btn btn--ghost" onClick={() => void pick(NEW)} disabled={busy} title="新增一個空的版型"><Icon icon={Plus} /> 新增版型</button>
            <button className="btn btn--ghost" onClick={() => void duplicate()} disabled={busy || !draft} title="複製現在這個版型，取個新名字再改"><Icon icon={Copy} /> 複製版型</button>
          </>
        )}
        <span className="ledtpl-dock__spacer" />
        {dirty && <span className="ledtpl-dock__dirty">有還沒存的修改</span>}
        {draft && (
          <>
            <button className="btn btn--ghost" onClick={() => void downloadGuide()} disabled={busy} title="下載版型畫布大小的 PNG（每塊螢幕的長方形、名字、像素大小、指著上方的箭頭），給動畫師當 AE 的參考圖層"><Icon icon={Download} /> 下載模板圖</button>
            <button className="btn btn--ghost" onClick={() => void downloadTiles()} disabled={busy} title="下載一個 zip：每塊 LED 一張圖（大小就是那塊在畫布上的像素）、座標表，還有一支 AE 腳本，在 AE 跑一下就會每塊 LED 建一個合成，再建一個整張畫布大小的總合成"><Icon icon={FileCode} /> 下載每塊 LED 的圖 + AE</button>
            <span className="ledtpl-dock__hint">解壓縮後，AE 執行裡面的腳本，輸出「總合成」</span>
            <OverflowMenu
              label="下載座標表（選 CSV 或 JSON）"
              align="auto"
              trigger={{ icon: FileSpreadsheet, text: '下載座標表', className: 'btn btn--ghost' }}
              items={[
                { key: 'csv', label: 'CSV（Excel 打得開）', icon: FileSpreadsheet, onSelect: () => downloadTable('csv') },
                { key: 'json', label: 'JSON（給程式讀）', icon: FileBraces, onSelect: () => downloadTable('json') },
              ]}
            />
            <button className="btn btn--ghost ledtpl-dock__danger" onClick={() => void remove()} disabled={busy}><Icon icon={Trash2} /> {draft.id ? '刪除版型' : '放棄'}</button>
            <button className="btn btn--primary" onClick={() => void save()} disabled={busy || !dirty}><Icon icon={busy ? LoaderCircle : Save} spin={busy} /> 儲存</button>
          </>
        )}
        <button className="ledtpl-dock__close" onClick={() => void tryClose()} title="關閉版型編輯" aria-label="關閉版型編輯"><Icon icon={X} size="md" /></button>
      </header>

      {!list ? (
        <div className="ledtpl-dock__empty muted">這個後台還沒有版型功能，或讀取失敗了。請重新整理。</div>
      ) : !fullCanvas ? (
        <div className="ledtpl-dock__empty">
          <Icon icon={TriangleAlert} size="lg" />
          <div>還沒填這個專案的 LED 畫布大小。</div>
          {onSetCanvas ? (
            <>
              <small className="muted">填 AE 合成（整張畫布）的寬 × 高，每塊螢幕的真實點數從它算。</small>
              <form
                className="ledtpl-dock__canvasform"
                onSubmit={e => {
                  e.preventDefault();
                  const r = parseCanvasFields(canvasW, canvasH);
                  if ('error' in r) { setCanvasErr(r.error); return; }
                  setCanvasErr('');
                  onSetCanvas(r.canvas);
                }}
              >
                <input className="input" inputMode="numeric" placeholder="寬" aria-label="畫布寬（像素）" value={canvasW} onChange={e => setCanvasW(e.target.value)} />
                <span>×</span>
                <input className="input" inputMode="numeric" placeholder="高" aria-label="畫布高（像素）" value={canvasH} onChange={e => setCanvasH(e.target.value)} />
                <button type="submit" className="btn btn--primary">設定</button>
              </form>
              {canvasErr && <small className="ledtpl-dock__canvaserr">{canvasErr}</small>}
            </>
          ) : (
            <small className="muted">先到 3D 畫面工具列的「更多」→ LED 對位圖，填 AE 合成的寬 × 高（每塊螢幕的真實點數從它算），再回來建立版型。</small>
          )}
        </div>
      ) : !draft ? (
        <div className="ledtpl-dock__empty">
          <div className="muted">{customs.length ? '選一個版型來編輯，' : '還沒有版型。'}或新增一個。3D 畫面上方的 LED 會顯示這個版型的測試圖，擺放的結果一看就知道。</div>
          <button className="btn btn--primary" onClick={() => void pick(NEW)}><Icon icon={Plus} /> 新增版型</button>
        </div>
      ) : (
        <div className="ledtpl-dock__body">
          <div className="ledtpl-dock__stage">
            <div className="ledtpl-fields">
              <label>名稱
                <input value={draft.name} maxLength={40} onChange={(e) => setMeta({ name: e.target.value }, 'name')} />
              </label>
              <label>畫布（影片大小）
                <span className="ledtpl-pair">
                  <NumField value={draft.width} min={16} max={32768} label="畫布寬" onChange={(n) => setMeta({ width: n }, 'canvas-w')} />
                  <span>×</span>
                  <NumField value={draft.height} min={16} max={32768} label="畫布高" onChange={(n) => setMeta({ height: n }, 'canvas-h')} />
                </span>
              </label>
              <label>比例
                <span className="ledtpl-pair">
                  <select value={scaleIsChoice ? String(draft.scalePct) : 'custom'} onChange={(e) => setMeta({ scalePct: e.target.value === 'custom' ? 75 : Number(e.target.value) }, 'scale')} title="螢幕比 LED 真實點數縮了多少（50% 就是一半大）。只影響預設大小和「被拉伸」的提醒">
                    {SCALE_CHOICES.map(n => <option key={n} value={n}>{n}%</option>)}
                    <option value="custom">自訂</option>
                  </select>
                  {!scaleIsChoice && <NumField value={draft.scalePct} min={1} max={400} label="比例（%）" onChange={(n) => setMeta({ scalePct: n }, 'scale')} />}
                </span>
              </label>
              <label>預設箱體（網格一格）
                <CabinetPicker label="版型預設箱體" value={draft.cabinet ?? null} onChange={(c) => setMeta({ cabinet: c }, 'cabinet')} />
              </label>
              <button className="btn btn--ghost" onClick={fitCanvas} title="畫布寬高改成剛好包住放進去的螢幕">畫布剛好包住螢幕</button>
              <span className="ledtpl-seg" role="group" aria-label="顯示哪張畫布">
                <button className={mode === 'template' ? 'is-on' : ''} aria-pressed={mode === 'template'} onClick={() => setMode('template')}>版型畫布</button>
                <button className={mode === 'full' ? 'is-on' : ''} aria-pressed={mode === 'full'} onClick={() => setMode('full')} title="在整張畫布上拖出範圍，把一個 LED 物件切成好幾塊螢幕"><Icon icon={Scissors} size="xs" /> 整張畫布（切螢幕）</button>
              </span>
            </div>

            {mode === 'template' ? (
              <LedTemplateCanvas
                canvas={{ width: draft.width, height: draft.height }}
                scalePct={draft.scalePct}
                defs={screens}
                items={draft.items}
                selected={selected}
                resetKey={resetKey}
                canUndo={!!hist && hist.past.length > 0}
                canRedo={!!hist && hist.future.length > 0}
                onSelect={setSelKeys}
                onPatch={patchItems}
                onGesture={onGesture}
                onRemove={removeSelected}
                onUndo={doUndo}
                onRedo={doRedo}
                onCenter={axis => apply(d => {
                  const pick = d.items.filter(i => selSet.size === 0 || selSet.has(i.key));
                  return patchDraftItems(d, movePatches(pick, centerGroupOnCanvas(pick.map(c => c.dest), { width: d.width, height: d.height }, axis)));
                }, {})}
                fullMap={fullMap.map}
                showContent={contentOn}
                contentOpacity={contentOpacity}
                backdrop={backdropLayer}
                layersBar={(
                  <LedTemplateLayers
                    contentOn={contentOn}
                    onContentOn={setContentOn}
                    contentOpacity={contentOpacity}
                    onContentOpacity={setContentOpacity}
                    contentNote={contentNote}
                    backdrop={backdrop}
                    canvas={{ width: draft.width, height: draft.height }}
                  />
                )}
              />
            ) : (
              <LedSplitCanvas
                fullCanvas={fullCanvas}
                objects={splitObjects}
                manuals={manuals ?? []}
                resetKey={resetKey}
                busy={busy}
                onCreate={createSplit}
              />
            )}

            {(issues.length > 0 || orphans > 0) && (
              <ul className="ledtpl-issues" role="status">
                {issues.map((i, n) => <li key={n}><Icon icon={TriangleAlert} size="xs" /> {i.text}</li>)}
                {orphans > 0 && <li><Icon icon={TriangleAlert} size="xs" /> 有 {orphans} 塊螢幕在模型裡找不到（模型換過、物件刪掉了，或已經被切開），存檔時會拿掉</li>}
              </ul>
            )}
          </div>

          <aside className="ledtpl-side">
            <h3>螢幕 <small className="muted">{placedCount} / {screens.length} 塊在這個版型裡</small></h3>
            {screens.length === 0 && <p className="muted small">這個專案還沒有 LED 物件。</p>}
            <ul className="ledtpl-screens">
              {screens.map(s => {
                const it = itemByKey.get(s.key);
                return (
                  <li key={s.key} className={(it ? 'is-in' : '') + (selSet.has(s.key) ? ' is-sel' : '')} onClick={(e) => { if (it) { setSelKeys(prev => clickSelect(prev, s.key, isAdditive(e))); setMode('template'); } }}>
                    <span className="ledtpl-dot" style={{ background: colorOf(s) }} aria-hidden="true" />
                    <span className="ledtpl-screens__name" title={s.name}>
                      <strong>{s.name}{s.manual ? '（切開的）' : ''}</strong>
                      <small className="muted">{it ? screenSizeLabel(s, it) : `實際 ${s.nativeW}×${s.nativeH}，不在版型裡（顯示黑的）`}</small>
                    </span>
                    {mode === 'full' && s.manual ? (
                      <button className="btn btn--ghost ledtpl-mini" onClick={(e) => { e.stopPropagation(); void removeSplit(s.key.slice(2), s.name); }} disabled={busy} title="刪掉這塊切開的螢幕"><Icon icon={Trash2} size="xs" /> 刪掉</button>
                    ) : it ? (
                      <button className="btn btn--ghost ledtpl-mini" onClick={(e) => { e.stopPropagation(); removeScreen(s.key); }} title="從這個版型拿掉（這塊螢幕就顯示黑的）">拿掉</button>
                    ) : (
                      <button className="btn ledtpl-mini" onClick={(e) => { e.stopPropagation(); addScreen(s); }} title="加進版型：真實點數 × 比例的大小，放在畫布上的空位"><Icon icon={Plus} size="xs" /> 加入版型</button>
                    )}
                  </li>
                );
              })}
            </ul>

            {mode === 'template' && selItem && selDef && (
              <div className="ledtpl-sel" role="group" aria-label={`選到的螢幕：${selDef.name}`}>
                <h4>{selDef.name} <small className="muted">{screenSizeLabel(selDef, selItem)}</small></h4>
                <div className="ledtpl-sel__grid">
                  {(['x', 'y', 'w', 'h'] as const).map(k => (
                    <label key={k}>{k === 'x' ? '左' : k === 'y' ? '上' : k === 'w' ? '寬' : '高'}
                      <NumField
                        value={selItem.dest[k]}
                        min={k === 'w' || k === 'h' ? 1 : -65536}
                        label={`${selDef.name} ${k === 'x' ? '左' : k === 'y' ? '上' : k === 'w' ? '寬' : '高'}`}
                        onChange={(n) => patchItem(selItem.key, { dest: { ...selItem.dest, [k]: n } }, { tag: `f:${selItem.key}:${k}` })}
                      />
                    </label>
                  ))}
                </div>
                <div className="ledtpl-sel__row">
                  <label>轉動
                    <select value={selItem.rotate} onChange={(e) => patchItem(selItem.key, setRotation(selItem, Number(e.target.value) as Rotation), {})}>
                      {ROTATIONS.map(d => <option key={d} value={d}>{d}°</option>)}
                    </select>
                  </label>
                  <label className="ledtpl-check"><input type="checkbox" checked={selItem.flipH} onChange={(e) => patchItem(selItem.key, { flipH: e.target.checked }, {})} /> 左右翻轉</label>
                  <label className="ledtpl-check"><input type="checkbox" checked={selItem.flipV} onChange={(e) => patchItem(selItem.key, { flipV: e.target.checked }, {})} /> 上下翻轉</label>
                </div>
                <div className="ledtpl-sel__row">
                  <label>箱體（網格一格）
                    <CabinetPicker
                      label={`${selDef.name} 箱體`}
                      inheritLabel={`跟版型（${resolveCabinet(null, draft.cabinet).w} × ${resolveCabinet(null, draft.cabinet).h}）`}
                      value={selItem.cabinet ?? null}
                      onChange={(c) => apply(d => setItemsCabinet(d, [selItem.key], c), { tag: `cab:${selItem.key}` })}
                    />
                  </label>
                  <small className="muted">{(() => { const g = gridCells({ w: selDef.nativeW, h: selDef.nativeH }, resolveCabinet(selItem.cabinet, draft.cabinet)); return `${g.cols} × ${g.rows} 格`; })()}</small>
                </div>
                <div className="ledtpl-sel__row">
                  <button className="btn btn--ghost" onClick={() => apply(d => resetItemSize(d, selDef), {})} title="大小改回「真實點數 × 比例」">標準大小</button>
                  <button className="btn btn--ghost" onClick={() => removeScreen(selItem.key)}>從版型拿掉</button>
                </div>
              </div>
            )}
            {mode === 'template' && groupBox && (
              <div className="ledtpl-sel" role="group" aria-label={`選到 ${selItems.length} 塊螢幕`}>
                <h4>已選 {selItems.length} 塊 <small className="muted">整組的外框 {groupBox.w} × {groupBox.h}：改左、上是整組一起移動，改寬、高是整組一起縮放（左上角不動）</small></h4>
                <div className="ledtpl-sel__grid">
                  {(['x', 'y', 'w', 'h'] as const).map(k => {
                    const name = k === 'x' ? '整組左' : k === 'y' ? '整組上' : k === 'w' ? '整組寬' : '整組高';
                    return (
                      <label key={k}>{name.slice(2)}
                        <NumField
                          value={groupBox[k]}
                          min={k === 'w' || k === 'h' ? 1 : -65536}
                          label={name}
                          onChange={(n) => (k === 'x' || k === 'y' ? moveGroup(k, n) : scaleGroupField(k, n))}
                        />
                      </label>
                    );
                  })}
                </div>
                <div className="ledtpl-sel__row">
                  <label className="ledtpl-check" title="改寬或高的時候，另一邊照整組的長寬比跟著變">
                    <input type="checkbox" checked={lockGroupAspect} onChange={(e) => setLockGroupAspect(e.target.checked)} /> 鎖長寬比
                  </label>
                  <form className="ledtpl-sel__pct" onSubmit={(e) => { e.preventDefault(); applyGroupPct(); }}>
                    <label>整組縮放 %
                      <input
                        className="ledtpl-sel__pctinput"
                        inputMode="numeric"
                        value={groupPctText}
                        aria-label="整組縮放百分比"
                        title="50 = 縮成一半大、200 = 放大一倍，以整組外框的左上角為準"
                        onChange={(e) => setGroupPctText(e.target.value)}
                      />
                    </label>
                    <button type="submit" className="btn btn--ghost">縮放</button>
                  </form>
                </div>
                <ul className="ledtpl-sel__names" aria-label="選到的螢幕">
                  {selItems.map(i => {
                    const def = screens.find(s => s.key === i.key);
                    return def ? (
                      <li key={i.key}>
                        <span className="ledtpl-dot" style={{ background: colorOf(def) }} aria-hidden="true" />
                        <span title={def.name}>{def.name}</span>
                      </li>
                    ) : null;
                  })}
                </ul>
                <div className="ledtpl-sel__row">
                  <label>箱體（網格一格）
                    <CabinetPicker
                      label="選到的螢幕箱體"
                      inheritLabel={`跟版型（${resolveCabinet(null, draft.cabinet).w} × ${resolveCabinet(null, draft.cabinet).h}）`}
                      value={selItems.every(i => cabinetsEqual(i.cabinet, selItems[0].cabinet)) ? (selItems[0].cabinet ?? null) : null}
                      mixed={!selItems.every(i => cabinetsEqual(i.cabinet, selItems[0].cabinet))}
                      onChange={(c) => apply(d => setItemsCabinet(d, selItems.map(i => i.key), c), { tag: 'cab:group' })}
                    />
                  </label>
                </div>
                <p className="muted small">畫布上方的「轉 90°」「左右翻轉」「上下翻轉」會讓每一塊各自在原地轉、翻。</p>
                <div className="ledtpl-sel__row">
                  <button className="btn btn--ghost" onClick={() => void removeSelected(selected)}>從版型拿掉這 {selItems.length} 塊</button>
                </div>
              </div>
            )}
            {mode === 'template' && selItems.length === 0 && placedCount > 0 && <p className="muted small">點畫布上的螢幕（或清單裡的名字）來選它，就能在這裡改數字。按住 Shift 或 Ctrl 可以加選，在畫布空白處拖曳可以框選好幾塊。</p>}
          </aside>
        </div>
      )}
    </section>
  );
}

