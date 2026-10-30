# 動畫師上手教學 第一階段（帶著做＋教學頁）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 動畫師第一次進工作站時有「帶著做」一步一步帶他做一次；網站多一頁不用登入的「動畫師上手教學」。

**Architecture:** 步驟內容和規則放純函式檔（`lib/tutorial/animatorTour.ts`），畫面是一個疊在最上面、不擋滑鼠的亮框＋說明框元件（`components/TourOverlay.tsx`），工作站只加 `data-tour="..."` 標記、狀態和選單項目。教學頁的內容也是資料檔（`lib/tutorial/animatorTutorialContent.tsx`），頁面元件只負責排版，第二階段換短片只改資料。看過與否記在 localStorage，不動後台。

**Tech Stack:** React 18 + Vite + TypeScript、react-router、vitest、lucide-react（經 `components/Icon`）。

**Spec:** `docs/superpowers/specs/2026-10-30-animator-tutorial-design.md`

## Global Constraints

- 畫面文字繁體中文、白話、短句；不用 emoji（圖示用 `<Icon icon={...} />`）；不用原生對話框（alert/confirm/prompt）。
- 畫面不出現英文角色字（`test/noEnglishRoleWords.test.ts` 會擋）；`test/noEmojiInUi.test.ts`、`test/noNativeDialogs.test.ts` 也要過。
- 只改網站（`web/`），不改 `cf-worker/`、不動資料庫；不動前後台共用的規則檔（`grep -rn "from '../web/src/" cf-worker --include=*.mjs --include=*.js` 列出的檔案）。
- 製作在程式裡的專案角色叫 `'admin'`（`ProjectRole = 'admin' | 'animator' | 'director'`，`lib/mockData.ts`）。
- 不准改 LED 畫面的顏色或貼圖邏輯。
- 1280 寬和 375 寬都不能整頁左右捲動；手機要能用。
- 教學內容的每一句事實都要能在 `web/src/pages/Help.tsx` 或程式裡找到根據，不准編功能。
- commit 用中文、不加署名。

---

### Task 1: 帶著做的步驟和規則（純函式）

**Files:**
- Create: `web/src/lib/tutorial/animatorTour.ts`
- Test: `web/src/lib/tutorial/animatorTour.test.ts`

**Interfaces:**
- Produces: `ANIMATOR_TOUR_SEEN_KEY`, `ANIMATOR_TUTORIAL_PATH`, `type TourTarget`, `type TourStepId`, `interface TourStep`, `interface TourContext`, `producerContactText(names)`, `animatorTourSteps(ctx)`, `shouldAutoStartTour(o)`, `readTourSeen(storage)`, `markTourSeen(storage)`

- [ ] **Step 1: 寫測試**

