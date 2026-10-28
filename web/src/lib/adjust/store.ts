// 調整舞台的草稿倉庫（不靠 React，可以測）。導演頁、面板、3D 把手都看這一份。
//
//   開著的時候 3D 每個機關的值都由這裡決定（StageScene 每幀問 override()）：
//     畫面 = 這個 cue 存的值 + 草稿（改值 → 馬上跳過去；換 cue → 照轉場秒數走過去；播轉場 → 從上一個 cue 走過來）
//   關著 → override() = null，審片的畫面完全照舊。
//   只是預覽：草稿不存到任何地方，換 cue / 關掉就沒了（要不要放棄由畫面先問）。

import { compileRig, type RigMechanism } from '../mechanisms/pose';
import { MechanismTweener } from '../mechanisms/motion';
import { clampValue, valueAxes, type Mechanism, type MechanismTimings, type MechanismValues } from '../mechanisms/model';
import { changedIds, effectiveValues, moveTogether, revertDraft, setDraftValue, type Draft, type TravelRange } from './draft';
import { snapValue } from './snap';
import { driveIds, hoistsOfRigDefs, type Halves, type ScopeKey } from './scope';

export interface AdjustCueContext {
  cueId: string | null;
  cueName: string;
  /** 這個 cue 存的機關值（每個機關都有） */
  saved: MechanismValues;
  /** 上一個 cue 的名字；這是第一個 cue → null（從預設位置） */
  prevName: string | null;
  /** 上一個 cue 的值（第一個 cue = 預設位置） */
  prevValues: MechanismValues;
  /** 這個 cue 的轉場秒數 */
  seconds: number;
  /** 這個 cue 自己設的延遲 / 走幾秒 */
  timings: MechanismTimings;
}

export interface AdjustSelection { objectId: string; mechId: string }

export type AdjustControl =
  | { type: 'mech'; id: string; def: Mechanism }
  | { type: 'rig'; rigId: string; def: Mechanism | undefined; hoists: Mechanism[] };

export interface AdjustState {
  on: boolean;
  cueId: string | null;
  /** 只放改過的機關 */
  draft: Draft;
  selection: AdjustSelection | null;
  /** 每一排選的範圍（groupId → 範圍） */
  scope: Record<string, ScopeKey>;
  /** 取消「左右一起」的吊掛（rigId → true） */
  unlinked: Record<string, boolean>;
  /** 正在播轉場 */
  playing: boolean;
  /** 正在調的機關（3D 畫它的行程線） */
  active: string | null;
}

const INITIAL: AdjustState = { on: false, cueId: null, draft: {}, selection: null, scope: {}, unlinked: {}, playing: false, active: null };
const MAX_HIGHLIGHT = 64;

