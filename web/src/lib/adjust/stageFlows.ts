// 調整舞台第 3 段：存起來的流程（存回 Cue 庫 / 另存成新 cue / 復原 / 衝突 / 複製 / 改名 / 轉場秒數）。
// 每個動作：先問清楚（會影響哪些歌）→ 呼叫後台 → 重新讀位置 / cue → 提示。
// 不靠 React：後台呼叫和畫面（對話框、提示）都從外面傳進來，所以測得到（stageFlows.test.ts）。
// 畫面這一層是 components/adjust/useStageSave.ts。後台一律再檢查一次權限和欄位（cf-worker/cueLibraryStage.mjs）。

import type { Cue } from '../api';
import type { CueMechanismPosition } from '../mechanisms/model';
import type { ChooseOptions, ConfirmOptions, PromptOptions } from '../../components/dialogs/dialogStore';
import type { LibraryCueUsage } from '../cueLibraryApi';
import { friendlyError } from '../songReview';
import type { Draft } from './draft';
import type { AdjustStore } from './store';
import {
  STAGE_SAVE_TEXT, buildStageRows, copiedText, copyHint, defaultCopyName, defaultSaveAsName, libraryRowsOf, parseSeconds, renamedText,
  saveAsHint, saveBackMessage, savedAsText, savedText, secText, secondsDoneText, secondsHint, secondsTitle, undoneText, usageSongs,
} from './saveBack';
import {
  isStageConflict, type CopyResult, type SaveAsResult, type SaveBackResult, type StageApiError, type StageMechRow, type StageSong,
} from './stageApi';

/** 流程用到的後台呼叫（平常是 stageApi.ts / cueLibraryApi.ts 的函式，測試換成假的） */
export interface StageFlowApi {
  saveStagePositions(projectId: string, lcId: string, body: { ifRev: number; mechanisms: StageMechRow[]; songId?: string; undo?: boolean }): Promise<SaveBackResult>;
  saveStageAs(projectId: string, lcId: string, body: { name?: string; mechanisms: StageMechRow[]; songId: string; cueId: string }): Promise<SaveAsResult>;
  copyStageCue(projectId: string, lcId: string, body: { name?: string }): Promise<CopyResult>;
  patchStageCue(projectId: string, lcId: string, body: { name?: string; crossfadeSeconds?: number; songId?: string }): Promise<unknown>;
  setSlotStageCrossfade(projectId: string, songId: string, cueId: string, crossfadeSeconds: number): Promise<unknown>;
  getLibraryCueUsage(projectId: string, lcId: string): Promise<Pick<LibraryCueUsage, 'slots'>>;
}

/** 流程用到的畫面（對話框、提示） */
export interface StageFlowUi {
  confirm(o: ConfirmOptions): Promise<boolean>;
  prompt(o: PromptOptions): Promise<string | null>;
  choose(o: ChooseOptions): Promise<string | null>;
  toast: { success(t: string): void; info(t: string): void; warn(t: string): void; error(t: string): void };
  /** 下面的綠色提示（有 undo = 有「復原」） */
  notice(text: string | null, undo?: () => Promise<void>): void;
}

type StoreLike = Pick<AdjustStore, 'saveTarget' | 'changedCount' | 'discardAll'> & { getState(): { draft: Draft; stale?: boolean } };

export interface StageFlowDeps {
  projectId: string;
  song: { id: string; name: string; code?: string | null };
  /** 現在選的 cue（這首歌的 slot）；沒有 → null */
  cue: Pick<Cue, 'id' | 'name' | 'crossfadeSeconds' | 'crossfadeOwn' | 'libraryCueId' | 'libraryCue' | 'libraryCrossfadeSeconds'> | null;
  store: StoreLike;
  /** 這首歌讀到的機關位置列（每個 slot 一份） */
  positionRows: readonly CueMechanismPosition[];
  /** 重新讀位置（true = 讀到了） */
  reloadPositions(): Promise<boolean>;
  /** 重新讀這首歌的 cue（改名 / 另存 / 改秒數之後名字、編號、秒數才會更新） */
  reloadCues(): Promise<void>;
  api: StageFlowApi;
  ui: StageFlowUi;
}

