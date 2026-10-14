// 新專案精靈（專案總覽的「新增專案」）用的純計算；newProjectWizard.test.ts 有測。
//
//   parseSetlist        貼上的歌單 → 一首一首：去頭尾空白、跳過空行、拿掉編號（「1. 開場」「(2) 夜曲」）、
//                       認得開頭的歌曲代號（「S01 開場」）、重複的歌只留第一首、從 Excel 貼的（Tab 分欄）也看得懂
//   assignSongCodes     每首歌的歌曲代號：有寫的照用，沒寫的接著前一首往下排（S01、S02…），不跟專案裡已經有的撞
//   songCodeProblems    使用者在表格裡改過代號之後，再檢查一次（格式、跟別首撞到）
//   步驟                WIZARD_STEPS、stepFromParam、nextStep / prevStep
//   進度                每一步「做好了 / 先跳過」記在這台電腦（localStorage），關掉之後專案總覽可以「繼續設定」
//   describeObjectCounts「找到 12 片 LED、2 個機關、1 個走位點」（分類跟上傳模型的命名規則一樣，lib/parseGlb.ts）

import { normalizeSongCode, songCodeKey, SONG_CODE_MAX } from './songCode';
import { LED_CANVAS_RANGE, normalizeLedCanvas, type LedCanvas } from './ledCanvas';
import type { StageObjectCategory } from './api';

// ─────────────────────────────────────────────
// 歌單
// ─────────────────────────────────────────────

/** 歌名最多幾個字（跟後台 SONG_NAME_MAX 一樣） */
export const SONG_NAME_MAX = 80;
/** 一次最多貼幾首 */
export const SETLIST_MAX_SONGS = 100;

export interface SetlistSong {
  name: string;
  /** 這一行開頭寫的代號（「S01 開場」→ S01）；沒寫 = null */
  code: string | null;
  /** 第幾行（從 1 開始，給畫面說「第 3 行」用） */
  line: number;
}

export interface SetlistParse {
  songs: SetlistSong[];
  /** 跳過的空行數 */
  skippedEmpty: number;
  /** 重複、只留第一首的歌名（照出現順序） */
  duplicates: string[];
  /** 超過 SETLIST_MAX_SONGS 沒加進來的首數 */
  tooMany: number;
}

// 編號有標點（「1.」「1、」「1)」「1：」「第 1 首」）→ 一定是編號，拿掉；後面緊接數字的不算（「3.14」「1:23」）
const NUM_PUNCT_RE = /^(?:第\s*)?\d{1,3}\s*(?:首\s*)?[.．、,，:：)）\]】](?!\d)\s*/;
const NUM_WORD_RE = /^第\s*\d{1,3}\s*首\s*/;
// 括號包起來的編號：「(1) 開場」「【2】夜曲」
const NUM_PAREN_RE = /^[(（[【]\s*\d{1,3}\s*[)）\]】]\s*/;
// 「#1 開場」
const NUM_HASH_RE = /^#\s*\d{1,3}\b\s*/;
// 清單符號：「- 開場」「• 開場」
const BULLET_RE = /^[-–—•·‧・*＊]\s+/;
// 只有數字 + 空白（「1 開場」）：歌名也可能是數字開頭（「1999」「2 Become 1」），整份歌單大多這樣寫才當編號
const NUM_BARE_RE = /^\d{1,3}\s+(?=\S)/;
// 開頭的歌曲代號：「S01 開場」「S01_開場」「S01. 開場」「[S01] 開場」「S01開場」
const CODE_SEP_RE = /^(S\d{1,3})(?:\s*[.．、:：|｜_\-–—]\s*|\s+)(.+)$/i;
const CODE_GLUED_RE = /^(S\d{1,3})(?=[^\x00-\x7F])(.+)$/i;
const CODE_BRACKET_RE = /^[(（[【]\s*(S\d{1,3})\s*[)）\]】]\s*(.+)$/i;
const CODE_ONLY_RE = /^S\d{1,3}$/i;
const NUM_ONLY_RE = /^\d{1,3}[.．、)）]?$/;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"], ['《', '》'], ['〈', '〉']];

function tidyName(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  for (const [a, b] of QUOTE_PAIRS) {
    if (s.length > 2 && s.startsWith(a) && s.endsWith(b)) {
      const inner = s.slice(a.length, s.length - b.length);
      // 「開場」與「夜曲」不是整個包起來的，不拿
      if (!inner.includes(a) && !inner.includes(b)) s = inner.trim();
      break;
    }
  }
  return Array.from(s).slice(0, SONG_NAME_MAX).join('');
}

