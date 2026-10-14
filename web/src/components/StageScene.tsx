import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { loadModel } from '../lib/modelLoader';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import type { CueState, Vec3, Euler, StageObject, CameraView } from '../lib/api';
import { fitFov } from '../lib/review/annotations';
import { computeFrontView } from '../lib/stageCamera';
import { cueMoveProgress } from '../lib/cueTiming';
import { cueQuaternion, lerpOpacity, type CuePoseMap } from '../lib/cueTimeline';
import type { Mechanism, MechanismValues, MechVec3 } from '../lib/mechanisms/model';
import { applyChain, basePoseFromScene, compileRig, EMPTY_RIG, travelGeometry, type RigMechanism } from '../lib/mechanisms/pose';
import { MechanismTweener, type MechanismMotion } from '../lib/mechanisms/motion';
import { stageFrontDirection } from '../lib/stageCamera';
import { createFadeWarmup, endObjectFade, getObjectOpacity, setObjectOpacity, suspendObjectFade, type FadeWarmup } from '../lib/stageLook/objectFade';
import type { HomeView } from '../lib/homeView';
import HomeViewPanel from './HomeViewPanel';
import { computeScaleFactor, findBestScope } from '../lib/parseGlb';
import { useNdiConnection } from '../lib/ndiConnection';
import { ndiShortLabel, ndiStepMessage, showSourcePicker, sourcePickerInStep, type NdiGuide } from '../lib/ndiSteps';
import { NDI_HELPER_DOWNLOAD_URL, NDI_HELPER_DOWNLOAD_URL_MAC, NDI_TOOLS_URL } from '../lib/downloads';
import { NdiAutostartNote, NdiChecklist, NdiGuideCard, NdiSourcePicker, ndiCardKey, ndiCardVisible } from './NdiGuide';
import { HELP_ANCHORS, helpUrl, ndiHelpAnchor } from '../lib/helpLinks';
import LookSettingsPanel from './LookSettingsPanel';
import { DEFAULT_LOOK_SETTINGS, type LookSettings } from '../lib/stageLook/lookSettings';
import { buildLedEmitters, type LedEmitter } from '../lib/stageLook/ledEmitters';
import { LedLightRig, type LedLightProps } from '../lib/stageLook/ledLightRig';
import { LedEnvironment, LED_LAYER } from '../lib/stageLook/ledEnvironment';
import { TextureColorReader, type LedColorSource } from '../lib/stageLook/textureColorReader';
import { AdaptiveQuality, QUALITY, detectQualityProfile, type QualityLevel } from '../lib/stageLook/quality';
import { LED_SURFACE, NDI_PIXEL_DENSITY, applyLedSurface, updateLedSurface } from '../lib/stageLook/ledSurface';
import { FloorReflection, applyFloorReflection, setFloorReflectionFor } from '../lib/stageLook/floorReflection';
import { applyMaterialSettings, captureOriginal, hasMirrorFloor, type MaterialOverride, type MaterialOverrides, type ModelMaterialInfo } from '../lib/stageLook/materialOverrides';
import MaterialPanel from './MaterialPanel';
import { detectFloorPlane } from '../lib/stageLook/floorPlane';
import {
  BookOpen, Box, Camera, ChevronDown, CircleHelp, Download, ExternalLink, FileBraces, FileCode, FileSpreadsheet, Footprints, Globe, Grid3x3, ImageDown,
  MapPin, MonitorCheck, Move, Palette, Pause, PersonStanding, Ratio, RefreshCw, Rotate3d, Ruler, SlidersHorizontal, Sparkles,
  Tag, Target, Video, X, Zap, type LucideIcon,
} from 'lucide-react';
import Icon from './Icon';
import { promptDialog } from './dialogs';
import { toast } from '../lib/toast';
import StageToolbar, { type ToolDef, type ToolMenuSection } from './StageToolbar';
import { LED_CANVAS_RANGE, normalizeLedCanvas, type LedCanvas } from '../lib/ledCanvas';
import {
  buildLedLayout, canvasSourceText, layoutToCsv, layoutToJson, ledMapFileName, parseCanvasInput, resolveLedCanvas, testPatternSize, todayString,
  type CanvasSize, type LedLayout, type LedMapMeta,
} from '../lib/ledMap';
import { ledPanelInputs, type LedSceneObject } from '../lib/ledMapScene';
import { downloadBlob, drawTestPattern, renderAlignmentMapPng } from '../lib/ledMapDraw';
import { AeCanvasTooBigError, downloadAeCompScript } from '../lib/aeCompScriptDownload';
import './StageScene.css';

