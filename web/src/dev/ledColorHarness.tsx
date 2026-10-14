// LED 顏色量測頁（開發用，web/led-color-harness.html）
//   真的 StageScene + 一個做出來的小舞台（LED 正面朝鏡頭、亮面地板、桁架、喇叭、一塊朝 LED 的白色 LED 給「反光」測試）。
//   LED 畫面走跟網站一模一樣的路：本地圖片（ledImage）、本地影片 / 網址影片（useLocalVideo 同一個 <video>）、
//   AE 即時（NDI：真的 NdiConnection + NdiClient，連到量測程式開的假小程序）、測試圖。
//   量測程式（web/scripts/led-color-accuracy.mjs）用 window.__ledHarness 控制、讀回畫面像素。
//   畫面文字不給一般使用者看，但一樣不用 emoji。

import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import StageScene from '../components/StageScene';
import type { CueState, StageObject, StageObjectCategory } from '../lib/api';
import type { HomeView } from '../lib/homeView';
import { parkVideo, useLocalVideo } from '../lib/localVideo';
import { DEFAULT_LOOK_SETTINGS, type LookSettings } from '../lib/stageLook/lookSettings';
import {
  CHART_HEIGHT, CHART_PATCHES, CHART_WIDTH, averageRgb, averageRgbLinear, drawChart, patchCenterUv, patchIndex, patchUvRect,
  simulateHelperFrame, type ChartPatch, type PatchGroup,
} from '../lib/stageLook/colorAccuracy';
import { aeRawChain } from '../lib/ndiColor';
import '../styles/global.css';

// ─── 小舞台（場景單位 = 公尺）───
const VIEW_W = 1280;
const VIEW_H = 800;
const LED_W = 10;
const LED_H = 5;
const LED_CY = 4;
const LED_TOP = LED_CY + LED_H / 2;
const LED_Z = 0;

interface ObjDef { id: string; name: string; category: StageObjectCategory }
const OBJECTS: ObjDef[] = [
  { id: 'o_led_main', name: 'LED_01_main', category: 'led_panel' },
  { id: 'o_led_aud', name: 'LED_02_audience', category: 'led_panel' },
  { id: 'o_floor', name: 'STAGE_00_floor', category: 'mechanism' },
  { id: 'o_truss_l', name: 'PROP_01_truss_L', category: 'fixture' },
  { id: 'o_truss_r', name: 'PROP_02_truss_R', category: 'fixture' },
  { id: 'o_truss_top', name: 'PROP_03_truss_top', category: 'fixture' },
  { id: 'o_spk_l', name: 'PROP_04_speaker_L', category: 'fixture' },
  { id: 'o_spk_r', name: 'PROP_05_speaker_R', category: 'fixture' },
];

function ledPlane(name: string, mat: THREE.Material, center: [number, number, number], back: boolean,
  uvRect?: { u0: number; v0: number; u1: number; v1: number }) {
  const g = new THREE.PlaneGeometry(LED_W, LED_H);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    // glTF 的 UV：v = 0 在上面（LED 貼圖 flipY = false，跟 C4D 匯出的模型一樣）
    let u = uv.getX(i), v = 1 - uv.getY(i);
    if (uvRect) { u = uvRect.u0 + u * (uvRect.u1 - uvRect.u0); v = uvRect.v0 + v * (uvRect.v1 - uvRect.v0); }
    uv.setXY(i, u, v);
  }
  if (back) g.rotateY(Math.PI);
  g.translate(...center);
  const m = new THREE.Mesh(g, mat);
  m.name = name;
  return m;
}

function box(name: string, mat: THREE.Material, size: [number, number, number], center: [number, number, number]) {
  const g = new THREE.BoxGeometry(...size);
  g.translate(...center);
  const m = new THREE.Mesh(g, mat);
  m.name = name;
  return m;
}

