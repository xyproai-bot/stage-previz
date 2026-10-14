// 管理頁右邊的「機關」分頁（只有製作看得到）
//   上面：這個 cue 的機關位置（常用位置一鍵、滑桿、打數字、回到沿用；來不及到位的提醒和「照機器速度」）
//   下面：設定機關（新增 / 編輯 / 刪除 / 排序；表單直接展開在這裡，3D 畫面照樣能轉、能選物件）
//   匯出機關總表（CSV，用 Excel 打開）
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChartGantt, ChevronDown, ChevronRight, Cog, FileSpreadsheet, LoaderCircle, Pencil, Plus, Rows3, TriangleAlert, Waves } from 'lucide-react';
import Icon from '../Icon';
import type { Cue, StageObject } from '../../lib/api';
import type { EditorMechanisms } from '../../lib/mechanisms/useMechanisms';
import { formatMechValue } from '../../lib/mechanisms/motion';
import { speedUnitOf, type Mechanism, type MechanismGroup, type MechanismInput, type MechVec3 } from '../../lib/mechanisms/model';
import { flipLabel } from '../../lib/mechanisms/flip';
import { countSides } from '../../lib/mechanisms/split';
import { layoutMechanisms, moveLayoutItem, valueRange } from '../../lib/mechanisms/group';
import * as mapi from '../../lib/mechanisms/mechanismApi';
import { buildMechanismSheetCsv, downloadMechanismSheet, sheetFileName } from '../../lib/mechanisms/cueSheet';
import { toast } from '../../lib/toast';
import { confirmDialog } from '../dialogs';
import MechanismCueRow from './MechanismCueRow';
import MechanismSetupForm from './MechanismSetupForm';
import MechanismBatchForm from './MechanismBatchForm';
import MechanismGroupForm from './MechanismGroupForm';
import MechanismPatternPanel from './MechanismPatternPanel';
import HelpLink from '../HelpLink';
import { HELP_ANCHORS } from '../../lib/helpLinks';
import './mechanisms.css';

interface Props {
  mech: EditorMechanisms;
  projectId: string;
  projectName?: string;
  /** 這首歌的 cue（正式 + 提案） */
  cues: Cue[];
  selectedCue: Cue | null;
  onSelectCue: (id: string | null) => void;
  stageObjects: StageObject[];
  selectedObjectIds: string[];
  scaleCorrection: number;
  /** 「照機器速度」：把這個 cue 的轉場改成幾秒 */
  onSetCrossfade: (seconds: number) => Promise<void>;
  /** 轉換舊位置後，物件位置也變了 → 重新讀 */
  onStatesChanged: () => void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function MechanismTab({
  mech, projectId, projectName, cues, selectedCue, onSelectCue, stageObjects, selectedObjectIds, scaleCorrection, onSetCrossfade, onStatesChanged,
}: Props) {
  const mechanisms = mech.mechanisms;
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [front, setFront] = useState<MechVec3 | null>(null);
  // 一排機關（v2 第 3 階段）：清單怎麼排、哪幾排展開、哪一排正在套花樣、哪一排在編輯、一次建立的表單
  const layout = useMemo(() => layoutMechanisms(mechanisms, mech.groups), [mechanisms, mech.groups]);
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());     // 「這個 cue 的機關位置」展開的排
  const [openSetup, setOpenSetup] = useState<Set<string>>(() => new Set());   // 「設定機關」展開的排
  const [patternFor, setPatternFor] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  // 在時間軸點到某一排裡的機關 → 這裡也把那一排展開，看得到是哪一個
  const focusedGroupId = mechanisms.find(m => m.id === mech.focusedId)?.groupId ?? null;
  useEffect(() => {
    if (focusedGroupId) {
      setOpenRows(s => (s.has(focusedGroupId) ? s : new Set(s).add(focusedGroupId)));
      setOpenSetup(s => (s.has(focusedGroupId) ? s : new Set(s).add(focusedGroupId)));
    }
  }, [focusedGroupId, mech.focusedId]);
  useEffect(() => { if (!selectedCue) setPatternFor(null); }, [selectedCue]);
  const masters = useMemo(() => cues.filter(c => c.status === 'master').sort((a, b) => a.order - b.order), [cues]);
  const cueName = useMemo(() => {
    const byId = new Map(cues.map(c => [c.id, c.name]));
    return (id: string) => byId.get(id) || '前面的 cue';
  }, [cues]);
  const cueLabel = useMemo(() => {
    const no = new Map(cues.filter(c => c.status === 'master').sort((a, b) => a.order - b.order).map((c, i) => [c.id, i + 1]));
    return (id: string) => (no.has(id) ? `Cue ${no.get(id)}「${cueName(id)}」` : `「${cueName(id)}」`);
  }, [cues, cueName]);

