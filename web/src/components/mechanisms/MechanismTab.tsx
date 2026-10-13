// 管理頁右邊的「機關」分頁（只有製作看得到）
//   上面：這個 cue 的機關位置（常用位置一鍵、滑桿、打數字、回到沿用；來不及到位的提醒和「照機器速度」）
//   下面：設定機關（新增 / 編輯 / 刪除 / 排序；表單直接展開在這裡，3D 畫面照樣能轉、能選物件）
//   匯出機關總表（CSV，用 Excel 打開）
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Cog, FileSpreadsheet, LoaderCircle, Pencil, Plus, TriangleAlert } from 'lucide-react';
import Icon from '../Icon';
import type { Cue, StageObject } from '../../lib/api';
import type { EditorMechanisms } from '../../lib/mechanisms/useMechanisms';
import { formatMechValue } from '../../lib/mechanisms/motion';
import { speedUnitOf, type Mechanism, type MechanismInput, type MechVec3 } from '../../lib/mechanisms/model';
import * as mapi from '../../lib/mechanisms/mechanismApi';
import { buildMechanismSheetCsv, downloadMechanismSheet, sheetFileName } from '../../lib/mechanisms/cueSheet';
import { toast } from '../../lib/toast';
import MechanismCueRow from './MechanismCueRow';
import MechanismSetupForm from './MechanismSetupForm';
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
  const masters = useMemo(() => cues.filter(c => c.status === 'master').sort((a, b) => a.order - b.order), [cues]);
  const cueName = useMemo(() => {
    const byId = new Map(cues.map(c => [c.id, c.name]));
    return (id: string) => byId.get(id) || '前面的 cue';
  }, [cues]);

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
        if (!confirm(`${err.message}\n\n要把它移到「${input.name}」嗎？`)) return;
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
    if (!confirm(`刪除「${m.name}」？會一起清掉 ${m.cueCount} 個 cue 裡設定的機關位置，不能復原。`)) return;
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
      const skippedNote = dry.skipped.length ? `\n\n另外 ${dry.skipped.length} 個 cue 沒辦法轉，會照原本的樣子留著。` : '';
      if (!confirm(`把 ${dry.converted} 個 cue 裡「${m.name}」帶的物件的位置，轉成「${m.name}」的機關位置？\n\n畫面看起來不會變，之後就能檢查速度、匯出總表。想先試試看的話，可以先複製專案、在副本上試。${skippedNote}`)) return;
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

  function move(m: Mechanism, dir: -1 | 1) {
    const ids = mechanisms.map(x => x.id);
    const i = ids.indexOf(m.id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void mech.reorder(ids);
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
      busy={busy}
      onSave={(input, moving) => save(m, input, moving)}
      onCancel={() => setEditingId(null)}
      onDelete={m ? () => void remove(m) : undefined}
      onConvert={m && m.cueCount === 0 && m.objectIds.length > 0 ? () => void convert(m) : undefined}
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
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void exportSheet()}
            disabled={exporting || mechanisms.length === 0}
            title="用 Excel 打開；整個專案每首歌、每個 cue、每個機關一行"
          ><Icon icon={exporting ? LoaderCircle : FileSpreadsheet} spin={exporting} /> 匯出機關總表</button>
        </header>
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
            {mechanisms.map(m => (
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
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mech-section">
        <header className="mech-section__head">
          <h3 className="mech-section__title">設定機關</h3>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditingId('new')} disabled={editingId === 'new'}>
            <Icon icon={Plus} /> 新增機關
          </button>
        </header>
        {scaleCorrection === 1 && (
          <div className="mech-warn" role="status">
            <Icon icon={TriangleAlert} size="sm" className="mech-warn__icon" />
            <span>還沒做測距校準：機關的行程是用公尺算的，先用工具列的測距把尺寸校準好，畫面上移動的距離才準</span>
          </div>
        )}
        {editingId === 'new' && formFor(null)}
        {mechanisms.length > 0 && (
          <ul className="mech-setup-list">
            {mechanisms.map((m, i) => {
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
                        {` · ${m.objectIds.length} 個物件 · ${m.cueCount} 個 cue 有設定`}
                      </span>
                      {kids.length > 0 && <span className="muted small">帶動：{kids.join('、')}</span>}
                    </div>
                    <div className="mech-setup-item__actions" onClick={e => e.stopPropagation()}>
                      <button type="button" className="mech-icon-btn" title="上移" aria-label="上移" disabled={i === 0} onClick={() => move(m, -1)}><Icon icon={ArrowUp} /></button>
                      <button type="button" className="mech-icon-btn" title="下移" aria-label="下移" disabled={i === mechanisms.length - 1} onClick={() => move(m, 1)}><Icon icon={ArrowDown} /></button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditingId(m.id); mech.setFocusedId(m.id); }} disabled={editingId === m.id}>
                        <Icon icon={Pencil} /> 編輯
                      </button>
                    </div>
                  </div>
                  {editingId === m.id && formFor(m)}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