async function buildStageGlb(): Promise<string> {
  const scene = new THREE.Scene();
  const ledMat = new THREE.MeshStandardMaterial({ name: 'LED_Screen', color: 0x111111, roughness: 0.5, metalness: 0 });
  const floorMat = new THREE.MeshStandardMaterial({ name: 'Floor_Black_Gloss', color: 0x2a2a2e, roughness: 0.3, metalness: 0 });
  const trussMat = new THREE.MeshStandardMaterial({ name: 'Truss_Metal', color: 0x9a9aa0, roughness: 0.35, metalness: 0.9 });
  const speakerMat = new THREE.MeshStandardMaterial({ name: 'Speaker_Black', color: 0x18181a, roughness: 0.7, metalness: 0 });
  // 對面那塊 LED 只取色卡「灰 255」那一格的中間 → 整塊白
  const white = patchUvRect(patchIndex('灰 255'));
  const inset = { u0: white.u0 + 0.25 * (white.u1 - white.u0), u1: white.u1 - 0.25 * (white.u1 - white.u0), v0: white.v0 + 0.25 * (white.v1 - white.v0), v1: white.v1 - 0.25 * (white.v1 - white.v0) };
  scene.add(ledPlane('LED_01_main', ledMat, [0, LED_CY, LED_Z], false));
  scene.add(ledPlane('LED_02_audience', ledMat, [0, LED_CY, 14], true, inset));
  scene.add(box('STAGE_00_floor', floorMat, [26, 1, 18], [0, 0.5, 3]));
  scene.add(box('PROP_01_truss_L', trussMat, [0.4, 7, 0.4], [-6, 4.5, 0.3]));
  scene.add(box('PROP_02_truss_R', trussMat, [0.4, 7, 0.4], [6, 4.5, 0.3]));
  scene.add(box('PROP_03_truss_top', trussMat, [12.4, 0.4, 0.4], [0, 8.2, 0.3]));
  scene.add(box('PROP_04_speaker_L', speakerMat, [1.2, 3, 1.2], [-8, 2.5, 3]));
  scene.add(box('PROP_05_speaker_R', speakerMat, [1.2, 3, 1.2], [8, 2.5, 3]));
  const buf = await new GLTFExporter().parseAsync(scene, { binary: true }) as ArrayBuffer;
  return URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
}

const ZERO = { x: 0, y: 0, z: 0 };
const ZERO_ROT = { pitch: 0, yaw: 0, roll: 0 };
const ONE = { x: 1, y: 1, z: 1 };

function makeStates(stress: boolean): CueState[] {
  return OBJECTS.map((o, i) => ({
    objectId: o.id, meshName: o.name, displayName: o.name, category: o.category, order: i, locked: false,
    default: { position: ZERO, rotation: ZERO_ROT, scale: ONE },
    override: null,
    effective: { position: ZERO, rotation: ZERO_ROT, scale: ONE, visible: o.id === 'o_led_aud' ? stress : true },
  }));
}

function makeStageObjects(brightness: number): StageObject[] {
  return OBJECTS.map((o, i) => ({
    id: o.id, meshName: o.name, displayName: o.name, category: o.category, order: i,
    defaultPosition: ZERO, defaultRotation: ZERO_ROT, defaultScale: ONE, metadata: null, createdAt: '', locked: false,
    materialProps: null,
    ledProps: o.category === 'led_panel' && brightness !== 1 ? { brightness } as StageObject['ledProps'] : null,
  }));
}

// ─── 色卡 / 假小程序的畫面 ───

function chartCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CHART_WIDTH;
  c.height = CHART_HEIGHT;
  drawChart(c.getContext('2d')!);
  return c;
}

const blobToBase64 = (b: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(b);
});

const canvasBlob = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality));

/**
 * 小程序送出的 JPEG：
 *   true / false = 0.1.12：色卡 → 2 倍縮小（+ 選擇性 limited→full）→ JPEG 品質 75
 *   'rawAe'      = 0.1.13 + AE：色卡經過量到的 AE → NDI（黑抬到 16）→ 原樣送（不縮）→ JPEG 品質 90；網頁自己校正
 */
async function helperJpegBase64(limitedToFull: boolean | 'rawAe', quality?: number): Promise<string> {
  const src = chartCanvas();
  const img = src.getContext('2d')!.getImageData(0, 0, src.width, src.height);
  if (limitedToFull === 'rawAe') {
    for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(aeRawChain(img.data[i + c]));
  }
  const rawAe = limitedToFull === 'rawAe';
  const out = simulateHelperFrame(img.data, src.width, src.height, { downsample: !rawAe, limitedToFull: limitedToFull === true });
  quality ??= rawAe ? 0.9 : 0.75;
  const c = document.createElement('canvas');
  c.width = out.width;
  c.height = out.height;
  c.getContext('2d')!.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  return blobToBase64(await canvasBlob(c, 'image/jpeg', quality));
}

// ─── 量測 ───

export type Source = 'image' | 'localVideo' | 'urlVideo' | 'ndi' | 'testPattern';
export type View = 'head' | 'stage' | { close: string };

