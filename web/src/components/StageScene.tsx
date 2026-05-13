import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import type { CueState, Vec3, Euler, StageObject } from '../lib/api';
import { computeScaleFactor, findBestScope } from '../lib/parseGlb';
import { NdiClient, type NdiClientStatus } from '../lib/ndiClient';
import './StageScene.css';

// RectAreaLight 必須先 init uniforms（Three.js 內建）
RectAreaLightUniformsLib.init();

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
  /** 唯讀模式：不顯示移動/旋轉/縮放工具，不啟用 transform gizmo（給動畫師/導演 view） */
  readOnly?: boolean;
  /** 預設 render mode（quick / realistic / cinematic） */
  defaultRenderMode?: RenderMode;
  /** NDI helper 連線：true 時連 ws://127.0.0.1:7777 把 frames 餵給 LED 面板 */
  enableNdi?: boolean;
  /** NDI helper URL（預設 ws://127.0.0.1:7777） */
  ndiUrl?: string;
  /** NDI 連線狀態回呼（給 UI 顯示「連線中 / 已連 / 錯誤」） */
  onNdiStatus?: (status: NdiClientStatus) => void;
  /** Cue 切換時的 crossfade 秒數（0 = 硬切，>0 = 平滑插值） */
  crossfadeSeconds?: number;
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
}

type RenderMode = 'quick' | 'realistic' | 'cinematic';

type Mode = 'translate' | 'rotate' | 'scale';

