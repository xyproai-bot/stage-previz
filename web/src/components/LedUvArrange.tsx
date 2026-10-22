import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowUpLeft, LayoutGrid, Link2, Lock, TriangleAlert, Unlink2 } from 'lucide-react';
import Icon from './Icon';
import NumField from './NumField';
import LedTemplateCanvas, { type PatchHow } from './LedTemplateCanvas';
import LedTemplateLayers from './LedTemplateLayers';
import { toast } from './dialogs';
import { panelColor } from '../lib/ledMap';
import { ROTATIONS, type PlacementInput, type Rotation, type ScreenDef } from '../lib/ledTemplate';
import { patchDraftItems, type ItemPatchEntry } from '../lib/ledTemplateDraft';
import { setRotation } from '../lib/ledTemplateEdit';
import { boundsOf, centerGroupOnCanvas, clickSelect, isAdditive, moveGroupTo, movePatches, pruneSelection } from '../lib/ledTemplateSelect';
import { useTemplateBackdrop } from '../lib/useTemplateBackdrop';
import type { LayerBackdrop } from '../lib/ledTemplateContentDraw';
import {
  arrangeTransformPatches, autoLayoutDoc, canTransformSelection, CANVAS_MAX, CANVAS_MIN, expandSelection, isInGroup, joinGroups,
  moveAllToTopLeft, setCanvasMode, setCustomCanvas, sourceSpan, splitGroups, withGroups,
} from '../lib/ledUv/arrange';
import type { ArrangeState } from '../lib/ledUv/useArrange';
import type { Plan } from '../lib/ledUv/plan';
import { makeTileContentCache } from '../lib/ledUv/tileContent';
import { ARRANGE_TEXT } from '../lib/ledUv/text';

/**
 * 「自動貼 UV」的第 3 步「排版」：用 LED 版型編輯器同一套畫布（LedTemplateCanvas）自己排整張畫布。
 *   拖曳移動、方向鍵微調、吸附（別塊的邊、畫布的邊，Alt 不吸附）、轉 90°、左右 / 上下翻轉、復原重做、複選、框選、縮放平移、框裡的對位圖內容、底圖，都是版型編輯器的。
 *   跟版型不一樣的地方：螢幕的大小是 LED 規格決定的，不能縮放（沒有縮放把手）；不能拿掉任何一塊；
 *   保留原本 UV 的物件只能搬位置；幾塊可以「連在一起」，一起移動、一起轉 / 翻。
 *   畫布：剛好包住全部螢幕，或自己填寬 × 高。「全部靠左上」「自動排一次」。
 * 數字怎麼算：lib/ledUv/arrange.ts（有單元測試）；編輯狀態：lib/ledUv/useArrange.ts。
 */

interface Props {
  projectId: string;
  /** 沒套用自己排的排法的方案：框裡的畫面、「自動排一次」用 */
  autoPlan: Plan;
  /** 現在的方案（有套用自己排的排法）：超出畫布、重疊的提醒 */
  plan: Plan;
  arrange: ArrangeState;
  gutter: string;
  setGutter: (s: string) => void;
}

const CONTENT_OPACITY_KEY = 'sp_ledtpl_content_opacity';

const fmtPx = (n: number) => n.toLocaleString('en-US');

