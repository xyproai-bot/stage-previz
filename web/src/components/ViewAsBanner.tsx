// 預覽模式（製作用導演 / 動畫師的身分看）最上面那一條：
//   「預覽：導演看到的畫面（只能看，不會改到資料）」  [換成動畫師]  [回到編輯]
//   「預覽：動畫師「小明」看到的畫面…」  [看哪個動畫師 ▾]  [換成導演]  [回到編輯]
// 固定在畫面最上面，頁面整個往下讓（量這條的高度放進 --viewas-h，手機上換行也對得上）。

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowLeftRight, Eye } from 'lucide-react';
import Icon from './Icon';
import { useViewAs } from '../lib/viewAsContext';
import { defaultAnimatorId, editorPath, viewAsBannerShortText, viewAsBannerText, viewAsPath } from '../lib/viewAs';
import './ViewAsBanner.css';

/** 換到導演再換回來時，還是看同一個動畫師（只記在這個分頁） */
const LAST_ANIMATOR_KEY = (projectId: string) => `sp_viewas_animator:${projectId}`;

function readLastAnimator(projectId: string): string | null {
  try { return sessionStorage.getItem(LAST_ANIMATOR_KEY(projectId)); } catch { return null; }
}
function saveLastAnimator(projectId: string, id: string | null) {
  try {
    if (id) sessionStorage.setItem(LAST_ANIMATOR_KEY(projectId), id);
    else sessionStorage.removeItem(LAST_ANIMATOR_KEY(projectId));
  } catch { /* 無痕模式 → 不記 */ }
}

const NOBODY = '';

export default function ViewAsBanner() {
  const va = useViewAs();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  // 量高度 → 頁面往下讓這麼多
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty('--viewas-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      return () => window.removeEventListener('resize', apply);
    }
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const projectId = va.projectId;
  const role = va.viewAs?.previewRole;
  const personId = va.person?.id ?? null;
  useEffect(() => {
    if (projectId && role === 'animator') saveLastAnimator(projectId, personId);
  }, [projectId, role, personId]);

  if (!va.active || !va.viewAs || !projectId) return null;
  const name = va.person?.name ?? null;

  const switchTo = () => {
    if (role === 'director') {
      const id = defaultAnimatorId(va.animators, [], readLastAnimator(projectId));
      navigate(viewAsPath(projectId, 'animator', id));
    } else {
      navigate(viewAsPath(projectId, 'director'));
    }
  };

  return (
    <div className="viewas-banner" ref={ref} role="status">
      <span className="viewas-banner__text">
        <Icon icon={Eye} size="sm" />
        <span className="viewas-banner__long">{viewAsBannerText(va.viewAs.previewRole, name)}</span>
        <span className="viewas-banner__short">{viewAsBannerShortText(va.viewAs.previewRole, name)}</span>
      </span>
      <span className="viewas-banner__actions">
        {role === 'animator' && va.animators.length > 0 && (
          <select
            className="viewas-banner__who"
            value={personId ?? NOBODY}
            onChange={(e) => navigate(viewAsPath(projectId, 'animator', e.target.value || null), { replace: true })}
            aria-label="看哪個動畫師的畫面"
            title="看哪個動畫師的畫面（「我的」會是指派給他的歌）"
          >
            {va.animators.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            <option value={NOBODY}>還沒指派歌的動畫師</option>
          </select>
        )}
        <button type="button" className="viewas-banner__btn" onClick={switchTo} title={role === 'director' ? '改看動畫師工作站' : '改看導演頁'}>
          <Icon icon={ArrowLeftRight} size="sm" /> {role === 'director' ? '換成動畫師' : '換成導演'}
        </button>
        <button type="button" className="viewas-banner__btn viewas-banner__btn--primary" onClick={() => navigate(editorPath(projectId))}>
          <Icon icon={ArrowLeft} size="sm" /> 回到編輯
        </button>
      </span>
    </div>
  );
}
