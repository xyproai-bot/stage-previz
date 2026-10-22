import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, LoaderCircle, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import * as api from '../lib/api';
import { toast } from '../lib/toast';
import { useEscapeClose } from '../lib/useEscapeClose';
import { friendlyError } from '../lib/songReview';
import { setSongTimeline, type LedTemplate } from '../lib/ledTemplateApi';
import {
  MAX_SWITCHES, checkTimeline, formatSwitchTime, parseSwitchTime, switchSentence, switchTime, unresolvedSwitchText,
  type CueTimes, type SwitchInput, type TimelineSwitch, type TimelineTemplateInfo,
} from '../lib/ledTemplateTimeline';
import { cueNumName } from '../lib/cueBadge';
import './LedTimelineDialog.css';

/** 畫面上的一列：換版型的點（用 Cue 或直接寫時間）+ 換成哪個版型 */
interface Row {
  key: string;
  mode: 'cue' | 'time';
  cueId: string;
  timeText: string;
  templateId: string;
}

let rowSeq = 0;
const newKey = () => `r${++rowSeq}`;

function rowsFromSwitches(switches: readonly TimelineSwitch[]): Row[] {
  return switches.map(sw => ({
    key: newKey(),
    mode: sw.cueId ? 'cue' as const : 'time' as const,
    cueId: sw.cueId ?? '',
    timeText: !sw.cueId && sw.atSec !== null ? formatSwitchTime(sw.atSec) : '',
    templateId: sw.templateId,
  }));
}

const sizeText = (t: { canvas: { width: number; height: number } }) => `${t.canvas.width}×${t.canvas.height}`;

interface DialogProps {
  open: boolean;
  projectId: string;
  song: { id: string; name: string; templateId: string | null; switches: readonly TimelineSwitch[] };
  /** 專案所有自己排的版型 */
  templates: readonly LedTemplate[];
  onClose: () => void;
  onSaved: (songId: string, result: { templateId: string | null; templateSwitches: TimelineSwitch[] }) => void;
}

/**
 * 「中途換版型」：同一首歌的影片只有一個檔，但畫面形狀會在歌的中間變（機關打開、螢幕飛進來）。
 * 這裡設定「開頭用哪個版型」和「到哪個 Cue（或哪個時間）起換成哪個版型」。只有製作能存。
 * 規則：所有版型的畫布大小要一樣（影片只有一個大小）；Cue 要有影片時間；兩個點不能在同一個時間。
 */
