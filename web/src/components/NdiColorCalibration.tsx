// 「校正 AE 即時顏色」對話框：下載校正圖 → 放進 AE → 按「校正」→ 量收到的畫面、算曲線、存在這台電腦。
// 3D 舞台（NDI 小視窗、⋯ 選單）和設定頁都用這個。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, LoaderCircle, Palette, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import Icon from './Icon';
import { calibrateFromFrame, CHART_DOWNLOAD_SIZE, renderChart, type CalibrationResult, type RgbaFrame } from '../lib/ndiCalibration';
import {
  clearCalibration, loadCalibration, pickNdiColorCurve, saveCalibration, subscribeCalibration, type NdiColorCalibration,
} from '../lib/ndiColor';
import { grabNdiFrame } from '../lib/ndiFrameGrab';
import { downloadBlob } from '../lib/ledMapDraw';
import type { NdiColorPipeline } from '../lib/ndiSteps';
import { toast } from '../lib/toast';
import './NdiColorCalibration.css';

/** 表格只列這幾格（全部 15 格太長） */
const SHOW_PATCHES = [0, 16, 32, 64, 128, 192, 235, 255];

export const CHART_FILE_NAME = 'stage-previz-AE即時顏色校正圖.png';

/** 這台電腦的校正（別的分頁 / 對話框改了會跟著變） */
export function useNdiCalibration(): NdiColorCalibration | null {
  const [cal, setCal] = useState<NdiColorCalibration | null>(() => loadCalibration());
  useEffect(() => subscribeCalibration(() => setCal(loadCalibration())), []);
  return cal;
}

/** 現在用哪條曲線（一句話） */
export function colorCurveLabel(pipeline: NdiColorPipeline | null, sourceIsAe: boolean, cal: NdiColorCalibration | null): string {
  const c = pickNdiColorCurve(pipeline, sourceIsAe, cal);
  if (c.kind === 'calibrated') return `這台電腦的校正${cal?.createdAt ? `（${formatTime(cal.createdAt)}）` : ''}`;
  if (c.kind === 'default') return '預設（AE 量好的曲線）';
  if (pipeline == null) return '不另外校正（小程序是舊版，顏色照以前）';
  if (pipeline === 'limited_to_full') return '不另外校正（小程序設定成拉伸色域）';
  return '不另外校正（來源不是 After Effects）';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 下載校正圖（3840×2160 PNG） */
export async function downloadCalibrationChart(): Promise<void> {
  const { width, height } = CHART_DOWNLOAD_SIZE;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('瀏覽器不能畫圖');
  ctx.putImageData(new ImageData(renderChart(width, height), width, height), 0, 0);
  const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('做不出圖檔');
  downloadBlob(blob, CHART_FILE_NAME);
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 小程序的顏色處理（guide.colorPipeline）；null = 舊版 / 還沒連上 */
  pipeline: NdiColorPipeline | null;
  /** 連上小程序了嗎（guide.helperVersion != null） */
  helperConnected: boolean;
  /** 目前的來源是 AE */
  sourceIsAe: boolean;
  source: string | null;
  /** 3D 舞台：直接拿正在顯示的那張畫面；沒有 → 自己連小程序拿一張 */
  getFrame?: () => RgbaFrame | null;
  ndiUrl?: string;
}

type Phase = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; result: CalibrationResult } | { kind: 'error'; message: string };

