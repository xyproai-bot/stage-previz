# 導演頁「調整舞台」模式（第 2 段：只預覽、不能存）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 導演頁上方多一個「審片 / 調整舞台」。調整舞台時點 3D 物件（或從右邊清單挑）→ 出現綠色把手 → 拖把手或用右邊面板改機關位置，3D 馬上看到；改的東西只是「草稿」，不存、不改任何後台資料。

**Architecture:**
- 草稿的狀態全部放在一個不靠 React 的小倉庫 `AdjustStore`（`web/src/lib/adjust/store.ts`，純 TS、可以測）。
  它自己有一個 `MechanismTweener`：調整舞台時 3D 上「每個機關的值」都由它決定（存的值 + 草稿；換 cue / 播轉場照轉場秒數走）。
- StageScene 只加三個掛鉤：
  1. `mechanismOverride?: () => MechanismValues | null` —— 每幀算完機關值之後，有回傳就蓋上去（審片時是 null，畫面完全照舊）。
  2. `adjustHostRef?: MutableRefObject<StageAdjustHost | null>` —— 把 scene / camera / canvas / 物件 / cue 位置 / 機關鏈 / 舞台範圍交出來，外加 `onFrame(cb)`（每幀套完機關之後、畫之前呼叫）。
  3. 沒有別的：選取外框、把手、虛線框都是 `components/adjust/` 自己加到 scene 裡的線和小形狀，不碰 LED 材質。
- 3D 上的把手、發亮的框、虛線框：`components/adjust/AdjustOverlay.tsx` + `components/adjust/handles.ts`（three.js 物件、拖拉）。
- 右邊面板、黃色提示列、模式切換：`components/adjust/AdjustPanel.tsx`、`AdjustBar.tsx`、`AdjustModeSwitch.tsx`。
- 拖的時候 React 不重畫整個導演頁：面板 / 提示列 / 3D 疊層各自 `useSyncExternalStore` 訂倉庫；導演頁只訂「開了沒、改了幾個、正在看哪個機關」。
- 行程線沿用 StageScene 現成的 `focusedMechanismId`（調整舞台時給「正在調的機關」）。

**Tech Stack:** React 18 + TS + three.js 0.169（`three/examples/jsm/lines` 的粗線）、vitest。

**Spec:** `docs/superpowers/specs/2026-10-29-director-stage-control-design.md` 第 2、4 節（第 3 節弧形軌道已做好；3.4 拆開對開別人在做）。

## Global Constraints

- 繁中介面、不用 emoji（用現有 `<Icon/>` + lucide 線條圖示）、不用原生對話框（用 `confirmDialog`）、畫面不出現英文角色字（`src/test/noEnglishRoleWords.test.ts`）。
- 只做預覽：不加速度 / 碰撞警告（`src/test/noMechanismSpeedWarnings.test.ts`）；不改任何後台、不改資料、不呼叫任何寫入 API。
- LED 畫面顏色不能變：不碰 LED 材質 / 渲染流程；把手、框只是額外的線。
- 審片模式的行為一點都不能變（留言、畫記、播放、換 cue 轉場）：所有新 prop 沒給 = 原本的行為。
- 新東西放 `web/src/lib/adjust/`、`web/src/components/adjust/`；StageScene、Preview、useMechanisms 只加最少的掛鉤。
- 草圖（scratchpad 的 mockup）裡的真實舞台數字不能進程式庫；測試和測試頁用自己編的數字。
- 每個 Task 一個 commit（中文、不加署名）。驗證：`cd web && npx tsc --noEmit` + 相關測試。

---

### Task 1: 純計算（草稿、對齊、整組、權限）

**Files:**
- Create: `web/src/lib/adjust/draft.ts`、`snap.ts`、`scope.ts`、`permissions.ts`
- Test: `web/src/lib/adjust/draft.test.ts`、`snap.test.ts`、`scope.test.ts`、`permissions.test.ts`

**Interfaces（Produces）:**
- `draft.ts`
  - `type Draft = MechanismValues`（只放改過的機關）
  - `setDraftValue(draft, saved, id, v): Draft`（跟存的一樣 → 拿掉）
  - `revertDraft(draft, ids): Draft`、`effectiveValues(saved, draft): MechanismValues`、`changedIds(draft): string[]`
  - `moveTogether(start, ids, primaryId, primaryTarget, ranges): MechanismValues`（每個加一樣的量，各自夾在行程內）
