// 「用其他身分看」的 React 這一層（規則在 viewAs.ts）：
//
//   App 路由把導演頁、工作站包在 <ViewAsProvider> 裡；頁面和裡面的元件用：
//     const user = useViewAsUser();            // 預覽時 = 導演 / 那個動畫師（角色、id、名字都換掉）；平常 = 登入的人
//     const va = useViewAs();
//     va.projectRole(myRole)                   // 預覽時換成預覽的角色
//     <button {...va.ro('原本的說明')} onClick={...}>   // 寫入的按鈕：預覽時按不下去、滑上去寫「預覽模式只能看」
//     onSomething={va.guard(fn)}               // 會寫資料的動作：預覽時改成說一聲
//
//   預覽開著時（只有製作、網址有 ?as=）：
//     - 先讀專案成員（要知道看的是哪個動畫師），讀完才畫頁面 —— 也保證「擋寫入」已經裝好了才開始讀資料
//     - 擋下所有寫入的請求（installWriteGuard）；離開預覽就拿掉
//     - 上面一條橫幅（components/ViewAsBanner，App 路由用 components/ViewAsPage 包起來）：在看誰的畫面、換成導演 / 動畫師、回到編輯

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as api from './api';
import type { AuthUser } from './api';
import type { ProjectMember, ProjectRole } from './mockData';
import { useAuth } from './auth';
import { toast } from './toast';
import {
  VIEW_AS_BLOCKED_MESSAGE, VIEW_AS_READ_ONLY_TIP, installWriteGuard, parseViewAs, viewAsIdentity, type ViewAs,
} from './viewAs';
import { RouteLoading } from './roleRouting';

/** 寫入按鈕要加的屬性（預覽時按不下去） */
export interface ReadOnlyProps {
  title?: string;
  'aria-disabled'?: true;
  'data-viewas-ro'?: '';
  onClickCapture?: (e: SyntheticEvent) => void;
}

export interface ViewAsState {
  /** 正在預覽（製作 + 網址有 ?as=） */
  active: boolean;
  viewAs: ViewAs | null;
  readOnly: boolean;
  projectId: string | null;
  /** 預覽時畫面上的「我」；不是預覽 = null（用 useViewAsUser 拿） */
  user: AuthUser | null;
  /** 看的是哪個動畫師（找得到這個專案的動畫師才有） */
  person: ProjectMember | null;
  /** 這個專案的動畫師（橫幅上換人用） */
  animators: ProjectMember[];
  /** 預覽時換成預覽的角色 */
  projectRole: (real: ProjectRole | null) => ProjectRole | null;
  /** 寫入按鈕的屬性：預覽時按不下去（按了說一聲）；平常就是原本的 title */
  ro: (title?: string) => ReadOnlyProps;
  /** 會寫資料的動作：預覽時改成說一聲 */
  guard: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
}

const passThrough = <A extends unknown[]>(fn: (...args: A) => void) => fn;

const INACTIVE: ViewAsState = {
  active: false,
  viewAs: null,
  readOnly: false,
  projectId: null,
  user: null,
  person: null,
  animators: [],
  projectRole: (real) => real,
  ro: (title) => (title ? { title } : {}),
  guard: passThrough,
};

const ViewAsCtx = createContext<ViewAsState>(INACTIVE);

export function useViewAs(): ViewAsState {
  return useContext(ViewAsCtx);
}

/** 頁面上的「我」：預覽時是導演 / 那個動畫師；平常就是登入的人 */
export function useViewAsUser(): AuthUser | null {
  const { user } = useAuth();
  const va = useContext(ViewAsCtx);
  return va.active ? va.user : user;
}

let lastBlockedToastAt = 0;
/** 按了預覽時不能按的東西：說一聲（連點只說一次） */
export function notifyViewAsBlocked() {
  const now = Date.now();
  if (now - lastBlockedToastAt < 1500) return;
  lastBlockedToastAt = now;
  toast.info(VIEW_AS_BLOCKED_MESSAGE);
}

function blockClick(e: SyntheticEvent) {
  e.preventDefault();
  e.stopPropagation();
  notifyViewAsBlocked();
}