export default function StageScene({ states, stageObjects, selectedObjectIds, onSelect, onTransform, cueName, modelUrl, readOnly = false, defaultRenderMode, enableNdi = false, ndiUrl, onNdiStatus, crossfadeSeconds = 0, snapshotApiRef, comments, onCommentPinClick, onAddAnchoredComment, bookmarkScope }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
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
  // 多選共動的 pivot（虛擬中心點，gizmo attach 在它身上；mesh 暫時 reparent 進 pivot）
  const multiPivotRef = useRef<THREE.Object3D | null>(null);

  const [mode, setMode] = useState<Mode>('translate');
  const [space, setSpace] = useState<'world' | 'local'>('world');
  const [showLabels, setShowLabels] = useState(true);
  const [renderMode, setRenderMode] = useState<RenderMode>(defaultRenderMode || 'quick');
  const [, setModelLoading] = useState(false);
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
  const crossfadeRef = useRef(crossfadeSeconds);
  crossfadeRef.current = crossfadeSeconds;
  const ledLightsRef = useRef<Map<string, THREE.RectAreaLight>>(new Map());
  // LED emissive 貼圖快取（imageUrl → Texture），避免每次 effect 重 load
  const ledTextureCacheRef = useRef<Map<string, THREE.Texture>>(new Map());
  const envLightsRef = useRef<{ ambient: THREE.AmbientLight; hemi: THREE.HemisphereLight; key: THREE.DirectionalLight | null } | null>(null);

  // ── Material Phase C ──
  // HDR IBL：Cinematic 模式時把 RoomEnvironment 烘成 PMREM cubemap，當作 scene.environment
  const envRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  // PostFX：EffectComposer + UnrealBloomPass（cinematic 模式啟用）
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  // NDI mock：當 LED 在 realistic/cinematic 模式且沒有 imageUrl，
  // 套一張動態 procedural canvas 貼圖當作「即將接 NDI」的預覽
  const ndiMockTextureRef = useRef<{ texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);
  // NDI 真連線：connect 後拿到 frames 就 update CanvasTexture（替代 mock）
  const ndiLiveTextureRef = useRef<{ texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);
  const ndiClientRef = useRef<NdiClient | null>(null);
  const [ndiActive, setNdiActive] = useState(false);  // 有真 frames 進來嗎
  const [ndiStatus, setNdiStatus] = useState<NdiClientStatus>({ kind: 'idle' });
  const [ndiPopoverOpen, setNdiPopoverOpen] = useState(false);
  const [ndiSources, setNdiSources] = useState<string[]>([]);
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

  // Wireframe / X-ray 模式（debug 看穿模型結構）
  const [wireframe, setWireframe] = useState(false);

  // 測距工具：點兩個點 → 畫線 + 距離（m）
  const [measureMode, setMeasureMode] = useState(false);
  const measureModeRef = useRef(false);
  measureModeRef.current = measureMode;
  const measurePointsRef = useRef<THREE.Vector3[]>([]);
  const measureLineRef = useRef<THREE.Line | null>(null);
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);

  // Walk mode（FPV / WASD）
  const [walkMode, setWalkMode] = useState(false);
  const walkKeysRef = useRef<{ [k: string]: boolean }>({});
  const walkPointerLockRef = useRef(false);
  // Persist to localStorage
  useEffect(() => {
    if (!bookmarkScope) return;
    try { localStorage.setItem('sp_camera_bookmarks:' + bookmarkScope, JSON.stringify(bookmarks)); } catch {}
  }, [bookmarks, bookmarkScope]);

  function saveCurrentCamera() {
    const cam = cameraRef.current;
    const orb = orbitRef.current;
    if (!cam || !orb) return;
    const name = (window.prompt('視角名稱：', `視角 ${bookmarks.length + 1}`) || '').trim();
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
    const cam = cameraRef.current;
    const orb = orbitRef.current;
    if (!cam || !orb) return;
    // 平滑飛行 0.6 秒
    const fromPos = cam.position.clone();
    const toPos = new THREE.Vector3(...bm.pos);
    const fromTarget = orb.target.clone();
    const toTarget = new THREE.Vector3(...bm.target);
    const fromFov = cam.fov;
    const toFov = bm.fov;
    const startTs = performance.now();
    const dur = 600;
    const stepCam = cam;
    const stepOrb = orb;
    function step() {
      const t = Math.min((performance.now() - startTs) / dur, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      stepCam.position.lerpVectors(fromPos, toPos, e);
      stepOrb.target.lerpVectors(fromTarget, toTarget, e);
      stepCam.fov = fromFov + (toFov - fromFov) * e;
      stepCam.updateProjectionMatrix();
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
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

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    camera.position.set(8, 6, 10);
    camera.lookAt(0, 1, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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

    // VR Button — 只在瀏覽器支援時顯示（Quest browser、Edge with WebXR enabled、PCVR + Steam）
    let vrBtn: HTMLElement | null = null;
    try {
      vrBtn = VRButton.createButton(renderer);
      vrBtn.classList.add('stage-scene__vr-btn');
      container.appendChild(vrBtn);
    } catch (e) {
      console.warn('[StageScene] VRButton failed (no WebXR support?):', e);
    }

    // ── Material Phase C：HDR IBL ──
    // RoomEnvironment 是 three.js 內建的「攝影棚式環境」程序貼圖，
    // 用 PMREMGenerator 烘成 cubemap 後當 scene.environment 給 PBR 反射 / 真實打光
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      const envRT = pmrem.fromScene(envScene, 0.04);
      envRTRef.current = envRT;
      pmrem.dispose();
      // 預設 quick 模式不掛 environment（避免太亮反射），切到 realistic/cinematic 時才掛
    } catch (e) {
      console.warn('[StageScene] PMREM init failed:', e);
    }

    // ── EffectComposer（給 cinematic 模式 bloom 用） ──
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

    // ── Lock pin layer（鎖住的物件永遠顯示 🔒，不受 L 切換影響）──
    {
      const layer = document.createElement('div');
      layer.className = 'stage-scene__lock-pins';
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

    // ── NDI mock texture（procedural animated canvas）──
    // 當 LED 沒設 imageUrl 且不是 quick 模式 → 套這張動態貼圖當「NDI 即將接上」預覽
    try {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const cctx = c.getContext('2d');
      if (cctx) {
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        ndiMockTextureRef.current = { texture: tex, canvas: c, ctx: cctx };
      }
    } catch (e) {
      console.warn('[StageScene] NDI mock canvas init failed:', e);
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

    // Orbit
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;
    orbit.target.set(0, 1, 0);
    orbitRef.current = orbit;

    // Transform gizmo (Three.js r169+ : TransformControls 不是 Object3D，要用 getHelper)
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSize(0.9);

    // hover 在 gizmo 軸上時就先 disable orbit（不然 orbit 先抓走滑鼠 → camera 跟著轉）
    transform.addEventListener('axis-changed', (event: any) => {
      orbit.enabled = (event.value === null);
    });

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
            const euler = new THREE.Euler().setFromQuaternion(wquat, 'XYZ');
            const id = m.userData.objectId as string | undefined;
            scene.attach(m); // 拿回 scene（保留 world matrix）
            if (id) {
              onTransformRef.current(id,
                { x: round(wpos.x), y: round(wpos.y), z: round(wpos.z) },
                { pitch: round(THREE.MathUtils.radToDeg(euler.x)),
                  yaw:   round(THREE.MathUtils.radToDeg(euler.y)),
                  roll:  round(THREE.MathUtils.radToDeg(euler.z)) });
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
          const pos = { x: round(obj.position.x), y: round(obj.position.y), z: round(obj.position.z) };
          const rot = {
            pitch: round(THREE.MathUtils.radToDeg(obj.rotation.x)),
            yaw:   round(THREE.MathUtils.radToDeg(obj.rotation.y)),
            roll:  round(THREE.MathUtils.radToDeg(obj.rotation.z)),
          };
          onTransformRef.current(id, pos, rot);
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

    // Render loop（用 setAnimationLoop 而非 rAF — 才能支援 WebXR）
    let stopped = false;
    let frameStart = performance.now();
    let lastTickTs = performance.now();
    const tick = () => {
      if (stopped) return;
      const nowTs = performance.now();
      const deltaSec = Math.min((nowTs - lastTickTs) / 1000, 0.1);
      lastTickTs = nowTs;

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

      // Crossfade tweens（每幀更新進行中的 mesh transform 插值）
      const tweens = tweensRef.current;
      if (tweens.size > 0) {
        const now = performance.now();
        const meshes = meshesRef.current;
        const finished: string[] = [];
        for (const [id, tw] of tweens) {
          const mesh = meshes.get(id);
          if (!mesh) { finished.push(id); continue; }
          const t = Math.min((now - tw.startTs) / tw.durationMs, 1);
          // ease-in-out cubic（給 cue 切換的「重」感覺）
          const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          mesh.position.lerpVectors(tw.fromPos, tw.toPos, e);
          mesh.quaternion.slerpQuaternions(tw.fromQuat, tw.toQuat, e);
          if (t >= 1) finished.push(id);
        }
        for (const id of finished) tweens.delete(id);
      }

      // Animate NDI mock texture (cheap procedural — only updates when realistic/cinematic)
      const ndiMock = ndiMockTextureRef.current;
      const rmode = renderModeRef.current;
      if (ndiMock && rmode !== 'quick') {
        const t = (performance.now() - frameStart) * 0.001;
        drawNdiMock(ndiMock.ctx, ndiMock.canvas, t);
        ndiMock.texture.needsUpdate = true;
      }

      // VR 模式時 EffectComposer 不能用（需要單一 framebuffer）→ 強制直接 render
      const inXR = renderer.xr.isPresenting;
      if (rmode === 'cinematic' && composerRef.current && !inXR) {
        composerRef.current.render();
      } else {
        renderer.render(scene, camera);
      }

      // update HTML labels（layer.style 控制全體顯隱，個別 label 仍會被 updateLabels 算位置）
      if (!inXR) updateLabels(labelsRef.current, meshesRef.current, camera, container);
      // 鎖頭 pin（永遠顯示）
      if (!inXR) updateLockPins(lockPinLayerRef.current, statesRef.current || [], meshesRef.current, camera, container);

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
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // composer 也要同步尺寸
      composerRef.current?.setSize(w, h);
      bloomPassRef.current?.setSize(w, h);
    });
    ro.observe(container);

    return () => {
      stopped = true;
      ro.disconnect();
      try { renderer.setAnimationLoop(null); } catch {}
      if (vrBtn) try { container.removeChild(vrBtn); } catch {}
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      try { scene.remove(transformHelper); } catch {}
      try { transform.detach(); } catch {}
      try { transform.dispose(); } catch (e) { console.warn('TransformControls dispose:', e); }
      try { orbit.dispose(); } catch {}
      // Material Phase C cleanup
      try { envRTRef.current?.dispose(); } catch {}
      envRTRef.current = null;
      try { composerRef.current?.dispose(); } catch {}
      composerRef.current = null;
      bloomPassRef.current = null;
      try { ndiMockTextureRef.current?.texture.dispose(); } catch {}
      ndiMockTextureRef.current = null;
      try { ndiLiveTextureRef.current?.texture.dispose(); } catch {}
      ndiLiveTextureRef.current = null;
      try { ndiClientRef.current?.destroy(); } catch {}
      ndiClientRef.current = null;
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

  // ── Load .glb model (if any) → build mesh_name map ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !modelUrl) {
      modelMeshMapRef.current.clear();
      return;
    }

    let cancelled = false;
    setModelLoading(true);
    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
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
        const finalBox = new THREE.Box3();
        gltf.scene.children.forEach(c => finalBox.expandByObject(c));
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
          const fitDist = (finalDiag * 0.6) / Math.tan((cam.fov * Math.PI) / 360);
          const dir = new THREE.Vector3(1, 0.6, 1).normalize();
          cam.position.copy(finalCenter).addScaledVector(dir, fitDist);
          orb.target.copy(finalCenter);
          cam.near = Math.max(0.01, finalDiag / 1000);
          cam.far  = Math.max(200, finalDiag * 10);
          cam.updateProjectionMatrix();
        }

        // 觸發 mesh 重建
        meshesRef.current.forEach((m) => {
          scene.remove(m);
          disposeObject3D(m);
        });
        meshesRef.current.clear();
        setModelLoading(false);
      },
      undefined,
      (err) => {
        if (cancelled) return;
        console.error('GLTF load failed:', err);
        setModelLoading(false);
      }
    );

    return () => { cancelled = true; };
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

    const currentIds = new Set(states.map(s => s.objectId));

    // Remove gone
    for (const [id, obj] of meshes) {
      if (!currentIds.has(id)) {
        scene.remove(obj);
        disposeObject3D(obj);
        meshes.delete(id);
        const lbl = labels.get(id);
        if (lbl) { layer.removeChild(lbl); labels.delete(id); }
      }
    }

    // Add / update
    for (const s of states) {
      let obj = meshes.get(s.objectId);
      if (!obj) {
        // 優先：從 GLB 模型 clone 對應 mesh_name 的物件；沒有 → 用 primitive
        const fromModel = modelMeshMapRef.current.get(s.meshName);
        if (fromModel) {
          obj = fromModel.clone(true);
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
        lbl.textContent = (s.locked ? '🔒 ' : '') + s.displayName;
        lbl.dataset.objectId = s.objectId;
        layer.appendChild(lbl);
        labels.set(s.objectId, lbl);
      } else {
        const lbl = labels.get(s.objectId);
        if (lbl) {
          const lblText = (s.locked ? '🔒 ' : '') + s.displayName;
          if (lbl.textContent !== lblText) lbl.textContent = lblText;
        }
      }
      obj.userData.locked = !!s.locked;
      obj.userData.objectId = s.objectId;

      const p = s.effective.position;
      const r = s.effective.rotation;
      const worldQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(r.pitch),
        THREE.MathUtils.degToRad(r.yaw),
        THREE.MathUtils.degToRad(r.roll),
      ));
      // Crossfade：如果開了，從 mesh 當前 transform tween 到目標
      // 前提：mesh 不在 multiPivot 下（pivot 模式表示用戶正在拖，不該 tween）
      const xfade = crossfadeRef.current;
      const inPivot = obj.parent && obj.parent !== scene;
      if (xfade > 0 && !inPivot && (obj.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z)) > 0.001 || !obj.quaternion.equals(worldQuat))) {
        tweensRef.current.set(s.objectId, {
          fromPos: obj.position.clone(),
          toPos: new THREE.Vector3(p.x, p.y, p.z),
          fromQuat: obj.quaternion.clone(),
          toQuat: worldQuat.clone(),
          startTs: performance.now(),
          durationMs: xfade * 1000,
        });
      } else {
        // 沒 crossfade：直接套（保留原本邏輯）
        if (inPivot) {
          const wp = new THREE.Vector3(p.x, p.y, p.z);
          obj.parent!.updateMatrixWorld();
          obj.parent!.worldToLocal(wp);
          obj.position.copy(wp);
          const parentQuat = new THREE.Quaternion();
          obj.parent!.getWorldQuaternion(parentQuat);
          obj.quaternion.copy(parentQuat.invert().multiply(worldQuat));
        } else {
          obj.position.set(p.x, p.y, p.z);
          obj.quaternion.copy(worldQuat);
        }
        // 跳過 tween → 確保 tweensRef 沒留 stale
        tweensRef.current.delete(s.objectId);
      }
      obj.visible = s.effective.visible;

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
  }, [states, selectedObjectIds]);

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
  }, [selectedObjectIds, states.length, pivotVersion, readOnly]);

  // ── Mode / space ──
  useEffect(() => { transformRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { transformRef.current?.setSpace(space); }, [space]);

  // ── Label visibility ──
  useEffect(() => {
    const layer = labelLayerRef.current;
    if (layer) layer.style.display = showLabels ? '' : 'none';
  }, [showLabels]);

  // ── NDI client（連 ndi-helper.exe）──
  useEffect(() => {
    if (!enableNdi) {
      // 斷線
      try { ndiClientRef.current?.destroy(); } catch {}
      ndiClientRef.current = null;
      setNdiActive(false);
      return;
    }
    const liveTex = ndiLiveTextureRef.current;
    if (!liveTex) return;

    const client = new NdiClient({
      url: ndiUrl,
      onFrame: (bitmap) => {
        // Adjust canvas size if first frame or size changed
        if (liveTex.canvas.width !== bitmap.width || liveTex.canvas.height !== bitmap.height) {
          liveTex.canvas.width = bitmap.width;
          liveTex.canvas.height = bitmap.height;
        }
        liveTex.ctx.drawImage(bitmap, 0, 0);
        liveTex.texture.needsUpdate = true;
        bitmap.close?.();
        if (!ndiActive) setNdiActive(true);
      },
      onStatus: (s) => {
        if (s.kind !== 'connected' && ndiActive) setNdiActive(false);
        setNdiStatus(s);
        onNdiStatus?.(s);
      },
      onSources: (list) => setNdiSources(list),
      reconnectIntervalMs: 3000,
    });
    ndiClientRef.current = client;
    client.connect();

    return () => {
      try { client.destroy(); } catch {}
      ndiClientRef.current = null;
      setNdiActive(false);
    };
    // ndiActive intentionally excluded — 用它做 first-frame 判斷不重連
  }, [enableNdi, ndiUrl, onNdiStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render mode (quick / realistic / cinematic) ──
  useEffect(() => {
    const env = envLightsRef.current;
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!env || !scene) return;
    if (renderMode === 'cinematic') {
      // 最強：HDR IBL + bloom + LED 主導 + 暗環境
      env.ambient.intensity = 0.05;
      env.hemi.intensity = 0.1;
      if (env.key) env.key.intensity = 0.15;
      scene.environment = envRTRef.current?.texture || null;
      if (renderer) renderer.toneMappingExposure = 1.1;
    } else if (renderMode === 'realistic') {
      env.ambient.intensity = 0.15;
      env.hemi.intensity = 0.2;
      if (env.key) env.key.intensity = 0.3;
      // realistic 也掛 environment（PBR 反射），但比 cinematic 弱
      scene.environment = envRTRef.current?.texture || null;
      if (renderer) renderer.toneMappingExposure = 1.0;
    } else {
      env.ambient.intensity = 0.55;
      env.hemi.intensity = 0.3;
      if (env.key) env.key.intensity = 0.7;
      scene.environment = null;
      if (renderer) renderer.toneMappingExposure = 1.0;
    }
  }, [renderMode]);

  // ── Sync 材質 + LED lights + emissive（統一決策，不被其他 effect 覆蓋） ──
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const meshes = meshesRef.current;
    const ledLights = ledLightsRef.current;
    const accentGreen = new THREE.Color(0x10c78a);
    const black = new THREE.Color(0x000000);

    meshes.forEach((obj, id) => {
      const so = stageObjMap.get(id);
      const isSelected = selectedObjectIds.includes(id);
      const isLed = so?.category === 'led_panel';
      const isLit = renderMode !== 'quick'; // realistic + cinematic 都打 LED
      const mat = so?.materialProps || {};
      const ledTint = so?.ledProps?.tint ? new THREE.Color(so.ledProps.tint) : new THREE.Color(0xffffff);
      const ledBrightness = so?.ledProps?.brightness ?? 1.0;

      // LED 貼圖（realistic / cinematic）priority：
      //   1. user imageUrl（admin 在物件設定的）
      //   2. NDI 真連線（ndi-helper 推 frames 進來）
      //   3. NDI mock（程序動態貼圖，等 helper 連上前的預覽）
      const ledImageUrl = (isLed && isLit && so?.ledProps?.imageUrl) || null;
      let ledTexture: THREE.Texture | null = null;
      if (ledImageUrl) {
        const cache = ledTextureCacheRef.current;
        if (!cache.has(ledImageUrl)) {
          const loader = new THREE.TextureLoader();
          loader.setCrossOrigin('anonymous');
          const tex = loader.load(ledImageUrl, undefined, undefined, (err) => {
            console.warn('[StageScene] LED imageUrl load failed (CORS?):', ledImageUrl, err);
          });
          tex.colorSpace = THREE.SRGBColorSpace;
          cache.set(ledImageUrl, tex);
        }
        ledTexture = cache.get(ledImageUrl) || null;
      } else if (isLed && isLit && ndiActive && ndiLiveTextureRef.current) {
        // NDI 連上了 → 用真實 NDI frame texture
        ledTexture = ndiLiveTextureRef.current.texture;
      } else if (isLed && isLit && ndiMockTextureRef.current) {
        // 沒 NDI / 沒 imageUrl → mock 動態貼圖
        ledTexture = ndiMockTextureRef.current.texture;
      }

      obj.traverse((c) => {
        if (!(c as THREE.Mesh).isMesh) return;
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!m || !('color' in m)) return;

        // 雙面渲染：LED 永遠 FrontSide（emissive 不該從背面看到），其他物件 DoubleSide
        const targetSide = isLed ? THREE.FrontSide : THREE.DoubleSide;
        if (m.side !== targetSide) {
          m.side = targetSide;
          m.needsUpdate = true;
        }

        if (isLed && isLit) {
          // === LED in realistic mode ===
          // 物理：自發光、不反射、不被環境光打亮
          //   base color 黑 → 環境光 × 黑 = 黑（LED 不被打亮）
          //   metalness 0、roughness 1、envMapIntensity 0 → 沒鏡面 / 沒環境反射
          //   emissive(Map) 是 LED 唯一的亮度來源
          m.color.setHex(0x000000);
          m.metalness = 0;
          m.roughness = 1;
          m.envMapIntensity = 0;
          m.opacity = 1;
          m.transparent = false;

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
        } else {
          // === 一般物件 / Quick mode 的 LED ===
          // 套 user materialProps；emissive 只在 selected 時 highlight
          // 注意：有貼圖（GLB 原本的 texture）或是 LED 時，不要用 category 顏色蓋掉
          // 否則 LED 在 quick mode 會被染綠（品牌色 = 0x10c78a），喇叭等貼圖物件會被染對應色
          const hasTexture = !!m.map;
          const baseColor = mat.color
            ? mat.color
            : (hasTexture || isLed)
              ? '#ffffff'   // 有貼圖或 LED → 用白色當乘數，保留原貼圖顏色
              : (CATEGORY_COLORS[so?.category || 'other'] !== undefined
                ? `#${CATEGORY_COLORS[so?.category || 'other'].toString(16).padStart(6, '0')}`
                : '#cccccc');
          m.color.set(baseColor);
          m.metalness = typeof mat.metalness === 'number' ? mat.metalness : 0.1;
          m.roughness = typeof mat.roughness === 'number' ? mat.roughness : 0.6;
          m.envMapIntensity = 1;
          if (typeof mat.opacity === 'number') {
            m.opacity = mat.opacity;
            m.transparent = mat.opacity < 1;
          }
          if (m.emissiveMap) { m.emissiveMap = null; m.needsUpdate = true; }
          if (isSelected) {
            m.emissive.copy(accentGreen);
            m.emissiveIntensity = 0.4;
          } else {
            m.emissive.copy(black);
            m.emissiveIntensity = 0;
          }
        }
      });

      // 3. LED RectAreaLight（realistic / cinematic 都打）
      let light = ledLights.get(id);
      if (isLit && isLed && so) {
        const led = so.ledProps || {};
        const brightness = led.brightness ?? 1.0;
        const castStrength = led.castLightStrength ?? 1.0;

        if (!light) {
          const w = 2 * (so.defaultScale.x || 1);
          const h = 1.2 * (so.defaultScale.y || 1);
          light = new THREE.RectAreaLight(0xffffff, 1, w, h);
          scene.add(light);
          ledLights.set(id, light);
        }
        light.position.copy(obj.position);
        light.position.y += 0.05;
        light.lookAt(obj.position.x, obj.position.y - 1, obj.position.z + 0.5);
        light.color.copy(ledTint);
        light.intensity = brightness * castStrength * 5;
        light.visible = obj.visible;
      } else if (light) {
        scene.remove(light);
        ledLights.delete(id);
      }
    });

    for (const [id, light] of ledLights) {
      if (!meshes.has(id)) {
        scene.remove(light);
        ledLights.delete(id);
      }
    }
  }, [stageObjects, renderMode, states, selectedObjectIds, ndiActive]);

  void RectAreaLightHelper; // keep import in case we want helper toggle later

  // ── Wireframe sync（每次切換或新 mesh 進來都套）──
  useEffect(() => {
    const meshes = meshesRef.current;
    meshes.forEach((obj) => {
      obj.traverse((c) => {
        if (!(c as THREE.Mesh).isMesh) return;
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (m && 'wireframe' in m) m.wireframe = wireframe;
      });
    });
  }, [wireframe, states, stageObjects]);

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
      // 唯讀模式：保留 L / X，不啟用 W/E/R/Q/Esc
      if (readOnlyRef.current) {
        if (e.key === 'l' || e.key === 'L') setShowLabels(s => !s);
        else if (e.key === 'x' || e.key === 'X') setWireframe(w => !w);
        return;
      }
      if (e.key === 'w' || e.key === 'W') setMode('translate');
      else if (e.key === 'e' || e.key === 'E') setMode('rotate');
      else if (e.key === 'r' || e.key === 'R') setMode('scale');
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
    const cam = cameraRef.current;
    const orb = orbitRef.current;
    if (!cam || !orb) return;
    cam.position.set(8, 6, 10);
    orb.target.set(0, 1, 0);
    cam.updateProjectionMatrix();
  }, []);

  // 3-state render mode：quick → realistic → cinematic → quick
  const cycleRenderMode = useCallback(() => {
    setRenderMode(m => m === 'quick' ? 'realistic' : (m === 'realistic' ? 'cinematic' : 'quick'));
  }, []);
  const renderModeLabel = renderMode === 'cinematic' ? '✨ Cinematic'
    : renderMode === 'realistic' ? '🎬 Realistic'
    : '⚡ Quick';
  const renderModeNext = renderMode === 'cinematic' ? 'Quick'
    : renderMode === 'realistic' ? 'Cinematic（HDR + Bloom）'
    : 'Realistic（LED 發光）';

  return (
    <div className="stage-scene" ref={containerRef}>
      <div className="stage-scene__toolbar">
        {!readOnly && (
          <>
            <button
              className={'tool ' + (mode === 'translate' ? 'is-active' : '')}
              onClick={() => setMode('translate')}
              title="移動 (W)"
            >↔ 移動</button>
            <button
              className={'tool ' + (mode === 'rotate' ? 'is-active' : '')}
              onClick={() => setMode('rotate')}
              title="旋轉 (E)"
            >↻ 旋轉</button>
            <button
              className={'tool ' + (mode === 'scale' ? 'is-active' : '')}
              onClick={() => setMode('scale')}
              title="縮放 (R)"
            >⤢ 縮放</button>
            <span className="tool-sep" />
            <button
              className="tool"
              onClick={() => setSpace(s => s === 'world' ? 'local' : 'world')}
              title="切換 world / local 軸 (Q)"
            >{space === 'world' ? '🌐 World' : '📦 Local'}</button>
            <span className="tool-sep" />
          </>
        )}
        <button
          className={'tool ' + (renderMode !== 'quick' ? 'is-active' : '')}
          onClick={cycleRenderMode}
          title={`切到 ${renderModeNext}`}
        >{renderModeLabel}</button>
        <button
          className={'tool ' + (wireframe ? 'is-active' : '')}
          onClick={() => setWireframe(w => !w)}
          title={wireframe ? '切回實心 (X)' : 'Wireframe / X-ray 模式（看穿模型）(X)'}
        >🔳 Wire</button>
        <button
          className={'tool ' + (showLabels ? 'is-active' : '')}
          onClick={() => setShowLabels(s => !s)}
          title={showLabels ? '隱藏物件名稱 label (L)' : '顯示物件名稱 label (L)'}
        >🏷️ Label</button>
        <button className="tool" onClick={resetCamera} title="重置攝影機">🎥</button>
        <button
          className={'tool ' + (walkMode ? 'is-active' : '')}
          onClick={() => setWalkMode(m => !m)}
          title={walkMode ? '離開 Walk 模式（或按 Esc）' : 'Walk 模式 — WASD 走位、滑鼠看四周'}
        >🚶 Walk</button>
        {bookmarkScope && (
          <div className="bm-wrap">
            <button
              className={'tool ' + (bookmarkPanelOpen ? 'is-active' : '')}
              onClick={() => setBookmarkPanelOpen(o => !o)}
              title={`視角書籤（${bookmarks.length}）— 儲存 / 切換常用視角`}
            >📷 視角{bookmarks.length > 0 && <span className="muted small"> {bookmarks.length}</span>}</button>
            {bookmarkPanelOpen && (
              <div className="bm-popover" onClick={e => e.stopPropagation()}>
                <div className="bm-popover__head">
                  <span>視角書籤</span>
                  <button className="dlg__close" onClick={() => setBookmarkPanelOpen(false)}>×</button>
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
                        <button className="bm-row__del" onClick={() => deleteBookmark(bm.id)} title="刪除">×</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        {onAddAnchoredComment && (
          <button
            className={'tool ' + (addPinMode ? 'is-active' : '')}
            onClick={() => setAddPinMode(m => !m)}
            title={addPinMode ? '取消 3D 留言模式' : '在 3D 場景上某個位置 / 物件加留言'}
          >📍 3D 留言</button>
        )}
        <button
          className={'tool ' + (measureMode ? 'is-active' : '')}
          onClick={() => {
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
          }}
          title={measureMode ? '關閉測距' : '測距：點兩個點看距離（m）'}
        >📏 測距</button>
        <span className="grow" />
        {enableNdi && (
          <div className="ndi-wrap">
            <button
              className={'ndi-pill ' + (ndiActive ? 'ndi-pill--live' : 'ndi-pill--idle')}
              onClick={() => setNdiPopoverOpen(o => !o)}
              title="點擊看 NDI 連線詳情"
            >
              {ndiActive ? '● LIVE NDI' : '○ NDI 等待中'}
            </button>
            {ndiPopoverOpen && (
              <div className="ndi-popover" onClick={e => e.stopPropagation()}>
                <div className="ndi-popover__head">
                  NDI Helper 狀態
                  <button className="ndi-popover__close" onClick={() => setNdiPopoverOpen(false)}>×</button>
                </div>
                <div className="ndi-popover__body">
                  <NdiStatusRows status={ndiStatus} active={ndiActive} url={ndiUrl || 'ws://127.0.0.1:7777'} />
                  {ndiSources.length > 0 && ndiStatus.kind === 'connected' && (
                    <div className="ndi-popover__sources">
                      <div className="ndi-popover__sources-title">可用的 NDI 來源</div>
                      <ul>
                        {ndiSources.map(src => {
                          const isActive = ndiStatus.kind === 'connected' && ndiStatus.source === src;
                          return (
                            <li key={src}>
                              <button
                                className={'ndi-source-row' + (isActive ? ' is-active' : '')}
                                onClick={() => {
                                  ndiClientRef.current?.selectSource(src);
                                  setTimeout(() => ndiClientRef.current?.requestStatus(), 800);
                                }}
                                disabled={isActive}
                              >
                                {isActive ? '● ' : '○ '}{src}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="ndi-popover__actions">
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => { ndiClientRef.current?.disconnect(); ndiClientRef.current?.connect(); }}
                  >🔄 立即重連</button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => ndiClientRef.current?.requestStatus()}
                  >↻ 重掃 sources</button>
                  <a
                    className="btn btn--ghost btn--sm"
                    href="https://www.ndi.tv/tools/"
                    target="_blank"
                    rel="noreferrer"
                  >NDI Tools ↗</a>
                </div>
                {!ndiActive && (
                  <div className="ndi-popover__hint">
                    <strong>沒收到 frames？</strong>
                    <ol>
                      <li>動畫師端是否有跑 stage-previz-ndi-helper.exe？</li>
                      <li>AE 的 NDI Output 有開嗎？</li>
                      <li>helper 系統列圖示是否顯示綠點 + source 名稱？</li>
                    </ol>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {cueName && <span className="cue-tag">當前 cue：<strong>{cueName}</strong></span>}
      </div>
      {/* Measure result overlay */}
      {measureMode && (
        <div className="stage-scene__measure-overlay">
          <strong>📏 測距模式</strong>
          {measureDistance === null
            ? <span> · 點兩個點測距離（點地板或物件表面）</span>
            : <span> · <strong className="measure-dist">{measureDistance.toFixed(2)} m</strong>（再點下一點重開）</span>
          }
        </div>
      )}
      {/* Help overlay */}
      <div className="stage-scene__help">
        {readOnly
          ? <><kbd>L</kbd> label · 拖拉旋轉視角 · 滾輪縮放</>
          : <><kbd>W</kbd> 移動 · <kbd>E</kbd> 旋轉 · <kbd>R</kbd> 縮放 · <kbd>Q</kbd> world/local · <kbd>L</kbd> label · <kbd>Esc</kbd> 取消選取</>
        }
      </div>
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function NdiStatusRows({ status, active, url }: { status: NdiClientStatus; active: boolean; url: string }) {
  let stateLabel: string;
  let stateClass: string;
  switch (status.kind) {
    case 'idle':         stateLabel = '未啟用';   stateClass = 'idle'; break;
    case 'connecting':   stateLabel = '連線中…';  stateClass = 'connecting'; break;
    case 'connected':    stateLabel = active ? '已連線（接收中）' : '已連線（等首幀）'; stateClass = 'connected'; break;
    case 'disconnected': stateLabel = '已斷線（自動重試）'; stateClass = 'disconnected'; break;
    case 'error':        stateLabel = '錯誤'; stateClass = 'error'; break;
  }
  const helperVer = status.kind === 'connected' ? status.helperVersion : null;
  const source = status.kind === 'connected' ? status.source : null;
  const errMsg = status.kind === 'error' ? status.message : null;
  return (
    <table className="ndi-popover__table">
      <tbody>
        <tr><th>狀態</th><td><span className={'ndi-state ndi-state--' + stateClass}>{stateLabel}</span></td></tr>
        <tr><th>WebSocket</th><td><code>{url}</code></td></tr>
        {helperVer && <tr><th>Helper 版本</th><td>v{helperVer}</td></tr>}
        {source && <tr><th>NDI 來源</th><td>{source}</td></tr>}
        {errMsg && <tr><th>錯誤訊息</th><td className="ndi-state--error">{errMsg}</td></tr>}
      </tbody>
    </table>
  );
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const m = child as THREE.Mesh;
    if (m.geometry) m.geometry.dispose?.();
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mat) => mat.dispose?.());
    }
  });
}

// NDI mock：模擬即時影像的程序動態貼圖
// 真 NDI helper 接上後就直接換成 NDI 來源的 BGRA buffer，材質結構不變
function drawNdiMock(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement, t: number) {
  const w = c.width, h = c.height;
  // 漸層底（橫向移動）
  const g = ctx.createLinearGradient(0, 0, w, 0);
  const phase = (t * 0.15) % 1;
  g.addColorStop(0,                 hsl((phase * 360),       70, 35));
  g.addColorStop(0.5,               hsl(((phase + 0.33) * 360) % 360, 75, 45));
  g.addColorStop(1,                 hsl(((phase + 0.66) * 360) % 360, 70, 30));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 掃描線
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  const scanY = ((Math.sin(t * 1.7) * 0.5 + 0.5) * h) | 0;
  ctx.beginPath();
  ctx.moveTo(0, scanY);
  ctx.lineTo(w, scanY);
  ctx.stroke();
  // 中央文字提示
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 22px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('● LIVE PREVIEW', w / 2, h / 2 - 12);
  ctx.font = '12px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('NDI mock · 接上 helper.exe 後即實時內容', w / 2, h / 2 + 12);
}

function hsl(h: number, s: number, l: number) {
  return `hsl(${h.toFixed(0)}, ${s}%, ${l}%)`;
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
      pin.textContent = '🔒';
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
      pin.textContent = '💬';
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
