// 新專案精靈（專案總覽「新增專案」）：一步一步把專案準備好，每一步都可以先跳過、之後再做。
//   1 名稱          專案名稱、Show（巡迴）、描述 → 按「建立專案」專案就建好了（後面每一步都直接存到這個專案上）
//   2 3D 模型       用「上傳 3D 模型」對話框（UploadModelDialog，跟編輯頁同一個）→ 顯示「找到 12 片 LED、2 個機關…」
//   3 LED 畫布大小  跟 3D 工具列「設定畫布大小…」存同一個地方（projects.led_canvas）；有模型就畫一張小的 LED 對位圖
//   4 歌單          貼上歌單（一行一首）→ 代號自動排（可以改）、專案裡有動畫師的話可以先指派
//   5 邀請人        邀請連結（跟「邀請」對話框同一塊：InvitePanel），訊息直接貼 LINE / 微信
//   6 完成          做了什麼、還沒做什麼 → 進入編輯頁 / 建立分享連結 / 用其他身分看
//
// 步驟放在網址上（?new=<步驟>&project=<id>，Admin.tsx 管）：瀏覽器 / 手機的「上一頁」= 上一步，重新整理也還在同一步。
// Esc / 右上角關掉 = 先離開，做好的都已經存在專案上；這台電腦記得做到哪（專案總覽會出現「繼續設定」）。
// 純計算（歌單、代號、步驟、進度）在 lib/newProjectWizard.ts，有單元測試。
// 每一步的按鈕用 portal 放到下面固定的那一條（手機上內容很長時按鈕還是在畫面最下面）。

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowRight, Box, Check, Circle, CircleCheck, CircleHelp, Eye, Flag, FolderPlus, Frame, Link2, ListMusic,
  LoaderCircle, RotateCcw, Trash2, TriangleAlert, Upload, UserPlus, X,
} from 'lucide-react';
import * as api from '../lib/api';
import type { Show, Song, StageObject } from '../lib/api';
import type { ProjectMember } from '../lib/mockData';
import {
  WIZARD_STEPS, stepIndex, stepLabel, nextStep, prevStep, type WizardStep,
  parseSetlist, assignSongCodes, songCodeProblems, songNameKey, SONG_NAME_MAX, SONG_CODE_MAX,
  newProgress, markStep, readWizardProgress, writeWizardProgress, type StepMark, type WizardProgress,
  describeObjectCounts, countByCategory, parseCanvasFields, aspectText, DEFAULT_WIZARD_CANVAS,
} from '../lib/newProjectWizard';
import { sameLedCanvas, type LedCanvas } from '../lib/ledCanvas';
import { buildLedLayout, todayString, type LedPanelInput } from '../lib/ledMap';
import { drawAlignmentMap } from '../lib/ledMapDraw';
import { HELP_ANCHORS, helpUrl } from '../lib/helpLinks';
import { friendlyError } from '../lib/songReview';
import { toast } from '../lib/toast';
import Icon from './Icon';
import UploadModelDialog from './UploadModelDialog';
import ShareLinksDialog from './ShareLinksDialog';
import OverflowMenu from './OverflowMenu';
import { useViewAsMenu, VIEW_AS_MENU_LABEL } from './ViewAsMenu';
import { InvitePanel } from './InviteDialog';
import { STAGE_CATEGORY, STAGE_CATEGORY_ORDER } from './stageCategories';
import './NewProjectDialog.css';
import './InviteDialog.css';
import './NewProjectWizard.css';

interface Props {
  step: WizardStep;
  /** 已經建好的專案（第 1 步按「建立專案」之後才有） */
  projectId: string | null;
  /** 換到某一步（replace = 不留在瀏覽器的上一頁紀錄裡） */
  onGo: (step: WizardStep, projectId: string | null, opts?: { replace?: boolean }) => void;
  /** 上一步：有上一頁紀錄就用瀏覽器的上一頁，沒有就換過去 */
  onBack: (step: WizardStep, projectId: string | null) => void;
  /** 關掉精靈（回到專案總覽） */
  onClose: () => void;
  /** 進入編輯頁 */
  onOpenEditor: (projectId: string) => void;
  /** 專案剛建好（專案總覽重新整理卡片） */
  onProjectCreated?: (projectId: string) => void;
}

interface Facts {
  project: { name: string; description: string; showId: string | null };
  objects: StageObject[];
  model: api.ModelInfo | null;
  ledCanvas: LedCanvas | null;
  songs: Song[];
  members: ProjectMember[];
  openInvites: number;
}

type FactsState = { status: 'none' } | { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; facts: Facts };

const STEP_ICONS: Record<WizardStep, typeof Box> = {
  name: FolderPlus, model: Box, canvas: Frame, songs: ListMusic, invite: UserPlus, done: Flag,
};

/** 這個專案現在的樣子（每一步需要的資料一次讀好；做完一步再讀一次） */
async function loadFacts(projectId: string): Promise<Facts> {
  const [info, objects, model, view, songs, meta, invites] = await Promise.allSettled([
    api.getProjectInfo(projectId),
    api.listStageObjects(projectId),
    api.getModelInfo(projectId),
    api.getProjectViewSettings(projectId),
    api.listSongs(projectId),
    api.getProjectMeta(projectId),
    api.listProjectInvites(projectId),
  ]);
  if (info.status === 'rejected') throw info.reason;
  const p = info.value.project;
  return {
    project: { name: p.name, description: p.description || '', showId: p.show_id ?? null },
    objects: objects.status === 'fulfilled' ? objects.value : [],
    model: model.status === 'fulfilled' ? model.value : null,
    ledCanvas: view.status === 'fulfilled' ? view.value.ledCanvas : null,
    songs: songs.status === 'fulfilled' ? songs.value : [],
    members: meta.status === 'fulfilled' ? meta.value?.members ?? [] : [],
    openInvites: invites.status === 'fulfilled' ? invites.value.length : 0,
  };
}

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** 每一步的按鈕放到下面那一條 */
function Footer({ el, children }: { el: HTMLElement | null; children: ReactNode }) {
  return el ? createPortal(children, el) : null;
}