- `snap.ts`：`snapValue(raw, { kind, presets, min, max, free }): number`（不按 Alt：先吸常用位置（直線 0.15 m / 旋轉 3°），再對齊 0.1 m / 1°；一律夾在行程內）
- `scope.ts`
  - `type ScopeKey = 'one' | 'all' | 'left' | 'right'`
  - `splitHalves(members: { id; pos }[], front): { left: string[]; right: string[] }`（觀眾看過去的左右：右 = (-front) × 上）
  - `driveIds(...)`：這個把手 / 滑桿一次動哪些機關（一排：只有這個 / 整排 / 左半 / 右半；吊點：左右一起 = 整組吊點）
- `permissions.ts`：`canAdjustStage({ projectRole, accountRole })`（導演、製作、全站製作）、`showAdjustSwitch({ canAdjust, mode, hasMechanisms })`（Cue 庫模式 + 有機關才出現）

- [ ] Step 1: 寫測試（會失敗）：草稿跟存的一樣就拿掉；一起動時夾在行程內不影響別的；對齊常用位置 / 0.1 m / 1°、Alt 不對齊、不超出行程；左右分半（偶數 / 奇數 / 正面朝別的方向）；權限表（導演 / 製作 / 全站製作看得到，動畫師、沒角色看不到；不是 Cue 庫模式不出現）。
- [ ] Step 2: `npx vitest run src/lib/adjust` 確認失敗
- [ ] Step 3: 實作
- [ ] Step 4: 測試過 + `npx tsc --noEmit`
- [ ] Step 5: Commit `feat(調整舞台): 草稿、對齊、整組、誰看得到的純計算`

### Task 2: 純計算（讀數、看的角度、拖拉的數學）

**Files:**
- Create: `web/src/lib/adjust/readouts.ts`、`views.ts`、`dragMath.ts`
- Test: 對應的 `*.test.ts`

**Interfaces（Produces）:**
- `readouts.ts`
  - `spinFromPrevText({ prevName, prev, cur, axisY }): string`：「從上一個 cue（…）轉過來：從上面看逆時針轉 180°（半圈）」/「跟上一個 cue 一樣，不轉」；沒有上一個 cue → 「從預設位置轉過來：…」；轉軸不是垂直 → 不講方向（`null`）
  - `turnsText(deg)`：半圈 / 1 圈 / 1.5 圈 / 2 圈…
  - `arcReadout({ pivot, axis, radiusM, center, front, sceneToMeters, value }): { towardM, turnDeg }`、`arcReadoutText(r): string`（「往觀眾靠近 1.2 公尺、轉 8 度」/「往後退…」）
- `views.ts`：`stageView(kind: 'audience' | 'top' | 'side', bounds, front, fov): CameraView`、`focusView(center, radius, stageCenter, fov): CameraView`（吊掛用：從舞台那一側看過去）
- `dragMath.ts`：`closestParamOnLine(rayO, rayD, lineO, lineD)`（太平行 → null）、`angleOnPlane(rayO, rayD, center, normal, ref)`（側著看 → null）、`wrapPi(a)`、`distToSegment2D`、`distToPolyline2D`

- [ ] Step 1: 測試（會失敗）：逆 / 順時針跟轉軸正負、180 / −180 方向相反、半圈 / 一圈 / 兩圈；弧形往前 / 往後、值 0 = 0、轉的角度 = 值 ÷ 半徑；三個視角都看著舞台中心、正上方不會正好垂直（避免鏡頭翻）；射線找線上最近點、平面上的角度、側著看回 null。
- [ ] Step 2–4: 確認失敗 → 實作 → 過 + tsc
- [ ] Step 5: Commit `feat(調整舞台): 自轉方向 / 弧形讀數、三個看的角度、拖把手的數學`

### Task 3: 草稿倉庫 AdjustStore

**Files:**
- Create: `web/src/lib/adjust/store.ts`
- Test: `web/src/lib/adjust/store.test.ts`

**Interfaces（Produces）:**
```ts
class AdjustStore {
  subscribe(fn): () => void; getState(): AdjustState;
  setDefs(defs: Mechanism[]): void;                      // 機關定義（算鏈、一排、吊掛）
  setCue(ctx: AdjustCueContext, nowMs): { dropped: number }; // 換 cue：草稿是別的 cue 的 → 丟掉（回傳丟了幾個）
  setHalves(fn: (groupId) => { left; right } | null): void;
  enter(nowMs, shown): void; exit(): void;               // 開 / 關調整舞台（關 = 草稿丟掉）
  select(sel | null): void; selectMechanism(mechId): void; selectObject(objectId): boolean;
  setScope(groupId, scope): void; setLinked(rigId, linked): void;
  controls(): AdjustControl[];                          // 選到的物件的機關鏈 → 面板 / 把手要畫的
  driveIds(mechId): string[];
  beginDrag(mechId): void; dragTo(mechId, raw, free): void; endDrag(): void;
  setValue(mechId, v): void; applyPreset(mechId, v): void;
  revert(mechIds): void; discardAll(): void;
  play(nowMs): void;                                    // 播轉場：上一個 cue → 草稿值
  override(nowMs): MechanismValues | null;              // StageScene 每幀問
  affectedObjects(): string[]; ghostObjects(): string[];
  value(id) / saved(id) / changedCount()
}
```
- [ ] Step 1: 測試（會失敗）：開了以後 override = 存的值；改一個 → override 馬上變、changedCount 1；回到存的值 / 放棄全部；整排一起拖每個加一樣的量；左半 / 右半；吊點預設左右一起、取消後單調一邊；換 cue → 草稿丟掉、override 照轉場秒數走過去；播轉場從上一個 cue 走到草稿值、走完 playing = false；關掉 → override null。
- [ ] Step 2–4
- [ ] Step 5: Commit `feat(調整舞台): 草稿倉庫（選取、整組、吊點連動、播轉場、換 cue）`

