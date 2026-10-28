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
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import type { CueState, Vec3, Euler, StageObject, CameraView } from '../lib/api';
import { fitFov } from '../lib/review/annotations';
import { applyClipPlanes } from '../lib/cameraClip';
import { computeFrontView, computePresetView, CAMERA_PRESETS, type CameraPreset } from '../lib/stageCamera';
import { cueMoveProgress } from '../lib/cueTiming';
import { cueQuaternion, lerpOpacity, type CuePoseMap } from '../lib/cueTimeline';
import type { Mechanism, MechanismTimings, MechanismValues, MechVec3 } from '../lib/mechanisms/model';
import { applyChain, basePoseFromScene, compileRig, EMPTY_RIG, travelGeometry, type RigMechanism } from '../lib/mechanisms/pose';
import { MechanismTweener, type MechanismMotion } from '../lib/mechanisms/motion';
import { hoistsOfRig } from '../lib/mechanisms/hoist';
import { stageFrontDirection } from '../lib/stageCamera';
import { FIGURE_HEIGHT_M, FIGURE_LABEL, MAX_STAND_ABOVE_DECK_M, canStandOnCategory, deckFootprint, defaultFigureSpots, figureSpotsFromExtent, findDeckLevel, frontAxes, gridCenter, pickFigureSpots } from '../lib/scaleReference';
import { buildWalkMesh, disposeWalkMesh, extractUpFaces, standingYAt, surfaceSignature } from '../lib/scaleReferenceScene';
import {
  STAGE_PROP_MAX, facingYaw, freeSpot, moveStagePropWith, newStagePropId, normalizeRotY, propsStandingOn, removeStageProp, rotateStagePropBy,
  riserTopAt, sanitizeStagePropItem, stagePropSpec, type StagePropItem, type StagePropType,
} from '../lib/stageProps';
import { createStagePropsLayer } from '../lib/stagePropsScene';
import { countInScope } from '../lib/stagePropsHistory';
import type { StagePropsHistory } from '../lib/useStageProps';
import ScalePropsPanel, { type ScalePart } from './ScalePropsPanel';
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
import { buildLedEmitters, type LedEmitter, type UvRect } from '../lib/stageLook/ledEmitters';
import { LedLightRig, type LedLightProps } from '../lib/stageLook/ledLightRig';
import { LedEnvironment, LED_LAYER } from '../lib/stageLook/ledEnvironment';
import { TextureColorReader, type LedColorSource } from '../lib/stageLook/textureColorReader';
import { AdaptiveQuality, QUALITY, detectQualityProfile, type QualityLevel } from '../lib/stageLook/quality';
import { LED_SHARED_UNIFORMS, configureLedMaterial, ndiLedTexels, setLedColorLut, setLedOriginalUv, setLedTemplate, updateLedSurface } from '../lib/stageLook/ledSurface';
import { materialsWithOriginalUv, planWantsOriginalUv } from '../lib/stageLook/ledOriginalUv';
import { createFrameClock, type FrameClock } from '../lib/ledFrameClock';
import { createSegmentSwitcher, type SegmentObject, type SegmentSwitcher } from '../lib/stageLook/ledTimelineSwitch';
import { buildCoverageUniforms, coverageRemap } from '../lib/stageLook/ledTemplateCoverage';
import { segmentIndexAt, timelineSummary, type LedTimeline } from '../lib/ledTemplateTimeline';
import { ensureOwnLedMaterials } from '../lib/stageLook/ledOwnMaterial';
import { blackenMaterial, offScreenMeshes, restoreOffMaterials, swapOffMaterials } from '../lib/ledOffPieces';
import { ledScreenMeshes, ledScreenParts } from '../lib/ledScreen';
import { pickNdiColorCurve, type NdiColorLut } from '../lib/ndiColor';
import { readPixels } from '../lib/ndiFrameGrab';
import NdiColorCalibrationDialog, { colorCurveLabel, useNdiCalibration } from './NdiColorCalibration';
import { LedOutputPass } from '../lib/stageLook/ledOutputPass';
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
import CameraBookmarkPanel from './CameraBookmarkPanel';
import type { CameraBookmark } from '../lib/cameraBookmarks';
import { Maximize, Axis3d } from 'lucide-react';
import StageShowBar from './StageShowBar';
import { useStageFullscreen } from '../lib/useStageFullscreen';
import { isStageShowActive, type StageShowInfo, type StageShowViewGroup } from '../lib/stageShow';
import { toast } from '../lib/toast';
import StageToolbar, { type ToolDef, type ToolMenuEntry, type ToolMenuSection } from './StageToolbar';
import WatermarkOverlay from './WatermarkOverlay';
import { LED_CANVAS_RANGE, normalizeLedCanvas, type LedCanvas } from '../lib/ledCanvas';
import {
  buildLedLayout, canvasSourceText, layoutPanel, layoutToCsv, layoutToJson, ledMapFileName, parseCanvasInput, resolveLedCanvas, testPatternSize, todayString,
  type CanvasSize, type LedLayout, type LedMapMeta,
} from '../lib/ledMap';
import { collectUvTriangles, ledPanelInputs, type LedSceneObject } from '../lib/ledMapScene';
import { buildObjectUniforms, buildScreenList, mapUvRectToTemplate, parseScreenKey, spanFromAxes, spanFromUv, usableParts, type AutoScreenPart, type LedTemplatePlan, type Placement, type ScreenDef, type SrcSpan } from '../lib/ledTemplate';
import { downloadBlob, drawTestPattern, renderAlignmentMapPng } from '../lib/ledMapDraw';
import type { UvPreview } from '../lib/ledUv/previewUv';
import { applyUvPreview } from '../lib/ledUv/previewApply';
import { AeCanvasTooBigError, downloadAeCompScript } from '../lib/aeCompScriptDownload';
import { downloadSongTemplateFile, downloadSongTimelineFile, type LedSongTemplate } from '../lib/ledTemplateDownload';
import { ledMapMenuHint, ledMapMenuLabel, type LedDownloadKind, type LedDownloadScope } from '../lib/ledMapMenuText';
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
  /** AE 即時收到的畫面大小（第一張畫面、畫面大小換了才叫；AE 切 Full / Half / Third 也會）：檢查跟 LED 版型的畫布大小對不對得上 */
  onNdiFrameSize?: (size: { width: number; height: number }) => void;
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
  /** 有給（專案 id）才有工具列的「視角」：常用看台視角 + 專案共用的視角書籤；不傳則停用功能 */
  bookmarkScope?: string;
  /**
   * 有給才有「全螢幕預演」（F 或工具列）：給客戶看的簡報畫面——3D 舞台佔滿整個螢幕、操作介面和各種提示全藏起來，
   * 只留下方的小條（上一首 / 下一首歌、播放 / 時間、上一個 / 下一個 cue、視角、離開；lib/stageShow.ts）
   */
  stageShow?: StageShowInfo;
  /** 專案共用的視角書籤（lib/cameraBookmarks.ts；每個人都能點了飛過去） */
  cameraBookmarks?: CameraBookmark[];
  /** 有給 = 可以存目前視角 / 改名 / 換順序 / 刪除（製作、導演）；沒給 = 只能看 */
  onCameraBookmarksChange?: (next: CameraBookmark[]) => void;
  /** 機關定義（每個專案設定一次）；沒給 / 還在讀 = 沒有機關 */
  mechanisms?: Mechanism[] | null;
  /** 目前這個 cue 的機關位置（已經沿用 / 夾在行程內）；換 cue 時照走幾秒走過去，同一個 cue 裡改值直接跳 */
  mechanismTargets?: MechanismValues;
  /** 跟著影片時間：只在 poseAtFrame 有回傳位置的那幾幀才問；回傳 null = 用 mechanismTargets */
  mechanismAtFrame?: () => MechanismValues | null;
  /** 目前這個 cue 自己設的延遲 / 走幾秒（換 cue 時先等延遲、照走幾秒走；沒有的機關跟著轉場） */
  mechanismTimings?: MechanismTimings;
  /** true = 每幀都問 mechanismAtFrame（管理頁的機關時間軸拉 / 播時；回傳 null = 照點 cue 走） */
  mechanismFrameAlways?: boolean;
  /** 換 cue 時機關怎麼走：'transition'（預設）= 照走幾秒（沒設 = 轉場秒數）；'instant' = 直接到位（分鏡縮圖） */
  mechanismMotion?: MechanismMotion;
  /** 查舞台：舞台正面方向、一組物件的中心（設定機關用） */
  sceneQueryRef?: React.MutableRefObject<StageSceneQuery | null>;
  /** 管理頁正在看的機關：3D 畫面上畫出它的行程（直線 / 圓弧，常用位置有刻度） */
  focusedMechanismId?: string | null;
  /** 測距校準倍率（模型 scene units → 真實公尺），存在專案上全員共用；預設 1 = 未校準 */
  scaleCorrection?: number;
  /** 有傳才顯示「設為已知距離 / 重設」— 只有 admin 能改校準 */
  onScaleCorrectionChange?: (n: number) => void;
  /** 比例尺的樂手和器材（存在專案上全員共用，lib/stageProps.ts）；沒給 = 沒有 */
  stageProps?: StagePropItem[];
  /** 有傳才能新增 / 拖動 / 轉 / 刪除 — 只有製作、導演；沒傳 = 只能看 */
  onStagePropsChange?: (next: StagePropItem[]) => void;
  /** 比例尺面板的「復原」和「一次清掉」（lib/useStageProps.ts 的 history）；跟 onStagePropsChange 一起給，沒給 = 面板沒有這兩個 */
  stagePropsHistory?: StagePropsHistory;
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
   * LED 畫布版型（lib/ledTemplate.ts）：ledVideo / ledImage（歌曲影片、本地檔案）和 AE 即時（NDI）收到的畫面是「版型畫布」時給，
   * 每塊螢幕從版型畫布上自己的位置取畫面（轉 90° / 翻轉也照做），沒放進版型的螢幕顯示黑的；像素格照整張畫布的真實點數。
   * 沒給 / null = 整張畫布（跟以前一樣）。測試圖、物件設定的圖片網址不受影響。
   * 現在該用哪一份由頁面決定（lib/ledLiveTemplate.ts chooseLedTemplate：影片版本用自己的快照、AE 即時 / 本地檔案用這首歌選的版型）。
   */
  ledTemplate?: LedTemplatePlan | null;
  /**
   * 中途換版型（lib/ledTemplateTimeline.ts）：同一首歌的影片前半段用版型 A 的排法、某個時間以後換成版型 B。有給（至少兩段）就蓋過 ledTemplate：
   * 每一段每個物件的取色資料先算好，播放中依「這一格畫面是影片的第幾秒」（requestVideoFrameCallback 的畫面時間，沒有就用 currentTime）
   * 在換版型的那一格剛好換，拉時間軸前後來回也對；顏色那條路不動。沒有播放時間的畫面（AE 即時、本地圖片）用 ledTimelineSec。
   * 頁面要把它用 useMemo 包住（內容沒變就同一個物件），不然每次都重算。
   */
  ledTimeline?: LedTimeline | null;
  /** 沒有播放時間的畫面（AE 即時、本地圖片）用這個時間（秒）決定現在是時間線的哪一段；預設 0 = 開頭 */
  ledTimelineSec?: number;
  /**
   * 編輯 LED 版型時的測試圖（lib/ledTemplateDraw.ts 畫的）：有給就蓋過影片 / 圖片 / 測試圖，每塊 LED 照 ledTemplate 的放法從這張圖取色。
   * 走跟影片一樣的「版型貼回」路徑，只是貼圖是畫出來的；不經過影片的顏色那一條路。ledPreviewVersion 加 1 = 圖重畫過了、要重傳。
   */
  ledPreviewCanvas?: HTMLCanvasElement | null;
  ledPreviewVersion?: number;
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
  /** 自動貼 UV 的 3D 預覽：暫時把 LED 的 UV 換成「套用以後」的樣子（新畫布大小 + 測試圖），不存檔；不給 = 照模型現在的 UV */
  ledUvPreview?: UvPreview | null;
  /** 自動貼 UV 不放進畫布的 LED（整個物件 id、或「物件id~mesh 名稱」）：3D 上一律顯示黑色；沒有 = 不變 */
  ledOffPieces?: readonly string[];
  /** 「更多」選單裡的 LED 對位圖（下載 PNG / CSV / JSON、LED 顯示測試圖）；預設有 */
  ledMapMenu?: boolean;
  /** 禁止下載（分享連結）：「更多」選單裡的 LED 對位圖 / AE 合成腳本 / 位置表下載不給（LED 顯示測試圖照舊） */
  hideDownloads?: boolean;
  /**
   * 這首歌選的 LED 版型（自己排的）+ 手動切的螢幕：有給 →「更多」選單的對位圖 / AE 合成腳本 / 位置表照版型下載（lib/ledTemplateDownload.ts），
   * 整張畫布的版本還是在（寫「（整張畫布）」）；沒給 = 跟以前一樣只有整張畫布
   */
  ledSongTemplate?: LedSongTemplate | null;
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
  /**
   * 錄影用：把 3D 畫面固定畫成這個大小（不管視窗多大；畫面上照比例縮小顯示）；null = 還原成跟視窗一樣大。
   * 固定大小時不降畫質、解析度倍率固定 1。
   */
  setRecordSize(size: { width: number; height: number } | null): void;
  /** 3D 畫面的 canvas（錄影用） */
  canvas(): HTMLCanvasElement | null;
}