/** getDeps 每次問都給最新的（流程裡有對話框，問完以後資料也許已經自動更新過） */
export function createStageFlows(getDeps: () => StageFlowDeps) {
  /** 現在存的列 + 草稿 = 要送的整份 */
  const currentRows = (lcId: string): StageMechRow[] => {
    const d = getDeps();
    return buildStageRows(libraryRowsOf(d.positionRows, lcId), d.store.getState().draft);
  };

  // ── 復原：用後台回的上一版再存一次（一樣帶版本，被別人改過就不能復原）──
  async function undo(p: { lcId: string; label: string; rev: number; previous: StageMechRow[] }): Promise<void> {
    const d = getDeps();
    try {
      await d.api.saveStagePositions(d.projectId, p.lcId, { ifRev: p.rev, mechanisms: p.previous, songId: d.song.id, undo: true });
    } catch (e) {
      d.ui.notice(null);
      void d.reloadPositions();
      d.ui.toast.error(isStageConflict(e) ? `${e.message}，沒辦法復原。重新載入再調吧。` : friendlyError(e));
      return;
    }
    await getDeps().reloadPositions();
    getDeps().ui.notice(undoneText(p.label));
  }

  // ── 另存成新 cue ──
  async function saveAs(): Promise<void> {
    const d = getDeps();
    const t = d.store.saveTarget();
    if (!t.libraryCueId || !t.cueId) { d.ui.toast.warn(STAGE_SAVE_TEXT.noCue); return; }
    const label = t.libraryLabel ?? t.cueName;
    const input = await d.ui.prompt({
      title: STAGE_SAVE_TEXT.saveAsTitle, label: STAGE_SAVE_TEXT.saveAsLabel, defaultValue: defaultSaveAsName(t.cueName),
      hint: saveAsHint(label), confirmLabel: STAGE_SAVE_TEXT.saveAsConfirm, maxLength: 100,
    });
    const name = input?.trim();
    if (!name) return;
    const r = await d.api.saveStageAs(d.projectId, t.libraryCueId, { name, mechanisms: currentRows(t.libraryCueId), songId: d.song.id, cueId: t.cueId });
    // 新的 cue 名字、編號、位置都要讀回來；位置讀回來以後，跟草稿一樣的就不算改了（畫面不跳）
    const [, okPos] = await Promise.all([getDeps().reloadCues(), getDeps().reloadPositions()]);
    if (!okPos) getDeps().ui.toast.warn(STAGE_SAVE_TEXT.reloadFailed);
    getDeps().ui.notice(savedAsText(r.libraryCue.label));
  }

  // ── 衝突：被別人搶先改過 ──
  async function onConflict(e: StageApiError): Promise<void> {
    const d = getDeps();
    void d.reloadPositions();   // 先讀最新的，提示列也會馬上出現「被別人改過」
    const choice = await d.ui.choose({
      title: e.message, message: STAGE_SAVE_TEXT.conflictMessage, cancelLabel: STAGE_SAVE_TEXT.conflictKeep,
      choices: [{ value: 'reload', label: STAGE_SAVE_TEXT.reload, primary: true }, { value: 'saveAs', label: STAGE_SAVE_TEXT.saveAs }],
    });
    if (choice === 'reload') {
      getDeps().store.discardAll();
      await getDeps().reloadPositions();
      getDeps().ui.toast.info(STAGE_SAVE_TEXT.reloaded);
    } else if (choice === 'saveAs') {
      await saveAs();
    }
  }

  // ── 存回 Cue 庫 ──
  async function saveBack(): Promise<void> {
    const d = getDeps();
    const t = d.store.saveTarget();
    const changed = d.store.changedCount();
    if (changed === 0) return;
    if (!t.libraryCueId) { d.ui.toast.warn(STAGE_SAVE_TEXT.noCue); return; }
    if (t.baseRev === null) { d.ui.toast.warn(STAGE_SAVE_TEXT.oldBackend); return; }
    const lcId = t.libraryCueId;
    const label = t.libraryLabel ?? t.cueName;
    // 先列出哪些歌會一起變。開始調之後這個 cue 已經被別人改過（stale）→ 反正後台會擋下來，直接去問後台「被誰改過」，不用再問「要存嗎」
    if (!d.store.getState().stale) {
      let songs: StageSong[];
      try {
        songs = usageSongs(await d.api.getLibraryCueUsage(d.projectId, lcId));
      } catch { d.ui.toast.error(STAGE_SAVE_TEXT.usageFailed); return; }
      const sure = await d.ui.confirm({
        title: STAGE_SAVE_TEXT.saveBackTitle(label), message: saveBackMessage(songs, changed), confirmLabel: STAGE_SAVE_TEXT.saveBackConfirm,
      });
      if (!sure) return;
    }
    // 問的時候資料也許又更新過：版本要用「開始調的那一刻」的（有人搶先改過，後台就會擋下來）；位置列和草稿用現在的
    const now = getDeps();
    const baseRev = now.store.saveTarget().baseRev;
    if (baseRev === null) return;
    let r: SaveBackResult;
    try {
      r = await now.api.saveStagePositions(now.projectId, lcId, { ifRev: baseRev, mechanisms: currentRows(lcId), songId: now.song.id });
    } catch (e) {
      if (isStageConflict(e)) { await onConflict(e); return; }
      throw e;
    }
    if (r.unchanged) {
      now.ui.toast.info(STAGE_SAVE_TEXT.unchanged);
      now.store.discardAll();
      return;
    }
    // 讀回最新的位置：草稿裡跟剛存進去的一樣的就自動不算改了（畫面不跳）
    const okPos = await getDeps().reloadPositions();
    if (!okPos) getDeps().ui.toast.warn(STAGE_SAVE_TEXT.reloadFailed);
    const previous = r.previous?.mechanisms;
    getDeps().ui.notice(
      savedText(label, r.changed, r.songs),
      previous ? () => undo({ lcId, label, rev: r.rev, previous }) : undefined,
    );
  }

  // ── 複製 / 改名 / 轉場秒數 ──
  async function copy(): Promise<void> {
    const d = getDeps();
    const cue = d.cue, lcId = cue?.libraryCueId;
    if (!cue || !lcId) { d.ui.toast.warn(STAGE_SAVE_TEXT.noSelectedCue); return; }
    const label = cue.libraryCue?.label ?? cue.name;
    const input = await d.ui.prompt({
      title: STAGE_SAVE_TEXT.copyTitle(label), label: STAGE_SAVE_TEXT.copyLabel, defaultValue: defaultCopyName(cue.name),
      hint: copyHint(label, d.store.changedCount() > 0), confirmLabel: STAGE_SAVE_TEXT.copyConfirm, maxLength: 100,
    });
    const name = input?.trim();
    if (!name) return;
    const r = await d.api.copyStageCue(d.projectId, lcId, { name });
    getDeps().ui.toast.success(copiedText(r.libraryCue.label));
  }

  async function rename(): Promise<void> {
    const d = getDeps();
    const cue = d.cue, lcId = cue?.libraryCueId;
    if (!cue || !lcId) { d.ui.toast.warn(STAGE_SAVE_TEXT.noSelectedCue); return; }
    const label = cue.libraryCue?.label ?? cue.name;
    const input = await d.ui.prompt({
      title: STAGE_SAVE_TEXT.renameTitle(label), label: STAGE_SAVE_TEXT.renameLabel, defaultValue: cue.name,
      hint: STAGE_SAVE_TEXT.renameHint, confirmLabel: STAGE_SAVE_TEXT.renameConfirm, maxLength: 100,
    });
    const name = input?.trim();
    if (!name || name === cue.name) return;
    await d.api.patchStageCue(d.projectId, lcId, { name, songId: d.song.id });
    await getDeps().reloadCues();
    getDeps().ui.toast.success(renamedText(label, name));
  }

  async function seconds(): Promise<void> {
    const d = getDeps();
    const cue = d.cue, lcId = cue?.libraryCueId;
    if (!cue || !lcId) { d.ui.toast.warn(STAGE_SAVE_TEXT.noSelectedCue); return; }
    const label = cue.libraryCue?.label ?? cue.name;
    // 這首歌自己另外設了秒數 → 改的是這首歌自己的；沒有 → 改 Cue 庫的（先列出用到的歌）
    const own = cue.crossfadeOwn === true;
    let songs: StageSong[] = [];
    if (!own) {
      try { songs = usageSongs(await d.api.getLibraryCueUsage(d.projectId, lcId)); } catch { d.ui.toast.error(STAGE_SAVE_TEXT.usageFailed); return; }
    }
    const librarySeconds = typeof cue.libraryCrossfadeSeconds === 'number' ? cue.libraryCrossfadeSeconds : null;
    const current = own ? cue.crossfadeSeconds : librarySeconds ?? cue.crossfadeSeconds;
    const input = await d.ui.prompt({
      title: secondsTitle(own, label), label: STAGE_SAVE_TEXT.secondsLabel, defaultValue: secText(current),
      hint: secondsHint({ own, label, ownSeconds: cue.crossfadeSeconds, librarySeconds, songs }),
      confirmLabel: STAGE_SAVE_TEXT.secondsConfirm,
      validate: v => { const p = parseSeconds(v); return p.ok ? null : p.error; },
    });
    if (input === null) return;
    const sec = parseSeconds(input);
    if (!sec.ok || sec.value === current) return;
    if (own) await d.api.setSlotStageCrossfade(d.projectId, d.song.id, cue.id, sec.value);
    else await d.api.patchStageCue(d.projectId, lcId, { crossfadeSeconds: sec.value, songId: d.song.id });
    await getDeps().reloadCues();
    getDeps().ui.toast.success(secondsDoneText(own, label, sec.value));
  }

  return { saveBack, saveAs, undo, copy, rename, seconds };
}
