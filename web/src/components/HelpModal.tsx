import { useEffect } from 'react';
import './HelpModal.css';

export default function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <header className="help-modal__head">
          <h2>使用說明</h2>
          <button className="dialog__close" onClick={onClose}>×</button>
        </header>
        <div className="help-modal__body">
          <section>
            <h3>🌍 全域</h3>
            <dl>
              <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd></dt>
              <dd>開啟「快速搜尋 / 切換」面板（找專案、Show、cue、物件）</dd>
              <dt><kbd>?</kbd></dt>
              <dd>開啟此說明</dd>
            </dl>
          </section>

          <section>
            <h3>📁 專案編輯器（在某個 project 內）</h3>
            <dl>
              <dt><kbd>J</kbd> / <kbd>K</kbd></dt>
              <dd>切到下一首 / 上一首歌</dd>
              <dt><kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd></dt>
              <dd>切到下一個 / 上一個 cue</dd>
              <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd></dt>
              <dd>Undo（最近 50 步 cue 位置改動）</dd>
            </dl>
          </section>

          <section>
            <h3>🎮 3D Viewport</h3>
            <dl>
              <dt><kbd>W</kbd> / <kbd>E</kbd> / <kbd>R</kbd></dt>
              <dd>切換 移動 / 旋轉 / 縮放 工具</dd>
              <dt><kbd>Q</kbd></dt>
              <dd>切換 World / Local 軸向</dd>
              <dt><kbd>L</kbd></dt>
              <dd>顯示 / 隱藏物件 label</dd>
              <dt><kbd>Esc</kbd></dt>
              <dd>取消選取</dd>
              <dt>點物件</dt>
              <dd>單選</dd>
              <dt><kbd>Shift</kbd>+點物件</dt>
              <dd>加 / 減選（多選）</dd>
              <dt>多選後拖 gizmo</dt>
              <dd>所有選中物件一起移動 / 旋轉</dd>
            </dl>
          </section>

          <section>
            <h3>🎬 Cue 系統</h3>
            <ul>
              <li><strong>Cue tracking</strong>：cue 沒設某物件位置時，會自動繼承同 song 內前一個 cue 的位置（不是回到 default）</li>
              <li><strong>Cue 模板（💎）</strong>：把常用 cue 存成模板，新 cue 可從模板一鍵套用，跨專案也可用（全域模板）</li>
              <li><strong>三種建立方式</strong>：空白 / 沿用當前 cue / 從 3D 狀態 snapshot / 從模板</li>
            </ul>
          </section>

          <section>
            <h3>👥 用戶 / 權限</h3>
            <ul>
              <li>每個用戶一組「號碼」（access code）登入，沒有密碼</li>
              <li>admin 可以建用戶、改名、改號碼、指派專案</li>
              <li>非 admin 用戶只看到 admin 指派的專案</li>
              <li>所有操作都會記在「最近活動」（audit log）</li>
            </ul>
          </section>

          <section>
            <h3>📦 模型 / 資產</h3>
            <ul>
              <li>每個專案可上傳一個 .glb / .gltf；舊版本自動保留，可隨時切回</li>
              <li>模板庫（共用資產）：admin 上傳一份，多個專案共用同一個 model（不重複佔空間）</li>
              <li>LED 板會在 Realistic 模式發光投影到周圍物件</li>
            </ul>
          </section>

          <section>
            <h3>🎫 Show 巡迴</h3>
            <ul>
              <li>Show 是巡迴的母體：一個 Show 可包含多個專案（每場一個專案）</li>
              <li>從「📋 複製專案」可以快速複製整棵樹開新場次</li>
            </ul>
          </section>
        </div>
        <footer className="help-modal__foot">
          <span className="muted small">需求 / 回報問題 → 直接跟 admin 說</span>
          <button className="btn btn--primary" onClick={onClose}>知道了</button>
        </footer>
      </div>
    </div>
  );
}
