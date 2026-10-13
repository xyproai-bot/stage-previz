// 機關總表（給自動化控台操作員）：CSV，用 Excel 打開；整個專案每首歌、每個正式 cue、每個機關一行，下面附機關說明。
// 跟機關分頁的提醒用同一套計算（track.ts 沿用、motion.ts 速度檢查）→ 總表跟畫面上說的一模一樣。
//
// 檔案格式：UTF-8 加 BOM（不然 Windows 的 Excel 中文會亂碼）、CRLF 換行、逗號分隔、RFC 4180 引號。
// 文字開頭是 = + - @ → 前面加 '（不讓 Excel 當成公式）；數字欄位不加（負數照樣是數字）。
// 數字：公尺 3 位小數（毫米）、度 1 位、秒 1 位、速度 m/秒 3 位 / °/秒 1 位；時間用影片時間 m:ss.s。

import {
  LINEAR_DIRECTIONS, ROTARY_AXES, matchLinearDirection, matchRotaryAxis, presetAt, unitOf,
  type CueMechanismPosition, type Mechanism, type MechVec3,
} from './model';
import { ownValuesByCue, resolveSongMechanisms } from './track';
import { checkSongMechanisms, cueGoTimes, formatSeconds, type MechCheck, type MotionCue } from './motion';

export interface SheetSong {
  id: string;
  name: string;
  code: string | null;
  order: number;
  cues: { id: string; name: string; order: number; videoTimeSec: number | null; crossfadeSeconds: number }[];
}

export interface SheetInput {
  songs: SheetSong[];
  positions: CueMechanismPosition[];
  mechanisms: Mechanism[];
  /** 舞台正面（說明裡的「往左 / 往觀眾」）；沒有 → +Z */
  front?: MechVec3 | null;
}

type Cell = { t: 'text'; v: string } | { t: 'num'; v: string } | null;
const text = (v: string | null | undefined): Cell => (v ? { t: 'text', v } : null);
const numCell = (v: string | null): Cell => (v === null ? null : { t: 'num', v });

export const SHEET_HEADER = [
  '歌曲 Song', 'Cue #', 'Cue 名稱 Cue name', 'GO 時間 GO', '到位時間 Arrive', '轉場(秒) Move s', '機關 Axis', '控台編號 Console',
  '起點 From', '目標 Target', '單位 Unit', '常用位置 Preset', '行程 Distance', '可用(秒) Avail s', '需要(秒) Need s',
  '速度(單位/秒) Speed', '最高速度 Max', '檢查 Check',
];