```ts
// web/src/lib/tutorial/animatorTour.test.ts
import { describe, expect, it } from 'vitest';
import {
  ANIMATOR_TOUR_SEEN_KEY, animatorTourSteps, markTourSeen, producerContactText, readTourSeen, shouldAutoStartTour,
} from './animatorTour';

const ctx = { ledHasPicture: false, producerNames: ['王小明'] };

describe('帶著做的步驟', () => {
  it('十步，順序固定', () => {
    expect(animatorTourSteps(ctx).map(s => s.id)).toEqual([
      'welcome', 'songs', 'stage', 'test-pattern', 'local-file', 'cues', 'add-video', 'ae-live', 'record', 'help',
    ]);
  });

  it('第一步和亮的地方', () => {
    const steps = animatorTourSteps(ctx);
    expect(steps[0].target).toBeNull();
    expect(steps[0].body).toContain('不用改');
    expect(steps.find(s => s.id === 'local-file')!.target).toBe('source-file');
    expect(steps.find(s => s.id === 'local-file')!.waitFor).toBe('local-file');
    expect(steps.find(s => s.id === 'local-file')!.done?.title).toBe('成功了');
    expect(steps.find(s => s.id === 'stage')!.waitFor).toBe('stage-drag');
  });

  it('LED 沒畫面 → 說「現在」看到的是測試圖；有畫面 → 說沒放東西的時候才會看到', () => {
    const none = animatorTourSteps(ctx).find(s => s.id === 'test-pattern')!;
    const some = animatorTourSteps({ ...ctx, ledHasPicture: true }).find(s => s.id === 'test-pattern')!;
    expect(none.body).toContain('現在');
    expect(some.body).toContain('沒放東西的時候');
  });

  it('最後一步寫出這個專案的製作', () => {
    expect(animatorTourSteps(ctx).at(-1)!.body).toContain('王小明');
    expect(animatorTourSteps({ ...ctx, producerNames: [] }).at(-1)!.body).toContain('邀請你進來的製作');
  });

  it('每一步都有標題和內容，沒有英文角色字', () => {
    for (const s of animatorTourSteps(ctx)) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.title + s.body).not.toMatch(/admin|animator|director|producer/i);
    }
  });

  it('錄成影片、使用說明找不到時有提示', () => {
    const steps = animatorTourSteps(ctx);
    expect(steps.find(s => s.id === 'record')!.missingHint).toBeTruthy();
    expect(steps.find(s => s.id === 'help')!.missingHint).toContain('⋯');
  });
});

describe('producerContactText', () => {
  it('沒有 → 邀請你進來的製作', () => {
    expect(producerContactText([])).toBe('邀請你進來的製作');
    expect(producerContactText(['  '])).toBe('邀請你進來的製作');
  });
  it('一到三個 → 列名字', () => {
    expect(producerContactText(['王小明'])).toBe('這個專案的製作 王小明');
    expect(producerContactText(['甲', '乙'])).toBe('這個專案的製作 甲、乙');
  });
  it('超過三個 → 前三個加「等人」', () => {
    expect(producerContactText(['甲', '乙', '丙', '丁'])).toBe('這個專案的製作 甲、乙、丙 等人');
  });
});

describe('什麼時候自動出現', () => {
  it('只有動畫師、不是「用動畫師的畫面看」、沒看過', () => {
    expect(shouldAutoStartTour({ projectRole: 'animator', viewAsActive: false, seen: false })).toBe(true);
    expect(shouldAutoStartTour({ projectRole: 'animator', viewAsActive: false, seen: true })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: 'animator', viewAsActive: true, seen: false })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: 'admin', viewAsActive: false, seen: false })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: 'director', viewAsActive: false, seen: false })).toBe(false);
    expect(shouldAutoStartTour({ projectRole: null, viewAsActive: false, seen: false })).toBe(false);
  });
});

describe('記得看過', () => {
  it('寫了就讀得到', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    expect(readTourSeen(st)).toBe(false);
    markTourSeen(st);
    expect(m.get(ANIMATOR_TOUR_SEEN_KEY)).toBe('1');
    expect(readTourSeen(st)).toBe(true);
  });
  it('瀏覽器不給存（無痕、擋掉）→ 當作看過，不要每次都跳；寫入失敗也不會壞', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readTourSeen(bad)).toBe(true);
    expect(readTourSeen(null)).toBe(true);
    expect(() => markTourSeen(bad)).not.toThrow();
    expect(() => markTourSeen(null)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑測試，確認失敗**

Run（在 `web/`）：`npx vitest run src/lib/tutorial/animatorTour.test.ts`
Expected: FAIL（找不到 `./animatorTour`）

- [ ] **Step 3: 寫程式**

```ts
// web/src/lib/tutorial/animatorTour.ts
// 動畫師工作站「帶著做」：步驟內容和規則（純函式，好測）。
//   畫面：components/TourOverlay.tsx；掛載和 data-tour 標記：pages/Studio.tsx。
//   看過與否記在這台電腦（localStorage）；步驟大改就把鍵名的版本號加一，讓大家再看一次。
import type { ProjectRole } from '../mockData';

export const ANIMATOR_TOUR_SEEN_KEY = 'sp_tour_animator_v1';
export const ANIMATOR_TUTORIAL_PATH = '/tutorial/animator';

/** 工作站裡 data-tour="..." 的元素 */
export type TourTarget = 'songs-mine' | 'stage' | 'source-file' | 'cue-bar' | 'add-video' | 'source-ae' | 'record' | 'help';
export type TourStepId =
  | 'welcome' | 'songs' | 'stage' | 'test-pattern' | 'local-file' | 'cues' | 'add-video' | 'ae-live' | 'record' | 'help';