export interface Scenario {
  mode: 'live' | 'quick';
  source: Source;
  /** 對面那塊白色 LED 打開（LED 表面會映出它） */
  stress?: boolean;
  view?: View;
  mediaUrl?: string;
  ndiUrl?: string;
  look?: Partial<LookSettings>;
  brightness?: number;
}

interface MeasuredPatch { name: string; group: PatchGroup; expected: [number, number, number]; measured: [number, number, number] }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`等不到：${what}`);
    await sleep(50);
  }
}

interface StageDebug {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  meshes: { current: Map<string, THREE.Object3D> };
}
const stageDebug = () => (window as unknown as { __stage?: StageDebug }).__stage;

function ledMaterial(): THREE.MeshStandardMaterial | null {
  const obj = stageDebug()?.meshes.current.get('o_led_main');
  let mat: THREE.MeshStandardMaterial | null = null;
  obj?.traverse(c => { if ((c as THREE.Mesh).isMesh && !mat) mat = (c as THREE.Mesh).material as THREE.MeshStandardMaterial; });
  return mat;
}

function ledTexture(): THREE.Texture | null {
  const m = ledMaterial();
  return m ? (m.emissiveMap ?? m.map ?? null) : null;
}

function headView(): HomeView {
  return { position: [0, LED_CY, 7.5], target: [0, LED_CY, 0], fov: 50 };
}

function closeView(patch: string): HomeView {
  const [u, v] = patchCenterUv(patchIndex(patch));
  const x = -LED_W / 2 + u * LED_W, y = LED_TOP - v * LED_H;
  return { position: [x, y, 0.84], target: [x, y, LED_Z], fov: 50 };
}

const STAGE_VIEW: HomeView = { position: [10, 6.5, 17], target: [0, 3.2, 0], fov: 50 };

function viewOf(v: View | undefined): HomeView {
  if (!v || v === 'head') return headView();
  if (v === 'stage') return STAGE_VIEW;
  return closeView(v.close);
}

function readCanvas(): { data: Uint8ClampedArray; width: number; height: number; canvas: HTMLCanvasElement } {
  const canvas = document.querySelector('#harness-stage canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('找不到 3D 畫面');
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { data: img.data, width: c.width, height: c.height, canvas };
}

/** LED 上 (u, v) → 畫面像素（drawing buffer 座標） */
function project(u: number, v: number, width: number, height: number): [number, number] {
  const cam = stageDebug()!.camera;
  cam.updateMatrixWorld();
  const p = new THREE.Vector3(-LED_W / 2 + u * LED_W, LED_TOP - v * LED_H, LED_Z + 0.001).project(cam);
  return [((p.x + 1) / 2) * width, ((1 - p.y) / 2) * height];
}

function measureChart(): MeasuredPatch[] {
  const { data, width, height } = readCanvas();
  return CHART_PATCHES.map((p, i) => {
    const [u, v] = patchCenterUv(i);
    const [cx, cy] = project(u, v, width, height);
    const [ex] = project(u + 0.5 / 10, v, width, height);
    const r = Math.max(2, Math.floor((ex - cx) * 0.3));
    const x0 = Math.round(cx) - r, y0 = Math.round(cy) - r;
    return { name: p.name, group: p.group, expected: [...p.rgb], measured: averageRgb(data, width, x0, y0, x0 + 2 * r + 1, y0 + 2 * r + 1) };
  });
}

/** 近看（看得到像素格）：中間 ±5 顆 LED 的「光的平均」，跟原檔比；也回傳最亮 / 最暗的像素（確定格子真的有畫） */
function measureCloseRegion(patch: ChartPatch, texelsAcross: number) {
  const { data, width, height } = readCanvas();
  const i = patchIndex(patch.name);
  const [u, v] = patchCenterUv(i);
  const [cx, cy] = project(u, v, width, height);
  const [tx] = project(u + 1 / texelsAcross, v, width, height);
  const texelPx = tx - cx;
  const half = Math.round(texelPx * 5);
  // 對齊到 LED 顆粒的邊（中心那顆的中心在 cx，往外 5 顆）
  const x0 = Math.round(cx - half), y0 = Math.round(cy - half);
  const x1 = Math.round(cx + half), y1 = Math.round(cy + half);
  const lin = averageRgbLinear(data, width, x0, y0, x1, y1);
  let lo = 255, hi = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * width + x) * 4;
    const m = Math.max(data[o], data[o + 1], data[o + 2]);
    lo = Math.min(lo, m); hi = Math.max(hi, m);
  }
  return { name: patch.name, group: patch.group, expected: [...patch.rgb] as [number, number, number], measured: lin, texelPx, darkest: lo, brightest: hi };
}