  // 舞台正面（「往觀眾」「往左」、方向字）：模型讀好之後問一次；打開設定時再問一次
  useEffect(() => {
    const t = window.setTimeout(() => setFront(mech.sceneQueryRef.current?.stageFront() ?? null), 400);
    return () => window.clearTimeout(t);
  }, [stageObjects, editingId, mech.sceneQueryRef]);

  const editingDefault = !selectedCue;
  const cueCheck = selectedCue ? mech.check?.cues.get(selectedCue.id) : undefined;
  const masterIdx = selectedCue ? masters.findIndex(c => c.id === selectedCue.id) : -1;
  const title = !selectedCue
    ? '預設位置（沒選 cue）'
    : masterIdx >= 0 ? `Cue ${masterIdx + 1}「${selectedCue.name}」` : `「${selectedCue.name}」`;

  async function exportSheet() {
    setExporting(true);
    try {
      const data = await mapi.getMechanismSheet(projectId);
      if (data.mechanisms.length === 0) { toast.info('還沒有機關，沒有東西可以匯出'); return; }
      const csv = buildMechanismSheetCsv({ ...data, front });
      downloadMechanismSheet(csv, sheetFileName(projectName || '專案'));
      toast.success('已下載機關總表（用 Excel 打開）');
    } catch (e) {
      toast.error('匯出機關總表失敗：' + msg(e));
    } finally {
      setExporting(false);
    }
  }