/** 設定機關時問舞台的事（StageScene 的 sceneQueryRef） */
export interface StageSceneQuery {
  /** 舞台正面（水平、指向觀眾）＝ LED 朝的方向 */
  stageFront(): MechVec3;
  /** 這些物件在 cue 位置（沒加機關）時的外框中心；都找不到 → null */
  groupCenter(ids: string[]): MechVec3 | null;
  /** 這些物件在 cue 位置（沒加機關）時的外框（翻轉從外框算轉軸）；都找不到 → null */
  groupBox(ids: string[]): { min: MechVec3; max: MechVec3 } | null;
  /** 每個 LED 物件（stage object id）在整張 LED 畫布上的範圍（從模型的 UV 算；LED 畫布版型的螢幕清單用） */
  ledSpans?(): Record<string, SrcSpan>;
  /** 有 2 塊以上 LED mesh 的 LED 物件：每個 mesh 一塊（名稱 = mesh 名稱、範圍 = 那個 mesh 的 UV 外框）；其他物件沒有 */
  ledPartSpans?(): Record<string, AutoScreenPart[]>;
}

const NO_OFF_MESHES: ReadonlySet<THREE.Mesh> = new Set();
const NO_STAGE_PROPS: StagePropItem[] = [];
const NO_CAMERA_BOOKMARKS: CameraBookmark[] = [];
const NO_SKIP: ReadonlySet<string> = new Set<string>();
/** 樂手和器材的自發光：現場（暗場）/ 快速（亮場景） */
const PROP_BOOST_LIVE = 2.2;
const PROP_BOOST_QUICK = 0.8;

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

