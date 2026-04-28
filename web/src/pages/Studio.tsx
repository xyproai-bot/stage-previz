import { useParams } from 'react-router-dom';

export default function Studio() {
  const { projectId } = useParams();
  return (
    <div className="page-stub">
      <div className="role-icon">🎨</div>
      <h1>ANIMATOR — 動畫師工作站</h1>
      <p>NDI live 預覽 + 歌曲 cue（Phase 2 開發中）</p>
      <div className="hint">/studio/{projectId ?? ':projectId'} · stub page</div>
    </div>
  );
}