export default function LedUvArrange({ projectId, autoPlan, plan, arrange, gutter, setGutter }: Props) {
  const natives = autoPlan.items;
  const doc = arrange.doc;
  const [sel, setSel] = useState<string[]>([]);
  const [contentOn, setContentOn] = useState(true);
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

  const nativeByKey = useMemo(() => new Map(natives.map(n => [n.key, n])), [natives]);
  const fixedKeys = useMemo(() => new Set(natives.filter(n => n.fixed).map(n => n.key)), [natives]);
  const defs = useMemo<ScreenDef[]>(() => natives.map((n) => {
    const p = autoPlan.pack.placed.get(n.key) ?? { x: 0, y: 0, w: n.w, h: n.h };
    return { key: n.key, objectId: n.key, name: n.name, manual: false, uv: null, src: sourceSpan(p, autoPlan.canvas), nativeW: n.w, nativeH: n.h };
  }), [natives, autoPlan]);
  const defByKey = useMemo(() => new Map(defs.map(d => [d.key, d])), [defs]);

  // 框裡的對位圖內容：每塊照「現在排在哪裡」自己畫（名字、x y w h、角落座標、箱體格線都是新位置），拖、轉、翻之後下一格就更新
  const tileCache = useRef(makeTileContentCache()).current;
  const itemsRef = useRef(doc.items);
  itemsRef.current = doc.items;
  const tileContent = useMemo(() => (contentOn && natives.length > 0
    ? (key: string) => {
      const n = nativeByKey.get(key);
      const it = itemsRef.current.find(i => i.key === key);
      if (!n || !it) return null;
      return tileCache(key, n.name, n.w, n.h, it.dest.x, it.dest.y, natives.indexOf(n));
    }
    : null), [contentOn, natives, nativeByKey, tileCache, doc.items]);
  const backdrop = useTemplateBackdrop(projectId, 'autouv');
  const backdropLayer = useMemo<LayerBackdrop | null>(
    () => (backdrop.picture ? { image: backdrop.picture.image, width: backdrop.picture.width, height: backdrop.picture.height, prefs: backdrop.prefs } : null),
    [backdrop.picture, backdrop.prefs],
  );

  const itemByKey = useMemo(() => new Map(doc.items.map(i => [i.key, i])), [doc.items]);
  const selected = useMemo(() => pruneSelection(sel, k => itemByKey.has(k)), [sel, itemByKey]);
  const selSet = useMemo(() => new Set(selected), [selected]);
  const selItems = useMemo(() => doc.items.filter(i => selSet.has(i.key)), [doc.items, selSet]);
  const one = selItems.length === 1 ? selItems[0] : null;
  const groupBox = useMemo(() => (selItems.length > 1 ? boundsOf(selItems.map(i => i.dest)) : null), [selItems]);

  // 點到一塊就選到它整組
  const onSelect = useCallback((keys: string[]) => setSel(expandSelection(keys, doc.groups)), [doc.groups]);
  const onPatch = useCallback((patches: readonly ItemPatchEntry[], how: PatchHow) => arrange.apply(d => patchDraftItems(d, patches), how), [arrange]);
  const transformPatches = useCallback(
    (kind: 'rotate' | 'flipH' | 'flipV', items: readonly PlacementInput[]) => arrangeTransformPatches(kind, items, doc.groups, fixedKeys),
    [doc.groups, fixedKeys],
  );
  const canTransform = useCallback((items: readonly PlacementInput[]) => canTransformSelection(items, doc.groups, fixedKeys), [doc.groups, fixedKeys]);

  const problems = plan.problems;
  const nameOf = (k: string) => nativeByKey.get(k)?.name ?? k;
  const flagged = useMemo(() => {
    const s = new Set<string>();
    for (const k of problems?.outside ?? []) s.add(k);
    for (const [a, b] of problems?.overlaps ?? []) { s.add(a); s.add(b); }
    return s;
  }, [problems]);

  const toTopLeft = () => {
    if (moveAllToTopLeft(doc, natives) === doc) { toast.info(ARRANGE_TEXT.alreadyTopLeft); return; }
    arrange.applyDoc(d => moveAllToTopLeft(d, natives));
  };
  const autoOnce = () => {
    if (autoLayoutDoc(doc, natives, autoPlan.pack) === doc) { toast.info(ARRANGE_TEXT.alreadyAuto); return; }
    arrange.applyDoc(d => autoLayoutDoc(d, natives, autoPlan.pack));
  };
  const join = () => arrange.applyDoc(d => withGroups(d, joinGroups(d.groups, selected)));
  const split = () => arrange.applyDoc(d => withGroups(d, splitGroups(d.groups, selected)));
  const selInGroup = selected.some(k => isInGroup(doc.groups, k));
  const groupedAll = selected.length > 1 && doc.groups.some(g => selected.every(k => g.includes(k)) && g.length === selected.length);

  const sizeLabel = useCallback((def: ScreenDef) => `${fmtPx(def.nativeW)} × ${fmtPx(def.nativeH)} 點`, []);
  const auto = doc.canvasMode === 'auto';

  if (natives.length === 0) {
    return (
      <div className="uvdock__empty">
        {ARRANGE_TEXT.empty}
        {autoPlan.blockers.map((b, i) => <div key={i} className="uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {b}</div>)}
      </div>
    );
  }

  return (
    <div className="uvarr" data-testid="uv-arrange">
      <div className="uvarr__main">
        <div className="uvarr__bar">
          <span className="uvseg" role="group" aria-label={ARRANGE_TEXT.canvasGroup}>
            <button className={auto ? 'is-on' : ''} aria-pressed={auto} onClick={() => arrange.applyDoc(d => setCanvasMode(d, 'auto', natives))} title={ARRANGE_TEXT.canvasAutoHint}>{ARRANGE_TEXT.canvasAuto}</button>
            <button className={!auto ? 'is-on' : ''} aria-pressed={!auto} onClick={() => arrange.applyDoc(d => setCanvasMode(d, 'custom', natives))} title={ARRANGE_TEXT.canvasCustomHint}>{ARRANGE_TEXT.canvasCustom}</button>
          </span>
          <span className="uvarr__pair">
            <NumField className="uvarr__num" value={doc.width} min={CANVAS_MIN} max={CANVAS_MAX} label="畫布寬（像素）" onChange={n => arrange.applyDoc(d => setCustomCanvas(d, { width: n }, natives), { tag: 'canvas-w' })} />
            <span>×</span>
            <NumField className="uvarr__num" value={doc.height} min={CANVAS_MIN} max={CANVAS_MAX} label="畫布高（像素）" onChange={n => arrange.applyDoc(d => setCustomCanvas(d, { height: n }, natives), { tag: 'canvas-h' })} />
          </span>
          <button className="btn btn--ghost btn--sm" onClick={toTopLeft} title={ARRANGE_TEXT.topLeftHint} data-testid="uv-top-left"><Icon icon={ArrowUpLeft} /> {ARRANGE_TEXT.topLeft}</button>
          <button className="btn btn--ghost btn--sm" onClick={autoOnce} title={ARRANGE_TEXT.autoOnceHint} data-testid="uv-auto-once"><Icon icon={LayoutGrid} /> {ARRANGE_TEXT.autoOnce}</button>
          <label className="uvfields" title={ARRANGE_TEXT.gutterHint}>
            <span className="muted small">螢幕間隔</span>
            <input className="uvfields__s" inputMode="numeric" value={gutter} onChange={e => setGutter(e.target.value)} aria-label="自動排版時螢幕之間的間隔（點）" />
            <span className="muted small">點</span>
          </label>
          <span className="uvdock__spacer" />
          <button className="btn btn--ghost btn--sm" onClick={join} disabled={selected.length < 2 || groupedAll} title={ARRANGE_TEXT.joinHint} data-testid="uv-join"><Icon icon={Link2} /> {ARRANGE_TEXT.join}</button>
          <button className="btn btn--ghost btn--sm" onClick={split} disabled={!selInGroup} title={ARRANGE_TEXT.splitHint} data-testid="uv-split"><Icon icon={Unlink2} /> {ARRANGE_TEXT.split}</button>
        </div>

        <LedTemplateCanvas
          canvas={{ width: doc.width, height: doc.height }}
          scalePct={100}
          defs={defs}
          items={doc.items}
          selected={selected}
          resetKey={`uv:${natives.length}:${auto ? 'auto' : `${doc.width}x${doc.height}`}`}
          canUndo={arrange.canUndo}
          canRedo={arrange.canRedo}
          onSelect={onSelect}
          onPatch={onPatch}
          onGesture={arrange.onGesture}
          onRemove={() => { /* 排版時每一塊都是必要的，不能拿掉 */ }}
          onUndo={arrange.undo}
          onRedo={arrange.redo}
          onCenter={axis => arrange.apply(d => {
            const pick = d.items.filter(i => selSet.size === 0 || selSet.has(i.key));
            return patchDraftItems(d, movePatches(pick, centerGroupOnCanvas(pick.map(c => c.dest), { width: d.width, height: d.height }, axis)));
          }, { tag: `center:${axis}:${Date.now()}` })}
          tileContent={tileContent}
          showContent={contentOn}
          contentOpacity={contentOpacity}
          backdrop={backdropLayer}
          layersBar={(
            <LedTemplateLayers
              contentOn={contentOn}
              onContentOn={setContentOn}
              contentOpacity={contentOpacity}
              onContentOpacity={setContentOpacity}
              contentNote=""
              backdrop={backdrop}
              canvas={{ width: doc.width, height: doc.height }}
            />
          )}
          lockSize
          allowRemove={false}
          transformPatches={transformPatches}
          canTransform={canTransform}
          canvasName="整張畫布"
          sizeLabel={sizeLabel}
          emptyText={ARRANGE_TEXT.empty}
          hint={ARRANGE_TEXT.canvasHint}
        />

        {(problems && (problems.outside.length > 0 || problems.overlaps.length > 0)) && (
          <ul className="uvarr__issues" role="status">
            {problems.outside.length > 0 && <li className="uvlist__bad small"><Icon icon={TriangleAlert} size="xs" /> {ARRANGE_TEXT.outside(problems.outside.map(nameOf))}</li>}
            {problems.overlaps.length > 0 && <li className="uvlist__warn small"><Icon icon={TriangleAlert} size="xs" /> {ARRANGE_TEXT.overlap(problems.overlaps.slice(0, 3).map(([a, b]) => `${nameOf(a)} 和 ${nameOf(b)}`), problems.overlaps.length)}</li>}
          </ul>
        )}
      </div>

      <aside className="uvarr__side">
        <h3 className="uvarr__h">螢幕 <small className="muted">{natives.length} 塊 · 畫布 {fmtPx(doc.width)} × {fmtPx(doc.height)}</small></h3>
        <p className="muted small uvarr__note">{ARRANGE_TEXT.sizeLocked}</p>
        <ul className="uvarr__list">
          {natives.map((n) => {
            const def = defByKey.get(n.key)!;
            const g = doc.groups.find(x => x.includes(n.key));
            return (
              <li
                key={n.key}
                className={(selSet.has(n.key) ? 'is-sel' : '') + (flagged.has(n.key) ? ' is-bad' : '')}
                onClick={(e) => setSel(expandSelection(clickSelect(selected, n.key, isAdditive(e)), doc.groups))}
              >
                <span className="uvarr__dot" style={{ background: panelColor(natives.indexOf(n)) }} aria-hidden="true" />
                <span className="uvarr__name" title={n.name}>
                  <strong>{n.name}</strong>
                  <small className="muted">{sizeLabel(def)}</small>
                </span>
                {g && <span className="uvarr__chip" title={`連在一起：${g.map(nameOf).join('、')}`}><Icon icon={Link2} size="xs" /> {g.length} 塊</span>}
                {n.fixed && <span className="uvarr__chip" title={ARRANGE_TEXT.fixedHint}><Icon icon={Lock} size="xs" /> 只能搬</span>}
              </li>
            );
          })}
        </ul>

        {one && (
          <div className="uvarr__sel" role="group" aria-label={`選到的螢幕：${nameOf(one.key)}`}>
            <h4>{nameOf(one.key)} <small className="muted">{sizeLabel(defByKey.get(one.key)!)}</small></h4>
            <div className="uvarr__grid">
              {(['x', 'y'] as const).map(k => (
                <label key={k}>{k === 'x' ? '左' : '上'}
                  <NumField
                    value={one.dest[k]}
                    min={-65536}
                    label={`${nameOf(one.key)} ${k === 'x' ? '左' : '上'}`}
                    onChange={n => arrange.apply(d => patchDraftItems(d, [{ key: one.key, patch: { dest: { ...(d.items.find(i => i.key === one.key) ?? one).dest, [k]: n } } }]), { tag: `f:${one.key}:${k}` })}
                  />
                </label>
              ))}
              <span className="uvarr__dims muted small">寬 {fmtPx(one.dest.w)} · 高 {fmtPx(one.dest.h)}（鎖定）</span>
            </div>
            <div className="uvarr__row">
              <label>轉動
                <select
                  value={one.rotate}
                  disabled={fixedKeys.has(one.key)}
                  onChange={e => arrange.apply(d => patchDraftItems(d, [{ key: one.key, patch: setRotation(d.items.find(i => i.key === one.key) ?? one, Number(e.target.value) as Rotation) }]), {})}
                >
                  {ROTATIONS.map(d => <option key={d} value={d}>{d}°</option>)}
                </select>
              </label>
              <label className="uvarr__check"><input type="checkbox" checked={one.flipH} disabled={fixedKeys.has(one.key)} onChange={e => onPatch([{ key: one.key, patch: { flipH: e.target.checked } }], {})} /> 左右翻轉</label>
              <label className="uvarr__check"><input type="checkbox" checked={one.flipV} disabled={fixedKeys.has(one.key)} onChange={e => onPatch([{ key: one.key, patch: { flipV: e.target.checked } }], {})} /> 上下翻轉</label>
            </div>
          </div>
        )}
        {groupBox && (
          <div className="uvarr__sel" role="group" aria-label={`選到 ${selItems.length} 塊螢幕`}>
            <h4>已選 {selItems.length} 塊 <small className="muted">整組的外框 {fmtPx(groupBox.w)} × {fmtPx(groupBox.h)}：改左、上是整組一起移動</small></h4>
            <div className="uvarr__grid">
              {(['x', 'y'] as const).map(k => (
                <label key={k}>{k === 'x' ? '整組左' : '整組上'}
                  <NumField
                    value={groupBox[k]}
                    min={-65536}
                    label={k === 'x' ? '整組左' : '整組上'}
                    onChange={n => arrange.apply(d => {
                      const cur = d.items.filter(i => selSet.has(i.key));
                      return patchDraftItems(d, movePatches(cur, moveGroupTo(cur.map(c => c.dest), { [k]: n })));
                    }, { tag: `g:${k}:${[...selected].sort().join(',')}` })}
                  />
                </label>
              ))}
            </div>
            <p className="muted small">{ARRANGE_TEXT.multiHint}</p>
          </div>
        )}
        {selItems.length === 0 && <p className="muted small">{ARRANGE_TEXT.pickHint}</p>}
      </aside>
    </div>
  );
}
