// LED 版型時間線（第 3 階段：同一首歌中途換版型）。純函式，沒有畫面、不碰網路；後台（cf-worker/ledTemplates.mjs）跟前端共用。
//
// 為什麼要有：LED 的形狀會在一首歌中間變（機關打開、螢幕飛進來），動畫師同一首歌的影片可能前半段用版型 A 的排法、
// 到某個 Cue 或某個時間以後用版型 B 的排法。仍然是「一個影片檔」，只是檔案裡每塊螢幕放的位置在換版型的那一格換掉。
//
// 資料長什麼樣子：
//   歌          songs.template_id（開頭用的版型，跟以前一樣）+ song_template_switches（換版型的點，最多 12 個）
//   換版型的點  用 Cue（跟著 Cue 的影片時間走，Cue 的時間改了它跟著動）或直接寫一個時間（秒）
//   影片版本    上傳那一刻把整條時間線存成快照（cue 的時間也在那一刻定下來，之後 Cue 動了，舊影片照舊貼對）
//
// 畫布大小規則（選「一樣大」，不選「等比例」）：同一首歌時間線裡所有版型的畫布大小要完全一樣。
//   理由：影片只有一個檔、一個大小；AE 合成也只有一個大小，座標表上每個版型的座標都是「這個合成裡的像素」，
//   一樣大才不用在腦子裡換算。（上傳影片的檢查另外允許等比例縮小，那是影片被壓縮的情況，跟版型之間的大小是兩回事。）
//
// 邊界規則：影格的時間 >= 換版型的時間 - 2 毫秒（SWITCH_EPS）就屬於新的那一段。
//   例：30 fps 的影片，Cue 在 83.0 秒 → 第 2490 格（83.0 秒）開始用新版型，第 2489 格（82.967 秒）還是舊的。

import { compareVideoToTemplate, formatPct, parsePlan, type LedTemplatePlan } from './ledTemplate.ts';
import type { CanvasSize } from './ledMap.ts';

export const MAX_SWITCHES = 12;
/** 影格時間比換版型的時間早不到這麼多秒，就算進新的那一段（吸收浮點誤差；比一格小很多） */
export const SWITCH_EPS = 0.002;
/** 換版型的時間上限（秒）：24 小時 */
export const MAX_SWITCH_SEC = 86400;

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// ───────────────────────── 時間的寫法 ─────────────────────────

/** 1:23.0 / 0:05.5 / 1:02:03.0（一位小數，跟畫面上的 Cue 時間同一個寫法） */
export function formatSwitchTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 10) / 10);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const ss = s.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * 使用者打的時間 → 秒。接受 83、83.5、1:23、1:23.5、1:02:03；看不懂 = null
 * （跟 Cue 的影片時間欄位同樣的寫法）
 */
export function parseSwitchTime(text: string): number | null {
  const t = text.trim().replace(/：/g, ':');
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!/^\d+(\.\d+)?$/.test(parts[i])) return null;
    const v = parseFloat(parts[i]);
    if (i > 0 && v >= 60) return null;
    total = total * 60 + v;
  }
  return total > MAX_SWITCH_SEC ? null : Math.round(total * 1000) / 1000;
}

// ───────────────────────── 換版型的點 ─────────────────────────

/** 後台存的一個換版型的點（GET songs 的 templateSwitches 裡的一筆） */
export interface TimelineSwitch {
  id: string;
  /** 用 Cue 換：Cue 的 id；直接寫時間 = null */
  cueId: string | null;
  /** 直接寫的時間（秒）；用 Cue 時是存檔那一刻 Cue 的時間（Cue 之後被清掉時間才用得到） */
  atSec: number | null;
  templateId: string;
  /** 後台一起給的 Cue 名字 / 目前的影片時間（唯讀；畫面有更新的 Cue 清單就用清單的） */
  cueName?: string | null;
  cueTimeSec?: number | null;
}

/** Cue id → { 名字, 影片時間 }（畫面上讀到的這首歌的 Cue 清單） */
export type CueTimes = ReadonlyMap<string, { name: string; timeSec: number | null }>;