export default function StageScene({ states, stageObjects, selectedObjectIds, onSelect, onTransform, cueName, modelUrl, readOnly: readOnlyProp = false, defaultRenderMode, enableNdi = false, ndiUrl, onNdiStatus, onNdiFrameSize, ndiGuide: showNdiGuide = false, ndiGuideHint, crossfadeSeconds = 0, cueKey, showScaleButton = true, snapshotApiRef, comments, onCommentPinClick, onAddAnchoredComment, bookmarkScope, stageShow, cameraBookmarks = NO_CAMERA_BOOKMARKS, onCameraBookmarksChange, scaleCorrection = 1, onScaleCorrectionChange, stageProps = NO_STAGE_PROPS, onStagePropsChange, stagePropsHistory, lookSettings = DEFAULT_LOOK_SETTINGS, onLookSettingsChange, lookCustomized = false, onLookReset, onLookSaveAsDefault, materialOverrides, onMaterialOverrideChange, homeView = null, onHomeViewChange, ledVideo, ledImage, ledTemplate = null, ledTimeline = null, ledTimelineSec = 0, ledPreviewCanvas = null, ledPreviewVersion = 0, poseAtFrame, toolbarMode = 'full', mechanisms, mechanismTargets, mechanismAtFrame, mechanismTimings, mechanismFrameAlways = false, mechanismMotion = 'transition', sceneQueryRef, focusedMechanismId = null, projectName, ledCanvas = null, onLedCanvasChange, ledUvPreview = null, ledOffPieces, ledMapMenu = true, hideDownloads = false, ledSongTemplate = null, helpHref, viewApiRef, transportKeys = false, children }: Props) {
  // 只看模式（動畫師）：工具列只剩 🎥、一律唯讀
  const viewer = toolbarMode === 'viewer';
  const containerRef = useRef<HTMLDivElement>(null);
  /** 錄影中固定的畫面大小（null = 跟視窗一樣大） */
  const recordSizeRef = useRef<{ width: number; height: number } | null>(null);
  const applyQualityRef = useRef<(() => void) | null>(null);
  // 全螢幕預演：預設是 3D 舞台這一塊拉滿整個螢幕；頁面有給 stageShow.controller（換歌時 3D 舞台會整個重建的導演頁、分享連結）
  // 就用頁面自己的（全螢幕套在不會被換掉的外層）。預演中一律唯讀（不選物件、不拖 gizmo）
  const ownShow = useStageFullscreen(containerRef, !!stageShow && !stageShow.controller);
  const show = stageShow?.controller ?? ownShow;
  const showActiveRef = useRef(show.active);
  showActiveRef.current = show.active;
  const readOnly = readOnlyProp || viewer || show.active;
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
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
  // 選到的物件外面框一個亮綠色的方框（不靠材質發光：很多物件共用材質，發光會連別的一起亮），每一幀跟著物件走
  const selectionBoxesRef = useRef<Map<string, THREE.BoxHelper>>(new Map());
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
  // 移動 / 旋轉把手要不要出現：關掉後點物件只會選取（右邊面板照樣能打數字），鏡頭隨時可以轉，不會被把手擋住；記在這台電腦
  const [gizmoOn, setGizmoOn] = useState<boolean>(() => {
    try { return window.localStorage.getItem('sp_gizmo_on') !== '0'; } catch { return true; }
  });
  const toggleGizmo = () => setGizmoOn(v => {
    const next = !v;
    try { window.localStorage.setItem('sp_gizmo_on', next ? '1' : '0'); } catch { /* 存不了就只在這次有效 */ }
    return next;
  });
  // 滑鼠停在把手上時會暫時停掉鏡頭控制（不然拖把手時鏡頭也跟著轉）；把手拿掉時要記得還回來
  const gizmoBlockRef = useRef(false);
  const [space, setSpace] = useState<'world' | 'local'>('world');
  // 物件名稱 label 預設關掉（按 L 或工具列打開）
  const [showLabels, setShowLabels] = useState(false);
  // 大家一打開就是「快速」（10-29 用戶：現場不要當預設）；只有明確指定 live 才用現場（舊的 realistic / cinematic 也當現場）；只看模式一律快速
  const [renderMode, setRenderMode] = useState<RenderMode>(
    !viewer && (defaultRenderMode === 'live' || defaultRenderMode === 'realistic' || defaultRenderMode === 'cinematic') ? 'live' : 'quick',
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
  const mechTimingsRef = useRef(mechanismTimings);
  mechTimingsRef.current = mechanismTimings;
  const mechFrameAlwaysRef = useRef(mechanismFrameAlways);
  mechFrameAlwaysRef.current = mechanismFrameAlways;
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
  const [ledMapBusy, setLedMapBusy] = useState<null | 'png' | 'jsx' | 'tpl-png' | 'tpl-jsx'>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // NDI 真連線：connect 後拿到 frames 就 update CanvasTexture（替代 mock）
  const ndiLiveTextureRef = useRef<{ texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);
  // 本地影片 / 圖片 → LED 貼圖（ledVideo / ledImage prop 變了就重建）
  const ledMediaTextureRef = useRef<THREE.Texture | null>(null);
  const [ndiPopoverOpen, setNdiPopoverOpen] = useState(false);
  // 暫停 AE 即時：連線留著，但 LED 不顯示 AE 送來的畫面（回到對位圖 / 其他來源）；這個分頁記得
  const [ndiPaused, setNdiPaused] = useState<boolean>(() => {
    try { return sessionStorage.getItem('sp_ndi_paused') === '1'; } catch { return false; }
  });
  const toggleNdiPaused = () => setNdiPaused(v => {
    const next = !v;
    try { sessionStorage.setItem('sp_ndi_paused', next ? '1' : '0'); } catch { /* 存不了就只在這次有效 */ }
    return next;
  });
  // 「校正 AE 即時顏色」對話框
  const [ndiColorOpen, setNdiColorOpen] = useState(false);
  // AE 即時：小程序縮成幾分之一、專案的 LED 畫布（像素格密度用）、現在的顏色校正曲線（燈色取樣用）
  const ndiDownscaleRef = useRef<number | null>(null);
  const projectCanvasRef = useRef<LedCanvas | null>(null);
  projectCanvasRef.current = normalizeLedCanvas(ledCanvas);
  // LED 畫布版型：現在用的版型、每個 LED 物件在整張畫布上的範圍（從模型的 UV 算，一個物件只算一次）、燈光取色的位置換算
  const ledTemplateRef = useRef<LedTemplatePlan | null>(null);
  ledTemplateRef.current = ledTimeline && ledTimeline.segments.length >= 2 ? ledTimeline.segments[0].plan : ledTemplate;
  // 中途換版型：影片的畫面時鐘、沒有播放時間時用的時間、換段落的開關（材質設定那一步建好，每一幀 tick 叫 sync）
  const ledClockRef = useRef<FrameClock | null>(null);
  const ledTimelineSecRef = useRef(0);
  ledTimelineSecRef.current = ledTimelineSec;
  const ledSegmentsRef = useRef<SegmentSwitcher | null>(null);
  const onNdiFrameSizeRef = useRef(onNdiFrameSize);
  onNdiFrameSizeRef.current = onNdiFrameSize;
  const ndiReportedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const ledSpanCacheRef = useRef<WeakMap<THREE.Object3D, SrcSpan | null>>(new WeakMap());
  const ledPartCacheRef = useRef<WeakMap<THREE.Object3D, AutoScreenPart[]>>(new WeakMap());
  const ledTemplateRemapRef = useRef<Map<string, (r: UvRect) => UvRect | null>>(new Map());
  const ndiColorLutRef = useRef<NdiColorLut | null>(null);
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

  // 視角書籤：專案共用（cameraBookmarks prop，存取在 lib/useCameraBookmarks.ts），這裡只管開關面板
  const [bookmarkPanelOpen, setBookmarkPanelOpen] = useState(false);
  const [homeViewPanelOpen, setHomeViewPanelOpen] = useState(false);

  // Wireframe / X-ray 模式（debug 看穿模型結構）
  const [wireframe, setWireframe] = useState(false);

  // 比例尺輔助（人形 1.7 m + 1 m 網格，人形站在舞台面上、可以拖）— 給動畫師看實體大小
  const [showScaleRef, setShowScaleRef] = useState(false);
  const scaleRefGroupRef = useRef<THREE.Group | null>(null);
  // 比例尺面板：人形 / 網格 / 樂手和器材各自顯示與否（只影響自己的畫面）+ 選到哪個樂手或器材
  const [scaleParts, setScaleParts] = useState({ figures: true, grid: true, props: true });
  const scalePartsRef = useRef(scaleParts);
  scalePartsRef.current = scaleParts;
  const [scalePanelOpen, setScalePanelOpen] = useState(false);
  const [selectedPropId, setSelectedPropId] = useState<string | null>(null);
  const selectedPropRef = useRef<string | null>(null);
  selectedPropRef.current = selectedPropId;
  const stagePropsRef = useRef(stageProps);
  stagePropsRef.current = stageProps;
  const onStagePropsChangeRef = useRef(onStagePropsChange);
  onStagePropsChangeRef.current = onStagePropsChange;
  // 比例尺 effect 建好的樂手和器材圖層：新增時要用它算站位；effect 拆掉時清空
  const propsHostRef = useRef<{ layer: ReturnType<typeof createStagePropsLayer>; add: (type: StagePropType) => void } | null>(null);

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

  // 切成只看模式：回到快速、開著的工具 / 面板都收起來
  useEffect(() => {
    if (!viewer) return;
    setRenderMode('quick');
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
  // 進入全螢幕預演：開著的面板、量測、漫遊、3D 留言、選到的樂手都收起來（只剩畫面）
  useEffect(() => {
    if (!show.active) return;
    setLookPanelOpen(false);
    setMaterialPanelOpen(false);
    setHomeViewPanelOpen(false);
    setBookmarkPanelOpen(false);
    setScalePanelOpen(false);
    setNdiPopoverOpen(false);
    setMoreMenuOpen(false);
    setWalkMode(false);
    setMeasureMode(false);
    setAddPinMode(false);
    setSelectedPropId(null);
    // 量到一半的測距線也收掉（畫在 3D 裡面，不是 DOM，CSS 藏不到）
    measurePointsRef.current = [];
    setMeasureDistance(null);
    if (measureLineRef.current) (measureLineRef.current.geometry as THREE.BufferGeometry).setFromPoints([]);
  }, [show.active]);
  function loadBookmark(bm: CameraBookmark) {
    flyCamera(new THREE.Vector3(...bm.position), new THREE.Vector3(...bm.target), bm.fov);
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
      // 倒影只拍 LED（見 floorReflection.ts 檔頭）
      floorReflRef.current = new FloorReflection(renderer, LED_LAYER);
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
      // 最後一步：tone mapping + 曝光 + sRGB；LED 畫面（alpha 0）跳過壓色、照原檔（ledOutputPass.ts），光暈也在這裡加
      composer.addPass(new LedOutputPass(bloomPass));
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
        // AE 即時的顏色校正曲線只套這張（LED shader 看這個標記）
        tex.userData.ledColorLut = true;
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
    // 但正在轉鏡頭（orbit 拖曳中）時不能管：拖過把手上方會把 orbit 關掉 → 鏡頭轉到一半卡住，像撞到牆
    let orbitDragging = false;
    orbit.addEventListener('start', () => { orbitDragging = true; });
    orbit.addEventListener('end', () => {
      orbitDragging = false;
      // 放手時剛好停在把手上：照把手的規則補關（不然下一次按在把手上會兩個一起動）
      if (transform.axis !== null && transform.object) {
        gizmoBlockRef.current = true;
        orbit.enabled = false;
      }
    });
    transform.addEventListener('axis-changed', (event: any) => {
      if (orbitDragging) return;
      gizmoBlockRef.current = event.value !== null;
      orbit.enabled = (event.value === null);
    });
    // 滑鼠離開 3D 畫面：如果是被把手停掉的鏡頭控制，還回來（不然回到畫面時鏡頭轉不動，像被鎖住）
    renderer.domElement.addEventListener('pointerleave', () => {
      if (gizmoBlockRef.current && !transform.dragging) {
        gizmoBlockRef.current = false;
        orbit.enabled = true;
      }
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

      // Alt + 左鍵 = 純轉鏡頭（C4D / Maya 的習慣）：不選取、不拖把手，原本選的物件留著
      if (e.altKey) {
        altCameraDrag = true;
        transform.enabled = false;
        return;
      }

      // 用 transform.axis 判斷是否點在 gizmo handle 上（hover 時會被設成 'X'/'Y'/'Z'/'XY' 等）
      // 比 raycast gizmoHelper 可靠 — 後者會把隱形 drag plane 也 hit 中、擋住所有 click
      if (transform.axis !== null) return;

      // 選取改成「放開時、而且滑鼠幾乎沒動」才算點擊：按下去拖曳是在轉鏡頭，不該換掉選到的物件
      pendingClick = { x: e.clientX, y: e.clientY, shift: e.shiftKey, pointerId: e.pointerId };
    }

    // 放開滑鼠：Alt 轉鏡頭結束 → 把手恢復；按下到放開幾乎沒移動 → 才當成點擊做選取
    let pendingClick: { x: number; y: number; shift: boolean; pointerId: number } | null = null;
    let altCameraDrag = false;
    const CLICK_MOVE_TOLERANCE_PX = 5;
    function onPointerUpSelect(e: PointerEvent) {
      if (altCameraDrag) {
        altCameraDrag = false;
        transform.enabled = true;
      }
      const p = pendingClick;
      pendingClick = null;
      if (!p || e.button !== 0 || e.pointerId !== p.pointerId) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_MOVE_TOLERANCE_PX) return;
      if (readOnlyRef.current || transform.dragging) return;
      selectAt(p.x, p.y, p.shift);
    }

    function selectAt(clientX: number, clientY: number, shift: boolean) {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);

      // 鎖定的物件不參與 raycast
      const objs = Array.from(meshesRef.current.values()).filter(o => !o.userData.locked);
      // recursive: GLB 物件可能有子 mesh
      const hit = raycaster.intersectObjects(objs, true);
      const mode: SelectMode = shift ? 'toggle' : 'replace';
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
    renderer.domElement.addEventListener('pointerup', onPointerUpSelect);

    // 套目前的畫質檔：解析度 / bloom / 地板倒影 / 燈數（resize 和自動調畫質都走這裡；不用重載模型）
    const applyQuality = () => {
      const q = qualityRef.current;
      ledRigRef.current?.setMaxLights(q.maxLights);
      floorReflRef.current?.setEnabled(renderModeRef.current === 'live' && q.reflectionScale > 0);
      // 光暈 0 = 整個不畫（省 13 次全畫面運算）
      if (bloomPassRef.current) bloomPassRef.current.enabled = q.bloomScale > 0 && lookRef.current.bloomStrength > 0;
      if (renderer.xr.isPresenting) return;  // VR 中不能改尺寸
      const rec = recordSizeRef.current;
      const w = rec ? rec.width : container.clientWidth;
      const h = rec ? rec.height : container.clientHeight;
      if (w === 0 || h === 0) return;
      const pr = rec ? 1 : Math.min(window.devicePixelRatio, q.pixelRatioCap);
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

    applyQualityRef.current = applyQuality;

    // ── 機關：每幀最後把「cue 位置 + 機關」寫到 mesh（只有這裡寫）──
    //   正在 3D 拖的物件不動（拖完會把放手的位置倒回 cue 位置）；多選的物件暫時在 pivot 底下 → 換算成 pivot 裡的位置
    const mechValuesFor = (nowTs: number, timelineActive: boolean): MechanismValues => {
      const rigNow = rigRef.current;
      const shown = displayedMechRef.current;
      if (rigNow.mechanisms.length === 0) return EMPTY_VALUES;
      const tweener = mechTweenerRef.current;
      let v: MechanismValues | null = timelineActive || mechFrameAlwaysRef.current ? (mechAtFrameRef.current?.() ?? null) : null;
      if (v) {
        mechTimelineActiveRef.current = true;
      } else {
        if (mechTimelineActiveRef.current) {
          // 影片時間軸剛停（點了沒設時間的 cue / 換 AE 即時）→ 從畫面上最後的位置走回目前 cue 的位置
          mechTimelineActiveRef.current = false;
          tweener.setCurrent(shown, nowTs);
          tweener.retarget(rigNow.mechanisms, mechTargetsRef.current || EMPTY_VALUES, nowTs, {
            animate: mechMotionRef.current !== 'instant', minSeconds: crossfadeRef.current, motion: mechMotionRef.current,
            timings: mechTimingsRef.current,
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
      for (const box of selectionBoxesRef.current.values()) box.update();

      // 動態 near / far：鏡頭遠時 near 拉大，貼很近的兩個面才不會閃爍
      if (!renderer.xr.isPresenting) {
        const oc = orbitRef.current;
        const d = walkPointerLockRef.current || !oc ? 0 : camera.position.distanceTo(oc.target);
        if (applyClipPlanes(camera, d, stageBoundsRef.current.radius * 2)) camera.updateProjectionMatrix();
      }

      // 自動畫質：一直卡 → 降一級；一直很順 → 升回去（VR 中不量）
      if (renderer.xr.isPresenting || recordSizeRef.current) {
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

      // 機關：這一幀的值（影片時間軸 / 點 cue 走過去）→ 套到每個物件（整個畫面只在這裡寫 mesh 的位置）
      commitPosesRef.current(nowTs, !!framePoses);

      // 中途換版型：這一格畫面是影片的第幾秒 → 換到那一段的排法。跟這一幀要畫的畫面同一幀生效（上傳貼圖在後面的 render），不會閃
      ledSegmentsRef.current?.sync();

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
            (id, uv) => {
              const src = sources.get(id);
              if (!src) return null;
              // 版型：燈光顏色從版型畫布上這塊螢幕的位置取；沒放進版型的螢幕 = 黑的
              const remap = ledTemplateRemapRef.current.get(id);
              if (!remap) return reader.sample(src, uv);
              const r = remap(uv);
              return r ? reader.sample(src, r) : [0, 0, 0];
            },
            (id) => props.get(id) || fallback,
            lookRef.current.ledLightStrength,
          );
          // LED 表面：像素格密度跟著貼圖解析度、側看衰減跟著現場設定（測試圖不畫像素格，字才清楚）
          const liveTexture = ndiLiveTextureRef.current?.texture;
          for (const mat of ledMaterialsRef.current) {
            const tex = mat.emissiveMap;
            const img = tex?.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
            const iw = img?.videoWidth || img?.width || 1;
            const ih = img?.videoHeight || img?.height || 1;
            // AE 即時：看收到的大小跟 LED 畫布（或小程序回報縮了幾倍）算一共幾顆 LED；其他貼圖一個像素 = 一顆
            // 版型：影片 / 圖片 / AE 畫面是版型畫布（可能縮小，形狀也跟整張畫布不一樣），像素格一律用整張畫布的真實點數
            // （沒有版型時 tplNative = null，跟以前完全一樣）
            const tplNative = ledTemplateRef.current && tex && (tex === ledMediaTextureRef.current || tex === liveTexture) ? projectCanvasRef.current : null;
            const texels: [number, number] = tplNative
              ? [tplNative.width, tplNative.height]
              : tex && tex === liveTexture
                ? ndiLedTexels({ width: iw, height: ih }, projectCanvasRef.current, ndiDownscaleRef.current)
                : [iw, ih];
            updateLedSurface(mat, {
              on: !!tex,
              texels,
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
        // 這一次 LED 把 alpha 寫 0 → 最後一步認得出 LED 畫面、不壓色（倒影 / 環境光那幾次不標）
        LED_SHARED_UNIFORMS.uLedMaskOut.value = 1;
        try {
          composerRef.current.render();
        } finally {
          LED_SHARED_UNIFORMS.uLedMaskOut.value = 0;
        }
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
      renderer.domElement.removeEventListener('pointerup', onPointerUpSelect);
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
          // LED 物件裡哪些是螢幕（框架、台體不是；lib/ledScreen.ts）
          const screens = isLedPanel ? ledScreenMeshes(obj) : null;
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
              // 雙面渲染：LED 螢幕維持單面（emissive 不該從背面看到），其他都雙面（喇叭、LED 的框架等不會少一面）
              const mat = m.material as THREE.MeshStandardMaterial;
              mat.side = screens?.has(m) ? THREE.FrontSide : THREE.DoubleSide;
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

  // ── 機關目標：換 cue → 照走幾秒走過去；同一個 cue 裡改值（滑桿 / 常用位置 / 打字）→ 直接跳 ──
  const lastMechCueKeyRef = useRef<string | null | undefined | typeof UNSET_CUE>(UNSET_CUE);
  useEffect(() => {
    const prev = lastMechCueKeyRef.current;
    const animate = mechanismMotion !== 'instant' && prev !== UNSET_CUE && cueKey !== prev;
    const now = performance.now();
    mechTweenerRef.current.retarget(rig.mechanisms, mechanismTargets || EMPTY_VALUES, now, {
      animate, minSeconds: crossfadeSeconds, motion: mechanismMotion, timings: mechanismTimings,
    });
    lastMechCueKeyRef.current = cueKey;
    commitPosesRef.current(now, timelineActiveRef.current);
  }, [rig, mechanismTargets, cueKey, crossfadeSeconds, mechanismMotion, mechanismTimings]);

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
      groupBox: (ids) => {
        const box = baseBox(ids);
        if (box.isEmpty()) return null;
        return { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
      },
      ledSpans: () => {
        const list: { id: string; category: string }[] = stageObjectsRef.current
          ? stageObjectsRef.current.map(o => ({ id: o.id, category: o.category }))
          : (statesRef.current || []).map(s => ({ id: s.objectId, category: s.category }));
        const out: Record<string, SrcSpan> = {};
        for (const o of list) {
          if (o.category !== 'led_panel') continue;
          const mesh = meshesRef.current.get(o.id);
          const span = mesh ? ledObjectSpan(mesh) : null;
          if (span) out[o.id] = span;
        }
        return out;
      },
      ledPartSpans: () => {
        const list: { id: string; category: string }[] = stageObjectsRef.current
          ? stageObjectsRef.current.map(o => ({ id: o.id, category: o.category }))
          : (statesRef.current || []).map(s => ({ id: s.objectId, category: s.category }));
        const out: Record<string, AutoScreenPart[]> = {};
        for (const o of list) {
          if (o.category !== 'led_panel') continue;
          const mesh = meshesRef.current.get(o.id);
          const parts = mesh ? ledObjectParts(mesh) : [];
          if (parts.length > 0) out[o.id] = parts;
        }
        return out;
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
      setRecordSize: (size) => {
        recordSizeRef.current = size && size.width > 0 && size.height > 0 ? { width: Math.round(size.width), height: Math.round(size.height) } : null;
        if (containerRef.current) { if (recordSizeRef.current) containerRef.current.dataset.recording = '1'; else delete containerRef.current.dataset.recording; }
        applyQualityRef.current?.();
      },
      canvas: () => rendererRef.current?.domElement ?? null,
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
    if (show.active) return;  // 全螢幕預演（簡報畫面）不畫這條工作用的線
    const focusedDef = focusedMechanismId ? (mechanisms || []).find(x => x.id === focusedMechanismId) : undefined;
    // 吊掛：點到整組 = 畫每個吊點的行程；點到一個吊點 = 畫那一個（都從吊點在物件上的位置往上畫）
    const hoistDefs = focusedDef?.variant === 'hoist_rig' ? hoistsOfRig(mechanisms || [], focusedDef.id)
      : focusedDef?.variant === 'hoist' ? [focusedDef] : null;
    const m = hoistDefs ? undefined : focusedMechanismId ? rig.byId.get(focusedMechanismId) : undefined;
    if (!m && !(hoistDefs && hoistDefs.length)) return;
    // 畫在哪：機關帶的第一個物件（通常就是升降台 / 轉台本身）；沒有 → 裝在它上面的機關帶的物件
    // 對開：A 邊、B 邊各畫一條（B 邊用鏡像的方向 / 轉軸中心）
    const def = m ? (mechanisms || []).find(x => x.id === m.id) : undefined;
    const presets = def?.presets.map(p => p.value) || [];
    const geoms: ReturnType<typeof travelGeometry>[] = [];
    for (const node of m ? [m, rig.mirrors.get(m.id)] : []) {
      if (!node) continue;
      let ids = def?.objectIds.filter(id => rig.chains.get(id)?.[0] === node).slice(0, 1) ?? [];
      if (ids.length === 0 && !node.side) ids = [...rig.chains].filter(([, chain]) => chain.includes(node)).map(([id]) => id);
      const box = baseBox(ids);
      const center = box.isEmpty() ? node.pivot.clone() : box.getCenter(new THREE.Vector3());
      const size = box.isEmpty() ? 1 : Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.2);
      geoms.push(travelGeometry(node, center, size, presets));
    }
    for (const h of hoistDefs ?? []) {
      const node = rig.byId.get(h.id);
      if (!node || !h.attach) continue;
      geoms.push(travelGeometry(node, new THREE.Vector3(h.attach.x, h.attach.y, h.attach.z), 1.5, h.presets.map(p => p.value)));
    }
    const color = new THREE.Color(0xffaa44);
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
    const tickMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
    const group = new THREE.Group();
    group.name = 'mechanism-travel';
    const lines = geoms.map(g => new THREE.Line(new THREE.BufferGeometry().setFromPoints(g.path), lineMat));
    const segs = geoms.flatMap(g => [...g.ends, ...g.ticks].flat());
    const ticks = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), tickMat);
    for (const o of [...lines, ticks]) { o.renderOrder = 999; o.frustumCulled = false; group.add(o); }
    // 外層的機關（這個機關裝在哪個機關上）
    const outer: RigMechanism[] = [];
    // 吊點沒有自己的上層；整組裝在哪個機關上，行程線就跟著那個機關動
    const parentOf = m ? m.parentId : (mechanisms || []).find(x => x.id === (hoistDefs?.[0]?.rigId ?? ''))?.parentId ?? null;
    for (let cur = parentOf ? rig.byId.get(parentOf) : undefined; cur && outer.length < 4 && !outer.includes(cur); cur = cur.parentId ? rig.byId.get(cur.parentId) : undefined) {
      outer.push(cur);
    }
    scene.add(group);
    travelRef.current = { group, outer };
    applyChain(outer, displayedMechRef.current, ZERO_VEC, IDENTITY_QUAT, group.position, group.quaternion);
    return () => {
      scene.remove(group);
      for (const l of lines) l.geometry.dispose();
      ticks.geometry.dispose();
      lineMat.dispose();
      tickMat.dispose();
      if (travelRef.current?.group === group) travelRef.current = null;
    };
  }, [focusedMechanismId, rig, mechanisms, states, modelVersion, show.active]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 選取外框：選到的物件框一個亮綠色方框（穿過別的東西也看得到），唯讀模式不畫 ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const boxes = selectionBoxesRef.current;
    const want = new Set(readOnly ? [] : selectedObjectIds);
    for (const [id, box] of boxes) {
      const obj = meshesRef.current.get(id);
      if (!want.has(id) || !obj || (box as unknown as { object?: THREE.Object3D }).object !== obj) {
        scene.remove(box);
        box.geometry.dispose();
        (box.material as THREE.Material).dispose();
        boxes.delete(id);
      }
    }
    for (const id of want) {
      if (boxes.has(id)) continue;
      const obj = meshesRef.current.get(id);
      if (!obj) continue;
      const box = new THREE.BoxHelper(obj, 0x10c78a);
      const mat = box.material as THREE.LineBasicMaterial;
      mat.depthTest = false;
      mat.transparent = true;
      mat.opacity = 0.9;
      box.renderOrder = 999;
      box.name = 'selection-box';
      scene.add(box);
      boxes.set(id, box);
    }
  }, [selectedObjectIds, readOnly, modelVersion, states.length]);

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

    // 把手拿掉時，被把手停掉的鏡頭控制要還回來（以前會一直停著 → 點過物件後鏡頭像被鎖住）
    const releaseOrbit = () => {
      if (gizmoBlockRef.current && !transform.dragging) {
        gizmoBlockRef.current = false;
        if (orbitRef.current) orbitRef.current.enabled = true;
      }
    };

    // 唯讀模式、或使用者把「把手」關掉：永遠 detach（不顯示 gizmo）
    if (readOnly || !gizmoOn) {
      transform.detach();
      releaseOrbit();
      return;
    }

    if (selectedObjectIds.length === 0) {
      transform.detach();
      releaseOrbit();
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
  }, [selectedObjectIds, states.length, pivotVersion, readOnly, modelVersion, gizmoOn]);

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
      // 畫面大小第一次知道 / 換了才通知上層（跟 LED 版型的畫布大小比，不是每一幀）
      const seen = ndiReportedSizeRef.current;
      if (!seen || seen.width !== bitmap.width || seen.height !== bitmap.height) {
        ndiReportedSizeRef.current = { width: bitmap.width, height: bitmap.height };
        onNdiFrameSizeRef.current?.(ndiReportedSizeRef.current);
      }
      bitmap.close?.();
    },
  });
  const ndiGuideState = ndi.guide;
  ndiDownscaleRef.current = ndiGuideState.helperDownscale;
  // LED 用 AE 畫面：這條連線收過畫面就用（AE 停住時留在最後一格）
  const ndiActive = enableNdi && ndiGuideState.hasFrame && !ndiPaused;
  // AE 即時的顏色校正：新版小程序送原始像素 → 預設曲線 / 這台電腦的校正；舊版照以前
  const ndiCalibration = useNdiCalibration();
  const ndiColor = useMemo(
    () => pickNdiColorCurve(ndiGuideState.colorPipeline, ndiGuideState.sourceIsAe, ndiCalibration),
    [ndiGuideState.colorPipeline, ndiGuideState.sourceIsAe, ndiCalibration],
  );
  useEffect(() => {
    // 曲線是全站共用的 uniform：只有開 AE 即時的這個 3D 畫面才動它（藏起來截圖用的那個不要蓋掉）
    if (!enableNdi) return;
    const lut = ndiColor.kind !== 'none' ? ndiColor.lut : null;
    ndiColorLutRef.current = lut;
    setLedColorLut(lut);
    return () => {
      ndiColorLutRef.current = null;
      setLedColorLut(null);
    };
  }, [enableNdi, ndiColor]);
  // 校正：直接量 3D 舞台正在顯示的那張（AE 停住也有最後一格）
  const grabLiveFrame = useCallback(() => {
    const live = ndiLiveTextureRef.current;
    return live && ndiGuideState.hasFrame ? readPixels(live.canvas) : null;
  }, [ndiGuideState.hasFrame]);
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
    // 現場：舞台用 Neutral tone mapping（LED 畫面不經過，見 ledOutputPass.ts）；Quick 維持 ACES（LED 一樣不經過）
    renderer.toneMapping = live ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = live ? look.exposure : 1;
    // LED 畫面照原檔、不吃曝光；曝光只用來算 LED 表面反光照相機曲線多亮（跟舞台其他地方一致）
    LED_SHARED_UNIFORMS.uLedExposure.value = renderer.toneMappingExposure;
    if (!live) scene.environment = null;
    scene.environmentIntensity = live ? 0.2 + look.ledLightStrength * 0.4 : 1;
    const bloom = bloomPassRef.current;
    if (bloom) {
      bloom.strength = look.bloomStrength;
      bloom.radius = 0.3;
      bloom.threshold = 0.75;
      bloom.enabled = qualityRef.current.bloomScale > 0 && look.bloomStrength > 0;
    }
    ledRigRef.current?.setEnabled(live);
    if (!live) for (const mat of ledMaterialsRef.current) updateLedSurface(mat, { on: false });
    floorReflRef.current?.setSettings(look.floorReflection, look.reflectionSharpness);
    floorReflRef.current?.setEnabled(live && qualityRef.current.reflectionScale > 0);
  }, [renderMode, lookSettings]);
  // 全螢幕預演（簡報畫面）：原點的紅綠藍座標軸是工作用的，不畫（地板格線是畫面的一部分，照舊）
  useEffect(() => {
    const h = helpersRef.current;
    if (h) h.axes.visible = renderMode !== 'live' && !show.active;
  }, [renderMode, show.active]);

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
    // 編輯 LED 版型：畫出來的測試圖（canvas）當成「版型畫布」，其他路一個字都不動
    if (ledPreviewCanvas) {
      const ptex = new THREE.CanvasTexture(ledPreviewCanvas);
      ptex.colorSpace = THREE.SRGBColorSpace;
      ptex.minFilter = THREE.LinearFilter;
      ptex.magFilter = THREE.LinearFilter;
      ptex.generateMipmaps = false;
      ptex.flipY = false;
      ptex.wrapS = ptex.wrapT = LED_TEXTURE_WRAP;
      ledMediaTextureRef.current = ptex;
      return () => {
        if (ledMediaTextureRef.current === ptex) ledMediaTextureRef.current = null;
        ptex.dispose();
      };
    }
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
    // 影片停著（換歌、換版本都停在第一格）：瀏覽器不會送「新的一格」→ 讀好那一格、拉時間軸之後自己傳一次，LED 才不會黑
    const pushFrame = () => { if (ledVideo && ledVideo.readyState >= ledVideo.HAVE_CURRENT_DATA) tex.needsUpdate = true; };
    const frameEvents = ledVideo ? ['loadeddata', 'seeked'] : [];
    pushFrame();
    frameEvents.forEach(ev => ledVideo?.addEventListener(ev, pushFrame));
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
      frameEvents.forEach(ev => ledVideo?.removeEventListener(ev, pushFrame));
      if (ledMediaTextureRef.current === tex) ledMediaTextureRef.current = null;
      tex.dispose();
    };
  }, [ledVideo, ledImage, ledPreviewCanvas]);

  // 編輯 LED 版型的測試圖重畫了 → 重傳貼圖
  useEffect(() => {
    if (ledPreviewCanvas && ledMediaTextureRef.current) ledMediaTextureRef.current.needsUpdate = true;
  }, [ledPreviewCanvas, ledPreviewVersion]);

  // 中途換版型要知道「現在這一格是影片的第幾秒」（只有真的有時間線、而且放的是影片才開；要排在下面「材質」那個 effect 前面）
  const hasLedTimeline = !!(ledTimeline && ledTimeline.segments.length >= 2);
  useEffect(() => {
    if (!ledVideo || !hasLedTimeline || ledPreviewCanvas) { ledClockRef.current = null; return; }
    const frameClock = createFrameClock(ledVideo);
    ledClockRef.current = frameClock;
    return () => {
      frameClock.dispose();
      if (ledClockRef.current === frameClock) ledClockRef.current = null;
    };
  }, [ledVideo, hasLedTimeline, ledPreviewCanvas]);

  // ── LED 對位圖 / 測試圖：每塊 LED 在畫布上的位置（從模型的 UV 算）──
  const resolvedCanvas = useMemo(
    () => resolveLedCanvas(ledUvPreview ? ledUvPreview.canvas : ledCanvas, mediaSize),
    [ledCanvas?.width, ledCanvas?.height, ledUvPreview, mediaSize?.width, mediaSize?.height], // eslint-disable-line react-hooks/exhaustive-deps
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
    // 一個物件裡有好幾塊 LED：測試圖每塊各自一格（各自的名稱、外框、座標）
    return buildLedLayout(ledPanelInputs(objs, (o) => {
      if (ledObjectParts(o.root).length < 2) return null;
      return ledScreenParts(o.root, o.root.name || 'LED');
    }), canvas);
  }, []);
  // 哪些 LED（名字 / 順序）：變了才重畫測試圖
  const ledObjectsKey = stageObjects
    ? stageObjects.filter(o => o.category === 'led_panel').map(o => `${o.id}:${o.displayName}:${o.order}`).join('|')
    : states.filter(st => st.category === 'led_panel').map(st => `${st.objectId}:${st.displayName}:${st.order}`).join('|');

  // 自動貼 UV 的 3D 預覽：LED 的 UV 暫時換成套用以後的（不改原本的 geometry，關掉就放回去）。要排在下面的測試圖 effect 前面
  useEffect(() => {
    if (!ledUvPreview) return;
    const applied = applyUvPreview(ledUvPreview, (id) => meshesRef.current.get(id));
    ledSpanCacheRef.current = new WeakMap();
    ledPartCacheRef.current = new WeakMap();
    emitterCacheRef.current = new WeakMap();
    if (applied.missing.length > 0) console.warn('[StageScene] LED UV 預覽對不上這些物件，沒換：', applied.missing);
    return () => {
      applied.restore();
      ledSpanCacheRef.current = new WeakMap();
      ledPartCacheRef.current = new WeakMap();
      emitterCacheRef.current = new WeakMap();
    };
  }, [ledUvPreview, modelVersion]);

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
      drawTestPattern(ctx, layout, size.scale, ledUvPreview ? { upArrow: true } : undefined);
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
  }, [modelVersion, ledObjectsKey, states.length, resolvedCanvas.canvas.width, resolvedCanvas.canvas.height, computeLedLayout, startQuality, ledUvPreview]);

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

  /** 這首歌選的版型的螢幕清單（跟 LED 版型編輯器同一套：每個 LED 物件一塊，手動切的螢幕取代它） */
  function songTemplateDefs(tpl: LedSongTemplate, full: CanvasSize): ScreenDef[] {
    const list = stageObjectsRef.current
      ? stageObjectsRef.current.map(o => ({ id: o.id, name: o.displayName || o.meshName, order: o.order, category: o.category }))
      : (statesRef.current || []).map(st => ({ id: st.objectId, name: st.displayName || st.meshName, order: st.order, category: st.category }));
    const autos = list.filter(o => o.category === 'led_panel').map(o => {
      const mesh = meshesRef.current.get(o.id);
      return { objectId: o.id, name: o.name, order: o.order, src: (mesh && ledObjectSpan(mesh)) || { us: 0, ul: 1, vs: 0, vl: 1 }, parts: mesh ? ledObjectParts(mesh) : [] };
    });
    // 舊版型用的「整個物件一塊」(o:<id>) 照舊留在清單裡
    const inUse = new Set<string>();
    for (const pl of tpl.timeline ? tpl.timeline.segments.map(sg => sg.plan) : [tpl.plan]) for (const sc of pl?.screens ?? []) inUse.add(sc.key);
    return buildScreenList(autos, tpl.manuals, full, inUse);
  }

  /** 「⋯」→ 版型的下載（對位圖 / AE 合成腳本 / 位置表）：lib/ledTemplateDownload.ts */
  async function downloadSongTemplate(kind: LedDownloadKind) {
    const full = projectCanvasRef.current;
    if (!ledSongTemplate || !full) { toast.error('版型要先有 LED 畫布大小'); return; }
    const busy = kind === 'png' ? 'tpl-png' : kind === 'jsx' ? 'tpl-jsx' : null;
    if (busy) setLedMapBusy(busy);
    try {
      await new Promise(r => requestAnimationFrame(() => r(null)));
      const defs = songTemplateDefs(ledSongTemplate, full);
      const meta = { projectName: projectName || '', date: todayString(), fullCanvas: full };
      // 這首歌有中途換版型：整條時間線一起下載（每個版型一份）
      const n = ledSongTemplate.timeline
        ? await downloadSongTimelineFile(kind, ledSongTemplate.timeline, defs, { ...meta, songName: ledSongTemplate.songName })
        : await downloadSongTemplateFile(kind, ledSongTemplate.plan, defs, meta);
      toast[n.level](n.text, n.duration);
    } finally {
      if (busy) setLedMapBusy(null);
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

  // LED 物件在整張畫布上的範圍（UV 外框，會繞回、可以跨接縫）：同一個物件只算一次
  function ledObjectSpan(obj: THREE.Object3D): SrcSpan | null {
    const cache = ledSpanCacheRef.current;
    if (cache.has(obj)) return cache.get(obj) ?? null;
    const lay = layoutPanel({ id: 'span', name: 'span', tris: collectUvTriangles(obj) }, { width: 1, height: 1 }, 0);
    const span = lay ? spanFromAxes(lay.u, lay.v) : null;
    cache.set(obj, span);
    return span;
  }

  // LED 物件裡每個 LED mesh 各自的範圍（2 塊以上、而且在畫布上分得開才拆；不拆 = 空陣列）：同一個物件只算一次
  function ledObjectParts(obj: THREE.Object3D): AutoScreenPart[] {
    const cache = ledPartCacheRef.current;
    const hit = cache.get(obj);
    if (hit) return hit;
    const parts = usableParts(ledScreenParts(obj, obj.name || 'LED').map((p) => {
      const lay = layoutPanel({ id: 'span', name: p.name, tris: collectUvTriangles(obj, new Set(p.meshes)) }, { width: 1, height: 1 }, 0);
      return { name: p.name, src: lay ? spanFromAxes(lay.u, lay.v) : null };
    }));
    cache.set(obj, parts);
    return parts;
  }

  // 不放進畫布的 LED 清單換了才要重新整理材質（陣列每次 render 都是新的，用內容比）
  const ledOffKey = (ledOffPieces ?? []).join(String.fromCharCode(31));

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
    const offSet = new Set(ledOffPieces ?? []);
    // 中途換版型（至少兩段才算）：每一段每個物件的取色資料先算好；現在是第幾段看影片的畫面時鐘（沒有影片 = 頁面給的時間）
    const timeline = ledTimeline && ledTimeline.segments.length >= 2 ? ledTimeline : null;
    const segTime = () => (ledClockRef.current ? ledClockRef.current.time() : ledTimelineSecRef.current);
    const startSeg = timeline ? segmentIndexAt(timeline, segTime()) : 0;
    const segObjects: SegmentObject[] = [];

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
      if (isLed && ledPreviewCanvas && ledMediaTextureRef.current) {
        // 正在編輯 LED 版型：版型的測試圖蓋過所有東西
        ledTexture = ledMediaTextureRef.current;
      } else if (isLed && (forceTestPattern || !!ledUvPreview) && testPatternTex) {
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

      // LED 畫布版型：這個物件的螢幕放法（對「影片 / 圖片」和 AE 即時收到的那張版型畫布；imageUrl 是整張畫布）
      // 還沒有影片、顯示測試圖時：測試圖不搬位置，只有版型放了的螢幕亮、其他黑（手動開的測試圖 / UV 預覽照舊整張）
      const coverageOnly = ledTexture === testPatternTex && !forceTestPattern && !ledUvPreview;
      let tplData: ReturnType<typeof buildObjectUniforms> | null = null;
      let segPer: SegmentObject['per'] | null = null;
      if ((timeline || ledTemplate) && isLed && ledTexture && (coverageOnly || ledTexture === ledMediaTextureRef.current || ledTexture === ndiLiveTextureRef.current?.texture)) {
        // 手動切的螢幕用自己的範圍；物件裡某個 LED mesh（key = o:<id>~<mesh 名稱>）用那個 mesh 的範圍（找不到 = 不貼）；其他整個物件一塊
        const srcFor = (p: Placement): SrcSpan | null => {
          if (p.uv) return spanFromUv(p.uv);
          const part = parseScreenKey(p.key)?.part;
          if (part === undefined) return ledObjectSpan(obj);
          return ledObjectParts(obj).find(x => x.name === part)?.src ?? null;
        };
        if (timeline) {
          segPer = timeline.segments.map(seg => ({
            plan: seg.plan,
            data: coverageOnly ? buildCoverageUniforms(seg.plan, id, srcFor) : buildObjectUniforms(seg.plan, id, srcFor),
            remap: coverageOnly ? coverageRemap(seg.plan, id, srcFor) : (r: UvRect) => mapUvRectToTemplate(seg.plan, id, srcFor, r),
          }));
          tplData = segPer[startSeg].data;
          ledTemplateRemapRef.current.set(id, segPer[startSeg].remap);
        } else {
          const plan = ledTemplate!;
          tplData = coverageOnly ? buildCoverageUniforms(plan, id, srcFor) : buildObjectUniforms(plan, id, srcFor);
          ledTemplateRemapRef.current.set(id, coverageOnly ? coverageRemap(plan, id, srcFor) : (r) => mapUvRectToTemplate(plan, id, srcFor, r));
        }
      } else {
        ledTemplateRemapRef.current.delete(id);
      }

      // LED 物件各自一份材質：模型裡的 LED 通常共用同一個材質，版型 / 亮度 / 色調 / 選取是每個物件的設定，
      // 共用的話後面的物件會蓋掉前面的（只剩最後一塊有畫面）。細節見 lib/stageLook/ledOwnMaterial.ts
      // 自動貼 UV 不放進畫布的 LED 一律黑色：上次換掉的材質先還原，這次要黑的 mesh 換成自己專用的複本（lib/ledOffPieces.ts）
      restoreOffMaterials(obj);
      if (isLed) ensureOwnLedMaterials(obj);
      const offMeshes = offSet.size > 0 ? offScreenMeshes(obj, id, isLed, offSet) : NO_OFF_MESHES;
      swapOffMaterials(offMeshes);
      // 舊影片（自動貼 UV 以前做的）：模型存了原本的 UV（uv1）就直接用它取色，一個像素都不差；沒存的材質照舊用版型的長方形
      const curPlan = timeline ? timeline.segments[startSeg].plan : ledTemplate;
      const wantsOrigAny = !coverageOnly && (segPer ? segPer.some(s => planWantsOriginalUv(s.plan, id)) : !!(ledTemplate && planWantsOriginalUv(ledTemplate, id)));
      const origAllMats = tplData && wantsOrigAny ? materialsWithOriginalUv(obj) : null;
      const origUvMats = origAllMats && curPlan && planWantsOriginalUv(curPlan, id) ? origAllMats : null;
      const segMats: THREE.MeshStandardMaterial[] = [];
      // LED 物件裡只有螢幕吃 LED 材質 / 畫面；框架、台體、燈牆面照一般物件畫（lib/ledScreen.ts，跟自動貼 UV 同一條規則）
      const screens = isLed ? ledScreenMeshes(obj) : null;

      obj.traverse((c) => {
        if (!(c as THREE.Mesh).isMesh) return;
        const isOff = offMeshes.has(c as THREE.Mesh);
        const isScreen = !!screens && screens.has(c as THREE.Mesh) && !isOff;
        // LED 也放進 LED_LAYER → 環境光的 CubeCamera 只拍這層
        if (isScreen) c.layers.enable(LED_LAYER);
        else if (isLed || isOff) c.layers.disable(LED_LAYER);
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!m || !('color' in m)) return;
        // 任何分支改材質之前先記下 C4D 原值（材質面板 / 回到原本 用）
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) captureOriginal(m);

        // 雙面渲染：LED 螢幕永遠 FrontSide（emissive 不該從背面看到），其他（含 LED 的框架）DoubleSide
        const targetSide = isScreen ? THREE.FrontSide : THREE.DoubleSide;
        if (m.side !== targetSide) {
          m.side = targetSide;
          m.needsUpdate = true;
        }

        if (isScreen && isLit) {
          // === LED in 現場模式 ===
          // 像真的 LED 牆：底色接近黑、roughness 0.3 → 畫面暗的地方是黑亮面，會映出其他 LED（反射來自 LED 環境光）
          // 畫面 = emissiveMap × tint × 亮度，正面看 = 原檔顏色（不壓色、不吃曝光；ledSurface.ts + ledOutputPass.ts）
          // 像素顆粒 / 側看變暗也在 ledSurface shader
          configureLedMaterial(m, { mode: 'live', texture: ledTexture, tint: ledTint, brightness: ledBrightness });
          const useOrig = !!origUvMats && origUvMats.has(m);
          setLedTemplate(m, useOrig ? null : tplData);
          setLedOriginalUv(m, useOrig);
          segMats.push(m);
          ledMaterials.add(m);
          // selected highlight：LED 不洗白，這裡只在沒畫面、沒亮度時加一點點當提示
          if (isSelected && ledBrightness < 0.05 && !ledTexture) {
            m.emissive.copy(accentGreen);
            m.emissiveIntensity = 0.3;
          }
        } else if (isScreen && ledTexture) {
          // === LED in Quick mode（有畫面）===
          // 快速模式：給動畫師 1:1 對顏色 → 只有畫面，不打燈、不反光、不壓色（以前放在 map 會被燈光打暗一大半）
          configureLedMaterial(m, { mode: 'quick', texture: ledTexture });
          const useOrig = !!origUvMats && origUvMats.has(m);
          setLedTemplate(m, useOrig ? null : tplData);
          setLedOriginalUv(m, useOrig);
          segMats.push(m);
          ledMaterials.add(m);
        } else {
          // === 一般物件 / Quick mode 的 LED（沒貼圖時）===
          // 材質 = C4D 匯出的原值 → 材質面板依名稱的覆寫 → 單一物件 materialProps（舊功能，最優先）
          // （以前會用 category 顏色 + 固定 roughness 0.6 / metalness 0.1 蓋掉，C4D 的材質全被洗成同一種塑膠）
          // 沒模型時的方塊替身：建立時就是 category 顏色，所以「原值」本身就是 category 顏色
          // emissive 只在 selected 時 highlight
          updateLedSurface(m, { on: false, mode: 'off' });
          setLedTemplate(m, null);
          setLedOriginalUv(m, false);
          applyMaterialSettings(m, materialOverrides?.[m.name], {
            color: mat.color, roughness: mat.roughness, metalness: mat.metalness, opacity: mat.opacity,
          });
          // 地板倒影：非 LED 材質都掛上（shader 只在「落在反射平面上、朝上」的地方才取樣倒影）
          // 有材質勾了「鏡面地板」→ 只有勾的材質反光；都沒勾 → 全部（自動找地板）
          if (!isScreen && floorReflRef.current) {
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
          if (isScreen && m.map) { m.map = null; m.needsUpdate = true; }
          if (isSelected) {
            m.emissive.copy(accentGreen);
            m.emissiveIntensity = 0.4;
          } else {
            m.emissive.copy(black);
            m.emissiveIntensity = 0;
          }
          // 不放進畫布的 LED：不管有沒有版型、材質面板怎麼設，都是沒通電的黑色
          if (isOff) blackenMaterial(m);
        }
      });

      if (segPer && segMats.length > 0) segObjects.push({ id, materials: segMats, per: segPer, originalUvMaterials: origAllMats });

      // 3. LED 照明：記下取色來源 / 燈參數；發光面只算一次（換模型才重算）
      if (isLed && so) {
        ledSourcesRef.current.set(id, ledTexture
          ? {
            image: ledTexture.image as CanvasImageSource,
            flipY: ledTexture.flipY,
            // AE 即時：燈色跟 LED 畫面一樣先校正顏色
            ...(ndiLiveTextureRef.current && ledTexture === ndiLiveTextureRef.current.texture ? { colorLut: () => ndiColorLutRef.current } : {}),
          }
          : null);
        ledLightPropsRef.current.set(id, {
          brightness: ledBrightness,
          castStrength: so.ledProps?.castLightStrength ?? 1,
          tint: ledTint.clone(),
        });
        let emitters = offMeshes.size > 0 ? undefined : emitterCacheRef.current.get(obj);
        if (!emitters) {
          emitters = buildLedEmitters(obj, { maxAngleDeg: 35, maxPerObject: 4, exclude: offMeshes });
          if (offMeshes.size === 0) emitterCacheRef.current.set(obj, emitters);
        }
        ledRigRef.current?.setObjectEmitters(id, emitters);
        ledIds.add(id);
      }
    });

    ledMaterialsRef.current = ledMaterials;
    // 中途換版型：每一幀 tick 叫 sync（看現在是第幾段，跟套用的不一樣就整批換）
    ledSegmentsRef.current = timeline && segObjects.length > 0
      ? createSegmentSwitcher({
        objects: segObjects, startIndex: startSeg, pick: () => segmentIndexAt(timeline, segTime()),
        setRemap: (oid, remap) => { ledTemplateRemapRef.current.set(oid, remap); },
      })
      : null;
    ledRigRef.current?.retainObjects(ledIds);
    for (const id of [...ledSourcesRef.current.keys()]) {
      if (!ledIds.has(id)) { ledSourcesRef.current.delete(id); ledLightPropsRef.current.delete(id); }
    }
  }, [stageObjects, renderMode, states, selectedObjectIds, ndiActive, modelVersion, materialOverrides, ledVideo, ledImage, ledTemplate, ledTimeline, ledPreviewCanvas, testPatternTex, forceTestPattern, ledUvPreview, ledOffKey]);

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
    const addMaterials = (root: THREE.Object3D, skip: Set<THREE.Mesh> | null) => {
      root.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!(c as THREE.Mesh).isMesh || !m?.isMeshStandardMaterial || skip?.has(c as THREE.Mesh)) return;
        const entry = byName.get(m.name) || { objects: new Set(), original: captureOriginal(m) };
        entry.objects.add(root);
        byName.set(m.name, entry);
      });
    };
    for (const root of roots) addMaterials(root, null);
    // LED 物件裡不是螢幕的部分（框架、台體、燈牆面）也是一般材質，可以在材質面板調（lib/ledScreen.ts）
    meshesRef.current.forEach((obj, id) => {
      if (stageObjMap.get(id)?.category === 'led_panel') addMaterials(obj, ledScreenMeshes(obj));
    });
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

  // ── 比例尺輔助：人形（站在舞台面上、可以拖）+ 每格 1 公尺的網格 ──
  // 用 scaleCorrection 把真實公尺換算成 scene units，所以校準後尺寸就會對得起來。
  // 人形站哪：把舞台（不含 LED）所有朝上的面依高度加總面積，最大的那一層 = 舞台面（桁架 / 屋頂的頂面小很多，不會被當成地板）；
  // 舞台面正面那一側的前緣往內縮，左 / 中 / 右各一個，往下打光線站上去（算法在 lib/scaleReference.ts）。
  // 模型載入 / 換了（modelVersion）、校準倍率變了就重新擺；拖動只在這次開著的時候有效，不存檔。
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // 拆掉舊的
    if (scaleRefGroupRef.current) {
      scene.remove(scaleRefGroupRef.current);
      scaleRefGroupRef.current.traverse((c) => {
        const m = c as THREE.Mesh;
        const sp = c as THREE.Sprite;
        if (m.isMesh) {
          m.geometry?.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach(x => x?.dispose?.());
          else mat?.dispose?.();
        } else if (sp.isSprite) {
          (sp.material as THREE.SpriteMaterial).map?.dispose?.();
          sp.material.dispose();
        }
      });
      scaleRefGroupRef.current = null;
    }

    if (!showScaleRef) return;

    const group = new THREE.Group();
    group.name = 'scale-reference';

    // 1 公尺對應幾個 scene unit
    const unitsPerMeter = 1 / scaleCorrection;

    // ── 舞台面：哪些 mesh 可以站（不含 LED、走位點、表演者）──
    const categoryOf = new Map<string, string>();
    for (const o of stageObjectsRef.current || []) categoryOf.set(o.id, o.category);
    for (const s of statesRef.current || []) if (!categoryOf.has(s.objectId)) categoryOf.set(s.objectId, s.category);
    const visibleMeshes = (include: (id: string) => boolean): THREE.Mesh[] => {
      const out: THREE.Mesh[] = [];
      meshesRef.current.forEach((obj, id) => {
        if (!include(id)) return;
        obj.updateWorldMatrix(true, true);
        obj.traverseVisible((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
      });
      return out;
    };
    const groundMeshes = () => visibleMeshes(id => canStandOnCategory(categoryOf.get(id)));
    const ledRoots = [...meshesRef.current].filter(([id]) => categoryOf.get(id) === 'led_panel').map(([, o]) => o);
    const front = stageFrontDirection(ledRoots);
    const front2 = { x: front.x, z: front.z };

    // 朝上的面 → 面積最大的那一層 = 舞台面 → 它的前後左右範圍
    const ground = groundMeshes();
    const faces = extractUpFaces(ground);
    const level = findDeckLevel(faces, unitsPerMeter);
    const footprint = level == null ? null : deckFootprint(faces, level, front2, unitsPerMeter);
    // 往下 / 沿著滑鼠打光線只打「舞台面 + 3.5 m 以內」的朝上的面（比整個模型快很多，也不會站到桁架、屋頂上）
    const capY = level == null ? Infinity : level + MAX_STAND_ABOVE_DECK_M * unitsPerMeter;
    let walkMesh = buildWalkMesh(faces, capY);
    let walkSig = surfaceSignature(ground);

    // 光線沒打到東西時站的高度 = 舞台外框最低點
    const box = new THREE.Box3();
    for (const m of ground) box.expandByObject(m);
    const hasBox = !box.isEmpty();
    const floorY = hasBox ? box.min.y : 0;
    const downRay = new THREE.Raycaster();

    const spots = footprint
      ? figureSpotsFromExtent(footprint.extent, front2, unitsPerMeter)
      : hasBox ? pickFigureSpots(box, front2, unitsPerMeter) : defaultFigureSpots(unitsPerMeter);

    // 一個站位 → 人形腳底的位置：從舞台面上方往下打光線，站在打到的最高的水平面上
    const standAt = (spot: { x: number; z: number }): THREE.Vector3 => {
      const targets = walkMesh ? [walkMesh] : [];
      if (footprint) {
        // 站位剛好在舞台面的形狀外面（斜角、缺口）→ 往舞台面的重心一步步找，找到真的有舞台面的地方
        for (let k = 0; k <= 10; k++) {
          const x = spot.x + (footprint.centroid.x - spot.x) * (k / 10);
          const z = spot.z + (footprint.centroid.z - spot.z) * (k / 10);
          const y = standingYAt(targets, x, z, footprint.level + 1 * unitsPerMeter, Number.NaN, downRay);
          if (!Number.isNaN(y) && Math.abs(y - footprint.level) <= 0.3 * unitsPerMeter) return new THREE.Vector3(x, y, z);
        }
      }
      // 沒有舞台面可以對：從模型上方往下打，站最高的水平面；打不到就站在外框最低點
      const top = (hasBox ? box.max.y : 0) + 1 * unitsPerMeter;
      return new THREE.Vector3(spot.x, standingYAt(targets, spot.x, spot.z, top, floorY, downRay), spot.z);
    };

    // ── 人形：淺色填色 + 深色外框，亮的暗的舞台都看得到 ──
    const FIG_W = 160, FIG_H = 320;
    const makePersonTexture = () => {
      const canvas = document.createElement('canvas');
      canvas.width = FIG_W;
      canvas.height = FIG_H;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#1a1a1a';
        ctx.fillStyle = '#e6e6e6';
        const cx = FIG_W / 2;
        // 頭
        ctx.beginPath();
        ctx.arc(cx, 34, 22, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        // 身體 + 手臂 + 兩條腿（一個輪廓）
        ctx.beginPath();
        ctx.moveTo(cx - 20, 64);
        ctx.lineTo(cx + 20, 64);
        ctx.quadraticCurveTo(cx + 46, 66, cx + 50, 92);   // 右肩
        ctx.lineTo(cx + 56, 168);                          // 右手臂外側
        ctx.lineTo(cx + 42, 170);
        ctx.lineTo(cx + 36, 112);                          // 右手臂內側
        ctx.lineTo(cx + 32, 184);                          // 右腰
        ctx.lineTo(cx + 30, 312);                          // 右腿外側
        ctx.lineTo(cx + 6, 312);
        ctx.lineTo(cx + 2, 196);                           // 胯
        ctx.lineTo(cx - 2, 196);
        ctx.lineTo(cx - 6, 312);
        ctx.lineTo(cx - 30, 312);
        ctx.lineTo(cx - 32, 184);
        ctx.lineTo(cx - 36, 112);
        ctx.lineTo(cx - 42, 170);
        ctx.lineTo(cx - 56, 168);
        ctx.lineTo(cx - 50, 92);
        ctx.quadraticCurveTo(cx - 46, 66, cx - 20, 64);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    // 畫面上人形頭頂到腳底（含外框）佔 FIG_H 裡的 [FIG_TOP, FIG_BOTTOM]（頭頂 y = 34 - 22 - 2.5，腳底 y = 312 + 2.5）
    const FIG_TOP = 9.5, FIG_BOTTOM = 314.5;
    const figureHeightUnits = FIGURE_HEIGHT_M * unitsPerMeter * (FIG_H / (FIG_BOTTOM - FIG_TOP));
    const personTex = makePersonTexture();
    const makePerson = () => {
      const mat = new THREE.SpriteMaterial({ map: personTex, transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(figureHeightUnits * (FIG_W / FIG_H), figureHeightUnits, 1);
      sprite.center.set(0.5, 1 - FIG_BOTTOM / FIG_H);   // 腳底對準站的高度（sprite 的 center：0 = 底、1 = 頂）
      sprite.renderOrder = 5;
      sprite.name = 'scale-reference-person';
      return sprite;
    };

    // 「1.7 m」的小字，跟著中間那個人形
    const makeLabel = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 96;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = 'bold 60px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 10;
        ctx.strokeStyle = '#1a1a1a';
        ctx.strokeText(FIGURE_LABEL, 128, 50);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(FIGURE_LABEL, 128, 50);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
      const sprite = new THREE.Sprite(mat);
      const h = 0.36 * unitsPerMeter;
      sprite.scale.set(h * (256 / 96), h, 1);
      sprite.center.set(0.5, 0);
      sprite.renderOrder = 6;
      sprite.name = 'scale-reference-label';
      return sprite;
    };

    // 站好
    const figs: THREE.Sprite[] = spots.map((spot) => {
      const p = makePerson();
      p.position.copy(standAt(spot));
      group.add(p);
      return p;
    });
    const centerFig = figs[1];
    const label = makeLabel();
    const placeLabel = () => label.position.set(centerFig.position.x, centerFig.position.y + (FIGURE_HEIGHT_M + 0.1) * unitsPerMeter, centerFig.position.z);
    placeLabel();
    group.add(label);

    // 網格：20m × 20m，每格 1m，中心在舞台正中間、高度跟中間人形站的地面一樣
    const gridSize = 20 * unitsPerMeter;
    const gridDiv = 20;
    const grid = new THREE.GridHelper(gridSize, gridDiv, 0x10c78a, 0x2a5d4a);
    (grid.material as THREE.LineBasicMaterial).transparent = true;
    (grid.material as THREE.LineBasicMaterial).opacity = 0.55;
    const stageCenter = footprint ? footprint.center : hasBox ? { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 } : { x: 0, z: 0 };
    const gc = gridCenter(stageCenter, centerFig.position.y);
    grid.position.set(gc.x, gc.y + 0.001 * unitsPerMeter, gc.z); // 比地板高一咪咪避免 z-fighting
    grid.name = 'scale-reference-grid';
    group.add(grid);

    // 舞台動過（機關、換 cue）→ 抓人形 / 樂手和器材的時候重抓一次朝上的面
    const refreshWalk = () => {
      const now = groundMeshes();
      const sig = surfaceSignature(now);
      if (sig === walkSig) return;
      walkSig = sig;
      disposeWalkMesh(walkMesh);
      walkMesh = buildWalkMesh(extractUpFaces(now), capY);
    };

    // ── 樂手和器材（存在專案上全員共用，格式見 lib/stageProps.ts）──
    // 這裡負責畫出來、新增時算站位（舞台前緣正中間，已經有東西就往左右找空位，面向觀眾）；拖動、選取在下面跟人形一起處理。
    const layer = createStagePropsLayer(unitsPerMeter);
    group.add(layer.group);
    layer.sync(stagePropsRef.current, selectedPropRef.current);
    layer.setBoost(renderModeRef.current === 'live' ? PROP_BOOST_LIVE : PROP_BOOST_QUICK);
    const rightAxis = (() => { const a = frontAxes(front2); return { x: a.rx, z: a.rz }; })();
    propsHostRef.current = {
      layer,
      add: (type) => {
        const items = stagePropsRef.current;
        const change = onStagePropsChangeRef.current;
        if (!change || items.length >= STAGE_PROP_MAX) return;
        refreshWalk();
        const base = spots[1];
        const free = freeSpot(items, { x: base.x / unitsPerMeter, z: base.z / unitsPerMeter }, rightAxis);
        const at = standAt({ x: free.x * unitsPerMeter, z: free.z * unitsPerMeter });
        const item = sanitizeStagePropItem({
          id: newStagePropId(), type, x: at.x / unitsPerMeter, y: at.y / unitsPerMeter, z: at.z / unitsPerMeter,
          // 地板監聽喇叭是對著樂手（背對觀眾），其他面向觀眾
          rotY: type === 'monitor' ? normalizeRotY(facingYaw(front2) + 180) : facingYaw(front2),
        });
        if (!item) return;
        change([...items, item]);
        selectedPropRef.current = item.id;
        setSelectedPropId(item.id);
      },
    };

    scene.add(group);
    scaleRefGroupRef.current = group;

    // ── 拖人形、拖樂手和器材：按住拖，沿著舞台面滑（往下打光線找站的高度；樂手台的頂面也算，所以可以站上去）──
    // 鏡頭不轉、不會選到物件 / 改 cue / 加留言：用 capture 先攔下 pointerdown（比 OrbitControls、選取、gizmo 的監聽早），
    // 拖的時候也把 OrbitControls 關掉；手指（觸控）一樣走 pointer events。
    // 樂手和器材：點一下選到（琥珀色 + 腳下圈圈），拖圈圈上的圓點自由轉；只有 onStagePropsChange 有給（製作、導演）才抓得到。
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    let stopDrag: () => void = () => {};
    let resetHover: () => void = () => {};
    if (renderer && camera && orbit) {
      const canvas = renderer.domElement;
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const tmp = new THREE.Vector3();
      const foot = new THREE.Vector3();
      type Drag =
        | { kind: 'fig'; fig: THREE.Sprite; pointerId: number; dx: number; dy: number }
        | { kind: 'prop'; id: string; pointerId: number; dx: number; dy: number; start: StagePropItem[]; next: StagePropItem[]; skip: Set<string>; moved: boolean }
        | { kind: 'rotate'; id: string; pointerId: number; start: StagePropItem[]; next: StagePropItem[]; a0: number; moved: boolean };
      let drag: Drag | null = null;
      let hovering = false;
      let pending: PointerEvent | null = null;
      let raf = 0;
      let tap: { pointerId: number; x: number; y: number } | null = null;

      const aim = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
      };
      const figureAt = (e: PointerEvent): { fig: THREE.Sprite; distance: number } | null => {
        if (!scalePartsRef.current.figures) return null;
        aim(e.clientX, e.clientY);
        const hit = ray.intersectObjects(figs, false)[0];
        return hit ? { fig: hit.object as THREE.Sprite, distance: hit.distance } : null;
      };
      const propAt = (e: PointerEvent): { id: string; distance: number; handle: boolean } | null => {
        // 全螢幕預演（給客戶看）時不能抓：不小心拖到會改到全專案共用的擺放
        if (!scalePartsRef.current.props || !onStagePropsChangeRef.current || showActiveRef.current) return null;
        aim(e.clientX, e.clientY);
        const h = selectedPropRef.current ? layer.pickHandle(ray) : null;   // 圈圈上的轉動把手優先
        if (h) return { ...h, handle: true };
        const p = layer.pick(ray);
        return p ? { ...p, handle: false } : null;
      };
      const selectProp = (id: string | null) => {
        if (id && !selectedPropRef.current) setScalePanelOpen(true);   // 剛選到 → 展開面板，轉 / 刪的按鈕就在裡面
        selectedPropRef.current = id;
        setSelectedPropId(id);
        layer.sync(stagePropsRef.current, id);
      };
      // 別的工具（量測 / 加留言點 / 走路 / 拖 gizmo）用著的時候，不搶滑鼠
      const busy = () => !orbit.enabled || measureModeRef.current || addPinModeRef.current;
      // 腳站的地方：舞台面 + 別的樂手台的頂面（正在拖的和站在它上面的不算）
      const stepTargets = (skip?: ReadonlySet<string>): THREE.Object3D[] => [...(walkMesh ? [walkMesh] : []), ...layer.walkables(skip)];
      const itemOf = (items: readonly StagePropItem[], id: string) => items.find(i => i.id === id);
      // 滑鼠在腳底水平面上的方位角（度），轉動把手用
      const angleAt = (e: PointerEvent, it: StagePropItem): number | null => {
        aim(e.clientX, e.clientY);
        const p = ray.ray.intersectPlane(plane.set(plane.normal, -it.y * unitsPerMeter), tmp);
        return p ? (Math.atan2(p.x - it.x * unitsPerMeter, p.z - it.z * unitsPerMeter) * 180) / Math.PI : null;
      };

      const applyDrag = () => {
        raf = 0;
        const e = pending;
        pending = null;
        if (!drag || !e) return;
        if (drag.kind === 'rotate') {
          const it = itemOf(drag.start, drag.id);
          const a = it ? angleAt(e, it) : null;
          if (!it || a == null) return;
          let rot = it.rotY + (a - drag.a0);
          if (e.shiftKey) rot = Math.round(rot / 15) * 15;
          drag.next = moveStagePropWith(drag.start, drag.id, { x: it.x, y: it.y, z: it.z, rotY: normalizeRotY(rot) });
          drag.moved = true;
          layer.sync(drag.next, drag.id);
          return;
        }
        // 瞄準「腳在畫面上的位置」（滑鼠 - 抓住時滑鼠離腳的距離）：光線穿過腳的地方就是它踩的那個面
        aim(e.clientX - drag.dx, e.clientY - drag.dy);
        if (drag.kind === 'prop') {
          const it = itemOf(drag.next, drag.id);
          if (!it) return;
          const targets = stepTargets(drag.skip);
          const hit = targets.length > 0 ? ray.intersectObjects(targets, false)[0] : undefined;
          let x: number, y: number, z: number;
          if (hit) {
            x = hit.point.x; y = hit.point.y; z = hit.point.z;
          } else {
            // 瞄到舞台外面：在現在的高度那個水平面上滑，再往下打光線（比現在高 0.5 m 以內的頂面可以踩上去，滑出台緣就掉到下面）
            const curY = it.y * unitsPerMeter;
            const p = ray.ray.intersectPlane(plane.set(plane.normal, -curY), tmp);
            if (!p) return;
            x = p.x; z = p.z;
            y = standingYAt(targets, x, z, curY + 0.5 * unitsPerMeter, floorY, downRay);
          }
          // 滑鼠指在樂手台的側面（光線穿過去打到底下的地板）→ 站到樂手台的頂面上
          const onTop = riserTopAt(drag.start, drag.skip, x / unitsPerMeter, z / unitsPerMeter, y / unitsPerMeter);
          if (onTop !== null) y = onTop * unitsPerMeter;
          drag.next = moveStagePropWith(drag.start, drag.id, { x: x / unitsPerMeter, y: y / unitsPerMeter, z: z / unitsPerMeter, rotY: it.rotY });
          drag.moved = true;
          layer.sync(drag.next, drag.id);
          return;
        }
        // 人形也可以站上樂手台（樂手和器材有顯示的時候）
        const figTargets = scalePartsRef.current.props ? stepTargets() : (walkMesh ? [walkMesh] : []);
        const hit = figTargets.length > 0 ? ray.intersectObjects(figTargets, false)[0] : undefined;
        let x: number, y: number, z: number;
        if (hit) {
          x = hit.point.x; y = hit.point.y; z = hit.point.z;
        } else {
          // 瞄到舞台外面：在人形現在的高度那個水平面上滑，再往下打光線（滑出台緣就掉到下面的地板）
          const p = ray.ray.intersectPlane(plane.set(plane.normal, -drag.fig.position.y), tmp);
          if (!p) return;
          x = p.x; z = p.z;
          y = standingYAt(figTargets, x, z, drag.fig.position.y + 0.05 * unitsPerMeter, floorY, downRay);
        }
        if (scalePartsRef.current.props) {
          const onTop = riserTopAt(stagePropsRef.current, NO_SKIP, x / unitsPerMeter, z / unitsPerMeter, y / unitsPerMeter);
          if (onTop !== null) y = onTop * unitsPerMeter;
        }
        drag.fig.position.set(x, y, z);
        if (drag.fig === centerFig) placeLabel();
      };

      const endDrag = (commit = true) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (d.kind === 'fig') (d.fig.material as THREE.SpriteMaterial).color.set(0xffffff);
        else if (commit && d.moved) onStagePropsChangeRef.current?.(d.next);   // 放開才存（拖的時候只動畫面）
        orbit.enabled = true;
        canvas.style.cursor = hovering ? 'grab' : '';
        try { canvas.releasePointerCapture(d.pointerId); } catch { /* 已經放掉了 */ }
      };

      const onDown = (e: PointerEvent) => {
        if (e.button !== 0 || drag || busy()) return;
        const f = figureAt(e);
        const pr = propAt(e);
        // 人形和樂手 / 器材都指到的話，抓比較近的；轉動把手畫在最上面，優先
        const propHit = pr && (pr.handle || !f || pr.distance <= f.distance) ? pr : null;
        const figHit = propHit ? null : f;
        const hitDistance = propHit ? propHit.distance : figHit?.distance;
        if (hitDistance === undefined) return;
        // 被舞台擋住（站在牆 / 結構後面）→ 看不到就不抓，鏡頭照常轉（轉動把手不用檢查）
        if (!propHit?.handle) {
          const blocker = ray.intersectObjects(visibleMeshes(() => true), false)[0];
          if (blocker && blocker.distance < hitDistance - 0.05 * unitsPerMeter) return;
        }
        e.stopImmediatePropagation();
        e.preventDefault();
        refreshWalk();
        // 抓住時滑鼠離腳的螢幕距離，拖的時候維持不變（東西不會跳到滑鼠位置）
        const rect = canvas.getBoundingClientRect();
        const grabOffset = (p: THREE.Vector3) => {
          foot.copy(p).project(camera);
          return { dx: e.clientX - (rect.left + ((foot.x + 1) / 2) * rect.width), dy: e.clientY - (rect.top + ((1 - foot.y) / 2) * rect.height) };
        };
        if (propHit) {
          const start = stagePropsRef.current.slice();
          const it = itemOf(start, propHit.id);
          if (!it) return;
          selectProp(propHit.id);
          if (propHit.handle) {
            const a0 = angleAt(e, it);
            if (a0 == null) return;
            drag = { kind: 'rotate', id: it.id, pointerId: e.pointerId, start, next: start, a0, moved: false };
          } else {
            const skip = new Set<string>([it.id, ...propsStandingOn(start, it.id)]);
            drag = { kind: 'prop', id: it.id, pointerId: e.pointerId, ...grabOffset(new THREE.Vector3(it.x, it.y, it.z).multiplyScalar(unitsPerMeter)), start, next: start, skip, moved: false };
          }
        } else if (figHit) {
          drag = { kind: 'fig', fig: figHit.fig, pointerId: e.pointerId, ...grabOffset(figHit.fig.position) };
          (figHit.fig.material as THREE.SpriteMaterial).color.set(0xfff0b8);
        }
        orbit.enabled = false;
        canvas.style.cursor = 'grabbing';
        try { canvas.setPointerCapture(e.pointerId); } catch { /* 不支援就算了，移出畫面才會斷 */ }
      };
      const onMove = (e: PointerEvent) => {
        if (drag) {
          if (e.pointerId !== drag.pointerId) return;
          pending = e;
          if (!raf) raf = requestAnimationFrame(applyDrag);
          return;
        }
        if (e.pointerType === 'touch') return;
        const over = !busy() && (!!figureAt(e) || !!propAt(e));
        if (over !== hovering) { hovering = over; canvas.style.cursor = over ? 'grab' : ''; }
      };
      const onUp = (e: PointerEvent) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        if (pending) applyDrag();   // 最後一個位置也套上
        endDrag();
      };
      // 點一下空白處（沒拖）→ 取消選到的樂手或器材。抓到東西的 pointerdown 在上面就攔掉了，不會走到這裡
      const onTapDown = (e: PointerEvent) => {
        tap = e.button === 0 && selectedPropRef.current ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY } : null;
      };
      const onTapUp = (e: PointerEvent) => {
        const t = tap;
        tap = null;
        if (t && t.pointerId === e.pointerId && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 6) selectProp(null);
      };

      canvas.addEventListener('pointerdown', onDown, true);
      canvas.addEventListener('pointerdown', onTapDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointerup', onTapUp);
      canvas.addEventListener('pointercancel', onUp);
      stopDrag = () => {
        canvas.removeEventListener('pointerdown', onDown, true);
        canvas.removeEventListener('pointerdown', onTapDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointerup', onTapUp);
        canvas.removeEventListener('pointercancel', onUp);
        if (raf) cancelAnimationFrame(raf);
        pending = null;
        endDrag(false);
      };
      resetHover = () => { if (hovering) { hovering = false; canvas.style.cursor = ''; } };
    }

    return () => {
      stopDrag(); resetHover(); disposeWalkMesh(walkMesh);
      propsHostRef.current = null;
      layer.dispose();
    };
  }, [showScaleRef, scaleCorrection, modelVersion]);

  // 比例尺面板的三個勾：人形 / 網格 / 樂手和器材（效果重建完再套，所以放在上面那個 effect 後面）
  useEffect(() => {
    const g = scaleRefGroupRef.current;
    if (!g) return;
    for (const c of g.children) {
      if (c.name === 'scale-reference-person' || c.name === 'scale-reference-label') c.visible = scaleParts.figures;
      else if (c.name === 'scale-reference-grid') c.visible = scaleParts.grid;
      else if (c.name === 'scale-reference-props') c.visible = scaleParts.props;
    }
  }, [scaleParts, showScaleRef, scaleCorrection, modelVersion]);
  // 專案上的樂手和器材 / 選到哪個變了 → 更新畫面；選到的被別人刪掉了就取消選取
  useEffect(() => {
    propsHostRef.current?.layer.sync(stageProps, selectedPropId);
    if (selectedPropId && !stageProps.some(p => p.id === selectedPropId)) setSelectedPropId(null);
  }, [stageProps, selectedPropId]);
  // 現場（暗場）要亮一點才看得到灰色模型，快速模式（場景本來就亮）低一點
  useEffect(() => {
    propsHostRef.current?.layer.setBoost(renderMode === 'live' ? PROP_BOOST_LIVE : PROP_BOOST_QUICK);
  }, [renderMode]);
  // 比例尺關掉 / 切到只看模式 → 面板收起來、不留選取；開了別的彈出框 → 比例尺面板讓開（位置一樣會疊在一起）
  useEffect(() => {
    if (showScaleRef) return;
    setScalePanelOpen(false);
    setSelectedPropId(null);
  }, [showScaleRef]);
  useEffect(() => {
    if (bookmarkPanelOpen || homeViewPanelOpen || ndiPopoverOpen) setScalePanelOpen(false);
  }, [bookmarkPanelOpen, homeViewPanelOpen, ndiPopoverOpen]);

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
      // 只看模式：快捷鍵全部關掉；全螢幕預演中也是（W / E / Q / L / X 都是編輯用的）
      if (viewerRef.current || isStageShowActive()) return;
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

  /** 常用看台預設視角（正面全景、控台 FOH、二樓看台、特區） */
  function computePresetViewHelper(preset: CameraPreset): { position: THREE.Vector3; target: THREE.Vector3 } | null {
    const modelRoots = [...modelMeshMapRef.current.values()];
    if (modelRoots.length > 0) {
      return computePresetView(preset, modelRoots, ledModelRoots(modelMeshMapRef.current), DEFAULT_FOV, viewAspect());
    } else if (meshesRef.current.size > 0) {
      const ledIds = new Set((stageObjectsRef.current || []).filter(o => o.category === 'led_panel').map(o => o.id));
      const leds = [...meshesRef.current].filter(([id]) => ledIds.has(id)).map(([, m]) => m);
      return computePresetView(preset, [...meshesRef.current.values()], leds, DEFAULT_FOV, viewAspect());
    }
    return null;
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
    const rec = recordSizeRef.current;
    if (rec) return rec.width / rec.height;
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
  // 比例尺：還沒開 → 打開並展開設定面板；已經開著 → 展開 / 收起設定面板（要關掉按面板裡的「關閉比例尺」）
  const openScalePanel = () => {
    setShowScaleRef(true);
    setScalePanelOpen(o => (showScaleRef ? !o : true));
    setBookmarkPanelOpen(false); setHomeViewPanelOpen(false); setNdiPopoverOpen(false);
  };
  const scaleTitle = showScaleRef ? '比例尺設定：人形、網格、樂手和器材' : '顯示比例尺：人形 1.7 m、每格 1 m 的網格、樂手和器材';
  const scaleTool: ToolDef = {
    id: 'scale', group: 'show', priority: 6,
    render: (l) => toolBtn({ icon: PersonStanding, label: '比例尺', title: scaleTitle, labeled: l, active: showScaleRef, onClick: openScalePanel }),
    menu: { icon: PersonStanding, label: showScaleRef ? '比例尺設定…' : '比例尺', checked: showScaleRef, hint: scaleTitle, onSelect: openScalePanel },
  };
  // 規則在 lib/stageProps.ts：只有 onStagePropsChange 有給的人（製作、導演）能改
  const canEditProps = !!onStagePropsChange;
  const selectedProp = selectedPropId ? stageProps.find(p => p.id === selectedPropId) : undefined;
  const rotateSelectedProp = (deg: number) => {
    if (selectedProp) onStagePropsChange?.(rotateStagePropBy(stageProps, selectedProp.id, deg));
  };
  const deleteSelectedProp = () => {
    if (!selectedProp) return;
    onStagePropsChange?.(removeStageProp(stageProps, selectedProp.id));
    setSelectedPropId(null);
  };

  // 「視角」：常用看台視角 + 專案共用的視角書籤；只看模式（動畫師、分享連結）也有，只是不能存 / 改
  const viewsTitle = `視角（專案存了 ${cameraBookmarks.length} 個）：常用看台視角、專案共用的視角` + (onCameraBookmarksChange ? '，可以存目前視角' : '');
  const viewsTool: ToolDef = {
    id: 'views', group: 'camera', priority: 3,
    render: (l) => toolBtn({
      icon: Camera, label: '視角', title: viewsTitle, labeled: l, active: bookmarkPanelOpen, onClick: openBookmarkPanel,
      extra: l && cameraBookmarks.length > 0 ? <span className="muted small"> {cameraBookmarks.length}</span> : null,
    }),
    menu: { icon: Camera, label: cameraBookmarks.length > 0 ? `視角…（${cameraBookmarks.length}）` : '視角…', hint: viewsTitle, onSelect: openBookmarkPanel },
  };

  // 「全螢幕預演」：頁面有給 stageShow 才有（F 也一樣）
  const showTitle = '全螢幕預演（按 F）：給別人看的乾淨畫面，操作介面和各種提示都藏起來；滑鼠一動會出現下方的小條（換歌、播放、換 cue、視角、離開）';
  const showTool: ToolDef = {
    id: 'show', group: 'show', priority: 5,
    render: (l) => toolBtn({ icon: Maximize, label: '全螢幕預演', title: showTitle, labeled: l, onClick: show.enter }),
    menu: { icon: Maximize, label: '全螢幕預演', shortcut: 'F', hint: showTitle, onSelect: show.enter },
  };

  // 全螢幕預演小條的「視角」選單：常用看台視角 + 專案存的視角，只能點了切換（存 / 改 / 刪在工具列的「視角」面板）
  const showViews: StageShowViewGroup[] | undefined = show.active && stageShow && bookmarkScope ? [
    {
      title: '常用看台視角',
      items: CAMERA_PRESETS.map(p => ({
        id: p.id, label: p.label, hint: p.hint,
        onSelect: () => { const v = computePresetViewHelper(p.id); if (v) flyCamera(v.position, v.target, DEFAULT_FOV); },
      })),
    },
    {
      title: `專案的視角${cameraBookmarks.length > 0 ? `（${cameraBookmarks.length}）` : ''}`,
      items: cameraBookmarks.map(bm => ({ id: bm.id, label: bm.name, onSelect: () => loadBookmark(bm) })),
    },
  ] : undefined;

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
    const gizmoTitle = gizmoOn
      ? '把手：開（點物件會出現移動 / 旋轉把手）。按一下關掉：點物件只選取，鏡頭隨時可以轉'
      : '把手：關（點物件只選取，用右邊面板打數字）。按一下打開移動 / 旋轉把手';
    tools.push({
      id: 'gizmo', group: 'edit', priority: 2,
      render: (l) => toolBtn({ icon: Axis3d, label: '把手', title: gizmoTitle, labeled: l, active: gizmoOn, pressed: gizmoOn, onClick: toggleGizmo }),
      menu: { icon: Axis3d, label: '把手', checked: gizmoOn, hint: '關掉後點物件不會出現把手，鏡頭不會被擋住', onSelect: toggleGizmo },
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
    if (showScaleButton) tools.push(scaleTool);
    tools.push({
      id: 'labels', group: 'show', priority: 2,
      render: (l) => toolBtn({ icon: Tag, label: '名稱', title: (showLabels ? '隱藏物件名稱' : '顯示物件名稱') + (transportKeys ? '' : ' (L)'), labeled: l, active: showLabels, pressed: showLabels, onClick: () => setShowLabels(s => !s) }),
      menu: { icon: Tag, label: '物件名稱', shortcut: transportKeys ? undefined : 'L', checked: showLabels, onSelect: () => setShowLabels(s => !s) },
    });
  }
  if (stageShow) tools.push(showTool);
  tools.push({
    id: 'reset', group: 'camera', priority: 0,
    render: () => (
      <button type="button" className="tool tool--icon" onClick={resetCamera} title={resetTitle} aria-label="重置攝影機">
        <Icon icon={Video} size="md" />
      </button>
    ),
    menu: { icon: Video, label: '重置攝影機', hint: resetTitle, onSelect: resetCamera },
  });
  // 只看模式（動畫師、分享連結）：專案上擺了樂手和器材才放比例尺，讓看的人也看得到（只能看，不能改）
  if (viewer && showScaleButton && stageProps.length > 0) tools.push(scaleTool);
  if (viewer && bookmarkScope) tools.push(viewsTool);
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
    if (bookmarkScope) tools.push(viewsTool);
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
          {ndiPillIcon(ndiGuideState)} {ndiPaused ? 'AE 已暫停' : ndiShortLabel(ndiGuideState)}
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
  // 四個下載（對位圖 / AE 合成腳本 / 位置表 CSV / JSON）：這首歌用了版型 → 版型的在前、整張畫布的在後；沒有版型 → 跟以前一樣
  const songTplScope: LedDownloadScope | null = ledSongTemplate && projectCanvasRef.current
    ? (ledSongTemplate.timeline ? { template: '版型時間線', timeline: true } : { template: ledSongTemplate.plan.name })
    : null;
  const dlIcons = { png: ImageDown, jsx: FileCode, csv: FileSpreadsheet, json: FileBraces } as const;
  const dlItem = (kind: LedDownloadKind, scope: LedDownloadScope): ToolMenuEntry => {
    const tpl = typeof scope === 'object';
    const busyText = kind === 'png' ? '正在畫對位圖…' : kind === 'jsx' ? '正在做 AE 合成腳本…' : null;
    return {
      icon: dlIcons[kind],
      label: busyText && ledMapBusy === (tpl ? `tpl-${kind}` : kind) ? busyText : ledMapMenuLabel(kind, scope),
      disabled: (kind === 'png' || kind === 'jsx') && !!ledMapBusy,
      hint: ledMapMenuHint(kind, scope),
      onSelect: () => { void (tpl ? downloadSongTemplate(kind) : downloadLedMap(kind)); },
    };
  };
  const dlKinds: LedDownloadKind[] = ['png', 'jsx', 'csv', 'json'];
  const downloadItems: ToolMenuEntry[] = songTplScope
    ? [...dlKinds.map(k => dlItem(k, songTplScope)), ...dlKinds.map(k => dlItem(k, 'full'))]
    : dlKinds.map(k => dlItem(k, 'plain'));
  const ledSections: ToolMenuSection[] = ledMapMenu ? [{
    id: 'ledmap',
    title: 'LED 對位圖',
    items: [
      ...(hideDownloads ? [] : downloadItems),
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
        {songTplScope && ledSongTemplate && (ledSongTemplate.timeline
          ? <><br />這首歌中途換版型：{timelineSummary(ledSongTemplate.timeline)}（{ledSongTemplate.plan.canvas.width} × {ledSongTemplate.plan.canvas.height}）</>
          : <><br />這首歌用的版型：{ledSongTemplate.plan.name}（{ledSongTemplate.plan.canvas.width} × {ledSongTemplate.plan.canvas.height}）</>)}
      </>
    ),
  }] : [];
  // AE 即時：顏色校正
  const aeLiveSections: ToolMenuSection[] = enableNdi ? [{
    id: 'aelive',
    title: 'AE 即時',
    items: [{
      icon: Palette,
      label: '校正 AE 即時顏色…',
      hint: 'AE 經過 NDI 送過來的顏色會偏一點：放校正圖到 AE、量一次，這台電腦之後都照它校正',
      onSelect: () => setNdiColorOpen(true),
    }],
  }] : [];
  // 「說明」：新分頁打開使用說明（分享頁給客戶用）
  const baseSections = [...ledSections, ...aeLiveSections];
  const menuSections: ToolMenuSection[] = helpHref ? [...baseSections, {
    id: 'help',
    title: '使用說明',
    items: [{ icon: CircleHelp, label: '說明', hint: '說明', onSelect: () => { window.open(helpHref, '_blank', 'noopener'); } }],
  }] : baseSections;

  return (
    <div
      className={'stage-scene' + (show.active ? ' is-show' + (show.barVisible ? '' : ' is-bar-hidden') : '')}
      ref={containerRef}
    >
      <StageToolbar
        tools={tools}
        sections={menuSections}
        className={viewer ? 'is-viewer' : undefined}
        menuOpen={moreMenuOpen}
        onMenuOpenChange={setMoreMenuOpen}
        menuHeader={(hidden) => (hidden.has('cue') && cueName ? <>當前 cue：<strong>{cueName}</strong></> : null)}
      >
        {scalePanelOpen && showScaleRef && (
          <ScalePropsPanel
            figures={scaleParts.figures}
            grid={scaleParts.grid}
            props={scaleParts.props}
            onToggle={(part: ScalePart, on: boolean) => setScaleParts(s => ({ ...s, [part]: on }))}
            count={stageProps.length}
            canEdit={canEditProps}
            selectedLabel={selectedProp ? stagePropSpec(selectedProp.type).label : null}
            onAdd={(t) => propsHostRef.current?.add(t)}
            onRotate={rotateSelectedProp}
            onDelete={deleteSelectedProp}
            undoDepth={stagePropsHistory?.undoDepth ?? 0}
            onUndo={stagePropsHistory?.undo}
            onClear={stagePropsHistory?.clear}
            counts={{ all: stageProps.length, person: countInScope(stageProps, 'person'), gear: countInScope(stageProps, 'gear') }}
            onClose={() => setScalePanelOpen(false)}
            onTurnOff={() => setShowScaleRef(false)}
          />
        )}
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
        {bookmarkPanelOpen && bookmarkScope && (
          <CameraBookmarkPanel
            presets={CAMERA_PRESETS}
            bookmarks={cameraBookmarks}
            onFlyPreset={(id) => {
              const v = computePresetViewHelper(id);
              if (v) flyCamera(v.position, v.target, DEFAULT_FOV);
            }}
            onFlyBookmark={loadBookmark}
            getCurrentView={() => {
              const v = currentCameraView();
              return v ? { position: v.position.map(round) as [number, number, number], target: v.target.map(round) as [number, number, number], fov: round(v.fov) } : null;
            }}
            onChange={onCameraBookmarksChange}
            onClose={() => setBookmarkPanelOpen(false)}
          />
        )}
        {enableNdi && ndiPopoverOpen && (
          <div className="ndi-popover" onClick={e => e.stopPropagation()}>
            <div className="ndi-popover__head">
              AE 即時（NDI 小程序）
              <button className="ndi-popover__close" onClick={() => setNdiPopoverOpen(false)} title="關閉" aria-label="關閉"><Icon icon={X} /></button>
            </div>
            <div className="ndi-popover__body">
              <button
                type="button"
                className={'btn btn--sm ' + (ndiPaused ? 'btn--primary' : 'btn--ghost')}
                onClick={toggleNdiPaused}
                title={ndiPaused ? '恢復顯示 AE 送來的畫面' : '先不顯示 AE 的畫面，LED 回到對位圖（連線不會斷，按一下就恢復）'}
              >
                {ndiPaused ? '恢復 AE 即時' : '暫停 AE 即時（LED 顯示對位圖）'}
              </button>
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
              {ndiGuideState.helperVersion && (
                <div className="ndi-popover__color">
                  <span>顏色：{colorCurveLabel(ndiGuideState.colorPipeline, ndiGuideState.sourceIsAe, ndiCalibration)}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => { setNdiPopoverOpen(false); setNdiColorOpen(true); }}
                  ><Icon icon={Palette} /> 校正 AE 即時顏色</button>
                </div>
              )}
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
      {enableNdi && (
        <NdiColorCalibrationDialog
          open={ndiColorOpen}
          onClose={() => setNdiColorOpen(false)}
          pipeline={ndiGuideState.colorPipeline}
          helperConnected={!!ndiGuideState.helperVersion}
          sourceIsAe={ndiGuideState.sourceIsAe}
          source={ndiGuideState.source}
          getFrame={grabLiveFrame}
          ndiUrl={ndiUrl}
        />
      )}
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
      {/* 浮水印（頁面有登記才畫；DOM 一層，不進 LED 貼圖，不影響顏色）。全螢幕預演也要留著（StageShow.css） */}
      <WatermarkOverlay />
      {/* 自動調低畫質時的小提示（不擋操作） */}
      {qualityLevel !== 'high' && (
        <div className="stage-scene__quality-note">畫質自動調低以保持順暢</div>
      )}
      {/* 全螢幕預演的小條（滑鼠一動出現 2.5 秒） */}
      {stageShow && show.active && (
        <StageShowBar visible={show.barVisible} info={stageShow} fallbackTitle={cueName ?? projectName} views={showViews} onHold={show.holdBar} onExit={show.exit} />
      )}
      {/* 選到哪個物件：名字寫在左下角（只有手把看不出選到誰） */}
      {!readOnly && selectedObjectIds.length > 0 && (
        <div className={'stage-scene__selected' + (qualityLevel !== 'high' ? ' stage-scene__selected--raised' : '')} aria-live="polite">
          已選：{selectedObjectIds.length === 1
            ? (() => { const o = (stageObjects || []).find(x => x.id === selectedObjectIds[0]); return o ? (o.displayName || o.meshName) : '1 個物件'; })()
            : `${selectedObjectIds.length} 個物件`}
          <span className="stage-scene__selected-hint">Esc 取消</span>
        </div>
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