  async function save(editing: Mechanism | null, input: MechanismInput, moveObjects: boolean) {
    setBusy(true);
    const send = async (move: boolean) => {
      if (editing) {
        const r = await mech.update(editing.id, { ...input, moveObjects: move || undefined });
        if (r.outOfRangeCount > 0) toast.warn(`有 ${r.outOfRangeCount} 個 cue 存的位置超出新的行程，播放時會停在邊界`);
      } else {
        const m = await mech.create({ ...input, moveObjects: move || undefined });
        mech.setFocusedId(m.id);
      }
    };
    try {
      try {
        await send(moveObjects);
      } catch (e) {
        const err = e as mapi.MechanismApiError;
        if (err.status !== 409 || !err.data?.conflicts?.length) throw e;
        if (!(await confirmDialog({ title: `要把它移到「${input.name}」嗎？`, message: err.message, confirmLabel: '移過來' }))) return;
        await send(true);
      }
      toast.success(editing ? `已儲存「${input.name}」` : `已新增「${input.name}」`);
      setEditingId(null);
    } catch (e) {
      toast.error('機關沒有存到：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: Mechanism) {
    const ok = await confirmDialog({
      title: `刪除「${m.name}」？`,
      message: `會一起清掉 ${m.cueCount} 個 cue 裡設定的機關位置，不能復原。`,
      confirmLabel: '刪除',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await mech.remove(m.id);
      setEditingId(null);
      toast.success(`已刪除「${m.name}」`);
    } catch (e) {
      toast.error('刪除失敗：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function convert(m: Mechanism) {
    setBusy(true);
    try {
      const dry = await mapi.convertCuePositions(projectId, m.id, true);
      if (dry.converted === 0) {
        toast.info(dry.skipped.length
          ? `沒有可以轉的 cue（${dry.skipped.length} 個 cue 的物件動法不一致）`
          : `「${m.name}」帶的物件在每個 cue 都沒有離開預設位置，不用轉`);
        return;
      }
      const skippedNote = dry.skipped.length ? `另外 ${dry.skipped.length} 個 cue 沒辦法轉，會照原本的樣子留著。` : '';
      const ok = await confirmDialog({
        title: `把 ${dry.converted} 個 cue 的位置轉成「${m.name}」的機關位置？`,
        message: `這些 cue 裡「${m.name}」帶的物件的高度 / 角度會變成機關的位置，畫面看起來不會變，之後就能檢查速度、匯出總表。想先試試看的話，可以先複製專案、在副本上試。${skippedNote}`,
        confirmLabel: '轉換',
      });
      if (!ok) return;
      const r = await mapi.convertCuePositions(projectId, m.id, false);
      toast.success(`已轉好 ${r.converted} 個 cue`);
      const bad = r.skipped.filter(s => s.reason === 'inconsistent');
      const range = r.skipped.filter(s => s.reason === 'range');
      const list = (xs: typeof r.skipped) => xs.slice(0, 8).map(s => s.name).join('、') + (xs.length > 8 ? '…' : '');
      if (bad.length) toast.warn(`${bad.length} 個 cue 的物件動法不一致，沒有轉：${list(bad)}`, 12000);
      if (range.length) toast.warn(`${range.length} 個 cue 轉出來會超出行程，沒有轉：${list(range)}`, 12000);
      await Promise.all([mech.refreshDefs(), mech.refreshPositions()]);
      onStatesChanged();
      setEditingId(null);
    } catch (e) {
      toast.error('轉換失敗：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  /** 清單上的一項（一個機關或一整排）上移 / 下移一格；一整排一起移，不會被拆開 */
  function move(index: number, dir: -1 | 1) {
    const ids = moveLayoutItem(layout, index, dir);
    if (ids) void mech.reorder(ids);
  }

  /** 一次建立 N 個機關（一排）；有物件已經在別的機關 → 問過再移過來 */
  async function saveBatch(payload: mapi.BatchPayload) {
    setBusy(true);
    try {
      let r;
      try {
        r = await mech.createBatch(payload);
      } catch (e) {
        const err = e as mapi.MechanismApiError;
        if (err.status !== 409 || !err.data?.conflicts?.length) throw e;
        const c = err.data.conflicts;
        const names = c.slice(0, 4).map(x => `「${x.objectName}」（在「${x.mechanismName}」）`).join('、') + (c.length > 4 ? `…等 ${c.length} 個` : '');
        const ok = await confirmDialog({
          title: `要把這些物件移到新的一排「${payload.namePrefix}」嗎？`,
          message: `${names} 已經在別的機關裡，一個物件只能直接放在一個機關。`,
          confirmLabel: '移過來',
        });
        if (!ok) return;
        r = await mech.createBatch({ ...payload, moveObjects: true });
      }
      toast.success(`已建立「${r.group.name}」：${r.mechanisms.length} 個機關`);
      setBatchOpen(false);
      setOpenRows(s => new Set(s).add(r.group.id));
      setOpenSetup(s => new Set(s).add(r.group.id));
      if (r.mechanisms[0]) mech.setFocusedId(r.mechanisms[0].id);
    } catch (e) {
      toast.error('機關沒有建立：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGroup(g: MechanismGroup, patch: mapi.GroupPatch) {
    setBusy(true);
    try {
      const r = await mech.updateGroup(g.id, patch);
      if (r.outOfRangeCount > 0) toast.warn(`有 ${r.outOfRangeCount} 個 cue 存的位置超出新的行程，播放時會停在邊界`);
      toast.success(`已儲存「${r.group.name}」`);
      setEditingGroupId(null);
    } catch (e) {
      toast.error('這一排沒有存到：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function dissolveGroup(g: MechanismGroup, count: number) {
    const ok = await confirmDialog({
      title: `解散「${g.name}」這一排？`,
      message: `${count} 個機關都會留著，變成一個一個普通機關；每個 cue 的位置和時間都不會變。`,
      confirmLabel: '解散',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await mech.removeGroup(g.id, true);
      setEditingGroupId(null);
      setPatternFor(null);
      toast.success(`已解散「${g.name}」，${count} 個機關還在`);
    } catch (e) {
      toast.error('解散失敗：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(g: MechanismGroup, members: Mechanism[]) {
    const positions = members.reduce((n, m) => n + m.cueCount, 0);
    const ok = await confirmDialog({
      title: `刪除「${g.name}」和裡面的 ${members.length} 個機關？`,
      message: `會一起清掉 ${positions} 筆 cue 裡設定的機關位置，不能復原。只想拆開這一排、機關要留著的話，按「只解散這一排」。`,
      confirmLabel: '刪除',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await mech.removeGroup(g.id, false);
      setEditingGroupId(null);
      setPatternFor(null);
      toast.success(`已刪除「${g.name}」`);
    } catch (e) {
      toast.error('刪除失敗：' + msg(e));
    } finally {
      setBusy(false);
    }
  }

  const children = (m: Mechanism) => mechanisms.filter(x => x.parentId === m.id).map(x => x.name);
  const formFor = (m: Mechanism | null) => (
    <MechanismSetupForm
      key={m?.id ?? 'new'}
      editing={m}
      mechanisms={mechanisms}
      stageObjects={stageObjects}
      selectedObjectIds={selectedObjectIds}
      scaleCorrection={scaleCorrection}
      front={front ?? { x: 0, y: 0, z: 1 }}
      groupCenter={(ids) => mech.sceneQueryRef.current?.groupCenter(ids) ?? null}
      groupBox={(ids) => mech.sceneQueryRef.current?.groupBox(ids) ?? null}
      busy={busy}
      onSave={(input, moving) => save(m, input, moving)}
      onCancel={() => setEditingId(null)}
      onDelete={m ? () => void remove(m) : undefined}
      onConvert={m && m.variant !== 'split' && m.cueCount === 0 && m.objectIds.length > 0 ? () => void convert(m) : undefined}
    />
  );

  if (mech.status === 'loading') {
    return <div className="editor-empty muted"><Icon icon={LoaderCircle} spin /> 載入機關中…</div>;
  }
  if (mech.status === 'error' && mechanisms.length === 0) {
    return (
      <div className="editor-empty" role="alert">
        <div className="muted">機關載入失敗</div>
        <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => void mech.refreshDefs()}>重新載入</button>
      </div>
    );
  }

  /** 「這個 cue 的機關位置」裡一個機關那一列 */
  const cueRow = (m: Mechanism) => (
    <MechanismCueRow
      key={m.id}
      mech={m}
      resolved={mech.selectedRow[m.id] ?? { value: m.defaultValue, stored: m.defaultValue, source: 'default', fromCueId: null, clamped: false }}
      editingDefault={editingDefault}
      cueName={cueName}
      check={cueCheck?.items[m.id]}
      cueFix={cueCheck?.fix ?? null}
      front={front}
      focused={mech.focusedId === m.id}
      disabled={busy}
      onFocus={() => { if (mech.focusedId !== m.id) mech.setFocusedId(m.id); }}
      onCommit={(v) => void mech.commitValue(m.id, v)}
      onPreview={(v) => mech.previewValue(m.id, v)}
      onClear={() => void mech.clearValue(m.id)}
      onFix={(s) => void onSetCrossfade(s)}
      timing={selectedCue ? mech.timings.get(selectedCue.id)?.[m.id] ?? null : null}
      showTiming={!!selectedCue && mech.selectedRow[m.id]?.source === 'own' && !!cueCheck?.items[m.id]?.prevCueId}
      cueSpan={cueCheck?.items[m.id]?.span ?? null}
      cueLabel={cueLabel}
      onTiming={selectedCue ? (patch) => void mech.commitTiming(selectedCue.id, m.id, patch) : undefined}
    />
  );

  /** 一排：標題（展開 / 收起、這個 cue 的位置範圍、套用花樣），底下是每個成員那一列 */
  const cueGroup = (g: MechanismGroup, members: Mechanism[]) => {
    const open = openRows.has(g.id);
    const range = valueRange(members.map(m => (editingDefault ? m.defaultValue : mech.selectedRow[m.id]?.value ?? m.defaultValue)));
    const kind = members[0]?.kind ?? 'linear';
    const problems = members.filter(m => cueCheck?.items[m.id] && cueCheck.items[m.id].status === 'tooFast').length;
    const firstCue = !!selectedCue && !members.some(m => cueCheck?.items[m.id]?.prevCueId);
    return (
      <li key={g.id} className="mech-group">
        <div className="mech-group__head">
          <button type="button" className="mech-icon-btn" aria-expanded={open} aria-label={open ? `收起「${g.name}」` : `展開「${g.name}」`}
            onClick={() => setOpenRows(s => toggle(s, g.id))}><Icon icon={open ? ChevronDown : ChevronRight} /></button>
          <span className="mech-group__name" title={g.name}>{g.name}</span>
          <span className="muted small">{members.length} 個機關{range ? ` · ${formatMechValue(range.min, kind)}${range.max !== range.min ? ` ~ ${formatMechValue(range.max, kind)}` : ''}` : ''}</span>
          {problems > 0 && <span className="mech-group__flag" title={`有 ${problems} 個機關來不及到位，展開看是哪幾個`}><Icon icon={TriangleAlert} size="sm" /> {problems}</span>}
          <span className="grow" />
          <button type="button" className="btn btn--ghost btn--sm" disabled={!selectedCue || busy || patternFor === g.id}
            title={selectedCue ? '一次設好這一排在這個 cue 的位置和延遲：一起、依序、波浪、漸層' : '先在上面選一個 cue，花樣是設在 cue 上的'}
            onClick={() => { setPatternFor(g.id); mech.setFocusedId(members[0]?.id ?? null); }}><Icon icon={Waves} /> 套用花樣</button>
        </div>
        {patternFor === g.id && selectedCue && (
          <MechanismPatternPanel
            key={selectedCue.id}
            group={g}
            members={members}
            mech={mech}
            cueId={selectedCue.id}
            cueLabel={cueLabel(selectedCue.id)}
            isFirstCue={firstCue}
            disabled={busy}
            onClose={() => setPatternFor(null)}
          />
        )}
        {open && <ul className="mech-rows mech-rows--member">{members.map(cueRow)}</ul>}
      </li>
    );
  };

  /** 「設定機關」裡一個機關那一列（index = 在清單的第幾項；一排裡面的成員不能單獨上下移，傳 null） */
  const setupItem = (m: Mechanism, index: number | null) => {
    const kids = children(m);
    const speed = m.maxSpeed === null ? null
      : m.kind === 'rotary' ? `${formatMechValue(m.maxSpeed, 'rotary', false)}${speedUnitOf('rotary')}` : `${formatMechValue(m.maxSpeed, 'linear', false)} ${speedUnitOf('linear')}`;
    return (
      <li key={m.id} className={'mech-setup-item' + (mech.focusedId === m.id ? ' is-focused' : '')}>
        <div className="mech-setup-item__row" onClick={() => mech.setFocusedId(m.id)}>
          <div className="mech-setup-item__main">
            <span className="mech-setup-item__name">{m.name}</span>
            <span className="muted small">
              {formatMechValue(m.travelMin, m.kind, false)} ~ {formatMechValue(m.travelMax, m.kind)}
              {speed && ` · ${speed}`}
              {flipLabel(m.metadata) && ` · ${flipLabel(m.metadata)}`}
              {m.variant === 'split'
                ? ` · 對開：A 邊 ${countSides(m.objectIds, m.objectSides ?? {}).a} 個、B 邊 ${countSides(m.objectIds, m.objectSides ?? {}).b} 個 · ${m.cueCount} 個 cue 有設定`
                : ` · ${m.objectIds.length} 個物件 · ${m.cueCount} 個 cue 有設定`}
            </span>
            {kids.length > 0 && <span className="muted small">帶動：{kids.join('、')}</span>}
          </div>
          <div className="mech-setup-item__actions" onClick={e => e.stopPropagation()}>
            {index !== null && (
              <>
                <button type="button" className="mech-icon-btn" title="上移" aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)}><Icon icon={ArrowUp} /></button>
                <button type="button" className="mech-icon-btn" title="下移" aria-label="下移" disabled={index === layout.length - 1} onClick={() => move(index, 1)}><Icon icon={ArrowDown} /></button>
              </>
            )}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditingId(m.id); mech.setFocusedId(m.id); }} disabled={editingId === m.id}>
              <Icon icon={Pencil} /> 編輯
            </button>
          </div>
        </div>
        {editingId === m.id && formFor(m)}
      </li>
    );
  };

  /** 「設定機關」裡的一排：標題 + 編輯這一排（名字、共用設定、解散、刪除），展開後是每個成員 */
  const setupGroup = (g: MechanismGroup, members: Mechanism[], index: number) => {
    const open = openSetup.has(g.id);
    const first = members[0];
    return (
      <li key={g.id} className={'mech-setup-item mech-setup-group' + (members.some(m => m.id === mech.focusedId) ? ' is-focused' : '')}>
        <div className="mech-setup-item__row" onClick={() => setOpenSetup(s => toggle(s, g.id))}>
          <button type="button" className="mech-icon-btn" aria-expanded={open} aria-label={open ? `收起「${g.name}」` : `展開「${g.name}」`}
            onClick={e => { e.stopPropagation(); setOpenSetup(s => toggle(s, g.id)); }}><Icon icon={open ? ChevronDown : ChevronRight} /></button>
          <div className="mech-setup-item__main">
            <span className="mech-setup-item__name">{g.name}</span>
            <span className="muted small">
              一排 {members.length} 個機關
              {first && ` · ${formatMechValue(first.travelMin, first.kind, false)} ~ ${formatMechValue(first.travelMax, first.kind)}`}
            </span>
          </div>
          <div className="mech-setup-item__actions" onClick={e => e.stopPropagation()}>
            <button type="button" className="mech-icon-btn" title="上移" aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)}><Icon icon={ArrowUp} /></button>
            <button type="button" className="mech-icon-btn" title="下移" aria-label="下移" disabled={index === layout.length - 1} onClick={() => move(index, 1)}><Icon icon={ArrowDown} /></button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditingGroupId(g.id); setEditingId(null); setBatchOpen(false); }} disabled={editingGroupId === g.id}>
              <Icon icon={Pencil} /> 編輯這一排
            </button>
          </div>
        </div>
        {editingGroupId === g.id && (
          <MechanismGroupForm
            key={g.id}
            group={g}
            members={members}
            busy={busy}
            onSave={(patch) => saveGroup(g, patch)}
            onCancel={() => setEditingGroupId(null)}
            onDissolve={() => void dissolveGroup(g, members.length)}
            onDelete={() => void deleteGroup(g, members)}
          />
        )}
        {open && <ul className="mech-setup-list mech-setup-list--member">{members.map(m => setupItem(m, null))}</ul>}
      </li>
    );
  };

  return (
    <div className="mech-tab">
      {mech.check?.orderMismatch && (
        <div className="mech-warn mech-warn--song" role="status">
          <Icon icon={TriangleAlert} size="sm" className="mech-warn__icon" />
          <span>cue 的順序跟影片時間對不上：機關會從影片時間的上一個 cue 出發</span>
        </div>
      )}

      <section className="mech-section">
        <header className="mech-section__head">
          <h3 className="mech-section__title">這個 cue 的機關位置 · <span className="mech-section__cue">{title}</span></h3>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void exportSheet()}
              disabled={exporting || mechanisms.length === 0}
              title="用 Excel 打開；整個專案每首歌、每個 cue、每個機關一行"
            ><Icon icon={exporting ? LoaderCircle : FileSpreadsheet} spin={exporting} /> 匯出機關總表</button>
            <HelpLink anchor={HELP_ANCHORS.prodMechanisms} />
          </span>
        </header>
        <label className="mech-speed-toggle" title="開了：換 cue 時機關照最高速度走（跟導演頁、分享連結一樣，太快就晚到）。關了：照轉場秒數，跟物件一起到">
          <input type="checkbox" checked={mech.realSpeed} onChange={e => mech.setRealSpeed(e.target.checked)} />
          <span>照機器速度播放</span>
          <small className="muted">{mech.realSpeed ? '換 cue 時機關照最高速度走，跟導演、客戶看到的一樣' : '換 cue 時機關照轉場秒數走（編輯比較快）；提醒照樣會出現'}</small>
        </label>
        {mechanisms.length > 0 && (
          <label className="mech-speed-toggle" title="開了：3D 畫面下面排出這首歌每個機關什麼時候動，可以拖色塊改延遲和走幾秒">
            <input type="checkbox" checked={mech.timelineOpen} onChange={e => mech.setTimelineOpen(e.target.checked)} />
            <Icon icon={ChartGantt} size="sm" />
            <span>顯示機關時間軸</span>
          </label>
        )}
        {cues.length > 0 && (
          <label className="mech-cue-pick">
            <span className="muted small">換 cue</span>
            <select value={selectedCue?.id ?? ''} onChange={e => onSelectCue(e.target.value || null)} aria-label="換 cue">
              <option value="">預設位置（沒選 cue）</option>
              {masters.map((c, i) => <option key={c.id} value={c.id}>Cue {i + 1}「{c.name}」</option>)}
              {cues.filter(c => c.status !== 'master').map(c => <option key={c.id} value={c.id}>提案「{c.name}」</option>)}
            </select>
          </label>
        )}

        {mechanisms.length === 0 ? (
          <div className="editor-empty mech-empty">
            <Icon icon={Cog} size="xl" className="editor-empty__icon" />
            <div>還沒有機關</div>
            <small className="muted">升降台、轉台、滑軌這類會動的機械，先在下面「新增機關」設定一次，之後每個 cue 選位置就好</small>
          </div>
        ) : (
          <ul className="mech-rows">
            {layout.map(it => (it.type === 'single' ? cueRow(it.mech) : cueGroup(it.group, it.members)))}
          </ul>
        )}
      </section>

      <section className="mech-section">
        <header className="mech-section__head">
          <h3 className="mech-section__title">設定機關</h3>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setBatchOpen(true); setEditingId(null); setEditingGroupId(null); }} disabled={batchOpen}
              title="用 3D 畫面選取的好幾個物件，一個物件一個機關，編號、名稱、方向、行程一次設好">
              <Icon icon={Rows3} /> 一次建立多個
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditingId('new'); setBatchOpen(false); }} disabled={editingId === 'new'}>
              <Icon icon={Plus} /> 新增機關
            </button>
          </span>
        </header>
        {scaleCorrection === 1 && (
          <div className="mech-warn" role="status">
            <Icon icon={TriangleAlert} size="sm" className="mech-warn__icon" />
            <span>還沒做測距校準：機關的行程是用公尺算的，先用工具列的測距把尺寸校準好，畫面上移動的距離才準</span>
          </div>
        )}
        {editingId === 'new' && formFor(null)}
        {batchOpen && (
          <MechanismBatchForm
            mechanisms={mechanisms}
            groups={mech.groups}
            stageObjects={stageObjects}
            selectedObjectIds={selectedObjectIds}
            front={front ?? { x: 0, y: 0, z: 1 }}
            groupCenter={(ids) => mech.sceneQueryRef.current?.groupCenter(ids) ?? null}
            groupBox={(ids) => mech.sceneQueryRef.current?.groupBox(ids) ?? null}
            busy={busy}
            onSave={saveBatch}
            onCancel={() => setBatchOpen(false)}
          />
        )}
        {mechanisms.length > 0 && (
          <ul className="mech-setup-list">
            {layout.map((it, i) => (it.type === 'single' ? setupItem(it.mech, i) : setupGroup(it.group, it.members, i)))}
          </ul>
        )}
      </section>
    </div>
  );
}
