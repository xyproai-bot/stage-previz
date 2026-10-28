// 調整舞台：疊在 3D 畫面上的東西（放在 StageScene 旁邊，跟畫面一樣大）
//   - 3D 裡的把手、發亮的框、存的位置的虛線框（handles.ts）
//   - 滑鼠：點到把手 → 拖（這一下不給鏡頭轉）；沒點到 → 照常轉鏡頭；放開時幾乎沒動 = 點物件選取
//   - 左上角：觀眾看 / 正上方 / 側面、播轉場；選到吊掛（提詞 LED）時鏡頭自動轉過去

import { useEffect, useRef, useSyncExternalStore, type MutableRefObject } from 'react';
import { ArrowDownToLine, ArrowRightToLine, Armchair, Play } from 'lucide-react';
import Icon from '../Icon';
import type { StageAdjustHost, StageSceneQuery, StageViewApi } from '../StageScene';
import type { AdjustStore } from '../../lib/adjust/store';
import { focusView, stageView, type StageViewKind } from '../../lib/adjust/views';
import { membersOfGroup, splitHalves } from '../../lib/adjust/scope';
import type { MechVec3 } from '../../lib/mechanisms/model';
import { isStageShowActive } from '../../lib/stageShow';
import { AdjustScene } from './handles';
import './AdjustStage.css';

const FRONT_FALLBACK: MechVec3 = { x: 0, y: 0, z: 1 };

export interface AdjustOverlayProps {
  store: AdjustStore;
  hostRef: MutableRefObject<StageAdjustHost | null>;
  viewApiRef: MutableRefObject<StageViewApi | null>;
  sceneQueryRef: MutableRefObject<StageSceneQuery | null>;
  /** 3D 疊層給面板用（物件在 cue 位置的中心：弧形讀數） */
  sceneRef: MutableRefObject<AdjustScene | null>;
}