### Task 4: StageScene / useStageMechanisms 的掛鉤

**Files:**
- Modify: `web/src/components/StageScene.tsx`（props `mechanismOverride`、`adjustHostRef`；`mechValuesFor` 最後蓋上 override；tick 在 `commitPoses` 後呼叫 frame hooks；一個 effect 設 host）
- Modify: `web/src/lib/mechanisms/useMechanisms.ts`（`useStageMechanisms` 多回傳 `mode`、`valuesForCue(cueId)`）

**Interfaces（Produces）:**
```ts
export interface StageAdjustHost {
  scene(): THREE.Scene | null; camera(): THREE.PerspectiveCamera | null; canvas(): HTMLCanvasElement | null;
  meshes(): ReadonlyMap<string, THREE.Object3D>;
  basePose(id): { pos: THREE.Vector3; quat: THREE.Quaternion } | null;
  rig(): CompiledRig; shownValues(): MechanismValues;
  stageBounds(): { center: THREE.Vector3; radius: number };
  onFrame(cb: (nowMs: number) => void): () => void;
}
```
- [ ] Step 1: 改；沒給新 prop 時一行行為都不變（override 沒給 → 不走新的那段）
- [ ] Step 2: `npx tsc --noEmit`、`npx vitest run src/lib/mechanisms src/components`
- [ ] Step 3: Commit `feat(3D 畫面): 給調整舞台的兩個掛鉤（機關值蓋上去、交出舞台給把手用）；沒用到時照舊`

### Task 5: 3D 疊層（發亮的框、虛線框、把手、看的角度、播轉場）

**Files:**
- Create: `web/src/components/adjust/handles.ts`（three.js：框、虛線框、直線箭頭、弧形 / 門的把手、自轉的地上圈；螢幕上固定大小；挑把手用螢幕距離）
- Create: `web/src/components/adjust/AdjustOverlay.tsx`（掛在 StageScene 旁邊；在 canvas 的上一層用 capture 攔 pointerdown：點到把手才攔，沒點到照常轉鏡頭；放開時沒動 = 點物件）
- Create: `web/src/components/adjust/AdjustStage.css`

- [ ] Step 1: 框和虛線框：選到的物件 = 綠色實線框（跟著動）；改過的物件在「存的位置」留白色虛線框
- [ ] Step 2: 把手：直線 / 升降 = 沿方向的雙箭頭；弧形軌道、門 = 物件上的圓點 + 切線箭頭，沿圓拖；自轉 = 物件底下地上的圈 + 圓點；吊掛 = 每個吊點一個上下箭頭
- [ ] Step 3: 拖：直線用射線找線上最近點（太平行改用螢幕方向），圓用平面角度（側著看改用螢幕方向）；Alt 不對齊；呼叫 `store.dragTo`
- [ ] Step 4: 工具列：觀眾看 / 正上方 / 側面 / 播轉場；選到吊掛 → 鏡頭飛過去
- [ ] Step 5: `npx tsc --noEmit`；Commit `feat(調整舞台): 3D 上的把手、發亮的框、存的位置虛線框、看的角度`

### Task 6: 右邊面板、黃色提示列、模式切換

**Files:**
- Create: `web/src/components/adjust/AdjustPanel.tsx`、`AdjustBar.tsx`、`AdjustModeSwitch.tsx`、`useAdjustStage.ts`
- Modify: `web/src/components/adjust/AdjustStage.css`
- Test: `web/src/lib/adjust/panelText.test.ts`（面板的字：數值、範圍、提示，沒有英文叫人的字、沒有 emoji）

