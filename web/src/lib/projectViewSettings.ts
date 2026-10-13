// 專案共用的 3D 檢視設定：測距校準倍率 + 機關滑桿位移 + 現場模式設定
//
// 用法（每個顯示 StageScene 的頁面）：
//   const view = useProjectViewSettings(projectId, user?.role === 'admin');
//   <StageScene scaleCorrection={view.scaleCorrection}
//               onScaleCorrectionChange={view.canEdit ? view.setScaleCorrection : undefined}
//               mechanismOffsets={view.mechanismOffsets}
//               lookSettings={personalLook.effective}       // usePersonalLook(projectId, view.lookSettings)
//               onLookSettingsChange={personalLook.set}     // 每個人調自己的，存在自己電腦
//               onLookSaveAsDefault={view.canEdit ? () => view.setLookSettings(personalLook.effective) : undefined}
//               materialOverrides={view.materialOverrides}  // admin 調的，存在專案上
//               onMaterialOverrideChange={view.canEdit ? view.setMaterialOverride : undefined} />
//
// 之前校準 / 滑桿存在各自瀏覽器的 localStorage → 導演 / 動畫師 / 換電腦都看不到。
// 現在存在 project 上（worker 只允許 admin 改）；admin 第一次打開時會把舊瀏覽器裡的值搬上去。
// 材質 / 重置視角一律以專案上存的為準：以前在自己電腦留的暫存（會把舊值補存回專案、蓋掉別台電腦的修改）
// 已經拿掉，打開時順便清掉（legacyViewCache.ts）。

import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import type { MechanismOffsets } from './api';
import { toast } from './toast';
import { DEFAULT_LOOK_SETTINGS, normalizeLookSettings, type LookSettings } from './stageLook/lookSettings';
import { normalizeMaterialOverrides, type MaterialOverride, type MaterialOverrides } from './stageLook/materialOverrides';
import type { HomeView } from './homeView';
import { clearLegacyViewCaches } from './legacyViewCache';
import { normalizeLedCanvas, type LedCanvas } from './ledCanvas';

const SAVE_DELAY_MS = 500;  // 滑桿停手多久才存

// 2026-10 前存在瀏覽器的 key
const legacyScaleKey = (projectId: string) => `scale-correction:${projectId}`;
const legacyMechanismKey = (projectId: string) => `mechanism-offsets:${projectId}`;

function readLegacy(projectId: string): { scale: number | null; offsets: MechanismOffsets | null } {
  let scale: number | null = null;
  let offsets: MechanismOffsets | null = null;
  try {
    const s = parseFloat(localStorage.getItem(legacyScaleKey(projectId)) || '');
    if (isFinite(s) && s > 0) scale = s;
    const raw = localStorage.getItem(legacyMechanismKey(projectId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) offsets = parsed;
    }
  } catch { /* private mode / 壞資料 → 當沒有 */ }
  return { scale, offsets };
}

function clearLegacy(projectId: string) {
  try {
    localStorage.removeItem(legacyScaleKey(projectId));
    localStorage.removeItem(legacyMechanismKey(projectId));
  } catch { /* ignore */ }
}

const hasNonZero = (o: MechanismOffsets) => Object.values(o).some(v => v && (v.x || v.y));

export interface ProjectViewSettingsState {
  scaleCorrection: number;
  mechanismOffsets: MechanismOffsets;
  lookSettings: LookSettings;
  materialOverrides: MaterialOverrides;
  /** 🎥 重置攝影機的畫面（null = 自動正面全景） */
  homeView: HomeView | null;
  /** AE 畫布尺寸（NDI Webcam 預覽用；null = 還沒填） */
  ledCanvas: LedCanvas | null;
  canEdit: boolean;
  /** 專案設定讀完了沒（讀失敗也算完，用預設值）；還沒讀完時校準倍率還是預設的 1 */
  loaded: boolean;
  setScaleCorrection: (n: number) => void;
  updateMechanismOffset: (objId: string, axis: 'x' | 'y', value: number) => void;
  resetAllMechanismOffsets: () => void;
  setLookSettings: (patch: Partial<LookSettings>) => void;
  /** patch = null → 這個材質回到 C4D 原本 */
  setMaterialOverride: (name: string, patch: Partial<MaterialOverride> | null) => void;
  /** null → 回到自動正面全景 */
  setHomeView: (view: HomeView | null) => void;
  /** null → 清掉（還沒填）；不合法的值會被當成 null */
  setLedCanvas: (v: LedCanvas | null) => void;
}

