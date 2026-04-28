import { useParams } from 'react-router-dom';

export default function Preview() {
  const { projectId } = useParams();
  return (
    <div className="page-stub">
      <div className="role-icon">🎬</div>
      <h1>DIRECTOR — 動畫進度</h1>
      <p>看最新影片、留言、微調 cue（Phase 3 開發中）</p>
      <div className="hint">/preview/{projectId ?? ':projectId'} · stub page</div>
    </div>
  );
}
