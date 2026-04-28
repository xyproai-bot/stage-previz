import { Routes, Route } from 'react-router-dom';
import RolePicker from './pages/RolePicker';
import Admin from './pages/Admin';
import Studio from './pages/Studio';
import Preview from './pages/Preview';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RolePicker />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/admin/:tab" element={<Admin />} />
      <Route path="/studio/:projectId" element={<Studio />} />
      <Route path="/preview/:projectId" element={<Preview />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="empty-state">
      <h1>404</h1>
      <p>找不到頁面</p>
      <a href="/">返回首頁</a>
    </div>
  );
}