/** 比對重複用：全形半形、大小寫、空白都不算 */
export function songNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function stripNumbering(line: string, bareNumbers: boolean): string {
  let s = line.replace(BULLET_RE, '');
  if (NUM_PAREN_RE.test(s)) return s.replace(NUM_PAREN_RE, '');
  if (NUM_HASH_RE.test(s)) return s.replace(NUM_HASH_RE, '');
  if (NUM_PUNCT_RE.test(s)) return s.replace(NUM_PUNCT_RE, '');
  if (NUM_WORD_RE.test(s)) return s.replace(NUM_WORD_RE, '');
  if (bareNumbers) s = s.replace(NUM_BARE_RE, '');
  return s;
}

function splitCode(text: string): { code: string | null; name: string } {
  const m = CODE_BRACKET_RE.exec(text) || CODE_SEP_RE.exec(text) || CODE_GLUED_RE.exec(text);
  if (m && m[2].trim()) return { code: m[1].toUpperCase(), name: m[2] };
  return { code: null, name: text };
}

/** 從 Excel / Google 試算表貼的（Tab 分欄）：第一欄是編號就跳過、是代號就當代號；歌名 = 接著的那一欄，後面的欄（長度、備註）不要 */
function fromCells(cells: string[]): { code: string | null; name: string } | null {
  let i = 0;
  let code: string | null = null;
  if (i < cells.length && NUM_ONLY_RE.test(cells[i])) i++;
  if (i < cells.length && CODE_ONLY_RE.test(cells[i])) { code = cells[i].toUpperCase(); i++; }
  if (i < cells.length && NUM_ONLY_RE.test(cells[i]) && i + 1 < cells.length) i++;
  if (i >= cells.length) return null;
  return { code, name: cells[i] };
}

