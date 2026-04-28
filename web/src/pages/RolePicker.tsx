import { useNavigate } from 'react-router-dom';
import './RolePicker.css';

const ROLES = [
  {
    id: 'admin',
    icon: '🛠️',
    title: 'Admin / 製作主管',
    desc: '建立專案、管理模型、設定 cue',
    path: '/admin',
  },
  {
    id: 'animator',
    icon: '🎨',
    title: 'Animator / 動畫師',
    desc: '即時預覽 NDI、查看歌曲 cue',
    path: '/studio/demo',
  },
  {
    id: 'director',
    icon: '🎬',
    title: 'Director / 導演',
    desc: '查看最新動畫、留言、微調 cue',
    path: '/preview/demo',
  },
] as const;

export default function RolePicker() {
  const navigate = useNavigate();

  function pick(roleId: string, path: string) {
    try {
      const remember = (document.getElementById('remember') as HTMLInputElement)?.checked;
      if (remember) localStorage.setItem('stagepreviz-role', roleId);
    } catch {
      /* ignore */
    }
    navigate(path);
  }

  return (
    <div className="role-picker">
      <header className="role-picker__hero">
        <h1>STAGE PREVIZ</h1>
        <p className="subtitle">3D LED 舞臺預覽 · 跨團隊協作</p>
      </header>

      <div className="role-picker__cards">
        {ROLES.map(role => (
          <button
            key={role.id}
            className="role-card"
            onClick={() => pick(role.id, role.path)}
          >
            <div className="role-card__icon">{role.icon}</div>
            <div className="role-card__title">{role.title}</div>
            <div className="role-card__desc">{role.desc}</div>
          </button>
        ))}
      </div>

      <label className="role-picker__remember">
        <input type="checkbox" id="remember" defaultChecked />
        <span>記住我的選擇</span>
      </label>

      <footer className="role-picker__footer">v2.0</footer>
    </div>
  );
}