/** 測試圖：在貼圖上找一塊一塊純色的地方，跟 LED 上同一點比 */
function measureFlatRegions(): MeasuredPatch[] {
  const tex = ledTexture();
  const src = tex?.image as HTMLCanvasElement | undefined;
  if (!src || !(src instanceof HTMLCanvasElement)) throw new Error('LED 貼圖不是 canvas');
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  const simg = sctx.getImageData(0, 0, src.width, src.height);
  const { data, width, height } = readCanvas();
  const out: MeasuredPatch[] = [];
  const N = 6;
  for (let gy = 1; gy < 16; gy++) {
    for (let gx = 1; gx < 32; gx++) {
      const u = gx / 32, v = gy / 16;
      const sx = Math.floor(u * src.width), sy = Math.floor(v * src.height);
      let flat = true;
      const o0 = (sy * src.width + sx) * 4;
      for (let dy = -N; dy <= N && flat; dy++) for (let dx = -N; dx <= N; dx++) {
        const o = ((sy + dy) * src.width + (sx + dx)) * 4;
        if (Math.abs(simg.data[o] - simg.data[o0]) > 0 || Math.abs(simg.data[o + 1] - simg.data[o0 + 1]) > 0 || Math.abs(simg.data[o + 2] - simg.data[o0 + 2]) > 0) { flat = false; break; }
      }
      if (!flat) continue;
      const exp: [number, number, number] = [simg.data[o0], simg.data[o0 + 1], simg.data[o0 + 2]];
      const [cx, cy] = project(u, v, width, height);
      const m = averageRgb(data, width, Math.round(cx) - 1, Math.round(cy) - 1, Math.round(cx) + 2, Math.round(cy) + 2);
      const isGrey = exp[0] === exp[1] && exp[1] === exp[2];
      out.push({ name: `測試圖 ${gx},${gy}`, group: isGrey ? 'grey' : 'macbeth', expected: exp, measured: m });
    }
  }
  return out;
}

/** 截圖：左邊原檔色卡、右邊 3D 畫面裡的 LED（同樣大小） */
function sideBySide(): string {
  const { canvas, width, height } = readCanvas();
  const [x0, y0] = project(0, 0, width, height);
  const [x1, y1] = project(1, 1, width, height);
  const w = 960, h = 480;
  const c = document.createElement('canvas');
  c.width = w * 2 + 24;
  c.height = h + 40;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(chartCanvas(), 0, 40, w, h);
  ctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, w + 24, 40, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = '20px sans-serif';
  ctx.fillText('原檔', 8, 28);
  ctx.fillText('3D 畫面裡的 LED（正面）', w + 32, 28);
  return c.toDataURL('image/png');
}

/** 一張截圖（data URL）裡，色卡被放在 (ox, oy, w, h) → 每格中心的顏色 */
async function samplePng(dataUrl: string, ox: number, oy: number, w: number, h: number): Promise<MeasuredPatch[]> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  return samplePatchesIn(data, c.width, ox, oy, w, h);
}

function samplePatchesIn(data: Uint8ClampedArray, stride: number, ox: number, oy: number, w: number, h: number): MeasuredPatch[] {
  return CHART_PATCHES.map((p, i) => {
    const [u, v] = patchCenterUv(i);
    const cx = Math.round(ox + u * w), cy = Math.round(oy + v * h);
    const r = Math.max(2, Math.floor((w / 10) * 0.3));
    return { name: p.name, group: p.group, expected: [...p.rgb], measured: averageRgb(data, stride, cx - r, cy - r, cx + r + 1, cy + r + 1) };
  });
}

// ─── 畫面 ───

interface HarnessApi {
  ready: boolean;
  error: string | null;
  chartPngBase64(): Promise<string>;
  helperJpegBase64(limitedToFull: boolean | 'rawAe'): Promise<string>;
  setScenario(s: Scenario): Promise<{ texture: string; textureSize: [number, number] }>;
  measure(): MeasuredPatch[];
  measureStable(): Promise<MeasuredPatch[]>;
  measureClose(patches: string[]): Promise<ReturnType<typeof measureCloseRegion>[]>;
  measureFlat(): MeasuredPatch[];
  sideBySide(): string;
  /** 小播放器：把同一個 <video> 放在畫面左上角（一半大小，截圖用）；false = 收回去 */
  showVideo(on: boolean): Promise<{ width: number; height: number }>;
  /** 同一個 <video> 畫進 2D canvas 讀回來（drawImage 的路） */
  sampleVideo2d(): MeasuredPatch[];
  samplePng(dataUrl: string, ox: number, oy: number, w: number, h: number): Promise<MeasuredPatch[]>;
  ledInfo(): Record<string, unknown>;
}