export function parseSetlist(text: string): SetlistParse {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const nonEmpty = lines.map(l => l.trim()).filter(Boolean);
  // 整份歌單有一半以上（至少兩行）是「數字 + 空白」或有標點的編號開頭 → 「1 開場」的 1 也當編號
  const numbered = nonEmpty.filter(l => NUM_BARE_RE.test(l.replace(BULLET_RE, '')) || NUM_PUNCT_RE.test(l) || NUM_PAREN_RE.test(l)).length;
  const bareNumbers = nonEmpty.length >= 2 && numbered / nonEmpty.length >= 0.6;

  const out: SetlistSong[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let skippedEmpty = 0;
  let tooMany = 0;
  // 頭尾的空行不算（貼上時常常多一兩行），只算夾在歌中間的
  const first = lines.findIndex(l => l.trim());
  const last = lines.length - 1 - [...lines].reverse().findIndex(l => l.trim());
  lines.forEach((raw, idx) => {
    // 開頭的全形數字、標點（「１．開場」）先換成半形，編號才認得到；歌名裡的全形字不動
    const line = raw.trim().replace(/^[０-９．、。（）\s]+/, m => m.normalize('NFKC'));
    if (!line) {
      if (first >= 0 && idx > first && idx < last) skippedEmpty++;
      return;
    }
    let parsed: { code: string | null; name: string } | null;
    if (line.includes('\t')) {
      parsed = fromCells(line.split('\t').map(c => c.trim()).filter(Boolean));
    } else {
      parsed = splitCode(stripNumbering(line, bareNumbers).trim());
    }
    if (!parsed) return;
    const name = tidyName(parsed.name);
    if (!name) return;
    const key = songNameKey(name);
    if (seen.has(key)) { duplicates.push(name); return; }
    seen.add(key);
    if (out.length >= SETLIST_MAX_SONGS) { tooMany++; return; }
    out.push({ name, code: parsed.code, line: idx + 1 });
  });
  return { songs: out, skippedEmpty, duplicates, tooMany };
}

// ─────────────────────────────────────────────
// 歌曲代號
// ─────────────────────────────────────────────

export interface CodedSong {
  name: string;
  code: string;
  /** true = 系統排的（沒寫、或寫的已經被用掉） */
  auto: boolean;
}

const sNumber = (code: string | null | undefined): number | null => {
  const m = /^S(\d+)$/i.exec(String(code ?? '').trim());
  return m ? parseInt(m[1], 10) : null;
};

const formatS = (n: number) => `S${String(n).padStart(2, '0')}`;

/**
 * 每首歌的代號。existingCodes = 專案裡已經有的歌的代號（接在它們後面）。
 * 有寫代號而且沒撞到 → 照用；沒寫 / 撞到 → 從前一首的號碼往下找第一個沒被用的 S 號碼（新專案就是 S01、S02、S03…）
 */
export function assignSongCodes(songs: ReadonlyArray<{ name: string; code?: string | null }>, existingCodes: ReadonlyArray<string | null | undefined> = []): CodedSong[] {
  const taken = new Set<string>();
  let n = 0;
  for (const c of existingCodes) {
    if (!c) continue;
    taken.add(songCodeKey(c));
    const k = sNumber(c);
    if (k !== null) n = Math.max(n, k);
  }
  // 先保留有寫的代號（同一個寫兩次 → 第一首拿到），系統排的才不會搶走後面那首寫好的
  const reserved = songs.map(s => {
    const wanted = s.code ? normalizeSongCode(s.code) : null;
    if (!wanted || !('code' in wanted) || taken.has(songCodeKey(wanted.code))) return null;
    taken.add(songCodeKey(wanted.code));
    return wanted.code;
  });
  const out: CodedSong[] = [];
  for (const [i, s] of songs.entries()) {
    const own = reserved[i];
    if (own) {
      const k = sNumber(own);
      if (k !== null) n = k;
      out.push({ name: s.name, code: own, auto: false });
      continue;
    }
    n++;
    while (taken.has(songCodeKey(formatS(n)))) n++;
    const code = formatS(n);
    taken.add(songCodeKey(code));
    out.push({ name: s.name, code, auto: true });
  }
  return out;
}

/**
 * 表格裡（使用者可能改過）的代號有沒有問題：回傳每一列的問題（沒問題 = null）。
 * 跟專案裡已經有的歌撞到、跟同一份歌單的上面幾列撞到、格式不對（規則跟 lib/songCode.ts 一樣）
 */
export function songCodeProblems(
  rows: ReadonlyArray<{ code: string }>,
  existing: ReadonlyArray<{ name: string; code?: string | null }> = [],
): (string | null)[] {
  const existingByKey = new Map<string, string>();
  for (const s of existing) if (s.code) existingByKey.set(songCodeKey(s.code), s.name);
  const seen = new Map<string, number>();
  return rows.map((r, i) => {
    const n = normalizeSongCode(r.code);
    if ('error' in n) return n.error;
    const key = songCodeKey(n.code);
    const owner = existingByKey.get(key);
    if (owner) return `「${n.code}」已經是「${owner}」的代號了`;
    const first = seen.get(key);
    if (first !== undefined) return `「${n.code}」跟第 ${first + 1} 首重複了`;
    seen.set(key, i);
    return null;
  });
}

export { SONG_CODE_MAX };

// ─────────────────────────────────────────────
// 步驟
// ─────────────────────────────────────────────

export type WizardStep = 'name' | 'model' | 'canvas' | 'songs' | 'invite' | 'done';

export const WIZARD_STEPS: ReadonlyArray<{ key: WizardStep; label: string }> = [
  { key: 'name', label: '名稱' },
  { key: 'model', label: '3D 模型' },
  { key: 'canvas', label: 'LED 畫布大小' },
  { key: 'songs', label: '歌單' },
  { key: 'invite', label: '邀請人' },
  { key: 'done', label: '完成' },
];

/** 可以跳過、之後再做的步驟（名稱一定要填；完成是最後一頁） */
export const OPTIONAL_STEPS: ReadonlyArray<WizardStep> = ['model', 'canvas', 'songs', 'invite'];

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.findIndex(s => s.key === step);
}

export function stepLabel(step: WizardStep): string {
  return WIZARD_STEPS[stepIndex(step)]?.label ?? '';
}

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[stepIndex(step) + 1]?.key ?? null;
}

export function prevStep(step: WizardStep): WizardStep | null {
  const i = stepIndex(step);
  return i > 0 ? WIZARD_STEPS[i - 1].key : null;
}

/**
 * 網址上的 ?new=<步驟>（瀏覽器的上一頁 / 下一頁就是換步驟）→ 要顯示哪一步。
 * 沒有 = 精靈沒開（null）；看不懂的步驟、還沒有專案卻要後面的步驟 → 從「名稱」開始
 */
export function stepFromParam(raw: string | null | undefined, hasProject: boolean): WizardStep | null {
  if (raw == null) return null;
  const hit = WIZARD_STEPS.find(s => s.key === raw)?.key ?? 'name';
  return hasProject ? hit : 'name';
}

// ─────────────────────────────────────────────
// 進度（記在這台電腦；資料本身每一步都已經存到專案上了）
// ─────────────────────────────────────────────

export type StepMark = 'done' | 'skipped';

export interface WizardProgress {
  projectId: string;
  projectName: string;
  marks: Partial<Record<WizardStep, StepMark>>;
  /** 走到「完成」那一頁了 */
  finished: boolean;
  updatedAt: number;
}

export const WIZARD_STORAGE_KEY = 'sp_new_project_wizard';

export function newProgress(projectId: string, projectName: string, now = Date.now()): WizardProgress {
  return { projectId, projectName, marks: { name: 'done' }, finished: false, updatedAt: now };
}