export default function NdiColorCalibrationDialog({ open, onClose, pipeline, helperConnected, sourceIsAe, source, getFrame, ndiUrl }: Props) {
  const cal = useNdiCalibration();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [downloading, setDownloading] = useState(false);
  const firstButton = useRef<HTMLButtonElement | null>(null);
  // 外面每次重畫都會給新的 onClose → 放 ref，不然結果一顯示就被清掉
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 打開時：清掉上一次的結果、焦點放第一個按鈕、Esc 關掉
  useEffect(() => {
    if (!open) return;
    setPhase({ kind: 'idle' });
    const t = window.setTimeout(() => firstButton.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const canCalibrate = helperConnected && pipeline === 'raw';
  const currentLabel = useMemo(() => colorCurveLabel(pipeline, sourceIsAe, cal), [pipeline, sourceIsAe, cal]);

  const run = useCallback(async () => {
    setPhase({ kind: 'busy' });
    try {
      let frame = getFrame?.() ?? null;
      let pipe = pipeline;
      if (!frame) {
        const got = await grabNdiFrame(ndiUrl);
        frame = got.frame;
        pipe = got.colorPipeline ?? pipe;
      }
      if (pipe !== 'raw') {
        setPhase({ kind: 'error', message: '小程序要更新到 0.1.13 以上才能校正（舊版會先把顏色拉伸過，量不準）' });
        return;
      }
      // 「校正前」= 現在用的曲線（換過來源也照現在的算）
      const current = pickNdiColorCurve(pipe, sourceIsAe, loadCalibration()).lut;
      const r = calibrateFromFrame(frame, current);
      if (!r.ok) {
        setPhase({ kind: 'error', message: r.message });
        return;
      }
      const saved = saveCalibration({
        version: 1,
        createdAt: new Date().toISOString(),
        pipeline: pipe,
        afterEffects: sourceIsAe,
        source,
        r: Array.from(r.lut.r), g: Array.from(r.lut.g), b: Array.from(r.lut.b),
        before: r.before,
        after: r.after,
      });
      if (!saved) toast.error('瀏覽器不准存資料（無痕模式？），這次的校正關掉頁面就沒了');
      setPhase({ kind: 'done', result: r });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [getFrame, ndiUrl, pipeline, sourceIsAe, source]);

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      await downloadCalibrationChart();
    } catch (e) {
      toast.error('校正圖沒有下載成功：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDownloading(false);
    }
  }, []);

  const reset = useCallback(() => {
    clearCalibration();
    setPhase({ kind: 'idle' });
    toast.success('已經回到預設的顏色曲線');
  }, []);

  if (!open) return null;
  const busy = phase.kind === 'busy';

  return createPortal(
    <div className="sp-dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="sp-dialog ndi-cal" role="dialog" aria-modal="true" aria-labelledby="ndi-cal-title">
        <div className="sp-dialog__head">
          <span className="sp-dialog__icon"><Icon icon={Palette} size="md" /></span>
          <h2 id="ndi-cal-title" className="sp-dialog__title">校正 AE 即時顏色</h2>
          <button type="button" className="ndi-cal__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </div>

        <p className="ndi-cal__lead">
          AE 經過 NDI 送過來的顏色會偏一點（黑色變灰）。網頁會自動校正；想要更準，可以用你這台電腦量一次。
        </p>
        <p className="ndi-cal__now">現在用的顏色曲線：<strong>{currentLabel}</strong></p>

        {!helperConnected && <p className="ndi-cal__warn">還沒連上 NDI 小程序：先打開「AE 即時」，連上之後再來校正。</p>}
        {helperConnected && pipeline !== 'raw' && (
          <p className="ndi-cal__warn">小程序要更新到 0.1.13 以上才能校正（舊版的顏色照以前顯示）。</p>
        )}

        <ol className="ndi-cal__steps">
          <li>
            下載校正圖，拖進 AE 的合成，<strong>放大到差不多填滿合成</strong>（選圖層按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>，Mac 是 <kbd>Cmd</kbd>+<kbd>Option</kbd>+<kbd>F</kbd>）。
            不要加效果、不要調顏色。
            <div>
              <button ref={firstButton} type="button" className="btn btn--ghost btn--sm" onClick={() => void download()} disabled={downloading}>
                <Icon icon={downloading ? LoaderCircle : Download} spin={downloading} /> {downloading ? '正在做校正圖…' : '下載校正圖（PNG）'}
              </button>
            </div>
          </li>
          <li>合成視窗下方的解析度選 <strong>Full（完整）</strong>，按空白鍵播放，3D 舞台的 LED 上看得到校正圖。</li>
          <li>按「校正」。量好會存在<strong>這台電腦的這個瀏覽器</strong>，之後 AE 即時都用它。</li>
        </ol>

        {phase.kind === 'busy' && <p className="ndi-cal__status"><Icon icon={LoaderCircle} spin /> 正在量…</p>}
        {phase.kind === 'error' && <p className="ndi-cal__warn" role="alert">{phase.message}</p>}
        {phase.kind === 'done' && <CalibrationSummary result={phase.result} />}

        <div className="sp-dialog__actions ndi-cal__actions">
          <button type="button" className="sp-dialog__btn sp-dialog__btn--ghost" onClick={reset} disabled={busy || !cal}>
            <Icon icon={RotateCcw} /> 回到預設
          </button>
          <button type="button" className="sp-dialog__btn sp-dialog__btn--primary" onClick={() => void run()} disabled={busy || !canCalibrate}>
            <Icon icon={SlidersHorizontal} /> {phase.kind === 'done' || cal ? '重新校正' : '校正'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CalibrationSummary({ result }: { result: CalibrationResult }) {
  const rows = result.grey.filter(g => SHOW_PATCHES.includes(g.value));
  return (
    <div className="ndi-cal__result" role="status">
      <p>
        量好了，已經存起來：灰階平均差 <strong>{result.before.mean} 階 → {result.after.mean} 階</strong>
        （最多差 {result.before.max} → {result.after.max} 階）。
      </p>
      <table className="ndi-cal__table">
        <thead>
          <tr><th>原本的灰</th><th>收到的</th><th>校正前顯示</th><th>校正後顯示</th></tr>
        </thead>
        <tbody>
          {rows.map(g => (
            <tr key={g.value}>
              <td>{g.value}</td>
              <td>{Math.round(g.received)}</td>
              <td>{Math.round(g.before)}</td>
              <td>{Math.round(g.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.location.method === 'fullFrame' && (
        <p className="ndi-cal__note">（四個角的記號有點糊，照「校正圖填滿畫面」量的；結果怪怪的話請把校正圖放大到填滿合成再量一次）</p>
      )}
    </div>
  );
}