export default function NewProjectWizard({ step, projectId, onGo, onBack, onClose, onOpenEditor, onProjectCreated }: Props) {
  const titleId = useId();
  const [factsState, setFactsState] = useState<FactsState>(projectId ? { status: 'loading' } : { status: 'none' });
  const [progress, setProgress] = useState<WizardProgress | null>(() => {
    const p = readWizardProgress(safeStorage());
    return p && p.projectId === projectId ? p : null;
  });
  // 疊在精靈上面的對話框（開著時 Esc 交給它們）
  const [uploadOpen, setUploadOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const subDialogOpen = uploadOpen || shareOpen;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [footerEl, setFooterEl] = useState<HTMLElement | null>(null);

  const facts = factsState.status === 'ready' ? factsState.facts : null;

  const reload = useCallback(async () => {
    if (!projectId) { setFactsState({ status: 'none' }); return; }
    try {
      const f = await loadFacts(projectId);
      setFactsState({ status: 'ready', facts: f });
    } catch (e) {
      setFactsState({ status: 'error', error: friendlyError(e) });
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) { setFactsState({ status: 'none' }); return; }
    setFactsState({ status: 'loading' });
    void reload();
  }, [projectId, reload]);

  // 進度：換專案時讀這台電腦記的那一份（沒有就新開一份）；專案名字改了跟著改
  useEffect(() => {
    if (!projectId) { setProgress(null); return; }
    setProgress(prev => {
      let p = prev && prev.projectId === projectId ? prev : null;
      if (!p) {
        const stored = readWizardProgress(safeStorage());
        p = stored && stored.projectId === projectId ? stored : newProgress(projectId, facts?.project.name ?? '');
      }
      if (facts && p.projectName !== facts.project.name) p = { ...p, projectName: facts.project.name };
      if (p !== prev) writeWizardProgress(safeStorage(), p);
      return p;
    });
  }, [projectId, facts]);

  const mark = useCallback((s: WizardStep, how: StepMark) => {
    setProgress(prev => {
      if (!prev) return prev;
      const next = markStep(prev, s, how);
      if (next !== prev) writeWizardProgress(safeStorage(), next);
      return next;
    });
  }, []);

  // 走到「完成」那一頁 = 這個專案的精靈走完了（專案總覽不再提醒「繼續設定」）
  useEffect(() => { if (step === 'done' && progress) mark('done', 'done'); }, [step, progress, mark]);

  // 換步驟：捲回最上面；名稱那一步（有滑鼠的電腦上）直接可以打字（手機不自動跳鍵盤）
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 });
    if (step === 'name') {
      const t = window.setTimeout(() => {
        const el = bodyRef.current?.querySelector<HTMLInputElement>('#npw-name');
        if (el && window.matchMedia?.('(pointer: fine)').matches) el.focus();
      }, 30);
      return () => window.clearTimeout(t);
    }
  }, [step, !!facts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc = 先離開（上面疊著的對話框 / 選單 / 確認框開著時交給它們）
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      if (subDialogOpen) return;
      // 「用其他身分看」的選單開著 → Esc 是關選單
      if (document.querySelector('.ovf__menu')) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [subDialogOpen]);

  // 後面的頁面不能捲（手機上精靈是整個畫面）
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = prev; };
  }, []);

  const goNext = (from: WizardStep, how?: StepMark) => {
    if (how) mark(from, how);
    const n = nextStep(from);
    if (n) onGo(n, projectId);
  };
  const goBack = () => {
    const p = prevStep(step);
    if (p) onBack(p, projectId);
  };

  const idx = stepIndex(step);
  const projectName = facts?.project.name ?? progress?.projectName ?? '';
  const ready = !projectId || !!facts;

  return (
    <>
      <div className="dialog-overlay npw-overlay">
        <div className="dialog npw" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <header className="npw__header">
            <div className="npw__title">
              <h2 id={titleId}>{projectId && projectName ? `新增專案：${projectName}` : '新增專案'}</h2>
              <span className="npw__count">第 {idx + 1} 步，共 {WIZARD_STEPS.length} 步：{stepLabel(step)}</span>
            </div>
            <button
              type="button" className="dialog__close" onClick={onClose}
              title={projectId ? '先離開（做好的都存好了，可以之後再繼續）' : '關閉'} aria-label={projectId ? '先離開' : '關閉'}
            >
              <Icon icon={X} size="md" />
            </button>
          </header>

          <StepNav step={step} progress={progress} hasProject={!!projectId} onPick={(s) => onGo(s, projectId)} />

          <div className="npw__body" ref={bodyRef}>
            {projectId && factsState.status === 'loading' && (
              <p className="npw-muted npw-loading"><Icon icon={LoaderCircle} spin /> 讀取專案…</p>
            )}
            {projectId && factsState.status === 'error' && (
              <div className="npw-error" role="alert">
                <span><Icon icon={TriangleAlert} /> 讀不到這個專案：{factsState.error}</span>
                <div className="npw-row">
                  <button type="button" className="btn btn--ghost" onClick={() => void reload()}>再試一次</button>
                  <button type="button" className="btn btn--ghost" onClick={onClose}>回到專案總覽</button>
                </div>
              </div>
            )}

            {ready && step === 'name' && (
              <NameStep
                footerEl={footerEl}
                projectId={projectId}
                current={facts?.project ?? null}
                onCreated={(id, name) => {
                  const p = newProgress(id, name);
                  setProgress(p);
                  writeWizardProgress(safeStorage(), p);
                  onProjectCreated?.(id);
                  // 這一步換成「有專案」的網址（按上一頁回來是改名字，不會再建一個），再到下一步
                  onGo('name', id, { replace: true });
                  onGo('model', id);
                }}
                onSaved={() => { void reload(); goNext('name'); }}
              />
            )}
            {projectId && facts && step === 'model' && (
              <ModelStep
                footerEl={footerEl} facts={facts} onUpload={() => setUploadOpen(true)}
                onBack={goBack} onNext={() => goNext('model', 'done')} onSkip={() => goNext('model', 'skipped')}
              />
            )}
            {projectId && facts && step === 'canvas' && (
              <CanvasStep
                key={projectId}
                footerEl={footerEl}
                projectId={projectId}
                facts={facts}
                onSaved={() => { void reload(); goNext('canvas', 'done'); }}
                onSkip={() => goNext('canvas', 'skipped')}
                onBack={goBack}
              />
            )}
            {projectId && facts && step === 'songs' && (
              <SongsStep
                key={projectId}
                footerEl={footerEl}
                projectId={projectId}
                facts={facts}
                onAdded={async (n) => { await reload(); if (n > 0) mark('songs', 'done'); }}
                onBack={goBack}
                onNext={() => goNext('songs', facts.songs.length > 0 ? 'done' : 'skipped')}
              />
            )}
            {projectId && facts && step === 'invite' && (
              <InviteStep
                footerEl={footerEl}
                projectId={projectId}
                projectName={projectName}
                hasInvites={progress?.marks.invite === 'done' || facts.openInvites > 0 || facts.members.some(m => m.role === 'animator' || m.role === 'director')}
                onCreated={() => { mark('invite', 'done'); void reload(); }}
                onBack={goBack}
                onNext={(how) => goNext('invite', how)}
              />
            )}
            {projectId && facts && step === 'done' && (
              <DoneStep
                footerEl={footerEl}
                projectId={projectId}
                facts={facts}
                onGo={(s) => onGo(s, projectId)}
                onOpenEditor={() => onOpenEditor(projectId)}
                onShare={() => setShareOpen(true)}
                onBack={goBack}
                onClose={onClose}
              />
            )}
          </div>

          <footer className="npw__footer" ref={setFooterEl} />
        </div>
      </div>

      {projectId && (
        <UploadModelDialog
          open={uploadOpen}
          projectId={projectId}
          onClose={() => setUploadOpen(false)}
          onImported={() => { mark('model', 'done'); void reload(); }}
        />
      )}
      {projectId && shareOpen && (
        <ShareLinksDialog
          open
          projectId={projectId}
          projectName={projectName}
          songs={facts?.songs ?? []}
          onClose={() => setShareOpen(false)}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// 上面的步驟列
// ─────────────────────────────────────────────

function StepNav({ step, progress, hasProject, onPick }: {
  step: WizardStep;
  progress: WizardProgress | null;
  hasProject: boolean;
  onPick: (s: WizardStep) => void;
}) {
  const cur = stepIndex(step);
  return (
    <nav className="npw-steps" aria-label="步驟">
      <ol>
        {WIZARD_STEPS.map((s, i) => {
          const m = progress?.marks[s.key];
          const state = i === cur ? 'current' : m === 'done' ? 'done' : m === 'skipped' ? 'skipped' : 'todo';
          // 專案建好之後，每一步都可以直接點過去（不用照順序）
          const canPick = hasProject && i !== cur;
          const StepIcon = STEP_ICONS[s.key];
          const note = state === 'done' ? '（做好了）' : state === 'skipped' ? '（先跳過了）' : '';
          return (
            <li key={s.key} className={`npw-steps__item is-${state}`}>
              <button type="button" disabled={!canPick} onClick={() => onPick(s.key)} aria-current={i === cur ? 'step' : undefined} title={s.label + note}>
                <span className="npw-steps__dot" aria-hidden="true">
                  <Icon icon={state === 'done' ? Check : StepIcon} size="xs" />
                </span>
                <span className="npw-steps__label">{s.label}</span>
                {note && <span className="npw-visually-hidden">{note}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="npw-steps__bar" aria-hidden="true"><span style={{ width: `${((cur + 1) / WIZARD_STEPS.length) * 100}%` }} /></div>
    </nav>
  );
}

// ─────────────────────────────────────────────
// 1 名稱
// ─────────────────────────────────────────────

function NameStep({ footerEl, projectId, current, onCreated, onSaved }: {
  footerEl: HTMLElement | null;
  projectId: string | null;
  current: Facts['project'] | null;
  onCreated: (id: string, name: string) => void;
  onSaved: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(current?.name ?? '');
  const [description, setDescription] = useState(current?.description ?? '');
  const [showId, setShowId] = useState(current?.showId ?? '');
  const [shows, setShows] = useState<Show[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.listShows().then(setShows).catch(() => setShows([])); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!projectId) {
        const res = await api.createProject({ name: n, description: description.trim(), showId: showId || null });
        onCreated(res.id, n);
        return;
      }
      const patch: Parameters<typeof api.updateProject>[1] = {};
      if (n !== current?.name) patch.name = n;
      if (description.trim() !== (current?.description ?? '')) patch.description = description.trim();
      if ((showId || null) !== (current?.showId ?? null)) patch.showId = showId || null;
      if (Object.keys(patch).length) await api.updateProject(projectId, patch);
      onSaved();
    } catch (err) {
      setError((projectId ? '沒有存到：' : '專案沒有建立：') + friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="npw-step" id={formId} onSubmit={submit}>
      <p className="npw-lead">
        {projectId
          ? '專案已經建好了。要改名字、Show 或描述，改完按「下一步」。'
          : '先取一個名字。按「建立專案」之後專案就建好了，後面每一步都可以先跳過、之後再做。'}
      </p>
      <div className="form-row">
        <label htmlFor="npw-name">專案名稱（一定要填）</label>
        <input id="npw-name" type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：魅影巡演 2026" required autoComplete="off" />
      </div>
      <div className="form-row">
        <label htmlFor="npw-show">歸屬於 Show（巡迴，可以不選）</label>
        <select id="npw-show" className="npw-select" value={showId} onChange={(e) => setShowId(e.target.value)}>
          <option value="">不歸屬任何 Show（獨立專案）</option>
          {shows.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <small className="npw-hint">同一場巡迴的不同場次選同一個 Show，方便一起管理</small>
      </div>
      <div className="form-row">
        <label htmlFor="npw-desc">描述（可以不填）</label>
        <input id="npw-desc" type="text" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句話描述這個專案" autoComplete="off" />
      </div>
      {error && <div className="npw-error" role="alert"><Icon icon={TriangleAlert} /> {error}</div>}
      <Footer el={footerEl}>
        <span className="npw__spacer" />
        <button type="submit" form={formId} className="btn btn--primary npw-btn" disabled={!name.trim() || busy}>
          {busy
            ? <><Icon icon={LoaderCircle} spin /> {projectId ? '儲存中…' : '建立中…'}</>
            : <>{projectId ? '下一步' : '建立專案'} <Icon icon={ArrowRight} /></>}
        </button>
      </Footer>
    </form>
  );
}

// ─────────────────────────────────────────────
// 2 3D 模型
// ─────────────────────────────────────────────

function ModelStep({ footerEl, facts, onUpload, onBack, onNext, onSkip }: {
  footerEl: HTMLElement | null;
  facts: Facts;
  onUpload: () => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const counts = countByCategory(facts.objects);
  const has = facts.objects.length > 0;
  const other = counts.other ?? 0;
  return (
    <div className="npw-step">
      <p className="npw-lead">
        上傳舞台的 3D 模型（.glb）。模型裡的物件照名稱開頭自動分類：<code>LED_</code> 是 LED、<code>STAGE_</code> 是機關、<code>ARTIST_</code> 是表演者……
      </p>
      <a className="npw-help" href={helpUrl(HELP_ANCHORS.prodNaming)} target="_blank" rel="noopener">
        <Icon icon={CircleHelp} /> 模型裡的物件怎麼命名（開新分頁）
      </a>
      {has ? (
        <div className="npw-card npw-card--ok" data-testid="npw-model-summary">
          <div className="npw-card__title"><Icon icon={CircleCheck} /> {describeObjectCounts(counts)}</div>
          <ul className="npw-chips">
            {STAGE_CATEGORY_ORDER.filter(c => (counts[c] ?? 0) > 0).map(c => (
              <li key={c} className={'npw-chip' + (c === 'other' ? ' is-warn' : '')}>
                <Icon icon={STAGE_CATEGORY[c].icon} /> {STAGE_CATEGORY[c].label} {counts[c]}
              </li>
            ))}
          </ul>
          {other > 0 && (
            <p className="npw-note">
              <Icon icon={TriangleAlert} /> {other} 個物件的名稱沒對到命名規則，先放在「其他」。之後可以在編輯頁右邊的「物件」分頁改分類，或在 C4D 改名字重新上傳。
            </p>
          )}
          {facts.model && <p className="npw-muted small">模型檔 {(facts.model.size / 1024 / 1024).toFixed(1)} MB</p>}
          <div className="npw-row">
            <button type="button" className="btn btn--ghost npw-btn" onClick={onUpload}><Icon icon={Upload} /> 換一個模型</button>
          </div>
        </div>
      ) : (
        <div className="npw-card npw-card--center">
          <button type="button" className="btn btn--primary npw-btn npw-big" onClick={onUpload}>
            <Icon icon={Upload} size="md" /> 上傳 3D 模型（.glb / .gltf）
          </button>
          <p className="npw-muted small">還沒有模型也沒關係：先跳過，之後在編輯頁右邊的「物件」分頁按「上傳模型」。</p>
        </div>
      )}
      <Footer el={footerEl}>
        <button type="button" className="btn btn--ghost npw-btn" onClick={onBack}><Icon icon={ArrowLeft} /> 上一步</button>
        <span className="npw__spacer" />
        {has
          ? <button type="button" className="btn btn--primary npw-btn" onClick={onNext}>下一步 <Icon icon={ArrowRight} /></button>
          : <button type="button" className="btn btn--ghost npw-btn" onClick={onSkip}>先跳過，之後再上傳</button>}
      </Footer>
    </div>
  );
}

// ─────────────────────────────────────────────
// 3 LED 畫布大小
// ─────────────────────────────────────────────

const CANVAS_PRESETS: LedCanvas[] = [
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
  { width: 7680, height: 2160 },
];

function CanvasStep({ footerEl, projectId, facts, onSaved, onSkip, onBack }: {
  footerEl: HTMLElement | null;
  projectId: string;
  facts: Facts;
  onSaved: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const formId = useId();
  const start = facts.ledCanvas ?? DEFAULT_WIZARD_CANVAS;
  const [w, setW] = useState(String(start.width));
  const [h, setH] = useState(String(start.height));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseCanvasFields(w, h);
  const canvas = 'canvas' in parsed ? parsed.canvas : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canvas || busy) return;
    if (facts.ledCanvas && sameLedCanvas(facts.ledCanvas, canvas)) { onSaved(); return; }
    setBusy(true);
    setError(null);
    try {
      await api.updateProjectViewSettings(projectId, { ledCanvas: canvas });
      onSaved();
    } catch (err) {
      setError('沒有存到：' + friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="npw-step" id={formId} onSubmit={submit}>
      <p className="npw-lead">
        LED 畫布大小 = 動畫師在 AE 做的合成有多大（寬 × 高，像素）。LED 對位圖、LED 測試圖、AE 即時預覽都照這個大小對位置。
        {facts.ledCanvas ? '' : '先放常用的 3840 × 2160，不確定的話問動畫師。'}
      </p>
      <div className="npw-canvas-fields">
        <div className="form-row">
          <label htmlFor="npw-w">寬（像素）</label>
          <input id="npw-w" type="text" inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} autoComplete="off" />
        </div>
        <span className="npw-canvas-x" aria-hidden="true">×</span>
        <div className="form-row">
          <label htmlFor="npw-h">高（像素）</label>
          <input id="npw-h" type="text" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className="npw-row npw-presets" role="group" aria-label="常用大小">
        {CANVAS_PRESETS.map(p => (
          <button
            key={`${p.width}x${p.height}`} type="button"
            className={'npw-preset' + (canvas && sameLedCanvas(canvas, p) ? ' is-active' : '')}
            aria-pressed={!!canvas && sameLedCanvas(canvas, p)}
            onClick={() => { setW(String(p.width)); setH(String(p.height)); }}
          >
            {p.width} × {p.height}
          </button>
        ))}
      </div>
      {'error' in parsed && <div className="npw-field-error" role="alert">{parsed.error}</div>}
      <LedCanvasPreview canvas={canvas} facts={facts} />
      <p className="npw-muted small">之後要改：編輯頁 3D 工具列最右邊的「⋯」→「設定畫布大小…」。</p>
      {error && <div className="npw-error" role="alert"><Icon icon={TriangleAlert} /> {error}</div>}
      <Footer el={footerEl}>
        <button type="button" className="btn btn--ghost npw-btn" onClick={onBack}><Icon icon={ArrowLeft} /> 上一步</button>
        <span className="npw__spacer" />
        <button type="button" className="btn btn--ghost npw-btn" onClick={onSkip}>先跳過</button>
        <button type="submit" form={formId} className="btn btn--primary npw-btn" disabled={!canvas || busy}>
          {busy ? <><Icon icon={LoaderCircle} spin /> 儲存中…</> : <>儲存，下一步 <Icon icon={ArrowRight} /></>}
        </button>
      </Footer>
    </form>
  );
}

/** 模型太大就不下載（只畫比例），免得等很久 */
const PREVIEW_MAX_MODEL_BYTES = 30 * 1024 * 1024;

/** 畫布比例 +（有模型的話）每塊 LED 在畫布上的位置 */
function LedCanvasPreview({ canvas, facts }: { canvas: LedCanvas | null; facts: Facts }) {
  const leds = useMemo(() => facts.objects.filter(o => o.category === 'led_panel'), [facts.objects]);
  const ledKey = leds.map(l => `${l.id}:${l.meshName}:${l.displayName}`).join('|');
  const [inputs, setInputs] = useState<LedPanelInput[] | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'skipped'>('idle');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const model = facts.model;

  useEffect(() => {
    if (!model || leds.length === 0) { setState('idle'); setInputs(null); return; }
    if (model.size > PREVIEW_MAX_MODEL_BYTES) { setState('skipped'); return; }
    const ac = new AbortController();
    setState('loading');
    import('../lib/ledCanvasPreview')
      .then(m => m.loadLedPanelInputs(api.modelDownloadUrl(model.key), leds.map(l => ({
        id: l.id, name: l.displayName || l.meshName, order: l.order, meshName: l.meshName,
      })), ac.signal))
      .then(list => { if (!ac.signal.aborted) { setInputs(list); setState(list.length ? 'ready' : 'failed'); } })
      .catch(() => { if (!ac.signal.aborted) setState('failed'); });
    return () => ac.abort();
  }, [model?.key, ledKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 畫：寬度跟著框，高度照比例
  useEffect(() => {
    const el = canvasRef.current, box = boxRef.current;
    if (!el || !box || !canvas || state !== 'ready' || !inputs) return;
    const cssW = Math.max(120, Math.round(box.clientWidth));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = (cssW * dpr) / canvas.width;
    el.width = Math.max(1, Math.round(canvas.width * scale));
    el.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const layout = buildLedLayout(inputs, canvas);
    drawAlignmentMap(ctx, layout, { projectName: facts.project.name, date: todayString(), canvas, canvasSource: 'project' }, scale);
  }, [canvas?.width, canvas?.height, inputs, state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canvas) return null;
  return (
    <figure className="npw-preview">
      <div
        className="npw-preview__box" ref={boxRef}
        // 比例照畫布；很高的畫布最多 240px 高（寬度跟著縮）
        style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, width: `min(100%, ${Math.round((240 * canvas.width) / canvas.height)}px)` }}
      >
        {state === 'ready'
          ? <canvas ref={canvasRef} className="npw-preview__canvas" role="img" aria-label="每塊 LED 在畫布上的位置" />
          : <span className="npw-preview__empty">{canvas.width} × {canvas.height}</span>}
      </div>
      <figcaption className="npw-muted small">
        {canvas.width} × {canvas.height}（{aspectText(canvas)}）
        {state === 'loading' && <> · <Icon icon={LoaderCircle} spin /> 讀取模型裡的 LED…</>}
        {state === 'ready' && ' · 每塊 LED 在畫布上的位置（跟 3D 工具列的「LED 對位圖」一樣）'}
        {state === 'failed' && ' · 模型裡讀不出 LED 的位置，進編輯頁後用 3D 工具列的「LED 對位圖」看'}
        {state === 'skipped' && ' · 模型比較大，這裡先不畫 LED 的位置；進編輯頁後用 3D 工具列的「LED 對位圖」看'}
      </figcaption>
    </figure>
  );
}

// ─────────────────────────────────────────────
// 4 歌單
// ─────────────────────────────────────────────

interface RowEdit { code?: string; name?: string; animatorId?: string; removed?: boolean }

function SongsStep({ footerEl, projectId, facts, onAdded, onBack, onNext }: {
  footerEl: HTMLElement | null;
  projectId: string;
  facts: Facts;
  onAdded: (count: number) => Promise<void>;
  onBack: () => void;
  onNext: () => void;
}) {
  const [text, setText] = useState('');
  // 表格裡改過的（用貼上那一行的歌名對；改貼上的字也不會弄丟）
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(0);

  const animators = useMemo(() => facts.members.filter(m => m.role === 'animator'), [facts.members]);
  const parsed = useMemo(() => parseSetlist(text), [text]);
  const coded = useMemo(() => assignSongCodes(parsed.songs, facts.songs.map(s => s.code ?? null)), [parsed, facts.songs]);
  const rows = useMemo(() => parsed.songs.map((s, i) => {
    const key = songNameKey(s.name);
    const ed = edits[key] ?? {};
    return {
      key, line: s.line,
      name: ed.name ?? s.name,
      code: ed.code ?? coded[i].code,
      animatorId: ed.animatorId ?? '',
      removed: !!ed.removed,
    };
  }), [parsed, coded, edits]);
  const kept = rows.filter(r => !r.removed);
  const problems = songCodeProblems(kept, facts.songs);
  const problemByKey = new Map(kept.map((r, i) => [r.key, problems[i]]));
  const nameProblem = kept.some(r => !r.name.trim());
  const canAdd = kept.length > 0 && problems.every(p => !p) && !nameProblem && !busy;

  const edit = (key: string, patch: RowEdit) => setEdits(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  async function addAll() {
    if (!canAdd) return;
    setError(null);
    setBusy({ done: 0, total: kept.length });
    let done = 0;
    const codeChanged: string[] = [];
    try {
      for (const r of kept) {
        let created: { id: string; code?: string | null };
        try {
          created = await api.createSong(projectId, r.name.trim(), r.code.trim());
        } catch (e) {
          // 代號剛好被別人用掉了 → 讓後台接著排
          if (api.errorStatus(e) !== 409) throw e;
          created = await api.createSong(projectId, r.name.trim());
          codeChanged.push(r.name.trim());
        }
        if (r.animatorId) await api.updateSong(projectId, created.id, { animator_user_id: r.animatorId });
        done++;
        setBusy({ done, total: kept.length });
      }
      toast.success(`已加入 ${done} 首歌` + (codeChanged.length ? `（${codeChanged.join('、')} 的代號剛好被用掉了，換成下一個）` : ''));
      setText('');
      setEdits({});
    } catch (e) {
      const failed = kept[done];
      setError(`加到「${failed?.name ?? ''}」時沒有成功：${friendlyError(e)}。` + (done ? `前面 ${done} 首已經加好了，下面只留還沒加的，再按一次就好。` : ''));
      // 已經加好的從貼上的字拿掉，再按一次就接著加剩下的
      const doneKeys = new Set(kept.slice(0, done).map(r => r.key));
      setText(parsed.songs.filter(s => !doneKeys.has(songNameKey(s.name))).map(s => (s.code ? `${s.code} ${s.name}` : s.name)).join('\n'));
    } finally {
      setBusy(null);
      setAdded(a => a + done);
      await onAdded(done);
    }
  }

  const notes: string[] = [];
  if (parsed.skippedEmpty) notes.push(`跳過 ${parsed.skippedEmpty} 行空白`);
  if (parsed.duplicates.length) notes.push(`重複的只留一首：${parsed.duplicates.join('、')}`);
  if (parsed.tooMany) notes.push(`一次最多 100 首，後面 ${parsed.tooMany} 首沒有放進來`);
  const hasSongs = facts.songs.length > 0;

  return (
    <div className="npw-step">
      <p className="npw-lead">
        把歌單貼進來，一行一首。前面的編號（「1. 開場」）會拿掉；寫了歌曲代號（「S01 開場」）就用那個代號，沒寫的照順序排 S01、S02……下面的表格都可以改。
      </p>
      {hasSongs && (
        <div className="npw-card npw-card--ok" data-testid="npw-existing-songs">
          <div className="npw-card__title"><Icon icon={CircleCheck} /> 這個專案有 {facts.songs.length} 首歌{added ? `（剛加了 ${added} 首）` : ''}</div>
          <ul className="npw-songlist">
            {facts.songs.slice(0, 30).map(s => <li key={s.id}><span className="npw-code">{s.code ?? '—'}</span> {s.name}</li>)}
            {facts.songs.length > 30 && <li className="npw-muted">…還有 {facts.songs.length - 30} 首</li>}
          </ul>
          <p className="npw-muted small">要再加歌就貼在下面；不用的話按「下一步」。</p>
        </div>
      )}
      <div className="form-row">
        <label htmlFor="npw-setlist">{hasSongs ? '再加幾首（一行一首）' : '歌單（一行一首）'}</label>
        <textarea
          id="npw-setlist" rows={7} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'開場\n夜曲\n安可'} spellCheck={false} disabled={!!busy}
        />
      </div>
      {notes.length > 0 && <p className="npw-muted small" data-testid="npw-setlist-notes">{notes.join('；')}</p>}

      {rows.length > 0 && (
        <div className={'npw-songs' + (animators.length ? ' has-animator' : '')} role="table" aria-label="要加入的歌">
          <div className="npw-songs__head" role="row">
            <span role="columnheader">歌曲代號</span>
            <span role="columnheader">歌名</span>
            {animators.length > 0 && <span role="columnheader">負責動畫師</span>}
            <span role="columnheader"><span className="npw-visually-hidden">不要這首</span></span>
          </div>
          {rows.map(r => {
            const prob = r.removed ? null : problemByKey.get(r.key);
            return (
              <div key={r.key} role="row" className={'npw-songs__row' + (r.removed ? ' is-removed' : '')}>
                <span role="cell" className="npw-songs__code">
                  <input
                    type="text" value={r.code} maxLength={SONG_CODE_MAX} aria-label={`「${r.name}」的歌曲代號`}
                    aria-invalid={!!prob} disabled={r.removed || !!busy}
                    onChange={(e) => edit(r.key, { code: e.target.value.toUpperCase() })}
                  />
                </span>
                <span role="cell" className="npw-songs__name">
                  <input
                    type="text" value={r.name} maxLength={SONG_NAME_MAX} aria-label={`第 ${r.line} 行的歌名`}
                    disabled={r.removed || !!busy} onChange={(e) => edit(r.key, { name: e.target.value })}
                  />
                </span>
                {animators.length > 0 && (
                  <span role="cell" className="npw-songs__anim">
                    <select
                      value={r.animatorId} aria-label={`「${r.name}」的負責動畫師`} disabled={r.removed || !!busy}
                      onChange={(e) => edit(r.key, { animatorId: e.target.value })}
                    >
                      <option value="">負責動畫師：還沒指派</option>
                      {animators.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </span>
                )}
                <span role="cell" className="npw-songs__rm">
                  <button
                    type="button" className="npw-icon-btn" disabled={!!busy}
                    onClick={() => edit(r.key, { removed: !r.removed })}
                    title={r.removed ? '還是要加這首' : '不要這首'} aria-label={r.removed ? `還是要加「${r.name}」` : `不要「${r.name}」`}
                  >
                    <Icon icon={r.removed ? RotateCcw : Trash2} />
                  </button>
                </span>
                {prob && <span className="npw-field-error npw-songs__err" role="alert">{prob}</span>}
              </div>
            );
          })}
        </div>
      )}
      {rows.length > 0 && animators.length === 0 && (
        <p className="npw-muted small">負責動畫師：動畫師用邀請連結進來之後（下一步就是邀請人），在編輯頁左邊的歌單上指派。</p>
      )}
      {error && <div className="npw-error" role="alert"><Icon icon={TriangleAlert} /> {error}</div>}
      <Footer el={footerEl}>
        <button type="button" className="btn btn--ghost npw-btn" onClick={onBack} disabled={!!busy}><Icon icon={ArrowLeft} /> 上一步</button>
        <span className="npw__spacer" />
        {rows.length > 0 ? (
          <>
            {hasSongs && <button type="button" className="btn btn--ghost npw-btn" onClick={onNext} disabled={!!busy}>不加了，下一步</button>}
            <button type="button" className="btn btn--primary npw-btn" onClick={() => void addAll()} disabled={!canAdd}>
              {busy ? <><Icon icon={LoaderCircle} spin /> 加入中… {busy.done} / {busy.total}</> : <>加入 {kept.length} 首歌</>}
            </button>
          </>
        ) : hasSongs ? (
          <button type="button" className="btn btn--primary npw-btn" onClick={onNext}>下一步 <Icon icon={ArrowRight} /></button>
        ) : (
          <button type="button" className="btn btn--ghost npw-btn" onClick={onNext}>先跳過</button>
        )}
      </Footer>
    </div>
  );
}

// ─────────────────────────────────────────────
// 5 邀請人
// ─────────────────────────────────────────────

function InviteStep({ footerEl, projectId, projectName, hasInvites, onCreated, onBack, onNext }: {
  footerEl: HTMLElement | null;
  projectId: string;
  projectName: string;
  hasInvites: boolean;
  onCreated: () => void;
  onBack: () => void;
  onNext: (how: StepMark) => void;
}) {
  return (
    <div className="npw-step">
      <p className="npw-lead">
        把動畫師和導演邀請進來：建一條邀請連結 →「複製訊息」→ 貼到 LINE / 微信。對方點開按「進入專案」就好，不用帳號密碼。一個人一條。
      </p>
      <InvitePanel projectId={projectId} projectName={projectName} defaultRole="animator" onCreated={onCreated} />
      <Footer el={footerEl}>
        <button type="button" className="btn btn--ghost npw-btn" onClick={onBack}><Icon icon={ArrowLeft} /> 上一步</button>
        <span className="npw__spacer" />
        {hasInvites
          ? <button type="button" className="btn btn--primary npw-btn" onClick={() => onNext('done')}>下一步 <Icon icon={ArrowRight} /></button>
          : <button type="button" className="btn btn--ghost npw-btn" onClick={() => onNext('skipped')}>先跳過</button>}
      </Footer>
    </div>
  );
}

// ─────────────────────────────────────────────
// 6 完成
// ─────────────────────────────────────────────

function DoneStep({ footerEl, projectId, facts, onGo, onOpenEditor, onShare, onBack, onClose }: {
  footerEl: HTMLElement | null;
  projectId: string;
  facts: Facts;
  onGo: (s: WizardStep) => void;
  onOpenEditor: () => void;
  onShare: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const animators = useMemo(() => facts.members.filter(m => m.role === 'animator').map(m => ({ id: m.id, name: m.name })), [facts.members]);
  const viewAs = useViewAsMenu({ projectId, animators, onCreateShare: onShare });
  const counts = countByCategory(facts.objects);
  const joined = facts.members.filter(m => m.role === 'animator' || m.role === 'director');
  const items: { step: WizardStep; ok: boolean; title: string; detail: string }[] = [
    {
      step: 'model', ok: facts.objects.length > 0, title: '3D 模型',
      detail: facts.objects.length > 0 ? describeObjectCounts(counts) : '還沒上傳（編輯頁右邊的「物件」分頁 →「上傳模型」）',
    },
    {
      step: 'canvas', ok: !!facts.ledCanvas, title: 'LED 畫布大小',
      detail: facts.ledCanvas ? `${facts.ledCanvas.width} × ${facts.ledCanvas.height}` : '還沒設定（編輯頁 3D 工具列「⋯」→「設定畫布大小…」）',
    },
    {
      step: 'songs', ok: facts.songs.length > 0, title: '歌單',
      detail: facts.songs.length > 0
        ? `${facts.songs.length} 首：${facts.songs.slice(0, 4).map(s => (s.code ? `${s.code} ${s.name}` : s.name)).join('、')}${facts.songs.length > 4 ? '……' : ''}`
        : '還沒有歌（編輯頁左邊「＋ 新增歌曲」）',
    },
    {
      step: 'invite', ok: facts.openInvites > 0 || joined.length > 0, title: '邀請人',
      detail: joined.length > 0
        ? `${joined.map(m => m.name).join('、')} 已經加入${facts.openInvites ? `，還有 ${facts.openInvites} 條邀請連結還沒用` : ''}`
        : facts.openInvites > 0 ? `建了 ${facts.openInvites} 條邀請連結，等對方點開` : '還沒邀請（編輯頁上方「邀請」）',
    },
  ];
  return (
    <div className="npw-step">
      <div className="npw-card npw-card--ok">
        <div className="npw-card__title"><Icon icon={CircleCheck} /> 專案「{facts.project.name}」建好了</div>
        <p className="npw-muted small">還沒做的都可以之後在編輯頁補，或按「回去設定」。</p>
      </div>
      <ul className="npw-checklist" aria-label="設定的狀況">
        {items.map(it => (
          <li key={it.step} className={it.ok ? 'is-ok' : 'is-todo'}>
            <span className="npw-checklist__icon" aria-hidden="true"><Icon icon={it.ok ? CircleCheck : Circle} size="md" /></span>
            <span className="npw-checklist__text">
              <strong>{it.title}<span className="npw-visually-hidden">{it.ok ? '（做好了）' : '（還沒做）'}</span></strong>
              <span className="npw-checklist__detail">{it.detail}</span>
            </span>
            {!it.ok && (
              <button type="button" className="btn btn--ghost btn--sm npw-btn" onClick={() => onGo(it.step)}>回去設定</button>
            )}
          </li>
        ))}
      </ul>
      <div className="npw-actions">
        <button type="button" className="btn btn--primary npw-btn npw-big" onClick={onOpenEditor}>
          進入編輯頁 <Icon icon={ArrowRight} />
        </button>
        <button type="button" className="btn btn--ghost npw-btn" onClick={onShare}>
          <Icon icon={Link2} /> 建立分享連結
        </button>
        <OverflowMenu
          label={VIEW_AS_MENU_LABEL}
          trigger={{ icon: Eye, text: VIEW_AS_MENU_LABEL, className: 'btn btn--ghost npw-btn npw-viewas' }}
          items={viewAs.items}
          onOpen={viewAs.load}
        />
      </div>
      <p className="npw-muted small">
        分享連結：給客戶看（不用登入、只能看）。用其他身分看：打開導演、動畫師、客戶看到的畫面（開新分頁，只能看，不會改到資料）。
      </p>
      <Footer el={footerEl}>
        <button type="button" className="btn btn--ghost npw-btn" onClick={onBack}><Icon icon={ArrowLeft} /> 上一步</button>
        <span className="npw__spacer" />
        <button type="button" className="btn btn--ghost npw-btn" onClick={onClose}>回到專案總覽</button>
      </Footer>
    </div>
  );
}