/** 影片時間 m:ss.s（0:00.0、1:05.0） */
export function sheetTime(sec: number): string {
  const t = Math.round(Math.max(0, sec) * 10) / 10;
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

const fixed = (v: number, d: number) => { const s = v.toFixed(d); return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s; };
const valueText = (v: number, kind: Mechanism['kind']) => fixed(v, kind === 'rotary' ? 1 : 3);
const trimNum = (v: number) => String(Math.round(v * 1000) / 1000);

function checkText(c: MechCheck): string {
  switch (c.status) {
    case 'start': return '起始位置';
    case 'still': return c.lateBy ? `會晚 ${formatSeconds(c.lateBy)} 秒到位` : '不動';
    case 'noSpeed': return '沒填最高速度';
    case 'ok': return c.lateBy ? `會晚 ${formatSeconds(c.lateBy)} 秒到位` : 'OK';
    case 'tooFast':
      return c.fix !== null ? `太快：轉場要 ${formatSeconds(c.fix)} 秒` : `太快：跟上一個 cue 只隔 ${formatSeconds(c.gap ?? 0)} 秒`;
  }
}

/** 表格的每一行（還沒變成 CSV） */
export function sheetRows(input: SheetInput): Cell[][] {
  const mechs = [...input.mechanisms].sort((a, b) => a.order - b.order);
  const own = ownValuesByCue(input.positions);
  const rows: Cell[][] = [];
  for (const song of [...input.songs].sort((a, b) => a.order - b.order)) {
    const cues: (MotionCue & { name: string })[] = [...song.cues]
      .sort((a, b) => a.order - b.order)
      .map(c => ({ ...c, status: 'master' }));
    if (!cues.length) continue;
    const resolved = resolveSongMechanisms(mechs, cues, own);
    const check = checkSongMechanisms(mechs, cues, resolved);
    const go = cueGoTimes(cues);
    const songLabel = song.code ? `${song.code} ${song.name}` : song.name;
    cues.forEach((cue, i) => {
      const times = go.get(cue.id);
      for (const m of mechs) {
        const c = check.cues.get(cue.id)?.items[m.id];
        if (!c) continue;
        const moving = c.status === 'ok' || c.status === 'tooFast' || c.status === 'noSpeed';
        const preset = presetAt(m.presets, c.to);
        const speed = moving && c.available && c.available > 0
          ? fixed(c.distance / c.available, m.kind === 'rotary' ? 1 : 3) : null;
        rows.push([
          text(songLabel),
          numCell(String(i + 1)),
          text(cue.name),
          text(times ? sheetTime(times.go) : null),
          text(times ? sheetTime(times.arrive) : null),
          numCell(formatSeconds(cue.crossfadeSeconds || 0)),
          text(m.name),
          text(m.consoleLabel),
          numCell(c.from === null ? null : valueText(c.from, m.kind)),
          numCell(valueText(c.to, m.kind)),
          text(unitOf(m.kind)),
          text(preset?.name),
          numCell(c.status === 'start' ? null : valueText(c.distance, m.kind)),
          numCell(moving && c.available !== null ? fixed(c.available, 1) : null),
          numCell((c.status === 'ok' || c.status === 'tooFast') && c.need !== null ? fixed(c.need, 1) : null),
          numCell(speed),
          numCell(m.maxSpeed === null ? null : trimNum(m.maxSpeed)),
          text(checkText(c)),
        ]);
      }
    });
  }
  return rows;
}

/** 機關說明（表格下面） */
export function sheetLegend(mechanisms: Mechanism[], front?: MechVec3 | null): string[] {
  const f = front ?? { x: 0, y: 0, z: 1 };
  const lines = ['# 機關說明 Axes'];
  for (const m of [...mechanisms].sort((a, b) => a.order - b.order)) {
    const unit = unitOf(m.kind);
    const u = (v: number) => (unit === '°' ? `${trimNum(v)}°` : `${trimNum(v)} m`);
    const head = m.consoleLabel ? `${m.name}（${m.consoleLabel}）` : m.name;
    let dir: string;
    if (m.kind === 'linear') {
      const d = matchLinearDirection(m.axis, f).dir;
      const label = LINEAR_DIRECTIONS.find(x => x.key === d)!.label;
      dir = `直線，0 = cue 裡原本的位置，正的數字${label}${d === 'left' || d === 'right' ? '（觀眾看過去）' : ''}`;
    } else {
      const r = matchRotaryAxis(m.axis, f);
      const axis = ROTARY_AXES.find(x => x.key === r.kind)!;
      // 「旋轉・水平轉（像轉台）」：轉軸的名字本身有括號，外面不再包一層（以前會變成「旋轉（水平轉（像轉台））」）
      dir = `旋轉・${axis.label}，0 = 模型原本的方向，正的角度${axis.positive[r.positiveFirst ? 0 : 1]}`;
    }
    const parts = [
      `${head}：${dir}`,
      `行程 ${u(m.travelMin)} ~ ${u(m.travelMax)}`,
      m.maxSpeed !== null ? `最高 ${trimNum(m.maxSpeed)}${unit === '°' ? '°' : ' m'}/秒` : '沒填最高速度（不檢查）',
    ];
    if (m.presets.length) parts.push(`常用位置 ${m.presets.map(p => `${p.name} ${trimNum(p.value)}`).join(' / ')}`);
    lines.push(`# ${parts.join('；')}`);
  }
  lines.push('# 註：需要秒數 = 行程 ÷ 最高速度，以等速計算、沒有算加減速，實際會再久一點。GO 時間 = 到位時間 − 可用秒數；沒有影片時間的 cue 由現場叫 GO。');
  return lines;
}

/** 一格 → CSV 文字：文字開頭是 = + - @ 前面加 '；有逗號 / 引號 / 換行就加引號 */
export function csvCell(c: Cell): string {
  if (!c) return '';
  let v = c.v;
  if (c.t === 'text' && /^[=+\-@]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildMechanismSheetCsv(input: SheetInput): string {
  const lines = [
    SHEET_HEADER.map(h => csvCell(text(h))).join(','),
    ...sheetRows(input).map(r => r.map(csvCell).join(',')),
    '',
    ...sheetLegend(input.mechanisms, input.front).map(l => csvCell(text(l))),
  ];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** 機關總表-{專案}-{yyyy-mm-dd}.csv（檔名不能用的字換成 _） */
export function sheetFileName(projectName: string, date = new Date()): string {
  const safe = (projectName || '專案').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || '專案';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `機關總表-${safe}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}

/** 在瀏覽器下載 */
export function downloadMechanismSheet(csv: string, fileName: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