export function useProjectViewSettings(projectId: string | undefined, canEdit: boolean): ProjectViewSettingsState {
  const [scaleCorrection, setScale] = useState(1);
  const [mechanismOffsets, setOffsets] = useState<MechanismOffsets>({});
  const [lookSettings, setLook] = useState<LookSettings>(DEFAULT_LOOK_SETTINGS);
  const [materialOverrides, setMaterials] = useState<MaterialOverrides>({});
  const [homeView, setHomeViewState] = useState<HomeView | null>(null);
  const [ledCanvas, setLedCanvasState] = useState<LedCanvas | null>(null);
  const [loaded, setLoaded] = useState(false);
  // ref 跟 state 同步：存檔 / 失敗回滾要拿「目前值」，不想把 callback 綁在 state 上
  const scaleRef = useRef(1);
  const offsetsRef = useRef<MechanismOffsets>({});
  const lookRef = useRef<LookSettings>(DEFAULT_LOOK_SETTINGS);
  const materialsRef = useRef<MaterialOverrides>({});
  // 還沒送出的修改（滑桿 / 現場設定），停手 SAVE_DELAY_MS 後合併成一次存
  const pendingRef = useRef<{ timer: number; projectId: string; patch: Partial<api.ProjectViewSettings> } | null>(null);
  // 存檔失敗的提示一個頁面只跳一次（拖滑桿時不要一直跳）
  const saveErrorShownRef = useRef(false);

  const applyScale = (n: number) => { scaleRef.current = n; setScale(n); };
  const applyOffsets = (o: MechanismOffsets) => { offsetsRef.current = o; setOffsets(o); };
  const applyLook = (s: LookSettings) => { lookRef.current = s; setLook(s); };
  const applyMaterials = (m: MaterialOverrides) => { materialsRef.current = m; setMaterials(m); };

  // 立刻送出還沒存的修改（切專案 / 離開頁面 / 關分頁時）
  const flushPending = useCallback((keepalive = false) => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    api.updateProjectViewSettings(p.projectId, p.patch, { keepalive }).catch(e => {
      if (saveErrorShownRef.current) return;
      saveErrorShownRef.current = true;
      console.warn('[viewSettings] save failed', e);
      toast.error('設定沒有存到專案上（網路或伺服器有問題），請稍後再調一次');
    });
  }, []);

  // 載入專案設定（+ admin 搬舊瀏覽器資料）
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    applyScale(1);
    applyOffsets({});
    applyLook(DEFAULT_LOOK_SETTINGS);
    applyMaterials({});
    setHomeViewState(null);
    setLedCanvasState(null);
    setLoaded(false);
    // 舊版在這台電腦留的材質 / 重置視角暫存：不再讀、不再補存回專案（會蓋掉別台電腦的修改），清掉
    try { clearLegacyViewCaches(localStorage); } catch { /* 無痕模式 / 讀不到 storage → 不用清 */ }
    (async () => {
      let settings: api.ProjectViewSettings;
      try {
        settings = await api.getProjectViewSettings(projectId);
      } catch {
        // 讀不到就維持預設（未校準 / 沒位移 / 預設現場設定 / 沒調材質 / 自動視角）
        if (!cancelled) setLoaded(true);
        return;
      }
      if (cancelled) return;

      if (canEdit) {
        const legacy = readLegacy(projectId);
        const patch: Partial<api.ProjectViewSettings> = {};
        // 只有專案上還沒有值時才搬，不蓋掉別人已經存的
        if (settings.scaleCorrection === 1 && legacy.scale !== null && legacy.scale !== 1) {
          patch.scaleCorrection = legacy.scale;
        }
        if (!hasNonZero(settings.mechanismOffsets) && legacy.offsets && hasNonZero(legacy.offsets)) {
          patch.mechanismOffsets = legacy.offsets;
        }
        let migrated = true;
        if (Object.keys(patch).length > 0) {
          try {
            await api.updateProjectViewSettings(projectId, patch);
            settings = { ...settings, ...patch };
            toast.info('已把這台電腦上的校準 / 機關滑桿數值存到專案，所有人都看得到了');
          } catch {
            migrated = false;  // 下次再試，先別清
          }
        }
        if (migrated) clearLegacy(projectId);
        if (cancelled) return;
      }

      applyScale(settings.scaleCorrection);
      applyOffsets(settings.mechanismOffsets);
      applyLook(settings.lookSettings);
      setLedCanvasState(settings.ledCanvas);
      applyMaterials(settings.materialOverrides);
      setHomeViewState(settings.homeView);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
      flushPending();
    };
  }, [projectId, canEdit, flushPending]);

  // 關分頁時把最後一次修改送出
  useEffect(() => {
    const onUnload = () => flushPending(true);
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, [flushPending]);

  const setScaleCorrection = useCallback((n: number) => {
    if (!projectId || !canEdit) return;
    const prev = scaleRef.current;
    applyScale(n);
    api.updateProjectViewSettings(projectId, { scaleCorrection: n }).catch(e => {
      applyScale(prev);
      toast.error('校準儲存失敗：' + (e instanceof Error ? e.message : String(e)));
    });
  }, [projectId, canEdit]);

  const scheduleSave = useCallback((patch: Partial<api.ProjectViewSettings>) => {
    if (!projectId) return;
    const prev = pendingRef.current;
    if (prev) clearTimeout(prev.timer);
    const merged = prev && prev.projectId === projectId ? { ...prev.patch, ...patch } : patch;
    pendingRef.current = {
      projectId,
      patch: merged,
      timer: window.setTimeout(() => flushPending(), SAVE_DELAY_MS),
    };
  }, [projectId, flushPending]);

  const updateMechanismOffset = useCallback((objId: string, axis: 'x' | 'y', value: number) => {
    if (!canEdit) return;
    const cur = offsetsRef.current;
    const next = { ...cur, [objId]: { ...(cur[objId] || { x: 0, y: 0 }), [axis]: value } };
    applyOffsets(next);
    scheduleSave({ mechanismOffsets: next });
  }, [canEdit, scheduleSave]);

  const resetAllMechanismOffsets = useCallback(() => {
    if (!canEdit) return;
    applyOffsets({});
    scheduleSave({ mechanismOffsets: {} });
    flushPending();
  }, [canEdit, scheduleSave, flushPending]);

  const setLookSettings = useCallback((patch: Partial<LookSettings>) => {
    if (!canEdit) return;
    const next = normalizeLookSettings({ ...lookRef.current, ...patch });
    applyLook(next);
    scheduleSave({ lookSettings: next });
  }, [canEdit, scheduleSave]);

  const setMaterialOverride = useCallback((name: string, patch: Partial<MaterialOverride> | null) => {
    if (!canEdit) return;
    const cur = materialsRef.current;
    const merged: MaterialOverrides = { ...cur };
    if (patch === null) delete merged[name];
    else merged[name] = { ...(cur[name] || {}), ...patch };
    const next = normalizeMaterialOverrides(merged);
    applyMaterials(next);
    scheduleSave({ materialOverrides: next });
  }, [canEdit, scheduleSave]);

  const setHomeView = useCallback((view: HomeView | null) => {
    if (!canEdit) return;
    setHomeViewState(view);
    scheduleSave({ homeView: view });
  }, [canEdit, scheduleSave]);

  // AE 畫布尺寸：admin 在管理頁填一次（按 Enter / 離開欄位才存），不用像滑桿那樣等停手，直接送出
  const setLedCanvas = useCallback((v: LedCanvas | null) => {
    if (!canEdit) return;
    const next = normalizeLedCanvas(v);
    setLedCanvasState(next);
    scheduleSave({ ledCanvas: next });
    flushPending();
  }, [canEdit, scheduleSave, flushPending]);

  return {
    scaleCorrection, mechanismOffsets, lookSettings, materialOverrides, homeView, ledCanvas, canEdit, loaded,
    setScaleCorrection, updateMechanismOffset, resetAllMechanismOffsets, setLookSettings, setMaterialOverride, setHomeView,
    setLedCanvas,
  };
}