/** 這個點現在是第幾秒；用 Cue 但 Cue 沒有影片時間（或已經不見了）= null */
export function switchTime(sw: Pick<TimelineSwitch, 'cueId' | 'atSec' | 'cueTimeSec'>, cues?: CueTimes): number | null {
  if (sw.cueId) {
    const live = cues?.get(sw.cueId);
    const t = live ? live.timeSec : (sw.cueTimeSec ?? null);
    return t !== null && Number.isFinite(t) && t >= 0 ? t : null;
  }
  return sw.atSec !== null && Number.isFinite(sw.atSec) && sw.atSec >= 0 ? sw.atSec : null;
}

export function switchCueName(sw: Pick<TimelineSwitch, 'cueId' | 'cueName'>, cues?: CueTimes): string | null {
  if (!sw.cueId) return null;
  return cues?.get(sw.cueId)?.name ?? sw.cueName ?? null;
}

/** 讀後台的 templateSwitches（壞資料略過；舊的後台沒有這個欄位 = 空） */
export function parseSwitches(raw: unknown): TimelineSwitch[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineSwitch[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.templateId !== 'string') continue;
    const cueId = typeof r.cueId === 'string' && r.cueId ? r.cueId : null;
    out.push({
      id: r.id, cueId, atSec: num(r.atSec), templateId: r.templateId,
      cueName: typeof r.cueName === 'string' ? r.cueName : null, cueTimeSec: num(r.cueTimeSec),
    });
  }
  return out.slice(0, MAX_SWITCHES);
}

// ───────────────────────── 時間線（畫面和影片快照用）─────────────────────────

export interface TimelineSegment {
  /** 這一段從第幾秒開始（第一段一定是 0） */
  fromSec: number;
  templateId: string;
  plan: LedTemplatePlan;
  /** 怎麼換過來的：「Cue 4」（用 Cue 的）；開頭和直接寫時間的 = null */
  label: string | null;
}

/** 至少兩段（只有一段就不是時間線，用單一版型） */
export interface LedTimeline {
  v: 1;
  segments: TimelineSegment[];
}

/**
 * 開頭的版型 + 換版型的點 → 時間線。
 *   沒有開頭版型（整張畫布）/ 沒有任何算得出時間的點 / 換完還是同一個版型 → null
 *   同一個時間有兩個點 → 排後面的算；換成跟上一段一樣的版型 → 併成一段
 */
export function buildTimeline(
  start: LedTemplatePlan | null,
  switches: readonly TimelineSwitch[],
  plans: ReadonlyMap<string, LedTemplatePlan>,
  cues?: CueTimes,
): LedTimeline | null {
  if (!start || !start.id) return null;
  const items: { at: number; order: number; plan: LedTemplatePlan; label: string | null }[] = [];
  switches.forEach((sw, order) => {
    const at = switchTime(sw, cues);
    const plan = plans.get(sw.templateId);
    if (at === null || !plan) return;
    items.push({ at, order, plan, label: switchCueName(sw, cues) });
  });
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  const segs: TimelineSegment[] = [{ fromSec: 0, templateId: start.id, plan: start, label: null }];
  for (const it of items) {
    const last = segs[segs.length - 1];
    const at = it.at <= SWITCH_EPS ? 0 : it.at;
    if (Math.abs(last.fromSec - at) <= SWITCH_EPS) {
      // 同一個時間：後面的蓋掉前面的（0 秒的點就是改開頭）
      segs[segs.length - 1] = { fromSec: last.fromSec, templateId: it.plan.id ?? '', plan: it.plan, label: at === 0 ? null : it.label };
      continue;
    }
    segs.push({ fromSec: at, templateId: it.plan.id ?? '', plan: it.plan, label: it.label });
  }
  const merged: TimelineSegment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.templateId === s.templateId) continue;
    merged.push(s);
  }
  return merged.length >= 2 ? { v: 1, segments: merged } : null;
}

/** 時間 t（秒）落在第幾段（0 起算）。邊界：>= 起點 - 2 毫秒 就算進那一段。t 不是數字 / 負的 = 第 0 段 */
export function segmentIndexAt(tl: { segments: readonly { fromSec: number }[] }, t: number): number {
  if (!Number.isFinite(t)) return 0;
  const segs = tl.segments;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].fromSec - SWITCH_EPS <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function planAt(tl: LedTimeline, t: number): LedTemplatePlan {
  return tl.segments[segmentIndexAt(tl, t)].plan;
}

