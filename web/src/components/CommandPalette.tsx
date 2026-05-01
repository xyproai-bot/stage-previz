import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import './CommandPalette.css';

interface Command {
  id: string;
  group: string;        // Action / Project / Show / Recent / 用戶
  icon: string;
  label: string;
  hint?: string;
  run: () => void;
}

const RECENT_KEY = 'sp_recent_projects';
const RECENT_MAX = 8;

export function pushRecentProject(id: string, name: string) {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) as { id: string; name: string }[] : [];
    const filtered = list.filter(x => x.id !== id);
    filtered.unshift({ id, name });
    localStorage.setItem(RECENT_KEY, JSON.stringify(filtered.slice(0, RECENT_MAX)));
  } catch { /* ignore */ }
}
export function getRecentProjects(): { id: string; name: string }[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export default function CommandPalette() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 載入時拉資料的 cache
  const [projects, setProjects] = useState<api.Show[] | { id: string; name: string }[]>([]);
  const [shows, setShows] = useState<api.Show[]>([]);
  const [recent, setRecent] = useState<{ id: string; name: string }[]>([]);
  const [searchResults, setSearchResults] = useState<api.SearchResults | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cmd+K / Ctrl+K listener
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 開啟時拉清單（每次都拉，保持新鮮）
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    setSearchResults(null);
    setRecent(getRecentProjects());
    setTimeout(() => inputRef.current?.focus(), 30);
    Promise.all([
      api.listProjects().catch(() => []),
      api.listShows().catch(() => []),
    ]).then(([ps, ss]) => {
      setProjects(ps as { id: string; name: string }[]);
      setShows(ss);
    });
  }, [open]);

  // query 變化 → debounce 200ms 後呼叫全域搜尋
  useEffect(() => {
    if (!open) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!query.trim() || query.trim().length < 2) {
      setSearchResults(null);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      api.searchAll(query.trim())
        .then(setSearchResults)
        .catch(() => setSearchResults(null));
    }, 200);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, open]);

  const close = useCallback(() => setOpen(false), []);

  // 組所有 commands
  const allCommands: Command[] = useMemo(() => {
    const cmds: Command[] = [];

    // Actions（不論 query 都會列）
    cmds.push(
      { id: 'a:home',       group: '動作', icon: '🏠', label: '回首頁',          run: () => { navigate('/'); close(); } },
      { id: 'a:projects',   group: '動作', icon: '📁', label: '專案總覽',        run: () => { navigate('/admin'); close(); } },
      { id: 'a:shows',      group: '動作', icon: '🎫', label: 'Show 巡迴',       run: () => { navigate('/admin/shows'); close(); } },
      { id: 'a:templates',  group: '動作', icon: '📐', label: '模板庫',          run: () => { navigate('/admin/templates'); close(); } },
      { id: 'a:studio',     group: '動作', icon: '🎨', label: '動畫師工作站',     hint: '/studio', run: () => { navigate('/studio'); close(); } },
      { id: 'a:preview',    group: '動作', icon: '🎬', label: '導演進度頁',       hint: '/preview', run: () => { navigate('/preview'); close(); } },
    );
    if (user?.role === 'admin') {
      cmds.push(
        { id: 'a:users', group: '動作', icon: '👥', label: '用戶管理', run: () => { navigate('/admin/users'); close(); } },
        { id: 'a:drive', group: '動作', icon: '☁', label: 'Drive 來源', run: () => { navigate('/admin/drive-sources'); close(); } },
      );
    }
    cmds.push(
      { id: 'a:logout',     group: '動作', icon: '⏻',  label: '登出',           run: async () => { close(); await logout(); navigate('/login'); } },
    );

    // Recent
    for (const r of recent) {
      cmds.push({
        id: `r:${r.id}`, group: '最近', icon: '🕒',
        label: r.name, hint: '最近開過',
        run: () => { navigate(`/admin/projects/${r.id}`); close(); },
      });
    }

    // Projects
    for (const p of (projects as { id: string; name: string }[])) {
      cmds.push({
        id: `p:${p.id}`, group: '專案', icon: '📁',
        label: p.name,
        run: () => { navigate(`/admin/projects/${p.id}`); close(); },
      });
    }

    // Shows
    for (const s of shows) {
      cmds.push({
        id: `s:${s.id}`, group: 'Show', icon: '🎫',
        label: s.name, hint: `${s.projectCount} 個專案`,
        run: () => { navigate(`/admin/shows/${s.id}`); close(); },
      });
    }

    // 全域搜尋結果（從 worker /api/search 拿）
    if (searchResults) {
      for (const sg of searchResults.songs) {
        cmds.push({
          id: `srch-song:${sg.id}`, group: '搜尋：歌曲', icon: '🎵',
          label: sg.name, hint: sg.projectName,
          run: () => { navigate(`/admin/projects/${sg.projectId}`); close(); },
        });
      }
      for (const c of searchResults.cues) {
        cmds.push({
          id: `srch-cue:${c.id}`, group: '搜尋：Cue', icon: '🎬',
          label: c.name, hint: `${c.projectName} · ${c.songName}`,
          run: () => { navigate(`/admin/projects/${c.projectId}`); close(); },
        });
      }
      for (const o of searchResults.stageObjects) {
        cmds.push({
          id: `srch-obj:${o.id}`, group: '搜尋：物件', icon: '🧩',
          label: o.name, hint: o.projectName,
          run: () => { navigate(`/admin/projects/${o.projectId}`); close(); },
        });
      }
    }

    return cmds;
  }, [recent, projects, shows, searchResults, user, navigate, close, logout]);

  // 模糊匹配 + 分組
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter(c =>
      c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
    );
  }, [allCommands, query]);

  // 鍵盤導航
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx(i => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = filtered[activeIdx];
        if (c) c.run();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, activeIdx]);

  // active 項自動 scroll into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  // group 顯示，按 group 順序維持原 cmds 順序
  const groups: { group: string; items: { c: Command; idx: number }[] }[] = [];
  filtered.forEach((c, idx) => {
    let g = groups.find(x => x.group === c.group);
    if (!g) { g = { group: c.group, items: [] }; groups.push(g); }
    g.items.push({ c, idx });
  });

  return (
    <div className="cmdk-overlay" onClick={close}>
      <div className="cmdk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-search">
          <span className="cmdk-search__icon">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            placeholder="搜尋動作、專案、Show…"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmdk-empty">沒有符合的結果</div>
          ) : (
            groups.map(g => (
              <div className="cmdk-group" key={g.group}>
                <div className="cmdk-group__head">{g.group}</div>
                {g.items.map(({ c, idx }) => (
                  <div
                    key={c.id}
                    data-idx={idx}
                    className={'cmdk-item' + (idx === activeIdx ? ' is-active' : '')}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => c.run()}
                  >
                    <span className="cmdk-item__icon">{c.icon}</span>
                    <span className="cmdk-item__label">{c.label}</span>
                    {c.hint && <span className="cmdk-item__hint">{c.hint}</span>}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cmdk-footer">
          <span><kbd>↑↓</kbd> 移動</span>
          <span><kbd>Enter</kbd> 選擇</span>
          <span><kbd>Esc</kbd> 關閉</span>
          <span style={{ marginLeft: 'auto' }}><kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> 隨時呼叫</span>
        </div>
      </div>
    </div>
  );
}