// 3D 畫面上用 DOM 直接畫的小圖示（物件名稱旁的鎖、留言圖釘）：跟 lucide 的 Lock / MessageSquare 同一個圖形
const SVG_BASE = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const lockSvg = (size: number) =>
  `<svg class="ui-icon" width="${size}" height="${size}" ${SVG_BASE}><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const commentSvg = (size: number) =>
  `<svg class="ui-icon" width="${size}" height="${size}" ${SVG_BASE}><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>`;

/** 物件名稱標籤：鎖住的物件前面多一個鎖頭圖示（內容沒變就不重畫） */
function setObjectLabel(lbl: HTMLDivElement, name: string, locked: boolean) {
  const key = (locked ? '1:' : '0:') + name;
  if (lbl.dataset.content === key) return;
  lbl.dataset.content = key;
  lbl.textContent = name;
  if (locked) lbl.insertAdjacentHTML('afterbegin', lockSvg(11));
}

// RectAreaLight 必須先 init uniforms（Three.js 內建）
RectAreaLightUniformsLib.init();

// LED 貼圖（NDI / mock / 自訂圖片）的 UV 超出 0~1 時要「繞回來」，跟 glTF 預設 sampler（REPEAT）、
// C4D / AE 一致。用預設 ClampToEdge 的話，UV 落在負值的面板（C4D 匯出常見，例：v ∈ [-0.8, -0.45]）
// 只會吃到貼圖邊緣那一排像素 → 整片變成拉長的條紋單色。
const LED_TEXTURE_WRAP = THREE.RepeatWrapping;

const CATEGORY_COLORS: Record<string, number> = {
  led_panel:  0x10c78a,
  mechanism:  0xffaa44,
  walk_point: 0x5294ff,
  fixture:    0xc264ff,
  performer:  0xff5470,
  other:      0x888888,
};

const CATEGORY_GEOM: Record<string, () => THREE.BufferGeometry> = {
  led_panel:  () => new THREE.BoxGeometry(2, 1.2, 0.1),
  mechanism:  () => new THREE.CylinderGeometry(1, 1, 0.4, 24),
  walk_point: () => new THREE.SphereGeometry(0.3, 16, 16),
  fixture:    () => new THREE.ConeGeometry(0.3, 0.7, 6),
  performer:  () => new THREE.CapsuleGeometry(0.25, 1, 4, 8),
  other:      () => new THREE.BoxGeometry(0.6, 0.6, 0.6),
};

export type SelectMode = 'replace' | 'toggle';

interface Props {
  states: CueState[];
  stageObjects?: StageObject[];   // 含 materialProps / ledProps（不在 cue 層級因為材質是物件層級的）
  selectedObjectIds: string[];
  /** mode: 'replace' = 取代之前選的（沒按 shift）；'toggle' = 加減選（按 shift） */
  onSelect: (id: string | null, mode: SelectMode) => void;
  onTransform: (objectId: string, position: Vec3, rotation: Euler) => Promise<void> | void;
  cueName?: string;
  modelUrl?: string | null;
  /** 唯讀模式：不顯示移動/旋轉工具，不啟用 transform gizmo（給動畫師/導演 view） */
  readOnly?: boolean;
  /** 預設 render mode（沒給 = live；舊值 realistic / cinematic 當 live） */
  defaultRenderMode?: RenderMode | 'realistic' | 'cinematic';
  /**
   * AE 即時（NDI 小程序 ws://127.0.0.1:7777）：true 時把 AE 畫面餵給 LED 面板。
   * 第一次 true 才開始連（權限已允許才自動連，還沒問過要按「連接 AE 即時」）；之後變 false = 暫停收畫面、不斷線
   */
  enableNdi?: boolean;
  /** NDI helper URL（預設 ws://127.0.0.1:7777） */
  ndiUrl?: string;
  /** AE 即時現在卡在哪一步（給上層顯示狀態文字） */
  onNdiStatus?: (guide: NdiGuide) => void;
  /** AE 即時還沒接好時，在 3D 畫面上顯示檢查清單卡片（分享頁、動畫師工作站） */
  ndiGuide?: boolean;
  /** 卡片最下面的小字 */
  ndiGuideHint?: string;
  /** Cue 切換時的 crossfade 秒數（0 = 硬切，>0 = 平滑插值） */
  crossfadeSeconds?: number;
  /** 目前 cue 的 id：有給的話，只有「換 cue」才平滑移動（編輯數值照舊即時）；沒給 = states 一換就滑 */
  cueKey?: string | null;
  /** 顯示「👤 比例尺」按鈕（分享連結不需要） */
  showScaleButton?: boolean;
  /** ref-style 抓 scene snapshot（給 storyboard / cue 縮圖用） */
  snapshotApiRef?: React.MutableRefObject<{ snapshot: () => Promise<Blob | null> } | null>;
  /** 3D-anchored 留言（顯示為投影到螢幕的 pin），有 anchor=world|mesh 才 render */
  comments?: import('../lib/api').SongComment[];
  /** 點 3D pin 觸發（給上層 scroll/highlight 對應留言） */
  onCommentPinClick?: (comment: import('../lib/api').SongComment) => void;
  /** 「加 3D 留言」流程：當啟用 + 用戶點 mesh，回傳 anchor 給上層彈出留言視窗 */
  onAddAnchoredComment?: (anchor: import('../lib/api').CommentAnchor) => void;
  /** Camera bookmarks 儲存範圍 — 用 projectId 當 localStorage key 前綴；不傳則停用功能 */
  bookmarkScope?: string;
  /** 機關定義（每個專案設定一次）；沒給 / 還在讀 = 沒有機關 */
  mechanisms?: Mechanism[] | null;
  /** 目前這個 cue 的機關位置（已經沿用 / 夾在行程內）；換 cue 時照機器速度走過去，同一個 cue 裡改值直接跳 */
  mechanismTargets?: MechanismValues;
  /** 跟著影片時間：只在 poseAtFrame 有回傳位置的那幾幀才問；回傳 null = 用 mechanismTargets */
  mechanismAtFrame?: () => MechanismValues | null;
  /** 換 cue 時機關怎麼走：'real'（預設）= 照機器速度；'transition' = 照轉場秒數（管理頁編輯時）；'instant' = 直接到位（分鏡縮圖） */
  mechanismMotion?: MechanismMotion;
  /** 查舞台：舞台正面方向、一組物件的中心（設定機關用） */
  sceneQueryRef?: React.MutableRefObject<StageSceneQuery | null>;
  /** 管理頁正在看的機關：3D 畫面上畫出它的行程（直線 / 圓弧，常用位置有刻度） */
  focusedMechanismId?: string | null;
  /** 測距校準倍率（模型 scene units → 真實公尺），存在專案上全員共用；預設 1 = 未校準 */
  scaleCorrection?: number;
  /** 有傳才顯示「設為已知距離 / 重設」— 只有 admin 能改校準 */
  onScaleCorrectionChange?: (n: number) => void;
  /** 現場模式設定（專案預設 + 自己調過的）；沒傳用預設 */
  lookSettings?: LookSettings;
  /** 有傳才顯示「🎚 設定」面板（每個人都可以調自己的） */
  onLookSettingsChange?: (patch: Partial<LookSettings>) => void;
  /** 自己的設定跟專案預設不一樣嗎 */
  lookCustomized?: boolean;
  /** 清掉自己的調整，回到專案預設 */
  onLookReset?: () => void;
  /** admin 才有：把目前的設定變成所有人的預設 */
  onLookSaveAsDefault?: () => void;
  /** 依 C4D 材質名稱的覆寫（存在專案上全員共用） */
  materialOverrides?: MaterialOverrides;
  /** 有傳才顯示「🎨 材質」面板 — 只有 admin；patch = null → 回到 C4D 原本 */
  onMaterialOverrideChange?: (name: string, patch: Partial<MaterialOverride> | null) => void;
  /** 🎥 重置攝影機要回到的畫面（admin 設、全專案共用）；沒給 / null = 自動正面全景 */
  homeView?: HomeView | null;
  /** 有傳才顯示重置視角設定（▾）— 只有 admin */
  onHomeViewChange?: (view: HomeView | null) => void;
  /** 本地影片（分享頁拖進來的檔案）：有給就播在 LED 上，優先於 NDI */
  ledVideo?: HTMLVideoElement | null;
  /** 本地圖片（分享頁拖進來的檔案，要先載好）：當靜態畫面放在 LED 上；跟 ledVideo 都有給時影片優先 */
  ledImage?: HTMLImageElement | null;
  /**
   * 每一幀問一次：有回傳位置 → 舞台照這個擺（分享頁跟著影片時間走，暫停 / 拉時間軸都會跟）；
   * 回傳 null → 照平常（換 cue 滑過去）。用函式而不是 states，才不會每幀重跑 React。
   */
  poseAtFrame?: () => CuePoseMap | null;
  /**
   * 工具列：'full'（預設）= 全部工具；'viewer' = 只看（動畫師）：工具列只有 🎥 重置攝影機（有開 NDI 再加 NDI 狀態），
   * 一律現場模式、不能調燈光 / 材質、快捷鍵關掉、不能選物件（轉視角 / 縮放照常）
   */
  toolbarMode?: 'full' | 'viewer';
  /** 專案名稱（LED 對位圖上的說明） */
  projectName?: string;
  /** AE 畫布大小（LED 內容合成的寬高，專案上存的）；null / 沒給 = 還沒設定 → 用目前影片的大小，再沒有就 3840 × 2160 */
  ledCanvas?: LedCanvas | null;
  /** 有傳才能在「LED 對位圖」裡改畫布大小 — 只有製作 */
  onLedCanvasChange?: (v: LedCanvas | null) => void;
  /** 「更多」選單裡的 LED 對位圖（下載 PNG / CSV / JSON、LED 顯示測試圖）；預設有 */
  ledMapMenu?: boolean;
  /** 有給 →「更多」選單最下面多一個「說明」（新分頁打開使用說明的這一段） */
  helpHref?: string;
  /** 審片用：拿目前的視角、飛到某個視角（留言記住的）、抓一張縮圖（StageViewApi） */
  viewApiRef?: React.MutableRefObject<StageViewApi | null>;
  /** 審片頁：J / K / L、空白鍵給播放器用 → 3D 畫面的 L（物件名稱）不當快捷鍵（工具列照樣按得到） */
  transportKeys?: boolean;
  /** 疊在 3D 畫面上的東西（畫記），跟畫面一樣大 */
  children?: ReactNode;
}

/** 審片用的 3D 畫面操作（StageScene 的 viewApiRef） */
export interface StageViewApi {
  /** 現在的攝影機（aspect = 畫面寬 / 高）；還沒準備好 = null */
  getView(): CameraView | null;
  /**
   * 平滑飛到某個視角（繞著舞台轉過去，不是直線穿過去）；飛到了才 resolve（被使用者轉視角打斷也 resolve）
   * fitAspect：當時畫面的比例 → 現在的畫面比較窄就把鏡頭角度放大，當時左右的東西都看得到（畫記才對得上）
   */
  flyTo(view: CameraView, opts?: { fitAspect?: number | null; durationMs?: number }): Promise<void>;
  /** 抓一張現在的畫面（最寬 maxWidth px，給留言縮圖）；抓不到 = null。只在按的時候抓一次 */
  capture(maxWidth?: number): HTMLCanvasElement | null;
  /** 畫面寬 / 高 */
  aspect(): number;
  /** 使用者自己開始轉 / 縮放視角（畫記要收起來） */
  onUserMove(cb: () => void): () => void;
}

/** 設定機關時問舞台的事（StageScene 的 sceneQueryRef） */
export interface StageSceneQuery {
  /** 舞台正面（水平、指向觀眾）＝ LED 朝的方向 */
  stageFront(): MechVec3;
  /** 這些物件在 cue 位置（沒加機關）時的外框中心；都找不到 → null */
  groupCenter(ids: string[]): MechVec3 | null;
}

// 機關：每幀共用的暫存（不配置記憶體）
const EMPTY_VALUES: MechanismValues = {};
const mechTmpPos = new THREE.Vector3();
const mechTmpQuat = new THREE.Quaternion();
const mechTmpQuat2 = new THREE.Quaternion();
const ZERO_VEC = new THREE.Vector3();
const IDENTITY_QUAT = new THREE.Quaternion();
const UNSET_CUE = Symbol('unset');

// ⚡ quick：像素 1:1 對顏色；🎤 live：暗場 + LED 照明 + 光暈（取代舊的 realistic / cinematic）
type RenderMode = 'quick' | 'live';

// 沒有縮放工具：cue 不存縮放（模型尺寸對不上走測距校準），縮了也存不起來、換 cue 就不見
type Mode = 'translate' | 'rotate';

const DEFAULT_FOV = 50;

export default function StageScene({ states, stageObjects, selectedObjectIds, onSelect, onTransform, cueName, modelUrl, readOnly: readOnlyProp = false, defaultRenderMode, enableNdi = false, ndiUrl, onNdiStatus, ndiGuide: showNdiGuide = false, ndiGuideHint, crossfadeSeconds = 0, cueKey, showScaleButton = true, snapshotApiRef, comments, onCommentPinClick, onAddAnchoredComment, bookmarkScope, scaleCorrection = 1, onScaleCorrectionChange, lookSettings = DEFAULT_LOOK_SETTINGS, onLookSettingsChange, lookCustomized = false, onLookReset, onLookSaveAsDefault, materialOverrides, onMaterialOverrideChange, homeView = null, onHomeViewChange, ledVideo, ledImage, poseAtFrame, toolbarMode = 'full', mechanisms, mechanismTargets, mechanismAtFrame, mechanismMotion = 'real', sceneQueryRef, focusedMechanismId = null, projectName, ledCanvas = null, onLedCanvasChange, ledMapMenu = true, helpHref, viewApiRef, transportKeys = false, children }: Props) {
  // 只看模式（動畫師）：工具列只剩 🎥、一律唯讀
  const viewer = toolbarMode === 'viewer';
  const readOnly = readOnlyProp || viewer;
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  // 模型載入後自動對準舞台的視角（🎥 重置會回到這裡）
  const homeViewRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const stageObjectsRef = useRef(stageObjects);
  stageObjectsRef.current = stageObjects;
  const homeViewPropRef = useRef(homeView);
  homeViewPropRef.current = homeView;
  // 使用者自己轉過鏡頭了 → 之後才讀到的重置視角就不要硬把鏡頭搬走
  const userMovedCameraRef = useRef(false);
  const transformRef = useRef<TransformControls | null>(null);
  const meshesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const modelMeshMapRef = useRef<Map<string, THREE.Object3D>>(new Map()); // mesh_name → top-level node from .glb
  const labelsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const onSelectRef = useRef(onSelect);
  const onTransformRef = useRef(onTransform);
  const selectedIdsRef = useRef<string[]>(selectedObjectIds);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const transportKeysRef = useRef(transportKeys);
  transportKeysRef.current = transportKeys;
  // 多選共動的 pivot（虛擬中心點，gizmo attach 在它身上；mesh 暫時 reparent 進 pivot）
  const multiPivotRef = useRef<THREE.Object3D | null>(null);

  const [mode, setMode] = useState<Mode>('translate');
  const [space, setSpace] = useState<'world' | 'local'>('world');
  // 物件名稱 label 預設關掉（按 L 或工具列打開）
  const [showLabels, setShowLabels] = useState(false);
  // 大家一打開就是「現場」；只有明確指定 quick 才用快速（舊的 realistic / cinematic 也當現場）；只看模式一律現場
  const [renderMode, setRenderMode] = useState<RenderMode>(
    defaultRenderMode === 'quick' && !viewer ? 'quick' : 'live',
  );
  const [lookPanelOpen, setLookPanelOpen] = useState(false);
  const [materialPanelOpen, setMaterialPanelOpen] = useState(false);
  // 材質面板用：模型裡的材質（依名稱分組）
  const [modelMaterials, setModelMaterials] = useState<ModelMaterialInfo[]>([]);
  const [, setModelLoading] = useState(false);
  // 每次 GLB 載入完 +1，讓依賴 meshesRef 的 effect 重建 / 重套材質
  const [modelVersion, setModelVersion] = useState(0);
  // bump 用：dragging-changed end 後讓 attach pivot 的 effect 重跑
  const [pivotVersion, setPivotVersion] = useState(0);

  // 把 stageObjects 用 id 索引，給 mesh sync 拿 materialProps/ledProps
  const stageObjMap = new Map<string, StageObject>();
  (stageObjects || []).forEach(o => stageObjMap.set(o.id, o));

  // Crossfade tween 動畫
  // tweens 是「正在進行中的 mesh transform 動畫」，render loop 每幀套用插值結果
  const tweensRef = useRef<Map<string, {
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromQuat: THREE.Quaternion;
    toQuat: THREE.Quaternion;
    startTs: number;
    durationMs: number;
  }>>(new Map());
  // 換 cue 時出現 / 消失的物件：跟移動一起等速淡入淡出（render loop 每幀算透明度）
  const fadesRef = useRef<Map<string, { from: number; to: number; startTs: number; durationMs: number }>>(new Map());
  const crossfadeRef = useRef(crossfadeSeconds);
  crossfadeRef.current = crossfadeSeconds;
  // 跟著影片時間擺位置（render loop 每幀讀）；上一幀有沒有在用 → 停用那一刻滑回平常的 cue 位置
  const poseAtFrameRef = useRef(poseAtFrame);
  poseAtFrameRef.current = poseAtFrame;
  const timelineActiveRef = useRef(false);
  const scaleCorrectionRef = useRef(scaleCorrection);
  scaleCorrectionRef.current = scaleCorrection;
  // ── 機關 ──
  // 存在這裡的是「cue 位置」（物件在 cue 裡的位置 / 角度，還沒加機關）；每幀最後一次套上機關寫到 mesh（只有這一個地方）。
  // 換 cue 滑動、影片時間軸、拖完存檔都只動 cue 位置 → 機關位移不會被加兩次
  const basePoseRef = useRef<Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion }>>(new Map());
  const setBasePose = (id: string, pos: { x: number; y: number; z: number }, quat: THREE.Quaternion) => {
    const cur = basePoseRef.current.get(id);
    if (cur) { cur.pos.set(pos.x, pos.y, pos.z); cur.quat.copy(quat); }
    else basePoseRef.current.set(id, { pos: new THREE.Vector3(pos.x, pos.y, pos.z), quat: quat.clone() });
  };
  // 機關定義 → 每個物件的機關鏈（定義或校準倍率變了才重算）
  const rig = useMemo(
    () => (mechanisms ? compileRig(mechanisms, scaleCorrection) : EMPTY_RIG),
    [mechanisms, scaleCorrection],
  );
  const rigRef = useRef(rig);
  rigRef.current = rig;
  const mechTweenerRef = useRef(new MechanismTweener());
  // 這一幀畫面上用的機關值（拖完存檔要用「放手那一幀」的值）
  const displayedMechRef = useRef<MechanismValues>({});
  const mechTimelineActiveRef = useRef(false);
  const mechTargetsRef = useRef(mechanismTargets);
  mechTargetsRef.current = mechanismTargets;
  const mechAtFrameRef = useRef(mechanismAtFrame);
  mechAtFrameRef.current = mechanismAtFrame;
  const mechMotionRef = useRef(mechanismMotion);
  mechMotionRef.current = mechanismMotion;
  /** 套上機關、寫到 mesh（render loop 每幀最後一次；states 換了也馬上一次） */
  const commitPosesRef = useRef<(nowTs: number, timelineActive: boolean) => void>(() => {});
  // 上一次套到舞台的 states：只有 states 換了（換 cue）才平滑移動；選取 / 校準變了照舊直接套
  const lastSyncedStatesRef = useRef<CueState[] | null>(null);
  // 換 cue 了 → 下一次 states 換掉時要滑過去（cue 的位置是另外抓的，會晚一點到）
  const lastCueKeyRef = useRef(cueKey);
  const cueChangedRef = useRef(false);
  if (cueKey !== undefined && cueKey !== lastCueKeyRef.current) {
    lastCueKeyRef.current = cueKey;
    cueChangedRef.current = true;
  }
  // LED emissive 貼圖快取（imageUrl → Texture），避免每次 effect 重 load
  const ledTextureCacheRef = useRef<Map<string, THREE.Texture>>(new Map());
  const envLightsRef = useRef<{ ambient: THREE.AmbientLight; hemi: THREE.HemisphereLight; key: THREE.DirectionalLight | null } | null>(null);

  // PostFX：EffectComposer + UnrealBloomPass（現場模式啟用）
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  // 現場模式：LED 燈組 / 只拍 LED 的環境光 / 取色器 / 每個 LED 物件的發光面
  const ledRigRef = useRef<LedLightRig | null>(null);
  const ledEnvRef = useRef<LedEnvironment | null>(null);
  const floorReflRef = useRef<FloorReflection | null>(null);
  const colorReaderRef = useRef<TextureColorReader | null>(null);
  const emitterCacheRef = useRef<WeakMap<THREE.Object3D, LedEmitter[]>>(new WeakMap());
  // objectId → 目前 LED 用的貼圖（取色用）/ 燈的參數
  const ledSourcesRef = useRef<Map<string, LedColorSource | null>>(new Map());
  const ledLightPropsRef = useRef<Map<string, LedLightProps>>(new Map());
  // 現場模式的 LED 材質（每 100ms 更新像素格 / 側看衰減）
  const ledMaterialsRef = useRef<Set<THREE.MeshStandardMaterial>>(new Set());
  const helpersRef = useRef<{ grid: THREE.GridHelper; axes: THREE.AxesHelper } | null>(null);
  // 舞台中心 / 大小（環境光 CubeCamera 放這裡）
  const stageBoundsRef = useRef<{ center: THREE.Vector3; radius: number }>({ center: new THREE.Vector3(0, 1, 0), radius: 10 });
  // 畫質：一開始依裝置選，之後看實際順不順自動升降（render loop 量每幀時間）
  const [startQuality] = useState<QualityLevel>(() => detectQualityProfile({
    maxTouchPoints: navigator.maxTouchPoints || 0,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    userAgent: navigator.userAgent,
  }));
  const qualityRef = useRef(QUALITY[startQuality]);
  const [qualityLevel, setQualityLevel] = useState<QualityLevel>(startQuality);
  const adaptiveQualityRef = useRef<AdaptiveQuality | null>(null);
  // 淡入淡出用的半透明 shader 預先編好、複本留著（第一次換 cue 才不會卡一下）
  const fadeWarmupRef = useRef<FadeWarmup | null>(null);
  const lookRef = useRef<LookSettings>(lookSettings);
  lookRef.current = lookSettings;
  const showLabelsRef = useRef(false);
  // LED 測試圖：沒有畫面（影片 / AE 即時 / 本地檔案）時 LED 顯示的，跟 LED 對位圖同一套位置
  // 模型 / 畫布大小換了才重畫（state：換了要讓材質重新套）
  const [testPatternTex, setTestPatternTex] = useState<THREE.CanvasTexture | null>(null);
  // 「LED 顯示測試圖」開著：有畫面時也顯示測試圖（檢查對位用；只有自己看得到，這個分頁記得）
  const [forceTestPattern, setForceTestPattern] = useState<boolean>(() => {
    try { return sessionStorage.getItem('sp_led_test_pattern') === '1'; } catch { return false; }
  });
  // 目前影片 / 圖片的大小（製作還沒設定畫布大小時，對位圖用這個）
  const [mediaSize, setMediaSize] = useState<CanvasSize | null>(null);
  const [ledMapBusy, setLedMapBusy] = useState<null | 'png' | 'jsx'>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // NDI 真連線：connect 後拿到 frames 就 update CanvasTexture（替代 mock）
  const ndiLiveTextureRef = useRef<{ texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);
  // 本地影片 / 圖片 → LED 貼圖（ledVideo / ledImage prop 變了就重建）
  const ledMediaTextureRef = useRef<THREE.Texture | null>(null);
  const [ndiPopoverOpen, setNdiPopoverOpen] = useState(false);
  // 按 × 收起引導卡片：記住是哪一步收的，換到別的問題會再出現
  const [ndiCardHiddenFor, setNdiCardHiddenFor] = useState<string | null>(null);
  // Anchored-comment 加入模式：滑鼠變十字、下次點 mesh / world 觸發 onAddAnchoredComment
  const [addPinMode, setAddPinMode] = useState(false);
  const addPinModeRef = useRef(false);
  addPinModeRef.current = addPinMode;
  const onAddAnchoredCommentRef = useRef(onAddAnchoredComment);
  onAddAnchoredCommentRef.current = onAddAnchoredComment;
  // 投影 3D pin 到螢幕（每幀 update HTML 位置，跟 label 同類）
  const commentPinLayerRef = useRef<HTMLDivElement | null>(null);
  const lockPinLayerRef = useRef<HTMLDivElement | null>(null);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const onCommentPinClickRef = useRef(onCommentPinClick);
  onCommentPinClickRef.current = onCommentPinClick;
  const statesRef = useRef(states);
  statesRef.current = states;

  // Camera bookmarks
  interface Bookmark { id: string; name: string; pos: [number, number, number]; target: [number, number, number]; fov: number; }
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    if (!bookmarkScope) return [];
    try {
      const raw = localStorage.getItem('sp_camera_bookmarks:' + bookmarkScope);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [bookmarkPanelOpen, setBookmarkPanelOpen] = useState(false);
  const [homeViewPanelOpen, setHomeViewPanelOpen] = useState(false);

  // Wireframe / X-ray 模式（debug 看穿模型結構）
  const [wireframe, setWireframe] = useState(false);

  // 比例尺輔助（人形剪影 + 1m 網格）— 給動畫師看實體大小
  const [showScaleRef, setShowScaleRef] = useState(false);
  const scaleRefGroupRef = useRef<THREE.Group | null>(null);

  // 測距工具：點兩個點 → 畫線 + 距離（m）
  const [measureMode, setMeasureMode] = useState(false);
  const measureModeRef = useRef(false);
  measureModeRef.current = measureMode;
  const measurePointsRef = useRef<THREE.Vector3[]>([]);
  const measureLineRef = useRef<THREE.Line | null>(null);
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);

  // 模型 → 真實單位的換算倍率：由上層從專案設定傳進來（scaleCorrection prop）
  // 自動偵測的縮放可能猜錯（例：GLB 是公分 / 毫米 / 英吋）→ 提供校準工具，admin 才能存
  const canCalibrate = !!onScaleCorrectionChange;
  const saveScaleCorrection = (n: number) => { onScaleCorrectionChange?.(n); };
  // 校準對話框：開著時 = 等使用者輸入「這兩點實際多少公尺」
  const [calibratePromptOpen, setCalibratePromptOpen] = useState(false);
  const [calibrateInput, setCalibrateInput] = useState('');

  // Walk mode（FPV / WASD）
  const [walkMode, setWalkMode] = useState(false);
  const walkKeysRef = useRef<{ [k: string]: boolean }>({});
  const walkPointerLockRef = useRef(false);

  // 切成只看模式：回到現場、開著的工具 / 面板都收起來
  useEffect(() => {
    if (!viewer) return;
    setRenderMode('live');
    setLookPanelOpen(false);
    setMaterialPanelOpen(false);
    setHomeViewPanelOpen(false);
    setBookmarkPanelOpen(false);
    setShowLabels(false);
    setWireframe(false);
    setShowScaleRef(false);
    setWalkMode(false);
    setMeasureMode(false);
    setAddPinMode(false);
  }, [viewer]);
  // Persist to localStorage
  useEffect(() => {
    if (!bookmarkScope) return;
    try { localStorage.setItem('sp_camera_bookmarks:' + bookmarkScope, JSON.stringify(bookmarks)); } catch {}
  }, [bookmarks, bookmarkScope]);

  async function saveCurrentCamera() {
    const cam = cameraRef.current;
    const orb = orbitRef.current;
    if (!cam || !orb) return;
    const name = ((await promptDialog({
      title: '存目前的視角', label: '視角名稱', defaultValue: `視角 ${bookmarks.length + 1}`, confirmLabel: '儲存', maxLength: 40,
    })) || '').trim();
    if (!name) return;
    const bm: Bookmark = {
      id: 'bm_' + Math.random().toString(36).slice(2, 10),
      name,
      pos: [round(cam.position.x), round(cam.position.y), round(cam.position.z)],
      target: [round(orb.target.x), round(orb.target.y), round(orb.target.z)],
      fov: cam.fov,
    };
    setBookmarks(prev => [...prev, bm]);
  }

  function loadBookmark(bm: Bookmark) {
    flyCamera(new THREE.Vector3(...bm.pos), new THREE.Vector3(...bm.target), bm.fov);
  }

  // 平滑飛到指定視角：看的點直線移過去，攝影機繞著它轉（像搖臂，不會從舞台中間穿過去）；
  // 距離越遠飛越久（0.5～1.2 秒）。新的一趟 / 使用者自己轉視角 → 舊的那趟停在那裡（Promise 照樣 resolve）
  const flightRef = useRef<{ cancelled: boolean; resolve: () => void } | null>(null);
  function cancelFlight() {
    const f = flightRef.current;
    if (f) { f.cancelled = true; f.resolve(); flightRef.current = null; }
  }
  function flyCamera(toPos: THREE.Vector3, toTarget: THREE.Vector3, toFov: number, durationMs?: number): Promise<void> {
    const cam = cameraRef.current;
    const orb = orbitRef.current;
    if (!cam || !orb) return Promise.resolve();
    cancelFlight();
    const fromTarget = orb.target.clone();
    const fromFov = cam.fov;
    const s0 = new THREE.Spherical().setFromVector3(cam.position.clone().sub(fromTarget));
    const s1 = new THREE.Spherical().setFromVector3(toPos.clone().sub(toTarget));
    let dTheta = s1.theta - s0.theta;
    if (dTheta > Math.PI) dTheta -= Math.PI * 2;
    if (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const r0 = Math.max(1e-3, s0.radius), r1 = Math.max(1e-3, s1.radius);
    const travel = fromTarget.distanceTo(toTarget) / Math.max(r0, r1) + Math.abs(dTheta) + Math.abs(s1.phi - s0.phi) + Math.abs(Math.log(r1 / r0));
    const dur = durationMs ?? Math.min(1200, Math.max(500, 420 + travel * 300));
    const startTs = performance.now();
    const tgt = new THREE.Vector3();
    const off = new THREE.Vector3();
    const sp = new THREE.Spherical();
    return new Promise<void>((resolve) => {
      const flight = { cancelled: false, resolve };
      flightRef.current = flight;
      const step = () => {
        if (flight.cancelled) return;
        const t = Math.min((performance.now() - startTs) / dur, 1);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        tgt.lerpVectors(fromTarget, toTarget, e);
        sp.set(r0 * Math.pow(r1 / r0, e), s0.phi + (s1.phi - s0.phi) * e, s0.theta + dTheta * e);
        off.setFromSpherical(sp);
        cam.position.copy(tgt).add(off);
        orb.target.copy(tgt);
        cam.fov = fromFov + (toFov - fromFov) * e;
        cam.updateProjectionMatrix();
        if (t < 1) { requestAnimationFrame(step); return; }
        // 最後一格對準（球座標換算的小誤差）
        cam.position.copy(toPos);
        orb.target.copy(toTarget);
        if (flightRef.current === flight) flightRef.current = null;
        resolve();
      };
      requestAnimationFrame(step);
    });
  }

  function deleteBookmark(id: string) {
    setBookmarks(prev => prev.filter(b => b.id !== id));
  }
  // 讓 useEffect 之外的 render loop 能讀取最新 renderMode
  const renderModeRef = useRef<RenderMode>(renderMode);
  renderModeRef.current = renderMode;

  onSelectRef.current = onSelect;
  selectedIdsRef.current = selectedObjectIds;
  onTransformRef.current = onTransform;

  // ── Scene init (only once) ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x16181c);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 200);
    camera.position.set(8, 6, 10);
    camera.lookAt(0, 1, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, qualityRef.current.pixelRatioCap));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.xr.enabled = true;  // 啟用 WebXR（VR 頭戴用）
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 暴露 snapshot API
    if (snapshotApiRef) {
      snapshotApiRef.current = {
        snapshot: () => new Promise<Blob | null>(resolve => {
          // 在 next animation frame 抓（確保 render loop 已 flush）
          const r = rendererRef.current;
          if (!r) return resolve(null);
          // setAnimationLoop 會在 XR + 一般兩種模式都有效。用 requestAnimationFrame 等下一幀
          requestAnimationFrame(() => {
            try {
              r.domElement.toBlob(b => resolve(b), 'image/jpeg', 0.85);
            } catch (e) {
              console.warn('[StageScene] snapshot failed:', e);
              resolve(null);
            }
          });
        }),
      };
    }

    // ── 現場模式：LED 燈組 + 只拍 LED 的環境光 + 取色器 ──
    ledRigRef.current = new LedLightRig(scene);
    ledRigRef.current.setMaxLights(qualityRef.current.maxLights);
    try {
      ledEnvRef.current = new LedEnvironment(renderer);
      floorReflRef.current = new FloorReflection(renderer);
    } catch (e) {
      console.warn('[StageScene] LED environment init failed:', e);
    }
    colorReaderRef.current = new TextureColorReader();

    // ── EffectComposer（現場模式 bloom 用） ──
    try {
      const composer = new EffectComposer(renderer);
      const renderPass = new RenderPass(scene, camera);
      composer.addPass(renderPass);
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        0.7,    // strength
        0.4,    // radius
        0.85,   // threshold（亮度高過此值才參與 bloom）
      );
      composer.addPass(bloomPass);
      composer.addPass(new OutputPass());
      composerRef.current = composer;
      bloomPassRef.current = bloomPass;
    } catch (e) {
      console.warn('[StageScene] EffectComposer init failed:', e);
    }

    // 自動畫質：剛打開前幾秒（載入、編 shader）不算
    // （同一個元件重跑這段時沿用原本的，等級才會跟 qualityRef / 畫面上的提示一致）
    const adaptiveQuality = adaptiveQualityRef.current ?? new AdaptiveQuality(startQuality);
    adaptiveQuality.hold(performance.now(), 4000);
    adaptiveQualityRef.current = adaptiveQuality;
    // 分頁切回來：前 2 秒不算
    const onVisibilityChange = () => {
      if (!document.hidden) adaptiveQuality.hold(performance.now(), 2000);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // ── Lock pin layer（鎖住的物件永遠顯示 🔒，不受 L 切換影響）──
    {
      const layer = document.createElement('div');
      layer.className = 'stage-scene__lock-pins';
      layer.style.display = showLabelsRef.current && !readOnlyRef.current ? '' : 'none';
      container.appendChild(layer);
      lockPinLayerRef.current = layer;
    }

    // ── Comment pin layer（3D-anchored 留言投影到螢幕）──
    {
      const layer = document.createElement('div');
      layer.className = 'stage-scene__comment-pins';
      layer.addEventListener('stage-comment-pin-click', (e: Event) => {
        const id = (e as CustomEvent).detail;
        const c = (commentsRef.current || []).find(cm => cm.id === id);
        if (c) onCommentPinClickRef.current?.(c);
      });
      container.appendChild(layer);
      commentPinLayerRef.current = layer;
    }

    // ── NDI live texture（CanvasTexture 接 NDI helper 的 frames）──
    try {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 256;  // 預設大小，frame 進來會 resize
      const cctx = c.getContext('2d', { alpha: false });
      if (cctx) {
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // 模型 UV 是 baked 過的（top-left origin），跟 Electron 版一致 → flipY = false
        tex.flipY = false;
        tex.wrapS = tex.wrapT = LED_TEXTURE_WRAP;
        ndiLiveTextureRef.current = { texture: tex, canvas: c, ctx: cctx };
      }
    } catch (e) {
      console.warn('[StageScene] NDI live canvas init failed:', e);
    }

    // Lights — quick mode 用 ambient 為主、realistic 會把 ambient 降低讓 LED 主導
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0x88aaff, 0x222222, 0.3);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(6, 10, 4);
    scene.add(key);
    envLightsRef.current = { ambient, hemi, key };

    // Helpers (grid + axes)
    const grid = new THREE.GridHelper(20, 20, 0x3a3d43, 0x222428);
    scene.add(grid);
    const axes = new THREE.AxesHelper(2);
    (axes.material as THREE.LineBasicMaterial).depthTest = false;
    axes.renderOrder = 1;
    scene.add(axes);
    helpersRef.current = { grid, axes };

    // Orbit
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;
    orbit.target.set(0, 1, 0);
    orbit.addEventListener('start', () => { userMovedCameraRef.current = true; });
    orbitRef.current = orbit;

    // Transform gizmo (Three.js r169+ : TransformControls 不是 Object3D，要用 getHelper)
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSize(0.9);

    // hover 在 gizmo 軸上時就先 disable orbit（不然 orbit 先抓走滑鼠 → camera 跟著轉）
    transform.addEventListener('axis-changed', (event: any) => {
      orbit.enabled = (event.value === null);
    });

    // 3D 畫面上放手的位置 / 角度 → 要存進 cue 的：倒回機關（用放手那一幀畫面上的機關值，pose.ts 的 basePoseFromScene），
    // 先放進 cue 位置（不然存檔回來之前會跳回舊位置一下），再存
    const toCuePose = (id: string, worldPos: THREE.Vector3, worldQuat: THREE.Quaternion): { position: Vec3; rotation: Euler } => {
      const bp = new THREE.Vector3(), bq = new THREE.Quaternion();
      basePoseFromScene(rigRef.current.chains.get(id), displayedMechRef.current, worldPos, worldQuat, bp, bq);
      const e = new THREE.Euler().setFromQuaternion(bq, 'XYZ');
      const position = { x: round(bp.x), y: round(bp.y), z: round(bp.z) };
      const rotation = {
        pitch: round(THREE.MathUtils.radToDeg(e.x)),
        yaw: round(THREE.MathUtils.radToDeg(e.y)),
        roll: round(THREE.MathUtils.radToDeg(e.z)),
      };
      setBasePose(id, position, cueQuaternion(rotation));
      return { position, rotation };
    };

    // dragging-changed：drag 結束時自動存（支援單選 / 多選共動）
    transform.addEventListener('dragging-changed', (event: any) => {
      if (event.value === false) {
        if (transform.axis === null) orbit.enabled = true;
        const obj = transform.object;
        if (!obj) return;
        const pivot = multiPivotRef.current;
        if (pivot && obj === pivot) {
          // ── 多選共動：對 pivot 內每個 mesh 算 final world transform，fire onTransform
          const children = [...pivot.children];
          for (const m of children) {
            m.updateMatrixWorld();
            const wpos = new THREE.Vector3();
            const wquat = new THREE.Quaternion();
            m.getWorldPosition(wpos);
            m.getWorldQuaternion(wquat);
            const id = m.userData.objectId as string | undefined;
            scene.attach(m); // 拿回 scene（保留 world matrix）
            if (id) {
              const pose = toCuePose(id, wpos, wquat);
              onTransformRef.current(id, pose.position, pose.rotation);
            }
          }
          transform.detach();
          scene.remove(pivot);
          multiPivotRef.current = null;
          // bump version 觸發 attach effect 重建 pivot（讓 user 可繼續拖）
          setPivotVersion(v => v + 1);
        } else {
          // ── 單選
          const id = obj.userData.objectId as string | undefined;
          if (!id) return;
          const pose = toCuePose(id, obj.position, obj.quaternion);
          onTransformRef.current(id, pose.position, pose.rotation);
        }
      } else {
        orbit.enabled = false;
      }
    });

    // r169+：TransformControls extends Controls (不是 Object3D)，要 add 它的 helper
    const transformHelper = transform.getHelper();
    scene.add(transformHelper);
    transformRef.current = transform;

    // Selection by click — 但要先排除「點到 gizmo」的情況（不然會 detach 中斷 drag）
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    // Debug 暴露
    (window as any).__stage = { scene, camera, raycaster, transform, transformHelper, meshes: meshesRef, modelMap: modelMeshMapRef };
    function onPointerDown(e: PointerEvent) {
      // Measure 模式（最前面，唯讀也支援）
      if (measureModeRef.current && e.button === 0) {
        const rect = renderer.domElement.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const objs = Array.from(meshesRef.current.values());
        const hit = raycaster.intersectObjects(objs, true);
        // 點到 mesh 用 hit point；點空白用 ground plane y=0
        let point: THREE.Vector3;
        if (hit.length > 0) {
          point = hit[0].point.clone();
        } else {
          // ground plane intersect
          const t = -raycaster.ray.origin.y / raycaster.ray.direction.y;
          if (!isFinite(t) || t < 0) return; // 看著天空 → 跳過
          point = raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, t);
        }
        const points = measurePointsRef.current;
        points.push(point);
        if (points.length === 2) {
          // 畫線
          if (!measureLineRef.current) {
            const geom = new THREE.BufferGeometry();
            const mat = new THREE.LineBasicMaterial({ color: 0xffaa44, linewidth: 2 });
            const line = new THREE.Line(geom, mat);
            line.renderOrder = 1000;
            (line.material as THREE.LineBasicMaterial).depthTest = false;
            scene.add(line);
            measureLineRef.current = line;
          }
          const line = measureLineRef.current;
          (line.geometry as THREE.BufferGeometry).setFromPoints(points);
          (line.geometry as THREE.BufferGeometry).computeBoundingSphere();
          const dist = points[0].distanceTo(points[1]);
          setMeasureDistance(dist);
        } else if (points.length > 2) {
          // 第三點 → 重新開始
          points.length = 0;
          points.push(point);
          setMeasureDistance(null);
          if (measureLineRef.current) {
            (measureLineRef.current.geometry as THREE.BufferGeometry).setFromPoints([]);
          }
        }
        return;
      }

      // Add-pin 模式（唯讀模式也要支援，所以放最前面）
      if (addPinModeRef.current && e.button === 0) {
        const rect = renderer.domElement.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const objs = Array.from(meshesRef.current.values());
        const hit = raycaster.intersectObjects(objs, true);
        let anchor: import('../lib/api').CommentAnchor;
        if (hit.length > 0) {
          // 點到 mesh — 找 root mesh 拿 displayName
          let target: THREE.Object3D | null = hit[0].object;
          let rootId: string | undefined;
          while (target && !(rootId = target.userData.objectId)) target = target.parent;
          // 取 mesh 名稱（從 states 對應）
          let meshName = 'unknown';
          if (rootId) {
            const s = (states || []).find(st => st.objectId === rootId);
            if (s) meshName = s.meshName;
          }
          // offset = hit point 相對 root mesh local
          const root = rootId ? meshesRef.current.get(rootId) : null;
          const offset = root ? root.worldToLocal(hit[0].point.clone()) : null;
          anchor = { type: 'mesh', meshName, offset: offset ? { x: offset.x, y: offset.y, z: offset.z } : null };
        } else {
          // 點空白 — 用 0 高度平面 raycast 拿 world coord
          // 簡化：用攝影機方向延伸 5m 處
          const dir = raycaster.ray.direction.clone().multiplyScalar(5);
          const point = raycaster.ray.origin.clone().add(dir);
          anchor = { type: 'world', world: { x: round(point.x), y: round(point.y), z: round(point.z) } };
        }
        setAddPinMode(false);
        onAddAnchoredCommentRef.current?.(anchor);
        return;
      }

      // 唯讀模式：不選取、不拖動
      if (readOnlyRef.current) return;
      // 已經在拖 gizmo 中 → 跳過
      if (transform.dragging) return;
      // 只處理左鍵
      if (e.button !== 0) return;

      // 用 transform.axis 判斷是否點在 gizmo handle 上（hover 時會被設成 'X'/'Y'/'Z'/'XY' 等）
      // 比 raycast gizmoHelper 可靠 — 後者會把隱形 drag plane 也 hit 中、擋住所有 click
      if (transform.axis !== null) return;

      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);

      // 鎖定的物件不參與 raycast
      const objs = Array.from(meshesRef.current.values()).filter(o => !o.userData.locked);
      // recursive: GLB 物件可能有子 mesh
      const hit = raycaster.intersectObjects(objs, true);
      const mode: SelectMode = e.shiftKey ? 'toggle' : 'replace';
      if (hit.length > 0) {
        let target: THREE.Object3D | null = hit[0].object;
        let id: string | undefined;
        // 沿著 parent 找 objectId（GLB 子 mesh 的 id 在 root，或 pivot 內被 reparent 的）
        while (target && !(id = target.userData.objectId)) target = target.parent;
        if (id) onSelectRef.current(id, mode);
        else if (mode === 'replace') onSelectRef.current(null, 'replace');
      } else if (mode === 'replace') {
        // 點空白 + 沒 shift → 清空；按 shift 點空白 → 不動
        onSelectRef.current(null, 'replace');
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    // 套目前的畫質檔：解析度 / bloom / 地板倒影 / 燈數（resize 和自動調畫質都走這裡；不用重載模型）
    const applyQuality = () => {
      const q = qualityRef.current;
      ledRigRef.current?.setMaxLights(q.maxLights);
      floorReflRef.current?.setEnabled(renderModeRef.current === 'live' && q.reflectionScale > 0);
      if (bloomPassRef.current) bloomPassRef.current.enabled = q.bloomScale > 0;
      if (renderer.xr.isPresenting) return;  // VR 中不能改尺寸
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      const pr = Math.min(window.devicePixelRatio, q.pixelRatioCap);
      if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // composer 也要同步尺寸 / 解析度
      composerRef.current?.setPixelRatio(pr);
      composerRef.current?.setSize(w, h);
      // 低畫質檔 bloom 用比較低的解析度（0 = 不畫）
      const bs = q.bloomScale;
      if (bs > 0) bloomPassRef.current?.setSize(Math.round(w * bs), Math.round(h * bs));
      // 地板倒影 RT（reflectionScale = 0 → 不畫）
      const rs = q.reflectionScale;
      if (rs > 0) floorReflRef.current?.setSize(w * rs, h * rs);
    };

    // ── 機關：每幀最後把「cue 位置 + 機關」寫到 mesh（只有這裡寫）──
    //   正在 3D 拖的物件不動（拖完會把放手的位置倒回 cue 位置）；多選的物件暫時在 pivot 底下 → 換算成 pivot 裡的位置
    const mechValuesFor = (nowTs: number, timelineActive: boolean): MechanismValues => {
      const rigNow = rigRef.current;
      const shown = displayedMechRef.current;
      if (rigNow.mechanisms.length === 0) return EMPTY_VALUES;
      const tweener = mechTweenerRef.current;
      let v: MechanismValues | null = timelineActive ? (mechAtFrameRef.current?.() ?? null) : null;
      if (v) {
        mechTimelineActiveRef.current = true;
      } else {
        if (mechTimelineActiveRef.current) {
          // 影片時間軸剛停（點了沒設時間的 cue / 換 AE 即時）→ 從畫面上最後的位置照機器速度走回目前 cue 的位置
          mechTimelineActiveRef.current = false;
          tweener.setCurrent(shown, nowTs);
          tweener.retarget(rigNow.mechanisms, mechTargetsRef.current || EMPTY_VALUES, nowTs, {
            animate: mechMotionRef.current !== 'instant', minSeconds: crossfadeRef.current, motion: mechMotionRef.current,
          });
        }
        v = tweener.valuesAt(nowTs);
      }
      for (const k in shown) if (!(k in v)) delete shown[k];
      for (const k in v) shown[k] = v[k];
      return shown;
    };
    const commitPoses = (nowTs: number, timelineActive: boolean) => {
      const values = mechValuesFor(nowTs, timelineActive);
      const travel = travelRef.current;
      if (travel) applyChain(travel.outer, values, ZERO_VEC, IDENTITY_QUAT, travel.group.position, travel.group.quaternion);
      const chains = rigRef.current.chains;
      const dragging = transform.dragging;
      const dragObj = dragging ? transform.object : null;
      const pivot = multiPivotRef.current;
      let pivotReady = false;
      for (const [id, mesh] of meshesRef.current) {
        const base = basePoseRef.current.get(id);
        if (!base) continue;
        const inPivot = !!pivot && mesh.parent === pivot;
        if (dragging && (mesh === dragObj || inPivot)) continue;
        applyChain(chains.get(id), values, base.pos, base.quat, mechTmpPos, mechTmpQuat);
        if (mesh.parent === scene) {
          mesh.position.copy(mechTmpPos);
          mesh.quaternion.copy(mechTmpQuat);
        } else if (inPivot) {
          if (!pivotReady) { pivot.updateMatrixWorld(); pivot.getWorldQuaternion(mechTmpQuat2).invert(); pivotReady = true; }
          mesh.position.copy(pivot.worldToLocal(mechTmpPos));
          mesh.quaternion.multiplyQuaternions(mechTmpQuat2, mechTmpQuat);
        }
      }
    };
    commitPosesRef.current = commitPoses;

    // Render loop（用 setAnimationLoop 而非 rAF — 才能支援 WebXR）
    let stopped = false;
    let lastTickTs = performance.now();
    let lastColorTs = 0;
    let lastEnvTs = 0;
    const tick = () => {
      if (stopped) return;
      const nowTs = performance.now();
      const frameMs = nowTs - lastTickTs;
      const deltaSec = Math.min(frameMs / 1000, 0.1);
      lastTickTs = nowTs;

      // 自動畫質：一直卡 → 降一級；一直很順 → 升回去（VR 中不量）
      if (renderer.xr.isPresenting) {
        adaptiveQuality.hold(nowTs, 2000);
      } else {
        const nextQuality = adaptiveQuality.frame(nowTs, frameMs);
        if (nextQuality) {
          qualityRef.current = QUALITY[nextQuality];
          applyQuality();
          setQualityLevel(nextQuality);
        }
      }

      // Walk mode：用 keysRef 算速度向量（相對 camera local 軸）
      if (walkPointerLockRef.current) {
        const cam = cameraRef.current!;
        const speed = 4 * deltaSec; // 公尺 / 秒
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        forward.y = 0; forward.normalize();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        right.y = 0; right.normalize();
        const k = walkKeysRef.current;
        if (k['w'] || k['arrowup'])    cam.position.addScaledVector(forward,  speed);
        if (k['s'] || k['arrowdown'])  cam.position.addScaledVector(forward, -speed);
        if (k['a'] || k['arrowleft'])  cam.position.addScaledVector(right,   -speed);
        if (k['d'] || k['arrowright']) cam.position.addScaledVector(right,    speed);
        if (k[' '])      cam.position.y += speed; // space 上升
        if (k['shift'])  cam.position.y -= speed; // shift 下降
        // OrbitControls 在 walk 模式 disable，所以 target 也順勢更新（保持前方一致）
        orbit.target.copy(cam.position).addScaledVector(forward, 5);
      }

      orbit.update();

      // 跟著影片時間擺位置（分享頁播本地影片）：有就直接照擺，換 cue 的滑動先不用
      const framePoses = poseAtFrameRef.current?.() ?? null;
      const tweens = tweensRef.current;
      const fades = fadesRef.current;
      if (framePoses) {
        timelineActiveRef.current = true;
        tweens.clear();
        fades.clear();
        const meshes = meshesRef.current;
        for (const [id, pose] of framePoses) {
          const mesh = meshes.get(id);
          if (!mesh) continue;
          // cue 位置（機關最後在 commitPoses 一起套）
          setBasePose(id, pose.position, pose.quaternion);
          setObjectOpacity(mesh, pose.opacity);
        }
      } else if (timelineActiveRef.current) {
        // 剛停用（換成 AE 即時 / 移掉影片 / 點了沒設影片時間的 cue）→ 從現在的位置滑回目前 cue 的位置
        timelineActiveRef.current = false;
        const meshes = meshesRef.current;
        const now = performance.now();
        const durationMs = Math.max(crossfadeRef.current, 0) * 1000;
        for (const s of statesRef.current || []) {
          const mesh = meshes.get(s.objectId);
          if (!mesh || mesh.parent !== scene) continue;
          // 淡到一半的也從現在的透明度淡回目前 cue 的樣子
          if (!fades.has(s.objectId)) {
            const fromOpacity = getObjectOpacity(mesh);
            const toOpacity = s.effective.visible ? 1 : 0;
            if (durationMs > 0 && fromOpacity !== toOpacity) {
              fades.set(s.objectId, { from: fromOpacity, to: toOpacity, startTs: now, durationMs });
            } else {
              setObjectOpacity(mesh, toOpacity);
            }
          }
          if (tweens.has(s.objectId)) continue;  // 換 cue 時已經在滑了
          const p = s.effective.position;
          const q = cueQuaternion(s.effective.rotation);
          const base = basePoseRef.current.get(s.objectId);
          if (durationMs > 0 && base) {
            tweens.set(s.objectId, {
              fromPos: base.pos.clone(), toPos: new THREE.Vector3(p.x, p.y, p.z),
              fromQuat: base.quat.clone(), toQuat: q,
              startTs: now, durationMs,
            });
          } else {
            setBasePose(s.objectId, p, q);
          }
        }
      }

      // Crossfade tweens（每幀更新進行中的 mesh transform 插值）
      if (!framePoses && tweens.size > 0) {
        const now = performance.now();
        const meshes = meshesRef.current;
        const finished: string[] = [];
        for (const [id, tw] of tweens) {
          const mesh = meshes.get(id);
          const base = basePoseRef.current.get(id);
          if (!mesh || !base) { finished.push(id); continue; }
          // 等速移動：使用者要舞台從頭到尾同一個速度滑過去，不要一開始慢、最後拖很久（動的是 cue 位置，機關最後再套）
          const t = cueMoveProgress(now - tw.startTs, tw.durationMs);
          base.pos.lerpVectors(tw.fromPos, tw.toPos, t);
          base.quat.slerpQuaternions(tw.fromQuat, tw.toQuat, t);
          if (t >= 1) finished.push(id);
        }
        for (const id of finished) tweens.delete(id);
      }

      // 出現 / 消失的淡入淡出（等速；淡完換回原本材質，不留半透明）
      if (!framePoses && fades.size > 0) {
        const now = performance.now();
        const meshes = meshesRef.current;
        for (const [id, f] of fades) {
          const mesh = meshes.get(id);
          if (!mesh) { fades.delete(id); continue; }
          const k = cueMoveProgress(now - f.startTs, f.durationMs);
          setObjectOpacity(mesh, lerpOpacity(f.from, f.to, k));
          if (k >= 1) fades.delete(id);
        }
      }

      // 機關：這一幀的值（影片時間軸 / 照機器速度走）→ 套到每個物件（整個畫面只在這裡寫 mesh 的位置）
      commitPosesRef.current(nowTs, !!framePoses);

      const rmode = renderModeRef.current;

      // VR 模式時 EffectComposer / CubeCamera 不能用（需要單一 framebuffer）
      const inXR = renderer.xr.isPresenting;
      const live = rmode === 'live';
      const rig = ledRigRef.current;
      if (live && rig) {
        rig.updatePoses(meshesRef.current);
        // 取色：每 100ms 一次（燈色跟著畫面內容變）
        if (nowTs - lastColorTs > 100 && colorReaderRef.current) {
          lastColorTs = nowTs;
          const reader = colorReaderRef.current;
          reader.beginFrame();
          const sources = ledSourcesRef.current;
          const props = ledLightPropsRef.current;
          const fallback: LedLightProps = { brightness: 1, castStrength: 1, tint: new THREE.Color(1, 1, 1) };
          rig.updateColors(
            (id, uv) => { const src = sources.get(id); return src ? reader.sample(src, uv) : null; },
            (id) => props.get(id) || fallback,
            lookRef.current.ledLightStrength,
          );
          // LED 表面：像素格密度跟著貼圖解析度、側看衰減跟著現場設定（測試圖不畫像素格，字才清楚）
          const liveTexture = ndiLiveTextureRef.current?.texture;
          for (const mat of ledMaterialsRef.current) {
            const tex = mat.emissiveMap;
            const img = tex?.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
            const density = tex && tex === liveTexture ? NDI_PIXEL_DENSITY : 1;
            const iw = img?.videoWidth || img?.width || 1;
            const ih = img?.videoHeight || img?.height || 1;
            updateLedSurface(mat, {
              on: !!tex,
              texels: [iw * density, ih * density],
              gridStrength: tex && !tex.userData.ledTestPattern ? 1 : 0,
              viewFalloff: lookRef.current.ledViewFalloff,
            });
          }
        }
        // 環境光（反射 / 染色）：依畫質檔定時更新
        const env = ledEnvRef.current;
        if (env && !inXR && nowTs - lastEnvTs > qualityRef.current.envIntervalMs) {
          lastEnvTs = nowTs;
          const b = stageBoundsRef.current;
          scene.environment = env.update(scene, b.center, b.radius);
        }
      }

      // 地板倒影：主畫面之前先從鏡像相機畫一次
      if (live && !inXR) floorReflRef.current?.render(scene, camera);

      if (live && composerRef.current && !inXR) {
        composerRef.current.render();
      } else {
        renderer.render(scene, camera);
      }

      // update HTML labels（layer.style 控制全體顯隱，個別 label 仍會被 updateLabels 算位置）
      if (!inXR) updateLabels(labelsRef.current, meshesRef.current, camera, container);
      // 鎖頭 pin：只在可編輯頁、Label 開著時顯示
      if (!inXR && !readOnlyRef.current && showLabelsRef.current) {
        updateLockPins(lockPinLayerRef.current, statesRef.current || [], meshesRef.current, camera, container);
      }

      // 3D-anchored comment pins — 用 displayName map 補強 mesh lookup
      if (!inXR) {
        const dnMap = new Map<string, THREE.Object3D>();
        if (statesRef.current) {
          for (const s of statesRef.current) {
            const m = meshesRef.current.get(s.objectId);
            if (m) {
              dnMap.set(s.displayName, m);
              dnMap.set(s.meshName, m);  // 也支援 meshName 命中
            }
          }
        }
        updateCommentPins(commentPinLayerRef.current, commentsRef.current, meshesRef.current, camera, container, dnMap);
      }
    };
    renderer.setAnimationLoop(tick);

    // Resize
    const ro = new ResizeObserver(applyQuality);
    ro.observe(container);

    return () => {
      stopped = true;
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      try { fadeWarmupRef.current?.dispose(); } catch {}
      fadeWarmupRef.current = null;
      try { renderer.setAnimationLoop(null); } catch {}
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      try { scene.remove(transformHelper); } catch {}
      try { transform.detach(); } catch {}
      try { transform.dispose(); } catch (e) { console.warn('TransformControls dispose:', e); }
      try { orbit.dispose(); } catch {}
      // 現場模式 cleanup
      try { ledRigRef.current?.dispose(); } catch {}
      ledRigRef.current = null;
      try { ledEnvRef.current?.dispose(); } catch {}
      try { floorReflRef.current?.dispose(); } catch {}
      floorReflRef.current = null;
      ledEnvRef.current = null;
      colorReaderRef.current = null;
      helpersRef.current = null;
      try { composerRef.current?.dispose(); } catch {}
      composerRef.current = null;
      bloomPassRef.current = null;
      try { ndiLiveTextureRef.current?.texture.dispose(); } catch {}
      ndiLiveTextureRef.current = null;
      try {
        if (measureLineRef.current) {
          scene.remove(measureLineRef.current);
          (measureLineRef.current.geometry as THREE.BufferGeometry).dispose();
          (measureLineRef.current.material as THREE.Material).dispose();
        }
      } catch {}
      measureLineRef.current = null;
      measurePointsRef.current = [];
      try { renderer.dispose(); } catch {}
      try { container.removeChild(renderer.domElement); } catch {}
      const layer = labelLayerRef.current;
      if (layer) try { container.removeChild(layer); } catch {}
      labelLayerRef.current = null;  // strict mode 双跑時別 leak 到舊 detached DOM
      const pinLayer = commentPinLayerRef.current;
      if (pinLayer) try { container.removeChild(pinLayer); } catch {}
      commentPinLayerRef.current = null;
      const lockLayer = lockPinLayerRef.current;
      if (lockLayer) try { container.removeChild(lockLayer); } catch {}
      lockPinLayerRef.current = null;
      labelsRef.current.clear();
      meshesRef.current.clear();
      modelMeshMapRef.current.clear();
      sceneRef.current = null;
    };
  }, []);

  // ── VR Button — 只在瀏覽器支援時顯示（Quest browser、Edge with WebXR enabled、PCVR + Steam）；只看模式不放 ──
  useEffect(() => {
    const renderer = rendererRef.current;
    const container = containerRef.current;
    if (viewer || !renderer || !container) return;
    // 不支援 VR 的瀏覽器不放按鈕（以前會顯示英文的「VR NOT SUPPORTED」）；按鈕上的字改成中文
    const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
    if (!xr) return;
    let cancelled = false;
    let vrBtn: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    xr.isSessionSupported('immersive-vr').then(ok => {
      if (!ok || cancelled) return;
      try {
        const btn = VRButton.createButton(renderer);
        btn.classList.add('stage-scene__vr-btn');
        const translate = () => {
          const t = btn.textContent;
          if (t === 'ENTER VR') btn.textContent = '進入 VR';
          else if (t === 'EXIT VR') btn.textContent = '離開 VR';
        };
        observer = new MutationObserver(translate);
        observer.observe(btn, { childList: true, characterData: true, subtree: true });
        translate();
        container.appendChild(btn);
        vrBtn = btn;
      } catch (e) {
        console.warn('[StageScene] VRButton failed (no WebXR support?):', e);
      }
    }).catch(() => { /* 問不到 = 不支援 */ });
    return () => { cancelled = true; observer?.disconnect(); vrBtn?.remove(); };
  }, [viewer]);

  // ── Load .glb model (if any) → build mesh_name map ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !modelUrl) {
      modelMeshMapRef.current.clear();
      return;
    }

    let cancelled = false;
    setModelLoading(true);
    // 壓縮過的模型（Draco / meshopt）會先載入解壓縮器；解出來的節點、位置、縮放跟原檔一樣（lib/modelLoader.ts）
    const abort = new AbortController();
    loadModel(modelUrl, { signal: abort.signal }).then(
      (gltf) => {
        if (cancelled) return;
        // 算 scene bbox + scaleFactor（跟 parseGlb 同邏輯，避免兩邊不一致）
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        const diag = size.length();
        const scaleFactor = computeScaleFactor(diag);

        // 用同樣的 findBestScope 找實際 LED/STAGE 等所在的層級
        gltf.scene.updateMatrixWorld(true);
        const bestScope = findBestScope(gltf.scene);

        // baked scaleFactor 進 children + 把 children 從 wrapper detach 出來
        // 改用 world transform，這樣 wrapper 的 transform 不會 leak
        const map = new Map<string, THREE.Object3D>();
        const children = [...bestScope.children]; // 複製 array（detach 會改原 array）
        children.forEach((child) => {
          const name = (child.name || '').trim();
          if (!name) return;

          // 把 wrapper 的 world transform baked 進 child
          const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
          child.matrixWorld.decompose(wp, wq, ws);

          // detach（移到 root），然後 set world transform back
          if (child.parent) child.parent.remove(child);
          child.position.copy(wp).multiplyScalar(scaleFactor);
          child.quaternion.copy(wq);
          child.scale.copy(ws).multiplyScalar(scaleFactor);

          map.set(name, child);
        });
        modelMeshMapRef.current = map;

        // 重新算 bbox after scale baking
        // 注意：children 已經從 gltf.scene detach，要從 map 算，不然 bbox 是空的、鏡頭不會對準舞台
        const finalBox = new THREE.Box3();
        map.forEach(c => finalBox.expandByObject(c));
        const finalSize = finalBox.getSize(new THREE.Vector3());
        const finalCenter = finalBox.getCenter(new THREE.Vector3());
        const finalDiag = finalSize.length();

        if (scaleFactor !== 1) {
          console.warn(`[StageScene] model diag ${diag.toFixed(2)}m → scaled by ${scaleFactor} → final ${finalDiag.toFixed(2)}m`);
        }

        // Auto-fit camera
        const cam = cameraRef.current;
        const orb = orbitRef.current;
        if (cam && orb && finalDiag > 0) {
          // 正面全景：從 LED 面朝的那一側（觀眾席）稍微高一點看，整個舞台剛好入鏡
          // admin 有設重置視角 → 一打開就用它
          const home = computeFrontView([...map.values()], ledModelRoots(map), DEFAULT_FOV, viewAspect());
          homeViewRef.current = { position: home.position.clone(), target: home.target.clone() };
          const custom = homeViewPropRef.current;
          cam.position.copy(custom ? new THREE.Vector3(...custom.position) : home.position);
          orb.target.copy(custom ? new THREE.Vector3(...custom.target) : home.target);
          cam.fov = custom ? custom.fov : DEFAULT_FOV;
          cam.near = Math.max(0.01, finalDiag / 1000);
          cam.far  = Math.max(200, finalDiag * 10);
          cam.updateProjectionMatrix();
          userMovedCameraRef.current = false;
          stageBoundsRef.current = { center: finalCenter.clone(), radius: finalDiag / 2 };
        }

        // 觸發 mesh 重建：清掉舊 mesh + label，bump modelVersion 讓 sync / 材質 / wireframe effect 重跑
        // （之前只 clear 沒 bump，模型比 cue 資料晚到時舞台整個不見，只剩 label）
        meshesRef.current.forEach((m) => {
          scene.remove(m);
          disposeObject3D(m);
        });
        meshesRef.current.clear();
        labelsRef.current.forEach((lbl) => lbl.remove());
        labelsRef.current.clear();
        // 新模型要建 mesh、編 shader → 前幾秒卡是正常的，自動畫質先不量
        adaptiveQualityRef.current?.hold(performance.now(), 4000);
        setModelLoading(false);
        setModelVersion((v) => v + 1);
      },
    ).catch((err) => {
      if (cancelled) return;
      console.error('GLTF load failed:', err);
      setModelLoading(false);
    });

    return () => { cancelled = true; abort.abort(); };
  }, [modelUrl]);

  // ── Sync states → scene meshes ──
  useEffect(() => {
    const scene = sceneRef.current;
    const container = containerRef.current;
    if (!scene || !container) return;

    // ensure label layer — 同時清掉之前 strict-mode/HMR 殘留的 .stage-scene__labels
    {
      const oldLayers = container.querySelectorAll('.stage-scene__labels');
      oldLayers.forEach(l => { if (l !== labelLayerRef.current) l.remove(); });
    }
    if (!labelLayerRef.current || !container.contains(labelLayerRef.current)) {
      const layer = document.createElement('div');
      layer.className = 'stage-scene__labels';
      layer.style.display = showLabelsRef.current ? '' : 'none';
      container.appendChild(layer);
      labelLayerRef.current = layer;
    }
    const layer = labelLayerRef.current;
    const meshes = meshesRef.current;
    const labels = labelsRef.current;
    // 移除 layer 內不在 labels Map 的孤兒 label DOM（避免重複）
    {
      const valid = new Set<Element>(Array.from(labels.values()));
      Array.from(layer.children).forEach(child => {
        if (!valid.has(child)) layer.removeChild(child);
      });
    }

    const statesChanged = lastSyncedStatesRef.current !== states;
    lastSyncedStatesRef.current = states;
    // 有給 cueKey：只有換 cue 後那一次滑；編輯物件位置時直接套
    const smoothThisRun = statesChanged && (cueKey === undefined || cueChangedRef.current);
    if (statesChanged) cueChangedRef.current = false;

    const currentIds = new Set(states.map(s => s.objectId));

    // Remove gone
    for (const [id, obj] of meshes) {
      if (!currentIds.has(id)) {
        scene.remove(obj);
        disposeObject3D(obj);
        meshes.delete(id);
        basePoseRef.current.delete(id);
        const lbl = labels.get(id);
        if (lbl) { layer.removeChild(lbl); labels.delete(id); }
      }
    }

    // Add / update
    for (const s of states) {
      let obj = meshes.get(s.objectId);
      const justCreated = !obj;
      if (!obj) {
        // 優先：從 GLB 模型 clone 對應 mesh_name 的物件；沒有 → 用 primitive
        const fromModel = modelMeshMapRef.current.get(s.meshName);
        if (fromModel) {
          obj = fromModel.clone(true);
          obj.userData.fromModel = true;  // LED 對位圖只看模型裡的（沒模型時的方塊替身不算）
          const isLedPanel = s.category === 'led_panel';
          // 給每個子 mesh 標 objectId 讓 raycaster 抓得到
          obj.traverse((child) => {
            child.userData.objectId = s.objectId;
            // 如果原 material 是 MeshBasicMaterial 之類，換成 PBR 才能高亮
            if ((child as THREE.Mesh).isMesh) {
              const m = child as THREE.Mesh;
              const old = m.material as THREE.Material;
              if (!(old instanceof THREE.MeshStandardMaterial)) {
                const stdMat = new THREE.MeshStandardMaterial({
                  color: (old as any).color || new THREE.Color(0xcccccc),
                  roughness: 0.6,
                  metalness: 0.1,
                });
                stdMat.name = old.name; // 材質面板依名稱調整
                m.material = stdMat;
              }
              // 雙面渲染：LED 面板維持單面（emissive 不該從背面看到），其他都雙面（喇叭等不會少一面）
              const mat = m.material as THREE.MeshStandardMaterial;
              mat.side = isLedPanel ? THREE.FrontSide : THREE.DoubleSide;
              mat.needsUpdate = true;
            }
          });
        } else {
          const geom = (CATEGORY_GEOM[s.category] || CATEGORY_GEOM.other)();
          const mat = new THREE.MeshStandardMaterial({
            color: CATEGORY_COLORS[s.category] || CATEGORY_COLORS.other,
            roughness: 0.55,
            metalness: 0.1,
          });
          obj = new THREE.Mesh(geom, mat);
        }
        obj.userData.objectId = s.objectId;
        scene.add(obj);
        meshes.set(s.objectId, obj);

        const lbl = document.createElement('div');
        lbl.className = 'stage-scene__label';
        setObjectLabel(lbl, s.displayName, !!s.locked && !readOnly);
        lbl.dataset.objectId = s.objectId;
        layer.appendChild(lbl);
        labels.set(s.objectId, lbl);
      } else {
        const lbl = labels.get(s.objectId);
        if (lbl) setObjectLabel(lbl, s.displayName, !!s.locked && !readOnly);
      }
      obj.userData.locked = !!s.locked;
      obj.userData.objectId = s.objectId;

      // cue 位置（場景單位）；機關的位移 / 旋轉在 render loop 最後 commitPoses 一起套（只有那裡寫 mesh）
      const p = s.effective.position;
      const worldQuat = cueQuaternion(s.effective.rotation);
      // Crossfade：如果開了，從現在的 cue 位置 tween 到目標
      // 前提：mesh 不在 multiPivot 下（pivot 模式表示用戶正在拖，不該 tween）
      const xfade = crossfadeRef.current;
      const inPivot = obj.parent && obj.parent !== scene;
      const running = tweensRef.current.get(s.objectId);
      const base = basePoseRef.current.get(s.objectId);
      if (running && !statesChanged && !inPivot) {
        // 移動中又因為別的原因（選取 / 校準）重算 → 改終點、繼續滑，不要瞬間跳到終點
        running.toPos.set(p.x, p.y, p.z);
        running.toQuat.copy(worldQuat);
      } else if (xfade > 0 && smoothThisRun && !justCreated && !inPivot && base && (base.pos.distanceTo(new THREE.Vector3(p.x, p.y, p.z)) > 0.001 || !base.quat.equals(worldQuat))) {
        tweensRef.current.set(s.objectId, {
          fromPos: base.pos.clone(),
          toPos: new THREE.Vector3(p.x, p.y, p.z),
          fromQuat: base.quat.clone(),
          toQuat: worldQuat.clone(),
          startTs: performance.now(),
          durationMs: xfade * 1000,
        });
      } else {
        // 沒 crossfade：直接套（多選拖曳中的 pivot 物件也是改 cue 位置，commitPoses 會換算進 pivot）
        setBasePose(s.objectId, p, worldQuat);
        // 跳過 tween → 確保 tweensRef 沒留 stale
        tweensRef.current.delete(s.objectId);
      }
      // 出現 / 消失：換 cue 時跟移動一起等速淡入淡出（同一個秒數、同時開始）；
      // 編輯時切顯示 / 隱藏（不是換 cue）照舊馬上變
      const targetOpacity = s.effective.visible ? 1 : 0;
      const fading = fadesRef.current.has(s.objectId);
      if (fading && !statesChanged) {
        // 淡到一半因為別的原因（選取 / 機關）重算 → 繼續淡
      } else if (xfade > 0 && smoothThisRun && !justCreated && !inPivot && getObjectOpacity(obj) !== targetOpacity) {
        fadesRef.current.set(s.objectId, {
          from: getObjectOpacity(obj),
          to: targetOpacity,
          startTs: performance.now(),
          durationMs: xfade * 1000,
        });
      } else {
        fadesRef.current.delete(s.objectId);
        setObjectOpacity(obj, targetOpacity);
      }

      // emissive 決策統一處理（避免兩個 useEffect 覆蓋）：
      //   1. selected → 綠色 highlight
      //   2. LED panel 在 realistic 模式 → tint 發光（自身 + RectAreaLight 投射）
      //   3. 其他 → 不發光
      // 注意：別在這裡套，把這個 effect 留給「位置/visibility」，emissive 留給專門的 effect
      // 統一在一個 effect 處理 emissive
      // ↓ 已 moved 到下方 useEffect

      const lbl = labels.get(s.objectId);
      if (lbl) {
        lbl.classList.toggle('is-selected', selectedObjectIds.includes(s.objectId));
        lbl.classList.toggle('has-override', !!s.override);
      }
    }
    // 馬上套一次（縮圖 / 截圖不會晚一幀）
    commitPosesRef.current(performance.now(), timelineActiveRef.current);
  }, [states, selectedObjectIds, modelVersion, readOnly]);

  // ── 機關目標：換 cue → 照機器速度走過去；同一個 cue 裡改值（滑桿 / 常用位置 / 打字）→ 直接跳 ──
  const lastMechCueKeyRef = useRef<string | null | undefined | typeof UNSET_CUE>(UNSET_CUE);
  useEffect(() => {
    const prev = lastMechCueKeyRef.current;
    const animate = mechanismMotion !== 'instant' && prev !== UNSET_CUE && cueKey !== prev;
    const now = performance.now();
    mechTweenerRef.current.retarget(rig.mechanisms, mechanismTargets || EMPTY_VALUES, now, {
      animate, minSeconds: crossfadeSeconds, motion: mechanismMotion,
    });
    lastMechCueKeyRef.current = cueKey;
    commitPosesRef.current(now, timelineActiveRef.current);
  }, [rig, mechanismTargets, cueKey, crossfadeSeconds, mechanismMotion]);

  // ── 設定機關時問舞台：正面朝哪、一組物件的中心（cue 位置，沒加機關）──
  useEffect(() => {
    if (!sceneQueryRef) return;
    const query: StageSceneQuery = {
      stageFront: () => {
        let leds = ledModelRoots(modelMeshMapRef.current);
        if (leds.length === 0) {
          const list: { id: string; category: string }[] = stageObjectsRef.current
            ? stageObjectsRef.current.map(o => ({ id: o.id, category: o.category }))
            : (statesRef.current || []).map(s => ({ id: s.objectId, category: s.category }));
          const ids = new Set(list.filter(o => o.category === 'led_panel').map(o => o.id));
          leds = [...meshesRef.current].filter(([id]) => ids.has(id)).map(([, m]) => m);
        }
        const f = stageFrontDirection(leds);
        return { x: f.x, y: f.y, z: f.z };
      },
      groupCenter: (ids) => {
        const box = baseBox(ids);
        if (box.isEmpty()) return null;
        const c = box.getCenter(new THREE.Vector3());
        return { x: c.x, y: c.y, z: c.z };
      },
    };
    sceneQueryRef.current = query;
    return () => { if (sceneQueryRef.current === query) sceneQueryRef.current = null; };
  }, [sceneQueryRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 審片：目前的視角、飛到留言記住的視角、抓縮圖 ──
  useEffect(() => {
    if (!viewApiRef) return;
    const listeners = new Set<() => void>();
    const orbit = orbitRef.current;
    const onStart = () => {
      cancelFlight();
      for (const cb of listeners) { try { cb(); } catch { /* 一個壞掉不影響別的 */ } }
    };
    orbit?.addEventListener('start', onStart);
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    const api: StageViewApi = {
      getView: () => {
        const cam = cameraRef.current;
        const orb = orbitRef.current;
        if (!cam || !orb) return null;
        return {
          position: [r4(cam.position.x), r4(cam.position.y), r4(cam.position.z)],
          target: [r4(orb.target.x), r4(orb.target.y), r4(orb.target.z)],
          fov: r4(cam.fov),
          aspect: r4(viewAspect()),
        };
      },
      flyTo: (v, opts = {}) => {
        if (!v || !Array.isArray(v.position) || !Array.isArray(v.target)) return Promise.resolve();
        userMovedCameraRef.current = true;  // 之後才讀到的重置視角不要把鏡頭搬走
        const fov = fitFov(v.fov, opts.fitAspect ?? v.aspect ?? null, viewAspect());
        return flyCamera(new THREE.Vector3(...v.position), new THREE.Vector3(...v.target), fov, opts.durationMs);
      },
      capture: (maxWidth = 480) => {
        const src = rendererRef.current?.domElement;
        if (!src || !src.width || !src.height) return null;
        try {
          const k = Math.min(1, maxWidth / src.width);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(src.width * k));
          c.height = Math.max(1, Math.round(src.height * k));
          const ctx = c.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(src, 0, 0, c.width, c.height);
          return c;
        } catch (e) {
          console.warn('[StageScene] capture failed:', e);
          return null;
        }
      },
      aspect: () => viewAspect(),
      onUserMove: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    };
    viewApiRef.current = api;
    return () => {
      orbit?.removeEventListener('start', onStart);
      if (viewApiRef.current === api) viewApiRef.current = null;
      cancelFlight();
    };
  }, [viewApiRef]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 這些物件在 cue 位置（沒加機關）時的外框 */
  function baseBox(ids: string[]): THREE.Box3 {
    const scene = sceneRef.current;
    const box = new THREE.Box3();
    const pt = new THREE.Vector3();
    for (const id of ids) {
      const mesh = meshesRef.current.get(id);
      const base = basePoseRef.current.get(id);
      if (!mesh || !base) continue;
      if (mesh.parent !== scene) { box.expandByPoint(pt.copy(base.pos)); continue; }
      const keepPos = mesh.position.clone(), keepQuat = mesh.quaternion.clone();
      mesh.position.copy(base.pos);
      mesh.quaternion.copy(base.quat);
      mesh.updateMatrixWorld(true);
      box.expandByObject(mesh);
      mesh.position.copy(keepPos);
      mesh.quaternion.copy(keepQuat);
      mesh.updateMatrixWorld(true);
    }
    return box;
  }

  // ── 管理頁點到的機關：3D 畫面上畫出行程（直線 / 圓弧，常用位置、兩端有刻度）；外層機關動的時候跟著動 ──
  const travelRef = useRef<{ group: THREE.Group; outer: RigMechanism[] } | null>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const m = focusedMechanismId ? rig.byId.get(focusedMechanismId) : undefined;
    if (!m) return;
    // 畫在哪：機關帶的第一個物件（通常就是升降台 / 轉台本身）；沒有 → 裝在它上面的機關帶的物件
    const def = (mechanisms || []).find(x => x.id === m.id);
    let ids = def?.objectIds.filter(id => rig.chains.get(id)?.[0] === m).slice(0, 1) ?? [];
    if (ids.length === 0) ids = [...rig.chains].filter(([, chain]) => chain.includes(m)).map(([id]) => id);
    const box = baseBox(ids);
    const center = box.isEmpty() ? m.pivot.clone() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? 1 : Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.2);
    const presets = def?.presets.map(p => p.value) || [];
    const g = travelGeometry(m, center, size, presets);
    const color = new THREE.Color(0xffaa44);
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
    const tickMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
    const group = new THREE.Group();
    group.name = 'mechanism-travel';
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(g.path), lineMat);
    const segs = [...g.ends, ...g.ticks].flat();
    const ticks = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), tickMat);
    for (const o of [line, ticks]) { o.renderOrder = 999; o.frustumCulled = false; group.add(o); }
    // 外層的機關（這個機關裝在哪個機關上）
    const outer: RigMechanism[] = [];
    for (let cur = m.parentId ? rig.byId.get(m.parentId) : undefined; cur && outer.length < 4 && !outer.includes(cur); cur = cur.parentId ? rig.byId.get(cur.parentId) : undefined) {
      outer.push(cur);
    }
    scene.add(group);
    travelRef.current = { group, outer };
    applyChain(outer, displayedMechRef.current, ZERO_VEC, IDENTITY_QUAT, group.position, group.quaternion);
    return () => {
      scene.remove(group);
      line.geometry.dispose();
      ticks.geometry.dispose();
      lineMat.dispose();
      tickMat.dispose();
      if (travelRef.current?.group === group) travelRef.current = null;
    };
  }, [focusedMechanismId, rig, mechanisms, states, modelVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attach gizmo：單選 attach mesh、多選建 pivot 把 mesh reparent 進去 ──
  useEffect(() => {
    const transform = transformRef.current;
    const scene = sceneRef.current;
    if (!transform || !scene) return;

    // 先拆掉之前的 pivot（若有），把 children 還回 scene
    const prevPivot = multiPivotRef.current;
    if (prevPivot) {
      [...prevPivot.children].forEach(c => scene.attach(c));
      if (transform.object === prevPivot) transform.detach();
      scene.remove(prevPivot);
      multiPivotRef.current = null;
    }

    // 唯讀模式：永遠 detach（不顯示 gizmo）
    if (readOnly) {
      transform.detach();
      return;
    }

    if (selectedObjectIds.length === 0) {
      transform.detach();
      return;
    }
    if (selectedObjectIds.length === 1) {
      const obj = meshesRef.current.get(selectedObjectIds[0]);
      if (obj) transform.attach(obj);
      else transform.detach();
      return;
    }
    // 多選：建 pivot 在 mesh 中心，把 mesh attach 進去
    const meshes = selectedObjectIds
      .map(id => meshesRef.current.get(id))
      .filter((m): m is THREE.Object3D => !!m);
    if (meshes.length < 2) {
      if (meshes.length === 1) transform.attach(meshes[0]);
      else transform.detach();
      return;
    }
    const center = new THREE.Vector3();
    meshes.forEach(m => {
      const wp = new THREE.Vector3();
      m.getWorldPosition(wp);
      center.add(wp);
    });
    center.divideScalar(meshes.length);
    const pivot = new THREE.Group();
    pivot.position.copy(center);
    scene.add(pivot);
    multiPivotRef.current = pivot;
    meshes.forEach(m => pivot.attach(m));
    transform.attach(pivot);
  }, [selectedObjectIds, states.length, pivotVersion, readOnly, modelVersion]);

  // ── Mode / space ──
  useEffect(() => { transformRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { transformRef.current?.setSpace(space); }, [space]);

  // ── Label visibility（鎖頭 pin 跟著 Label，且唯讀頁不顯示）──
  useEffect(() => {
    showLabelsRef.current = showLabels;
    const layer = labelLayerRef.current;
    if (layer) layer.style.display = showLabels ? '' : 'none';
    const lockLayer = lockPinLayerRef.current;
    if (lockLayer) lockLayer.style.display = showLabels && !readOnly ? '' : 'none';
  }, [showLabels, readOnly]);

  // ── AE 即時（NDI 小程序）：連線、權限、重試、暫停都在 useNdiConnection ──
  const ndi = useNdiConnection({
    enabled: enableNdi,
    url: ndiUrl,
    onFrame: (bitmap) => {
      const liveTex = ndiLiveTextureRef.current;
      if (!liveTex) { bitmap.close?.(); return; }
      // Adjust canvas size if first frame or size changed
      if (liveTex.canvas.width !== bitmap.width || liveTex.canvas.height !== bitmap.height) {
        liveTex.canvas.width = bitmap.width;
        liveTex.canvas.height = bitmap.height;
        // three.js 第一次上傳就把 GPU 貼圖大小固定（texStorage2D），之後只會覆蓋左上角。
        // AE 切 Full ↔ Half / Third 時 frame 大小會變 → 一定要 dispose，下次使用才會用新尺寸重建，
        // 不然畫面只更新左上角一塊、其他 LED 變黑或卡舊畫面。
        liveTex.texture.dispose();
      }
      liveTex.ctx.drawImage(bitmap, 0, 0);
      liveTex.texture.needsUpdate = true;
      bitmap.close?.();
    },
  });
  const ndiGuideState = ndi.guide;
  // LED 用 AE 畫面：這條連線收過畫面就用（AE 停住時留在最後一格）
  const ndiActive = enableNdi && ndiGuideState.hasFrame;
  useEffect(() => {
    if (enableNdi) onNdiStatus?.(ndiGuideState);
  }, [enableNdi, ndiGuideState, onNdiStatus]);
  const ndiCardShown = enableNdi && showNdiGuide && !ndiPopoverOpen
    && ndiCardVisible(ndiGuideState) && ndiCardHiddenFor !== ndiCardKey(ndiGuideState);

  // ── Render mode（quick / live）+ 現場設定 ──
  useEffect(() => {
    const env = envLightsRef.current;
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!env || !scene || !renderer) return;
    const live = renderMode === 'live';
    const look = lookSettings;
    // 現場：暗場，底光可調；Quick：維持原本明亮工作燈
    env.ambient.intensity = live ? 0.02 + look.houseLight * 0.5 : 0.55;
    env.hemi.intensity = live ? 0.03 + look.houseLight * 0.6 : 0.3;
    if (env.key) env.key.intensity = live ? look.houseLight * 0.4 : 0.7;
    (scene.background as THREE.Color).set(live ? 0x050506 : 0x16181c);
    if (helpersRef.current) {
      helpersRef.current.grid.visible = !live;
      helpersRef.current.axes.visible = !live;
    }
    // 現場：Neutral tone mapping 保留 LED 飽和色；Quick 維持 ACES（畫面不變）
    renderer.toneMapping = live ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = live ? look.exposure : 1;
    if (!live) scene.environment = null;
    scene.environmentIntensity = live ? 0.2 + look.ledLightStrength * 0.4 : 1;
    const bloom = bloomPassRef.current;
    if (bloom) {
      bloom.strength = look.bloomStrength;
      bloom.radius = 0.3;
      bloom.threshold = 0.75;
    }
    ledRigRef.current?.setEnabled(live);
    if (!live) for (const mat of ledMaterialsRef.current) updateLedSurface(mat, { on: false });
    floorReflRef.current?.setSettings(look.floorReflection, look.reflectionSharpness);
    floorReflRef.current?.setEnabled(live && qualityRef.current.reflectionScale > 0);
  }, [renderMode, lookSettings]);

  // 切現場 / 快速：要畫的東西不一樣了 → 前 3 秒（編 shader）不算，之前判定太重的等級可以再試
  useEffect(() => {
    const adaptive = adaptiveQualityRef.current;
    if (!adaptive) return;
    adaptive.resetCeiling();
    adaptive.hold(performance.now(), 3000);
  }, [renderMode]);

  // ── 本地影片 / 圖片 → LED 貼圖（跟 NDI 貼圖同樣設定：flipY false、超出 0~1 繞回）──
  // 圖片跟影片用一模一樣的設定 → 同一張畫面放成圖片或影片，方向、顏色都一樣
  useEffect(() => {
    const image = ledVideo ? null : ledImage;
    if (!ledVideo && !image) { ledMediaTextureRef.current = null; return; }
    const tex = ledVideo ? new THREE.VideoTexture(ledVideo) : new THREE.Texture(image!);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;  // VideoTexture 本來就不做；圖片跟著一樣
    tex.flipY = false;
    tex.wrapS = tex.wrapT = LED_TEXTURE_WRAP;
    if (image) {
      // 圖片只要傳一次（還沒載好就等載好再傳）
      if (image.complete) tex.needsUpdate = true;
      else image.addEventListener('load', () => { tex.needsUpdate = true; }, { once: true });
    }
    // 記下畫面大小（製作還沒設定畫布大小時，LED 對位圖用這個）
    const readSize = () => {
      const w = ledVideo ? ledVideo.videoWidth : image?.naturalWidth || 0;
      const h = ledVideo ? ledVideo.videoHeight : image?.naturalHeight || 0;
      if (w >= 16 && h >= 16) setMediaSize(prev => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    readSize();
    const sizeTarget: HTMLElement | null = ledVideo ?? image ?? null;
    const sizeEvents = ledVideo ? ['loadedmetadata', 'resize'] : ['load'];
    sizeEvents.forEach(ev => sizeTarget?.addEventListener(ev, readSize));
    ledMediaTextureRef.current = tex;
    return () => {
      sizeEvents.forEach(ev => sizeTarget?.removeEventListener(ev, readSize));
      if (ledMediaTextureRef.current === tex) ledMediaTextureRef.current = null;
      tex.dispose();
    };
  }, [ledVideo, ledImage]);

  // ── LED 對位圖 / 測試圖：每塊 LED 在畫布上的位置（從模型的 UV 算）──
  const resolvedCanvas = useMemo(
    () => resolveLedCanvas(ledCanvas, mediaSize),
    [ledCanvas?.width, ledCanvas?.height, mediaSize?.width, mediaSize?.height], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const computeLedLayout = useCallback((canvas: CanvasSize): LedLayout => {
    const objs: LedSceneObject[] = [];
    const list: { id: string; name: string; order: number; category: string }[] = stageObjectsRef.current
      ? stageObjectsRef.current.map(o => ({ id: o.id, name: o.displayName || o.meshName, order: o.order, category: o.category }))
      : (statesRef.current || []).map(st => ({ id: st.objectId, name: st.displayName || st.meshName, order: st.order, category: st.category }));
    for (const o of list) {
      if (o.category !== 'led_panel') continue;
      const mesh = meshesRef.current.get(o.id);
      if (!mesh || !mesh.userData.fromModel) continue;
      objs.push({ id: o.id, name: o.name, order: o.order, root: mesh });
    }
    return buildLedLayout(ledPanelInputs(objs), canvas);
  }, []);
  // 哪些 LED（名字 / 順序）：變了才重畫測試圖
  const ledObjectsKey = stageObjects
    ? stageObjects.filter(o => o.category === 'led_panel').map(o => `${o.id}:${o.displayName}:${o.order}`).join('|')
    : states.filter(st => st.category === 'led_panel').map(st => `${st.objectId}:${st.displayName}:${st.order}`).join('|');

  // 測試圖貼圖：模型 / LED / 畫布大小換了才重畫（畫一次、上傳一次，之後不用每幀更新）
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    let layout = computeLedLayout(resolvedCanvas.canvas);
    if (layout.panels.length === 0) {
      // 還沒有模型（LED 是方塊替身）：整張畫布一張測試圖
      const hasLed = (stageObjectsRef.current || statesRef.current || []).some(o => o.category === 'led_panel');
      if (!hasLed) { setTestPatternTex(null); return; }
      layout = buildLedLayout([{ id: 'led', name: 'LED', tris: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1] }], resolvedCanvas.canvas);
    }
    const low = startQuality === 'low';
    const maxTex = renderer.capabilities.maxTextureSize || 4096;
    const size = testPatternSize(layout.canvas, Math.min(maxTex, low ? 4096 : 8192), low ? 4e6 : 8.4e6);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      drawTestPattern(ctx, layout, size.scale);
    } catch (e) {
      console.warn('[StageScene] test pattern draw failed:', e);
      return;
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;  // 跟 AE 即時 / 本地檔案同一套（UV 原點在左上）
    tex.wrapS = tex.wrapT = LED_TEXTURE_WRAP;
    tex.generateMipmaps = true;  // 不會變的圖：遠看字和格線不會閃
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.userData.ledTestPattern = true;
    setTestPatternTex(tex);
    // 等材質換成新的那張再丟（不然會有一幀用到已經丟掉的）
    return () => { window.setTimeout(() => tex.dispose(), 1000); };
  }, [modelVersion, ledObjectsKey, states.length, resolvedCanvas.canvas.width, resolvedCanvas.canvas.height, computeLedLayout, startQuality]);

  useEffect(() => {
    try { sessionStorage.setItem('sp_led_test_pattern', forceTestPattern ? '1' : '0'); } catch { /* 只是不會記得 */ }
  }, [forceTestPattern]);

  const ledMapMeta = (): LedMapMeta => ({
    projectName: projectName || '',
    date: todayString(),
    canvas: resolvedCanvas.canvas,
    canvasSource: resolvedCanvas.source,
  });

  async function downloadLedMap(kind: 'png' | 'csv' | 'json' | 'jsx') {
    const layout = computeLedLayout(resolvedCanvas.canvas);
    if (layout.panels.length === 0) {
      toast.error('找不到 LED：要等模型載好，而且物件分類是「LED」的才畫得出來');
      return;
    }
    const meta = ledMapMeta();
    if (kind === 'csv') {
      downloadBlob(new Blob([layoutToCsv(layout)], { type: 'text/csv;charset=utf-8' }), ledMapFileName('csv', meta));
      return;
    }
    if (kind === 'json') {
      downloadBlob(new Blob([layoutToJson(layout, meta)], { type: 'application/json' }), ledMapFileName('json', meta));
      return;
    }
    if (kind === 'jsx') {
      // AE 一鍵建合成（lib/aeCompScript.ts）：畫布大小的合成 + 每塊 LED 的外框、名字（導引圖層）+ 小張的對位圖
      setLedMapBusy('jsx');
      try {
        await new Promise(r => requestAnimationFrame(() => r(null)));
        const r = await downloadAeCompScript(layout, meta);
        toast.success(`AE 合成腳本下載好了：在 AE 按「File > Scripts > Run Script File…」選它${r.withMap ? '' : '（這次沒有夾對位圖，外框和名字都有）'}`, 8000);
      } catch (e) {
        toast.error((e instanceof AeCanvasTooBigError ? '' : 'AE 合成腳本沒做出來：') + (e instanceof Error ? e.message : String(e)));
      } finally {
        setLedMapBusy(null);
      }
      return;
    }
    setLedMapBusy('png');
    try {
      // 先讓「正在畫」顯示出來再開始畫（大畫布要一兩秒）
      await new Promise(r => requestAnimationFrame(() => r(null)));
      const png = await renderAlignmentMapPng(layout, meta);
      downloadBlob(png.blob, ledMapFileName('png', meta));
      if (png.scale < 1) {
        toast.warn(`這台電腦的瀏覽器畫不了原尺寸，對位圖縮小成 ${png.width} × ${png.height}；圖上標的位置還是原尺寸的像素`, 8000);
      } else if (layout.skipped.length > 0) {
        toast.warn(`對位圖下載好了；${layout.skipped.length} 塊 LED 沒有 UV、沒畫出來：${layout.skipped.slice(0, 3).join('、')}${layout.skipped.length > 3 ? '…' : ''}`, 8000);
      } else {
        toast.success(`LED 對位圖下載好了（${meta.canvas.width} × ${meta.canvas.height}）`);
      }
    } catch (e) {
      toast.error('LED 對位圖沒畫出來：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLedMapBusy(null);
    }
  }

  async function editLedCanvas() {
    if (!onLedCanvasChange) return;
    const cur = resolvedCanvas.canvas;
    const v = await promptDialog({
      title: 'LED 畫布大小',
      label: 'AE 合成的寬 × 高（像素）',
      defaultValue: `${cur.width} × ${cur.height}`,
      placeholder: '例：10496 × 5120',
      confirmLabel: '儲存',
      required: false,
      hint: '動畫師的 AE 合成做這個大小，LED 對位圖、測試圖都照它畫；所有人一起用。清空 = 還沒設定',
      validate: (t) => {
        if (!t.trim()) return null;
        const c = parseCanvasInput(t);
        if (!c) return '請寫成「寬 × 高」，例：10496 × 5120';
        if (!normalizeLedCanvas(c)) return `寬、高要是 ${LED_CANVAS_RANGE[0]} 到 ${LED_CANVAS_RANGE[1]} 的整數`;
        return null;
      },
    });
    if (v === null) return;
    if (!v.trim()) {
      onLedCanvasChange(null);
      toast.info('畫布大小清掉了：LED 對位圖改用目前影片的大小，沒有影片就用 3840 × 2160');
      return;
    }
    const c = normalizeLedCanvas(parseCanvasInput(v));
    if (c) {
      onLedCanvasChange(c);
      toast.success(`LED 畫布大小改成 ${c.width} × ${c.height}`);
    }
  }

  // ── Sync 材質 + LED lights + emissive（統一決策，不被其他 effect 覆蓋） ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const meshes = meshesRef.current;
    // 淡入淡出中的物件先換回原本材質再改設定（下一幀淡入淡出會讓複本跟上）
    meshes.forEach(suspendObjectFade);
    const accentGreen = new THREE.Color(0x10c78a);
    const black = new THREE.Color(0x000000);
    const ledIds = new Set<string>();
    const ledMaterials = new Set<THREE.MeshStandardMaterial>();
    const mirrorFlagged = hasMirrorFloor(materialOverrides || {});

    meshes.forEach((obj, id) => {
      const so = stageObjMap.get(id);
      const isSelected = selectedObjectIds.includes(id);
      const isLed = so?.category === 'led_panel';
      const isLit = renderMode !== 'quick'; // 現場模式才打 LED
      const mat = so?.materialProps || {};
      const ledTint = so?.ledProps?.tint ? new THREE.Color(so.ledProps.tint) : new THREE.Color(0xffffff);
      const ledBrightness = so?.ledProps?.brightness ?? 1.0;

      // LED 貼圖 priority（不分 render mode，Quick 也要吃 NDI）：
      //   0. 「LED 顯示測試圖」開著 → 一律測試圖（檢查對位用）
      //   1. user imageUrl（admin 在物件設定的）
      //   2. 本地影片 / 圖片（分享頁拖進來的檔案，ledVideo / ledImage prop）
      //   3. NDI 真連線（ndi-helper 推 frames 進來）
      //   4. 測試圖（還沒有畫面時：每塊 LED 的名字、格線、彩條，看得出對位對不對）
      const ledImageUrl = (isLed && so?.ledProps?.imageUrl) || null;
      let ledTexture: THREE.Texture | null = null;
      if (isLed && forceTestPattern && testPatternTex) {
        ledTexture = testPatternTex;
      } else if (ledImageUrl) {
        const cache = ledTextureCacheRef.current;
        if (!cache.has(ledImageUrl)) {
          const loader = new THREE.TextureLoader();
          loader.setCrossOrigin('anonymous');
          const tex = loader.load(ledImageUrl, undefined, undefined, (err) => {
            console.warn('[StageScene] LED imageUrl load failed (CORS?):', ledImageUrl, err);
          });
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = tex.wrapT = LED_TEXTURE_WRAP;
          cache.set(ledImageUrl, tex);
        }
        ledTexture = cache.get(ledImageUrl) || null;
      } else if (isLed && ledMediaTextureRef.current) {
        // 本地影片 / 圖片（分享頁拖進來的）→ 優先於 NDI
        ledTexture = ledMediaTextureRef.current;
      } else if (isLed && ndiActive && ndiLiveTextureRef.current) {
        // NDI 連上了 → 用真實 NDI frame texture（Quick 模式也要）
        ledTexture = ndiLiveTextureRef.current.texture;
      } else if (isLed && testPatternTex) {
        ledTexture = testPatternTex;
      }

      obj.traverse((c) => {
        if (!(c as THREE.Mesh).isMesh) return;
        // LED 也放進 LED_LAYER → 環境光的 CubeCamera 只拍這層
        if (isLed) c.layers.enable(LED_LAYER);
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!m || !('color' in m)) return;
        // 任何分支改材質之前先記下 C4D 原值（材質面板 / 回到原本 用）
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) captureOriginal(m);

        // 雙面渲染：LED 永遠 FrontSide（emissive 不該從背面看到），其他物件 DoubleSide
        const targetSide = isLed ? THREE.FrontSide : THREE.DoubleSide;
        if (m.side !== targetSide) {
          m.side = targetSide;
          m.needsUpdate = true;
        }

        if (isLed && isLit) {
          // === LED in 現場模式 ===
          // 像真的 LED 牆：
          //   底色接近黑、roughness 0.3 → 畫面暗的地方是黑亮面，會映出其他 LED（反射來自 LED 環境光）
          //   emissive(Map) 是亮度來源；像素顆粒 / 側看變暗由 ledSurface shader 處理
          //   toneMapped = false → 不在材質裡壓色（現場模式統一由 OutputPass 做 Neutral tone mapping）
          m.color.setHex(LED_SURFACE.baseColor);
          m.metalness = 0;
          m.roughness = LED_SURFACE.roughness;
          m.envMapIntensity = LED_SURFACE.envMapIntensity;
          applyLedSurface(m);
          ledMaterials.add(m);
          m.opacity = 1;
          m.transparent = false;
          if (m.toneMapped !== false) {
            m.toneMapped = false;
            m.needsUpdate = true;
          }

          if (ledTexture) {
            if (m.emissiveMap !== ledTexture) {
              m.emissiveMap = ledTexture;
              m.needsUpdate = true;
            }
            // 圖案的明暗 = emissiveMap 像素亮度 × emissive(tint) × emissiveIntensity
            m.emissive.copy(ledTint);
            m.emissiveIntensity = ledBrightness;
          } else {
            if (m.emissiveMap) { m.emissiveMap = null; m.needsUpdate = true; }
            m.emissive.copy(ledTint);
            m.emissiveIntensity = ledBrightness;
          }
          // selected highlight：LED 不洗白，靠 RectAreaLightHelper / outline 之後做
          // 這裡只在沒亮度時加一點點當 hint
          if (isSelected && ledBrightness < 0.05 && !ledTexture) {
            m.emissive.copy(accentGreen);
            m.emissiveIntensity = 0.3;
          }
        } else if (isLed && ledTexture) {
          // === LED in Quick mode（有 NDI 或 imageUrl）===
          // Quick mode 的設計目標：pixel-accurate LED 預覽（給動畫師對顏色用）
          // 不打燈、不 tone map、不 bloom、不 PBR 計算 — texture 直接顯示。
          //   m.map = NDI / imageUrl texture
          //   color 白 = 不染色
          //   metalness 0、roughness 1、envMapIntensity 0 = 不反射不被環境光打亮
          //   toneMapped false = 跳過 ACES，texture pixel 1:1
          //   emissive 黑 = 不疊加自發光（已經是 map 直接顯示了）
          updateLedSurface(m, { on: false });
          if (m.map !== ledTexture) {
            m.map = ledTexture;
            m.needsUpdate = true;
          }
          m.color.setHex(0xffffff);
          m.metalness = 0;
          m.roughness = 1;
          m.envMapIntensity = 0;
          m.opacity = 1;
          m.transparent = false;
          if (m.emissiveMap) { m.emissiveMap = null; m.needsUpdate = true; }
          m.emissive.copy(black);
          m.emissiveIntensity = 0;
          if (m.toneMapped !== false) {
            m.toneMapped = false;
            m.needsUpdate = true;
          }
          if (isSelected) {
            // selected hint：稍微加自發光綠色框感，不洗白本來的內容
            m.emissive.copy(accentGreen);
            m.emissiveIntensity = 0.15;
          }
        } else {
          // === 一般物件 / Quick mode 的 LED（沒貼圖時）===
          // 材質 = C4D 匯出的原值 → 材質面板依名稱的覆寫 → 單一物件 materialProps（舊功能，最優先）
          // （以前會用 category 顏色 + 固定 roughness 0.6 / metalness 0.1 蓋掉，C4D 的材質全被洗成同一種塑膠）
          // 沒模型時的方塊替身：建立時就是 category 顏色，所以「原值」本身就是 category 顏色
          // emissive 只在 selected 時 highlight
          updateLedSurface(m, { on: false });
          applyMaterialSettings(m, materialOverrides?.[m.name], {
            color: mat.color, roughness: mat.roughness, metalness: mat.metalness, opacity: mat.opacity,
          });
          // 地板倒影：非 LED 材質都掛上（shader 只在「落在反射平面上、朝上」的地方才取樣倒影）
          // 有材質勾了「鏡面地板」→ 只有勾的材質反光；都沒勾 → 全部（自動找地板）
          if (!isLed && floorReflRef.current) {
            applyFloorReflection(m, floorReflRef.current.uniforms);
            setFloorReflectionFor(m, mirrorFlagged ? !!materialOverrides?.[m.name]?.mirrorFloor : true);
          }
          // 非 LED/realistic 路徑 → 還原 toneMapped（避免被 realistic 路徑切換時殘留 false）
          if (m.toneMapped !== true) {
            m.toneMapped = true;
            m.needsUpdate = true;
          }
          if (m.emissiveMap) { m.emissiveMap = null; m.needsUpdate = true; }
          // 切回沒貼圖的 LED → 清掉殘留的 NDI map（避免上次切去 Quick 留下的）
          if (isLed && m.map) { m.map = null; m.needsUpdate = true; }
          if (isSelected) {
            m.emissive.copy(accentGreen);
            m.emissiveIntensity = 0.4;
          } else {
            m.emissive.copy(black);
            m.emissiveIntensity = 0;
          }
        }
      });

      // 3. LED 照明：記下取色來源 / 燈參數；發光面只算一次（換模型才重算）
      if (isLed && so) {
        ledSourcesRef.current.set(id, ledTexture
          ? { image: ledTexture.image as CanvasImageSource, flipY: ledTexture.flipY }
          : null);
        ledLightPropsRef.current.set(id, {
          brightness: ledBrightness,
          castStrength: so.ledProps?.castLightStrength ?? 1,
          tint: ledTint.clone(),
        });
        let emitters = emitterCacheRef.current.get(obj);
        if (!emitters) {
          emitters = buildLedEmitters(obj, { maxAngleDeg: 35, maxPerObject: 4 });
          emitterCacheRef.current.set(obj, emitters);
        }
        ledRigRef.current?.setObjectEmitters(id, emitters);
        ledIds.add(id);
      }
    });

    ledMaterialsRef.current = ledMaterials;
    ledRigRef.current?.retainObjects(ledIds);
    for (const id of [...ledSourcesRef.current.keys()]) {
      if (!ledIds.has(id)) { ledSourcesRef.current.delete(id); ledLightPropsRef.current.delete(id); }
    }
  }, [stageObjects, renderMode, states, selectedObjectIds, ndiActive, modelVersion, materialOverrides, ledVideo, ledImage, testPatternTex, forceTestPattern]);

  // ── 淡入淡出的半透明 shader 先編好（不然第一次換 cue 淡入淡出會卡一下）──
  // 模型載好 / 切模式 / 改材質 / 換 LED 畫面 / 畫質換了（燈數會變）→ 等畫面穩一點再編
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!renderer || !scene || !camera || renderer.xr.isPresenting || meshesRef.current.size === 0) return;
      const warm = createFadeWarmup(meshesRef.current.values());
      const live = renderModeRef.current === 'live';
      const prevTarget = renderer.getRenderTarget();
      try {
        // 現場模式是畫進 composer 的 render target（不 tone map）→ 用同樣的設定編；快速模式直接畫到畫面
        const composer = composerRef.current;
        if (live && composer) renderer.setRenderTarget(composer.renderTarget1);
        const all = new THREE.Scene();
        warm.meshes.forEach((m) => all.add(m));
        renderer.compile(all, camera, scene);
        // LED 環境光的 CubeCamera 只拍 LED：沒有燈、沒有環境貼圖 → LED 的複本再編一份
        if (live && ledEnvRef.current) {
          const ledOnly = new THREE.Scene();
          warm.meshes.forEach((m) => { if (m.layers.isEnabled(LED_LAYER)) ledOnly.add(m); });
          if (ledOnly.children.length > 0) {
            const ledCamera = camera.clone();
            ledCamera.layers.set(LED_LAYER);
            const prevEnv = scene.environment;
            scene.environment = null;
            try { renderer.compile(ledOnly, ledCamera, scene); } finally { scene.environment = prevEnv; }
          }
        }
      } catch (e) {
        console.warn('[StageScene] fade shader warm-up failed:', e);
      } finally {
        renderer.setRenderTarget(prevTarget);
      }
      // 新的編好才丟舊的（還在用的 shader 不會被刪掉又重編）
      fadeWarmupRef.current?.dispose();
      fadeWarmupRef.current = warm;
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [modelVersion, renderMode, materialOverrides, stageObjects, ledVideo, ledImage, ndiActive, qualityLevel, testPatternTex, forceTestPattern]);

  // ── 地板倒影的反射平面 + 材質面板的材質清單（換模型 / 物件移動 / 改材質後重算）──
  useEffect(() => {
    const roots: THREE.Object3D[] = [];
    meshesRef.current.forEach((obj, id) => {
      if (stageObjMap.get(id)?.category !== 'led_panel') roots.push(obj);
    });

    // 有材質勾「鏡面地板」→ 只從那些材質找地板；都沒勾 → 自動找最大的朝上水平面
    const refl = floorReflRef.current;
    if (refl) {
      const flagged = new Set(Object.entries(materialOverrides || {}).filter(([, v]) => v.mirrorFloor).map(([k]) => k));
      const plane = flagged.size > 0
        ? detectFloorPlane(roots, { meshFilter: (m) => flagged.has((m.material as THREE.Material).name) })
        : detectFloorPlane(roots);
      refl.setPlane(plane ? plane.y : null, Math.max(stageBoundsRef.current.radius * 0.002, 1e-4));
    }

    // 材質清單：非 LED 物件的材質依名稱分組（用到幾個物件 + C4D 原值）
    const byName = new Map<string, { objects: Set<THREE.Object3D>; original: ModelMaterialInfo['original'] }>();
    for (const root of roots) {
      root.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!(c as THREE.Mesh).isMesh || !m?.isMeshStandardMaterial) return;
        const entry = byName.get(m.name) || { objects: new Set(), original: captureOriginal(m) };
        entry.objects.add(root);
        byName.set(m.name, entry);
      });
    }
    const list: ModelMaterialInfo[] = [...byName.entries()].map(([name, e]) => ({ name, count: e.objects.size, original: e.original }));
    setModelMaterials(prev => {
      const key = (l: ModelMaterialInfo[]) => l.map(x => `${x.name}:${x.count}`).join('|');
      return key(prev) === key(list) ? prev : list;
    });
  }, [states, modelVersion, materialOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  void RectAreaLightHelper; // keep import in case we want helper toggle later

  // ── Wireframe sync（每次切換或新 mesh 進來都套）──
  useEffect(() => {
    const meshes = meshesRef.current;
    meshes.forEach((obj) => {
      suspendObjectFade(obj);  // 淡入淡出中 → 改原本材質（下一幀複本會跟上）
      obj.traverse((c) => {
        if (!(c as THREE.Mesh).isMesh) return;
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (m && 'wireframe' in m) m.wireframe = wireframe;
      });
    });
  }, [wireframe, states, stageObjects, modelVersion]);

  // ── 比例尺輔助：人形剪影 + 每格 1 公尺的網格 ──
  // 用 scaleCorrection 把真實公尺換算成 scene units，所以校準後尺寸就會對得起來。
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // 拆掉舊的
    if (scaleRefGroupRef.current) {
      scene.remove(scaleRefGroupRef.current);
      scaleRefGroupRef.current.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach(x => x?.dispose?.());
          else mat?.dispose?.();
        }
      });
      scaleRefGroupRef.current = null;
    }

    if (!showScaleRef) return;

    const group = new THREE.Group();
    group.name = 'scale-reference';

    // 1 公尺對應幾個 scene unit
    const unitsPerMeter = 1 / scaleCorrection;

    // 網格：20m × 20m，每格 1m
    const gridSize = 20 * unitsPerMeter;
    const gridDiv = 20;
    const grid = new THREE.GridHelper(gridSize, gridDiv, 0x10c78a, 0x2a5d4a);
    (grid.material as THREE.LineBasicMaterial).transparent = true;
    (grid.material as THREE.LineBasicMaterial).opacity = 0.55;
    grid.position.y = 0.001 * unitsPerMeter; // 比地板高一咪咪避免 z-fighting
    group.add(grid);

    // 人形剪影 — 用 canvas 畫一個簡單的火柴人 silhouette，做成 sprite billboard
    const makePerson = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#1a1a1a';
        // 頭
        ctx.beginPath();
        ctx.arc(32, 18, 12, 0, Math.PI * 2);
        ctx.fill();
        // 身 + 腿（梯形 → 兩腿）
        ctx.beginPath();
        ctx.moveTo(22, 30);
        ctx.lineTo(42, 30);
        ctx.lineTo(48, 90);
        ctx.lineTo(36, 90);
        ctx.lineTo(34, 158);
        ctx.lineTo(28, 158);
        ctx.lineTo(30, 90);
        ctx.lineTo(16, 90);
        ctx.closePath();
        ctx.fill();
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.75, depthTest: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      // 高 1.7m，寬比例 64/160
      const heightUnits = 1.7 * unitsPerMeter;
      sprite.scale.set(heightUnits * (64 / 160), heightUnits, 1);
      // sprite 的 anchor 是中心，要把腳移到 y=0
      sprite.center.set(0.5, 0); // 0=底, 1=頂
      return sprite;
    };

    // 放兩個人形（左前 / 右前），距離 ~3m
    const p1 = makePerson();
    p1.position.set(-3 * unitsPerMeter, 0, 1 * unitsPerMeter);
    group.add(p1);
    const p2 = makePerson();
    p2.position.set(3 * unitsPerMeter, 0, 1 * unitsPerMeter);
    group.add(p2);

    scene.add(group);
    scaleRefGroupRef.current = group;
  }, [showScaleRef, scaleCorrection]);

  // ── Walk mode：pointer lock + WASD keys ──
  useEffect(() => {
    const renderer = rendererRef.current;
    const orbit = orbitRef.current;
    const camera = cameraRef.current;
    if (!renderer || !orbit || !camera) return;
    if (!walkMode) {
      walkPointerLockRef.current = false;
      orbit.enabled = true;
      walkKeysRef.current = {};
      return;
    }

    const canvas = renderer.domElement;
    orbit.enabled = false;
    canvas.requestPointerLock?.();

    function onPointerMove(e: PointerEvent) {
      if (!walkPointerLockRef.current || !camera) return;
      const sens = 0.0025;
      // yaw + pitch — 用 quaternion 累積（避免 gimbal lock）
      const yaw = -e.movementX * sens;
      const pitch = -e.movementY * sens;
      const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
      camera.quaternion.multiplyQuaternions(qYaw, camera.quaternion);
      camera.quaternion.multiply(qPitch);
    }
    function onLockChange() {
      walkPointerLockRef.current = document.pointerLockElement === canvas;
      if (!walkPointerLockRef.current && walkMode) {
        // Esc 退出 → 自動關 walk mode
        setWalkMode(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      walkKeysRef.current[e.key.toLowerCase()] = true;
      if (e.key === ' ') e.preventDefault();
    }
    function onKeyUp(e: KeyboardEvent) {
      walkKeysRef.current[e.key.toLowerCase()] = false;
    }

    document.addEventListener('pointerlockchange', onLockChange);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      document.removeEventListener('pointerlockchange', onLockChange);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      try { document.exitPointerLock?.(); } catch {}
      orbit.enabled = true;
    };
  }, [walkMode]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 只看模式：快捷鍵全部關掉
      if (viewerRef.current) return;
      // 唯讀模式：保留 L / X，不啟用 W/E/Q/Esc
      if (readOnlyRef.current) {
        // 審片頁的 L 是播放（J / K / L）→ 物件名稱只能從工具列開
        if ((e.key === 'l' || e.key === 'L') && !transportKeysRef.current) setShowLabels(s => !s);
        else if (e.key === 'x' || e.key === 'X') setWireframe(w => !w);
        return;
      }
      if (e.key === 'w' || e.key === 'W') setMode('translate');
      else if (e.key === 'e' || e.key === 'E') setMode('rotate');
      else if (e.key === 'q' || e.key === 'Q') setSpace(s => s === 'world' ? 'local' : 'world');
      else if (e.key === 'l' || e.key === 'L') setShowLabels(s => !s);
      else if (e.key === 'x' || e.key === 'X') setWireframe(w => !w);
      else if (e.key === 'Escape') onSelectRef.current(null, 'replace');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset camera
  const resetCamera = useCallback(() => {
    // admin 設的重置視角優先；沒有才用自動正面全景
    const custom = homeViewPropRef.current;
    if (custom) {
      flyCamera(new THREE.Vector3(...custom.position), new THREE.Vector3(...custom.target), custom.fov);
      return;
    }
    const home = computeAutoHome();
    flyCamera(
      home ? home.position : new THREE.Vector3(8, 6, 10),
      home ? home.target : new THREE.Vector3(0, 1, 0),
      DEFAULT_FOV,
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 自動正面全景（用現在的畫面比例重算）；沒模型時用場上的物件；什麼都沒有回傳 null */
  function computeAutoHome(): { position: THREE.Vector3; target: THREE.Vector3 } | null {
    const modelRoots = [...modelMeshMapRef.current.values()];
    let home: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
    if (modelRoots.length > 0) {
      home = computeFrontView(modelRoots, ledModelRoots(modelMeshMapRef.current), DEFAULT_FOV, viewAspect());
    } else if (meshesRef.current.size > 0) {
      const ledIds = new Set((stageObjectsRef.current || []).filter(o => o.category === 'led_panel').map(o => o.id));
      const leds = [...meshesRef.current].filter(([id]) => ledIds.has(id)).map(([, m]) => m);
      home = computeFrontView([...meshesRef.current.values()], leds, DEFAULT_FOV, viewAspect());
    }
    if (home) homeViewRef.current = home;
    return home;
  }

  /** 現在的鏡頭 → 重置視角 */
  function currentCameraView(): HomeView | null {
    const cam = cameraRef.current;
    const orb = orbitRef.current;
    if (!cam || !orb) return null;
    return { position: cam.position.toArray() as [number, number, number], target: orb.target.toArray() as [number, number, number], fov: cam.fov };
  }

  /** 改數字時鏡頭直接跳過去，邊改邊看 */
  function jumpCamera(v: HomeView) {
    const cam = cameraRef.current;
    const orb = orbitRef.current;
    if (!cam || !orb) return;
    cam.position.set(...v.position);
    orb.target.set(...v.target);
    cam.fov = v.fov;
    cam.updateProjectionMatrix();
  }

  /** 面板上顯示的值：自訂的，或自動算的 */
  function displayedHomeView(): HomeView {
    if (homeView) return homeView;
    const auto = homeViewRef.current;
    return auto
      ? { position: auto.position.toArray() as [number, number, number], target: auto.target.toArray() as [number, number, number], fov: DEFAULT_FOV }
      : { position: [8, 6, 10], target: [0, 1, 0], fov: DEFAULT_FOV };
  }

  /** 畫面寬高比：直接量容器（不靠 camera.aspect，畫面剛出現 / 分頁在背景時它可能還沒更新） */
  function viewAspect(): number {
    const el = containerRef.current;
    const w = el?.clientWidth || 0, h = el?.clientHeight || 0;
    return w > 0 && h > 0 ? w / h : (cameraRef.current?.aspect || 16 / 9);
  }

  /** 模型裡屬於 LED 的那些物件（看 stage objects 的分類） */
  function ledModelRoots(map: Map<string, THREE.Object3D>): THREE.Object3D[] {
    const names = new Set((stageObjectsRef.current || []).filter(o => o.category === 'led_panel').map(o => o.meshName));
    return [...map].filter(([name]) => names.has(name)).map(([, o]) => o);
  }

  useEffect(() => {
    if (!homeView || userMovedCameraRef.current) return;
    if (modelMeshMapRef.current.size === 0 && meshesRef.current.size === 0) return;  // 模型還沒好，載入時會用
    jumpCamera(homeView);
  }, [homeView]); // eslint-disable-line react-hooks/exhaustive-deps

  // 兩個模式：快速（像素 1:1 對顏色）/ 現場（暗場 + LED 照明 + 光暈）
  const cycleRenderMode = useCallback(() => {
    setRenderMode(m => (m === 'quick' ? 'live' : 'quick'));
  }, []);
  const renderModeNext = renderMode === 'live' ? '快速（像素 1:1 對顏色）' : '現場（暗場 + LED 照明 + 光暈）';

  // ── 工具列：永遠一排；放不下時先拿掉字、再把不常用的收進「更多」（StageToolbar）──
  // priority 0 = 一定要看得到（移動 / 旋轉、快速 / 現場、重置攝影機、AE 即時）；數字越大越早收
  const toolBtn = (o: {
    icon: LucideIcon; label: string; title: string; labeled: boolean; onClick: () => void;
    active?: boolean; pressed?: boolean; extra?: ReactNode;
  }) => (
    <button
      type="button"
      className={'tool' + (o.labeled ? '' : ' tool--icon') + (o.active ? ' is-active' : '')}
      onClick={o.onClick}
      title={o.title}
      aria-label={o.labeled ? undefined : o.label}
      aria-pressed={o.pressed}
    >
      <Icon icon={o.icon} size="md" />
      {o.labeled && <span className="tool__label">{o.label}</span>}
      {o.extra}
    </button>
  );
  const toggleMeasure = () => {
    const next = !measureMode;
    setMeasureMode(next);
    if (!next) {
      // 關閉時清線
      measurePointsRef.current = [];
      setMeasureDistance(null);
      if (measureLineRef.current) {
        (measureLineRef.current.geometry as THREE.BufferGeometry).setFromPoints([]);
      }
    }
  };
  const toggleSpace = () => setSpace(s => (s === 'world' ? 'local' : 'world'));
  const openLookPanel = () => { setLookPanelOpen(o => !o); setMaterialPanelOpen(false); };
  const openMaterialPanel = () => { setMaterialPanelOpen(o => !o); setLookPanelOpen(false); };
  const openHomeViewPanel = () => { setHomeViewPanelOpen(o => !o); setBookmarkPanelOpen(false); setNdiPopoverOpen(false); };
  const openBookmarkPanel = () => { setBookmarkPanelOpen(o => !o); setHomeViewPanelOpen(false); setNdiPopoverOpen(false); };
  const resetTitle = homeView ? '重置攝影機（回到設定好的畫面）' : '重置攝影機（正面全景）';

  const tools: ToolDef[] = [];
  if (!readOnly) {
    tools.push({
      id: 'move', group: 'edit', priority: 0,
      render: (l) => toolBtn({ icon: Move, label: '移動', title: '移動 (W)', labeled: l, active: mode === 'translate', pressed: mode === 'translate', onClick: () => setMode('translate') }),
      menu: { icon: Move, label: '移動', shortcut: 'W', checked: mode === 'translate', onSelect: () => setMode('translate') },
    });
    tools.push({
      id: 'rotate', group: 'edit', priority: 0,
      render: (l) => toolBtn({ icon: Rotate3d, label: '旋轉', title: '旋轉 (E)', labeled: l, active: mode === 'rotate', pressed: mode === 'rotate', onClick: () => setMode('rotate') }),
      menu: { icon: Rotate3d, label: '旋轉', shortcut: 'E', checked: mode === 'rotate', onSelect: () => setMode('rotate') },
    });
    const spaceTitle = space === 'world' ? '目前是世界座標軸，按一下改成物件自己的軸 (Q)' : '目前是物件自己的軸，按一下改成世界座標軸 (Q)';
    tools.push({
      id: 'space', group: 'edit', priority: 2,
      render: (l) => toolBtn({ icon: space === 'world' ? Globe : Box, label: space === 'world' ? '世界' : '物件', title: spaceTitle, labeled: l, onClick: toggleSpace }),
      menu: { icon: space === 'world' ? Globe : Box, label: space === 'world' ? '座標軸：世界' : '座標軸：物件自己的', shortcut: 'Q', hint: spaceTitle, onSelect: toggleSpace },
    });
  }
  if (!viewer) {
    tools.push({
      id: 'render', group: 'look', priority: 0,
      render: (l) => toolBtn({
        icon: renderMode === 'live' ? Sparkles : Zap, label: renderMode === 'live' ? '現場' : '快速', title: `切到 ${renderModeNext}`,
        labeled: l, active: renderMode !== 'quick', onClick: cycleRenderMode,
      }),
      menu: { icon: renderMode === 'live' ? Sparkles : Zap, label: renderMode === 'live' ? '畫面：現場（切到快速）' : '畫面：快速（切到現場）', onSelect: cycleRenderMode },
    });
    if (renderMode === 'live' && onLookSettingsChange) {
      const t = '現場設定：底光 / 曝光 / LED 照明 / 光暈 / 倒影（調的是你自己看到的）';
      tools.push({
        id: 'look', group: 'look', priority: 1,
        render: (l) => toolBtn({ icon: SlidersHorizontal, label: '設定', title: t, labeled: l, active: lookPanelOpen, onClick: openLookPanel }),
        menu: { icon: SlidersHorizontal, label: '現場設定…', hint: t, onSelect: openLookPanel },
      });
    }
    if (onMaterialOverrideChange) {
      const t = '材質：依 C4D 材質名稱調顏色 / 亮霧面 / 金屬感 / 反射 / 透明度，指定鏡面地板（所有人共用）';
      tools.push({
        id: 'material', group: 'look', priority: 3,
        render: (l) => toolBtn({ icon: Palette, label: '材質', title: t, labeled: l, active: materialPanelOpen, onClick: openMaterialPanel }),
        menu: { icon: Palette, label: '材質…', hint: t, onSelect: openMaterialPanel },
      });
    }
    tools.push({
      id: 'wire', group: 'look', priority: 5,
      render: (l) => toolBtn({ icon: Grid3x3, label: '線框', title: wireframe ? '切回實心 (X)' : '線框模式：看穿模型 (X)', labeled: l, active: wireframe, pressed: wireframe, onClick: () => setWireframe(w => !w) }),
      menu: { icon: Grid3x3, label: '線框', shortcut: 'X', checked: wireframe, onSelect: () => setWireframe(w => !w) },
    });
    if (showScaleButton) {
      tools.push({
        id: 'scale', group: 'show', priority: 6,
        render: (l) => toolBtn({ icon: PersonStanding, label: '比例尺', title: showScaleRef ? '隱藏比例尺輔助' : '顯示比例尺輔助：人形剪影 + 1m 網格', labeled: l, active: showScaleRef, pressed: showScaleRef, onClick: () => setShowScaleRef(s => !s) }),
        menu: { icon: PersonStanding, label: '比例尺', checked: showScaleRef, hint: '人形剪影 + 1m 網格', onSelect: () => setShowScaleRef(s => !s) },
      });
    }
    tools.push({
      id: 'labels', group: 'show', priority: 2,
      render: (l) => toolBtn({ icon: Tag, label: '名稱', title: (showLabels ? '隱藏物件名稱' : '顯示物件名稱') + (transportKeys ? '' : ' (L)'), labeled: l, active: showLabels, pressed: showLabels, onClick: () => setShowLabels(s => !s) }),
      menu: { icon: Tag, label: '物件名稱', shortcut: transportKeys ? undefined : 'L', checked: showLabels, onSelect: () => setShowLabels(s => !s) },
    });
  }
  tools.push({
    id: 'reset', group: 'camera', priority: 0,
    render: () => (
      <button type="button" className="tool tool--icon" onClick={resetCamera} title={resetTitle} aria-label="重置攝影機">
        <Icon icon={Video} size="md" />
      </button>
    ),
    menu: { icon: Video, label: '重置攝影機', hint: resetTitle, onSelect: resetCamera },
  });
  if (onHomeViewChange && !viewer) {
    tools.push({
      id: 'home', group: 'camera', priority: 4, noSepBefore: true,
      render: () => (
        <button
          type="button"
          className={'tool tool--chevron' + (homeViewPanelOpen ? ' is-active' : '')}
          onClick={openHomeViewPanel}
          title="設定重置攝影機的畫面（所有人按「重置攝影機」都會回到這裡）"
          aria-label="設定重置攝影機的畫面"
          aria-expanded={homeViewPanelOpen}
        ><Icon icon={ChevronDown} /></button>
      ),
      menu: { icon: Video, label: '設定重置攝影機的畫面…', hint: '所有人按「重置攝影機」都會回到這裡', onSelect: openHomeViewPanel },
    });
  }
  if (!viewer) {
    tools.push({
      id: 'walk', group: 'camera', priority: 6,
      render: (l) => toolBtn({ icon: Footprints, label: '漫遊', title: walkMode ? '離開漫遊模式（或按 Esc）' : '漫遊模式：WASD 走動、滑鼠看四周', labeled: l, active: walkMode, pressed: walkMode, onClick: () => setWalkMode(m => !m) }),
      menu: { icon: Footprints, label: '漫遊', checked: walkMode, hint: 'WASD 走動、滑鼠看四周（Esc 離開）', onSelect: () => setWalkMode(m => !m) },
    });
    if (bookmarkScope) {
      const t = `視角書籤（${bookmarks.length}）— 儲存 / 切換常用視角`;
      tools.push({
        id: 'views', group: 'camera', priority: 3,
        render: (l) => toolBtn({
          icon: Camera, label: '視角', title: t, labeled: l, active: bookmarkPanelOpen, onClick: openBookmarkPanel,
          extra: l && bookmarks.length > 0 ? <span className="muted small"> {bookmarks.length}</span> : null,
        }),
        menu: { icon: Camera, label: bookmarks.length > 0 ? `視角書籤…（${bookmarks.length}）` : '視角書籤…', hint: t, onSelect: openBookmarkPanel },
      });
    }
    if (onAddAnchoredComment) {
      tools.push({
        id: 'pin', group: 'mark', priority: 1,
        render: (l) => toolBtn({ icon: MapPin, label: '3D 留言', title: addPinMode ? '取消 3D 留言模式' : '在 3D 場景上某個位置 / 物件加留言', labeled: l, active: addPinMode, pressed: addPinMode, onClick: () => setAddPinMode(m => !m) }),
        menu: { icon: MapPin, label: '3D 留言', checked: addPinMode, hint: '在 3D 場景上某個位置 / 物件加留言', onSelect: () => setAddPinMode(m => !m) },
      });
    }
    tools.push({
      id: 'measure', group: 'mark', priority: 4,
      render: (l) => toolBtn({ icon: Ruler, label: '測距', title: measureMode ? '關閉測距' : '測距：點兩個點看距離（公尺）', labeled: l, active: measureMode, pressed: measureMode, onClick: toggleMeasure }),
      menu: { icon: Ruler, label: '測距', checked: measureMode, hint: '點兩個點看距離（公尺）', onSelect: toggleMeasure },
    });
  }
  if (enableNdi) {
    tools.push({
      id: 'ndi', group: 'status', priority: 0, noSepBefore: true,
      render: () => (
        <button
          type="button"
          className={'ndi-pill ' + ndiPillClass(ndiGuideState)}
          onClick={() => { setNdiPopoverOpen(o => !o); setBookmarkPanelOpen(false); setHomeViewPanelOpen(false); }}
          title={ndiGuideState.step === 'live' ? `AE 即時：${ndiStepMessage(ndiGuideState, ndi.env.browser).title}` : '點擊看 AE 即時連線狀態'}
          aria-expanded={ndiPopoverOpen}
        >
          {ndiPillIcon(ndiGuideState)} {ndiShortLabel(ndiGuideState)}
        </button>
      ),
      menu: null,
    });
  }
  if (cueName) {
    tools.push({
      id: 'cue', group: 'status', priority: 3.5, noSepBefore: true,
      flex: { min: 90, compactMin: 64 },
      render: (l, fw) => (
        <span className={'cue-tag' + (l ? '' : ' cue-tag--compact')} style={fw ? { maxWidth: fw } : undefined} title={`當前 cue：${cueName}`}>
          {l ? <>當前 cue：<strong>{cueName}</strong></> : <strong>{cueName}</strong>}
        </span>
      ),
      menu: null,
    });
  }

  // 「更多」選單固定的一段：LED 對位圖（給動畫師做 AE 合成用）
  const canvasNow = resolvedCanvas.canvas;
  const ledSections: ToolMenuSection[] = ledMapMenu ? [{
    id: 'ledmap',
    title: 'LED 對位圖',
    items: [
      {
        icon: ImageDown,
        label: ledMapBusy === 'png' ? '正在畫對位圖…' : '下載對位圖（PNG）',
        disabled: !!ledMapBusy,
        hint: '每塊 LED 在 AE 畫布上的位置：名字、x y w h、每 100 px 格線；可以直接放進 AE 當參考圖層',
        onSelect: () => { void downloadLedMap('png'); },
      },
      {
        icon: FileCode,
        label: ledMapBusy === 'jsx' ? '正在做 AE 合成腳本…' : '下載 AE 合成腳本（.jsx）',
        disabled: !!ledMapBusy,
        hint: '在 AE 按「File > Scripts > Run Script File…」（檔案 > 指令碼 > 執行指令碼檔案）跑：自動建好畫布大小的合成，每塊 LED 的外框、名字都是導引圖層（不會算圖出去）',
        onSelect: () => { void downloadLedMap('jsx'); },
      },
      { icon: FileSpreadsheet, label: '下載位置表（CSV）', hint: 'Excel 打得開：每塊 LED 的名字和 x、y、w、h', onSelect: () => { void downloadLedMap('csv'); } },
      { icon: FileBraces, label: '下載位置表（JSON）', hint: '給 AE 腳本 / 程式讀', onSelect: () => { void downloadLedMap('json'); } },
      {
        icon: MonitorCheck,
        label: 'LED 顯示測試圖',
        checked: forceTestPattern,
        keepOpen: true,
        hint: '有畫面時也讓 LED 顯示測試圖，檢查每塊 LED 對得對不對（只有你這邊看得到）',
        onSelect: () => setForceTestPattern(v => !v),
      },
      ...(onLedCanvasChange ? [{
        icon: Ratio,
        label: '設定畫布大小…',
        hint: 'AE 合成的寬 × 高（所有人一起用）',
        onSelect: () => { void editLedCanvas(); },
      }] : []),
    ],
    note: (
      <>
        畫布 {canvasNow.width} × {canvasNow.height}（{canvasSourceText(resolvedCanvas.source)}）
        {resolvedCanvas.source !== 'project' && !onLedCanvasChange && <><br />AE 合成要做多大，以製作給的為準</>}
      </>
    ),
  }] : [];
  // 「說明」：新分頁打開使用說明（分享頁給客戶用）
  const menuSections: ToolMenuSection[] = helpHref ? [...ledSections, {
    id: 'help',
    title: '使用說明',
    items: [{ icon: CircleHelp, label: '說明', hint: '說明', onSelect: () => { window.open(helpHref, '_blank', 'noopener'); } }],
  }] : ledSections;

  return (
    <div className="stage-scene" ref={containerRef}>
      <StageToolbar
        tools={tools}
        sections={menuSections}
        className={viewer ? 'is-viewer' : undefined}
        menuOpen={moreMenuOpen}
        onMenuOpenChange={setMoreMenuOpen}
        menuHeader={(hidden) => (hidden.has('cue') && cueName ? <>當前 cue：<strong>{cueName}</strong></> : null)}
      >
        {homeViewPanelOpen && onHomeViewChange && !viewer && (
          <HomeViewPanel
            view={displayedHomeView()}
            isCustom={!!homeView}
            scale={scaleCorrection}
            onCaptureCurrent={() => { const v = currentCameraView(); if (v) onHomeViewChange(v); }}
            onChange={v => {
              if (v.position.every((n, i) => Math.abs(n - v.target[i]) < 1e-6)) return;  // 看向自己 → 不收
              onHomeViewChange(v);
              jumpCamera(v);
            }}
            onUseAuto={() => {
              onHomeViewChange(null);
              const home = computeAutoHome();
              if (home) flyCamera(home.position, home.target, DEFAULT_FOV);
            }}
            onClose={() => setHomeViewPanelOpen(false)}
          />
        )}
        {bookmarkPanelOpen && bookmarkScope && !viewer && (
          <div className="bm-popover" onClick={e => e.stopPropagation()}>
            <div className="bm-popover__head">
              <span>視角書籤</span>
              <button className="dlg__close" onClick={() => setBookmarkPanelOpen(false)} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
            </div>
            <button className="btn btn--primary btn--sm bm-popover__save" onClick={saveCurrentCamera}>
              + 儲存目前視角
            </button>
            {bookmarks.length === 0 ? (
              <div className="bm-popover__empty">還沒儲存任何視角</div>
            ) : (
              <ul className="bm-popover__list">
                {bookmarks.map(bm => (
                  <li key={bm.id}>
                    <button className="bm-row" onClick={() => loadBookmark(bm)}>
                      <span className="bm-row__name">{bm.name}</span>
                      <span className="bm-row__coords">({bm.pos.map(n => n.toFixed(1)).join(', ')})</span>
                    </button>
                    <button className="bm-row__del" onClick={() => deleteBookmark(bm.id)} title="刪除這個視角" aria-label="刪除這個視角"><Icon icon={X} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {enableNdi && ndiPopoverOpen && (
          <div className="ndi-popover" onClick={e => e.stopPropagation()}>
            <div className="ndi-popover__head">
              AE 即時（NDI 小程序）
              <button className="ndi-popover__close" onClick={() => setNdiPopoverOpen(false)} title="關閉" aria-label="關閉"><Icon icon={X} /></button>
            </div>
            <div className="ndi-popover__body">
              {ndiGuideState.step === 'live' && (
                <div className="ndi-popover__live"><span className="ndi-dot ndi-dot--on" aria-hidden="true" /> {ndiStepMessage(ndiGuideState, ndi.env.browser).title}</div>
              )}
              <NdiChecklist
                guide={ndiGuideState}
                env={ndi.env}
                onConnect={ndi.connect}
                onSelectSource={ndi.selectSource}
                showAutostartNote={false}
              />
              {!sourcePickerInStep(ndiGuideState) && showSourcePicker(ndiGuideState) && (
                <NdiSourcePicker guide={ndiGuideState} onSelectSource={ndi.selectSource} />
              )}
              <NdiAutostartNote guide={ndiGuideState} />
              {ndiGuideState.outdated && ndiGuideState.step !== 'helper_outdated' && (
                <p className="ndi-popover__note">
                  小程序有新版（你的是 {ndiGuideState.helperVersion}）：
                  <a href={ndi.env.os === 'mac' ? NDI_HELPER_DOWNLOAD_URL_MAC : NDI_HELPER_DOWNLOAD_URL}><Icon icon={Download} /> 下載更新</a>
                </p>
              )}
              {ndiGuideState.helperVersion && !ndiGuideState.outdated && (
                <p className="ndi-popover__note">小程序版本 {ndiGuideState.helperVersion}</p>
              )}
            </div>
            <div className="ndi-popover__actions">
              <button
                className="btn btn--ghost btn--sm"
                onClick={ndi.retry}
                disabled={ndiGuideState.step === 'browser_unsupported'}
              ><Icon icon={RefreshCw} /> 重新連線</button>
              <a
                className="btn btn--ghost btn--sm"
                href={NDI_TOOLS_URL}
                target="_blank"
                rel="noreferrer"
              >NDI Tools <Icon icon={ExternalLink} size="xs" /></a>
              <a
                className="btn btn--ghost btn--sm ndi-popover__help"
                href={helpUrl(ndiHelpAnchor(ndiGuideState.step) ?? HELP_ANCHORS.aeLive)}
                target="_blank"
                rel="noopener"
              ><Icon icon={BookOpen} /> 圖文說明</a>
            </div>
          </div>
        )}
      </StageToolbar>
      {forceTestPattern && testPatternTex && (
        <div className="stage-scene__testpattern-note" role="status">
          <Icon icon={MonitorCheck} /> LED 正在顯示測試圖
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setForceTestPattern(false)}>關掉</button>
        </div>
      )}
      {ndiCardShown && (
        <NdiGuideCard
          guide={ndiGuideState}
          env={ndi.env}
          onConnect={ndi.connect}
          onSelectSource={ndi.selectSource}
          onCollapse={() => setNdiCardHiddenFor(ndiCardKey(ndiGuideState))}
          hint={ndiGuideHint}
        />
      )}
      {!viewer && lookPanelOpen && renderMode === 'live' && onLookSettingsChange && (
        <LookSettingsPanel
          settings={lookSettings}
          onChange={onLookSettingsChange}
          onClose={() => setLookPanelOpen(false)}
          customized={lookCustomized}
          onReset={onLookReset || (() => {})}
          onSaveAsDefault={onLookSaveAsDefault}
        />
      )}
      {!viewer && materialPanelOpen && onMaterialOverrideChange && (
        <MaterialPanel
          materials={modelMaterials}
          overrides={materialOverrides || {}}
          onChange={onMaterialOverrideChange}
          onClose={() => setMaterialPanelOpen(false)}
        />
      )}
      {/* Measure result overlay */}
      {measureMode && (
        <div className="stage-scene__measure-overlay">
          <strong><Icon icon={Ruler} /> 測距模式</strong>
          {measureDistance === null
            ? <span> · 點兩個點測距離（點地板或物件表面）</span>
            : (
              <>
                <span> · <strong className="measure-dist">{(measureDistance * scaleCorrection).toFixed(2)} m</strong>（再點下一點重開）</span>
                {canCalibrate && (
                  <button
                    className="btn btn--ghost btn--sm"
                    style={{ marginLeft: 12 }}
                    onClick={() => { setCalibrateInput(''); setCalibratePromptOpen(true); }}
                    title="把剛剛量到的距離設為已知值，全專案的測距 / 比例尺 / 機關都會用這個倍率（所有人一起）"
                  ><Icon icon={Target} /> 設為已知距離</button>
                )}
              </>
            )
          }
          {scaleCorrection !== 1 && (
            <span style={{ marginLeft: 12, opacity: 0.7, fontSize: 12 }}>
              （目前校準倍率 ×{scaleCorrection.toFixed(2)}
              {canCalibrate && (
                <>
                  {' '}
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => saveScaleCorrection(1)}
                    title="清除校準、回到模型原始尺寸（所有人一起）"
                  >重設</button>
                </>
              )}
              ）
            </span>
          )}
        </div>
      )}
      {/* 校準輸入對話框 — inline styles 避免依賴尚未定義的 .modal class */}
      {calibratePromptOpen && measureDistance !== null && measureDistance > 0 && (
        <div
          onClick={() => setCalibratePromptOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#1a1a1a', color: '#eee', padding: 20, borderRadius: 8,
              maxWidth: 420, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>校準尺寸</h3>
            <p style={{ fontSize: 14, opacity: 0.8, marginTop: 0 }}>
              剛剛量到的距離是 <strong>{(measureDistance * scaleCorrection).toFixed(3)} m</strong>。
              它實際應該是幾公尺？輸入後，這個專案所有人的測距、比例尺、機關都會用這個倍率換算。
            </p>
            <input
              type="number"
              step="0.01"
              placeholder="例：3"
              value={calibrateInput}
              autoFocus
              onChange={e => setCalibrateInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const real = parseFloat(calibrateInput);
                  if (isFinite(real) && real > 0 && measureDistance > 0) {
                    saveScaleCorrection(real / measureDistance);
                    setCalibratePromptOpen(false);
                  }
                } else if (e.key === 'Escape') {
                  setCalibratePromptOpen(false);
                }
              }}
              style={{
                width: '100%', padding: 8, fontSize: 16, marginBottom: 12,
                background: '#222', color: '#eee', border: '1px solid #444', borderRadius: 4,
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn--ghost" onClick={() => setCalibratePromptOpen(false)}>取消</button>
              <button
                className="btn"
                onClick={() => {
                  const real = parseFloat(calibrateInput);
                  if (isFinite(real) && real > 0 && measureDistance > 0) {
                    saveScaleCorrection(real / measureDistance);
                    setCalibratePromptOpen(false);
                  }
                }}
              >套用</button>
            </div>
          </div>
        </div>
      )}
      {/* 疊在 3D 畫面上的東西（審片的畫記），跟畫面一樣大 */}
      {children}
      {/* 自動調低畫質時的小提示（不擋操作） */}
      {qualityLevel !== 'high' && (
        <div className="stage-scene__quality-note">畫質自動調低以保持順暢</div>
      )}
      {/* Help overlay */}
      <div className="stage-scene__help">
        {viewer
          ? <>拖拉旋轉視角 · 滾輪縮放</>
          : readOnly
          ? (transportKeys ? <>拖拉旋轉視角 · 滾輪縮放</> : <><kbd>L</kbd> 物件名稱 · 拖拉旋轉視角 · 滾輪縮放</>)
          : <><kbd>W</kbd> 移動 · <kbd>E</kbd> 旋轉 · <kbd>Q</kbd> 世界 / 物件軸 · <kbd>L</kbd> 物件名稱 · <kbd>Esc</kbd> 取消選取</>
        }
      </div>
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 工具列 NDI 標示：LIVE 綠、要處理的橘、其他灰 */
function ndiPillClass(g: NdiGuide): string {
  if (g.step === 'live') return 'ndi-pill--live';
  if (g.step === 'connecting' || g.step === 'waiting_frames' || g.step === 'ready') return 'ndi-pill--idle';
  return 'ndi-pill--warn';
}

function ndiPillIcon(g: NdiGuide): ReactNode {
  if (g.step === 'live') return <span className="ndi-dot ndi-dot--on" aria-hidden="true" />;
  if (g.step === 'waiting_frames' && g.hadFrames) return <Icon icon={Pause} size="xs" />;
  return <span className="ndi-dot" aria-hidden="true" />;
}

function disposeObject3D(obj: THREE.Object3D) {
  endObjectFade(obj);  // 淡到一半的半透明複本先丟掉、換回原本材質
  obj.traverse((child) => {
    const m = child as THREE.Mesh;
    if (m.geometry) m.geometry.dispose?.();
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mat) => mat.dispose?.());
    }
  });
}

function updateLockPins(
  layer: HTMLDivElement | null,
  states: CueState[],
  meshes: Map<string, THREE.Object3D>,
  camera: THREE.PerspectiveCamera,
  container: HTMLElement,
) {
  if (!layer) return;
  const lockedStates = states.filter(s => s.locked);
  // 同步 children
  const existing = new Map<string, HTMLDivElement>();
  for (const child of Array.from(layer.children)) {
    const id = (child as HTMLElement).dataset.objectId;
    if (id) existing.set(id, child as HTMLDivElement);
  }
  for (const [id, el] of existing) {
    if (!lockedStates.find(s => s.objectId === id)) { layer.removeChild(el); existing.delete(id); }
  }
  if (lockedStates.length === 0) return;
  const w = container.clientWidth, h = container.clientHeight;
  const v = new THREE.Vector3();
  for (const s of lockedStates) {
    const mesh = meshes.get(s.objectId);
    if (!mesh) continue;
    let pin = existing.get(s.objectId);
    if (!pin) {
      pin = document.createElement('div');
      pin.className = 'stage-scene__lock-pin';
      pin.dataset.objectId = s.objectId;
      pin.innerHTML = lockSvg(13);
      pin.title = `${s.displayName} 已鎖定`;
      layer.appendChild(pin);
    }
    v.copy(mesh.position);
    v.y += 0.4;
    v.project(camera);
    if (v.z > 1) { pin.style.display = 'none'; continue; }
    pin.style.display = '';
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    pin.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }
}

function updateCommentPins(
  layer: HTMLDivElement | null,
  comments: import('../lib/api').SongComment[] | undefined,
  meshes: Map<string, THREE.Object3D>,
  camera: THREE.PerspectiveCamera,
  container: HTMLElement,
  displayNameMap?: Map<string, THREE.Object3D>,  // displayName → mesh root（從 states 構建）
) {
  if (!layer) return;
  const list = (comments || []).filter(c => c.anchor && (c.anchor.type === 'world' || c.anchor.type === 'mesh'));
  // 同步 DOM：用 c.id 對 .pin 子元素，多刪少補
  const existing = new Map<string, HTMLDivElement>();
  for (const child of Array.from(layer.children)) {
    const id = (child as HTMLElement).dataset.commentId;
    if (id) existing.set(id, child as HTMLDivElement);
  }
  // 移除 stale
  for (const [id, el] of existing) {
    if (!list.find(c => c.id === id)) { layer.removeChild(el); existing.delete(id); }
  }
  if (list.length === 0) return;

  const w = container.clientWidth;
  const h = container.clientHeight;
  const v = new THREE.Vector3();

  for (const c of list) {
    let world: THREE.Vector3 | null = null;
    if (c.anchor!.type === 'world') {
      world = new THREE.Vector3(c.anchor!.world.x, c.anchor!.world.y, c.anchor!.world.z);
    } else if (c.anchor!.type === 'mesh') {
      const anchor = c.anchor as { type: 'mesh'; meshName: string; offset?: { x: number; y: number; z: number } | null };
      // 找 mesh：優先 displayName 對照表（從 states），fallback Three.js mesh name
      let found: THREE.Vector3 | null = null;
      const byDisplayName = displayNameMap?.get(anchor.meshName);
      if (byDisplayName) {
        const wp = new THREE.Vector3();
        byDisplayName.getWorldPosition(wp);
        found = wp;
      } else {
        for (const m of meshes.values()) {
          m.traverse((o: THREE.Object3D) => {
            if (found) return;
            const name = (o as THREE.Mesh & { name?: string }).name || '';
            if (name === anchor.meshName) {
              const wp = new THREE.Vector3();
              o.getWorldPosition(wp);
              found = wp;
            }
          });
          if (found) break;
        }
      }
      if (!found) {
        // fallback：拿第一個 mesh 的 world position（避免 pin 不見）
        const first = meshes.values().next().value as THREE.Object3D | undefined;
        if (first) {
          const wp = new THREE.Vector3();
          first.getWorldPosition(wp);
          found = wp;
        }
      }
      world = found;
      if (world && anchor.offset) {
        world = world.clone().add(new THREE.Vector3(anchor.offset.x, anchor.offset.y, anchor.offset.z));
      }
    }
    if (!world) continue;

    v.copy(world);
    v.project(camera);
    let pin = existing.get(c.id);
    if (!pin) {
      pin = document.createElement('div');
      pin.className = 'stage-scene__comment-pin stage-scene__comment-pin--' + c.role;
      pin.dataset.commentId = c.id;
      pin.title = `${c.author}: ${c.text}`;
      pin.innerHTML = commentSvg(15);
      pin.addEventListener('click', () => {
        const ev = new CustomEvent('stage-comment-pin-click', { detail: c.id, bubbles: true });
        layer.dispatchEvent(ev);
      });
      layer.appendChild(pin);
    }
    if (v.z > 1) {
      pin.style.display = 'none';
      continue;
    }
    pin.style.display = '';
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    pin.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }
}

function updateLabels(
  labels: Map<string, HTMLDivElement>,
  meshes: Map<string, THREE.Object3D>,
  camera: THREE.PerspectiveCamera,
  container: HTMLElement
) {
  if (labels.size === 0) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  const v = new THREE.Vector3();
  for (const [id, lbl] of labels) {
    const mesh = meshes.get(id);
    if (!mesh) continue;
    if (!mesh.visible) { lbl.style.display = 'none'; continue; }
    v.copy(mesh.position);
    v.y += 0.7; // 標籤浮在物件上方
    v.project(camera);
    if (v.z > 1) { lbl.style.display = 'none'; continue; }
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    lbl.style.display = 'block';
    lbl.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }
}
