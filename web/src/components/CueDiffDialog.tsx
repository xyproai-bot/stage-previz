import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { Cue, CueState } from '../lib/api';
import './CueDiffDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  songId: string;
  cues: Cue[];        // master cues only
  onClose: () => void;
}

interface DiffRow {
  objectId: string;
  displayName: string;
  meshName: string;
  category: string;
  changed: boolean;
  posDelta: { x: number; y: number; z: number } | null;
  rotDelta: { pitch: number; yaw: number; roll: number } | null;
  visibleChanged: boolean;
  aPos?: CueState['effective']['position'];
  bPos?: CueState['effective']['position'];
}

export default function CueDiffDialog({ open, projectId, songId, cues, onClose }: Props) {
  const [aId, setAId] = useState<string>('');
  const [bId, setBId] = useState<string>('');
  const [aStates, setAStates] = useState<CueState[]>([]);
  const [bStates, setBStates] = useState<CueState[]>([]);
  const [loading, setLoading] = useState(false);
  const [showOnlyChanged, setShowOnlyChanged] = useState(true);

  useEffect(() => {
    if (!open) return;
    if (cues.length >= 2) {
      setAId(cues[0].id);
      setBId(cues[1].id);
    } else if (cues.length === 1) {
      setAId(cues[0].id);
      setBId('');
    }
  }, [open, cues]);

  useEffect(() => {
    if (!open || !aId) { setAStates([]); return; }
    let cancelled = false;
    setLoading(true);
    api.listCueStates(projectId, songId, aId).then(s => {
      if (!cancelled) setAStates(s);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, songId, aId]);

  useEffect(() => {
    if (!open || !bId) { setBStates([]); return; }
    let cancelled = false;
    api.listCueStates(projectId, songId, bId).then(s => {
      if (!cancelled) setBStates(s);
    });
    return () => { cancelled = true; };
  }, [open, projectId, songId, bId]);

  const rows: DiffRow[] = (() => {
    if (aStates.length === 0 || bStates.length === 0) return [];
    const bMap = new Map(bStates.map(s => [s.objectId, s]));
    return aStates.map(a => {
      const b = bMap.get(a.objectId);
      if (!b) {
        return {
          objectId: a.objectId, displayName: a.displayName, meshName: a.meshName, category: a.category,
          changed: false, posDelta: null, rotDelta: null, visibleChanged: false,
        };
      }
      const dx = round(b.effective.position.x - a.effective.position.x);
      const dy = round(b.effective.position.y - a.effective.position.y);
      const dz = round(b.effective.position.z - a.effective.position.z);
      const dpitch = round(b.effective.rotation.pitch - a.effective.rotation.pitch);
      const dyaw   = round(b.effective.rotation.yaw - a.effective.rotation.yaw);
      const droll  = round(b.effective.rotation.roll - a.effective.rotation.roll);
      const posChanged = Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001 || Math.abs(dz) > 0.001;
      const rotChanged = Math.abs(dpitch) > 0.01 || Math.abs(dyaw) > 0.01 || Math.abs(droll) > 0.01;
      const visibleChanged = a.effective.visible !== b.effective.visible;
      return {
        objectId: a.objectId,
        displayName: a.displayName,
        meshName: a.meshName,
        category: a.category,
        changed: posChanged || rotChanged || visibleChanged,
        posDelta: posChanged ? { x: dx, y: dy, z: dz } : null,
        rotDelta: rotChanged ? { pitch: dpitch, yaw: dyaw, roll: droll } : null,
        visibleChanged,
        aPos: a.effective.position,
        bPos: b.effective.position,
      };
    });
  })();

  const visibleRows = showOnlyChanged ? rows.filter(r => r.changed) : rows;
  const changedCount = rows.filter(r => r.changed).length;

  if (!open) return null;
  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg cue-diff-dlg">
        <header className="dlg__header">
          <h2>🔀 Cue 並排對比</h2>
          <button className="dlg__close" onClick={onClose}>×</button>
        </header>
        <div className="dlg__body">
          <div className="cue-diff__pickers">
            <label>
              <span>A</span>
              <select value={aId} onChange={e => setAId(e.target.value)}>
                <option value="">— 選 cue —</option>
                {cues.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <span className="cue-diff__arrow">→</span>
            <label>
              <span>B</span>
              <select value={bId} onChange={e => setBId(e.target.value)}>
                <option value="">— 選 cue —</option>
                {cues.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <span className="grow" />
            <label className="cue-diff__filter">
              <input type="checkbox" checked={showOnlyChanged} onChange={e => setShowOnlyChanged(e.target.checked)} />
              <span>只看有變的（{changedCount}/{rows.length}）</span>
            </label>
          </div>

          {loading ? (
            <div className="cue-diff__loading">載入中…</div>
          ) : !aId || !bId ? (
            <div className="cue-diff__empty">請選兩個 cue 對比</div>
          ) : visibleRows.length === 0 ? (
            <div className="cue-diff__empty">{rows.length === 0 ? '沒有資料' : '兩個 cue 完全一樣'}</div>
          ) : (
            <table className="cue-diff__table">
              <thead>
                <tr>
                  <th>物件</th>
                  <th>位置變化（m）</th>
                  <th>角度變化（°）</th>
                  <th>顯示</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(r => (
                  <tr key={r.objectId} className={r.changed ? 'is-changed' : ''}>
                    <td>
                      <div className="cue-diff__name">{r.displayName}</div>
                      <div className="cue-diff__mesh">{r.meshName}</div>
                    </td>
                    <td>
                      {r.posDelta ? (
                        <span className="cue-diff__delta cue-diff__delta--changed">
                          {fmtDelta(r.posDelta.x)}, {fmtDelta(r.posDelta.y)}, {fmtDelta(r.posDelta.z)}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>
                      {r.rotDelta ? (
                        <span className="cue-diff__delta cue-diff__delta--changed">
                          {fmtDelta(r.rotDelta.pitch)}, {fmtDelta(r.rotDelta.yaw)}, {fmtDelta(r.rotDelta.roll)}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>
                      {r.visibleChanged
                        ? <span className="cue-diff__delta--changed">變了</span>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function round(n: number): number { return Math.round(n * 100) / 100; }
function fmtDelta(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n}`;
}