declare global {
  interface Window { __ledHarness?: HarnessApi }
}

function textureKind(tex: THREE.Texture | null): string {
  if (!tex) return 'none';
  if ((tex as THREE.VideoTexture).isVideoTexture) return 'video';
  if (tex.userData?.ledTestPattern) return 'testPattern';
  if ((tex as THREE.CanvasTexture).isCanvasTexture) return 'canvas';
  return 'image';
}

const EXPECT_KIND: Record<Source, string> = { image: 'image', localVideo: 'video', urlVideo: 'video', ndi: 'canvas', testPattern: 'testPattern' };

function Harness() {
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [sc, setSc] = useState<Scenario | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const player = useLocalVideo();
  const playerRef = useRef(player);
  playerRef.current = player;
  const scRef = useRef(sc);
  scRef.current = sc;
  const [videoBox, setVideoBox] = useState(false);
  const videoHostRef = useRef<HTMLDivElement>(null);
  const loadedVideoRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildStageGlb().then(u => { if (!cancelled) setModelUrl(u); }).catch(e => {
      if (window.__ledHarness) window.__ledHarness.error = String(e);
    });
    return () => { cancelled = true; };
  }, []);

  // 小播放器：同一個 <video>（MiniPlayer 也是把它直接放進畫面）
  useEffect(() => {
    const v = player.video;
    const host = videoHostRef.current;
    if (!videoBox || !host) { parkVideo(v); return; }
    host.appendChild(v);
    // 一半大小（小播放器也是縮小顯示；每格中間是純色，縮小不影響）
    v.style.width = `${v.videoWidth / 2}px`;
    v.style.height = `${v.videoHeight / 2}px`;
    v.style.display = 'block';
    return () => { v.style.width = ''; v.style.height = ''; parkVideo(v); };
  }, [videoBox, player.video]);

  useEffect(() => {
    const api: HarnessApi = {
      ready: false,
      error: null,
      chartPngBase64: async () => blobToBase64(await canvasBlob(chartCanvas(), 'image/png')),
      helperJpegBase64: (lut) => helperJpegBase64(lut),
      setScenario: async (s) => {
        const p = playerRef.current;
        // 影片：本地檔案（File → blob 網址，跟拖檔一樣）或網址（另一個網站 + crossOrigin，跟 R2 版本一樣）
        if (s.source === 'localVideo' || s.source === 'urlVideo') {
          const key = `${s.source}:${s.mediaUrl}`;
          if (loadedVideoRef.current !== key) {
            if (s.source === 'localVideo') {
              const blob = await (await fetch(s.mediaUrl!)).blob();
              p.load(new File([blob], 'chart.mp4', { type: blob.type || 'video/mp4' }), key);
            } else {
              p.loadUrl(s.mediaUrl!, { key, name: 'chart', crossOrigin: 'anonymous', autoplay: true });
            }
            loadedVideoRef.current = key;
          }
          p.video.muted = true;
          await waitFor(() => playerRef.current.ready, 20000, '影片載好');
          await playerRef.current.video.play().catch(() => {});
          await waitFor(() => playerRef.current.video.currentTime > 0.1, 20000, '影片開始播');
        } else {
          playerRef.current.pause();
        }
        if (s.source === 'image') {
          const blob = await canvasBlob(chartCanvas(), 'image/png');
          const img = new Image();
          img.src = URL.createObjectURL(new File([blob], 'chart.png', { type: 'image/png' }));
          await img.decode();
          setImage(img);
        } else {
          setImage(null);
        }
        setSc(s);
        await waitFor(() => (stageDebug()?.meshes.current.size ?? 0) >= OBJECTS.length, 30000, '模型');
        await waitFor(() => textureKind(ledTexture()) === EXPECT_KIND[s.source], 30000, `LED 換成 ${s.source}`);
        // 換模式要編 shader、影片要上傳幾格 → 多等一下
        await sleep(1500);
        const tex = ledTexture();
        const im = tex?.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
        return { texture: textureKind(tex), textureSize: [im?.videoWidth || im?.width || 0, im?.videoHeight || im?.height || 0] };
      },
      measure: () => measureChart(),
      measureStable: async () => {
        let prev = measureChart();
        for (let k = 0; k < 20; k++) {
          await sleep(400);
          const cur = measureChart();
          const diff = Math.max(...cur.map((c, i) => Math.max(...c.measured.map((v, j) => Math.abs(v - prev[i].measured[j])))));
          if (diff < 0.5) return cur;
          prev = cur;
        }
        return prev;
      },
      measureClose: async (names) => {
        const out: ReturnType<typeof measureCloseRegion>[] = [];
        const tex = ledTexture();
        const im = tex?.image as { width?: number; videoWidth?: number } | undefined;
        // NDI 收到的一個像素 = 2 顆 LED（StageScene 的 NDI_PIXEL_DENSITY）
        const density = textureKind(tex) === 'canvas' ? 2 : 1;
        const texels = (im?.videoWidth || im?.width || CHART_WIDTH) * density;
        for (const n of names) {
          const patch = CHART_PATCHES[patchIndex(n)];
          setSc(cur => (cur ? { ...cur, view: { close: n } } : cur));
          await sleep(1200);
          out.push(measureCloseRegion(patch, texels));
        }
        return out;
      },
      measureFlat: () => measureFlatRegions(),
      sideBySide: () => sideBySide(),
      showVideo: async (on) => {
        setVideoBox(on);
        await sleep(600);
        const v = playerRef.current.video;
        return { width: v.videoWidth / 2, height: v.videoHeight / 2 };
      },
      sampleVideo2d: () => {
        const v = playerRef.current.video;
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0);
        return samplePatchesIn(ctx.getImageData(0, 0, c.width, c.height).data, c.width, 0, 0, c.width, c.height);
      },
      samplePng: (d, ox, oy, w, h) => samplePng(d, ox, oy, w, h),
      ledInfo: () => {
        const m = ledMaterial();
        const tex = ledTexture();
        return {
          materialType: m?.type, toneMapped: m?.toneMapped, color: m?.color.getHexString(), emissive: m?.emissive.getHexString(),
          emissiveIntensity: m?.emissiveIntensity, roughness: m?.roughness, metalness: m?.metalness, envMapIntensity: m?.envMapIntensity,
          hasMap: !!m?.map, hasEmissiveMap: !!m?.emissiveMap, texture: textureKind(tex), colorSpace: tex?.colorSpace,
          ledSurface: m?.userData.ledSurface ? Object.fromEntries(Object.entries(m.userData.ledSurface as Record<string, { value: unknown }>).map(([k, v]) => [k, (v.value as { toArray?: () => unknown })?.toArray?.() ?? v.value])) : null,
        };
      },
    };
    window.__ledHarness = api;
  }, []);

  useEffect(() => {
    if (modelUrl && window.__ledHarness) window.__ledHarness.ready = true;
  }, [modelUrl]);

  const states = useMemo(() => makeStates(!!sc?.stress), [sc?.stress]);
  const stageObjects = useMemo(() => makeStageObjects(sc?.brightness ?? 1), [sc?.brightness]);
  const look = useMemo(() => ({ ...DEFAULT_LOOK_SETTINGS, ...(sc?.look || {}) }), [sc?.look]);
  const view = useMemo(() => viewOf(sc?.view), [sc?.view]);
  const videoOn = !!sc && (sc.source === 'localVideo' || sc.source === 'urlVideo') && player.ready;

  return (
    <>
      <div id="harness-stage" style={{ position: 'fixed', left: 0, top: 0, width: VIEW_W, height: VIEW_H }}>
        {sc && modelUrl && (
          <StageScene
            key={sc.mode}
            states={states}
            stageObjects={stageObjects}
            selectedObjectIds={[]}
            onSelect={() => {}}
            onTransform={() => {}}
            modelUrl={modelUrl}
            readOnly
            defaultRenderMode={sc.mode}
            enableNdi={sc.source === 'ndi'}
            ndiUrl={sc.ndiUrl}
            lookSettings={look}
            homeView={view}
            ledVideo={videoOn ? player.video : null}
            ledImage={sc.source === 'image' ? image : null}
            showScaleButton={false}
            ledMapMenu={false}
          />
        )}
      </div>
      <div ref={videoHostRef} style={{ position: 'fixed', left: 0, top: 0, zIndex: 100, display: videoBox ? 'block' : 'none', background: '#000' }} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
