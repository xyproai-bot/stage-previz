// LED 版型的「座標表」（給 LED 工程師、d3 操作員看的）：一塊螢幕一列，寫清楚這塊螢幕在版型畫布上放在哪裡、
// 轉了沒、翻了沒、真實有幾個點、縮了幾 %、對應整張畫布的哪一塊。純函式（CSV / JSON 的字都在這裡），ledTemplateTable.test.ts 有測。
//
// 座標：原點在左上角、y 朝下，單位是像素。轉向是「在版型畫布上看到的樣子」順時針轉幾度（0 / 90 / 180 / 270），轉完再左右 / 上下翻。
// 整張畫布 = 專案的 LED 畫布（AE 的「全部」合成），螢幕真實的點數、位置都從它來。

import { csvCell, safeName, spanToPixels, type CanvasSize } from './ledMap';
import { checkPlacements, formatPct, rotatedDims, type LedTemplatePlan, type Rotation, type ScreenDef } from './ledTemplate';
import { layoutPattern } from './ledTemplatePattern';
import { segmentWhere, switchSentence, type LedTimeline } from './ledTemplateTimeline';

export interface TemplateTableMeta {
  projectName: string;
  /** yyyy-mm-dd */
  date: string;
  /** 專案的 LED 畫布（整張畫布） */
  fullCanvas: CanvasSize;
}