export class AdjustStore {
  private state: AdjustState = INITIAL;
  private listeners = new Set<() => void>();
  private defs: Mechanism[] = [];
  private byId = new Map<string, Mechanism>();
  private axes: { id: string }[] = [];
  private chains = new Map<string, RigMechanism[]>();
  private ctx: AdjustCueContext | null = null;
  private tweener = new MechanismTweener();
  private drag: { mechId: string; ids: string[]; start: MechanismValues } | null = null;
  private halvesFn: (groupId: string) => Halves | null = () => null;
  private controlsCache: { sel: AdjustSelection | null; defs: Mechanism[]; list: AdjustControl[] } | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  // ── 訂閱（useSyncExternalStore）──
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getState = (): AdjustState => this.state;
  private set(patch: Partial<AdjustState>) {
    let changed = false;
    for (const k in patch) {
      if ((patch as Record<string, unknown>)[k] !== (this.state as unknown as Record<string, unknown>)[k]) { changed = true; break; }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  // ── 從頁面同步進來的東西 ──
  setDefs(defs: Mechanism[] | null | undefined) {
    const list = defs ?? [];
    if (list === this.defs) return;
    this.defs = list;
    this.byId = new Map(list.map(m => [m.id, m]));
    this.axes = valueAxes(list).map(m => ({ id: m.id }));
    this.chains = compileRig(list, 1).chains;
    // 機關被刪掉了 → 草稿裡拿掉；選到的物件沒有機關了 → 取消選取
    const draft: Draft = {};
    for (const id in this.state.draft) if (this.byId.has(id)) draft[id] = this.state.draft[id];
    const sel = this.state.selection && this.chains.has(this.state.selection.objectId) ? this.state.selection : null;
    this.set({ draft: Object.keys(draft).length === Object.keys(this.state.draft).length ? this.state.draft : draft, selection: sel });
    this.retarget(false);
  }

  /** 換 cue / 存的值更新了。草稿是別的 cue 的 → 丟掉（回傳丟了幾個，畫面講一聲） */
  setCue(ctx: AdjustCueContext): { dropped: number } {
    const prev = this.ctx;
    this.ctx = ctx;
    let dropped = 0;
    if (this.state.cueId !== ctx.cueId) {
      dropped = changedIds(this.state.draft).length;
      this.drag = null;
      this.set({ cueId: ctx.cueId, draft: {}, playing: false });
      this.retarget(prev !== null && prev.cueId !== ctx.cueId);
    } else {
      // 存的值更新了：改回跟存的一樣的就不算改
      let draft = this.state.draft;
      for (const id of changedIds(draft)) {
        if (typeof ctx.saved[id] === 'number' && Math.abs(ctx.saved[id] - draft[id]) < 1e-9) draft = revertDraft(draft, [id]);
      }
      this.set({ draft });
      this.retarget(false);
    }
    return { dropped };
  }

  /** 左半 / 右半怎麼分（要物件位置，3D 那邊給） */
  setHalves(fn: (groupId: string) => Halves | null) {
    this.halvesFn = fn;
  }

  // ── 開 / 關 ──
  /** 打開調整舞台；shown = 畫面上現在的值（直接接著用） */
  enter(shown: MechanismValues) {
    if (this.state.on) return;
    this.tweener = new MechanismTweener();
    this.tweener.setCurrent(shown, this.now());
    this.set({ on: true, draft: {}, selection: null, playing: false, active: null });
    this.retarget(false);
  }
  /** 關掉：草稿丟掉（要不要放棄由畫面先問） */
  exit() {
    this.drag = null;
    this.set({ on: false, draft: {}, selection: null, playing: false, active: null });
  }

  /** StageScene 每幀問：開著 = 每個機關的值；關著 = null */
  override = (): MechanismValues | null => {
    if (!this.state.on) return null;
    const now = this.now();
    const v = this.tweener.valuesAt(now);
    if (this.state.playing && !this.tweener.isMoving(now)) this.set({ playing: false });
    return v;
  };

  // ── 選東西 ──
  select(sel: AdjustSelection | null) {
    this.set({ selection: sel, active: sel?.mechId ?? null });
  }
  /** 在 3D 點到物件；沒有機關 → false */
  selectObject(objectId: string): boolean {
    const chain = this.chains.get(objectId);
    if (!chain || chain.length === 0) return false;
    this.select({ objectId, mechId: chain[0].id });
    return true;
  }
  /** 從清單挑機關 → 選它帶的物件（沒有 → 裝在它上面的機關帶的；吊點 → 整組吊掛帶的）；都沒有 → false */
  selectMechanism(mechId: string): boolean {
    const objectId = this.objectFor(mechId);
    if (!objectId) return false;
    this.select({ objectId, mechId });
    return true;
  }
  /** 這個機關在 3D 上代表的物件（選它時選到的那個） */
  objectFor(mechId: string): string | null {
    const def = this.byId.get(mechId);
    if (!def) return null;
    const target = def.variant === 'hoist' && def.rigId ? def.rigId : mechId;
    const direct = this.byId.get(target)?.objectIds ?? [];
    for (const id of direct) if (this.chains.get(id)?.some(n => n.id === target)) return id;
    for (const [id, chain] of this.chains) if (chain.some(n => n.id === target)) return id;
    return null;
  }

  /** 選到的物件的機關鏈（裡面的在前）→ 面板一段一段、3D 一個一個把手 */
  controls(): AdjustControl[] {
    const sel = this.state.selection;
    const c = this.controlsCache;
    if (c && c.sel === sel && c.defs === this.defs) return c.list;
    const list: AdjustControl[] = [];
    for (const node of (sel ? this.chains.get(sel.objectId) : undefined) ?? []) {
      if (node.hoist) list.push({ type: 'rig', rigId: node.id, def: this.byId.get(node.id), hoists: hoistsOfRigDefs(this.defs, node.id) });
      else {
        const def = this.byId.get(node.id);
        if (def) list.push({ type: 'mech', id: node.id, def });
      }
    }
    this.controlsCache = { sel, defs: this.defs, list };
    return list;
  }

  // ── 整組 ──
  setScope(groupId: string, scope: ScopeKey) {
    this.set({ scope: { ...this.state.scope, [groupId]: scope } });
    if (scope !== 'left' && scope !== 'right') return;
    // 選的那個不在那一半 → 改選那一半的第一個（把手要在動得到的那個上）
    const ctl = this.controls().find(c => c.type === 'mech' && c.def.groupId === groupId);
    const side = this.halvesFn(groupId)?.[scope] ?? [];
    if (ctl && ctl.type === 'mech' && side.length > 0 && !side.includes(ctl.id)) this.selectMechanism(side[0]);
  }
  setLinked(rigId: string, linked: boolean) {
    const unlinked = { ...this.state.unlinked };
    if (linked) delete unlinked[rigId]; else unlinked[rigId] = true;
    this.set({ unlinked });
  }
  /** 這一排的左半 / 右半（分不出來 → null） */
  halvesOf(groupId: string): Halves | null { return this.halvesFn(groupId); }
  isLinked(rigId: string): boolean {
    return !this.state.unlinked[rigId];
  }
  /** 這個把手 / 滑桿一次動哪些機關 */
  driveIds(mechId: string): string[] {
    return driveIds({ mechId, defs: this.defs, scope: this.state.scope, linked: r => this.isLinked(r), halves: this.halvesFn });
  }

  // ── 值 ──
  /** 機關定義（清單、一排的成員用） */
  mechanisms(): Mechanism[] { return this.defs; }
  def(id: string): Mechanism | undefined { return this.byId.get(id); }
  saved(id: string): number {
    const s = this.ctx?.saved[id];
    return typeof s === 'number' ? s : this.byId.get(id)?.defaultValue ?? 0;
  }
  value(id: string): number {
    const d = this.state.draft[id];
    return typeof d === 'number' ? d : this.saved(id);
  }
  isChanged(id: string): boolean { return id in this.state.draft; }
  changedCount(): number { return changedIds(this.state.draft).length; }
  /** 上一個 cue（或預設位置）的值 */
  prevValue(id: string): number {
    const p = this.ctx?.prevValues[id];
    return typeof p === 'number' ? p : this.byId.get(id)?.defaultValue ?? 0;
  }
  cue(): AdjustCueContext | null { return this.ctx; }

  // ── 改值 ──
  beginDrag(mechId: string) {
    const ids = this.driveIds(mechId);
    const start: MechanismValues = {};
    for (const id of ids) start[id] = this.value(id);
    this.drag = { mechId, ids, start };
    this.set({ active: mechId });
  }
  /** 拖到 raw（沒對齊的值）；free = 按住 Alt 不對齊 */
  dragTo(mechId: string, raw: number, free: boolean) {
    if (!this.drag || this.drag.mechId !== mechId) this.beginDrag(mechId);
    const d = this.drag!;
    const def = this.byId.get(mechId);
    if (!def) return;
    const target = snapValue(raw, { kind: def.kind, presets: def.presets.map(p => p.value), min: def.travelMin, max: def.travelMax, free });
    this.applyValues(moveTogether(d.start, d.ids, mechId, target, this.ranges()));
  }
  endDrag() { this.drag = null; }
  /** 面板的滑桿 / 數字：這個機關到 v（不對齊、夾在行程內），一起動的加一樣的量 */
  setValue(mechId: string, v: number) {
    const ids = this.driveIds(mechId);
    const start: MechanismValues = {};
    for (const id of ids) start[id] = this.value(id);
    this.applyValues(moveTogether(start, ids, mechId, v, this.ranges()), { active: mechId });
  }
  /** 常用位置：範圍裡每個都到這個值（各自夾在行程內） */
  applyPreset(mechId: string, v: number) {
    const out: MechanismValues = {};
    for (const id of this.driveIds(mechId)) {
      const def = this.byId.get(id);
      if (def) out[id] = clampValue(v, def.travelMin, def.travelMax);
    }
    this.applyValues(out, { active: mechId });
  }
  revert(ids: string[]) { this.setDraft(revertDraft(this.state.draft, ids)); }
  discardAll() { this.drag = null; this.setDraft({}); }

  /** 播轉場：從上一個 cue（第一個 cue = 預設位置）用這個 cue 的轉場秒數走到現在的值 */
  play() {
    if (!this.state.on || !this.ctx) return;
    const now = this.now();
    const from: MechanismValues = {};
    for (const m of this.axes) from[m.id] = this.prevValue(m.id);
    this.tweener.setCurrent(from, now);
    this.tweener.retarget(this.axes, this.effective(), now, {
      animate: true, minSeconds: this.ctx.seconds, motion: 'transition', timings: this.ctx.timings,
    });
    this.set({ playing: true });
  }

  // ── 3D 要畫的 ──
  /** 發亮的物件：選到的 + 現在的把手 / 滑桿會動到的 */
  affectedObjects(): string[] {
    const sel = this.state.selection;
    if (!sel) return [];
    const ids = new Set<string>();
    for (const c of this.controls()) {
      if (c.type === 'mech') for (const id of this.driveIds(c.id)) ids.add(id);
      else ids.add(c.rigId);
    }
    const out = new Set<string>([sel.objectId]);
    for (const [obj, chain] of this.chains) {
      if (out.size >= MAX_HIGHLIGHT) break;
      if (chain.some(n => ids.has(n.id))) out.add(obj);
    }
    return [...out];
  }
  /** 改過的物件（存的位置留虛線框） */
  ghostObjects(): string[] {
    const changed = new Set<string>();
    for (const id of changedIds(this.state.draft)) {
      const def = this.byId.get(id);
      changed.add(def?.variant === 'hoist' && def.rigId ? def.rigId : id);
    }
    if (changed.size === 0) return [];
    const out: string[] = [];
    for (const [obj, chain] of this.chains) {
      if (out.length >= MAX_HIGHLIGHT) break;
      if (chain.some(n => changed.has(n.id))) out.push(obj);
    }
    return out;
  }
  /** 存的值（畫虛線框用） */
  savedValues(): MechanismValues { return this.ctx?.saved ?? {}; }
  /** 草稿值（存的 + 改過的） */
  effective(): MechanismValues { return effectiveValues(this.ctx?.saved ?? {}, this.state.draft); }

  // ── 內部 ──
  private ranges(): Record<string, TravelRange | undefined> {
    const r: Record<string, TravelRange | undefined> = {};
    for (const m of this.defs) r[m.id] = { travelMin: m.travelMin, travelMax: m.travelMax };
    return r;
  }
  private applyValues(vals: MechanismValues, extra: Partial<AdjustState> = {}) {
    let draft = this.state.draft;
    for (const id in vals) draft = setDraftValue(draft, this.ctx?.saved ?? {}, id, vals[id]);
    this.setDraft(draft, extra);
  }
  /** 草稿換了才通知、才重新對位置（setDraftValue 每次都給新物件：內容一樣就當沒變） */
  private setDraft(draft: Draft, extra: Partial<AdjustState> = {}) {
    if (sameValues(draft, this.state.draft)) { this.set(extra); return; }
    this.set({ ...extra, draft, playing: false });
    this.retarget(false);
  }
  /** 改值 → 全部直接跳到草稿值；換 cue → 照轉場走 */
  private retarget(animate: boolean) {
    if (!this.state.on) return;
    const now = this.now();
    const eff = this.effective();
    if (!animate) this.tweener.setCurrent(eff, now);
    this.tweener.retarget(this.axes, eff, now, {
      animate, minSeconds: this.ctx?.seconds ?? 0, motion: 'transition', timings: this.ctx?.timings ?? null,
    });
  }
}

function sameValues(a: MechanismValues, b: MechanismValues): boolean {
  if (a === b) return true;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