export default function LedTimelineDialog({ open, projectId, song, templates, onClose, onSaved }: DialogProps) {
  useEscapeClose(open, onClose);
  const [cues, setCues] = useState<api.Cue[] | null>(null);
  const [cuesError, setCuesError] = useState(false);
  const [start, setStart] = useState<string>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // 打開的時候用這首歌現在的設定當起點；讀這首歌的 Cue（只有正式的能當換版型的點）
  useEffect(() => {
    if (!open) return;
    setStart(song.templateId && templates.some(t => t.id === song.templateId) ? song.templateId : '');
    setRows(rowsFromSwitches(song.switches));
    setServerError(null);
    setCues(null);
    setCuesError(false);
    let cancelled = false;
    api.listCues(projectId, song.id)
      .then(list => { if (!cancelled) setCues(list.filter(c => c.status === 'master')); })
      .catch(() => { if (!cancelled) { setCues([]); setCuesError(true); } });
    return () => { cancelled = true; };
    // 只在打開的那一刻抓一次起點，不要因為清單重讀把使用者正在改的東西蓋掉
  }, [open, song.id]);

  const cueTimes: CueTimes = useMemo(
    () => new Map((cues ?? []).map(c => [c.id, { name: cueNumName(c), timeSec: c.videoTimeSec }])),
    [cues],
  );
  const infoMap = useMemo(() => new Map<string, TimelineTemplateInfo>(
    templates.map(t => [t.id, { id: t.id, name: t.name, kind: 'custom' as const, canvas: t.canvas }]),
  ), [templates]);
  const startTpl = templates.find(t => t.id === start) ?? null;

  // 每一列轉成後台的格式；時間看不懂的列標出來
  const parsed = rows.map(r => {
    if (r.mode === 'cue') return { row: r, input: (r.cueId ? { cueId: r.cueId, templateId: r.templateId } : null) as SwitchInput | null, problem: r.cueId ? null : '要選一個 Cue' };
    const sec = parseSwitchTime(r.timeText);
    return { row: r, input: (sec === null ? null : { atSec: sec, templateId: r.templateId }) as SwitchInput | null, problem: sec === null ? '時間要寫成 83 或 1:23.5' : null };
  });
  const rowProblems = parsed.map(p => (p.row.templateId ? p.problem : '要選換成哪個版型'));
  const validInputs = parsed.filter((p, i) => !rowProblems[i] && p.input).map(p => p.input!);
  const check = useMemo(
    () => (cues === null ? null : checkTimeline({ start: start || null, switches: validInputs, templates: infoMap, cues: cueTimes })),
    [cues, start, JSON.stringify(validInputs), infoMap, cueTimes],
  );
  const hasRowProblem = rowProblems.some(Boolean);
  const checkError = check && !check.ok ? check.error : null;
  const canSave = !saving && cues !== null && !hasRowProblem && !checkError && (rows.length === 0 || !!start);

  // 預覽：照時間排好的幾句話
  const preview = useMemo(() => {
    const items: { at: number; text: string }[] = [];
    const lines: string[] = [];
    parsed.forEach((p) => {
      const tpl = templates.find(t => t.id === p.row.templateId);
      if (!tpl) return;
      if (p.row.mode === 'cue') {
        const cue = cueTimes.get(p.row.cueId);
        if (!cue) return;
        if (cue.timeSec === null) { lines.push(unresolvedSwitchText(cue.name, tpl.name)); return; }
        items.push({ at: cue.timeSec, text: switchSentence(cue.name, cue.timeSec, tpl.name) });
      } else {
        const sec = parseSwitchTime(p.row.timeText);
        if (sec !== null) items.push({ at: sec, text: switchSentence(null, sec, tpl.name) });
      }
    });
    items.sort((a, b) => a.at - b.at);
    return { sorted: items.map(i => i.text), notes: lines };
  }, [rows, templates, cueTimes]);

  function update(key: string, patch: Partial<Row>) {
    setRows(list => list.map(r => (r.key === key ? { ...r, ...patch } : r)));
    setServerError(null);
  }

  function addRow() {
    // 預設換成「開頭以外的第一個一樣大的版型」，常見的 A → B
    const other = templates.find(t => t.id !== start && startTpl && sizeText(t) === sizeText(startTpl)) ?? null;
    const usedCues = new Set(rows.filter(r => r.mode === 'cue').map(r => r.cueId));
    const nextCue = (cues ?? []).find(c => c.videoTimeSec !== null && !usedCues.has(c.id));
    setRows(list => [...list, {
      key: newKey(), mode: nextCue ? 'cue' : 'time', cueId: nextCue?.id ?? '', timeText: '', templateId: other?.id ?? '',
    }]);
    setServerError(null);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setServerError(null);
    try {
      const out = await setSongTimeline(projectId, song.id, { start: start || null, switches: validInputs });
      onSaved(song.id, out);
      toast.success(out.templateSwitches.length > 0 ? `「${song.name}」中途換版型存好了（換 ${out.templateSwitches.length} 次）` : `「${song.name}」沒有中途換版型了`);
      onClose();
    } catch (e) {
      setServerError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg tl-dlg" role="dialog" aria-modal="true" aria-label={`「${song.name}」中途換版型`}>
        <header className="dlg__header">
          <h2><Icon icon={ArrowRightLeft} size="md" /> 中途換版型 · {song.name}</h2>
          <button className="dlg__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dlg__body">
          <p className="tl-dlg__hint">
            LED 的形狀會在歌的中間變（機關打開、螢幕飛進來）時，同一個影片檔可以前半段用版型 A 的排法、到了指定的 Cue 或時間換成版型 B。
            動畫師還是只交一個影片檔，檔案裡每塊螢幕放的位置在換版型的那一格換掉。
            <strong> 所有版型的畫布大小要一樣</strong>（影片只有一個大小）。
          </p>

          {templates.length === 0 && (
            <p className="tl-dlg__warn"><Icon icon={TriangleAlert} /> 這個專案還沒有自己排的版型。先到上面的「版型」建好版型再來。</p>
          )}

          <label className="tl-dlg__field">
            <span>開頭用</span>
            <select
              value={start}
              onChange={(e) => { setStart(e.target.value); setServerError(null); }}
              aria-label="開頭用哪個版型"
            >
              <option value="">全部（整張畫布，不能中途換版型）</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}（{sizeText(t)}）</option>)}
            </select>
          </label>

          {cues === null ? (
            <div className="tl-dlg__loading"><Icon icon={LoaderCircle} spin /> 讀取這首歌的 Cue…</div>
          ) : (
            <>
              {cuesError && <p className="tl-dlg__warn"><Icon icon={TriangleAlert} /> 沒讀到這首歌的 Cue，現在只能用「時間」。</p>}
              {rows.length === 0 && <p className="muted small tl-dlg__empty">還沒有換版型的點。按下面的「加一個換版型的點」。</p>}
              <ul className="tl-dlg__rows">
                {parsed.map((p, i) => {
                  const r = p.row;
                  const problem = rowProblems[i];
                  return (
                    <li key={r.key} className={'tl-row' + (problem ? ' has-problem' : '')}>
                      <span className="tl-row__n">{i + 1}</span>
                      <label className="tl-row__cell">
                        <span>從</span>
                        <select value={r.mode} onChange={(e) => update(r.key, { mode: e.target.value as Row['mode'] })} aria-label="用 Cue 還是用時間">
                          <option value="cue">Cue</option>
                          <option value="time">時間</option>
                        </select>
                      </label>
                      {r.mode === 'cue' ? (
                        <select
                          className="tl-row__cue"
                          value={r.cueId}
                          onChange={(e) => update(r.key, { cueId: e.target.value })}
                          aria-label="換版型的 Cue"
                        >
                          <option value="">選一個 Cue…</option>
                          {(cues ?? []).map(c => (
                            <option key={c.id} value={c.id} disabled={c.videoTimeSec === null}>
                              {cueNumName(c)}（{c.videoTimeSec === null ? '還沒有影片時間' : formatSwitchTime(c.videoTimeSec)}）
                            </option>
                          ))}
                          {r.cueId && !cueTimes.has(r.cueId) && <option value={r.cueId}>（這個 Cue 不見了）</option>}
                        </select>
                      ) : (
                        <input
                          className="tl-row__time"
                          type="text"
                          inputMode="decimal"
                          value={r.timeText}
                          placeholder="例：1:23.5 或 83"
                          onChange={(e) => update(r.key, { timeText: e.target.value })}
                          aria-label="換版型的時間"
                        />
                      )}
                      <label className="tl-row__cell">
                        <span>起換成</span>
                        <select value={r.templateId} onChange={(e) => update(r.key, { templateId: e.target.value })} aria-label="換成哪個版型">
                          <option value="">選一個版型…</option>
                          {templates.map(t => {
                            const same = !startTpl || sizeText(t) === sizeText(startTpl);
                            return <option key={t.id} value={t.id} disabled={!same && t.id !== r.templateId}>{t.name}（{sizeText(t)}）{same ? '' : ' 大小不同，不能用'}</option>;
                          })}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="tl-row__del"
                        onClick={() => setRows(list => list.filter(x => x.key !== r.key))}
                        title="拿掉這個換版型的點"
                        aria-label="拿掉這個換版型的點"
                      ><Icon icon={Trash2} /></button>
                      {problem && <span className="tl-row__problem">{problem}</span>}
                    </li>
                  );
                })}
              </ul>
              <button type="button" className="btn btn--ghost tl-dlg__add" onClick={addRow} disabled={rows.length >= MAX_SWITCHES || templates.length === 0 || !start}>
                <Icon icon={Plus} /> 加一個換版型的點{!start && templates.length > 0 ? '（先選開頭的版型）' : ''}
              </button>
            </>
          )}

          {(preview.sorted.length > 0 || preview.notes.length > 0) && startTpl && (
            <div className="tl-dlg__preview" aria-live="polite">
              <div className="tl-dlg__preview-title">會這樣換</div>
              <ol>
                <li>開頭用「{startTpl.name}」</li>
                {preview.sorted.map((t, i) => <li key={i}>{t}</li>)}
              </ol>
              {preview.notes.map((t, i) => <p key={i} className="tl-dlg__warn"><Icon icon={TriangleAlert} /> {t}</p>)}
            </div>
          )}

          {(checkError || serverError) && (
            <p className="tl-dlg__error" role="alert"><Icon icon={TriangleAlert} /> {checkError || serverError}</p>
          )}
        </div>
        <footer className="dlg__footer tl-dlg__footer">
          <span className="muted small tl-dlg__note">已經交的影片版本不會變：每一版上傳的那一刻就記住了當時的換版型設定。</span>
          <button className="btn btn--ghost" onClick={onClose}>取消</button>
          <button className="btn btn--primary" onClick={() => { void save(); }} disabled={!canSave}>
            {saving ? '存檔中…' : '儲存'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * 歌單上這首歌換版型的幾句話：「從 Cue 4（1:23.0）起換成「版型 B」」，照時間排。
 * 沒有任何換版型的點 = 不顯示。算不出時間的點（Cue 沒有影片時間）用小字提醒。
 */
export function SongTimelineSummary({ switches, templates, cueTimes }: {
  switches: readonly TimelineSwitch[];
  templates: readonly { id: string; name: string }[];
  cueTimes?: CueTimes;
}) {
  if (switches.length === 0) return null;
  const nameOf = (id: string) => templates.find(t => t.id === id)?.name ?? '（版型不見了）';
  const lines = switches.map((sw, i) => {
    const at = switchTime(sw, cueTimes);
    const cueName = sw.cueId ? (cueTimes?.get(sw.cueId)?.name ?? sw.cueName ?? 'Cue') : null;
    return at === null
      ? { key: sw.id || String(i), at: Number.POSITIVE_INFINITY, text: unresolvedSwitchText(cueName, nameOf(sw.templateId)), warn: true }
      : { key: sw.id || String(i), at, text: switchSentence(cueName, at, nameOf(sw.templateId)), warn: false };
  }).sort((a, b) => a.at - b.at);
  return (
    <ul className="tl-summary" aria-label="這首歌中途換版型的設定">
      {lines.map(l => <li key={l.key} className={l.warn ? 'is-warn' : ''}>{l.text}</li>)}
    </ul>
  );
}