- [ ] Step 1: 清單（一排 / 吊掛 / 單一機關，改過的標黃色）；選到後：每個機關一段（整組選、常用位置、滑桿 + 數字、讀數、回到存的值）；放棄全部改動
- [ ] Step 2: 黃色提示列：「改了 N 個機關」+「放棄」+「存回 Cue 庫（下一版開放）」（按不下去）
- [ ] Step 3: `useAdjustStage`：建倉庫、同步機關定義 / cue / 上一個 cue / 轉場秒數；`guard(action)`（有改 → confirmDialog「放棄這些改動？」）；beforeunload
- [ ] Step 4: tsc + 測試；Commit `feat(調整舞台): 右邊面板、黃色提示列、審片 / 調整舞台切換`

### Task 7: 接到導演頁

**Files:**
- Modify: `web/src/pages/Preview.tsx`（SongDetail：切換鈕、StageScene 新 props、右邊換成面板（留言區留著、只是藏起來）、cue 列 / Shift+J/K / 上下首 / 回總覽 / 切回審片都先問、開調整舞台時影片暫停、自動播放停）
- Modify: `web/src/pages/Preview.css`（最少）

- [ ] Step 1: 接上；審片時所有 props 跟原本一樣（override、host 沒給；focusedMechanismId null）
- [ ] Step 2: `npx tsc --noEmit`、`npx vitest run`
- [ ] Step 3: Commit `feat(導演頁): 接上調整舞台（只預覽、不能存）`

### Task 8: 驗證

- [ ] 全部 `npx vitest run`、`npm run build`
- [ ] 臨時測試頁（`web/adjust-test.html` + `src/dev/adjustHarness.tsx`：真的 StageScene + 假機關：弧形 + 自轉 + 升降 + 吊掛）→ 瀏覽器點一次、最多 3 張截圖 → 刪掉測試頁（不 commit）
- [ ] 計畫檔最後補「結果 / 跟規格不一樣的地方」，Commit `docs(調整舞台): 第 2 段做完的紀錄`

---

## 結果（2026-10-29）

Task 1–8 都做完。全部 `npx vitest run` 192 個檔 / 2621 個測試過；`npm run build` 過（大檔警告是原本就有的）。

**瀏覽器實測（一次）：** 臨時測試頁（真的 StageScene + 編的小舞台：4 片沿弧形軌道 + 自轉的 LED、升降平台、兩個吊點的提詞 LED），
用 headless Chrome 真的滑鼠操作（App 裡的瀏覽器窗格被判定成看不到、3D 不畫，所以改用 headless）：
點 3D 物件選到、拖弧形把手（對齊 0.1 m、讀數「往觀眾靠近…、轉…度」）、拖地上的圈轉自轉（讀數「從上一個 cue 轉過來：從上面看逆時針…」）、
整排一起、吊點左右一起 / 取消後單調一邊（提詞 LED 斜了）、按住 Alt 不對齊、拖到常用位置會吸過去、不超出行程、播轉場（從上一個 cue 走到草稿值、走完自動停）、
正上方 / 觀眾看、切回審片先問「放棄這些改動？」→ 放棄後 3D 回到存的值；console 沒有錯誤。測完測試頁已刪掉（沒有 commit）。
截圖：scratchpad 的 `adjust-1-led.jpg`、`adjust-2-hoist.jpg`、`adjust-3-top.jpg`（截圖之後又把操作提示移到工具列下面，圖上提示還在左下角）。

**跟規格 / 交代不一樣的地方：**
- 切換鈕除了「Cue 庫模式」以外，還要「專案有機關」才出現（沒有機關時打開也沒東西可調）。
- 「放棄」（黃色提示列、面板最下面）直接放棄不再問一次（按鈕本身就是放棄）；切 cue / 切回審片 / 換歌 / 回總覽才問。
- 影片在播、自動切 cue、通知點進來這種「不是使用者點的」換 cue 擋不住 → 草稿丟掉並跳一則提醒；打開調整舞台時先把影片停掉、自動切 cue 關掉，調整舞台時自動切 cue 的按鈕按不下去。
- 「側面」固定從觀眾看過去的右邊看。
- 吊掛的鏡頭「轉過去」= 從舞台那一側看提詞 LED（離開吊掛再選別的會飛回觀眾看）。
- 一排機關在清單上的名字用成員名字共同的開頭（沒有另外讀「一排」的名稱）。
- 沒跑 `led-color-accuracy.mjs`：沒有動 LED 材質 / 畫法（只多了每幀的掛鉤和額外的線），而且這台沒有裝 playwright-core。

**下一段（存回 Cue 庫）要接的地方：** `AdjustStore.getState().draft`（只有改過的機關）、`store.cue()`（cue id / 名字）；
`AdjustBar` 的「存回 Cue 庫」按鈕目前 disabled。
