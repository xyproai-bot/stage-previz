import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js';
import type { CueState, Vec3, Euler, StageObject } from '../lib/api';
import { computeScaleFactor, findBestScope } from '../lib/parseGlb';
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
}

type RenderMode = 'quick' | 'realistic';

type Mode = 'translate' | 'rotate' | 'scale';

export default function StageScene({ states, stageObjects, selectedObjectIds, onSelect, onTransform, cueName, modelUrl }: Props) {
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
  // 多選共動的 pivot（虛擬中心點，gizmo attach 在它身上；mesh 暫時 reparent 進 pivot）
  const multiPivotRef = useRef<THREE.Object3D | null>(null);

  const [mode, setMode] = useState<Mode>('translate');
  const [space, setSpace] = useState<'world' | 'local'>('world');
  const [showLabels, setShowLabels] = useState(true);
  const [renderMode, setRenderMode] = useState<RenderMode>('quick');
  const [, setModelLoading] = useState(false);
  // bump 用：dragging-changed end 後讓 attach pivot 的 effect 重跑
  const [pivotVersion, setPivotVersion] = useState(0);

  // 把 stageObjects 用 id 索引，給 mesh sync 拿 materialProps/ledProps
  const stageObjMap = new Map<string, StageObject>();
  (stageObjects || []).forEach(o => stageObjMap.set(o.id, o));
  const ledLightsRef = useRef<Map<string, THREE.RectAreaLight>>(new Map());
  // LED emissive 貼圖快取（imageUrl → Texture），避免每次 effect 重 load
  const ledTextureCacheRef = useRef<Map<string, THREE.Texture>>(new Map());
  const envLightsRef = useRef<{ ambient: THREE.AmbientLight; hemi: THREE.HemisphereLight; key: THREE.DirectionalLight | null } | null>(null);

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

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

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

    // Render loop
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      orbit.update();
      renderer.render(scene, camera);
      // update HTML labels（layer.style 控制全體顯隱，個別 label 仍會被 updateLabels 算位置）
      updateLabels(labelsRef.current, meshesRef.current, camera, container);
      requestAnimationFrame(tick);
    };
    tick();

    // Resize
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    return () => {
      stopped = true;
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      try { scene.remove(transformHelper); } catch {}
      try { transform.detach(); } catch {}
      try { transform.dispose(); } catch (e) { console.warn('TransformControls dispose:', e); }
      try { orbit.dispose(); } catch {}
      try { renderer.dispose(); } catch {}
      try { container.removeChild(renderer.domElement); } catch {}
      const layer = labelLayerRef.current;
      if (layer) try { container.removeChild(layer); } catch {}
      labelLayerRef.current = null;  // strict mode 双跑時別 leak 到舊 detached DOM
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
      // 如果 mesh 被 reparent 進 multiPivot，要把 world coord 換成 local
      if (obj.parent && obj.parent !== scene) {
        const wp = new THREE.Vector3(p.x, p.y, p.z);
        obj.parent.updateMatrixWorld();
        obj.parent.worldToLocal(wp);
        obj.position.copy(wp);
        const parentQuat = new THREE.Quaternion();
        obj.parent.getWorldQuaternion(parentQuat);
        obj.quaternion.copy(parentQuat.invert().multiply(worldQuat));
      } else {
        obj.position.set(p.x, p.y, p.z);
        obj.quaternion.copy(worldQuat);
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
  }, [selectedObjectIds, states.length, pivotVersion]);

  // ── Mode / space ──
  useEffect(() => { transformRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { transformRef.current?.setSpace(space); }, [space]);

  // ── Label visibility ──
  useEffect(() => {
    const layer = labelLayerRef.current;
    if (layer) layer.style.display = showLabels ? '' : 'none';
  }, [showLabels]);

  // ── Render mode (quick / realistic) ──
  useEffect(() => {
    const env = envLightsRef.current;
    if (!env) return;
    if (renderMode === 'realistic') {
      env.ambient.intensity = 0.15;   // 降下來讓 LED 主導
      env.hemi.intensity = 0.2;
      if (env.key) env.key.intensity = 0.3;
    } else {
      env.ambient.intensity = 0.55;
      env.hemi.intensity = 0.3;
      if (env.key) env.key.intensity = 0.7;
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
      const isRealistic = renderMode === 'realistic';
      const mat = so?.materialProps || {};
      const ledTint = so?.ledProps?.tint ? new THREE.Color(so.ledProps.tint) : new THREE.Color(0xffffff);
      const ledBrightness = so?.ledProps?.brightness ?? 1.0;

      // LED 貼圖（only realistic mode）
      const ledImageUrl = (isLed && isRealistic && so?.ledProps?.imageUrl) || null;
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
      }

      obj.traverse((c) => {
        if (!(c as THREE.Mesh).isMesh) return;
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!m || !('color' in m)) return;

        if (isLed && isRealistic) {
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
          const baseColor = mat.color || (CATEGORY_COLORS[so?.category || 'other'] !== undefined
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

      // 3. LED RectAreaLight
      let light = ledLights.get(id);
      if (renderMode === 'realistic' && isLed && so) {
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
  }, [stageObjects, renderMode, states, selectedObjectIds]);

  void RectAreaLightHelper; // keep import in case we want helper toggle later

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'w' || e.key === 'W') setMode('translate');
      else if (e.key === 'e' || e.key === 'E') setMode('rotate');
      else if (e.key === 'r' || e.key === 'R') setMode('scale');
      else if (e.key === 'q' || e.key === 'Q') setSpace(s => s === 'world' ? 'local' : 'world');
      else if (e.key === 'l' || e.key === 'L') setShowLabels(s => !s);
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

  return (
    <div className="stage-scene" ref={containerRef}>
      <div className="stage-scene__toolbar">
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
        <button
          className={'tool ' + (renderMode === 'realistic' ? 'is-active' : '')}
          onClick={() => setRenderMode(m => m === 'quick' ? 'realistic' : 'quick')}
          title={renderMode === 'realistic' ? '切回 Quick（純色）' : '切到 Realistic（LED 發光照明）'}
        >{renderMode === 'realistic' ? '🎬 Realistic' : '⚡ Quick'}</button>
        <button
          className={'tool ' + (showLabels ? 'is-active' : '')}
          onClick={() => setShowLabels(s => !s)}
          title={showLabels ? '隱藏物件名稱 label (L)' : '顯示物件名稱 label (L)'}
        >🏷️ Label</button>
        <button className="tool" onClick={resetCamera} title="重置攝影機">🎥</button>
        <span className="grow" />
        {cueName && <span className="cue-tag">當前 cue：<strong>{cueName}</strong></span>}
      </div>
      {/* Help overlay */}
      <div className="stage-scene__help">
        <kbd>W</kbd> 移動 · <kbd>E</kbd> 旋轉 · <kbd>R</kbd> 縮放 · <kbd>Q</kbd> world/local · <kbd>L</kbd> label · <kbd>Esc</kbd> 取消選取
      </div>
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
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