export interface TourStep {
  id: TourStepId;
  title: string;
  body: string;
  /** 要亮的地方；null = 不亮、說明框放中間 */
  target: TourTarget | null;
  /** 要亮的東西現在找不到（窄畫面收進「⋯」、這首歌現在沒有這個按鈕）時，說明框放中間、多加這一句 */
  missingHint?: string;
  /** 要他動手的步驟：stage-drag 做到就自動往下；local-file 做到就換成 done 的字。不做也能按「下一步」 */
  waitFor?: 'stage-drag' | 'local-file';
  done?: { title: string; body: string };
}

export interface TourContext {
  /** LED 現在有畫面（影片、本地檔案、AE 即時有在送）→ 看不到測試圖 */
  ledHasPicture: boolean;
  /** 這個專案的製作名字 */
  producerNames: readonly string[];
}

/** 「卡住了找誰」：最多列三個名字；沒有就請他找邀請他的人 */
export function producerContactText(names: readonly string[]): string {
  const clean = names.map(n => n.trim()).filter(Boolean);
  if (clean.length === 0) return '邀請你進來的製作';
  if (clean.length <= 3) return `這個專案的製作 ${clean.join('、')}`;
  return `這個專案的製作 ${clean.slice(0, 3).join('、')} 等人`;
}

export function animatorTourSteps(ctx: TourContext): TourStep[] {
  return [
    {
      id: 'welcome', target: null,
      title: '歡迎來到動畫師工作站',
      body: '你在 AE 裡的做法一點都不用改。這裡是把你的動畫貼到真的舞台上看的地方，不用跑現場就知道 LED 上長什麼樣子。跟著走一遍大約 5 分鐘，隨時可以跳過。',
    },
    {
      id: 'songs', target: 'songs-mine',
      title: '這是你的歌',
      body: '「我的」是指派給你的歌。點一首，舞台就換成那首歌的樣子。',
    },
    {
      id: 'stage', target: 'stage', waitFor: 'stage-drag',
      title: '轉轉看舞台',
      body: '按住拖拉可以轉，滾輪可以放大縮小。轉亂了沒關係，按攝影機圖示的「重置攝影機」就回來。試著拖一下。',
    },
    {
      id: 'test-pattern', target: 'stage',
      title: 'LED 上的測試圖',
      body: ctx.ledHasPicture
        ? 'LED 沒放東西的時候會顯示測試圖：每塊 LED 自己的名字和位置，跟你 AE 合成裡的一樣。你的動畫就是照這些位置貼上去的。'
        : '現在 LED 上的格子圖叫測試圖：每塊 LED 自己的名字和位置，跟你 AE 合成裡的一樣。你的動畫就是照這些位置貼上去的。',
    },
    {
      id: 'local-file', target: 'source-file', waitFor: 'local-file',
      title: '把你的動畫放上去',
      body: '點「本地檔案」，把一支你從 AE 輸出的影片拖進來（整張 LED 畫布大小的那支）。只放在你這台電腦，不會上傳，別人看不到。',
      done: { title: '成功了', body: '這就是你的動畫在舞台上的樣子。按「下一步」繼續。' },
    },
    {
      id: 'cues', target: 'cue-bar',
      title: '播放和 cue',
      body: '小播放器可以播放、暫停、拉時間。這一排是 cue：點一個，舞台換成那個 cue 的樣子，影片也跳到那個時間。',
    },
    {
      id: 'add-video', target: 'add-video',
      title: '要給導演看的時候',
      body: '按「＋ 加影片」把影片交上來，導演就會收到。現在不用按，知道在這裡就好。',
    },
    {
      id: 'ae-live', target: 'source-ae',
      title: '想要 AE 一動，LED 就跟著動',
      body: '選「AE 即時」，你在 AE 裡改什麼，舞台上的 LED 馬上跟著變，不用先輸出。第一次要先裝兩個免費的小程式，上手教學裡有一步一步的做法。',
    },
    {
      id: 'record', target: 'record',
      title: '錄成影片',
      body: '放影片的時候，按「錄成影片」可以把舞台連同 LED 上的動畫錄成一個影片檔，直接傳給導演，或自己留著看。',
      missingHint: '放影片（或本地影片）的時候，這附近會出現「錄成影片」。',
    },
    {
      id: 'help', target: 'help',
      title: '卡住了怎麼辦',
      body: `每個區塊旁邊的「?」會打開那一段的說明；「上手教學」有整套一步一步的做法。還是不行，找${producerContactText(ctx.producerNames)}。`,
      missingHint: '「使用說明」在右上角「⋯」裡。',
    },
  ];
}