/** 時間 t 之後的下一個換版型的點（已經在最後一段 = null） */
export function nextSwitchAfter(tl: LedTimeline, t: number): { index: number; segment: TimelineSegment } | null {
  const i = segmentIndexAt(tl, t) + 1;
  return i < tl.segments.length ? { index: i, segment: tl.segments[i] } : null;
}

/** 時間線的畫布（每一段都一樣大；用第一段的） */
export function timelineCanvas(tl: LedTimeline): CanvasSize {
  return tl.segments[0].plan.canvas;
}

// ───────────────────────── 說明文字 ─────────────────────────

/** 「從 Cue 4（1:23.0）起換成「版型 B」」/「從 1:23.0 起換成「版型 B」」 */
export function switchSentence(label: string | null, sec: number, templateName: string): string {
  // 「從 Cue 4（1:23.0）起換成…」括號後面不加空格；純時間「從 1:23.0 起換成…」要空格
  return label
    ? `從 ${label}（${formatSwitchTime(sec)}）起換成「${templateName}」`
    : `從 ${formatSwitchTime(sec)} 起換成「${templateName}」`;
}

/** 一段在標記 / 表格 / 說明裡怎麼叫：「開頭」或「Cue 4 · 1:23.0」/「1:23.0」 */
export function segmentWhere(label: string | null, fromSec: number): string {
  if (fromSec <= 0) return '開頭';
  return label ? `${label} · ${formatSwitchTime(fromSec)}` : formatSwitchTime(fromSec);
}

/** 這個點算不出時間時的說明 */
export function unresolvedSwitchText(cueName: string | null, templateName: string): string {
  return cueName
    ? `${cueName} 還沒有影片時間（或已經不見了），換成「${templateName}」先不生效：到 Cue 的設定填影片時間`
    : `換成「${templateName}」的時間不對，先不生效`;
}

/** 時間線一句話：「版型 A → 版型 B（Cue 4 · 1:23.0）→ 版型 C（2:10.0）」 */
export function timelineSummary(tl: LedTimeline): string {
  return tl.segments.map((s, i) => {
    if (i === 0) return s.plan.name;
    const where = s.label ? `${s.label} · ${formatSwitchTime(s.fromSec)}` : formatSwitchTime(s.fromSec);
    return `${s.plan.name}（${where}）`;
  }).join(' → ');
}

/**
 * 影片版本列上的一行：「版型時間線：版型 A → 版型 B（Cue 4 · 1:23.0）」；
 * 影片大小是版型畫布的等比例縮小 / 比例不一樣時，後面接一句（跟單一版型的標示同一套說法）
 */
export function timelineVersionLabel(tl: LedTimeline, video?: { width: number | null; height: number | null }): string {
  const base = `版型時間線：${timelineSummary(tl)}`;
  if (!video?.width || !video.height) return base;
  const fit = compareVideoToTemplate({ width: video.width, height: video.height }, timelineCanvas(tl));
  if (fit.kind === 'scaled') return `${base} · 影片是版型的 ${formatPct(fit.pct)}`;
  if (fit.kind === 'stretch') return `${base} · 影片比例跟版型不一樣（會變形）`;
  return base;
}

// ───────────────────────── 檢查（後台和畫面共用）─────────────────────────

/** 版型的最少資料（檢查用） */
export interface TimelineTemplateInfo { id: string; name: string; kind: 'full' | 'custom'; canvas: CanvasSize | null }

/** 時間線裡的版型畫布大小要一樣；不一樣 = 說明，一樣 = null */
export function canvasMismatch(templates: readonly TimelineTemplateInfo[]): string | null {
  const first = templates[0];
  if (!first?.canvas) return null;
  const bad = templates.find(t => t.canvas && (t.canvas.width !== first.canvas!.width || t.canvas.height !== first.canvas!.height));
  if (!bad?.canvas) return null;
  return `同一首歌中途換版型，每個版型的畫布大小都要一樣（影片只有一個檔、一個大小）：`
    + `「${first.name}」是 ${first.canvas.width}×${first.canvas.height}，「${bad.name}」是 ${bad.canvas.width}×${bad.canvas.height}。`
    + `請把其中一個改成一樣大，或換一個一樣大的版型`;
}

