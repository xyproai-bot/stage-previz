// 用名字找現有的用戶（「成員」面板的「加入現有用戶」、邀請「已經有帳號的人」共用）。
// 一定要輸入名字才會找（用戶多了不會一次全列出來）；最多列 20 個，不列停用的和全站製作。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import * as api from '../lib/api';
import type { MemberCandidate } from '../lib/api';
import { ROLE_LABEL } from '../lib/roleLabels';
import Icon from './Icon';
import './InviteDialog.css';
import './MembersPanel.css';

interface Props {
  projectId: string;
  /** 每個結果右邊要放什麼（加入的按鈕、選他…） */
  renderAction: (user: MemberCandidate) => ReactNode;
  placeholder?: string;
  label?: string;
  /** 外面要重新找（例如剛加了一個人，要更新「已在專案」的標記）時加一 */
  refreshKey?: number;
  autoFocus?: boolean;
}

const DEBOUNCE_MS = 250;

export default function UserSearchPicker({ projectId, renderAction, placeholder = '輸入名字找人', label = '用名字找人', refreshKey = 0, autoFocus }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MemberCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 只用最後一次的結果（打字比回應快的時候，舊的回應不能蓋掉新的）
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      seq.current++;
      setResults(null);
      setSearching(false);
      setError(null);
      return;
    }
    const my = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api.searchMemberCandidates(projectId, text)
        .then(list => { if (my === seq.current) { setResults(list); setError(null); } })
        .catch(e => { if (my === seq.current) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (my === seq.current) setSearching(false); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, projectId, refreshKey]);

  return (
    <div className="user-search">
      <div className="user-search__box">
        <Icon icon={Search} />
        <input
          type="text" role="searchbox" aria-label={label} placeholder={placeholder}
          value={q} maxLength={40} autoFocus={autoFocus} autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error && <div className="acct-error">找不到人：{error}</div>}
      {searching && !results && <p className="user-search__empty"><Icon icon={LoaderCircle} spin /> 找人中…</p>}
      {results && results.length === 0 && !error && (
        <p className="user-search__empty">找不到名字有「{q.trim()}」的用戶（停用的帳號和全站製作不會列出來）。</p>
      )}
      {results && results.length > 0 && (
        <ul className="user-search__list" aria-label="找到的用戶">
          {results.map(u => (
            <li key={u.id} className="user-search__item" data-user-id={u.id}>
              <span className="avatar avatar--sm" style={{ background: u.avatarColor }}>{u.name[0]}</span>
              <span className="user-search__who">
                <strong>{u.name}</strong>
                <small>
                  帳號是{ROLE_LABEL[u.role]}
                  {u.projectRole ? ` · 已在這個專案（${ROLE_LABEL[u.projectRole]}）` : ''}
                </small>
              </span>
              {renderAction(u)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