/** 記下某一步：做好了蓋過跳過；跳過不會蓋掉已經做好的 */
export function markStep(p: WizardProgress, step: WizardStep, mark: StepMark, now = Date.now()): WizardProgress {
  const cur = p.marks[step];
  if (mark === 'skipped' && cur === 'done') return p;
  if (cur === mark) return p;
  return { ...p, marks: { ...p.marks, [step]: mark }, finished: p.finished || step === 'done', updatedAt: now };
}

/** 還沒做好的可選步驟（跳過的也算還沒做好） */
export function unfinishedSteps(p: WizardProgress): WizardStep[] {
  return OPTIONAL_STEPS.filter(s => p.marks[s] !== 'done');
}

/** 「繼續設定」從哪一步開始：第一個還沒碰過的步驟；都碰過了 → 完成那一頁 */
export function resumeStep(p: WizardProgress): WizardStep {
  return OPTIONAL_STEPS.find(s => !p.marks[s]) ?? 'done';
}

/** 專案總覽要不要提醒「還沒設定完」：還沒走到完成那一頁就關掉的 */
export function needsResume(p: WizardProgress | null): boolean {
  return !!p && !p.finished && unfinishedSteps(p).length > 0;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readWizardProgress(storage: StorageLike | null | undefined): WizardProgress | null {
  try {
    const raw = storage?.getItem(WIZARD_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || typeof o.projectId !== 'string' || !o.projectId) return null;
    const marks: WizardProgress['marks'] = {};
    if (o.marks && typeof o.marks === 'object') {
      for (const s of WIZARD_STEPS) {
        const m = o.marks[s.key];
        if (m === 'done' || m === 'skipped') marks[s.key] = m;
      }
    }
    return {
      projectId: o.projectId,
      projectName: typeof o.projectName === 'string' ? o.projectName : '',
      marks,
      finished: o.finished === true,
      updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeWizardProgress(storage: StorageLike | null | undefined, p: WizardProgress | null): void {
  try {
    if (!storage) return;
    if (p) storage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(p));
    else storage.removeItem(WIZARD_STORAGE_KEY);
  } catch { /* 無痕模式 / 不能存 → 只是不能「繼續設定」 */ }
}

// ─────────────────────────────────────────────
// 模型裡找到什麼、LED 畫布大小
// ─────────────────────────────────────────────

const COUNT_WORDS: ReadonlyArray<readonly [StageObjectCategory, (n: number) => string]> = [
  ['led_panel', n => `${n} 片 LED`],
  ['mechanism', n => `${n} 個機關`],
  ['walk_point', n => `${n} 個走位點`],
  ['fixture', n => `${n} 個燈光 / 道具`],
  ['performer', n => `${n} 位表演者`],
  ['other', n => `${n} 個其他物件`],
];

/** 「找到 12 片 LED、2 個機關、1 個走位點」；一個都沒有 → 「模型裡沒有讀到物件」 */
export function describeObjectCounts(counts: Partial<Record<StageObjectCategory, number>>): string {
  const parts = COUNT_WORDS.filter(([k]) => (counts[k] ?? 0) > 0).map(([k, word]) => word(counts[k] as number));
  return parts.length ? `找到 ${parts.join('、')}` : '模型裡沒有讀到物件';
}

export function countByCategory(objects: ReadonlyArray<{ category: StageObjectCategory }>): Partial<Record<StageObjectCategory, number>> {
  const out: Partial<Record<StageObjectCategory, number>> = {};
  for (const o of objects) out[o.category] = (out[o.category] ?? 0) + 1;
  return out;
}

export const DEFAULT_WIZARD_CANVAS: LedCanvas = { width: 3840, height: 2160 };

/** 兩個欄位（寬、高）→ 可以存的大小，或一句白話說哪裡不對 */
export function parseCanvasFields(width: string, height: string): { canvas: LedCanvas } | { error: string } {
  const [min, max] = LED_CANVAS_RANGE;
  const w = String(width ?? '').trim(), h = String(height ?? '').trim();
  if (!w || !h) return { error: '寬和高都要填' };
  const canvas = normalizeLedCanvas({ width: w, height: h });
  if (!canvas) return { error: `寬和高要是 ${min}～${max} 的整數（像素）` };
  return { canvas };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** 比例：3840 × 2160 → 「16:9」；約不出漂亮的數字 → 「3.56:1」 */
export function aspectText(c: LedCanvas): string {
  const g = gcd(c.width, c.height);
  const a = c.width / g, b = c.height / g;
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  const r = c.width / c.height;
  return r >= 1 ? `${(Math.round(r * 100) / 100)}:1` : `1:${Math.round((1 / r) * 100) / 100}`;
}