export interface SwitchInput {
  cueId?: string | null;
  atSec?: number | null;
  templateId: string;
}

export interface TimelineInput {
  /** 開頭的版型（null = 整張畫布；有換版型的點就一定要是自己排的版型） */
  start: string | null;
  switches: SwitchInput[];
}

/** PUT 的 body → 乾淨的 TimelineInput（格式不對 = 說明） */
export function normalizeTimelineInput(body: unknown): Parsed<TimelineInput> {
  if (!isObj(body)) return { ok: false, error: '請傳 { start, switches }' };
  let start: string | null = null;
  if (body.start !== null && body.start !== undefined && body.start !== '') {
    if (typeof body.start !== 'string' || !ID_RE.test(body.start)) return { ok: false, error: '開頭的版型 id 不合法' };
    start = body.start;
  }
  const raw = body.switches === undefined || body.switches === null ? [] : body.switches;
  if (!Array.isArray(raw)) return { ok: false, error: 'switches 要是陣列' };
  if (raw.length > MAX_SWITCHES) return { ok: false, error: `一首歌最多換 ${MAX_SWITCHES} 次版型` };
  const switches: SwitchInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const n = `第 ${i + 1} 個換版型的點`;
    if (!isObj(r)) return { ok: false, error: `${n}的格式不對` };
    if (typeof r.templateId !== 'string' || !ID_RE.test(r.templateId)) return { ok: false, error: `${n}：要選一個版型` };
    const hasCue = typeof r.cueId === 'string' && r.cueId !== '';
    const hasSec = r.atSec !== null && r.atSec !== undefined && r.atSec !== '';
    if (hasCue === hasSec) return { ok: false, error: `${n}：要選一個 Cue，或寫一個時間（二選一）` };
    if (hasCue) {
      if (!ID_RE.test(r.cueId as string)) return { ok: false, error: `${n}：Cue 的 id 不合法` };
      switches.push({ cueId: r.cueId as string, templateId: r.templateId });
    } else {
      const sec = typeof r.atSec === 'string' ? parseSwitchTime(r.atSec) : num(r.atSec);
      if (sec === null || sec < 0 || sec > MAX_SWITCH_SEC) return { ok: false, error: `${n}：時間要是 0 到 ${MAX_SWITCH_SEC} 秒（例：83、1:23.5）` };
      switches.push({ atSec: Math.round(sec * 1000) / 1000, templateId: r.templateId });
    }
  }
  return { ok: true, value: { start, switches } };
}

export interface CheckInput {
  start: string | null;
  switches: readonly (SwitchInput & { id?: string })[];
  /** 專案裡所有版型（含「全部」）：id → 資料；「全部」的 canvas 是專案的 LED 畫布 */
  templates: ReadonlyMap<string, TimelineTemplateInfo>;
  /** 這首歌的 Cue（只有 master 的才能當換版型的點） */
  cues: CueTimes;
}

/**
 * 存之前的檢查：版型都存在、都是自己排的版型、畫布一樣大、Cue 有影片時間、時間 > 0、兩個點不能在同一個時間。
 * 沒有換版型的點時只檢查開頭的版型存在。
 */