export function shouldAutoStartTour(o: { projectRole: ProjectRole | null; viewAsActive: boolean; seen: boolean }): boolean {
  return o.projectRole === 'animator' && !o.viewAsActive && !o.seen;
}

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

/** 瀏覽器不給讀（無痕、擋掉）→ 當作看過：記不住的話每次都跳出來太煩 */
export function readTourSeen(storage: ReadStore | null): boolean {
  if (!storage) return true;
  try { return storage.getItem(ANIMATOR_TOUR_SEEN_KEY) === '1'; } catch { return true; }
}

export function markTourSeen(storage: WriteStore | null): void {
  if (!storage) return;
  try { storage.setItem(ANIMATOR_TOUR_SEEN_KEY, '1'); } catch { /* 記不住就算了 */ }
}
```

- [ ] **Step 4: 跑測試，確認通過**

Run：`npx vitest run src/lib/tutorial/animatorTour.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/tutorial/animatorTour.ts web/src/lib/tutorial/animatorTour.test.ts
git commit -m "feat(上手教學): 帶著做的步驟和規則"
```

---

### Task 2: 亮框＋說明框元件 TourOverlay

**Files:**
- Create: `web/src/components/TourOverlay.tsx`, `web/src/components/TourOverlay.css`
- Create: `web/src/lib/tutorial/tourPlacement.ts`（說明框擺哪裡的純函式）＋ `tourPlacement.test.ts`

**Interfaces:**
- Consumes: `TourStep`（Task 1）
- Produces:
  ```ts
  export interface TourOverlayProps {
    steps: TourStep[];
    index: number;
    onIndex: (n: number) => void;
    /** 'skip' = 按跳過或 Esc；'done' = 最後一步按完成 */
    onClose: (reason: 'skip' | 'done') => void;
    /** 這一步要他做的事已經做到了（local-file 換成 done 的字） */
    stepDone: boolean;
    /** 最後一步多一個「打開上手教學」連結 */
    tutorialHref: string;
  }
  export default function TourOverlay(props: TourOverlayProps): JSX.Element
  ```
  ```ts
  // tourPlacement.ts
  export interface Rect { x: number; y: number; w: number; h: number }
  export type Placement = { mode: 'center' } | { mode: 'sheet' } | { mode: 'anchored'; side: 'below' | 'above' | 'right' | 'left'; x: number; y: number };
  export function placeBubble(target: Rect | null, bubble: { w: number; h: number }, viewport: { w: number; h: number }, gutter?: number): Placement
  ```

規則：
- **找目標**：`document.querySelector('[data-tour="<target>"]')`，要看得到才算（`getClientRects().length > 0`，寬高 > 0，不是 `display:none` / `hidden`）。同一個 target 有好幾個（例：寬畫面按鈕＋窄畫面選單）取第一個看得到的。
- **跟著動**：開著的時候用 `requestAnimationFrame` 每格量一次目標位置（目標會因捲動、拖小播放器、版面變動而移動），位置沒變就不重畫。關掉時取消。
- **亮框**：一個 `position:fixed` 的框，蓋在目標外面多 6px、圓角 8px，用 `box-shadow: 0 0 0 9999px rgba(0,0,0,.55)` 把其他地方變暗。**整層 `pointer-events:none`**：不擋滑鼠，他可以直接按亮起來的按鈕、拖舞台、把檔案拖進頁面；只有說明框接收點擊。
- **說明框**：標題、內容、「3 / 10」、按鈕「上一步」（第一步不顯示）、「下一步」（最後一步改「完成」）、文字按鈕「跳過」。最後一步多一個「打開上手教學」（`<a target="_blank" rel="noopener">`）。`stepDone` 時標題和內容換成 `step.done`。
- **擺哪裡**（`placeBubble`）：視窗寬 < 640 → `sheet`（貼在畫面底部、左右各 16px）；沒有目標 → `center`；有目標 → 下面放得下就下面，不然上面，不然右邊、左邊；都放不下 → `center`。座標夾在視窗內、離邊 16px。
- **找不到目標**：沒有亮框，說明框放中間（窄畫面還是 sheet），內容後面接 `step.missingHint`。
- **鍵盤**：Esc = 跳過；換步時把焦點放到「下一步」；`role="dialog"`、`aria-modal="false"`、`aria-labelledby` 指到標題。按鍵事件不要被工作站的空白鍵 / J K L 播放快捷鍵吃掉（說明框裡的按鍵 `stopPropagation`）。
- **樣式**：用專案現有的顏色變數（看 `Studio.css` / `index.css` 用哪些 `--...`），深色背景、圓角、陰影；`z-index` 要在工作站所有東西（含小播放器、選單）上面，但選單打開時選單要能被按到（亮框不擋滑鼠就沒問題）。不用 emoji。

- [ ] **Step 1: 寫 `tourPlacement.test.ts`**：至少這幾個案例——窄畫面 → sheet；沒目標 → center；目標在上半部 → below；目標在最下面 → above；目標佔滿高度、左邊有空 → right 或 left；結果座標都在 gutter 內。
- [ ] **Step 2: 跑，確認失敗**
- [ ] **Step 3: 寫 `tourPlacement.ts`**
- [ ] **Step 4: 跑，確認通過**
- [ ] **Step 5: 寫 `TourOverlay.tsx` / `.css`**，再寫 `web/src/components/TourOverlay.test.tsx`（用專案現有的 React 測試方式，看其他 `*.test.tsx` 怎麼寫）：找不到目標時顯示 missingHint；第一步沒有「上一步」；最後一步是「完成」且有「打開上手教學」連到 `tutorialHref`；Esc 叫 `onClose('skip')`；`stepDone` 時顯示 done 的標題。
- [ ] **Step 6: 跑測試通過 → Commit**：`feat(上手教學): 亮框和說明框`

---

### Task 3: 掛到工作站

**Files:**
- Modify: `web/src/pages/Studio.tsx`（目前 2025 行；先用 `graphify query` 或 grep 找位置，只讀需要的段落）
- Modify（如果需要樣式）: `web/src/pages/Studio.css`

**Interfaces:**
- Consumes: Task 1 全部、Task 2 `TourOverlay`

要做：
- [ ] **Step 1: 標記要亮的地方**（加 `data-tour`，不改長相）：
  - `songs-mine`：歌曲清單上面的「我的」分頁按鈕（約 1083 行 `setSongFilter('mine')`）。
  - `stage`：3D 舞台畫面的外框。
  - `source-file` / `source-ae`：LED 畫面來源切換裡的「本地檔案」「AE 即時」按鈕。
  - `cue-bar`：cue 列。
  - `add-video`：「＋ 加影片」。
  - `record`：「錄成影片」按鈕（約 741 行）。
  - `help`：上方列的使用說明入口（見 Step 4）。
- [ ] **Step 2: 狀態和自動出現**
  - `const [tourIndex, setTourIndex] = useState<number | null>(null)`。
  - 專案資料、成員、`projectRole` 都載好之後跑一次：`shouldAutoStartTour({ projectRole, viewAsActive: va.active, seen: readTourSeen(safeLocalStorage()) })` → true 就 `setTourIndex(0)`，**同時馬上** `markTourSeen(...)`（關掉分頁也不會被逼著再看一次；想再看從選單叫）。同一個分頁只跑一次（用 ref 記）。
  - `ctx`：`ledHasPicture` 照現在 LED 有沒有畫面算（影片版本有在放、本地檔案有選到東西、AE 即時有在送畫面；找出 StageScene 決定顯示測試圖的條件，用同一個條件），`producerNames = members.filter(m => m.role === 'admin').map(m => m.name)`。
  - `steps = animatorTourSteps(ctx)`（`useMemo`）。
- [ ] **Step 3: 要他動手的步驟**
  - 進到 `stage` 這一步時：如果現在 LED 來源是 AE 即時、而且 AE 沒在送畫面（3D 上蓋著 NDI 說明卡），就切到「本地檔案」（呼叫跟他自己按「本地檔案」一樣的函式，會記住）。來源是影片、或 AE 正在送畫面，不動。目的是讓第 3、4 步看得到舞台和測試圖。
  - `stage-drag`：在 `[data-tour="stage"]` 上聽 `pointerdown` → `pointermove` 移動超過 20px → 600ms 後自動到下一步（這段時間內他自己按了下一步就不要再跳一次）。離開這一步要拿掉監聽。
  - `local-file`：`source === 'file'` 而且本地檔案有選到一支（`media.active` 不是 null）→ `stepDone = true`，說明框換成「成功了」。不自動往下。
- [ ] **Step 4: 上方列入口**（1280 寬不能變成左右捲動）
  - 寬畫面：原本的「使用說明」連結（約 1012 行）換成一個下拉選單，按鈕長相和字不變（`<Icon icon={BookOpen} /> 使用說明`），用現有的 `OverflowMenu` 的 `trigger`（`{ icon: BookOpen, text: ' 使用說明', className: 'studio-top__help ovf-hide-narrow' }`，`align` 照位置選），裡面三項：「使用說明」（開新分頁，原本的網址）、「上手教學」（開新分頁，`ANIMATOR_TUTORIAL_PATH`）、「帶我走一遍」（`setTourIndex(0)`）。這個按鈕加 `data-tour="help"`。
  - 窄畫面的「⋯」：「使用說明」下面加「上手教學」「帶我走一遍」。
  - 「帶我走一遍」任何角色、「用動畫師的畫面看」都能按（手動叫出來不寫 seen 也沒關係）。
- [ ] **Step 5: 放上 `<TourOverlay>`**：`tourIndex !== null` 時渲染；`onClose` → `setTourIndex(null)`；`tutorialHref={ANIMATOR_TUTORIAL_PATH}`。錄影中（`recorder.locked`）不要顯示，正在帶的話先關掉。
- [ ] **Step 6: 測試**：如果 Studio 有現成的入口守門測試（像 `test/musicEntrances.test.ts` 那樣讀原始碼確認東西有接上），照樣寫一個 `test/tourEntrances.test.ts`：Studio 有八個 `data-tour` 標記、有「帶我走一遍」「上手教學」、有用 `shouldAutoStartTour` 和 `markTourSeen`。跑 `npx tsc -b`（或 `npm run build`）＋相關測試。
- [ ] **Step 7: Commit**：`feat(上手教學): 動畫師第一次進工作站帶著做一遍`

---

### Task 4: 教學頁 /tutorial/animator

**Files:**
- Create: `web/src/lib/tutorial/animatorTutorialContent.tsx`（內容資料）
- Create: `web/src/pages/AnimatorTutorial.tsx`, `web/src/pages/AnimatorTutorial.css`
- Create: `web/src/components/TutorialMedia.tsx`（圖片 / 短片，第二階段換短片用）
- Modify: `web/src/App.tsx`（加路由，跟 Help 一樣 `lazy` ＋ `ErrorBoundary`，不用登入）
- Modify: `web/src/pages/Help.tsx`（動畫師章節最上面加一條連結）
- Test: `web/src/lib/tutorial/animatorTutorialContent.test.ts`, `web/src/pages/AnimatorTutorial.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type TutorialMediaItem =
    | { kind: 'image'; src: string; alt: string; width?: number; height?: number }
    | { kind: 'clip'; src: string; poster: string; alt: string; width?: number; height?: number };
  export interface TutorialStep {
    id: string;              // 網址 #id，例 'login'、'before-you-start'
    title: string;
    /** 一到三句話（可以有 <strong>、說明頁的 <Ui> 那種按鈕字樣式） */
    lead: ReactNode;
    /** 照順序做的動作，一行一個動作 */
    actions?: ReactNode[];
    media?: TutorialMediaItem | null;
    /** 「想知道更多」：說明頁的段落 */
    more?: { anchor: HelpAnchor; label: string }[];
  }
  export interface TutorialSection { id: string; number: number; title: string; summary: string; steps: TutorialStep[] }
  export const ANIMATOR_TUTORIAL: TutorialSection[];
  /** 教學影片；第三階段做好之前是 null（不顯示那一塊） */
  export const ANIMATOR_TUTORIAL_VIDEO: { src: string; poster: string } | null;
  ```

內容（八段，照規格；每段一到四個 step）：
1. **先看這裡**（1 分鐘）：這是什麼（把動畫貼到真舞台上看）、幫你省什麼（跑現場、來回改、傳檔案）、你的 AE 做法不用改、三件最常做的事（在舞台上看、交一版、看導演意見）。`ANIMATOR_TUTORIAL_VIDEO` 不是 null 才放影片。
2. **第一次登入**：邀請連結（說明頁 `loginInvite`）、登入碼（`loginCode`）、進來之後找「我的」歌（`landing`、`animStudio`）。
3. **開工前：把 AE 合成做對**：LED 對位圖（`animLedMap`）、或用 AE 腳本一鍵建合成（`animAeScript`）；一句話講為什麼：畫布大小對了 LED 才對得準。
4. **做的時候在舞台上看**：本地檔案（`animSource`）→ AE 即時（第一次設定 `setup`、每次使用 `use`、裝小程式的下載連結沿用 `lib/downloads.ts`）→ 測試圖檢查對位（`animTestPattern`）→ 沒影片的歌聽音樂、看 cue 時間對拍子（`animStudio` 的音樂那段）。
5. **交一版**：AE 輸出設定（`animAeExport`，只講結論：H.264 的 MP4、整張 LED 畫布、建議位元率）→ 加影片（`animAddVideo`）→ 版本 V1 V2（`animVersions`）→ 提交審查（`animSubmit`）。
6. **錄成影片給導演**：在哪裡按、解析度、範圍、視角、cue 字幕、存成什麼檔、可以直接傳 Google Drive；AE 即時不能錄。事實照 `components/RecordStageDialog.tsx`、`lib/stageRecording.ts`。（說明頁沒有獨立段落，`more` 連 `animStudio`）
7. **導演有意見時**：看意見、點留言飛到那個視角、回覆、按「改好了」（`animFeedback`）→ 比較兩版 C 鍵（`animCompare`）。
8. **卡住了**：五種最常見的狀況，各給一個照做的解法並連到說明頁：LED 一片黑（`faqBlack`）、LED 對不準（`animTestPattern`：通常是 AE 合成大小不對或模型 UV，找製作）、上傳到一半斷掉（`qUpload`）、瀏覽器擋住（`faqBlocked` / `qPermission`）、Safari 不能用 AE 即時（`faqSafari`）。最後：「還是不行，找邀請你進來的製作。」

寫法：跟同事講話的口氣；先講做完會看到什麼，再講步驟；一行一個動作；按鈕字用說明頁那種按鈕字樣式（看 Help.tsx 的 `Ui` 元件，可以搬到共用的地方或在這頁做一個一樣的）；不用術語，必要的產品名（NDI、H.264）第一次出現時用一句話講是什麼。

畫面：
- 圖片先用 `web/public/help/animator/*.webp`、`web/public/help/win/*.png`、`web/public/help/start/*` 裡合適的（看 `pages/helpFigures.ts` 的 alt 和 caption 選）。沒有合適的就先不放，不要放空框。
- `TutorialMedia`：`image` → `<img loading="lazy">`；`clip` → `<video muted loop playsInline autoPlay preload="metadata" poster>`，使用者設了「減少動態」（`prefers-reduced-motion: reduce`）就不自動播、顯示播放鍵。都要有 `alt` / `aria-label`。

版面：
- 最上面：標題「動畫師上手教學」、副標「照著做一次就會。你在 AE 裡的做法不用改。」、連回「使用說明」。`document.title` 用 `'動畫師上手教學 — STAGE PREVIZ'`（跟 Help 一樣的寫法，離開時還原）。
- 寬畫面：左邊固定的八段目錄（數字＋標題，捲到哪一段就亮哪一段）；窄畫面：目錄變成上面一排可以左右滑的小按鈕（只有那一排可以左右滑，整頁不行）。
- 每一段一張卡：大數字、標題、一句摘要，下面是 step。
- 網址帶 `#段落id` 打開時捲到那裡。
- 顏色、字體沿用 Help 頁（看 `Help.css` 用的變數），深淺色都要正常。

- [ ] **Step 1: 寫 `animatorTutorialContent.test.ts`**：八段、編號 1～8；段落和 step 的 id 不重複；每個 `more.anchor` 都在 `HELP_ANCHORS` 的值裡；每個 `media.src` 對應 `web/public` 底下真的有的檔案（用 `node:fs` 檢查）；所有文字沒有英文角色字（把 ReactNode 轉成文字的方式看 Help 有沒有現成的，沒有就只檢查 string 欄位）；`ANIMATOR_TUTORIAL_VIDEO` 是 null。
- [ ] **Step 2: 跑，確認失敗**
- [ ] **Step 3: 寫內容資料檔**
- [ ] **Step 4: 跑，確認通過**
- [ ] **Step 5: 寫 `TutorialMedia`、頁面、CSS、路由**；`AnimatorTutorial.test.tsx`：八段標題都在、目錄有八個連結、`ANIMATOR_TUTORIAL_VIDEO` 是 null 時沒有影片區塊。
- [ ] **Step 6: Help 動畫師章節最上面加一條**：「第一次用？看〈動畫師上手教學〉，一步一步帶你做一次。」連到 `ANIMATOR_TUTORIAL_PATH`（同分頁）。
- [ ] **Step 7: 守門測試**：`npx vitest run src/test` 全過（英文角色字、emoji、原生對話框）。
- [ ] **Step 8: Commit**：`feat(上手教學): 動畫師上手教學頁（/tutorial/animator）`

---

### Task 5: 驗證（不上線）

- [ ] **Step 1**：在 `web/` 跑 `npx vitest run`（全部一次）和 `npm run build`（`npx tsc -b --noEmit` 會報 TS6310，用 build）。全過。
- [ ] **Step 2: 本機實測一次**（只在本機，正式站的資料一律不碰）：
  - `cf-worker/`：`.dev.vars` 放隨機產生的密鑰（測完刪掉）、`npx wrangler d1 migrations apply stage-previz-db --local`、`npx wrangler dev`（本機 D1 / R2）。
  - 本機 D1 建假帳號（一個製作、一個動畫師）和一個假專案：模型用 repo 根目錄的 `stage.glb`（只在本機測，不拍成教學畫面），兩首歌、幾個 cue，動畫師被指派其中一首。動畫師用正常的登入流程登入（登入碼或邀請連結），不要自己簽登入憑證。
  - `web/`：Vite dev，瀏覽器 localStorage 設 `stagepreviz-api-base` 指到本機 wrangler。
  - 檢查：動畫師第一次進工作站自動出現帶著做；十步走完（拖舞台會自動往下；把一支用 ffmpeg 做的小測試影片拖進本地檔案會變「成功了」）；重新整理不會再跳；「使用說明」選單的「帶我走一遍」叫得出來、「上手教學」開新分頁；製作「用動畫師的畫面看」不會自動跳；寬度 1280 和 375 都走一遍、不會整頁左右捲動、說明框不會跑出畫面。
  - 教學頁 `/tutorial/animator`：沒登入打得開；1280 和 375 捲到底沒有整頁左右捲動；目錄點得到；`#段落id` 打開會捲過去。
  - 截圖最多 2 張（一張帶著做、一張教學頁），存在 scratchpad。
  - 測完：關掉本機伺服器、刪 `.dev.vars`。
- [ ] **Step 3**：確認 `git diff --name-only master...HEAD` 沒有 `cf-worker/` 的檔案、沒有共用規則檔。
- [ ] **Step 4: 回報**（簡短）：做了什麼、測試數字、截圖路徑、哪些沒驗證到。不要上線（上線由主對話做）。