const RO_PROPS: ReadOnlyProps = {
  title: VIEW_AS_READ_ONLY_TIP,
  'aria-disabled': true,
  'data-viewas-ro': '',
  onClickCapture: blockClick,
};

/** banner = 預覽時最上面那一條（components/ViewAsBanner；從 ViewAsPage 傳進來，這裡不 import 畫面元件） */
export function ViewAsProvider({ children, banner }: { children: ReactNode; banner?: ReactNode }) {
  const { user } = useAuth();
  const { projectId = null } = useParams();
  const [params] = useSearchParams();
  const asParam = params.get('as');
  const userParam = params.get('user');
  const accountRole = user?.role;
  const viewAs = useMemo(() => {
    const q = new URLSearchParams();
    if (asParam) q.set('as', asParam);
    if (userParam) q.set('user', userParam);
    return parseViewAs(q, accountRole);
  }, [asParam, userParam, accountRole]);
  const active = !!viewAs && !!projectId;

  // 專案成員（看的是哪個動畫師、橫幅上換人）
  const [members, setMembers] = useState<{ projectId: string; list: ProjectMember[] } | null>(null);
  useEffect(() => {
    if (!active || !projectId) return;
    let cancelled = false;
    api.getProjectMeta(projectId)
      .then(p => { if (!cancelled) setMembers({ projectId, list: p?.members ?? [] }); })
      // 讀不到（封存的專案不在清單裡 / 網路）→ 當作沒有成員，頁面自己會說讀不到
      .catch(() => { if (!cancelled) setMembers({ projectId, list: [] }); });
    return () => { cancelled = true; };
  }, [active, projectId]);

  // 擋下寫入的請求（萬一有漏掉的按鈕也改不到資料）
  const [guardOn, setGuardOn] = useState(false);
  useEffect(() => {
    if (!active) return;
    const remove = installWriteGuard(globalThis, (method, url) => {
      console.warn(`[預覽模式] 擋下了一個寫入的請求（${method} ${url}）`);
    });
    setGuardOn(true);
    return () => { remove(); setGuardOn(false); };
  }, [active]);

  const memberList = members && members.projectId === projectId ? members.list : null;
  const animators = useMemo(() => (memberList ?? []).filter(m => m.role === 'animator'), [memberList]);
  const person = useMemo(
    () => (viewAs?.previewRole === 'animator' && viewAs.previewUserId ? animators.find(m => m.id === viewAs.previewUserId) ?? null : null),
    [viewAs, animators],
  );
  const effectiveUser = useMemo(
    () => (viewAs && user ? viewAsIdentity(user, viewAs, person) : null),
    [user, viewAs, person],
  );

  const projectRole = useCallback((real: ProjectRole | null) => (viewAs ? viewAs.previewRole : real), [viewAs]);
  const ro = useCallback((title?: string): ReadOnlyProps => (active ? RO_PROPS : (title ? { title } : {})), [active]);
  const guard = useCallback(<A extends unknown[]>(fn: (...args: A) => void) => (
    active ? ((..._args: A) => { notifyViewAsBlocked(); }) : fn
  ), [active]);

  const value = useMemo<ViewAsState>(() => (active && viewAs ? {
    active: true,
    viewAs,
    readOnly: true,
    projectId,
    user: effectiveUser,
    person,
    animators,
    projectRole,
    ro,
    guard,
  } : INACTIVE), [active, viewAs, projectId, effectiveUser, person, animators, projectRole, ro, guard]);

  // 橫幅蓋在頁面上面 → 頁面往下讓
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add('viewas-on');
    return () => { root.classList.remove('viewas-on'); root.style.removeProperty('--viewas-h'); };
  }, [active]);

  if (!active) return <>{children}</>;
  const ready = guardOn && memberList !== null;
  return (
    <ViewAsCtx.Provider value={value}>
      {banner}
      {/* 換人 / 換角色 → 整頁重來（不會帶著上一個人選的歌、篩選） */}
      {ready ? <Fragment key={`${viewAs!.previewRole}:${person?.id ?? ''}`}>{children}</Fragment> : <div style={{ paddingTop: 'var(--viewas-h, 36px)' }}><RouteLoading text="正在打開預覽…" /></div>}
    </ViewAsCtx.Provider>
  );
}