export interface TemplateTableRow {
  key: string;
  name: string;
  /** 在版型畫布上的位置和大小（轉完以後的外框） */
  x: number; y: number; w: number; h: number;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** 螢幕真實的點數 */
  nativeW: number; nativeH: number;
  /** 橫、直各縮成真實點數的幾 %（被拉伸時兩個不一樣） */
  scaleX: number; scaleY: number;
  /** 在整張畫布上的哪一塊（跨過畫布邊緣的，x + w 會超過畫布寬） */
  source: { x: number; y: number; w: number; h: number; wrapsX: boolean; wrapsY: boolean };
  /** 要提醒的事：被拉伸 / 超出版型畫布 / 和別塊重疊 */
  notes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const overlaps = (a: TemplateTableRow, b: TemplateTableRow) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 一塊螢幕一列（照版型裡的放法排；模型裡找不到的螢幕略過） */
export function templateTableRows(plan: LedTemplatePlan, defs: readonly ScreenDef[], fullCanvas: CanvasSize): TemplateTableRow[] {
  const defByKey = new Map(defs.map(d => [d.key, d]));
  const issues = checkPlacements({ ...plan, screens: plan.screens.filter(p => defByKey.has(p.key)) }, defs);
  const rows: TemplateTableRow[] = layoutPattern(plan, defs).map(it => {
    const def = defByKey.get(it.key)!;
    const r = rotatedDims(def.nativeW, def.nativeH, it.rotate);
    const px = spanToPixels({ start: def.src.us, length: def.src.ul, wraps: false }, fullCanvas.width);
    const py = spanToPixels({ start: def.src.vs, length: def.src.vl, wraps: false }, fullCanvas.height);
    const notes: string[] = [];
    if (issues.some(i => i.key === it.key && i.kind === 'stretch')) notes.push('被拉伸');
    if (issues.some(i => i.key === it.key && i.kind === 'outside')) notes.push('超出版型畫布');
    return {
      key: it.key, name: it.name,
      x: it.dest.x, y: it.dest.y, w: it.dest.w, h: it.dest.h,
      rotate: it.rotate, flipH: it.flipH, flipV: it.flipV,
      nativeW: def.nativeW, nativeH: def.nativeH,
      scaleX: round2((it.dest.w / Math.max(1, r.w)) * 100),
      scaleY: round2((it.dest.h / Math.max(1, r.h)) * 100),
      source: { x: px.pos, y: py.pos, w: def.nativeW, h: def.nativeH, wrapsX: px.pos + def.nativeW > fullCanvas.width, wrapsY: py.pos + def.nativeH > fullCanvas.height },
      notes,
    };
  });
  for (const a of rows) if (rows.some(b => b !== a && overlaps(a, b))) a.notes.push('和別塊重疊');
  return rows;
}

/** 「比例 %」那一格：橫直一樣就是一個數字；被拉伸就寫「橫 50 / 直 40」 */
export function scaleText(row: Pick<TemplateTableRow, 'scaleX' | 'scaleY'>): string {
  const same = Math.abs(row.scaleX - row.scaleY) <= Math.max(0.5, Math.max(row.scaleX, row.scaleY) * 0.005);
  return same ? String(row.scaleX) : `橫 ${row.scaleX} / 直 ${row.scaleY}`;
}

const size = (c: CanvasSize) => `${c.width}×${c.height}`;
const yesNo = (v: boolean) => (v ? '是' : '否');

/** 表最上面的兩行說明：版型名稱、畫布大小、比例；座標怎麼看 */
export function templateTableHeaderLines(plan: Pick<LedTemplatePlan, 'name' | 'canvas' | 'scalePct'>, meta: TemplateTableMeta): string[] {
  return [
    `版型「${plan.name}」 · 版型畫布 ${size(plan.canvas)} 像素 · 比例 ${formatPct(plan.scalePct)} · 專案 ${meta.projectName || '（未命名）'} · 整張畫布 ${size(meta.fullCanvas)} · ${meta.date}`,
    '座標原點在左上角、y 朝下，單位是像素 · 轉向是順時針轉幾度，轉完再翻 · 整張畫布 x y w h = 這塊螢幕在整張畫布上的位置',
  ];
}

export const TEMPLATE_TABLE_COLUMNS = [
  '名稱', '版型 x', '版型 y', '版型 w', '版型 h', '轉向', '左右翻', '上下翻',
  '實際點數 W×H', '比例 %', '整張畫布 x', '整張畫布 y', '整張畫布 w', '整張畫布 h', '備註',
] as const;

/** 座標表 CSV（Excel 打得開：前面有 BOM、換行 CRLF、中文不會亂碼） */
export function templateTableToCsv(plan: LedTemplatePlan, defs: readonly ScreenDef[], meta: TemplateTableMeta): string {
  const lines: (string | number)[][] = templateTableHeaderLines(plan, meta).map(l => [l]);
  lines.push([...TEMPLATE_TABLE_COLUMNS]);
  for (const r of templateTableRows(plan, defs, meta.fullCanvas)) {
    const notes = [...r.notes];
    if (r.source.wrapsX && r.source.wrapsY) notes.push('整張畫布上跨畫布邊緣（左右、上下）');
    else if (r.source.wrapsX) notes.push('整張畫布上跨畫布左右邊緣');
    else if (r.source.wrapsY) notes.push('整張畫布上跨畫布上下邊緣');
    lines.push([
      r.name, r.x, r.y, r.w, r.h, r.rotate, yesNo(r.flipH), yesNo(r.flipV),
      `${r.nativeW}×${r.nativeH}`, scaleText(r),
      r.source.x, r.source.y, r.source.w, r.source.h,
      notes.join('；'),
    ]);
  }
  return '﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 座標表 JSON（給程式讀；欄位都是數字 / 布林） */
export function templateTableToJson(plan: LedTemplatePlan, defs: readonly ScreenDef[], meta: TemplateTableMeta): string {
  return JSON.stringify({
    project: meta.projectName,
    date: meta.date,
    template: { id: plan.id, name: plan.name, canvas: { width: plan.canvas.width, height: plan.canvas.height }, scalePct: plan.scalePct },
    fullCanvas: { width: meta.fullCanvas.width, height: meta.fullCanvas.height },
    origin: 'top-left',
    rotateUnit: 'degrees-clockwise',
    screens: templateTableRows(plan, defs, meta.fullCanvas).map(r => ({
      key: r.key,
      name: r.name,
      x: r.x, y: r.y, w: r.w, h: r.h,
      rotate: r.rotate,
      flipH: r.flipH,
      flipV: r.flipV,
      native: { w: r.nativeW, h: r.nativeH },
      scalePct: { x: r.scaleX, y: r.scaleY },
      source: r.source,
      notes: r.notes,
    })),
  }, null, 2) + '\n';
}

/** 檔名：LED座標表-主舞臺-版型 1-1920x1080.csv */
export function templateTableFileName(kind: 'csv' | 'json', projectName: string | undefined, plan: Pick<LedTemplatePlan, 'name' | 'canvas'>): string {
  return `LED座標表-${safeName(projectName || '')}-${safeName(plan.name)}-${plan.canvas.width}x${plan.canvas.height}.${kind}`;
}

// ───────────────────────── 版型時間線（同一首歌中途換版型）─────────────────────────
// 一個區段一個版型（同一個版型出現好幾段只寫一次，標題列出是第幾段）；每一段的畫布大小都一樣，座標都是「同一個 AE 合成裡的像素」。

export interface TimelineTableMeta extends TemplateTableMeta {
  /** 這首歌的名字（表頭、檔名用）；可以沒有 */
  songName?: string;
}

export interface TimelineTableSection {
  templateId: string;
  plan: LedTemplatePlan;
  /** 這個版型用在第幾段（從 1 算） */
  segmentNumbers: number[];
  /** 標題：「第 1 段 · 開頭 · 版型「版型 A」」 */
  title: string;
  rows: TemplateTableRow[];
}

/** 時間線每個版型一個區段（照第一次出現的順序） */
export function timelineTableSections(tl: LedTimeline, defs: readonly ScreenDef[], fullCanvas: CanvasSize): TimelineTableSection[] {
  const out: TimelineTableSection[] = [];
  tl.segments.forEach((seg, i) => {
    let sec = out.find(x => x.templateId === seg.templateId);
    if (!sec) {
      sec = { templateId: seg.templateId, plan: seg.plan, segmentNumbers: [], title: '', rows: templateTableRows(seg.plan, defs, fullCanvas) };
      out.push(sec);
    }
    sec.segmentNumbers.push(i + 1);
  });
  for (const sec of out) {
    const wheres = sec.segmentNumbers.map(n => segmentWhere(tl.segments[n - 1].label, tl.segments[n - 1].fromSec));
    sec.title = `第 ${sec.segmentNumbers.join('、')} 段 · ${wheres.join('、')} · 版型「${sec.plan.name}」`;
  }
  return out;
}

/** 表最上面的說明：這首歌、畫布大小、怎麼換版型；座標怎麼看 */
export function timelineTableHeaderLines(tl: LedTimeline, meta: TimelineTableMeta): string[] {
  const c = tl.segments[0].plan.canvas;
  const how = tl.segments.map((s, i) => (i === 0 ? `開頭用「${s.plan.name}」` : switchSentence(s.label, s.fromSec, s.plan.name))).join('；');
  return [
    `版型時間線（中途換版型）${meta.songName ? ` · 歌「${meta.songName}」` : ''} · 版型畫布 ${size(c)} 像素（每一段都一樣大，一個影片檔）· 共 ${tl.segments.length} 段 · 專案 ${meta.projectName || '（未命名）'} · 整張畫布 ${size(meta.fullCanvas)} · ${meta.date}`,
    how,
    '座標原點在左上角、y 朝下，單位是像素 · 轉向是順時針轉幾度，轉完再翻 · 每個區段是一個版型的排法；到了換版型的時間，影片裡每塊螢幕的位置就改成下一個區段的座標',
  ];
}

/** 一塊螢幕在 CSV 裡的一列（單一版型和時間線共用） */
function csvRow(r: TemplateTableRow): (string | number)[] {
  const notes = [...r.notes];
  if (r.source.wrapsX && r.source.wrapsY) notes.push('整張畫布上跨畫布邊緣（左右、上下）');
  else if (r.source.wrapsX) notes.push('整張畫布上跨畫布左右邊緣');
  else if (r.source.wrapsY) notes.push('整張畫布上跨畫布上下邊緣');
  return [
    r.name, r.x, r.y, r.w, r.h, r.rotate, yesNo(r.flipH), yesNo(r.flipV),
    `${r.nativeW}×${r.nativeH}`, scaleText(r),
    r.source.x, r.source.y, r.source.w, r.source.h,
    notes.join('；'),
  ];
}

/** 時間線座標表 CSV：每個版型一個區段，中間空一行（Excel 打得開：前面有 BOM、換行 CRLF） */
export function timelineTableToCsv(tl: LedTimeline, defs: readonly ScreenDef[], meta: TimelineTableMeta): string {
  const lines: (string | number)[][] = timelineTableHeaderLines(tl, meta).map(l => [l]);
  for (const sec of timelineTableSections(tl, defs, meta.fullCanvas)) {
    lines.push([]);
    lines.push([sec.title]);
    lines.push([...TEMPLATE_TABLE_COLUMNS]);
    for (const r of sec.rows) lines.push(csvRow(r));
  }
  return '﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 時間線座標表 JSON（給程式讀） */
export function timelineTableToJson(tl: LedTimeline, defs: readonly ScreenDef[], meta: TimelineTableMeta): string {
  const c = tl.segments[0].plan.canvas;
  return JSON.stringify({
    project: meta.projectName,
    song: meta.songName ?? null,
    date: meta.date,
    canvas: { width: c.width, height: c.height },
    fullCanvas: { width: meta.fullCanvas.width, height: meta.fullCanvas.height },
    origin: 'top-left',
    rotateUnit: 'degrees-clockwise',
    segments: tl.segments.map((s, i) => ({
      index: i + 1,
      fromSec: s.fromSec,
      toSec: i + 1 < tl.segments.length ? tl.segments[i + 1].fromSec : null,
      label: s.label,
      templateId: s.templateId,
      templateName: s.plan.name,
    })),
    templates: timelineTableSections(tl, defs, meta.fullCanvas).map(sec => ({
      id: sec.templateId,
      name: sec.plan.name,
      scalePct: sec.plan.scalePct,
      segments: sec.segmentNumbers,
      screens: sec.rows.map(r => ({
        key: r.key, name: r.name,
        x: r.x, y: r.y, w: r.w, h: r.h,
        rotate: r.rotate, flipH: r.flipH, flipV: r.flipV,
        native: { w: r.nativeW, h: r.nativeH },
        scalePct: { x: r.scaleX, y: r.scaleY },
        source: r.source,
        notes: r.notes,
      })),
    })),
  }, null, 2) + '\n';
}

/** 檔名：LED座標表-主舞臺-開場-版型時間線-4400x200.csv */
export function timelineTableFileName(kind: 'csv' | 'json', projectName: string | undefined, songName: string | undefined, canvas: CanvasSize): string {
  return `LED座標表-${safeName(projectName || '')}-${songName ? `${safeName(songName)}-` : ''}版型時間線-${canvas.width}x${canvas.height}.${kind}`;
}