export default function AdjustOverlay({ store, hostRef, viewApiRef, sceneQueryRef, sceneRef }: AdjustOverlayProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const front = (): MechVec3 => {
    try { return sceneQueryRef.current?.stageFront() ?? FRONT_FALLBACK; } catch { return FRONT_FALLBACK; }
  };
  const frontRef = useRef(front);
  frontRef.current = front;

  // 3D 疊層 + 滑鼠（開著才掛上；StageScene 還沒準備好就等下一幀）
  useEffect(() => {
    if (!state.on) return;
    let raf = 0;
    let cleanup: (() => void) | null = null;
    const attach = () => {
      const host = hostRef.current;
      const canvas = host?.canvas();
      if (!host || !canvas || !host.scene() || !host.camera()) { raf = requestAnimationFrame(attach); return; }
      const adj = new AdjustScene(host, store, () => frontRef.current());
      sceneRef.current = adj;
      const offFrame = host.onFrame(() => adj.update());
      // 左半 / 右半：照每個機關帶的物件在 cue 位置的中心分
      store.setHalves((groupId) => {
        const members = membersOfGroup(store.mechanisms(), groupId).flatMap(m => {
          const obj = store.objectFor(m.id);
          const c = obj ? adj.baseCenter(obj) : null;
          return c ? [{ id: m.id, pos: { x: c.x, y: c.y, z: c.z } }] : [];
        });
        return members.length >= 2 ? splitHalves(members, frontRef.current()) : null;
      });

      const target = canvas.parentElement ?? canvas;
      let dragId: number | null = null;
      let pending: { x: number; y: number; id: number } | null = null;
      const onDown = (e: PointerEvent) => {
        if (e.target !== canvas || e.button !== 0 || isStageShowActive()) return;   // 全螢幕預演：把手藏起來、也拖不到
        const h = adj.pick(e.clientX, e.clientY, e.pointerType === 'touch');
        if (h) {
          // 點到把手：這一下是拖把手，不給鏡頭轉、不給樂手 / 器材拖
          e.stopPropagation();
          e.preventDefault();
          dragId = e.pointerId;
          adj.beginDrag(h, e.clientX, e.clientY);
          canvas.style.cursor = 'grabbing';
          return;
        }
        pending = { x: e.clientX, y: e.clientY, id: e.pointerId };
      };
      const onMove = (e: PointerEvent) => {
        if (dragId !== null) {
          if (e.pointerId !== dragId) return;
          e.stopPropagation();
          adj.moveDrag(e.clientX, e.clientY, e.altKey);
          return;
        }
        if (e.target === canvas && e.pointerType !== 'touch') {
          const over = adj.hover(e.clientX, e.clientY);
          canvas.style.cursor = over ? 'grab' : '';
        }
      };
      const onUp = (e: PointerEvent) => {
        if (dragId !== null) {
          if (e.pointerId !== dragId) return;
          dragId = null;
          adj.endDrag();
          canvas.style.cursor = '';
          e.stopPropagation();
          return;
        }
        const p = pending;
        pending = null;
        if (!p || p.id !== e.pointerId || e.button !== 0 || e.type === 'pointercancel') return;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;   // 拖了 = 轉鏡頭，不是點
        const id = adj.pickObject(e.clientX, e.clientY);
        // 點空白、或點到沒有機關的物件（地板之類）→ 回到清單
        if (!id || !store.selectObject(id)) store.select(null);
      };
      const onLeave = () => { adj.clearHover(); if (dragId === null) canvas.style.cursor = ''; };
      target.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      canvas.addEventListener('pointerleave', onLeave);
      cleanup = () => {
        target.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        canvas.removeEventListener('pointerleave', onLeave);
        canvas.style.cursor = '';
        if (dragId !== null) adj.endDrag();
        offFrame();
        adj.dispose();
        if (sceneRef.current === adj) sceneRef.current = null;
        store.setHalves(() => null);
      };
    };
    attach();
    return () => { cancelAnimationFrame(raf); cleanup?.(); };
  }, [state.on, store, hostRef, sceneRef]);

  const fly = (kind: StageViewKind) => {
    const host = hostRef.current;
    const cam = host?.camera();
    if (!host || !cam) return;
    const b = host.stageBounds();
    void viewApiRef.current?.flyTo(stageView(kind, { center: b.center, radius: b.radius }, front(), cam.fov));
  };

  // 選到吊掛（提詞 LED）→ 鏡頭轉過去；之後選別的 → 回到觀眾看
  const autoFocusRef = useRef(false);
  const selObj = state.selection?.objectId ?? null;
  useEffect(() => {
    if (!state.on) { autoFocusRef.current = false; return; }
    const host = hostRef.current;
    const adj = sceneRef.current;
    const cam = host?.camera();
    if (!host || !cam || !adj) return;
    const isHoist = !!(selObj && host.rig().chains.get(selObj)?.[0]?.hoist);
    if (isHoist && selObj) {
      const sph = adj.objectSphere(selObj);
      if (!sph) return;
      autoFocusRef.current = true;
      void viewApiRef.current?.flyTo(focusView(sph.center, sph.radius, host.stageBounds().center, front(), cam.fov));
    } else if (autoFocusRef.current && selObj) {
      autoFocusRef.current = false;
      fly('audience');
    }
  }, [selObj, state.on]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state.on) return null;
  return (
    <div className="adjust-overlay">
      <div className="adjust-overlay__top">
        <div className="adjust-toolbar" role="toolbar" aria-label="調整舞台：看的角度">
          <button type="button" onClick={() => fly('audience')} title="從觀眾席看舞台"><Icon icon={Armchair} /> 觀眾看</button>
          <button type="button" onClick={() => fly('top')} title="從正上方往下看"><Icon icon={ArrowDownToLine} /> 正上方</button>
          <button type="button" onClick={() => fly('side')} title="從側面看"><Icon icon={ArrowRightToLine} /> 側面</button>
          <span className="adjust-toolbar__sep" aria-hidden="true" />
          <button
            type="button"
            className={state.playing ? 'is-on' : undefined}
            onClick={() => store.play()}
            title="從上一個 cue 用轉場秒數走到現在的樣子，看一次怎麼動"
          ><Icon icon={Play} /> 播轉場</button>
        </div>
        <div className="adjust-hint">點物件選取 · 拖綠色把手調整 · 按住 Alt 不對齊 · 拖空白處轉視角</div>
      </div>
    </div>
  );
}