export function checkTimeline(i: CheckInput): { ok: true } | { ok: false; error: string } {
  const startInfo = i.start ? i.templates.get(i.start) : null;
  if (i.start && !startInfo) return { ok: false, error: '這個專案裡找不到開頭的版型（可能剛被刪掉，請重新整理）' };
  if (i.switches.length === 0) return { ok: true };
  if (!startInfo || startInfo.kind !== 'custom') {
    return { ok: false, error: '要中途換版型，開頭得先選一個自己排的版型（「全部」是整張畫布，沒有排法可以換）' };
  }
  const used: TimelineTemplateInfo[] = [startInfo];
  const times: { at: number; name: string }[] = [];
  for (let n = 0; n < i.switches.length; n++) {
    const sw = i.switches[n];
    const info = i.templates.get(sw.templateId);
    if (!info) return { ok: false, error: `第 ${n + 1} 個換版型的點：這個專案裡找不到那個版型（可能剛被刪掉，請重新整理）` };
    if (info.kind !== 'custom') return { ok: false, error: `第 ${n + 1} 個換版型的點：不能換成「${info.name}」（整張畫布沒有排法），請選自己排的版型` };
    used.push(info);
    let at: number | null;
    let name: string;
    if (sw.cueId) {
      const cue = i.cues.get(sw.cueId);
      if (!cue) return { ok: false, error: `第 ${n + 1} 個換版型的點：找不到這個 Cue（只有這首歌的正式 Cue 可以用），請重新整理` };
      if (cue.timeSec === null || !Number.isFinite(cue.timeSec)) {
        return { ok: false, error: `${cue.name} 還沒有影片時間：先到 Cue 的設定填「影片時間」，或改成直接寫時間` };
      }
      at = cue.timeSec;
      name = cue.name;
    } else {
      at = typeof sw.atSec === 'number' && Number.isFinite(sw.atSec) ? sw.atSec : null;
      name = at === null ? '' : formatSwitchTime(at);
    }
    if (at === null) return { ok: false, error: `第 ${n + 1} 個換版型的點：沒有時間` };
    if (at <= SWITCH_EPS) {
      return { ok: false, error: `${name || `第 ${n + 1} 個換版型的點`}在 0 秒：0 秒就是開頭，請直接把開頭的版型改掉` };
    }
    times.push({ at, name: name || formatSwitchTime(at) });
  }
  const mismatch = canvasMismatch(used);
  if (mismatch) return { ok: false, error: mismatch };
  const sorted = [...times].sort((a, b) => a.at - b.at);
  for (let k = 1; k < sorted.length; k++) {
    if (Math.abs(sorted[k].at - sorted[k - 1].at) <= SWITCH_EPS) {
      return { ok: false, error: `${sorted[k - 1].name} 和 ${sorted[k].name} 在同一個時間（${formatSwitchTime(sorted[k].at)}），一個時間只能換一次版型` };
    }
  }
  return { ok: true };
}

// ───────────────────────── 影片版本的快照 ─────────────────────────

/**
 * 存進 song_videos.template_timeline 的 JSON：每個版型的排法只存一份（plans），段落只記「從第幾秒、用哪個版型、怎麼換過來的」。
 * 時間是上傳那一刻定下來的（Cue 之後動了，這一版影片照舊）。
 */
export function serializeTimeline(tl: LedTimeline): string {
  const plans: Record<string, LedTemplatePlan> = {};
  for (const s of tl.segments) plans[s.templateId] = s.plan;
  return JSON.stringify({
    v: 1,
    plans,
    segments: tl.segments.map(s => ({ fromSec: s.fromSec, templateId: s.templateId, label: s.label })),
  });
}

/** 讀快照 / API 的 templateTimeline；任何地方不對 = null（當單一版型 / 整張畫布，跟舊版一樣） */
export function parseTimeline(raw: unknown): LedTimeline | null {
  let obj: unknown = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!isObj(obj) || !isObj(obj.plans) || !Array.isArray(obj.segments)) return null;
  const plans = new Map<string, LedTemplatePlan>();
  for (const [id, p] of Object.entries(obj.plans)) {
    const plan = parsePlan(p);
    if (plan) plans.set(id, plan);
  }
  const segments: TimelineSegment[] = [];
  for (const s of obj.segments) {
    if (!isObj(s) || typeof s.templateId !== 'string') return null;
    const plan = plans.get(s.templateId);
    const fromSec = num(s.fromSec);
    if (!plan || fromSec === null || fromSec < 0) return null;
    const prev = segments[segments.length - 1];
    if (prev ? fromSec <= prev.fromSec : fromSec !== 0) return null;
    segments.push({ fromSec, templateId: s.templateId, plan, label: typeof s.label === 'string' && s.label ? s.label : null });
  }
  return segments.length >= 2 ? { v: 1, segments } : null;
}
